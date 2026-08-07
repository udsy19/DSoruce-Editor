//! **The edited-plan invariant battery.**
//!
//! Everything here runs against `src/fixtures.rs` — the population that had no
//! tests, and therefore the population where the defect lived. `generate` is
//! covered ten cases deep by `golden_generate_output_is_frozen`; what was never
//! covered is the document a user has after touching it.
//!
//! Two kinds of assertion, deliberately:
//!
//! 1. **The repro.** `f3_plate_collapse_no_longer_eats_the_floor` names the exact
//!    state the reported defect came from, and would have caught it.
//! 2. **The invariants.** Properties that must hold for *any* document, checked
//!    over the fixtures and over ~1 200 randomized mutator sequences. These are
//!    written against the property, not against the fix — a gate calibrated on
//!    the fix can only ever confirm it (`.claude/rules/gate-independence.md`).

use crate::document::{Document, PlateResolution};
use crate::fixtures;
use crate::zone::{ZoneShape, ZoneType};
use crate::{compute_metrics, effective_zone_areas, net_internal_area};

/// Every fixture, built once, with its id for failure messages.
fn all_fixtures() -> Vec<(&'static str, Document)> {
    fixtures::FIXTURE_IDS
        .iter()
        .map(|&id| (id, fixtures::build(id).unwrap_or_else(|| panic!("fixture {id} builds"))))
        .collect()
}

// ---------------------------------------------------------------------------
// 1. The repro
// ---------------------------------------------------------------------------

/// **F3: the GEA collapse.** A user draws a small closed box while the plate's
/// own loop is open, and `trace_floor_polygon`'s largest-closed-loop rule locks
/// onto the box: a 930 m² floor reported ~1 m², NIA was clamped to it, and
/// `usable / nia` came out at 1159%.
///
/// The assertion is not "GEA is 930" — with the envelope broken we genuinely do
/// not know the floor, and inventing one is the defect wearing different clothes.
/// It is that **the 1.2 m² scratch loop is never mistaken for the building**, and
/// that the panel is told the plate is unresolved rather than handed a number.
#[test]
fn f3_plate_collapse_no_longer_eats_the_floor() {
    let doc = fixtures::build("F3").expect("F3 builds");

    // The state is what it claims to be: the walls still close SOMEWHERE (so
    // this is not just "open walls"), and the loop they close on is tiny.
    let segs: Vec<_> = doc.walls.iter().filter(|w| !w.generated).map(|w| (w.a, w.b)).collect();
    let faces = crate::geometry::trace_floor_faces(&segs, crate::geometry::LOOP_SNAP_TOL);
    assert!(!faces.is_empty(), "F3 must still contain a closed loop, or it is not this defect");
    let largest = crate::geometry::polygon_area(&faces[0]).abs();
    assert!(
        largest < 10.0,
        "F3's largest closed face should be the scratch box, got {largest:.2} m² — \
         the fixture no longer reproduces the state it was built for"
    );

    // The old rule would have taken that face. The new one refuses it.
    assert!(
        matches!(doc.plate_resolution(), PlateResolution::Unresolved),
        "F3 must report the plate as unresolved, got {}",
        doc.plate_resolution().tag()
    );
    let m = compute_metrics(&doc);
    assert_eq!(m.plate_state, "unresolved");
    assert!(
        m.gross_external_area > 100.0,
        "GEA fell back to {:.2} m² — a bounding box is a poor answer but a 1 m² \
         scratch loop is a wrong one",
        m.gross_external_area
    );
    assert!(
        m.efficiency_pct <= 100.0,
        "efficiency {:.1}% — this is the reported symptom",
        m.efficiency_pct
    );
    assert!(
        m.net_internal_area > 0.0 && m.net_internal_area <= m.gross_external_area,
        "NIA {:.2} against GEA {:.2}",
        m.net_internal_area,
        m.gross_external_area
    );
}

