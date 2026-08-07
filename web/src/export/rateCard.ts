// The RATE CARD — the one place a ₹ figure comes from when no product is bound.
//
// ---------------------------------------------------------------------------
// Why this exists, and what it is NOT
// ---------------------------------------------------------------------------
//
// ADR 0004 makes price CORE-AUTHORITATIVE: a component bound to a product
// carries `price_inr`, written by `Editor.assign_product`, and that number wins
// over everything in this file, always. Nothing here ever overrides a real
// price, and nothing here invents one for a product the material bank published
// as `null` — that stays "to be quoted", exactly as `commercial.ts` carries it.
//
// But a quantity takeoff is not a furniture catalogue. Drywall, carpet tile,
// gypsum ceiling and glazed fronts are priced from a RATE SCHEDULE — ₹ per m²
// or per running metre of a specified build-up — and no product bank prices
// them. A takeoff whose entire commercial half reads ₹0 because "the bank has
// no SKU for drywall" is not honest, it is unfinished. So: measured quantities
// (the core's) × published market rates (this file), with every rate carrying
// the basis that makes it defensible, printed in the workbook where the reader
// can see and change it.
//
// Three kinds of number therefore appear in the deliverables, and they are
// always distinguishable:
//
//   `bound`      — ₹ from `Component.price_inr`. A real product, a real price.
//   `rate-card`  — ₹ from here. A market rate for a specified build-up.
//   `unpriced`   — no rate exists. Carried as "to be quoted", never as 0.
//
// ---------------------------------------------------------------------------
// Why this is a new table and not a reuse of `editor/stats.ts`
// ---------------------------------------------------------------------------
//
// `crates/ds-core/src/cost.rs` and its TS mirror `editor/stats.ts` hold an
// ELEMENT model: one blended ₹/m² for "base shell" (flooring + ceiling +
// lighting + power + data + HVAC + fire), one ₹/running-m for "solid
// partition", one ₹/leaf for "door". That is the right shape for a headline
// number and the wrong shape for a takeoff, which bills a NAMED material
// ("Carpet tile 500×500 (CPT)") against a MEASURED quantity. This file is the
// finer decomposition of the same market — a different responsibility, per
// `.claude/rules/no-bloat.md`'s fork rule.
//
// Where the two genuinely describe the same thing, this file DERIVES its figure
// from the element benchmark rather than restating it ({@link ELEMENT_BENCHMARK_INR}),
// and `rateCard.test.mjs` parses those constants out of the Rust source and
// fails on divergence — the mechanism `CLAUDE.md` prescribes for an unavoidable
// mirror.
//
// ---------------------------------------------------------------------------
// Grounding
// ---------------------------------------------------------------------------
//
// Indian metro (Bengaluru / Hyderabad) commercial CAT-B fit-out market, ₹,
// 2024–25, supply-and-install. Finish and partition rates are the component
// ₹/sqft ranges already cited in `cost.rs` (Holzbox 2024, Studio Matrx 2026)
// converted at 10.764 sqft/m². Furniture rates sit inside price bands observed
// in the LIVE material bank; each entry names its comparator, with the bank's
// own observation date, so a reader can re-check it.

/** sqft per m². Only used to state a rate's ₹/sqft equivalent in its basis. */
export const SQFT_PER_M2 = 10.7639

/**
 * The elevation (m) the ₹/running-metre partition benchmarks assume — a
 * ~2.7 m storey. Dividing by it is what turns a running-metre rate into the
 * ₹/m²-of-elevation the workbook's wall rows bill against, since those rows
 * measure `wall height × run`.
 */
export const BENCHMARK_STOREY_M = 2.7

/**
 * The element-model figures this card decomposes. **Mirrors
 * `crates/ds-core/src/cost.rs`** (`PARTITION_SOLID`, `PARTITION_GLASS`, `DOOR`,
 * `furniture_rate`) and its TS twin `web/src/editor/stats.ts` (`WALL`, `FURN`).
 * `rateCard.test.mjs` re-reads the Rust source and fails if any of these drift.
 */
