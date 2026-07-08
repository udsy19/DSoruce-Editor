//! Circulation / "walking place" evaluator.
//!
//! Scores how good the walkable (circulation) space of a floor plan is. This is
//! the objective the autonomous test-fit loop optimises against: given a
//! `Document` (walls + placed components) it returns a `CirculationScore` with
//! concrete, interpretable sub-metrics plus a single 0–100 headline number.
//!
//! # Approach (grid occupancy + distance transform)
//!
//! We rasterise the wall bounding box into a uniform **occupancy grid** (cell
//! size ~0.10–0.25 m). Cells covered by a wall (respecting its thickness) or a
//! component footprint are marked *blocked*; the rest are *free*. On the free
//! cells we run a two-pass **chamfer distance transform** (an integer/float
//! approximation of the Euclidean distance transform) so every free cell knows
//! its distance to the nearest obstacle. That distance is exactly the local
//! clearance radius, so `2 × clearance` at the centreline of a passage is the
//! local **corridor width**. Local maxima of the distance field approximate the
//! **medial axis** (skeleton) of the free space — the set of passage
//! centrelines — which is where corridor-width thresholds are meaningfully
//! measured. Connected-component labelling of the free cells gives reachability
//! and fragmentation. This family of techniques (occupancy grid, distance
//! transform, medial axis, circulation grid) is the standard pragmatic toolkit
//! for spatial/circulation analysis in robotics SLAM and architectural
//! generative design.
//!
//! Chosen because it is deterministic, dependency-light (std only), O(N) in the
//! number of grid cells, and needs no polygon/skeleton libraries — so it can run
//! thousands of times inside an optimisation loop.
//!
//! # Sub-metrics and thresholds
//!
//! * `reachable_free_area` (m²) — walkable area of the enclosed floor plate
//!   (largest interior free space); the "circulation + open floor" the plan
//!   actually offers.
//! * `circulation_ratio` — `reachable_free_area / floor_area`. Industry rule of
//!   thumb: circulation is ~25–40% of usable area for legacy offices, up to
//!   ~45% for open plans (this metric also folds in open floor, so it reads
//!   higher; it is reported for context and is *not* directly scored).
//! * `min_corridor_width` (m) — narrowest passage found along any centreline;
//!   the tightest pinch a person must squeeze through.
//! * `mean_clearance` (m) — average distance-to-obstacle over walkable cells; a
//!   proxy for overall spaciousness.
//! * `pct_corridors_below_min` — fraction of centreline (medial-axis) cells
//!   whose corridor width is below `target_corridor_width`.
//! * `largest_connected_free_region` — fraction of walkable area that is one
//!   connected piece (1.0 = furniture never chops the floor into islands).
//! * `score` — 0–100 headline: `100 × (0.30·connectivity + 0.40·(1 −
//!   pct_below_min) + 0.30·min(min_width/target, 1))`.
//!
//! ## Thresholds (see module sources; confirm with product owner)
//!
//! * Target corridor width defaults to **0.9 m** ≈ ADA/IBC accessible-route
//!   continuous clear width of 36 in (0.915 m). Primary means-of-egress
//!   corridors under IBC are commonly 44 in (1.12 m); two-way passing wants
//!   60 in (1.52 m). `target_corridor_width` is configurable per use case.
//!
//! # Sources
//! * U.S. Access Board / ADA Standards, Ch.4 Accessible Routes (36 in clear,
//!   32 in pinch ≤24 in, 60 in passing): access-board.gov / ada.gov.
//! * IBC Ch.10 Means of Egress, §1020.3 corridor width (44 in min): iccsafe.org.
//! * Circulation factor 25–40% of usable area: iands.design (Avancé LLC),
//!   qpractice.com NCIDQ glossary.
//! * Distance transform / chamfer / medial axis: Fabbri et al. and
//!   Rémy & Thiel, "Medial axis for chamfer distances" (2002); general DT
//!   survey, Springer "Distance Transform Algorithms" (2007).
//! * Circulation grid / adjacency scoring in generative architectural design:
//!   US Patent 11,409,920 & 11,308,246 (Autodesk generative design).