/// The second route into the same face-structure defect, and the one a user can
/// reach without any wall deletion: **commit a CAD line that snaps across the
/// plate.** The envelope's face is split into two, each holding about half the
/// plan, and largest-wins silently reports half the floor as the whole.
#[test]
fn a_wall_drawn_across_the_plate_cannot_halve_the_floor() {
    let mut doc = fixtures::build("F1").expect("F1 builds");
    let before = compute_metrics(&doc).gross_external_area;

    // Draw a wall between two EXISTING plate nodes, which is what snapping does.
    // Pick the pair that most nearly bisects the plate: the boundary's first
    // vertex and the one halfway round it.
    let b = fixtures::plate_boundary();
    let (a, c) = (b[0], b[b.len() / 2]);
    let id = doc.alloc_id();
    doc.walls.push(crate::model::Wall {
        id,
        a,
        b: c,
        thickness: 0.1,
        generated: false,
        glazing: false,
        height_m: None,
    });

    let after = compute_metrics(&doc);
    assert!(
        after.gross_external_area > before * 0.8,
        "one drawn wall took GEA from {before:.1} m² to {:.1} m² — the plate face \
         was split and the larger half was reported as the building",
        after.gross_external_area
    );
    assert!(after.efficiency_pct <= 100.0);
}

/// The containment threshold is a gap, not a tuned parameter — so say what the
/// gap actually measures on a real plan. This test is the provenance for the
/// number quoted in `PLATE_CONTAINMENT`'s doc comment; if the plan changes, the
/// comment is re-derived from here rather than from memory.
#[test]
fn plate_containment_on_a_real_plan_is_not_near_the_threshold() {
    let doc = fixtures::build("F1").expect("F1 builds");
    let segs: Vec<_> = doc.walls.iter().filter(|w| !w.generated).map(|w| (w.a, w.b)).collect();
    let faces = crate::geometry::trace_floor_faces(&segs, crate::geometry::LOOP_SNAP_TOL);
    assert!(!faces.is_empty());
    let anchors = doc.plan_anchors_for_test();
    let inside = anchors
        .iter()
        .filter(|p| crate::geometry::point_in_polygon(p.x, p.y, &faces[0]))
        .count();
    let frac = inside as f64 / anchors.len() as f64;
    println!("PLATE CONTAINMENT F1: {inside}/{} = {frac:.4}", anchors.len());
    assert!(
        frac > 0.97,
        "a real plan's own envelope contains {frac:.3} of it — if this is drifting \
         toward 0.9 the threshold has stopped being a gap and become a tuning knob"
    );
}

// ---------------------------------------------------------------------------
// 2. The invariants
// ---------------------------------------------------------------------------

