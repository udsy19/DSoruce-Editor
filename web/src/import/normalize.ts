// Furniture normalization: map an imported CAD block to a CANONICAL editor
// component so imported furniture renders with the SAME symbology as the
// generator's furniture (north star: laiout.co — one consistent furniture
// language across the whole plan).
//
// The problem this solves: a raw DWG carries hundreds of vendor-specific blocks
// ("Steelcase SILQ Task Chair", "Workstations BENCH Single 5 X 2 FT", "ROUND 4
// CONF TABLE") at their real footprints. Stamped verbatim they read as plain
// bbox outlines of every size — totally unlike the generator's canonical
// Desk/Chair/Table line-symbols, so a merged plan looks incoherent. Here we
// infer the semantic category from the block name / coarse layer category /
// footprint and snap it onto the editor's canonical vocabulary (the same
// category strings the Rust generator emits — "Desk", "Chair", "Table",
// "Door", "Window" — and CATALOG), so both render through the one
// `drawFurnitureSymbol` path.
//
// What is normalized: the SYMBOL (category) and, for the uniform grid pieces
// (desks + chairs), the SIZE — a real task chair and a generated chair become
// the identical glyph. What is preserved: the piece's real position (its caller
// keeps the bbox center), its orientation (encoded in w/h for the aspect), its
// label, and its bound product id/name/price. Pieces with no canonical symbol
// (sofas, planters, casework, appliances) keep their real footprint and fall to
// the neutral 'Furniture' symbol — a clean rounded outline, never raw linework.
//
// Pure TS, dependency-free besides the shared CATALOG (single source of the
// canonical sizes). Coordinates/sizes in meters.

import type { FurnitureItem } from './types'
import { catByCategory } from '../editor/catalog'

/** A canonical editor component derived from one imported block. The caller
 *  supplies position (bbox center); the axis-aligned `w/h` carries the block's
 *  landscape-vs-portrait aspect, and `rotation` carries which way a directional
 *  symbol faces (the flip/turn `w/h` alone can't express). */
export interface NormalizedComponent {
  /** Editor/CATALOG category string → drives the canonical top-view symbol. */
  category: string
  /** Normalized footprint width (meters). */
  w: number
  /** Normalized footprint height (meters). */
  h: number
  /**
   * Cardinal orientation of the block (world-space, CCW radians, one of
   * 0 · π/2 · π · 3π/2). It exists because the axis-aligned `w/h` footprint only
   * carries the block's LANDSCAPE-vs-PORTRAIT aspect — not which way a directional
   * symbol (a Desk's monitor/chair, a Chair's backrest) FACES. Two desks with the
   * same bbox but rotated 180° apart share one `w/h`, so drawn upright they'd both
   * point the same (wrong) way; `rotation` recovers the flip/turn.
   *
   * Contract for the symbol renderer: `rotation`'s 90°-parity always agrees with
   * the `w/h` aspect (portrait ⟺ an odd number of quarter-turns). So a consumer
   * "un-swaps" back to the block's NATURAL (pre-rotation) footprint —
   * `odd ? [h, w] : [w, h]` — and draws THAT rotated by `rotation` (negated for a
   * Y-down screen), which reproduces the `w/h` on-screen extent while facing right.
   * BOTH consumers use it: the imported 2D canvas (`DrawingCanvas.drawItemSymbol`)
   * and the merge stamp (`mergeFit` → `stampBaseInto`, which adds `+π` for the
   * import↔editor Y-mirror). Non-directional pieces (Table/Door/Window/Furniture)
   * are 0 (their symbols are left-right symmetric, so a mirror == a `+π` turn).
   */
  rotation: number
  /**
   * Hinge handedness for a Door (left- vs right-hand swing), reflected across the
   * door's long axis. `rotation` alone can't express it — a door and its mirror
   * image cannot be rotated onto each other — so this second facet carries the
   * hand recovered from the swing arc (see `recoverDoorPose`). It rides ALONGSIDE
   * the aspect-baked `w/h` (a reflection leaves the bbox unchanged, so the un-swap
   * contract is untouched). Non-doors are left-right symmetric → always `false`.
   * The renderer reflects the leaf+arc when true (`furniture.ts` `drawDoor`).
   */
  mirror: boolean
  /** Human-readable label (the bound product name when present, else the block name). */
  label: string
  /** Preserved material-bank binding (re-imagine), if the block carried one. */
  productId?: string
  productName?: string
}

// Canonical sizes come from the shared CATALOG so imported pieces snap to the
// exact footprint the generator/editor use — no forked constants.
const DESK = catByCategory('Desk') ?? { w: 1.4, h: 0.7 }
const CHAIR = catByCategory('Chair') ?? { w: 0.5, h: 0.5 }

