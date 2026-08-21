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
/// own loop is open, and the retired largest-closed-loop rule locks onto the
/// box: a 930 m² floor reported ~1 m², NIA was clamped to it, and
/// `usable / nia` came out at 1159%. (That rule was `geometry::trace_floor_
/// polygon`; it is now deleted, and `Document::plate_polygon` is the only
/// selector in the crate.)
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
// 2. The invariants — ENUMERATED, GRADED, AND COUNTED (R16)
// ---------------------------------------------------------------------------

/// **R16 — every statement this battery grades is a CHECK or a GUARD, and the
/// distinction is declared rather than inferred.**
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Grade {
    /// **Falsifiable**, and carries its falsification record in [`CONJUNCTS`].
    Check,
    /// An identity **by construction**: it cannot fail because a mechanism we
    /// built makes it so. Carries a *construction proof* — break the mechanism
    /// and it reds — instead of a falsification. **Excluded from the check
    /// count**, because a board counting guards as checks overstates coverage.
    Guard,
}

/// **THE conjunct table — the fix for the structural finding, not for its two
/// instances.**
///
/// `cargo test` reports *tests*. Before this table `metrics_can_never_be_
/// impossible` was ONE test holding ~17 conjuncts, two of which were
/// tautologies (`efficiency_pct > 100 + 1e-6`, and `traced && nia > gea + 1e-6`),
/// and they survived **four consecutive assertion-by-assertion audits**. An
/// unenumerated conjunct cannot be audited by a process that audits lists — so
/// the conjuncts are now a list.
///
/// Every entry is `(id, grade, note)`. The note is a **falsification record**
/// for a `Check` and a **construction proof** for a `Guard`;
/// `every_conjunct_is_declared_graded_and_reached` fails on an empty one, on a
/// declared conjunct the battery never evaluates, and on an evaluated conjunct
/// that is not declared here. Both directions, because either alone is a
/// presence-match between two lists that can agree about what is missing.
const CONJUNCTS: &[(&str, Grade, &str)] = &[
    // ---- aggregate metric well-formedness -------------------------------
    ("M01.floor_area.finite", Grade::Check,
     "reds on any mutator that writes a non-finite coordinate; the f64-mutator \
      audit (lib.rs) found all fifteen accepting NaN"),
    ("M02.gross_external_area.finite", Grade::Check,
     "as M01, on the GEA path — the figure every area on the workbook is a share of"),
    ("M03.net_internal_area.finite", Grade::Check,
     "as M01, on the NIA path — the denominator of efficiency and of every donut share"),
    ("M04.area_per_workstation.finite", Grade::Check,
     "reds when NIA is non-finite or the seat count divides wrongly"),
    ("M05.efficiency_pct.finite", Grade::Check,
     "the ONLY conjunct that catches a NaN efficiency: `NaN.min(100.0) == 100.0`, \
      so the deleted `> 100` conjunct could not"),
    ("M06.unassigned_area.finite", Grade::Check,
     "as M01, on the Unassigned subset — the floor the plan wastes, billed to nobody"),
    ("M07.unassigned_pct.finite", Grade::Check,
     "as M01, on the Unassigned share — the same quantity as a percentage of NIA"),
    // ---- the two R16 dispositions ---------------------------------------
    ("M08.efficiency.equals_the_ratio_rederived_from_the_document", Grade::Check,
     "REPLACES the deleted tautology `efficiency_pct > 100 + 1e-6`. Sabotage S-T1b \
      (usable_area reads the RAW vector while NIA stays scaled — M1's own family) \
      reds this and left the deleted conjunct green, because lib.rs clamps"),
    ("M09.nia_never_exceeds_a_traced_gea", Grade::Guard,
     "GUARD, reclassified from `tautology`. Construction: `gross_external_area == \
      floor_area` and, under Traced, `nia == (Σ areas).min(floor_area)` — the same \
      `doc.floor_area()` on the same document. Proof it is a construction and not \
      algebra: sabotage S-T2 (drop `.min(doc.floor_area())` from \
      `net_internal_area`'s Traced arm) makes it RED"),
    // ---- the panel's own arithmetic -------------------------------------
    ("M10.seated_plans_report_floor_per_seat", Grade::Check,
     "the reported `Area/WS 0.0 m²` row; reds whenever seats exist and NIA does not"),
    ("M11.plate_state.is_a_state_the_panel_renders", Grade::Check,
     "the panel branches on this string; an unknown value renders blank"),
    ("M12.a_capped_basis_reports_itself", Grade::Check,
     "reds on `suppress overflow, keep the cap` (193/3) — falsified in the R16 round"),
    ("M13.nia_has_one_owner", Grade::Check,
     "reds on a second NIA owner anywhere between the document and the panel"),
    ("M14.zone_rows.one_row_per_zone", Grade::Check,
     "replaced the producer veto `if !rows.is_empty()`; returning nothing left the \
      suite at 195 green (S5b reproduced that against the pre-fix gate)"),
    ("M15.zone_rows.sum_to_nia", Grade::Check,
     "reds on a second areas owner in `zone_rows` (the inversion it replaced could \
      not: `area / pct_of_nia * 100` is identically nia) and on every row × 3.0"),
    ("M16.zone_row.area.finite", Grade::Check,
     "reds on the compensating pair (+300/−300 across two rows, Σ preserved): \
      `Meeting Room 2  area -283.600` on a published surface"),
    ("M17.zone_row.pct_of_nia.finite", Grade::Check,
     "as M16, on the donut share: the compensating pair also billed `pct -31.518`"),
    ("M18.zone_row.carries_the_one_basis_factor", Grade::Check,
     "reds on misattribution (100 m² non-usable → usable inside the shared basis, \
      194/2 on this conjunct alone) and on `k = 1.0` (194/2)"),
    // ---- the basis itself, not two readers of it ------------------------
    ("M25.basis.bills_no_floor_outside_the_plate", Grade::Check,
     "**THE STAGE NOTHING GRADED.** De-clipping `area_basis` (`z.area_on(plate_\
      ref)` → `z.area()`) left 199 of 200 Rust tests green on the merged tree — \
      this battery, the conjunct census, the wasm surface census and every \
      layout NIA/GEA assertion among them — because M08/M18/M22 re-derive their \
      expectation from `raw_zone_areas_unscaled`, the same `effective_zone_\
      areas` the rows came from, so subject and ground truth move together. \
      Anchored instead to the plate POLYGON via `point_in_polygon` + \
      `dist_to_polygon`, neither of which the clip path calls. Falsification: \
      that same de-clip reds it. A box bound was written first and measured \
      INERT — it bit 0 times in 10 001 zone-evaluations while the clip bit 349 \
      — because the zone writers refuse an off-plate shape and the clip's real \
      work is a rect over a concave plate. Graded only where the geometry \
      certifies a cut, so its evaluation count is its own non-vacuity figure; \
      it is an inequality, and the VALUE is pinned by \
      `the_area_basis_clips_each_zone_to_the_plate_polygon`"),
    ("M26.capacity.is_the_seat_count_the_billed_area_supports", Grade::Guard,
     "**GUARD, and it was RED AT HEAD — which is what separates it from an \
      identity by algebra (M21's own standing).** Construction: `Zone::capacity_\
      on(area)` takes the floor area as an ARGUMENT, and both publishing writers \
      pass the very `area_basis` value they bill on that row; the raw-shape form \
      survives only as `pub(crate) seat_estimate_for_ordering`, which no \
      publisher can name. Construction proof — break the mechanism and it reds: \
      restoring `z.seat_estimate_for_ordering()` in `quantity.rs` reds the \
      takeoff arm, and in `lib.rs::zone_rows` reds the panel arm; each is \
      independently sufficient. Watched failing first at 83c8e39: 2 449 of \
      28 480 zone-evaluations diverged (8.60%), on the UNEDITED fixtures as well \
      as the edited ones — F1 unedited zone 244 `Open Workspace (2)` billed 8.0 \
      m² and 5 pax, and `seed 25 from F5` zone 423 billed 369 pax against 153. \
      Graded on BOTH published surfaces, and on the panel ONLY on its area-rule \
      arm: the same bound over the FURNISHED arm reds 81 times on the FIXED tree \
      (F5 zone 41 `Focus Room 1`, a real 2-seat table in 7.5 m² against a 9 \
      m²/seat rate), because the rate is a planning rule and not a packing \
      limit. Excluded from the check count. REJECTED IN THE SAME ROUND: a \
      plate-anchored quarter-disc bound on the seat count, M25's instrument one \
      column over. It reds at HEAD (63 takeoff + 115 panel of 322 evaluations) \
      and is green after — but on the area-rule arm it is implied by M25 ∧ this, \
      and on the furnished arm it is the 81 false reds. A guard by derivation \
      whose only new coverage is wrong; not written"),
    // ---- cross-surface: panel vs takeoff --------------------------------
    ("M19.takeoff.one_room_per_zone", Grade::Check,
     "the takeoff's half of M14; reds when `quantities` drops or invents a room"),
    ("M20.takeoff.rows_are_the_same_zone", Grade::Check,
     "reds when the two surfaces are joined on position and the orders diverge"),
    ("M21.takeoff.area_equals_the_panel", Grade::Guard,
     "GUARD since R14 — `mod basis` makes the raw vector unnameable, so both \
      surfaces read `area_basis` by construction. Construction proof: sabotage S1 \
      (restore the raw read in `quantity.rs`) needs TWO edits to compile and then \
      reds 194/2. It was RED at HEAD before R14, which is what separates it from \
      an identity by algebra"),
    ("M22.takeoff.area_is_anchored_to_the_documents_geometry", Grade::Check,
     "the anchor that stops M21's pair agreeing while both drift; reds on `k = 1.0` \
      and on any per-zone transform between the geometry and the bill"),
    ("M23.attribution.partition_agrees_on_three_surfaces", Grade::Guard,
     "GUARD — a theorem of the current fold table (`published_zone_type` moves \
      Unassigned → Circulation, both non-usable). Construction proof: change the \
      fold to `Unassigned → Workspace` and it reds 194/2"),
    ("M24.takeoff.sum_equals_the_panel_sum", Grade::Guard,
     "GUARD by DERIVATION, not by construction: implied by M14 ∧ M19 ∧ M20 ∧ M21, \
      and strictly weaker (a per-row 1e-6 tolerance summed over N rows exceeds a \
      1e-6 tolerance on the sum). Kept only for its failure message, which names \
      the divergence in m²; excluded from the check count"),
    // ---- save / reopen (R15: NOT in the battery before this change) ------
    ("S02.reopen.is_lossless_on_every_published_surface", Grade::Check,
     "**S01 was DELETED into this one.** S01 asserted `to_string(&doc).is_ok()` on \
      the stated premise that serde_json refuses NaN — it does not: it writes \
      `null` and returns `Ok`, so S01 could not fire. Measured in the sabotage \
      round, not argued; the same false premise was live in a lib.rs doc comment \
      and is corrected there. The refusal is on the READ side, so the ROUND TRIP \
      is the only form of the assertion that works, and it is this one. \
      Reds when a Document field stops round-tripping, or when `backfill_seats` \
      changes a number on reopen. The INVENTORY facets (component/wall/confirmed \
      counts, per-room headcount and capacity) are compared because the area facets \
      alone could not see them: sabotage S-S02, popping one component inside \
      `backfill_seats`, left the whole probe GREEN until they were added"),
    ("S03.cad_json.survives_a_reopen", Grade::Check,
     "the drafting blob rides in the snapshot; reds when `set_cad_json`/`get_cad_json` \
      stop agreeing across a save"),
    // ---- the plan renderer's own surfaces --------------------------------
    ("S04.wall_outlines.are_finite", Grade::Check,
     "a NaN in the outline is a blank canvas, not an error; reds on a non-finite wall"),
    ("S05.plate.is_finite", Grade::Check,
     "as S04, on the polygon the renderer clips zones against; a NaN vertex clips everything away"),
    ("S06.plate.area_equals_the_billed_gea", Grade::Check,
     "cross-surface: the polygon `plate()` hands the renderer and the GEA `metrics()` \
      bills are one floor. Sabotage S-S6 (`floor_area` → `bbox_area` unconditionally) reds it"),
    ("S07.wall_types.one_row_per_wall", Grade::Check,
     "the plan renderer colours from this; a missing row is an uncoloured wall"),
    ("S08.wall_types.length_is_the_walls_own_geometry", Grade::Check,
     "re-derived from `Wall::a`/`b`, not from the classifier; reds on any length transform"),
    ("S09.wall_types.total_run_agrees_with_the_takeoff", Grade::Check,
     "cross-surface: `wall_types()` (the coloured plan) and `quantities().walls` (the \
      billed workbook) must measure the same runs. Core is excluded — it legitimately \
      carries keep-out perimeter length with zero modelled segments"),
    ("S10.zone_at.returns_a_live_zone", Grade::Check,
     "the hit-test the editor selects with; reds when it returns an id no longer in \
      the document (the stale-index shape)"),
    // ---- the scoring surfaces --------------------------------------------
    ("S11.circulation.is_a_score", Grade::Check,
     "guarded on `doc.walls.len() > 0` — the degeneracy is read off the DOCUMENT, not \
      off the producer's own output, so it is a guard and not a skip. Reds on a \
      non-finite or out-of-range circulation score. `circulation_ratio` is \
      deliberately bounded BELOW only: it divides a cell-counted walkable area by a \
      polygon area, and that discretization overshoots — measured up to 1.010254 \
      (seed 7 from F2) on this population. Bounding it at 1 would assert a promise \
      the surface never made; its own doc comment says `context only, not scored`"),
    ("S12.layout_score.is_a_score", Grade::Check,
     "every sub-score finite and in 0..=100, and `total` likewise; the autonomous \
      search loop ranks candidates on these"),
    ("S13.density_score.is_a_score", Grade::Check,
     "exported so the frontend stops deciding `too dense` on its own; reds out of 0..=100"),
    ("S17.layout_score.floor_is_the_documents_own_floor", Grade::Guard,
     "**GUARD, and RED AT HEAD — 546 of 1 205 states — which is what separates \
      it from an identity by algebra (M21's standing).** The plate had TWO \
      owners: `Document::plate_polygon` selects by anchor containment, and its \
      own doc comment records largest-closed-loop as a retired defect, while \
      `layout/score.rs:16`, `:194` and `layout.rs:201` still called \
      `geometry::trace_floor_polygon` — largest-wins — verbatim. Construction: \
      all three now call `doc.plate_polygon()`, `LayoutScore::floor_area_m2` \
      publishes the floor they divided by, and it is `Document::floor_area()`. \
      Construction proof — break the mechanism and it reds, in ALL THREE \
      directions, which is the point: the scorer reading the SMALLEST face reds \
      it **922** times, LARGEST-WINS (the defect restored) reds it **546**, and \
      the canonical plate is green (203/203). Before this conjunct existed all \
      three gave **Rust 202/202** — nothing on the board moved whether the scorer \
      read the right plate, the wrong plate, or a third wrong plate — and that \
      null was RE-RUN, not inherited: with these three conjuncts' assertions \
      disabled and largest-wins restored, 202 of 203 tests pass and the only red \
      is `a_disjoint_neighbouring_loop_is_not_this_plans_floor`, added in this \
      same round. NON-VACUITY, measured: the published field must be fed by the \
      scorer's OWN divisor and not by ground truth. Wiring it \
      `floor_area_m2: doc.floor_area()` with largest-wins live silences this \
      conjunct outright (546 -> 0) while S19 still reds 356 — that is the gate \
      measuring nothing, and it is why the field is `floor_area_m2: floor`. The \
      1e-6 relative tolerance is load-bearing too: widened to 1e12 under \
      largest-wins it silences the conjunct (546 -> 0). \
      Ground truth is `doc.floor_area()`, the DOCUMENT's own answer, which the \
      scorer does not produce; it is nonetheless the same expression the scorer \
      now resolves to, so it is graded GUARD and not CHECK. RETYPED \
      RE-DERIVATION IS A GUARD — said plainly, because belief four found eleven \
      conjuncts mis-graded CHECK for exactly this. Excluded from the check count"),
    ("S18.scores.declare_an_unresolved_plate_instead_of_scoring_it", Grade::Guard,
     "GUARD — a wiring assertion, both sides read `Document::plate_resolution`. \
      `PlateResolution` exists because \"we don't know is a value\", and it had \
      reached `Metrics` and neither scoring surface: on the unedited F3 fixture \
      `density_score()` returned a confident **0.000/100** — the most extreme \
      value on the scale — where the honest answer is that the walls close on no \
      face holding this plan. `LayoutScore` now carries `plate_state`, the same \
      three tags from the same owner as `Metrics::plate_state`, and \
      `density_score()` returns `Option<f64>`, absent across the wasm boundary \
      exactly when the plate is `Unresolved` — `Metrics::metrics_error`'s \
      convention, not a second one. Construction proof, two mechanisms, \
      each independently sufficient: deleting the `Unresolved => None` arm reds \
      it **546** — exactly the number of unresolved states in the population, so \
      the arm is reached on every one — and pinning `LayoutScore::plate_state` to \
      the literal \"traced\" reds it **703**, every state whose plate is not \
      traced. Excluded from the check count"),
    ("S19.layout_score.wasted_floor_debit_is_within_its_declared_range", Grade::Guard,
     "**GUARD, and RED AT HEAD — 354 of 1 205 states, worst 969.2178 points on a \
      0..100 scale.** `unassigned_penalty` is specified by its own comment as \
      \"~1.8 points … deliberately NOT enough to reorder candidates\", so its \
      range is `[0, 10]` — 10 x a SHARE of the plate. It left that range two \
      ways, and THE SECOND ONE WAS NOT IN THE BRIEF: the plate defect above \
      (denominator), and an un-de-overlapped numerator (`z.area_on(plate)` \
      summed per zone, billing a hand-drawn overlapping zone's floor twice) \
      which still broke the range on **11 of 1 205** states after the plate was \
      fixed — worst `seed 62 from F2` at 15.2783 on a correctly-traced 930.06 m² \
      plate. Both halves are now one owner: the numerator is \
      `crate::unassigned_area` over `crate::area_basis`, the denominator is \
      `Document::floor_area()`, and the basis is capped so `Σ areas ≤ nia ≤ \
      floor_area`. Construction proof — break either half and it \
      reds, independently: restoring the raw per-zone sum reds it **11** (and \
      also reds `no_unregistered_production_site_reads_the_raw_per_zone_areas`, \
      because the exemption that used to cover that line is deleted); putting the \
      scorer back on largest-wins reds it **356** — 354 at HEAD, where both \
      halves were broken at once. The threshold is load-bearing: \
      `MAX_WASTE_DEBIT` raised to 1e9 under largest-wins silences the conjunct \
      (356 -> 0) while S17 still reds 546. That the bound follows from the cap is \
      precisely why it is a GUARD and not a CHECK. Excluded from the check count"),
    ("S14.qto_schedule.bills_every_component_exactly_once", Grade::Check,
     "anchored to the DOCUMENT: the rolled-up `item_count` must equal the component \
      count. Reds when the hierarchy drops a category, and when a component is \
      claimed by two zones' `component_ids` and therefore billed twice"),
    ("S16.qto_schedule.unassigned_items_are_the_documents_own_orphans", Grade::Check,
     "the orphan count is RE-DERIVED here from `zone.component_ids`, never read \
      off the schedule: `unassigned_items` is what the workbook surfaces instead \
      of silently folding a component into a room it is not in"),
    ("S15.qto_schedule.totals_are_finite", Grade::Check,
     "a NaN grand total renders as a blank price in the workbook, not as an error"),
];