/// The properties that make a metric a metric. Returns the first violation as a
/// message, so callers can name the case that produced it.
fn violations(doc: &Document) -> Vec<String> {
    let m = compute_metrics(doc);
    let mut v = Vec::new();
    let finite = |name: &str, x: f64, out: &mut Vec<String>| {
        if !x.is_finite() {
            out.push(format!("{name} is {x}"));
        } else if x < 0.0 {
            out.push(format!("{name} is negative ({x})"));
        }
    };
    finite("floor_area", m.floor_area, &mut v);
    finite("gross_external_area", m.gross_external_area, &mut v);
    finite("net_internal_area", m.net_internal_area, &mut v);
    finite("area_per_workstation", m.area_per_workstation, &mut v);
    finite("efficiency_pct", m.efficiency_pct, &mut v);
    finite("unassigned_area", m.unassigned_area, &mut v);
    finite("unassigned_pct", m.unassigned_pct, &mut v);

    if m.efficiency_pct > 100.0 + 1e-6 {
        v.push(format!("efficiency {:.3}% exceeds 100", m.efficiency_pct));
    }
    // NIA ≤ GEA only when GEA is a measurement. Under `open`/`unresolved` the
    // gross figure is a bounding box and the relation carries no meaning — the
    // plate_state field is the assertion in that case.
    if m.plate_state == "traced" && m.net_internal_area > m.gross_external_area + 1e-6 {
        v.push(format!(
            "NIA {:.3} exceeds a TRACED GEA {:.3}",
            m.net_internal_area, m.gross_external_area
        ));
    }
    // A plan with seats must be able to say how much floor each one gets. This
    // is the "Area/WS 0.0 m²" row from the screenshots.
    if m.workstations > 0 && m.area_per_workstation <= 0.0 {
        v.push(format!(
            "{} workstations but area_per_workstation is {}",
            m.workstations, m.area_per_workstation
        ));
    }
    // The panel branches on this string; an unknown value would fall through
    // every branch and render blank.
    if !matches!(m.plate_state, "traced" | "open" | "unresolved") {
        v.push(format!("unknown plate_state {:?}", m.plate_state));
    }
    // The two NIA readers must agree, always. This is the pair that diverged.
    //
    // RE-DERIVED FROM THE PANEL'S OWN ARTIFACT, not from the owner function.
    // The first version of this check compared `compute_metrics` against
    // `net_internal_area` — two calls to the same function — and the sabotage
    // round proved it: putting the second owner back into `zone_rows` left the
    // whole suite green. A check that cannot see the divergence it is named for
    // is not conservative, it is absent. `pct_of_nia` is `area / nia`, so the
    // Zones tab's own rows carry the NIA they were computed against, and
    // inverting one row recovers it without asking the core which number it used.
    let (areas, _) = effective_zone_areas(doc);
    let owner = net_internal_area(doc, &areas);
    if (owner - m.net_internal_area).abs() > 1e-9 {
        v.push(format!(
            "two NIA values: metrics {:.6} vs owner {:.6}",
            m.net_internal_area, owner
        ));
    }
    let rows = crate::Editor::for_test(doc.clone()).zone_rows_for_test(false);
    if let Some(row) = rows.iter().find(|r| r.pct_of_nia > 1e-9 && r.area > 1e-9) {
        let rows_nia = row.area / row.pct_of_nia * 100.0;
        if (rows_nia - m.net_internal_area).abs() > 1e-6 * rows_nia.max(1.0) {
            v.push(format!(
                "the Zones tab and the metrics panel disagree about NIA: \
                 rows say {rows_nia:.3}, metrics says {:.3}",
                m.net_internal_area
            ));
        }
    }
    v
}

/// **The conditional clamp, guarded directly — because the sabotage round found
/// it unguarded.**
///
/// Reverting `net_internal_area` to clamp unconditionally (as the pre-fix
/// `metrics()` did) left the entire battery green. The reason is benign: once
/// plate selection is fixed, an unresolved plate falls back to the wall bounding
/// box, which dominates every face inside it, so the clamp is inert on every
/// state the fixtures and the random battery reach. Inert is not guarded, and a
/// null result is the most useful thing a sabotage round produces.
///
/// So this asserts the *semantics* rather than waiting for a symptom: when the
/// plate is not a measurement, NIA is the zones' own sum and nothing caps it.
/// The document below makes the difference load-bearing — the walls are reduced
/// to one small stub in a corner, so the bounding box is a few m² while the plan
/// it once held is still hundreds.
#[test]
fn nia_is_never_capped_by_a_plate_we_do_not_trust() {
    let mut doc = fixtures::build("F1").expect("F1 builds");
    let stub = doc
        .walls
        .iter()
        .find(|w| !w.generated)
        .cloned()
        .expect("plate walls exist");
    doc.walls.retain(|w| w.generated);
    let a = stub.a;
    doc.walls.push(crate::model::Wall {
        b: crate::geometry::Point::new(a.x + 2.0, a.y),
        a,
        ..stub
    });

    let bbox_area = compute_metrics(&doc).gross_external_area;
    let (areas, _) = effective_zone_areas(&doc);
    let sum: f64 = areas.iter().sum();
    assert!(
        sum > bbox_area * 10.0,
        "this case is only load-bearing while the zone sum ({sum:.1}) dwarfs the \
         bbox fallback ({bbox_area:.1}) — otherwise the clamp is inert and the \
         test proves nothing"
    );
    let m = compute_metrics(&doc);
    assert_ne!(m.plate_state, "traced");
    assert!(
        (m.net_internal_area - sum).abs() < 1e-6,
        "NIA {:.3} was capped by an untrusted plate figure of {bbox_area:.3}; \
         it must be the zones' own sum {sum:.3}",
        m.net_internal_area
    );
    assert!(m.efficiency_pct <= 100.0);
}

