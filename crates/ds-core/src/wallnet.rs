//! **The wall network's outline** — what an architect draws, instead of what a
//! loop over walls draws.
//!
//! A plan's walls are one solid. The reference sheets show it that way: two
//! continuous lines that turn corners, meet at T-junctions and stop at door
//! openings, with nothing crossing inside the wall body. DSource drew each wall
//! as an independent box — two long faces plus two end caps — so every junction
//! stacked four extra strokes on top of each other and the plan came out
//! spidery. It was not a stroke-weight problem; the extra ink was *geometry that
//! is not on the boundary of the solid*.
//!
//! So this computes the boundary. Each wall contributes a thickness rectangle;
//! the network's outline is the set of rectangle edges that lie **outside every
//! other rectangle**. That is the union boundary, exactly, and it needs no
//! polygon-clipping library: split each edge at its crossings with the others,
//! then keep the pieces whose midpoint is in nobody else's interior.
//!
//! **Openings are already geometry.** Generated room shells are emitted with a
//! real 0.9 m gap in the wall run (see `assert_room_enclosed`), so a door is an
//! absence of wall, not a white line painted over one. That is why `paint.ts`'s
//! `punchOpening` — which overdrew in white — was never called from the render
//! loop and has been deleted rather than ported.
//!
//! Cost is O(E²) in wall-quad edges: the sample plate's 155 walls give 620
//! edges and ~380 k segment tests, about 4 ms. The whole thing re-runs only when
//! the walls change.

use crate::geometry::{point_in_polygon, Point};
use crate::model::Wall;
use serde::Serialize;

/// Endpoints closer than this are the same junction. Matches the plate tracer's
/// own snap tolerance so a wall that closes the plate also joins its neighbours.
const JOIN_TOL: f64 = crate::geometry::LOOP_SNAP_TOL;

/// Fallback thickness for a wall stored with none. Same 0.1 m the renderer used.
const MIN_T: f64 = 0.1;

/// One stroke of the network outline.
#[derive(Clone, Debug, Serialize)]
pub struct OutlineSeg {
    pub a: [f64; 2],
    pub b: [f64; 2],
    /// The wall this piece came from, so the renderer can pick a tier without
    /// re-deriving anything.
    pub wall: u32,
    /// On the traced plate boundary → the heavier cut tier.
    pub exterior: bool,
    /// A glazed run: the renderer adds the centre line for the triple-line
    /// convention. The faces still come from the union, so a glass front meeting
    /// a partition is as clean as any other junction.
    pub glazed: bool,
}

/// A wall's thickness rectangle, in world meters.
#[derive(Clone, Copy)]
struct Quad {
    c: [Point; 4],
    wall: u32,
}

impl Quad {
    fn edges(&self) -> [(Point, Point); 4] {
        [
            (self.c[0], self.c[1]),
            (self.c[1], self.c[2]),
            (self.c[2], self.c[3]),
            (self.c[3], self.c[0]),
        ]
    }
    fn contains(&self, p: Point) -> bool {
        point_in_polygon(p.x, p.y, &self.c)
    }
    fn bbox(&self) -> (f64, f64, f64, f64) {
        let (mut x0, mut y0, mut x1, mut y1) = (f64::MAX, f64::MAX, f64::MIN, f64::MIN);
        for q in self.c {
            x0 = x0.min(q.x);
            y0 = y0.min(q.y);
            x1 = x1.max(q.x);
            y1 = y1.max(q.y);
        }
        (x0, y0, x1, y1)
    }
}