/// **There is deliberately NO list of covered surfaces.** The covered set is a
/// run-time witness — what [`Ledger::read`] recorded — checked against the
/// population parsed out of `lib.rs`'s own `#[wasm_bindgen] impl Editor`. A
/// hand-maintained "surfaces we cover" list is one more artifact-derived list to
/// presence-match, which is the shape the completeness rule forbids.
///
/// Read surfaces deliberately outside the mutation battery, each with the reason
/// and where its content IS graded. An empty justification is a failure.
const SURFACE_EXEMPTIONS: &[(&str, &str)] = &[
    ("new",
     "the constructor. An `Editor::new()` document has no plan to grade; the empty \
      and wizard-fresh states are covered by `a_freshly_imported_plate_with_no_plan_\
      still_traces` and by `Document::new()` at the head of every fixture build."),
    ("revision",
     "not a document surface — it reports the mutation counter. Graded structurally \
      by `tests::every_mutator_bumps_the_revision`, which scans lib.rs's own source \
      so a mutator added next year fails at the moment it is written."),
    ("zones",
     "a byte-identical passthrough of `doc.zones` (lib.rs `zones()`), so a conjunct \
      comparing it against `doc.zones` would be a value compared against itself — \
      the exact R16 tautology this round deleted two of. Its content is graded \
      through S01/S02 (the whole document serialises and reopens) and through every \
      zone-row conjunct M14–M18."),
    ("layout_diag",
     "a passthrough of the generator's own `LayoutDiag`, populated only by \
      `generate`/`load_fixture` and never by an edit — so it is constant across a \
      mutation sequence and grading it per step would be 1 200 evaluations of one \
      value. The same struct is graded by `no_region_is_allocated_desks_it_cannot_\
      seat` and `desk_capacity_never_exceeds_what_the_packer_places` via \
      `fixtures::diag_for`."),
    ("fixture_ids",
     "the fixture enumeration itself. `all_fixtures()` — this battery's own base \
      population — reads `fixtures::FIXTURE_IDS` and panics on an id that does not \
      build, so every battery test is already a consumer; `fixtures_are_the_states_\
      they_claim_to_be` grades what each id resolves to."),
    // ---- Folded in from Line B's `SURFACES` table at the pair-1 collapse. -----
    // B's census classified these two and A's population never contained them,
    // because A's line predates `zone_domain!`. The collapse keeps A's mechanism
    // (coverage is a runtime witness, not a table cell) and keeps B's KNOWLEDGE,
    // which is the part a name-collapse would otherwise throw away.
    ("ground_zone_types",
     "not a document surface — it publishes the ground CLASS of the type space, \
      which is constant across a mutation sequence, so grading it per step would \
      be 1 205 evaluations of one value. Graded by name instead: \
      `zone::tests::ground_is_never_usable` and \
      `capacity_seats_nobody_exactly_where_the_usable_partition_does` exercise \
      `is_ground_zone`, whose answer this publishes, and `coreParity.test.mjs` \
      plus `sheetlib.mjs` hold the TS side to the value it returns."),
    ("zone_type_names",
     "not a document surface — it publishes `ZoneType::ALL`, the derived type \
      space itself, constant across a mutation sequence for the same reason as \
      `ground_zone_types`. Graded by name instead: `is_ground_zone`'s domain \
      assert fires on any variant missing from it, and \
      `groundConsumers.test.mjs` cross-checks that every ground type is a \
      member. The generated view is battery step 52 (`zone-domain`)."),
];

/// One evaluation of the invariant set: the violations it found, **which
/// conjuncts it graded**, and **which published surfaces it read**.
///
/// The last two are the R16/R15 repair. They are collected at the call sites, so
/// they are a run-time witness of what executed — not a comment claiming it.
pub(crate) struct Ledger {
    pub(crate) v: Vec<String>,
    /// How many documents were evaluated into this ledger. Non-vacuity: a union
    /// over zero evaluations satisfies every assertion below it.
    pub(crate) evaluations: usize,
    /// conjunct id → times evaluated.
    pub(crate) graded: std::collections::BTreeMap<&'static str, usize>,
    /// `#[wasm_bindgen]` surface name → times read.
    pub(crate) surfaces: std::collections::BTreeMap<&'static str, usize>,
}

impl Ledger {
    fn new() -> Self {
        Ledger {
            v: Vec::new(),
            evaluations: 0,
            graded: Default::default(),
            surfaces: Default::default(),
        }
    }
    /// Grade one conjunct. The id is passed at the site; [`CONJUNCTS`] owns what
    /// kind of statement it is, so there is exactly one place to audit.
    fn grade(&mut self, id: &'static str, ok: bool, msg: impl FnOnce() -> String) {
        *self.graded.entry(id).or_default() += 1;
        if !ok {
            self.v.push(format!("[{id}] {}", msg()));
        }
    }
    /// Record that a published surface was read in this evaluation.
    fn read(&mut self, surface: &'static str) {
        *self.surfaces.entry(surface).or_default() += 1;
    }
    fn finite(&mut self, id: &'static str, name: &str, x: f64) {
        let ok = x.is_finite() && x >= 0.0;
        let what = if x.is_finite() {
            format!("{name} is negative ({x})")
        } else {
            format!("{name} is {x}")
        };
        self.grade(id, ok, || what);
    }
}

/// The properties that make a metric a metric. Returns the violations as
/// messages, so callers can name the case that produced them.
fn violations(doc: &Document) -> Vec<String> {
    violations_ledger(doc).v
}

/// A `Program` for the `layout_score` surface. Fixed, because the surface under
/// test is the scorer's output over an EDITED document, not the program space —
/// `layout::tests` varies that.
fn battery_program() -> crate::layout::Program {
    crate::layout::Program::default()
}

