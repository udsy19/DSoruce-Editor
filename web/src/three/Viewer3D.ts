import * as THREE from 'three'
// `three/addons/*` is the modern published alias for `three/examples/jsm/*`
// (defined in three's package.json `exports`; @types/three maps it too).
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { SAOPass } from 'three/addons/postprocessing/SAOPass.js'
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js'
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js'
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js'
import { Sky } from 'three/addons/objects/Sky.js'
import type { DocState, DocComponent, DocWall, DocZone, ZoneType } from '../types/doc'
import { catByCategory } from '../editor/catalog'
import { buildFurniture3D, TEXTURES } from './furniture3d'
import { clipPolyToRect, platePolygonFromWalls, type Pt } from '../util/clip'
import {
  THEMES,
  loadThemeId,
  saveThemeId,
  type ThemeId,
  type ViewerTheme,
  NEUTRAL_FLOOR_ZONES,
} from './theme'
import { SELECTION_ACCENT_HEX } from '../editor/planStyle'

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
 * ambient from RoomEnvironment (via PMREMGenerator). Three quality tiers, all
 * driven by ONE EffectComposer whose pass list is
 *   [RenderPass, SAOPass, GTAOPass, UnrealBloomPass, OutputPass, SMAAPass]
 * and where each tier just toggles pass `.enabled`:
 *  - 'low'    — bypass the composer entirely (direct render, context MSAA,
 *               1024 shadow map, DPR ≤ 1.5).
 *  - 'high'   — RenderPass → OutputPass → SMAA (SAO/GTAO/bloom all disabled;
 *               2048 shadow map, DPR ≤ 2). Today's look, untouched.
 *  - 'render' — the Enscape tier: a physical Sky dome + PMREM sky-environment,
 *               RenderPass → GTAO → OutputPass → SMAA (GTAO in linear HDR before
 *               OutputPass tone-maps; SMAA last on display-referred colors),
 *               4096 shadow map, exposure 0.5, and a gentler sky-environment
 *               intensity so the bright atmosphere doesn't wash the interior out.
 *               The directional sun + the Sky's sun uniform + the sky environment
 *               all derive from {@link Viewer3D.setSun}. (Bloom is wired but stays
 *               OFF — see applyPipeline: it blooms the HDR sky to a white void.)
 * A rolling FPS window auto-degrades one tier at a time below 40 fps
 * (render → high → low); it never auto-upgrades.
 *
 * Software-GL guard: 'render' silently drops GTAO+bloom (keeping sky/sun/
 * shadows) on SwiftShader/llvmpipe/ANGLE-software stacks, where depth-based
 * post corrupts large depth ranges — the same reason SAO ships disabled.
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

// Floor-to-ceiling heights (m). Exported so the orthographic section renderer
// (three/sectionRender.ts) extrudes walls/ceiling to the SAME datum the 3D
// viewer does — one source of truth, no drift between the walkthrough and the
// section sheets.
export const WALL_HEIGHT = 2.6
export const CEILING_HEIGHT = 2.6
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

// ── 'render' tier (Enscape-like) tuning ─────────────────────────────────────
// Sun angles are spherical: elevation above the horizon, azimuth clockwise from
// world +Z. Default is a warm mid-morning key light.
const SUN_DEFAULT_ELEV = 42 // degrees above horizon
const SUN_DEFAULT_AZ = 135 // degrees clockwise from +Z
const SUN_ELEV_MIN = 5
const SUN_ELEV_MAX = 90
// Debounce for regenerating the sky PMREM environment while a slider drags.
// (PMREM from a lone sky mesh is cheap, but per-tick regen is still wasteful.)
const SKY_ENV_DEBOUNCE_MS = 150
// Tone-mapping exposure: the physical sky is bright, so 'render' sits well below
// the crisp-interior lift used by 'high'/'low'. At 0.75 the atmospheric sky (a
// large HDR value) still tone-mapped to near-white and flooded the interior; 0.5
// lands a legible daylit interior with real wall/floor shading.
const EXPOSURE_DEFAULT = 1.0 // ACES neutral; 1.05 washed the light studio walls flat
const EXPOSURE_RENDER = 0.5
// Image-based ambient intensity per source (RoomEnvironment vs. sky PMREM). The
// sky PMREM integrates the very bright atmosphere, so it drives surfaces far
// harder than RoomEnvironment at the same intensity — keep both low so ambient
// fills shadows without blowing the albedo out (0.85 room ambient left the walls
// reading as flat white; 0.75 lets the sun shading and shadows carry depth).
const ENV_INTENSITY_ROOM = 0.75
const ENV_INTENSITY_SKY = 0.5
// Ceiling light-fixture panel color (walk mode only); an unlit warm white.
const FIXTURE_COLOR = 0xfff6e6

const easeOutCubic = (t: number): number => 1 - Math.pow(1 - t, 3)
const easeInOutCubic = (t: number): number =>
  t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2

export type ViewerMode = 'orbit' | 'walk'
export type ViewPreset = 'persp' | 'top'
/** Render quality tiers. 'render' is the physically-plausible "Enscape" look
 *  (physical sky + sun, GTAO, subtle bloom, 4096 shadows); see the class doc. */
export type Quality = 'high' | 'low' | 'render'

/** Metadata stamped on pickable scene objects via `userData.pick`.
 *  - `component` — a generated-plan component (setState path); `id` is DocComponent.id.
 *  - `zone`      — a zone floor plate; clicking the room floor selects the room.
 *  - `furniture` — an imported-drawing furniture instance; `index` into Drawing.furniture.
 *  - `shell`     — merged building fabric (walls/glazing/…); reported but not
 *                  selectable UI-wise (wrappers treat it as a card-close). */
export interface PickInfo {
  kind: 'component' | 'zone' | 'furniture' | 'shell'
  id?: number
  index?: number
  name?: string
  category?: string
  label?: string
  zoneType?: string
}

/** What {@link Viewer3D.onPick} delivers: the picked object's {@link PickInfo}
 *  plus the click position in CSS px relative to the viewer container (for
 *  anchoring a selection card). `null` = clicked empty space (close the card). */
export interface PickHit extends PickInfo {
  screen: { x: number; y: number }
}

// Clean-click discrimination: a pick fires only for press→release under both
// thresholds, so orbit drags / damped rotations never produce phantom picks.
const CLICK_MAX_MS = 250
const CLICK_MAX_PX = 5

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

