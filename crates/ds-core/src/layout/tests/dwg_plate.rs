//! The USER'S REAL IMPORTED PLATE — the ground-truth fixture for zone geometry.
//!
//! Captured from the dev plan library entry "Northwind India GCC · L14"
//! (`web/.dev-plans/a874827e-…json`, 103 workstations), i.e. from
//! `samples/furniture-plan.dwg` after plate extraction: the 107 non-generated
//! walls, the three building-core keep-outs and the entry point the importer
//! produced, plus the exact Program the wizard sent to `generate()`.
//!
//! Why a captured fixture and not the synthetic `REAL_PLATE` corner loop: the
//! defects this module measures — an open-workspace zone that is one giant
//! rectangle, and floor inside the building that belongs to no zone — are
//! properties of THIS plate's wall set (its interior partitions, its stepped
//! facade and its west lobe), and `REAL_PLATE` is a 43-corner idealisation that
//! has none of them. Ground truth is the artifact the user actually sees.

use super::*;

/// `(ax, ay, bx, by, glazing)` — every non-generated wall of the imported plate.
pub(super) const DWG_WALLS: [(f64, f64, f64, f64, bool); 107] = [
    (7.75, 1.0, 8.35, 1.0, false),
    (20.5, 1.0, 21.09087, 1.104271, false),
    (24.75, 1.75, 26.0, 2.0, false),
    (26.0, 2.0, 26.25, 2.5, false),
    (26.25, 2.5, 27.5, 2.5, false),
    (27.5, 2.5, 27.75, 3.0, false),
    (27.75, 3.0, 28.339723, 3.110573, false),
    (31.75, 3.75, 32.24923, 4.08282, false),
    (33.25, 4.75, 34.5, 4.75, false),
    (34.5, 4.75, 34.75, 5.5, false),
    (34.75, 5.5, 35.335712, 5.630158, false),
    (37.0, 6.0, 37.25, 6.75, false),
    (37.25, 6.75, 38.5, 6.75, false),
    (38.5, 6.75, 38.51463, 7.349822, false),
    (38.75, 17.0, 38.15, 17.0, false),
    (27.25, 17.0, 27.25, 17.6, false),
    (27.25, 38.25, 27.848233, 38.296018, false),
    (30.5, 38.5, 30.75, 39.75, false),
    (30.75, 39.75, 30.167222, 39.892721, false),
    (18.5, 42.75, 17.902256, 42.801978, false),
    (12.75, 43.25, 12.150136, 43.237237, false),
    (1.0, 43.0, 2.0, 42.5, false),
    (2.0, 42.5, 2.0, 41.9, false),
    (2.0, 38.0, 3.0, 38.0, false),
    (3.0, 38.0, 3.031535, 38.599171, false),
    (3.25, 42.75, 3.85, 42.75, false),
    (10.75, 42.75, 10.75, 42.15, false),
    (10.75, 10.5, 10.150333, 10.480011, false),
    (3.25, 10.25, 3.226019, 10.849521, false),
    (3.0, 16.5, 2.0, 16.5, false),
    (2.0, 16.5, 2.0, 15.9, false),
    (2.0, 10.5, 1.0, 10.25, false),
    (1.0, 10.25, 1.0, 9.65, false),
    (1.0, 1.5, 1.598361, 1.455677, false),
    (8.35, 1.0, 19.9, 1.0, true),
    (19.9, 1.0, 20.5, 1.0, false),
    (21.09087, 1.104271, 24.15913, 1.645729, true),
    (24.15913, 1.645729, 24.75, 1.75, false),
    (28.339723, 3.110573, 31.160277, 3.639427, true),
    (31.160277, 3.639427, 31.75, 3.75, false),
    (32.24923, 4.08282, 32.75077, 4.41718, true),
    (32.75077, 4.41718, 33.25, 4.75, false),
    (35.335712, 5.630158, 36.414288, 5.869842, true),
    (36.414288, 5.869842, 37.0, 6.0, false),
    (38.51463, 7.349822, 38.73537, 16.400178, true),
    (38.73537, 16.400178, 38.75, 17.0, false),
    (38.15, 17.0, 27.85, 17.0, true),
    (27.85, 17.0, 27.25, 17.0, false),
    (27.25, 17.6, 27.25, 37.65, true),
    (27.25, 37.65, 27.25, 38.25, false),
    (27.848233, 38.296018, 29.901767, 38.453982, true),
    (29.901767, 38.453982, 30.5, 38.5, false),
    (30.167222, 39.892721, 19.082778, 42.607279, true),
    (19.082778, 42.607279, 18.5, 42.75, false),
    (17.902256, 42.801978, 13.347744, 43.198022, true),
    (13.347744, 43.198022, 12.75, 43.25, false),
    (12.150136, 43.237237, 1.599864, 43.012763, true),
    (1.599864, 43.012763, 1.0, 43.0, false),
    (2.0, 41.9, 2.0, 38.6, true),
    (2.0, 38.6, 2.0, 38.0, false),
    (3.031535, 38.599171, 3.218465, 42.150829, true),
    (3.218465, 42.150829, 3.25, 42.75, false),
    (3.85, 42.75, 10.15, 42.75, true),
    (10.15, 42.75, 10.75, 42.75, false),
    (10.75, 42.15, 10.75, 11.1, true),
    (10.75, 11.1, 10.75, 10.5, false),
    (10.150333, 10.480011, 3.849667, 10.269989, true),
    (3.849667, 10.269989, 3.25, 10.25, false),
    (3.226019, 10.849521, 3.023981, 15.900479, true),
    (3.023981, 15.900479, 3.0, 16.5, false),
    (2.0, 15.9, 2.0, 11.1, true),
    (2.0, 11.1, 2.0, 10.5, false),
    (1.0, 9.65, 1.0, 2.1, true),
    (1.0, 2.1, 1.0, 1.5, false),
    (1.598361, 1.455677, 7.151639, 1.044323, true),
    (7.151639, 1.044323, 7.75, 1.0, false),
    (18.858965, 0.917248, 18.920753, 0.927344, false),
    (12.17179, 43.19432, 6.516987, 43.292072, false),
    (6.516987, 43.292072, 0.875, 42.899215, false),
    (12.169429, 43.170419, 6.5158, 43.268033, false),
    (6.5158, 43.268033, 0.875, 42.875062, false),
    (18.858965, 0.917248, 18.858965, 0.937554, false),
    (3.118965, 26.696075, 3.118965, 27.696075, false),
    (3.118965, 27.696075, 2.118965, 27.696075, false),
    (2.118965, 27.696075, 2.118965, 26.696075, false),
    (2.118965, 26.696075, 3.118965, 26.696075, false),
    (3.118965, 37.896075, 3.118965, 38.896075, false),
    (2.118965, 37.896075, 3.118965, 37.896075, false),
    (3.118965, 15.496075, 3.118965, 16.496075, false),
    (0.875187, 1.647507, 0.918965, 1.642491, false),
    (0.918965, 1.642491, 0.918965, 3.496075, false),
    (0.918965, 3.496075, 0.875187, 3.496075, false),
    (0.875187, 9.096075, 0.918965, 9.096075, false),
    (0.918965, 9.096075, 0.918965, 10.346075, false),
    (0.918965, 10.346075, 0.875187, 10.346075, false),
    (7.468965, 10.346075, 4.618965, 10.346075, false),
    (4.618965, 10.346075, 4.618965, 10.336325, false),
    (0.918965, 8.896075, 0.918965, 7.796075, false),
    (0.875166, 1.647456, 1.109519, 1.621238, false),
    (0.875187, 7.796075, 0.918965, 7.796075, false),
    (0.918965, 7.796075, 0.918965, 1.642491, false),
    (0.918965, 9.296075, 0.918965, 8.896075, false),
    (0.918965, 8.896075, 0.875187, 8.896075, false),
    (0.918965, 9.546075, 0.918965, 10.146075, false),
    (4.418965, 10.346075, 4.618965, 10.346075, false),
    (10.734537, 42.707491, 10.734537, 12.551021, false),
    (10.734537, 12.551021, 10.734537, 12.322421, false),
];

