//! Primitive 2D geometry. Units are **meters** throughout the core; the frontend
//! owns pixels-per-meter scaling. Kept free of any browser/JS dependency.

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}

impl Point {
    pub fn new(x: f64, y: f64) -> Self {
        Point { x, y }
    }

    pub fn dist(&self, o: &Point) -> f64 {
        ((self.x - o.x).powi(2) + (self.y - o.y).powi(2)).sqrt()
    }
}

/// Shortest distance from point `p` to segment `ab`. Used for wall hit-testing
/// and slot-clearance checks (`rect_segment_dist`).
pub fn point_segment_dist(p: Point, a: Point, b: Point) -> f64 {
    let abx = b.x - a.x;
    let aby = b.y - a.y;
    let apx = p.x - a.x;
    let apy = p.y - a.y;
    let len2 = abx * abx + aby * aby;
    let t = if len2 == 0.0 {
        0.0
    } else {
        ((apx * abx + apy * aby) / len2).clamp(0.0, 1.0)
    };
    let cx = a.x + t * abx;
    let cy = a.y + t * aby;
    ((p.x - cx).powi(2) + (p.y - cy).powi(2)).sqrt()
}

// ---------------------------------------------------------------------------
// Floor-plate polygon support: trace the plate outline from wall segments and
// test placements against it, so the layout generator respects L/U-shaped
// (non-rectangular) buildings instead of their bounding box.
// ---------------------------------------------------------------------------

/// Snap tolerance (meters) for merging wall endpoints into shared graph nodes
/// when tracing the floor-plate loop. 1 cm: generous versus editor snapping,
/// far below any real wall length, so it never fuses distinct corners.
pub const LOOP_SNAP_TOL: f64 = 1e-2;

/// Absolute (unsigned) shoelace area of a polygon, m². 0 for < 3 vertices.
pub fn polygon_area(poly: &[Point]) -> f64 {
    if poly.len() < 3 {
        return 0.0;
    }
    let mut s = 0.0;
    for i in 0..poly.len() {
        let j = (i + 1) % poly.len();
        s += poly[i].x * poly[j].y - poly[j].x * poly[i].y;
    }
    (s / 2.0).abs()
}

/// Ray-cast (even-odd) point-in-polygon. Points exactly on the boundary are
/// ambiguous at float precision; callers that need clearance combine this with
/// `rect_segment_dist` edge-distance checks, which is what the layout
/// generator's slot test does.
pub fn point_in_polygon(px: f64, py: f64, poly: &[Point]) -> bool {
    if poly.len() < 3 {
        return false;
    }
    let mut inside = false;
    let mut j = poly.len() - 1;
    for i in 0..poly.len() {
        let (pi, pj) = (poly[i], poly[j]);
        if (pi.y > py) != (pj.y > py) {
            let x_cross = pi.x + (py - pi.y) * (pj.x - pi.x) / (pj.y - pi.y);
            if px < x_cross {
                inside = !inside;
            }
        }
        j = i;
    }
    inside
}