fn violations_ledger(doc: &Document) -> Ledger {
    let mut led = Ledger::new();
    let m = compute_metrics(doc);
    led.read("metrics");

    led.finite("M01.floor_area.finite", "floor_area", m.floor_area);
    led.finite("M02.gross_external_area.finite", "gross_external_area", m.gross_external_area);
    led.finite("M03.net_internal_area.finite", "net_internal_area", m.net_internal_area);
    led.finite("M04.area_per_workstation.finite", "area_per_workstation", m.area_per_workstation);
    led.finite("M05.efficiency_pct.finite", "efficiency_pct", m.efficiency_pct);
    led.finite("M06.unassigned_area.finite", "unassigned_area", m.unassigned_area);
    led.finite("M07.unassigned_pct.finite", "unassigned_pct", m.unassigned_pct);

    // **DELETED (R16) — `if m.efficiency_pct > 100.0 + 1e-6`.**
    //
    // A TAUTOLOGY, and the disposition is deletion rather than reclassification
    // because it fails R16's own separator test. `lib.rs` clamps `efficiency_pct`
    // unconditionally (`efficiency_pct = efficiency_pct.min(100.0);`, after the
    // reporting branch has already set it to 100.0), so no consumer-side
    // assertion on that field can fire whatever happens upstream. Breaking the
    // clamp alone does NOT red it — `usable` and `nia` come from one scaled
    // basis, so the raw ratio is a non-negative subset over its own total and
    // cannot exceed 1 + float noise. Two independent breakages are needed before
    // it can fail, which is the definition of guarding nothing.
    // `NaN.min(100.0) == 100.0` closed the last route: it could not even catch a
    // NaN, which M05 does.
    //
    // Rebuilt as M08 below — the property is not "the number is possible" (the
    // producer guarantees that by clamping) but **"the number is the ratio the
    // document supports"**, which the clamp cannot fake.
    let (areas, spanning) = raw_zone_areas_unscaled(doc);
    let raw_sum: f64 = areas.iter().sum();
    let owner = net_internal_area(doc, &areas);
    let k = if raw_sum > 1e-9 && owner < raw_sum - 1e-6 { owner / raw_sum } else { 1.0 };

    let usable_rederived: f64 = doc
        .zones
        .iter()
        .zip(&areas)
        .filter(|(z, _)| crate::is_usable_zone(z.zone_type))
        .map(|(_, a)| *a * k)
        .sum();
    let want_eff = if owner > 0.0 { usable_rederived / owner * 100.0 } else { 0.0 };
    led.grade(
        "M08.efficiency.equals_the_ratio_rederived_from_the_document",
        (m.efficiency_pct - want_eff).abs() <= 1e-6 * want_eff.abs().max(1.0),
        || {
            format!(
                "the panel bills efficiency {:.6}% but the document's own basis \
                 supports {want_eff:.6}% (usable {usable_rederived:.3} / NIA \
                 {owner:.3}) — the numerator and the denominator disagree about \
                 one floor, which is M1's family. The clamp at lib.rs cannot make \
                 this agree: it can only make the number LOOK possible",
                m.efficiency_pct
            )
        },
    );

    // **M09 — RECLASSIFIED (R16), not deleted.** `traced && nia > gea + 1e-6`
    // reads as unfalsifiable (`gea == floor_area`; under Traced `nia ==
    // (Σ raw).min(floor_area)`), and panic-instrumenting it left 196 green. But
    // R16's separator is *break the mechanism*, not *watch it never fire*:
    // dropping `.min(doc.floor_area())` from `net_internal_area`'s Traced arm
    // makes it RED. It is therefore a GUARD on that clamp with a construction
    // proof, and is excluded from the check count.
    //
    // NIA ≤ GEA only when GEA is a measurement. Under `open`/`unresolved` the
    // gross figure is a bounding box and the relation carries no meaning — the
    // plate_state field is the assertion in that case.
    if m.plate_state == "traced" {
        led.grade(
            "M09.nia_never_exceeds_a_traced_gea",
            m.net_internal_area <= m.gross_external_area + 1e-6,
            || {
                format!(
                    "NIA {:.3} exceeds a TRACED GEA {:.3}",
                    m.net_internal_area, m.gross_external_area
                )
            },
        );
    }

    // A plan with seats must be able to say how much floor each one gets. This
    // is the "Area/WS 0.0 m²" row from the screenshots.
    if m.workstations > 0 {
        led.grade(
            "M10.seated_plans_report_floor_per_seat",
            m.area_per_workstation > 0.0,
            || {
                format!(
                    "{} workstations but area_per_workstation is {}",
                    m.workstations, m.area_per_workstation
                )
            },
        );
    }
    // The panel branches on this string; an unknown value would fall through
    // every branch and render blank.
    led.grade(
        "M11.plate_state.is_a_state_the_panel_renders",
        matches!(m.plate_state, "traced" | "open" | "unresolved"),
        || format!("unknown plate_state {:?}", m.plate_state),
    );

    // The two NIA readers must agree, always. This is the pair that diverged.
    //
    // RE-DERIVED FROM THE PANEL'S OWN ARTIFACT, not from the owner function.
    // The first version of this check compared `compute_metrics` against
    // `net_internal_area` — two calls to the same function — and the sabotage
    // round proved it: putting the second owner back into `zone_rows` left the
    // whole suite green. A check that cannot see the divergence it is named for
    // is not conservative, it is absent.
    //
    // **A capped metric must say it was capped.** `efficiency_pct` is clamped at
    // the source, so the M1 symptom can never again surface as a NUMBER — which
    // is exactly what would make an unreported cap invisible to every assertion
    // above. Re-derived from the UNCLAMPED areas, so this asks the document, not
    // the metric, whether a cap happened.
    led.grade(
        "M12.a_capped_basis_reports_itself",
        !(raw_sum > owner + 1e-6 && m.metrics_error.is_none()),
        || format!("the basis was capped ({raw_sum:.3} → {owner:.3}) and metrics_error is null"),
    );
    led.grade(
        "M13.nia_has_one_owner",
        (owner - m.net_internal_area).abs() <= 1e-9,
        || {
            format!(
                "two NIA values: metrics {:.6} vs owner {:.6}",
                m.net_internal_area, owner
            )
        },
    );

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
    // R10 AXES — this guard's falsification varies: the AREAS VECTOR (a second
    // owner in `zone_rows`; every row scaled), the CAP (a document whose raw sum
    // exceeds a traced floor), and the PLATE STATE (traced / open / unresolved,
    // which decides whether the cap applies at all).
    let ed = crate::Editor::for_test(doc.clone());
    let rows = ed.zone_rows_for_test(false);
    led.read("zone_stats");
    // **The producer no longer chooses whether it is checked.** This was
    // `if !rows.is_empty()`, which handed `zone_rows` a veto over its own test:
    // returning nothing — the Zones tab rendering an empty donut — left the whole
    // suite at 195 green. *A missing input is a FAILURE, never a skip.* The
    // expected count is re-derived from the document, not from the producer.
    led.grade("M14.zone_rows.one_row_per_zone", rows.len() == doc.zones.len(), || {
        format!(
            "zone_rows delivered {} rows for a document with {} zones",
            rows.len(),
            doc.zones.len()
        )
    });
    let row_sum: f64 = rows.iter().map(|r| r.area).sum();
    led.grade(
        "M15.zone_rows.sum_to_nia",
        (row_sum - m.net_internal_area).abs() <= 1e-6 * row_sum.max(1.0),
        || {
            format!(
                "the Zones tab's rows sum to {row_sum:.3} but NIA is {:.3} — the \
                 donut's slices do not sum to its own total",
                m.net_internal_area
            )
        },
    );

    // ---- THE VECTOR INVARIANTS. The sum is a scalar; the property is a vector.
    //
    // Everything above this line applies its finite/non-negative predicate to
    // seven AGGREGATE metrics and to zero per-row values, and a sum is preserved
    // by any compensating pair. Injecting +300 into one row and −300 into another
    // left 195 green while F1 billed `Meeting Room 2  area -283.600  pct -31.518`
    // — a negative donut slice, on a published surface, under a green board.
    for r in &rows {
        led.finite("M16.zone_row.area.finite", &format!("zone row {} area", r.id), r.area);
        led.finite(
            "M17.zone_row.pct_of_nia.finite",
            &format!("zone row {} pct_of_nia", r.id),
            r.pct_of_nia,
        );
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
    for (i, r) in rows.iter().enumerate() {
        let want = areas[i] * k;
        led.grade(
            "M18.zone_row.carries_the_one_basis_factor",
            (r.area - want).abs() <= 1e-6 * want.abs().max(1.0),
            || {
                format!(
                    "zone row {} area {:.3} is not its own de-overlapped footprint \
                     {:.3} × the one basis factor {k:.6} (= {want:.3}) — the basis \
                     carries a per-zone transform, not one shared cap",
                    r.id, r.area, areas[i]
                )
            },
        );
        // ---- M26, THE PANEL'S HALF. ----
        //
        // The area-rule arm of `zone_rows`. The OTHER two arms are deliberately
        // not graded here and the reason is measured, not assumed: bounding the
        // FURNISHED arm by the same rule reds 81 times on the fixed tree —
        // `F5 unedited` zone 41 "Focus Room 1", a 7.5 m² cabin holding a real
        // 2-seat table against a 9 m²/seat planning rate. Furniture is the
        // stronger evidence and legitimately beats the rule of thumb; a conjunct
        // that reds on it would be asserting the rate is a packing limit, which
        // it is not. So this grades exactly where the AREA is the evidence.
        //
        // The arm is re-derived here rather than read off the producer: which
        // arm fired is not a field on the row, and asking the row would be
        // asking the subject.
        let furnished: u32 = doc.zones[i]
            .component_ids
            .iter()
            .filter_map(|&cid| doc.components.iter().find(|c| c.id == cid))
            .filter(|c| !c.reference)
            .filter(|c| c.category != "Chair")
            .map(|c| c.seats)
            .sum();
        if furnished == 0 && Some(i) != spanning {
            if let Some(per) = crate::zone::m2_per_seat(doc.zones[i].zone_type) {
                let want_cap = (r.area / per).floor().max(0.0) as u32;
                led.grade(
                    "M26.capacity.is_the_seat_count_the_billed_area_supports",
                    r.capacity == want_cap,
                    || {
                        format!(
                            "the Zones tab bills zone {} at {:.3} m² and {} pax, but \
                             {:.3} m² at {per} m²/seat is {want_cap} pax — the row's \
                             area and its seat count are measuring two different \
                             floors",
                            r.id, r.area, r.capacity, r.area
                        )
                    },
                );
            }
        }
    }

    // ---- THE BASIS ITSELF — what the areas ARE, not that two readers agree. --
    //
    // **THE STAGE NOTHING GRADED, measured rather than suspected.** De-clip
    // `area_basis` (`z.area_on(plate_ref)` → `z.area()`), so every published
    // area bills floor that is outside the building, and the merged tree answers
    // **199 of 200 Rust tests green**. This battery passes. The conjunct census
    // passes. The wasm surface census passes. `golden_generate_output_is_frozen`
    // passes. Every `layout::tests` NIA/GEA assertion passes. The single red is
    // `cost::tests::enclosed_premium_reads_the_area_basis`.
    //
    // Every conjunct above is blind to it BY CONSTRUCTION, and that is not a
    // fault in any of them. M08, M18 and M22 re-derive their expectation from
    // `raw_zone_areas_unscaled` — the same `effective_zone_areas` the rows came
    // from — so de-clipping moves the subject and the ground truth together.
    // That is the rules file's warning about calibrating against the population
    // under test, in its area form: **two readers of one basis are each other's
    // ground truth for DIVERGENCE and for nothing else.** "The basis is
    // plate-clipped" is a statement about the shared definition, and no
    // agreement check can make it — which is why the basis's other stages ARE
    // guarded and this one was not. Measured the same way, each stage disabled
    // on its own in a disposable worktree:
    //
    //   de-overlap, non-spanning  5 red  (`nia_never_exceeds_gea_under_room_
    //                                     heavy_tilted_plates`, `stress_insights_
    //                                     invariants_over_shape_space`, +3)
    //   de-overlap, spanning      3 red  (the same two, + `oriented_fill_
    //                                     insights_are_correct_nia_le_gea…`)
    //   cap                       4 red  (M18 ×1143, M22 ×1164, M15 ×48,
    //                                     M08 ×17)
    //   plate clip                1 red  (`cost::tests::enclosed_premium…`)
    //
    // The three guarded stages all move Σ areas against `doc.floor_area()`, a
    // quantity the basis does not produce. The clip does not: it moves every
    // reader by the same amount, which is exactly why only an anchor outside
    // the basis can see it.
    //
    // **THE FIRST ANCHOR THIS ROUND TRIED WAS INERT, AND THE MEASUREMENT IS THE
    // REASON THIS ONE EXISTS.** The obvious independent bound is a box bound —
    // `zone ⊆ bbox(zone) ∧ plate ⊆ bbox(plate) ⟹ area(zone ∩ plate) ≤
    // area(bbox(zone) ∩ bbox(plate))` — exact, O(1), and reading nothing the
    // basis produces. It was written, and then counted over the battery:
    //
    //     zones under a traced plate  10 001
    //     the CLIP bites (area_on < area)  349
    //     the BOX BOUND bites                0
    //
    // Zero, out of ten thousand. `add_zone`/`resize_zone` refuse an off-plate
    // shape, so no edit can push a zone past the plate's own extent — and the
    // clip's real work is the case `ZoneShape::area_on`'s doc comment names:
    // rectangular zones on a NON-rectangular plate, hanging into a notch that is
    // entirely inside the bounding box. **A box bound is structurally incapable
    // of guarding this clip**, and `every_conjunct_is_declared_graded_and_
    // reached` said so by refusing a conjunct graded zero times.
    //
    // R2/R13: the ground truth is therefore re-derived from the plate POLYGON,
    // by two primitives the clip path never calls. `area_on` clips with
    // `rect_polygon_clip_area` → `clip_rect_to_polygon` (Sutherland–Hodgman);
    // this reads `point_in_polygon` (even-odd ray cast) and `dist_to_polygon`
    // (point-to-segment distance). Different algorithms over the same document
    // geometry, so agreement is evidence rather than transcription.
    //
    // The statement is EXACT, not a tolerance. If a rect corner `C` is outside
    // the plate and at distance `d` from its boundary, every point within `d` of
    // `C` is outside too (reaching the inside means crossing the boundary), and
    // the rect contains the quarter-disc of radius `d ≤ w/2, h/2` at that
    // corner. So at least `π d² / 4` of the shape is off the floor:
    //
    //     area(zone ∩ plate) ≤ area(zone) − π d² / 4
    //
    // De-overlap only subtracts and the cap only scales by k ≤ 1, so the bound
    // survives all three stages; it is checked against the UNCAPPED vector,
    // where the clip is the only stage that could have moved it.
    if let Some(poly) = doc.plate_polygon() {
        for (i, z) in doc.zones.iter().enumerate() {
            // `Rect` only: the quarter-disc argument needs the corner's interior
            // quadrant to belong to the shape. A `RectRing`'s corner may sit over
            // its own hole and a `Poly` is built by clipping and has no corners
            // in this sense — neither is skipped silently, they are simply not
            // what this statement is about.
            let ZoneShape::Rect { x, y, w, h } = z.shape else { continue };
            let unclipped = z.shape.area();
            if !unclipped.is_finite() || !areas[i].is_finite() || w <= 0.0 || h <= 0.0 {
                continue; // non-finite geometry is M01/M16's statement, not this one
            }
            // The largest quarter-disc any outside corner certifies.
            let mut cut = 0.0_f64;
            for (cx, cy) in [
                (x - w / 2.0, y - h / 2.0),
                (x + w / 2.0, y - h / 2.0),
                (x + w / 2.0, y + h / 2.0),
                (x - w / 2.0, y + h / 2.0),
            ] {
                if crate::geometry::point_in_polygon(cx, cy, &poly) {
                    continue;
                }
                // **THE HALF-SPAN CLAMP IS DECLARED INERT ON THIS POPULATION.**
                // It is what makes the quarter-disc argument sound — a disc
                // wider than the rect does not fit inside it, and an
                // unclamped `d` would over-certify and produce a FALSE RED.
                // Sabotage F5 removed it and the suite stayed GREEN (19/19 of
                // `metrics_tests::`), so no zone in the battery has a corner
                // further outside the plate than half its own span. Kept for
                // soundness, not for coverage; recorded here rather than left
                // to look load-bearing.
                let d = crate::geometry::dist_to_polygon(crate::geometry::Point::new(cx, cy), &poly)
                    .min(w / 2.0)
                    .min(h / 2.0);
                if d.is_finite() && d > 0.0 {
                    cut = cut.max(std::f64::consts::PI * d * d / 4.0);
                }
            }
            // **GRADED ONLY WHERE THE GEOMETRY CERTIFIES A CUT** — the S11 idiom.
            // A zone wholly inside the plate certifies none, the inequality is
            // then true of any basis whatsoever, and grading it would pad the
            // board with evaluations that cannot fail. The 5 cm floor keeps a
            // corner that merely grazes the boundary — where `point_in_polygon`
            // is ambiguous at float precision, as its own doc comment says —
            // from certifying a cut it cannot support. So the conjunct's
            // evaluation count IS its non-vacuity figure, and
            // `every_conjunct_is_declared_graded_and_reached` fails at zero.
            const MIN_CUT: f64 = std::f64::consts::PI * 0.05 * 0.05 / 4.0; // d = 5 cm
            if cut < MIN_CUT {
                continue;
            }
            led.grade(
                "M25.basis.bills_no_floor_outside_the_plate",
                areas[i] <= unclipped - cut,
                || {
                    format!(
                        "zone {} is billed {:.6} m² of a {unclipped:.6} m² shape, but \
                         a corner of it lies clear of the plate polygon and the \
                         geometry certifies at least {cut:.6} m² is off the floor — \
                         the basis is billing floor that is not in the building",
                        z.id, areas[i]
                    )
                },
            );
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
    let quantities = crate::quantity::quantities(doc);
    led.read("quantities");
    let rooms = &quantities.rooms;
    // The FOLDED rows — what `Editor::zone_stats_published()` publishes to every
    // client-facing artifact. `rows` above is the unfolded truth; both are
    // checked, because the fold is where an attribution could change without any
    // area moving.
    let pub_rows = ed.zone_rows_for_test(true);
    led.read("zone_stats_published");
    led.grade("M19.takeoff.one_room_per_zone", rooms.len() == doc.zones.len(), || {
        format!(
            "the takeoff delivered {} rooms for a document with {} zones",
            rooms.len(),
            doc.zones.len()
        )
    });
    if rooms.len() == rows.len() {
        for (i, (r, q)) in rows.iter().zip(rooms).enumerate() {
            led.grade("M20.takeoff.rows_are_the_same_zone", r.id == q.room_id, || {
                format!(
                    "panel row {} and takeoff room {} are not the same zone",
                    r.id, q.room_id
                )
            });
            if r.id != q.room_id {
                continue;
            }
            led.grade(
                "M21.takeoff.area_equals_the_panel",
                (r.area - q.area_m2).abs() <= 1e-6 * r.area.abs().max(1.0),
                || {
                    format!(
                        "zone {}: the panel shows {:.3} m² and the takeoff bills \
                         {:.3} m² — two owners of one room's area",
                        r.id, r.area, q.area_m2
                    )
                },
            );
            // ...and the takeoff is anchored to the DOCUMENT's geometry in its
            // own right, not merely to the panel. Otherwise the pair could agree
            // with each other while both drifted off the floor they describe —
            // the mutual-contamination shape the rules file names, where two
            // artifact-derived lists agree about the missing element.
            let want = areas[i] * k;
            led.grade(
                "M22.takeoff.area_is_anchored_to_the_documents_geometry",
                (q.area_m2 - want).abs() <= 1e-6 * want.abs().max(1.0),
                || {
                    format!(
                        "the takeoff bills zone {} at {:.3} m², not its own \
                         de-overlapped footprint {:.3} × the one basis factor \
                         {k:.6} (= {want:.3})",
                        q.room_id, q.area_m2, areas[i]
                    )
                },
            );
            // ---- M26, THE TAKEOFF'S HALF: the seat count on the same row. ----
            //
            // **The defect this closes was live on the UNEDITED base fixtures.**
            // `quantities` billed `capacity: z.capacity()` — the area rule on the
            // RAW shape — in the row whose `area_m2` one field up had already
            // been routed through `area_basis`, under a comment retracting that
            // exact defect for the area. On F1 unedited, zone 244 "Open
            // Workspace (2)": **8.0 m² and 5 pax**, five workstations at 6 m²
            // each on floor the same row says is eight. Across the battery
            // 2 449 of 28 480 zone-evaluations diverged (8.60%), the takeoff's
            // Σ pax on 835 of 1 205 states, worst `seed 25 from F5` at 729 vs
            // 362 with zone 423 alone billing 369 against 153.
            //
            // Not "the two surfaces agree": the panel and the takeoff publish
            // DIFFERENT seat quantities on purpose (the panel folds furniture
            // in, the takeoff keeps `headcount` and `capacity` as separate
            // columns), and they diverge on 8 551 rows of the battery by design.
            // The property is INTERNAL to one row: whatever floor it bills, its
            // seat count is the count that floor supports.
            //
            // R2: `per` comes from `zone::m2_per_seat`, the rate SPEC, so this
            // never calls `capacity_on` — a wrong rate and a wrong argument are
            // both visible. The rates themselves are pinned by value in
            // `zone::tests::capacity_rules`.
            if let Some(per) = crate::zone::m2_per_seat(q.zone_type) {
                let want_cap = (q.area_m2 / per).floor().max(0.0) as u32;
                led.grade(
                    "M26.capacity.is_the_seat_count_the_billed_area_supports",
                    q.capacity == want_cap,
                    || {
                        format!(
                            "the takeoff bills room {} at {:.3} m² and {} pax, but \
                             {:.3} m² at {per} m²/seat is {want_cap} pax — the row's \
                             area and its seat count are measuring two different \
                             floors",
                            q.room_id, q.area_m2, q.capacity, q.area_m2
                        )
                    },
                );
            }
            // ---- The ATTRIBUTION facet, anchored to the document. ----
            //
            // Efficiency is `usable / nia`, so which side of that partition a
            // room lands on is worth 11 points on the headline. Checked as the
            // PREDICATE, not as the type name: the panel publishes FOLDED rows
            // (Unassigned → Circulation) and the takeoff publishes unfolded ones
            // deliberately (`space_type_label`: "Seeing 'Unassigned' in a
            // delivered artifact is the bug report"), so the two names
            // legitimately differ while the partition must not. Three-way
            // against the document's own `zone_type`, which neither surface owns.
            let doc_type = doc.zones.iter().find(|z| z.id == q.room_id).map(|z| z.zone_type);
            let Some(doc_type) = doc_type else {
                led.grade("M23.attribution.partition_agrees_on_three_surfaces", false, || {
                    format!("takeoff bills room {} which is not a zone", q.room_id)
                });
                continue;
            };
            let published = pub_rows.iter().find(|p| p.id == q.room_id);
            let seen = [
                ("the panel's raw row", Some(r.zone_type)),
                ("the panel's published row", published.map(|p| p.zone_type)),
                ("the takeoff", Some(q.zone_type)),
            ];
            for (who, t) in seen {
                let ok = t.is_some_and(|t| crate::is_usable_zone(t) == crate::is_usable_zone(doc_type));
                led.grade("M23.attribution.partition_agrees_on_three_surfaces", ok, || match t {
                    None => format!("zone {} is missing from {who}", q.room_id),
                    Some(t) => format!(
                        "zone {}: the document types it {doc_type:?} ({}) and \
                         {who} bills it {t:?} ({}) — the usable/non-usable \
                         partition differs by surface",
                        q.room_id,
                        if crate::is_usable_zone(doc_type) { "usable" } else { "overhead" },
                        if crate::is_usable_zone(t) { "usable" } else { "overhead" },
                    ),
                });
            }
        }
    }
    let room_sum: f64 = rooms.iter().map(|r| r.area_m2).sum();
    led.grade(
        "M24.takeoff.sum_equals_the_panel_sum",
        (room_sum - row_sum).abs() <= 1e-6 * row_sum.max(1.0),
        || {
            format!(
                "the panel's rows sum to {row_sum:.3} m² and the takeoff's rooms sum \
                 to {room_sum:.3} m² — a {:.3} m² divergence between two published \
                 surfaces over the same document",
                (room_sum - row_sum).abs()
            )
        },
    );

    // ---- SAVE / REOPEN. ------------------------------------------------------
    //
    // **RETRACTED BY NAME (R15).** The R15 ledger entry read *"The battery now
    // evaluates every surface the product publishes at every step — metrics,
    // zone rows, quantities/takeoff, save/reopen, export."* Save/reopen was not
    // in it: `metrics_tests.rs` contained zero references to `snapshot` or
    // `restore`. It is in it now, and this is what that claim should have meant.
    //
    // `snapshot()` is `serde_json::to_string(&self.doc)` and `restore` /
    // `from_snapshot` are `serde_json::from_str` + `backfill_seats`, so the whole
    // round trip is reachable natively; only the `JsValue` wrapper is not.
    let mut saveable = doc.clone();
    saveable.cad_json = Some("{\"battery\":\"cad blob\"}".to_string());
    // `to_string` on a Document cannot fail (a struct of scalars, vecs and
    // string-keyed maps), so "it serialized" is not a statement worth grading —
    // that was S01, deleted. What CAN fail is reading it back: a non-finite
    // number is written as `null` and `from_str` refuses it. The round trip is
    // the assertion.
    let snap = serde_json::to_string(&saveable);
    led.read("state");
    led.read("snapshot");
    if let Ok(s) = &snap {
        match serde_json::from_str::<Document>(s) {
            Err(e) => {
                led.grade("S02.reopen.is_lossless_on_every_published_surface", false, || {
                    format!(
                        "the saved document does not reopen: {e} — a `.dsource` that \
                         saved and can never be opened again"
                    )
                });
                led.grade("S03.cad_json.survives_a_reopen", false, || {
                    format!("the saved document does not reopen: {e}")
                });
            }
            Ok(mut reopened) => {
                // Exactly what `Editor::restore` / `Editor::from_snapshot` do.
                reopened.backfill_seats();
                led.read("restore");
                led.read("from_snapshot");
                led.read("get_cad_json");
                let rm = compute_metrics(&reopened);
                let rrows = crate::Editor::for_test(reopened.clone()).zone_rows_for_test(false);
                let rrooms = crate::quantity::quantities(&reopened).rooms;
                // Every PUBLISHED number, not merely the JSON — a field that
                // round-trips into a different derived quantity is the failure
                // this is for. `metrics_error` is a String, compared as one.
                let mut diffs: Vec<String> = Vec::new();
                for (name, a, b) in [
                    ("gross_external_area", m.gross_external_area, rm.gross_external_area),
                    ("net_internal_area", m.net_internal_area, rm.net_internal_area),
                    ("efficiency_pct", m.efficiency_pct, rm.efficiency_pct),
                    ("unassigned_area", m.unassigned_area, rm.unassigned_area),
                    ("area_per_workstation", m.area_per_workstation, rm.area_per_workstation),
                ] {
                    if (a - b).abs() > 1e-9 * a.abs().max(1.0) {
                        diffs.push(format!("{name} {a:.6} → {b:.6}"));
                    }
                }
                if m.workstations != rm.workstations {
                    diffs.push(format!("workstations {} → {}", m.workstations, rm.workstations));
                }
                // The INVENTORY facets. Without these the check was blind to a
                // reopen that drops a component: areas are geometry and survive
                // it untouched, so `Document::backfill_seats` popping one item
                // left the whole probe green — measured, not argued (S-S02).
                for (name, a, b) in [
                    ("component_count", m.component_count, rm.component_count),
                    ("confirmed", m.confirmed, rm.confirmed),
                    ("wall_count", m.wall_count, rm.wall_count),
                ] {
                    if a != b {
                        diffs.push(format!("{name} {a} → {b}"));
                    }
                }
                if m.plate_state != rm.plate_state {
                    diffs.push(format!("plate_state {} → {}", m.plate_state, rm.plate_state));
                }
                if rrows.len() != rows.len() {
                    diffs.push(format!("zone rows {} → {}", rows.len(), rrows.len()));
                } else {
                    for (a, b) in rows.iter().zip(&rrows) {
                        if a.id != b.id || (a.area - b.area).abs() > 1e-9 * a.area.abs().max(1.0) {
                            diffs.push(format!(
                                "zone row {}/{} area {:.6} → {:.6}",
                                a.id, b.id, a.area, b.area
                            ));
                        }
                    }
                }
                if rrooms.len() != rooms.len() {
                    diffs.push(format!("takeoff rooms {} → {}", rooms.len(), rrooms.len()));
                } else {
                    for (a, b) in rooms.iter().zip(&rrooms) {
                        if a.room_id != b.room_id
                            || (a.area_m2 - b.area_m2).abs() > 1e-9 * a.area_m2.abs().max(1.0)
                        {
                            diffs.push(format!(
                                "takeoff room {}/{} area {:.6} → {:.6}",
                                a.room_id, b.room_id, a.area_m2, b.area_m2
                            ));
                        }
                        if a.headcount != b.headcount || a.capacity != b.capacity {
                            diffs.push(format!(
                                "takeoff room {} headcount {}/{} capacity {}/{}",
                                a.room_id, a.headcount, b.headcount, a.capacity, b.capacity
                            ));
                        }
                    }
                }
                led.grade(
                    "S02.reopen.is_lossless_on_every_published_surface",
                    diffs.is_empty(),
                    || {
                        format!(
                            "save → reopen changed {} published value(s): {diffs:?} — a \
                             .dsource that reopens as a different building",
                            diffs.len()
                        )
                    },
                );
                led.grade(
                    "S03.cad_json.survives_a_reopen",
                    reopened.cad_json.as_deref() == Some("{\"battery\":\"cad blob\"}"),
                    || {
                        format!(
                            "the CAD drafting blob did not survive the round trip: {:?}",
                            reopened.cad_json
                        )
                    },
                );
            }
        }
    }

    // ---- THE PLAN RENDERER'S SURFACES. --------------------------------------
    let ext: std::collections::HashSet<u32> = doc.exterior_wall_ids().into_iter().collect();
    let outlines = crate::wallnet::outline(&doc.walls, &|id| ext.contains(&id));
    led.read("wall_outlines");
    let bad_outline = outlines.iter().find(|s| {
        !(s.a[0].is_finite() && s.a[1].is_finite() && s.b[0].is_finite() && s.b[1].is_finite())
    });
    led.grade("S04.wall_outlines.are_finite", bad_outline.is_none(), || {
        format!("a wall outline stroke is non-finite: {:?}", bad_outline.map(|s| (s.a, s.b)))
    });

    let plate = doc.plate_points();
    led.read("plate");
    let bad_pt = plate
        .as_ref()
        .and_then(|p| p.iter().find(|p| !(p[0].is_finite() && p[1].is_finite())));
    led.grade("S05.plate.is_finite", bad_pt.is_none(), || {
        format!("the plate polygon carries a non-finite vertex: {bad_pt:?}")
    });
    // Cross-surface: the polygon `plate()` hands the renderer to clip against and
    // the GEA `metrics()` bills are ONE floor. Both published; nothing else joins
    // them.
    if let Some(pts) = &plate {
        let poly: Vec<crate::geometry::Point> = pts
            .iter()
            .map(|p| crate::geometry::Point::new(p[0], p[1]))
            .collect();
        let poly_area = crate::geometry::polygon_area(&poly).abs();
        led.grade(
            "S06.plate.area_equals_the_billed_gea",
            (poly_area - m.gross_external_area).abs() <= 1e-6 * poly_area.max(1.0),
            || {
                format!(
                    "the plate polygon the renderer clips to encloses {poly_area:.3} m² \
                     and the panel bills a GEA of {:.3} m² — two floors",
                    m.gross_external_area
                )
            },
        );
    }

    let wall_types = crate::quantity::classify_walls(doc);
    led.read("wall_types");
    led.grade("S07.wall_types.one_row_per_wall", wall_types.len() == doc.walls.len(), || {
        format!(
            "the plan renderer was handed {} wall classifications for {} walls",
            wall_types.len(),
            doc.walls.len()
        )
    });
    if wall_types.len() == doc.walls.len() {
        for (w, c) in doc.walls.iter().zip(&wall_types) {
            // Re-derived from the wall's own endpoints, not from the classifier.
            let want = ((w.b.x - w.a.x).powi(2) + (w.b.y - w.a.y).powi(2)).sqrt();
            led.grade(
                "S08.wall_types.length_is_the_walls_own_geometry",
                c.id == w.id && (c.length_m - want).abs() <= 1e-9 * want.max(1.0),
                || {
                    format!(
                        "wall {} is classified as id {} with length {:.6} m, but its \
                         own endpoints are {:.6} m apart",
                        w.id, c.id, c.length_m, want
                    )
                },
            );
        }
    }
    // Cross-surface: the coloured plan (`wall_types`) and the billed workbook
    // (`quantities().walls`) must measure the same runs, per type.
    //
    // `Core` is excluded and the exclusion is the documented reason, not a
    // convenience: `WallQuantity` says Core "can carry length with segments == 0
    // when it comes from keep-out perimeters" — length with no modelled wall
    // behind it, which `classify_walls` (one row per `Wall`) cannot see.
    for wq in &quantities.walls {
        if format!("{:?}", wq.wall_type) == "Core" {
            continue;
        }
        let from_plan: f64 = wall_types
            .iter()
            .filter(|c| c.wall_type == wq.wall_type)
            .map(|c| c.length_m)
            .sum();
        led.grade(
            "S09.wall_types.total_run_agrees_with_the_takeoff",
            (from_plan - wq.length_m).abs() <= 1e-6 * from_plan.max(1.0),
            || {
                format!(
                    "{:?}: the coloured plan draws {from_plan:.3} m of run and the \
                     workbook bills {:.3} m",
                    wq.wall_type, wq.length_m
                )
            },
        );
    }

    // The hit-test the editor selects with. Sampled at each Rect zone's own
    // centre — a point the document says is inside SOME zone.
    for z in &doc.zones {
        let (bx0, by0, bx1, by1) = z.shape.bbox();
        let hit = doc.zone_at((bx0 + bx1) / 2.0, (by0 + by1) / 2.0);
        led.read("zone_at");
        led.grade(
            "S10.zone_at.returns_a_live_zone",
            hit.is_none_or(|id| doc.zones.iter().any(|z| z.id == id)),
            || {
                format!(
                    "zone_at returned {hit:?} at the centre of zone {} — no such zone \
                     is in the document, so a click there selects a ghost",
                    z.id
                )
            },
        );
    }

    // ---- THE SCORING SURFACES. ----------------------------------------------
    //
    // `circulation()` is degenerate with 0 walls (CLAUDE.md). The guard reads the
    // DOCUMENT's wall count, never the producer's own `CirculationScore::empty`
    // flag — a producer that mislabelled itself would otherwise veto its own
    // test. `the_battery_reaches_every_guarded_surface` asserts the guarded arm
    // is reached, so this is a guard and not a skip.
    if !doc.walls.is_empty() {
        let c = crate::circulation::evaluate(doc, &crate::circulation::CirculationConfig::new());
        led.read("circulation");
        let bad = [
            ("score", c.score, 0.0, 100.0),
            // Upper-bounded at +inf on purpose — see the CONJUNCTS note. A
            // cell-counted area over a polygon area overshoots by ~1% here.
            ("circulation_ratio", c.circulation_ratio, 0.0, f64::INFINITY),
            ("largest_connected_free_region", c.largest_connected_free_region, 0.0, 1.0),
            ("entry_reachable_fraction", c.entry_reachable_fraction, 0.0, 1.0),
            ("pct_corridors_below_min", c.pct_corridors_below_min, 0.0, 1.0),
            ("min_corridor_width", c.min_corridor_width, 0.0, f64::INFINITY),
            ("mean_clearance", c.mean_clearance, 0.0, f64::INFINITY),
            ("reachable_free_area", c.reachable_free_area, 0.0, f64::INFINITY),
        ]
        .into_iter()
        .find(|(_, x, lo, hi)| !(x.is_finite() && *x >= *lo && *x <= *hi));
        led.grade("S11.circulation.is_a_score", bad.is_none(), || {
            let (n, x, lo, hi) = bad.unwrap();
            format!("circulation.{n} is {x}, outside [{lo}, {hi}]")
        });
    }

    let ls = crate::layout::score(doc, &battery_program());
    led.read("layout_score");
    let bad = [
        ("capacity", ls.capacity),
        ("adjacency", ls.adjacency),
        ("circulation", ls.circulation),
        ("density", ls.density),
        ("program_fit", ls.program_fit),
        ("daylight", ls.daylight),
        ("entry_adjacency", ls.entry_adjacency),
        ("total", ls.total),
    ]
    .into_iter()
    .find(|(_, x)| !(x.is_finite() && *x >= 0.0 && *x <= 100.0));
    led.grade("S12.layout_score.is_a_score", bad.is_none(), || {
        let (n, x) = bad.unwrap();
        format!("layout_score.{n} is {x}, outside [0, 100] — the search loop ranks on this")
    });

    // ---- S17: the scorer and the panel divide by ONE floor. -----------------
    //
    // Ground truth is `doc.floor_area()` — the DOCUMENT's own answer, not
    // anything `score` produced. The scorer used to trace its own plate with the
    // retired largest-closed-loop rule; see the CONJUNCTS note.
    let doc_floor = doc.floor_area();
    led.grade(
        "S17.layout_score.floor_is_the_documents_own_floor",
        ls.floor_area_m2.is_finite()
            && ls.floor_area_m2 >= 0.0
            && (ls.floor_area_m2 - doc_floor).abs() <= 1e-6 * doc_floor.max(1.0),
        || {
            format!(
                "the scorer divided by {:.6} m² while the document's floor is \
                 {doc_floor:.6} m² (plate_state {}) — every plate-derived sub-score \
                 and `total` are measured against a floor this plan is not on",
                ls.floor_area_m2, ls.plate_state
            )
        },
    );

    // ---- S19: the wasted-floor debit stays inside its own definition. -------
    //
    // `unassigned_penalty` is DEFINED as `10 × (Unassigned m² / plate m²)` — a
    // share, so the debit cannot leave `[0, 10]`, and its own doc comment sizes
    // it at "~1.8 points … deliberately NOT enough to reorder candidates". The
    // bound comes from that specification, never from re-running the producer's
    // arithmetic. It is subtracted from an absolute 0..100 `total` that the
    // candidate gallery ranks on and the Claude evaluator is handed, so a debit
    // outside its range does not merely misrank — it clamps every candidate to
    // zero and blinds the seed search.
    const MAX_WASTE_DEBIT: f64 = 10.0;
    led.grade(
        "S19.layout_score.wasted_floor_debit_is_within_its_declared_range",
        ls.unassigned_penalty.is_finite()
            && ls.unassigned_penalty >= -1e-9
            && ls.unassigned_penalty <= MAX_WASTE_DEBIT + 1e-9,
        || {
            format!(
                "unassigned_penalty is {:.4} — outside [0, {MAX_WASTE_DEBIT}]. The term \
                 is 10 × a SHARE of the plate, so a value above {MAX_WASTE_DEBIT} means \
                 the floor in the denominator is not the floor the numerator was \
                 measured on (floor {:.4} m², plate_state {})",
                ls.unassigned_penalty, ls.floor_area_m2, ls.plate_state
            )
        },
    );

    let d = crate::Editor::for_test(doc.clone()).density_score();
    led.read("density_score");
    led.grade(
        "S13.density_score.is_a_score",
        d.is_none_or(|d| d.is_finite() && (0.0..=100.0).contains(&d)),
        || format!("density_score is {d:?}, outside [0, 100]"),
    );

    // ---- S18: "we could not measure" is said, not scored as a zero. --------
    //
    // The channel `PlateResolution` exists for, carried out to the two scoring
    // surfaces. The document's own resolution is the subject AND the ground
    // truth here — this is a wiring assertion, not a measurement one, and it is
    // graded GUARD for exactly that reason.
    let unresolved = matches!(doc.plate_resolution(), PlateResolution::Unresolved);
    led.grade(
        "S18.scores.declare_an_unresolved_plate_instead_of_scoring_it",
        (ls.plate_state == m.plate_state) && (d.is_none() == unresolved),
        || {
            format!(
                "the plate is {} but layout_score says plate_state {:?} and \
                 density_score says {d:?} — a consumer cannot tell \"we could not \
                 measure this floor\" from \"this layout is bad\"",
                m.plate_state, ls.plate_state
            )
        },
    );

    let sched = crate::qto::schedule(doc);
    led.read("qto_schedule");
    led.grade(
        "S14.qto_schedule.bills_every_component_exactly_once",
        sched.item_count == doc.components.len(),
        || {
            format!(
                "the schedule bills {} items for a document holding {} components \
                 — {} are billed nowhere (negative: billed twice)",
                sched.item_count,
                doc.components.len(),
                doc.components.len() as i64 - sched.item_count as i64
            )
        },
    );
    // Re-derived from `zone.component_ids`, not read off the schedule.
    let orphans = doc
        .components
        .iter()
        .filter(|c| !doc.zones.iter().any(|z| z.component_ids.contains(&c.id)))
        .count();
    led.grade(
        "S16.qto_schedule.unassigned_items_are_the_documents_own_orphans",
        sched.unassigned_items == orphans,
        || {
            format!(
                "the schedule surfaces {} unassigned items but {orphans} components \
                 belong to no zone — items are vanishing into a room they are not in",
                sched.unassigned_items
            )
        },
    );
    let bad_line = sched
        .all_lines
        .iter()
        .find(|l| !(l.quantity.is_finite() && l.area_m2.is_finite()))
        .map(|l| l.label.clone());
    led.grade(
        "S15.qto_schedule.totals_are_finite",
        sched.grand_total_inr.is_finite() && sched.grand_total_inr >= 0.0 && bad_line.is_none(),
        || {
            format!(
                "the schedule's grand total is {} and line {bad_line:?} carries a \
                 non-finite quantity",
                sched.grand_total_inr
            )
        },
    );

    led
}

// ---------------------------------------------------------------------------
// 2b. THE CENSUS — derived from the product's own exports, never from a list
// ---------------------------------------------------------------------------

/// One `pub fn` as it appears in Rust source: its name, its full (possibly
/// multi-line) parameter list, and its brace-balanced body.
pub(crate) struct PubFn<'a> {
    pub(crate) name: &'a str,
    pub(crate) params: &'a str,
    pub(crate) body: &'a str,
}

impl PubFn<'_> {
    pub(crate) fn is_mutator(&self) -> bool {
        self.params.contains("&mut self")
    }
}

/// Every `pub fn` in `src`. **The one source scanner**, shared by
/// `tests::every_mutator_bumps_the_revision`,
/// `tests::every_f64_mutator_is_guarded_against_non_finite_input` and the
/// surface census below — three guards that were each re-implementing this
/// parse, which is the drift `.claude/rules/no-bloat.md` names.
///
/// The body is taken by brace balance rather than by a fixed window: a fixed
/// window is a threshold on comment length, and this crate's comments are long
/// on purpose (the first draft of the f64 scan used 400 chars and reported
/// `assign_product` unguarded when its guard sat below a paragraph explaining
/// why it exists).
/// `src` with every comment body and string-literal body replaced by spaces,
/// **byte for byte**, so every index into the result is a valid index into
/// `src` and slicing may be done against the original.
///
/// **This exists because a doc comment defeated the scanner that reads it.**
/// `lib.rs`'s `ground_zone_types` carries a doc comment arguing that a
/// form-specific reader is defeated by rewriting the form, and it names the
/// offending shape inline: *"the `pub fn ` impl-block scan"*. `pub_fns` matched
/// that prose and published a phantom export whose "name" was two paragraphs of
/// English. Measured: **58 exports where the crate has 57**, and the census
/// reported the phantom as MISSING — a surface that does not exist, held against
/// a battery that could not possibly read it.
///
/// The comment was RIGHT, and it proved itself by breaking the instrument that
/// could not read it. Masking is the minimum repair: it makes the scan read
/// code. It does **not** make the scan a value-reader, so R20's objection to the
/// whole approach stands and is recorded against the census, not discharged by
/// this fix.
///
/// Handles line comments, nested block comments, normal string literals with
/// backslash escapes, and raw strings (`r"…"`, `r#"…"#`). Byte-oriented so that
/// masking a multi-byte character replaces all of its bytes and the result stays
/// valid UTF-8.
pub(crate) fn mask_comments_and_strings(src: &str) -> String {
    let b = src.as_bytes();
    let mut out = b.to_vec();
    let mut i = 0usize;
    while i < b.len() {
        // line comment
        if b[i] == b'/' && i + 1 < b.len() && b[i + 1] == b'/' {
            while i < b.len() && b[i] != b'\n' {
                out[i] = b' ';
                i += 1;
            }
            continue;
        }
        // block comment, nested
        if b[i] == b'/' && i + 1 < b.len() && b[i + 1] == b'*' {
            let mut depth = 0usize;
            while i < b.len() {
                if b[i] == b'/' && i + 1 < b.len() && b[i + 1] == b'*' {
                    depth += 1;
                    out[i] = b' ';
                    out[i + 1] = b' ';
                    i += 2;
                    continue;
                }
                if b[i] == b'*' && i + 1 < b.len() && b[i + 1] == b'/' {
                    depth -= 1;
                    out[i] = b' ';
                    out[i + 1] = b' ';
                    i += 2;
                    if depth == 0 {
                        break;
                    }
                    continue;
                }
                if b[i] != b'\n' {
                    out[i] = b' ';
                }
                i += 1;
            }
            continue;
        }
        // raw string: r"…" or r#"…"#  (any number of hashes)
        if b[i] == b'r' {
            let mut j = i + 1;
            let mut hashes = 0usize;
            while j < b.len() && b[j] == b'#' {
                hashes += 1;
                j += 1;
            }
            if j < b.len() && b[j] == b'"' {
                j += 1;
                'raw: while j < b.len() {
                    if b[j] == b'"' {
                        let mut k = j + 1;
                        let mut seen = 0usize;
                        while k < b.len() && b[k] == b'#' && seen < hashes {
                            seen += 1;
                            k += 1;
                        }
                        if seen == hashes {
                            j = k;
                            break 'raw;
                        }
                    }
                    if b[j] != b'\n' {
                        out[j] = b' ';
                    }
                    j += 1;
                }
                i = j;
                continue;
            }
        }
        // normal string literal
        if b[i] == b'"' {
            i += 1;
            while i < b.len() {
                if b[i] == b'\\' {
                    if i + 1 < b.len() && b[i + 1] != b'\n' {
                        out[i] = b' ';
                        out[i + 1] = b' ';
                    }
                    i += 2;
                    continue;
                }
                if b[i] == b'"' {
                    i += 1;
                    break;
                }
                if b[i] != b'\n' {
                    out[i] = b' ';
                }
                i += 1;
            }
            continue;
        }
        i += 1;
    }
    String::from_utf8(out).expect("masking replaces whole byte runs with ASCII spaces")
}