/// `(cx, cy, w, h, label)` — the building-core keep-outs the importer found.
pub(super) const DWG_KEEPOUTS: [(f64, f64, f64, f64, &str); 3] = [
    (22.510221, 38.151204, 7.020442, 5.802408, "Core 1"),
    (6.125, 2.875, 2.25, 2.75, "Core 2"),
    (12.875, 3.0, 2.25, 2.5, "Core 3"),
];

/// The entry point the importer placed.
pub(super) const DWG_ENTRY: (f64, f64) = (3.868965, 9.696686);

/// The imported plate as a `Document`, ready for `generate()`.
pub(super) fn dwg_plate_doc() -> Document {
    let mut doc = Document::new();
    for &(ax, ay, bx, by, glazing) in DWG_WALLS.iter() {
        let id = doc.alloc_id();
        doc.walls.push(Wall {
            id,
            a: Point::new(ax, ay),
            b: Point::new(bx, by),
            thickness: 0.15,
            generated: false,
            glazing,
            height_m: None,
        });
    }
    for &(x, y, w, h, label) in DWG_KEEPOUTS.iter() {
        let id = doc.alloc_id();
        doc.keepouts.push(crate::model::KeepOut { id, x, y, w, h, label: label.to_string() });
    }
    doc.entries.push(Point::new(DWG_ENTRY.0, DWG_ENTRY.1));
    doc
}