export class Viewer3D {
  /** Optional overlay callback for the current walkthrough hint (or null). */
  onModeHint?: (text: string | null) => void

  /** Optional callback pushed the first-person {@link Pose} every walk frame,
   *  for a live minimap. Drawn imperatively by the consumer (no React state). */
  onPose?: (pose: Pose) => void

  /** Fired whenever the render quality changes — including the automatic
   *  degrade to 'low' when high quality can't sustain 40 fps. */
  onQualityChange?: (q: Quality) => void

  /** Fired on a clean click in ORBIT mode (press→release < 250 ms, < 5 px of
   *  movement — drags and orbit rotations never trigger it) with the nearest
   *  picked object's metadata, or `null` for empty space. The raycast walks up
   *  the parent chain to the closest ancestor carrying `userData.pick`; hits
   *  are distance-sorted, so furniture/components (which sit above the zone
   *  floor plates) win over the zone under them. Double-click refocus still
   *  works — a pick fires alongside it by design. */
  onPick?: (hit: PickHit | null) => void

  readonly camera: THREE.PerspectiveCamera

  private container: HTMLElement
  private renderer: THREE.WebGLRenderer
  private scene: THREE.Scene
  private orbit: OrbitControls
  private walk: PointerLockControls
  private sun: THREE.DirectionalLight
  private clock = new THREE.Clock()
  private mode: ViewerMode = 'orbit'

  // Postprocessed pipeline ('high' and 'render'); bypassed entirely in 'low'.
  // One composer, pass list [render, sao, gtao, bloom, output, smaa]; the tier
  // selects a chain by toggling each pass's `.enabled` (see applyPipeline()).
  private composer: EffectComposer
  private renderPass: RenderPass
  private saoPass: SAOPass
  private gtaoPass: GTAOPass
  private bloomPass: UnrealBloomPass
  private outputPass: OutputPass
  private smaaPass: SMAAPass
  private quality: Quality = 'high'
  /** True on software/limited GL stacks (SwiftShader/llvmpipe/ANGLE-software),
   *  where depth-based post (SAO/GTAO) corrupts large depth ranges. 'render'
   *  then keeps sky/sun/shadows but drops GTAO+bloom. */
  private softwareGL = false
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
  // Two wall tones mirror the 2D lineweight hierarchy: `wallMat` for generated
  // interior partitions (lighter), `wallExtMat` for the exterior/plate walls
  // (heavier & darker). Both colors are (re)set from the active theme; a plaster
  // roughness map gives them tooth so they don't read as flat white. See setTheme.
  private wallMat = new THREE.MeshStandardMaterial({
    color: 0xe0e2e6,
    roughness: 0.92,
    roughnessMap: TEXTURES.plasterRough,
    metalness: 0,
  })
  private wallExtMat = new THREE.MeshStandardMaterial({
    color: 0xc3c6cd,
    roughness: 0.88,
    roughnessMap: TEXTURES.plasterRough,
    metalness: 0,
  })
  // Glazed partitions (glass fronts of generated rooms). Cheap transparency,
  // not physical transmission: a test-fit can carry one glass front per room,
  // and each transmissive material would multiply full-scene render passes.
  private glassWallMat = new THREE.MeshStandardMaterial({
    color: 0xbfd9e6,
    roughness: 0.08,
    metalness: 0,
    transparent: true,
    opacity: 0.25,
    side: THREE.DoubleSide,
    depthWrite: false,
  })
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
  private highlightMat = new THREE.LineBasicMaterial({ color: SELECTION_ACCENT_HEX })
  private shared: Set<THREE.BufferGeometry | THREE.Material>

  // Click-pick state (orbit mode). One persistent amber wireframe box is
  // repositioned/rescaled around each picked object (its opacity pulses in
  // animate()) — nothing is allocated per pick, so "disposal on next pick" is
  // just hiding/moving it; the geometry+material are freed once in dispose().
  // Separate material from `highlightMat` so the pulse doesn't affect the 2D
  // selection outline that shares highlightMat.
  private pickOutlineMat = new THREE.LineBasicMaterial({
    color: SELECTION_ACCENT_HEX,
    transparent: true,
    opacity: 0.9,
  })
  private pickOutline: THREE.LineSegments
  private clickValid = false
  private clickX = 0
  private clickY = 0
  private clickTime = 0

  /** Framing staleness: false until the user gives any camera input (pointer,
   *  wheel, mode switch) after content was framed. While false, resize() re-runs
   *  the instant framing so late container-size settling (panel layout, view
   *  toggles) can't leave the plan stuck in a corner. One interaction flips it
   *  forever (until the next fresh framing) — auto-reframe never fights the
   *  user's camera. */
  private userMoved = false

  /** Active material theme (persisted). Drives zone floors, wall tones, ground,
   *  and grid. Applied live by {@link setTheme} without a content rebuild. */
  private theme: ViewerTheme = THEMES[loadThemeId()]
  /** One floor material per zone-type (never per plate), rebuilt on theme
   *  change. Opaque, carpet-textured, tinted to the zone's theme color so the
   *  plan reads by room in 3D. */
  private zoneFloorMats = new Map<ZoneType, THREE.MeshStandardMaterial>()
  private floorBaseMat!: THREE.MeshStandardMaterial
  /** Shared carpet map (cloned so its repeat is independent of furniture floors). */
  private floorTex = TEXTURES.carpet.clone()

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
  private fixtureMat = new THREE.MeshBasicMaterial({ color: FIXTURE_COLOR })
  /** Vertical sky gradient (canvas texture) used as scene.background. */
  private skyTex: THREE.CanvasTexture
  /** Soft radial darkening under the plan so the building sits on the ground
   *  instead of floating; repositioned/scaled to the content bounds. */
  private vignette: THREE.Mesh
  private vignetteTex: THREE.CanvasTexture
  private pmrem: THREE.PMREMGenerator
  /** RoomEnvironment PMREM (the 'high'/'low' ambient). */
  private envRT: THREE.WebGLRenderTarget
  /** Physical atmospheric sky dome (Sky.js). Visible only in 'render'; in
   *  'high'/'low' it's hidden and scene.background is the gradient canvas. */
  private sky: Sky
  /** Throwaway scene used to PMREM the sky in isolation (the sky mesh is briefly
   *  reparented into it so walls/furniture don't leak into the environment). */
  private skyScene: THREE.Scene
  /** PMREM of the sky (the 'render' ambient), regenerated on sun changes. */
  private skyEnvRT: THREE.WebGLRenderTarget | null = null
  /** Debounce handle for {@link regenerateSkyEnv}. */
  private skyEnvTimer: ReturnType<typeof setTimeout> | null = null
  // Sun position as spherical angles (source of truth for sun light + sky).
  private sunElevationDeg = SUN_DEFAULT_ELEV
  private sunAzimuthDeg = SUN_DEFAULT_AZ
  /** Once the user drives {@link setSun}, the directional light follows the
   *  angles in every tier; until then 'high'/'low' keep the content-relative
   *  3/4 key light (today's look). */
  private sunUserSet = false
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
    this.renderer.toneMappingExposure = EXPOSURE_DEFAULT // 'high'/'low' interior read
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    container.appendChild(this.renderer.domElement)

