//! Room placement: hunting a legal slot for one `RoomJob` along a band, in an
//! interior pocket, or at a user anchor, and emitting it once found.

use super::*;

/// Maximum face gap (m) between two rooms that still reads as ONE SHARED WALL:
/// a generated partition (`PARTITION_T` 0.1) meeting a glazed front
/// (`GLAZING_T` 0.05). Derived, not tuned — the same arithmetic the
/// plan-quality rubric's `WALL_MAX_M` cites.
pub(crate) const ROOM_ABUT_MAX: f64 = PARTITION_T + GLAZING_T;

/// Face gap between two corner-origin rects across the axis they overlap on;
/// `None` when they interpenetrate or are diagonal (no shared face). The
/// 0.05 m overlap slack matches the plan-quality rubric's `faceGap`.
fn face_gap(a: &geometry::Rect, b: &geometry::Rect) -> Option<f64> {
    let ov_x = a.x1.min(b.x1) - a.x0.max(b.x0);
    let ov_y = a.y1.min(b.y1) - a.y0.max(b.y0);
    if ov_x > 0.05 && ov_y > 0.05 {
        return None;
    }
    if ov_y > 0.05 {
        return Some(a.x0.max(b.x0) - a.x1.min(b.x1));
    }
    if ov_x > 0.05 {
        return Some(a.y0.max(b.y0) - a.y1.min(b.y1));
    }
    None
}

/// **The wall-or-passage invariant** (PQ2's property, enforced at placement):
/// the gap between a candidate room and every room already emitted must be a
/// shared wall (≤ [`ROOM_ABUT_MAX`]) or a walkable passage (≥ `SECONDARY_W`) —
/// the band in between is floor that is billed, dead, and unenterable, so a
/// candidate that would create it is not a legal slot at all.
pub(crate) fn room_gap_legal(rooms: &[geometry::Rect], cx: f64, cy: f64, w: f64, h: f64) -> bool {
    let cand = geometry::Rect { x0: cx - w / 2.0, y0: cy - h / 2.0, x1: cx + w / 2.0, y1: cy + h / 2.0 };
    rooms.iter().all(|r| match face_gap(&cand, r) {
        Some(g) => g <= ROOM_ABUT_MAX + 1e-6 || g >= SECONDARY_W - 1e-6,
        None => true,
    })
}

/// Corner-origin rects of every ROOM zone already in the document — the same
/// population PQ2 grades (every zone type except Circulation / Workspace /
/// Core; Unassigned does not exist at placement time). Open settings (collab,
/// print) count: a dead sliver beside an open zone is as dead as one beside a
/// wall.
pub(crate) fn room_rects(doc: &Document) -> Vec<geometry::Rect> {
    doc.zones
        .iter()
        .filter(|z| {
            !matches!(
                z.zone_type,
                ZoneType::Circulation | ZoneType::Workspace | ZoneType::Core | ZoneType::Unassigned
            )
        })
        .filter_map(|z| match z.shape {
            ZoneShape::Rect { x, y, w, h } => Some(geometry::Rect {
                x0: x - w / 2.0,
                y0: y - h / 2.0,
                x1: x + w / 2.0,
                y1: y + h / 2.0,
            }),
            _ => None,
        })
        .collect()
}

/// Gap (m) between a center-based rect and a corner-based `geometry::Rect`
/// (0 when they touch or overlap).
pub(crate) fn rect_gap(cx: f64, cy: f64, w: f64, h: f64, r: &geometry::Rect) -> f64 {
    let dx = (r.x0 - (cx + w / 2.0)).max((cx - w / 2.0) - r.x1).max(0.0);
    let dy = (r.y0 - (cy + h / 2.0)).max((cy - h / 2.0) - r.y1).max(0.0);
    (dx * dx + dy * dy).sqrt()
}