use crate::document::Document;
use crate::geometry::{point_segment_dist, Point};
use serde::Serialize;

/// Chamfer weights: orthogonal step = 1, diagonal step ≈ √2. Gives a good
/// (~2%) approximation of the Euclidean distance transform at O(N) cost.
const CHAMFER_ORTHO: f64 = 1.0;
const CHAMFER_DIAG: f64 = 1.4142135623730951;

/// Tuning knobs for the evaluator. `Default` yields sensible office values.
#[derive(Clone, Debug, Serialize)]
#[allow(dead_code)]
pub struct CirculationConfig {
    /// Grid resolution in meters (~0.10–0.25). Smaller = more accurate, slower.
    pub cell_size: f64,
    /// Target minimum corridor width in meters (default 0.9 m ≈ ADA 36 in).
    pub target_corridor_width: f64,
    /// Extra free margin (m) rasterised around the wall bbox so the exterior
    /// flood-fill has room to run and clearances near the edge are well defined.
    pub padding: f64,
    /// Hard cap on grid cell count. If the requested resolution would exceed it,
    /// `cell_size` is coarsened so the evaluator stays cheap in a hot loop.
    pub max_cells: usize,
}

impl Default for CirculationConfig {
    fn default() -> Self {
        CirculationConfig {
            cell_size: 0.15,
            target_corridor_width: 0.9,
            padding: 0.3,
            max_cells: 4_000_000,
        }
    }
}

#[allow(dead_code)]
impl CirculationConfig {
    pub fn new() -> Self {
        CirculationConfig::default()
    }
}

/// The evaluation result. All lengths/areas in meters; all `pct`/fraction fields
/// are 0..1; `score` is 0..100. `Serialize` so it can cross the wasm boundary.
#[derive(Clone, Debug, Serialize)]
#[allow(dead_code)]
pub struct CirculationScore {
    /// Headline 0–100 circulation quality.
    pub score: f64,
    /// Walkable area of the enclosed floor plate (m²).
    pub reachable_free_area: f64,
    /// Wall-bbox floor area (m²), from `Document::floor_area`.
    pub floor_area: f64,
    /// `reachable_free_area / floor_area` (context only, not scored).
    pub circulation_ratio: f64,
    /// Narrowest passage found along any centreline (m).
    pub min_corridor_width: f64,
    /// Mean distance-to-obstacle over walkable cells (m).
    pub mean_clearance: f64,
    /// Fraction of centreline cells narrower than the target width (0..1).
    pub pct_corridors_below_min: f64,
    /// Fraction of walkable area that is a single connected region (0..1).
    pub largest_connected_free_region: f64,
    /// True if a wall-enclosed interior was detected (vs. an open/unbounded plan
    /// where we fall back to the largest connected free blob).
    pub enclosed: bool,
    /// Grid dimensions actually used (diagnostics).
    pub grid_cols: usize,
    pub grid_rows: usize,
    pub cell_size: f64,
}

impl CirculationScore {
    /// Degenerate result (no walls, empty plan, or no walkable space).
    fn empty(floor_area: f64, cols: usize, rows: usize, cell: f64, enclosed: bool) -> Self {
        CirculationScore {
            score: 0.0,
            reachable_free_area: 0.0,
            floor_area,
            circulation_ratio: 0.0,
            min_corridor_width: 0.0,
            mean_clearance: 0.0,
            pct_corridors_below_min: 1.0,
            largest_connected_free_region: 0.0,
            enclosed,
            grid_cols: cols,
            grid_rows: rows,
            cell_size: cell,
        }
    }
}

/// Occupancy grid over the (padded) wall bounding box.
struct Grid {
    cols: usize,
    rows: usize,
    cell: f64,
    origin_x: f64,
    origin_y: f64,
    /// true = blocked (wall or component), false = free.
    blocked: Vec<bool>,
}

