import * as THREE from 'three'
// `three/addons/*` is the modern published alias for `three/examples/jsm/*`
// (defined in three's package.json `exports`; @types/three maps it too).
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { SAOPass } from 'three/addons/postprocessing/SAOPass.js'
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js'
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js'
import type { DocState, DocComponent, DocWall, DocZone, ZoneType } from '../editor/EditorCanvas'
import { catByCategory } from '../editor/catalog'
import { buildFurniture3D } from './furniture3d'
import { clipPolyToRect, platePolygonFromWalls, type Pt } from '../util/clip'

/**
 * Framework-agnostic Three.js viewer that renders a 2D office plan (DocState,
 * serialized from the Rust core) as a lit, read-only 3D scene, OR renders an
 * arbitrary externally-built group (imported plans) via {@link setContent}.
 *
 * Two camera modes ({@link setMode}), with an animated fly between them:
 *  - `orbit` — OrbitControls tuned for native mouse feel: scroll dives toward
 *    the cursor (`zoomToCursor`), double-click smoothly refocuses the orbit
 *    pivot on the clicked content, and {@link frameAll}/{@link setView} ease
 *    the camera between standard framings.
 *  - `walk`  — first-person at eye height (1.6 m), mouse-first: left-drag looks
 *    around (grab-style, smoothed), scroll glides forward/back along the look
 *    direction (collision-checked), WASD/arrows move, Shift sprints. Pointer
 *    lock is optional — double-click engages it, Esc releases.
 *
 * ── Rendering ─────────────────────────────────────────────────────────────
 * ACES filmic tone-mapping + sRGB output, PCF soft shadows, and an image-based
 * ambient from RoomEnvironment (via PMREMGenerator). Quality 'high' renders
 * through an EffectComposer (RenderPass → SAO → OutputPass → SMAA); 'low'
 * bypasses it (direct render, MSAA from the context, smaller shadow map,
 * capped pixel ratio). A rolling FPS window auto-degrades high → low when the
 * composer can't hold 40 fps (never auto-upgrades).
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
 *  - Composer + OutputPass ordering: https://threejs.org/examples/#webgl_postprocessing_sao
 *    (tone mapping/sRGB happen in OutputPass; AA passes like SMAA/FXAA run
 *    after it, on display-referred colors)
 *  - Disposal: https://discourse.threejs.org/t/dispose-things-correctly-in-three-js/6534
 */

const WALL_HEIGHT = 2.6
const CEILING_HEIGHT = 2.6
const SKY_TOP = '#cfd8e3' // soft blue-grey zenith
const SKY_HORIZON = '#f3f1ec' // warm off-white horizon (fog matches)
const FOG_COLOR = 0xf3f1ec
const EYE_HEIGHT = 1.6
const WALK_SPEED = 3.0 // m/s
const SPRINT_MULT = 2.0
const WALK_MARGIN = 4 // how far past the plan bounds you may wander (m)
const PLAYER_RADIUS = 0.32 // keep this far off walls (m); enables wall-sliding

// Movement smoothing: velocity ramps toward the target instead of snapping, so
// starts/stops feel weighted rather than instant.
const WALK_ACCEL = 12 // ramp rate toward target velocity (1/s)
const WALK_DECEL = 9 // ramp rate toward rest when input released (1/s)
// Head-bob: a subtle vertical + lateral camera oscillation while moving that
// eases back to zero when idle. Amplitudes are a few centimeters — felt, not seen.
const BOB_RATE = 9.0 // step-cycle phase rate at full speed (rad/s)
const BOB_AMP_V = 0.035 // vertical bob amplitude (m)
const BOB_AMP_LAT = 0.022 // lateral bob amplitude (m)

// Mouse-first walk controls.
const DRAG_LOOK_SENS = 0.0032 // rad per px of drag
const PITCH_LIMIT = (85 * Math.PI) / 180
const LOOK_SMOOTH = 20 // exponential smoothing rate for drag-look (1/s)
const SCROLL_STEP = 0.8 // meters walked per wheel notch
const SCROLL_SMOOTH = 6 // consume rate of banked scroll distance (1/s)

const WALK_HINT = 'Drag to look · Scroll or WASD to move · Double-click for mouse-look'
const WALK_LOCKED_HINT = 'WASD to move · Shift to sprint · Esc to release'

const easeOutCubic = (t: number): number => 1 - Math.pow(1 - t, 3)
const easeInOutCubic = (t: number): number =>
  t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2

export type ViewerMode = 'orbit' | 'walk'
export type ViewPreset = 'persp' | 'top'
export type Quality = 'high' | 'low'

/** First-person pose pushed to `onPose` each walk frame: world position (x, z)
 *  and a horizontal heading unit vector (hx, hz). Coordinates are the viewer's
 *  (recentered) world space — see {@link Viewer3D.getContentOffset}. */
export interface Pose {
  x: number
  z: number
  hx: number
  hz: number
}

/** One in-flight camera animation. `locked` tweens are mode transitions: user
 *  input can't cancel them and both control rigs stay disabled until `onDone`.
 *  Unlocked tweens (double-click refocus, frameAll, setView) are cancelled by
 *  any pointerdown/wheel so the camera never fights the mouse. Position always
 *  lerps; orientation comes from EITHER a quaternion slerp (mode transitions)
 *  or the orbit target lerp (orbit.update() re-aims at the moving target). */
