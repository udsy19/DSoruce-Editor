//! Room jobs: the concrete list of rooms one `generate()` call tries to place —
//! derived support program, explicit `Program.rooms`, and pinned anchors.

use super::*;

// ---- Room jobs: the concrete rooms one generate() call tries to place ----

/// One room instance to place. `w` runs along the corridor front, `d` is the
/// depth away from it (a portrait band transposes both into world axes).
#[derive(Clone, Debug)]
pub(crate) struct RoomJob {
    pub(crate) kind: SpaceKind,
    /// Zone label, unique per instance ("Meeting Room 2", "Phone Booth 3") —
    /// `score()` counts delivered rooms by these exact labels.
    pub(crate) label: String,
    pub(crate) w: f64,
    pub(crate) d: f64,
    pub(crate) zone_type: ZoneType,
    pub(crate) glass_front: bool,
    pub(crate) door_w: f64,
    pub(crate) furniture: RoomFurniture,
    /// Briefed occupancy from `RoomReq::seats` (0 = derive from the table).
    pub(crate) seats: u32,
    /// false → open setting (collab / print alcove): zone + furniture, no
    /// partitions and no door — spec §1.1 marks them open.
    pub(crate) walls: bool,
    /// Slide in from the band end FAR from the entry (pantry = social anchor
    /// at the far end of the spine; storage/IT/wellness/focus = quiet end;
    /// booths distributed away from reception).
    pub(crate) far: bool,
    /// Facade preference (explicit rooms only; derived rooms are `Flexible`).
    /// Biases region choice and within-band ordering — see `allocate_rooms`.
    pub(crate) placement: Placement,
}

/// Facade preference for a DERIVED support room. Focus rooms are pinned to the
/// facade via `Window` (item 4a: a HARD daylight/placement rule — Window biases
/// both the wing chosen and the within-band slot toward the plate boundary — on
/// top of the rear-alignment in `place_in_band` that seats them ON the facade
/// wall). Every other derived room stays placement-neutral (`Flexible`) so the
/// derive path is byte-identical apart from focus.
pub(crate) fn derived_placement(kind: SpaceKind) -> Placement {
    match kind {
        SpaceKind::Focus => Placement::Window,
        _ => Placement::Flexible,
    }
}

/// Expand the derived support program into placeable room jobs (spec §1.1).
///
/// Zone-type mapping (spec asks for a justified choice): cabins, phone booths
/// and focus rooms are cellular offices → `ClosedOffice`; pantry, reception,
/// print, IT/server, storage and wellness are tenant amenity/support program —
/// NOT building core, which stays reserved for landlord keep-outs (stairs,
/// lifts, shafts) so the Core stats keep meaning "non-lettable" → `Amenity`;
/// collab settings are open breakout → `Collaboration`. Meeting-typed kinds
/// (4P/6–8P/board) are covered by the user's `meeting_rooms` override and are
/// not duplicated here.
pub(crate) fn support_jobs(program: &Program, plate_area: f64) -> Vec<RoomJob> {
    if !program.support_spaces {
        return Vec::new();
    }
    let sp = SpaceProgram::derive(
        program_headcount(program, plate_area) as usize,
        plate_area,
        program_open_share(program),
        program_cellular_mult(program),
        program_support_cap(program),
    );
    let mut jobs = Vec::new();
    for req in &sp.reqs {
        // Meeting-typed kinds are covered by the `meeting_rooms` override in
        // the derive path and are not duplicated in the support program.
        if matches!(
            req.kind,
            SpaceKind::Meeting | SpaceKind::Meeting4P | SpaceKind::Meeting6P | SpaceKind::Boardroom
        ) {
            continue;
        }
        let t = job_template(req.kind, program);
        for i in 0..req.count {
            let label = if req.count == 1 {
                t.name.to_string()
            } else {
                format!("{} {}", t.name, i + 1)
            };
            // Derived rooms carry their derive() footprint. Focus rooms are pinned
            // to the facade (`Window`) — item 4a's HARD daylight rule; the rest stay
            // placement-neutral (`Flexible`), so the derive path is otherwise unchanged.
            jobs.push(t.to_job(req.kind, label, snap_module(req.w), snap_module(req.d), derived_placement(req.kind), 0));
        }
    }
    jobs
}

/// The per-kind room recipe: zone type, display name, glass/door/furniture
/// flags, whether it is a walled enclosure, which band end it prefers, and its
/// DEFAULT footprint (corridor-run `w` × depth `d`). Shared by the derived
/// program (`support_jobs`, which supplies its own derive() sizes) and the
/// explicit builder (`explicit_jobs`, which uses the default sizes unless the
/// `RoomReq` overrides them) so the two paths can never drift (no-bloat).
pub(crate) struct JobTemplate {
    pub(crate) zone_type: ZoneType,
    pub(crate) name: &'static str,
    pub(crate) glass_front: bool,
    pub(crate) door_w: f64,
    pub(crate) furniture: RoomFurniture,
    pub(crate) walls: bool,
    pub(crate) far: bool,
    pub(crate) w: f64,
    pub(crate) d: f64,
}

