//! Primitive 2D geometry. Units are **meters** throughout the core; the frontend
//! owns pixels-per-meter scaling. Kept free of any browser/JS dependency.

use serde::Serialize;

#[derive(Clone, Copy, Debug, Serialize)]
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
/// and, later, circulation/clearance evaluation.
#[allow(dead_code)]
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
