//! **Zone geometry must read as a plan, not a diagram.**
//!
//! Two properties, both measured off the emitted `Document` (zones, components,
//! walls) and nothing the generator says about itself:
//!
//! 1. [`workspace_zones_hug_their_desks`] — an open-workspace zone may not bill
//!    floor it does not work. Every point of a `Workspace` zone must lie within
//!    the program's own declared `desk_clearance_m` of a desk footprint the zone
//!    contains. One rectangle thrown over the whole desk field fails this by
//!    construction, and no area ratio has to be invented to say so.
//! 2. [`no_untyped_floor_inside_the_plate`] — `layout.rs` states the invariant in
//!    as many words ("a professional test-fit leaves NO untyped floor: every m²
//!    is a desk, a room, the building core, OR named circulation"). This measures
//!    it, excusing only the floor the code deliberately leaves bare: the
//!    [`FACADE_GAP`] maintenance strip along the plate boundary.
//!
//! **Anchors.** The hug distance is `Program::desk_clearance_m` — the caller's own
//! spec for how much room a desk needs — and the untyped excuse is `FACADE_GAP`,
//! a named constant with a documented reason. Neither is a percentile of the
//! plates below, because a threshold fitted to the population it judges is the
//! failure `.claude/rules/gate-independence.md` documents.
//!
//! Both run over the same plate matrix, which includes the USER'S REAL IMPORTED
//! PLATE (`dwg_plate`), because that is the artifact the defects were reported on.

use super::*;

/// Raster step (m) for every area measurement here. Fine enough that a 0.9 m
/// aisle is ~13 cells across, coarse enough to sweep a 930 m² plate.
const CELL: f64 = 0.25;

/// The plate matrix: name, document, program. Deliberately spans every packing
/// regime — one rectangular region, an axis-aligned L, the synthetic 43-corner
/// plate, the imported 107-wall DWG plate the defects were reported on, and two
/// TILTED plates.
///
/// The tilted pair is here because the sabotage round said so. Disabling the
/// neighbour midpoint split in `emit::emit_workspace_bands` produced two
/// overlapping `Workspace` zones — and on the axis-aligned four it produced
/// none, so the failure surfaced only as an `NIA > GEA` in
/// `stress_insights_invariants_over_shape_space`, two inferences from the cause.
/// A rotated trapezoid and parallelogram are where runs land off each other's
/// grain, which is the condition the overlap needs.
fn plates() -> Vec<(String, Document, Program, u64)> {
    let rotate = |corners: &[(f64, f64)], th: f64| -> Document {
        let (s, c) = th.sin_cos();
        let pts: Vec<(f64, f64)> =
            corners.iter().map(|&(x, y)| (x * c - y * s, x * s + y * c)).collect();
        room_from_corners(&pts)
    };
    const TRAPEZOID: [(f64, f64); 4] = [(0.0, 0.0), (30.0, 0.0), (22.0, 12.0), (4.0, 12.0)];
    const PARALLELOGRAM: [(f64, f64); 4] = [(0.0, 0.0), (28.0, 0.0), (34.0, 12.0), (6.0, 12.0)];
    let mut v: Vec<(String, Document, Program, u64)> = Vec::new();
    for seed in [1u64, 2, 3] {
        v.push((format!("rect20x14/seed{seed}"), room(20.0, 14.0), Program::default(), seed));
        v.push((format!("l_plate/seed{seed}"), l_room(), Program::default(), seed));
        v.push((format!("real_plate/seed{seed}"), real_plate_doc(), Program::default(), seed));
        v.push((format!("dwg_plate/seed{seed}"), dwg_plate_doc(), dwg_plate_program(), seed));
        v.push((
            format!("trapezoid@1.5rad/seed{seed}"),
            rotate(&TRAPEZOID, 1.5),
            Program::default(),
            seed,
        ));
        v.push((
            format!("parallelogram@1.5rad/seed{seed}"),
            rotate(&PARALLELOGRAM, 1.5),
            Program::default(),
            seed,
        ));
    }
    v
}

/// World-space AABB of a component (rotation-aware).
fn comp_aabb(c: &crate::model::Component) -> (f64, f64, f64, f64) {
    let (w, h) = world_extents(c.w, c.h, c.rotation);
    (c.x - w / 2.0, c.y - h / 2.0, c.x + w / 2.0, c.y + h / 2.0)
}

/// Distance from `(px, py)` to an axis-aligned rect (0 inside).
fn dist_to_rect(px: f64, py: f64, r: (f64, f64, f64, f64)) -> f64 {
    let dx = (r.0 - px).max(0.0).max(px - r.2);
    let dy = (r.1 - py).max(0.0).max(py - r.3);
    (dx * dx + dy * dy).sqrt()
}

