/**
 * Scores and statistics read back from the Rust core.
 *
 * `Metrics`/`ZoneStat` come from `Editor.metrics()`/`Editor.zone_stats()`,
 * `LayoutScore` from `Editor.generate()`/`layout_score()`, and
 * `CirculationScore` from `Editor.circulation()` — all computed in Rust, never
 * derived TS-side (CLAUDE.md: core is the source of truth).
 */

import type { ZoneType } from './doc'

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
   * Did `generate` actually produce a plan? False when nothing was placed at
   * all — a FAILED generation, not a low-scoring one.
   *
   * Never present a candidate, a score or a priced deliverable for an
   * infeasible result. Several sub-scores divide by populations that are empty
   * in exactly that case, so before this existed an empty plan reported
   * adjacency/daylight/entry_adjacency of 100 for a total of 38.7, and the
   * wizard offered three scored candidates for a document containing nothing
   * (cad-validation/findings/F4-empty-plan-scored-as-success.md).
   *
   * Optional so a score decoded from an older persisted plan still type-checks;
   * treat `undefined` as feasible, since pre-existing saved plans were only
   * ever stored after a successful generate.
   */
  feasible?: boolean
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