impl Grid {
    #[inline]
    fn idx(&self, x: usize, y: usize) -> usize {
        y * self.cols + x
    }

    /// Center of cell (x, y) in world meters.
    #[inline]
    fn cell_center(&self, x: usize, y: usize) -> Point {
        Point::new(
            self.origin_x + (x as f64 + 0.5) * self.cell,
            self.origin_y + (y as f64 + 0.5) * self.cell,
        )
    }

    /// Clamp a world coordinate to a valid column/row index.
    #[inline]
    fn col_of(&self, wx: f64) -> usize {
        let c = ((wx - self.origin_x) / self.cell).floor();
        c.clamp(0.0, (self.cols - 1) as f64) as usize
    }
    #[inline]
    fn row_of(&self, wy: f64) -> usize {
        let r = ((wy - self.origin_y) / self.cell).floor();
        r.clamp(0.0, (self.rows - 1) as f64) as usize
    }
}

/// Evaluate the circulation quality of `doc`. Pure and deterministic.
///
/// Complexity: O(N) in grid cells `N = cols·rows` for the distance transform,
/// connectivity and metrics, plus rasterisation cost roughly O(Σ wall_len/cell)
/// + O(Σ component_area/cell²). With defaults a typical floor is well under a
/// million cells, so thousands of calls per second are feasible.
#[allow(dead_code)]
pub fn evaluate(doc: &Document, cfg: &CirculationConfig) -> CirculationScore {
    let floor_area = doc.floor_area();

    // --- 1. Build the occupancy grid -------------------------------------
    let grid = match build_grid(doc, cfg) {
        Some(g) => g,
        None => return CirculationScore::empty(floor_area, 0, 0, cfg.cell_size, false),
    };
    let n = grid.cols * grid.rows;
    let cell_area = grid.cell * grid.cell;

    // --- 2. Connected-component labelling of free cells -------------------
    // labels: -1 blocked, else component id. Also record which components touch
    // the grid border (== the exterior / outside-the-building free space).
    let (labels, comp_sizes, touches_border) = label_free_regions(&grid);

    // Interior = free cells whose component does NOT touch the border, i.e.
    // space enclosed by walls. Fall back to the largest free blob if the plan
    // is not enclosed (open layout with no complete outer wall ring).
    let total_free: usize = comp_sizes.iter().sum();
    if total_free == 0 {
        return CirculationScore::empty(floor_area, grid.cols, grid.rows, grid.cell, false);
    }

    let mut interior_total = 0usize;
    for (id, &size) in comp_sizes.iter().enumerate() {
        if !touches_border[id] {
            interior_total += size;
        }
    }
    let enclosed = interior_total as f64 >= 0.05 * total_free as f64;

    // `walkable[id]` marks which components count as walkable floor.
    let mut walkable_comp = vec![false; comp_sizes.len()];
    let (largest_frac, walkable_cells) = if enclosed {
        // Walkable = all interior components; connectivity = largest / interior.
        let mut largest = 0usize;
        for (id, &size) in comp_sizes.iter().enumerate() {
            if !touches_border[id] {
                walkable_comp[id] = true;
                largest = largest.max(size);
            }
        }
        (largest as f64 / interior_total as f64, interior_total)
    } else {
        // Open plan: walkable = single largest free component; it is by
        // definition fully connected, so connectivity fraction is 1.0.
        let mut best_id = 0usize;
        let mut best = 0usize;
        for (id, &size) in comp_sizes.iter().enumerate() {
            if size > best {
                best = size;
                best_id = id;
            }
        }
        walkable_comp[best_id] = true;
        (1.0, best)
    };

    if walkable_cells == 0 {
        return CirculationScore::empty(floor_area, grid.cols, grid.rows, grid.cell, enclosed);
    }

    // Boolean mask of the walkable set for cheap lookups.
    let mut walkable = vec![false; n];
    for i in 0..n {
        if labels[i] >= 0 && walkable_comp[labels[i] as usize] {
            walkable[i] = true;
        }
    }

    // --- 3. Distance transform (clearance to nearest obstacle) -----------
    let dt = distance_transform(&grid); // in CELL units

    // --- 4. Corridor / clearance metrics over walkable cells -------------
    // Clearance (m) = dt * cell (dt is in CELL units). Corridor width at a
    // passage centreline = 2·clearance.
    // We measure width at *chokepoints* — saddle points of the clearance field,
    // where a passage is a local max across its width but a local min along its
    // length (see `choke_axis`). Saddles are exactly the constrictions a
    // person must pass through, and unlike raw medial-axis maxima they do not
    // suffer from boundary/corner spurs (which are monotonic slopes, not saddles).
    let mut clearance_sum = 0.0f64;
    let mut clearance_count = 0usize;
    let mut choke_count = 0usize;
    let mut choke_below = 0usize;
    let mut min_width = f64::INFINITY;
    let mut max_clearance = 0.0f64;
    // A pinch only counts as a CORRIDOR chokepoint if it separates meaningful
    // walkable area on both pinch sides. The traced plate's V-shaped boundary
    // notches form walkable strings that narrow to nothing — locally they look
    // exactly like corridors (walkable both ways, strict ridge), so dead-end-
    // ness must be established by connectivity, not the saddle test. 2 m² is
    // "a human can stand there and needs to get out"; anything smaller is a
    // geometry artifact nobody routes through.
    let pocket_cells = ((2.0 / (grid.cell * grid.cell)).ceil() as usize).max(4);
    let mut chokes: Vec<(usize, usize, bool, f64)> = Vec::new();

    for y in 0..grid.rows {
        for x in 0..grid.cols {
            let i = grid.idx(x, y);
            if !walkable[i] {
                continue;
            }
            let d = dt[i];
            clearance_sum += d * grid.cell;
            clearance_count += 1;
            max_clearance = max_clearance.max(d * grid.cell);

            if let Some(vertical) = choke_axis(&grid, &dt, x, y) {
                chokes.push((x, y, vertical, 2.0 * d * grid.cell));
            }
        }
    }
    for &(x, y, vertical, width) in &chokes {
        if !separates_area(&grid, &walkable, x, y, vertical, pocket_cells) {
            continue; // dead-end pocket, not a route
        }
        choke_count += 1;
        min_width = min_width.min(width);
        if width < cfg.target_corridor_width {
            choke_below += 1;
        }
    }

    let mean_clearance = if clearance_count > 0 {
        clearance_sum / clearance_count as f64
    } else {
        0.0
    };
    let (min_corridor_width, pct_below) = if choke_count > 0 {
        (min_width, choke_below as f64 / choke_count as f64)
    } else {
        // No constriction detected (a single open blob with no saddle): report
        // the plan's widest open span as the "narrowest corridor" and treat it
        // as fully compliant.
        (2.0 * max_clearance, 0.0)
    };

    let reachable_free_area = walkable_cells as f64 * cell_area;
    let circulation_ratio = if floor_area > 0.0 {
        reachable_free_area / floor_area
    } else {
        0.0
    };

    // --- 5. Headline score ------------------------------------------------
    let s_conn = largest_frac.clamp(0.0, 1.0);
    let s_below = (1.0 - pct_below).clamp(0.0, 1.0);
    let s_minw = (min_corridor_width / cfg.target_corridor_width).clamp(0.0, 1.0);
    let score = 100.0 * (0.30 * s_conn + 0.40 * s_below + 0.30 * s_minw);

    CirculationScore {
        score,
        reachable_free_area,
        floor_area,
        circulation_ratio,
        min_corridor_width,
        mean_clearance,
        pct_corridors_below_min: pct_below,
        largest_connected_free_region: s_conn,
        enclosed,
        grid_cols: grid.cols,
        grid_rows: grid.rows,
        cell_size: grid.cell,
    }
}

