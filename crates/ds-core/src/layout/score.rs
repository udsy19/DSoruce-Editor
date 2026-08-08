//! The objective function: `LayoutScore`, its sub-scores, and the weighted
//! total the autonomous generate → evaluate → optimize loop maximises.

use super::*;

/// The density sub-score for a document — the scoring engine's ONE opinion of
/// whether a plan is professionally dense, so nothing outside this module gets
/// to hold a second one. Floor area is `Document::plate_polygon`'s area, the
/// same plate the panel bills (identical to the bbox for rectangular rooms);
/// `Document::floor_area`'s bounding-box fallback only when the plate does not
/// resolve, or an L-plate's density would be diluted by its void notch.
/// Total SEATS = workstations + meeting/collab capacity (the report's KPI), so
/// density measures people-per-area the way a consultant reads it, not desk
/// footprint coverage (which rewarded cramming). 0 when there is nothing to
/// judge.
pub fn density_of_doc(doc: &Document) -> f64 {
    density_of(doc, doc.plate_polygon().as_deref())
}

/// See [`density_of_doc`] — this form takes an already-traced plate so `score`
/// does not trace the same polygon twice.
pub fn density_of(doc: &Document, plate_poly: Option<&[Point]>) -> f64 {
    let floor = plate_poly
        .map(geometry::polygon_area)
        .unwrap_or_else(|| doc.floor_area());
    let meeting_seats: f64 = doc
        .zones
        .iter()
        .filter(|z| matches!(z.zone_type, ZoneType::Meeting | ZoneType::Collaboration))
        .map(|z| z.seat_estimate_for_ordering() as f64)
        .sum();
    let seats =
        doc.components.iter().filter(|c| c.category == "Desk").count() as f64 + meeting_seats;
    if floor <= 0.0 || seats <= 0.0 {
        0.0
    } else {
        density_score(floor / seats)
    }
}


/// Weighted objective breakdown. All sub-scores are 0..100; `total` is the
/// weight-normalised blend. Serialize so the frontend metrics panel and the
/// optimizer loop read the exact same numbers a human judges by.
#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct LayoutScore {
    pub capacity: f64,
    pub adjacency: f64,
    pub circulation: f64,
    pub density: f64,
    /// Delivered vs derived room program, 0..100 (spec §1.1 / M5-prep). 100
    /// when every requested room (meetings + support spaces) got placed; a
    /// shortfall on a wall-dense plate shows here instead of being silent.
    pub program_fit: f64,
    /// % of workstations within `DAYLIGHT_REACH_M` of the facade (plate
    /// boundary) — qbiq's daylight sub-score (spec §5). 100 when every desk sits
    /// near a window, low when desks are buried in the deep plan.
    pub daylight: f64,
    /// Entry narrative, 0..100: reception nearer the entry than the pantry
    /// (spec §3). 100 (neutral) when the plate carries no entry to judge against.
    pub entry_adjacency: f64,
    pub total: f64,
    /// desks actually placed (diagnostic for the loop's "which sub-score is weak")
    pub placed_desks: u32,
    /// Points deducted from `total` for floor the plan wastes: 10 × the
    /// `Unassigned` share of the plate. Surfaced so the autonomous loop can say
    /// WHICH term cost a candidate its rank, rather than only that it lost.
    pub unassigned_penalty: f64,
    /// **The floor every plate-derived term above divided by**, m² — one number,
    /// published so the two readers of the plate can be held to each other.
    ///
    /// It is `Document::floor_area()` and nothing else. It is surfaced because
    /// the scorer held a SECOND plate for four belief passes: `score` traced its
    /// own polygon with the retired largest-closed-loop rule while the panel used
    /// anchor containment, they disagreed on 545 of 1 200 mutated states, and
    /// nothing could see it because the scorer never said which floor it used.
    /// `CirculationScore::floor_area` already publishes the same quantity for the
    /// same reason. Graded against the panel by `S17`.
    pub floor_area_m2: f64,
    /// **Whether the numbers above are a measurement.** `"traced"` · `"open"` ·
    /// `"unresolved"` — the same three tags, from the same owner
    /// (`document::PlateResolution::tag`), that `Metrics::plate_state` carries.
    ///
    /// `adjacency`, `density`, `daylight`, `program_fit` and
    /// `unassigned_penalty` — and through them `total` — are all measured on the
    /// floor plate. When the plate is `"unresolved"` the floor is a bounding-box
    /// stand-in, so every one of them is a number derived from a fallback rather
    /// than from the building; a consumer that shows a user a score, or hands one
    /// to an LLM, must be able to tell that apart from a bad layout. It is the
    /// same branch `Metrics::plate_state` exists for, on the same document, and
    /// deliberately not a second convention.
    pub plate_state: &'static str,
    /// Did `generate` actually produce a plan?
    ///
    /// False when nothing was placed at all — no desks, no rooms, no zones.
    /// That is a FAILED generation, not a low-scoring one, and it must be
    /// distinguishable by the caller without inspecting document state.
    ///
    /// It exists because several sub-scores are computed over populations that
    /// are empty in exactly that case, and an empty population has no
    /// violations: a plan containing nothing scored `adjacency` 100,
    /// `daylight` 100 and `entry_adjacency` 100, for a `total` of 38.7 — and an
    /// empty 78 m² plate scored 90.5 on circulation, HIGHER than a populated
    /// 930 m² plate with 104 real desks and real corridors. Emptiness was being
    /// scored as perfection, and the wizard then offered the user three scored
    /// candidates for a document with nothing in it.
    pub feasible: bool,
}