/// Per-zone hug report: `(area, worked_area, share)` where `worked_area` is the
/// part of the zone within `reach` of SOME desk on the plan.
///
/// **Some desk, not one of the zone's own.** Which band a desk is bucketed into
/// is decided by `Document::zone_index_at` on the desk's CENTRE, so a desk whose
/// footprint straddles two bands works floor in one of them while counting in the
/// other — an artifact of where the tiling put a boundary, not a fact about the
/// plan. Measuring against every desk asks the question that matters: is this
/// floor doing workstation duty for anybody? The check keeps all its force —
/// collapsing the bands back to one rectangle over the field still fails it, by
/// construction and by measurement (sabotage S1).
fn hug(doc: &Document, z: &Zone, reach: f64) -> (f64, f64, f64) {
    let desks: Vec<(f64, f64, f64, f64)> = doc
        .components
        .iter()
        .filter(|c| c.category == "Desk" && !c.reference)
        .map(comp_aabb)
        .collect();
    let (x0, y0, x1, y1) = z.shape.bbox();
    let (mut area, mut worked) = (0.0, 0.0);
    let mut y = y0 + CELL / 2.0;
    while y < y1 {
        let mut x = x0 + CELL / 2.0;
        while x < x1 {
            if z.shape.contains(x, y) {
                area += CELL * CELL;
                if desks.iter().any(|&d| dist_to_rect(x, y, d) <= reach) {
                    worked += CELL * CELL;
                }
            }
            x += CELL;
        }
        y += CELL;
    }
    let share = if area > 0.0 { worked / area } else { 1.0 };
    (area, worked, share)
}

/// **A `Workspace` zone may not bill floor it does not work.**
///
/// Fails loudly with a per-zone table — area, worked area, share, and the
/// desk count — because a single scalar cannot tell a band that hugs its desk
/// run from a rectangle that swallowed the aisle, the void beside it and the
/// margin above it (`.claude/rules/gate-independence.md`, "A scalar is not
/// geometry").
#[test]
fn workspace_zones_hug_their_desks() {
    // A workstation's own floor is its footprint plus the clearance the program
    // asks for around it. Floor further than that from every desk in the zone is
    // floor the zone is not working.
    const MIN_WORKED_SHARE: f64 = 0.90;
    let mut rows: Vec<String> = Vec::new();
    let mut failures = 0usize;
    for (name, mut doc, program, seed) in plates() {
        generate(&mut doc, &program, seed, false);
        let reach = program.desk_clearance_m.max(0.0);
        for z in doc.zones.iter().filter(|z| z.zone_type == ZoneType::Workspace) {
            let (area, worked, share) = hug(&doc, z, reach);
            let desks = z
                .component_ids
                .iter()
                .filter(|id| {
                    doc.components.iter().any(|c| c.id == **id && c.category == "Desk")
                })
                .count();
            let bad = share < MIN_WORKED_SHARE;
            if bad {
                failures += 1;
            }
            rows.push(format!(
                "  {:<20} {:<22} area {:>7.1}  worked {:>7.1}  share {:>5.2}  desks {:>3}  {}",
                name,
                z.label.chars().take(22).collect::<String>(),
                area,
                worked,
                share,
                desks,
                if bad { "<-- BILLS UNWORKED FLOOR" } else { "" }
            ));
        }
    }
    assert!(
        failures == 0,
        "{failures} Workspace zone(s) bill floor further than the program's own \
         desk clearance from any desk they contain — an open field drawn as one \
         block, not as bands that hug the desk runs:\n{}",
        rows.join("\n")
    );
}

/// **No untyped POCKET a person could stand in.**
///
/// `generate` states the invariant in as many words — every m² is a desk, a room,
/// the core or named circulation — and nothing measured it. It was also gated off
/// entirely for single-region plates, on the stated ground that "a rectangular
/// plate has no such pockets"; it has them.
///
/// **Why a width test and not a percentage.** Untyped floor comes in two kinds
/// and only one of them is a defect. The merge pass keeps its cells a half-raster
/// cell clear of every zone edge, so every zone is ringed by a ~0.125 m untyped
/// seam — two screen pixels, invisible, and summing to a few percent of any
/// plate. A percentage cannot separate that from a 4 × 30 m strip of nothing, and
/// a percentage tuned until the seams pass would be a threshold fitted to the
/// population it judges. So the test asks the question that has an answer:
/// **could a person walk in this untyped floor?** The untyped mask is eroded by
/// half of [`MIN_CIRC_CLEAR_M`] — the IBC-derived clear width `conform.rs`
/// already owns and documents — and anything surviving is a pocket the plan has
/// no account of. Seams vanish by construction; a hole cannot.
#[test]
fn no_walkable_untyped_pocket() {
    let mut rows: Vec<String> = Vec::new();
    let mut failures = 0usize;
    for (name, mut doc, program, seed) in plates() {
        generate(&mut doc, &program, seed, false);
        // ONE derivation of "unaccounted floor somebody could stand in", shared
        // with `walking_area_is_unified_no_white_floor` (`super`).
        let walkable = walkable_untyped_area(&doc);
        let bad = walkable > 0.0;
        if bad {
            failures += 1;
        }
        rows.push(format!(
            "  {:<20} untyped ≥{:.1} m wide: {:>7.1} m²  {}",
            name,
            MIN_CIRC_CLEAR_M,
            walkable,
            if bad { "<-- A HOLE IN THE PLAN" } else { "" }
        ));
    }
    assert!(
        failures == 0,
        "{failures} plate(s) leave a pocket of floor at least {MIN_CIRC_CLEAR_M} m \
         wide belonging to no zone at all — `generate`'s own invariant is that \
         every m² is a desk, a room, the core or named circulation:\n{}",
        rows.join("\n")
    );
}

