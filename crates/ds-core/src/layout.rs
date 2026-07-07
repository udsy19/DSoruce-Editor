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
use crate::model::{Component, DecisionState};
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

/// Axis-aligned bbox of all wall endpoints (mirrors `Document::floor_area`).
/// Returns None when there are no walls (nothing to place into).
fn wall_bbox(doc: &Document) -> Option<(f64, f64, f64, f64)> {
    if doc.walls.is_empty() {
        return None;
    }
    let mut min_x = f64::INFINITY;
    let mut min_y = f64::INFINITY;
    let mut max_x = f64::NEG_INFINITY;
    let mut max_y = f64::NEG_INFINITY;
    for w in &doc.walls {
        for p in [w.a, w.b] {
            min_x = min_x.min(p.x);
            min_y = min_y.min(p.y);
            max_x = max_x.max(p.x);
            max_y = max_y.max(p.y);
        }
    }
    Some((min_x, min_y, max_x, max_y))
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
        decision: DecisionState::Open,
    });
}

/// Deterministically generate a test-fit into `doc` for `program`, seeded by `seed`.
///
/// Clears existing components (walls are preserved). Frozen components — those
/// left `Confirmed` — are the Freeze/Regenerate hook; v1 clears all, a later
/// version will retain `Confirmed` ones and pack around them (see design §4).
pub fn generate(doc: &mut Document, program: &Program, seed: u64) {
    doc.components.clear();
    doc.selection = None;

    let (min_x, min_y, max_x, max_y) = match wall_bbox(doc) {
        Some(b) => b,
        None => return, // no boundary → nothing to place
    };

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

    // --- 1. Meeting-room band across the top of the work zone ---
    let mut band_bottom = y0; // y below which desks may start
    if program.meeting_rooms > 0 && program.meeting_h > 0.0 && program.meeting_w > 0.0 {
        let mr_pitch = program.meeting_w + clear;
        let cols = (((x1 - x0) + clear) / mr_pitch).floor() as i64;
        if cols > 0 && program.meeting_h <= (y1 - y0) {
            let mut placed = 0u32;
            for c in 0..cols {
                if placed >= program.meeting_rooms {
                    break;
                }
                let cx = x0 + program.meeting_w / 2.0 + (c as f64) * mr_pitch;
                let cy = y0 + program.meeting_h / 2.0;
                push_component(doc, "MeetingRoom", cx, cy, program.meeting_w, program.meeting_h);
                placed += 1;
            }
            if placed > 0 {
                // consume the band plus one clearance aisle below it
                band_bottom = y0 + program.meeting_h + clear;
            }
        }
    }

    // --- 2. Desk grid in the remaining work zone ---
    if program.desks == 0 || program.desk_w <= 0.0 || program.desk_h <= 0.0 {
        return;
    }
    let dz_x0 = x0;
    let dz_y0 = band_bottom;
    let dz_x1 = x1;
    let dz_y1 = y1;
    if dz_x1 <= dz_x0 || dz_y1 <= dz_y0 {
        return;
    }

    let pitch_x = program.desk_w + clear;
    let pitch_y = program.desk_h + clear;
    let cols = (((dz_x1 - dz_x0) + clear) / pitch_x).floor() as i64;
    let rows = (((dz_y1 - dz_y0) + clear) / pitch_y).floor() as i64;
    if cols <= 0 || rows <= 0 {
        return;
    }

    let cluster_cols = program.cluster_cols.max(1);
    // Jitter is bounded to 25 % of the clearance so it can never eat the gap.
    let jitter = clear * 0.25;

    let mut placed = 0u32;
    'grid: for r in 0..rows {
        for c in 0..cols {
            if placed >= program.desks {
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
            push_component(doc, "Desk", fx, fy, program.desk_w, program.desk_h);
            placed += 1;
        }
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
    let floor = doc.floor_area();
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
    use crate::geometry::Point;
    use crate::model::Wall;

    /// Build a rectangular room `w`×`h` meters with its SW corner at origin.
    fn room(w: f64, h: f64) -> Document {
        let mut doc = Document::new();
        let corners = [
            (0.0, 0.0),
            (w, 0.0),
            (w, h),
            (0.0, h),
        ];
        for i in 0..4 {
            let (ax, ay) = corners[i];
            let (bx, by) = corners[(i + 1) % 4];
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

    #[test]
    fn generate_is_deterministic_for_same_seed() {
        let program = Program::default();
        let mut a = room(20.0, 15.0);
        let mut b = room(20.0, 15.0);
        generate(&mut a, &program, 42);
        generate(&mut b, &program, 42);
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
        generate(&mut a, &program, 1);
        generate(&mut b, &program, 2);
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
        generate(&mut doc, &program, 7);
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
        generate(&mut doc, &program, 3);
        let desks = doc.components.iter().filter(|c| c.category == "Desk").count();
        let mrs = doc.components.iter().filter(|c| c.category == "MeetingRoom").count();
        assert_eq!(desks, 12, "large room should seat all requested desks");
        assert_eq!(mrs, 1);
    }

    #[test]
    fn generate_clears_previous_components() {
        let program = Program::default();
        let mut doc = room(20.0, 15.0);
        generate(&mut doc, &program, 1);
        let first = doc.components.len();
        assert!(first > 0);
        generate(&mut doc, &program, 1);
        assert_eq!(doc.components.len(), first, "re-generate must not accumulate");
    }

    #[test]
    fn no_walls_is_a_noop() {
        let program = Program::default();
        let mut doc = Document::new();
        generate(&mut doc, &program, 1);
        assert!(doc.components.is_empty());
    }

    #[test]
    fn score_fields_are_bounded_and_capacity_tracks_placement() {
        let program = Program::default();
        let mut doc = room(30.0, 20.0);
        generate(&mut doc, &program, 5);
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
        generate(&mut doc, &program, 1);
        let s = score(&doc, &program);
        assert!(s.capacity < 100.0, "cramped room should not reach full capacity");
        assert!(s.placed_desks < 200);
    }
}