pub(crate) fn pub_fns(src: &str) -> Vec<PubFn<'_>> {
    let mut out = Vec::new();
    // Scan the MASKED text so prose cannot declare a function; slice the
    // ORIGINAL, which masking keeps byte-aligned with it.
    let masked = mask_comments_and_strings(src);
    for (idx, _) in masked.match_indices("pub fn ") {
        let after = &src[idx + "pub fn ".len()..];
        let after_masked = &masked[idx + "pub fn ".len()..];
        let Some(open) = after_masked.find('(') else { continue };
        let name = after[..open].trim();
        let Some(close) = after_masked.find(')') else { continue };
        if close < open {
            continue;
        }
        let params = &after[open..close];
        let Some(brace) = after_masked[close..].find('{') else { continue };
        let body_start = close + brace;
        let mut depth = 0i32;
        let mut end = after.len();
        // Balance braces on the MASKED text: a `{` inside a doc comment or a
        // string literal is not a block, and counting it truncates the body.
        for (i, ch) in after_masked[body_start..].char_indices() {
            match ch {
                '{' => depth += 1,
                '}' => {
                    depth -= 1;
                    if depth == 0 {
                        end = body_start + i;
                        break;
                    }
                }
                _ => {}
            }
        }
        out.push(PubFn { name, params, body: &after[body_start..end] });
    }
    out
}

