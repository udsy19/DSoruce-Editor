import * as THREE from 'three'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js'
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js'
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js'
import type { DocState } from '../editor/EditorCanvas'
import { pointInZoneShape } from '../util/zoneGeom'
import { CEILING_HEIGHT } from './Viewer3D'
import {
  buildInteriorScene,
  createInteriorLighting,
  interiorEnvironment,
  interiorSkyTexture,
  pointInPolygon,
  type InteriorRoom,
  type InteriorScene,
  type InteriorSceneOpts,
} from './materialTheme'
import { bestVista, buildClearanceGrid, frameLook, type ClearanceGrid } from '../export/composition'

/**
 * OFFSCREEN PHOTOREAL STILL RENDERER — the Enscape-like tier, headless.
 *
 * Same tier as `Viewer3D`'s `'render'` quality (ACES + PCF soft shadows + GTAO
 * ambient occlusion + SMAA, in that pass order) and the SAME scene, which comes
 * from `three/materialTheme.ts` — there is one scene builder and one material
 * theme for the stills, the walkthrough and the web viewer. What this module
 * adds is (a) an offscreen renderer that needs no container / rAF loop / input
 * rig, so it runs identically in the app and in headless Chromium, (b) camera
 * auto-placement that will not put the eye inside a wall, and (c) a floor mask
 * pass, which is how the still can PROVE which of its pixels are floor.
 *
 * Two deliberate differences from `Viewer3D`'s render tier, both because a
 * fit-out interior is not an exterior massing:
 *  - the IBL is `RoomEnvironment` (an interior light box), not the physical
 *    Preetham sky — which additionally emits NaN on software GL, the exact
 *    reason `Viewer3D.setQuality` has to degrade the tier there;
 *  - the sun's shadow frustum is fitted to the ROOM being rendered, so a 4096
 *    map resolves a 5 m meeting room instead of smearing over a 40 m plate.
 */

/** Eye height band the brief fixes for a human-scale interior still (m). */
export const EYE_HEIGHT = 1.6

export interface StillCamera {
  eye: THREE.Vector3
  target: THREE.Vector3
  /** HORIZONTAL field of view (deg); the vertical FOV is derived from aspect. */
  fovHorizontalDeg: number
  /** Which candidate won, for the report/debug line. */
  placement: 'door' | 'corner' | 'edge' | 'interior'
  /** Metres of unobstructed view straight ahead — the anti-wall guarantee. */
  forwardClearanceM: number
}

export interface CameraPlacementOpts {
  /** `wide` frames the whole room from its threshold/corner; `close` steps into
   *  it for a desk-level view. */
  framing?: 'wide' | 'close'
  /** Horizontal FOV (deg). Default 70 wide / 62 close — the brief's 60–75 band. */
  fovHorizontalDeg?: number
  eyeHeight?: number
  /** Look-at height (m). Slightly below the eye so the frame tilts gently down
   *  and keeps near floor in shot without pointing at the walker's toes. */
  targetHeight?: number
  /** Minimum metres of empty space around the eye. */
  clearanceM?: number
  /** Minimum metres the view must travel before it hits anything. */
  forwardClearanceM?: number
  /** The shared composition field (`export/composition.buildClearanceGrid`).
   *  Pass one built once per document — four stills would otherwise rebuild the
   *  same field four times. It is what lets a still be composed by the SAME
   *  scorer the walkthrough frames with. Omitted, it is built here. */
  grid?: ClearanceGrid
  /** `'required'` makes showing the room's own floor outrank composition — the
   *  fallback `roomRenders` uses when the best-composed still turns out not to
   *  evidence its finish. Default is composition-first; see `placeRoomCamera`. */
  floorEvidence?: 'required'
  /** Plan points no camera may stand within {@link EYE_SEPARATION_M} of. Two
   *  stills legitimately share one open floor (the reference's do), but they
   *  have to be two different pictures of it — and the same scorer, run twice
   *  on the same room, otherwise returns the same standing point twice. */
  avoidEyes?: Array<[number, number]>
}

export interface StillOpts extends CameraPlacementOpts {
  width?: number
  height?: number
  /** Tone-mapping exposure. */
  exposure?: number
  /** Ambient (IBL) intensity. */
  environmentIntensity?: number
  /** Turn the composer off (direct render) — a diagnostic escape hatch. */
  postprocess?: boolean
  /** Scene construction options (perimeter glazing, ceiling, luminaires, …). */
  scene?: InteriorSceneOpts
  /** Restrict the floor mask (and therefore {@link StillResult.floorRect}) to
   *  ONE zone's floor plate — the room the still is of. Omit to accept any floor. */
  floorZoneId?: number
  /** Half-extent (m) of the sun's shadow frustum around the subject. */
  shadowRadiusM?: number
  ceilingLamps?: number
  lampIntensity?: number
  lampReachM?: number
}

export interface StillResult {
  canvas: HTMLCanvasElement
  camera: StillCamera
  /** Fractional `(x0,y0,x1,y1)` crop of the frame that is floor to
   *  `MIN_FLOOR_PURITY` — measured from a mask render, not guessed. This is what
   *  a render pack hands gate G6 so its floor-material check samples floor and
   *  nothing else. */
  floorRect: [number, number, number, number]
  /** Share of `floorRect` that is genuinely floor (1.0 = every pixel). */
  floorRectPurity: number
  /** Mean luminance of `floorRect` in the beauty frame (0–1). A crop in deep
   *  shadow reports the ambient rather than the finish, so the caller uses this
   *  to decide whether the still can carry a material cross-check at all. */
  floorRectLuma: number
  /** Whether the GPU is a software rasterizer (GTAO is dropped there). */
  softwareGL: boolean
}

// ── Camera auto-placement ────────────────────────────────────────────────────

const SOLID_SKIP = /glass|mullion|emissive/i