/// Whether a room may stand at (cx, cy, w×h): on the plate, clear of interior
/// walls, abutting-but-not-inside keep-outs (0.05 m), a person-clearance from
/// frozen furniture, `ROOM_GAP` from other rooms — and, against every room
/// already emitted, at a WALL-OR-PASSAGE gap ([`room_gap_legal`]) — and never
/// intruding on a drawn circulation rect.
#[allow(clippy::too_many_arguments)]
pub(crate) fn room_slot_ok(
    plate: Option<&[Point]>,
    iwalls: &[(Point, Point, f64)],
    obstacles: &[(f64, f64, f64, f64)],
    keepout_len: usize,
    frozen_len: usize,
    circ_rects: &[geometry::Rect],
    rooms: &[geometry::Rect],
    clear: f64,
    cx: f64,
    cy: f64,
    w: f64,
    h: f64,
) -> bool {
    slot_fits_plate(plate, cx, cy, w, h, 0.05)
        && slot_clears_walls(iwalls, cx, cy, w, h)
        && !footprint_overlaps(&obstacles[..keepout_len], cx, cy, w, h, 0.05)
        && !footprint_overlaps(&obstacles[keepout_len..frozen_len], cx, cy, w, h, clear)
        && !footprint_overlaps(&obstacles[frozen_len..], cx, cy, w, h, ROOM_GAP - 1e-6)
        && room_gap_legal(rooms, cx, cy, w, h)
        // A band room's glazed front sits EXACTLY on the spine edge (its door
        // opens onto it) - that shared edge must be allowed. Reject only genuine
        // interpenetration (a strict negative tolerance), not a touching front.
        && !circ_rects.iter().any(|r| {
            (cx - (r.x0 + r.x1) / 2.0).abs() < (w + r.width()) / 2.0 - 1e-6
                && (cy - (r.y0 + r.y1) / 2.0).abs() < (h + r.height()) / 2.0 - 1e-6
        })
}

/// Emit one placed room job: an enclosed shell via `emit_room` for walled
/// rooms, or an open setting (zone + breakout table) for collab/print.
pub(crate) fn emit_job(doc: &mut Document, job: &RoomJob, cx: f64, cy: f64, w: f64, h: f64, side: CorridorSide) {
    if job.walls {
        emit_room(
            doc, cx, cy, w, h, side,
            &RoomSpec {
                zone_type: job.zone_type,
                label: job.label.clone(),
                glass_front: job.glass_front,
                door_w: job.door_w,
                furniture: job.furniture,
                seats: job.seats,
            },
        );
    } else {
        push_zone(doc, job.zone_type, ZoneShape::Rect { x: cx, y: cy, w, h }, &job.label);
        let tw = snap_module((w - 1.8).clamp(0.6, 2.4).min(w - 0.2));
        let th = snap_module((h - 1.8).clamp(0.6, 1.2).min(h - 0.2));
        if tw > 0.3 && th > 0.3 {
            let (tx, ty) = (snap_module(cx), snap_module(cy));
            push_component(doc, "Table", tx, ty, tw, th, 0.0);
            // A COLLABORATION setting is a table people sit around, so it is
            // seated like any meeting table. The other open setting is the print
            // point, whose "table" is a copier console — nobody sits at it, so it
            // is deliberately left unseated (this is why the rule keys on the
            // zone type and not on the presence of a `Table`).
            if job.zone_type == ZoneType::Collaboration {
                seat_around_table(
                    doc, tx, ty, tw, th,
                    (cx - w / 2.0, cy - h / 2.0, cx + w / 2.0, cy + h / 2.0),
                );
            }
        }
    }
}

