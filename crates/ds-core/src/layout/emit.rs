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
        // Resolved HERE, from world size, so the renderer reads it instead of
        // guessing a chair count from the zoom level (ui-system.md §3.6).
        seats: crate::model::seats_for(category, w, h),
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
pub const DOOR_W: f64 = 0.9;
/// Door slab depth (m): the component footprint across the wall.
pub const DOOR_D: f64 = 0.15;
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
    /// Briefed occupancy from `RoomReq::seats` (0 = derive from the table).
    pub(crate) seats: u32,
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
        // Generated partitions are always full storey height — the generator has
        // no partial-height primitive (see `quantity::WallType::HalfDrywall`).
        height_m: None,
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

    furnish_room(doc, cx, cy, w, h, side, spec.furniture, spec.seats);
}

/// Place a room's interior furniture (existing Table/Chair categories only).
/// `side` is the door/front side; furniture faces it, rear pieces back onto
/// the opposite wall. Everything snaps to the module.
pub(crate) fn furnish_room(doc: &mut Document, cx: f64, cy: f64, w: f64, h: f64, side: CorridorSide, furniture: RoomFurniture, briefed_seats: u32) {
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
                // THE BRIEF WINS. The table is sized to the ROOM, so its
                // perimeter can seat more than the room was asked for — a
                // "6 person" team room fitted a table seating 8, and that 8 then
                // flowed to the plan tag, the report's meeting seats and the
                // density. Clamp the object's occupancy to what was briefed
                // (never above what physically fits) so the drawing, the tag and
                // the brief are the same number.
                if briefed_seats > 0 {
                    if let Some(t) = doc.components.last_mut() {
                        t.seats = t.seats.min(briefed_seats);
                    }
                }
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

pub(crate) const CHAIR_SIZE: f64 = 0.5;
pub(crate) const CHAIR_PROJECT: f64 = 0.35;
/// Walkable gap (m) preserved between two chair backs sharing an aisle.
pub(crate) const CHAIR_AISLE_KEEP: f64 = 0.2;
pub(crate) const CHAIR_PROJECT_MIN: f64 = 0.05;
pub(crate) const SEAT_PITCH: f64 = 0.75;

/// Seat task chairs around a conference / meeting / collaboration table.
///
/// `floor(long_side / SEAT_PITCH)` seats along **each** long side, plus **one**
/// head seat at each end — office practice takes a single person at a table end
/// however wide it is. Every chair faces the table and tucks
/// `CHAIR_SIZE − CHAIR_PROJECT` under its edge, projecting `CHAIR_PROJECT` into
/// the room: the identical tuck `seat_desk_chairs` gives a workstation, so all
/// seating in the document reads as one object at one size.
///
/// `clear` is the `(x0, y0, x1, y1)` rect the seats must stay inside — a walled
/// room's INNER wall faces, or an open setting's zone rect. A seat that does not
/// fit, or that would collide with a seat already placed at this table, is
/// **dropped rather than forced**, so a table clamped against architecture
/// simply carries fewer chairs and never one inside a wall.
///
/// These are REAL `Chair` components, which is the whole point: the 2D plan
/// glyphs draw no implied seating (`web/src/editor/furniture.ts`), so what the
/// plan and the room thumbnails draw is exactly what the Furniture Inventory
/// bills and what `quantity::headcount` counts for a room with no desks.
/// Like every other chair they are exempt from the circulation raster
/// (`circulation::is_loose_seating`).
pub(crate) fn seat_around_table(
    doc: &mut Document,
    tx: f64,
    ty: f64,
    tw: f64,
    th: f64,
    clear: (f64, f64, f64, f64),
) {
    use std::f64::consts::{FRAC_PI_2, PI};
    let half = CHAIR_SIZE / 2.0;
    // Chair centre offset BEYOND the table edge: the seat overlaps the worktop
    // and projects CHAIR_PROJECT past it.
    let off = (CHAIR_PROJECT - half).max(0.0);
    let (x0, y0, x1, y1) = clear;

    let long_x = tw >= th;
    let (run, span) = if long_x { (tw, th) } else { (th, tw) };
    let n = ((run / SEAT_PITCH).floor() as usize).max(1);

    // Long sides first (they are the real capacity), heads last, so a head seat
    // is the one dropped when a stubby table's corners would collide.
    let side_d = snap_module(span / 2.0 + off);
    let head_d = snap_module(run / 2.0 + off);
    let mut seats: Vec<(f64, f64, f64)> = Vec::with_capacity(2 * n + 2);
    for i in 0..n {
        let t = snap_module(((i as f64 + 0.5) / n as f64 - 0.5) * run);
        if long_x {
            // Chair faces the table: rot maps its local +y onto the facing
            // direction (`rot = atan2(-fx, fy)`), matching `furnish_room`.
            seats.push((tx + t, ty - side_d, 0.0));
            seats.push((tx + t, ty + side_d, PI));
        } else {
            seats.push((tx - side_d, ty + t, -FRAC_PI_2));
            seats.push((tx + side_d, ty + t, FRAC_PI_2));
        }
    }
    if long_x {
        seats.push((tx - head_d, ty, -FRAC_PI_2));
        seats.push((tx + head_d, ty, FRAC_PI_2));
    } else {
        seats.push((tx, ty - head_d, 0.0));
        seats.push((tx, ty + head_d, PI));
    }

    let mut placed: Vec<(f64, f64, f64, f64)> = Vec::with_capacity(seats.len());
    for (cx, cy, rot) in seats {
        let inside = cx - half >= x0 - 1e-6
            && cx + half <= x1 + 1e-6
            && cy - half >= y0 - 1e-6
            && cy + half <= y1 + 1e-6;
        if !inside || footprint_overlaps(&placed, cx, cy, CHAIR_SIZE, CHAIR_SIZE, -1e-6) {
            continue;
        }
        placed.push((cx, cy, CHAIR_SIZE, CHAIR_SIZE));
        push_component(doc, "Chair", cx, cy, CHAIR_SIZE, CHAIR_SIZE, rot);
    }
}

/// Seat ONE task chair at every generated `Desk` — the workstation's other half.
///
/// Runs as a POST-PASS over the finished layout rather than inside the packer:
/// desk placement stays byte-identical (desk counts, determinism and every
/// `LayoutScore` term are unaffected), and the seating rule lives in one place
/// regardless of which packer — axis-aligned `pack_desks` or `pack_desks_oriented`
/// — placed the desk.
///
/// **Which side.** A desk's user sits on its local **+y** side: the monitor is on
/// the −y back edge and `web/src/editor/furniture.ts::drawDesk` states "the user
/// sits toward +y". Bench pairs butt their two desks together with
/// `SPINE_GAP == 0`, so for a paired desk that side is solid desk and the seat
/// falls back to −y — the outer aisle, and the only place a person can physically
/// sit in a back-to-back run. Trying +y then −y therefore seats BOTH the paired
/// and the single-row regimes correctly without this pass knowing which one ran.
///
/// **Tuck.** The chair overlaps its own desk and projects `CHAIR_PROJECT` into the
/// aisle, capped so two chairs sharing one `clear` aisle keep `CHAIR_AISLE_KEEP`
/// of walkable floor between their backs. Candidates are rejected if they leave
/// the plate, foul an interior wall, or touch ANY component other than their own
/// desk, so a desk pinned against architecture keeps a fully-tucked seat and a
/// desk with no room at all gets none — never an overlapping one.
///
/// Chairs are deliberately NOT added to the packer's obstacle list and are NOT
/// blocking in the circulation raster (see `circulation::rasterize_components`):
/// a task chair is loose furniture that tucks away, not fixed construction, so it
/// cannot narrow a code-measured clear width.
pub(crate) fn seat_desk_chairs(
    doc: &mut Document,
    plate: Option<&[Point]>,
    iwalls: &[(Point, Point, f64)],
    clear: f64,
) {
    // Two chair backs share one aisle in a bench run, so each may claim at most
    // half of it less the walkable keep.
    let project = CHAIR_PROJECT
        .min(((clear - CHAIR_AISLE_KEEP) / 2.0).max(CHAIR_PROJECT_MIN))
        .max(CHAIR_PROJECT_MIN);
    let half_chair = CHAIR_SIZE / 2.0;

    // Every existing component as a world AABB, so a candidate seat can be tested
    // against all of them at once. Rebuilt per desk only in the sense that the
    // desk's own entry is skipped by index.
    let boxes: Vec<(f64, f64, f64, f64)> = doc
        .components
        .iter()
        .map(|c| {
            let (ww, wh) = world_extents(c.w, c.h, c.rotation);
            (c.x, c.y, ww, wh)
        })
        .collect();

    let desks: Vec<usize> = (0..doc.components.len())
        .filter(|&i| doc.components[i].category == "Desk" && !doc.components[i].reference)
        .collect();

    // Seats decided first, pushed after — `push_component` borrows `doc` mutably.
    let mut seats: Vec<(f64, f64, f64)> = Vec::new();
    // Chair AABBs already committed in this pass, so two seats can never collide.
    let mut placed: Vec<(f64, f64, f64, f64)> = Vec::new();

    for &di in &desks {
        let d = &doc.components[di];
        // R(θ)·(0,1) — the desk's local +y in world space (the user's side).
        let (s, c) = d.rotation.sin_cos();
        let (ux, uy) = (-s, c);
        let half_depth = d.h / 2.0;
        // An existing user-placed/frozen chair already at this desk: don't add a
        // second one (a Confirmed chair survives `keep_confirmed` regeneration).
        let already = doc.components.iter().enumerate().any(|(j, o)| {
            j != di
                && o.category == "Chair"
                && (o.x - d.x).abs() < d.w
                && (o.y - d.y).abs() < d.h + CHAIR_SIZE
        });
        if already {
            continue;
        }

        let mut seated = false;
        'sides: for side in [1.0f64, -1.0] {
            // Chair faces its desk: on the +y side it looks back along −y (rot+π);
            // on the −y side its own +y already points at the worktop (rot).
            let rot = if side > 0.0 {
                d.rotation + std::f64::consts::PI
            } else {
                d.rotation
            };
            for proj in [project, project * 0.5, CHAIR_PROJECT_MIN] {
                let dist = half_depth + proj - half_chair;
                let cx = snap_module(d.x + side * ux * dist);
                let cy = snap_module(d.y + side * uy * dist);
                let (cw, ch) = world_extents(CHAIR_SIZE, CHAIR_SIZE, rot);
                if !slot_fits_plate(plate, cx, cy, cw, ch, 0.0)
                    || !slot_clears_walls(iwalls, cx, cy, cw, ch)
                    || footprint_overlaps(&placed, cx, cy, cw, ch, -1e-6)
                {
                    continue;
                }
                // Free of every component except the desk it belongs to.
                let fouls = boxes
                    .iter()
                    .enumerate()
                    .any(|(j, &b)| j != di && footprint_overlaps(&[b], cx, cy, cw, ch, -1e-6));
                if fouls {
                    continue;
                }
                seats.push((cx, cy, rot));
                placed.push((cx, cy, cw, ch));
                seated = true;
                break 'sides;
            }
        }
        let _ = seated;
    }

    for (x, y, rot) in seats {
        push_component(doc, "Chair", x, y, CHAIR_SIZE, CHAIR_SIZE, rot);
    }
}

