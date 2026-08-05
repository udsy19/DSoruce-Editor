import type { DocState } from '../editor/EditorCanvas'
import { canvasToPngBytes } from './planGraphic'
import type { WallSpan } from './wallTypes'
import { buildInteriorScene, type InteriorRoom, type InteriorScene } from '../three/materialTheme'
import { placeRoomCamera, renderInteriorStill, type StillOpts } from '../three/interiorStill'
import { buildClearanceGrid, type ClearanceGrid } from './composition'
import { FINISH_SPEC } from './finishSchedule'
import { zoneArea } from '../util/zoneGeom'

/**
 * DELIVERABLE 2 — the per-room hero stills.
 *
 * Four photoreal-style interiors (Reception · Open space · Work stations ·
 * Conference room) rendered from the SAME `DocState` the quantity workbook is
 * built from, dressed in the SAME material theme as the walkthrough video and
 * the web viewer (`three/materialTheme.ts`). Renders and quantities therefore
 * cannot tell the client two different stories: a room's floor comes from
 * `FINISH_SPEC`/`finishTypeFor` — the Inventory sheet's own source — and this
 * module reports the resulting Inventory material name alongside each PNG.
 *
 * Gate G6 reads `out/ground-truth.json`'s `renders` block, which is exactly
 * {@link roomRenderGroundTruth}'s output.
 *
 * ── Usage (app or headless; one code path) ────────────────────────────────
 *   const pack = await renderRoomPack(state, { wallSpans, plate })
 *   for (const r of pack) writeFile(`out/renders/${r.key}.png`, r.png)
 *   groundTruth.renders = roomRenderGroundTruth(pack)
 */

/** Filenames the reference pack (and therefore gate G6) uses. */
export type RoomRenderKey = 'Reception' | 'Open_space' | 'Work_stations' | 'Conference_room'

export interface RoomRenderSpec {
  key: RoomRenderKey
  title: string
  framing: 'wide' | 'close'
  /** Preference-ordered candidate room types (see `finishSchedule.FinishKey`). */
  prefer: InteriorRoom['finishKey'][]
  /** Smallest acceptable room (m²) before falling through to the next type. */
  minAreaM2: number
}

/**
 * The four space types, in the reference pack's own order.
 *
 * `Open_space` and `Work_stations` legitimately resolve to the SAME open-plan
 * zone when a test-fit has no separate lounge — the reference does exactly this
 * (both of its stills look at one open floor) — but they are shot differently:
 * `wide` from the floor's edge, `close` standing between the desk banks.
 */
export const ROOM_RENDER_SPECS: RoomRenderSpec[] = [
  { key: 'Reception', title: 'Reception', framing: 'wide', prefer: ['reception', 'collab'], minAreaM2: 6 },
  { key: 'Open_space', title: 'Open space', framing: 'wide', prefer: ['collab', 'workspace'], minAreaM2: 25 },
  { key: 'Work_stations', title: 'Work stations', framing: 'close', prefer: ['workspace'], minAreaM2: 12 },
  {
    key: 'Conference_room',
    title: 'Conference room',
    framing: 'wide',
    prefer: ['boardroom', 'conference'],
    minAreaM2: 8,
  },
]

export interface RoomRender {
  key: RoomRenderKey
  title: string
  /** The zone that was photographed. */
  roomId: number
  roomLabel: string
  /** The room's Inventory floor material — `FINISH_SPEC[finishTypeFor(zone)].floor`,
   *  the SAME string `qtoWorkbook` writes into the Inventory sheet's
   *  `Floor Material` column and into `ground-truth.rooms[].floorMaterial`. One
   *  vocabulary for plan, workbook and renders; gate G6 requires the three to
   *  agree literally. */
  floorMaterial: string
  /** Which framing actually produced this still — `spec.framing`, unless the
   *  first shot could not see the room's own floor and the reframe did. */
  framing: RoomRenderSpec['framing']
  /** Whether this still offers a floor sample good enough to cross-check the
   *  Inventory: `'ok'`, or why not. A still whose only visible floor is a
   *  shadowed sliver would report the ambient, not the finish. This is
   *  DIAGNOSTIC only — it never removes the claim from the ground truth, because
   *  a gate the artifact can switch off is not a gate (defect D1). */
  floorCheck: 'ok' | 'no-clean-floor' | 'floor-underexposed'
  /** Measured mostly-floor crop, for G6's floor-pixel sample. */
  floorRect: [number, number, number, number]
  floorRectPurity: number
  floorRectLuma: number
  camera: {
    eye: [number, number, number]
    target: [number, number, number]
    fovHorizontalDeg: number
    placement: string
    forwardClearanceM: number
  }
  width: number
  height: number
  png: Uint8Array
}

