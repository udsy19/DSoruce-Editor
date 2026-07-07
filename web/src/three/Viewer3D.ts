import * as THREE from 'three'
// `three/addons/*` is the modern published alias for `three/examples/jsm/*`
// (defined in three's package.json `exports`; @types/three maps it too).
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'
import type { DocState, DocComponent, DocWall, DocZone, ZoneType } from '../editor/EditorCanvas'
import { catByCategory } from '../editor/catalog'
import { buildFurniture3D } from './furniture3d'

/**
 * Framework-agnostic Three.js viewer that renders a 2D office plan (DocState,
 * serialized from the Rust core) as a lit, read-only 3D scene, OR renders an
 * arbitrary externally-built group (imported plans) via {@link setContent}.
 *
 * Two camera modes ({@link setMode}):
 *  - `orbit` — OrbitControls, framed to the plan's bounding box.
 *  - `walk`  — first-person PointerLockControls at eye height (1.6 m); click to
 *    lock the pointer, WASD/arrows to move on the XZ plane, Shift to sprint,
 *    Esc to release. Movement is bounded to the plan extent (no fly / wander).
 *
 * ── Rendering ─────────────────────────────────────────────────────────────
 * ACES filmic tone-mapping + sRGB output, PCF soft shadows, and an image-based
 * ambient from RoomEnvironment (via PMREMGenerator) give a clean interior look.
 * A hemisphere fill + one shadow-casting DirectionalLight "sun" add contact
 * shadows and directionality on top of the environment.
 *
 * ── Coordinate mapping ────────────────────────────────────────────────────
 * The 2D canvas uses meters with X→right and Y→DOWN (screen convention). We
 * map to a right-handed Three.js scene as:
 *     plan X → world X      plan Y → world Z      up → world +Y
 * A 2D rotation θ (canvas rotate, clockwise because Y is down) becomes a
 * rotation about world +Y of −θ. The same handedness flip gives wall
 * orientation φ = −atan2(b.y−a.y, b.x−a.x).
 *
 * ── Height heuristics (meters) ────────────────────────────────────────────
 * Walls 2.6 tall (using DocWall.thickness for depth). Real furniture is built
 * by `buildFurniture3D`. MeetingRoom is a translucent full-height volume;
 * FallCeiling a thin slab hung just below the ceiling.
 *
 * Sources (r0.185 patterns):
 *  - RoomEnvironment / PMREM: https://threejs.org/examples/#webgl_materials_envmaps
 *  - PointerLockControls: https://threejs.org/docs/#examples/en/controls/PointerLockControls
 *  - Disposal: https://discourse.threejs.org/t/dispose-things-correctly-in-three-js/6534
 */

const WALL_HEIGHT = 2.6
const CEILING_HEIGHT = 2.6
const BG = 0xf3f1ec // neutral-warm off-white
const EYE_HEIGHT = 1.6
const WALK_SPEED = 3.0 // m/s
const SPRINT_MULT = 2.0
const WALK_MARGIN = 4 // how far past the plan bounds you may wander (m)

export type ViewerMode = 'orbit' | 'walk'

/** Subtle per-zone floor tints (Laiout-style zoning cue). */
const ZONE_TINT: Record<ZoneType, number> = {
  Circulation: 0xe8a13c,
  Workspace: 0x5b8def,
  Meeting: 0x5fa8c4,
  Collaboration: 0x46b3a6,
  Core: 0x8a93a6,
  ClosedOffice: 0x9b7ede,
  Amenity: 0xd98da8,
}

export class Viewer3D {
  /** Optional overlay callback for the current walkthrough hint (or null). */
  onModeHint?: (text: string | null) => void

  private container: HTMLElement
  private renderer: THREE.WebGLRenderer
  private scene: THREE.Scene
  private camera: THREE.PerspectiveCamera
  private orbit: OrbitControls
  private walk: PointerLockControls
  private sun: THREE.DirectionalLight
  private clock = new THREE.Clock()
  private mode: ViewerMode = 'orbit'

  /** Everything rebuilt on setState()/setContent() lives here so the rest of
   *  the scene (lights, ground, grid, environment) survives updates. */
  private content = new THREE.Group()
  private contentBounds = new THREE.Box3()