const MIN_TABLE_SIDE = 0.4 // m — a table footprint never collapses below this

/**
 * Infer the canonical category for an imported block from its name + coarse
 * layer category (from dxf.ts). Name keywords win over the coarse category
 * because CAD block names are far more specific than AIA layers — and because
 * dxf.ts's layer/name heuristic mislabels casework that merely contains the
 * word "Door" ("CW Cupbd … 1 Door") as a door. Rules are ordered most-specific
 * first; the first match wins.
 */
export function inferCategory(item: FurnitureItem): string {
  const s = `${item.name} ${item.raw}`.toUpperCase()

  // A cupboard/cabinet/drawer/shelf unit is casework even when its block name
  // mentions "Door" and dxf.ts tagged it category 'door'.
  const isCasework = /CUPBD|CUPBOARD|CABINET|\bCW\b|DRAWER|SHELF|SHELVES|BOOKCASE|LOCKER|COUNTERTOP|\bOHEAD\b/.test(s)

  // Real door leaves (swing symbol). Only genuine doors — not casework doors.
  if (!isCasework && (item.category === 'door' || /\bDOOR\b/.test(s))) return 'Door'

  // Glazing: curtain-wall mullions + glazed system panels → window symbol.
  if (item.category === 'glazing' || /MULLION|GLAZED|GLAZING|CURTAIN|\bWINDOW\b/.test(s)) return 'Window'

  // Seating of every kind → the one Chair glyph.
  if (/TASK CHAIR|SIDE CHAIR|GUEST CHAIR|SWIVEL CHAIR|CLUB CHAIR|DESK CHAIR|CONFERENCE CHAIR|LOUNGE|BARSTOOL|BAR STOOL|\bSTOOL\b|ARMCHAIR|\bCHAIR\b/.test(s))
    return 'Chair'

  // Workstations / benches / desks → the Desk glyph.
  if (/WORKSTATION|WORKSTATIONS|\bBENCH\b|\bDESK\b/.test(s)) return 'Desk'

  // Tables of every kind (conference, side, coffee, pedestal, workroom) → Table.
  if (/\bTABLE\b|TABLES|COFFEETABLE|PEDESTALTABLE|WORKTABLE/.test(s)) return 'Table'

  // Everything else (sofas, planters, casework, appliances, fixtures) → the
  // neutral 'Furniture' symbol: a clean rounded outline, not raw linework.
  return 'Furniture'
}

/**
 * Map an imported block to a canonical component. Desks + chairs snap to the
 * catalog footprint (so the imported grid matches the generated grid exactly);
 * a desk keeps its long-axis orientation via w/h. Tables keep their real
 * footprint (a boardroom and a side table are both "Table" but must not become
 * the same size) but gain the canonical Table symbol. Neutral pieces keep their
 * real footprint. Product binding + label are always carried through.
 */
export function normalizeFurniture(item: FurnitureItem): NormalizedComponent {
  const category = inferCategory(item)
  const bw = item.bbox[2] - item.bbox[0]
  const bh = item.bbox[3] - item.bbox[1]
  const portrait = bh > bw // the block's long side runs vertically

  let w: number
  let h: number
  let rotation = 0
  let mirror = false
  switch (category) {
    case 'Door': {
      // Doors are directional AND handed. Recover the opening axis (which wall it
      // sits in) + the hinge hand from the swing arc in the block's geometry (see
      // recoverDoorPose). Footprint becomes the canonical thin leaf-slab so it
      // renders as the door SYMBOL (opening span + swing arc), not a raw bbox.
      const pose = recoverDoorPose(item)
      if (pose) {
        const leaf = Math.min(2.5, Math.max(0.3, pose.leafLen))
        const slab = Math.min(DOOR_SLAB, leaf * 0.35)
        // Opening runs vertically ⟺ an odd number of quarter-turns; aspect-bake
        // w/h to match so the consumers' un-swap reconstructs the natural (leaf ×
        // slab) footprint exactly (same contract as a portrait desk).
        const vertical = Math.round(pose.axisAngle / (Math.PI / 2)) % 2 === 1
        ;[w, h] = vertical ? [slab, leaf] : [leaf, slab]
        rotation = pose.axisAngle
        mirror = pose.mirror
      } else {
        // No recoverable swing arc → keep the real footprint, upright (old behavior).
        w = bw
        h = bh
      }
      break
    }
    case 'Desk': {
      // Snap to the canonical desk footprint, long side along the block's long side.
      const long = Math.max(DESK.w, DESK.h)
      const short = Math.min(DESK.w, DESK.h)
      ;[w, h] = portrait ? [short, long] : [long, short]
      rotation = cardinalOrientation(item.rotation, portrait)
      break
    }
    case 'Chair':
      w = CHAIR.w
      h = CHAIR.h
      // A square chair carries no aspect, so orientation is the authored quarter-turn
      // outright (backrest direction); portrait=false keeps parity even/no-op.
      rotation = cardinalOrientation(item.rotation, false)
      break
    case 'Table':
      // Keep the real footprint (tables genuinely span side-table → boardroom).
      w = Math.max(bw, MIN_TABLE_SIDE)
      h = Math.max(bh, MIN_TABLE_SIDE)
      break
    default:
      // Window / neutral Furniture: keep the real footprint (symmetric symbols).
      w = bw
      h = bh
  }

  return {
    category,
    w,
    h,
    rotation,
    mirror,
    label: item.productName ?? item.name,
    productId: item.productId,
    productName: item.productName,
  }
}