export interface RoomPackOpts extends StillOpts {
  /** Typed wall runs (`classifyWalls(state, editor.wall_types())`). */
  wallSpans?: WallSpan[]
  /** `editor.plate_polygon()`. */
  plate?: [number, number][] | null
  /** Restrict the pack (e.g. re-render one still). Default: all four. */
  only?: RoomRenderKey[]
  /** Called after each still — progress for a UI. */
  onProgress?: (key: RoomRenderKey, index: number, total: number) => void
}

/** Resolve a spec to the best room in the document, or null when the test-fit
 *  has nothing of that kind (a 6-desk plan has no conference room). */
function pickRoom(scene: InteriorScene, spec: RoomRenderSpec, taken: Set<number>): InteriorRoom | null {
  for (const key of spec.prefer) {
    const cands = scene.rooms
      .filter((r) => r.finishKey === key && zoneArea(r.zone.shape) >= spec.minAreaM2)
      .sort((a, b) => zoneArea(b.zone.shape) - zoneArea(a.zone.shape))
    // Prefer a room no other still has used; fall back to sharing it (the
    // open-plan case) rather than dropping a deliverable.
    const fresh = cands.find((r) => !taken.has(r.zone.id))
    if (fresh) return fresh
    if (cands.length) return cands[0]
  }
  return null
}

/** Place a camera with the given framing and shoot the still. */
function shoot(
  scene: InteriorScene,
  room: InteriorRoom,
  state: DocState,
  opts: RoomPackOpts,
  framing: RoomRenderSpec['framing'],
  avoidEyes: Array<[number, number]>,
  grid: ClearanceGrid,
  floorEvidence?: 'required',
): ReturnType<typeof renderInteriorStill> {
  const cam = placeRoomCamera(scene, room, state, { ...opts, framing, avoidEyes, grid, floorEvidence })
  return renderInteriorStill(scene, cam, {
    width: opts.width ?? 3840,
    height: opts.height ?? 2160,
    exposure: opts.exposure,
    environmentIntensity: opts.environmentIntensity,
    postprocess: opts.postprocess,
    lampIntensity: opts.lampIntensity,
    lampReachM: opts.lampReachM,
    ceilingLamps: opts.ceilingLamps,
    // The floor crop must be THIS room's floor — a conference still shot
    // from the corridor must not sample the corridor's parquet.
    floorZoneId: room.zone.id,
  })
}

/** Can this still be trusted to SHOW the room's floor finish? The purity bar
 *  tracks `interiorStill`'s own `MIN_FLOOR_PURITY`. */
function floorCheckOf(still: ReturnType<typeof renderInteriorStill>): RoomRender['floorCheck'] {
  if (still.floorRectPurity < 0.95) return 'no-clean-floor'
  if (still.floorRectLuma < 0.2 || still.floorRectLuma > 0.85) return 'floor-underexposed'
  return 'ok'
}

/**
 * Render the four hero stills. The interior scene is built ONCE and all four
 * cameras shoot it, so the stills cannot disagree with each other about the
 * building — and it is four times less work than rebuilding per frame.
 *
 * Default output is 3840×2160 (the reference pack's size); G6's floor is
 * 1920×1080.
 */
