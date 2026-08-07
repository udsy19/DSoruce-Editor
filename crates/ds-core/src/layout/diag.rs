//! **What the generator did, and why** — the instrument F1 asks for.
//!
//! The captures show the sample plate's left third and bottom carrying no
//! programme at all. Five plausible mechanisms were listed for that, and every
//! one of them is a hypothesis until something measures it. This is the
//! something: `generate` records its own internal decisions — the decomposed
//! regions, the coverage fraction that chooses the packer, each region's band
//! and field and corridor rects, the desk allocation and what was actually
//! placed against it, and the leftover fill's budget arithmetic — and hands them
//! across the wasm boundary so a debug layer can draw them over the plan.
//!
//! **This is not a gate and must never become one.** It is the generator's own
//! account of itself, which `.claude/rules/gate-independence.md` forbids a check
//! from consuming. Its job is to point at the mechanism; the coverage gate that
//! follows re-derives its ground truth from the emitted document.

use crate::geometry::Rect;
use serde::Serialize;

/// A rectangle on the wire: corner-origin, world meters, with a role.
#[derive(Clone, Debug, Serialize)]
pub struct DiagRect {
    pub x0: f64,
    pub y0: f64,
    pub x1: f64,
    pub y1: f64,
    /// `region` · `field` · `band` · `spine` · `connector` · `link` · `seam`
    pub role: &'static str,
    /// Region index this belongs to, or `null` for plate-level artifacts.
    pub region: Option<usize>,
}

impl DiagRect {
    pub(crate) fn of(r: Rect, role: &'static str, region: Option<usize>) -> Self {
        DiagRect { x0: r.x0, y0: r.y0, x1: r.x1, y1: r.y1, role, region }
    }
}

/// Per-region desk accounting: what the allocator asked for against what the
/// packer managed. A region whose `allocated` is healthy and whose `placed` is
/// zero is a placement failure; a region that was never allocated anything is an
/// allocation failure. The two look identical on the canvas and need different
/// fixes, which is the whole reason this is recorded separately.
#[derive(Clone, Debug, Serialize, Default)]
pub struct RegionDesks {
    /// Free slots `allocate_desks` measured in this region's field, BEFORE any
    /// desk was placed anywhere. `allocated` is clamped to it.
    pub capacity: u32,
    /// Free slots the PACKER's own `FieldGrid` saw when it ran — the same
    /// enumeration against the obstacle set as it stood at that moment, which on
    /// region `i > 0` also contains the desks regions `0..i` just placed. It can
    /// therefore fall below `capacity`, and the gap is the one divergence the
    /// single obstacle model does NOT close by construction: allocation is a
    /// simultaneous split, placement is sequential. Recorded so the battery can
    /// tell an over-allocation from a packer failure instead of inferring it.
    pub pack_capacity: u32,
    pub allocated: u32,
    pub placed: u32,
    /// Extra desks the top-up pass reclaimed here.
    pub topped_up: u32,
    /// Why the packer turned slots down here.
    pub rejects: DeskRejects,
    /// Grid the packer actually walked: `outer_n × inner_n` candidate lines.
    /// `0` on either axis means the field could not host a single desk row, and
    /// that is a BAND-DEPTH finding, not a packing one.
    pub grid_outer: i64,
    pub grid_inner: i64,
    /// Cross-axis depth of the region's field (m) — what the room band left.
    pub field_depth: f64,
    /// Declared a ROOM WING: too shallow for a viable desk field after banding,
    /// so its whole depth goes to rooms and it is never allocated desks.
    pub room_wing: bool,
}

/// Slot rejections, by cause. Four counters instead of one, because "the packer
/// placed 0" has four different fixes and they are in different files: a bounds
/// rejection is the band eating the field, a plate rejection is the facade gap
/// against an angled boundary, a wall rejection is imported linework, and an
/// obstacle rejection is a room or an already-placed desk.
#[derive(Clone, Debug, Serialize, Default)]
pub struct DeskRejects {
    /// Snapped footprint fell outside the field rect.
    pub bounds: u32,
    /// Outside the plate polygon, or inside its facade gap.
    pub plate: u32,
    /// Straddles an imported/committed interior wall.
    pub walls: u32,
    /// Overlaps a room, keep-out, corridor strip or an existing desk.
    pub obstacles: u32,
}

/// Everything one `generate` call decided.
#[derive(Clone, Debug, Serialize, Default)]
pub struct LayoutDiag {
    pub plate_area: f64,
    pub bbox_area: f64,
    pub is_rectangular: bool,
    /// Plate area (m²) the AXIS-ALIGNED decomposition actually covers.
    pub axis_cover: f64,
    /// `axis_cover / plate_area` — the number `ORIENTED_COVER_FRAC` gates on.
    pub axis_cover_frac: f64,
    pub use_oriented_field: bool,
    pub single_region: bool,
    pub rects: Vec<DiagRect>,
    /// Plate area (m²) no region claims — the maximal-rectangle tiling's
    /// leftovers along a notched or angled boundary. Enumerated as `residue`
    /// rects so it can be looked at rather than inferred from a subtraction.
    pub residue_area: f64,
    pub region_desks: Vec<RegionDesks>,
    /// `desk_target(program, plate_area)` minus frozen — what the plan aimed at.
    pub desk_target: u32,

    // --- the whole-plate leftover fill ---------------------------------------
    /// `plate_area / fill_density_floor(strategy)` — the seat ceiling the fill
    /// respects so the plan stays inside the professional 8–12 m²/person band.
    pub fill_seat_cap: f64,
    pub fill_meeting_seats: f64,
    pub fill_desks_before: f64,
    /// `seat_cap − meeting_seats − desks_now`, floored at 0. **Zero here means
    /// the fill never ran**, which is one of the five suspects for the dead
    /// wings and the only one that would leave the plan at target density while
    /// geometrically collapsed into a column.
    pub fill_budget: u32,
    pub fill_placed: u32,

    /// Rooms that found no band slot and no interior pocket. A silent drop here
    /// is what `program_fit` reports as a shortfall; naming them makes the
    /// difference between "not requested" and "requested and impossible".
    pub rooms_unplaced: Vec<String>,
}