/// Slide `job` along `plan`'s band — from the entry end, or the far end for
/// `far` jobs — in `BAND_STEP` increments until a clear anchor appears. THE
/// wall-dense-plate fix: the old fixed-pitch placement found almost no clear
/// slots once real interior walls constrained the band (1 of 11 rooms on the
/// user's imported building); a sliding anchor hunts out the gaps between
/// them. Room fronts stay ON the shared band-front line. Returns placed.
#[allow(clippy::too_many_arguments)]
pub(crate) fn place_in_band(
    doc: &mut Document,
    plan: &RegionPlan,
    job: &RoomJob,
    cursors: &mut (f64, f64),
    plate: Option<&[Point]>,
    iwalls: &[(Point, Point, f64)],
    obstacles: &mut Vec<(f64, f64, f64, f64)>,
    keepout_len: usize,
    frozen_len: usize,
    circ_rects: &[geometry::Rect],
    clear: f64,
) -> bool {
    let depth_cap = (plan.band_front - plan.band_base).abs();
    if depth_cap < 0.5 {
        return false;
    }
    let rooms = room_rects(doc);
    // Clamp to the band (the old meeting clamp, floored at 70% of the ask).
    let d = snap_room_floor(job.d.min(depth_cap));
    let w = snap_room_floor(job.w.min(cursors.1 - cursors.0));
    if d < 0.7 * job.d - 1e-9 || w < 0.7 * job.w - 1e-9 || w < 0.5 {
        return false;
    }
    // Front-aligned: the corridor face sits exactly on the band front line — so
    // every room front lands on one unbroken line (spec §4.3). EXCEPTION: Focus
    // rooms REAR-align to `band_base` (the band's rear, which backs onto the
    // boundary/facade wall) so they sit ON the facade for daylight — item 4a's
    // HARD placement rule (front-alignment would float a shallow focus room in
    // the band middle, AWAY from the window, which is exactly the inequality M7
    // couldn't guarantee). Their glazed front + door still open toward the spine
    // across the shallow set-back the deeper band leaves — a reachable pocket.
    let sign = if plan.band_far { 1.0 } else { -1.0 };
    let cc = if job.kind == SpaceKind::Focus {
        plan.band_base - sign * d / 2.0
    } else {
        plan.band_front + sign * d / 2.0
    };
    let side = match (plan.portrait, plan.band_far) {
        (false, false) => CorridorSide::Top,
        (false, true) => CorridorSide::Bottom,
        (true, false) => CorridorSide::Right,
        (true, true) => CorridorSide::Left,
    };
    // World rect dims: a portrait band runs along Y, so front-run/depth swap.
    let (ww, hh) = if plan.portrait { (d, w) } else { (w, d) };

    let from_hi = job.far ^ plan.rev;
    let mut along = if from_hi {
        snap_module_floor(cursors.1 - w / 2.0)
    } else {
        snap_module(cursors.0 + w / 2.0)
    };
    loop {
        if from_hi {
            if along - w / 2.0 < cursors.0 - 1e-9 {
                return false;
            }
        } else if along + w / 2.0 > cursors.1 + 1e-9 {
            return false;
        }
        let (cx, cy) = if plan.portrait { (cc, along) } else { (along, cc) };
        if room_slot_ok(
            plate, iwalls, obstacles, keepout_len, frozen_len, circ_rects, &rooms, clear, cx, cy, ww, hh,
        ) {
            emit_job(doc, job, cx, cy, ww, hh, side);
            obstacles.push((cx, cy, ww, hh));
            if from_hi {
                cursors.1 = along - w / 2.0 - ROOM_GAP;
            } else {
                cursors.0 = along + w / 2.0 + ROOM_GAP;
            }
            return true;
        }
        along = if from_hi {
            snap_module(along - BAND_STEP)
        } else {
            snap_module(along + BAND_STEP)
        };
    }
}