/// **THE published surface population**: the body of `#[wasm_bindgen] impl
/// Editor` in `lib.rs`, taken by brace balance.
///
/// Derived from the product's own exports. A brief's list of surfaces is a
/// suspect list; this is the population, and it grows on its own the moment
/// somebody adds an export.
pub(crate) fn wasm_editor_impl() -> &'static str {
    const SRC: &str = include_str!("lib.rs");
    // Anchor and balance on the MASKED text, for the same reason `pub_fns`
    // does: this file's doc comments quote both the anchor string and stray
    // braces, and prose must not be able to move the population's boundary.
    let masked = mask_comments_and_strings(SRC);
    let head = "#[wasm_bindgen]\nimpl Editor {";
    let i = masked.find(head).expect("lib.rs must carry a `#[wasm_bindgen] impl Editor` block");
    let from = i + head.len() - 1;
    let mut depth = 0i32;
    for (o, ch) in masked[from..].char_indices() {
        match ch {
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    return &SRC[from..from + o];
                }
            }
            _ => {}
        }
    }
    panic!("the `#[wasm_bindgen] impl Editor` block never closes");
}

/// The `&mut self` half of the export population — **the exact set
/// `tests::every_mutator_bumps_the_revision` and
/// `tests::every_f64_mutator_is_guarded_against_non_finite_input` grade**,
/// because it is the same function call and not a second list.
pub(crate) fn wasm_editor_mutators() -> Vec<&'static str> {
    pub_fns(wasm_editor_impl())
        .into_iter()
        .filter(|f| f.is_mutator())
        .map(|f| f.name)
        .collect()
}

