// The qbiq-parity master plan graphic — the single most visible page of the
// deliverable pack (workbook `Plan` sheet, gate G4).
//
// One renderer, two consumers: the in-app export action and the headless gate
// harness (`scripts/render-plan.mjs`) both call `renderHighlightedPlan`. It
// runs anywhere a `<canvas>` exists, takes a plain `DocState` and never touches
// wasm — the caller passes the core's `circulation()` result in.
//
// What it draws, bottom to top:
//   1. the print plan (white ground + CAD furniture symbols) — REUSED from
//      `renderPrintCanvas` in pdf.ts, walls off, so there is exactly one
//      furniture symbol library in the codebase (`editor/symbols.ts` — R2)
//   2. the pink circulation wash: the plate minus every enclosed room, drawn at
//      the reference's own `rgba(255,0,0,25)`
//   3. the building core in core grey
//   4. wall spans colour-coded by `WallType` (see wallTypes.ts)
//   5. door swings in door-swing orange
//   6. Room ID labels, bold + haloed, de-collided with `placeNear` (sheetSet.ts)
//
// DETERMINISM IS GATED (G4 renders twice and diffs the bytes): no `Date`, no
// `Math.random`, no iteration over unordered collections, fixed font metrics.

import type { DocComponent, DocState, DocZone } from '../types/doc'
import { isGroundZone } from '../types/doc'
import type { CirculationScore } from '../types/metrics'
import { drawSymbol } from '../editor/symbols'
import { zoneArea, zoneCenter } from '../util/zoneGeom'
import { renderPrintCanvas } from './printPlan'
import { componentBox, labelLeader, placeNear, zoneBoxOnSheet, type OccBox } from './sheetSet'
import { roomDisplayNames } from './roomNaming'
import { CIRCULATION_RGBA, PLAN_PALETTE, WALL_TYPE_HEX } from './qbiqPalette'
import { classifyWalls, type WallSpan } from './wallTypes'

export type { WallSpan }

/** Default workbook-embed size, measured off the reference `xl/media/image1.png`. */
export const PLAN_W = 1040
export const PLAN_H = 780

/** A room that gets a Room ID label on the plan (and one Inventory row). */
export interface PlanRoom {
  /** The Inventory `Room ID` — a user marker ref when one exists, else zone id. */
  id: string
  /** Source zone, or `null` for the aggregated circulation row (Room ID "0"). */
  zoneId: number | null
  label: string
  /** Label anchor in world meters. */
  x: number
  y: number
}

export interface PlanGraphicOpts {
  width?: number
  height?: number
  /** Device-pixel multiplier — `2` renders the @2x plate at 2080×1560. */
  scale?: number
  /** Space-step room markers (App.tsx `buildRoomRefs`): zone id → user ref.
   *  Markers WIN over generated zone ids, exactly as the Inventory does. */
  roomRefs?: Map<number, string>
  /** Explicit room set. When the workbook writer passes its Inventory rows the
   *  plan labels match one-for-one by construction. Default: `planRoomList`. */
  rooms?: PlanRoom[]
  /** `Editor.circulation()`. Degenerate with 0 walls, so pass `null` then. */
  circulation?: CirculationScore | null
  /** Traced floor-plate polygon (`Editor.plate_polygon()`), world meters. The
   *  circulation wash is clipped to it; default is the wall bounding box. */
  plate?: [number, number][] | null
  /** Pre-classified wall spans — pass the core's classifier output here.
   *  Default: `classifyWalls(state)` (which itself prefers `wall.wall_type`). */
  wallSpans?: WallSpan[]
}

export interface PlanGraphicResult {
  png: Uint8Array
  /** Every Room ID drawn, in draw order. Gate G3 asserts each Inventory Room ID
   *  appears here exactly once; this feeds `planLabels` in ground-truth.json. */
  labels: string[]
}

/** Zone types that are building fabric / walking space, not a schedulable room. */
const NON_ROOM_ZONES = new Set(['Circulation', 'Unassigned', 'Core'])
/** The reference gives all circulation ONE aggregated Inventory row, Room ID 0. */
export const CIRCULATION_ROOM_ID = '0'