/// Interior clear-pocket fallback for rooms the bands rejected: scan a
/// `POCKET_STEP` candidate grid across every region (BOTH orientations), keep
/// the fitting candidate nearest a drawn circulation rect, and face the door
/// toward it. This is what lets rooms land between the interior walls of a
/// wall-dense imported plan instead of being silently dropped.
#[allow(clippy::too_many_arguments)]
pub(crate) fn place_in_pocket(
    doc: &mut Document,
    plans: &[RegionPlan],
    job: &RoomJob,
    plate: Option<&[Point]>,
    iwalls: &[(Point, Point, f64)],
    obstacles: &mut Vec<(f64, f64, f64, f64)>,
    keepout_len: usize,
    frozen_len: usize,
    circ_rects: &[geometry::Rect],
    clear: f64,
) -> bool {
    let rooms = room_rects(doc);
    let mut best: Option<(f64, f64, f64, f64, f64)> = None; // (dist, cx, cy, w, h)
    'search: for plan in plans {
        let p = &plan.pocket;
        for (w, d) in [(job.w, job.d), (job.d, job.w)] {
            // Clamp to the pocket exactly as the band pass clamps to its band:
            // down to 70% of the ask still counts as fitting. Without this a
            // room-scale wing 0.1 m shy of a cabin's depth hosted nothing.
            let ww = snap_room_floor(w.min(p.width()));
            let hh = snap_room_floor(d.min(p.height()));
            if ww < 0.7 * w - 1e-9 || hh < 0.7 * d - 1e-9 || ww < 0.5 || hh < 0.5 {
                continue;
            }
            let x_lo = p.x0 + ww / 2.0;
            let x_hi = p.x1 - ww / 2.0;
            let y_lo = p.y0 + hh / 2.0;
            let y_hi = p.y1 - hh / 2.0;
            let nx = ((x_hi - x_lo) / POCKET_STEP).floor().max(0.0) as i64;
            let ny = ((y_hi - y_lo) / POCKET_STEP).floor().max(0.0) as i64;
            // Scan-grid candidates, PLUS flush-snap candidates: for each room
            // already placed, positions abutting it at ROOM_GAP (shared-wall
            // class) with edges aligned to it. Without these, the wall-or-
            // passage invariant would push every pocket room a whole aisle
            // away from its neighbour — legal, but wasteful; WITH them, rooms
            // pack shoulder-to-shoulder exactly like a band.
            let mut cands: Vec<(f64, f64)> = Vec::new();
            for iy in 0..=ny {
                for ix in 0..=nx {
                    cands.push((
                        snap_module(x_lo + ix as f64 * POCKET_STEP),
                        snap_module(y_lo + iy as f64 * POCKET_STEP),
                    ));
                }
            }
            for r in &rooms {
                let xs = [r.x0 - ROOM_GAP - ww / 2.0, r.x1 + ROOM_GAP + ww / 2.0];
                let ys = [r.y0 - ROOM_GAP - hh / 2.0, r.y1 + ROOM_GAP + hh / 2.0];
                let x_aligns = [r.x0 + ww / 2.0, r.x1 - ww / 2.0, (r.x0 + r.x1) / 2.0];
                let y_aligns = [r.y0 + hh / 2.0, r.y1 - hh / 2.0, (r.y0 + r.y1) / 2.0];
                for &cx in &xs {
                    for &cy in &y_aligns {
                        cands.push((snap_module(cx), snap_module(cy)));
                    }
                }
                for &cy in &ys {
                    for &cx in &x_aligns {
                        cands.push((snap_module(cx), snap_module(cy)));
                    }
                }
            }
            for (cx, cy) in cands {
                {
                    if cx - ww / 2.0 < p.x0 - 1e-9
                        || cx + ww / 2.0 > p.x1 + 1e-9
                        || cy - hh / 2.0 < p.y0 - 1e-9
                        || cy + hh / 2.0 > p.y1 + 1e-9
                    {
                        continue;
                    }
                    if !room_slot_ok(
                        plate, iwalls, obstacles, keepout_len, frozen_len, circ_rects, &rooms, clear,
                        cx, cy, ww, hh,
                    ) {
                        continue;
                    }
                    let dist = circ_rects
                        .iter()
                        .map(|r| rect_gap(cx, cy, ww, hh, r))
                        .fold(f64::INFINITY, f64::min);
                    if best.is_none_or(|b| dist < b.0) {
                        best = Some((dist, cx, cy, ww, hh));
                    }
                    if dist <= 0.3 {
                        break 'search; // adjacent to a corridor — take it
                    }
                }
            }
        }
    }
    let Some((_, cx, cy, ww, hh)) = best else { return false };
    let side = door_side_toward_circ(cx, cy, ww, hh, circ_rects);
    emit_job(doc, job, cx, cy, ww, hh, side);
    obstacles.push((cx, cy, ww, hh));
    true
}