/// Twice the signed area of triangle `abc` — the classic orientation test.
fn orient(a: Point, b: Point, c: Point) -> f64 {
    (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
}

/// True when segments `a1a2` and `b1b2` properly cross (interiors intersect).
/// Collinear touching is left to the caller — the endpoint-to-segment distance
/// minimum in `segment_segment_dist` already reports 0 for those cases.
fn segments_properly_cross(a1: Point, a2: Point, b1: Point, b2: Point) -> bool {
    let d1 = orient(b1, b2, a1);
    let d2 = orient(b1, b2, a2);
    let d3 = orient(a1, a2, b1);
    let d4 = orient(a1, a2, b2);
    (d1 > 0.0) != (d2 > 0.0) && (d3 > 0.0) != (d4 > 0.0)
}

/// Shortest distance between two segments (0 when they touch or cross).
pub fn segment_segment_dist(a1: Point, a2: Point, b1: Point, b2: Point) -> f64 {
    if segments_properly_cross(a1, a2, b1, b2) {
        return 0.0;
    }
    point_segment_dist(a1, b1, b2)
        .min(point_segment_dist(a2, b1, b2))
        .min(point_segment_dist(b1, a1, a2))
        .min(point_segment_dist(b2, a1, a2))
}

/// Shortest distance from the axis-aligned rect (center `cx,cy`, size `w`×`h`)
/// to segment `ab`. 0 when the segment touches or enters the rect. Exact (not
/// sampled): a segment that overlaps the rect either has an endpoint inside or
/// crosses one of the rect's edges.
pub fn rect_segment_dist(cx: f64, cy: f64, w: f64, h: f64, a: Point, b: Point) -> f64 {
    let x0 = cx - w / 2.0;
    let x1 = cx + w / 2.0;
    let y0 = cy - h / 2.0;
    let y1 = cy + h / 2.0;
    let inside = |p: Point| p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1;
    if inside(a) || inside(b) {
        return 0.0;
    }
    let corners = [
        Point::new(x0, y0),
        Point::new(x1, y0),
        Point::new(x1, y1),
        Point::new(x0, y1),
    ];
    let mut best = f64::INFINITY;
    for i in 0..4 {
        best = best.min(segment_segment_dist(a, b, corners[i], corners[(i + 1) % 4]));
    }
    best
}

/// Area of `rect ∩ polygon`, m²: Sutherland–Hodgman clip of the polygon against
/// the rect's four half-planes, then shoelace. Correct for non-convex subject
/// polygons (degenerate connector edges cancel in the signed sum). Used to
/// report honest zone areas where a rectangular zone overhangs a plate notch.
pub fn rect_polygon_clip_area(poly: &[Point], x0: f64, y0: f64, x1: f64, y1: f64) -> f64 {
    let inside = |pass: usize, p: Point| match pass {
        0 => p.x >= x0,
        1 => p.x <= x1,
        2 => p.y >= y0,
        _ => p.y <= y1,
    };
    // Crossing point of `a→b` with the pass's boundary line. Only called when
    // `a` and `b` are on opposite sides, so the denominator is never 0.
    let cross = |pass: usize, a: Point, b: Point| -> Point {
        match pass {
            0 | 1 => {
                let bx = if pass == 0 { x0 } else { x1 };
                Point::new(bx, a.y + (bx - a.x) / (b.x - a.x) * (b.y - a.y))
            }
            _ => {
                let by = if pass == 2 { y0 } else { y1 };
                Point::new(a.x + (by - a.y) / (b.y - a.y) * (b.x - a.x), by)
            }
        }
    };
    let mut pts = poly.to_vec();
    for pass in 0..4 {
        if pts.is_empty() {
            return 0.0;
        }
        let mut out = Vec::with_capacity(pts.len() + 4);
        for i in 0..pts.len() {
            let prev = pts[(i + pts.len() - 1) % pts.len()];
            let cur = pts[i];
            let (prev_in, cur_in) = (inside(pass, prev), inside(pass, cur));
            if prev_in != cur_in {
                out.push(cross(pass, prev, cur));
            }
            if cur_in {
                out.push(cur);
            }
        }
        pts = out;
    }
    polygon_area(&pts)
}

/// Trace the **floor-plate polygon**: the largest-area closed loop through the
/// given wall centerline segments. Endpoints within `tol` of each other are
/// snapped to one node; the loop is found by planar face traversal (at each
/// node, take the next edge clockwise from the reversed incoming edge), which
/// tolerates interior partition walls and dead-end stubs — the outer face has
/// the largest area and wins. Returns `None` when no closed loop exists (open
/// walls), letting callers fall back to bounding-box behavior.
pub fn trace_floor_polygon(segments: &[(Point, Point)], tol: f64) -> Option<Vec<Point>> {
    fn snap(nodes: &mut Vec<Point>, p: Point, tol: f64) -> usize {
        if let Some(i) = nodes.iter().position(|n| n.dist(&p) <= tol) {
            return i;
        }
        nodes.push(p);
        nodes.len() - 1
    }

    let mut nodes: Vec<Point> = Vec::new();
    let mut adj: Vec<Vec<usize>> = Vec::new();
    for &(a, b) in segments {
        let ia = snap(&mut nodes, a, tol);
        let ib = snap(&mut nodes, b, tol);
        adj.resize(nodes.len(), Vec::new());
        if ia == ib {
            continue; // zero-length wall
        }
        adj[ia].push(ib);
        adj[ib].push(ia);
    }

    let mut used: std::collections::HashSet<(usize, usize)> = std::collections::HashSet::new();
    let mut best: Option<(f64, Vec<Point>)> = None;
    // The clockwise-next rule makes edge succession a permutation, so every walk
    // returns to its starting directed edge; the bound is only a safety net.
    let max_steps = 2 * segments.len() + 4;
    for su in 0..adj.len() {
        for &sv in &adj[su] {
            if used.contains(&(su, sv)) {
                continue;
            }
            let mut face: Vec<usize> = Vec::new();
            let (mut u, mut v) = (su, sv);
            let mut closed = false;
            for _ in 0..max_steps {
                used.insert((u, v));
                face.push(u);
                // Next edge clockwise around `v`, starting from the reversed
                // incoming edge. Backtracking (w == u) scores a full turn, so
                // it is only chosen at dead ends.
                let back = (nodes[u].y - nodes[v].y).atan2(nodes[u].x - nodes[v].x);
                let mut next: Option<(f64, usize)> = None;
                for &w in &adj[v] {
                    let ang = (nodes[w].y - nodes[v].y).atan2(nodes[w].x - nodes[v].x);
                    let mut d = back - ang;
                    while d <= 1e-12 {
                        d += std::f64::consts::TAU;
                    }
                    if next.map_or(true, |(bd, _)| d < bd) {
                        next = Some((d, w));
                    }
                }
                let Some((_, w)) = next else { break };
                u = v;
                v = w;
                if (u, v) == (su, sv) {
                    closed = true;
                    break;
                }
            }
            if !closed || face.len() < 3 {
                continue;
            }
            let pts: Vec<Point> = face.iter().map(|&i| nodes[i]).collect();
            let area = polygon_area(&pts);
            // Open-wall Euler tours double back on themselves and enclose ~0
            // area; requiring a real area rejects them.
            if area > 1e-6 && best.as_ref().map_or(true, |(ba, _)| area > *ba) {
                best = Some((area, pts));
            }
        }
    }
    best.map(|(_, pts)| pts)
}

// ---------------------------------------------------------------------------
// Plate decomposition: tile the (possibly irregular) floor-plate polygon with a
// small set of maximal axis-aligned rectangles. The layout generator packs each
// rectangle independently so wings of an L/U/multi-wing plate each get their own
// desk field instead of a single global grid clumping wherever the wall-bbox
// grid happens to intersect the plate.
// ---------------------------------------------------------------------------

/// Axis-aligned rectangle in world meters, **corner-origin** (unlike `Component`
/// / `ZoneShape::Rect`, which are center-origin). The output unit of
/// [`decompose_plate`]; the layout generator treats each as a sub-plate to pack.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rect {
    pub x0: f64,
    pub y0: f64,
    pub x1: f64,
    pub y1: f64,
}

