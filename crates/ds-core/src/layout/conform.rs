//! Boundary conforming: growing `Rect` zones into plate-following `Poly` zones,
//! re-enclosing conformed rooms with walls, and melting the leftover floor into
//! one unified walking area — then deciding which of that leftover floor is
//! honestly **circulation** and which is merely **unassigned**.

use super::*;
use crate::circulation::{self, CirculationConfig};

/// Minimum clear width (m) at which leftover floor can be called circulation.
///
/// **1.2 m, and it is a floor-plan constant, not a taste.** IBC 2024 §1020.2
/// requires 44 in (1 118 mm) clear for a corridor serving an occupant load of
/// 50 or more, 36 in below that; ADA 2010 §403.5 requires 36 in (914 mm)
/// continuous clear with 60 in passing spaces. 1.2 m clears the IBC figure with
/// raster headroom and matches Laiout's own 1.5 m default corridor after the
/// wall-thickness the raster already spends. A strip that cannot host a path
/// this wide is not a corridor in any code that governs the building — so
/// calling it "circulation" was never a rounding error, it was a wrong claim.
///
/// This is the *width* half of the test. The *extent* half is
/// [`CIRC_WIDE_FRACTION`], and the two are a conjunction with connectivity.
pub(crate) const MIN_CIRC_CLEAR_M: f64 = 1.2;

/// Boundary tolerance for shape measurement: the SAME 0.3 m the merge pass snaps
/// residual boundary vertices onto the plate with (`fill_untyped_as_circulation`'s
/// `SNAP`). Simplifying at a finer tolerance would preserve the staircase the
/// snap created; at a coarser one it would erase real corners.
pub(crate) const SNAP_TOL: f64 = 0.3;

/// What share of a leftover pocket must actually sit on a code-width path
/// before the whole pocket counts as circulation.
///
/// **PRE-REGISTERED at 0.5 in the Phase 0 audit (§E.1) before this classifier
/// existed, and ratified.** The audit measured both defensible readings of the
/// brief's bare "1.2 m": *widest point clears 1.2 m* reclassified 12 m² of 170
/// on the reference plate (the workstream failing while reporting success — an
/// 80 m² leftover wing kept its `CIRCULATION` label), while *most of the pocket
/// sits on a 1.2 m path* reclassified ~150 m². The second is the honest read.
///
/// **Do not tune this to make a near-miss pass.** Two pockets on the reference
/// plate sit at 0.45 and 0.47; nudging to 0.45 to admit them would be
/// calibrating the threshold against the population it is meant to judge, which
/// is the exact failure `.claude/rules/gate-independence.md` documents. If
/// evidence says 0.5 is miscalibrated, that is a reported finding with a
/// proposed re-registration — never a quiet edit.
///
/// **THIS is the load-bearing constant, and [`MIN_CIRC_CLEAR_M`] is not** —
/// measured on the fixture plate after implementation, per pocket, comparing
/// the wide-fraction at 1.2 m against the same fraction at 0.9 m (the ADA
/// accessible-route minimum, and `CirculationConfig::target_corridor_width`'s
/// own default):
///
/// | pocket m² | wide @ 1.2 m | wide @ 0.9 m | verdict |
/// |---|---|---|---|
/// | 154.5 | 0.442 | 0.464 | Unassigned |
/// |  63.5 | 0.759 | 0.769 | Circulation |
/// |   9.2 | 0.219 | 0.227 | Unassigned |
///
/// Every pocket moves by ~0.02. Relaxing the width all the way to the ADA floor
/// would change **no** verdict on this plate: these pockets fail on how MUCH of
/// them is walkable, not on where the width line is drawn. So the width
/// constant is a code citation that happens not to bind here, and the fraction
/// is the decision. Worth knowing before anyone "fixes" a verdict by moving the
/// wrong number.
const CIRC_WIDE_FRACTION: f64 = 0.5;

/// The elongation at which a shape stops being a room and starts being a path.
///
/// **3:1, and τ is DERIVED from it rather than fitted.** Width and connectivity
/// cannot tell a corridor from a clearing: on the reference plate a 3.8 × 3.1 m
/// near-square cleared both and was billed as circulation. A corridor is a
/// shape you pass ALONG; the cheapest honest statement of that is that it is at
/// least three times as long as it is wide.
///
/// For a `w × L` rectangle the isoperimetric quotient is `πwL/(w+L)²`, so at
/// `L = A·w` it is `πA/(1+A)²` — a pure function of the aspect ratio. The rule
/// is therefore expressible as a threshold on [`compactness`], and the threshold
/// is a consequence of the rule instead of a number chosen to sort the pockets
/// we happened to look at.
///
/// **Deliberately NOT 0.30.** That value separated the ten pockets of one plate
/// cleanly, which is exactly what makes it untrustworthy — a threshold fitted to
/// the population it judges is the calibration failure
/// `.claude/rules/gate-independence.md` documents. It would also have left the
/// fixture plate's only circulation pocket (0.291) inside the boundary by 3%,
/// where any re-trace could flip it. At 3:1 that pocket clears by a factor of two.
pub(crate) const MIN_CORRIDOR_ASPECT: f64 = 3.0;

/// Compactness at or above which a residual pocket is a clearing, not a path.
/// `πA/(1+A)²` at `A =` [`MIN_CORRIDOR_ASPECT`] — 3π/16 ≈ 0.589.
pub(crate) fn corridor_compactness_max() -> f64 {
    let a = MIN_CORRIDOR_ASPECT;
    std::f64::consts::PI * a / ((1.0 + a) * (1.0 + a))
}