export const ELEMENT_BENCHMARK_INR = {
  /** ₹ per running metre of solid boarded/painted drywall partition. */
  partitionSolidPerM: 4_600,
  /** ₹ per running metre of framed aluminium office glazing. */
  partitionGlassPerM: 15_000,
  /** ₹ per door leaf, blended across types (leaf + frame + ironmongery). */
  doorPerLeaf: 25_000,
  /** ₹ per unit, task / soft seating. */
  seatingPerUnit: 12_000,
  /** ₹ per unit, desk or table (the element model's blended figure). */
  deskOrTablePerUnit: 20_000,
  /** ₹ per unit, storage / cabinet / pedestal. */
  storagePerUnit: 12_000,
  /** ₹ per unit, acoustic pod / phone booth. */
  privacyPerUnit: 120_000,
  /** ₹ per unit, loose accessory. */
  accessoryPerUnit: 2_500,
} as const

/** Where a ₹ figure on a deliverable came from. */
export type PriceBasis = 'bound' | 'rate-card' | 'unpriced'

/** Human label for {@link PriceBasis}, for a Price Basis column. */
export const PRICE_BASIS_LABEL: Record<PriceBasis, string> = {
  bound: 'Bound product — material bank',
  'rate-card': 'Rate card — market rate',
  unpriced: 'To be quoted',
}

export interface Rate {
  /** ₹ per {@link unit}. */
  inr: number
  unit: 'm^2' | 'm' | 'Number'
  /** Why this figure is defensible. Printed in the workbook's rate-basis table,
   *  so it is the reader's answer to "where did ₹1,250 come from?". */
  basis: string
}

const m2 = (inr: number, basis: string): Rate => ({ inr, unit: 'm^2', basis })
const each = (inr: number, basis: string): Rate => ({ inr, unit: 'Number', basis })

/** `₹1,250/m² (≈₹116/sqft)` — the form every finish basis string opens with. */
function per(inr: number): string {
  return `₹${inr.toLocaleString('en-IN')}/m² ≈ ₹${Math.round(inr / SQFT_PER_M2)}/sqft`
}

// ---------------------------------------------------------------------------
// Floor finishes — keyed by `FINISH_SPEC[*].floor` (finishSchedule.ts)
// ---------------------------------------------------------------------------

export const FLOOR_RATE_INR: Record<string, Rate> = {
  'Carpet tile 500×500 (CPT)': m2(
    1_250,
    `${per(1_250)}. Commercial nylon loop-pile tile, supply + lay on levelled screed; CAT-B flooring band ₹80–150/sqft.`,
  ),
  'Carpet tile, premium (CPT)': m2(
    2_000,
    `${per(2_000)}. Heavy-contract solution-dyed nylon tile with acoustic backing — boardroom spec.`,
  ),
  'Engineered timber (TIM)': m2(
    2_400,
    `${per(2_400)}. Engineered oak plank on ply sub-deck, sanded + sealed.`,
  ),
  'Porcelain stone, LF (POR)': m2(
    1_950,
    `${per(1_950)}. Large-format porcelain, adhesive-set with epoxy grout — reception-grade.`,
  ),
  'Anti-skid vitrified tile (VIT)': m2(
    1_050,
    `${per(1_050)}. Anti-skid vitrified tile with coved skirting — pantry / wet-adjacent.`,
  ),
  'Anti-skid ceramic, R10 (CER)': m2(
    950,
    `${per(950)}. R10 anti-skid ceramic on waterproofed screed — toilet cores.`,
  ),
  'Luxury vinyl tile (LVT)': m2(
    1_150,
    `${per(1_150)}. 2.5 mm commercial LVT plank, glue-down on levelling compound.`,
  ),
  'Cushioned vinyl (LVT)': m2(
    1_350,
    `${per(1_350)}. Cushioned-back vinyl sheet, welded seams — wellness / quiet rooms.`,
  ),
  'Sealed vinyl / screed (VNL)': m2(
    550,
    `${per(550)}. Sealed screed with vinyl skirting — back-of-house store.`,
  ),
  'Anti-static vinyl (VNL)': m2(
    1_850,
    `${per(1_850)}. Conductive anti-static vinyl with copper earthing grid — IT / server rooms.`,
  ),
  'Cement screed, sealed': m2(
    450,
    `${per(450)}. Power-floated screed, dust-sealed — service core, no applied finish.`,
  ),
}

