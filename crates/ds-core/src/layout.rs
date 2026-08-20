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
mod diag;
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
pub use self::diag::{DiagRect, LayoutDiag, RegionDesks};
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
/// `outer ∖ inner` as up to four disjoint rects (exact — the workspace-trim
/// bookkeeping must conserve floor area to the module, so no raster is
/// involved). Empty when `inner` covers `outer`.
fn subtract_rect(outer: geometry::Rect, inner: geometry::Rect) -> Vec<geometry::Rect> {
    let i = geometry::Rect {
        x0: inner.x0.max(outer.x0),
        y0: inner.y0.max(outer.y0),
        x1: inner.x1.min(outer.x1),
        y1: inner.y1.min(outer.y1),
    };
    if i.x1 <= i.x0 || i.y1 <= i.y0 {
        return vec![outer];
    }
    let mut out = Vec::new();
    let mut push = |x0: f64, y0: f64, x1: f64, y1: f64| {
        if x1 - x0 > 1e-9 && y1 - y0 > 1e-9 {
            out.push(geometry::Rect { x0, y0, x1, y1 });
        }
    };
    push(outer.x0, outer.y0, outer.x1, i.y0); // below
    push(outer.x0, i.y1, outer.x1, outer.y1); // above
    push(outer.x0, i.y0, i.x0, i.y1); // left band
    push(i.x1, i.y0, outer.x1, i.y1); // right band
    out
}

/// Alias with hole semantics for the void bookkeeping loop.
fn subtract_rect_hole(base: geometry::Rect, hole: geometry::Rect) -> Vec<geometry::Rect> {
    subtract_rect(base, hole)
}

/// Merge rects that share a full edge back into single rects, to a fixpoint.
/// The guillotine subtraction above fragments a void into slivers; emitting
/// each as its own zone put 0.02 m² "Open Workspace" rows into the delivered
/// room schedule. Exact — a merge changes no covered area.
fn coalesce_rects(mut rects: Vec<geometry::Rect>) -> Vec<geometry::Rect> {
    let eq = |a: f64, b: f64| (a - b).abs() < 1e-9;
    loop {
        let mut merged = false;
        'outer: for i in 0..rects.len() {
            for j in (i + 1)..rects.len() {
                let (a, b) = (rects[i], rects[j]);
                let joined = if eq(a.y0, b.y0) && eq(a.y1, b.y1) && (eq(a.x1, b.x0) || eq(b.x1, a.x0)) {
                    Some(geometry::Rect { x0: a.x0.min(b.x0), y0: a.y0, x1: a.x1.max(b.x1), y1: a.y1 })
                } else if eq(a.x0, b.x0) && eq(a.x1, b.x1) && (eq(a.y1, b.y0) || eq(b.y1, a.y0)) {
                    Some(geometry::Rect { x0: a.x0, y0: a.y0.min(b.y0), x1: a.x1, y1: a.y1.max(b.y1) })
                } else {
                    None
                };
                if let Some(r) = joined {
                    rects[i] = r;
                    rects.swap_remove(j);
                    merged = true;
                    break 'outer;
                }
            }
        }
        if !merged {
            return rects;
        }
    }
}

