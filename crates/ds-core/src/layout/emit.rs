//! Everything that writes geometry into the `Document`: the component/zone/wall
//! push primitives, and the enclosed-room shell (`emit_room`) with its
//! partitions, glazed front, door opening and interior furniture.

use super::*;

pub(crate) fn push_component(doc: &mut Document, category: &str, x: f64, y: f64, w: f64, h: f64, rotation: f64) {
    let id = doc.alloc_id();
    doc.components.push(Component {
        id,
        category: category.to_string(),
        x,
        y,
        w,
        h,
        rotation,
        mirror: false,
        reference: false, // generated fit-out counts toward every metric
        label: format!("{} {}", category, id),
        product_id: None,
            price_inr: None,
        decision: DecisionState::Open,
    });
}

/// Mirror of `push_component` for zones: mint a shared id and record a tiled
/// floor region. `component_ids` is filled later by `reassign_components`.
pub(crate) fn push_zone(doc: &mut Document, zone_type: ZoneType, shape: ZoneShape, label: &str) {
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

// ---- Enclosed-room emission (M1 of docs/design/testfit-pro-quality.md) ----

/// Generated-partition thickness (m): 100 mm double-boarded drywall — the
/// standard office fit-out partition.
pub(crate) const PARTITION_T: f64 = 0.1;
/// Glazed-front thickness (m): framed office glazing renders thinner than
/// drywall (spec §2 "Glass fronts").
pub(crate) const GLAZING_T: f64 = 0.05;
/// Door leaf width (m): standard office single leaf 900×2100.
pub(crate) const DOOR_W: f64 = 0.9;
/// Door slab depth (m): the component footprint across the wall.
pub(crate) const DOOR_D: f64 = 0.15;
/// Hinge-side jamb offset (m) from the perpendicular wall, so the leaf opens
/// flat against it (spec §2 door convention).
pub(crate) const DOOR_JAMB: f64 = 0.15;
/// Clear ring (m) kept between a room's table and its walls' inner faces.
/// ≥ the 0.9 m accessible route so the circulation evaluator's in-room
/// chokepoints never undercut the corridor target (0.95 leaves raster
/// headroom over the evaluator's 0.15 m cells).
pub(crate) const TABLE_CLEAR: f64 = 0.95;

/// Which side of a generated room faces the corridor its door opens onto —
/// the side that gets the glass front and the door opening. Landscape wings
/// stack rooms against the work rect's RIGHT edge (perimeter/seam corridor to
/// their right); portrait wings band rooms along its BOTTOM edge.
#[derive(Clone, Copy)]
pub(crate) enum CorridorSide {
    Right,
    Bottom,
    /// Mirrors of Right/Bottom for M2's `band_far` seed choice, which moves
    /// the meeting band to the opposite region end — the glass front + door
    /// must still face the corridor/desk-field side.
    Left,
    Top,
}

/// Interior furnishing of a generated room — all from EXISTING renderer
/// categories (Table/Chair), so the 2D glyphs and 3D builds need no additions.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum RoomFurniture {
    /// Full-size conference table with the TABLE_CLEAR egress ring (meetings).
    ConferenceTable,
    /// Work table against the rear wall + task chair facing the door
    /// (cabin / focus / phone booth — the booth degrades to chair + ledge).
    WorkPoint,
    /// Counter run along the rear wall (pantry).
    Counter,
    /// Centered desk-height table facing the door + chair behind (reception).
    ReceptionDesk,
    /// Unfurnished (IT/server, storage, wellness).
    Empty,
}

/// What `emit_room` builds around a placed room rect. M1 emitted meeting rooms
/// only; M3's cabins/booths/focus/pantry/reception/IT/storage/wellness reuse it
/// with per-type flags.
pub(crate) struct RoomSpec {
    pub(crate) zone_type: ZoneType,
    pub(crate) label: String,
    /// Corridor-facing wall is glazed (solid for booths/IT/storage — spec §2).
    pub(crate) glass_front: bool,
    /// Door leaf width (m); 1.0 for NBC-exit rooms (pantry).
    pub(crate) door_w: f64,
    pub(crate) furniture: RoomFurniture,
}