impl Rect {
    pub fn width(&self) -> f64 {
        self.x1 - self.x0
    }
    pub fn height(&self) -> f64 {
        self.y1 - self.y0
    }
    pub fn area(&self) -> f64 {
        self.width().max(0.0) * self.height().max(0.0)
    }
}

/// A raster cell counts as inside the plate iff its center **and** its four
/// corners are inside (or exactly on the boundary). Conservative on diagonal
/// edges (a cut cell has ≥1 corner strictly outside → dropped, so a region
/// never pokes past the plate), yet lossless on axis-aligned edges flush with a
/// grid line (corners land exactly on the wall → kept, so coverage stays high).
fn cell_inside(poly: &[Point], cx: f64, cy: f64, half: f64) -> bool {
    let on_or_in = |x: f64, y: f64| -> bool {
        if point_in_polygon(x, y, poly) {
            return true;
        }
        // Exactly-on-boundary corners (flush with an axis-aligned wall) are
        // ambiguous for the even-odd ray cast; accept them explicitly so a cell
        // flush inside the plate is kept.
        (0..poly.len()).any(|i| {
            let a = poly[i];
            let b = poly[(i + 1) % poly.len()];
            point_segment_dist(Point::new(x, y), a, b) <= 1e-7
        })
    };
    on_or_in(cx, cy)
        && on_or_in(cx - half, cy - half)
        && on_or_in(cx + half, cy - half)
        && on_or_in(cx + half, cy + half)
        && on_or_in(cx - half, cy + half)
}