interface CamTween {
  t: number
  dur: number
  locked: boolean
  emitPose: boolean
  ease: (t: number) => number
  fromPos: THREE.Vector3
  toPos: THREE.Vector3
  fromQuat: THREE.Quaternion | null
  toQuat: THREE.Quaternion | null
  fromTarget: THREE.Vector3 | null
  toTarget: THREE.Vector3 | null
  onDone?: () => void
}

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

  /** Optional callback pushed the first-person {@link Pose} every walk frame,
   *  for a live minimap. Drawn imperatively by the consumer (no React state). */
  onPose?: (pose: Pose) => void

  /** Fired whenever the render quality changes — including the automatic
   *  degrade to 'low' when high quality can't sustain 40 fps. */
  onQualityChange?: (q: Quality) => void

  readonly camera: THREE.PerspectiveCamera

  private container: HTMLElement
  private renderer: THREE.WebGLRenderer
  private scene: THREE.Scene
  private orbit: OrbitControls
  private walk: PointerLockControls
  private sun: THREE.DirectionalLight
  private clock = new THREE.Clock()
  private mode: ViewerMode = 'orbit'

  // Postprocessed pipeline (quality 'high'); bypassed entirely in 'low'.
  private composer: EffectComposer
  private renderPass: RenderPass
  private saoPass: SAOPass
  private outputPass: OutputPass
  private smaaPass: SMAAPass
  private quality: Quality = 'high'
  // Rolling FPS window for auto-degrade (never auto-upgrades).
  private fpsTime = 0
  private fpsFrames = 0
  private fpsWindows = 0

  /** Everything rebuilt on setState()/setContent() lives here so the rest of
   *  the scene (lights, ground, grid, environment) survives updates. */
  private content = new THREE.Group()
  private contentBounds = new THREE.Box3()
  /** Translation subtracted from imported content to recenter it on the origin
   *  (0 for generated plans). A minimap converts source coords via `p − offset`
   *  to match the recentered world the pose lives in. */
  private contentOffset = { x: 0, z: 0 }

  // Walk-mode collision: raycast against `content` at eye height; reused temps.
  private raycaster = new THREE.Raycaster()
  private tmpDir = new THREE.Vector3()
  private rayDir = new THREE.Vector3()

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
  /** Interior ceiling plane (normal facing DOWN), spanning the plan bounds at
   *  ceiling height. Shown only in walk mode so first-person feels enclosed; it
   *  never casts shadow (so it can't darken the room) and is hidden in orbit so
   *  it never occludes the top-down framing. */
  private ceiling: THREE.Mesh
  /** Sparse instanced "light fixture" rectangles on the walk ceiling — cheap
   *  emissive-looking planes (no real lights) so interiors read lit. Visible
   *  exactly when the ceiling is. Rebuilt whenever content bounds change. */
  private fixtures: THREE.InstancedMesh | null = null
  private fixtureGeo = new THREE.PlaneGeometry(0.6, 1.2)
  private fixtureMat = new THREE.MeshBasicMaterial({ color: 0xfff6e6 })
  /** Vertical sky gradient (canvas texture) used as scene.background. */
  private skyTex: THREE.CanvasTexture
  /** Soft radial darkening under the plan so the building sits on the ground
   *  instead of floating; repositioned/scaled to the content bounds. */
  private vignette: THREE.Mesh
  private vignetteTex: THREE.CanvasTexture
  private pmrem: THREE.PMREMGenerator
  private envRT: THREE.WebGLRenderTarget
  private framed = false
  private rafId = 0
  private disposed = false

  // Walk-mode input state.
  private keys = new Set<string>()
  // Walk-mode motion state: smoothed world-plane velocity + head-bob.
  private velX = 0
  private velZ = 0
  private bobPhase = 0
  private bobIntensity = 0 // eased 0→1 with speed; scales bob amplitude
  private bobX = 0 // lateral bob offset currently baked into camera.position
  private bobZ = 0
  // Drag-look (mouse-first look control; pointer lock not required): target
  // yaw/pitch driven by pointer drags, smoothed toward each frame.
  private dragging = false
  private dragX = 0
  private dragY = 0
  private lookYaw = 0
  private lookPitch = 0
  private curYaw = 0
  private curPitch = 0
  private lookEuler = new THREE.Euler(0, 0, 0, 'YXZ')
  /** Banked scroll-to-move distance (m, signed); consumed smoothly per frame. */
  private scrollMove = 0

  /** Current camera animation (mode transition / refocus / view move). */
  private camTween: CamTween | null = null

  constructor(container: HTMLElement) {
    this.container = container

    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.05 // slight lift for a crisp interior read
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    container.appendChild(this.renderer.domElement)

    this.scene = new THREE.Scene()
    this.skyTex = this.makeSkyTexture()
    this.scene.background = this.skyTex
    this.scene.fog = new THREE.Fog(FOG_COLOR, 45, 130)
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

    // Orbit controls, tuned for native mouse feel. `zoomToCursor` makes the
    // wheel dive toward whatever is under the pointer instead of the center.
    this.orbit = new OrbitControls(this.camera, this.renderer.domElement)
    this.orbit.enableDamping = true
    this.orbit.dampingFactor = 0.12
    this.orbit.rotateSpeed = 0.9
    this.orbit.panSpeed = 0.9
    this.orbit.zoomSpeed = 1.1
    this.orbit.zoomToCursor = true
    this.orbit.minDistance = 1
    this.orbit.maxDistance = 200 // tightened to the plan size on first framing
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

    // Ground (slightly darker than the horizon so the plan reads grounded) + grid.
    this.ground = new THREE.Mesh(
      new THREE.PlaneGeometry(400, 400),
      new THREE.MeshStandardMaterial({ color: 0xe3e0d8, roughness: 0.7, metalness: 0.05 }),
    )
    this.ground.rotation.x = -Math.PI / 2
    this.ground.position.y = -0.001
    this.ground.receiveShadow = true
    this.scene.add(this.ground)

    this.grid = new THREE.GridHelper(200, 200, 0xc9cdd3, 0xdee1e6)
    ;(this.grid.material as THREE.Material).transparent = true
    ;(this.grid.material as THREE.Material).opacity = 0.3
    this.scene.add(this.grid)

    // Radial ground vignette under the plan (sized in syncGroundDressing()).
    this.vignetteTex = this.makeVignetteTexture()
    this.vignette = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ map: this.vignetteTex, transparent: true, depthWrite: false }),
    )
    this.vignette.rotation.x = -Math.PI / 2
    this.vignette.renderOrder = -1 // draw before other transparents (zone plates)
    this.vignette.visible = false
    this.scene.add(this.vignette)

    // Interior ceiling (walk mode only). Unit plane scaled to the plan extent in
    // syncCeiling(); light matte material, downward normal, no shadow casting so
    // it encloses the view without darkening the lit interior.
    this.ceiling = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshStandardMaterial({ color: 0xf1f2f4, roughness: 0.95, metalness: 0, side: THREE.FrontSide }),
    )
    this.ceiling.rotation.x = Math.PI / 2 // normal → −Y (faces the walker below)
    this.ceiling.castShadow = false
    this.ceiling.receiveShadow = true
    this.ceiling.visible = false
    this.scene.add(this.ceiling)

    this.shared = new Set<THREE.BufferGeometry | THREE.Material>([
      this.unitBox,
      this.wallMat,
      this.meetingMat,
      this.fallCeilingMat,
      this.highlightMat,
    ])

    // Postprocessed pipeline. Order matters in r0.185: RenderPass and SAOPass
    // work in linear HDR (tone mapping is OFF when rendering into a target);
    // OutputPass applies ACES + sRGB; SMAA runs LAST, on display-referred
    // colors — the same placement the three.js FXAA/SMAA examples use.
    this.composer = new EffectComposer(this.renderer)
    this.renderPass = new RenderPass(this.scene, this.camera)
    this.saoPass = new SAOPass(this.scene, this.camera)
    const sao = this.saoPass.params
    sao.saoBias = 0.5
    sao.saoIntensity = 0.02 // subtle contact darkening, not dirt
    sao.saoScale = 6 // tuned for a 10–40 m interior at ~15–30 m camera distance
    sao.saoKernelRadius = 32
    sao.saoBlur = true
    sao.saoBlurRadius = 8
    sao.saoBlurStdDev = 4
    sao.saoBlurDepthCutoff = 0.001
    // SAO is wired but DISABLED by default: on software/limited GL stacks
    // (SwiftShader, some ANGLE paths) it corrupts large depth ranges — the
    // distant ground renders black regardless of saoScale (verified in
    // headless testing; not safely tunable from here). HQ still buys SMAA +
    // 2048 shadow maps + full DPR. Flip on once validated on target GPUs:
    // `viewer.saoPass.enabled = true`.
    this.saoPass.enabled = false
    this.outputPass = new OutputPass()
    this.smaaPass = new SMAAPass()
    this.composer.addPass(this.renderPass)
    this.composer.addPass(this.saoPass)
    this.composer.addPass(this.outputPass)
    this.composer.addPass(this.smaaPass)

    // Input.
    window.addEventListener('keydown', this.onKeyDown)
    window.addEventListener('keyup', this.onKeyUp)
    const el = this.renderer.domElement
    el.addEventListener('pointerdown', this.onPointerDown)
    el.addEventListener('pointermove', this.onPointerMove)
    el.addEventListener('pointerup', this.onPointerUp)
    el.addEventListener('pointercancel', this.onPointerUp)
    el.addEventListener('dblclick', this.onDblClick)
    el.addEventListener('wheel', this.onWheel, { passive: false })
    this.walk.addEventListener('lock', this.onWalkLock)
    this.walk.addEventListener('unlock', this.onWalkUnlock)

    this.resize()
    this.animate()
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /** Switch between orbit and first-person walkthrough. The camera FLIES to
   *  the new rig (600 ms ease-in-out) instead of teleporting: orbit→walk
   *  descends to the walk spawn; walk→orbit rises back to the frame-all view.
   *  Input is disabled during the transition; `onPose` keeps firing so the
   *  minimap tracks the descent. */
  setMode(mode: ViewerMode): void {
    if (mode === this.mode) return
    this.mode = mode
    if (this.walk.isLocked) this.walk.unlock()
    this.keys.clear()
    this.dragging = false
    this.scrollMove = 0
    this.orbit.enabled = false
    this.walk.enabled = false
    this.emitHint(null)

    if (mode === 'walk') {
      const spawn = this.computeWalkSpawn()
      this.camTween = {
        t: 0,
        dur: 0.6,
        locked: true,
        emitPose: true,
        ease: easeInOutCubic,
        fromPos: this.camera.position.clone(),
        toPos: spawn.pos,
        fromQuat: this.camera.quaternion.clone(),
        toQuat: this.lookQuat(spawn.pos, spawn.look),
        fromTarget: null,
        toTarget: null,
        onDone: () => {
          this.walk.enabled = true
          this.resetWalkMotion()
          this.syncLookFromCamera()
          this.syncCeiling()
          this.emitHint(WALK_HINT)
        },
      }
    } else {
      const pose = this.frameAllPose()
      this.camTween = {
        t: 0,
        dur: 0.6,
        locked: true,
        emitPose: false,
        ease: easeInOutCubic,
        fromPos: this.camera.position.clone(),
        toPos: pose.pos,
        fromQuat: this.camera.quaternion.clone(),
        toQuat: this.lookQuat(pose.pos, pose.target),
        fromTarget: null,
        toTarget: null,
        onDone: () => {
          this.orbit.target.copy(pose.target)
          this.orbit.enabled = true
          this.orbit.update()
        },
      }
    }
    this.syncCeiling() // hides the ceiling during the fly-through
  }

  /** Animated re-frame of the whole plan (orbit mode; no-op in walk). */
  frameAll(): void {
    if (this.mode !== 'orbit' || this.isTransitioning()) return
    const pose = this.frameAllPose()
    this.applyClipPlanes(pose.fitDist)
    this.startOrbitTween(pose.pos, pose.target, 0.7)
  }

  /** Animated fly to a standard view: 'top' = near-straight-down over the plan
   *  center (perspective camera kept); 'persp' = the 3/4 frame-all framing.
   *  Orbit mode only; cancelled by any user input. */
  setView(preset: ViewPreset): void {
    if (this.mode !== 'orbit' || this.isTransitioning()) return
    const pose = this.frameAllPose()
    let toPos: THREE.Vector3
    if (preset === 'top') {
      const box = this.contentBounds
      const radius = box.isEmpty()
        ? 15
        : Math.max(box.getBoundingSphere(new THREE.Sphere()).radius, 3)
      const vfov = (this.camera.fov * Math.PI) / 180
      // Fit against the tighter screen axis so the plan fills the view.
      const halfFov = Math.min(vfov / 2, Math.atan(Math.tan(vfov / 2) * Math.max(this.camera.aspect, 0.4)))
      const dist = (radius / Math.tan(halfFov)) * 1.06
      // Tiny horizontal offset keeps OrbitControls' azimuth stable at the pole.
      toPos = pose.target.clone().add(new THREE.Vector3(0, dist, dist * 0.02))
    } else {
      toPos = pose.pos
    }
    this.applyClipPlanes(pose.fitDist)
    this.startOrbitTween(toPos, pose.target, 0.7)
  }

  /** 'high' = postprocessed pipeline (SAO + SMAA, 2048 shadows, DPR ≤ 2);
   *  'low' = direct render (context MSAA, 1024 shadows, DPR ≤ 1.5). */
  setQuality(q: Quality): void {
    if (q === this.quality) return
    this.quality = q
    const shadow = q === 'high' ? 2048 : 1024
    this.sun.shadow.mapSize.set(shadow, shadow)
    this.sun.shadow.map?.dispose() // force reallocation at the new size
    this.sun.shadow.map = null
    this.resize() // re-applies the quality-dependent pixel ratio
    this.onQualityChange?.(q)
  }

  getQuality(): Quality {
    return this.quality
  }

  /** Rebuild the extruded plan from a fresh DocState (generated plans). */
  setState(state: DocState): void {
    this.clearContent()

    if (state.zones) {
      // Trace the floor-plate polygon ONCE per rebuild; zone plates are clipped
      // to it so tinted floors never stick out past an L-shaped building edge.
      const plate = platePolygonFromWalls(state.walls)
      for (const z of state.zones) this.buildZonePlate(z, plate)
    }
    for (const w of state.walls) this.content.add(this.buildWall(w))
    for (const c of state.components) {
      this.content.add(this.buildComponent(c, c.id === state.selection))
    }

    this.contentBounds = this.boundsFromState(state)
    this.contentOffset = { x: 0, z: 0 } // generated plans render in source coords
    if (!this.framed && !this.contentBounds.isEmpty()) this.frameBox(this.contentBounds)
    this.syncGroundDressing()
    this.syncCeiling()
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
    // Offset to map a source point to recentered world space: world = source − offset.
    this.contentOffset = { x: 0, z: 0 }
    if (!bounds.isEmpty()) {
      const center = bounds.getCenter(new THREE.Vector3())
      root.position.x -= center.x
      root.position.z -= center.z
      root.updateMatrixWorld(true)
      bounds.translate(new THREE.Vector3(-center.x, 0, -center.z))
      this.contentOffset = { x: center.x, z: center.z }
    }
    this.content.add(root)
    this.contentBounds = bounds
    this.framed = false
    if (!this.contentBounds.isEmpty()) this.frameBox(this.contentBounds)
    this.syncGroundDressing()
    this.syncCeiling()
  }

  /** The recentered plan bounds (world space). Minimap uses this for scaling. */
  getContentBounds(): THREE.Box3 {
    return this.contentBounds.clone()
  }

  /** Amount subtracted from source coords to recenter (0 for generated plans).
   *  Map a source point to viewer world space with `p − offset`. */
  getContentOffset(): { x: number; z: number } {
    return { x: this.contentOffset.x, z: this.contentOffset.z }
  }

  /** Teleport the first-person walker to a world (x, z) — e.g. a minimap click.
   *  Keeps the current heading + eye height, clears momentum + head-bob so the
   *  arrival is clean, and clamps to the same walkable bounds as movement. A
   *  no-op outside walk mode. Coordinates are the viewer's (recentered) world
   *  space — the same space {@link onPose} reports and the minimap fits. */
  moveWalkerTo(x: number, z: number): void {
    if (this.mode !== 'walk' || this.isTransitioning()) return
    const b = this.contentBounds
    let px = x
    let pz = z
    if (!b.isEmpty()) {
      px = THREE.MathUtils.clamp(px, b.min.x - WALK_MARGIN, b.max.x + WALK_MARGIN)
      pz = THREE.MathUtils.clamp(pz, b.min.z - WALK_MARGIN, b.max.z + WALK_MARGIN)
    } else {
      px = THREE.MathUtils.clamp(px, -100, 100)
      pz = THREE.MathUtils.clamp(pz, -100, 100)
    }
    this.resetWalkMotion()
    this.camera.position.set(px, EYE_HEIGHT, pz)
    this.emitPose()
  }

  resize(): void {
    const w = this.container.clientWidth || 1
    const h = this.container.clientHeight || 1
    const pr = Math.min(window.devicePixelRatio || 1, this.quality === 'high' ? 2 : 1.5)
    this.renderer.setPixelRatio(pr)
    this.renderer.setSize(w, h, false)
    this.composer.setPixelRatio(pr)
    this.composer.setSize(w, h) // propagates to every pass (SAO buffers, SMAA RTs)
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
    const el = this.renderer.domElement
    el.removeEventListener('pointerdown', this.onPointerDown)
    el.removeEventListener('pointermove', this.onPointerMove)
    el.removeEventListener('pointerup', this.onPointerUp)
    el.removeEventListener('pointercancel', this.onPointerUp)
    el.removeEventListener('dblclick', this.onDblClick)
    el.removeEventListener('wheel', this.onWheel)
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
    this.ceiling.geometry.dispose()
    ;(this.ceiling.material as THREE.Material).dispose()

    if (this.fixtures) {
      this.scene.remove(this.fixtures)
      this.fixtures.dispose()
      this.fixtures = null
    }
    this.fixtureGeo.dispose()
    this.fixtureMat.dispose()

    this.scene.background = null
    this.skyTex.dispose()
    this.vignette.geometry.dispose()
    ;(this.vignette.material as THREE.Material).dispose()
    this.vignetteTex.dispose()

    this.renderPass.dispose()
    this.saoPass.dispose()
    this.outputPass.dispose()
    this.smaaPass.dispose()
    this.composer.dispose()

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

  /** Thin colored floor plate under a zone (Rect or RectRing footprint). When
   *  the walls close into a floor-plate polygon (`plate`), each rect is clipped
   *  to it so zone tint never spills past an L-shaped building edge; with open
   *  walls (`plate` null) the original full-rect plates are kept. */
  private buildZonePlate(z: DocZone, plate: Pt[] | null): void {
    const tint = ZONE_TINT[z.zone_type] ?? 0x9aa2b1
    // Lazy: a zone fully outside the plate would otherwise orphan the material.
    let mat: THREE.MeshStandardMaterial | null = null
    const materialFor = () =>
      (mat ??= new THREE.MeshStandardMaterial({
        color: tint,
        roughness: 0.85,
        metalness: 0,
        transparent: true,
        opacity: 0.16,
      }))
    const add = (x: number, y: number, w: number, h: number) => {
      let mesh: THREE.Mesh
      if (plate) {
        const clipped = clipPolyToRect(plate, x, y, x + w, y + h)
        if (clipped.length < 3) return // rect lies wholly outside the plate
        // Orientation: plan (px, py) must land at world (px, 0.006, py). The
        // Shape lives in local XY; we bake plan points as local (px, −py) and
        // apply rotation.x = −π/2, which maps local (x, y, z) → (x, z, −y):
        // (px, −py, 0) → (px, 0, py) ✓, and the shape normal local +Z →
        // world +Y (faces up, so the single-sided material is visible).
        const shape = new THREE.Shape(clipped.map(([px, py]) => new THREE.Vector2(px, -py)))
        mesh = new THREE.Mesh(new THREE.ShapeGeometry(shape), materialFor())
        mesh.rotation.x = -Math.PI / 2
        mesh.position.y = 0.006 // no centering: the shape carries absolute plan coords
      } else {
        const geo = new THREE.PlaneGeometry(Math.max(w, 0.05), Math.max(h, 0.05))
        mesh = new THREE.Mesh(geo, materialFor())
        mesh.rotation.x = -Math.PI / 2
        mesh.position.set(x + w / 2, 0.006, y + h / 2)
      }
      // Walk-mode systems (spawn centroid, collision) must ignore zone plates;
      // ShapeGeometry would otherwise count as real content.
      mesh.userData.zonePlate = true
      mesh.receiveShadow = true
      this.content.add(mesh)
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

  /** The standard 3/4 framing of the current content: camera position, orbit
   *  target, and the fit distance. Pure math — mutates nothing. */
  private frameAllPose(): { pos: THREE.Vector3; target: THREE.Vector3; fitDist: number } {
    const box = this.contentBounds
    if (box.isEmpty()) {
      return { pos: new THREE.Vector3(12, 12, 16), target: new THREE.Vector3(), fitDist: 20 }
    }
    const center = box.getCenter(new THREE.Vector3())
    const radius = Math.max(box.getBoundingSphere(new THREE.Sphere()).radius, 3)
    const fov = (this.camera.fov * Math.PI) / 180
    const fitDist = (radius / Math.sin(fov / 2)) * 1.12
    const dir = new THREE.Vector3(0.55, 0.62, 1).normalize()
    return { pos: center.clone().addScaledVector(dir, fitDist), target: center, fitDist }
  }

  private applyClipPlanes(fitDist: number): void {
    this.camera.near = 0.1
    this.camera.far = fitDist * 4 + 200
    this.camera.updateProjectionMatrix()
  }

  /** Fit the camera + shadow frustum to an arbitrary bounding box (once,
   *  instantly — animated re-framing goes through {@link frameAll}). */
  private frameBox(box: THREE.Box3): void {
    const pose = this.frameAllPose()
    const center = pose.target
    const size = box.getSize(new THREE.Vector3())
    const span = Math.max(size.x, size.z, 4)

    this.orbit.target.copy(center)
    this.camera.position.copy(pose.pos)
    this.applyClipPlanes(pose.fitDist)
    this.orbit.maxDistance = pose.fitDist * 4
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

  /** Size + position the interior ceiling (and its light fixtures) to the plan
   *  bounds; shown only in walk mode AFTER the fly-in transition, so it never
   *  blocks the descending camera or the orbit framing. */
  private syncCeiling(): void {
    const b = this.contentBounds
    const show = this.mode === 'walk' && !this.isTransitioning() && !b.isEmpty()
    this.ceiling.visible = show
    if (this.fixtures) this.fixtures.visible = show
    if (!show) return
    const size = b.getSize(new THREE.Vector3())
    this.ceiling.scale.set(size.x + WALK_MARGIN * 2, size.z + WALK_MARGIN * 2, 1)
    this.ceiling.position.set((b.min.x + b.max.x) / 2, CEILING_HEIGHT, (b.min.z + b.max.z) / 2)
  }

  /** Reposition the ground vignette and rebuild the ceiling light-fixture grid
   *  for the current content bounds. Called on every content change. */
  private syncGroundDressing(): void {
    const b = this.contentBounds

    if (b.isEmpty()) {
      this.vignette.visible = false
    } else {
      const size = b.getSize(new THREE.Vector3())
      const span = Math.max(size.x, size.z, 10)
      this.vignette.scale.set(span * 2.6, span * 2.6, 1)
      this.vignette.position.set((b.min.x + b.max.x) / 2, 0.002, (b.min.z + b.max.z) / 2)
      this.vignette.visible = true
    }

    // Sparse fixture grid: one small "panel" every ~4.5 m, capped for safety.
    if (this.fixtures) {
      this.scene.remove(this.fixtures)
      this.fixtures.dispose() // instance buffer only; geometry/material are shared
      this.fixtures = null
    }
    if (b.isEmpty()) return
    const size = b.getSize(new THREE.Vector3())
    const nx = Math.max(1, Math.min(24, Math.round(size.x / 4.5)))
    const nz = Math.max(1, Math.min(24, Math.round(size.z / 4.5)))
    const mesh = new THREE.InstancedMesh(this.fixtureGeo, this.fixtureMat, nx * nz)
    const m = new THREE.Matrix4()
    const faceDown = new THREE.Matrix4().makeRotationX(Math.PI / 2) // plane normal → −Y
    let i = 0
    for (let ix = 0; ix < nx; ix++) {
      for (let iz = 0; iz < nz; iz++) {
        const x = b.min.x + ((ix + 0.5) / nx) * size.x
        const z = b.min.z + ((iz + 0.5) / nz) * size.z
        m.makeTranslation(x, CEILING_HEIGHT - 0.02, z).multiply(faceDown)
        mesh.setMatrixAt(i++, m)
      }
    }
    mesh.instanceMatrix.needsUpdate = true
    mesh.visible = this.ceiling.visible
    this.scene.add(mesh)
    this.fixtures = mesh
  }

  // ── World dressing textures ──────────────────────────────────────────────

  /** Vertical sky gradient: soft blue-grey zenith → warm off-white horizon.
   *  Used as scene.background (screen-space, so the gradient stays vertical);
   *  the fog shares the horizon color so distance fades coherently. Note: in
   *  r0.185 the background IS tone-mapped, so the hues shift slightly under
   *  ACES — the stops were chosen with that in mind. */
  private makeSkyTexture(): THREE.CanvasTexture {
    const c = document.createElement('canvas')
    c.width = 2
    c.height = 512
    const ctx = c.getContext('2d')!
    const g = ctx.createLinearGradient(0, 0, 0, 512)
    g.addColorStop(0, SKY_TOP)
    g.addColorStop(0.62, SKY_HORIZON)
    g.addColorStop(1, SKY_HORIZON)
    ctx.fillStyle = g
    ctx.fillRect(0, 0, 2, 512)
    const tex = new THREE.CanvasTexture(c)
    tex.colorSpace = THREE.SRGBColorSpace
    return tex
  }

  /** Soft radial darkening (transparent at the rim) laid flat under the plan. */
  private makeVignetteTexture(): THREE.CanvasTexture {
    const c = document.createElement('canvas')
    c.width = 512
    c.height = 512
    const ctx = c.getContext('2d')!
    const g = ctx.createRadialGradient(256, 256, 0, 256, 256, 256)
    g.addColorStop(0, 'rgba(60, 66, 76, 0.16)')
    g.addColorStop(0.55, 'rgba(60, 66, 76, 0.09)')
    g.addColorStop(1, 'rgba(60, 66, 76, 0)')
    ctx.fillStyle = g
    ctx.fillRect(0, 0, 512, 512)
    const tex = new THREE.CanvasTexture(c)
    tex.colorSpace = THREE.SRGBColorSpace
    return tex
  }

  // ── Camera animation ─────────────────────────────────────────────────────

  private isTransitioning(): boolean {
    return this.camTween?.locked === true
  }

  /** Cancel a cancellable (unlocked) tween — called on any pointer/wheel input
   *  so an animated view move never fights the mouse. Mode transitions
   *  (locked) always run to completion. */
  private cancelTween(): void {
    if (this.camTween && !this.camTween.locked) this.camTween = null
  }

  /** Start an unlocked orbit-mode tween: position lerps while orbit.update()
   *  re-aims the camera at the lerping target each frame. Replaces any tween. */
  private startOrbitTween(toPos: THREE.Vector3, toTarget: THREE.Vector3, dur: number): void {
    this.camTween = {
      t: 0,
      dur,
      locked: false,
      emitPose: false,
      ease: easeInOutCubic,
      fromPos: this.camera.position.clone(),
      toPos,
      fromQuat: null,
      toQuat: null,
      fromTarget: this.orbit.target.clone(),
      toTarget,
    }
  }

  private updateTween(dt: number): void {
    const tw = this.camTween!
    tw.t += dt
    const k = tw.ease(Math.min(tw.t / tw.dur, 1))
    this.camera.position.lerpVectors(tw.fromPos, tw.toPos, k)
    if (tw.fromQuat && tw.toQuat) {
      this.camera.quaternion.slerpQuaternions(tw.fromQuat, tw.toQuat, k)
    }
    if (tw.fromTarget && tw.toTarget) {
      this.orbit.target.lerpVectors(tw.fromTarget, tw.toTarget, k)
    }
    if (tw.emitPose) this.emitPose()
    if (tw.t >= tw.dur) {
      this.camTween = null
      tw.onDone?.()
    }
  }

  /** Quaternion that looks from `from` toward `at` with +Y up (no roll). */
  private lookQuat(from: THREE.Vector3, at: THREE.Vector3): THREE.Quaternion {
    const m = new THREE.Matrix4().lookAt(from, at, new THREE.Vector3(0, 1, 0))
    return new THREE.Quaternion().setFromRotationMatrix(m)
  }

  // ── Walk mode ────────────────────────────────────────────────────────────

  /** Where the first-person camera should stand + look when entering walk
   *  mode. The bounding-box center is a poor spawn for a large L-shaped or
   *  sparse plan — it lands in empty space facing a blank wall. We instead aim
   *  at the *content centroid* (the dense area; see {@link contentCentroid}),
   *  then stand a modest step back from it along the LONGER horizontal axis
   *  and look down that axis toward the greater content extent — so the walker
   *  starts *among* the furniture looking into the room, not shoved against a
   *  perimeter wall. The backoff is capped (a big L-shaped plan must not spawn
   *  the camera 15 m away at the far glazing). Pure math — mutates nothing. */
  private computeWalkSpawn(): { pos: THREE.Vector3; look: THREE.Vector3 } {
    const b = this.contentBounds
    if (b.isEmpty()) {
      return { pos: new THREE.Vector3(0, EYE_HEIGHT, 6), look: new THREE.Vector3(0, EYE_HEIGHT, 0) }
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
    return alongX
      ? { pos: new THREE.Vector3(camAxis, EYE_HEIGHT, c.z), look: new THREE.Vector3(lookAxis, EYE_HEIGHT, c.z) }
      : { pos: new THREE.Vector3(c.x, EYE_HEIGHT, camAxis), look: new THREE.Vector3(c.x, EYE_HEIGHT, lookAxis) }
  }

  /** Average world position of the meaningful solid content (walls, furniture),
   *  which lands in the dense area rather than the geometric bbox center. Floor
   *  planes (PlaneGeometry) and zone plates (`userData.zonePlate`, which may be
   *  clipped ShapeGeometry) are excluded so a large empty footprint doesn't
   *  pull the spawn into a void. Returns null if nothing qualifies. */
  private contentCentroid(): THREE.Vector3 | null {
    this.content.updateMatrixWorld(true)
    const acc = new THREE.Vector3()
    const v = new THREE.Vector3()
    let n = 0
    this.content.traverse((obj) => {
      const mesh = obj as THREE.Mesh
      if (!mesh.isMesh || !mesh.geometry) return
      const geo = mesh.geometry as THREE.BufferGeometry
      if (geo.type === 'PlaneGeometry' || mesh.userData.zonePlate) return // floors / zone plates
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

  /** Zero all walk motion (momentum, head-bob, banked scroll) for a clean
   *  spawn/teleport arrival. */
  private resetWalkMotion(): void {
    this.velX = 0
    this.velZ = 0
    this.bobPhase = 0
    this.bobIntensity = 0
    this.bobX = 0
    this.bobZ = 0
    this.scrollMove = 0
  }

  /** Adopt the camera's current orientation as the drag-look yaw/pitch state —
   *  called when walk input takes over (after the fly-in, and after pointer
   *  lock releases, since PointerLockControls rotated the camera meanwhile). */
  private syncLookFromCamera(): void {
    this.lookEuler.setFromQuaternion(this.camera.quaternion, 'YXZ')
    this.lookYaw = this.curYaw = this.lookEuler.y
    this.lookPitch = this.curPitch = THREE.MathUtils.clamp(this.lookEuler.x, -PITCH_LIMIT, PITCH_LIMIT)
  }

  private updateWalk(dt: number): void {
    // Recover the "true" walker position by removing last frame's lateral bob,
    // so the oscillation never accumulates into real displacement.
    this.camera.position.x -= this.bobX
    this.camera.position.z -= this.bobZ

    // Drag-look: ease the camera toward the target yaw/pitch (slight inertia,
    // never raw). Skipped while pointer-locked — PointerLockControls owns the
    // camera orientation then, and we resync on unlock.
    if (!this.walk.isLocked) {
      const lk = Math.min(LOOK_SMOOTH * dt, 1)
      this.curYaw += (this.lookYaw - this.curYaw) * lk
      this.curPitch += (this.lookPitch - this.curPitch) * lk
      this.lookEuler.set(this.curPitch, this.curYaw, 0)
      this.camera.quaternion.setFromEuler(this.lookEuler)
    }

    // Read intent. Shift sprints.
    const sprint = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight')
    const targetSpeed = WALK_SPEED * (sprint ? SPRINT_MULT : 1)
    const fwd = (this.keys.has('KeyW') || this.keys.has('ArrowUp') ? 1 : 0) +
      (this.keys.has('KeyS') || this.keys.has('ArrowDown') ? -1 : 0)
    const strafe = (this.keys.has('KeyD') || this.keys.has('ArrowRight') ? 1 : 0) +
      (this.keys.has('KeyA') || this.keys.has('ArrowLeft') ? -1 : 0)

    // Horizontal forward + right basis from the current look direction.
    const f = this.camera.getWorldDirection(this.tmpDir)
    f.y = 0
    if (f.lengthSq() < 1e-6) f.set(0, 0, -1)
    f.normalize()
    const rx = -f.z // right = forward × up  (up = +Y)
    const rz = f.x

    // Desired world-plane velocity, then ramp the actual velocity toward it
    // (gentle acceleration on press, deceleration on release — no snapping).
    let desVX = 0
    let desVZ = 0
    const moving = fwd !== 0 || strafe !== 0
    if (moving) {
      let dirX = f.x * fwd + rx * strafe
      let dirZ = f.z * fwd + rz * strafe
      const l = Math.hypot(dirX, dirZ) || 1
      dirX /= l
      dirZ /= l
      desVX = dirX * targetSpeed
      desVZ = dirZ * targetSpeed
    }
    const k = Math.min((moving ? WALK_ACCEL : WALK_DECEL) * dt, 1)
    this.velX += (desVX - this.velX) * k
    this.velZ += (desVZ - this.velZ) * k

    // Integrate + collide per axis so the walker slides along a wall instead of
    // sticking; a blocked axis also drops its velocity so momentum doesn't pile
    // up against the wall (and head-bob settles).
    const dx = this.velX * dt
    const dz = this.velZ * dt
    if (Math.abs(dx) > 1e-6) {
      const allowed = this.collideAxis(dx, 1, 0)
      this.camera.position.x += allowed
      if (Math.abs(allowed) < Math.abs(dx) - 1e-6) this.velX = 0
    }
    if (Math.abs(dz) > 1e-6) {
      const allowed = this.collideAxis(dz, 0, 1)
      this.camera.position.z += allowed
      if (Math.abs(allowed) < Math.abs(dz) - 1e-6) this.velZ = 0
    }

    // Scroll-to-move: consume the banked wheel distance as a smooth glide along
    // the horizontal look direction, collision-checked like WASD movement.
    if (Math.abs(this.scrollMove) > 1e-3) {
      const step = this.scrollMove * Math.min(SCROLL_SMOOTH * dt, 1)
      this.scrollMove -= step
      const sx = f.x * step
      const sz = f.z * step
      if (Math.abs(sx) > 1e-6) this.camera.position.x += this.collideAxis(sx, 1, 0)
      if (Math.abs(sz) > 1e-6) this.camera.position.z += this.collideAxis(sz, 0, 1)
    } else {
      this.scrollMove = 0
    }

    // Clamp to the plan bounds (no infinite wander).
    const p = this.camera.position
    const b = this.contentBounds
    if (!b.isEmpty()) {
      p.x = THREE.MathUtils.clamp(p.x, b.min.x - WALK_MARGIN, b.max.x + WALK_MARGIN)
      p.z = THREE.MathUtils.clamp(p.z, b.min.z - WALK_MARGIN, b.max.z + WALK_MARGIN)
    } else {
      p.x = THREE.MathUtils.clamp(p.x, -100, 100)
      p.z = THREE.MathUtils.clamp(p.z, -100, 100)
    }

    // Report the steady (un-bobbed) pose so the minimap marker doesn't jitter.
    p.y = EYE_HEIGHT
    this.emitPose()

    // Head-bob: intensity eases toward the current speed fraction; the phase
    // advances with it. Vertical rides at 2× the step rate (both feet per cycle),
    // lateral at 1× (a subtle side-to-side sway). Both vanish smoothly at rest.
    const speedFrac = Math.min(Math.hypot(this.velX, this.velZ) / WALK_SPEED, 1)
    this.bobIntensity += (speedFrac - this.bobIntensity) * Math.min(6 * dt, 1)
    this.bobPhase += dt * BOB_RATE * (0.6 + 0.4 * speedFrac)
    const vBob = Math.sin(this.bobPhase * 2) * BOB_AMP_V * this.bobIntensity
    const latAmt = Math.sin(this.bobPhase) * BOB_AMP_LAT * this.bobIntensity
    this.bobX = rx * latAmt
    this.bobZ = rz * latAmt
    p.y = EYE_HEIGHT + vBob
    p.x += this.bobX
    p.z += this.bobZ
  }

  /** Resolve a single world-axis move against walls. The eye-height ray only
   *  intersects tall geometry (walls, glazing, partitions, meeting pods) — desks
   *  and chairs sit below 1.6 m, so you never snag on furniture. Floor planes
   *  (PlaneGeometry) and zone plates (`userData.zonePlate`, possibly clipped
   *  ShapeGeometry) are ignored. Returns the allowed signed distance. */
  private collideAxis(amount: number, ux: number, uz: number): number {
    const mag = Math.abs(amount)
    if (mag < 1e-5) return amount
    const s = Math.sign(amount)
    this.raycaster.set(this.camera.position, this.rayDir.set(ux * s, 0, uz * s))
    this.raycaster.far = mag + PLAYER_RADIUS
    const hits = this.raycaster.intersectObject(this.content, true)
    for (const h of hits) {
      const geo = (h.object as THREE.Mesh).geometry as THREE.BufferGeometry | undefined
      if (!geo || geo.type === 'PlaneGeometry' || h.object.userData.zonePlate) continue // floors / zone plates
      return s * Math.max(0, h.distance - PLAYER_RADIUS)
    }
    return amount
  }

  /** Push the current first-person pose to the minimap consumer. */
  private emitPose(): void {
    if (!this.onPose) return
    const f = this.camera.getWorldDirection(this.tmpDir)
    f.y = 0
    if (f.lengthSq() < 1e-6) f.set(0, 0, -1)
    f.normalize()
    this.onPose({ x: this.camera.position.x, z: this.camera.position.z, hx: f.x, hz: f.z })
  }

  // ── Input handlers ───────────────────────────────────────────────────────

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

  /** Left-drag in walk mode = Matterport-style grab-look: the world follows
   *  the cursor (drag right → look left). In orbit mode this only cancels any
   *  animated view move so the camera never fights the mouse. */
  private onPointerDown = (e: PointerEvent): void => {
    this.cancelTween()
    if (this.mode !== 'walk' || this.walk.isLocked || this.isTransitioning() || e.button !== 0) return
    this.dragging = true
    this.dragX = e.clientX
    this.dragY = e.clientY
    this.renderer.domElement.setPointerCapture(e.pointerId)
  }

  private onPointerMove = (e: PointerEvent): void => {
    if (!this.dragging || this.mode !== 'walk' || this.walk.isLocked) return
    const dx = e.clientX - this.dragX
    const dy = e.clientY - this.dragY
    this.dragX = e.clientX
    this.dragY = e.clientY
    this.lookYaw += dx * DRAG_LOOK_SENS
    this.lookPitch = THREE.MathUtils.clamp(this.lookPitch + dy * DRAG_LOOK_SENS, -PITCH_LIMIT, PITCH_LIMIT)
  }

  private onPointerUp = (e: PointerEvent): void => {
    if (!this.dragging) return
    this.dragging = false
    const el = this.renderer.domElement
    if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId)
  }

  /** Double-click: in walk mode, engage pointer lock (mouse-look). In orbit
   *  mode, refocus — raycast the click against real content (zone plates
   *  excluded; ground/grid aren't in `content`) and ease the orbit pivot (and
   *  the camera by the same delta) onto the hit point. */
  private onDblClick = (e: MouseEvent): void => {
    if (this.isTransitioning()) return
    if (this.mode === 'walk') {
      if (!this.walk.isLocked) this.walk.lock()
      return
    }
    const rect = this.renderer.domElement.getBoundingClientRect()
    const ndc = new THREE.Vector2(
      ((e.clientX - rect.left) / Math.max(rect.width, 1)) * 2 - 1,
      -((e.clientY - rect.top) / Math.max(rect.height, 1)) * 2 + 1,
    )
    this.raycaster.setFromCamera(ndc, this.camera)
    this.raycaster.far = Infinity // collideAxis shortens it; restore for picking
    const hits = this.raycaster.intersectObject(this.content, true)
    const hit = hits.find((h) => !h.object.userData.zonePlate)
    if (!hit) return
    const toPos = this.camera.position.clone().add(hit.point).sub(this.orbit.target)
    this.camTween = {
      t: 0,
      dur: 0.4,
      locked: false,
      emitPose: false,
      ease: easeOutCubic,
      fromPos: this.camera.position.clone(),
      toPos,
      fromQuat: null,
      toQuat: null,
      fromTarget: this.orbit.target.clone(),
      toTarget: hit.point.clone(),
    }
  }

  /** Wheel: in walk mode, bank forward/backward glide distance (~0.8 m per
   *  notch, consumed smoothly + collision-checked in updateWalk). In orbit
   *  mode OrbitControls owns the wheel; we only cancel animated view moves. */
  private onWheel = (e: WheelEvent): void => {
    if (this.mode === 'walk') {
      e.preventDefault()
      if (this.isTransitioning()) return
      const px = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY // lines → px
      const notches = THREE.MathUtils.clamp(px / 100, -3, 3)
      this.scrollMove = THREE.MathUtils.clamp(this.scrollMove - notches * SCROLL_STEP, -10, 10)
    } else {
      this.cancelTween()
    }
  }

  private onWalkLock = (): void => {
    this.dragging = false
    if (this.mode === 'walk') this.emitHint(WALK_LOCKED_HINT)
  }

  private onWalkUnlock = (): void => {
    this.keys.clear()
    // PointerLockControls rotated the camera while locked; adopt that as the
    // new drag-look state so the view doesn't snap back.
    this.syncLookFromCamera()
    if (this.mode === 'walk') this.emitHint(WALK_HINT)
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
    const raw = this.clock.getDelta()
    const dt = Math.min(raw, 0.1)

    if (this.camTween) this.updateTween(dt)
    if (this.mode === 'walk') {
      if (this.walk.enabled) this.updateWalk(dt)
    } else if (!this.isTransitioning()) {
      // orbit.update() also re-aims the camera at a tweening orbit target.
      this.orbit.update()
    }

    if (this.quality === 'high') this.composer.render()
    else this.renderer.render(this.scene, this.camera)

    // Rolling ~2 s FPS window → auto-degrade high → low below 40 fps. The
    // first window is discarded (shader compiles / first-frame jank), as is
    // any window containing a huge delta (backgrounded tab).
    if (raw > 0.5) {
      this.fpsTime = 0
      this.fpsFrames = 0
    } else {
      this.fpsTime += raw
      this.fpsFrames++
      if (this.fpsTime >= 2) {
        const fps = this.fpsFrames / this.fpsTime
        this.fpsWindows++
        if (this.fpsWindows > 1 && this.quality === 'high' && fps < 40) this.setQuality('low')
        this.fpsTime = 0
        this.fpsFrames = 0
      }
    }
  }
}