/// Append one generated wall segment (partition or glass front).
pub(crate) fn push_gen_wall(doc: &mut Document, ax: f64, ay: f64, bx: f64, by: f64, thickness: f64, glazing: bool) {
    if ((bx - ax).abs() + (by - ay).abs()) < 1e-6 {
        return; // zero-length stub (door gap touched the corner)
    }
    let id = doc.alloc_id();
    doc.walls.push(Wall {
        id,
        a: Point::new(ax, ay),
        b: Point::new(bx, by),
        thickness,
        generated: true,
        glazing,
    });
}

/// Emit one ENCLOSED room on the rect centered `(cx, cy)`, size `w`×`h`:
/// 0.1 m generated partitions on three sides, a glazed corridor-facing front
/// broken by a `door_w` opening (two collinear segments), a `Door` component
/// in the gap (rotated so the leaf swings INTO the room, hinge on the jamb
/// nearest the corner), a typed zone, and a full-size table with a ≥0.9 m
/// chair/egress ring.
///
/// Self-blocking is impossible by construction: wall centerlines are inset
/// half a thickness so the partitions' OUTER faces sit exactly on the room
/// rect — the same rect the caller pushes into `obstacles` with a full
/// clearance pad, which every later placement (rooms, desks, top-up passes)
/// already avoids. The packer's wall-obstacle list (`interior_walls`) is
/// snapshotted BEFORE any emission and generated walls are cleared at the top
/// of `generate()`, so a room's own shell can never reject its own interior
/// furniture, and later placements respect earlier rooms via the rect
/// obstacle (a strict superset of the walls + their clearance).
pub(crate) fn emit_room(doc: &mut Document, cx: f64, cy: f64, w: f64, h: f64, side: CorridorSide, spec: &RoomSpec) {
    let t2 = PARTITION_T / 2.0;
    // Wall centerline rectangle (inset so outer faces land on the room rect).
    let x0 = cx - w / 2.0 + t2;
    let x1 = cx + w / 2.0 - t2;
    let y0 = cy - h / 2.0 + t2;
    let y1 = cy + h / 2.0 - t2;

    // The corridor-facing run carries the door gap: hinge-side jamb DOOR_JAMB
    // from the far corner; fall back to a centered gap in short runs, and to a
    // solid front when even that can't fit (degenerate, sub-1.2 m rooms).
    let front_t = if spec.glass_front { GLAZING_T } else { PARTITION_T };
    let gap = |lo: f64, hi: f64| -> Option<(f64, f64)> {
        let run = hi - lo;
        if run < spec.door_w + 0.1 {
            return None;
        }
        let g_hi = if run >= spec.door_w + 2.0 * DOOR_JAMB {
            hi - DOOR_JAMB
        } else {
            (lo + hi) / 2.0 + spec.door_w / 2.0
        };
        Some((g_hi - spec.door_w, g_hi))
    };
    match side {
        CorridorSide::Right => {
            // Solid partitions: left, top, bottom.
            push_gen_wall(doc, x0, y0, x0, y1, PARTITION_T, false);
            push_gen_wall(doc, x0, y1, x1, y1, PARTITION_T, false);
            push_gen_wall(doc, x0, y0, x1, y0, PARTITION_T, false);
            // Corridor-facing front at x1 (vertical run), gap near the TOP corner.
            match gap(y0, y1) {
                Some((g_lo, g_hi)) => {
                    push_gen_wall(doc, x1, y0, x1, g_lo, front_t, spec.glass_front);
                    push_gen_wall(doc, x1, g_hi, x1, y1, front_t, spec.glass_front);
                    // rotation −π/2 puts the hinge on the g_hi jamb (nearest the
                    // corner) and swings the leaf into the room (−x).
                    push_component(
                        doc, "Door", x1, (g_lo + g_hi) / 2.0, spec.door_w, DOOR_D,
                        -std::f64::consts::FRAC_PI_2,
                    );
                }
                None => push_gen_wall(doc, x1, y0, x1, y1, front_t, spec.glass_front),
            }
        }
        CorridorSide::Bottom => {
            // Solid partitions: left, right, top.
            push_gen_wall(doc, x0, y0, x0, y1, PARTITION_T, false);
            push_gen_wall(doc, x1, y0, x1, y1, PARTITION_T, false);
            push_gen_wall(doc, x0, y1, x1, y1, PARTITION_T, false);
            // Corridor-facing front at y0 (horizontal run), gap near the RIGHT corner.
            match gap(x0, x1) {
                Some((g_lo, g_hi)) => {
                    push_gen_wall(doc, x0, y0, g_lo, y0, front_t, spec.glass_front);
                    push_gen_wall(doc, g_hi, y0, x1, y0, front_t, spec.glass_front);
                    // rotation π: hinge on the g_hi jamb, leaf swings into the room (+y).
                    push_component(
                        doc, "Door", (g_lo + g_hi) / 2.0, y0, spec.door_w, DOOR_D,
                        std::f64::consts::PI,
                    );
                }
                None => push_gen_wall(doc, x0, y0, x1, y0, front_t, spec.glass_front),
            }
        }
        CorridorSide::Left => {
            // Mirror of Right: solid right, top, bottom; front at x0.
            push_gen_wall(doc, x1, y0, x1, y1, PARTITION_T, false);
            push_gen_wall(doc, x0, y1, x1, y1, PARTITION_T, false);
            push_gen_wall(doc, x0, y0, x1, y0, PARTITION_T, false);
            match gap(y0, y1) {
                Some((g_lo, g_hi)) => {
                    push_gen_wall(doc, x0, y0, x0, g_lo, front_t, spec.glass_front);
                    push_gen_wall(doc, x0, g_hi, x0, y1, front_t, spec.glass_front);
                    // rotation +π/2: hinge on the g_hi jamb, leaf swings into the room (+x).
                    push_component(
                        doc, "Door", x0, (g_lo + g_hi) / 2.0, spec.door_w, DOOR_D,
                        std::f64::consts::FRAC_PI_2,
                    );
                }
                None => push_gen_wall(doc, x0, y0, x0, y1, front_t, spec.glass_front),
            }
        }
        CorridorSide::Top => {
            // Mirror of Bottom: solid left, right, bottom; front at y1.
            push_gen_wall(doc, x0, y0, x0, y1, PARTITION_T, false);
            push_gen_wall(doc, x1, y0, x1, y1, PARTITION_T, false);
            push_gen_wall(doc, x0, y0, x1, y0, PARTITION_T, false);
            match gap(x0, x1) {
                Some((g_lo, g_hi)) => {
                    push_gen_wall(doc, x0, y1, g_lo, y1, front_t, spec.glass_front);
                    push_gen_wall(doc, g_hi, y1, x1, y1, front_t, spec.glass_front);
                    // rotation 0: hinge on the g_hi jamb, leaf swings into the room (−y).
                    push_component(
                        doc, "Door", (g_lo + g_hi) / 2.0, y1, spec.door_w, DOOR_D, 0.0,
                    );
                }
                None => push_gen_wall(doc, x0, y1, x1, y1, front_t, spec.glass_front),
            }
        }
    }

    // The room's zone (pastel fill + stats bucket) spans the FULL room rect.
    push_zone(
        doc,
        spec.zone_type,
        ZoneShape::Rect { x: cx, y: cy, w, h },
        &spec.label,
    );

    furnish_room(doc, cx, cy, w, h, side, spec.furniture);
}