    // Detect a software rasterizer once — 'render' post degrades on these.
    this.softwareGL = this.detectSoftwareGL()

    this.scene = new THREE.Scene()
    this.skyTex = this.makeSkyTexture()
    this.scene.background = this.skyTex
    this.scene.fog = new THREE.Fog(FOG_COLOR, 45, 130)
    this.scene.add(this.content)

    this.camera = new THREE.PerspectiveCamera(55, 1, 0.1, 1000)
    this.camera.position.set(12, 12, 16)

    // Image-based ambient: RoomEnvironment → PMREM → scene.environment (the
    // 'high'/'low' tiers). 'render' swaps in a sky PMREM instead (see setQuality).
    this.pmrem = new THREE.PMREMGenerator(this.renderer)
    const roomEnv = new RoomEnvironment()
    this.envRT = this.pmrem.fromScene(roomEnv, 0.04)
    this.scene.environment = this.envRT.texture
    this.scene.environmentIntensity = ENV_INTENSITY_ROOM
    roomEnv.dispose()

    // Physical atmospheric sky (Sky.js). Its vertex shader pins depth to the far
    // plane (gl_Position.z = w), so any large scale draws behind everything as
    // long as the camera stays inside the dome. Hidden until the 'render' tier.
    this.sky = new Sky()
    this.sky.scale.setScalar(10000)
    const skyU = this.sky.material.uniforms
    skyU.turbidity.value = 3.5
    skyU.rayleigh.value = 1.2
    skyU.mieCoefficient.value = 0.004
    skyU.mieDirectionalG.value = 0.85
    this.sky.visible = false
    this.scene.add(this.sky)
    this.skyScene = new THREE.Scene() // holds the sky alone during PMREM

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

    // Carpet map for the zone floors — cloned so its repeat is independent of
    // the shared furniture floor texture. UVs on the plates are in
    // plan meters, so a sub-unit repeat tiles the fine speckle every ~2 m.
    this.floorTex.repeat.set(0.5, 0.5)
    this.floorTex.needsUpdate = true

    // Ground (theme-toned so the plan reads grounded, not a white void) + grid.
    // Colors are set from the active theme by applyTheme() below.
    this.ground = new THREE.Mesh(
      new THREE.PlaneGeometry(400, 400),
      new THREE.MeshStandardMaterial({ color: 0xd8d2c4, roughness: 0.85, metalness: 0.02 }),
    )
    this.ground.rotation.x = -Math.PI / 2
    this.ground.position.y = -0.001
    this.ground.receiveShadow = true
    this.scene.add(this.ground)