/// Compute the padded wall bbox and rasterise walls + components into it.
/// Returns `None` if there are no walls (nothing to bound).
fn build_grid(doc: &Document, cfg: &CirculationConfig) -> Option<Grid> {
    if doc.walls.is_empty() {
        return None;
    }

    let mut min_x = f64::INFINITY;
    let mut min_y = f64::INFINITY;
    let mut max_x = f64::NEG_INFINITY;
    let mut max_y = f64::NEG_INFINITY;
    for w in &doc.walls {
        for p in [w.a, w.b] {
            let half = w.thickness * 0.5;
            min_x = min_x.min(p.x - half);
            min_y = min_y.min(p.y - half);
            max_x = max_x.max(p.x + half);
            max_y = max_y.max(p.y + half);
        }
    }
    if !min_x.is_finite() || max_x <= min_x || max_y <= min_y {
        return None;
    }

    let pad = cfg.padding.max(0.0);
    let origin_x = min_x - pad;
    let origin_y = min_y - pad;
    let span_x = (max_x - min_x) + 2.0 * pad;
    let span_y = (max_y - min_y) + 2.0 * pad;

    // Coarsen the cell size if the requested resolution would blow the budget.
    let mut cell = cfg.cell_size.max(1e-3);
    loop {
        let cols = (span_x / cell).ceil() as usize + 1;
        let rows = (span_y / cell).ceil() as usize + 1;
        if cols.saturating_mul(rows) <= cfg.max_cells || cell > span_x.max(span_y) {
            let cols = cols.max(1);
            let rows = rows.max(1);
            let mut grid = Grid {
                cols,
                rows,
                cell,
                origin_x,
                origin_y,
                blocked: vec![false; cols * rows],
            };
            rasterize_walls(&mut grid, doc);
            rasterize_components(&mut grid, doc);
            return Some(grid);
        }
        cell *= 1.5;
    }
}