// ---------------------------------------------------------------------------
// Ceiling finishes — keyed by `FINISH_SPEC[*].ceiling`
// ---------------------------------------------------------------------------

export const CEILING_RATE_INR: Record<string, Rate> = {
  'Metal grid 600×600 (MGC)': m2(
    950,
    `${per(950)}. 600×600 lay-in tile on exposed GI grid, incl. hangers; CAT-B ceiling band ₹60–120/sqft.`,
  ),
  'Painted gypsum, cove (GYP)': m2(
    1_350,
    `${per(1_350)}. Suspended gypsum board with perimeter cove + concealed light trough, taped and painted.`,
  ),
  'Gypsum + linear light (GYP)': m2(
    1_700,
    `${per(1_700)}. Gypsum raft with integrated linear-light slots — boardroom spec.`,
  ),
  'Painted gypsum board (GYP)': m2(
    1_150,
    `${per(1_150)}. Suspended gypsum board on GI framing, taped, primed and painted.`,
  ),
  'Suspended gypsum (GYP)': m2(
    1_150,
    `${per(1_150)}. Suspended gypsum board on GI framing, taped, primed and painted.`,
  ),
  'MR gypsum board (MRB)': m2(
    1_250,
    `${per(1_250)}. Moisture-resistant gypsum board, painted — pantry / wet-adjacent.`,
  ),
  'MR grid / board (MRB)': m2(
    1_150,
    `${per(1_150)}. Moisture-resistant lay-in grid with access tiles — toilet cores.`,
  ),
  'Acoustic pad (ACP)': m2(
    1_650,
    `${per(1_650)}. Class-A acoustic pad on suspension, fabric-faced — phone booths.`,
  ),
  'Exposed services, painted': m2(
    350,
    `${per(350)}. Soffit and services prepped and spray-painted; no suspended ceiling.`,
  ),
  'Exposed slab / grid': m2(
    300,
    `${per(300)}. Slab left exposed with partial grid over circulation only.`,
  ),
  'Exposed slab, painted': m2(
    300,
    `${per(300)}. Slab soffit prepped and painted — IT / server rooms.`,
  ),
  'Exposed slab': m2(200, `${per(200)}. Slab soffit as-found, made good only — service core.`),
}

// ---------------------------------------------------------------------------
// Walls and glazed fronts — ₹ per m² of ELEVATION
// ---------------------------------------------------------------------------
//
// The workbook's wall and glass rows bill `wall height × run`, i.e. m² of
// elevation, so these are ₹/m² and not ₹/running metre. The two solid/glazed
// figures are the element benchmark divided by the 2.7 m storey it assumes,
// rounded to the nearest ₹50 — derived, not restated.

const SOLID_PER_M2 = Math.round(ELEMENT_BENCHMARK_INR.partitionSolidPerM / BENCHMARK_STOREY_M / 50) * 50
const GLASS_PER_M2 = Math.round(ELEMENT_BENCHMARK_INR.partitionGlassPerM / BENCHMARK_STOREY_M / 50) * 50