export async function renderRoomPack(state: DocState, opts: RoomPackOpts = {}): Promise<RoomRender[]> {
  const scene = buildInteriorScene(state, {
    wallSpans: opts.wallSpans,
    plate: opts.plate,
    ...opts.scene,
  })
  // Built ONCE and handed to every camera search: the shared composition field
  // is a property of the building, not of a shot, and it is the same field the
  // walkthrough frames against (`export/composition.ts`).
  const grid = opts.grid ?? buildClearanceGrid(state, scene.plate)
  try {
    const specs = opts.only
      ? ROOM_RENDER_SPECS.filter((s) => opts.only!.includes(s.key))
      : ROOM_RENDER_SPECS
    const taken = new Set<number>()
    /** Where a still of each room already stood, so a second still of the SAME
     *  open floor (the reference pack does this too) is a different picture of
     *  it rather than the same camera search returning the same answer. */
    const shotFrom = new Map<number, Array<[number, number]>>()
    const out: RoomRender[] = []
    for (let i = 0; i < specs.length; i++) {
      const spec = specs[i]
      const room = pickRoom(scene, spec, taken)
      if (!room) continue
      taken.add(room.zone.id)
      const avoid = shotFrom.get(room.zone.id) ?? []

      // Shoot the best-composed camera first. If the developed still cannot
      // show the room's OWN floor, come back and pay for it — first by making
      // floor evidence outrank composition from the same framing, then by
      // reframing. A pack whose renders do not agree with the takeoff is the
      // defect, and dropping the claim only hid it (D1) — but the price is only
      // worth paying when the shot ACTUALLY fails, which is the whole point of
      // asking the rendered floor mask instead of a 20-ray guess. Three of the
      // four rooms never reach this branch.
      let framing = spec.framing
      let still = shoot(scene, room, state, opts, framing, avoid, grid)
      if (floorCheckOf(still) !== 'ok') {
        const paid = shoot(scene, room, state, opts, framing, avoid, grid, 'required')
        if (floorCheckOf(paid) === 'ok') {
          still = paid
        } else {
          const alt: RoomRenderSpec['framing'] = framing === 'wide' ? 'close' : 'wide'
          const retry = shoot(scene, room, state, opts, alt, avoid, grid, 'required')
          // Only a shot that ACTUALLY evidences the floor is worth losing the
          // spec's composition for. Trading the intended framing for a merely
          // less-bad one buys nothing and produces a table-top close-up.
          if (floorCheckOf(retry) === 'ok') {
            still = retry
            framing = alt
          }
        }
      }
      const cam = still.camera
      shotFrom.set(room.zone.id, [...avoid, [cam.eye.x, cam.eye.z]])
      out.push({
        key: spec.key,
        title: spec.title,
        roomId: room.zone.id,
        roomLabel: room.zone.label,
        floorMaterial: FINISH_SPEC[room.finishKey].floor,
        framing,
        floorCheck: floorCheckOf(still),
        floorRect: still.floorRect,
        floorRectPurity: still.floorRectPurity,
        floorRectLuma: still.floorRectLuma,
        camera: {
          eye: [cam.eye.x, cam.eye.y, cam.eye.z],
          target: [cam.target.x, cam.target.y, cam.target.z],
          fovHorizontalDeg: cam.fovHorizontalDeg,
          placement: cam.placement,
          forwardClearanceM: Number(cam.forwardClearanceM.toFixed(2)),
        },
        width: still.canvas.width,
        height: still.canvas.height,
        png: await canvasToPngBytes(still.canvas),
      })
      opts.onProgress?.(spec.key, i, specs.length)
    }
    return out
  } finally {
    scene.dispose()
  }
}

/** One `ground-truth.json` `renders[]` entry per still — G6's input contract
 *  (`docs/reference/qbiq/spec/ground-truth.schema.json`). */
export function roomRenderGroundTruth(
  pack: RoomRender[],
  dir = 'out/renders',
): Array<{
  name: string
  file: string
  roomId: number
  floorMaterial: string
  floorRect: [number, number, number, number]
}> {
  return pack.map((r) => ({
    name: r.key,
    file: `${dir}/${r.key}.png`,
    roomId: r.roomId,
    // ALWAYS claimed, never conditional. `floorMaterial` is the assertion "this
    // still shows the Inventory finish of room <roomId>", and G6 holds the pack
    // to it. Omitting it when the shot was poor used to disable the gate's only
    // render-to-model check from inside the artifact (D1); the honest response
    // to a shot that cannot show its floor is to reframe it (see
    // {@link renderRoomPack}), not to withdraw the claim.
    floorMaterial: r.floorMaterial,
    floorRect: r.floorRect,
  }))
}