/// Mark cells within `thickness/2` of any wall segment as blocked.
fn rasterize_walls(grid: &mut Grid, doc: &Document) {
    for w in &doc.walls {
        let half = (w.thickness * 0.5).max(grid.cell * 0.5);
        // Iterate only over the segment's expanded AABB.
        let lo_x = grid.col_of(w.a.x.min(w.b.x) - half);
        let hi_x = grid.col_of(w.a.x.max(w.b.x) + half);
        let lo_y = grid.row_of(w.a.y.min(w.b.y) - half);
        let hi_y = grid.row_of(w.a.y.max(w.b.y) + half);
        for y in lo_y..=hi_y {
            for x in lo_x..=hi_x {
                let c = grid.cell_center(x, y);
                if point_segment_dist(c, w.a, w.b) <= half {
                    let i = grid.idx(x, y);
                    grid.blocked[i] = true;
                }
            }
        }
    }
}

/// Mark cells inside each component's (rotation-aware) footprint as blocked.
fn rasterize_components(grid: &mut Grid, doc: &Document) {
    for comp in &doc.components {
        let hw = comp.w * 0.5;
        let hh = comp.h * 0.5;
        // Bounding radius of the (possibly rotated) rectangle.
        let r = (hw * hw + hh * hh).sqrt();
        let lo_x = grid.col_of(comp.x - r);
        let hi_x = grid.col_of(comp.x + r);
        let lo_y = grid.row_of(comp.y - r);
        let hi_y = grid.row_of(comp.y + r);
        let (s, cta) = comp.rotation.sin_cos();
        for y in lo_y..=hi_y {
            for x in lo_x..=hi_x {
                let p = grid.cell_center(x, y);
                let dx = p.x - comp.x;
                let dy = p.y - comp.y;
                // Rotate point into the component's local (un-rotated) frame.
                let lx = dx * cta + dy * s;
                let ly = -dx * s + dy * cta;
                if lx.abs() <= hw && ly.abs() <= hh {
                    let i = grid.idx(x, y);
                    grid.blocked[i] = true;
                }
            }
        }
    }
}

