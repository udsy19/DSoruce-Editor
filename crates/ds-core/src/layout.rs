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
    /// pair desk rows back-to-back (bench desking) instead of uniform single
    /// rows. Default **true**. The struct carries no blanket `#[serde(default)]`,
    /// so a partial JSON blob that omits this field would otherwise ERROR — the
    /// field-level default makes a missing `bench_pairs` deserialize to `true`
    /// (verified by `missing_bench_pairs_field_defaults_true`).
    #[serde(default = "default_bench_pairs")]
    pub bench_pairs: bool,

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
            bench_pairs: true,
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

/// serde field-default for `Program::bench_pairs` (missing field → bench desking on).
fn default_bench_pairs() -> bool {
    true
}

/// Back-to-back spine gap (m) between the two rows of a bench pair. Set to 0.0
/// (**touching** pairs — desks share the spine over a common cable tray, the most
/// common real bench-desking detail). A 0.15 m gap was tried first, but the
/// circulation evaluator's 0.15 m occupancy cells resolved that slot as a spurious
/// ~0.30 m "corridor" (2×cell) flanked by desks, tanking `min_corridor_width` far
/// below the aisle clearance in `l_plate_circulation_quality`. Touching pairs
/// leave no walkable cell between the two rows, so no bogus min-corridor appears,
/// and they pack even denser. Kept as a named constant so the intent — and the
/// path back to a nonzero gap on a finer circulation grid — is explicit.
const SPINE_GAP: f64 = 0.0;

/// The GLOBAL desk lattice for one `generate()` call: origin at the plate bbox
/// min corner plus ONE seed-drawn jitter (`jx`,`jy`), shared by every region so
/// adjacent wings' rows/columns land on the same lines across their seam.
#[derive(Clone, Copy)]
struct Lattice {
    ox: f64,
    oy: f64,
    jx: f64,
    jy: f64,
}

/// Tiny inline PRNG — xorshift64* (Marsaglia). Deterministic, no `rand` crate.
/// Used only to draw the one bounded global-lattice jitter per `generate()`, so
/// different seeds yield distinct but still-valid candidates for the optimizer.
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
}

