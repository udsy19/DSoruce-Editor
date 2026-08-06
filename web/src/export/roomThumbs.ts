// Per-room thumbnails — the 240×180 plan crop qbiq anchors in column B of every
// Inventory row, which is what makes that sheet read as a room schedule rather
// than a spreadsheet (gate G5).
//
// Tier 1 (this module): a top-down mini-render of ONE room — floor material
// swatch + texture, walls in their `WallType` colour, the room's own furniture
// drawn with the shared CAD symbol library and a soft drop shadow, and a room-
// type accent bar. No new symbol library, no new finish vocabulary: the floor
// material comes from `FINISH_SPEC`/`finishTypeFor` (finishSchedule.ts) so the
// thumbnail, the workbook's Floor Material column and the 3D renders can never
// disagree, and the swatch hexes come from `palette.json` via qbiqPalette.ts.
//
// Deterministic (G4/G5 both diff bytes): no `Date`, no `Math.random`.

import type { DocComponent, DocState, DocZone } from '../types/doc'
import { drawSymbol } from '../editor/symbols'
import { pointInZoneShape, zoneBBox } from '../util/zoneGeom'
import { ZONE_META } from '../editor/stats'
import { FINISH_SPEC, finishTypeFor, type FinishKey } from './finishSchedule'
import { canvasToPngBytes, planRoomList, CIRCULATION_ROOM_ID } from './planGraphic'
import { MATERIALS, PLAN_PALETTE, WALL_TYPE_HEX } from './qbiqPalette'
import { classifyWalls, type WallSpan } from './wallTypes'

/** Reference thumbnail size (`ext` 2286000×1714500 EMU on the Inventory rows). */
export const THUMB_W = 240
export const THUMB_H = 180

export interface RoomThumbOpts {
  width?: number
  height?: number
  /** Device-pixel multiplier. Default 1: the reference thumbnails are 240×180
   *  NATURAL pixels (`ext` 2286000×1714500 EMU), and gate G5 measures the
   *  anchor — keeping natural == anchor size means a naive embed still passes.
   *  Pass 2 for a retina embed, but then anchor it at 240×180 explicitly. */
  scale?: number
  roomRefs?: Map<number, string>
  wallSpans?: WallSpan[]
}

/**
 * Floor swatch per finish family, resolved from the `FINISH_SPEC` floor string's
 * trade abbreviation. Every hex comes from `palette.json` `materials.*` — the
 * same as-rendered colours the 3D renders and the video are graded against.
 */
function floorHex(spec: string): string {
  if (spec.includes('(CPT)')) return MATERIALS.light_gray_carpet.hex
  if (spec.includes('(TIM)')) return MATERIALS.herringbone_parquet.hex
  if (spec.includes('(LVT)')) return MATERIALS.white_oak_furniture.hex
  if (spec.includes('(POR)') || spec.includes('(VIT)') || spec.includes('(CER)')) {
    return MATERIALS.ceiling_white.hex
  }
  return WALL_TYPE_HEX.core // sealed screed / anti-static vinyl reads grey
}

/** Floor texture: the grid module (m) a material is laid in, 0 = seamless. */
const FLOOR_MODULE: Partial<Record<FinishKey, number>> = {
  workspace: 0.5,
  conference: 0.5,
  boardroom: 0.5,
  phonebooth: 0.5,
  focus: 0.5,
  other: 0.5,
  reception: 0.6,
  pantry: 0.3,
  toilet: 0.3,
  cabin: 0.19, // engineered timber board
  collab: 0.19,
  wellness: 0.19,
  print: 0.19,
  storage: 0.6, // sealed screed / vinyl sheet joint
  itserver: 0.6,
  core: 0.6,
}

/** Extra context (m) pulled into frame around the corridor network, so the
 *  aggregated circulation thumbnail reads as a corridor between rooms rather
 *  than a bare pink band. */
const CIRCULATION_CONTEXT = 1.2

/** Mix `hex` toward white by `t` (0..1) — keeps swatches readable behind linework. */
function lighten(hex: string, t: number): string {
  const n = parseInt(hex.slice(1), 16)
  const r = Math.round((n >> 16) + (255 - (n >> 16)) * t)
  const g = Math.round(((n >> 8) & 255) + (255 - ((n >> 8) & 255)) * t)
  const b = Math.round((n & 255) + (255 - (n & 255)) * t)
  return `rgb(${r}, ${g}, ${b})`
}

