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
 *  supplies position (bbox center) + a rotation of 0 — the axis-aligned bbox
 *  already bakes the block's rotation in, and the orientation we care about is
 *  carried by which of w/h is the long side. */
export interface NormalizedComponent {
  /** Editor/CATALOG category string → drives the canonical top-view symbol. */
  category: string
  /** Normalized footprint width (meters). */
  w: number
  /** Normalized footprint height (meters). */
  h: number
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
  switch (category) {
    case 'Desk': {
      // Snap to the canonical desk footprint, long side along the block's long side.
      const long = Math.max(DESK.w, DESK.h)
      const short = Math.min(DESK.w, DESK.h)
      ;[w, h] = portrait ? [short, long] : [long, short]
      break
    }
    case 'Chair':
      w = CHAIR.w
      h = CHAIR.h
      break
    case 'Table':
      // Keep the real footprint (tables genuinely span side-table → boardroom).
      w = Math.max(bw, MIN_TABLE_SIDE)
      h = Math.max(bh, MIN_TABLE_SIDE)
      break
    default:
      // Door / Window / neutral Furniture: keep the real footprint.
      w = bw
      h = bh
  }

  return {
    category,
    w,
    h,
    label: item.productName ?? item.name,
    productId: item.productId,
    productName: item.productName,
  }
}