/// PASS D — a room into RESIDUAL ground: the free floor left after every band,
/// pocket, anchor and desk pass has run. The free rectangles are re-derived
/// from the document exactly the way the residual classifier will derive them
/// (zones + components + keep-outs as holes), so a room placed here consumes
/// floor that would otherwise be typed Unassigned — the repro plate carried
/// 166 m² of it while 38 briefed rooms were dropped. Candidates are scanned
/// inside each free rect (largest first, both orientations, the band pass's
/// 70% clamp) through the same `room_slot_ok` every other pass uses, so the
/// wall-or-passage invariant and circulation intrusion rules hold unchanged.
/// Returns whether the room was placed.
#[allow(clippy::too_many_arguments)]
pub(crate) fn place_in_residual(
    doc: &mut Document,
    job: &RoomJob,
    poly: &[Point],
    holes: &[geometry::Rect],
    iwalls: &[(Point, Point, f64)],
    obstacles: &mut Vec<(f64, f64, f64, f64)>,
    keepout_len: usize,
    frozen_len: usize,
    circ_rects: &[geometry::Rect],
    clear: f64,
    // The workspace-trim VOIDS — floor cut away from field zones because no
    // desk uses it. Scanned FIRST: it is interior, corridor-adjacent ground,
    // exactly where a homeless room belongs.
    extra: &[geometry::Rect],
) -> bool {
    // Free floor right now: every zone bbox + component AABB + keep-out is a
    // hole. Re-derived per call — rooms placed by earlier calls are zones
    // already, so the ground never goes stale.
    let mut used: Vec<geometry::Rect> = holes.to_vec();
    for z in &doc.zones {
        let (x0, y0, x1, y1) = z.shape.bbox();
        used.push(geometry::Rect { x0, y0, x1, y1 });
    }
    for c in &doc.components {
        let (ww, wh) = world_extents(c.w, c.h, c.rotation);
        used.push(geometry::Rect {
            x0: c.x - ww / 2.0,
            y0: c.y - wh / 2.0,
            x1: c.x + ww / 2.0,
            y1: c.y + wh / 2.0,
        });
    }
    let rooms = room_rects(doc);
    let mut free: Vec<geometry::Rect> = extra.to_vec();
    free.extend(geometry::decompose_plate(poly, 0.5, 1.0, 2.0, &used));
    let mut best: Option<(f64, f64, f64, f64, f64)> = None;
    'rects: for r in &free {
        for (w, d) in [(job.w, job.d), (job.d, job.w)] {
            let ww = snap_room_floor(w.min(r.width()));
            let hh = snap_room_floor(d.min(r.height()));
            if ww < 0.7 * w - 1e-9 || hh < 0.7 * d - 1e-9 || ww < 0.5 || hh < 0.5 {
                continue;
            }
            let x_lo = r.x0 + ww / 2.0;
            let x_hi = r.x1 - ww / 2.0;
            let y_lo = r.y0 + hh / 2.0;
            let y_hi = r.y1 - hh / 2.0;
            let nx = ((x_hi - x_lo) / POCKET_STEP).floor().max(0.0) as i64;
            let ny = ((y_hi - y_lo) / POCKET_STEP).floor().max(0.0) as i64;
            // Scan grid + the same FLUSH-SNAP candidates the pocket pass uses,
            // so consecutive residual rooms pack shoulder-to-shoulder instead
            // of stranding 1.5 m slivers between themselves.
            let mut cands: Vec<(f64, f64)> = Vec::new();
            for iy in 0..=ny {
                for ix in 0..=nx {
                    cands.push((
                        snap_module(x_lo + ix as f64 * POCKET_STEP),
                        snap_module(y_lo + iy as f64 * POCKET_STEP),
                    ));
                }
            }
            for rr in &rooms {
                let xs = [rr.x0 - ROOM_GAP - ww / 2.0, rr.x1 + ROOM_GAP + ww / 2.0];
                let ys = [rr.y0 - ROOM_GAP - hh / 2.0, rr.y1 + ROOM_GAP + hh / 2.0];
                let x_aligns = [rr.x0 + ww / 2.0, rr.x1 - ww / 2.0, (rr.x0 + rr.x1) / 2.0];
                let y_aligns = [rr.y0 + hh / 2.0, rr.y1 - hh / 2.0, (rr.y0 + rr.y1) / 2.0];
                for &cx in &xs {
                    for &cy in &y_aligns {
                        cands.push((snap_module(cx), snap_module(cy)));
                    }
                }
                for &cy in &ys {
                    for &cx in &x_aligns {
                        cands.push((snap_module(cx), snap_module(cy)));
                    }
                }
            }
            for (cx, cy) in cands {
                if cx - ww / 2.0 < r.x0 - 1e-9
                    || cx + ww / 2.0 > r.x1 + 1e-9
                    || cy - hh / 2.0 < r.y0 - 1e-9
                    || cy + hh / 2.0 > r.y1 + 1e-9
                {
                    continue;
                }
                if !room_slot_ok(
                    Some(poly), iwalls, obstacles, keepout_len, frozen_len, circ_rects,
                    &rooms, clear, cx, cy, ww, hh,
                ) {
                    continue;
                }
                let dist = circ_rects
                    .iter()
                    .map(|c| rect_gap(cx, cy, ww, hh, c))
                    .fold(f64::INFINITY, f64::min);
                if best.is_none_or(|b| dist < b.0) {
                    best = Some((dist, cx, cy, ww, hh));
                }
                if dist <= 0.3 {
                    break 'rects; // door onto a corridor — take it
                }
            }
        }
    }
    let Some((_, cx, cy, ww, hh)) = best else { return false };
    let side = door_side_toward_circ(cx, cy, ww, hh, circ_rects);
    emit_job(doc, job, cx, cy, ww, hh, side);
    obstacles.push((cx, cy, ww, hh));
    true
}