/// **THE battery, run once for the whole process.**
///
/// 120 seeds x 10 mutations from each of the five fixtures = 6 000 mutations and
/// 1 200 metric evaluations, plus the five unedited fixtures — all deterministic,
/// and now grading every published read surface at every step. Three tests read
/// it (the invariant assertion, the conjunct enumeration and the surface
/// census), so it is computed once: the surfaces added this round —
/// `circulation` and `layout_score` — cost ~65 ms each per evaluation, and three
/// independent runs would be eight minutes of duplicated work over an identical
/// deterministic population.
fn battery_union() -> &'static Ledger {
    static ONCE: std::sync::OnceLock<Ledger> = std::sync::OnceLock::new();
    ONCE.get_or_init(|| {
        let bases = all_fixtures();
        let mut all = Ledger::new();
        for (id, doc) in &bases {
            merge_into(&mut all, violations_ledger(doc), &format!("fixture {id}"));
        }
        for seed in 1u64..=120 {
            let (id, base) = &bases[(seed as usize - 1) % bases.len()];
            let mut doc = base.clone();
            let mut rng = Rng(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1);
            for step in 0..10 {
                mutate(&mut doc, &mut rng);
                merge_into(
                    &mut all,
                    violations_ledger(&doc),
                    &format!("seed {seed} from {id}, after {} mutation(s)", step + 1),
                );
            }
        }
        all
    })
}

