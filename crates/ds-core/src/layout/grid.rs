//! The global alignment module (every emitted coordinate snaps to it) and the
//! slot-feasibility predicates every placer shares: plate containment, obstacle
//! overlap, and interior-wall clearance.

use super::*;

/// Back-to-back spine gap (m) between the two rows of a bench pair. Set to 0.0
/// (**touching** pairs — desks share the spine over a common cable tray, the most
/// common real bench-desking detail). A 0.15 m gap was tried first, but the
/// circulation evaluator's 0.15 m occupancy cells resolved that slot as a spurious
/// ~0.30 m "corridor" (2×cell) flanked by desks, tanking `min_corridor_width` far
/// below the aisle clearance in `l_plate_circulation_quality`. Touching pairs
/// leave no walkable cell between the two rows, so no bogus min-corridor appears,
/// and they pack even denser. Kept as a named constant so the intent — and the
/// path back to a nonzero gap on a finer circulation grid — is explicit.
pub(crate) const SPINE_GAP: f64 = 0.0;

/// The global alignment module (m): EVERY emitted component coordinate and
/// dimension snaps to this grid, so plan dimensions read as round numbers and
/// rows share long straight lines (docs/design/testfit-pro-quality.md §4.1).
pub(crate) const MODULE: f64 = 0.05;

/// Snap a coordinate/dimension to the nearest module line.
pub(crate) fn snap_module(v: f64) -> f64 {
    (v / MODULE).round() * MODULE
}

/// Snap DOWN to the module — for dimensions clamped by available space, so the
/// snapped size never exceeds it. The epsilon rescues exact multiples from
/// binary-representation dust (4.0 / 0.05 sits fractionally below 80.0).
pub(crate) fn snap_module_floor(v: f64) -> f64 {
    ((v / MODULE) + 1e-9).floor() * MODULE
}

/// Snap a ROOM dimension DOWN to twice the module (0.1 m), so its half sits
/// exactly on a module line. Room walls, the centered table, and the door gap
/// are all derived from +/-(dim/2); flooring dims to 0.1 keeps every one of
/// those emitted coordinates on the 0.05 m grid (spec 4.1), even for the
/// support program's odd sizes (3.3 / 2.7 / 1.3 ...). Meeting rooms (even dims)
/// are unaffected.
pub(crate) fn snap_room_floor(v: f64) -> f64 {
    ((v / (2.0 * MODULE)) + 1e-9).floor() * (2.0 * MODULE)
}

/// World-axis-aligned extents of a `w`×`h` footprint rotated by `rotation` —
/// the exact AABB (w×h at 0/π, swapped at ±π/2). Obstacle registration must
/// use this, not the raw local dims, now that portrait wings emit ±π/2 desks.
pub(crate) fn world_extents(w: f64, h: f64, rotation: f64) -> (f64, f64) {
    let (s, c) = rotation.sin_cos();
    (w * c.abs() + h * s.abs(), w * s.abs() + h * c.abs())
}

/// Axis-aligned overlap test between a candidate footprint (center cx,cy, size
/// w×h) and any obstacle rect, expanded by `pad` on every side.
pub(crate) fn footprint_overlaps(
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

/// The **architectural** walls' centerline segments, ready for
/// `geometry::trace_floor_polygon`. Generator-emitted partitions are excluded:
/// the plate is the building envelope, never our own room shells.
pub(crate) fn wall_segments(doc: &Document) -> Vec<(Point, Point)> {
    doc.walls
        .iter()
        .filter(|w| !w.generated)
        .map(|w| (w.a, w.b))
        .collect()
}

/// True when a candidate footprint (center `cx,cy`, size `w`×`h`) is a valid
/// slot on the floor plate: its center lies inside the plate polygon and the
/// whole rect keeps ≥ `margin` clearance to **every** plate edge. Because the
/// rect is connected, "center inside + no edge closer than `margin` > 0" is an
/// exact containment-with-clearance test (the rect cannot cross the boundary
/// without an edge at distance 0) — this is what keeps the perimeter corridor
/// intact around notches of L/U-shaped plates. `plate == None` (open walls, no
/// closed loop) accepts everything: pure bounding-box behavior, as before.
pub(crate) fn slot_fits_plate(plate: Option<&[Point]>, cx: f64, cy: f64, w: f64, h: f64, margin: f64) -> bool {
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

/// Clearance (m) kept between a packed footprint and each **face** of an
/// interior wall — the wall acts as a thin obstacle of `thickness + 2×this`.
pub(crate) const WALL_CLEARANCE: f64 = 0.05;
/// A wall whose whole centerline lies within this distance (m) of the plate
/// boundary IS the boundary, not an interior partition.
pub(crate) const INTERIOR_WALL_TOL: f64 = 0.05;

/// Interior partition walls as `(a, b, min_clearance)` obstacle segments.
///
/// A wall is **interior** when any of its five centerline samples (ends,
/// quarters, midpoint) sits farther than `INTERIOR_WALL_TOL` from every
/// boundary segment — the plate polygon's edges when the walls close a loop,
/// else the wall-bbox perimeter (the open-walls fallback, so bbox-edge walls
/// stay non-blocking and the historical behavior is byte-identical).
/// `min_clearance` is half the wall's thickness plus `WALL_CLEARANCE`: a
/// candidate rect must keep at least that distance from the centerline, so no
/// footprint straddles or presses against a partition.
pub(crate) fn interior_walls(
    doc: &Document,
    plate: Option<&[Point]>,
    bbox: (f64, f64, f64, f64),
) -> Vec<(Point, Point, f64)> {
    let boundary: Vec<(Point, Point)> = match plate {
        Some(poly) => (0..poly.len())
            .map(|i| (poly[i], poly[(i + 1) % poly.len()]))
            .collect(),
        None => {
            let (x0, y0, x1, y1) = bbox;
            vec![
                (Point::new(x0, y0), Point::new(x1, y0)),
                (Point::new(x1, y0), Point::new(x1, y1)),
                (Point::new(x1, y1), Point::new(x0, y1)),
                (Point::new(x0, y1), Point::new(x0, y0)),
            ]
        }
    };
    doc.walls
        .iter()
        .filter_map(|w| {
            let on_boundary = (0..=4).all(|k| {
                let t = k as f64 / 4.0;
                let p = Point::new(w.a.x + (w.b.x - w.a.x) * t, w.a.y + (w.b.y - w.a.y) * t);
                boundary
                    .iter()
                    .any(|&(a, b)| geometry::point_segment_dist(p, a, b) <= INTERIOR_WALL_TOL)
            });
            if on_boundary {
                None
            } else {
                Some((w.a, w.b, w.thickness / 2.0 + WALL_CLEARANCE))
            }
        })
        .collect()
}

/// True when the candidate footprint keeps every interior wall at least its
/// required clearance away. Exact for any wall angle (`rect_segment_dist`), so
/// no footprint can straddle a partition — the packer's wall-blocking test.
pub(crate) fn slot_clears_walls(walls: &[(Point, Point, f64)], cx: f64, cy: f64, w: f64, h: f64) -> bool {
    walls
        .iter()
        .all(|&(a, b, m)| geometry::rect_segment_dist(cx, cy, w, h, a, b) >= m - 1e-9)
}