impl JobTemplate {
    pub(crate) fn to_job(&self, kind: SpaceKind, label: String, w: f64, d: f64, placement: Placement, seats: u32) -> RoomJob {
        RoomJob {
            kind,
            label,
            w,
            d,
            zone_type: self.zone_type,
            glass_front: self.glass_front,
            door_w: self.door_w,
            furniture: self.furniture,
            seats,
            walls: self.walls,
            far: self.far,
            placement,
        }
    }
}

/// Recipe + default footprint for one `SpaceKind`. Meeting-family kinds use the
/// user's `meeting_w`/`meeting_h`; everything else mirrors `SpaceProgram::derive`.
pub(crate) fn job_template(kind: SpaceKind, program: &Program) -> JobTemplate {
    use RoomFurniture::*;
    use SpaceKind::*;
    let (zone_type, name, glass_front, door_w, furniture, walls, far, w, d) = match kind {
        Meeting => (ZoneType::Meeting, "Meeting Room", true, DOOR_W, ConferenceTable, true, false, program.meeting_w, program.meeting_h),
        Meeting4P => (ZoneType::Meeting, "Team Room", true, DOOR_W, ConferenceTable, true, false, 2.7, 3.3),
        Meeting6P => (ZoneType::Meeting, "Team Room", true, DOOR_W, ConferenceTable, true, false, 3.6, 4.2),
        Boardroom => (ZoneType::Meeting, "Boardroom", true, DOOR_W, ConferenceTable, true, false, 4.5, 6.5),
        Cabin => (ZoneType::ClosedOffice, "Cabin", true, DOOR_W, WorkPoint, true, false, 3.0, 3.3),
        // Booths: solid fronts (spec §2), narrow leaf for the 1.3 m run.
        PhoneBooth => (ZoneType::ClosedOffice, "Phone Booth", false, 0.8, WorkPoint, true, true, 1.3, 1.1),
        Focus => (ZoneType::ClosedOffice, "Focus Room", true, DOOR_W, WorkPoint, true, true, 1.8, 2.4),
        Collab => (ZoneType::Collaboration, "Collab", false, 0.0, ConferenceTable, false, false, 4.8, 4.2),
        // Reception/pantry doors at 1.0 m (NBC exit-leaf rooms, spec §2).
        Reception => (ZoneType::Amenity, "Reception", true, 1.0, ReceptionDesk, true, false, 4.0, 3.2),
        Pantry => (ZoneType::Amenity, "Pantry", false, 1.0, Counter, true, true, 3.6, 3.0),
        Print => (ZoneType::Amenity, "Print Point", false, 0.0, ConferenceTable, false, false, 2.0, 1.5),
        ItServer => (ZoneType::Amenity, "IT / Server", false, DOOR_W, Empty, true, true, 3.0, 2.4),
        Storage => (ZoneType::Amenity, "Storage", false, DOOR_W, Empty, true, true, 3.0, 2.0),
        Wellness => (ZoneType::Amenity, "Wellness Room", false, DOOR_W, Empty, true, true, 3.0, 2.4),
    };
    JobTemplate { zone_type, name, glass_front, door_w, furniture, walls, far, w, d }
}

/// Expand `Program.rooms` (the Detailed builder) into placeable jobs. Sizes come
/// from each request (falling back to the kind default), placement bias rides
/// through to `allocate_rooms`. Ordered reception-first then largest-first so big
/// rooms claim band space while it is plentiful — the same priority the derived
/// path uses.
pub(crate) fn explicit_jobs(program: &Program) -> Vec<RoomJob> {
    let mut jobs = Vec::new();
    for req in &program.rooms {
        let t = job_template(req.kind, program);
        let w = snap_module(req.w.unwrap_or(t.w).max(0.5));
        let d = snap_module(req.d.unwrap_or(t.d).max(0.5));
        for i in 0..req.count {
            let label = if req.count == 1 {
                t.name.to_string()
            } else {
                format!("{} {}", t.name, i + 1)
            };
            jobs.push(t.to_job(req.kind, label, w, d, req.placement, req.seats));
        }
    }
    // Reception first (entry-adjacent), then largest footprint first.
    jobs.sort_by(|a, b| {
        let key = |j: &RoomJob| (j.kind != SpaceKind::Reception, -(j.w * j.d));
        key(a).partial_cmp(&key(b)).unwrap_or(std::cmp::Ordering::Equal)
    });
    jobs
}

/// One pinned `RoomJob` per anchor (workflow.md §3.5), carrying its target point.
/// Each uses the kind's DEFAULT footprint from `job_template` (an anchor picks a
/// kind, not a size) and a distinct `(pinned N)` label so `score()` counts it as
/// a delivered room. Placement-neutral (`Flexible`): the pin *is* the placement.
pub(crate) fn anchor_jobs(program: &Program, anchors: &[crate::document::Anchor]) -> Vec<(RoomJob, f64, f64)> {
    anchors
        .iter()
        .enumerate()
        .map(|(i, a)| {
            let t = job_template(a.kind, program);
            let job = t.to_job(
                a.kind,
                format!("{} (pinned {})", t.name, i + 1),
                snap_module(t.w.max(0.5)),
                snap_module(t.d.max(0.5)),
                Placement::Flexible,
                0, // anchor pin: kind only, no seat brief
            );
            (job, a.x, a.y)
        })
        .collect()
}