// ---------------------------------------------------------------------------
// Room set
// ---------------------------------------------------------------------------

/**
 * The canonical room list for BOTH the plan labels and the Inventory sheet:
 * every enclosed room (markers beat generated zone ids), plus one aggregated
 * circulation row with Room ID "0" — the shape the reference workbook uses
 * (31 rows = 30 rooms + 1 `Circulation`).
 *
 * Deterministic: zone order from `state.zones`, which the core emits in id order.
 */
export function planRoomList(state: DocState, roomRefs?: Map<number, string>): PlanRoom[] {
  const zones = state.zones ?? []
  // `label` is what the Inventory sheet prints as `Program Room Name`, so it is
  // the disambiguated name (`roomDisplayNames`) — the same string the drawing
  // set's finish schedule shows for that Room ID. Computed over the WHOLE zone
  // list, not this filtered one, so the ordinal a room gets here is the ordinal
  // it gets on every sheet.
  const names = roomDisplayNames(state)
  const rooms: PlanRoom[] = []
  for (const z of zones) {
    if (NON_ROOM_ZONES.has(z.zone_type)) continue
    const c = zoneCenter(z.shape)
    rooms.push({
      id: String(roomRefs?.get(z.id) ?? z.id),
      zoneId: z.id,
      label: names.get(z.id) ?? (z.label || z.zone_type),
      x: c.x,
      y: c.y,
    })
  }
  // One aggregated circulation label, anchored on the largest circulation zone.
  const circ = zones.filter((z) => isGroundZone(z.zone_type))
  if (circ.length > 0) {
    let best = circ[0]
    for (const z of circ) if (zoneArea(z.shape) > zoneArea(best.shape)) best = z
    const c = zoneCenter(best.shape)
    rooms.push({ id: CIRCULATION_ROOM_ID, zoneId: null, label: 'Circulation', x: c.x, y: c.y })
  }
  return rooms
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

function pathZone(ctx: CanvasRenderingContext2D, z: DocZone, X: (m: number) => number, Y: (m: number) => number, k: number): void {
  const s = z.shape
  ctx.beginPath()
  if (s.kind === 'Poly') {
    if (s.pts.length < 3) return
    ctx.moveTo(X(s.pts[0][0]), Y(s.pts[0][1]))
    for (let i = 1; i < s.pts.length; i++) ctx.lineTo(X(s.pts[i][0]), Y(s.pts[i][1]))
    ctx.closePath()
  } else if (s.kind === 'RectRing') {
    ctx.rect(X(s.x - s.w / 2), Y(s.y - s.h / 2), s.w * k, s.h * k)
    ctx.rect(X(s.x - s.in_w / 2), Y(s.y - s.in_h / 2), s.in_w * k, s.in_h * k)
  } else {
    ctx.rect(X(s.x - s.w / 2), Y(s.y - s.h / 2), s.w * k, s.h * k)
  }
}

function wallBounds(state: DocState) {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const w of state.walls) {
    minX = Math.min(minX, w.a.x, w.b.x)
    minY = Math.min(minY, w.a.y, w.b.y)
    maxX = Math.max(maxX, w.a.x, w.b.x)
    maxY = Math.max(maxY, w.a.y, w.b.y)
  }
  return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null
}

// ---------------------------------------------------------------------------
// The renderer
// ---------------------------------------------------------------------------

/**
 * Draw the highlighted plan onto a fresh canvas. Exposed separately from the
 * PNG encode so the room-thumbnail renderer and any in-app preview share the
 * exact same pixels. Returns the world→canvas transform for overlays.
 */