/** Canonical thin depth (meters) of a door leaf-slab in the plan symbol — matches
 *  the generator's door footprint so imported + generated doors read identically. */
const DOOR_SLAB = 0.15

/** A door's recovered plan pose. `axisAngle` is the world-CCW opening axis (hinge
 *  → strike jamb), snapped to a cardinal so it obeys the same aspect/parity
 *  contract as desks; `mirror` is the hinge hand; `leafLen` is the swing radius. */
interface DoorPose {
  axisAngle: number
  mirror: boolean
  leafLen: number
}

/**
 * Recover a door's plan pose from its block geometry. A CAD door block draws its
 * leaf swing as a quarter-circle ARC (tessellated to a polyline on import): the
 * arc CENTER is the hinge, its RADIUS the leaf length, and its two endpoints are
 * the strike jamb (leaf closed, along the wall) and the open leaf tip. From those
 * we get the opening axis (hinge→strike) and the hand (which side of the axis the
 * leaf swings, via the endpoint cross-product). Returns null when no swing arc is
 * found (e.g. a frameless opening or a degenerate stub) — the caller then keeps
 * the raw footprint upright, unmirrored (the pre-existing behavior).
 */
function recoverDoorPose(item: FurnitureItem): DoorPose | null {
  const arcs = detectArcs(item.entities)
  if (arcs.length === 0) return null
  const maxR = Math.max(...arcs.map((a) => a.r))
  // Swing arcs: near-full-radius, quarter-turn-ish sweep (rules out tiny fillets).
  const swing = arcs.filter((a) => a.r > 0.6 * maxR && a.sweep > 0.6 && a.sweep < 2.2)
  if (swing.length === 0) return null

  // Distinct hinge centers. A double door has two leaves hinged at opposite jambs;
  // it is symmetric (no hand), and the opening axis is the line between the hinges.
  const centers: [number, number][] = []
  for (const a of swing) {
    if (!centers.some((c) => dist(c, a.center) < 0.15)) centers.push(a.center)
  }
  if (centers.length >= 2) {
    const [h1, h2] = centers
    return { axisAngle: snapCardinal(Math.atan2(h2[1] - h1[1], h2[0] - h1[0])), mirror: false, leafLen: maxR }
  }

  const arc = swing.reduce((m, a) => (a.r > m.r ? a : m), swing[0])
  const H = arc.center
  const r = arc.r
  // The leaf line (a straight segment ≈ r long from the hinge) points to the OPEN
  // tip; the other arc endpoint is then the strike jamb (along the wall).
  let openTip: [number, number] | null = null
  let best = Infinity
  for (const e of item.entities) {
    if (e.kind !== 'polyline' || !e.pts || e.pts.length < 2) continue
    const a = e.pts[0]
    const b = e.pts[e.pts.length - 1]
    const len = dist(a, b)
    if (Math.abs(len - r) > 0.2 * r) continue
    if (dist(a, H) < 0.12 * r && dist(b, H) > 0.7 * r && dist(a, H) < best) { best = dist(a, H); openTip = b }
    else if (dist(b, H) < 0.12 * r && dist(a, H) > 0.7 * r && dist(b, H) < best) { best = dist(b, H); openTip = a }
  }
  let strike: [number, number]
  let open: [number, number]
  if (openTip) {
    open = dist(openTip, arc.e0) < dist(openTip, arc.e1) ? arc.e0 : arc.e1
    strike = open === arc.e0 ? arc.e1 : arc.e0
  } else {
    // Fallback: the block's authored insert rotation points toward the strike jamb.
    const wx = Math.cos(item.rotation)
    const wy = Math.sin(item.rotation)
    const d0 = (arc.e0[0] - H[0]) * wx + (arc.e0[1] - H[1]) * wy
    const d1 = (arc.e1[0] - H[0]) * wx + (arc.e1[1] - H[1]) * wy
    strike = d0 >= d1 ? arc.e0 : arc.e1
    open = strike === arc.e0 ? arc.e1 : arc.e0
  }
  const axisAngle = snapCardinal(Math.atan2(strike[1] - H[1], strike[0] - H[0]))
  // Cross product (strike−H) × (open−H): >0 ⟹ leaf swings CCW/left of the axis
  // (the canonical, unmirrored hand); <0 ⟹ the reflected hand.
  const cross = (strike[0] - H[0]) * (open[1] - H[1]) - (strike[1] - H[1]) * (open[0] - H[0])
  return { axisAngle, mirror: cross < 0, leafLen: r }
}