/// Grow boundary-touching **`Rect`** zones — rooms, workspace fields AND
/// residual circulation, not just circulation — into plate-conforming **`Poly`**
/// zones so **every** zone reaches an angled/stepped wall edge-to-edge, closing
/// the triangular "wedge" gaps a rectangle leaves along a diagonal boundary (the
/// user's flagged negative space along the stepped top-right wall).
///
/// The previous pass grew only circulation because growing rooms + workspace
/// INDEPENDENTLY (each capped only by neighbour bounding boxes, then reject-if-
/// overlaps) let two zones claim the SAME wedge on a tilted plate → their summed
/// area exceeded the plate (NIA > GEA). This pass replaces that heuristic with a
/// **disjoint plate partition** that makes overlaps structurally impossible:
///
/// 1. Raster the plate bbox at `CELL` metres. Each cell centre is `OUT` (outside
///    the plate), `CORE` (inside a building-core keep-out → skip), or interior.
/// 2. **Own each interior cell by exactly one growable zone.** A cell inside one
///    or more zone rects is owned by the SMALLEST-area one (an enclosed room wins
///    over the big field it sits in — this also drops the field-over-rooms double
///    count). A gap cell (between a zone and the wall) is owned by the NEAREST
///    zone within `REACH`, provided a straight path to it does not cross a
///    partition wall (so a room never bleeds across its own wall into a corridor).
///    Cells with no owner stay `LEFT` (they read as the spanning field's
///    background or as untyped floor; they only BLOCK growth, never overlap).
/// 3. **Grow each zone's wall-facing edges only through the cells it OWNS** (and
///    freely through `OUT` cells, which the plate clip trims away), stopping at
///    the first cell owned by another zone or by the core. The grown rect is then
///    clipped to the plate: the clip follows the exact wall line (no staircase);
///    the ownership cap guarantees two grown polys never share a cell → disjoint
///    by construction → Σ area ≤ GEA. A final overlap guard is belt-and-braces.
///
/// The plate-spanning oriented Workspace (a bbox-sized `Rect`) is EXCLUDED — it
/// already renders clipped to the plate and its room overlap is reconciled by
/// `effective_zone_areas`; converting it would defeat that (and it can enclose
/// interior rooms, which a single simple `Poly` can't represent). Core keep-outs
/// stay exact rects. Deterministic and seed-independent (grid + index iteration,
/// no RNG). Interior zone-to-zone borders stay at grid resolution (acceptable);
/// only wall-facing edges are re-cut, and only onto genuinely owned floor.
pub(crate) fn conform_zones_to_plate(doc: &mut Document, plate: &[Point]) {
    /// Raster cell (m). Coarse enough to keep the sweep cheap, fine enough that a
    /// wedge gets an owner; wall edges are exact via the clip, not this grid.
    const CELL: f64 = 0.25;
    /// How far a wall-facing edge reaches outward before the plate clip trims it,
    /// and how far a gap cell may reach for an owner (kept equal so an owned wedge
    /// cell is always within growth range).
    const MAX_GROW: f64 = 2.0;
    const REACH: f64 = 2.0;
    const EPS: f64 = 1e-6;
    /// Minimum m² a conform must add to bother replacing the `Rect` with a `Poly`.
    const MIN_GAIN: f64 = 0.25;
    // Ownership sentinels (non-negative values are zone indices into `doc.zones`).
    const OUT: i32 = -2;
    const CORE: i32 = -3;
    const LEFT: i32 = -4;
    const NONE: i32 = -1;

    let (mut minx, mut miny, mut maxx, mut maxy) =
        (f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY);
    for p in plate {
        minx = minx.min(p.x);
        miny = miny.min(p.y);
        maxx = maxx.max(p.x);
        maxy = maxy.max(p.y);
    }
    if !(maxx > minx && maxy > miny) {
        return;
    }
    // Skip axis-aligned plates entirely: with every wall horizontal or vertical a
    // rect clip can only yield another rect (no wedge to close), so the raster
    // would just burn time. Any slanted edge → run the partition.
    let axis_aligned = (0..plate.len()).all(|i| {
        let a = plate[i];
        let b = plate[(i + 1) % plate.len()];
        (a.x - b.x).abs() <= 1e-6 || (a.y - b.y).abs() <= 1e-6
    });
    if axis_aligned {
        return;
    }
    let cols = (((maxx - minx) / CELL).ceil() as usize).max(1);
    let rows = (((maxy - miny) / CELL).ceil() as usize).max(1);

    // The plate-spanning oriented Workspace (bbox-sized Rect): excluded from the
    // partition — detected exactly as `effective_zone_areas` does so the two agree.
    let spanning: Option<usize> = doc.wall_bbox().and_then(|(bx0, by0, bx1, by1)| {
        let (cx, cy) = ((bx0 + bx1) / 2.0, (by0 + by1) / 2.0);
        let (bw, bh) = (bx1 - bx0, by1 - by0);
        const TOL: f64 = 1e-3;
        (0..doc.zones.len()).find(|&i| {
            doc.zones[i].zone_type == ZoneType::Workspace
                && matches!(
                    doc.zones[i].shape,
                    ZoneShape::Rect { x, y, w, h }
                        if (x - cx).abs() < TOL && (y - cy).abs() < TOL
                            && (w - bw).abs() < TOL && (h - bh).abs() < TOL
                )
        })
    });
    // Growable candidates: rooms, workspace fields, residual circulation — every
    // Rect zone except the spanning field and the building core.
    let is_candidate = |i: usize, z: &Zone| -> bool {
        Some(i) != spanning
            && !matches!(z.zone_type, ZoneType::Core)
            && matches!(z.shape, ZoneShape::Rect { .. })
    };

    // ---- Ownership grid -------------------------------------------------------
    let mut owner = vec![NONE; cols * rows];
    for r in 0..rows {
        let cy = miny + (r as f64 + 0.5) * CELL;
        for c in 0..cols {
            let cx = minx + (c as f64 + 0.5) * CELL;
            if !geometry::point_in_polygon(cx, cy, plate) {
                owner[r * cols + c] = OUT;
            } else if doc
                .zones
                .iter()
                .any(|z| matches!(z.zone_type, ZoneType::Core) && z.shape.contains(cx, cy))
            {
                owner[r * cols + c] = CORE;
            }
        }
    }
    // Covered cells → SMALLEST containing candidate. Process largest-area first so
    // a smaller (inner) zone processed later overwrites it and wins the cell.
    let mut order: Vec<usize> = (0..doc.zones.len())
        .filter(|&i| is_candidate(i, &doc.zones[i]))
        .collect();
    order.sort_by(|&a, &b| {
        doc.zones[b]
            .area()
            .partial_cmp(&doc.zones[a].area())
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    for &zi in &order {
        let (bx0, by0, bx1, by1) = doc.zones[zi].shape.bbox();
        let c0 = (((bx0 - minx) / CELL).floor().max(0.0)) as usize;
        let r0 = (((by0 - miny) / CELL).floor().max(0.0)) as usize;
        let c1 = ((((bx1 - minx) / CELL).ceil()) as usize).min(cols);
        let r1 = ((((by1 - miny) / CELL).ceil()) as usize).min(rows);
        for r in r0..r1 {
            let cy = miny + (r as f64 + 0.5) * CELL;
            for c in c0..c1 {
                let cx = minx + (c as f64 + 0.5) * CELL;
                let o = owner[r * cols + c];
                if o == OUT || o == CORE {
                    continue;
                }
                if doc.zones[zi].shape.contains(cx, cy) {
                    owner[r * cols + c] = zi as i32;
                }
            }
        }
    }
    // Gap cells → NEAREST candidate within REACH, if the straight path doesn't
    // cross a partition wall. Partition walls include our generated room shells,
    // so a room can't bleed across its own wall into the corridor.
    let iwalls = interior_walls(doc, Some(plate), (minx, miny, maxx, maxy));
    for r in 0..rows {
        let cy = miny + (r as f64 + 0.5) * CELL;
        for c in 0..cols {
            if owner[r * cols + c] != NONE {
                continue;
            }
            let cx = minx + (c as f64 + 0.5) * CELL;
            let (mut best, mut bi) = (REACH, LEFT);
            for &zi in &order {
                let (bx0, by0, bx1, by1) = doc.zones[zi].shape.bbox();
                let nx = cx.clamp(bx0, bx1);
                let ny = cy.clamp(by0, by1);
                let d = ((cx - nx).powi(2) + (cy - ny).powi(2)).sqrt();
                if d < best - EPS {
                    let a = Point::new(cx, cy);
                    let b = Point::new(nx, ny);
                    let crosses = iwalls
                        .iter()
                        .any(|&(wa, wb, _)| geometry::segment_segment_dist(a, b, wa, wb) <= EPS);
                    if !crosses {
                        best = d;
                        bi = zi as i32;
                    }
                }
            }
            owner[r * cols + c] = bi;
        }
    }

    // ---- Grow each candidate through its owned cells --------------------------
    let owner_at = |px: f64, py: f64| -> i32 {
        let c = ((px - minx) / CELL).floor();
        let r = ((py - miny) / CELL).floor();
        if c < 0.0 || r < 0.0 || c >= cols as f64 || r >= rows as f64 {
            return OUT;
        }
        owner[r as usize * cols + c as usize]
    };
    let mut updates: Vec<(usize, (f64, f64, f64, f64), Vec<[f64; 2]>)> = Vec::new();
    for &zi in &order {
        let ZoneShape::Rect { x, y, w, h } = doc.zones[zi].shape else { continue };
        let (x0, x1, y0, y1) = (x - w / 2.0, x + w / 2.0, y - h / 2.0, y + h / 2.0);
        // dir: 0 left(−x), 1 right(+x), 2 bottom(−y), 3 top(+y).
        let fr = [0.15, 0.5, 0.85];
        let wall_facing = |dir: usize| -> bool {
            fr.iter().any(|&f| {
                let (px, py) = match dir {
                    0 => (x0 - MAX_GROW, y0 + f * (y1 - y0)),
                    1 => (x1 + MAX_GROW, y0 + f * (y1 - y0)),
                    2 => (x0 + f * (x1 - x0), y0 - MAX_GROW),
                    _ => (x0 + f * (x1 - x0), y1 + MAX_GROW),
                };
                !geometry::point_in_polygon(px, py, plate)
            })
        };
        // Max free growth of an edge = the shortest lane before a cell owned by
        // another zone / the core blocks it. `OUT` cells never block (the clip
        // trims them), so a thin wedge whose far end pinches to the wall still
        // grows the full depth and the clip cuts the diagonal.
        let cap_edge = |dir: usize| -> f64 {
            let (s0, s1) = if dir < 2 { (y0, y1) } else { (x0, x1) };
            let n = (((s1 - s0) / (CELL * 0.5)).ceil() as usize).max(1);
            let mut cap = MAX_GROW;
            for k in 0..=n {
                let s = s0 + (s1 - s0) * (k as f64 / n as f64);
                let mut t = CELL * 0.5;
                let mut lane = MAX_GROW;
                while t <= MAX_GROW + EPS {
                    let (px, py) = match dir {
                        0 => (x0 - t, s),
                        1 => (x1 + t, s),
                        2 => (s, y0 - t),
                        _ => (s, y1 + t),
                    };
                    let o = owner_at(px, py);
                    if o == CORE || o == LEFT || (o >= 0 && o != zi as i32) {
                        lane = (t - CELL * 0.5).max(0.0);
                        break;
                    }
                    t += CELL * 0.5;
                }
                cap = cap.min(lane);
            }
            cap
        };
        let mut g = [0.0f64; 4];
        for dir in 0..4 {
            if wall_facing(dir) {
                g[dir] = cap_edge(dir).max(0.0);
            }
        }
        if g.iter().all(|&v| v <= EPS) {
            continue;
        }
        let poly = geometry::clip_rect_to_polygon(plate, x0 - g[0], y0 - g[2], x1 + g[1], y1 + g[3]);
        if poly.len() < 3 {
            continue;
        }
        let gain =
            geometry::polygon_area(&poly) - geometry::rect_polygon_clip_area(plate, x0, y0, x1, y1);
        if gain < MIN_GAIN {
            continue;
        }
        // Convert only when the clip actually followed the boundary: a slanted
        // edge (diagonal wall) or a stepped outline (> 4 vertices). A straight
        // axis-aligned wall gives just a bigger rectangle — keep the `Rect`.
        let slanted = (0..poly.len()).any(|k| {
            let a = poly[k];
            let b = poly[(k + 1) % poly.len()];
            (a.x - b.x).abs() > 1e-4 && (a.y - b.y).abs() > 1e-4
        });
        if poly.len() <= 4 && !slanted {
            continue;
        }
        updates.push((zi, (x, y, w, h), poly.iter().map(|p| [p.x, p.y]).collect()));
    }
    // Apply, LARGEST candidate first so the biggest wall gets claimed and later
    // rivals yield. The ownership cap bounds growth against OTHER-zone cells, but
    // two zones can still both grow through OUTSIDE-the-plate cells into the same
    // wall wedge (OUT never blocks) and overlap after the clip. The guard — checked
    // against the LIVE zone shapes so it sees earlier-applied polys — rejects any
    // such residual overlap: the loser keeps its `Rect` (that wall stays as-is,
    // never double-counted), so the partition is strictly disjoint and NIA ≤ GEA
    // holds unconditionally. Strict tol (~one sample cell) admits only shared-edge
    // slivers, not real double-cover.
    updates.sort_by(|a, b| {
        let area = |p: &[[f64; 2]]| {
            geometry::polygon_area(&p.iter().map(|q| Point::new(q[0], q[1])).collect::<Vec<_>>())
        };
        area(&b.2).partial_cmp(&area(&a.2)).unwrap_or(std::cmp::Ordering::Equal)
    });
    for (zi, orig, pts) in updates {
        let poly: Vec<Point> = pts.iter().map(|p| Point::new(p[0], p[1])).collect();
        let boxes: Vec<(f64, f64, f64, f64)> = doc.zones.iter().map(|z| z.shape.bbox()).collect();
        if poly_overlaps_other_zones(&poly, &doc.zones, &boxes, zi, 0.08, 0.2) {
            continue;
        }
        // A conformed ENCLOSED room's rectangular shell (partitions + glazed
        // front + door) no longer bounds it — the grown sides leave the old walls
        // floating INSIDE the polygon. Rebuild the shell to follow the polygon
        // (the user's flagged floating-wall bug). Non-room zones (circulation,
        // workspace residual) carry no shell and just take the new shape.
        let is_room = matches!(
            doc.zones[zi].zone_type,
            ZoneType::Meeting | ZoneType::ClosedOffice | ZoneType::Collaboration | ZoneType::Amenity
        );
        if is_room {
            match reenclose_conformed_room(doc, orig, &poly, plate) {
                // Couldn't safely re-enclose: keep the room a Rect — its original
                // shell still bounds it exactly, never a floating wall.
                Reenclose::Fail => continue,
                Reenclose::Done | Reenclose::NoShell => {}
            }
        }
        doc.zones[zi].shape = ZoneShape::Poly { pts };
    }
}

/// Result of re-enclosing a conformed room. `Done` = shell rebuilt to bound the
/// polygon; `NoShell` = the room is an OPEN setting (breakout/print — no
/// partitions to rebuild), so the polygon shape is safe to apply as-is; `Fail` =
/// the polygon can't be validly enclosed (no recoverable front, or the door
/// won't fit the front edge), so the caller keeps the room a `Rect`.
pub(crate) enum Reenclose {
    Done,
    NoShell,
    Fail,
}

/// Sides of a room's rectangular shell, indexed L(0)/R(1)/B(2)/T(3): each side's
/// generated-wall indices. Buckets exactly like the enclosure test, so the two
/// agree on what "this room's walls" are. Second tuple = all of them flattened.
pub(crate) fn room_shell_sides(doc: &Document, x0: f64, x1: f64, y0: f64, y1: f64) -> ([Vec<usize>; 4], Vec<usize>) {
    const EPS: f64 = 1e-6;
    let on = |v: f64, t: f64| (v - t).abs() < EPS;
    let mut sides: [Vec<usize>; 4] = [vec![], vec![], vec![], vec![]];
    for (i, wl) in doc.walls.iter().enumerate() {
        if !wl.generated {
            continue;
        }
        let in_y = wl.a.y >= y0 - EPS && wl.a.y <= y1 + EPS && wl.b.y >= y0 - EPS && wl.b.y <= y1 + EPS;
        let in_x = wl.a.x >= x0 - EPS && wl.a.x <= x1 + EPS && wl.b.x >= x0 - EPS && wl.b.x <= x1 + EPS;
        if on(wl.a.x, x0) && on(wl.b.x, x0) && in_y {
            sides[0].push(i);
        } else if on(wl.a.x, x1) && on(wl.b.x, x1) && in_y {
            sides[1].push(i);
        } else if on(wl.a.y, y0) && on(wl.b.y, y0) && in_x {
            sides[2].push(i);
        } else if on(wl.a.y, y1) && on(wl.b.y, y1) && in_x {
            sides[3].push(i);
        }
    }
    let all: Vec<usize> = sides.iter().flatten().copied().collect();
    (sides, all)
}

/// Rebuild a conformed room's enclosure to bound its wall-hugging polygon.
///
/// Conform only grows a room's WALL-FACING edges (the corridor-facing front,
/// which probes INSIDE the plate, never grows), so the front glass + door keep
/// their line; it is the grown side/perpendicular partitions that the old
/// rectangular shell leaves floating. This removes the old shell + door, then
/// re-emits: a solid partition along every polygon edge that faces the interior,
/// the glazed front + a single door on the (unchanged) front line, and NOTHING
/// along edges that lie on the plate boundary — the building's own wall already
/// encloses those. Walls sit ON the polygon edges (they meet exactly at the
/// polygon vertices, so the room is closed by construction). Deterministic (pure
/// geometry, no RNG). All validation happens BEFORE any mutation, so a `Fail`
/// leaves the document byte-identical.
pub(crate) fn reenclose_conformed_room(
    doc: &mut Document,
    orig: (f64, f64, f64, f64),
    poly: &[Point],
    plate: &[Point],
) -> Reenclose {
    let (cx, cy, w, h) = orig;
    let t2 = PARTITION_T / 2.0;
    // Old shell centerline rectangle (inset), for bucketing this room's walls.
    let (sx0, sx1, sy0, sy1) =
        (cx - w / 2.0 + t2, cx + w / 2.0 - t2, cy - h / 2.0 + t2, cy + h / 2.0 - t2);
    let (sides, wall_idxs) = room_shell_sides(doc, sx0, sx1, sy0, sy1);
    if wall_idxs.is_empty() {
        // No shell walls: this is an OPEN setting (breakout/print) — nothing to
        // rebuild, the polygon is safe to apply as-is.
        return Reenclose::NoShell;
    }
    // Recover the door + front from the existing shell before removing it.
    let Some(di) = doc.components.iter().position(|c| {
        c.category == "Door"
            && (c.x - cx).abs() <= w / 2.0 + 1e-6
            && (c.y - cy).abs() <= h / 2.0 + 1e-6
    }) else {
        return Reenclose::Fail;
    };
    let door_w = doc.components[di].w;
    let (dcx, dcy) = (doc.components[di].x, doc.components[di].y);
    // Front side index from the door's position on the shell perimeter.
    let front = if (dcx - sx0).abs() < 1e-3 {
        0
    } else if (dcx - sx1).abs() < 1e-3 {
        1
    } else if (dcy - sy0).abs() < 1e-3 {
        2
    } else if (dcy - sy1).abs() < 1e-3 {
        3
    } else {
        return Reenclose::Fail;
    };
    let glass_front = sides[front].iter().any(|&i| doc.walls[i].glazing);
    // The room's OUTER front face (poly edges sit on outer faces; conform never
    // moved the front, so it is still the original outer-face line).
    let front_line = match front {
        0 => cx - w / 2.0,
        1 => cx + w / 2.0,
        2 => cy - h / 2.0,
        _ => cy + h / 2.0,
    };
    let vertical_front = front <= 1; // Left/Right fronts run along y.

    // Classify each polygon edge: on the plate boundary (building wall encloses
    // it — emit nothing), the front (glazed + door), or an interior side
    // (partition). Validate EVERYTHING before mutating so a Fail is inert.
    const BND_TOL: f64 = 0.06;
    let on_boundary = |a: Point, b: Point| -> bool {
        (0..plate.len()).any(|k| {
            let (p, q) = (plate[k], plate[(k + 1) % plate.len()]);
            geometry::point_segment_dist(a, p, q) < BND_TOL
                && geometry::point_segment_dist(b, p, q) < BND_TOL
        })
    };
    let mut front_span: Option<(f64, f64)> = None;
    let mut partitions: Vec<(Point, Point)> = Vec::new();
    for i in 0..poly.len() {
        let a = poly[i];
        let b = poly[(i + 1) % poly.len()];
        if (a.x - b.x).abs() < 1e-9 && (a.y - b.y).abs() < 1e-9 {
            continue; // degenerate
        }
        let is_front = if vertical_front {
            (a.x - front_line).abs() < 1e-3 && (b.x - front_line).abs() < 1e-3
        } else {
            (a.y - front_line).abs() < 1e-3 && (b.y - front_line).abs() < 1e-3
        };
        if is_front {
            if front_span.is_some() {
                return Reenclose::Fail; // two fronts — ambiguous, bail
            }
            front_span = Some(if vertical_front {
                (a.y.min(b.y), a.y.max(b.y))
            } else {
                (a.x.min(b.x), a.x.max(b.x))
            });
        } else if on_boundary(a, b) {
            // Plate boundary wall already encloses this edge — no partition.
        } else {
            partitions.push((a, b));
        }
    }
    let Some((flo, fhi)) = front_span else { return Reenclose::Fail };
    // Door gap on the front, near the HIGH corner (matches `emit_room`). Bail if
    // the front is too short to seat the door — keep the room a Rect.
    let run = fhi - flo;
    if run < door_w + 0.1 {
        return Reenclose::Fail;
    }
    let g_hi = if run >= door_w + 2.0 * DOOR_JAMB {
        fhi - DOOR_JAMB
    } else {
        (flo + fhi) / 2.0 + door_w / 2.0
    };
    let (g_lo, g_hi) = (g_hi - door_w, g_hi);

    // ---- Validated. Now mutate: drop the old shell + door, emit the new one. --
    let mut drop = wall_idxs;
    drop.sort_unstable();
    for &i in drop.iter().rev() {
        doc.walls.remove(i);
    }
    doc.components.remove(di);

    // Solid partitions along every interior (non-front, non-boundary) edge.
    for (a, b) in partitions {
        push_gen_wall(doc, a.x, a.y, b.x, b.y, PARTITION_T, false);
    }
    // Glazed (or solid) front, split by the door gap, + the door leaf.
    let front_t = if glass_front { GLAZING_T } else { PARTITION_T };
    let (door_x, door_y, rot);
    if vertical_front {
        push_gen_wall(doc, front_line, flo, front_line, g_lo, front_t, glass_front);
        push_gen_wall(doc, front_line, g_hi, front_line, fhi, front_t, glass_front);
        door_x = front_line;
        door_y = (g_lo + g_hi) / 2.0;
        // Right front: leaf swings into the room (−x). Left front: (+x).
        rot = if front == 1 { -std::f64::consts::FRAC_PI_2 } else { std::f64::consts::FRAC_PI_2 };
    } else {
        push_gen_wall(doc, flo, front_line, g_lo, front_line, front_t, glass_front);
        push_gen_wall(doc, g_hi, front_line, fhi, front_line, front_t, glass_front);
        door_x = (g_lo + g_hi) / 2.0;
        door_y = front_line;
        // Bottom front: leaf swings into the room (+y) → π. Top front: (−y) → 0.
        rot = if front == 2 { std::f64::consts::PI } else { 0.0 };
    }
    push_component(doc, "Door", door_x, door_y, door_w, DOOR_D, rot);
    Reenclose::Done
}

/// Unify the whole walking area into coherent merged **`Circulation`** polygons.
///
/// After the desk field, rooms, residual fill and `conform_zones_to_plate`, the
/// walking area is FRAGMENTED: many little residual `Circulation` rects/polys
/// (label `"Circulation"`) scattered across the floor, PLUS triangular wedges
/// against angled/stepped walls left as untyped WHITE floor. Laiout renders
/// circulation as one flowing space; this pass melts BOTH classes together.
///
/// 1. Raster the plate bbox at `CELL`. A cell is **WALKING** if its centre is
///    inside the plate and NOT covered by any non-circulation zone
///    (desk-field/room/workspace/core) nor any furniture footprint — i.e. it is
///    untyped OR already owned by a residual `"Circulation"` zone. The DRAWN
///    corridor network (spine `"Corridor"`, `"Entry"` connector, `"Aisle"` link,
///    seam `"Corridor"`) is a real designed corridor the score/entry logic
///    anchors on, so its cells stay OWNED (blocked) and it is left untouched.
/// 2. 4-connected flood-fill the WALKING cells into regions (row-major discovery
///    → deterministic ids, ordered by (min-y, min-x)).
/// 3. Each region ≥ `MIN_AREA` with a single simple boundary loop → one merged
///    `Poly`: trace the cell-set outline, SNAP each boundary vertex within `SNAP`
///    of the plate onto the nearest plate edge (so the wall-facing side is the
///    clean diagonal, not a grid staircase), simplify near-collinear runs.
/// 4. Guard against the non-circulation zones (`poly_overlaps_other_zones`, strict
///    tol) — a rejected region is simply left as its original residual zones
///    (never a coverage regression, never a disjointness break). The residual
///    `"Circulation"` zones a merged poly REPLACES are removed so they don't
///    double up; residual zones in un-merged regions are kept as-is.
///
/// Disjoint by construction (WALKING excludes every owned cell → NIA ≤ GEA;
/// separate components never share a cell → merged polys mutually disjoint).
/// Deterministic (grid + flood-fill + ascending-id emit, no RNG). Touches ONLY
/// Circulation — desks, rooms, workspace and Core are never read for growth nor
/// removed, so the workstation count and NIA are unchanged.
pub(crate) fn fill_untyped_as_circulation(doc: &mut Document, plate: &[Point]) {
    /// Raster cell (m): coarse enough to stay O(cells) inside the time budget,
    /// fine enough to catch a wedge; wall edges are exact via the vertex snap.
    const CELL: f64 = 0.25;
    /// Skip regions below this — sub-visible wall-thickness slivers; merging them
    /// only adds noise.
    const MIN_AREA: f64 = 0.5;
    /// Snap a boundary vertex this close to the plate wall onto that edge.
    const SNAP: f64 = 0.3;
    /// Drop a boundary vertex within this of the line through its neighbours.
    const SIMPLIFY: f64 = 0.02;
    /// Strict disjointness guard (~one sample cell of shared-edge quantization).
    const OVERLAP_TOL: f64 = 0.08;

    // The fragmentation we melt is everything the generator had LEFT OVER; the
    // drawn network (spine `Corridor`, perimeter ring, `Entry`, `Aisle`) is
    // designed and is preserved untouched.
    //
    // This was `zone_type == Circulation && label == "Circulation"`. A label is
    // a display string a user can retype — and `RoomTools` offers "Circulation"
    // as a room type — so renaming a drawn corridor silently converted network
    // into residual and the next run of this pass would melt it. `origin` is
    // structural and generator-only (see `ZoneOrigin`).
    let is_residual = |z: &Zone| z.origin == ZoneOrigin::Residual;

    let (mut minx, mut miny, mut maxx, mut maxy) =
        (f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY);
    for p in plate {
        minx = minx.min(p.x);
        miny = miny.min(p.y);
        maxx = maxx.max(p.x);
        maxy = maxy.max(p.y);
    }
    if !(maxx > minx && maxy > miny) {
        return;
    }
    let cols = (((maxx - minx) / CELL).ceil() as usize).max(1);
    let rows = (((maxy - miny) / CELL).ceil() as usize).max(1);

    // Blocking geometry: non-circulation zones (rooms/workspace/core) + the drawn
    // corridor network + every furniture footprint. A cell over any of these is
    // OWNED (not walking). Broad-phased by bbox.
    let block_zones: Vec<((f64, f64, f64, f64), usize)> = (0..doc.zones.len())
        .filter(|&i| !is_residual(&doc.zones[i]))
        .map(|i| (doc.zones[i].shape.bbox(), i))
        .collect();
    // Furniture footprints are stamped ONCE into a half-cell occupancy bitmap so
    // the per-cell/per-corner blocked test is an O(1) lookup, not a scan over
    // every component (that scan blew the debug time budget). Component bboxes are
    // axis-aligned, so a bbox stamp is exact. Zones stay an exact `contains` test
    // (there are far fewer of them, and `Poly` needs exact edges).
    const FCELL: f64 = 0.125;
    let fcols = (((maxx - minx) / FCELL).ceil() as usize).max(1);
    let frows = (((maxy - miny) / FCELL).ceil() as usize).max(1);
    let mut comp_occ = vec![false; fcols * frows];
    for c in &doc.components {
        let (ww, wh) = world_extents(c.w, c.h, c.rotation);
        let (x0, y0, x1, y1) = (c.x - ww / 2.0, c.y - wh / 2.0, c.x + ww / 2.0, c.y + wh / 2.0);
        let c0 = (((x0 - minx) / FCELL).floor().max(0.0)) as usize;
        let r0 = (((y0 - miny) / FCELL).floor().max(0.0)) as usize;
        let c1 = ((((x1 - minx) / FCELL).ceil()) as usize).min(fcols);
        let r1 = ((((y1 - miny) / FCELL).ceil()) as usize).min(frows);
        for r in r0..r1 {
            for cc in c0..c1 {
                comp_occ[r * fcols + cc] = true;
            }
        }
    }
    let blocked = |cx: f64, cy: f64| -> bool {
        let fc = ((cx - minx) / FCELL).floor();
        let fr = ((cy - miny) / FCELL).floor();
        if fc >= 0.0 && fr >= 0.0 && (fc as usize) < fcols && (fr as usize) < frows
            && comp_occ[fr as usize * fcols + fc as usize]
        {
            return true;
        }
        for &((a0, b0, a1, b1), i) in &block_zones {
            if cx >= a0 && cx <= a1 && cy >= b0 && cy <= b1 && doc.zones[i].shape.contains(cx, cy) {
                return true;
            }
        }
        false
    };

    // ---- Walking mask + connected components ---------------------------------
    // In-plate test by SCANLINE (one set of edge crossings per row, not a full
    // point-in-polygon per cell) — keeps the sweep O(cells) with a tiny constant
    // so it stays inside the generate time budget.
    //
    // A cell is WALKING only when its CENTRE is inside the plate AND its centre
    // and all four CORNERS are clear of every owned zone/furniture footprint.
    // Corner clearance (not just the centre) is what makes the merged poly
    // STRICTLY disjoint: a zone edge that clips a cell puts a corner inside the
    // zone → the cell is dropped → the cell-aligned poly never shares floor with
    // a zone. Centre-only would leave sub-cell slivers along every border that
    // sum past the disjointness tol (NIA > GEA). Corners a hair OUTSIDE the plate
    // do NOT block — that's the wall-facing side, snapped onto the wall later.
    let h = CELL / 2.0;
    let mut walk = vec![false; cols * rows];
    let mut xs: Vec<f64> = Vec::new();
    for r in 0..rows {
        let cy = miny + (r as f64 + 0.5) * CELL;
        xs.clear();
        for i in 0..plate.len() {
            let a = plate[i];
            let b = plate[(i + 1) % plate.len()];
            if (a.y <= cy && b.y > cy) || (b.y <= cy && a.y > cy) {
                xs.push(a.x + (cy - a.y) / (b.y - a.y) * (b.x - a.x));
            }
        }
        xs.sort_by(|p, q| p.partial_cmp(q).unwrap_or(std::cmp::Ordering::Equal));
        for c in 0..cols {
            let cx = minx + (c as f64 + 0.5) * CELL;
            if xs.iter().filter(|&&x| x < cx).count() % 2 == 1
                && !blocked(cx, cy)
                && !blocked(cx - h, cy - h)
                && !blocked(cx + h, cy - h)
                && !blocked(cx - h, cy + h)
                && !blocked(cx + h, cy + h)
            {
                walk[r * cols + c] = true;
            }
        }
    }
    let mut comp = vec![-1i32; cols * rows];
    let mut comp_cells: Vec<Vec<(usize, usize)>> = Vec::new();
    let mut stack: Vec<(usize, usize)> = Vec::new();
    for r0 in 0..rows {
        for c0 in 0..cols {
            if !walk[r0 * cols + c0] || comp[r0 * cols + c0] >= 0 {
                continue;
            }
            let id = comp_cells.len() as i32;
            let mut cells = Vec::new();
            comp[r0 * cols + c0] = id;
            stack.push((c0, r0));
            while let Some((c, r)) = stack.pop() {
                cells.push((c, r));
                let nb = |nc: i64, nr: i64, st: &mut Vec<(usize, usize)>, comp: &mut Vec<i32>| {
                    if nc < 0 || nr < 0 || nc >= cols as i64 || nr >= rows as i64 {
                        return;
                    }
                    let (nc, nr) = (nc as usize, nr as usize);
                    if walk[nr * cols + nc] && comp[nr * cols + nc] < 0 {
                        comp[nr * cols + nc] = id;
                        st.push((nc, nr));
                    }
                };
                nb(c as i64 - 1, r as i64, &mut stack, &mut comp);
                nb(c as i64 + 1, r as i64, &mut stack, &mut comp);
                nb(c as i64, r as i64 - 1, &mut stack, &mut comp);
                nb(c as i64, r as i64 + 1, &mut stack, &mut comp);
            }
            comp_cells.push(cells);
        }
    }

    // The merged poly is kept STRICTLY DISJOINT from every zone: `effective_zone_
    // areas` reconciles Workspace/room overlaps with rect-clip math that mis-
    // measures a big non-convex circulation `Poly`, so ANY real penetration risks
    // NIA > GEA. Corner-clearance already keeps the cell set a ~half-cell margin
    // clear of every zone; this guard is the belt-and-braces backstop, rejecting
    // any poly that still double-counts (a rejected region keeps its residuals).
    let guard_zones: Vec<Zone> =
        doc.zones.iter().filter(|z| !is_residual(z)).cloned().collect();
    let guard_boxes: Vec<(f64, f64, f64, f64)> =
        guard_zones.iter().map(|z| z.shape.bbox()).collect();

    let min_cells = (MIN_AREA / (CELL * CELL)).ceil() as usize;
    let mut emit: Vec<Vec<[f64; 2]>> = Vec::new();
    for (id, cells) in comp_cells.iter().enumerate() {
        let id = id as i32;
        if cells.len() < min_cells {
            continue;
        }
        // Trace the cell-set outline into boundary loops; a simply-connected
        // region yields exactly one. More than one → a hole/pinch a single
        // simple `Poly` can't represent: skip (its residual zones stay).
        let loops = trace_cell_boundary(cells, &comp, id, cols, rows, minx, miny, CELL);
        if loops.len() != 1 {
            continue;
        }
        let mut pts = loops.into_iter().next().unwrap();
        // Collapse the long axis-aligned collinear runs BEFORE snapping — the
        // per-vertex plate projection is the pass's hot loop, and a raw cell
        // outline is mostly straight interior borders that simplify to a handful
        // of vertices. (The diagonal wall's staircase survives this pass — its
        // steps aren't collinear — then snaps onto the wall and simplifies away.)
        simplify_collinear(&mut pts, SIMPLIFY);
        snap_poly(&mut pts, plate, SNAP);
        simplify_collinear(&mut pts, SIMPLIFY);
        if pts.len() < 3 {
            continue;
        }
        // Coarse guard step (0.4 m): corner-clearance already makes the poly
        // disjoint by construction, so this is pure insurance and needn't sample
        // finely — a real double-cover would be gross, not a hairline. (Conform,
        // which has no corner-clearance, keeps the fine 0.2 m step.)
        if poly_overlaps_other_zones(&pts, &guard_zones, &guard_boxes, guard_zones.len(), OVERLAP_TOL, 0.4)
        {
            continue;
        }
        emit.push(pts.iter().map(|p| [p.x, p.y]).collect());
    }

    // Remove every OLD residual "Circulation" zone so the walking area reads as
    // the merged polys, not a pile of little rects: one whose centre falls inside
    // a merged poly is now represented by it, and any that stayed un-merged is a
    // sub-`MIN_AREA` sliver the merge pass deliberately skips as noise (its floor
    // is negligible). Larger un-merged regions cannot occur — a residual zone
    // ≥ `MIN_AREA` forms its own walking component that merges. (`emit` was pushed
    // AFTER this filter, so it is untouched.)
    let emitted: Vec<Vec<Point>> = emit
        .iter()
        .map(|p| p.iter().map(|q| Point::new(q[0], q[1])).collect())
        .collect();
    doc.zones.retain(|z| {
        if !is_residual(z) {
            return true;
        }
        let (x0, y0, x1, y1) = z.shape.bbox();
        let (cx, cy) = ((x0 + x1) / 2.0, (y0 + y1) / 2.0);
        let absorbed = emitted.iter().any(|poly| geometry::point_in_polygon(cx, cy, poly));
        !(absorbed || z.shape.area() < MIN_AREA)
    });
    for pts in emit {
        // Type is provisional: `classify_residual_zones` below decides whether
        // this merged pocket is honestly circulation or unassigned. It is
        // emitted as residual so that judgement cannot be skipped.
        push_residual_zone(doc, ZoneType::Circulation, ZoneShape::Poly { pts }, "Circulation");
    }

    // Every pocket of leftover floor now exists in its merged form. Judge them.
    classify_residual_zones(doc);
}

/// Ramer–Douglas–Peucker on a CLOSED ring.
///
/// Splits the ring at its two most distant-in-index extremes (the first vertex
/// and the vertex farthest from it), simplifies each chain, and rejoins — the
/// standard way to apply an open-polyline algorithm to a loop without the
/// result depending on where the vertex list happens to start.
///
/// Exists because [`compactness`] would otherwise measure JAGGEDNESS, not shape.
/// A wall-following pocket leaves this pass with a staircase boundary snapped to
/// the plate, and every extra vertex adds perimeter without adding area: the
/// 80.43 m² ribbon on the reference plate carries 41 vertices and a 109 m
/// perimeter, so its raw compactness (0.085) is partly an artifact of how it was
/// traced rather than a fact about its shape. Simplifying first at the same
/// tolerance the boundary was snapped with makes a smooth corridor and a jagged
/// one of the same shape score together, which is the only way a threshold on
/// the result can mean anything.
pub(crate) fn simplify_rdp_closed(pts: &[Point], eps: f64) -> Vec<Point> {
    if pts.len() < 4 {
        return pts.to_vec();
    }
    let far = (1..pts.len())
        .max_by(|&a, &b| {
            let da = (pts[a].x - pts[0].x).hypot(pts[a].y - pts[0].y);
            let db = (pts[b].x - pts[0].x).hypot(pts[b].y - pts[0].y);
            da.partial_cmp(&db).unwrap_or(std::cmp::Ordering::Equal)
        })
        .unwrap_or(pts.len() - 1);
    let mut ring: Vec<Point> = Vec::new();
    let chain_a: Vec<Point> = pts[..=far].to_vec();
    let mut chain_b: Vec<Point> = pts[far..].to_vec();
    chain_b.push(pts[0]);
    let a = rdp(&chain_a, eps);
    let b = rdp(&chain_b, eps);
    ring.extend_from_slice(&a);
    // `b` starts where `a` ended and ends where `a` started; drop both duplicates.
    if b.len() > 2 {
        ring.extend_from_slice(&b[1..b.len() - 1]);
    }
    ring
}

fn rdp(pts: &[Point], eps: f64) -> Vec<Point> {
    if pts.len() < 3 {
        return pts.to_vec();
    }
    let (a, b) = (pts[0], pts[pts.len() - 1]);
    let mut worst = 0.0f64;
    let mut idx = 0usize;
    for (i, p) in pts.iter().enumerate().take(pts.len() - 1).skip(1) {
        let d = geometry::point_segment_dist(*p, a, b);
        if d > worst {
            worst = d;
            idx = i;
        }
    }
    if worst <= eps {
        return vec![a, b];
    }
    let mut left = rdp(&pts[..=idx], eps);
    let right = rdp(&pts[idx..], eps);
    left.pop();
    left.extend(right);
    left
}

/// Isoperimetric quotient `4piA / P^2` over the SIMPLIFIED boundary: 1.0 for a
/// circle, 0.785 for a square, and falling toward 0 as a shape becomes a path.
///
/// Both area and perimeter come from the simplified ring, so the measure is
/// internally consistent — mixing a raw area with a simplified perimeter would
/// bias every jagged shape upward.
pub(crate) fn compactness(pts: &[Point], eps: f64) -> f64 {
    let ring = simplify_rdp_closed(pts, eps);
    if ring.len() < 3 {
        // The whole pocket simplified away: every vertex sat within `eps` of the
        // line through its neighbours, so the shape is smaller than the
        // tolerance it is measured at. Return the CIRCLE bound (1.0) — the
        // maximally non-path answer — so such a pocket is rejected rather than
        // waved through on a shape nobody could measure. Conservative by
        // choice, and stated: a silent 1.0 falling out of a guard clause is how
        // a fallback becomes an accidental rule.
        return 1.0;
    }
    let area = geometry::polygon_area(&ring);
    let mut per = 0.0;
    for i in 0..ring.len() {
        let j = (i + 1) % ring.len();
        per += (ring[j].x - ring[i].x).hypot(ring[j].y - ring[i].y);
    }
    if per <= 1e-9 {
        return 1.0; // degenerate ring — same conservative answer as above
    }
    4.0 * std::f64::consts::PI * area / (per * per)
}

/// Decides, for each pocket of leftover floor, whether it is **circulation** or
/// merely **unassigned**.
///
/// One grid is built for the whole document and every residual zone is measured
/// against it, so the answer cannot depend on the order zones were emitted in.
///
/// The mask is the point of the type. `circulation::build_grid`'s free space is
/// *physical* — anything that is not wall and not furniture — so it runs
/// straight through a meeting room. Judged against that, a dead pocket touching
/// a meeting-room wall would read as "connected to the walking network" via the
/// meeting room and be promoted. So this builds its mask with the **program**
/// zones stamped as blocked and the **drawn corridor network left free**: what
/// remains is exactly the walkable-and-unclaimed floor, and the network is what
/// seeds the flood.
pub(crate) struct WalkClassifier {
    grid: circulation::Grid,
    /// Per cell: free in the mask AND clear width ≥ [`MIN_CIRC_CLEAR_M`].
    /// Clear width at a cell is `2 · distance-to-nearest-obstacle`.
    wide: Vec<bool>,
    /// Per cell: reachable from the drawn corridor network by 4-connected steps
    /// **through `wide` cells only**. A pocket joined to the network solely by a
    /// sub-code pinch is therefore NOT reachable — which is the intent: you
    /// cannot call a space part of the walking network if you cannot legally
    /// walk into it.
    reach: Vec<bool>,
    /// False when the document carries no drawn corridor network at all. The
    /// connectivity conjunct is then vacuous and width alone decides — stated
    /// rather than silently defaulted, because "connected to nothing" would
    /// otherwise mark every pocket on a corridor-less plan as unassigned.
    has_network: bool,
}

impl WalkClassifier {
    /// Build the mask for `doc`. `None` when there are no walls to bound a grid
    /// (the same degenerate case `circulation::evaluate` refuses).
    pub(crate) fn build(doc: &Document) -> Option<Self> {
        let cfg = CirculationConfig::new();
        // Program zones block; residual pockets and the drawn network do not.
        let program: Vec<&Zone> = doc
            .zones
            .iter()
            .filter(|z| {
                !matches!(z.zone_type, ZoneType::Circulation | ZoneType::Unassigned)
            })
            .collect();
        let grid = circulation::walkable_grid(doc, &cfg, &program)?;
        let n = grid.cols * grid.rows;
        let dt = circulation::distance_transform(&grid);

        let mut wide = vec![false; n];
        for i in 0..n {
            if !grid.blocked[i] && 2.0 * dt[i] * grid.cell >= MIN_CIRC_CLEAR_M {
                wide[i] = true;
            }
        }

        // Seeds: cells inside a zone that is circulation AND drawn — i.e. the
        // designed network (spine `Corridor`, perimeter ring, `Entry`, `Aisle`).
        // A residual zone is never a seed; that would let leftover floor vouch
        // for leftover floor.
        let mut reach = vec![false; n];
        let mut stack: Vec<usize> = Vec::new();
        let mut has_network = false;
        for z in &doc.zones {
            if z.origin != ZoneOrigin::Drawn || z.zone_type != ZoneType::Circulation {
                continue;
            }
            has_network = true;
            let (x0, y0, x1, y1) = z.shape.bbox();
            let (c0, c1) = (grid.col_of(x0), grid.col_of(x1));
            let (r0, r1) = (grid.row_of(y0), grid.row_of(y1));
            for r in r0..=r1 {
                for c in c0..=c1 {
                    let i = grid.idx(c, r);
                    if !wide[i] || reach[i] {
                        continue;
                    }
                    let p = grid.cell_center(c, r);
                    if z.shape.contains(p.x, p.y) {
                        reach[i] = true;
                        stack.push(i);
                    }
                }
            }
        }
        // 4-connected flood through `wide`.
        while let Some(i) = stack.pop() {
            let (c, r) = (i % grid.cols, i / grid.cols);
            let step = |c: usize, r: usize, st: &mut Vec<usize>, reach: &mut Vec<bool>| {
                let j = r * grid.cols + c;
                if wide[j] && !reach[j] {
                    reach[j] = true;
                    st.push(j);
                }
            };
            if c > 0 { step(c - 1, r, &mut stack, &mut reach); }
            if c + 1 < grid.cols { step(c + 1, r, &mut stack, &mut reach); }
            if r > 0 { step(c, r - 1, &mut stack, &mut reach); }
            if r + 1 < grid.rows { step(c, r + 1, &mut stack, &mut reach); }
        }

        Some(WalkClassifier { grid, wide, reach, has_network })
    }

    /// Classify one leftover pocket by sampling this grid over the polygon the
    /// pass will actually emit — not over the coarser cell set it was traced
    /// from, so the measurement matches the delivered shape.
    ///
    /// Circulation iff **both**:
    ///   * ≥ [`CIRC_WIDE_FRACTION`] of the pocket's area sits on cells of clear
    ///     width ≥ [`MIN_CIRC_CLEAR_M`], and
    ///   * some part of it is reachable from the drawn network through such
    ///     cells (vacuous when the plan draws no network).
    ///
    /// A pocket that is wide but sealed off is Unassigned: width alone does not
    /// make floor part of a walking network.
    /// Diagnostic twin of `classify_poly`: returns the two numbers the decision
    /// was made from, so a surprising verdict can be explained rather than
    /// argued about. Test-only.
    #[cfg(test)]
    pub(crate) fn debug_measure(&self, pts: &[Point]) -> (f64, bool, usize) {
        let (mut minx, mut miny, mut maxx, mut maxy) =
            (f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY);
        for p in pts {
            minx = minx.min(p.x); miny = miny.min(p.y);
            maxx = maxx.max(p.x); maxy = maxy.max(p.y);
        }
        let (c0, c1) = (self.grid.col_of(minx), self.grid.col_of(maxx));
        let (r0, r1) = (self.grid.row_of(miny), self.grid.row_of(maxy));
        let (mut inside, mut wide_n, mut reach_n) = (0usize, 0usize, 0usize);
        for r in r0..=r1 {
            for c in c0..=c1 {
                let p = self.grid.cell_center(c, r);
                if !geometry::point_in_polygon(p.x, p.y, pts) { continue; }
                inside += 1;
                let i = self.grid.idx(c, r);
                if self.wide[i] { wide_n += 1; }
                if self.reach[i] { reach_n += 1; }
            }
        }
        let wf = if inside > 0 { wide_n as f64 / inside as f64 } else { 0.0 };
        (wf, !self.has_network || reach_n > 0, inside)
    }

    pub(crate) fn classify_poly(&self, pts: &[Point]) -> ZoneType {
        let (mut minx, mut miny, mut maxx, mut maxy) =
            (f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY);
        for p in pts {
            minx = minx.min(p.x);
            miny = miny.min(p.y);
            maxx = maxx.max(p.x);
            maxy = maxy.max(p.y);
        }
        if !(maxx > minx && maxy > miny) {
            return ZoneType::Unassigned;
        }
        let (c0, c1) = (self.grid.col_of(minx), self.grid.col_of(maxx));
        let (r0, r1) = (self.grid.row_of(miny), self.grid.row_of(maxy));
        let (mut inside, mut wide_n, mut reach_n) = (0usize, 0usize, 0usize);
        for r in r0..=r1 {
            for c in c0..=c1 {
                let p = self.grid.cell_center(c, r);
                if !geometry::point_in_polygon(p.x, p.y, pts) {
                    continue;
                }
                inside += 1;
                let i = self.grid.idx(c, r);
                if self.wide[i] {
                    wide_n += 1;
                }
                if self.reach[i] {
                    reach_n += 1;
                }
            }
        }
        if inside == 0 {
            // Smaller than one grid cell. Nothing this size is a corridor.
            return ZoneType::Unassigned;
        }
        let wide_frac = wide_n as f64 / inside as f64;
        let connected = !self.has_network || reach_n > 0;
        // THIRD CONJUNCT — shape. Measured on the RDP-simplified boundary at the
        // same tolerance the boundary was snapped with, so a pocket is judged on
        // its shape and not on how finely it happened to be traced.
        let path_shaped = compactness(pts, SNAP_TOL) < corridor_compactness_max();
        if wide_frac >= CIRC_WIDE_FRACTION && connected && path_shaped {
            ZoneType::Circulation
        } else {
            ZoneType::Unassigned
        }
    }
}

/// Re-type every **residual** zone as `Circulation` or `Unassigned`.
///
/// A sweep over `origin == Residual` rather than a decision taken at each
/// emission site, so no path can mint leftover floor and skip the judgement —
/// including the pockets the merge rejects (a region with a hole, whose
/// original residual rects survive) and the sub-`MIN_AREA` slivers.
///
/// Runs AFTER the merge on purpose: clear width is a property of the merged
/// shape, and two slivers that merge into one 1.4 m band are a corridor while
/// neither half was.
pub(crate) fn classify_residual_zones(doc: &mut Document) {
    if !doc.zones.iter().any(|z| z.origin == ZoneOrigin::Residual) {
        return;
    }
    let Some(cls) = WalkClassifier::build(doc) else { return };
    for i in 0..doc.zones.len() {
        if doc.zones[i].origin != ZoneOrigin::Residual {
            continue;
        }
        let pts: Vec<Point> = match &doc.zones[i].shape {
            ZoneShape::Poly { pts } => pts.iter().map(|p| Point::new(p[0], p[1])).collect(),
            ZoneShape::Rect { x, y, w, h } => {
                let (hw, hh) = (w / 2.0, h / 2.0);
                vec![
                    Point::new(x - hw, y - hh),
                    Point::new(x + hw, y - hh),
                    Point::new(x + hw, y + hh),
                    Point::new(x - hw, y + hh),
                ]
            }
            // A residual zone is never a ring — the perimeter corridor is drawn.
            ZoneShape::RectRing { .. } => continue,
        };
        let t = cls.classify_poly(&pts);
        doc.zones[i].zone_type = t;
        // The label follows the type so the two can never disagree on screen.
        // Identification is the LEGEND's job on paper (both are ground), but the
        // editor still names what you select.
        doc.zones[i].label = match t {
            ZoneType::Unassigned => "Unassigned".to_string(),
            _ => "Circulation".to_string(),
        };
    }
}

/// Trace the outline(s) of the cells of `comp == id` as CCW loops of world
/// points. Emits the directed cell-edges not shared with another in-component
/// cell (interior on the left), then stitches them into closed loops by matching
/// integer lattice endpoints — a simply-connected region gives exactly one loop.
pub(crate) fn trace_cell_boundary(
    cells: &[(usize, usize)],
    comp: &[i32],
    id: i32,
    cols: usize,
    rows: usize,
    minx: f64,
    miny: f64,
    cell: f64,
) -> Vec<Vec<Point>> {
    use std::collections::HashMap;
    let inside = |c: i64, r: i64| -> bool {
        c >= 0 && r >= 0 && c < cols as i64 && r < rows as i64 && comp[r as usize * cols + c as usize] == id
    };
    // Directed edges (start → end) as integer lattice corners.
    let mut adj: HashMap<(i64, i64), Vec<(i64, i64)>> = HashMap::new();
    for &(c, r) in cells {
        let (c, r) = (c as i64, r as i64);
        // BL,BR,TR,TL corners of the cell.
        let (bl, br, tr, tl) = ((c, r), (c + 1, r), (c + 1, r + 1), (c, r + 1));
        if !inside(c, r - 1) {
            adj.entry(bl).or_default().push(br); // bottom, →
        }
        if !inside(c + 1, r) {
            adj.entry(br).or_default().push(tr); // right, ↑
        }
        if !inside(c, r + 1) {
            adj.entry(tr).or_default().push(tl); // top, ←
        }
        if !inside(c - 1, r) {
            adj.entry(tl).or_default().push(bl); // left, ↓
        }
    }
    let to_world = |p: (i64, i64)| Point::new(minx + p.0 as f64 * cell, miny + p.1 as f64 * cell);
    let mut loops: Vec<Vec<Point>> = Vec::new();
    // Walk edges, consuming each once. Deterministic start: smallest key.
    let mut starts: Vec<(i64, i64)> = adj.keys().copied().collect();
    starts.sort();
    for s in starts {
        while let Some(nexts) = adj.get(&s) {
            if nexts.is_empty() {
                break;
            }
            let mut loop_pts: Vec<Point> = Vec::new();
            let mut cur = s;
            loop {
                let next = match adj.get_mut(&cur).and_then(|v| v.pop()) {
                    Some(n) => n,
                    None => break,
                };
                loop_pts.push(to_world(cur));
                cur = next;
                if cur == s {
                    break;
                }
            }
            if loop_pts.len() >= 3 {
                loops.push(loop_pts);
            }
        }
    }
    loops
}

/// Snap each boundary vertex onto the nearest `plate` wall or neighbouring
/// `zone_edges` border within `snap` m. Closes BOTH gaps a grid-aligned trace
/// leaves: the wall-facing side lands on the exact diagonal/step wall, and the
/// interior side lands on the shared zone border (the half-cell corner-clearance
/// seam collapses to a zero-area shared edge → no untyped white AND no double-
/// count). A vertex OUTSIDE the plate (a wall-facing cell overshoots the wall by
/// up to half a cell) is pulled onto the WALL, never a nearer zone edge — so the
/// merged poly can't bulge past the boundary (`area_on` doesn't clip a `Poly`).
pub(crate) fn snap_poly(pts: &mut [Point], plate: &[Point], snap: f64) {
    let plate_segs: Vec<(Point, Point)> =
        (0..plate.len()).map(|i| (plate[i], plate[(i + 1) % plate.len()])).collect();
    for p in pts.iter_mut() {
        let mut best = f64::INFINITY;
        let mut pp = *p;
        for &(a, b) in &plate_segs {
            let q = geometry::closest_point_on_segment(*p, a, b);
            let d = p.dist(&q);
            if d < best {
                best = d;
                pp = q;
            }
        }
        // A wall-facing vertex overshooting the boundary (a corner-clearance cell
        // overshoots by ≤ ~0.18 m) is pulled onto the wall UNCONDITIONALLY so the
        // merged poly stays ⊆ plate (its unclipped `area_on` can't overcount floor
        // the plate lacks); an interior vertex snaps only within `snap`.
        if !geometry::point_in_polygon(p.x, p.y, plate) || best <= snap {
            *p = pp;
        }
    }
}

/// Drop each vertex within `tol` m of the segment through its neighbours (a
/// near-collinear run — the many grid steps a snapped diagonal leaves, and the
/// straight interior edges). Keeps at least a triangle.
pub(crate) fn simplify_collinear(pts: &mut Vec<Point>, tol: f64) {
    if pts.len() <= 3 {
        return;
    }
    let mut changed = true;
    while changed && pts.len() > 3 {
        changed = false;
        let n = pts.len();
        let mut keep = vec![true; n];
        let mut removed = 0;
        for i in 0..n {
            if n - removed <= 3 {
                break;
            }
            let prev = {
                let mut j = (i + n - 1) % n;
                while !keep[j] {
                    j = (j + n - 1) % n;
                }
                j
            };
            let next = {
                let mut j = (i + 1) % n;
                while !keep[j] {
                    j = (j + 1) % n;
                }
                j
            };
            if prev == i || next == i || prev == next {
                continue;
            }
            if geometry::point_segment_dist(pts[i], pts[prev], pts[next]) <= tol {
                keep[i] = false;
                removed += 1;
                changed = true;
            }
        }
        if removed > 0 {
            *pts = pts.iter().zip(keep).filter(|(_, k)| *k).map(|(p, _)| *p).collect();
        }
    }
}

/// True if `poly` overlaps some zone other than `self_idx` by more than `tol` m².
/// A coarse 0.2 m grid, broad-phase culled by `zone_bboxes` (only zones whose AABB
/// meets the poly's are tested) and early-exiting the instant the tolerance is
/// crossed — enough to reject a conform/fill that would double-count another
/// zone's floor. Sampling is confined to each candidate zone's own bbox (∩ the
/// poly's), NOT the poly's full AABB: a big non-convex circulation poly can have a
/// vast, mostly-empty AABB, so per-zone sampling keeps this near-free (the sample
/// count is bounded by the small zones' areas, not the poly's bounding box).
pub(crate) fn poly_overlaps_other_zones(
    poly: &[Point],
    zones: &[Zone],
    zone_boxes: &[(f64, f64, f64, f64)],
    self_idx: usize,
    tol: f64,
    step: f64,
) -> bool {
    if poly.len() < 3 {
        return false;
    }
    let (mut minx, mut miny, mut maxx, mut maxy) =
        (f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY);
    for p in poly {
        minx = minx.min(p.x);
        miny = miny.min(p.y);
        maxx = maxx.max(p.x);
        maxy = maxy.max(p.y);
    }
    let (step, cell) = (step, step * step);
    let mut overlap = 0.0;
    for (j, &(a0, b0, a1, b1)) in zone_boxes.iter().enumerate() {
        if j == self_idx || !(a0 < maxx && a1 > minx && b0 < maxy && b1 > miny) {
            continue;
        }
        // Sample only this zone's bbox clipped to the poly's — the shared band.
        let (sx0, sy0, sx1, sy1) = (a0.max(minx), b0.max(miny), a1.min(maxx), b1.min(maxy));
        let mut y = sy0 + step / 2.0;
        while y < sy1 {
            let mut x = sx0 + step / 2.0;
            while x < sx1 {
                if zones[j].shape.contains(x, y) && geometry::point_in_polygon(x, y, poly) {
                    overlap += cell;
                    if overlap > tol {
                        return true;
                    }
                }
                x += step;
            }
            y += step;
        }
    }
    false
}
