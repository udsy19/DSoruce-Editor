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
use crate::{compute_metrics, net_internal_area, raw_zone_areas_unscaled};

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

/// **M4: seven anchors is a real plan, and the count gate let it through.**
///
/// A 40 × 30 envelope with one wall deleted, plus a 1.2 × 1.0 m scratch box, two
/// zones and five components — 7 anchors, one under the old `MIN_PLAN_ANCHORS`
/// of 8. The containment check was skipped entirely and largest-loop-wins
/// returned the scratch box: `plate_state "traced" · GEA 1.20 m²` for a 1200 m²
/// building, `Open Workspace 1.2 m² / 80 pax`. A 1000× under-report labelled as
/// a measurement.
///
/// **R10 AXES — this guard's falsification varies:** anchor COUNT (7 here, 254 on
/// F1, 0 in the wizard case below) and face STRUCTURE (a spurious small loop
/// present vs. a sound envelope). Both must be varied: a count-only falsification
/// is what shipped the hole, and a structure-only one would not have found it.
#[test]
fn a_seven_anchor_plan_cannot_certify_a_scratch_box_as_the_floor() {
    let mut doc = Document::new();
    let mut wall = |ax: f64, ay: f64, bx: f64, by: f64| {
        let id = doc_alloc(&mut doc);
        doc.walls.push(crate::model::Wall {
            id,
            a: crate::geometry::Point::new(ax, ay),
            b: crate::geometry::Point::new(bx, by),
            thickness: 0.2,
            generated: false,
            glazing: false,
            height_m: None,
        });
    };
    // Envelope, SOUTH-WEST side deleted — three of four runs.
    wall(0.0, 0.0, 40.0, 0.0);
    wall(40.0, 0.0, 40.0, 30.0);
    wall(40.0, 30.0, 0.0, 30.0);
    // The scratch box: the only closed face in the network.
    wall(5.0, 5.0, 6.2, 5.0);
    wall(6.2, 5.0, 6.2, 6.0);
    wall(6.2, 6.0, 5.0, 6.0);
    wall(5.0, 6.0, 5.0, 5.0);

    doc.add_zone(
        ZoneType::Workspace,
        ZoneShape::Rect { x: 20.0, y: 10.0, w: 30.0, h: 16.0 },
        "Open Workspace".into(),
    )
    .expect("on-plate");
    doc.add_zone(
        ZoneType::Meeting,
        ZoneShape::Rect { x: 30.0, y: 24.0, w: 8.0, h: 6.0 },
        "Boardroom".into(),
    )
    .expect("on-plate");
    for i in 0..5 {
        let id = doc_alloc(&mut doc);
        doc.components.push(crate::model::Component {
            id,
            category: "Desk".into(),
            x: 10.0 + i as f64 * 2.0,
            y: 10.0,
            w: 1.4,
            h: 0.7,
            rotation: 0.0,
            mirror: false,
            reference: false,
            seats: 1,
            label: format!("Desk {id}"),
            product_id: None,
            price_inr: None,
            decision: crate::model::DecisionState::Open,
        });
    }

    // The state is what it claims to be, or the test proves nothing.
    let anchors = doc.plan_anchors_for_test().len();
    assert_eq!(anchors, 7, "the case is 7 anchors — one under the retired gate");
    let segs: Vec<_> = doc.walls.iter().filter(|w| !w.generated).map(|w| (w.a, w.b)).collect();
    let faces = crate::geometry::trace_floor_faces(&segs, crate::geometry::LOOP_SNAP_TOL);
    assert!(!faces.is_empty(), "the scratch box must still close, or this is just 'open walls'");
    let largest = crate::geometry::polygon_area(&faces[0]).abs();
    assert!(largest < 10.0, "the largest face should be the 1.2 m² box, got {largest:.2}");

    let m = compute_metrics(&doc);
    println!("M4 REPRO: {anchors} anchors, plate {} GEA {:.3}", m.plate_state, m.gross_external_area);
    assert_eq!(
        m.plate_state, "unresolved",
        "a 1.2 m² scratch loop was certified as a 1200 m² building's floor"
    );
    assert!(
        m.gross_external_area > 100.0,
        "GEA {:.3} m² — the bbox fallback is a poor answer, the scratch box is a wrong one",
        m.gross_external_area
    );
}

