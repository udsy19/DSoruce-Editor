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

/// Deterministically generate a test-fit into `doc` for `program`, seeded by `seed`.
///
/// Walls are preserved. When `keep_confirmed` is true, components left `Confirmed`
/// are **frozen** — kept in place and treated as obstacles so newly-placed items
/// pack around them (Laiout-style Freeze/Regenerate, design §4). When false, all
/// components are cleared for a fresh fit. Frozen items count toward the program
/// targets, so regenerating tops the plan up to the requested counts.
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
    // rectangular room it equals the bbox, so every check below passes and the
    // output is identical to the pure-bbox path. `None` (open walls) keeps the
    // historical bbox-only behavior.
    let plate = geometry::trace_floor_polygon(&wall_segments(doc), geometry::LOOP_SNAP_TOL);

    let corridor = program.target_corridor_m.max(0.0);
    let clear = program.desk_clearance_m.max(0.0);

    // Inset by the perimeter corridor on all sides → the work zone. Everything
    // placed lives strictly inside this rect, guaranteeing the corridor.
    let x0 = min_x + corridor;
    let y0 = min_y + corridor;
    let x1 = max_x - corridor;
    let y1 = max_y - corridor;
    if x1 <= x0 || y1 <= y0 {
        return; // corridor swallowed the whole floor
    }

    let mut rng = Rng::new(seed);

    // Frozen items already count toward the program targets.
    let mut rooms_placed = doc.components.iter().filter(|c| c.category == "MeetingRoom").count() as u32;
    let mut desks_placed = doc.components.iter().filter(|c| c.category == "Desk").count() as u32;

    // --- Zone tiling, part 1: perimeter Circulation ring ------------------
    // The corridor is a rectangular ring: the wall bbox minus the work-zone hole
    // (the concentric inset). Ring + work zone tile the whole bbox with no gap.
    push_zone(
        doc,
        ZoneType::Circulation,
        ZoneShape::RectRing {
            x: (min_x + max_x) / 2.0,
            y: (min_y + max_y) / 2.0,
            w: max_x - min_x,
            h: max_y - min_y,
            in_w: x1 - x0,
            in_h: y1 - y0,
        },
        "Circulation",
    );

    // --- 1. Meeting rooms: a column down the right edge of the work zone.
    // A side column (vs a full-width top band) keeps the desk field contiguous —
    // better for circulation and bench adjacency — and we only claim the column
    // if at least one desk column still fits beside it, so a shallow room never
    // ends up with meeting rooms and zero desks. Room size is clamped to fit.
    // Slots that would collide with a frozen component are skipped. Each placed
    // room also emits a `Meeting` zone matching its footprint. ---
    let mut dz_x1 = x1;
    let mut claimed = false;
    let mut col_x0 = x1; // meeting-column left edge; stays x1 when no column claimed
    let mut col_mw = 0.0f64;
    let mut meeting_intervals: Vec<(f64, f64)> = Vec::new(); // (top, bottom) per placed room
    if rooms_placed < program.meeting_rooms && program.meeting_w > 0.0 && program.meeting_h > 0.0 {
        let mw = program.meeting_w.min(x1 - x0);
        let mh = program.meeting_h.min(y1 - y0);
        let cx0 = x1 - mw;
        let mr_pitch = mh + clear;
        let rows = (((y1 - y0) + clear) / mr_pitch).floor() as i64;
        // Require room for a desk column to the left before claiming the strip.
        if rows > 0 && (cx0 - clear - x0) >= program.desk_w {
            for r in 0..rows {
                if rooms_placed >= program.meeting_rooms {
                    break;
                }
                let cx = cx0 + mw / 2.0;
                let cy = y0 + mh / 2.0 + (r as f64) * mr_pitch;
                if !slot_fits_plate(plate.as_deref(), cx, cy, mw, mh, corridor)
                    || footprint_overlaps(&obstacles[..frozen_len], cx, cy, mw, mh, clear)
                {
                    continue;
                }
                push_component(doc, "MeetingRoom", cx, cy, mw, mh);
                let room_no = rooms_placed + 1;
                push_zone(
                    doc,
                    ZoneType::Meeting,
                    ZoneShape::Rect { x: cx, y: cy, w: mw, h: mh },
                    &format!("Meeting Room {}", room_no),
                );
                obstacles.push((cx, cy, mw, mh));
                meeting_intervals.push((cy - mh / 2.0, cy + mh / 2.0));
                rooms_placed += 1;
                claimed = true;
            }
            if claimed {
                dz_x1 = cx0 - clear;
                col_x0 = cx0;
                col_mw = mw;
            }
        }
    }

    // --- Zone tiling, part 2: Workspace + Core ----------------------------
    // Workspace covers the desk field with its right edge EXTENDED to the meeting
    // column (absorbing the clear-wide aisle, v1 option (a)); when no column was
    // claimed it spans the full work-zone width. This makes ring · workspace ·
    // meeting-column a strict tile of the bbox.
    let ws_x1 = if claimed { col_x0 } else { x1 };
    push_zone(
        doc,
        ZoneType::Workspace,
        ZoneShape::Rect {
            x: (x0 + ws_x1) / 2.0,
            y: (y0 + y1) / 2.0,
            w: ws_x1 - x0,
            h: y1 - y0,
        },
        "Open Workspace",
    );
    // Fill the meeting column's leftover bands (between stacked rooms and below
    // the last one) with `Core` zones so the column tiles exactly. Slivers under
    // ~1 m² are skipped to avoid noise.
    if claimed {
        meeting_intervals.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
        let cx = col_x0 + col_mw / 2.0;
        let mut prev_bottom = y0;
        let emit_core = |top: f64, bottom: f64, doc: &mut Document| {
            let h = bottom - top;
            // Honest sliver check: measure the band's area *on the plate*
            // (clipped to the floor polygon), so a band living entirely in an
            // L-plate notch is skipped instead of reported as usable Core.
            let on_plate = match &plate {
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

    // --- 2. Desk grid fills the remaining work zone (full height), skipping
    // any grid cell that would collide with a frozen or just-placed obstacle. ---
    'desks: {
        if program.desk_w <= 0.0 || program.desk_h <= 0.0 {
            break 'desks;
        }
        let dz_x0 = x0;
        let dz_y0 = y0;
        let dz_y1 = y1;
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
        // Jitter is bounded to 25 % of the clearance so it can never eat the gap.
        let jitter = clear * 0.25;

        'grid: for r in 0..rows {
            for c in 0..cols {
                if desks_placed >= program.desks {
                    break 'grid;
                }
                // extra aisle offset: one clearance gap per completed cluster to the left
                let aisle = ((c as u32) / cluster_cols) as f64 * clear;
                let cx = dz_x0 + program.desk_w / 2.0 + (c as f64) * pitch_x + aisle;
                let cy = dz_y0 + program.desk_h / 2.0 + (r as f64) * pitch_y;
                // stop if the aisle pushed this column past the zone edge
                if cx + program.desk_w / 2.0 > dz_x1 {
                    continue;
                }
                // Apply bounded jitter, then clamp so the footprint can never leave
                // the work zone (and thus never the perimeter corridor).
                let jx = rng.signed() * jitter;
                let jy = rng.signed() * jitter;
                let fx = (cx + jx).clamp(dz_x0 + program.desk_w / 2.0, dz_x1 - program.desk_w / 2.0);
                let fy = (cy + jy).clamp(dz_y0 + program.desk_h / 2.0, dz_y1 - program.desk_h / 2.0);
                if !slot_fits_plate(plate.as_deref(), fx, fy, program.desk_w, program.desk_h, corridor)
                    || footprint_overlaps(&obstacles, fx, fy, program.desk_w, program.desk_h, clear * 0.5)
                {
                    continue;
                }
                push_component(doc, "Desk", fx, fy, program.desk_w, program.desk_h);
                obstacles.push((fx, fy, program.desk_w, program.desk_h));
                desks_placed += 1;
            }
        }
    }

    // Fill each zone's component_ids by point-in-zone on component centers.
    doc.reassign_components();
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
}