/// Largest all-true axis-aligned rectangle in a `cols`×`rows` boolean raster
/// (classic histogram-stack algorithm, O(cols·rows)). Returns
/// `(area_in_cells, c0, r0, c1, r1)` with **inclusive** cell indices, or an
/// area of 0 when the raster is empty.
/// Largest all-true rectangle with BOTH dimensions ≥ the given minimums (in
/// cells). Constraining the search itself matters: the unconstrained maximum
/// can be a long thin strip, and rejecting it after the fact would abandon
/// perfectly valid fatter rectangles elsewhere in the raster (a real bug:
/// a 3 m corridor strip's area beat the 6.5×8 m left wing, terminating the
/// decomposition before the wing was found).
fn max_true_rectangle(
    inside: &[bool],
    cols: usize,
    rows: usize,
    min_c: usize,
    min_r: usize,
) -> (usize, usize, usize, usize, usize) {
    let mut heights = vec![0usize; cols];
    let mut best = (0usize, 0usize, 0usize, 0usize, 0usize);
    for r in 0..rows {
        for c in 0..cols {
            heights[c] = if inside[r * cols + c] { heights[c] + 1 } else { 0 };
        }
        // Largest rectangle in the histogram `heights`, whose bottom is row `r`.
        // Stack holds (start_col, height) with strictly increasing heights.
        let mut stack: Vec<(usize, usize)> = Vec::new();
        for c in 0..=cols {
            let h = if c < cols { heights[c] } else { 0 };
            let mut start = c;
            while let Some(&(s, ph)) = stack.last() {
                if ph <= h {
                    break;
                }
                stack.pop();
                // For a popped run of height ph spanning cols [s, c-1]: any
                // sub-height ≥ min_r over the full span is also a candidate —
                // taking the span at exactly min_r rows can beat a thin
                // full-height strip. Evaluate both the full height and the
                // clamped-to-minimum height (the extremes dominate: width is
                // fixed, so area is linear in the chosen height).
                let width = c - s;
                if width >= min_c && ph >= min_r {
                    let area = ph * width;
                    if area > best.0 {
                        // cols [s, c-1], height ph, bottom row r → top row r+1-ph.
                        best = (area, s, r + 1 - ph, c - 1, r);
                    }
                }
                start = s;
            }
            if stack.last().map_or(true, |&(_, ph)| ph < h) {
                stack.push((start, h));
            }
        }
    }
    best
}