fn merge_into(all: &mut Ledger, led: Ledger, label: &str) {
    all.evaluations += 1;
    all.v.extend(led.v.into_iter().map(|m| format!("{label}: {m}")));
    for (id, n) in led.graded {
        *all.graded.entry(id).or_default() += n;
    }
    for (s, n) in led.surfaces {
        *all.surfaces.entry(s).or_default() += n;
    }
}

/// **R16, at the class level: the conjuncts are a LIST, and the list is
/// checked in both directions.**
///
/// `cargo test` counts tests. It reported 196 while
/// `metrics_can_never_be_impossible` was one test holding ~17 conjuncts, two of
/// them tautologies — and those two survived four consecutive
/// assertion-by-assertion audits, because *an unenumerated conjunct cannot be
/// audited by a process that audits lists*. This is the repair.
///
/// Three failures, not one:
/// 1. a conjunct the battery grades that [`CONJUNCTS`] does not declare;
/// 2. a conjunct [`CONJUNCTS`] declares that the battery never reaches — a
///    declared statement evaluated zero times is an absent check wearing a
///    table row, and the same shape as `if !rows.is_empty()`;
/// 3. an entry whose note is empty. A `Check` owes a falsification record and a
///    `Guard` owes a construction proof; "TODO" is neither.
#[test]
fn every_conjunct_is_declared_graded_and_reached() {
    let led = battery_union();

    let declared: std::collections::BTreeSet<&str> =
        CONJUNCTS.iter().map(|(id, _, _)| *id).collect();
    assert_eq!(
        declared.len(),
        CONJUNCTS.len(),
        "CONJUNCTS carries a duplicate id — two statements graded under one name \
         is how one of them stops being audited"
    );

    let evaluated: std::collections::BTreeSet<&str> = led.graded.keys().copied().collect();
    let undeclared: Vec<&&str> = evaluated.difference(&declared).collect();
    assert!(
        undeclared.is_empty(),
        "the battery graded {} conjunct(s) that CONJUNCTS does not declare: \
         {undeclared:?} — an unenumerated conjunct cannot be audited",
        undeclared.len()
    );
    let unreached: Vec<&&str> = declared.difference(&evaluated).collect();
    assert!(
        unreached.is_empty(),
        "CONJUNCTS declares {} conjunct(s) the battery never evaluates: \
         {unreached:?} — a declared statement graded zero times is an absent check",
        unreached.len()
    );

    for (id, grade, note) in CONJUNCTS {
        assert!(
            note.trim().len() >= 40,
            "{id} ({grade:?}) carries no usable note. A Check owes its \
             falsification record; a Guard owes its construction proof"
        );
    }

    // **Guards are excluded from the check count.** A board counting guards as
    // checks overstates its coverage.
    let checks: Vec<&&str> = CONJUNCTS
        .iter()
        .filter(|(_, g, _)| *g == Grade::Check)
        .map(|(id, _, _)| id)
        .collect();
    let guards: Vec<&&str> = CONJUNCTS
        .iter()
        .filter(|(_, g, _)| *g == Grade::Guard)
        .map(|(id, _, _)| id)
        .collect();
    let check_evals: usize = CONJUNCTS
        .iter()
        .filter(|(_, g, _)| *g == Grade::Check)
        .map(|(id, _, _)| led.graded[id])
        .sum();
    let guard_evals: usize = CONJUNCTS
        .iter()
        .filter(|(_, g, _)| *g == Grade::Guard)
        .map(|(id, _, _)| led.graded[id])
        .sum();
    println!(
        "CONJUNCT BOARD — {} CHECKS ({check_evals} evaluations) · {} GUARDS \
         ({guard_evals} evaluations, NOT counted as checks)",
        checks.len(),
        guards.len()
    );
    for (id, grade, _) in CONJUNCTS {
        println!("  {:<7} {:<62} {:>8} evaluations", format!("{grade:?}"), id, led.graded[id]);
    }
    println!("GUARDS (excluded from the check count): {guards:?}");
    assert!(
        checks.len() >= 25,
        "only {} checks declared — the enumeration has lost statements",
        checks.len()
    );
    assert!(led.v.is_empty(), "the census population violated: {:?}", led.v);
}