/**
 * How far the composition search may swing a still off its subject (deg).
 *
 * The walkthrough allows 30°, because a walker's head turns and the room is
 * whatever it is passing. A still is OF a named room, so it gets less — and the
 * swing is not free either way: the biased heading is re-scored from scratch
 * (`visible` included), so a swing that loses the room loses the comparison.
 * One scorer (`export/composition`), two budgets.
 */
const STILL_BIAS_MAX_DEG = 25

/** How far the aim drops (m) at a full-budget composition swing — see the note
 *  in `evaluate`. Small: it is a tilt of ~4 deg at typical room distances, not
 *  a change of shot. */
const TILT_WITH_BIAS_M = 0.25

/** How far apart two stills of the SAME room must stand (m). Roughly a bay and
 *  a half on an office grid: far enough that the second shot is a different
 *  view of the floor rather than the same one nudged. */
export const EYE_SEPARATION_M = 9

/**
 * Fraction of the lower frame that must land DIRECTLY on the room's own floor
 * before the still counts as able to evidence its finish. Decided BEFORE score
 * (see `placeRoomCamera`'s tiers), because a prettier frame must never cost the
 * render↔takeoff cross-check the pack rests on.
 *
 * Left at 0.15, and lowering it was tried and reverted. The Reception still's
 * blank-wall defect looked like a cost of this bar; it was not. It was the
 * corner inset (see `candidateEyes`) spending the small room's depth, and at
 * 0.08 the bar instead started admitting *worse* shots to the top tier on a
 * 1-probe-in-20 difference — it flipped the meeting room from the corner that
 * shows its glazed front and slat panel to the one that shows two bare walls.
 * A 20-probe estimate cannot resolve 0.05 from 0.10; it can resolve 0.00 from
 * 0.15, which is the question this constant is actually asked.
 */
const FLOOR_EVIDENCE_MIN = 0.15

interface Candidate {
  x: number
  z: number
  kind: StillCamera['placement']
}

/**
 * Candidate eye positions.
 *
 * They are not all inside the room: candidates also stand back through the
 * doorway and outside each boundary, because a room with no standable interior
 * still has to be photographed from somewhere. But those are a strictly LOWER
 * TIER in `placeRoomCamera` and never merely a cheaper option — the reference
 * pack shoots its conference room through a glass wall and can carry it; ours
 * tried and put a mullion through the middle of the table. What makes an
 * outside candidate safe rather than arbitrary is that it only survives if the
 * view actually reaches the room: glazing and door openings are not in the
 * solid set, a blank partition is, and every candidate must still sit inside
 * the building's floor plate.
 */
function candidateEyes(
  room: InteriorRoom,
  state: DocState,
  framing: 'wide' | 'close',
  plate: Array<[number, number]> | null,
  clearanceM: number,
): { inside: Candidate[]; outside: Candidate[] } {
  const { minX, minY, maxX, maxY } = room.bbox
  const w = maxX - minX
  const h = maxY - minY
  // The inset must clear the wall by more than `clearanceM`, or a small room's
  // corner cameras are all rejected for standing too close to the wall they are
  // meant to stand in front of — but only just. A 5 × 4 m meeting room holding a
  // 2.9 m table has one composition available: back into a corner so the table
  // runs away diagonally. A metre of inset spends the only depth the room has,
  // and the table then IS the picture. So the corner sits as tight to the walls
  // as the clearance test will accept.
  const inset = THREE.MathUtils.clamp(
    Math.max(clearanceM + 0.15, Math.min(w, h) * 0.2),
    0.6,
    1.1,
  )
  const cx = (minX + maxX) / 2
  const cy = (minY + maxY) / 2
  const inside: Candidate[] = []
  const outside: Candidate[] = []

  // Doors on this room's boundary → one step in, and two steps back out.
  for (const d of state.components) {
    if (d.category !== 'Door') continue
    const pad = 0.8
    if (d.x < minX - pad || d.x > maxX + pad || d.y < minY - pad || d.y > maxY + pad) continue
    const vx = cx - d.x
    const vy = cy - d.y
    const len = Math.hypot(vx, vy) || 1
    inside.push({ x: d.x + (vx / len) * 1.0, z: d.y + (vy / len) * 1.0, kind: 'door' })
    for (const back of [0.9, 1.5, 2.4, 3.6]) {
      outside.push({ x: d.x - (vx / len) * back, z: d.y - (vy / len) * back, kind: 'door' })
    }
  }

  for (const [sx, sy] of [
    [1, 1],
    [-1, 1],
    [1, -1],
    [-1, -1],
  ] as const) {
    inside.push({ x: cx + (w / 2 - inset) * sx, z: cy + (h / 2 - inset) * sy, kind: 'corner' })
  }
  for (const [dx, dy] of [
    [0, 1],
    [0, -1],
    [1, 0],
    [-1, 0],
  ] as const) {
    inside.push({ x: cx + (w / 2 - inset) * dx, z: cy + (h / 2 - inset) * dy, kind: 'edge' })
    // Stand off each face: only the faces that are glazed or open will survive.
    // The near backs matter most — a 1.5 m corridor in front of a glazed
    // meeting room is exactly where the reference shoots its conference still,
    // and stepping further lands in the desks and fails the clearance test.
    for (const back of [0.8, 1.2, 1.8, 2.6, 3.6]) {
      const ox = cx + (w / 2) * dx + dx * back
      const oy = cy + (h / 2) * dy + dy * back
      for (const slide of [0, -0.3, 0.3]) {
        outside.push({ x: ox + dy * slide * w, z: oy + dx * slide * h, kind: 'corner' })
      }
    }
  }

  // A coarse interior grid — the only way a `close` camera can stand between
  // two desk rows rather than at the room edge, and, in a small room, the only
  // way the INSIDE pool has more than a corner or two to choose from once the
  // minimum-subject-distance test has thinned it. It is unconditional: a shot
  // from inside the room is not optional (see `placeRoomCamera`'s tiers), so
  // every framing needs a real choice of standing points.
  const step = Math.max(1.0, Math.min(w, h) / 5)
  for (let x = minX + inset; x <= maxX - inset; x += step) {
    for (let y = minY + inset; y <= maxY - inset; y += step) {
      inside.push({ x, z: y, kind: 'interior' })
    }
  }

  const inPlate = (c: Candidate) => !plate || plate.length < 3 || pointInPolygon(plate, c.x, c.z)
  return {
    inside: inside.filter((c) => pointInZoneShape(room.zone.shape, c.x, c.z)),
    // Outside candidates must be off the room but still in the building.
    outside: outside.filter((c) => !pointInZoneShape(room.zone.shape, c.x, c.z) && inPlate(c)),
  }
}