/// Place a room's interior furniture (existing Table/Chair categories only).
/// `side` is the door/front side; furniture faces it, rear pieces back onto
/// the opposite wall. Everything snaps to the module.
pub(crate) fn furnish_room(doc: &mut Document, cx: f64, cy: f64, w: f64, h: f64, side: CorridorSide, furniture: RoomFurniture) {
    // Outward front normal, and the rotation mapping local +y (the side a
    // seated user faces) onto it: R(θ)·(0,1) = (−sinθ, cosθ) = f.
    let (fx, fy) = match side {
        CorridorSide::Right => (1.0, 0.0),
        CorridorSide::Left => (-1.0, 0.0),
        CorridorSide::Top => (0.0, 1.0),
        CorridorSide::Bottom => (0.0, -1.0),
    };
    let rot = f64::atan2(-fx, fy);
    // Room extent along the front normal (depth) and across it (front run).
    let (depth, run) = if fx != 0.0 { (w, h) } else { (h, w) };
    let inner_run = run - 2.0 * PARTITION_T - 0.2;
    let inner_depth = depth - 2.0 * PARTITION_T - 0.2;
    // A point `t` meters behind the room center along the inward normal.
    let at = |t: f64| (snap_module(cx - fx * t), snap_module(cy - fy * t));

    match furniture {
        RoomFurniture::ConferenceTable => {
            // Full-size conference table (chairs live in its 2D glyph / 3D
            // build), centered with the TABLE_CLEAR ring to the inner faces.
            let tw = (w - 2.0 * PARTITION_T - 2.0 * TABLE_CLEAR).max(0.8).min(w - 2.0 * PARTITION_T - 0.2);
            let th = (h - 2.0 * PARTITION_T - 2.0 * TABLE_CLEAR).max(0.8).min(h - 2.0 * PARTITION_T - 0.2);
            if tw > 0.3 && th > 0.3 {
                push_component(doc, "Table", cx, cy, tw, th, 0.0);
            }
        }
        RoomFurniture::WorkPoint => {
            if inner_depth >= 1.5 {
                // Work table backed onto the rear wall, chair in front of it.
                let tw = snap_module(inner_run.min(1.2).max(0.4));
                let td = 0.6;
                let (tx, ty) = at(depth / 2.0 - PARTITION_T - 0.1 - td / 2.0);
                push_component(doc, "Table", tx, ty, tw, td, rot);
                let (chx, chy) = at(depth / 2.0 - PARTITION_T - 0.1 - td - 0.35);
                // The chair faces the table (rearward), back to the door.
                push_component(doc, "Chair", chx, chy, 0.5, 0.5, rot + std::f64::consts::PI);
            } else if inner_run > 0.5 && inner_depth > 0.5 {
                // Phone-booth scale: seat + a shallow ledge when it fits.
                if inner_depth >= 0.85 {
                    let (tx, ty) = at(depth / 2.0 - PARTITION_T - 0.05 - 0.15);
                    push_component(doc, "Table", tx, ty, inner_run.min(0.6), 0.3, rot);
                }
                let (chx, chy) = at(-(depth / 2.0 - PARTITION_T - 0.05 - 0.3));
                // Seat faces the ledge (rearward).
                push_component(doc, "Chair", chx, chy, 0.5, 0.5, rot + std::f64::consts::PI);
            }
        }
        RoomFurniture::Counter => {
            if inner_run > 1.0 && inner_depth > 1.2 {
                let tw = snap_module(inner_run - 0.6);
                let td = 0.55;
                let (tx, ty) = at(depth / 2.0 - PARTITION_T - 0.05 - td / 2.0);
                push_component(doc, "Table", tx, ty, tw, td, rot);
            }
        }
        RoomFurniture::ReceptionDesk => {
            if inner_run > 2.0 && inner_depth > 2.0 {
                let (tx, ty) = at(0.0);
                push_component(doc, "Table", tx, ty, 1.8_f64.min(inner_run - 0.6), 0.7, rot);
                let (chx, chy) = at(0.75);
                push_component(doc, "Chair", chx, chy, 0.5, 0.5, rot);
            }
        }
        RoomFurniture::Empty => {}
    }
}
