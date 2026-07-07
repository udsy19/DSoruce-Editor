import * as THREE from 'three'
// `three/addons/*` is the modern published alias for `three/examples/jsm/*`
// (defined in three's package.json `exports`; @types/three maps it too).
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import type { DocState, DocComponent, DocWall } from '../editor/EditorCanvas'
import { catByCategory } from '../editor/catalog'

/**
 * Framework-agnostic Three.js viewer that renders a 2D office plan (DocState,
 * serialized from the Rust core) as an extruded, read-only 3D scene. Editing
 * stays in 2D; this is an orbit/walkthrough view.
 *
 * ── Coordinate mapping ────────────────────────────────────────────────────
 * The 2D canvas uses meters with X→right and Y→DOWN (screen convention). We
 * map to a right-handed Three.js scene as:
 *     plan X → world X      plan Y → world Z      up → world +Y
 * A 2D rotation θ (canvas rotate, clockwise because Y is down) becomes a
 * rotation about world +Y of −θ. Derivation: a plan point (dx,dy) rotated by θ
 * is (dx·cosθ − dy·sinθ, dx·sinθ + dy·cosθ); mapping y→z and applying Three's
 * Ry(φ) [x'=x·cosφ+z·sinφ, z'=−x·sinφ+z·cosφ] matches only when φ = −θ. The
 * same handedness flip gives wall orientation φ = −atan2(b.y−a.y, b.x−a.x).
 *
 * ── Height heuristics (meters) ────────────────────────────────────────────
 * Walls 2.6 tall (using DocWall.thickness for depth). Desk/Table 0.75, Chair
 * 0.9, MeetingRoom a translucent volume the full room height (2.6), FallCeiling
 * a thin slab (0.05) hung just below the ceiling. Unknown categories → 0.8.
 *
 * Sources (r0.160+ patterns):
 *  - Disposal / leak prevention: https://discourse.threejs.org/t/dispose-things-correctly-in-three-js/6534
 *  - PCFSoftShadowMap + directional shadow frustum: https://sbcode.net/threejs/directional-light-shadow/
 *  - OrbitControls: https://threejs.org/docs/#examples/en/controls/OrbitControls
 */

const WALL_HEIGHT = 2.6
const CEILING_HEIGHT = 2.6
const BG = 0x0f1420

/** Per-category extruded height (meters). */
function componentHeight(category: string): number {
  switch (category) {
    case 'Desk':
    case 'Table':
      return 0.75
    case 'Chair':
      return 0.9
    case 'MeetingRoom':
      return CEILING_HEIGHT
    case 'FallCeiling':
      return 0.05
    default:
      return 0.8
  }
}

export class Viewer3D {
  private container: HTMLElement
  private renderer: THREE.WebGLRenderer
  private scene: THREE.Scene
  private camera: THREE.PerspectiveCamera
  private controls: OrbitControls
  private sun: THREE.DirectionalLight

  /** Everything rebuilt on setState() lives here so the rest of the scene
   *  (lights, ground, grid) survives updates. */
  private content = new THREE.Group()