// ---- M5: professional scoring (spec §5) ----

/// A workstation this far (m) or nearer to the facade (plate boundary) counts as
/// daylit — matches the report's DAYLIGHT_RADIUS_M so the Rust sub-score and the
/// exported KPI agree on which desks see a window.
pub(crate) const DAYLIGHT_REACH_M: f64 = 5.0;

/// Professional density sub-score from NIA m² per person (spec §5). Peaks (100)
/// across the BCO/NBC professional band **8–12 m²/person** (10 is the design
/// occupancy) and tapers to 0 on BOTH sides: too CRAMMED (fewer m²/person, 0 at
/// ≤4.5) and too SPARSE (more m²/person, 0 at ≥20). This REPLACES the old
/// desk-area/floor 30–55% band, which peaked at ~2.3 m²/desk — literally
/// steering the optimizer toward unprofessional cramming (spec gap #7).
pub(crate) fn density_score(m2_per_person: f64) -> f64 {
    if m2_per_person < 8.0 {
        ((m2_per_person - 4.5) / (8.0 - 4.5) * 100.0).clamp(0.0, 100.0)
    } else if m2_per_person <= 12.0 {
        100.0
    } else {
        ((20.0 - m2_per_person) / (20.0 - 12.0) * 100.0).clamp(0.0, 100.0)
    }
}

/// Centroid of a zone (its bbox center).
pub(crate) fn zone_bbox_center(z: &Zone) -> (f64, f64) {
    let (x0, y0, x1, y1) = z.shape.bbox();
    ((x0 + x1) / 2.0, (y0 + y1) / 2.0)
}

/// Shortest distance from a point to the plate boundary (facade). 0 when the
/// walls don't close a loop.
pub(crate) fn dist_to_facade(px: f64, py: f64, poly: Option<&[Point]>) -> f64 {
    let Some(poly) = poly else { return 0.0 };
    (0..poly.len())
        .map(|i| {
            let a = poly[i];
            let b = poly[(i + 1) % poly.len()];
            geometry::point_segment_dist(Point::new(px, py), a, b)
        })
        .fold(f64::INFINITY, f64::min)
}