/// The other side of the same threshold, and the reason it must be a FRACTION
/// rather than a count: a plan with plenty of anchors and a spurious loop must
/// also refuse. Anchor count is high (254 on F1's descendant) and the structure
/// is the same — so if this passed while the case above failed, the rule would
/// still be reading the count.
#[test]
fn a_high_anchor_plan_with_a_spurious_loop_also_refuses() {
    let doc = fixtures::build("F3").expect("F3 builds");
    let anchors = doc.plan_anchors_for_test().len();
    assert!(anchors > 100, "F3 must be a full plan, {anchors} anchors");
    assert_eq!(compute_metrics(&doc).plate_state, "unresolved");
}

/// **The zero-anchor wizard case, which is why the count gate existed at all.**
///
/// A plate confirmed in the wizard has no zones and no components. The retired
/// `MIN_PLAN_ANCHORS` branch existed for exactly this, and the fraction covers it
/// with no special case: `0 >= PLATE_CONTAINMENT * 0` holds, so the largest face
/// is accepted and behaviour is unchanged. Pinned, because deleting the branch
/// that names a case is how the case stops being tested.
#[test]
fn a_freshly_imported_plate_with_no_plan_still_traces() {
    let mut doc = Document::new();
    let corners = [(0.0, 0.0), (40.0, 0.0), (40.0, 30.0), (0.0, 30.0)];
    for i in 0..4 {
        let id = doc_alloc(&mut doc);
        let (ax, ay) = corners[i];
        let (bx, by) = corners[(i + 1) % 4];
        doc.walls.push(crate::model::Wall {
            id,
            a: crate::geometry::Point::new(ax, ay),
            b: crate::geometry::Point::new(bx, by),
            thickness: 0.2,
            generated: false,
            glazing: false,
            height_m: None,
        });
    }
    assert!(doc.plan_anchors_for_test().is_empty(), "the wizard case has no plan yet");
    let m = compute_metrics(&doc);
    assert_eq!(m.plate_state, "traced", "an imported plate with no plan must still trace");
    assert!((m.gross_external_area - 1200.0).abs() < 1.0, "GEA {:.3}", m.gross_external_area);
}