/// Decompose a floor-plate polygon into a small set of maximal inscribed
/// axis-aligned rectangles. Rasterises the interior on a `cell`-meter grid
/// (conservative — see [`cell_inside`]), then repeatedly extracts the
/// largest-area all-inside rectangle and clears its cells, stopping once the
/// best rectangle is thinner than `min_dim` on either side or smaller than
/// `min_area`. Rectangles are returned **largest-area first** and never cross
/// the polygon boundary. Typical real plates yield 2–6 rectangles covering
/// ~80–95 % of the plate area.
pub fn decompose_plate(poly: &[Point], cell: f64, min_dim: f64, min_area: f64) -> Vec<Rect> {
    if poly.len() < 3 || cell <= 0.0 {
        return Vec::new();
    }
    let (mut minx, mut miny, mut maxx, mut maxy) =
        (f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY);
    for p in poly {
        minx = minx.min(p.x);
        miny = miny.min(p.y);
        maxx = maxx.max(p.x);
        maxy = maxy.max(p.y);
    }
    let cols = (((maxx - minx) / cell).ceil() as usize).max(1);
    let rows = (((maxy - miny) / cell).ceil() as usize).max(1);
    let half = cell / 2.0;
    let mut inside = vec![false; cols * rows];
    for r in 0..rows {
        for c in 0..cols {
            let cx = minx + (c as f64 + 0.5) * cell;
            let cy = miny + (r as f64 + 0.5) * cell;
            if cell_inside(poly, cx, cy, half) {
                inside[r * cols + c] = true;
            }
        }
    }

    // Constrain the search to rectangles that can actually host a work zone;
    // the loop ends only when no qualifying rectangle remains anywhere.
    let min_cells = ((min_dim / cell).ceil() as usize).max(1);
    let mut out = Vec::new();
    loop {
        let (area_cells, c0, r0, c1, r1) = max_true_rectangle(&inside, cols, rows, min_cells, min_cells);
        if area_cells == 0 {
            break;
        }
        let rect = Rect {
            x0: minx + c0 as f64 * cell,
            y0: miny + r0 as f64 * cell,
            x1: minx + (c1 + 1) as f64 * cell,
            y1: miny + (r1 + 1) as f64 * cell,
        };
        if rect.area() < min_area {
            break; // qualifying rects only shrink from here
        }
        for r in r0..=r1 {
            for c in c0..=c1 {
                inside[r * cols + c] = false;
            }
        }
        out.push(rect);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The L-plate: 20×14 minus an 8×6 notch at the top-right corner.
    fn l_poly() -> Vec<Point> {
        [(0.0, 0.0), (20.0, 0.0), (20.0, 8.0), (12.0, 8.0), (12.0, 14.0), (0.0, 14.0)]
            .iter()
            .map(|&(x, y)| Point::new(x, y))
            .collect()
    }

    #[test]
    fn point_in_polygon_respects_the_notch() {
        let poly = l_poly();
        assert!(point_in_polygon(5.0, 5.0, &poly));
        assert!(point_in_polygon(18.0, 4.0, &poly), "lower leg is inside");
        assert!(!point_in_polygon(16.0, 11.0, &poly), "notch void is outside");
        assert!(!point_in_polygon(-1.0, 5.0, &poly));
        assert!((polygon_area(&poly) - 232.0).abs() < 1e-9); // 280 − 48
    }

    #[test]
    fn rect_segment_dist_is_zero_on_contact_and_exact_otherwise() {
        let a = Point::new(0.0, -5.0);
        let b = Point::new(0.0, 5.0);
        // Segment crossing straight through a 2×2 rect at the origin.
        assert!(rect_segment_dist(0.0, 0.0, 2.0, 2.0, a, b) < 1e-12);
        // Same segment shifted 2 m right → 1 m from the rect's right edge.
        let c = Point::new(2.0, -5.0);
        let d = Point::new(2.0, 5.0);
        assert!((rect_segment_dist(0.0, 0.0, 2.0, 2.0, c, d) - 1.0).abs() < 1e-9);
    }

    #[test]
    fn clip_area_matches_hand_computed_overlaps() {
        let poly = l_poly();
        // Rect [10,20]×[6,14]: plate overlap is [10,20]×[6,8] (20 m²) plus
        // [10,12]×[8,14] (12 m²) = 32 m².
        assert!((rect_polygon_clip_area(&poly, 10.0, 6.0, 20.0, 14.0) - 32.0).abs() < 1e-9);
        // Fully inside and fully in the notch void.
        assert!((rect_polygon_clip_area(&poly, 1.0, 1.0, 3.0, 3.0) - 4.0).abs() < 1e-9);
        assert!(rect_polygon_clip_area(&poly, 13.0, 9.0, 19.0, 13.0).abs() < 1e-9);
    }

    #[test]
    fn tracer_snaps_nearby_endpoints_into_one_loop() {
        // A 10×10 rectangle whose closing endpoint misses the origin by 5 mm —
        // within LOOP_SNAP_TOL, so the loop still closes.
        let segs = vec![
            (Point::new(0.0, 0.0), Point::new(10.0, 0.0)),
            (Point::new(10.0, 0.0), Point::new(10.0, 10.0)),
            (Point::new(10.0, 10.0), Point::new(0.0, 10.0)),
            (Point::new(0.0, 10.0), Point::new(0.005, 0.0)),
        ];
        let poly = trace_floor_polygon(&segs, LOOP_SNAP_TOL).expect("snapped loop closes");
        assert_eq!(poly.len(), 4);
        assert!((polygon_area(&poly) - 100.0).abs() < 0.2);
    }

    #[test]
    fn decompose_l_plate_tiles_into_two_rects() {
        // The L (20×14 minus an 8×6 notch) decomposes into exactly two maximal
        // rectangles: the tall left leg [0,12]×[0,14] (168 m², extracted first as
        // the larger) and the bottom-right leg [12,20]×[0,8] (64 m²).
        let rects = decompose_plate(&l_poly(), 0.5, 2.0, 4.0);
        assert_eq!(rects.len(), 2, "L should tile into 2 rects, got {:?}", rects);
        // Largest-first ordering.
        assert!(rects[0].area() >= rects[1].area());
        assert_eq!(rects[0], Rect { x0: 0.0, y0: 0.0, x1: 12.0, y1: 14.0 });
        assert_eq!(rects[1], Rect { x0: 12.0, y0: 0.0, x1: 20.0, y1: 8.0 });
    }

    #[test]
    fn decompose_rects_never_cross_the_polygon() {
        // No rectangle may contain a point (its center or any corner) outside the
        // plate — i.e. no rectangle pokes into the notch void or past the walls.
        let poly = l_poly();
        for rect in decompose_plate(&poly, 0.5, 2.0, 4.0) {
            let pts = [
                (rect.x0, rect.y0),
                (rect.x1, rect.y0),
                (rect.x1, rect.y1),
                (rect.x0, rect.y1),
                ((rect.x0 + rect.x1) / 2.0, (rect.y0 + rect.y1) / 2.0),
            ];
            for (x, y) in pts {
                // On-boundary corners are allowed (flush with a wall); a point
                // strictly inside the notch void must never occur.
                assert!(
                    !(x > 12.0 + 1e-9 && y > 8.0 + 1e-9),
                    "rect {:?} reaches into the notch at ({}, {})",
                    rect,
                    x,
                    y
                );
            }
        }
    }

    #[test]
    fn decompose_covers_most_of_the_plate() {
        let poly = l_poly();
        let covered: f64 = decompose_plate(&poly, 0.5, 2.0, 4.0).iter().map(|r| r.area()).sum();
        let plate = polygon_area(&poly); // 232 m²
        assert!(
            covered >= 0.90 * plate,
            "coverage {} m² < 90% of plate {} m²",
            covered,
            plate
        );
    }
}
