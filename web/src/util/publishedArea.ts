// THE per-zone floor area a deliverable is allowed to print.
//
// One definition, and it lives in Rust. `crate::basis::area_basis` is the core's
// single owner of per-zone area — plate-clipped, de-overlapped (a Workspace
// field does not bill the rooms carved out of it) and cap-scaled when the zones
// fail to tile the traced floor. Its raw vector is private to that module and
// unnameable from anywhere else, so the workbook's Room Schedule, the Zones tab,
// the areas donut and the metrics chip all read one number by construction.
//
// This module is that guarantee's TypeScript end. It does not compute an area
// and it must never learn how to: it carries the core's numbers, keyed by zone
// id, from `Editor.zone_stats()` (or `Editor.quantities()`) to the sheet, label
// or panel that prints them.
//
// WHAT WENT WRONG WITHOUT IT. `util/zoneGeom.zoneArea(shape)` — raw shoelace,
// none of the three corrections above — was a fourth, fifth, sixth and seventh
// owner, and four of its call sites published the result. On the UNEDITED F1
// fixture, zone 244 "Open Workspace (2)" printed **35.0 m²** on sheet A.09 and
// on the plan label while the workbook billed **8.0 m²** for the same zone id in
// the same delivered pack. 23 of F4-retyped's 24 scheduled rooms disagreed. The
// unification that fixed this in the core was certified with a `rustc` census,
// and `rustc` cannot see `web/src/export/`.
//
// A MISSING ID IS A FAILURE, NEVER A SKIP (.claude/rules/gate-independence.md).
// `publishedZoneArea` throws rather than defaulting to 0 or falling back to the
// shape: a zone the core did not measure is a bug in the caller's plumbing, and
// printing a plausible wrong number is how this class hides.

import type { ZoneStat } from '../types/metrics'

// ONE TYPE NAME IN THE MERGED TREE. Line A called this `ZoneAreas`
// and Line B called it `ZoneAreas`; they are the same type, and two names for
// one thing is the smell this mission spends its rounds on. B's name survives
// because eight merged files already import it — a name is not a mechanism, and
// what mattered in A was the ACCESSORS below, which B never had.
import type { ZoneAreas } from '../types/metrics'
export type { ZoneAreas }

/**
 * Build the map from the core's own rows — `Editor.zone_stats()` or
 * `Editor.zone_stats_published()`, which carry byte-identical areas (only the
 * `Unassigned`→`Circulation` word differs), or any `{ id, area }` projection of
 * `Editor.quantities().rooms`.
 */
export function publishedZoneAreas(rows: readonly Pick<ZoneStat, 'id' | 'area'>[]): ZoneAreas {
  return new Map(rows.map((r) => [r.id, r.area]))
}

/** The published area of one zone, m². Throws when the core never measured it. */
export function publishedZoneArea(areas: ZoneAreas, zoneId: number): number {
  const a = areas.get(zoneId)
  if (a === undefined) {
    throw new Error(
      `publishedZoneArea: zone ${zoneId} has no area from the core. Pass the ` +
        `zone_stats() rows for THIS document — never fall back to the shape.`,
    )
  }
  return a
}

/**
 * The published area as the ONE string every surface prints: one decimal, no
 * unit (callers append " m²" where their layout wants it). One rounding rule, so
 * the schedule and the plan label can never disagree in the last digit.
 */
export function publishedAreaText(areas: ZoneAreas, zoneId: number): string {
  return publishedZoneArea(areas, zoneId).toFixed(1)
}