  // Shared GPU resources — protected from per-rebuild disposal. Furniture built
  // by buildFurniture3D owns fresh geometry/material each call; those ARE
  // disposed when content is cleared (tracked via `shared` exclusion).
  private unitBox = new THREE.BoxGeometry(1, 1, 1)
  private wallMat = new THREE.MeshStandardMaterial({ color: 0xd9dce1, roughness: 0.9, metalness: 0 })
  private meetingMat = new THREE.MeshStandardMaterial({
    color: 0x5fa8c4,
    roughness: 0.6,
    transparent: true,
    opacity: 0.14,
    depthWrite: false,
    side: THREE.DoubleSide,
  })
  private fallCeilingMat = new THREE.MeshStandardMaterial({
    color: 0x8a93a6,
    roughness: 0.95,
    transparent: true,
    opacity: 0.6,
  })
  private highlightMat = new THREE.LineBasicMaterial({ color: 0xe8a13c })
  private shared: Set<THREE.BufferGeometry | THREE.Material>

  private ground: THREE.Mesh
  private grid: THREE.GridHelper
  private pmrem: THREE.PMREMGenerator
  private envRT: THREE.WebGLRenderTarget
  private framed = false
  private rafId = 0
  private disposed = false

  // Walk-mode input state.
  private keys = new Set<string>()

