/**
 * Scores and statistics read back from the Rust core.
 *
 * `Metrics`/`ZoneStat` come from `Editor.metrics()`/`Editor.zone_stats()`,
 * `LayoutScore` from `Editor.generate()`/`layout_score()`, and
 * `CirculationScore` from `Editor.circulation()` — all computed in Rust, never
 * derived TS-side (CLAUDE.md: core is the source of truth).
 */

import type { ZoneType } from './doc'

/**
 * Whether a plate-derived number is a MEASUREMENT or a stand-in — the three
 * tags `document::PlateResolution::tag()` emits, with ONE owner on this side.
 *
 * Named because two interfaces carry it (`Metrics` and `LayoutScore`) and it was
 * previously spelled out inline in one of them and absent from the other, so the
 * union could drift in exactly the way a shared tag must not.
 */
export type PlateState = 'traced' | 'open' | 'unresolved'

export interface Metrics {
  floor_area: number
  wall_count: number
  component_count: number
  confirmed: number
  // Slice 2 additive Statistics-panel fields (optional for backward-compat).
  gross_external_area?: number
  net_internal_area?: number
  workstations?: number
  area_per_workstation?: number
  efficiency_pct?: number
  /** Wasted floor (m²) — `ZoneType.Unassigned`. Internal/editor only. */
  unassigned_area?: number
  /** Wasted floor as % of NIA — waste's own name, kept OUT of `efficiency_pct`
   *  so that number stays comparable to the industry benchmark. Never published. */
  unassigned_pct?: number
  /**
   * Whether `gross_external_area` is a MEASUREMENT.
   *
   * - `traced` — a face of the wall network was identified as this plan's floor.
   * - `open` — the walls close nowhere; the figure is the wall bounding box.
   * - `unresolved` — the walls DO close, but no closed face contains the plan.
   *   Something the user drew changed which loops exist and the floor is no
   *   longer identifiable.
   *
   * The panel MUST branch on this before printing a gross area. A silent
   * bounding-box fallback is not a smaller number, it is a different quantity,
   * and showing it in the same slot is how "GEA 1 m²" read as a fact rather than
   * as a broken wall loop. Optional only for documents metered by an older core.
   */
  plate_state?: PlateState
  /**
   * Whether these numbers are a MEASUREMENT — absent (`undefined`; `None`
   * crosses the wasm boundary that way) normally, a sentence naming the
   * impossibility when one is not.
   *
   * The release-visible successor to a `debug_assert!`. Efficiency reached
   * 102.469% (retype every F4 zone to Workspace) and 648.4% (overlapping
   * Workspace rects) behind an assertion that is **compiled out of the wasm we
   * ship**, so the one guard at the source of the defect did not exist in the
   * only build a user runs. The core now caps the value AND states why here.
   *
   * Display it; never branch on its text. A cap that nothing renders is a
   * `debug_assert` with extra steps.
   */
  metrics_error?: string | null
  indicative_cost?: number
  /** Σ observed ₹ prices of bank-bound components (specified furniture capex). */
  specified_cost?: number
  indicative_carbon?: number
}
export interface ZoneStat {
  id: number
  zone_type: ZoneType
  label: string
  area: number
  capacity: number
  seated: number
  pct_of_nia: number
}
/**
 * **THE per-zone floor areas, m², keyed by zone id — the only way an area
 * enters web/ (R17).**
 *
 * The quantity has one definition and it is in Rust: `mod basis` in
 * `crates/ds-core/src/lib.rs`, which clips each zone to the traced plate,
 * de-overlaps Workspace fields against the rooms carved out of them, and
 * applies the overflow cap. Two wasm surfaces publish it —
 * `zone_stats()`/`zone_stats_published()` as `ZoneStat.area`, and
 * `quantities()` as `RoomQuantity.areaM2` — and a standing gate proves they
 * agree per row, so either is authoritative and neither is a second owner.
 *
 * The boundary can stop web/ NAMING the Rust definition; it cannot stop web/
 * RECOMPUTING it from the shapes that `state()` necessarily carries for
 * drawing. That is exactly what happened: `util/zoneGeom.zoneArea(shape)` was
 * raw, unclipped and un-de-overlapped, and sheet A.09 billed
 * `Open Workspace (2)` at 35.0 m² against the workbook's 8.0 on an unedited
 * fixture. Passing this map is what makes a consumer's area source visible at
 * the call site — and its absence a compile error rather than a wrong number.
 */
export type ZoneAreas = ReadonlyMap<number, number>

/** `ZoneAreas` from `Editor.zone_stats()` / `Editor.zone_stats_published()`. */
export function zoneAreasFromStats(rows: readonly ZoneStat[]): ZoneAreas {
  return new Map(rows.map((r) => [r.id, r.area]))
}

/**
 * `ZoneAreas` from `Editor.quantities()`'s room rows. Structural in its
 * parameter (`{ roomId, areaM2 }[]`) rather than importing `Quantities`, so
 * `types/` keeps the acyclic `program → metrics → doc` chain CLAUDE.md pins.
 */
export function zoneAreasFromRooms(
  rooms: readonly { roomId: number; areaM2: number }[],
): ZoneAreas {
  return new Map(rooms.map((r) => [r.roomId, r.areaM2]))
}

export interface LayoutScore {
  capacity: number
  adjacency: number
  circulation: number
  /** m²/person NIA density, peaking in the professional 8–12 band (M5). */
  density: number
  /** Delivered vs derived room program, 0..100 (M3/M4). */
  program_fit: number
  /** % of workstations within reach of the facade (M5). */
  daylight: number
  /** Entry narrative: reception near the entry, pantry far (M5). */
  entry_adjacency: number
  total: number
  placed_desks: number
  /**
   * Points deducted from `total` for floor the plan wastes: 10 x the
   * `Unassigned` share of the plate, so always in `[0, 10]`.
   *
   * **This interface did not carry it, and the Rust struct always sent it.** A
   * TS type that under-describes the wasm payload cannot be read as a contract:
   * the field a defect was measured ON — Line A's 15.28-point un-de-overlapped
   * penalty, against a term specified at ~1.8 — was invisible to every TS
   * consumer and to `tsc`. Landed at the 2b integration with `plate_state`.
   */
  unassigned_penalty: number
  /**
   * Whether the numbers above are a measurement — the same three tags, from the
   * same owner, as `Metrics.plate_state`. On `"unresolved"` the floor is a
   * bounding-box stand-in and every plate-derived sub-score (and `total`) rests
   * on it; show that state rather than the score.
   */
  plate_state: PlateState
}
export interface CirculationScore {
  score: number
  reachable_free_area: number
  floor_area: number
  circulation_ratio: number
  min_corridor_width: number
  mean_clearance: number
  pct_corridors_below_min: number
  largest_connected_free_region: number
  enclosed: boolean
  grid_cols: number
  grid_rows: number
  cell_size: number
}
