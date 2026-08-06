//! Autonomous test-fit layout generator (v1) + objective function.
//!
//! This is Stage 3 ("Generate") of the pipeline in
//! `research/07-synthesis-and-proposed-pipeline.md`, and the deterministic
//! heuristic engine (`research/06 §1`) at the base of the
//! generate → evaluate → optimize loop documented in
//! `docs/design/autonomous-testfit-loop.md`.
//!
//! Strategy: carve the wall bounding box into a perimeter circulation corridor,
//! a meeting-room band, and a grid-packed desk zone with clearance aisles. The
//! generator is a **pure function of (program, seed)** so runs are reproducible
//! and the optimizer can re-roll by bumping the seed. Constraints (perimeter
//! corridor + per-desk clearance) hold *by construction*.
//!
//! Standards used for the defaults / clearances:
//!   - perimeter/primary circulation 0.9–1.2 m (IBC 2024 §1020.3 ≈ 1.118 m min):
//!     https://arcedior.com/blog/open-office-layout-standards-clearances-2025
//!   - workstation clearances:
//!     https://www.dimensions.com/element/office-workstation-clearances
//!   - ~5.5–6.5 m² per workstation, 40–50 % of floor to desks:
//!     https://www.factoryoficina.com/gb/blog/office-space-planning-how-many-workstations-fit-per-m-quick-rule-templates.html
//! Evaluator-optimizer loop pattern this scoring feeds:
//!     https://github.com/anthropics/anthropic-cookbook/blob/main/patterns/agents/evaluator_optimizer.ipynb
//!
//! ## Where the pipeline lives
//!
//! This file is the ORCHESTRATOR: [`generate`] reads the plate, draws the seeded
//! choices, and drives the stages below in order. Each stage is a submodule:
//!
//! | module     | stage                                                          |
//! |------------|----------------------------------------------------------------|
//! | [`program`]| strategy selection + program derivation (what to place)        |
//! | [`seed`]   | the per-run PRNG, discrete choices, and the global desk lattice |
//! | [`grid`]   | the alignment module + the shared slot-feasibility predicates   |
//! | [`regions`]| plate → wings, corridor network, band/desk allocation           |
//! | [`jobs`]   | the concrete room list (derived / explicit / anchored)          |
//! | [`place`]  | finding and taking a slot for one room                          |
//! | [`emit`]   | writing components, zones, walls and room shells into the doc   |
//! | [`packing`]| desk packing, axis-aligned and principal-axis oriented          |
//! | [`conform`]| growing zones to the plate boundary, unifying the walking area  |
//! | [`score`]  | the objective function the optimize loop maximises              |
//!
//! `generate` and [`score`] are the only entry points `lib.rs` calls, and their
//! output is frozen by `tests::golden_generate_output_is_frozen` — determinism
//! per seed is a product feature, not an implementation detail.

use crate::circulation::{self, CirculationConfig};
use crate::document::Document;
use crate::geometry::{self, Point};
use crate::model::{Component, DecisionState, Wall};
use crate::zone::{Zone, ZoneOrigin, ZoneShape, ZoneType};
use serde::{Deserialize, Serialize};

mod conform;
mod emit;
mod grid;
mod jobs;
mod packing;
mod place;
mod program;
mod regions;
mod score;
mod seed;

#[cfg(test)]
mod tests;

// Re-export the submodules' items into the `layout` namespace, so the
// generator below (and `lib.rs`, which reaches for `Program` / `SpaceKind` /
// `score`) sees exactly the same names it did when this was one file.
pub(crate) use self::conform::*;
pub(crate) use self::emit::*;
pub(crate) use self::grid::*;
pub(crate) use self::jobs::*;
pub(crate) use self::packing::*;
pub(crate) use self::place::*;
pub(crate) use self::program::*;
pub(crate) use self::regions::*;
pub(crate) use self::score::*;
pub(crate) use self::seed::*;