fn doc_alloc(doc: &mut Document) -> u32 {
    doc.alloc_id()
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
    // **A capped metric must say it was capped.**
    //
    // `efficiency_pct` is now clamped at the source, so the M1 symptom can never
    // again surface as a NUMBER — which is exactly what would make an unreported
    // cap invisible to every assertion above. Re-derived from the UNCLAMPED
    // areas, so this asks the document, not the metric, whether a cap happened.
    let (areas, _) = raw_zone_areas_unscaled(doc);
    let raw_sum: f64 = areas.iter().sum();
    let owner = net_internal_area(doc, &areas);
    if raw_sum > owner + 1e-6 && m.metrics_error.is_none() {
        v.push(format!(
            "the basis was capped ({raw_sum:.3} → {owner:.3}) and metrics_error is null"
        ));
    }
    if (owner - m.net_internal_area).abs() > 1e-9 {
        v.push(format!(
            "two NIA values: metrics {:.6} vs owner {:.6}",
            m.net_internal_area, owner
        ));
    }
    // THE ZONES TAB'S ROWS MUST SUM TO NIA. Asserted directly, because the
    // inversion this replaces could not fail.
    //
    // The previous form recovered NIA as `row.area / row.pct_of_nia * 100`. But
    // `pct_of_nia := row.area / nia * 100`, so that expression is **identically
    // `nia` for any areas vector whatsoever** — a value compared against itself,
    // wearing a comment that claimed the opposite ("re-derived from the panel's
    // own artifact"). Restoring the second NIA owner in `zone_rows` left the
    // whole suite at 194 green while the Zones tab billed
    // `Σ row.area 1035.791` against `NIA 930.063` — slices summing to **111.37%
    // of their own donut**. Multiplying every row area by 3.0 also stayed green.
    //
    // RETRACTED BY NAME: the VERIFIER entry claimed this check had been rewritten
    // to close exactly that sabotage. It reproduced the property it replaced. The
    // sum is the property; the inversion was never anything else.
    //
    // R10 AXES — this guard's falsification varies: the AREAS VECTOR (a second
    // owner in `zone_rows`; every row scaled), the CAP (a document whose raw sum
    // exceeds a traced floor), and the PLATE STATE (traced / open / unresolved,
    // which decides whether the cap applies at all).
    let rows = crate::Editor::for_test(doc.clone()).zone_rows_for_test(false);
    // **The producer no longer chooses whether it is checked.** This was
    // `if !rows.is_empty()`, which handed `zone_rows` a veto over its own test:
    // returning nothing — the Zones tab rendering an empty donut — left the whole
    // suite at 195 green. *A missing input is a FAILURE, never a skip.* The
    // expected count is re-derived from the document, not from the producer.
    if rows.len() != doc.zones.len() {
        v.push(format!(
            "zone_rows delivered {} rows for a document with {} zones",
            rows.len(),
            doc.zones.len()
        ));
    }
    let row_sum: f64 = rows.iter().map(|r| r.area).sum();
    if (row_sum - m.net_internal_area).abs() > 1e-6 * row_sum.max(1.0) {
        v.push(format!(
            "the Zones tab's rows sum to {row_sum:.3} but NIA is {:.3} — the \
             donut's slices do not sum to its own total",
            m.net_internal_area
        ));
    }

    // ---- THE VECTOR INVARIANTS. The sum is a scalar; the property is a vector.
    //
    // Everything above this line applies its finite/non-negative predicate to
    // seven AGGREGATE metrics and to zero per-row values, and a sum is preserved
    // by any compensating pair. Injecting +300 into one row and −300 into another
    // left 195 green while F1 billed `Meeting Room 2  area -283.600  pct -31.518`
    // — a negative donut slice, on a published surface, under a green board.
    for r in &rows {
        finite(&format!("zone row {} area", r.id), r.area, &mut v);
        finite(&format!("zone row {} pct_of_nia", r.id), r.pct_of_nia, &mut v);
    }

    // **ONE BASIS, ONE FACTOR — asserted per row, not per total.**
    //
    // `area_basis` scales the WHOLE vector by the single factor `k = nia / Σraw`,
    // which is the property its doc comment claims ("every subset metric carries
    // the SAME factor"). A total cannot see a violation of that: moving 100 m²
    // from the largest non-usable zone to the largest usable one inside the
    // shared basis preserves Σ exactly, keeps every row non-negative, keeps
    // `metrics_error` null — and takes efficiency 72.763% → 83.876%, +11.1 pts.
    // That is M1's own family (a numerator and a denominator disagreeing about
    // one floor) and every rebuilt guard stayed green through it.
    //
    // R2: the expected vector is re-derived from the DOCUMENT's geometry via
    // `raw_zone_areas_unscaled`, not read back out of the basis the rows came
    // from, so a per-zone transform applied anywhere between the geometry and the
    // row is visible as a row whose ratio is not k. The condition mirrors
    // `area_basis`'s own cap condition; in the boundary region both branches give
    // k ≈ 1 and the tolerance covers the difference.
    let k = if raw_sum > 1e-9 && owner < raw_sum - 1e-6 { owner / raw_sum } else { 1.0 };
    for (i, r) in rows.iter().enumerate() {
        let want = areas[i] * k;
        if (r.area - want).abs() > 1e-6 * want.abs().max(1.0) {
            v.push(format!(
                "zone row {} area {:.3} is not its own de-overlapped footprint \
                 {:.3} × the one basis factor {k:.6} (= {want:.3}) — the basis \
                 carries a per-zone transform, not one shared cap",
                r.id, r.area, areas[i]
            ));
        }
    }

    // ---- CROSS-SURFACE: the panel and the takeoff are the same numbers. ------
    //
    // R15. `quantities()` is a PUBLISHED surface — the workbook's Room Schedule
    // (`web/src/export/qtoWorkbook.ts:272-295`), with finishes priced `unit:
    // 'm^2'` off these very rows — and it was outside the tested population
    // entirely: this 1 200-evaluation battery called `compute_metrics` and never
    // `quantities`. `quantity.rs`'s own `Σ room area ≤ plate` assertion would
    // have fired at 953.030 against a 930.063 floor; it had simply never run on
    // an edited document.
    //
    // RETRACTED BY NAME: `quantity.rs:187-188` ("the same number the Statistics
    // panel shows"), `quantity.rs:509-511` ("the ONE area definition … so the
    // takeoff can never disagree with what the user sees on screen") and
    // `reports/B1-1.md:132`. All three were TRUE when written. The M1 fix
    // introduced `area_basis`, moved the panel onto it, and left the takeoff on
    // the raw areas — so on the M1 state (retype every F4 zone to Workspace,
    // four clicks) the panel billed Σ 930.063 and the takeoff billed Σ 953.030,
    // 22.968 m² apart, all 24 rooms disagreeing, on a clean tree.
    //
    // R2: neither surface is asked what the other used. Both are read as
    // delivered artifacts and joined on the zone id — the document's own key.
    let rooms = crate::quantity::quantities(doc).rooms;
    // The FOLDED rows — what `Editor::zone_stats()` actually publishes to the
    // Zones tab. `rows` above is the unfolded truth; both are checked, because
    // the fold is where an attribution could change without any area moving.
    let pub_rows = crate::Editor::for_test(doc.clone()).zone_rows_for_test(true);
    if rooms.len() != doc.zones.len() {
        v.push(format!(
            "the takeoff delivered {} rooms for a document with {} zones",
            rooms.len(),
            doc.zones.len()
        ));
    }
    if rooms.len() == rows.len() {
        for (i, (r, q)) in rows.iter().zip(&rooms).enumerate() {
            if r.id != q.room_id {
                v.push(format!(
                    "panel row {} and takeoff room {} are not the same zone",
                    r.id, q.room_id
                ));
                continue;
            }
            if (r.area - q.area_m2).abs() > 1e-6 * r.area.abs().max(1.0) {
                v.push(format!(
                    "zone {}: the panel shows {:.3} m² and the takeoff bills \
                     {:.3} m² — two owners of one room's area",
                    r.id, r.area, q.area_m2
                ));
            }
            // ...and the takeoff is anchored to the DOCUMENT's geometry in its
            // own right, not merely to the panel. Otherwise the pair could agree
            // with each other while both drifted off the floor they describe —
            // the mutual-contamination shape the rules file names, where two
            // artifact-derived lists agree about the missing element.
            let want = areas[i] * k;
            if (q.area_m2 - want).abs() > 1e-6 * want.abs().max(1.0) {
                v.push(format!(
                    "the takeoff bills zone {} at {:.3} m², not its own \
                     de-overlapped footprint {:.3} × the one basis factor \
                     {k:.6} (= {want:.3})",
                    q.room_id, q.area_m2, areas[i]
                ));
            }
            // ---- The ATTRIBUTION facet, anchored to the document. ----
            //
            // Efficiency is `usable / nia`, so which side of that partition a
            // room lands on is worth 11 points on the headline. Checked as the
            // PREDICATE, not as the type name: the panel publishes FOLDED rows
            // (`Editor::zone_stats` → `zone_rows(true)`, Unassigned →
            // Circulation) and the takeoff publishes unfolded ones deliberately
            // (`space_type_label`: "Seeing 'Unassigned' in a delivered artifact
            // is the bug report"), so the two names legitimately differ while
            // the partition must not. Three-way against the document's own
            // `zone_type`, which neither surface owns.
            let doc_type = doc
                .zones
                .iter()
                .find(|z| z.id == q.room_id)
                .map(|z| z.zone_type);
            let Some(doc_type) = doc_type else {
                v.push(format!("takeoff bills room {} which is not a zone", q.room_id));
                continue;
            };
            let published = pub_rows.iter().find(|p| p.id == q.room_id);
            let seen = [
                ("the panel's raw row", Some(r.zone_type)),
                ("the panel's published row", published.map(|p| p.zone_type)),
                ("the takeoff", Some(q.zone_type)),
            ];
            for (who, t) in seen {
                match t {
                    None => v.push(format!("zone {} is missing from {who}", q.room_id)),
                    Some(t) if crate::is_usable_zone(t) != crate::is_usable_zone(doc_type) => v.push(format!(
                        "zone {}: the document types it {doc_type:?} ({}) and \
                         {who} bills it {t:?} ({}) — the usable/non-usable \
                         partition differs by surface",
                        q.room_id,
                        if crate::is_usable_zone(doc_type) { "usable" } else { "overhead" },
                        if crate::is_usable_zone(t) { "usable" } else { "overhead" },
                    )),
                    Some(_) => {}
                }
            }
        }
    }
    let room_sum: f64 = rooms.iter().map(|r| r.area_m2).sum();
    if (room_sum - row_sum).abs() > 1e-6 * row_sum.max(1.0) {
        v.push(format!(
            "the panel's rows sum to {row_sum:.3} m² and the takeoff's rooms sum \
             to {room_sum:.3} m² — a {:.3} m² divergence between two published \
             surfaces over the same document",
            (room_sum - row_sum).abs()
        ));
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
    let (areas, _) = raw_zone_areas_unscaled(&doc);
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

/// The zone types the battery reassigns across. Named once because two step
/// classes draw from it — the one-zone retype and the retype-ALL below.
const TYPES: [ZoneType; 6] = [
    ZoneType::Workspace,
    ZoneType::Meeting,
    ZoneType::Circulation,
    ZoneType::Core,
    ZoneType::Unassigned,
    ZoneType::Amenity,
];

/// Apply one random mutation of the kind the UI can produce.
///
/// **R10 AXES — what this battery's falsification varies:** zone TYPE (one zone,
/// and — since M1 — ALL zones at once), zone COUNT (delete, merge, split),
/// zone SHAPE (resize, including absurd scale factors), zone OVERLAP (a new zone
/// laid over existing ones), wall TOPOLOGY (draw a closed loop, delete a plate
/// wall) and component POSITION/COUNT. An axis not listed here is an axis this
/// battery does not test.
///
/// **The axis this list was missing, and what it cost.** Step class 3 retypes
/// ONE zone per step, drawn from six types, over ten steps. The probability that
/// ten single retypes leave a fixture with every zone occupiable is effectively
/// zero — so "all zones usable" was unreachable **by construction**, and
/// `efficiency = usable / nia` at 102.469% (F4, retype every zone to Workspace —
/// four UI clicks) sat inside the battery's blind spot through 1 200 evaluations
/// per run. A guard's frame is part of the guard: this one was varying one axis
/// intensely and one axis not at all. Step classes 8 and 9 are that repair, and
/// `the_battery_reaches_an_all_usable_document` asserts they land.
fn mutate(doc: &mut Document, rng: &mut Rng) {
    match rng.below(10) {
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
        7 => {
            if !doc.components.is_empty() {
                let i = rng.below(doc.components.len());
                doc.components.remove(i);
                doc.reassign_components();
            }
        }
        8 => {
            // **RETYPE EVERY ZONE** — the step class the battery did not have.
            // Four clicks in the Zones tab, and the state that produced 102.469%.
            // Drawn from the same six types, so it also reaches "all Circulation"
            // (usable 0) and "all Unassigned", not only the usable extreme.
            let t = TYPES[rng.below(TYPES.len())];
            let ids: Vec<u32> = doc.zones.iter().map(|z| z.id).collect();
            for id in ids {
                let _ = doc.set_zone_type(id, t);
            }
        }
        _ => {
            // Add a zone that OVERLAPS what is already there — the second half of
            // M1. Retyping alone makes every zone usable; overlap is what makes
            // Σ areas exceed the floor, and the two together are the 648.4% case.
            // Centred on an existing zone so the overlap is certain, not lucky.
            if let Some((x0, y0, x1, y1)) = doc.wall_bbox() {
                let (cx, cy) = match doc.zones.get(rng.below(doc.zones.len().max(1))) {
                    Some(z) => {
                        let (bx0, by0, bx1, by1) = z.shape.bbox();
                        ((bx0 + bx1) / 2.0, (by0 + by1) / 2.0)
                    }
                    None => ((x0 + x1) / 2.0, (y0 + y1) / 2.0),
                };
                // Clamped into the wall bbox, because `add_zone` refuses an
                // off-plate shape (M3). The overlap is with SIBLING zones, which
                // is legal and is exactly the case under test.
                // `min` before `max`: a bbox narrower than the minimum size would
                // otherwise give `clamp` a lo above its hi, which panics — a
                // battery that aborts is not a battery.
                let w = rng.range(2.0, (x1 - x0).max(2.1)).min(x1 - x0);
                let h = rng.range(2.0, (y1 - y0).max(2.1)).min(y1 - y0);
                let cx = cx.max(x0 + w / 2.0).min(x1 - w / 2.0);
                let cy = cy.max(y0 + h / 2.0).min(y1 - h / 2.0);
                let t = TYPES[rng.below(TYPES.len())];
                let _ = doc.add_zone(
                    t,
                    ZoneShape::Rect { x: cx, y: cy, w, h },
                    "battery overlap".to_string(),
                );
            }
        }
    }
}

/// **The cross-surface check is not free: the battery reaches states where the
/// two area owners could disagree, and did.**
///
/// R15's non-vacuity. `violations` now evaluates `quantities()` — a published
/// surface (the workbook Room Schedule) that this battery never called, which is
/// the whole reason the divergence survived four belief passes. But panel == takeoff
/// is trivially true wherever the cap does not fire: `k == 1` and any two readers
/// of the same raw vector agree for free. So assert the population contains
/// CAPPED evaluations with real rooms in them — the states the two owners are
/// separable in — and print the count, because a battery that never reaches them
/// certifies nothing while staying green.
///
/// Deliberately **not** a re-run of `metrics_can_never_be_impossible`'s assertion:
/// that test says the property holds, this one says the property was tested.
#[test]
fn the_battery_reaches_states_the_two_area_surfaces_could_diverge_in() {
    let bases = all_fixtures();
    let (mut capped, mut evaluated, mut rooms_seen) = (0usize, 0usize, 0usize);
    for seed in 1u64..=120 {
        let (_, base) = &bases[(seed as usize - 1) % bases.len()];
        let mut doc = base.clone();
        let mut rng = Rng(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1);
        for _ in 0..10 {
            mutate(&mut doc, &mut rng);
            let (raw, _) = raw_zone_areas_unscaled(&doc);
            let raw_sum: f64 = raw.iter().sum();
            let nia = net_internal_area(&doc, &raw);
            let rooms = crate::quantity::quantities(&doc).rooms;
            evaluated += 1;
            rooms_seen += rooms.len();
            if raw_sum > nia + 1e-6 && !rooms.is_empty() {
                capped += 1;
            }
        }
    }
    println!(
        "TAKEOFF EVALUATIONS: {evaluated} · rooms billed {rooms_seen} · \
         CAPPED-AND-ROOMED (where panel ≠ takeoff was possible): {capped}"
    );
    assert_eq!(evaluated, 1200, "the battery must actually run");
    assert!(
        rooms_seen > 0,
        "the battery billed zero rooms across 1 200 evaluations — the takeoff is \
         in the loop but not in the population, and the cross-surface check is a \
         comparison of two empty lists"
    );
    assert!(
        capped > 0,
        "the battery never reached a document whose basis was capped WITH rooms \
         on it. Uncapped, k == 1 and the panel and the takeoff agree by reading \
         the same numbers — the check would pass with the divergence live, which \
         is exactly what happened for four belief passes"
    );
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

/// **The repro for M1, stated as the state rather than as the number.**
///
/// Retype every F4 zone to `Workspace` — four clicks in the Zones tab. Before the
/// fix: `GEA 930.063 · NIA 930.063 · eff 102.469% · traced`, with the raw zone sum
/// 953.030 against a floor of 930.063. `net_internal_area` clamped, `usable_area`
/// did not, and `usable / nia` divided a full sum by a clamped one.
///
/// Two assertions, because the fix has two halves: efficiency is possible, AND
/// the cap is REPORTED. A silently capped 100% would satisfy the first alone and
/// would be the same lie in a smaller font.
#[test]
fn retyping_every_zone_cannot_produce_an_impossible_efficiency() {
    let mut doc = fixtures::build("F4").expect("F4 builds");
    let ids: Vec<u32> = doc.zones.iter().map(|z| z.id).collect();
    assert!(ids.len() >= 5, "F4 must be a real plan, {} zones", ids.len());
    for id in ids {
        doc.set_zone_type(id, ZoneType::Workspace).expect("zone exists");
    }

    // Non-vacuity: this case only tests the clamp while the raw sum really does
    // exceed the traced floor. If de-overlap ever makes it tile exactly, the
    // assertion below passes for the wrong reason and this line says so.
    let (raw, _) = raw_zone_areas_unscaled(&doc);
    let sum: f64 = raw.iter().sum();
    let m = compute_metrics(&doc);
    assert_eq!(m.plate_state, "traced", "the F4 plate must still resolve");
    println!(
        "M1 REPRO: Σ zone areas {sum:.3} vs floor {:.3}, eff {:.3}%",
        m.gross_external_area, m.efficiency_pct
    );
    assert!(
        sum > m.gross_external_area + 1e-6,
        "the zone sum ({sum:.3}) no longer exceeds the floor ({:.3}) — this test \
         has stopped reproducing the state it exists for",
        m.gross_external_area
    );

    assert!(
        m.efficiency_pct <= 100.0 + 1e-6,
        "efficiency {:.3}% — M1, live again",
        m.efficiency_pct
    );
    let err = m
        .metrics_error
        .as_deref()
        .expect("a capped metric must report itself — that is the whole of the new policy");
    assert!(
        err.contains("do not tile"),
        "metrics_error must name the overlap, got {err:?}"
    );

    // **The M1 state, on the SECOND surface.** The fix above moved the panel onto
    // `area_basis` and left the workbook's Room Schedule on the raw vector, so
    // this very document — the one the test above certifies as fixed — billed
    // Σ 930.063 m² on screen and Σ 953.030 m² in the delivered workbook, 22.968 m²
    // (2.47%) apart, 24 of 24 rooms disagreeing. Printed, not just asserted: the
    // divergence is the number this test exists to keep at zero.
    let rows = crate::Editor::for_test(doc.clone()).zone_rows_for_test(false);
    let rooms = crate::quantity::quantities(&doc).rooms;
    let panel: f64 = rows.iter().map(|r| r.area).sum();
    let takeoff: f64 = rooms.iter().map(|r| r.area_m2).sum();
    let disagreeing = rows
        .iter()
        .zip(&rooms)
        .filter(|(r, q)| (r.area - q.area_m2).abs() > 1e-6 * r.area.abs().max(1.0))
        .count();
    println!(
        "M1 CROSS-SURFACE: panel Σ {panel:.3} · takeoff Σ {takeoff:.3} · \
         divergence {:.3} m² · {disagreeing}/{} rooms disagree",
        (takeoff - panel).abs(),
        rooms.len()
    );
    // Non-vacuity: a capped basis is what makes the two surfaces separable at
    // all. `k == 1` on an uncapped document and any pair of readers agrees.
    assert!(
        m.metrics_error.is_some() && sum > m.net_internal_area + 1e-6,
        "this case only separates the two area owners while the basis is CAPPED \
         (Σ raw {sum:.3} vs NIA {:.3}); uncapped, k == 1 and they agree for free",
        m.net_internal_area
    );
    let v = violations(&doc);
    assert!(v.is_empty(), "M1 state: {v:?}");
}

/// The battery is now allowed to REACH the state M1 lived in. Written as its own
/// test rather than as a comment, because "the retype-all class exists" and "the
/// retype-all class lands on a document with no unusable zone left" are different
/// claims, and only the second one is the axis.
#[test]
fn the_battery_reaches_an_all_usable_document() {
    let bases = all_fixtures();
    let mut all_usable = 0usize;
    let mut overflowing = 0usize;
    for seed in 1u64..=120 {
        let (_, base) = &bases[(seed as usize - 1) % bases.len()];
        let mut doc = base.clone();
        let mut rng = Rng(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1);
        for _ in 0..10 {
            mutate(&mut doc, &mut rng);
            if !doc.zones.is_empty()
                && doc.zones.iter().all(|z| {
                    crate::is_usable_zone(z.zone_type)
                })
            {
                all_usable += 1;
            }
            if compute_metrics(&doc).metrics_error.is_some() {
                overflowing += 1;
            }
        }
    }
    println!("ALL-USABLE STATES REACHED: {all_usable} · CAPPED-BASIS STATES: {overflowing}");
    assert!(
        all_usable > 0,
        "the battery never reached a document whose every zone is occupiable — \
         that is the exact state `usable / nia` could exceed 100% in, and it was \
         unreachable by construction while `mutate` retyped one zone at a time"
    );
    assert!(
        overflowing > 0,
        "the battery never reached a document whose zones overlap past the floor, \
         so the clamp it exercises is inert and proves nothing"
    );
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