/// Which wall a free-standing room's door/front faces: toward the NEAREST drawn
/// circulation rect, on its dominant axis. Shared by the pocket fallback and the
/// anchor placement (both drop rooms off the band, so both need a door side).
pub(crate) fn door_side_toward_circ(cx: f64, cy: f64, ww: f64, hh: f64, circ_rects: &[geometry::Rect]) -> CorridorSide {
    circ_rects
        .iter()
        .min_by(|a, b| {
            rect_gap(cx, cy, ww, hh, a)
                .partial_cmp(&rect_gap(cx, cy, ww, hh, b))
                .unwrap_or(std::cmp::Ordering::Equal)
        })
        .map(|r| {
            let dx = (r.x0 + r.x1) / 2.0 - cx;
            let dy = (r.y0 + r.y1) / 2.0 - cy;
            if dx.abs() > dy.abs() {
                if dx > 0.0 { CorridorSide::Right } else { CorridorSide::Left }
            } else if dy > 0.0 {
                CorridorSide::Top
            } else {
                CorridorSide::Bottom
            }
        })
        .unwrap_or(CorridorSide::Top)
}

/// Place one ANCHORED room (workflow.md §3.5) at (near) its pinned point.
///
/// Scans candidate centers — the exact pin first, then a fixed `ANCHOR_STEP`
/// grid over the plate bbox, in BOTH orientations — and keeps the feasible slot
/// whose center is NEAREST the pin (`room_slot_ok` enforces plate containment,
/// wall clearance, keep-out/obstacle avoidance, and no circulation intrusion —
/// the SAME test the band/pocket passes use, so an anchor never overlaps them).
/// The room is emitted with its door toward the nearest corridor and registered
/// as an obstacle so later placement packs around it. Deterministic (no rng).
/// Returns whether it placed (false only when nothing fits anywhere — a shortfall
/// `program_fit` reports).
#[allow(clippy::too_many_arguments)]
pub(crate) fn place_anchor(
    doc: &mut Document,
    job: &RoomJob,
    tx: f64,
    ty: f64,
    bbox: (f64, f64, f64, f64),
    plate: Option<&[Point]>,
    iwalls: &[(Point, Point, f64)],
    obstacles: &mut Vec<(f64, f64, f64, f64)>,
    keepout_len: usize,
    frozen_len: usize,
    circ_rects: &[geometry::Rect],
    clear: f64,
) -> bool {
    /// Nearest-slot scan step (m): fine enough to snuggle a pin against real
    /// interior walls, coarse enough to stay cheap on a big plate.
    const ANCHOR_STEP: f64 = 0.3;
    let (min_x, min_y, max_x, max_y) = bbox;
    let rooms = room_rects(doc);
    // (dist², cx, cy, ww, hh) of the feasible candidate nearest the pin so far.
    let mut best: Option<(f64, f64, f64, f64, f64)> = None;
    let consider = |cx: f64, cy: f64, ww: f64, hh: f64, best: &mut Option<(f64, f64, f64, f64, f64)>| {
        if room_slot_ok(
            plate, iwalls, obstacles, keepout_len, frozen_len, circ_rects, &rooms, clear, cx, cy, ww, hh,
        ) {
            let dist2 = (cx - tx).powi(2) + (cy - ty).powi(2);
            if best.is_none_or(|b| dist2 < b.0) {
                *best = Some((dist2, cx, cy, ww, hh));
            }
        }
    };
    for (w, d) in [(job.w, job.d), (job.d, job.w)] {
        let ww = snap_room_floor(w);
        let hh = snap_room_floor(d);
        if ww < 0.5 || hh < 0.5 {
            continue;
        }
        // The exact pin first (dist 0 wins outright when it fits).
        consider(snap_module(tx), snap_module(ty), ww, hh, &mut best);
        let nx = (((max_x - min_x) / ANCHOR_STEP).floor() as i64).max(0);
        let ny = (((max_y - min_y) / ANCHOR_STEP).floor() as i64).max(0);
        for iy in 0..=ny {
            for ix in 0..=nx {
                let cx = snap_module(min_x + ix as f64 * ANCHOR_STEP);
                let cy = snap_module(min_y + iy as f64 * ANCHOR_STEP);
                consider(cx, cy, ww, hh, &mut best);
            }
        }
    }
    let Some((_, cx, cy, ww, hh)) = best else { return false };
    let side = door_side_toward_circ(cx, cy, ww, hh, circ_rects);
    emit_job(doc, job, cx, cy, ww, hh, side);
    obstacles.push((cx, cy, ww, hh));
    true
}