/// Deterministically generate a test-fit into `doc` for `program`, seeded by `seed`.
///
/// Walls are preserved. When `keep_confirmed` is true, components left `Confirmed`
/// are **frozen** — kept in place and treated as obstacles so newly-placed items
/// pack around them (Laiout-style Freeze/Regenerate, design §4). When false, all
/// components are cleared for a fresh fit. Frozen items count toward the program
/// targets, so regenerating tops the plan up to the requested counts.
///
/// Layout regime (M3+M4, docs/design/testfit-pro-quality.md §1/§3): a
/// non-rectangular plate is decomposed into rectangular regions (wings); a
/// rectangular plate is one region. Every region gets a ROOM BAND backed onto
/// one long edge, a PRIMARY SPINE (1.5 m **drawn** `Circulation` rect, NBC
/// corridor minimum) along the band's face that every room front and door
/// opens onto, and a DESK FIELD on the facade side holding a 0.9 m maintenance
/// gap to the window wall — the old perimeter `RectRing` (which spent the
/// daylight on corridor) is retired. `Document::entries` anchors the network:
/// the entry region gets a connector strip from the entry to its spine, and
/// reception is the first room sliding in from the entry end.
///
/// Rooms = the user's `meeting_rooms` override + (when `support_spaces`) the
/// support program derived from the headcount (spec §1.1). Placement is robust
/// on wall-dense plates: anchors SLIDE along the band in 0.15 m steps, rooms
/// that find no band slot fall back to interior clear pockets (both
/// orientations), and any remaining shortfall is reported honestly through
/// `LayoutScore::program_fit` rather than silently dropped.
pub fn generate(doc: &mut Document, program: &Program, seed: u64, keep_confirmed: bool) {
    // Generated walls (room partitions/glass fronts) are OUTPUT of a previous
    // run: clear them FIRST — and only them, never user-drawn/imported walls —
    // so the plate trace, wall bbox and interior-wall snapshot below see the
    // building envelope, not our own shells. Regeneration is thereby
    // idempotent (verified by `regenerate_replaces_generated_walls…`).
    doc.walls.retain(|w| !w.generated);

    // Snap the program's generator dimensions to the module ONCE, so every
    // pitch and anchor derived from them lands on module lines (§4.1). The
    // UI defaults are already module-aligned; this guards imported programs.
    let program = &{
        let mut p = program.clone();
        p.desk_w = snap_module(p.desk_w);
        p.desk_h = snap_module(p.desk_h);
        p.meeting_w = snap_module(p.meeting_w);
        p.meeting_h = snap_module(p.meeting_h);
        p.target_corridor_m = snap_module(p.target_corridor_m.max(0.0));
        p.desk_clearance_m = snap_module(p.desk_clearance_m.max(0.0));
        p
    };
    // Keep-outs are PERMANENT hard obstacles (the building core: stairs/lifts/
    // shafts/WCs) — always avoided regardless of `keep_confirmed`. They lead the
    // obstacle list so they sit before `frozen_len` (meetings reject slots over
    // them) and before every desk `grid_start` (the full-clearance regime keeps
    // furniture a real aisle away). Held as corner-origin holes for the plate
    // decomposition too, so no region ever spans the core.
    let holes: Vec<geometry::Rect> = doc
        .keepouts
        .iter()
        .map(|k| geometry::Rect {
            x0: k.x - k.w / 2.0,
            y0: k.y - k.h / 2.0,
            x1: k.x + k.w / 2.0,
            y1: k.y + k.h / 2.0,
        })
        .collect();
    // Center + label snapshot for the Core zones emitted at the end (taken now,
    // before `doc` is mutated further).
    let keepout_zones: Vec<(f64, f64, f64, f64, String)> = doc
        .keepouts
        .iter()
        .map(|k| (k.x, k.y, k.w, k.h, k.label.clone()))
        .collect();

    // Freeze: keep Confirmed components, drop the rest. Keep-outs + frozen
    // footprints become obstacles the new placement must avoid.
    let mut obstacles: Vec<(f64, f64, f64, f64)> = Vec::new();
    for k in &doc.keepouts {
        obstacles.push((k.x, k.y, k.w, k.h));
    }
    // Rooms treat keep-outs as abuttable architecture (0.05 m pad) but frozen
    // FURNITURE as needing a full person-clearance — the boundary index between
    // the two obstacle classes.
    let keepout_len = obstacles.len();
    if keep_confirmed {
        doc.components.retain(|c| c.decision == DecisionState::Confirmed);
        for c in &doc.components {
            // World AABB, not local dims — a frozen portrait desk is ±π/2.
            let (ww, wh) = world_extents(c.w, c.h, c.rotation);
            obstacles.push((c.x, c.y, ww, wh));
        }
    } else {
        doc.components.clear();
    }
    // Zones are regenerated wholesale each call (like components), including under
    // keep_confirmed — frozen components are simply re-bucketed into the new zones.
    doc.zones.clear();
    doc.selection = None;
    // Only keep-outs + frozen footprints block new placement. Items placed in
    // this call are laid out on non-overlapping pitches by construction, so they
    // must NOT be checked against each other (their spacing == the overlap
    // threshold, which floating-point rounding would otherwise flag as a collision).
    let frozen_len = obstacles.len();

    let (min_x, min_y, max_x, max_y) = match doc.wall_bbox() {
        Some(b) => b,
        None => return, // no boundary → nothing to place
    };

    // The floor-plate polygon: the largest closed loop through the walls. For a
    // rectangular room it equals the bbox. `None` (open walls) keeps the
    // historical bbox-only behavior.
    let plate = geometry::trace_floor_polygon(&wall_segments(doc), geometry::LOOP_SNAP_TOL);

    // Interior partitions (imported linework, committed CAD sketches) are hard
    // obstacles: nothing may straddle them. Boundary walls are excluded — the
    // plate/corridor inset already handles them. Per-candidate rejection (not
    // decomposition holes) is the v1: exact for diagonal walls, and it applies
    // on the rectangular single-region path too, which never decomposes.
    let iwalls = interior_walls(doc, plate.as_deref(), (min_x, min_y, max_x, max_y));

    let corridor = program.target_corridor_m.max(0.0);
    let clear = program.desk_clearance_m.max(0.0);

    // Frozen items already count toward the program targets, so we only place
    // the remainder. These global counters also number Meeting-Room zone labels.
    // ("MeetingRoom" components are now only legacy frozen pods from pre-M1
    // documents or user-placed catalog pods — generated rooms are walls + zone
    // + Door + Table — but they still count toward the meeting target so old
    // frozen plans don't over-place.)
    let mr_counter = doc.components.iter().filter(|c| c.category == "MeetingRoom").count() as u32;
    let frozen_desks = doc.components.iter().filter(|c| c.category == "Desk").count() as u32;
    let remaining_meetings = program.meeting_rooms.saturating_sub(mr_counter);

    // Regions: only a materially non-rectangular plate is decomposed; a
    // rectangular plate (or open walls) is ONE region. A region must survive
    // its insets with room for at least one desk — 3 m slivers pass a fixed
    // minimum but pack nothing, stealing desk allocation from real wings.
    let bbox_area = (max_x - min_x) * (max_y - min_y);
    let plate_area = plate
        .as_deref()
        .map(geometry::polygon_area)
        .unwrap_or(bbox_area);
    // Desk target scales to the plate at professional density (spec §1): fill
    // the open field to `desk_target` desks, the open-plan share of the design
    // headcount, so a bare plate lands in the 8–12 m²/person band instead of
    // echoing a fixed 24-desk count on any plate size (the field bug).
    let remaining_desks = desk_target(program, plate_area).saturating_sub(frozen_desks);
    let min_dim = REGION_MIN_DIM.max(2.0 * corridor + program.desk_w.min(program.desk_h));
    let mut regions = match &plate {
        Some(poly) if geometry::polygon_area(poly) < 0.98 * bbox_area => {
            geometry::decompose_plate(poly, REGION_CELL, min_dim, REGION_MIN_AREA, &holes)
        }
        _ => Vec::new(),
    };
    // Oriented-field gate: how much of the plate the AXIS-ALIGNED decomposition
    // actually covers (computed from the raw decomposition, BEFORE the
    // single-region bbox fallback below inflates `regions`). A tilted/angular
    // plate leaves most of itself uncovered → drive the desk field with the
    // principal-axis oriented packer so it fills the WHOLE polygon rather than a
    // corner. A rectangle (regions empty only because plate ≈ bbox) and an
    // axis-aligned L/T (near-total coverage) keep the current per-wing path.
    let is_rectangular = match &plate {
        Some(poly) => geometry::polygon_area(poly) >= 0.98 * bbox_area,
        None => true, // open walls → historical bbox behaviour, never oriented
    };
    let axis_cover: f64 = match &plate {
        Some(poly) if !is_rectangular => regions
            .iter()
            .map(|r| geometry::rect_polygon_clip_area(poly, r.x0, r.y0, r.x1, r.y1))
            .sum(),
        _ => plate_area,
    };
    let use_oriented_field =
        !is_rectangular && plate_area > 0.0 && axis_cover < ORIENTED_COVER_FRAC * plate_area;
    let single_region = regions.is_empty();
    if single_region {
        regions.push(geometry::Rect { x0: min_x, y0: min_y, x1: max_x, y1: max_y });
    }
    // Dominant wing(s) reserved for the open desk field (spec §1: desks are the
    // MAJORITY use): they get a shallow room band and a band-only room pocket so
    // no deep support room deepens their long band or fragments their field. Only
    // when the plate has MORE THAN ONE region — a single (rectangular) plate must
    // host the whole program in its one band.
    let field_regions: Vec<bool> = {
        let max_area = regions.iter().map(|r| r.area()).fold(0.0f64, f64::max);
        regions
            .iter()
            .map(|r| regions.len() > 1 && r.area() >= FIELD_REGION_FRAC * max_area)
            .collect()
    };
    // Per-region insets: 0.9 m facade gap on plate-boundary edges (desks get
    // the window wall), corridor/2 on seams shared with an adjacent region so
    // neighbours form ONE shared corridor.
    let insets: Vec<Insets> = if single_region {
        vec![Insets::boundary()]
    } else {
        (0..regions.len())
            .map(|i| region_insets(&regions, i, corridor))
            .collect()
    };

    // ONE global desk lattice per generate(): origin = plate bbox min corner,
    // snapped to the module, shared by EVERY region so adjacent wings' rows/
    // columns land on the same lines across their seam. Odd seeds shift the
    // whole lattice by half a pitch — one of the DISCRETE seed choices that
    // replaced the old continuous jitter (which shifted the lattice up to
    // ~0.22 m off any structural line — spec §4.1 / gap #6).
    let mut rng = Rng::new(seed);
    let choices = SeedChoices::draw(&mut rng, program);
    let half_phase = if seed % 2 == 1 { 0.5 } else { 0.0 };
    let lat = Lattice {
        ox: snap_module(min_x + half_phase * (program.desk_w + clear)),
        oy: snap_module(min_y + half_phase * (program.desk_h + clear)),
    };

    // --- Rooms: explicit builder program, or meeting override + derived ----
    let entry = doc.entries.first().copied();
    // Detailed builder: `program.rooms` REPLACES the derived room program +
    // meeting override (workflow.md §3.4). Desks still scale to the plate.
    // Empty → today's derive path, byte-identical.
    let mut jobs: Vec<RoomJob> = if !program.rooms.is_empty() {
        explicit_jobs(program)
    } else {
        let mut jobs: Vec<RoomJob> = Vec::new();
        let support = support_jobs(program, plate_area);
        let take = |jobs: &mut Vec<RoomJob>, kind: SpaceKind| {
            jobs.extend(support.iter().filter(|j| j.kind == kind).cloned());
        };
        // Priority order = placement order: reception first (entry-adjacent),
        // then the big rooms while band space is plentiful, small/distributed
        // last. Focus rooms are lifted ahead of the bulk support set: they are
        // facade-PINNED (item 4a), so they must claim a daylit band slot before
        // the frontage is spent — otherwise, being small and late, they overflow
        // into interior pockets, AWAY from the window the hard rule requires.
        take(&mut jobs, SpaceKind::Reception);
        for k in 0..remaining_meetings {
            let t = job_template(SpaceKind::Meeting, program);
            jobs.push(t.to_job(
                SpaceKind::Meeting,
                format!("Meeting Room {}", mr_counter + k + 1),
                program.meeting_w,
                program.meeting_h,
                Placement::Flexible,
                0, // derived meeting: no explicit brief
            ));
        }
        take(&mut jobs, SpaceKind::Focus);
        for kind in [
            SpaceKind::Cabin,
            SpaceKind::Collab,
            SpaceKind::Pantry,
            SpaceKind::ItServer,
            SpaceKind::Storage,
            SpaceKind::Wellness,
            SpaceKind::Print,
            SpaceKind::PhoneBooth,
        ] {
            take(&mut jobs, kind);
        }
        jobs
    };

    // --- Anchored rooms (workflow.md §3.5): each pinned room is placed FIRST at
    // (near) its point and CONSUMES one of its kind's count. Removing one free
    // job per anchor makes the effective total `max(requested, anchored)`: an
    // anchor beyond the free supply nets a new room ("bumps the count"); an
    // anchor within it re-pins an already-requested room (no net change). Cloned
    // up front so Pass 0 can mutate `doc` freely.
    let anchored: Vec<(RoomJob, f64, f64)> = anchor_jobs(program, &doc.anchors);
    for (aj, _, _) in &anchored {
        if let Some(pos) = jobs.iter().position(|j| j.kind == aj.kind) {
            jobs.remove(pos);
        }
    }

    let entry_idx = entry_region_idx(&regions, entry);
    // A band may only claim depth that still leaves one desk row in front.
    let min_field_d = program.desk_w.min(program.desk_h) + clear;
    let (mut region_jobs, band_depths, mut overflow) =
        allocate_rooms(jobs, &regions, &insets, entry_idx, entry.is_some(), min_field_d, &field_regions);

    // --- Region plans: band + spine + connector + link geometry -----------
    let plans: Vec<RegionPlan> = (0..regions.len())
        .map(|i| {
            plan_region(
                regions[i],
                insets[i],
                regions[i].height() > regions[i].width(),
                choices.band_far,
                band_depths[i],
                if i == entry_idx { entry } else { None },
                field_regions[i],
                single_region && plate_area < SMALL_PLATE_FIELD_AREA,
            )
        })
        .collect();

    // Full-size circulation rects: rooms must not intrude on them, and pocket
    // rooms orient their door toward the nearest one.
    let circ_rects: Vec<geometry::Rect> = plans
        .iter()
        .flat_map(|p| [p.spine, p.connector, p.link])
        .flatten()
        .collect();
    // Desk-effective obstacles for the strips that cross the desk field
    // (connector/link): shrunk so the full-clearance pad rejects desks only
    // ~0.1 m from the strip edge instead of wasting a whole extra aisle.
    let shrink = (clear - 0.1).max(0.0);
    for p in &plans {
        for r in [p.connector, p.link].into_iter().flatten() {
            obstacles.push((
                (r.x0 + r.x1) / 2.0,
                (r.y0 + r.y1) / 2.0,
                (r.width() - 2.0 * shrink).max(0.05),
                (r.height() - 2.0 * shrink).max(0.05),
            ));
        }
    }

    // --- Oriented desk field FIRST (tilted / irregular plates only) ---------
    // Desks are the MAJORITY use (spec §1), so on a compact single-region
    // irregular plate the desk field must claim the floor BEFORE the support
    // rooms — otherwise the derived room program fills the one inscribed core
    // and crushes the field to a handful (a hexagon seated 5 rooms + 3 desks).
    // Placing the principal-axis field first makes every desk an obstacle the
    // room passes below pack AROUND, so rooms settle into the leftover pockets
    // (Laiout's "support in the core, desks radiating" — desks win the tie on a
    // tight plate; a large tilted plate still leaves ample room pockets). Axis-
    // aligned plates keep the room-first order and their per-wing lattice.
    if use_oriented_field {
        // Workspace zone spanning the plate bbox. Both the canvas fill and the
        // metrics `area_on` clip it to the plate polygon, so it reports the true
        // desk-field floor on a tilted/angular plate (the small per-region
        // inscribed rect used elsewhere would leave most oriented desks unzoned,
        // craters NIA and shows an absurd ~3 m²/workstation). Emitted BEFORE the
        // room passes so each room's zone, pushed later, wins its own interior in
        // the point-in-zone bucketing (last-non-Circulation-wins). NIA can now
        // exceed the summed disjoint tiling by the room/corridor overlap; the
        // metrics layer caps NIA at the gross area (NIA ≤ GEA is always true).
        push_zone(
            doc,
            ZoneType::Workspace,
            ZoneShape::Rect {
                x: (min_x + max_x) / 2.0,
                y: (min_y + max_y) / 2.0,
                w: max_x - min_x,
                h: max_y - min_y,
            },
            "Open Workspace",
        );
        if let Some(poly) = plate.as_deref() {
            pack_desks_oriented(doc, program, poly, remaining_desks, &iwalls, &mut obstacles, clear);
        }
    }

    // --- Pass 0: anchored rooms land FIRST at (near) their pinned point ------
    // Placed before the free band/pocket program so every later placement packs
    // AROUND them (each becomes an obstacle). The exact pin wins when it fits;
    // otherwise the nearest feasible slot on the plate is taken and the room is
    // still emitted — a truly infeasible pin (tiny plate) drops and surfaces as
    // a `program_fit` shortfall, never silently.
    for (job, tx, ty) in &anchored {
        place_anchor(
            doc, job, *tx, *ty, (min_x, min_y, max_x, max_y), plate.as_deref(),
            &iwalls, &mut obstacles, keepout_len, frozen_len, &circ_rects, clear,
        );
    }

    // --- Pass A: rooms slide into each region's band ------------------------
    for (i, plan) in plans.iter().enumerate() {
        let mut cursors = (plan.a0, plan.a1);
        for job in region_jobs[i].drain(..) {
            let placed = place_in_band(
                doc, plan, &job, &mut cursors, plate.as_deref(), &iwalls,
                &mut obstacles, keepout_len, frozen_len, &circ_rects, clear,
            );
            if !placed {
                overflow.push(job);
            }
        }
    }
    // --- Pass B: leftover rooms hunt interior clear pockets (both
    // orientations, nearest-to-circulation candidate wins). A room that fits
    // nowhere is a shortfall `program_fit` reports — never a silent drop.
    for job in overflow {
        place_in_pocket(
            doc, &plans, &job, plate.as_deref(), &iwalls, &mut obstacles,
            keepout_len, frozen_len, &circ_rects, clear,
        );
    }

    // --- Drawn circulation zones (spine / entry connector / link / seams) --
    for plan in &plans {
        emit_plan_zones(doc, plan);
    }

    // --- Pass C: desk fields -----------------------------------------------
    // Oriented plates already filled their desk field + Workspace zone above
    // (before the room passes). Only the axis-aligned path packs here.
    if !use_oriented_field {
        // AXIS-ALIGNED plate (rectangle, L/T, real multi-wing): desks on the
        // shared global lattice, per-region proportional allocation.
        let mut placed_desks = 0u32;
        let d_alloc = allocate_desks(program, &plans, clear, remaining_desks);
        for (i, plan) in plans.iter().enumerate() {
            let region_no = if single_region { None } else { Some((i + 1) as u32) };
            placed_desks += pack_desks(
                doc, program, plan, d_alloc[i], region_no, /*emit_zones=*/ true,
                plate.as_deref(), &iwalls, &mut obstacles, lat, clear, choices,
            );
        }
        // --- Top-up pass: reclaim allocation lost to rooms/geometry. Smallest
        // wings first: the proportional allocation already loaded the big regions.
        // SAME global lattice → top-up slots either coincide with occupied lines
        // (rejected) or fill genuinely free ones in perfect row alignment.
        let mut shortfall = remaining_desks.saturating_sub(placed_desks);
        if shortfall > 0 {
            for (i, plan) in plans.iter().enumerate().rev() {
                if shortfall == 0 {
                    break;
                }
                let region_no = if single_region { None } else { Some((i + 1) as u32) };
                let got = pack_desks(
                    doc, program, plan, shortfall, region_no, /*emit_zones=*/ false,
                    plate.as_deref(), &iwalls, &mut obstacles, lat, clear, choices,
                );
                shortfall = shortfall.saturating_sub(got);
            }
        }

        // --- Degenerate-plate rescue (safety net): if an axis-aligned plate
        // somehow seated ZERO (an adverse global-lattice phase on a shallow
        // field, say), fall back to the oriented packer just as before. Tilted
        // plates take the `use_oriented_field` branch above; this only catches
        // the rare axis-aligned zero.
        if placed_desks == 0 && remaining_desks > 0 {
            if let Some(poly) = plate.as_deref() {
                // Side effect only — the count is not needed after this branch.
                pack_desks_oriented(doc, program, poly, remaining_desks, &iwalls, &mut obstacles, clear);
            }
        }

        // --- Whole-plate leftover fill (irregular multi-region plates) ---------
        // The per-region packer fills each wing's inscribed desk RECTANGLE, but
        // the maximal-rectangle decomposition of a notched/irregular plate leaves
        // big empty pockets the region grid never reaches: a mid-size wing whose
        // shallow room band swallowed its depth, the low bottom band, and the
        // fragments between the dominant column and the facades. On the real
        // ~882 m² plate that stranded ~27% of the floor as dead space while the
        // desks collapsed into a ~12 m central column (the user's #1 complaint:
        // "we still are not able to utilize the entire space"). Re-pack every
        // wing over its FULL cross-section on the SAME global lattice so the field
        // spreads into those pockets. `pack_desks` rejects every slot overlapping
        // a room, keep-out, existing desk, or corridor, and holds the facade gap,
        // so only genuinely empty floor gets a desk — module- and lattice-aligned
        // with the field already placed (spec §4.1/§4.5), never an off-grid
        // straggler. Capped at the professional density floor so the plan stays
        // in the 8–12 m²/person band. Single-region (rectangular) plates already
        // pack their one field solid, so they are gated out (today's behaviour).
        if !single_region {
            let meeting_seats: f64 = doc
                .zones
                .iter()
                .filter(|z| matches!(z.zone_type, ZoneType::Meeting | ZoneType::Collaboration))
                .map(|z| z.capacity() as f64)
                .sum();
            let seat_cap = (plate_area / fill_density_floor(program.strategy)).floor();
            // Actual desks already down (the per-region pass AND its top-up, which
            // `placed_desks` alone does not fully count) plus meeting seats set the
            // headroom, so the fill lands ON the density floor rather than past it.
            let desks_now = doc.components.iter().filter(|c| c.category == "Desk").count() as f64;
            let budget = (seat_cap - meeting_seats - desks_now).max(0.0) as u32;
            if budget > 0 {
                // The spine + seam corridors are not yet obstacles (connector/link
                // already are); add them at FULL drawn width so the fill can never
                // narrow a corridor below its 1.5 m drawn size (NBC 2016).
                let guard = obstacles.len();
                for p in &plans {
                    for r in p.spine.into_iter().chain(p.seams.iter().copied()) {
                        obstacles.push(((r.x0 + r.x1) / 2.0, (r.y0 + r.y1) / 2.0, r.width(), r.height()));
                    }
                }
                let before = doc.components.len();
                // ONE sweep over the WHOLE plate bbox on the shared global lattice.
                // `pack_desks` walks the lattice across the bbox and seats a desk in
                // every empty in-plate slot, rejecting the rest — so the budget
                // flows PAST the already-packed dominant column (whose slots are
                // occupied obstacles) into the stranded wings and the strips BETWEEN
                // regions, pushing desks out toward the plate's far edges rather
                // than widening the central column. Orientation follows the dominant
                // wing so the fill reads as one continuous field.
                let dom = (0..plans.len())
                    .max_by(|&a, &b| regions[a].area().partial_cmp(&regions[b].area()).unwrap_or(std::cmp::Ordering::Equal))
                    .unwrap_or(0);
                let mut fp = plans[dom].clone();
                fp.field = geometry::Rect { x0: min_x, y0: min_y, x1: max_x, y1: max_y };
                pack_desks(
                    doc, program, &fp, budget, None, /*emit_zones=*/ false,
                    plate.as_deref(), &iwalls, &mut obstacles, lat, clear, choices,
                );
                obstacles.truncate(guard); // drop the temporary corridor guards
                // Zone each newly seated fill desk (a Workspace tile the size of
                // the desk footprint — NOT the pitch cell, so bench-paired tiles
                // never overlap and double-count NIA) so the fill counts toward
                // the workstation tally and renders as workspace floor. The aisle
                // gaps between fill desks are picked up by the residual pass below.
                // A fill desk that landed in an existing Workspace zone's own
                // unpacked slot is ALREADY counted there — only tile the ones that
                // fell in genuinely un-zoned pockets, so tiles never overlap the
                // region field zones (which would double-count NIA).
                let tiles: Vec<(f64, f64, f64, f64)> = doc.components[before..]
                    .iter()
                    .filter(|c| c.category == "Desk")
                    .filter(|c| {
                        !doc.zones.iter().any(|z| z.zone_type == ZoneType::Workspace && z.shape.contains(c.x, c.y))
                    })
                    .map(|c| {
                        let (ww, wh) = world_extents(c.w, c.h, c.rotation);
                        (c.x, c.y, ww, wh)
                    })
                    .collect();
                for (x, y, w, h) in tiles {
                    push_zone(doc, ZoneType::Workspace, ZoneShape::Rect { x, y, w, h }, "Open Workspace");
                }
            }
        }
    }

    // --- Residual floor → explicit Circulation ("walking place") ------------
    // A professional test-fit leaves NO untyped floor: every m² is a desk, a
    // room, the building core, OR named circulation. After the desk field, rooms
    // and the fill, a notched/irregular plate still has SUBSTANTIAL pockets no
    // rectangle furnished — the strip beside a notch, the depth a mid-size wing's
    // room band gave up, the low bottom band. Rather than leave them as silent
    // empty floor (the user's "wasted space the tenant pays rent for"), label
    // each big free pocket Circulation. Reuses `decompose_plate`: mark every zone
    // + component footprint as a hole, extract the maximal FREE rectangles, and
    // emit them. `REGION_MIN_DIM`/`REGION_MIN_AREA` keep it to real pockets
    // (≥ ~1.5 m, ≥ 4 m²) — the thin facade maintenance gap stays unlabelled, not
    // fragmented into noise. Emitted before the Core zones (so a keep-out still
    // wins its tile) and, being Circulation, it loses the point-in-zone tie to
    // every desk/room, so bucketing is unchanged. Disjoint from all other zones
    // by construction, so NIA never double-counts. Gated to irregular multi-
    // region plates (a rectangular plate has no such pockets). The oriented path
    // already emits a plate-spanning Workspace (its own fill), so it is excluded
    // — layering residual Circulation over that spanning zone would double-count
    // the floor (NIA > GEA).
    if !single_region && !use_oriented_field {
        if let Some(poly) = plate.as_deref() {
            let mut used: Vec<geometry::Rect> = holes.clone(); // keep-outs
            for z in &doc.zones {
                let (x0, y0, x1, y1) = z.shape.bbox();
                used.push(geometry::Rect { x0, y0, x1, y1 });
            }
            for c in &doc.components {
                let (ww, wh) = world_extents(c.w, c.h, c.rotation);
                used.push(geometry::Rect { x0: c.x - ww / 2.0, y0: c.y - wh / 2.0, x1: c.x + ww / 2.0, y1: c.y + wh / 2.0 });
            }
            // Finer grid + smaller min pocket (min-dim 0.5 m, ≥ 0.3 m²): capture the
            // sub-metre wedges against angled/stepped walls that a 1 m floor left as
            // untyped WHITE floor (measured ~8.5%/75 m² of the plate). These become
            // named circulation the conform pass then grows to the wall — so the
            // plate reads fully typed, never a wasted white gap. Still filtered so it
            // doesn't shatter into sub-half-metre noise.
            for r in geometry::decompose_plate(poly, 0.25, 0.5, 0.3, &used) {
                // Inset a half cell per side: `decompose_plate` keeps a cell whose
                // CENTRE is clear of every hole, so a rect edge can overshoot an
                // adjacent zone by at most half a cell. Pulling back that much keeps
                // the residual STRICTLY disjoint (NIA ≤ GEA) without widening the gap.
                let (w, h) = (r.width() - 0.25, r.height() - 0.25);
                if w <= 0.0 || h <= 0.0 {
                    continue;
                }
                // Residual, not drawn: this is floor nothing claimed, and the
                // type here is PROVISIONAL. `conform::classify_residual_zones`
                // decides Circulation vs Unassigned once the merge has run —
                // clear width is a property of the merged pocket, not of the
                // decomposition rectangles it was assembled from.
                push_residual_zone(
                    doc,
                    ZoneType::Circulation,
                    ZoneShape::Rect { x: (r.x0 + r.x1) / 2.0, y: (r.y0 + r.y1) / 2.0, w, h },
                    "Circulation",
                );
            }
        }
    }

    // Keep-outs surface as `Core` zones (gray tint, Core cost/NIA rate). A point
    // inside a keep-out buckets to Core rather than to an overlapping spanning
    // Workspace rect because `Document::zone_index_at` picks the SMALLEST
    // containing zone (a shaft is always smaller than the field around it).
    for (kx, ky, kw, kh, label) in &keepout_zones {
        push_zone(
            doc,
            ZoneType::Core,
            ZoneShape::Rect { x: *kx, y: *ky, w: *kw, h: *kh },
            label,
        );
    }

    // Boundary-conforming pass: every zone rect that sits along an angled/stepped
    // plate wall stops short of it (a conservative raster drops the cut cells),
    // leaving triangular "wedge" gaps of dead floor the tenant still pays rent
    // for. Grow each such zone's WALL-FACING edges out to the wall and clip to the
    // plate so its footprint follows the diagonal exactly — a trapezoid/polygon
    // instead of a set-back rectangle. Interior rectangular rooms are untouched.
    if let Some(poly) = plate.as_deref() {
        conform_zones_to_plate(doc, poly);
        // Unify the walking area: melt every untyped wedge AND the many scattered
        // residual-Circulation fragments into ONE merged wall-following polygon per
        // contiguous region (same gate as the residual fill — the oriented spanning
        // Workspace already covers the floor, so layering circulation would double-
        // count; a single/axis-aligned plate has no wedges).
        if !single_region && !use_oriented_field {
            fill_untyped_as_circulation(doc, poly);
        }
    }

    // Seat every generated desk. Last, so it sees the final desk set (including
    // the cross-region top-up pass) and so desk placement above is untouched.
    seat_desk_chairs(doc, plate.as_deref(), &iwalls, clear);

    // Fill each zone's component_ids by point-in-zone on component centers.
    doc.reassign_components();

    // Model the facade's glazing module. Runs AFTER zones and components so the
    // ids they were allocated (the workbook's Room IDs) never move.
    glaze_facade(doc);
}
