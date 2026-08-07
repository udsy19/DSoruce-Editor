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
  plate_state?: 'traced' | 'open' | 'unresolved'
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