export function renderPlanCanvas(
  state: DocState,
  opts: PlanGraphicOpts = {},
): { canvas: HTMLCanvasElement; labels: string[]; k: number; ox: number; oy: number } {
  const scale = opts.scale ?? 1
  const wPx = Math.round((opts.width ?? PLAN_W) * scale)
  const hPx = Math.round((opts.height ?? PLAN_H) * scale)

  // 1. Ground + furniture, from the ONE existing print-plan renderer. Walls and
  //    zone tints off: this module owns those layers (colour-coded / washed).
  const { canvas, k, ox, oy } = renderPrintCanvas(state, wPx, hPx, {
    layers: {
      zoneFill: false,
      furniture: true,
      roomLabels: false,
      existingWalls: false,
      generatedWalls: false,
    },
  })
  const ctx = canvas.getContext('2d')
  if (!ctx || k <= 0) return { canvas, labels: [], k, ox, oy }
  const X = (m: number) => m * k + ox
  const Y = (m: number) => m * k + oy

  const zones = state.zones ?? []

  // 2. Circulation wash = plate MINUS every enclosed room, at the reference's
  //    own rgba(255,0,0,25). Built on a scratch canvas with destination-out so
  //    the result is a true set difference rather than stacked translucency
  //    (stacking would drift the hue away from the legend chip).
  //    `circulation()` is degenerate with 0 walls (CLAUDE.md) — guarded.
  const circOk = state.walls.length > 0 && (opts.circulation?.floor_area ?? 1) > 0
  if (circOk) {
    const wash = document.createElement('canvas')
    wash.width = wPx
    wash.height = hPx
    const wctx = wash.getContext('2d')
    if (wctx) {
      wctx.fillStyle = '#FF0000'
      const plate = opts.plate
      if (plate && plate.length >= 3) {
        wctx.beginPath()
        wctx.moveTo(X(plate[0][0]), Y(plate[0][1]))
        for (let i = 1; i < plate.length; i++) wctx.lineTo(X(plate[i][0]), Y(plate[i][1]))
        wctx.closePath()
        wctx.fill()
      } else {
        const bb = wallBounds(state)
        if (bb) wctx.fillRect(X(bb.minX), Y(bb.minY), (bb.maxX - bb.minX) * k, (bb.maxY - bb.minY) * k)
      }
      wctx.globalCompositeOperation = 'destination-out'
      for (const z of zones) {
        if (isGroundZone(z.zone_type)) continue
        pathZone(wctx, z, X, Y, k)
        wctx.fill(z.shape.kind === 'RectRing' ? 'evenodd' : 'nonzero')
      }
      // Re-ink the surviving mask in the wash colour, then composite ONCE — so
      // every washed pixel lands at exactly one alpha, never stacked.
      wctx.globalCompositeOperation = 'source-in'
      wctx.fillStyle = CIRCULATION_RGBA
      wctx.fillRect(0, 0, wPx, hPx)
      ctx.drawImage(wash, 0, 0)
    }
  }

  // 3. Building core / service shafts, solid in core grey.
  ctx.fillStyle = WALL_TYPE_HEX.core
  for (const z of zones) {
    if (z.zone_type !== 'Core') continue
    pathZone(ctx, z, X, Y, k)
    ctx.fill(z.shape.kind === 'RectRing' ? 'evenodd' : 'nonzero')
  }

  // 4. Walls, colour-coded by type at true scaled thickness.
  const spans = opts.wallSpans ?? classifyWalls(state)
  ctx.lineCap = 'butt'
  for (const s of spans) {
    ctx.strokeStyle = WALL_TYPE_HEX[s.type]
    ctx.lineWidth = Math.max(2.4 * scale, s.thickness * k)
    ctx.beginPath()
    ctx.moveTo(X(s.ax), Y(s.ay))
    ctx.lineTo(X(s.bx), Y(s.by))
    ctx.stroke()
  }

  // 5. Doors — the same CAD symbol the editor draws, inked in door-swing orange.
  for (const c of state.components) {
    if (c.category !== 'Door') continue
    drawSymbol(
      ctx,
      {
        category: 'Door',
        cx: X(c.x),
        cy: Y(c.y),
        w: c.w,
        h: c.h,
        rotation: c.rotation,
        mirror: c.mirror,
        selected: false,
        // R6: deliverable surface — real Chair components are drawn
        // beside this glyph, so it must not imply seating.
        implySeats: false,
      },
      {
        stroke: WALL_TYPE_HEX.door_swing,
        detail: WALL_TYPE_HEX.door_swing,
        accent: WALL_TYPE_HEX.door_swing,
      },
      { pxPerM: k, dpr: 1 },
    )
  }

  // 6. Room ID labels — bold, centred, knocked out of the linework with a white
  //    halo, de-collided through the drawing set's own `placeNear`.
  //
  //    `occ` IS SEEDED WITH THE FURNITURE FOOTPRINTS, not just with the labels
  //    already placed. The labels are drawn last and knock a 4 px white halo out
  //    of everything under them; at the workbook's 1040x780 the plate maps to
  //    ~23.6 px/m, so a 0.6 m table is 14 px and a 0.5 m chair 12 px — smaller
  //    than the label that lands on top. Rooms 145/147 billed `Table W60 X L60`
  //    and drew nothing but the number, and 155/171 did the same with their
  //    chair (defect E7, reports/defects-2.md). Labels now step aside for
  //    furniture exactly as they already step aside for each other: DISPLACED,
  //    never dropped or shrunk, so G3's "every Inventory Room ID appears exactly
  //    once in `labels`" still holds and G11 can see the furniture.
  const rooms = opts.rooms ?? planRoomList(state, opts.roomRefs)
  const fs = Math.round(15 * scale)
  ctx.font = `700 ${fs}px Helvetica, Arial, sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  const occ: OccBox[] = []
  for (const c of state.components) {
    if (c.category === 'Door') continue
    occ.push(componentBox(c, (mx, my) => ({ x: X(mx), y: Y(my) }), k))
  }
  //    A label that ends up OFF its room gets a leader back to it (shared with
  //    the drawing set: `labelLeader`). Three identical phone booths whose
  //    numbers all sit outside them are unreadable without one — the reader
  //    cannot tell which booth is 163. Drawn before the label's own halo, in the
  //    plan's linework colour at hairline weight, and stopping at the room's
  //    edge so it never crosses the furniture inside.
  const zoneBoxes = new Map<number, OccBox>()
  for (const z of zones) zoneBoxes.set(z.id, zoneBoxOnSheet(z.shape, (mx, my) => ({ x: X(mx), y: Y(my) })))
  const labels: string[] = []
  for (const r of rooms) {
    const w = ctx.measureText(r.id).width + 8 * scale
    const h = fs + 6 * scale
    const p = placeNear(occ, X(r.x), Y(r.y), w, h)
    const lead = labelLeader(X(r.x), Y(r.y), p, w, h, r.zoneId == null ? null : zoneBoxes.get(r.zoneId))
    if (lead) {
      ctx.strokeStyle = PLAN_PALETTE.linework
      ctx.lineWidth = Math.max(1, scale)
      ctx.beginPath()
      ctx.moveTo(lead.x1, lead.y1)
      ctx.lineTo(lead.x2, lead.y2)
      ctx.stroke()
    }
    ctx.lineWidth = 4 * scale
    ctx.strokeStyle = PLAN_PALETTE.background
    ctx.lineJoin = 'round'
    ctx.strokeText(r.id, p.x, p.y)
    ctx.fillStyle = PLAN_PALETTE.room_label_text
    ctx.fillText(r.id, p.x, p.y)
    labels.push(r.id)
  }

  return { canvas, labels, k, ox, oy }
}

/** Encode a canvas as PNG bytes. Chromium's encoder is content-only (no
 *  timestamp chunk), so identical pixels give byte-identical files — which is
 *  exactly what G4's determinism twin asserts. */
export async function canvasToPngBytes(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/png'))
  if (!blob) throw new Error('canvas.toBlob returned null')
  return new Uint8Array(await blob.arrayBuffer())
}

/**
 * Render the highlighted master plan to PNG bytes.
 *
 * @returns `png` — the image the workbook embeds; `labels` — every Room ID
 *          actually drawn, which must match the Inventory rows one-for-one.
 */
export async function renderHighlightedPlan(
  state: DocState,
  opts: PlanGraphicOpts = {},
): Promise<PlanGraphicResult> {
  const { canvas, labels } = renderPlanCanvas(state, opts)
  return { png: await canvasToPngBytes(canvas), labels }
}