function isSolid(o: THREE.Object3D): boolean {
  const m = o as THREE.Mesh
  if (!m.isMesh) return false
  const mat = m.material as THREE.Material | THREE.Material[]
  const one = Array.isArray(mat) ? mat[0] : mat
  if (!one) return false
  if ((one as THREE.MeshPhysicalMaterial).transmission) return false
  if (one.transparent) return false
  return !SOLID_SKIP.test(one.type + (one.name ?? ''))
}

/**
 * Pick a camera for a room and PROVE it is not inside geometry.
 *
 * Every candidate is tested three ways before it can win:
 *  1. **containment** — the eye may not sit inside any solid's world AABB;
 *  2. **clearance** — 8 horizontal probes plus up/down must all be clear of
 *     `clearanceM`, so the eye never starts flush against a surface;
 *  3. **forward clearance** — the view direction itself must run free for
 *     `forwardClearanceM`, which is what stops a camera aimed into a partition.
 * The survivors are then scored on how well their distance to the room's
 * furniture centroid matches the framing.
 */
export function placeRoomCamera(
  scene: InteriorScene,
  room: InteriorRoom,
  state: DocState,
  opts: CameraPlacementOpts = {},
): StillCamera {
  const framing = opts.framing ?? 'wide'
  const eyeY = opts.eyeHeight ?? EYE_HEIGHT
  const roomDiag0 = Math.hypot(room.bbox.maxX - room.bbox.minX, room.bbox.maxY - room.bbox.minY)
  // A small room needs a lower aim so the near floor stays in the bottom of the
  // frame; a deep floor does not, and would end up staring at its own feet.
  const targetY = opts.targetHeight ?? (framing === 'close' ? 1.05 : 1.15)
  const roomDiag = roomDiag0
  // Clearances scale with the room: a 4 m reception cannot offer the 3.2 m of
  // open view a 38 m floor can, and demanding it would leave NO valid camera.
  const clearance = opts.clearanceM ?? THREE.MathUtils.clamp(roomDiag * 0.1, 0.32, 0.62)
  const fwdMin =
    opts.forwardClearanceM ??
    Math.min(framing === 'wide' ? 3.2 : 2.4, Math.max(1.6, roomDiag * 0.45))
  // Brief's band is 60–75° horizontal. A small room needs the wide end to read
  // as a room at all; a deep open floor does not.
  const fov =
    opts.fovHorizontalDeg ?? (framing === 'close' ? 62 : roomDiag < 7 ? 75 : roomDiag < 14 ? 72 : 70)

  const solids: THREE.Object3D[] = []
  /** Solids MINUS the floor and ceiling slabs — the set a "is the frame
   *  cluttered?" probe must use, since every downward ray legitimately hits the
   *  floor a metre away and that is not clutter. */
  const uprights: THREE.Object3D[] = []
  scene.root.traverse((o) => {
    if (!isSolid(o)) return
    solids.push(o)
    if (!o.userData?.surface) uprights.push(o)
  })
  /**
   * World AABBs of the upright solids — the "is the eye inside a wall?" test.
   *
   * It CANNOT be done by raycasting. Every material here is `FrontSide`, so
   * three's raycaster culls back faces: a ray crossing a closed box reports ONE
   * hit, not two, which makes an even/odd parity test pure noise (it was
   * rejecting perfectly good meeting-room corners as "inside a solid"), and a
   * ray fired from INSIDE a box reports no hit at all — the failure mode that
   * would actually put a camera in a wall. Containment is exact and cheap.
   */
  const solidBoxes = uprights.map((o) => new THREE.Box3().setFromObject(o).expandByScalar(0.04))
  const insideSolid = (p: THREE.Vector3): boolean => solidBoxes.some((b) => b.containsPoint(p))

  const target = new THREE.Vector3(room.focus.x, targetY, room.focus.y)
  const diag = roomDiag
  // How far back the shot wants to stand from the room's furniture centroid.
  // CAPPED for the wide: on a 38 m open floor `diag * 0.8` asks the camera to
  // stand 30 m back, which on this plate means the far corner — and every metre
  // beyond about fifteen is bare carpet between the lens and the desks. Past
  // that distance a wider view buys nothing a client can read.
  const ideal =
    framing === 'wide'
      ? Math.min(diag * 0.8, 14)
      : THREE.MathUtils.clamp(diag * 0.3, 3.5, 9)

  const halfFov = (fov * Math.PI) / 360
  const ray = new THREE.Raycaster()
  ray.far = 200
  const dirs: THREE.Vector3[] = []
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2
    dirs.push(new THREE.Vector3(Math.cos(a), 0, Math.sin(a)))
  }
  dirs.push(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, -1, 0))

  const nearestHit = (from: THREE.Vector3, dir: THREE.Vector3, set = solids): number => {
    ray.set(from, dir)
    const hits = ray.intersectObjects(set, false)
    return hits.length ? hits[0].distance : Infinity
  }

  // Frame-clutter probe grid, in camera space. A camera standing behind a door
  // leaf or a mullion passes every centre-ray test and still produces a
  // photograph of a door — this is what catches that.
  const CLUTTER_M = 1.6
  const probeFractions: Array<[number, number]> = []
  for (const fx of [-0.85, -0.5, -0.2, 0, 0.2, 0.5, 0.85]) {
    for (const fy of [-0.3, 0, 0.3]) probeFractions.push([fx, fy])
  }
  const tanX = Math.tan(halfFov)
  const tanY = tanX / (16 / 9)
  /** Every mesh, glazing included — the set that answers "can this camera see
   *  the room's floor with nothing at all in between?". */
  const occluders: THREE.Object3D[] = []
  scene.root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) occluders.push(o)
  })
  const floorProbes: Array<[number, number]> = []
  for (const fx of [-0.8, -0.4, 0, 0.4, 0.8]) {
    for (const fy of [-0.9, -0.7, -0.5, -0.3]) floorProbes.push([fx, fy])
  }
  /** How far in front of the camera a piece of furniture still counts as
   *  FOREGROUND rather than as part of the far field (m). */
  const FOREGROUND_M = 7
  /**
   * One pass down the lower frame, answering two questions the plan-space
   * scorer cannot:
   *
   *  `floor`      fraction landing directly on THIS room's floor. A camera
   *               scoring 0 here can produce a pretty picture but cannot
   *               support the Inventory cross-check, which is half of what
   *               these stills are for.
   *  `foreground` fraction landing on near furniture — the difference between
   *               a photograph of an office and a photograph of the carpet in
   *               front of one. Every reference still puts a desk, a chair or a
   *               planter in the bottom of frame and reads the room past it;
   *               ours shot across 10 m of empty floor because "see the whole
   *               room" and "look a long way" were the only things scored.
   *               Depth layering is a plan-space blind spot: the field knows a
   *               ray crosses a desk, never how far away that desk is.
   */
  const lowerFrame = (
    eye: THREE.Vector3,
    fwd: THREE.Vector3,
  ): { floor: number; foreground: number } => {
    const right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0)).normalize()
    const up = new THREE.Vector3().crossVectors(right, fwd).normalize()
    let hit = 0
    let near = 0
    const d = new THREE.Vector3()
    for (const [fx, fy] of floorProbes) {
      d.copy(fwd)
        .addScaledVector(right, fx * tanX)
        .addScaledVector(up, fy * tanY)
        .normalize()
      ray.set(eye, d)
      const hits = ray.intersectObjects(occluders, false)
      if (!hits.length) continue
      const h = hits[0]
      if (h.object.userData?.zoneId === room.zone.id) hit++
      else if (h.object.userData?.furniture && h.distance <= FOREGROUND_M) near++
    }
    return { floor: hit / floorProbes.length, foreground: near / floorProbes.length }
  }
  const clutterOf = (eye: THREE.Vector3, fwd: THREE.Vector3): number => {
    const right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0)).normalize()
    const up = new THREE.Vector3().crossVectors(right, fwd).normalize()
    let blocked = 0
    const d = new THREE.Vector3()
    for (const [fx, fy] of probeFractions) {
      d.copy(fwd)
        .addScaledVector(right, fx * tanX)
        .addScaledVector(up, fy * tanY)
        .normalize()
      if (nearestHit(eye, d, uprights) < CLUTTER_M) blocked++
    }
    return blocked / probeFractions.length
  }

  // Sample points spread over the room — the yardstick for "is the ROOM in
  // shot". Scoring on raw view depth instead picks whichever candidate stares
  // down the longest corridor, which is how a conference-room still ends up
  // being a photograph of a corridor.
  const probes: THREE.Vector3[] = []
  for (let i = 1; i <= 3; i++) {
    for (let j = 1; j <= 3; j++) {
      const px = room.bbox.minX + ((room.bbox.maxX - room.bbox.minX) * i) / 4
      const py = room.bbox.minY + ((room.bbox.maxY - room.bbox.minY) * j) / 4
      if (pointInZoneShape(room.zone.shape, px, py)) probes.push(new THREE.Vector3(px, 1.0, py))
    }
  }
  if (!probes.length) probes.push(target.clone())

  // Standing 1.7 m off a 3 m conference table technically sees the room, but
  // the table then IS the picture. A wide shot has to stand back.
  const minDist =
    framing === 'wide'
      ? Math.max(1.5, Math.min(2.6, diag * 0.32))
      : Math.min(1.6, Math.max(1.0, diag * 0.3))

  // The shared composition field: what is worth looking at, from anywhere on
  // this plate. Same builder, same scorer as the walkthrough's per-frame bias.
  const grid = opts.grid ?? buildClearanceGrid(state, scene.plate, 0.15)

  /** Validate one candidate and score it, or null if it must not be used.
   *  `bias` shoots the SAME standing point on a composition-biased heading
   *  instead of straight at the room's focus; both are offered to the ranking,
   *  so a bias that loses the room simply loses. */
  let lastReject = ''
  const evaluate = (
    c: Candidate,
    bias?: { yaw: number; dropM: number },
  ): { cam: StillCamera; score: number; floorSeen: number; yaw: number; detail: string } | null => {
    const eye = new THREE.Vector3(c.x, eyeY, c.z)
    const dist = eye.distanceTo(target)
    if (dist < minDist) { lastReject = `dist ${dist.toFixed(2)}<${minDist.toFixed(2)}`; return null }

    // 0. not where another still of this room already stood.
    for (const [ax, az] of opts.avoidEyes ?? []) {
      if (Math.hypot(c.x - ax, c.z - az) < EYE_SEPARATION_M) { lastReject = 'too near a sibling still'; return null }
    }

    // 1. the eye must not be inside a wall or a piece of furniture
    if (insideSolid(eye)) {
      lastReject = 'inside-solid'
      return null
    }

    // 2. all-round clearance
    let clear = true
    for (const d of dirs) {
      const lim = d.y !== 0 ? 0.35 : clearance
      if (nearestHit(eye, d) < lim) {
        clear = false
        break
      }
    }
    if (!clear) { lastReject = 'clearance'; return null }

    // 3. the view must actually REACH the room: unobstructed for fwdMin, and
    //    for most of the way to the target (glazing is not in `solids`, so a
    //    camera looking through a glass wall passes; one facing a blank
    //    partition does not).
    let aim = target
    if (bias) {
      // Same standing point, a different heading — and a slightly lower aim.
      // Turning off a near blank wall swings the room's own floor toward the
      // frame edge (measured: the Reception's floor probes fall 0.15 -> 0.10
      // across a 17 deg swing), so the shot tilts down by the same argument
      // that turned it. Without the tilt the better-composed frame has to be
      // discarded for losing its floor evidence, which is exactly the trade
      // that made the shipped still a photograph of drywall.
      const horiz = Math.hypot(target.x - eye.x, target.z - eye.z)
      aim = new THREE.Vector3(
        eye.x + Math.cos(bias.yaw) * horiz,
        targetY - bias.dropM,
        eye.z + Math.sin(bias.yaw) * horiz,
      )
    }
    const fwd = aim.clone().sub(eye).normalize()
    const forward = nearestHit(eye, fwd)
    if (forward < Math.min(fwdMin, dist * 0.85)) { lastReject = `fwd ${forward.toFixed(2)}<${Math.min(fwdMin, dist*0.85).toFixed(2)}`; return null }

    // 4. how much of the room this camera actually sees (in frame AND not
    //    occluded). This is the dominant term.
    const dirH = new THREE.Vector3(fwd.x, 0, fwd.z).normalize()
    let seen = 0
    const probeDir = new THREE.Vector3()
    for (const p of probes) {
      probeDir.copy(p).sub(eye)
      const pd = probeDir.length()
      probeDir.normalize()
      const horiz = new THREE.Vector3(probeDir.x, 0, probeDir.z).normalize()
      if (Math.acos(THREE.MathUtils.clamp(horiz.dot(dirH), -1, 1)) > halfFov) continue
      if (nearestHit(eye, probeDir) < pd - 0.2) continue
      seen++
    }
    const visible = seen / probes.length
    if (visible < 0.2) { lastReject = `vis ${visible.toFixed(2)}`; return null }

    // 5. foreground clutter — a door leaf or mullion filling the frame.
    const clutter = clutterOf(eye, fwd)
    if (clutter > 0.45) { lastReject = `clutter ${clutter.toFixed(2)}`; return null }

    // 6. what the lower frame lands on: the room's own floor (the Inventory
    //    cross-check) and near furniture (the picture's foreground).
    const { floor: floorSeen, foreground } = lowerFrame(eye, fwd)

    // 7. is the room's accent wall — its identity surface — actually in shot?
    //    Weighted as a tie-breaker only: a prettier shot must never outrank one
    //    that can actually evidence the room's floor finish.
    let facingAccent = 0
    if (room.accentWall) {
      const v = new THREE.Vector3(room.accentWall.x - eye.x, 0, room.accentWall.y - eye.z)
      if (v.lengthSq() > 0.04) {
        v.normalize()
        if (Math.acos(THREE.MathUtils.clamp(v.dot(dirH), -1, 1)) < halfFov) facingAccent = 1
      }
    }

    // 8. what is actually IN the picture — the shared composition scorer, the
    //    same one the walkthrough biases every frame with. `visible` says the
    //    room is in shot; this says whether the shot is worth looking at:
    //    depth, content crossed, and glazing rather than plasterboard at the
    //    end of each sight line. Without it a camera can score full marks for
    //    framing a room and still deliver 46 % of the frame as one blank wall,
    //    which is exactly what the Reception still shipped.
    const yaw = Math.atan2(fwd.z, fwd.x)
    const fl = frameLook(grid, eye.x, eye.z, yaw, halfFov * 2, 0)

    // A foreground is worth having and worth having ONCE: past about half the
    // lower frame the near desk stops layering the picture and starts being it.
    const layering = Math.min(foreground, 0.5) / 0.5

    let score =
      visible * 9 +
      floorSeen * 7 +
      fl.interest * 9 -
      fl.blankFraction * 8 +
      layering * (framing === 'close' ? 6 : 5) +
      facingAccent * 1.2 -
      Math.abs(dist - ideal) * 0.5 -
      clutter * 14
    if (c.kind === 'door') score += framing === 'wide' ? 1.2 : 0.3
    if (c.kind === 'corner') score += framing === 'wide' ? 0.8 : 0
    // A little depth still helps a wide shot read as an interior, not a box.
    score += Math.min(forward, 18) * 0.05

    return {
      score,
      floorSeen,
      yaw,
      detail:
        `vis${visible.toFixed(2)} flr${floorSeen.toFixed(2)} fg${foreground.toFixed(2)} int${fl.interest.toFixed(2)} ` +
        `blk${fl.blankFraction.toFixed(2)} clt${clutter.toFixed(2)} d${dist.toFixed(1)}/${ideal.toFixed(1)}`,
      cam: {
        eye,
        target: aim,
        fovHorizontalDeg: fov,
        placement: c.kind,
        forwardClearanceM: forward === Infinity ? 999 : forward,
      },
    }
  }

  /**
   * Ranking is LEXICOGRAPHIC, not a weighted sum, because standing inside the
   * room is not tradeable against picture quality:
   *
   *   tier 1  inside the room
   *   tier 0  outside it — only when the room cannot be stood in at all
   *
   * A still of room X shot from the corridor is a photograph of X's glass
   * front, and the pane it shoots through is then IN the picture: the shipped
   * Conference_room still stood 1.25 m outside a 5 × 4 m meeting room and put a
   * floor-to-ceiling mullion down the middle of the conference table. A soft
   * bonus could not prevent that — the corridor camera outscored every camera
   * in the room by more than any bonus worth paying — so being inside is a
   * rank, not a term.
   *
   * **Floor evidence is deliberately NOT a rank here by default.** It was, and
   * that is what turned the Reception still into a photograph of drywall: a
   * 20-probe estimate of "how much floor is in the lower frame" ranked a blank
   * white wall above a composed frame whose floor crop measured 100 % pure
   * anyway. The evidence question has an exact answer — the rendered floor mask
   * — so `roomRenders` asks THAT: it shoots the best-composed camera, and only
   * if the developed still genuinely cannot evidence its finish does it come
   * back with `floorEvidence: 'required'` and pay for it. Trading composition
   * for evidence up front paid a cost that was, in three of four rooms, not
   * owed.
   */
  const requireFloor = opts.floorEvidence === 'required'
  const pools = candidateEyes(room, state, framing, scene.plate, clearance)
  const debug = typeof window !== 'undefined' && (window as any).DS_CAMERA_DEBUG
  let best: StillCamera | null = null
  let bestRank = -1
  let bestScore = -Infinity
  const consider = (c: Candidate, inside: boolean, report?: string[]) => {
    const straight = evaluate(c)
    const takes = straight ? [straight] : []
    if (straight) {
      // ...and the same standing point on the best-composed heading within the
      // swing budget. This is `bestVista` — the shared scorer's HARD argmax —
      // not `frameLook`'s soft one: the soft form exists to keep a walking
      // camera's pan continuous frame to frame, and a still has no next frame
      // to be continuous with. Measured on the Reception, the soft form gives
      // up at +12 deg (its turn penalty is a continuity cost, not a composition
      // one) where the best frame available is at +26 deg.
      const maxBias = (STILL_BIAS_MAX_DEG * Math.PI) / 180
      const yaw = bestVista(grid, c.x, c.z, halfFov * 2, {
        yaw: straight.yaw,
        halfRangeRad: maxBias,
      })
      let off = yaw - straight.yaw
      while (off > Math.PI) off -= 2 * Math.PI
      while (off < -Math.PI) off += 2 * Math.PI
      if (Math.abs(off) > 0.02) {
        const biased = evaluate(c, {
          yaw,
          dropM: TILT_WITH_BIAS_M * Math.min(1, Math.abs(off) / maxBias),
        })
        if (biased) takes.push(biased)
      }
    }
    for (const r of takes) {
      const rank =
        (inside ? 2 : 0) +
        (requireFloor && r.floorSeen >= FLOOR_EVIDENCE_MIN ? 1 : 0)
      if (rank > bestRank || (rank === bestRank && r.score > bestScore)) {
        bestRank = rank
        bestScore = r.score
        best = r.cam
      }
    }
    if (report) {
      report.push(
        `${c.kind}(${c.x.toFixed(1)},${c.z.toFixed(1)})=` +
          (takes.length
            ? takes
                .map((r) => `${r.score.toFixed(2)}[${r.detail}]`)
                .join('|')
            : `REJ:${lastReject || '?'}`),
      )
    }
  }
  const insideRep: string[] = []
  const outsideRep: string[] = []
  for (const c of pools.inside) consider(c, true, debug ? insideRep : undefined)
  // Outside candidates are still evaluated: a room too small or too full to
  // stand in has to be shot from its threshold, and tier 0 is how that happens.
  for (const c of pools.outside) consider(c, false, debug ? outsideRep : undefined)
  if (debug) {
    console.warn(`cam ${room.zone.label} inside[${pools.inside.length}] ${insideRep.join(' ')}`)
    console.warn(`cam ${room.zone.label} outside[${pools.outside.length}] ${outsideRep.join(' ')}`)
  }

  if (best) return best
  // Nothing survived (a tiny room packed with furniture). Fall back to the room
  // centre raised above the furniture — never inside a wall, just less flattering.
  return {
    eye: new THREE.Vector3(room.center.x, eyeY, room.center.y),
    target: new THREE.Vector3(room.focus.x, targetY, room.focus.y + 0.001),
    fovHorizontalDeg: fov,
    placement: 'interior',
    forwardClearanceM: 0,
  }
}