    this.grid = this.makeGrid()
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
      this.wallExtMat,
      this.glassWallMat,
      this.meetingMat,
      this.fallCeilingMat,
      this.highlightMat,
    ])
    // Zone floor materials are added to `shared` as applyTheme() creates them.

    // Pick highlight: lives in `scene` (NOT `content`) so pick raycasts and
    // walk collision never hit it, and clearContent() can't dispose it.
    this.pickOutline = new THREE.LineSegments(new THREE.EdgesGeometry(this.unitBox), this.pickOutlineMat)
    this.pickOutline.visible = false
    this.scene.add(this.pickOutline)

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

    // GTAO — the 'render' tier's interior AO (superior to SAO for 10–40 m rooms).
    // Default output composites AO onto the read buffer (the RenderPass result),
    // so it must sit AFTER RenderPass and stay in linear HDR (before OutputPass).
    // Tuned for interiors: a ~0.35 m contact radius, moderate blend.
    this.gtaoPass = new GTAOPass(this.scene, this.camera, 1, 1)
    this.gtaoPass.output = GTAOPass.OUTPUT.Default
    this.gtaoPass.blendIntensity = 0.9
    this.gtaoPass.updateGtaoMaterial({
      radius: 0.35, // meters — contact shadows in corners/under furniture
      distanceExponent: 1.0,
      thickness: 1.0,
      distanceFallOff: 1.0,
      scale: 1.0,
      samples: 16,
      screenSpaceRadius: false,
    })
    this.gtaoPass.enabled = false // only the 'render' tier turns this on

    // Bloom is wired into the pass list but stays DISABLED in every tier (like
    // SAO). It runs in linear HDR before OutputPass tone-maps, so it blooms the
    // physical Sky dome (a huge HDR value that fills the background) across the
    // whole frame — hazing the render tier to a white void. The render look gets
    // its depth from GTAO + 4096 shadows + the sky environment instead. Flip on
    // only if the sky is first clamped out of the bright-pass input.
    this.bloomPass = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.18, 0.4, 1.0)
    this.bloomPass.enabled = false

    this.outputPass = new OutputPass()
    this.smaaPass = new SMAAPass()
    // Fixed pass list; tiers select a chain by toggling `.enabled`. Disabled
    // passes are skipped and never claim renderToScreen (see applyPipeline()).
    this.composer.addPass(this.renderPass)
    this.composer.addPass(this.saoPass)
    this.composer.addPass(this.gtaoPass)
    this.composer.addPass(this.bloomPass)
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
    // Capture phase so a trackpad two-finger scroll can PAN the orbit before
    // OrbitControls' own (bubble-phase) wheel handler dollies it.
    el.addEventListener('wheel', this.onWheel, { passive: false, capture: true })
    this.walk.addEventListener('lock', this.onWalkLock)
    this.walk.addEventListener('unlock', this.onWalkUnlock)

    this.applyTheme() // tint walls/ground/grid + build the per-zone floor mats

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
    this.userMoved = true // a mode switch is a deliberate camera action
    this.setPickHighlight(null) // picks are orbit-only; drop the outline
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

  /** Set the render tier.
   *  - 'low'    — direct render (context MSAA, 1024 shadows, DPR ≤ 1.5).
   *  - 'high'   — composer RenderPass → Output → SMAA (2048 shadows, DPR ≤ 2).
   *  - 'render' — physical sky + sun, GTAO + subtle bloom, 4096 shadows,
   *               exposure 0.75 (degrades to the safe chain on software GL). */
  setQuality(q: Quality): void {
    if (q === this.quality) return
    this.quality = q
    const isRender = q === 'render'

    // Shadows: resolution per tier; tighter bias/normalBias in 'render'.
    const shadow = q === 'render' ? 4096 : q === 'high' ? 2048 : 1024
    this.sun.shadow.mapSize.set(shadow, shadow)
    this.sun.shadow.bias = isRender ? -0.0002 : -0.0004
    this.sun.shadow.normalBias = isRender ? 0.03 : 0.02
    this.sun.shadow.map?.dispose() // force reallocation at the new size
    this.sun.shadow.map = null

    // Tone-mapping exposure: the physical sky is bright, so 'render' sits lower.
    this.renderer.toneMappingExposure = isRender ? EXPOSURE_RENDER : EXPOSURE_DEFAULT

    if (isRender) {
      if (this.softwareGL) {
        // Software GL (SwiftShader/llvmpipe): the Preetham sky shader emits
        // NaN, which poisons the PMREM environment — every env-sampling PBR
        // material then renders black, and SMAA/Output smear the NaN across
        // the whole frame. Keep the gradient background + RoomEnvironment;
        // the sun still follows the angles and shadows go 4096.
        this.sky.visible = false
        this.scene.background = this.skyTex
        this.scene.environment = this.envRT.texture
        this.scene.environmentIntensity = ENV_INTENSITY_ROOM
        console.info(
          '[Viewer3D] render tier on software GL: physical sky + GTAO disabled (sun angles + shadows kept).',
        )
      } else {
        // Physical sky replaces the gradient background; sky PMREM replaces the
        // RoomEnvironment ambient (at a gentler intensity so it fills without
        // washing surfaces out).
        this.sky.visible = true
        this.scene.background = null
        this.applySunToSky()
        this.regenerateSkyEnv() // sync: environment ready before the next frame
        this.scene.environmentIntensity = ENV_INTENSITY_SKY
      }
    } else {
      // Restore today's look for 'high'/'low'.
      this.sky.visible = false
      this.scene.background = this.skyTex
      this.scene.environment = this.envRT.texture
      this.scene.environmentIntensity = ENV_INTENSITY_ROOM
    }

    this.positionSun() // angle-driven in 'render'; else the content-relative key light
    this.applyPipeline() // toggle GTAO/bloom for the tier + software-GL guard
    this.resize() // re-applies the quality-dependent pixel ratio + pass sizes
    this.onQualityChange?.(q)
  }

  getQuality(): Quality {
    return this.quality
  }

  /** Switch the material theme (studio / warm / mono / blueprint) and re-tint
   *  the live scene — zone floors, wall tones, ground, and grid — without a
   *  content rebuild (materials are shared, so recoloring updates every mesh).
   *  Persists the choice to localStorage. */
  setTheme(id: ThemeId): void {
    if (id === this.theme.id) return
    this.theme = THEMES[id]
    this.applyTheme()
    saveThemeId(id)
  }

  getTheme(): ThemeId {
    return this.theme.id
  }

  /** Reposition the sun by spherical angles: `elevationDeg` above the horizon
   *  (clamped 5–90) and `azimuthDeg` clockwise from world +Z (wrapped 0–360).
   *  Drives the directional light, the Sky's sun uniform, and — in the 'render'
   *  tier — a debounced regeneration of the sky PMREM environment. Calling this
   *  makes the directional light follow the angles in every tier thereafter. */
  setSun(elevationDeg: number, azimuthDeg: number): void {
    this.sunElevationDeg = THREE.MathUtils.clamp(elevationDeg, SUN_ELEV_MIN, SUN_ELEV_MAX)
    this.sunAzimuthDeg = ((azimuthDeg % 360) + 360) % 360
    this.sunUserSet = true
    this.applySunToSky()
    this.positionSun()
    if (this.quality === 'render') this.scheduleSkyEnv()
  }

  getSun(): { elevationDeg: number; azimuthDeg: number } {
    return { elevationDeg: this.sunElevationDeg, azimuthDeg: this.sunAzimuthDeg }
  }

  /** Rebuild the extruded plan from a fresh DocState (generated plans). */
  setState(state: DocState): void {
    this.clearContent()

    if (state.zones) {
      // Trace the floor-plate polygon ONCE per rebuild; zone plates are clipped
      // to it so tinted floors never stick out past an L-shaped building edge.
      // Generated room partitions are excluded — the plate is the envelope.
      const plate = platePolygonFromWalls(state.walls.filter((w) => !w.generated))
      for (const z of state.zones) this.buildZonePlate(z, plate)
    }
    for (const w of state.walls) this.content.add(this.buildWall(w))
    for (const c of state.components) {
      this.content.add(this.buildComponent(c, c.id === state.selection))
    }

    const prev = this.framed ? this.contentBounds.clone() : null
    this.contentBounds = this.boundsFromState(state)
    this.contentOffset = { x: 0, z: 0 } // generated plans render in source coords
    // Re-frame when the content is SUBSTANTIALLY different (test-fit pushed a
    // new plate, a candidate applied, a project opened) — a new world is a new
    // framing contract, even mid-session. Small edits to the same plan keep
    // the user's camera. Never frames while a mode transition is in flight.
    let stale = !this.framed
    if (prev && !this.contentBounds.isEmpty()) {
      const span = Math.max(
        prev.getSize(new THREE.Vector3()).length(),
        this.contentBounds.getSize(new THREE.Vector3()).length(),
        1,
      )
      const centerShift = prev
        .getCenter(new THREE.Vector3())
        .distanceTo(this.contentBounds.getCenter(new THREE.Vector3()))
      const sizeShift = Math.abs(
        prev.getSize(new THREE.Vector3()).length() -
          this.contentBounds.getSize(new THREE.Vector3()).length(),
      )
      stale = centerShift > span * 0.25 || sizeShift > span * 0.4
    }
    if (stale && !this.contentBounds.isEmpty() && !this.isTransitioning()) this.frameBox()
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
    if (!this.contentBounds.isEmpty()) this.frameBox()
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
    const pr = Math.min(window.devicePixelRatio || 1, this.quality === 'low' ? 1.5 : 2)
    this.renderer.setPixelRatio(pr)
    this.renderer.setSize(w, h, false)
    this.composer.setPixelRatio(pr)
    this.composer.setSize(w, h) // propagates to every pass (SAO/GTAO buffers, bloom + SMAA RTs)
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()

    // Framing staleness fix: content is framed once when set, but the container
    // often settles to its real size AFTER that (panel layout, plan/3D toggle) —
    // leaving the plan shoved into a corner. Until the user touches the camera,
    // every resize re-runs the instant (non-animated) framing so the plan stays
    // centered; the first interaction flips `userMoved` and ends auto-reframing.
    if (
      !this.userMoved &&
      this.framed &&
      this.mode === 'orbit' &&
      !this.isTransitioning() &&
      !this.contentBounds.isEmpty()
    ) {
      this.frameBox()
    }
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
    el.removeEventListener('wheel', this.onWheel, { capture: true })
    this.walk.removeEventListener('lock', this.onWalkLock)
    this.walk.removeEventListener('unlock', this.onWalkUnlock)

    if (this.walk.isLocked) this.walk.unlock()
    this.orbit.dispose()
    this.walk.dispose()

    this.clearContent()
    this.unitBox.dispose()
    this.wallMat.dispose()
    this.wallExtMat.dispose()
    this.glassWallMat.dispose()
    this.meetingMat.dispose()
    this.fallCeilingMat.dispose()
    this.highlightMat.dispose()
    for (const m of this.zoneFloorMats.values()) m.dispose()
    this.zoneFloorMats.clear()
    this.floorBaseMat?.dispose()
    this.floorTex.dispose()

    this.scene.remove(this.pickOutline)
    this.pickOutline.geometry.dispose() // EdgesGeometry owned by the outline
    this.pickOutlineMat.dispose()

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

    if (this.skyEnvTimer !== null) clearTimeout(this.skyEnvTimer)
    this.scene.remove(this.sky)
    this.sky.geometry.dispose()
    this.sky.material.dispose()

    this.renderPass.dispose()
    this.saoPass.dispose()
    this.gtaoPass.dispose()
    this.bloomPass.dispose()
    this.outputPass.dispose()
    this.smaaPass.dispose()
    this.composer.dispose()

    this.scene.environment = null
    this.envRT.dispose()
    this.skyEnvRT?.dispose()
    this.pmrem.dispose()

    this.renderer.dispose()
    this.renderer.domElement.remove()
  }

  // ── Content builders ────────────────────────────────────────────────────

  private buildWall(w: DocWall): THREE.Mesh {
    const dx = w.b.x - w.a.x
    const dz = w.b.y - w.a.y // plan Y → world Z
    const len = Math.hypot(dx, dz) || 0.01
    const glass = !!w.glazing
    // Lineweight hierarchy in 3D: generated partitions get the lighter tone,
    // the exterior/plate (non-generated) walls the heavier one.
    const wallMat = w.generated ? this.wallMat : this.wallExtMat
    const mesh = new THREE.Mesh(this.unitBox, glass ? this.glassWallMat : wallMat)
    mesh.scale.set(len, WALL_HEIGHT, Math.max(w.thickness, 0.05))
    mesh.position.set((w.a.x + w.b.x) / 2, WALL_HEIGHT / 2, (w.a.y + w.b.y) / 2)
    mesh.rotation.y = -Math.atan2(dz, dx) // see coordinate-mapping note above
    mesh.castShadow = !glass // glass fronts stay light-transparent
    mesh.receiveShadow = !glass
    // Shell = building fabric: reported by onPick but not selectable UI-wise.
    // Stamping it keeps a click on a wall from selecting the zone behind it.
    mesh.userData.pick = { kind: 'shell', category: glass ? 'glazing' : 'wall' } satisfies PickInfo
    return mesh
  }

  private buildComponent(c: DocComponent, selected: boolean): THREE.Object3D {
    const group = new THREE.Group()
    group.position.set(c.x, 0, c.y)
    group.rotation.y = -c.rotation // 2D clockwise θ → world −θ about +Y
    group.userData.pick = {
      kind: 'component',
      id: c.id,
      category: c.category,
      label: c.label,
    } satisfies PickInfo

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
    // Opaque, carpet-textured floor tinted per zone-type — shared across all
    // plates of a type (built by applyTheme), so the plan reads by room in 3D
    // and matches the 2D zone legend. No per-plate material allocation.
    const mat = this.zoneFloorMats.get(z.zone_type) ?? this.floorBaseMat
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
        mesh = new THREE.Mesh(new THREE.ShapeGeometry(shape), mat)
        mesh.rotation.x = -Math.PI / 2
        mesh.position.y = 0.006 // no centering: the shape carries absolute plan coords
      } else {
        const geo = new THREE.PlaneGeometry(Math.max(w, 0.05), Math.max(h, 0.05))
        mesh = new THREE.Mesh(geo, mat)
        mesh.rotation.x = -Math.PI / 2
        mesh.position.set(x + w / 2, 0.006, y + h / 2)
      }
      // Walk-mode systems (spawn centroid, collision) must ignore zone plates;
      // ShapeGeometry would otherwise count as real content.
      mesh.userData.zonePlate = true
      // …but clicking the room floor SELECTS the room (zone) in orbit mode.
      mesh.userData.pick = {
        kind: 'zone',
        id: z.id,
        label: z.label,
        zoneType: z.zone_type,
      } satisfies PickInfo
      mesh.receiveShadow = true
      this.content.add(mesh)
    }
    const s = z.shape
    if (s.kind === 'Poly') {
      // Boundary-conforming polygon: a single flat filled floor. The pts are
      // already ⊆ plate, so no rect clip — build the Shape directly (same plan→
      // world mapping as the clipped-rect path: local (px, −py), rotate −π/2).
      if (s.pts.length >= 3) {
        const shape = new THREE.Shape(s.pts.map(([px, py]) => new THREE.Vector2(px, -py)))
        const mesh = new THREE.Mesh(new THREE.ShapeGeometry(shape), mat)
        mesh.rotation.x = -Math.PI / 2
        mesh.position.y = 0.006
        mesh.userData.zonePlate = true
        mesh.userData.pick = {
          kind: 'zone',
          id: z.id,
          label: z.label,
          zoneType: z.zone_type,
        } satisfies PickInfo
        mesh.receiveShadow = true
        this.content.add(mesh)
      }
    } else if (s.kind === 'Rect') {
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
   *  target, and the fit distance. Pure math — mutates nothing.
   *
   *  Fits the ACTUAL bounding box (not its loose bounding sphere) to BOTH frustum
   *  axes at the current aspect ratio, so a wide plan on a landscape viewport
   *  fills the frame instead of sitting small with big empty margins (the old
   *  sphere-to-vertical-FOV fit over-zoomed by the plan's 3D diagonal and ignored
   *  the wider horizontal axis). For the fixed 3/4 direction we build the view
   *  basis, then require the camera far enough back that every box corner's
   *  horizontal/vertical offset lands inside the (aspect-corrected) half-FOV. */
  private frameAllPose(): { pos: THREE.Vector3; target: THREE.Vector3; fitDist: number } {
    const box = this.contentBounds
    if (box.isEmpty()) {
      return { pos: new THREE.Vector3(12, 12, 16), target: new THREE.Vector3(), fitDist: 20 }
    }
    const center = box.getCenter(new THREE.Vector3())
    const dir = new THREE.Vector3(0.55, 0.62, 1).normalize() // fixed 3/4 iso
    const forward = dir.clone().negate() // camera looks from center + dir back toward center
    const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize()
    const up = new THREE.Vector3().crossVectors(right, forward).normalize()
    const tanV = Math.tan(((this.camera.fov * Math.PI) / 180) / 2)
    const tanH = tanV * Math.max(this.camera.aspect, 1e-4)
    const o = new THREE.Vector3()
    let dist = 0
    for (let i = 0; i < 8; i++) {
      o.set(
        i & 1 ? box.max.x : box.min.x,
        i & 2 ? box.max.y : box.min.y,
        i & 4 ? box.max.z : box.min.z,
      ).sub(center)
      // Depth along the view direction, plus the back-off each screen axis needs.
      const along = dir.dot(o)
      const need = Math.max(Math.abs(right.dot(o)) / tanH, Math.abs(up.dot(o)) / tanV)
      dist = Math.max(dist, along + need)
    }
    const fitDist = Math.max(dist * 1.06, 6) // small margin; floor for tiny plans
    return { pos: center.clone().addScaledVector(dir, fitDist), target: center, fitDist }
  }

  private applyClipPlanes(fitDist: number): void {
    this.camera.near = 0.1
    this.camera.far = fitDist * 4 + 200
    this.camera.updateProjectionMatrix()
  }

  /** Fit the camera + shadow frustum to the current content bounds (once,
   *  instantly — animated re-framing goes through {@link frameAll}). */
  private frameBox(): void {
    const pose = this.frameAllPose()
    const center = pose.target

    this.orbit.target.copy(center)
    this.camera.position.copy(pose.pos)
    this.applyClipPlanes(pose.fitDist)
    this.orbit.maxDistance = pose.fitDist * 4
    this.orbit.update()

    // Point the sun at the plan and tighten its shadow frustum around it.
    this.positionSun()

    this.framed = true
    // Fresh framing restarts the auto-reframe-on-resize window (see resize()).
    this.userMoved = false
  }

  // ── Render tier: sun / sky / pipeline ─────────────────────────────────────

  /** Read the unmasked GL renderer string and match known software rasterizers.
   *  On those, depth-based post (SAO/GTAO) corrupts large depth ranges, so the
   *  'render' tier drops GTAO + bloom. */
  private detectSoftwareGL(): boolean {
    try {
      const gl = this.renderer.getContext()
      const dbg = gl.getExtension('WEBGL_debug_renderer_info')
      const r = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : ''
      return /swiftshader|llvmpipe|software|angle \(software/i.test(r)
    } catch {
      return false
    }
  }

  /** Enable exactly the passes the current tier needs. The composer runs only
   *  for 'high'/'render' (animate() bypasses it for 'low'); disabled passes are
   *  skipped and never claim `renderToScreen`. GTAO is the 'render' differentiator
   *  and is additionally gated by the software-GL guard. Bloom stays off in every
   *  tier — it blooms the HDR sky to white (see the bloomPass construction note). */
  private applyPipeline(): void {
    const post = this.quality === 'render' && !this.softwareGL
    this.saoPass.enabled = false // superseded by GTAO; kept for manual validation
    this.gtaoPass.enabled = post
    this.bloomPass.enabled = false
  }

  /** Unit vector pointing from the scene toward the sun, from the stored
   *  spherical angles (elevation above horizon, azimuth clockwise from +Z). */
  private sunDirection(): THREE.Vector3 {
    const el = THREE.MathUtils.degToRad(this.sunElevationDeg)
    const az = THREE.MathUtils.degToRad(this.sunAzimuthDeg)
    const cosEl = Math.cos(el)
    return new THREE.Vector3(Math.sin(az) * cosEl, Math.sin(el), Math.cos(az) * cosEl).normalize()
  }

  /** Place the directional light + tighten its shadow frustum to the content.
   *  In 'render' (or once {@link setSun} has been called) the light follows the
   *  sun angles; otherwise 'high'/'low' keep the content-relative 3/4 key light
   *  (today's look). Pure placement — no allocation beyond a couple of temps. */
  private positionSun(): void {
    const b = this.contentBounds
    const center = b.isEmpty() ? new THREE.Vector3() : b.getCenter(new THREE.Vector3())
    const size = b.isEmpty() ? new THREE.Vector3(20, 0, 20) : b.getSize(new THREE.Vector3())
    const span = Math.max(size.x, size.z, 4)

    if (this.quality === 'render' || this.sunUserSet) {
      const dir = this.sunDirection()
      this.sun.position.copy(center).addScaledVector(dir, span * 2 + 14)
    } else {
      this.sun.position.set(center.x + span, span * 1.6 + 8, center.z + span * 0.6)
    }
    this.sun.target.position.copy(center)
    this.sun.target.updateMatrixWorld()

    const half = span * 0.75 + 6
    const sc = this.sun.shadow.camera
    sc.left = -half
    sc.right = half
    sc.top = half
    sc.bottom = -half
    sc.near = 1
    sc.far = span * 4 + 60
    sc.updateProjectionMatrix()
  }

  /** Push the current sun direction into the Sky shader's sun uniform. */
  private applySunToSky(): void {
    if (this.softwareGL) return
    this.sky.material.uniforms.sunPosition.value.copy(this.sunDirection())
  }

  /** Debounced sky-PMREM regeneration for slider-driven {@link setSun} drags. */
  private scheduleSkyEnv(): void {
    if (this.softwareGL) return // sky shader NaNs on software GL — see setQuality
    if (this.skyEnvTimer !== null) clearTimeout(this.skyEnvTimer)
    this.skyEnvTimer = setTimeout(() => {
      this.skyEnvTimer = null
      this.regenerateSkyEnv()
    }, SKY_ENV_DEBOUNCE_MS)
  }

  /** Regenerate the sky's image-based ambient (PMREM). The sky is briefly
   *  reparented into an isolated scene so the main scene's walls/furniture never
   *  bleed into the captured environment; the previous target is disposed. Only
   *  installs the result while the 'render' tier is active. */
  private regenerateSkyEnv(): void {
    const prev = this.skyEnvRT
    this.scene.remove(this.sky)
    this.skyScene.add(this.sky)
    this.skyEnvRT = this.pmrem.fromScene(this.skyScene)
    this.skyScene.remove(this.sky)
    this.scene.add(this.sky)
    prev?.dispose()
    if (this.quality === 'render') this.scene.environment = this.skyEnvRT.texture
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

  // ── Material theme ─────────────────────────────────────────────────────────

  /** A 1 m ground grid whose lines read against the themed ground: minor lines
   *  in the theme's grid color, the two center lines in the accent. */
  private makeGrid(): THREE.GridHelper {
    const g = new THREE.GridHelper(200, 200, this.theme.accent, this.theme.grid)
    const m = g.material as THREE.Material
    m.transparent = true
    m.opacity = 0.5
    return g
  }

  /** Opaque, carpet-textured floor material tinted to `color`. Shared per
   *  zone-type (see {@link zoneFloorMats}); never allocated per plate. */
  private makeFloorMat(color: number): THREE.MeshStandardMaterial {
    return new THREE.MeshStandardMaterial({
      color,
      map: this.floorTex,
      roughness: 0.95,
      metalness: 0,
    })
  }

  /** Push the active theme onto the live scene: recolor the two wall tones and
   *  the ground in place, rebuild the grid (its colors are baked into vertex
   *  colors, so it can't be recolored in place), and (re)build the per-zone
   *  floor materials. Walls and zone plates SHARE these materials, so a recolor
   *  updates every mesh with no content rebuild. */
  private applyTheme(): void {
    const t = this.theme
    this.wallMat.color.setHex(t.wall)
    this.wallExtMat.color.setHex(t.wallExt)
    ;(this.ground.material as THREE.MeshStandardMaterial).color.setHex(t.ground)

    const oldGrid = this.grid
    this.scene.remove(oldGrid)
    oldGrid.geometry.dispose()
    ;(oldGrid.material as THREE.Material).dispose()
    this.grid = this.makeGrid()
    this.scene.add(this.grid)

    // Per-zone floor materials: recolor in place if they exist (plates keep
    // their reference), else create + protect from clearContent's disposal.
    for (const zt of Object.keys(t.floorByZone) as ZoneType[]) {
      // GROUND TAKES THE NEUTRAL FLOOR. Skipping allocation here is the whole
      // change: `buildZonePlate` already falls back to `floorBaseMat` for any
      // type without a material, so ground gets the same floor as unzoned plate
      // instead of a tinted carpet. The table keeps its entry either way — the
      // toolbar swatch reads it.
      if (NEUTRAL_FLOOR_ZONES.has(zt)) continue
      const color = t.floorByZone[zt]
      const mat = this.zoneFloorMats.get(zt)
      if (mat) mat.color.setHex(color)
      else {
        const created = this.makeFloorMat(color)
        this.zoneFloorMats.set(zt, created)
        this.shared.add(created)
      }
    }
    if (this.floorBaseMat) this.floorBaseMat.color.setHex(t.floorBase)
    else {
      this.floorBaseMat = this.makeFloorMat(t.floorBase)
      this.shared.add(this.floorBaseMat)
    }
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
    this.userMoved = true // any pointer input ends auto-reframe-on-resize
    this.cancelTween()
    // Arm clean-click pick detection (orbit only): a press that releases within
    // CLICK_MAX_MS having moved less than CLICK_MAX_PX is a pick, anything
    // longer/farther is an orbit gesture and must never pick.
    this.clickValid =
      this.mode === 'orbit' && e.button === 0 && !this.isTransitioning()
    this.clickX = e.clientX
    this.clickY = e.clientY
    this.clickTime = performance.now()
    if (this.mode !== 'walk' || this.walk.isLocked || this.isTransitioning() || e.button !== 0) return
    this.dragging = true
    this.dragX = e.clientX
    this.dragY = e.clientY
    this.renderer.domElement.setPointerCapture(e.pointerId)
  }

  private onPointerMove = (e: PointerEvent): void => {
    // Invalidate the pending pick as soon as the pointer wanders (drag/orbit).
    if (this.clickValid && Math.hypot(e.clientX - this.clickX, e.clientY - this.clickY) > CLICK_MAX_PX) {
      this.clickValid = false
    }
    if (!this.dragging || this.mode !== 'walk' || this.walk.isLocked) return
    const dx = e.clientX - this.dragX
    const dy = e.clientY - this.dragY
    this.dragX = e.clientX
    this.dragY = e.clientY
    this.lookYaw += dx * DRAG_LOOK_SENS
    this.lookPitch = THREE.MathUtils.clamp(this.lookPitch + dy * DRAG_LOOK_SENS, -PITCH_LIMIT, PITCH_LIMIT)
  }

  private onPointerUp = (e: PointerEvent): void => {
    if (this.clickValid) {
      this.clickValid = false
      if (
        this.mode === 'orbit' &&
        e.type === 'pointerup' && // pointercancel is never a click
        performance.now() - this.clickTime < CLICK_MAX_MS &&
        Math.hypot(e.clientX - this.clickX, e.clientY - this.clickY) <= CLICK_MAX_PX
      ) {
        this.doPick(e)
      }
    }
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
    this.userMoved = true // wheel zoom/glide is camera input too
    if (this.mode === 'walk') {
      e.preventDefault()
      if (this.isTransitioning()) return
      const px = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY // lines → px
      const notches = THREE.MathUtils.clamp(px / 100, -3, 3)
      this.scrollMove = THREE.MathUtils.clamp(this.scrollMove - notches * SCROLL_STEP, -10, 10)
      return
    }
    this.cancelTween()
    // Orbit: a two-finger trackpad scroll PANS the view; pinch (ctrl/⌘) and a
    // real mouse wheel fall through to OrbitControls to dolly/zoom. This lets a
    // laptop user move around the plan without a middle/right button.
    const pinch = e.ctrlKey || e.metaKey
    const mouseWheel =
      e.deltaMode !== 0 || (e.deltaX === 0 && Number.isInteger(e.deltaY) && Math.abs(e.deltaY) >= 40)
    if (pinch || mouseWheel || this.isTransitioning()) return // let OrbitControls handle it
    e.preventDefault()
    e.stopImmediatePropagation() // block OrbitControls' dolly this event
    const el = this.renderer.domElement
    const dist = this.camera.position.distanceTo(this.orbit.target)
    const vFov = (this.camera.fov * Math.PI) / 180
    const perPx = (2 * dist * Math.tan(vFov / 2)) / Math.max(el.clientHeight, 1)
    const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrix, 0)
    const up = new THREE.Vector3().setFromMatrixColumn(this.camera.matrix, 1)
    const move = new THREE.Vector3()
      .addScaledVector(right, -e.deltaX * perPx)
      .addScaledVector(up, e.deltaY * perPx)
    this.camera.position.add(move)
    this.orbit.target.add(move)
    this.orbit.update()
  }

  // ── Click picking (orbit mode) ───────────────────────────────────────────

  /** Raycast a clean click against `content` and report the nearest pickable
   *  object through {@link onPick}. Hits come back distance-sorted, and the
   *  metadata lookup walks UP the parent chain to the closest ancestor with
   *  `userData.pick` — so a chair leg resolves to its furniture group. Because
   *  furniture/components physically sit above the zone floor plates, the first
   *  hit that resolves to a pick already prefers them over the zone underneath
   *  (verified: plates lie at y≈0.006, furniture from y=0 upward, so the ray
   *  reaches the furniture surface first). Shell hits (building fabric) are
   *  reported but never highlighted; empty space reports `null`. */
  private doPick(e: PointerEvent): void {
    const rect = this.renderer.domElement.getBoundingClientRect()
    const ndc = new THREE.Vector2(
      ((e.clientX - rect.left) / Math.max(rect.width, 1)) * 2 - 1,
      -((e.clientY - rect.top) / Math.max(rect.height, 1)) * 2 + 1,
    )
    this.raycaster.setFromCamera(ndc, this.camera)
    this.raycaster.far = Infinity // collideAxis shortens it; restore for picking
    const hits = this.raycaster.intersectObject(this.content, true)

    let pickedObj: THREE.Object3D | null = null
    let picked: PickInfo | null = null
    for (const h of hits) {
      let o: THREE.Object3D | null = h.object
      while (o && o !== this.content) {
        if (o.userData.pick) {
          pickedObj = o
          picked = o.userData.pick as PickInfo
          break
        }
        o = o.parent
      }
      if (picked) break
    }

    if (!picked || !pickedObj) {
      this.setPickHighlight(null)
      this.onPick?.(null)
      return
    }
    // Shells are metadata-only: no highlight (the merged mesh's bbox would wrap
    // the whole building); consumers treat them like a background click.
    this.setPickHighlight(picked.kind === 'shell' ? null : pickedObj)
    const crect = this.container.getBoundingClientRect()
    this.onPick?.({
      ...picked,
      screen: { x: e.clientX - crect.left, y: e.clientY - crect.top },
    })
  }

  /** Move the persistent amber outline around `obj` (world-space bbox), or hide
   *  it for `null`. The outline is one reused LineSegments living in `scene`,
   *  so "disposing the previous highlight" is just this repositioning — its
   *  GPU resources are freed exactly once, in {@link dispose}. */
  private setPickHighlight(obj: THREE.Object3D | null): void {
    if (!obj) {
      this.pickOutline.visible = false
      return
    }
    const box = new THREE.Box3().setFromObject(obj)
    if (box.isEmpty()) {
      this.pickOutline.visible = false
      return
    }
    const size = box.getSize(new THREE.Vector3())
    const center = box.getCenter(new THREE.Vector3())
    const pad = 0.04 // small clearance so the outline never z-fights the surfaces
    this.pickOutline.scale.set(size.x + pad, Math.max(size.y, 0.05) + pad, size.z + pad)
    this.pickOutline.position.copy(center)
    this.pickOutline.visible = true
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
    this.setPickHighlight(null) // the picked object is about to be destroyed
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

    // Gentle emissive-style pulse on the pick outline (opacity 0.55 ↔ 1.0).
    if (this.pickOutline.visible) {
      this.pickOutlineMat.opacity = 0.775 + 0.225 * Math.sin(this.clock.elapsedTime * 4)
    }

    // 'low' bypasses the composer; 'high'/'render' run their pass chains.
    if (this.quality === 'low') this.renderer.render(this.scene, this.camera)
    else this.composer.render()

    // Rolling ~2 s FPS window → auto-degrade ONE tier below 40 fps
    // (render → high → low). The first window is discarded (shader compiles /
    // first-frame jank), as is any window containing a huge delta (backgrounded
    // tab). Never auto-upgrades.
    if (raw > 0.5) {
      this.fpsTime = 0
      this.fpsFrames = 0
    } else {
      this.fpsTime += raw
      this.fpsFrames++
      if (this.fpsTime >= 2) {
        const fps = this.fpsFrames / this.fpsTime
        this.fpsWindows++
        if (this.fpsWindows > 1 && fps < 40) {
          if (this.quality === 'render') this.setQuality('high')
          else if (this.quality === 'high') this.setQuality('low')
        }
        this.fpsTime = 0
        this.fpsFrames = 0
      }
    }
  }
}