/// Build each wall's thickness rectangle, mitred at its junctions.
///
/// A wall whose end meets another wall's end is **extended by half its own
/// thickness** there, so the two rectangles overlap and the union closes the
/// corner. Without it the corner keeps a square notch the width of the wall —
/// visible, and exactly the artifact this module exists to remove. A free end is
/// left alone: it is a real wall end and should read as one.
fn quads(walls: &[Wall]) -> Vec<Quad> {
    let ends: Vec<(Point, Point)> = walls.iter().map(|w| (w.a, w.b)).collect();
    let joined = |p: Point, self_i: usize| -> bool {
        ends.iter().enumerate().any(|(j, (a, b))| {
            j != self_i && (p.dist(a) <= JOIN_TOL || p.dist(b) <= JOIN_TOL)
        })
    };

    walls
        .iter()
        .enumerate()
        .filter_map(|(i, w)| {
            let (dx, dy) = (w.b.x - w.a.x, w.b.y - w.a.y);
            let len = (dx * dx + dy * dy).sqrt();
            if len < 1e-9 {
                return None;
            }
            let h = if w.thickness > 0.0 { w.thickness } else { MIN_T } / 2.0;
            let (ux, uy) = (dx / len, dy / len);
            let (nx, ny) = (-uy * h, ux * h);
            let ext_a = if joined(w.a, i) { h } else { 0.0 };
            let ext_b = if joined(w.b, i) { h } else { 0.0 };
            let a = Point::new(w.a.x - ux * ext_a, w.a.y - uy * ext_a);
            let b = Point::new(w.b.x + ux * ext_b, w.b.y + uy * ext_b);
            Some(Quad {
                c: [
                    Point::new(a.x + nx, a.y + ny),
                    Point::new(b.x + nx, b.y + ny),
                    Point::new(b.x - nx, b.y - ny),
                    Point::new(a.x - nx, a.y - ny),
                ],
                wall: w.id,
            })
        })
        .collect()
}

/// Parameter along `p→q` where it crosses `r→s`, or `None` if they don't cross.
fn cross_t(p: Point, q: Point, r: Point, s: Point) -> Option<f64> {
    let (dx, dy) = (q.x - p.x, q.y - p.y);
    let (ex, ey) = (s.x - r.x, s.y - r.y);
    let den = dx * ey - dy * ex;
    if den.abs() < 1e-12 {
        return None; // parallel or collinear: no isolated crossing point
    }
    let t = ((r.x - p.x) * ey - (r.y - p.y) * ex) / den;
    let u = ((r.x - p.x) * dy - (r.y - p.y) * dx) / den;
    if (0.0..=1.0).contains(&t) && (0.0..=1.0).contains(&u) {
        Some(t)
    } else {
        None
    }
}

/// The outline of the merged wall network.
///
/// `exterior` marks the walls the caller has identified as lying on the plate
/// boundary; everything else draws at the interior tier.
pub fn outline(walls: &[Wall], exterior: &dyn Fn(u32) -> bool) -> Vec<OutlineSeg> {
    let qs = quads(walls);
    let boxes: Vec<(f64, f64, f64, f64)> = qs.iter().map(|q| q.bbox()).collect();
    let glazed: std::collections::HashMap<u32, bool> =
        walls.iter().map(|w| (w.id, w.glazing)).collect();

    let mut out: Vec<OutlineSeg> = Vec::new();
    for (i, q) in qs.iter().enumerate() {
        for (p, r) in q.edges() {
            // Every crossing with another rectangle's edges is a place where
            // this edge may pass from outside to inside.
            let mut ts: Vec<f64> = vec![0.0, 1.0];
            for (j, o) in qs.iter().enumerate() {
                if i == j || !bbox_overlap(boxes[i], boxes[j]) {
                    continue;
                }
                for (rp, rq) in o.edges() {
                    if let Some(t) = cross_t(p, r, rp, rq) {
                        ts.push(t);
                    }
                }
            }
            ts.sort_by(|a, b| a.partial_cmp(b).unwrap());
            for k in 0..ts.len() - 1 {
                let (t0, t1) = (ts[k], ts[k + 1]);
                if t1 - t0 < 1e-9 {
                    continue;
                }
                let tm = (t0 + t1) / 2.0;
                let mid = Point::new(p.x + (r.x - p.x) * tm, p.y + (r.y - p.y) * tm);
                // Inside ANY other rectangle → interior to the solid, not on its
                // boundary. This one test is the whole difference between a
                // merged network and 155 boxes.
                let buried = qs.iter().enumerate().any(|(j, o)| {
                    i != j && bbox_contains(boxes[j], mid) && o.contains(mid)
                });
                if buried {
                    continue;
                }
                out.push(OutlineSeg {
                    a: [p.x + (r.x - p.x) * t0, p.y + (r.y - p.y) * t0],
                    b: [p.x + (r.x - p.x) * t1, p.y + (r.y - p.y) * t1],
                    wall: q.wall,
                    exterior: exterior(q.wall),
                    glazed: glazed.get(&q.wall).copied().unwrap_or(false),
                });
            }
        }
    }
    out
}