#[test]
fn every_fixture_reports_possible_metrics() {
    for (id, doc) in all_fixtures() {
        let v = violations(&doc);
        assert!(v.is_empty(), "fixture {id}: {v:?}");
    }
}

/// The fixtures are frozen artifacts: if one stops being the state it was built
/// to be, every assertion above becomes vacuous while still passing. Pin the
/// shape of each, not its every number.
#[test]
fn fixtures_are_the_states_they_claim_to_be() {
    let f1 = fixtures::build("F1").unwrap();
    assert!(f1.zones.len() >= 5, "F1 should be a generated plan, {} zones", f1.zones.len());
    assert!(f1.components.len() >= 50, "F1 components: {}", f1.components.len());
    assert_eq!(compute_metrics(&f1).plate_state, "traced", "F1's plate must resolve");

    let f2 = fixtures::build("F2").unwrap();
    assert_eq!(
        f2.walls.len(),
        f1.walls.len() + 4,
        "F2 adds exactly the drawn box's four walls"
    );
    assert_eq!(compute_metrics(&f2).plate_state, "traced", "F2's envelope is intact");
    let (a1, a2) = (compute_metrics(&f1).gross_external_area, compute_metrics(&f2).gross_external_area);
    assert!(
        (a1 - a2).abs() < 1e-6,
        "drawing a box inside the plate must not change the floor: {a1:.3} vs {a2:.3}"
    );

    let f3 = fixtures::build("F3").unwrap();
    assert_eq!(f3.walls.len(), f2.walls.len() - 1, "F3 removes one plate wall");

    let f4 = fixtures::build("F4").unwrap();
    assert!(
        f4.zones.iter().any(|z| z.zone_type == ZoneType::Circulation),
        "F4 reassigns a room to Circulation"
    );
    assert_eq!(f4.zones.len(), f1.zones.len(), "F4 reassigns, it does not add or drop");

    let f5 = fixtures::build("F5").unwrap();
    assert!(f5.zones.len() < f1.zones.len(), "F5 deletes a zone");
    assert!(f5.walls.len() > f1.walls.len(), "F5 draws walls");
}

// ---------------------------------------------------------------------------
// 3. The randomized battery
// ---------------------------------------------------------------------------

/// The repo's own PRNG convention (`layout::seed`) rather than a new dependency:
/// a seeded xorshift, so a failure names a seed that reproduces it exactly.
struct Rng(u64);
impl Rng {
    fn next_u64(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.0 = x;
        x
    }
    fn below(&mut self, n: usize) -> usize {
        (self.next_u64() % n as u64) as usize
    }
    fn unit(&mut self) -> f64 {
        (self.next_u64() >> 11) as f64 / (1u64 << 53) as f64
    }
    fn range(&mut self, lo: f64, hi: f64) -> f64 {
        lo + (hi - lo) * self.unit()
    }
}