interface DetectedArc {
  center: [number, number]
  r: number
  e0: [number, number]
  e1: [number, number]
  sweep: number
}

/** Find polylines that are (tessellated) circular arcs: all vertices near-equal
 *  distance from the circumcenter of their first/mid/last points. */
function detectArcs(entities: FurnitureItem['entities']): DetectedArc[] {
  const out: DetectedArc[] = []
  for (const e of entities) {
    if (e.kind !== 'polyline' || !e.pts || e.pts.length < 6) continue
    const p = e.pts
    const n = p.length
    const c = circumcenter(p[0], p[Math.floor(n / 2)], p[n - 1])
    if (!c) continue
    const r = dist(c, p[0])
    if (!(r > 0.05)) continue
    let ok = true
    const step = Math.max(1, Math.floor(n / 6))
    for (let i = 0; i < n; i += step) {
      if (Math.abs(dist(c, p[i]) - r) > 0.06 * r) { ok = false; break }
    }
    if (!ok) continue
    const a0 = Math.atan2(p[0][1] - c[1], p[0][0] - c[0])
    const a1 = Math.atan2(p[n - 1][1] - c[1], p[n - 1][0] - c[0])
    let sweep = Math.abs(a1 - a0)
    if (sweep > Math.PI) sweep = 2 * Math.PI - sweep
    out.push({ center: c, r, e0: p[0], e1: p[n - 1], sweep })
  }
  return out
}

/** Circumcenter of three points, or null if they are collinear. */
function circumcenter(a: [number, number], b: [number, number], c: [number, number]): [number, number] | null {
  const [ax, ay] = a
  const [bx, by] = b
  const [cx, cy] = c
  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by))
  if (Math.abs(d) < 1e-9) return null
  const a2 = ax * ax + ay * ay
  const b2 = bx * bx + by * by
  const c2 = cx * cx + cy * cy
  return [
    (a2 * (by - cy) + b2 * (cy - ay) + c2 * (ay - by)) / d,
    (a2 * (cx - bx) + b2 * (ax - cx) + c2 * (bx - ax)) / d,
  ]
}

function dist(a: [number, number], b: [number, number]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1])
}

/** Snap an angle to the nearest cardinal (0 · π/2 · π · 3π/2), normalized to
 *  [0, 2π). Office walls are axis-aligned, and this keeps the door's rotation on
 *  the same cardinal/aspect-parity contract the desk/chair renderers rely on. */
function snapCardinal(rad: number): number {
  const q = ((Math.round(rad / (Math.PI / 2)) % 4) + 4) % 4
  return q * (Math.PI / 2)
}

/**
 * Cardinal (0 · π/2 · π · 3π/2) world-CCW orientation for a directional block.
 *
 * The 90°-parity is pinned to the footprint `aspect` (portrait ⟺ one quarter-turn)
 * so the renderer's "un-swap to natural footprint, then rotate" stays exact and the
 * axis-aligned `w/h` — which `mergeFit` still consumes verbatim — never shifts. The
 * remaining 180° flip is recovered from the block's AUTHORED rotation: a block
 * rounded to the 180°/270° quadrant faces the reverse hemisphere, so we add π. This
 * is what separates a 0° desk from a 180° one (both landscape) and a 90° desk from a
 * 270° one (both portrait) — the cases a bbox alone cannot tell apart.
 */
function cardinalOrientation(rawRotation: number, portrait: boolean): number {
  const r = Number.isFinite(rawRotation) ? rawRotation : 0
  // Quadrant of the authored rotation: 0,1,2,3 quarter-turns (robust to negatives).
  const quad = ((Math.round(r / (Math.PI / 2)) % 4) + 4) % 4
  let rot = portrait ? Math.PI / 2 : 0
  if (quad === 2 || quad === 3) rot += Math.PI // reverse hemisphere → 180° flip
  return rot
}