export const WALL_RATE_INR: Record<string, Rate> = {
  Drywall: m2(
    SOLID_PER_M2,
    `${per(SOLID_PER_M2)}. Full-height boarded partition — GI studs, insulation, board both faces, taped and painted. ` +
      `Derived: ₹${ELEMENT_BENCHMARK_INR.partitionSolidPerM.toLocaleString('en-IN')}/running m ÷ ${BENCHMARK_STOREY_M} m storey.`,
  ),
  'Half Drywall': m2(
    Math.round(SOLID_PER_M2 / 2 / 50) * 50,
    `Half of the Drywall rate BY DESIGN: the takeoff measures every wall row at the full storey ` +
      `height (General!D5), so a half-height screen is billed at half the ₹/m² to land on the ` +
      `correct line total. Read the line total, not this rate, in isolation.`,
  ),
  Glass: m2(
    GLASS_PER_M2,
    `${per(GLASS_PER_M2)}. Framed aluminium office glazing. Billed on the 'BOM - Glass Partitions' sheet, not here — ` +
      `this row exists so the wall schedule stays complete.`,
  ),
  Core: m2(
    1_150,
    `${per(1_150)}. Dry-lining to the base-build core face — furring, board, skim and paint. ` +
      `The core structure itself is landlord scope.`,
  ),
  'Perimeter windows': m2(
    450,
    `${per(450)}. FIT-OUT SCOPE ONLY at the glass line: roller blinds, pelmet and perimeter closure. ` +
      `The facade itself is base-build and is NOT bought by a CAT-B fit-out — pricing it as glazing ` +
      `would overstate this floor by tens of lakhs.`,
  ),
  'Perimeter wall': m2(
    850,
    `${per(850)}. Making good the existing perimeter — dry-lining / plaster repair, skim and paint.`,
  ),
}

export const GLASS_PARTITION_RATE_INR: Record<string, Rate> = {
  'Glass Partition': m2(
    GLASS_PER_M2,
    `${per(GLASS_PER_M2)}. Framed aluminium office front, 12 mm toughened, with door cut-outs and seals. ` +
      `Derived: ₹${ELEMENT_BENCHMARK_INR.partitionGlassPerM.toLocaleString('en-IN')}/running m ÷ ${BENCHMARK_STOREY_M} m storey.`,
  ),
}

// ---------------------------------------------------------------------------
// Doors — ₹ per leaf
// ---------------------------------------------------------------------------
//
// The two split either side of the element model's blended ₹25,000/leaf, and
// average back to it exactly — asserted in `rateCard.test.mjs`.

export const DOOR_RATE_INR: Record<string, Rate> = {
  Glass: each(
    28_000,
    'Frameless 12 mm toughened glass leaf with patch fittings, floor spring and pull — ₹12k–28k leaf band, top end.',
  ),
  Solid: each(
    22_000,
    'Flush laminate-faced leaf, hardwood frame, ironmongery and vision panel — ₹12k–28k leaf band, mid.',
  ),
}

// ---------------------------------------------------------------------------
// Furniture — ₹ per unit, by document category
// ---------------------------------------------------------------------------

/**
 * Tables are the one category a flat per-unit rate cannot describe honestly: an
 * 1.9 × 2.9 m boardroom table and a 0.6 × 0.6 m side table are the same
 * `Table` category and are not the same purchase. So tables are priced off the
 * PLACED footprint — which the core measures — at a ₹/m²-of-top rate chosen so
 * that a standard 1400 × 700 desk-sized top lands on the element model's
 * ₹20,000, with a floor for small occasional tables.
 */
const TABLE_PER_M2 = 20_000
const TABLE_MIN = 12_000

/** Live-bank comparators captured 2026-08-07, quoted in the basis strings so a
 *  reader can re-run the query. All `basis: listed_mrp`, none stale. */
const BANK_NOTE = {
  seating:
    "bank comparators: Doe Buck 'Preglo Task Chair' ₹10,999 and 'Adan Task Chair' ₹12,999 " +
    '(urbanladder.com, listed MRP, observed 2026-07-07)',
  desk:
    "bank comparator: Haworth India 'Intuity Office Desk 120×60' ₹44,500 " +
    '(in.shopping.haworth.com, listed MRP, observed 2026-07-05) — contract-grade single desk at list; ' +
    'a bench workstation procured at floor-plate scale sits well below it',
  table:
    "bank comparators: Mohh 'Phillip' ₹34,999 · ABACA 'Remy' ₹45,200 · ABACA 'Antwerp' ₹128,300 " +
    '(listed MRP, observed 2026-07-16)',
  storage:
    "bank comparators: Nilkamal engineered-wood cabinet ₹6,990 · Adona 'Lyra Storage Cabinet' ₹25,299 " +
    '(listed MRP, observed 2026-07-07/14)',
}

/** Which rate family a document category falls into. Mirrors the grouping in
 *  `editor/stats.ts` `furnGroup` — same buckets, same words. */