// ── Floor mask → the honest floorRect ────────────────────────────────────────

const MASK_W = 480

/**
 * How much of the offered crop must be the room's own floor before the still may
 * offer it as evidence of that room's finish. High on purpose: the crop is
 * published to gate G6 as "these pixels ARE the Inventory floor material", and a
 * crop with a tenth of chair leg in it is a measurement of the chair as much as
 * of the carpet. A room that cannot offer such a crop reports `no-clean-floor`
 * and is counted as un-evidenced — see `roomRenders.floorCheckOf` and G6's
 * `--min-evidenced` bar. Relaxing this to 0.90 was tried and reverted: it did
 * not rescue the one room that needs it (a 5 × 4 m meeting room with eight
 * chairs offers no clean patch at any threshold) and it measurably shrank the
 * colour margin on the three rooms that pass.
 */
const MIN_FLOOR_PURITY = 0.97

/** Largest mostly-floor rectangle in the lower half of the frame, from a mask
 *  render. Beats guessing a band: the crop is derived from the geometry that
 *  actually reached the pixels. */
function bestFloorRect(
  mask: Uint8ClampedArray,
  luma: Uint8ClampedArray,
  w: number,
  h: number,
): { rect: [number, number, number, number]; purity: number; luma: number } {
  // Integral image of "is floor".
  const sum = new Int32Array((w + 1) * (h + 1))
  const lum = new Float64Array((w + 1) * (h + 1))
  for (let y = 0; y < h; y++) {
    let row = 0
    let lrow = 0
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      row += mask[i] > 127 ? 1 : 0
      lrow += (0.2126 * luma[i] + 0.7152 * luma[i + 1] + 0.0722 * luma[i + 2]) / 255
      sum[(y + 1) * (w + 1) + (x + 1)] = sum[y * (w + 1) + (x + 1)] + row
      lum[(y + 1) * (w + 1) + (x + 1)] = lum[y * (w + 1) + (x + 1)] + lrow
    }
  }
  const box = (t: Int32Array | Float64Array, x0: number, y0: number, x1: number, y1: number) =>
    t[y1 * (w + 1) + x1] - t[y0 * (w + 1) + x1] - t[y1 * (w + 1) + x0] + t[y0 * (w + 1) + x0]
  const area = (x0: number, y0: number, x1: number, y1: number) => box(sum, x0, y0, x1, y1)
  // A crop that is pure floor but sits in the black shadow under a
  // table is still not a sample of the material: it reports the ambient, not the
  // finish (the reception's parquet measured S 0.09 there against 0.18–0.48 in
  // the open). Only a correctly-exposed patch may be offered for the check.
  const LUMA_LO = 0.18
  const LUMA_HI = 0.86

  // Full sweep, not a handful of hand-picked bands. The floor is not always a
  // strip across the bottom: in a small room it can be one lit patch beside the
  // table, and a coarse grid that only offers symmetric wide bands will miss it
  // and fall back to sampling a desk top instead.
  const MIN_AREA_FRAC = 0.006 // ≥0.6 % of the frame, so the sample is not a sliver
  const MIN_W_FRAC = 0.1
  const MIN_H_FRAC = 0.05
  const minPx = MIN_AREA_FRAC * w * h
  let best: [number, number, number, number] = [0.05, 0.8, 0.95, 0.98]
  let bestPurity = 0
  let bestArea = -1
  let fallback: [number, number, number, number] = best
  let fallbackPurity = 0
  let fallbackLuma = 0
  let bestLuma = 0

  for (let fx0 = 0.02; fx0 <= 0.62; fx0 += 0.04) {
    for (let fx1 = fx0 + MIN_W_FRAC; fx1 <= 0.985; fx1 += 0.04) {
      const x0 = Math.round(fx0 * w)
      const x1 = Math.round(fx1 * w)
      if (x1 <= x0) continue
      for (let fy0 = 0.32; fy0 <= 0.93; fy0 += 0.03) {
        for (let fy1 = fy0 + MIN_H_FRAC; fy1 <= Math.min(0.99, fy0 + 0.38); fy1 += 0.04) {
          const y0 = Math.round(fy0 * h)
          const y1 = Math.round(fy1 * h)
          const px = (x1 - x0) * (y1 - y0)
          if (px <= 0) continue
          const purity = area(x0, y0, x1, y1) / px
          const meanLuma = box(lum, x0, y0, x1, y1) / px
          if (purity > fallbackPurity && px >= minPx * 0.5) {
            fallbackPurity = purity
            fallbackLuma = meanLuma
            fallback = [fx0, fy0, fx1, fy1]
          }
          if (purity < MIN_FLOOR_PURITY || px < minPx) continue
          if (meanLuma < LUMA_LO || meanLuma > LUMA_HI) continue
          if (px > bestArea) {
            bestArea = px
            bestPurity = purity
            bestLuma = meanLuma
            best = [fx0, fy0, fx1, fy1]
          }
        }
      }
    }
  }
  // No crop of usable size clears MIN_FLOOR_PURITY — report the purest one and
  // let the caller decide whether the still can carry a material cross-check.
  if (bestArea < 0) return { rect: fallback, purity: fallbackPurity, luma: fallbackLuma }
  return { rect: best, purity: bestPurity, luma: bestLuma }
}