pub fn generate(
    doc: &mut Document,
    program: &Program,
    seed: u64,
    keep_confirmed: bool,
) -> LayoutDiag {
    // The generator's own account of what it decided — see `diag.rs`. Returned
    // rather than stored, and returning it is source-compatible: every existing
    // caller uses `generate(..)` in statement position.
    let mut diag = LayoutDiag::default();
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
        None => return diag, // no boundary → nothing to place
    };

    // The floor-plate polygon — `Document::plate_polygon`, the same face the
    // panel bills and the scorer divides by. For a rectangular room it equals
    // the bbox. `None` (walls that close nowhere, or close on no face holding
    // this plan) keeps the historical bbox-only behavior.
    //
    // On THIS call site the two selection rules coincide by construction and the
    // routing is therefore byte-identical: zones and (unless `keep_confirmed`)
    // components have just been cleared above, so `plan_anchors()` is empty,
    // `0 >= PLATE_CONTAINMENT * 0` holds, and the largest face is accepted —
    // which is exactly what `trace_floor_polygon` returned. It is routed anyway,
    // because "the plate has one owner" must be true of every reader or the next
    // change to the selection rule reaches two of the three again. Under
    // `keep_confirmed` the confirmed furniture IS an anchor set, and there the
    // routing is a real correction.
    let plate = doc.plate_polygon();

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
    // SECOND-CHANCE wings: re-decompose the residue at ROOM scale and append
    // the claims as regions, so room-scale pockets the desk-field floor
    // (`REGION_MIN_DIM`) rejected still get bands/pockets/desk allocation
    // through the machinery that already exists — on the repro plate the
    // primary tiling stranded 135 m² this way while 38 briefed rooms dropped.
    // Axis-aligned multi-region plates only: the oriented path fills the whole
    // polygon itself, and its gate (`axis_cover`, computed ABOVE from the
    // primary decomposition alone) must not be flipped by wing crumbs along a
    // diagonal facade. `primary_n` marks where the wings start — secondary
    // regions take room-scale insets (`region_insets`).
    let primary_n = regions.len();
    if !single_region && !use_oriented_field {
        if let Some(poly) = plate.as_deref() {
            let mut claimed = holes.clone();
            claimed.extend(regions.iter().copied());
            regions.extend(geometry::decompose_plate(
                poly,
                REGION_CELL,
                WING_MIN_DIM,
                WING_MIN_AREA,
                &claimed,
            ));
        }
    }
    diag.plate_area = plate_area;
    diag.bbox_area = bbox_area;
    diag.is_rectangular = is_rectangular;
    diag.axis_cover = axis_cover;
    diag.axis_cover_frac = if plate_area > 0.0 { axis_cover / plate_area } else { 0.0 };
    diag.use_oriented_field = use_oriented_field;
    diag.single_region = single_region;
    diag.desk_target = remaining_desks;
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
            .map(|i| region_insets(&regions, i, corridor, i >= primary_n))
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

    for (i, r) in regions.iter().enumerate() {
        diag.rects.push(DiagRect::of(*r, "region", Some(i)));
    }
    // THE TILING RESIDUE: plate the maximal-rectangle decomposition never
    // claimed. 122 m² of 930 on the sample plate, and until it is enumerated it
    // is invisible — it has no region, no plan and no programme, so nothing in
    // the generator has an opinion about it. Re-decomposed with the REGIONS as
    // holes, which is the same tool answering the complementary question.
    if let Some(poly) = plate.as_deref() {
        if !single_region {
            let claimed: Vec<geometry::Rect> = regions.to_vec();
            for r in geometry::decompose_plate(poly, REGION_CELL, 1.0, 2.0, &claimed) {
                diag.residue_area += r.area();
                diag.rects.push(DiagRect::of(r, "residue", None));
            }
        }
    }
    for (i, p) in plans.iter().enumerate() {
        diag.rects.push(DiagRect::of(p.field, "field", Some(i)));
        diag.rects.push(DiagRect::of(p.pocket, "pocket", Some(i)));
        if let Some(r) = p.spine {
            diag.rects.push(DiagRect::of(r, "spine", Some(i)));
        }
        if let Some(r) = p.connector {
            diag.rects.push(DiagRect::of(r, "connector", Some(i)));
        }
        if let Some(r) = p.link {
            diag.rects.push(DiagRect::of(r, "link", Some(i)));
        }
        for r in &p.seams {
            diag.rects.push(DiagRect::of(*r, "seam", Some(i)));
        }
    }
    diag.region_desks = vec![RegionDesks::default(); plans.len()];

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
    // Which regions actually received rooms — read here because `region_jobs` is
    // drained below, and a ROOM WING is defined by holding rooms while seating no
    // desks. Without it a wing that failed and a wing that was meant for rooms
    // look identical in the diagnostics, which is the distinction F1a exists for.
    let rooms_in_region: Vec<u32> = region_jobs.iter().map(|l| l.len() as u32).collect();
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
    // orientations, nearest-to-circulation candidate wins). A room that still
    // fits nowhere is kept for PASS D below — the residual-ground pass that
    // runs after the desks, so a briefed room gets one more chance at the
    // floor nothing else claimed before that floor is written off.
    let mut homeless: Vec<RoomJob> = Vec::new();
    for job in overflow {
        let ok = place_in_pocket(
            doc, &plans, &job, plate.as_deref(), &iwalls, &mut obstacles,
            keepout_len, frozen_len, &circ_rects, clear,
        );
        if !ok {
            homeless.push(job);
        }
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
        // Capacity measured against what is ALREADY placed (rooms, keep-outs,
        // corridor strips), so a wing the rooms have consumed is allocated zero
        // instead of being handed desks it cannot seat.
        let (d_alloc, d_cap) = allocate_desks(
            program, &plans, clear, remaining_desks, plate.as_deref(), &iwalls, &obstacles, lat,
            choices,
        );
        for (i, plan) in plans.iter().enumerate() {
            let region_no = if single_region { None } else { Some((i + 1) as u32) };
            diag.region_desks[i].capacity = d_cap[i];
            diag.region_desks[i].allocated = d_alloc[i];
            // A ROOM WING: no viable desk capacity, but rooms banded into it.
            // Declared rather than left as a silent zero, so the acceptance
            // check can tell an intended room wing from a failed desk field.
            diag.region_desks[i].room_wing =
                d_alloc[i] == 0 && rooms_in_region.get(i).copied().unwrap_or(0) > 0;
            let got = pack_desks(
                doc, program, plan, d_alloc[i], region_no, /*emit_zones=*/ true,
                plate.as_deref(), &iwalls, &mut obstacles, lat, clear, choices, &[],
                Some(&mut diag.region_desks[i]),
            );
            diag.region_desks[i].placed = got;
            placed_desks += got;
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
                    plate.as_deref(), &iwalls, &mut obstacles, lat, clear, choices, &[],
                    None,
                );
                diag.region_desks[i].topped_up += got;
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

    // --- Workspace zones shrink to the desks they actually seat --------------
    // A region's Workspace zone is emitted over its WHOLE field rect before a
    // single desk lands, but the desk target caps what the field seats — on
    // the repro plate the dominant field billed ~100 m² of desk-less void as
    // "Open Workspace" while 33 briefed rooms were homeless. Trim each field
    // zone to the hull of its own desks plus one clearance aisle (a zone that
    // seats nothing is removed outright); the cut-away floor is kept as VOID
    // rects — ground for PASS D below — and after that pass every void piece
    // no room took is emitted as a residual-provisional zone by EXACT
    // rectangle subtraction, so not a square centimetre leaves the NIA (the
    // 930.1/906 plate yardsticks are pinned). Same gate as the residual
    // machinery (the oriented path's spanning zone is its own regime).
    let mut voids: Vec<geometry::Rect> = Vec::new();
    if !single_region && !use_oriented_field {
        let desk_hulls: Vec<(f64, f64, f64, f64)> = doc
            .components
            .iter()
            .filter(|c| c.category == "Desk")
            .map(|c| {
                let (ww, wh) = world_extents(c.w, c.h, c.rotation);
                (c.x - ww / 2.0, c.y - wh / 2.0, c.x + ww / 2.0, c.y + wh / 2.0)
            })
            .collect();
        let mut kept_voids: Vec<geometry::Rect> = Vec::new();
        doc.zones.retain_mut(|z| {
            if z.zone_type != ZoneType::Workspace {
                return true;
            }
            let ZoneShape::Rect { x, y, w, h } = z.shape else { return true };
            let outer = geometry::Rect {
                x0: x - w / 2.0,
                y0: y - h / 2.0,
                x1: x + w / 2.0,
                y1: y + h / 2.0,
            };
            let mut hull: Option<(f64, f64, f64, f64)> = None;
            for &(dx0, dy0, dx1, dy1) in &desk_hulls {
                let (cx, cy) = ((dx0 + dx1) / 2.0, (dy0 + dy1) / 2.0);
                if cx >= outer.x0 && cx <= outer.x1 && cy >= outer.y0 && cy <= outer.y1 {
                    hull = Some(match hull {
                        None => (dx0, dy0, dx1, dy1),
                        Some((a, b, c, d)) => (a.min(dx0), b.min(dy0), c.max(dx1), d.max(dy1)),
                    });
                }
            }
            let Some((hx0, hy0, hx1, hy1)) = hull else {
                kept_voids.push(outer); // seats nothing: the whole rect is void
                return false;
            };
            let trimmed = geometry::Rect {
                x0: snap_module((hx0 - clear).max(outer.x0)),
                y0: snap_module((hy0 - clear).max(outer.y0)),
                x1: snap_module((hx1 + clear).min(outer.x1)),
                y1: snap_module((hy1 + clear).min(outer.y1)),
            };
            kept_voids.extend(subtract_rect(outer, trimmed));
            z.shape = ZoneShape::Rect {
                x: (trimmed.x0 + trimmed.x1) / 2.0,
                y: (trimmed.y0 + trimmed.y1) / 2.0,
                w: trimmed.width(),
                h: trimmed.height(),
            };
            true
        });
        voids = kept_voids;
    }

    // --- PASS D: homeless rooms take residual ground -------------------------
    // After every band, pocket, anchor and DESK pass: a briefed room that
    // still has no home hunts the free floor the residual pass is about to
    // write off. Runs BEFORE that pass so a placed room is architecture and
    // the leftover is honestly typed around it; a room that fails even here is
    // a shortfall `program_fit` reports — never a silent drop. Naming the
    // survivors is the difference between "the derive did not ask for it" and
    // "the derive asked and placement refused", and those have different
    // fixes. Gated exactly like the residual pass: the oriented path's
    // spanning Workspace zone covers the floor, so there is no residual ground
    // to take there.
    for job in homeless {
        let placed = !single_region
            && !use_oriented_field
            && plate.as_deref().is_some_and(|poly| {
                place_in_residual(
                    doc, &job, poly, &holes, &iwalls, &mut obstacles, keepout_len, frozen_len,
                    &circ_rects, clear, &voids,
                )
            });
        if !placed {
            diag.rooms_unplaced.push(job.label.clone());
        }
    }
    // Every void piece no room took goes BACK to Workspace by EXACT
    // subtraction of the room zones that landed in it — no raster, no
    // half-cell shaving, so the field's floor re-enters the NIA to the module
    // with its original billing. The trim exists to hand rooms the desk-less
    // ground, not to relitigate how an under-filled field is billed: typed as
    // residual instead, the whole void merely moved from the Workspace column
    // to Unassigned (measured: 156.7 m² vs 113.5) while the yardsticked NIA
    // shed raster dust — strictly worse on both `phase0` pins.
    {
        let room_holes: Vec<geometry::Rect> = doc
            .zones
            .iter()
            .filter(|z| {
                !matches!(z.zone_type, ZoneType::Circulation | ZoneType::Workspace | ZoneType::Core)
            })
            .map(|z| {
                let (x0, y0, x1, y1) = z.shape.bbox();
                geometry::Rect { x0, y0, x1, y1 }
            })
            .collect();
        let mut pieces: Vec<geometry::Rect> = Vec::new();
        for v in &voids {
            let mut frontier = vec![*v];
            for h in &room_holes {
                let mut next = Vec::new();
                for f in frontier {
                    next.extend(subtract_rect_hole(f, *h));
                }
                frontier = next;
            }
            pieces.extend(frontier);
        }
        let pieces = coalesce_rects(pieces);
        for p in pieces {
            if p.width() < 0.02 || p.height() < 0.02 {
                continue; // sub-module dust
            }
            push_zone(
                doc,
                ZoneType::Workspace,
                ZoneShape::Rect {
                    x: (p.x0 + p.x1) / 2.0,
                    y: (p.y0 + p.y1) / 2.0,
                    w: p.width(),
                    h: p.height(),
                },
                "Open Workspace",
            );
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
                .map(|z| z.seat_estimate_for_ordering() as f64)
                .sum();
            let seat_cap = (plate_area / fill_density_floor(program.strategy)).floor();
            // Actual desks already down (the per-region pass AND its top-up, which
            // `placed_desks` alone does not fully count) plus meeting seats set the
            // headroom, so the fill lands ON the density floor rather than past it.
            let desks_now = doc.components.iter().filter(|c| c.category == "Desk").count() as f64;
            let budget = (seat_cap - meeting_seats - desks_now).max(0.0) as u32;
            diag.fill_seat_cap = seat_cap;
            diag.fill_meeting_seats = meeting_seats;
            diag.fill_desks_before = desks_now;
            diag.fill_budget = budget;
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
                // The emitted Workspace zone rects: a fill slot may sit fully
                // inside one (that zone owns it) or fully outside (it gets its
                // own tile below) but never HALF ACROSS an edge — the "desk
                // crossing the open-workspace boundary" defect (Workstream E:
                // watched red on the golden real_plate cases, 3 desks up to
                // 0.55 m outside, before this list existed).
                let ws_edges: Vec<geometry::Rect> = doc
                    .zones
                    .iter()
                    .filter(|z| z.zone_type == ZoneType::Workspace)
                    .filter_map(|z| match z.shape {
                        ZoneShape::Rect { x, y, w, h } => Some(geometry::Rect {
                            x0: x - w / 2.0,
                            y0: y - h / 2.0,
                            x1: x + w / 2.0,
                            y1: y + h / 2.0,
                        }),
                        _ => None,
                    })
                    .collect();
                pack_desks(
                    doc, program, &fp, budget, None, /*emit_zones=*/ false,
                    plate.as_deref(), &iwalls, &mut obstacles, lat, clear, choices,
                    &ws_edges,
                    None,
                );
                diag.fill_placed = (doc.components.len() - before) as u32;
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

    diag
}