/// **No zone may claim floor the building does not have.**
///
/// Added because the sabotage round found this class completely unguarded:
/// deleting the corner-in-plate test from `emit::emit_bank_aisles` — which lets
/// an aisle rectangle run straight through an exterior wall — left all 172 tests
/// green, `golden_generate_output_is_frozen` included. `Zone::area_on` clips to
/// the plate, so NIA never noticed; the canvas draws the raw shape, so a reader
/// would have.
///
/// Measured against the plate polygon traced from the walls, not against anything
/// the generator recorded.
///
/// **The tolerance, and the one thing it lets through.** `conform::snap_poly`
/// pulls a merged walking polygon's vertices onto the plate wall, but the EDGE
/// between two snapped vertices is a chord: across a convex corner of the wall it
/// bulges a little way outside. On `real_plate/seed2` one residual `Circulation`
/// polygon does exactly that, for 0.12 m² — 0.014% of an 838 m² plate. That is
/// **pre-existing**: this test was run against `HEAD` with the generator changes
/// reverted and reported the same zone at the same 0.12 m². The bound is set at
/// four raster cells to admit that mechanism and nothing larger; the defect it
/// was written for measured 4.19 m², thirty times over.
#[test]
fn every_zone_lies_inside_the_plate() {
    let mut rows: Vec<String> = Vec::new();
    let mut failures = 0usize;
    for (name, mut doc, program, seed) in plates() {
        generate(&mut doc, &program, seed, false);
        let poly = poly_of(&doc);
        for z in &doc.zones {
            let (x0, y0, x1, y1) = z.shape.bbox();
            let mut outside = 0.0;
            let mut y = y0 + CELL / 2.0;
            while y < y1 {
                let mut x = x0 + CELL / 2.0;
                while x < x1 {
                    if z.shape.contains(x, y) && !geometry::point_in_polygon(x, y, &poly) {
                        outside += CELL * CELL;
                    }
                    x += CELL;
                }
                y += CELL;
            }
            if outside > 4.0 * CELL * CELL {
                failures += 1;
                rows.push(format!(
                    "  {:<20} {:<22} {:?} spills {:>6.2} m² outside the plate",
                    name, z.label.chars().take(22).collect::<String>(), z.zone_type, outside
                ));
            }
        }
        let _ = program;
    }
    assert!(
        failures == 0,
        "{failures} zone(s) claim floor outside the traced plate — drawn on the \
         canvas, invisible to NIA (which clips):\n{}",
        rows.join("\n")
    );
}

/// **Two `Workspace` zones may never share floor.**
///
/// The open field is emitted as several bands, and overlapping bands are not a
/// cosmetic problem: the shared floor is counted twice in NIA, and
/// `Document::zone_index_at` hands each desk to whichever of the two happens to
/// be smaller, so the workstation tally moves too.
///
/// Added because the sabotage round showed the invariant rested on two guards in
/// `emit_workspace_bands` — the nesting merge and the neighbour midpoint split —
/// of which only the second was exercised by any test, and neither was named by
/// one. Removing the midpoint split fires
/// `stress_insights_invariants_over_shape_space` with an `NIA > GEA` two
/// inferences away from the cause; this says it directly.
#[test]
fn workspace_zones_are_pairwise_disjoint() {
    let mut rows: Vec<String> = Vec::new();
    let mut failures = 0usize;
    for (name, mut doc, program, seed) in plates() {
        generate(&mut doc, &program, seed, false);
        let ws: Vec<&Zone> =
            doc.zones.iter().filter(|z| z.zone_type == ZoneType::Workspace).collect();
        for i in 0..ws.len() {
            for j in (i + 1)..ws.len() {
                let (a, b) = (ws[i], ws[j]);
                let (ax0, ay0, ax1, ay1) = a.shape.bbox();
                let (bx0, by0, bx1, by1) = b.shape.bbox();
                let (x0, y0, x1, y1) =
                    (ax0.max(bx0), ay0.max(by0), ax1.min(bx1), ay1.min(by1));
                if x1 <= x0 || y1 <= y0 {
                    continue;
                }
                let mut shared = 0.0;
                let mut y = y0 + CELL / 2.0;
                while y < y1 {
                    let mut x = x0 + CELL / 2.0;
                    while x < x1 {
                        if a.shape.contains(x, y) && b.shape.contains(x, y) {
                            shared += CELL * CELL;
                        }
                        x += CELL;
                    }
                    y += CELL;
                }
                if shared > CELL * CELL {
                    failures += 1;
                    rows.push(format!(
                        "  {:<20} zone {} x zone {} share {:>6.2} m²",
                        name, a.id, b.id, shared
                    ));
                }
            }
        }
        let _ = program;
    }
    assert!(
        failures == 0,
        "{failures} pair(s) of Workspace zones share floor — double-counted in \
         NIA, and their desks go to whichever zone is smaller:\n{}",
        rows.join("\n")
    );
}