// ── The renderer ─────────────────────────────────────────────────────────────

function detectSoftwareGL(gl: WebGLRenderingContext | WebGL2RenderingContext): boolean {
  try {
    const dbg = gl.getExtension('WEBGL_debug_renderer_info')
    const s = String(dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER))
    return /swiftshader|llvmpipe|software|basic render/i.test(s)
  } catch {
    return false
  }
}

/**
 * Render ONE interior still. The caller supplies a scene (built once and reused
 * across the four stills — building it per still would be four times the work
 * and would risk the four frames disagreeing) and a camera.
 *
 * Returns the beauty frame plus a measured {@link StillResult.floorRect}.
 */
export function renderInteriorStill(
  scene: InteriorScene,
  camera: StillCamera,
  opts: StillOpts = {},
): StillResult {
  const W = opts.width ?? 3840
  const H = opts.height ?? 2160
  const gl = document.createElement('canvas')
  const renderer = new THREE.WebGLRenderer({
    canvas: gl,
    antialias: false, // SMAA runs at the end of the composer instead
    preserveDrawingBuffer: true,
    alpha: false,
    powerPreference: 'high-performance',
  })
  const softwareGL = detectSoftwareGL(renderer.getContext())
  renderer.setPixelRatio(1)
  renderer.setSize(W, H, false)
  renderer.shadowMap.enabled = true
  // Genuinely soft shadows: three r185 deprecated PCFSoftShadowMap (it silently
  // degrades to hard PCF), so the tier uses variance shadow mapping, whose blur
  // is a real filter over the depth distribution — not a post-process smudge
  // over a flat image.
  renderer.shadowMap.type = THREE.VSMShadowMap
  // Khronos PBR Neutral, not ACES. ACES' RRT deliberately crosstalks channels
  // and desaturates as it rolls off — measured here as a ~0.29 achromatic lift
  // on a pure-red test albedo, which dragged the parquet floor out of its own
  // measured hue/saturation band. PBR Neutral exists precisely to keep a
  // material's colour recognisable through tone mapping, which is the whole
  // contract of a render that has to agree with a materials takeoff.
  renderer.toneMapping = THREE.NeutralToneMapping
  renderer.toneMappingExposure = opts.exposure ?? 1.15
  renderer.outputColorSpace = THREE.SRGBColorSpace

  const world = new THREE.Scene()
  const sky = interiorSkyTexture()
  world.background = sky
  const envRT = interiorEnvironment(renderer)
  world.environment = envRT.texture
  world.environmentIntensity = opts.environmentIntensity ?? 0.42
  world.add(scene.root)

  const lighting = createInteriorLighting({
    focus: { x: camera.target.x, y: camera.target.z, radius: opts.shadowRadiusM ?? 16 },
    ceilingLamps: opts.ceilingLamps,
    lampIntensity: opts.lampIntensity,
    lampReachM: opts.lampReachM,
  })
  world.add(lighting)

  const aspect = W / H
  const fovX = ((opts.fovHorizontalDeg ?? camera.fovHorizontalDeg) * Math.PI) / 180
  const fovY = 2 * Math.atan(Math.tan(fovX / 2) / aspect)
  const cam = new THREE.PerspectiveCamera((fovY * 180) / Math.PI, aspect, 0.08, 400)
  cam.position.copy(camera.eye)
  cam.lookAt(camera.target)
  cam.updateProjectionMatrix()

  // Pass order mirrors Viewer3D's 'render' tier: GTAO runs in linear HDR before
  // OutputPass tone-maps, SMAA last on display-referred colour.
  const usePost = opts.postprocess !== false && !softwareGL
  const composer = new EffectComposer(renderer)
  const renderPass = new RenderPass(world, cam)
  const gtao = new GTAOPass(world, cam, W, H)
  const output = new OutputPass()
  const smaa = new SMAAPass()
  if (usePost) {
    gtao.output = GTAOPass.OUTPUT.Default
    gtao.blendIntensity = 0.95
    gtao.updateGtaoMaterial({
      radius: 0.4,
      distanceExponent: 1.0,
      thickness: 1.0,
      distanceFallOff: 1.0,
      scale: 1.0,
      samples: 16,
      screenSpaceRadius: false,
    })
    composer.setPixelRatio(1)
    composer.setSize(W, H)
    composer.addPass(renderPass)
    composer.addPass(gtao)
    composer.addPass(output)
    composer.addPass(smaa)
    composer.render()
  } else {
    renderer.render(world, cam)
  }

  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(renderer.domElement, 0, 0)

  // ── Floor mask pass — same camera, flat colours, no post. ─────────────────
  // White is ONLY the target room's own floor plate, so the crop this yields is
  // that room's floor and nothing else — never the corridor's parquet.
  //
  // Glazing OCCLUDES here rather than being hidden. A pane is not optically
  // free: looking into the reception from the neighbouring room crosses four
  // glass surfaces, and each one lays its own near-white film over the pixels
  // behind it — enough to turn a floor measured at S 0.23 / L 0.28 into
  // S 0.06 / L 0.50. Only floor the camera can see DIRECTLY may be sampled.
  const white = new THREE.MeshBasicMaterial({ color: 0xffffff })
  const black = new THREE.MeshBasicMaterial({ color: 0x000000 })
  const floorSet = new Set<THREE.Object3D>()
  scene.floors.traverse((o) => {
    if (opts.floorZoneId === undefined || (o as THREE.Mesh).userData?.zoneId === opts.floorZoneId) {
      floorSet.add(o)
    }
  })
  const saved: Array<[THREE.Mesh, THREE.Material | THREE.Material[], boolean]> = []
  world.traverse((o) => {
    const m = o as THREE.Mesh
    if (!m.isMesh) return
    saved.push([m, m.material, m.visible])
    m.material = floorSet.has(m) ? white : black
  })
  const prevBg = world.background
  const prevTone = renderer.toneMapping
  world.background = null
  renderer.toneMapping = THREE.NoToneMapping
  renderer.setClearColor(0x000000, 1)
  renderer.render(world, cam)
  const maskH = Math.max(2, Math.round((MASK_W * H) / W))
  const mc = document.createElement('canvas')
  mc.width = MASK_W
  mc.height = maskH
  const mctx = mc.getContext('2d', { willReadFrequently: true })!
  mctx.drawImage(renderer.domElement, 0, 0, MASK_W, maskH)
  const maskPixels = mctx.getImageData(0, 0, MASK_W, maskH).data
  // The BEAUTY frame at mask resolution, so the crop can be judged on exposure
  // as well as on what it contains.
  mctx.clearRect(0, 0, MASK_W, maskH)
  mctx.drawImage(canvas, 0, 0, MASK_W, maskH)
  const beautyPixels = mctx.getImageData(0, 0, MASK_W, maskH).data
  const { rect, purity, luma } = bestFloorRect(maskPixels, beautyPixels, MASK_W, maskH)

  // Restore, then tear the renderer down (the scene itself is the caller's).
  for (const [m, mat, vis] of saved) {
    m.material = mat
    m.visible = vis
  }
  world.background = prevBg
  renderer.toneMapping = prevTone
  world.remove(scene.root)
  white.dispose()
  black.dispose()
  sky.dispose()
  envRT.dispose()
  renderPass.dispose()
  gtao.dispose()
  output.dispose()
  smaa.dispose()
  composer.dispose()
  renderer.dispose()

  return { canvas, camera, floorRect: rect, floorRectPurity: purity, floorRectLuma: luma, softwareGL }
}

/** Convenience for a one-off still straight from a `DocState` (the app path).
 *  Builds a scene, places the camera, renders, disposes. */
export function renderRoomStill(
  state: DocState,
  roomPredicate: (r: InteriorRoom) => boolean,
  opts: StillOpts = {},
): StillResult | null {
  const scene = buildInteriorScene(state, opts.scene)
  try {
    const room = scene.rooms.find(roomPredicate)
    if (!room) return null
    const cam = placeRoomCamera(scene, room, state, opts)
    return renderInteriorStill(scene, cam, opts)
  } finally {
    scene.dispose()
  }
}

/** Ceiling datum re-exported so consumers (E's walkthrough, F's viewer) do not
 *  reach into `Viewer3D` for it. */
export { CEILING_HEIGHT }