function furnitureGroup(category: string): 'seating' | 'desk' | 'table' | 'storage' | 'privacy' | 'accessory' | null {
  const c = category.toLowerCase()
  if (/\bdoor\b/.test(c)) return null // doors are priced by DOOR_RATE_INR
  if (/chair|sofa|lounge|stool|seat|bench/.test(c)) return 'seating'
  if (/desk|workstation/.test(c)) return 'desk'
  if (/table|counter|credenza|worktop/.test(c)) return 'table'
  if (/storage|cabinet|locker|shelf|pedestal|file/.test(c)) return 'storage'
  if (/pod|booth|phone/.test(c)) return 'privacy'
  if (/plant|screen|lamp|bin|accessor/.test(c)) return 'accessory'
  return null
}

/**
 * The rate-card ₹ for one placed furniture component, or `null` when the card
 * has no defensible figure for it — in which case the line stays UNPRICED and
 * says so. `wM`/`hM` are the placed footprint in metres.
 */
export function furnitureRate(category: string, wM: number, hM: number): Rate | null {
  const g = furnitureGroup(category)
  const B = ELEMENT_BENCHMARK_INR
  switch (g) {
    case 'seating':
      return each(
        B.seatingPerUnit,
        `Mid-spec ergonomic task chair — synchro mechanism, adjustable arms, mesh back; ${BANK_NOTE.seating}.`,
      )
    case 'desk':
      return each(
        B.deskOrTablePerUnit,
        `1400 × 700 bench workstation incl. cable tray, screen and mobile pedestal; ${BANK_NOTE.desk}.`,
      )
    case 'table': {
      const areaM2 = Math.max(0, wM) * Math.max(0, hM)
      const inr = Math.max(TABLE_MIN, Math.round((areaM2 * TABLE_PER_M2) / 100) * 100)
      return each(
        inr,
        `Sized off the placed top: ${areaM2.toFixed(2)} m² × ₹${TABLE_PER_M2.toLocaleString('en-IN')}/m² ` +
          `(floor ₹${TABLE_MIN.toLocaleString('en-IN')}). Veneer or laminate top on a steel frame, ` +
          `with power/data grommet; ${BANK_NOTE.table}.`,
      )
    }
    case 'storage':
      return each(B.storagePerUnit, `Steel or laminate storage unit with lock; ${BANK_NOTE.storage}.`)
    case 'privacy':
      return each(
        B.privacyPerUnit,
        'Acoustic phone booth / meeting pod — glazed, ventilated, lit, delivered and assembled.',
      )
    case 'accessory':
      return each(B.accessoryPerUnit, 'Loose accessory — planter, desk screen, waste unit.')
    default:
      return null
  }
}

// ---------------------------------------------------------------------------
// Lookup across every construction block
// ---------------------------------------------------------------------------

/** Which `General` catalog block a rate belongs to. */
export type RateCategory = 'Floors' | 'Ceilings' | 'Walls' | 'Glass Partitions' | 'Doors'

const BLOCKS: [RateCategory, Record<string, Rate>][] = [
  ['Floors', FLOOR_RATE_INR],
  ['Ceilings', CEILING_RATE_INR],
  ['Walls', WALL_RATE_INR],
  ['Glass Partitions', GLASS_PARTITION_RATE_INR],
  ['Doors', DOOR_RATE_INR],
]

/**
 * The rate for a `General` Material / Type Name, searched in the block the
 * caller names first so the two `Glass` entries (a wall type and a door type)
 * cannot collide.
 */
export function constructionRate(name: string, category?: RateCategory): Rate | null {
  if (category) {
    const block = BLOCKS.find(([c]) => c === category)?.[1]
    return block?.[name] ?? null
  }
  for (const [, block] of BLOCKS) {
    if (block[name]) return block[name]
  }
  return null
}

/** Every construction rate, flattened — the workbook's visible rate-basis table
 *  and the rate-card tests both iterate this. */
export function allConstructionRates(): { category: RateCategory; name: string; rate: Rate }[] {
  return BLOCKS.flatMap(([category, block]) =>
    Object.entries(block).map(([name, rate]) => ({ category, name, rate })),
  )
}