/** Spans whose midpoint sits on this room's outline (within `pad` m). */
function roomWallSpans(spans: WallSpan[], bb: ReturnType<typeof zoneBBox>, pad: number): WallSpan[] {
  return spans.filter((s) => {
    const mx = (s.ax + s.bx) / 2
    const my = (s.ay + s.by) / 2
    return mx >= bb.minX - pad && mx <= bb.maxX + pad && my >= bb.minY - pad && my <= bb.maxY + pad
  })
}

function componentsIn(state: DocState, z: DocZone): DocComponent[] {
  const ids = new Set(z.component_ids ?? [])
  const owned = state.components.filter((c) => ids.has(c.id))
  if (owned.length > 0) return owned
  return state.components.filter((c) => c.category !== 'Door' && pointInZoneShape(z.shape, c.x, c.y))
}

/**
 * Render one room's thumbnail.
 *
 * @param roomId the Inventory `Room ID` (`planRoomList` ids — a marker ref when
 *               one exists, else the zone id; `"0"` is aggregated circulation).
 */
export async function renderRoomThumbnail(
  state: DocState,
  roomId: string | number,
  opts: RoomThumbOpts = {},
): Promise<Uint8Array> {
  const scale = opts.scale ?? 1
  const W = Math.round((opts.width ?? THUMB_W) * scale)
  const H = Math.round((opts.height ?? THUMB_H) * scale)

  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('2d context unavailable')

  ctx.fillStyle = PLAN_PALETTE.background
  ctx.fillRect(0, 0, W, H)

  const id = String(roomId)
  const room = planRoomList(state, opts.roomRefs).find((r) => r.id === id)
  const zone = room?.zoneId != null ? (state.zones ?? []).find((z) => z.id === room.zoneId) : undefined

  // The aggregated circulation row gets the circulation wash over the corridor
  // network — the same colour language as the master plan.
  const circZones = (state.zones ?? []).filter((z) => z.zone_type === 'Circulation')
  const subject: DocZone[] = zone ? [zone] : id === CIRCULATION_ROOM_ID ? circZones : []
  if (subject.length === 0) {
    // Unknown room: an explicitly empty (but still room-specific) frame.
    ctx.strokeStyle = WALL_TYPE_HEX.core
    ctx.lineWidth = 2 * scale
    ctx.strokeRect(scale, scale, W - 2 * scale, H - 2 * scale)
    ctx.fillStyle = PLAN_PALETTE.room_label_text
    ctx.font = `600 ${11 * scale}px Helvetica, Arial, sans-serif`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(id, W / 2, H / 2)
    return canvasToPngBytes(canvas)
  }

  // --- fit transform ---------------------------------------------------------
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const z of subject) {
    const bb = zoneBBox(z.shape)
    minX = Math.min(minX, bb.minX)
    minY = Math.min(minY, bb.minY)
    maxX = Math.max(maxX, bb.maxX)
    maxY = Math.max(maxY, bb.maxY)
  }
  if (!zone) {
    // Circulation: pull the flanking rooms into frame so the crop reads as a
    // corridor BETWEEN rooms rather than a bare pink band.
    minX -= CIRCULATION_CONTEXT
    minY -= CIRCULATION_CONTEXT
    maxX += CIRCULATION_CONTEXT
    maxY += CIRCULATION_CONTEXT
  }
  const pad = 10 * scale
  const spanX = Math.max(maxX - minX, 0.5)
  const spanY = Math.max(maxY - minY, 0.5)
  const k = Math.min((W - pad * 2) / spanX, (H - pad * 2) / spanY)
  const ox = (W - spanX * k) / 2 - minX * k
  const oy = (H - spanY * k) / 2 - minY * k
  const X = (m: number) => m * k + ox
  const Y = (m: number) => m * k + oy

  const key: FinishKey = zone ? finishTypeFor(zone) : 'core'
  const meta = ZONE_META[zone?.zone_type ?? 'Circulation']

  // --- floor: material swatch + module grid ---------------------------------
  const base = zone ? floorHex(FINISH_SPEC[key].floor) : PLAN_PALETTE.background
  for (const z of subject) {
    const bb = zoneBBox(z.shape)
    ctx.fillStyle = zone ? lighten(base, 0.45) : PLAN_PALETTE.background
    ctx.fillRect(X(bb.minX), Y(bb.minY), (bb.maxX - bb.minX) * k, (bb.maxY - bb.minY) * k)
    if (!zone) {
      // Flat #FFE6E6 — the same colour the master plan's rgba(255,0,0,25) wash
      // composites to over white, but opaque so a thin corridor still reads.
      ctx.fillStyle = PLAN_PALETTE.circulation
      ctx.fillRect(X(bb.minX), Y(bb.minY), (bb.maxX - bb.minX) * k, (bb.maxY - bb.minY) * k)
      continue
    }
    const mod = FLOOR_MODULE[key] ?? 0
    if (mod > 0) {
      ctx.save()
      ctx.beginPath()
      ctx.rect(X(bb.minX), Y(bb.minY), (bb.maxX - bb.minX) * k, (bb.maxY - bb.minY) * k)
      ctx.clip()
      ctx.strokeStyle = lighten(base, 0.22)
      ctx.lineWidth = Math.max(0.5, 0.6 * scale)
      ctx.beginPath()
      for (let x = bb.minX; x <= bb.maxX + 1e-6; x += mod) {
        ctx.moveTo(X(x), Y(bb.minY))
        ctx.lineTo(X(x), Y(bb.maxY))
      }
      for (let y = bb.minY; y <= bb.maxY + 1e-6; y += mod) {
        ctx.moveTo(X(bb.minX), Y(y))
        ctx.lineTo(X(bb.maxX), Y(y))
      }
      ctx.stroke()
      ctx.restore()
    }
  }

  // --- furniture: soft shadow, then the shared CAD symbol -------------------
  const comps = subject.flatMap((z) => componentsIn(state, z))
  for (const c of comps) {
    ctx.save()
    ctx.translate(1.5 * scale, 1.8 * scale)
    drawSymbol(
      ctx,
      {
        category: c.category,
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
        stroke: 'rgba(28, 33, 38, 0.16)',
        detail: 'rgba(28, 33, 38, 0.10)',
        fill: 'rgba(28, 33, 38, 0.13)',
        accent: 'rgba(28, 33, 38, 0.16)',
      },
      { pxPerM: k, dpr: 1 },
    )
    ctx.restore()
    drawSymbol(
      ctx,
      {
        category: c.category,
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
        stroke: '#1c2126',
        detail: '#7c848e',
        fill: '#ffffff',
        seat: lighten(meta.line, 0.55),
        accent: '#1c2126',
      },
      { pxPerM: k, dpr: 1 },
    )
  }

  // --- walls in their type colour -------------------------------------------
  const spans = opts.wallSpans ?? classifyWalls(state)
  ctx.lineCap = 'butt'
  for (const z of subject) {
    for (const s of roomWallSpans(spans, zoneBBox(z.shape), zone ? 0.45 : CIRCULATION_CONTEXT)) {
      ctx.strokeStyle = WALL_TYPE_HEX[s.type]
      ctx.lineWidth = Math.max(2 * scale, s.thickness * k)
      ctx.beginPath()
      ctx.moveTo(X(s.ax), Y(s.ay))
      ctx.lineTo(X(s.bx), Y(s.by))
      ctx.stroke()
    }
  }

  // --- room-type accent bar + Room ID ----------------------------------------
  ctx.fillStyle = meta.line
  ctx.fillRect(0, H - 4 * scale, W, 4 * scale)
  ctx.font = `700 ${10 * scale}px Helvetica, Arial, sans-serif`
  ctx.textAlign = 'left'
  ctx.textBaseline = 'top'
  const cap = `${id}`
  const tw = ctx.measureText(cap).width
  ctx.fillStyle = 'rgba(255, 255, 255, 0.88)'
  ctx.fillRect(0, 0, tw + 10 * scale, 16 * scale)
  ctx.fillStyle = PLAN_PALETTE.room_label_text
  ctx.fillText(cap, 5 * scale, 3.5 * scale)

  return canvasToPngBytes(canvas)
}

/** Every Inventory room's thumbnail, keyed by Room ID. Ordered like the sheet. */
export async function renderAllRoomThumbnails(
  state: DocState,
  opts: RoomThumbOpts = {},
): Promise<{ id: string; png: Uint8Array }[]> {
  const spans = opts.wallSpans ?? classifyWalls(state)
  const out: { id: string; png: Uint8Array }[] = []
  for (const r of planRoomList(state, opts.roomRefs)) {
    out.push({ id: r.id, png: await renderRoomThumbnail(state, r.id, { ...opts, wallSpans: spans }) })
  }
  return out
}