  constructor(container: HTMLElement) {
    this.container = container

    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.0
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    container.appendChild(this.renderer.domElement)

    this.scene = new THREE.Scene()
    this.scene.background = new THREE.Color(BG)
    this.scene.fog = new THREE.Fog(BG, 45, 130)
    this.scene.add(this.content)

    this.camera = new THREE.PerspectiveCamera(55, 1, 0.1, 1000)
    this.camera.position.set(12, 12, 16)

    // Image-based ambient: RoomEnvironment → PMREM → scene.environment.
    this.pmrem = new THREE.PMREMGenerator(this.renderer)
    const roomEnv = new RoomEnvironment()
    this.envRT = this.pmrem.fromScene(roomEnv, 0.04)
    this.scene.environment = this.envRT.texture
    this.scene.environmentIntensity = 0.85
    roomEnv.dispose()

    // Orbit controls.
    this.orbit = new OrbitControls(this.camera, this.renderer.domElement)
    this.orbit.enableDamping = true
    this.orbit.dampingFactor = 0.08
    this.orbit.maxPolarAngle = Math.PI * 0.495 // keep camera above the floor
    this.orbit.target.set(0, 0, 0)

    // First-person controls (inactive until setMode('walk')).
    this.walk = new PointerLockControls(this.camera, this.renderer.domElement)
    this.walk.enabled = false

    // Lighting: hemisphere fill + a shadow-casting sun (env supplies the rest).
    const hemi = new THREE.HemisphereLight(0xfff6ea, 0xdfe3e8, 0.6)
    this.scene.add(hemi)

    this.sun = new THREE.DirectionalLight(0xfff4e6, 2.4)
    this.sun.position.set(14, 22, 10)
    this.sun.castShadow = true
    this.sun.shadow.mapSize.set(2048, 2048)
    this.sun.shadow.bias = -0.0004
    this.sun.shadow.normalBias = 0.02
    const cam = this.sun.shadow.camera
    cam.near = 1
    cam.far = 90
    cam.left = -30
    cam.right = 30
    cam.top = 30
    cam.bottom = -30
    this.scene.add(this.sun)
    this.scene.add(this.sun.target)

    // Ground + grid.
    this.ground = new THREE.Mesh(
      new THREE.PlaneGeometry(400, 400),
      new THREE.MeshStandardMaterial({ color: 0xeae7e0, roughness: 0.65, metalness: 0.05 }),
    )
    this.ground.rotation.x = -Math.PI / 2
    this.ground.position.y = -0.001
    this.ground.receiveShadow = true
    this.scene.add(this.ground)

    this.grid = new THREE.GridHelper(200, 200, 0xc9cdd3, 0xdee1e6)
    ;(this.grid.material as THREE.Material).transparent = true
    ;(this.grid.material as THREE.Material).opacity = 0.3
    this.scene.add(this.grid)

    this.shared = new Set<THREE.BufferGeometry | THREE.Material>([
      this.unitBox,
      this.wallMat,
      this.meetingMat,
      this.fallCeilingMat,
      this.highlightMat,
    ])

    // Walk-mode input.
    window.addEventListener('keydown', this.onKeyDown)
    window.addEventListener('keyup', this.onKeyUp)
    this.renderer.domElement.addEventListener('click', this.onCanvasClick)
    this.walk.addEventListener('lock', this.onWalkLock)
    this.walk.addEventListener('unlock', this.onWalkUnlock)

    this.resize()
    this.animate()
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /** Switch between orbit and first-person walkthrough. */
  setMode(mode: ViewerMode): void {
    if (mode === this.mode) return
    this.mode = mode
    if (mode === 'walk') {
      this.orbit.enabled = false
      this.walk.enabled = true
      this.spawnWalker()
      this.emitHint('Click to look · WASD to move · Shift to sprint')
    } else {
      if (this.walk.isLocked) this.walk.unlock()
      this.walk.enabled = false
      this.keys.clear()
      this.orbit.enabled = true
      this.orbit.update()
      this.emitHint(null)
    }
  }

  /** Rebuild the extruded plan from a fresh DocState (generated plans). */
  setState(state: DocState): void {
    this.clearContent()

    if (state.zones) for (const z of state.zones) this.buildZonePlate(z)
    for (const w of state.walls) this.content.add(this.buildWall(w))
    for (const c of state.components) {
      this.content.add(this.buildComponent(c, c.id === state.selection))
    }

    this.contentBounds = this.boundsFromState(state)
    if (!this.framed && !this.contentBounds.isEmpty()) this.frameBox(this.contentBounds)
  }

  /** Replace the dynamic content with an arbitrary externally-built group
   *  (imported plans) and frame the camera to its bounding box. Takes over
   *  ownership: the previous content's owned resources are disposed.
   *
   *  Imported plans carry their source DXF world coordinates and can sit
   *  ~1000 m from the origin, where the origin-anchored ground/grid/fog no
   *  longer surround them. We therefore recenter the group so its horizontal
   *  bounding-box center sits at the world origin (Y is preserved) and update
   *  `contentBounds` to the recentered extent, so framing + walk clamping use
   *  the same coordinates. (`setState` plans are already near origin.) */
  setContent(root: THREE.Group): void {
    this.clearContent()
    const bounds = new THREE.Box3().setFromObject(root)
    if (!bounds.isEmpty()) {
      const center = bounds.getCenter(new THREE.Vector3())
      root.position.x -= center.x
      root.position.z -= center.z
      root.updateMatrixWorld(true)
      bounds.translate(new THREE.Vector3(-center.x, 0, -center.z))
    }
    this.content.add(root)
    this.contentBounds = bounds
    this.framed = false
    if (!this.contentBounds.isEmpty()) this.frameBox(this.contentBounds)
  }

  resize(): void {
    const w = this.container.clientWidth || 1
    const h = this.container.clientHeight || 1
    this.renderer.setSize(w, h, false)
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
  }

  /** Release all GPU resources, controls, and listeners; stop the render loop. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    cancelAnimationFrame(this.rafId)

    window.removeEventListener('keydown', this.onKeyDown)
    window.removeEventListener('keyup', this.onKeyUp)
    this.renderer.domElement.removeEventListener('click', this.onCanvasClick)
    this.walk.removeEventListener('lock', this.onWalkLock)
    this.walk.removeEventListener('unlock', this.onWalkUnlock)

    if (this.walk.isLocked) this.walk.unlock()
    this.orbit.dispose()
    this.walk.dispose()

    this.clearContent()
    this.unitBox.dispose()
    this.wallMat.dispose()
    this.meetingMat.dispose()
    this.fallCeilingMat.dispose()
    this.highlightMat.dispose()

    this.ground.geometry.dispose()
    ;(this.ground.material as THREE.Material).dispose()
    this.grid.geometry.dispose()
    ;(this.grid.material as THREE.Material).dispose()

    this.scene.environment = null
    this.envRT.dispose()
    this.pmrem.dispose()

    this.renderer.dispose()
    this.renderer.domElement.remove()
  }

  // ── Content builders ────────────────────────────────────────────────────

  private buildWall(w: DocWall): THREE.Mesh {
    const dx = w.b.x - w.a.x
    const dz = w.b.y - w.a.y // plan Y → world Z
    const len = Math.hypot(dx, dz) || 0.01
    const mesh = new THREE.Mesh(this.unitBox, this.wallMat)
    mesh.scale.set(len, WALL_HEIGHT, Math.max(w.thickness, 0.05))
    mesh.position.set((w.a.x + w.b.x) / 2, WALL_HEIGHT / 2, (w.a.y + w.b.y) / 2)
    mesh.rotation.y = -Math.atan2(dz, dx) // see coordinate-mapping note above
    mesh.castShadow = true
    mesh.receiveShadow = true
    return mesh
  }

  private buildComponent(c: DocComponent, selected: boolean): THREE.Object3D {
    const group = new THREE.Group()
    group.position.set(c.x, 0, c.y)
    group.rotation.y = -c.rotation // 2D clockwise θ → world −θ about +Y

    let obj: THREE.Object3D
    if (c.category === 'MeetingRoom') {
      // Translucent full-height room volume.
      const mesh = new THREE.Mesh(this.unitBox, this.meetingMat)
      mesh.scale.set(c.w, CEILING_HEIGHT, c.h)
      mesh.position.y = CEILING_HEIGHT / 2
      obj = mesh
    } else if (c.category === 'FallCeiling') {
      // Thin slab hung just below the ceiling.
      const mesh = new THREE.Mesh(this.unitBox, this.fallCeilingMat)
      const t = 0.05
      mesh.scale.set(c.w, t, c.h)
      mesh.position.y = CEILING_HEIGHT - t / 2
      obj = mesh
    } else {
      // Real parametric furniture (owns fresh geometry/material → disposed on clear).
      const color = catByCategory(c.category)?.color
      obj = buildFurniture3D(c.category, c.w, c.h, color ? { color } : {})
    }
    group.add(obj)

    if (selected) {
      const helper = new THREE.LineSegments(
        new THREE.EdgesGeometry(this.unitBox),
        this.highlightMat,
      )
      const box = new THREE.Box3().setFromObject(obj)
      const size = box.getSize(new THREE.Vector3())
      const center = box.getCenter(new THREE.Vector3())
      helper.scale.set(Math.max(size.x, 0.05), Math.max(size.y, 0.05), Math.max(size.z, 0.05))
      helper.position.copy(center)
      group.add(helper)
    }
    return group
  }

  /** Thin colored floor plate under a zone (Rect or RectRing footprint). */
  private buildZonePlate(z: DocZone): void {
    const tint = ZONE_TINT[z.zone_type] ?? 0x9aa2b1
    const mat = new THREE.MeshStandardMaterial({
      color: tint,
      roughness: 0.85,
      metalness: 0,
      transparent: true,
      opacity: 0.16,
    })
    const add = (x: number, y: number, w: number, h: number) => {
      const geo = new THREE.PlaneGeometry(Math.max(w, 0.05), Math.max(h, 0.05))
      const plate = new THREE.Mesh(geo, mat)
      plate.rotation.x = -Math.PI / 2
      plate.position.set(x + w / 2, 0.006, y + h / 2)
      plate.receiveShadow = true
      this.content.add(plate)
    }
    const s = z.shape
    if (s.kind === 'Rect') {
      add(s.x, s.y, s.w, s.h)
    } else {
      // RectRing: four border strips around the inner void.
      const bx = (s.w - s.in_w) / 2
      const bz = (s.h - s.in_h) / 2
      add(s.x, s.y, s.w, bz) // top
      add(s.x, s.y + s.h - bz, s.w, bz) // bottom
      add(s.x, s.y + bz, bx, s.in_h) // left
      add(s.x + s.w - bx, s.y + bz, bx, s.in_h) // right
    }
  }

  // ── Framing ──────────────────────────────────────────────────────────────

  private boundsFromState(state: DocState): THREE.Box3 {
    const box = new THREE.Box3()
    const p = new THREE.Vector3()
    const add = (x: number, z: number) => box.expandByPoint(p.set(x, 0, z))
    for (const w of state.walls) {
      add(w.a.x, w.a.y)
      add(w.b.x, w.b.y)
    }
    for (const c of state.components) {
      const r = Math.hypot(c.w, c.h) / 2
      add(c.x - r, c.y - r)
      add(c.x + r, c.y + r)
    }
    if (!box.isEmpty()) box.expandByPoint(p.set(box.min.x, WALL_HEIGHT, box.min.z))
    return box
  }

  /** Fit the camera + shadow frustum to an arbitrary bounding box (once). */
  private frameBox(box: THREE.Box3): void {
    const center = box.getCenter(new THREE.Vector3())
    const size = box.getSize(new THREE.Vector3())
    const span = Math.max(size.x, size.z, 4)

    const radius = Math.max(box.getBoundingSphere(new THREE.Sphere()).radius, 3)
    const fov = (this.camera.fov * Math.PI) / 180
    const fitDist = (radius / Math.sin(fov / 2)) * 1.12
    const dir = new THREE.Vector3(0.55, 0.62, 1).normalize()
    this.orbit.target.copy(center)
    this.camera.position.copy(center).addScaledVector(dir, fitDist)
    this.camera.near = 0.1
    this.camera.far = fitDist * 4 + 200
    this.camera.updateProjectionMatrix()
    this.orbit.update()

    // Point the sun at the plan and tighten its shadow frustum around it.
    this.sun.position.set(center.x + span, span * 1.6 + 8, center.z + span * 0.6)
    this.sun.target.position.copy(center)
    const half = span * 0.75 + 6
    const sc = this.sun.shadow.camera
    sc.left = -half
    sc.right = half
    sc.top = half
    sc.bottom = -half
    sc.far = span * 4 + 60
    sc.updateProjectionMatrix()

    this.framed = true
  }

  // ── Walk mode ────────────────────────────────────────────────────────────

  /** Position the first-person camera inside the built geometry, looking at the
   *  bulk of the content. The bounding-box center is a poor spawn for a large
   *  L-shaped or sparse plan — it lands in empty space facing a blank wall. We
   *  instead aim at the *content centroid* (the dense area; see
   *  {@link contentCentroid}), then stand a modest step back from it along the
   *  LONGER horizontal axis and look down that axis toward the greater content
   *  extent — so the walker starts *among* the furniture looking into the room,
   *  not shoved against a perimeter wall. The backoff is capped (a big L-shaped
   *  plan must not spawn the camera 15 m away at the far glazing). */
  private spawnWalker(): void {
    const b = this.contentBounds
    if (b.isEmpty()) {
      this.camera.position.set(0, EYE_HEIGHT, 6)
      this.camera.lookAt(0, EYE_HEIGHT, 0)
      return
    }
    const c = this.contentCentroid() ?? b.getCenter(new THREE.Vector3())
    const size = b.getSize(new THREE.Vector3())
    const alongX = size.x >= size.z
    // Distance from the centroid to each end of the longer axis.
    const cc = alongX ? c.x : c.z
    const lo = alongX ? b.min.x : b.min.z
    const hi = alongX ? b.max.x : b.max.z
    // Face the side with the greater remaining extent (more content ahead).
    const sign = hi - cc >= cc - lo ? 1 : -1
    const ahead = Math.max(hi - cc, cc - lo)
    const back = Math.min(ahead * 0.3, 6) // step back into the room, capped at 6 m
    const camAxis = cc - sign * back
    const lookAxis = cc + sign * ahead
    if (alongX) {
      this.camera.position.set(camAxis, EYE_HEIGHT, c.z)
      this.camera.lookAt(lookAxis, EYE_HEIGHT, c.z)
    } else {
      this.camera.position.set(c.x, EYE_HEIGHT, camAxis)
      this.camera.lookAt(c.x, EYE_HEIGHT, lookAxis)
    }
  }

  /** Average world position of the meaningful solid content (walls, furniture),
   *  which lands in the dense area rather than the geometric bbox center. Floor
   *  and zone plates (PlaneGeometry) are excluded so a large empty footprint
   *  doesn't pull the spawn into a void. Returns null if nothing qualifies. */
  private contentCentroid(): THREE.Vector3 | null {
    this.content.updateMatrixWorld(true)
    const acc = new THREE.Vector3()
    const v = new THREE.Vector3()
    let n = 0
    this.content.traverse((obj) => {
      const mesh = obj as THREE.Mesh
      if (!mesh.isMesh || !mesh.geometry) return
      const geo = mesh.geometry as THREE.BufferGeometry
      if (geo.type === 'PlaneGeometry') return // floors / zone plates
      if (!geo.boundingBox) geo.computeBoundingBox()
      const bb = geo.boundingBox
      if (!bb) return
      bb.getCenter(v)
      mesh.localToWorld(v)
      acc.add(v)
      n++
    })
    return n > 0 ? acc.multiplyScalar(1 / n) : null
  }

  private updateWalk(dt: number): void {
    // Move along the look direction on the XZ plane; Shift sprints.
    const sprint = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight')
    const dist = WALK_SPEED * (sprint ? SPRINT_MULT : 1) * dt
    const fwd = (this.keys.has('KeyW') || this.keys.has('ArrowUp') ? 1 : 0) +
      (this.keys.has('KeyS') || this.keys.has('ArrowDown') ? -1 : 0)
    const strafe = (this.keys.has('KeyD') || this.keys.has('ArrowRight') ? 1 : 0) +
      (this.keys.has('KeyA') || this.keys.has('ArrowLeft') ? -1 : 0)
    if (fwd) this.walk.moveForward(fwd * dist)
    if (strafe) this.walk.moveRight(strafe * dist)

    // Clamp to eye height (no fly) and to the plan bounds (no infinite wander).
    const p = this.camera.position
    p.y = EYE_HEIGHT
    const b = this.contentBounds
    if (!b.isEmpty()) {
      p.x = THREE.MathUtils.clamp(p.x, b.min.x - WALK_MARGIN, b.max.x + WALK_MARGIN)
      p.z = THREE.MathUtils.clamp(p.z, b.min.z - WALK_MARGIN, b.max.z + WALK_MARGIN)
    } else {
      p.x = THREE.MathUtils.clamp(p.x, -100, 100)
      p.z = THREE.MathUtils.clamp(p.z, -100, 100)
    }
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (this.mode !== 'walk') return
    this.keys.add(e.code)
    if (
      e.code.startsWith('Arrow') ||
      ['KeyW', 'KeyA', 'KeyS', 'KeyD'].includes(e.code)
    ) {
      e.preventDefault()
    }
  }

  private onKeyUp = (e: KeyboardEvent): void => {
    this.keys.delete(e.code)
  }

  private onCanvasClick = (): void => {
    if (this.mode === 'walk' && !this.walk.isLocked) this.walk.lock()
  }

  private onWalkLock = (): void => {
    if (this.mode === 'walk') this.emitHint('WASD to move · Shift to sprint · Esc to release')
  }

  private onWalkUnlock = (): void => {
    this.keys.clear()
    if (this.mode === 'walk') this.emitHint('Click to look · WASD to move · Shift to sprint')
  }

  private emitHint(text: string | null): void {
    this.onModeHint?.(text)
  }

  // ── Housekeeping ─────────────────────────────────────────────────────────

  /** Detach and dispose meshes built by setState()/setContent(). Shared
   *  geometry/materials are protected; furniture-owned resources are freed. */
  private clearContent(): void {
    this.content.traverse((obj) => {
      const m = obj as THREE.Mesh
      const geo = m.geometry as THREE.BufferGeometry | undefined
      if (geo && !this.shared.has(geo)) geo.dispose()
      const mat = m.material as THREE.Material | THREE.Material[] | undefined
      if (Array.isArray(mat)) {
        for (const x of mat) if (!this.shared.has(x)) x.dispose()
      } else if (mat && !this.shared.has(mat)) {
        mat.dispose()
      }
    })
    for (let i = this.content.children.length - 1; i >= 0; i--) {
      this.content.remove(this.content.children[i])
    }
  }

  private animate = (): void => {
    if (this.disposed) return
    this.rafId = requestAnimationFrame(this.animate)
    const dt = Math.min(this.clock.getDelta(), 0.1)
    if (this.mode === 'walk') {
      if (this.walk.enabled) this.updateWalk(dt)
    } else {
      this.orbit.update()
    }
    this.renderer.render(this.scene, this.camera)
  }
}
