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

use crate::circulation::{self, CirculationConfig};
use crate::document::Document;
use crate::geometry::{self, Point};
use crate::model::{Component, DecisionState};
use crate::zone::{Zone, ZoneShape, ZoneType};
use serde::{Deserialize, Serialize};

/// The user-set program + criteria. `desks`/`meeting_rooms` and the footprint
/// fields drive the generator; the `w_*` weights drive the evaluator (§1c of the
/// design doc). Implements `Default` so partial JSON from the UI fills sensibly.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Program {
    // --- what to place (generator inputs) ---
    pub desks: u32,
    pub meeting_rooms: u32,
    /// desk footprint, meters (default 1.6 × 0.8)
    pub desk_w: f64,
    pub desk_h: f64,
    /// meeting-room footprint, meters (default 4.0 × 4.0)
    pub meeting_w: f64,
    pub meeting_h: f64,
    /// desks per bench cluster before an aisle is inserted
    pub cluster_cols: u32,

    // --- hard constraints ---
    /// perimeter circulation corridor width, meters
    pub target_corridor_m: f64,
    /// clear gap around each desk, meters
    pub desk_clearance_m: f64,

    // --- objective weights (soft goals) ---
    pub w_capacity: f64,
    pub w_adjacency: f64,
    pub w_circulation: f64,
    pub w_density: f64,
}

impl Default for Program {
    fn default() -> Self {
        Program {
            desks: 24,
            meeting_rooms: 2,
            desk_w: 1.6,
            desk_h: 0.8,
            meeting_w: 4.0,
            meeting_h: 4.0,
            cluster_cols: 4,
            target_corridor_m: 1.2,
            desk_clearance_m: 0.9,
            w_capacity: 0.35,
            w_adjacency: 0.20,
            w_circulation: 0.25,
            w_density: 0.20,
        }
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
    pub total: f64,
    /// desks actually placed (diagnostic for the loop's "which sub-score is weak")
    pub placed_desks: u32,
}

/// Tiny inline PRNG — xorshift64* (Marsaglia). Deterministic, no `rand` crate.
/// Used only for bounded per-desk jitter so different seeds yield distinct but
/// still-valid candidates for the optimizer to compare.
struct Rng {
    state: u64,
}

impl Rng {
    fn new(seed: u64) -> Rng {
        // splitmix-style scramble; force nonzero so xorshift never sticks at 0.
        let s = (seed ^ 0x9E37_79B9_7F4A_7C15) | 1;
        Rng { state: s }
    }

    fn next_u64(&mut self) -> u64 {
        let mut x = self.state;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.state = x;
        x.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }

    /// Uniform in [0, 1).
    fn next_f64(&mut self) -> f64 {
        (self.next_u64() >> 11) as f64 / (1u64 << 53) as f64
    }