/// Apply one random mutation of the kind the UI can produce.
fn mutate(doc: &mut Document, rng: &mut Rng) {
    match rng.below(8) {
        0 => {
            // draw a closed loop somewhere in the plate's bbox
            if let Some((x0, y0, x1, y1)) = doc.wall_bbox() {
                let cx = rng.range(x0, x1);
                let cy = rng.range(y0, y1);
                let (w, h) = (rng.range(0.4, 6.0), rng.range(0.4, 6.0));
                let corners = [
                    crate::geometry::Point::new(cx - w / 2.0, cy - h / 2.0),
                    crate::geometry::Point::new(cx + w / 2.0, cy - h / 2.0),
                    crate::geometry::Point::new(cx + w / 2.0, cy + h / 2.0),
                    crate::geometry::Point::new(cx - w / 2.0, cy + h / 2.0),
                ];
                for i in 0..4 {
                    let id = doc.alloc_id();
                    doc.walls.push(crate::model::Wall {
                        id,
                        a: corners[i],
                        b: corners[(i + 1) % 4],
                        thickness: 0.1,
                        generated: false,
                        glazing: false,
                        height_m: None,
                    });
                }
            }
        }
        1 => {
            // delete a user wall — including, sometimes, a plate wall
            let user: Vec<u32> = doc.walls.iter().filter(|w| !w.generated).map(|w| w.id).collect();
            if !user.is_empty() {
                let victim = user[rng.below(user.len())];
                doc.walls.retain(|w| w.id != victim);
            }
        }
        2 => {
            // resize a zone, sometimes absurdly
            let rects: Vec<(u32, f64, f64, f64, f64)> = doc
                .zones
                .iter()
                .filter_map(|z| match z.shape {
                    ZoneShape::Rect { x, y, w, h } => Some((z.id, x, y, w, h)),
                    _ => None,
                })
                .collect();
            if !rects.is_empty() {
                let (id, x, y, w, h) = rects[rng.below(rects.len())];
                let k = rng.range(0.05, 4.0);
                let _ = doc.resize_zone(id, ZoneShape::Rect { x, y, w: w * k, h: h * k });
            }
        }
        3 => {
            // reassign a zone's type, across the ground boundary as often as not
            let ids: Vec<u32> = doc.zones.iter().map(|z| z.id).collect();
            if !ids.is_empty() {
                const TYPES: [ZoneType; 6] = [
                    ZoneType::Workspace,
                    ZoneType::Meeting,
                    ZoneType::Circulation,
                    ZoneType::Core,
                    ZoneType::Unassigned,
                    ZoneType::Amenity,
                ];
                let id = ids[rng.below(ids.len())];
                let _ = doc.set_zone_type(id, TYPES[rng.below(TYPES.len())]);
            }
        }
        4 => {
            let ids: Vec<u32> = doc.zones.iter().map(|z| z.id).collect();
            if !ids.is_empty() {
                let _ = doc.delete_zone(ids[rng.below(ids.len())]);
            }
        }
        5 => {
            let ids: Vec<u32> = doc.zones.iter().map(|z| z.id).collect();
            if ids.len() >= 2 {
                let a = ids[rng.below(ids.len())];
                let b = ids[rng.below(ids.len())];
                let _ = doc.merge_zones(a, b);
            }
        }
        6 => {
            // move a component, sometimes clean off the plate
            if !doc.components.is_empty() {
                let i = rng.below(doc.components.len());
                let (dx, dy) = (rng.range(-30.0, 30.0), rng.range(-30.0, 30.0));
                doc.components[i].x += dx;
                doc.components[i].y += dy;
                doc.reassign_components();
            }
        }
        _ => {
            if !doc.components.is_empty() {
                let i = rng.below(doc.components.len());
                doc.components.remove(i);
                doc.reassign_components();
            }
        }
    }
}

/// **No sequence of edits may produce an impossible metric.**
///
/// 120 seeds × 10 mutations from each of the five fixtures = 6 000 mutations and
/// 1 200 metric evaluations, all deterministic. The point is not coverage of
/// every sequence — it is that the invariants are stated over the *class* of
/// edited documents rather than over the five states somebody thought of.
#[test]
fn metrics_can_never_be_impossible() {
    let bases = all_fixtures();
    let mut cases = 0usize;
    for seed in 1u64..=120 {
        let (id, base) = &bases[(seed as usize - 1) % bases.len()];
        let mut doc = base.clone();
        let mut rng = Rng(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1);
        for step in 0..10 {
            mutate(&mut doc, &mut rng);
            let v = violations(&doc);
            cases += 1;
            assert!(
                v.is_empty(),
                "seed {seed} from {id}, after {} mutation(s): {v:?}",
                step + 1
            );
        }
    }
    assert_eq!(cases, 1200, "the battery must actually run");
}

/// Non-vacuity: the battery is only worth anything if these mutations really do
/// reach the states the invariants are about. Assert the population is varied —
/// a battery that only ever sees `traced` plates would pass with the collapse
/// still live.
#[test]
fn the_randomized_battery_reaches_broken_plates() {
    let bases = all_fixtures();
    let mut seen: std::collections::BTreeMap<&'static str, usize> = Default::default();
    for seed in 1u64..=120 {
        let (_, base) = &bases[(seed as usize - 1) % bases.len()];
        let mut doc = base.clone();
        let mut rng = Rng(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1);
        for _ in 0..10 {
            mutate(&mut doc, &mut rng);
            *seen.entry(doc.plate_resolution().tag()).or_default() += 1;
        }
    }
    println!("PLATE STATES REACHED: {seen:?}");
    for tag in ["traced", "unresolved"] {
        assert!(
            seen.get(tag).copied().unwrap_or(0) > 0,
            "the battery never reached a {tag:?} plate — it is not exercising the \
             defect class it exists for. Reached: {seen:?}"
        );
    }
}