/// RELATIONSHIP adjacency (0..100): how well the plan honours senior-planner
/// space relationships beyond desk pitch (spec §3 / the "smart" adjacency model,
/// docs/design/testfit-pro-quality.md). Averages the APPLICABLE checks:
///   - meeting/conference rooms CLUSTER near the entry (client-facing),
///   - focus rooms sit toward the FACADE (daylit / calm),
///   - the pantry is a CENTRAL social node,
///   - IT / storage sit toward the INTERIOR (near the building core).
/// Returns `None` when the plate offers nothing to judge (no rooms, or open
/// walls with no entry) — the caller then falls back to pure desk coherence.
/// Deterministic; a pure read of the document geometry.
pub(crate) fn relationship_adjacency(doc: &Document, poly: Option<&[Point]>, entry: Option<Point>) -> Option<f64> {
    // Plate bbox → centroid + diagonal, the intrinsic length scale the checks
    // normalise against (so a big plate isn't unfairly penalised).
    let (bx0, by0, bx1, by1) = doc.wall_bbox()?;
    let (cx, cy) = ((bx0 + bx1) / 2.0, (by0 + by1) / 2.0);
    let diag = ((bx1 - bx0).powi(2) + (by1 - by0).powi(2)).sqrt().max(1e-6);

    let centers = |pred: &dyn Fn(&Zone) -> bool| -> Vec<(f64, f64)> {
        doc.zones.iter().filter(|z| pred(z)).map(zone_bbox_center).collect()
    };
    let meetings = centers(&|z| z.zone_type == ZoneType::Meeting);
    let focus = centers(&|z| z.label.starts_with("Focus"));
    let pantry = centers(&|z| z.label.starts_with("Pantry"));
    let it_store = centers(&|z| z.label.starts_with("IT") || z.label.starts_with("Storage"));

    let mut sum = 0.0;
    let mut n = 0u32;
    let avg = |v: &[(f64, f64)], f: &dyn Fn(f64, f64) -> f64| -> f64 {
        v.iter().map(|&(x, y)| f(x, y)).sum::<f64>() / v.len() as f64
    };

    // (1) Meetings near the entry. Reference = the entry→centroid distance: a
    // meeting AT the entry scores 100, one at 2× that reference scores 0.
    if let Some(e) = entry {
        if !meetings.is_empty() {
            let d_ref = (((cx - e.x).powi(2) + (cy - e.y).powi(2)).sqrt()).max(1e-6);
            let d_m = avg(&meetings, &|x, y| ((x - e.x).powi(2) + (y - e.y).powi(2)).sqrt());
            sum += (100.0 * (2.0 * d_ref - d_m) / (2.0 * d_ref)).clamp(0.0, 100.0);
            n += 1;
        }
    }
    // (2) Focus rooms toward the facade (within ~DAYLIGHT_REACH_M → full marks).
    if !focus.is_empty() && poly.is_some() {
        let d_f = avg(&focus, &|x, y| dist_to_facade(x, y, poly));
        sum += (100.0 * (1.5 * DAYLIGHT_REACH_M - d_f) / (1.5 * DAYLIGHT_REACH_M)).clamp(0.0, 100.0);
        n += 1;
    }
    // (3) Pantry central: near the plate centroid (a social node the whole floor
    // reaches). At the centroid → 100, at half the diagonal away → 0.
    if !pantry.is_empty() {
        let d_p = avg(&pantry, &|x, y| ((x - cx).powi(2) + (y - cy).powi(2)).sqrt());
        sum += (100.0 * (1.0 - d_p / (0.5 * diag))).clamp(0.0, 100.0);
        n += 1;
    }
    // (4) IT / storage toward the interior (away from the facade → near the core).
    if !it_store.is_empty() && poly.is_some() {
        let d_i = avg(&it_store, &|x, y| dist_to_facade(x, y, poly));
        sum += (100.0 * (d_i / 4.0)).clamp(0.0, 100.0);
        n += 1;
    }

    if n == 0 {
        None
    } else {
        Some(sum / n as f64)
    }
}