    /// Uniform in [-1, 1).
    fn signed(&mut self) -> f64 {
        self.next_f64() * 2.0 - 1.0
    }
}

fn push_component(doc: &mut Document, category: &str, x: f64, y: f64, w: f64, h: f64) {
    let id = doc.alloc_id();
    doc.components.push(Component {
        id,
        category: category.to_string(),
        x,
        y,
        w,
        h,
        rotation: 0.0,
        label: format!("{} {}", category, id),
        product_id: None,
            price_inr: None,
        decision: DecisionState::Open,
    });
}

/// Mirror of `push_component` for zones: mint a shared id and record a tiled
/// floor region. `component_ids` is filled later by `reassign_components`.
fn push_zone(doc: &mut Document, zone_type: ZoneType, shape: ZoneShape, label: &str) {
    let id = doc.alloc_id();
    doc.zones.push(Zone {
        id,
        zone_type,
        shape,
        label: label.to_string(),
        component_ids: Vec::new(),
        group: None,
    });
}

/// Axis-aligned overlap test between a candidate footprint (center cx,cy, size
/// w×h) and any obstacle rect, expanded by `pad` on every side.
fn footprint_overlaps(
    obstacles: &[(f64, f64, f64, f64)],
    cx: f64,
    cy: f64,
    w: f64,
    h: f64,
    pad: f64,
) -> bool {
    obstacles.iter().any(|&(ox, oy, ow, oh)| {
        (cx - ox).abs() < (w + ow) / 2.0 + pad && (cy - oy).abs() < (h + oh) / 2.0 + pad
    })
}

/// The walls' centerline segments, ready for `geometry::trace_floor_polygon`.
fn wall_segments(doc: &Document) -> Vec<(Point, Point)> {
    doc.walls.iter().map(|w| (w.a, w.b)).collect()
}

/// True when a candidate footprint (center `cx,cy`, size `w`×`h`) is a valid
/// slot on the floor plate: its center lies inside the plate polygon and the
/// whole rect keeps ≥ `margin` clearance to **every** plate edge. Because the
/// rect is connected, "center inside + no edge closer than `margin` > 0" is an
/// exact containment-with-clearance test (the rect cannot cross the boundary
/// without an edge at distance 0) — this is what keeps the perimeter corridor
/// intact around notches of L/U-shaped plates. `plate == None` (open walls, no
/// closed loop) accepts everything: pure bounding-box behavior, as before.
fn slot_fits_plate(plate: Option<&[Point]>, cx: f64, cy: f64, w: f64, h: f64, margin: f64) -> bool {
    let Some(poly) = plate else { return true };
    if !geometry::point_in_polygon(cx, cy, poly) {
        return false;
    }
    (0..poly.len()).all(|i| {
        let a = poly[i];
        let b = poly[(i + 1) % poly.len()];
        geometry::rect_segment_dist(cx, cy, w, h, a, b) >= margin - 1e-6
    })
}

/// Raster cell size (m) for plate decomposition — 0.5 m keeps the grid at a few
/// thousand cells (trivial cost) while resolving real wing geometry.
const REGION_CELL: f64 = 0.5;
/// A decomposition region must be at least this wide/tall (m) — narrower slivers
/// can't usefully hold a corridor-inset desk row, so they're discarded.
const REGION_MIN_DIM: f64 = 3.0;
/// …and at least this many m² — below this a region is noise, not a wing.
const REGION_MIN_AREA: f64 = 9.0;

/// Per-region deterministic RNG stream: derived from `(seed, region_index)` so a
/// region's layout is reproducible and region order can't perturb its neighbours.
/// `index == 0` collapses to `Rng::new(seed)`, so the single-region (rectangular)
/// path is byte-identical to the historical `Rng::new(seed)` behavior.
fn region_rng(seed: u64, index: u64) -> Rng {
    Rng::new(seed ^ index.wrapping_mul(0x9E37_79B9_7F4A_7C15))
}

/// Deterministically generate a test-fit into `doc` for `program`, seeded by `seed`.
///
/// Walls are preserved. When `keep_confirmed` is true, components left `Confirmed`
/// are **frozen** — kept in place and treated as obstacles so newly-placed items
/// pack around them (Laiout-style Freeze/Regenerate, design §4). When false, all
/// components are cleared for a fresh fit. Frozen items count toward the program
/// targets, so regenerating tops the plan up to the requested counts.
///
/// Path selection: a **materially non-rectangular** plate (`polygon_area <
/// 0.98·bbox_area`) is decomposed into rectangular regions and packed per-region
/// (Stages 1–4) so every wing gets its own desk field. A rectangular room (or
/// open walls with no plate) takes the historical single-work-rect path, which
/// is placement-identical to before — the decomposition is never invoked for it.
pub fn generate(doc: &mut Document, program: &Program, seed: u64, keep_confirmed: bool) {
    // Freeze: keep Confirmed components, drop the rest. Frozen footprints become
    // obstacles the new placement must avoid.
    let mut obstacles: Vec<(f64, f64, f64, f64)> = Vec::new();
    if keep_confirmed {
        doc.components.retain(|c| c.decision == DecisionState::Confirmed);
        for c in &doc.components {
            obstacles.push((c.x, c.y, c.w, c.h));
        }
    } else {
        doc.components.clear();
    }
    // Zones are regenerated wholesale each call (like components), including under
    // keep_confirmed — frozen components are simply re-bucketed into the new zones.
    doc.zones.clear();
    doc.selection = None;
    // Only frozen footprints block new placement. Items placed in this call are
    // laid out on non-overlapping pitches by construction, so they must NOT be
    // checked against each other (their spacing == the overlap threshold, which
    // floating-point rounding would otherwise flag as a collision).
    let frozen_len = obstacles.len();

    let (min_x, min_y, max_x, max_y) = match doc.wall_bbox() {
        Some(b) => b,
        None => return, // no boundary → nothing to place
    };

    // The floor-plate polygon: the largest closed loop through the walls. For a
    // rectangular room it equals the bbox. `None` (open walls) keeps the
    // historical bbox-only behavior.
    let plate = geometry::trace_floor_polygon(&wall_segments(doc), geometry::LOOP_SNAP_TOL);

    let corridor = program.target_corridor_m.max(0.0);
    let clear = program.desk_clearance_m.max(0.0);

    // Frozen items already count toward the program targets, so we only place the
    // remainder. These global counters also number Meeting-Room zone labels.
    let mut mr_counter = doc.components.iter().filter(|c| c.category == "MeetingRoom").count() as u32;
    let frozen_desks = doc.components.iter().filter(|c| c.category == "Desk").count() as u32;
    let remaining_meetings = program.meeting_rooms.saturating_sub(mr_counter);
    let remaining_desks = program.desks.saturating_sub(frozen_desks);

    // Path selection: only a materially non-rectangular plate is decomposed.
    // A region must survive its own corridor inset with room for at least one
    // desk — 3 m slivers pass a fixed minimum but pack nothing, stealing desk
    // allocation from real wings.
    let bbox_area = (max_x - min_x) * (max_y - min_y);
    let min_dim = REGION_MIN_DIM.max(2.0 * corridor + program.desk_w.min(program.desk_h));
    let regions = match &plate {
        Some(poly) if geometry::polygon_area(poly) < 0.98 * bbox_area => {
            geometry::decompose_plate(poly, REGION_CELL, min_dim, REGION_MIN_AREA)
        }
        _ => Vec::new(),
    };

    if regions.is_empty() {
        // --- Rectangular room / open walls / undecomposable plate -----------
        // The single-work-rect path: identical to the historical generator.
        let outer = geometry::Rect { x0: min_x, y0: min_y, x1: max_x, y1: max_y };
        let mut rng = Rng::new(seed);
        pack_region(
            doc, program, outer, remaining_meetings, remaining_desks,
            /*column_major=*/ false, /*region_no=*/ None, /*tile_zones=*/ true,
            /*emit_zones=*/ true,
            plate.as_deref(), &mut obstacles, frozen_len, &mut mr_counter, &mut rng,
            corridor, clear,
        );
    } else {
        // --- Irregular plate: decompose → allocate → per-region packing -----
        let plans = allocate_regions(program, &regions, corridor, clear, remaining_meetings, remaining_desks);
        let mut placed_desks = 0u32;
        for (i, &(region, m_target, d_target)) in plans.iter().enumerate() {
            let mut rng = region_rng(seed, i as u64);
            // Desk rows run along the region's long axis: a portrait region packs
            // column-major so its wing fills with natural vertical rows.
            let column_major = region.height() > region.width();
            placed_desks += pack_region(
                doc, program, region, m_target, d_target,
                column_major, /*region_no=*/ Some((i + 1) as u32), /*tile_zones=*/ false,
                /*emit_zones=*/ true,
                plate.as_deref(), &mut obstacles, frozen_len, &mut mr_counter, &mut rng,
                corridor, clear,
            );
        }
        // --- Top-up pass: reclaim the allocation lost to meetings/geometry ---
        // A region's meeting room can eat its whole desk budget (or a diagonal
        // edge rejects its slots); those desks were previously dropped silently.
        // Retry the shortfall in every region, largest first — every desk placed
        // so far sits in `obstacles`, and grid slots that coincide with occupied
        // pitches are rejected by the overlap check, so only genuinely free
        // slots fill. Zones are already emitted; this pass only places.
        let mut shortfall = remaining_desks.saturating_sub(placed_desks);
        if shortfall > 0 {
            // Smallest wings first: the proportional allocation already loaded
            // the big regions, so the shortfall spreads the field outward.
            for (i, &(region, _m, _d)) in plans.iter().enumerate().rev() {
                if shortfall == 0 {
                    break;
                }
                // SAME rng stream as the first pass → same grid offset, so
                // top-up slots either coincide with occupied pitches (rejected)
                // or fill genuinely free ones in perfect row alignment. A fresh
                // offset would interleave desks between existing rows and
                // pinch the aisles the grid-level jitter fix just guaranteed.
                let mut rng = region_rng(seed, i as u64);
                let column_major = region.height() > region.width();
                let all_frozen = obstacles.len(); // everything placed so far blocks
                let got = pack_region(
                    doc, program, region, 0, shortfall,
                    column_major, /*region_no=*/ Some((i + 1) as u32), /*tile_zones=*/ false,
                    /*emit_zones=*/ false,
                    plate.as_deref(), &mut obstacles, all_frozen, &mut mr_counter, &mut rng,
                    corridor, clear,
                );
                shortfall = shortfall.saturating_sub(got);
            }
        }
    }

    // Fill each zone's component_ids by point-in-zone on component centers.
    doc.reassign_components();
}

/// Allocate the program across decomposition `regions` (already area-desc).
/// Returns `(region, meetings, desks)` per region. Meeting rooms are handed out
/// round-robin over the regions that fit one (largest-first); desks are split by
/// each region's inset grid capacity via largest-remainder rounding, so regions
/// too small for a single desk get zero.
fn allocate_regions(
    program: &Program,
    regions: &[geometry::Rect],
    corridor: f64,
    clear: f64,
    meetings: u32,
    desks: u32,
) -> Vec<(geometry::Rect, u32, u32)> {
    let n = regions.len();
    let pitch_x = program.desk_w + clear;
    let pitch_y = program.desk_h + clear;

    // Per-region inset dimensions, meeting-fit, meeting stack capacity, desk cap.
    let mut fits_meeting = vec![false; n];
    let mut meeting_cap = vec![0u32; n];
    let mut desk_cap = vec![0u32; n];
    for (i, reg) in regions.iter().enumerate() {
        let iw = reg.width() - 2.0 * corridor;
        let ih = reg.height() - 2.0 * corridor;
        if iw >= program.meeting_w && ih >= program.meeting_h && program.meeting_w > 0.0 && program.meeting_h > 0.0 {
            fits_meeting[i] = true;
            meeting_cap[i] = (((ih + clear) / (program.meeting_h + clear)).floor() as i64).max(0) as u32;
        }
        if iw >= program.desk_w && ih >= program.desk_h && pitch_x > 0.0 && pitch_y > 0.0 {
            let cols = (((iw + clear) / pitch_x).floor() as i64).max(0);
            let rows = (((ih + clear) / pitch_y).floor() as i64).max(0);
            desk_cap[i] = (cols * rows) as u32;
        }
    }

    // Meetings: round-robin over fitting regions (area-desc), respecting each
    // region's vertical stack capacity, until the target or all capacity is used.
    let mut m_alloc = vec![0u32; n];
    let mut remaining_m = meetings;
    loop {
        if remaining_m == 0 {
            break;
        }
        let mut progressed = false;
        for i in 0..n {
            if remaining_m == 0 {
                break;
            }
            if fits_meeting[i] && m_alloc[i] < meeting_cap[i] {
                m_alloc[i] += 1;
                remaining_m -= 1;
                progressed = true;
            }
        }
        if !progressed {
            break;
        }
    }

    // Desks: largest-remainder split proportional to desk capacity, clamped to it.
    let total_cap: u32 = desk_cap.iter().sum();
    let mut d_alloc = vec![0u32; n];
    if total_cap > 0 {
        let target = desks.min(total_cap);
        let mut rema: Vec<(f64, usize)> = Vec::with_capacity(n);
        let mut assigned = 0u32;
        for i in 0..n {
            let exact = target as f64 * desk_cap[i] as f64 / total_cap as f64;
            let base = (exact.floor() as u32).min(desk_cap[i]);
            d_alloc[i] = base;
            assigned += base;
            rema.push((exact - exact.floor(), i));
        }
        // Distribute the leftover to the largest fractional remainders, respecting
        // each cap; iterate to termination since total_cap ≥ target guarantees room.
        rema.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
        let mut left = target - assigned;
        while left > 0 {
            let mut progressed = false;
            for &(_, i) in &rema {
                if left == 0 {
                    break;
                }
                if d_alloc[i] < desk_cap[i] {
                    d_alloc[i] += 1;
                    left -= 1;
                    progressed = true;
                }
            }
            if !progressed {
                break;
            }
        }
    }

    (0..n).map(|i| (regions[i], m_alloc[i], d_alloc[i])).collect()
}

/// Pack one rectangular work region: a perimeter Circulation ring, up to
/// `meeting_target` meeting rooms in a right-edge column, the Workspace zone(s),
/// and a grid-packed desk field (up to `desk_target`). Frozen/just-placed
/// footprints in `obstacles` are avoided; every footprint is validated against
/// the plate polygon. `rng` is the region's own stream. Returns desks placed.
///
/// `tile_zones == true` reproduces the historical single-region generator exactly
/// (meeting column reserved out of the desk field, Workspace shrunk to it, Core
/// bands filling the column) and is used for the rectangular path. `false` (the
/// per-region path) instead packs desks across the *full* work rect around the
/// meeting footprints and emits a single full-width Workspace — a deliberate fork:
/// narrow wings would otherwise lose half their desks to a reserved full-height
/// column, and cross-region corridors already come from the overlapping rings.
#[allow(clippy::too_many_arguments)]
fn pack_region(
    doc: &mut Document,
    program: &Program,
    outer: geometry::Rect,
    meeting_target: u32,
    desk_target: u32,
    column_major: bool,
    region_no: Option<u32>,
    tile_zones: bool,
    // `false` on the top-up pass: this region's ring/Workspace zones were
    // already emitted by the first pass — only place components.
    emit_zones: bool,
    plate: Option<&[Point]>,
    obstacles: &mut Vec<(f64, f64, f64, f64)>,
    frozen_len: usize,
    mr_counter: &mut u32,
    rng: &mut Rng,
    corridor: f64,
    clear: f64,
) -> u32 {
    // Inset by the perimeter corridor on all sides → the work zone. Everything
    // placed lives strictly inside this rect, guaranteeing the corridor.
    let x0 = outer.x0 + corridor;
    let y0 = outer.y0 + corridor;
    let x1 = outer.x1 - corridor;
    let y1 = outer.y1 - corridor;
    if x1 <= x0 || y1 <= y0 {
        return 0; // corridor swallowed this region
    }

    // --- Zone tiling, part 1: perimeter Circulation ring ------------------
    // A rectangular ring: the region bbox minus the work-zone hole. Adjacent
    // regions' rings overlap along shared edges → the internal corridor network.
    if emit_zones {
        push_zone(
            doc,
            ZoneType::Circulation,
            ZoneShape::RectRing {
                x: (outer.x0 + outer.x1) / 2.0,
                y: (outer.y0 + outer.y1) / 2.0,
                w: outer.width(),
                h: outer.height(),
                in_w: x1 - x0,
                in_h: y1 - y0,
            },
            "Circulation",
        );
    }

    // --- 1. Meeting rooms: a column down the right edge of the work zone ----
    // A side column keeps the desk field contiguous. In `tile_zones` mode we only
    // claim the column when a desk column still fits beside it (a shallow room
    // never ends up with rooms and zero desks); the per-region path drops that
    // guard so a meeting-sized wing can still host a room. Rooms clamp to fit.
    let mut dz_x1 = x1;
    let mut claimed = false;
    let mut col_x0 = x1;
    let mut col_mw = 0.0f64;
    let mut meeting_intervals: Vec<(f64, f64)> = Vec::new();
    if meeting_target > 0 && program.meeting_w > 0.0 && program.meeting_h > 0.0 {
        let mw = program.meeting_w.min(x1 - x0);
        let mh = program.meeting_h.min(y1 - y0);
        let cx0 = x1 - mw;
        let mr_pitch = mh + clear;
        let rows = (((y1 - y0) + clear) / mr_pitch).floor() as i64;
        let desk_room = !tile_zones || (cx0 - clear - x0) >= program.desk_w;
        if rows > 0 && desk_room {
            let mut placed_here = 0u32;
            for r in 0..rows {
                if placed_here >= meeting_target {
                    break;
                }
                let cx = cx0 + mw / 2.0;
                let cy = y0 + mh / 2.0 + (r as f64) * mr_pitch;
                if !slot_fits_plate(plate, cx, cy, mw, mh, corridor)
                    || footprint_overlaps(&obstacles[..frozen_len], cx, cy, mw, mh, clear)
                {
                    continue;
                }
                push_component(doc, "MeetingRoom", cx, cy, mw, mh);
                *mr_counter += 1;
                push_zone(
                    doc,
                    ZoneType::Meeting,
                    ZoneShape::Rect { x: cx, y: cy, w: mw, h: mh },
                    &format!("Meeting Room {}", *mr_counter),
                );
                obstacles.push((cx, cy, mw, mh));
                meeting_intervals.push((cy - mh / 2.0, cy + mh / 2.0));
                placed_here += 1;
                claimed = true;
            }
            if claimed {
                col_x0 = cx0;
                col_mw = mw;
                if tile_zones {
                    dz_x1 = cx0 - clear; // reserve the column out of the desk field
                }
            }
        }
    }

    // --- Zone tiling, part 2: Workspace (+ Core in tile mode) --------------
    let ws_label = match region_no {
        Some(n) => format!("Open Workspace ({})", n),
        None => "Open Workspace".to_string(),
    };
    // In tile mode the Workspace stops at the reserved meeting column; the
    // per-region path lays a single full-width Workspace (meetings sit on top of
    // it as their own zones — desks pack around their footprints).
    let ws_x1 = if tile_zones && claimed { col_x0 } else { x1 };
    if emit_zones {
        push_zone(
            doc,
            ZoneType::Workspace,
            ZoneShape::Rect {
                x: (x0 + ws_x1) / 2.0,
                y: (y0 + y1) / 2.0,
                w: ws_x1 - x0,
                h: y1 - y0,
            },
            &ws_label,
        );
    }
    // Fill the meeting column's leftover bands with `Core` zones so the column
    // tiles exactly (tile mode only). Slivers under ~1 m² of plate are skipped.
    if tile_zones && claimed {
        meeting_intervals.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
        let cx = col_x0 + col_mw / 2.0;
        let mut prev_bottom = y0;
        let emit_core = |top: f64, bottom: f64, doc: &mut Document| {
            let h = bottom - top;
            let on_plate = match plate {
                Some(poly) => geometry::rect_polygon_clip_area(
                    poly,
                    cx - col_mw / 2.0,
                    top,
                    cx + col_mw / 2.0,
                    bottom,
                ),
                None => h * col_mw,
            };
            if on_plate >= 1.0 {
                push_zone(
                    doc,
                    ZoneType::Core,
                    ZoneShape::Rect { x: cx, y: (top + bottom) / 2.0, w: col_mw, h },
                    "Core",
                );
            }
        };
        for &(top, bottom) in &meeting_intervals {
            emit_core(prev_bottom, top, doc);
            prev_bottom = bottom;
        }
        emit_core(prev_bottom, y1, doc);
    }

    // --- 2. Desk grid fills the work zone, skipping any cell that collides
    // with a frozen or just-placed obstacle (including meeting footprints). ----
    let mut desks_here = 0u32;
    'desks: {
        if program.desk_w <= 0.0 || program.desk_h <= 0.0 {
            break 'desks;
        }
        let (dz_x0, dz_y0, dz_y1) = (x0, y0, y1);
        if dz_x1 <= dz_x0 || dz_y1 <= dz_y0 {
            break 'desks;
        }
        let pitch_x = program.desk_w + clear;
        let pitch_y = program.desk_h + clear;
        let cols = (((dz_x1 - dz_x0) + clear) / pitch_x).floor() as i64;
        let rows = (((dz_y1 - dz_y0) + clear) / pitch_y).floor() as i64;
        if cols <= 0 || rows <= 0 {
            break 'desks;
        }
        let cluster_cols = program.cluster_cols.max(1);
        // GRID-level jitter: one offset for the whole desk field. Per-desk
        // jitter let adjacent desks drift toward each other, eroding the
        // guaranteed aisle from `clear` down to ~0.5·clear (user-visible as
        // "min corridor 0.30–0.60 m" warnings). A shared offset keeps seeds
        // producing distinct layouts while every aisle stays exactly `clear`.
        let jitter = clear * 0.25;
        let jx = rng.signed() * jitter;
        let jy = rng.signed() * jitter;

        // Row-major (rows outer) for landscape/rect regions — identical to the
        // historical order; column-major (cols outer) for portrait regions so
        // desk rows run down the long axis. The cluster aisle follows the inner
        // axis in each case.
        //
        // Two grid PHASES: the base grid, then (only if the target is unmet) a
        // half-pitch-shifted grid that catches slots the base phase lost to a
        // meeting room's clearance shadow — the failure mode of tight wings,
        // where every base row lands 0.3–0.5 m too close to the room. Desks
        // from an earlier phase fall before `grid_start`, so the full-clearance
        // regime keeps phase-2 desks a true aisle away from phase-1 rows.
        let (outer_n, inner_n) = if column_major { (cols, rows) } else { (rows, cols) };
        'phases: for phase in 0..2u32 {
        if desks_here >= desk_target {
            break 'phases;
        }
        let (px, py) = if phase == 0 {
            (0.0, 0.0)
        } else {
            (pitch_x * 0.5, pitch_y * 0.5)
        };
        let grid_start = obstacles.len();
        'grid: for o in 0..outer_n {
            for i in 0..inner_n {
                if desks_here >= desk_target {
                    break 'grid;
                }
                let (c, r) = if column_major { (o, i) } else { (i, o) };
                let (cx, cy, past_edge) = if column_major {
                    let aisle = ((r as u32) / cluster_cols) as f64 * clear;
                    let cy = dz_y0 + py + program.desk_h / 2.0 + (r as f64) * pitch_y + aisle;
                    (dz_x0 + px + program.desk_w / 2.0 + (c as f64) * pitch_x, cy, cy + program.desk_h / 2.0 > dz_y1)
                } else {
                    let aisle = ((c as u32) / cluster_cols) as f64 * clear;
                    let cx = dz_x0 + px + program.desk_w / 2.0 + (c as f64) * pitch_x + aisle;
                    (cx, dz_y0 + py + program.desk_h / 2.0 + (r as f64) * pitch_y, cx + program.desk_w / 2.0 > dz_x1)
                };
                // stop if the aisle pushed this desk past the field edge
                if past_edge {
                    continue;
                }
                // Apply the shared grid offset, clamped so the footprint can
                // never leave the work zone (and thus never the corridor).
                let fx = (cx + jx).clamp(dz_x0 + program.desk_w / 2.0, dz_x1 - program.desk_w / 2.0);
                let fy = (cy + jy).clamp(dz_y0 + program.desk_h / 2.0, dz_y1 - program.desk_h / 2.0);
                // Two clearance regimes: same-grid desks are pitched exactly
                // `clear` apart by construction (half-pad only guards fp noise),
                // but meetings/frozen/earlier-pass footprints need the FULL
                // clearance or people can't pass between a desk and a room.
                let ok = |px: f64, py: f64| {
                    slot_fits_plate(plate, px, py, program.desk_w, program.desk_h, corridor)
                        && !footprint_overlaps(
                            &obstacles[..grid_start],
                            px, py, program.desk_w, program.desk_h, clear - 1e-6,
                        )
                        && !footprint_overlaps(
                            &obstacles[grid_start..],
                            px, py, program.desk_w, program.desk_h, clear * 0.5,
                        )
                };
                // Knife-edge wings: a slot exactly at the plate margin dies to
                // ANY jitter. Fall back to the pure grid position before
                // giving the slot up — tight wings fill, roomy fields jitter.
                let (fx, fy) = if ok(fx, fy) {
                    (fx, fy)
                } else {
                    let gx = cx.clamp(dz_x0 + program.desk_w / 2.0, dz_x1 - program.desk_w / 2.0);
                    let gy = cy.clamp(dz_y0 + program.desk_h / 2.0, dz_y1 - program.desk_h / 2.0);
                    if ok(gx, gy) { (gx, gy) } else { continue; }
                };
                push_component(doc, "Desk", fx, fy, program.desk_w, program.desk_h);
                obstacles.push((fx, fy, program.desk_w, program.desk_h));
                desks_here += 1;
            }
        }
        } // 'phases
    }

    desks_here
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

    // --- capacity: fraction of requested desks actually seated ---
    let capacity = if program.desks == 0 {
        100.0
    } else {
        (100.0 * placed_desks as f64 / program.desks as f64).min(100.0)
    };

    // --- adjacency: nearest-neighbour pitch ratio (tight benches score high) ---
    let ideal_pitch = ((program.desk_w + program.desk_clearance_m)
        .min(program.desk_h + program.desk_clearance_m))
    .max(1e-6);
    let adjacency = if desks.len() < 2 {
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

    // --- density: reward desk-area / floor-area inside the 30–55 % band ---
    // Floor area is the true plate-polygon area when the walls close a loop
    // (identical to the bbox for rectangular rooms); bbox only as a fallback.
    // Otherwise an L-plate's density would be diluted by its void notch.
    let floor = geometry::trace_floor_polygon(&wall_segments(doc), geometry::LOOP_SNAP_TOL)
        .map(|poly| geometry::polygon_area(&poly))
        .unwrap_or_else(|| doc.floor_area());
    let density = if floor <= 0.0 {
        0.0
    } else {
        let desk_area: f64 = desks.iter().map(|c| c.w * c.h).sum();
        let ratio = desk_area / floor;
        // piecewise: full marks in [0.30, 0.55], linear taper to 0 at [0, 0.80].
        if ratio < 0.30 {
            (ratio / 0.30 * 100.0).clamp(0.0, 100.0)
        } else if ratio <= 0.55 {
            100.0
        } else {
            (((0.80 - ratio) / 0.25) * 100.0).clamp(0.0, 100.0)
        }
    };

    // --- circulation: the teammate-owned "walking place" evaluator ---
    // `crates/ds-core/src/circulation.rs::evaluate(doc, &CirculationConfig)`
    // returns a `CirculationScore` whose `.score` is the 0..100 headline. We feed
    // the program's target corridor width through so the corridor the generator
    // reserves is the same width the evaluator measures against.
    // (See docs/design/autonomous-testfit-loop.md §3.)
    let mut circ_cfg = CirculationConfig::default();
    circ_cfg.target_corridor_width = program.target_corridor_m;
    let circulation = circulation::evaluate(doc, &circ_cfg).score;

    // --- weighted total ---
    let wsum = (program.w_capacity + program.w_adjacency + program.w_circulation + program.w_density)
        .max(1e-6);
    let total = (program.w_capacity * capacity
        + program.w_adjacency * adjacency
        + program.w_circulation * circulation
        + program.w_density * density)
        / wsum;

    LayoutScore {
        capacity,
        adjacency,
        circulation,
        density,
        total,
        placed_desks,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Wall;

    /// Build a room from a closed corner loop (one wall per consecutive pair).
    fn room_from_corners(corners: &[(f64, f64)]) -> Document {
        let mut doc = Document::new();
        for i in 0..corners.len() {
            let (ax, ay) = corners[i];
            let (bx, by) = corners[(i + 1) % corners.len()];
            let id = doc.alloc_id();
            doc.walls.push(Wall {
                id,
                a: Point::new(ax, ay),
                b: Point::new(bx, by),
                thickness: 0.1,
            });
        }
        doc
    }

    /// Build a rectangular room `w`×`h` meters with its SW corner at origin.
    fn room(w: f64, h: f64) -> Document {
        room_from_corners(&[(0.0, 0.0), (w, 0.0), (w, h), (0.0, h)])
    }

    /// L-shaped plate: 20×14 with an 8×6 notch removed at the top-right corner
    /// (void where x > 12 and y > 8), drawn as 6 walls forming one closed loop.
    fn l_room() -> Document {
        room_from_corners(&[
            (0.0, 0.0),
            (20.0, 0.0),
            (20.0, 8.0),
            (12.0, 8.0),
            (12.0, 14.0),
            (0.0, 14.0),
        ])
    }

    #[test]
    fn generate_is_deterministic_for_same_seed() {
        let program = Program::default();
        let mut a = room(20.0, 15.0);
        let mut b = room(20.0, 15.0);
        generate(&mut a, &program, 42, false);
        generate(&mut b, &program, 42, false);
        assert_eq!(a.components.len(), b.components.len());
        for (ca, cb) in a.components.iter().zip(b.components.iter()) {
            assert_eq!(ca.category, cb.category);
            assert!((ca.x - cb.x).abs() < 1e-12, "x differs across identical seeds");
            assert!((ca.y - cb.y).abs() < 1e-12, "y differs across identical seeds");
        }
    }

    #[test]
    fn different_seeds_produce_different_layouts() {
        let program = Program::default();
        let mut a = room(20.0, 15.0);
        let mut b = room(20.0, 15.0);
        generate(&mut a, &program, 1, false);
        generate(&mut b, &program, 2, false);
        // same counts, but jittered positions must differ somewhere
        let differs = a
            .components
            .iter()
            .zip(b.components.iter())
            .any(|(ca, cb)| (ca.x - cb.x).abs() > 1e-9 || (ca.y - cb.y).abs() > 1e-9);
        assert!(differs, "distinct seeds should yield distinct layouts");
    }

    #[test]
    fn everything_stays_inside_the_perimeter_corridor() {
        let program = Program::default();
        let mut doc = room(20.0, 15.0);
        generate(&mut doc, &program, 7, false);
        let c = program.target_corridor_m;
        for comp in &doc.components {
            let left = comp.x - comp.w / 2.0;
            let right = comp.x + comp.w / 2.0;
            let bottom = comp.y - comp.h / 2.0;
            let top = comp.y + comp.h / 2.0;
            assert!(left >= 0.0 + c - 1e-6, "{} crosses left corridor", comp.label);
            assert!(right <= 20.0 - c + 1e-6, "{} crosses right corridor", comp.label);
            assert!(bottom >= 0.0 + c - 1e-6, "{} crosses bottom corridor", comp.label);
            assert!(top <= 15.0 - c + 1e-6, "{} crosses top corridor", comp.label);
        }
    }

    #[test]
    fn places_requested_when_room_is_large_enough() {
        let mut program = Program::default();
        program.desks = 12;
        program.meeting_rooms = 1;
        let mut doc = room(30.0, 20.0);
        generate(&mut doc, &program, 3, false);
        let desks = doc.components.iter().filter(|c| c.category == "Desk").count();
        let mrs = doc.components.iter().filter(|c| c.category == "MeetingRoom").count();
        assert_eq!(desks, 12, "large room should seat all requested desks");
        assert_eq!(mrs, 1);
    }

    #[test]
    fn places_multiple_meeting_rooms_when_they_fit() {
        let mut program = Program::default();
        program.meeting_rooms = 2;
        let mut doc = room(30.0, 20.0);
        generate(&mut doc, &program, 1, false);
        let mrs = doc.components.iter().filter(|c| c.category == "MeetingRoom").count();
        // The right-side column must stack both requested rooms (regression:
        // exact-pitch self-collision used to drop the 2nd).
        assert_eq!(mrs, 2, "column should stack both requested meeting rooms");
    }

    #[test]
    fn generate_clears_previous_components() {
        let program = Program::default();
        let mut doc = room(20.0, 15.0);
        generate(&mut doc, &program, 1, false);
        let first = doc.components.len();
        assert!(first > 0);
        generate(&mut doc, &program, 1, false);
        assert_eq!(doc.components.len(), first, "re-generate must not accumulate");
    }

    #[test]
    fn no_walls_is_a_noop() {
        let program = Program::default();
        let mut doc = Document::new();
        generate(&mut doc, &program, 1, false);
        assert!(doc.components.is_empty());
    }

    #[test]
    fn score_fields_are_bounded_and_capacity_tracks_placement() {
        let program = Program::default();
        let mut doc = room(30.0, 20.0);
        generate(&mut doc, &program, 5, false);
        let s = score(&doc, &program);
        for v in [s.capacity, s.adjacency, s.circulation, s.density, s.total] {
            assert!((0.0..=100.0).contains(&v), "score {} out of range", v);
        }
        // 30x20 seats the default 24 desks → capacity 100.
        assert_eq!(s.placed_desks, 24);
        assert!((s.capacity - 100.0).abs() < 1e-9);
    }

    #[test]
    fn capacity_is_partial_when_room_too_small() {
        let mut program = Program::default();
        program.desks = 200; // won't fit
        let mut doc = room(12.0, 10.0);
        generate(&mut doc, &program, 1, false);
        let s = score(&doc, &program);
        assert!(s.capacity < 100.0, "cramped room should not reach full capacity");
        assert!(s.placed_desks < 200);
    }

    #[test]
    fn zones_tile_the_bbox_without_overlap() {
        let program = Program::default();
        let mut doc = room(20.0, 14.0);
        generate(&mut doc, &program, 1, false);

        // At least the ring + workspace + meeting rooms exist.
        assert!(doc.zones.len() >= 3, "expected a tiling, got {} zones", doc.zones.len());

        // (a) Σ zone areas ≈ wall-bbox area.
        let bbox_area = 20.0 * 14.0;
        let sum: f64 = doc.zones.iter().map(|z| z.area()).sum();
        assert!(
            (sum - bbox_area).abs() < 0.5,
            "zone areas {} should tile bbox {}",
            sum,
            bbox_area
        );

        // No two Rect zones overlap (interiors). The Circulation RectRing is the
        // complement of the work zone, so it never overlaps the interior rects.
        let rects: Vec<(f64, f64, f64, f64)> = doc
            .zones
            .iter()
            .filter_map(|z| match z.shape {
                ZoneShape::Rect { x, y, w, h } => Some((x, y, w, h)),
                _ => None,
            })
            .collect();
        for (i, &(ax, ay, aw, ah)) in rects.iter().enumerate() {
            for &(bx, by, bw, bh) in rects.iter().skip(i + 1) {
                let ox = (aw + bw) / 2.0 - (ax - bx).abs();
                let oy = (ah + bh) / 2.0 - (ay - by).abs();
                assert!(
                    ox <= 1e-6 || oy <= 1e-6,
                    "rect zones overlap by ({}, {})",
                    ox,
                    oy
                );
            }
        }

        // (b) zone_stats' pct_of_nia (= area / NIA * 100) sums to ~100.
        let nia = sum;
        let pct_sum: f64 = doc.zones.iter().map(|z| z.area() / nia * 100.0).sum();
        assert!((pct_sum - 100.0).abs() < 1e-6, "pct_of_nia sum was {}", pct_sum);
    }

    #[test]
    fn every_component_is_bucketed_into_a_zone() {
        let program = Program::default();
        let mut doc = room(20.0, 14.0);
        generate(&mut doc, &program, 1, false);
        // Every component center lands in exactly one zone's component_ids.
        let assigned: usize = doc.zones.iter().map(|z| z.component_ids.len()).sum();
        assert_eq!(
            assigned,
            doc.components.len(),
            "every component must be reassigned to a zone"
        );
        // Desks live in the Workspace zone.
        let ws = doc
            .zones
            .iter()
            .find(|z| z.zone_type == ZoneType::Workspace)
            .expect("a workspace zone");
        let desks = doc.components.iter().filter(|c| c.category == "Desk").count();
        assert_eq!(ws.component_ids.len(), desks, "all desks in workspace");
    }

    #[test]
    fn l_room_keeps_every_footprint_out_of_the_notch() {
        let program = Program::default();
        let mut doc = l_room();
        generate(&mut doc, &program, 7, false);
        let desks = doc.components.iter().filter(|c| c.category == "Desk").count();
        assert!(desks > 0, "L-plate should still seat desks in its legs");
        // No corner, edge midpoint, or center of any footprint may fall in the
        // notch void (x > 12 ∧ y > 8) — that is outside the building.
        for comp in &doc.components {
            let xs = [comp.x - comp.w / 2.0, comp.x, comp.x + comp.w / 2.0];
            let ys = [comp.y - comp.h / 2.0, comp.y, comp.y + comp.h / 2.0];
            for &px in &xs {
                for &py in &ys {
                    assert!(
                        !(px > 12.0 + 1e-9 && py > 8.0 + 1e-9),
                        "{} has point ({}, {}) inside the notch void",
                        comp.label,
                        px,
                        py
                    );
                }
            }
        }
    }

    #[test]
    fn loop_tracer_finds_the_l_polygon_from_its_walls() {
        let doc = l_room();
        let segs: Vec<(Point, Point)> = doc.walls.iter().map(|w| (w.a, w.b)).collect();
        let poly = geometry::trace_floor_polygon(&segs, geometry::LOOP_SNAP_TOL)
            .expect("6 closed walls must trace a loop");
        assert_eq!(poly.len(), 6, "the L has 6 corners");
        // 20×14 − 8×6 notch = 232 m².
        assert!((geometry::polygon_area(&poly) - 232.0).abs() < 1e-9);
        assert!(geometry::point_in_polygon(5.0, 5.0, &poly));
        assert!(!geometry::point_in_polygon(16.0, 11.0, &poly), "notch is outside");
    }

    #[test]
    fn open_walls_fall_back_to_bbox_behavior() {
        // Only 3 sides of a 20×15 rect: no closed loop. The tracer must return
        // None, and generate() must match the closed 20×15 room placement-for-
        // placement (both reduce to the same bbox work zone).
        let mut open = room(20.0, 15.0);
        open.walls.pop();
        let segs: Vec<(Point, Point)> = open.walls.iter().map(|w| (w.a, w.b)).collect();
        assert!(
            geometry::trace_floor_polygon(&segs, geometry::LOOP_SNAP_TOL).is_none(),
            "open walls must not trace a loop"
        );

        let program = Program::default();
        generate(&mut open, &program, 7, false);
        let mut closed = room(20.0, 15.0);
        generate(&mut closed, &program, 7, false);
        assert!(!open.components.is_empty());
        assert_eq!(open.components.len(), closed.components.len());
        for (a, b) in open.components.iter().zip(closed.components.iter()) {
            assert_eq!(a.category, b.category);
            assert!((a.x - b.x).abs() < 1e-12 && (a.y - b.y).abs() < 1e-12);
        }
    }

    #[test]
    fn keep_confirmed_freezes_components_and_packs_around_them() {
        let program = Program::default();
        let mut doc = room(30.0, 20.0);
        generate(&mut doc, &program, 3, false);

        // Confirm (freeze) the first two desks; remember id + position.
        let frozen: Vec<(u32, f64, f64)> = doc
            .components
            .iter_mut()
            .filter(|c| c.category == "Desk")
            .take(2)
            .map(|c| {
                c.decision = DecisionState::Confirmed;
                (c.id, c.x, c.y)
            })
            .collect();
        assert_eq!(frozen.len(), 2);

        // Regenerate with a different seed, keeping confirmed.
        generate(&mut doc, &program, 9, true);

        for (id, x, y) in &frozen {
            let kept = doc
                .components
                .iter()
                .find(|c| c.id == *id)
                .expect("frozen desk was dropped on regenerate");
            assert!(
                (kept.x - x).abs() < 1e-9 && (kept.y - y).abs() < 1e-9,
                "frozen desk moved"
            );
            assert_eq!(kept.decision, DecisionState::Confirmed);
            // No other component overlaps this frozen footprint.
            for c in &doc.components {
                if c.id == *id {
                    continue;
                }
                let overlaps = (c.x - x).abs() < (c.w + program.desk_w) / 2.0
                    && (c.y - y).abs() < (c.h + program.desk_h) / 2.0;
                assert!(!overlaps, "{} overlaps a frozen desk", c.label);
            }
        }

        // Total desks never exceed the requested target.
        let desks = doc.components.iter().filter(|c| c.category == "Desk").count();
        assert!(desks <= program.desks as usize, "over-placed past target");
    }

    // ---- Irregular-plate rigor (region pipeline + the user's real building) --

    const REAL_PLATE: [(f64, f64); 43] = [
        (7.75, 1.0), (15.25, 1.5), (15.25, 2.25), (14.25, 2.5),
        (14.5, 4.0), (18.5, 4.0), (18.75, 1.0), (24.75, 1.75),
        (26.0, 2.0), (26.25, 2.5), (27.5, 2.5), (27.75, 3.0),
        (31.75, 3.75), (33.25, 4.75), (34.5, 4.75), (34.75, 5.5),
        (37.0, 6.0), (37.25, 6.75), (38.5, 6.75), (38.5, 16.75),
        (24.0, 17.0), (24.0, 21.0), (27.25, 21.25), (27.25, 39.0),
        (28.75, 39.25), (30.5, 38.5), (30.75, 39.75), (18.5, 42.75),
        (12.75, 43.25), (10.75, 42.75), (10.75, 12.25), (11.5, 12.0),
        (11.5, 10.5), (10.25, 10.0), (11.5, 9.75), (11.5, 1.75),
        (7.5, 1.75), (7.5, 10.0), (1.0, 10.25), (1.0, 1.5),
        (1.5, 2.0), (4.0, 2.0), (4.25, 1.25),
    ];

    fn real_plate_doc() -> Document {
        room_from_corners(&REAL_PLATE)
    }

    fn poly_of(doc: &Document) -> Vec<Point> {
        let segs: Vec<(Point, Point)> = doc.walls.iter().map(|w| (w.a, w.b)).collect();
        geometry::trace_floor_polygon(&segs, geometry::LOOP_SNAP_TOL).expect("plate loop")
    }

    /// All 9 sample points (corners, edge midpoints, center) inside the plate.
    fn footprint_in_plate(c: &crate::model::Component, poly: &[Point]) -> bool {
        let xs = [c.x - c.w / 2.0, c.x, c.x + c.w / 2.0];
        let ys = [c.y - c.h / 2.0, c.y, c.y + c.h / 2.0];
        xs.iter().all(|&px| ys.iter().all(|&py| geometry::point_in_polygon(px, py, poly)))
    }

    fn footprints_overlap(a: &crate::model::Component, b: &crate::model::Component) -> bool {
        (a.x - b.x).abs() < (a.w + b.w) / 2.0 - 1e-6
            && (a.y - b.y).abs() < (a.h + b.h) / 2.0 - 1e-6
    }

    fn assert_no_overlaps(doc: &Document, ctx: &str) {
        for i in 0..doc.components.len() {
            for j in (i + 1)..doc.components.len() {
                assert!(
                    !footprints_overlap(&doc.components[i], &doc.components[j]),
                    "{ctx}: {} overlaps {}",
                    doc.components[i].label,
                    doc.components[j].label
                );
            }
        }
    }

    #[test]
    fn l_plate_fills_both_wings() {
        let mut program = Program::default();
        program.desks = 30;
        program.meeting_rooms = 2;
        program.meeting_w = 3.0; // the app's DEFAULT_PROGRAM footprint
        program.meeting_h = 3.0;
        let mut doc = l_room();
        generate(&mut doc, &program, 3, false);
        let poly = poly_of(&doc);
        let desks: Vec<_> = doc.components.iter().filter(|c| c.category == "Desk").collect();
        assert!(desks.len() >= 21, "placed only {} of 30 desks", desks.len());
        // The L = a 20x8 bottom band + a 12x6 upper-left wing. BOTH must fill.
        let in_band = desks.iter().filter(|c| c.y < 8.0).count();
        let in_wing = desks.iter().filter(|c| c.y > 8.0 && c.x < 12.0).count();
        assert!(in_band >= 5, "bottom band has only {in_band} desks");
        assert!(in_wing >= 5, "upper-left wing has only {in_wing} desks");
        for c in &doc.components {
            assert!(footprint_in_plate(c, &poly), "{} escapes the plate", c.label);
        }
        assert_no_overlaps(&doc, "l_plate");
    }

    #[test]
    fn l_plate_circulation_quality() {
        // Aisle semantics: desk rows are pitched at desk_clearance_m by design,
        // so the narrowest measured passage is an access AISLE (>= clearance);
        // egress corridors (>= target) come from the per-region rings. The
        // grid-level jitter fix guarantees aisles never erode below clearance.
        let mut program = Program::default();
        program.desks = 30;
        program.meeting_rooms = 2;
        program.meeting_w = 3.0;
        program.meeting_h = 3.0;
        let mut doc = l_room();
        generate(&mut doc, &program, 3, false);
        let score = circulation::evaluate(&doc, &CirculationConfig::default());
        assert!(
            score.min_corridor_width >= 0.95 * program.desk_clearance_m,
            "narrowest aisle {:.2} m eroded below the {:.2} m clearance",
            score.min_corridor_width,
            program.desk_clearance_m
        );
        assert!(score.score >= 55.0, "circulation score {:.1} < 55", score.score);
    }

    #[test]
    fn real_building_plate_spreads_the_program() {
        // The exact plate the user's DWG traces to: 843 m2, multiple wings,
        // diagonal glazing edges - the case the old bbox packer failed on.
        let mut program = Program::default();
        program.desks = 60;
        program.meeting_rooms = 4;
        program.meeting_w = 3.0;
        program.meeting_h = 3.0;
        for seed in 1..=3u64 {
            let mut doc = real_plate_doc();
            let t0 = std::time::Instant::now();
            generate(&mut doc, &program, seed, false);
            let ms = t0.elapsed().as_millis();
            assert!(ms < 150, "seed {seed}: generate took {ms} ms (debug budget 150)");

            let poly = poly_of(&doc);
            let desks: Vec<_> = doc.components.iter().filter(|c| c.category == "Desk").collect();
            let meetings = doc.components.iter().filter(|c| c.category == "MeetingRoom").count();
            assert!(desks.len() >= 45, "seed {seed}: placed {} of 60 desks", desks.len());
            assert!(meetings >= 3, "seed {seed}: only {meetings} of 4 meeting rooms");
            for c in &doc.components {
                assert!(footprint_in_plate(c, &poly), "seed {seed}: {} escapes", c.label);
            }
            assert_no_overlaps(&doc, "real plate");

            // Spread: the desk field must span the building, not clump in one
            // wing - its bbox covers >=60% of the plate bbox on BOTH axes.
            let (px0, py0, px1, py1) = poly.iter().fold(
                (f64::MAX, f64::MAX, f64::MIN, f64::MIN),
                |(a, b, c2, d), p| (a.min(p.x), b.min(p.y), c2.max(p.x), d.max(p.y)),
            );
            let (dx0, dy0, dx1, dy1) = desks.iter().fold(
                (f64::MAX, f64::MAX, f64::MIN, f64::MIN),
                |(a, b, c2, d), k| (a.min(k.x), b.min(k.y), c2.max(k.x), d.max(k.y)),
            );
            assert!(
                (dx1 - dx0) >= 0.6 * (px1 - px0),
                "seed {seed}: desk spread x {:.1} of {:.1}",
                dx1 - dx0,
                px1 - px0
            );
            assert!(
                (dy1 - dy0) >= 0.6 * (py1 - py0),
                "seed {seed}: desk spread y {:.1} of {:.1}",
                dy1 - dy0,
                py1 - py0
            );

            // Deterministic: same seed twice -> identical layout.
            let mut again = real_plate_doc();
            generate(&mut again, &program, seed, false);
            assert_eq!(doc.components.len(), again.components.len());
            for (a, b) in doc.components.iter().zip(again.components.iter()) {
                assert_eq!(
                    (a.category.as_str(), a.x.to_bits(), a.y.to_bits()),
                    (b.category.as_str(), b.x.to_bits(), b.y.to_bits())
                );
            }
        }
    }

}