fn push_component(doc: &mut Document, category: &str, x: f64, y: f64, w: f64, h: f64, rotation: f64) {
    let id = doc.alloc_id();
    doc.components.push(Component {
        id,
        category: category.to_string(),
        x,
        y,
        w,
        h,
        rotation,
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

/// Per-edge corridor inset for one region. On an edge facing the plate boundary
/// or unshared space the full `corridor` is inset; on an edge shared with an
/// adjacent region only `corridor/2` — the two neighbours' half-insets meet at
/// the seam to form exactly ONE shared corridor instead of a double-width one.
#[derive(Clone, Copy)]
struct Insets {
    left: f64,
    right: f64,
    top: f64,
    bottom: f64,
}

impl Insets {
    /// Full corridor on all four sides — the rectangular / single-region path,
    /// byte-identical to the historical symmetric inset.
    fn uniform(c: f64) -> Self {
        Insets { left: c, right: c, top: c, bottom: c }
    }
    /// Smallest horizontal / vertical inset — the symmetric `RectRing` band that
    /// still nests inside the (possibly asymmetric) work rect without overlap.
    fn min_x(&self) -> f64 {
        self.left.min(self.right)
    }
    fn min_y(&self) -> f64 {
        self.top.min(self.bottom)
    }
}

/// Minimum shared-edge overlap (m) for two regions to count as adjacent — below
/// this a mere corner-touch shouldn't halve a whole edge's corridor.
const SEAM_MIN_OVERLAP: f64 = 1.0;

/// Compute region `idx`'s per-edge insets: an edge is halved to `corridor/2`
/// when another region abuts it (co-linear within epsilon, overlapping by
/// ≥ `SEAM_MIN_OVERLAP`), else it keeps the full `corridor`.
fn region_insets(regions: &[geometry::Rect], idx: usize, corridor: f64) -> Insets {
    let r = &regions[idx];
    let half = corridor / 2.0;
    let eps = 1e-3;
    let mut ins = Insets::uniform(corridor);
    for (j, o) in regions.iter().enumerate() {
        if j == idx {
            continue;
        }
        let y_overlap = (r.y1.min(o.y1) - r.y0.max(o.y0)).max(0.0);
        let x_overlap = (r.x1.min(o.x1) - r.x0.max(o.x0)).max(0.0);
        if (o.x1 - r.x0).abs() < eps && y_overlap >= SEAM_MIN_OVERLAP {
            ins.left = half;
        }
        if (o.x0 - r.x1).abs() < eps && y_overlap >= SEAM_MIN_OVERLAP {
            ins.right = half;
        }
        if (o.y1 - r.y0).abs() < eps && x_overlap >= SEAM_MIN_OVERLAP {
            ins.bottom = half;
        }
        if (o.y0 - r.y1).abs() < eps && x_overlap >= SEAM_MIN_OVERLAP {
            ins.top = half;
        }
    }
    ins
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
            geometry::decompose_plate(poly, REGION_CELL, min_dim, REGION_MIN_AREA, &holes)
        }
        _ => Vec::new(),
    };
    // Per-region corridor insets: full corridor on plate-boundary edges, half on
    // seams shared with an adjacent region, so neighbours share ONE corridor.
    let insets: Vec<Insets> = (0..regions.len())
        .map(|i| region_insets(&regions, i, corridor))
        .collect();

    // ONE global desk lattice per generate(): origin = plate bbox min corner,
    // phase = a single seed-drawn jitter shared by EVERY region so adjacent
    // wings' rows/columns land on the same lines across their seam (the old
    // per-region jitter made them visibly misalign). Bounded to a quarter of the
    // clearance, as the per-region jitter was; the region's first-line-≥-inset
    // math absorbs it, so no desk is ever pushed into the corridor.
    let mut jrng = Rng::new(seed);
    let jitter = clear * 0.25;
    // Odd seeds shift the whole lattice by half a pitch — a second structurally
    // distinct family of layouts for the gallery (even/odd seeds differ by
    // more than cosmetic jitter).
    let half_phase = if seed % 2 == 1 { 0.5 } else { 0.0 };
    let lat = Lattice {
        ox: min_x + half_phase * (program.desk_w + clear),
        oy: min_y + half_phase * (program.desk_h + clear),
        jx: jrng.next_f64() * jitter,
        jy: jrng.next_f64() * jitter,
    };

    if regions.is_empty() {
        // --- Rectangular room / open walls / undecomposable plate -----------
        // The single-work-rect path.
        let outer = geometry::Rect { x0: min_x, y0: min_y, x1: max_x, y1: max_y };
        pack_region(
            doc, program, outer, remaining_meetings, remaining_desks,
            /*column_major=*/ false, /*region_no=*/ None, /*tile_zones=*/ true,
            /*emit_zones=*/ true,
            plate.as_deref(), &mut obstacles, frozen_len, &mut mr_counter, lat,
            Insets::uniform(corridor), corridor, clear,
        );
    } else {
        // --- Irregular plate: decompose → allocate → per-region packing -----
        let plans = allocate_regions(program, &regions, corridor, clear, remaining_meetings, remaining_desks, seed);
        let mut placed_desks = 0u32;
        for (i, &(region, m_target, d_target)) in plans.iter().enumerate() {
            // Desk rows run along the region's long axis: a portrait region packs
            // column-major so its wing fills with natural vertical rows.
            let column_major = region.height() > region.width();
            placed_desks += pack_region(
                doc, program, region, m_target, d_target,
                column_major, /*region_no=*/ Some((i + 1) as u32), /*tile_zones=*/ false,
                /*emit_zones=*/ true,
                plate.as_deref(), &mut obstacles, frozen_len, &mut mr_counter, lat,
                insets[i], corridor, clear,
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
                // SAME global lattice as the first pass → top-up slots either
                // coincide with occupied lines (rejected) or fill genuinely free
                // ones in perfect row alignment. Zones are already emitted.
                let column_major = region.height() > region.width();
                let all_frozen = obstacles.len(); // everything placed so far blocks
                let got = pack_region(
                    doc, program, region, 0, shortfall,
                    column_major, /*region_no=*/ Some((i + 1) as u32), /*tile_zones=*/ false,
                    /*emit_zones=*/ false,
                    plate.as_deref(), &mut obstacles, all_frozen, &mut mr_counter, lat,
                    insets[i], corridor, clear,
                );
                shortfall = shortfall.saturating_sub(got);
            }
        }
    }

    // Keep-outs surface as `Core` zones (gray tint, Core cost/NIA rate). Emitted
    // last so a point inside a keep-out buckets to Core, winning the
    // last-non-Circulation-wins tie over any overlapping Workspace rect.
    for (kx, ky, kw, kh, label) in &keepout_zones {
        push_zone(
            doc,
            ZoneType::Core,
            ZoneShape::Rect { x: *kx, y: *ky, w: *kw, h: *kh },
            label,
        );
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
    seed: u64,
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
    // The seed ROTATES the round-robin start so different seeds put meetings in
    // different wings — the structural variety the candidate gallery needs
    // (with the global lattice, jitter alone made every seed near-identical
    // and the near-duplicate filter collapsed the gallery to one option).
    let start = if n > 0 { (seed as usize) % n } else { 0 };
    let mut m_alloc = vec![0u32; n];
    let mut remaining_m = meetings;
    loop {
        if remaining_m == 0 {
            break;
        }
        let mut progressed = false;
        for k in 0..n {
            let i = (start + k) % n;
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
/// `meeting_target` meeting rooms anchored at the region's short end, the
/// Workspace zone(s), and a grid-packed desk field (up to `desk_target`).
/// Frozen/just-placed footprints in `obstacles` are avoided; every footprint is
/// validated against the plate polygon. `lat` is the call's GLOBAL desk lattice,
/// so this region's rows align with its neighbours'. Returns desks placed.
///
/// `insets` gives the per-edge corridor inset: full `corridor` on plate-boundary
/// edges, `corridor/2` on edges shared with a neighbour so the two half-insets
/// meet at the seam as ONE shared corridor (no double-width waste). The work
/// rect uses the asymmetric insets; the symmetric `RectRing` is emitted at the
/// per-axis MINIMUM inset so it always nests inside the work rect without
/// overlap — the honest choice, since `RectRing` can't be off-center (the only
/// cost is that the extra corridor strip on a full-inset boundary edge renders
/// as plate rather than corridor-blue, never as an overlap).
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
    lat: Lattice,
    insets: Insets,
    corridor: f64,
    clear: f64,
) -> u32 {
    // Inset by the (possibly asymmetric) corridor per edge → the work zone.
    // Everything placed lives strictly inside this rect, guaranteeing the
    // corridor on plate edges and half-corridors that pair up on shared seams.
    let x0 = outer.x0 + insets.left;
    let y0 = outer.y0 + insets.bottom;
    let x1 = outer.x1 - insets.right;
    let y1 = outer.y1 - insets.top;
    if x1 <= x0 || y1 <= y0 {
        return 0; // corridor swallowed this region
    }

    // --- Zone tiling, part 1: perimeter Circulation ring ------------------
    // A symmetric ring at the per-axis minimum inset — it nests inside the work
    // rect (never overlaps it) even when the insets are asymmetric. Adjacent
    // regions' rings meet along shared edges → the internal corridor network.
    if emit_zones {
        push_zone(
            doc,
            ZoneType::Circulation,
            ZoneShape::RectRing {
                x: (outer.x0 + outer.x1) / 2.0,
                y: (outer.y0 + outer.y1) / 2.0,
                w: outer.width(),
                h: outer.height(),
                in_w: outer.width() - 2.0 * insets.min_x(),
                in_h: outer.height() - 2.0 * insets.min_y(),
            },
            "Circulation",
        );
    }

    // --- 1. Meeting rooms: anchored at the region's SHORT end (the end of the
    // long axis) so rooms cluster at the wing tip like real test-fits, keeping
    // the desk field contiguous. A landscape (row-major) region anchors a
    // vertical column at the RIGHT edge; a portrait (column-major) region anchors
    // a horizontal band along the TOP edge. In `tile_zones` mode (rectangular,
    // always landscape) we only claim the column when a desk column still fits
    // beside it, and reserve it out of the desk field; the per-region path drops
    // that guard (a meeting-sized wing can still host a room) and lets desks pack
    // around the room footprints. Rooms clamp to fit.
    let mut dz_x1 = x1;
    let mut claimed = false;
    let mut col_x0 = x1;
    let mut col_mw = 0.0f64;
    let mut meeting_intervals: Vec<(f64, f64)> = Vec::new();
    if meeting_target > 0 && program.meeting_w > 0.0 && program.meeting_h > 0.0 {
        let mw = program.meeting_w.min(x1 - x0);
        let mh = program.meeting_h.min(y1 - y0);
        let mut placed_here = 0u32;
        // Place one room at `(cx, cy)`, recording the obstacle + Meeting zone.
        let place = |doc: &mut Document,
                         obstacles: &mut Vec<(f64, f64, f64, f64)>,
                         mr_counter: &mut u32,
                         cx: f64,
                         cy: f64|
         -> bool {
            if !slot_fits_plate(plate, cx, cy, mw, mh, corridor)
                || footprint_overlaps(&obstacles[..frozen_len], cx, cy, mw, mh, clear)
            {
                return false;
            }
            push_component(doc, "MeetingRoom", cx, cy, mw, mh, 0.0);
            *mr_counter += 1;
            push_zone(
                doc,
                ZoneType::Meeting,
                ZoneShape::Rect { x: cx, y: cy, w: mw, h: mh },
                &format!("Meeting Room {}", *mr_counter),
            );
            obstacles.push((cx, cy, mw, mh));
            true
        };

        if column_major {
            // Portrait wing → a horizontal band of rooms along the BOTTOM (base)
            // edge, so the daylit wing tip stays open desk space (real test-fits
            // give the perimeter/window wall to workstations, rooms to the core).
            let mr_pitch = mw + clear;
            let cols = (((x1 - x0) + clear) / mr_pitch).floor() as i64;
            if cols > 0 {
                for c in 0..cols {
                    if placed_here >= meeting_target {
                        break;
                    }
                    let cx = x0 + mw / 2.0 + (c as f64) * mr_pitch;
                    let cy = y0 + mh / 2.0;
                    if place(doc, obstacles, mr_counter, cx, cy) {
                        placed_here += 1;
                        claimed = true;
                    }
                }
            }
        } else {
            // Landscape wing → a vertical column at the right edge (historical).
            let cx0 = x1 - mw;
            let mr_pitch = mh + clear;
            let rows = (((y1 - y0) + clear) / mr_pitch).floor() as i64;
            let desk_room = !tile_zones || (cx0 - clear - x0) >= program.desk_w;
            if rows > 0 && desk_room {
                for r in 0..rows {
                    if placed_here >= meeting_target {
                        break;
                    }
                    let cx = cx0 + mw / 2.0;
                    let cy = y0 + mh / 2.0 + (r as f64) * mr_pitch;
                    if place(doc, obstacles, mr_counter, cx, cy) {
                        meeting_intervals.push((cy - mh / 2.0, cy + mh / 2.0));
                        placed_here += 1;
                        claimed = true;
                    }
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

    // --- 2. Desk grid fills the work zone on the GLOBAL lattice, skipping any
    // cell that collides with a frozen or just-placed obstacle (incl. meetings).
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
        let cluster_cols = program.cluster_cols.max(1);
        let bench = program.bench_pairs;
        let hw = program.desk_w / 2.0;
        let hh = program.desk_h / 2.0;

        // Two axes. The INNER axis runs uniform-pitch desks along the region's
        // long side (cluster aisles accrue here). The OUTER axis carries the rows
        // that PAIR back-to-back under bench desking. Row-major (landscape) runs
        // rows along Y (outer) with long desk rows along X (inner); a portrait
        // region transposes so its wing fills with vertical rows.
        let (inner_o, inner_dz0, inner_dz1, inner_half, inner_pitch, inner_size) = if column_major {
            (lat.oy + lat.jy, dz_y0, dz_y1, hh, pitch_y, program.desk_h)
        } else {
            (lat.ox + lat.jx, dz_x0, dz_x1, hw, pitch_x, program.desk_w)
        };
        let (outer_o, outer_dz0, outer_dz1, outer_half, outer_pitch, outer_desk) = if column_major {
            (lat.ox + lat.jx, dz_x0, dz_x1, hw, pitch_x, program.desk_w)
        } else {
            (lat.oy + lat.jy, dz_y0, dz_y1, hh, pitch_y, program.desk_h)
        };

        // GLOBAL lattice phase: the first desk line in each region is the first
        // line of the shared lattice (origin = plate bbox min + one seed jitter)
        // that clears this region's inset. Because the phase comes from the plate
        // origin — not the region corner — adjacent wings' rows/columns land on
        // the SAME lines across the seam. `ceil` picks that first line; the offset
        // it introduces is why global alignment can cost a fractional row (bench
        // pairing more than pays it back). Inner axis (uniform pitch):
        let inner_first =
            inner_o + ((inner_dz0 - inner_o) / inner_pitch).ceil() * inner_pitch + inner_half;
        let inner_n = if inner_first + inner_half <= inner_dz1 + 1e-9 {
            (((inner_dz1 - inner_half - inner_first) / inner_pitch).floor() as i64 + 1).max(0)
        } else {
            0
        };

        // OUTER axis. Under bench pairing rows come back-to-back in PAIRS:
        //   [desk | SPINE_GAP | desk(rotated π) | clear aisle] repeating,
        // block = 2·desk + SPINE_GAP + clear — DENSER than 2·(desk+clear) single
        // rows, which is exactly why real plans pair. Pairs anchor to global BLOCK
        // lines so stacked wings still share pair lines. `bench == false` restores
        // uniform single rows on the same global lattice.
        let block = 2.0 * outer_desk + SPINE_GAP + clear;
        let outer_first =
            outer_o + ((outer_dz0 - outer_o) / outer_pitch).ceil() * outer_pitch + outer_half;
        // Pairs start at the first PITCH-aligned line clearing the inset (not the
        // coarser block line — that wasted up to a full 2·desk+clear block at each
        // region's near edge, shrinking the field's spread). Two regions sharing
        // the outer range still resolve the same start, so their rows align.
        let outer_first_near = outer_first - outer_half;
        // Center + rotation of outer desk index `o`.
        let outer_at = |o: i64| -> (f64, f64) {
            if bench {
                let p = o / 2;
                let w = o % 2;
                let near = outer_first_near
                    + p as f64 * block
                    + if w == 1 { outer_desk + SPINE_GAP } else { 0.0 };
                (near + outer_half, if w == 1 { std::f64::consts::PI } else { 0.0 })
            } else {
                (outer_first + o as f64 * outer_pitch, 0.0)
            }
        };
        let outer_n = {
            let mut n = 0i64;
            while outer_at(n).0 + outer_half <= outer_dz1 + 1e-9 {
                n += 1;
            }
            n
        };
        if inner_n <= 0 || outer_n <= 0 {
            break 'desks;
        }

        // Cluster aisles accrue on the INNER axis only, capped to what the inner
        // slack absorbs so a bench aisle never costs a whole row (utilization wins;
        // the perimeter/seam corridors carry egress).
        let inner_tight = (inner_n - 1).max(0) as f64 * inner_pitch + inner_size;
        let inner_span = inner_dz1 - (inner_first - inner_half);
        let max_aisles = ((inner_span - inner_tight).max(0.0) / clear).floor().max(0.0) as u32;

        // Two clearance regimes. Same-grid desks are pitched `clear` apart (or
        // SPINE_GAP apart for a bench pair) BY CONSTRUCTION, so their check needs
        // only guard fp noise; meetings/frozen/earlier-phase footprints still need
        // the FULL clearance so a person can pass. Under pairing the same-grid pad
        // shrinks below the spine so the intended 0.15 m gap (or a touching 0.0)
        // is never flagged as a collision.
        let same_grid_pad = if bench { SPINE_GAP * 0.5 - 1e-6 } else { clear * 0.5 };

        // Two grid PHASES: the base grid, then a half-pitch-shifted pass that
        // catches slots a meeting room's clearance shadow stole from tight wings.
        // Earlier-phase desks fall before `grid_start`, so the full-clearance
        // regime keeps phase-2 desks a true aisle away from phase-1 rows.
        'phases: for phase in 0..2u32 {
            if desks_here >= desk_target {
                break 'phases;
            }
            let (inner_ph, outer_ph) = if phase == 0 {
                (0.0, 0.0)
            } else {
                (inner_pitch * 0.5, outer_pitch * 0.5)
            };
            let grid_start = obstacles.len();
            'grid: for o in 0..outer_n {
                let (outer_c, rot) = outer_at(o);
                for i in 0..inner_n {
                    if desks_here >= desk_target {
                        break 'grid;
                    }
                    let aisle = ((i as u32 / cluster_cols).min(max_aisles)) as f64 * clear;
                    let inner_c = inner_first + inner_ph + i as f64 * inner_pitch + aisle;
                    let outer_cc = outer_c + outer_ph;
                    let (cx, cy) = if column_major {
                        (outer_cc, inner_c)
                    } else {
                        (inner_c, outer_cc)
                    };
                    // stop if the cluster aisle pushed this desk past the inner edge
                    let past_edge = if column_major {
                        cy + hh > inner_dz1
                    } else {
                        cx + hw > inner_dz1
                    };
                    if past_edge {
                        continue;
                    }
                    // Clamp into the work zone (never into the corridor). Phase-0
                    // positions already sit inside by construction, so this only
                    // reins in a half-pitch phase-2 slot at the edge.
                    let fx = cx.clamp(dz_x0 + hw, dz_x1 - hw);
                    let fy = cy.clamp(dz_y0 + hh, dz_y1 - hh);
                    let ok = slot_fits_plate(plate, fx, fy, program.desk_w, program.desk_h, corridor)
                        && !footprint_overlaps(
                            &obstacles[..grid_start],
                            fx, fy, program.desk_w, program.desk_h, clear - 1e-6,
                        )
                        && !footprint_overlaps(
                            &obstacles[grid_start..],
                            fx, fy, program.desk_w, program.desk_h, same_grid_pad,
                        );
                    if !ok {
                        continue;
                    }
                    push_component(doc, "Desk", fx, fy, program.desk_w, program.desk_h, rot);
                    obstacles.push((fx, fy, program.desk_w, program.desk_h));
                    desks_here += 1;
                }
            }
        }
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
        // Back-to-back bench pairing (denser than single rows) plus seam-shared
        // corridors seat 25–29 here across seeds; the ≥24 bar keeps headroom for
        // the global-lattice alignment cost.
        assert!(desks.len() >= 24, "placed only {} of 30 desks", desks.len());
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
        // Aisle semantics: bench PAIRS touch at a 0.0 m spine (no walkable cell
        // between them, so no bogus min-corridor), and the aisle between pairs is
        // pitched at desk_clearance_m by design — so the narrowest measured passage
        // is an access AISLE (>= clearance); egress corridors (>= target) come from
        // the per-region rings. The shared global lattice keeps aisles from eroding.
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
            // Seam-shared corridors + capacity-aware cluster aisles fill the
            // whole program (60/60) on this plate; 52 leaves headroom (was 45).
            assert!(desks.len() >= 52, "seed {seed}: placed {} of 60 desks", desks.len());
            assert!(meetings >= 3, "seed {seed}: only {meetings} of 4 meeting rooms");
            for c in &doc.components {
                assert!(footprint_in_plate(c, &poly), "seed {seed}: {} escapes", c.label);
            }
            assert_no_overlaps(&doc, "real plate");

            // Circulation stays walkable. The narrowest passage is plate-inherent
            // (this real building has a ~0.30 m structural neck present even with
            // ZERO furniture), so only the aggregate score is asserted here — the
            // desk-to-desk aisle guarantee is covered by l_plate_circulation_quality.
            let circ = circulation::evaluate(&doc, &CirculationConfig::default());
            assert!(circ.score >= 55.0, "seed {seed}: circulation score {:.1} < 55", circ.score);

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

    // ---- Interior keep-outs (building core) -------------------------------

    /// True if component `c`'s footprint intersects rect (center `kx,ky`, `kw×kh`).
    fn intersects(c: &crate::model::Component, kx: f64, ky: f64, kw: f64, kh: f64) -> bool {
        (c.x - kx).abs() < (c.w + kw) / 2.0 - 1e-9 && (c.y - ky).abs() < (c.h + kh) / 2.0 - 1e-9
    }

    #[test]
    fn keepout_blocks_furniture_and_emits_core_zone() {
        // Capacity-bound program (asks for far more desks than the room seats) so
        // the keep-out's blocked core measurably lowers the placed count.
        let mut program = Program::default();
        program.desks = 100;
        program.meeting_rooms = 0;
        // Baseline capacity with no keep-out.
        let mut base = room(20.0, 15.0);
        generate(&mut base, &program, 7, false);
        let base_desks = base.components.iter().filter(|c| c.category == "Desk").count();

        // Same room with a 3×3 keep-out dead center.
        let mut doc = room(20.0, 15.0);
        doc.keepouts.push(crate::model::KeepOut {
            id: 900, x: 10.0, y: 7.5, w: 3.0, h: 3.0, label: "Stair".into(),
        });
        generate(&mut doc, &program, 7, false);

        // (a) Not one component footprint intersects the keep-out.
        for c in &doc.components {
            assert!(!intersects(c, 10.0, 7.5, 3.0, 3.0), "{} sits in the keep-out", c.label);
        }
        // (b) A Core zone with the keep-out's label + footprint exists (distinct
        // from the meeting-column Core bands the tile path also emits).
        let core = doc
            .zones
            .iter()
            .find(|z| z.zone_type == ZoneType::Core && z.label == "Stair")
            .expect("a Core zone for the keep-out");
        match core.shape {
            ZoneShape::Rect { x, y, w, h } => assert!(
                (x - 10.0).abs() < 1e-9 && (y - 7.5).abs() < 1e-9
                    && (w - 3.0).abs() < 1e-9 && (h - 3.0).abs() < 1e-9
            ),
            _ => panic!("Core zone should be a Rect"),
        }
        // (c) Capacity drops — the blocked core seats fewer desks.
        let ko_desks = doc.components.iter().filter(|c| c.category == "Desk").count();
        assert!(
            ko_desks < base_desks,
            "keep-out should reduce capacity ({ko_desks} placed vs {base_desks} baseline)"
        );
    }

    #[test]
    fn real_plate_with_keepouts_still_meets_rigor() {
        let mut program = Program::default();
        program.desks = 60;
        program.meeting_rooms = 4;
        program.meeting_w = 3.0;
        program.meeting_h = 3.0;
        // Two plausible core rects inside the plate's lower wing.
        let kos = [(14.0, 36.0, 2.5, 2.5), (20.0, 38.0, 2.5, 2.5)];
        for seed in 1..=3u64 {
            let mut doc = real_plate_doc();
            let poly0 = poly_of(&doc);
            for &(x, y, _, _) in &kos {
                assert!(geometry::point_in_polygon(x, y, &poly0), "keep-out ({x},{y}) not inside plate");
            }
            for (i, &(x, y, w, h)) in kos.iter().enumerate() {
                doc.keepouts.push(crate::model::KeepOut {
                    id: 1000 + i as u32, x, y, w, h, label: format!("Core {i}"),
                });
            }
            generate(&mut doc, &program, seed, false);

            let poly = poly_of(&doc);
            let desks: Vec<_> = doc.components.iter().filter(|c| c.category == "Desk").collect();
            let meetings = doc.components.iter().filter(|c| c.category == "MeetingRoom").count();
            // Rigor still holds with two keep-outs removing ~12 m² of core.
            assert!(desks.len() >= 52, "seed {seed}: only {} desks with keep-outs", desks.len());
            assert!(meetings >= 3, "seed {seed}: only {meetings} meeting rooms");
            for c in &doc.components {
                assert!(footprint_in_plate(c, &poly), "seed {seed}: {} escapes plate", c.label);
                for &(kx, ky, kw, kh) in &kos {
                    assert!(!intersects(c, kx, ky, kw, kh),
                        "seed {seed}: {} sits in the keep-out at ({kx},{ky})", c.label);
                }
            }
            assert_no_overlaps(&doc, "real plate + keep-outs");
            // One Core zone per keep-out.
            let cores = doc.zones.iter().filter(|z| z.zone_type == ZoneType::Core).count();
            assert_eq!(cores, kos.len(), "seed {seed}: expected {} Core zones, got {cores}", kos.len());
        }
    }

    // ---- Bench-pair desking + global lattice (round 3) --------------------

    /// Desks in a bench pair alternate rotation 0 / π, sit SPINE_GAP apart at the
    /// shared spine, and the aisle BETWEEN pairs is a full clearance.
    #[test]
    fn bench_pairs_alternate_rotation() {
        let mut program = Program::default();
        program.desks = 40;
        program.meeting_rooms = 0; // keep the field clean of a meeting column
        program.cluster_cols = 100; // no inner cluster aisles to interleave
        assert!(program.bench_pairs, "bench pairing is the default");
        let mut doc = room(20.0, 15.0); // landscape → rows pair along Y
        generate(&mut doc, &program, 5, false);
        let desks: Vec<_> = doc.components.iter().filter(|c| c.category == "Desk").collect();
        assert!(desks.len() >= 8, "need several rows to see pairs");

        // Both orientations must appear.
        let flat = desks.iter().filter(|c| c.rotation.abs() < 1e-9).count();
        let flipped = desks.iter().filter(|c| (c.rotation - std::f64::consts::PI).abs() < 1e-9).count();
        assert!(flat > 0 && flipped > 0, "expected both 0 and π rows, got {flat}/{flipped}");
        // Every desk is exactly one of the two orientations.
        for c in &desks {
            assert!(
                c.rotation.abs() < 1e-9 || (c.rotation - std::f64::consts::PI).abs() < 1e-9,
                "unexpected rotation {}",
                c.rotation
            );
        }

        // Take the fullest column (desks sharing an x line) and read its rows.
        use std::collections::BTreeMap;
        let mut cols: BTreeMap<i64, Vec<&&Component>> = BTreeMap::new();
        for c in &desks {
            cols.entry((c.x * 1000.0).round() as i64).or_default().push(c);
        }
        let mut col = cols.into_values().max_by_key(|v| v.len()).unwrap();
        col.sort_by(|a, b| a.y.partial_cmp(&b.y).unwrap());
        assert!(col.len() >= 4, "need ≥2 pairs in a column, got {}", col.len());

        let desk_h = program.desk_h;
        let clear = program.desk_clearance_m;
        // Row 0 flat, row 1 flipped (the pair), spine gap == SPINE_GAP.
        assert!(col[0].rotation.abs() < 1e-9, "row 0 should be un-rotated");
        assert!((col[1].rotation - std::f64::consts::PI).abs() < 1e-9, "row 1 should be π");
        let spine = (col[1].y - col[0].y) - desk_h;
        assert!((spine - SPINE_GAP).abs() < 1e-6, "spine gap {spine:.3} != {SPINE_GAP}");
        // Aisle between the pair and the next pair is ≥ a full clearance.
        let aisle = (col[2].y - col[1].y) - desk_h;
        assert!(aisle >= clear - 1e-6, "pair aisle {aisle:.3} < clearance {clear}");
        assert!(col[2].rotation.abs() < 1e-9, "next pair starts un-rotated");
    }

    /// With `bench_pairs = false` the generator falls back to uniform single rows:
    /// zero π rotations and a constant `desk_h + clear` row pitch.
    #[test]
    fn bench_pairs_false_reproduces_single_rows() {
        let mut program = Program::default();
        program.desks = 40;
        program.meeting_rooms = 0;
        program.cluster_cols = 100;
        program.bench_pairs = false;
        let mut doc = room(20.0, 15.0);
        generate(&mut doc, &program, 5, false);
        let desks: Vec<_> = doc.components.iter().filter(|c| c.category == "Desk").collect();
        assert!(desks.len() >= 8);

        // No desk is flipped.
        for c in &desks {
            assert!(c.rotation.abs() < 1e-9, "single rows must not rotate: {}", c.rotation);
        }
        // Old pitch: every consecutive gap in a column is desk_h + clear (no spine).
        use std::collections::BTreeMap;
        let mut cols: BTreeMap<i64, Vec<&&Component>> = BTreeMap::new();
        for c in &desks {
            cols.entry((c.x * 1000.0).round() as i64).or_default().push(c);
        }
        let mut col = cols.into_values().max_by_key(|v| v.len()).unwrap();
        col.sort_by(|a, b| a.y.partial_cmp(&b.y).unwrap());
        assert!(col.len() >= 3);
        let pitch_y = program.desk_h + program.desk_clearance_m;
        for w in col.windows(2) {
            let gap = w[1].y - w[0].y;
            assert!((gap - pitch_y).abs() < 1e-6, "row pitch {gap:.3} != single-row {pitch_y:.3}");
        }
    }

    /// Two adjacent regions of one plate anchor their desk grids to the SAME global
    /// lattice, so every desk in BOTH regions lies on shared lines modulo pitch.
    #[test]
    fn regions_share_the_global_lattice() {
        // L-plate decomposes into a bottom band and an upper-left wing (both
        // row-major). bench off + no cluster aisles + a target below capacity (so
        // only the base phase runs) leaves a pure pitch lattice on both axes.
        let mut program = Program::default();
        program.desks = 10;
        program.meeting_rooms = 0;
        program.cluster_cols = 100;
        program.bench_pairs = false;
        let mut doc = l_room();
        generate(&mut doc, &program, 3, false);
        let desks: Vec<_> = doc.components.iter().filter(|c| c.category == "Desk").collect();
        // Both regions are populated (band below y=8, wing above it at x<12).
        let band = desks.iter().filter(|c| c.y < 8.0).count();
        let wing = desks.iter().filter(|c| c.y > 8.0 && c.x < 12.0).count();
        assert!(band > 0 && wing > 0, "need desks in both regions (band {band}, wing {wing})");

        // A single global lattice: every desk x is congruent to a common residue
        // mod pitch_x, and every desk y mod pitch_y — across BOTH regions.
        let pitch_x = program.desk_w + program.desk_clearance_m;
        let pitch_y = program.desk_h + program.desk_clearance_m;
        let x0 = desks.iter().map(|c| c.x).fold(f64::MAX, f64::min);
        let y0 = desks.iter().map(|c| c.y).fold(f64::MAX, f64::min);
        for c in &desks {
            let kx = (c.x - x0) / pitch_x;
            let ky = (c.y - y0) / pitch_y;
            assert!((kx - kx.round()).abs() < 1e-6, "x {} off the shared lattice", c.x);
            assert!((ky - ky.round()).abs() < 1e-6, "y {} off the shared lattice", c.y);
        }
    }

    /// A JSON `Program` that omits `bench_pairs` must deserialize (not error) with
    /// the field defaulting to `true` — the field-level `#[serde(default)]` at work
    /// (the struct carries no blanket default, so this is the only thing keeping the
    /// UI's not-yet-updated payload from failing).
    #[test]
    fn missing_bench_pairs_field_defaults_true() {
        let without = r#"{
            "desks": 24, "meeting_rooms": 2, "desk_w": 1.6, "desk_h": 0.8,
            "meeting_w": 4.0, "meeting_h": 4.0, "cluster_cols": 4,
            "target_corridor_m": 1.2, "desk_clearance_m": 0.9,
            "w_capacity": 0.35, "w_adjacency": 0.20, "w_circulation": 0.25, "w_density": 0.20
        }"#;
        let p: Program = serde_json::from_str(without).expect("missing bench_pairs must not error");
        assert!(p.bench_pairs, "omitted bench_pairs should default to true");

        // And an explicit false is still honored.
        let with_false = without.replace(
            "\"cluster_cols\": 4,",
            "\"cluster_cols\": 4, \"bench_pairs\": false,",
        );
        let p2: Program = serde_json::from_str(&with_false).expect("explicit bench_pairs parses");
        assert!(!p2.bench_pairs, "explicit false must be honored");
    }

}