/// The exact `Program` the wizard sent for the captured plan.
pub(super) fn dwg_plate_program() -> Program {
    Program {
        desks: 0,
        meeting_rooms: 0,
        desk_w: 1.4,
        desk_h: 0.7,
        meeting_w: 3.0,
        meeting_h: 3.0,
        cluster_cols: 4,
        target_corridor_m: 1.2,
        desk_clearance_m: 0.9,
        bench_pairs: true,
        support_spaces: false,
        headcount: Some(93),
        rooms: vec![
        RoomReq { kind: SpaceKind::Cabin, count: 1, w: Some(4.5), d: Some(4.0), placement: Placement::Window, seats: 1 },
        RoomReq { kind: SpaceKind::Cabin, count: 3, w: Some(3.6), d: Some(3.6), placement: Placement::Window, seats: 1 },
        RoomReq { kind: SpaceKind::Cabin, count: 10, w: Some(3.0), d: Some(3.3), placement: Placement::Window, seats: 1 },
        RoomReq { kind: SpaceKind::Cabin, count: 9, w: Some(2.7), d: Some(3.0), placement: Placement::Window, seats: 1 },
        RoomReq { kind: SpaceKind::Focus, count: 4, w: Some(1.8), d: Some(2.4), placement: Placement::Window, seats: 1 },
        RoomReq { kind: SpaceKind::Meeting4P, count: 4, w: Some(2.7), d: Some(3.3), placement: Placement::Flexible, seats: 4 },
        RoomReq { kind: SpaceKind::Meeting6P, count: 3, w: Some(3.6), d: Some(4.2), placement: Placement::Flexible, seats: 6 },
        RoomReq { kind: SpaceKind::Boardroom, count: 1, w: Some(4.5), d: Some(6.5), placement: Placement::Core, seats: 14 },
        RoomReq { kind: SpaceKind::Meeting6P, count: 1, w: Some(3.6), d: Some(4.8), placement: Placement::Core, seats: 10 },
        RoomReq { kind: SpaceKind::Meeting, count: 2, w: Some(3.0), d: Some(3.6), placement: Placement::Core, seats: 6 },
        RoomReq { kind: SpaceKind::Collab, count: 4, w: Some(2.4), d: Some(2.4), placement: Placement::Flexible, seats: 4 },
        RoomReq { kind: SpaceKind::PhoneBooth, count: 8, w: Some(1.3), d: Some(1.1), placement: Placement::Flexible, seats: 1 },
        RoomReq { kind: SpaceKind::Reception, count: 1, w: Some(4.0), d: Some(3.2), placement: Placement::Flexible, seats: 0 },
        RoomReq { kind: SpaceKind::Pantry, count: 1, w: Some(3.6), d: Some(3.0), placement: Placement::Flexible, seats: 0 },
        RoomReq { kind: SpaceKind::Wellness, count: 1, w: Some(3.0), d: Some(2.4), placement: Placement::Flexible, seats: 0 },
        RoomReq { kind: SpaceKind::Print, count: 2, w: Some(2.0), d: Some(1.5), placement: Placement::Flexible, seats: 0 },
        RoomReq { kind: SpaceKind::Storage, count: 1, w: Some(3.0), d: Some(2.0), placement: Placement::Flexible, seats: 0 },
        ],
        ..Program::default()
    }
}