fn bbox_overlap(a: (f64, f64, f64, f64), b: (f64, f64, f64, f64)) -> bool {
    a.0 <= b.2 && b.0 <= a.2 && a.1 <= b.3 && b.1 <= a.3
}

fn bbox_contains(b: (f64, f64, f64, f64), p: Point) -> bool {
    p.x >= b.0 - 1e-9 && p.x <= b.2 + 1e-9 && p.y >= b.1 - 1e-9 && p.y <= b.3 + 1e-9
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Wall;

    fn w(id: u32, ax: f64, ay: f64, bx: f64, by: f64, t: f64) -> Wall {
        Wall {
            id,
            a: Point::new(ax, ay),
            b: Point::new(bx, by),
            thickness: t,
            generated: false,
            glazing: false,
            height_m: None,
        }
    }

    /// A lone wall is its own boundary: all four rectangle edges survive.
    #[test]
    fn one_wall_keeps_its_whole_rectangle() {
        let segs = outline(&[w(1, 0.0, 0.0, 4.0, 0.0, 0.2)], &|_| false);
        let total: f64 = segs
            .iter()
            .map(|s| ((s.b[0] - s.a[0]).powi(2) + (s.b[1] - s.a[1]).powi(2)).sqrt())
            .sum();
        // 2 × 4 m faces + 2 × 0.2 m caps.
        assert!((total - 8.4).abs() < 1e-6, "perimeter {total}");
    }

    /// Is `p` STRICTLY inside wall `w`'s own thickness rectangle?
    ///
    /// Derived here from `(a, b, thickness)` and nothing else — never from
    /// `quads()`, which is the code under test. It is deliberately the
    /// UN-MITRED rectangle, a strict subset of the solid `outline` actually
    /// unions, so it can only ever UNDER-report burial: every point it calls
    /// interior really is interior, and the assertion cannot fire on a segment
    /// that legitimately lies on the union boundary.
    ///
    /// `eps` points OUTWARD. A point exactly on a face is on the boundary of the
    /// solid and is exactly where the union is supposed to draw, so tangency
    /// must be permitted; only a point with clearance on every side is buried.
    fn strictly_inside(wall: &Wall, p: [f64; 2], eps: f64) -> bool {
        let (dx, dy) = (wall.b.x - wall.a.x, wall.b.y - wall.a.y);
        let len = (dx * dx + dy * dy).sqrt();
        if len < 1e-9 {
            return false;
        }
        let (ux, uy) = (dx / len, dy / len);
        let (vx, vy) = (p[0] - wall.a.x, p[1] - wall.a.y);
        let along = vx * ux + vy * uy;
        let across = (vy * ux - vx * uy).abs();
        along > eps && along < len - eps && across < wall.thickness / 2.0 - eps
    }

    /// **The junction.** Two walls meeting at a corner used to draw eight
    /// strokes, four of them buried inside the solid. The union keeps the
    /// boundary and nothing else: no stroke may run through the wall body.
    ///
    /// THE PROPERTY, not a window (F5, adversary round). This test previously
    /// asked whether a midpoint fell in the OPEN box `(3.9, 4.1) × (-0.1, 0.1)`
    /// with strict `>`/`<` and a `+1e-9` inset — and the L is axis-aligned on
    /// exactly those four coordinates, so every buried midpoint landed precisely
    /// ON the excluded boundary. Deleting the union entirely (`let buried =
    /// false`) took the output from 8 segments to 12, and this test — the one
    /// named for the defect — stayed GREEN through it. Measured, not assumed:
    /// the four strokes it could not see were
    ///     w1 [3.9,0.1]→[4.1,0.1]  mid (4.000, 0.100)
    ///     w1 [4.1,0.1]→[4.1,-0.1] mid (4.100, 0.000)
    ///     w2 [3.9,-0.1]→[3.9,0.1] mid (3.900, 0.000)
    ///     w2 [4.1,0.1]→[4.1,-0.1] mid (4.100, 0.000)
    /// A hand-drawn window is a guess about where the defect will appear. The
    /// property — *no output segment lies strictly inside another wall's solid*
    /// — is the definition of a union boundary, needs no coordinates, and holds
    /// at every angle.
    ///
    /// R10 — WHICH AXES THIS GUARD'S FALSIFICATION VARIES: (1) the MECHANISM —
    /// `let buried = false` in `outline`, the sabotage this test is named for and
    /// had never survived; (2) the ORIENTATION — the same junction axis-aligned
    /// and at 60°, so the assertion cannot be passing on exact-coordinate luck.
    /// Orientation was the unvaried axis that let (1) through.
    #[test]
    fn an_l_junction_draws_no_line_inside_the_wall() {
        // Axis-aligned — the original case, where every buried midpoint sits on
        // an exact coordinate — and oblique, where none of them do.
        let cases: [(&str, [Wall; 2]); 2] = [
            (
                "axis-aligned",
                [w(1, 0.0, 0.0, 4.0, 0.0, 0.2), w(2, 4.0, 0.0, 4.0, 3.0, 0.2)],
            ),
            (
                "oblique 60°",
                [
                    w(1, 0.0, 0.0, 4.0, 0.0, 0.2),
                    w(2, 4.0, 0.0, 4.0 + 3.0 * 0.5, 3.0 * 0.866_025_403_784_438_6, 0.2),
                ],
            ),
        ];
        for (name, walls) in cases {
            let segs = outline(&walls, &|_| false);
            assert!(!segs.is_empty(), "{name}: outline produced nothing to check");
            for s in &segs {
                let mid = [(s.a[0] + s.b[0]) / 2.0, (s.a[1] + s.b[1]) / 2.0];
                for other in &walls {
                    if other.id == s.wall {
                        continue;
                    }
                    assert!(
                        !strictly_inside(other, mid, 1e-9),
                        "{name}: segment {:?} → {:?} (wall {}) runs through the body of wall {}",
                        s.a,
                        s.b,
                        s.wall,
                        other.id
                    );
                }
            }
        }
    }

    /// A closed rectangular room: the outline is exactly the outer and inner
    /// rings, and nothing else. Four walls, 0.2 m thick, 6 × 4 m centrelines →
    /// outer 6.2 × 4.2, inner 5.8 × 3.8.
    #[test]
    fn a_closed_room_yields_only_its_two_rings() {
        let walls = [
            w(1, 0.0, 0.0, 6.0, 0.0, 0.2),
            w(2, 6.0, 0.0, 6.0, 4.0, 0.2),
            w(3, 6.0, 4.0, 0.0, 4.0, 0.2),
            w(4, 0.0, 4.0, 0.0, 0.0, 0.2),
        ];
        let segs = outline(&walls, &|_| false);
        let total: f64 = segs
            .iter()
            .map(|s| ((s.b[0] - s.a[0]).powi(2) + (s.b[1] - s.a[1]).powi(2)).sqrt())
            .sum();
        let expect = 2.0 * (6.2 + 4.2) + 2.0 * (5.8 + 3.8);
        assert!(
            (total - expect).abs() < 1e-6,
            "outline length {total}, expected {expect} (outer ring + inner ring, no caps)"
        );
    }

    /// Collinear walls end-to-end — the shape every imported boundary polyline
    /// has — must read as ONE continuous run, not as boxes with cross-lines at
    /// each vertex.
    #[test]
    fn collinear_runs_lose_their_shared_caps() {
        let walls = [w(1, 0.0, 0.0, 3.0, 0.0, 0.2), w(2, 3.0, 0.0, 7.0, 0.0, 0.2)];
        let segs = outline(&walls, &|_| false);
        let total: f64 = segs
            .iter()
            .map(|s| ((s.b[0] - s.a[0]).powi(2) + (s.b[1] - s.a[1]).powi(2)).sqrt())
            .sum();
        // 2 × 7 m faces + 2 × 0.2 m caps at the free ends. The two caps at x = 3
        // are buried and must be gone.
        assert!((total - 14.4).abs() < 1e-6, "outline length {total}, expected 14.4");
    }
}