/// Label connected free regions (4-connectivity) via iterative BFS.
/// Returns (labels, component_sizes, component_touches_border).
fn label_free_regions(grid: &Grid) -> (Vec<i32>, Vec<usize>, Vec<bool>) {
    let n = grid.cols * grid.rows;
    let mut labels = vec![-1i32; n];
    let mut sizes: Vec<usize> = Vec::new();
    let mut border: Vec<bool> = Vec::new();
    let mut queue: Vec<usize> = Vec::new();

    for start in 0..n {
        if grid.blocked[start] || labels[start] != -1 {
            continue;
        }
        let id = sizes.len() as i32;
        sizes.push(0);
        border.push(false);
        labels[start] = id;
        queue.clear();
        queue.push(start);
        while let Some(cur) = queue.pop() {
            sizes[id as usize] += 1;
            let cx = cur % grid.cols;
            let cy = cur / grid.cols;
            if cx == 0 || cy == 0 || cx == grid.cols - 1 || cy == grid.rows - 1 {
                border[id as usize] = true;
            }
            // 4-connected neighbours.
            let push = |nx: usize, ny: usize, labels: &mut Vec<i32>, q: &mut Vec<usize>| {
                let ni = ny * grid.cols + nx;
                if !grid.blocked[ni] && labels[ni] == -1 {
                    labels[ni] = id;
                    q.push(ni);
                }
            };
            if cx > 0 {
                push(cx - 1, cy, &mut labels, &mut queue);
            }
            if cx + 1 < grid.cols {
                push(cx + 1, cy, &mut labels, &mut queue);
            }
            if cy > 0 {
                push(cx, cy - 1, &mut labels, &mut queue);
            }
            if cy + 1 < grid.rows {
                push(cx, cy + 1, &mut labels, &mut queue);
            }
        }
    }
    (labels, sizes, border)
}

/// Two-pass chamfer distance transform: distance (in CELL units) from each free
/// cell to the nearest blocked cell. Blocked cells are seeds at distance 0.
fn distance_transform(grid: &Grid) -> Vec<f64> {
    let n = grid.cols * grid.rows;
    let mut dt = vec![0.0f64; n];
    for i in 0..n {
        dt[i] = if grid.blocked[i] { 0.0 } else { f64::INFINITY };
    }
    let cols = grid.cols;
    let rows = grid.rows;

    // Forward pass: neighbours up-left, up, up-right, left.
    for y in 0..rows {
        for x in 0..cols {
            let i = y * cols + x;
            if grid.blocked[i] {
                continue;
            }
            let mut d = dt[i];
            if x > 0 {
                d = d.min(dt[i - 1] + CHAMFER_ORTHO);
            }
            if y > 0 {
                d = d.min(dt[i - cols] + CHAMFER_ORTHO);
                if x > 0 {
                    d = d.min(dt[i - cols - 1] + CHAMFER_DIAG);
                }
                if x + 1 < cols {
                    d = d.min(dt[i - cols + 1] + CHAMFER_DIAG);
                }
            }
            dt[i] = d;
        }
    }
    // Backward pass: neighbours down-right, down, down-left, right.
    for y in (0..rows).rev() {
        for x in (0..cols).rev() {
            let i = y * cols + x;
            if grid.blocked[i] {
                continue;
            }
            let mut d = dt[i];
            if x + 1 < cols {
                d = d.min(dt[i + 1] + CHAMFER_ORTHO);
            }
            if y + 1 < rows {
                d = d.min(dt[i + cols] + CHAMFER_ORTHO);
                if x + 1 < cols {
                    d = d.min(dt[i + cols + 1] + CHAMFER_DIAG);
                }
                if x > 0 {
                    d = d.min(dt[i + cols - 1] + CHAMFER_DIAG);
                }
            }
            dt[i] = d;
        }
    }
    dt
}