// ---------------------------------------------------------------------------
// 4. The generator's own accounting (Q3-F)
// ---------------------------------------------------------------------------

/// **No region is allocated desks it cannot seat.**
///
/// This is F1a's acceptance criterion, stated as an invariant rather than as a
/// number. The defect it forbids: two wings on the sample plate were allocated
/// 7 desks between them and placed 0, because capacity was computed by dividing
/// an empty field rect by the desk pitch while placement was computed against
/// the rooms already standing in that field.
///
/// It is checked over every fixture, so it covers the edited population too.
#[test]
fn no_region_is_allocated_desks_it_cannot_seat() {
    for id in fixtures::FIXTURE_IDS {
        let diag = fixtures::diag_for(id).expect("fixture builds");
        // Non-vacuity: a diag with no regions would pass this trivially.
        assert!(
            !diag.region_desks.is_empty(),
            "{id}: no regions recorded — the instrument is the finding"
        );
        for (i, r) in diag.region_desks.iter().enumerate() {
            assert!(
                !(r.allocated > 0 && r.placed == 0),
                "{id} R{i}: allocated {} desks and placed none \
                 (grid {}x{}, depth {:.2} m, rejects b{} p{} w{} o{})",
                r.allocated,
                r.grid_outer,
                r.grid_inner,
                r.field_depth,
                r.rejects.bounds,
                r.rejects.plate,
                r.rejects.walls,
                r.rejects.obstacles,
            );
            // A region that seats nothing is either a DECLARED room wing or has
            // no viable field at all. What it may never be is an undeclared
            // failure — that is the state F1a exists to make impossible.
            if r.allocated == 0 && !r.room_wing {
                assert!(
                    r.grid_outer == 0 || r.grid_inner == 0 || r.field_depth < 3.0,
                    "{id} R{i}: seats nothing, is not a declared room wing, and has a \
                     {:.2} m field with a {}x{} grid — an undeclared failure",
                    r.field_depth,
                    r.grid_outer,
                    r.grid_inner,
                );
            }
        }
    }
}

/// The capacity function and the packer must agree. `field_free_slots` counting
/// a slot the packer then rejects is an over-allocation — the exact defect F1a
/// fixed, reintroduced from the other side.
///
/// **SCOPE, stated because it was the whole defect.** All five fixtures descend
/// from ONE 930 m² plate, on which the desk field is over-subscribed
/// (programme < capacity in every region), so capacity never binds and this
/// assertion cannot fail here however wrong the two halves are. It is a
/// regression check over the EDITED fixture population, nothing more. The guard
/// that actually measures the invariant is
/// `layout::tests::desk_capacity_agrees_with_the_packer_across_plates_and_seeds`,
/// which varies plate shape, seed, bench pairing and cluster rhythm.
///
/// The assertion is the STRONG form. It used to read
/// `placed >= min(allocated, placed + rejects)`, which is satisfied by any
/// shortfall whose rejection count is zero — a floor with no ceiling.
#[test]
fn desk_capacity_never_exceeds_what_the_packer_places() {
    for id in fixtures::FIXTURE_IDS {
        let diag = fixtures::diag_for(id).expect("fixture builds");
        for (i, r) in diag.region_desks.iter().enumerate() {
            assert!(
                r.placed >= r.allocated,
                "{id} R{i}: allocated {} but placed {} (capacity {}, packer grid {}, \
                 rejects b{} p{} w{} o{}) — capacity and the packer disagree",
                r.allocated,
                r.placed,
                r.capacity,
                r.pack_capacity,
                r.rejects.bounds,
                r.rejects.plate,
                r.rejects.walls,
                r.rejects.obstacles,
            );
        }
    }
}