  // Shared GPU resources — one unit box + one edge overlay for every mesh, so
  // a rebuild only detaches meshes (cheap) and never churns geometry.
  private unitBox = new THREE.BoxGeometry(1, 1, 1)
  private unitEdges = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1))
  private materials = new Map<string, THREE.Material>()
  private highlightMat = new THREE.LineBasicMaterial({ color: 0xffffff })
  private wallMat = new THREE.MeshStandardMaterial({
    color: 0xcdd6e4,
    roughness: 0.9,
    metalness: 0.0,
  })

  private ground: THREE.Mesh
  private grid: THREE.GridHelper
  private framed = false
  private rafId = 0
  private disposed = false

  constructor(container: HTMLElement) {
    this.container = container

    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    container.appendChild(this.renderer.domElement)

    this.scene = new THREE.Scene()
    this.scene.background = new THREE.Color(BG)
    this.scene.fog = new THREE.Fog(BG, 40, 120)
    this.scene.add(this.content)

    this.camera = new THREE.PerspectiveCamera(55, 1, 0.1, 1000)
    this.camera.position.set(12, 12, 16)

    this.controls = new OrbitControls(this.camera, this.renderer.domElement)
    this.controls.enableDamping = true
    this.controls.dampingFactor = 0.08
    this.controls.maxPolarAngle = Math.PI * 0.495 // keep camera above the floor
    this.controls.target.set(0, 0, 0)

    // Lighting: hemisphere fill + a shadow-casting sun.
    const hemi = new THREE.HemisphereLight(0xbdd4ff, 0x141a26, 0.9)
    this.scene.add(hemi)

    this.sun = new THREE.DirectionalLight(0xffffff, 2.2)
    this.sun.position.set(14, 22, 10)
    this.sun.castShadow = true
    this.sun.shadow.mapSize.set(2048, 2048)
    this.sun.shadow.bias = -0.0004
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
      new THREE.MeshStandardMaterial({ color: 0x0b0f18, roughness: 1 }),
    )
    this.ground.rotation.x = -Math.PI / 2
    this.ground.position.y = -0.001
    this.ground.receiveShadow = true
    this.scene.add(this.ground)

    this.grid = new THREE.GridHelper(200, 200, 0x2a3348, 0x1a2032)
    ;(this.grid.material as THREE.Material).transparent = true
    ;(this.grid.material as THREE.Material).opacity = 0.35
    this.scene.add(this.grid)

    this.resize()
    this.animate()
  }

  /** Cached opaque/translucent standard material per category. */
  private materialFor(c: DocComponent): THREE.Material {
    let mat = this.materials.get(c.category)
    if (mat) return mat
    const color = new THREE.Color(catByCategory(c.category)?.color ?? '#4f8cff')
    if (c.category === 'MeetingRoom') {
      mat = new THREE.MeshStandardMaterial({
        color,
        roughness: 0.6,
        transparent: true,
        opacity: 0.16,
        depthWrite: false,
        side: THREE.DoubleSide,
      })
    } else if (c.category === 'FallCeiling') {
      mat = new THREE.MeshStandardMaterial({
        color,
        roughness: 0.95,
        transparent: true,
        opacity: 0.6,
      })
    } else {
      mat = new THREE.MeshStandardMaterial({ color, roughness: 0.7, metalness: 0.05 })
    }
    this.materials.set(c.category, mat)
    return mat
  }

  /** Rebuild the extruded plan from a fresh DocState. */
  setState(state: DocState): void {
    this.clearContent()

    for (const w of state.walls) this.content.add(this.buildWall(w))
    for (const c of state.components) {
      this.content.add(this.buildComponent(c, c.id === state.selection))
    }

    if (!this.framed) this.frameBounds(state)
  }

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
    const height = componentHeight(c.category)
    const group = new THREE.Group()
    group.position.set(c.x, 0, c.y)
    group.rotation.y = -c.rotation // 2D clockwise θ → world −θ about +Y

    const mesh = new THREE.Mesh(this.unitBox, this.materialFor(c))
    // FallCeiling hangs near the ceiling; everything else sits on the floor.
    const yCenter = c.category === 'FallCeiling' ? CEILING_HEIGHT - height / 2 : height / 2
    mesh.scale.set(c.w, height, c.h)
    mesh.position.y = yCenter
    mesh.castShadow = c.category !== 'MeetingRoom'
    mesh.receiveShadow = c.category !== 'MeetingRoom'
    group.add(mesh)

    if (selected) {
      const outline = new THREE.LineSegments(this.unitEdges, this.highlightMat)
      outline.scale.copy(mesh.scale)
      outline.position.copy(mesh.position)
      group.add(outline)
    }
    return group
  }

  /** Fit the camera + shadow frustum to the plan's extent (once). */
  private frameBounds(state: DocState): void {
    const box = new THREE.Box3()
    const p = new THREE.Vector3()
    let any = false
    const add = (x: number, z: number) => {
      box.expandByPoint(p.set(x, 0, z))
      any = true
    }
    for (const w of state.walls) {
      add(w.a.x, w.a.y)
      add(w.b.x, w.b.y)
    }
    for (const c of state.components) {
      const r = Math.hypot(c.w, c.h) / 2
      add(c.x - r, c.y - r)
      add(c.x + r, c.y + r)
    }
    if (!any) return // nothing to frame yet; keep default and retry next setState

    const center = box.getCenter(new THREE.Vector3())
    const size = box.getSize(new THREE.Vector3())
    const span = Math.max(size.x, size.z, 4)

    // Fit the whole plan to the viewport using the bounding sphere, so it stays
    // centered regardless of aspect ratio. Camera sits on a fixed 3/4 direction.
    const radius = Math.max(box.getBoundingSphere(new THREE.Sphere()).radius, 3)
    const fov = (this.camera.fov * Math.PI) / 180
    const fitDist = (radius / Math.sin(fov / 2)) * 1.12
    const dir = new THREE.Vector3(0.55, 0.62, 1).normalize()
    this.controls.target.copy(center)
    this.camera.position.copy(center).addScaledVector(dir, fitDist)
    this.camera.near = 0.1
    this.camera.far = fitDist * 4 + 200
    this.camera.updateProjectionMatrix()
    this.controls.update()

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

  /** Detach meshes built by setState. Shared geometry/materials are NOT
   *  disposed here (they are reused); only released in dispose(). */
  private clearContent(): void {
    for (let i = this.content.children.length - 1; i >= 0; i--) {
      this.content.remove(this.content.children[i])
    }
  }

  resize(): void {
    const w = this.container.clientWidth || 1
    const h = this.container.clientHeight || 1
    this.renderer.setSize(w, h, false)
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
  }

  private animate = (): void => {
    if (this.disposed) return
    this.rafId = requestAnimationFrame(this.animate)
    this.controls.update()
    this.renderer.render(this.scene, this.camera)
  }

  /** Release all GPU resources and stop the render loop. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    cancelAnimationFrame(this.rafId)
    this.controls.dispose()

    this.clearContent()
    this.unitBox.dispose()
    this.unitEdges.dispose()
    this.highlightMat.dispose()
    this.wallMat.dispose()
    for (const m of this.materials.values()) m.dispose()
    this.materials.clear()

    this.ground.geometry.dispose()
    ;(this.ground.material as THREE.Material).dispose()
    this.grid.geometry.dispose()
    ;(this.grid.material as THREE.Material).dispose()

    this.renderer.dispose()
    this.renderer.domElement.remove()
  }
}