/// A free cell is a **chokepoint** (a saddle of the clearance field) if it is a
/// local maximum across the passage in one axis and a local minimum along the
/// passage in the perpendicular axis. Two orientations:
///
/// * vertical passage (obstacles left & right): local max horizontally
///   (`c ≥ left,right`) and local min vertically (`up,down ≥ c`);
/// * horizontal passage (obstacles above & below): local max vertically and
///   local min horizontally.
///
/// This fires exactly at constrictions. Peaks (open-room centres: max on both
/// axes) and pits (concave corners: min on both axes) are excluded, and so are
/// monotonic boundary/corner spurs (they satisfy neither a max nor a min on the
/// slope axis). Ties are allowed so flat plateaus in wide rooms still register
/// (with their large, non-penalising width). Blocked neighbours read as 0, so a
/// cell needs obstacles flanking *both* sides of the constricted axis to qualify.
/// True when severing the corridor at chokepoint `(x, y)` (blocking the whole
/// contiguous walkable run ACROSS the passage, not just one cell — a flood
/// could otherwise sneak around the block within the pinch's own width) still
/// leaves at least `need` walkable cells reachable on EACH route side. A pinch
/// guarding a dead-end pocket fails this: it is boundary-geometry, not a route.
/// `vertical` = the route runs along y. Bounded BFS (stops at `need`).
fn separates_area(
    grid: &Grid,
    walkable: &[bool],
    x: usize,
    y: usize,
    vertical: bool,
    need: usize,
) -> bool {
    // The blocked band: the contiguous walkable run through (x, y) along the
    // WIDTH axis (x for a vertical passage, y for a horizontal one).
    let mut blocked = vec![false; walkable.len()];
    if vertical {
        let mut c = x;
        loop {
            blocked[grid.idx(c, y)] = true;
            if c == 0 || !walkable[grid.idx(c - 1, y)] {
                break;
            }
            c -= 1;
        }
        let mut c = x;
        while c + 1 < grid.cols && walkable[grid.idx(c + 1, y)] {
            c += 1;
            blocked[grid.idx(c, y)] = true;
        }
    } else {
        let mut r = y;
        loop {
            blocked[grid.idx(x, r)] = true;
            if r == 0 || !walkable[grid.idx(x, r - 1)] {
                break;
            }
            r -= 1;
        }
        let mut r = y;
        while r + 1 < grid.rows && walkable[grid.idx(x, r + 1)] {
            r += 1;
            blocked[grid.idx(x, r)] = true;
        }
    }

    // Flood each route side independently; both must reach `need`.
    let sides: [(i64, i64); 2] = if vertical { [(0, -1), (0, 1)] } else { [(-1, 0), (1, 0)] };
    for &(dx, dy) in &sides {
        let nx = x as i64 + dx;
        let ny = y as i64 + dy;
        if nx < 0 || ny < 0 || nx as usize >= grid.cols || ny as usize >= grid.rows {
            return false;
        }
        let start = grid.idx(nx as usize, ny as usize);
        if !walkable[start] || blocked[start] {
            return false;
        }
        let mut seen = vec![false; walkable.len()];
        let mut queue = std::collections::VecDeque::new();
        seen[start] = true;
        queue.push_back((nx as usize, ny as usize));
        let mut count = 0usize;
        while let Some((cx, cy)) = queue.pop_front() {
            count += 1;
            if count >= need {
                break;
            }
            let steps = [
                (cx.wrapping_sub(1), cy),
                (cx + 1, cy),
                (cx, cy.wrapping_sub(1)),
                (cx, cy + 1),
            ];
            for &(sx, sy) in &steps {
                if sx >= grid.cols || sy >= grid.rows {
                    continue;
                }
                let si = grid.idx(sx, sy);
                if walkable[si] && !seen[si] && !blocked[si] {
                    seen[si] = true;
                    queue.push_back((sx, sy));
                }
            }
        }
        if count < need {
            return false;
        }
    }
    true
}
/// The passage direction at a chokepoint: `Some(true)` = the route runs along
/// y (vertical passage; its width is measured across x), `Some(false)` = along
/// x. `None` = not a chokepoint (incl. plateau cells and dead-end wedges).
fn choke_axis(grid: &Grid, dt: &[f64], x: usize, y: usize) -> Option<bool> {
    let i = grid.idx(x, y);
    let c = dt[i];
    if !c.is_finite() || c <= 0.0 {
        return None;
    }
    let nb = |nx: i64, ny: i64| -> f64 {
        if nx < 0 || ny < 0 || nx as usize >= grid.cols || ny as usize >= grid.rows {
            0.0
        } else {
            dt[ny as usize * grid.cols + nx as usize]
        }
    };
    let xi = x as i64;
    let yi = y as i64;
    let (left, right, up, down) = (nb(xi - 1, yi), nb(xi + 1, yi), nb(xi, yi - 1), nb(xi, yi + 1));
    let max_h = c >= left && c >= right && (c > left || c > right);
    let min_h = left >= c && right >= c;
    let max_v = c >= up && c >= down && (c > up || c > down);
    let min_v = up >= c && down >= c;
    if max_h && min_v && up > 0.0 && down > 0.0 {
        Some(true) // vertical passage: wide across x, route along y
    } else if max_v && min_h && left > 0.0 && right > 0.0 {
        Some(false) // horizontal passage: route along x
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::geometry::Point;
    use crate::model::{Component, DecisionState, Wall};

    /// Build a rectangular room [0,w]×[0,h] with 0.1 m walls.
    fn room(w: f64, h: f64) -> Document {
        let mut doc = Document::new();
        let t = 0.1;
        let corners = [
            (Point::new(0.0, 0.0), Point::new(w, 0.0)),
            (Point::new(w, 0.0), Point::new(w, h)),
            (Point::new(w, h), Point::new(0.0, h)),
            (Point::new(0.0, h), Point::new(0.0, 0.0)),
        ];
        for (a, b) in corners {
            let id = doc.alloc_id();
            doc.walls.push(Wall { id, a, b, thickness: t });
        }
        doc
    }

    fn add_box(doc: &mut Document, x: f64, y: f64, w: f64, h: f64) {
        let id = doc.alloc_id();
        doc.components.push(Component {
            id,
            category: "Desk".to_string(),
            x,
            y,
            w,
            h,
            rotation: 0.0,
            label: "box".to_string(),
            product_id: None,
            price_inr: None,
            decision: DecisionState::Open,
        });
    }

    #[test]
    fn empty_document_is_zero_and_safe() {
        let doc = Document::new();
        let s = evaluate(&doc, &CirculationConfig::default());
        assert_eq!(s.score, 0.0);
        assert_eq!(s.reachable_free_area, 0.0);
        assert!(!s.enclosed);
    }

    #[test]
    fn empty_room_is_well_connected_and_spacious() {
        let doc = room(6.0, 5.0);
        let s = evaluate(&doc, &CirculationConfig::default());
        assert!(s.enclosed, "a walled room should read as enclosed");
        // Interior ~ (6-0.1)*(5-0.1) ≈ 28.9 m²; allow generous slack for raster.
        assert!(
            s.reachable_free_area > 24.0 && s.reachable_free_area < 30.0,
            "reachable area was {}",
            s.reachable_free_area
        );
        // One open room => single connected region and no sub-target pinch.
        assert!((s.largest_connected_free_region - 1.0).abs() < 1e-6);
        assert!(s.min_corridor_width > 0.9, "min width {}", s.min_corridor_width);
        assert!(s.score > 90.0, "score {}", s.score);
    }

    #[test]
    fn narrow_gap_between_furniture_lowers_min_width() {
        // Two blocks leaving only a ~0.4 m slot between them: sub-target pinch.
        // block1 spans x 1.3..3.3, block2 spans x 3.7..5.7 → 0.4 m gap at x≈3.5.
        let mut doc = room(6.0, 5.0);
        add_box(&mut doc, 2.3, 2.5, 2.0, 3.6);
        add_box(&mut doc, 4.7, 2.5, 2.0, 3.6);
        let s = evaluate(&doc, &CirculationConfig::default());
        assert!(
            s.min_corridor_width < 0.9,
            "expected a sub-target pinch, got {}",
            s.min_corridor_width
        );
        assert!(
            s.pct_corridors_below_min > 0.0,
            "expected some corridor below target"
        );
        assert!(s.score < 95.0);
    }
}