/// **R15 — every published wasm surface is exercised per mutation step, or is
/// exempt with a stated reason.**
///
/// The population is `#[wasm_bindgen] impl Editor`'s own `pub fn` list, parsed
/// out of `lib.rs`. It is deliberately NOT a list in this file: the completeness
/// rule in `.claude/rules/gate-independence.md` is that the expected set is
/// derived from ground truth and each artifact is then checked against *that*,
/// never that two artifact-derived lists are presence-matched.
///
/// The other side is a **run-time witness**: [`Ledger::read`] records a surface
/// at the point the battery actually reads it. So the two sides are the
/// product's source and the battery's execution — an entry that is claimed but
/// never read fails just as loudly as a surface that is never claimed.
///
/// **Measured before this change: 4 of 21 read surfaces.** `metrics_tests.rs`
/// contained zero references to `snapshot`, `restore`, `qto`, `circulation`,
/// `classify_walls`, `layout::score` or `density`. The prior ledger entry
/// claiming save/reopen and export were in the battery is **retracted by name**
/// in `violations_ledger`'s save/reopen section.
#[test]
fn every_published_wasm_surface_is_exercised_or_exempt() {
    let exports = pub_fns(wasm_editor_impl());
    assert!(
        exports.len() >= 50,
        "only {} exports parsed out of `#[wasm_bindgen] impl Editor` — the \
         scanner has lost its grip on the source and the census is vacuous",
        exports.len()
    );
    let readers: Vec<&str> = exports.iter().filter(|f| !f.is_mutator()).map(|f| f.name).collect();
    let mutators = wasm_editor_mutators();
    assert_eq!(
        readers.len() + mutators.len(),
        exports.len(),
        "the reader/mutator partition does not cover the export list"
    );

    let led = battery_union();
    let exercised: std::collections::BTreeSet<&str> = led.surfaces.keys().copied().collect();

    // A `led.read("typo")` must fail here rather than silently claim coverage.
    let all_names: std::collections::BTreeSet<&str> =
        exports.iter().map(|f| f.name).collect();
    let ghosts: Vec<&&str> = exercised.difference(&all_names).collect();
    assert!(
        ghosts.is_empty(),
        "the battery claims to read {ghosts:?}, which `impl Editor` does not export"
    );

    let mut missing: Vec<&str> = Vec::new();
    println!("PUBLISHED SURFACE CENSUS — {} exports = {} readers + {} mutators",
             exports.len(), readers.len(), mutators.len());
    for name in &readers {
        let reads = led.surfaces.get(name).copied().unwrap_or(0);
        let exempt = SURFACE_EXEMPTIONS.iter().find(|(n, _)| n == name);
        match (reads, exempt) {
            (0, None) => {
                missing.push(name);
                println!("  MISSING  {name}");
            }
            (0, Some((_, why))) => {
                assert!(
                    why.trim().len() >= 40,
                    "{name} is exempt with no usable justification — an empty \
                     justification is a failure, not an exemption"
                );
                println!("  EXEMPT   {name}");
            }
            (n, None) => println!("  COVERED  {name:<24} {n:>7} reads"),
            (n, Some(_)) => {
                // An exemption for a surface the battery DOES read is stale, and
                // stale exemptions are how a real gap hides behind an old excuse.
                panic!("{name} is exempt but the battery reads it {n} times — delete the exemption");
            }
        }
    }
    for (name, _) in SURFACE_EXEMPTIONS {
        assert!(
            readers.contains(name),
            "SURFACE_EXEMPTIONS names {name:?}, which is not a read surface of \
             `impl Editor` — a stale exemption covers nothing"
        );
    }
    assert!(
        missing.is_empty(),
        "{} published read surface(s) are outside the mutation battery and carry \
         no justified exemption: {missing:?}. Add them to `violations_ledger` \
         (one `led.read(..)` at the point of use) or add a SURFACE_EXEMPTIONS \
         entry saying where they ARE graded",
        missing.len()
    );

    // The `&mut self` half is graded elsewhere, and "elsewhere" is the same
    // function call rather than a claim: `tests::every_mutator_bumps_the_revision`
    // and `tests::every_f64_mutator_is_guarded_against_non_finite_input` both
    // enumerate `wasm_editor_mutators()`.
    println!("  (+ {} mutators, graded by tests::every_mutator_bumps_the_revision \
              and tests::every_f64_mutator_is_guarded_against_non_finite_input)",
             mutators.len());
    assert!(
        mutators.len() >= 30,
        "only {} mutators found — the mutator guards have lost their population",
        mutators.len()
    );
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

/// **The basis IS plate-clipped — asserted on the basis, against a number
/// derived from the geometry by hand.**
///
/// R13: the property directly, not a round trip through a consumer. Measured
/// before this test existed: de-clipping `area_basis` (`z.area_on(plate_ref)` →
/// `z.area()`) left **199 of 200** Rust tests green, the one red being
/// `cost::tests::enclosed_premium_reads_the_area_basis` — which reaches the
/// basis through `indicative_cost` and through a plate that is a plain
/// rectangle, so the only overhang it can express is one that leaves the plate
/// entirely on one side.
///
/// `M25` in the battery covers the real mutated population, but it is an
/// **inequality**: it certifies only the quarter-disc an outside corner
/// supports, which here is π·2²/4 ≈ 3.14 m² of an 8 m² overhang. This test pins
/// the **value**. The plate is L-shaped and the room hangs into the notch — the
/// case `ZoneShape::area_on`'s doc comment exists for, and the case a
/// rectangular plate cannot pose at all.
///
/// The expected 24 m² is arithmetic on the rectangle coordinates, re-derived by
/// splitting the L into two disjoint rectangles — never read back out of
/// `area_basis`, and never out of `area_on`.
#[test]
fn the_area_basis_clips_each_zone_to_the_plate_polygon() {
    // An L: a 30 x 20 rectangle with a 10 x 10 notch out of the top-right
    // corner, so the floor is 600 − 100 = 500 m².
    let ring = [(0.0, 0.0), (30.0, 0.0), (30.0, 10.0), (20.0, 10.0), (20.0, 20.0), (0.0, 20.0)];
    let mut doc = Document::default();
    for i in 0..ring.len() {
        let (ax, ay) = ring[i];
        let (bx, by) = ring[(i + 1) % ring.len()];
        let id = doc_alloc(&mut doc);
        doc.walls.push(crate::model::Wall {
            id,
            a: crate::geometry::Point::new(ax, ay),
            b: crate::geometry::Point::new(bx, by),
            thickness: 0.1,
            generated: false,
            glazing: false,
            height_m: None,
        });
    }
    let floor = doc.floor_area();
    assert!(
        (floor - 500.0).abs() < 1e-9,
        "the L plate must trace to 500 m² or this test is measuring a different \
         shape than the one its numbers were derived from; got {floor}"
    );

    // The room: 8 x 4 centred at (18, 12.5), i.e. x 14..22 by y 10.5..14.5.
    // Above y = 10 the plate only covers x ≤ 20, so
    //   ON  the floor: x 14..20 by y 10.5..14.5 = 6 x 4 = 24 m²
    //   OFF the floor: x 20..22 by y 10.5..14.5 = 2 x 4 =  8 m²   (the notch)
    // Its centre (18, 12.5) is inside the L, so the plan-containment rule still
    // resolves this face as the floor.
    let id = doc_alloc(&mut doc);
    doc.zones.push(crate::zone::Zone {
        id,
        zone_type: ZoneType::Meeting,
        shape: ZoneShape::Rect { x: 18.0, y: 12.5, w: 8.0, h: 4.0 },
        label: "room over the notch".to_string(),
        component_ids: Vec::new(),
        group: None,
        origin: Default::default(),
    });
    assert_eq!(compute_metrics(&doc).plate_state, "traced", "the L must resolve as the floor");

    let clipped = 24.0;
    let unclipped = 32.0;
    let basis = crate::area_basis(&doc);
    assert_eq!(basis.areas.len(), 1);
    assert!(
        (basis.areas[0] - clipped).abs() < 1e-9,
        "the basis bills {:.6} m² for a room with {clipped} m² inside the \
         building and {} m² over the notch",
        basis.areas[0],
        unclipped - clipped
    );

    assert!(
        (basis.areas[0] - unclipped).abs() > 1.0,
        "billing the raw {unclipped} m² shape must be distinguishable from \
         {clipped} m², or this test cannot see a de-clipped basis"
    );

    // **Why this is not a duplicate of M25, stated as arithmetic rather than as
    // a claim.** M25 certifies a cut from the largest quarter-disc an outside
    // corner supports. Here the outside corners are (22, 10.5) and (22, 14.5),
    // each 2 m clear of the plate edge at x = 20, and the rect's half-height is
    // also 2 — so M25 can certify only π·2²/4 ≈ 3.1416 m² of the 8 m² that is
    // really over the notch. M25 is an INEQUALITY and would accept any basis
    // billing up to 32 − 3.1416 ≈ 28.86 m²; this test pins the VALUE at 24.
    let m25_certified_cut = std::f64::consts::PI * 2.0 * 2.0 / 4.0;
    let true_overhang = unclipped - clipped;
    assert!(
        m25_certified_cut < true_overhang - 1.0,
        "M25 certifies {m25_certified_cut:.4} m² and the real overhang is \
         {true_overhang:.4} m² — if those ever coincide, the population conjunct \
         has become as strong as this test and one of the two is redundant"
    );
}

/// **The E5 repro, stated as the VALUE the population conjunct can only bound.**
///
/// M26 is an equality over 1 205 states, but every one of its terms comes off
/// the delivered rows; the numbers themselves are pinned here, on the one zone
/// this defect was found on, from the fixture's own geometry.
///
/// `F1` unedited — no edit, no mutation — zone 244 "Open Workspace (2)" is a
/// 35.0 m² Workspace `Rect` that the basis bills at 8.0 m², because the rooms
/// laid over it are carved out of it. Before this change the delivered row read
/// **8.0 m² · 5 pax**: five workstations at 6 m² each, on a row that says the
/// room has eight. It is the same zone id and the same fixture as the 35.0-vs-8.0
/// area divergence `export/publishedArea.test.mjs` was built for — the defect
/// simply had a second column nobody had looked at.
///
/// The raw-shape estimate is asserted UNCHANGED, because the generator and the
/// scorer still read it and moving them would move
/// `golden_generate_output_is_frozen` without correcting a published figure.
#[test]
fn the_published_seat_count_reads_the_area_the_row_bills() {
    // RE-PLANTED (W4). The original pin rode F1's zone 244 — a 35 m² Workspace
    // whose basis was 8 m² because rooms were carved out of it. The W4
    // workspace-trim stopped the generator emitting field zones over their own
    // rooms, so that population no longer arises from generation — a strict
    // improvement that would have left this E5 guard riding a vanished
    // fixture. The state is still REAL (any user-drawn workspace over
    // existing rooms produces it), so it is planted the way fixtures.rs
    // plants unconformed states: push the zone directly and re-bucket.
    let mut doc = fixtures::build("F1").expect("F1 builds");
    // A 7×5 = 35 m² Workspace laid over an existing enclosed room, sized so
    // the SHAPE estimate (floor(35/6) = 5) and the BASIS capacity disagree.
    let (rx, ry, room_area) = doc
        .zones
        .iter()
        .find(|z| z.zone_type == ZoneType::ClosedOffice || z.zone_type == ZoneType::Meeting)
        .map(|z| {
            let (x0, y0, x1, y1) = z.shape.bbox();
            ((x0 + x1) / 2.0, (y0 + y1) / 2.0, z.shape.area())
        })
        .expect("F1 carries an enclosed room");
    assert!(room_area > 3.0, "the carve must be material, room is {room_area:.2} m²");
    let id = doc.alloc_id();
    doc.zones.push(crate::zone::Zone {
        id,
        zone_type: ZoneType::Workspace,
        shape: ZoneShape::Rect { x: rx, y: ry, w: 7.0, h: 5.0 },
        label: "Planted Workspace".into(),
        origin: crate::zone::ZoneOrigin::Drawn,
        component_ids: Vec::new(),
        group: None,
    });
    doc.reassign_components();
    let i = doc.zones.iter().position(|z| z.id == id).unwrap();
    let z = &doc.zones[i];

    // The RAW shape — 35 m², and exactly what the ordering estimate reads.
    assert!((z.area() - 35.0).abs() < 1e-6, "the shape is {:.6} m²", z.area());
    assert_eq!(
        z.seat_estimate_for_ordering(),
        5,
        "the generation/ranking estimate is deliberately untouched by this change"
    );

    // The basis — the shape MINUS the room carved out of it (plus any other
    // non-Workspace floor it overlaps), and what BOTH surfaces bill.
    let basis_area = crate::area_basis(&doc).areas[i];
    assert!(
        basis_area < z.area() - room_area + 1e-6,
        "the basis ({basis_area:.3}) must carve out at least the {room_area:.3} m² room"
    );
    let basis_cap = z.capacity_from_area(basis_area);
    assert!(
        basis_cap < 5,
        "capacity {basis_cap} from a {basis_area:.3} m² basis — the carve must be visible in \
         the published seat count or this test cannot see E5"
    );

    let rooms = crate::quantity::quantities(&doc).rooms;
    let r = rooms.iter().find(|r| r.room_id == id).expect("the takeoff bills the planted zone");
    assert!((r.area_m2 - basis_area).abs() < 1e-9);
    assert_eq!(r.capacity, basis_cap, "the workbook must bill the basis, not the 35 m² shape");

    let rows = crate::Editor::for_test(doc.clone()).zone_rows_for_test(false);
    let row = rows.iter().find(|r| r.id == id).expect("the panel bills the planted zone");
    assert!((row.area - basis_area).abs() < 1e-9);
    assert_eq!(row.capacity, basis_cap, "the canvas tag must read the basis capacity");

    // And the correction is not cosmetic at the plan level: the published
    // takeoff seat total sits BELOW the raw shape-estimate total by at least
    // the seats the carve removed from the planted zone alone.
    let published: u32 = rooms.iter().map(|r| r.capacity).sum();
    let raw: u32 = doc.zones.iter().map(|z| z.seat_estimate_for_ordering()).sum();
    assert!(
        raw >= published + (5 - basis_cap),
        "raw {raw} vs published {published} — the shape-vs-basis divergence vanished"
    );
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
/// 1 200 metric evaluations, plus the five unedited fixtures, all deterministic.
/// The point is not coverage of every sequence — it is that the invariants are
/// stated over the *class* of edited documents rather than over the five states
/// somebody thought of.
///
/// **What this test is NOT any more: the whole grade.** It is one assertion —
/// "nothing violated" — over a population whose composition is asserted by
/// `the_battery_reaches_*`, whose conjuncts are enumerated by
/// `every_conjunct_is_declared_graded_and_reached`, and whose surface coverage
/// is enumerated by `every_published_wasm_surface_is_exercised_or_exempt`. It
/// used to be all four at once, which is how two tautologies sat inside it
/// through four audits.
#[test]
fn metrics_can_never_be_impossible() {
    let led = battery_union();
    assert_eq!(
        led.evaluations,
        1205,
        "the battery must actually run: 1 200 edited states + 5 unedited fixtures"
    );
    assert!(led.v.is_empty(), "{:?}", led.v);
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

    // PLANT the over-cover. F4 used to carry it naturally (Σ 953.030 over a
    // 930.063 floor); the W4 workspace-trim made the generated partition tile
    // without that overlap, so the state this test exists for stopped arising
    // from generation — a strict improvement in the product that would have
    // left this guard vacuous. The population is still REAL (any restored
    // pre-trim .dsource, any user resize) and is planted the way fixtures.rs
    // plants F3/F4's unconformed states: write the shape directly, then
    // re-bucket, bypassing conform-on-edit exactly as `restore` does.
    if let Some(z) = doc.zones.iter_mut().max_by(|a, b| {
        a.shape.area().partial_cmp(&b.shape.area()).unwrap_or(std::cmp::Ordering::Equal)
    }) {
        if let ZoneShape::Rect { w, h, .. } = &mut z.shape {
            *w *= 1.3;
            *h *= 1.3;
        } else {
            panic!("F4's largest zone is no longer a Rect — replant the over-cover");
        }
    }
    doc.reassign_components();

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

/// **The plate defect on a document that never stopped tracing.**
///
/// The first report of F1 read "confined to `plate_state: unresolved`" — true of
/// all 545 battery states that reproduced it, and **retracted inside the report
/// that made it**. This is the state that retracted it, and it is the reason
/// this file's `f3_plate_collapse` repro was not sufficient on its own: F3's
/// envelope is BROKEN, so the panel at least says `"unresolved"` and a careful
/// consumer is warned. Here nothing is broken.
///
/// A DWG import of a floor in a multi-tenant slab carries the neighbouring
/// tenancy's outline — or an atrium void, or a lightwell — as a second, disjoint
/// closed loop. Our tenancy is 20 x 15 = 300 m² and holds every desk; the
/// neighbour is 50 x 40 = 2 000 m² and holds nothing. Anchor containment picks
/// ours. Largest-wins picks theirs.
///
/// Measured at `8adfb0d`, with the scorer on largest-wins: `density_score`
/// **0.000/100** on a plan the panel scores 100, from a floor 6.67x too big —
/// with `plate_state "traced"` and `metrics_error: None`. **No warning existed
/// anywhere**, because nothing was in an error state: the document is perfectly
/// well-formed and two readers simply disagreed about which building it is.
#[test]
fn a_disjoint_neighbouring_loop_is_not_this_plans_floor() {
    let mut doc = Document::new();
    let push_loop = |d: &mut Document, x0: f64, y0: f64, x1: f64, y1: f64| {
        let c = [(x0, y0), (x1, y0), (x1, y1), (x0, y1)];
        for i in 0..4 {
            let id = d.alloc_id();
            d.walls.push(crate::model::Wall {
                id,
                a: crate::geometry::Point::new(c[i].0, c[i].1),
                b: crate::geometry::Point::new(c[(i + 1) % 4].0, c[(i + 1) % 4].1),
                thickness: 0.2,
                generated: false,
                glazing: false,
                height_m: None,
            });
        }
    };
    push_loop(&mut doc, 0.0, 0.0, 20.0, 15.0); // this tenancy: 300 m²
    push_loop(&mut doc, 100.0, 0.0, 150.0, 40.0); // the neighbour: 2 000 m², disjoint
    for i in 0..30 {
        let id = doc.alloc_id();
        doc.components.push(crate::model::Component {
            id,
            category: "Desk".into(),
            x: 2.0 + (i % 6) as f64 * 3.0,
            y: 2.0 + (i / 6) as f64 * 2.5,
            w: 1.6,
            h: 0.8,
            rotation: 0.0,
            mirror: false,
            reference: false,
            label: String::new(),
            product_id: None,
            price_inr: None,
            seats: 1,
            decision: crate::model::DecisionState::Open,
        });
    }

    // The state is what it claims to be: TWO closed faces, the larger holding no
    // part of the plan, and the document reporting itself perfectly healthy.
    let segs: Vec<_> = doc.walls.iter().map(|w| (w.a, w.b)).collect();
    let faces = crate::geometry::trace_floor_faces(&segs, crate::geometry::LOOP_SNAP_TOL);
    let areas: Vec<f64> =
        faces.iter().map(|f| crate::geometry::polygon_area(f).abs()).collect();
    assert!(
        (areas[0] - 2000.0).abs() < 1.0,
        "the LARGEST face must be the neighbour's 2 000 m², or this is not the \
         state; faces are {areas:?}"
    );
    assert!(
        areas.iter().any(|a| (a - 300.0).abs() < 1.0),
        "and one face must be this tenancy's 300 m²; faces are {areas:?}"
    );
    let m = compute_metrics(&doc);
    assert_eq!(m.plate_state, "traced", "nothing here is broken — that is the point");
    assert!(m.metrics_error.is_none(), "and nothing reports an error: {:?}", m.metrics_error);
    assert!((m.floor_area - 300.0).abs() < 1.0, "the panel bills {:.2} m²", m.floor_area);

    // The scorer divides by the same 300 m², not the neighbour's 2 000.
    let ls = crate::layout::score(&doc, &battery_program());
    assert!(
        (ls.floor_area_m2 - 300.0).abs() < 1.0,
        "the scorer divided by {:.2} m² — the neighbouring tenancy's floor",
        ls.floor_area_m2
    );
    assert_eq!(ls.plate_state, "traced");

    // …and the verdict it reaches is the plan's, not the neighbour's. 300 m² over
    // 30 seats is 10 m²/seat, dead centre of the professional 8-12 band.
    let d = crate::Editor::for_test(doc.clone()).density_score();
    assert_eq!(
        d,
        Some(100.0),
        "density_score is {d:?}; on the neighbour's 2 000 m² it is 66.7 m²/seat and \
         scores 0.000/100 — a maximally bad verdict on a textbook-dense plan"
    );
}