/// Score a layout against the program. Sub-scores are 0..100; `total` is the
/// weight-normalised blend (design §3). This is the deterministic evaluator that
/// drives the generate→evaluate→optimize loop.
pub fn score(doc: &Document, program: &Program) -> LayoutScore {
    let desks: Vec<&Component> = doc
        .components
        .iter()
        .filter(|c| c.category == "Desk")
        .collect();
    let placed_desks = desks.len() as u32;

    // The plate polygon is resolved ONCE and reused by the adjacency (facade
    // relationships), density, daylight, program_fit and wasted-floor terms.
    //
    // **It is `Document::plate_polygon`, and the scorer holds no second opinion
    // about which face is the floor.** This used to be
    // `geometry::trace_floor_polygon` — largest-closed-loop — which
    // `plate_polygon`'s own doc comment records as a retired defect: the rule is
    // right only while the envelope's loop is closed, and one user gesture breaks
    // that. Routing the panel to anchor containment and leaving the scorer on
    // largest-wins gave one document two floors. Measured over the mutation
    // battery: they disagreed on **545 of 1 200** states (45.42%), and on the
    // unedited F3 fixture the scorer divided by a **1.20 m² scratch box** where
    // the document's floor is 1 594.94 m² — `density 0.000/100` against
    // 68.757/100, and an `unassigned_penalty` of **969.2178** on a term whose own
    // comment sizes it at ~1.8 points, clamping every candidate's `total` to 0
    // and blinding `autoGenerate`'s seed search. It is not confined to a broken
    // envelope: a DISJOINT neighbouring loop (an adjacent tenancy or atrium void
    // in an imported DWG) does it on a fully `"traced"` document, with no
    // `plate_state` warning and no `metrics_error` — see
    // `a_disjoint_neighbouring_loop_is_not_this_plans_floor`.
    let plate_poly = doc.plate_polygon();

    // --- capacity: fraction of requested desks actually seated ---
    let capacity = if program.desks == 0 {
        100.0
    } else {
        (100.0 * placed_desks as f64 / program.desks as f64).min(100.0)
    };

    // --- adjacency: desk-cluster coherence BLENDED with relationship adjacency ---
    // (1) Desk coherence: nearest-neighbour pitch ratio (tight benches read as
    // coherent clusters, not scattered desks).
    let ideal_pitch = ((program.desk_w + program.desk_clearance_m)
        .min(program.desk_h + program.desk_clearance_m))
    .max(1e-6);
    let desk_coherence = if desks.len() < 2 {
        100.0
    } else {
        let mut sum_nn = 0.0;
        for (i, a) in desks.iter().enumerate() {
            let mut best = f64::INFINITY;
            for (j, b) in desks.iter().enumerate() {
                if i == j {
                    continue;
                }
                let d = ((a.x - b.x).powi(2) + (a.y - b.y).powi(2)).sqrt();
                if d < best {
                    best = d;
                }
            }
            sum_nn += best;
        }
        let avg_nn = sum_nn / desks.len() as f64;
        // avg_nn == ideal_pitch → 100; larger spacing → lower.
        (100.0 * ideal_pitch / avg_nn.max(1e-6)).min(100.0)
    };
    // (2) Relationship adjacency (meeting↔entry, focus↔facade, pantry central,
    // IT↔core). Blended in when the plate offers relationships to judge; the
    // desk-coherence term keeps the sub-score meaningful for a bare open plan.
    let adjacency = match relationship_adjacency(doc, plate_poly.as_deref(), doc.entries.first().copied()) {
        Some(rel) => 0.45 * desk_coherence + 0.55 * rel,
        None => desk_coherence,
    };

    // --- density: peak at the professional 8–12 m²/person band (spec §5) ---
    // The whole verdict lives in `density_of` so the scorer and every consumer
    // outside this crate (the wasm `Editor::density_score`, and through it the
    // AI consequence preview) read ONE opinion of what a dense plan is.
    let density = density_of(doc, plate_poly.as_deref());
    // The plate's true floor area — also what the support-space program sizes to.
    let floor = plate_poly
        .as_deref()
        .map(geometry::polygon_area)
        .unwrap_or_else(|| doc.floor_area());

    // --- circulation: the teammate-owned "walking place" evaluator ---
    // `crates/ds-core/src/circulation.rs::evaluate(doc, &CirculationConfig)`
    // returns a `CirculationScore` whose `.score` is the 0..100 headline. We feed
    // the program's target corridor width through so the corridor the generator
    // reserves is the same width the evaluator measures against.
    // (See docs/design/autonomous-testfit-loop.md §3.)
    let mut circ_cfg = CirculationConfig::default();
    circ_cfg.target_corridor_width = program.target_corridor_m;
    let circulation = circulation::evaluate(doc, &circ_cfg).score;

    // --- program_fit: delivered vs derived room program (spec 1.1) ---
    // Every placed room emits exactly one typed zone (Meeting / ClosedOffice /
    // Amenity / Collaboration); the derived target is the meeting override plus
    // the support program the same headcount derives. A shortfall on a
    // wall-dense plate surfaces here instead of being silently dropped.
    let placed_rooms = doc
        .zones
        .iter()
        .filter(|z| {
            matches!(
                z.zone_type,
                ZoneType::Meeting
                    | ZoneType::ClosedOffice
                    | ZoneType::Amenity
                    | ZoneType::Collaboration
            )
        })
        .count() as u32;
    // Derived target + the anchor "bump": for each anchored kind, the rooms its
    // pins ADD beyond the free supply (anchored − supply, floored at 0). Folding
    // it into the denominator keeps `program_fit` honest — a bumped pin that fits
    // nowhere shows as a shortfall instead of vanishing (workflow.md §3.5).
    let support = support_jobs(program, floor);
    let free_of = |k: SpaceKind| -> u32 {
        let s = support.iter().filter(|j| j.kind == k).count() as u32;
        if k == SpaceKind::Meeting { s + program.meeting_rooms } else { s }
    };
    let mut anchor_bump = 0u32;
    let mut seen: Vec<SpaceKind> = Vec::new();
    for a in &doc.anchors {
        if seen.contains(&a.kind) {
            continue;
        }
        seen.push(a.kind);
        let anchored_k = doc.anchors.iter().filter(|b| b.kind == a.kind).count() as u32;
        anchor_bump += anchored_k.saturating_sub(free_of(a.kind));
    }
    let derived_rooms = program.meeting_rooms + support.len() as u32 + anchor_bump;
    let program_fit = if derived_rooms == 0 {
        100.0
    } else {
        (100.0 * placed_rooms as f64 / derived_rooms as f64).min(100.0)
    };

    // --- daylight: % of workstations within reach of the facade (spec §5) ---
    // qbiq's published daylight metric: real plans put desks at the windows.
    // A desk is daylit when its center is within DAYLIGHT_REACH_M of any plate
    // boundary edge. No plate loop (open walls) → neutral 100 (nothing to fault).
    let daylight = if desks.is_empty() {
        100.0
    } else if let Some(poly) = plate_poly.as_deref() {
        let near = desks
            .iter()
            .filter(|c| {
                (0..poly.len()).any(|i| {
                    let a = poly[i];
                    let b = poly[(i + 1) % poly.len()];
                    geometry::point_segment_dist(Point::new(c.x, c.y), a, b) <= DAYLIGHT_REACH_M
                })
            })
            .count();
        100.0 * near as f64 / desks.len() as f64
    } else {
        100.0
    };

    // --- entry_adjacency: reception near the entry, pantry far (spec §3) ---
    // The plan's "enter → reception → spine → pantry" narrative. Neutral 100
    // when the plate carries no entry to judge against.
    let entry_adjacency = match doc.entries.first() {
        None => 100.0,
        Some(e) => {
            let dist_to = |label: &str| {
                doc.zones.iter().find(|z| z.label == label).map(|z| {
                    let (x0, y0, x1, y1) = z.shape.bbox();
                    (((x0 + x1) / 2.0 - e.x).powi(2) + ((y0 + y1) / 2.0 - e.y).powi(2)).sqrt()
                })
            };
            match (dist_to("Reception"), dist_to("Pantry")) {
                // 100 when reception hugs the door and the pantry is the far
                // social anchor; 50 when they are equidistant; →0 if inverted.
                (Some(dr), Some(dp)) if dr + dp > 1e-6 => {
                    (100.0 * dp / (dr + dp)).clamp(0.0, 100.0)
                }
                (Some(_), Some(_)) => 100.0,
                (Some(_), None) | (None, Some(_)) => 60.0,
                (None, None) => 50.0,
            }
        }
    };

    // --- weighted total ---
    // The strategy re-weights the objective so the seed search WITHIN a strategy
    // optimises for its priorities (Open → capacity/density; Cellular →
    // program-fit/entry). Balanced's bias is the identity, so `total` is
    // byte-unchanged for every pre-M7 (Balanced) program.
    let bias = program.strategy.weight_bias();
    let wc = program.w_capacity * bias.capacity;
    let wa = program.w_adjacency * bias.adjacency;
    let wr = program.w_circulation * bias.circulation;
    let wd = program.w_density * bias.density;
    let wp = program.w_program * bias.program;
    let wl = program.w_daylight * bias.daylight;
    let we = program.w_entry * bias.entry;
    let wsum = (wc + wa + wr + wd + wp + wl + we).max(1e-6);

    // --- wasted floor: the penalty that makes the search prefer honest plans ---
    //
    // PRE-REGISTERED in the Phase 0 audit (§F) before this code existed:
    // `0.10 × (unassigned_m² / plate_m²) × 100` points, i.e. **10 points per
    // unit of wasted-floor fraction**, subtracted from the weighted total. On
    // the reference plate (~170 m² of 930) that is ~1.8 points — enough to break
    // a tie toward the plan that wastes less floor, deliberately NOT enough to
    // reorder candidates separated by more than that.
    //
    // **That sizing is now enforced, because it was not true and nothing said
    // so.** Measured over the mutation battery at `8adfb0d`: 969.2178 points on
    // the unedited F3 fixture (the scorer's own plate was a 1.20 m² scratch box)
    // and 15.2783 on a correctly-traced 930.06 m² plate (the numerator
    // double-counted an overlapping hand-drawn zone). A debit of 969 on a 0..100
    // scale does not "break a tie"; it clamps every candidate's `total` to zero
    // and blinds `autoGenerate`'s seed search entirely. The term is now a share
    // of the plate by construction on both ends — one plate, one basis — and
    // `S19` in `metrics_tests` grades it inside `[0, 10]` on every state.
    //
    // Subtractive rather than a weighted sub-score on purpose. Every term above
    // is "how good is this plan at X"; waste is not a quality being averaged, it
    // is a debit against whatever the plan otherwise achieved. Folding it into
    // `wsum` would also let a program that zeroes `w_*` weights dilute the
    // penalty to nothing, which is exactly backwards.
    //
    // Before `ZoneType::Unassigned` existed this term could not have been
    // written: wasted floor was labelled `Circulation`, and a search penalising
    // circulation would have penalised real corridors too — the generator would
    // have learned to draw fewer corridors, not to waste less floor.
    //
    // **It is INERT on some plates, and that is correct — do not "fix" it.**
    // Measured on the DXF reference plate, all three strategies (Open/Balanced/
    // Cellular) scored an identical penalty of 0.693129690346807, to fifteen
    // decimal places, despite placing 101 / 98 / 84 desks. That is not a bug: the
    // leftover there is the same set of unfurnished wings whatever the strategy
    // does with the middle of the floor, so the term correctly contributes
    // nothing to choosing between them.
    //
    // The term is live where strategies genuinely differ in waste — on the
    // fixture plate it ranges 171.3 m² (seed 1) to 195.0 m² (seed 4), a spread
    // of ~0.3 points. A future reader finding it constant on one plate is
    // looking at a property of that plate, not a broken constant.
    //
    // **The numerator is `crate::unassigned_area` over the shared
    // `crate::area_basis`, not a sum this module computes.** It used to be
    // `doc.zones … .map(|z| z.area_on(plate_poly))` — the raw, un-de-overlapped,
    // uncapped clip — and that read carried a REGISTERED EXEMPTION whose stated
    // ground was that the number is "not a published area and never billed … a
    // relative penalty compared only against itself". True of the area; **false
    // of the number derived from it**: `unassigned_penalty` is a serialized
    // `LayoutScore` field and `total` is an absolute 0..100 shown in the
    // candidate gallery, printed as "best N/100", and handed to the Claude
    // evaluator. The exemption is deleted, by the same route the `cost.rs` entry
    // beside it went: the site now reads the basis, so it is not an exemption any
    // more. See `crate::unassigned_area` for the 11-of-1 205 measurement.
    let unassigned_m2 = crate::unassigned_area(doc, &crate::area_basis(doc).areas);
    let waste_fraction = if floor > 0.0 { unassigned_m2 / floor } else { 0.0 };
    let unassigned_penalty = 10.0 * waste_fraction;

    let total = ((wc * capacity
        + wa * adjacency
        + wr * circulation
        + wd * density
        + wp * program_fit
        + wl * daylight
        + we * entry_adjacency)
        / wsum
        - unassigned_penalty)
        .clamp(0.0, 100.0);

    // Nothing placed at all → a failed generation. Every sub-score above that
    // divides by an empty population returned its maximum, so report the
    // failure instead of a flattering blend of vacuous perfect scores. The
    // three affected sub-scores are zeroed rather than left at 100 so a caller
    // reading them individually cannot be misled either.
    //
    // Conditioned on document state, not on a generator flag: a flag can be
    // dropped, and an empty document cannot lie about being empty.
    let feasible = placed_desks > 0 || !doc.zones.is_empty() || !doc.components.is_empty();
    if !feasible {
        return LayoutScore {
            capacity: 0.0,
            adjacency: 0.0,
            circulation,
            density: 0.0,
            program_fit: 0.0,
            daylight: 0.0,
            entry_adjacency: 0.0,
            total: 0.0,
            placed_desks,
            // Nothing was placed, so no floor was "wasted" in the sense this
            // term measures — an empty plate is not a plan that squandered its
            // area, it is the absence of a plan. Reporting a penalty here would
            // imply a plan existed and scored badly.
            unassigned_penalty: 0.0,
            feasible,
            // These two describe the PLATE, not the plan, so they stay honest
            // here. The floor exists and was measured whether or not anything
            // was placed on it, and `plate_state` says whether that measurement
            // came from traced walls or a bounding-box stand-in. Zeroing them
            // alongside the scores would lose the one piece of information that
            // distinguishes "we could not read the drawing" from "we read it and
            // placed nothing" — which is exactly the distinction `feasible` was
            // added to make.
            floor_area_m2: floor,
            plate_state: doc.plate_resolution().tag(),
        };
    }

    LayoutScore {
        capacity,
        adjacency,
        circulation,
        density,
        program_fit,
        daylight,
        entry_adjacency,
        total,
        placed_desks,
        unassigned_penalty,
        floor_area_m2: floor,
        plate_state: doc.plate_resolution().tag(),
        feasible,
    }
}
