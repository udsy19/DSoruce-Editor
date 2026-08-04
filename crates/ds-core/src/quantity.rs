//! **Quantity surface** — the geometric truth a Quantity Takeoff workbook reads.
//!
//! Every number here is *computed from the document geometry*, never typed. The
//! xlsx writer (`web/src/export/qtoWorkbook.ts`) consumes this through the
//! `Editor` wasm boundary and must not re-derive any of it; the deliverable-pack
//! gate `scripts/gates/g3-quantity-truth.py` cross-checks the workbook's cells
//! against `out/ground-truth.json` to within 1 cm (walls), 0.01 m² (rooms) and
//! exact equality (door counts).
//!
//! **This module supplies geometry, not the ground-truth file.** `ground-truth.json`
//! is a *join* of these numbers with data the core does not hold — finish
//! materials (`finishSchedule.ts`), furniture elements (`takeoff.ts`), CAD room-
//! marker ids and the plan renderer's drawn labels — so it is assembled by
//! `qtoWorkbook.ts::buildQtoGroundTruth`, which takes its walls, doors, room
//! areas and sqf factor verbatim from here. See `reports/B1-2.md`.
//!
//! ## Wall classification (`WallType`)
//!
//! The qbiq plan legend names seven wall categories. Six of them are wall runs
//! and are produced here; the seventh, `Door_length`, is a *door* quantity and
//! comes from [`DoorQuantity`] (doors are `Component`s with `category: "Door"`,
//! never `Wall`s). Rules, in priority order — the first match wins:
//!
//! | # | Rule | Type |
//! |---|------|------|
//! | 1 | centerline lies on a [`KeepOut`] rectangle's boundary | `Core` |
//! | 2 | `!generated` **and** centerline lies on the traced plate polygon, glazed | `PerimeterWindows` |
//! | 3 | `!generated` **and** centerline lies on the traced plate polygon | `PerimeterWall` |
//! | 4 | `glazing` | `Glass` |
//! | 5 | [`Wall::is_partial_height`] | `HalfDrywall` |
//! | 6 | otherwise | `Drywall` |
//!
//! Deviations from the naive reading of the brief, and why:
//!
//! * **`glazing` does NOT immediately mean `Glass`.** A glazed *facade* segment
//!   is `Perimeter windows`, which the legend lists separately; only an interior
//!   glazed partition (a meeting room's glass front) is `Glass`.
//! * **The perimeter test is geometric, not `!generated`.** An imported DWG plan
//!   has *every* wall `generated == false`, including interior partitions, so the
//!   flag alone would bill interior drywall as facade. `generated` is still used
//!   as a guard (the generator only ever emits interior partitions — see
//!   `layout::reenclose_room`, which explicitly skips boundary edges), and as the
//!   *fallback* when the walls don't close so no plate can be traced.
//! * **`Core` also covers keep-outs with no modelled walls.** The generator
//!   surfaces a `KeepOut` as a `Core` *zone* and emits no shell walls for it, so a
//!   generated test-fit would otherwise report 0 m of core wall. Each keep-out
//!   therefore contributes its own rectangle perimeter *unless* real walls were
//!   already classified against it — never both, so nothing is double-counted.

use crate::document::Document;
use crate::geometry::{self, Point};
use crate::model::{Component, KeepOut, Wall, FULL_WALL_HEIGHT_M};
use crate::zone::{Zone, ZoneType};
use serde::{Deserialize, Serialize};

/// Square feet per square meter. **Exactly 10.764** by orchestrator ruling
/// (`reports/ORCHESTRATOR_LOG.md` cycle 1, ruling 3) — not 10.76 (what the qbiq
/// reference workbook actually used) and not 10.7639 (the true conversion).
pub const SQF_PER_M2: f64 = 10.764;

/// How close a wall centerline must run to a boundary (plate polygon edge or
/// keep-out rectangle edge) to count as lying *on* it, meters. Wall centerlines
/// are what the plate is traced from, so a true boundary wall matches exactly;
/// this only absorbs imported-CAD noise and half-thickness offsets.
const BOUNDARY_TOL_M: f64 = 0.10;

/// How close a `Door` component's center must be to a wall for that wall to be
/// the door's host (and so decide Glass vs Solid), meters.
const DOOR_HOST_TOL_M: f64 = 0.6;

/// The six wall-run categories of the qbiq plan legend. (The legend's seventh
/// row, `Door_length`, is a door quantity — see [`DoorQuantity`].)
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub enum WallType {
    Drywall,
    HalfDrywall,
    Glass,
    Core,
    PerimeterWindows,
    PerimeterWall,
}

impl WallType {
    /// Every variant, in legend order. Quantities always report all six (a
    /// category with no geometry reports `0.0`) so the workbook's wall table has
    /// a stable, complete row set.
    pub const ALL: [WallType; 6] = [
        WallType::Drywall,
        WallType::HalfDrywall,
        WallType::Glass,
        WallType::Core,
        WallType::PerimeterWindows,
        WallType::PerimeterWall,
    ];

    /// The exact legend / `General!J*` "Material Name" string. These are the keys
    /// `ground-truth.json` uses and G3 matches on, so they must not drift.
    pub fn label(self) -> &'static str {
        match self {
            WallType::Drywall => "Drywall",
            WallType::HalfDrywall => "Half Drywall",
            WallType::Glass => "Glass",
            WallType::Core => "Core",
            WallType::PerimeterWindows => "Perimeter windows",
            WallType::PerimeterWall => "Perimeter wall",
        }
    }

    /// The plan-palette key — must equal a `WallType` member of
    /// `web/src/export/qbiqPalette.ts` (and therefore a `plan.*` key of
    /// `docs/reference/qbiq/spec/palette.json`), so the plan renderer colours a
    /// wall with the SAME classification the workbook bills it under.
    pub fn plan_key(self) -> &'static str {
        match self {
            WallType::Drywall => "drywall",
            WallType::HalfDrywall => "half_drywall",
            WallType::Glass => "glass",
            WallType::Core => "core",
            WallType::PerimeterWindows => "perimeter_windows",
            WallType::PerimeterWall => "perimeter_wall",
        }
    }
}

/// The two door types of `General!T9:T10`. A door is `Glass` when its host wall
/// is glazed, `Solid` otherwise — derived from the wall it sits in, never typed.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub enum DoorType {
    Glass,
    Solid,
}

impl DoorType {
    pub const ALL: [DoorType; 2] = [DoorType::Glass, DoorType::Solid];

    pub fn label(self) -> &'static str {
        match self {
            DoorType::Glass => "Glass",
            DoorType::Solid => "Solid",
        }
    }
}

/// One wall-type row: run length plus the height assumption behind it, so the
/// workbook can wire a live `length × height` area formula instead of a constant.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WallQuantity {
    pub wall_type: WallType,
    /// `WallType::label()` — the exact `General!J*` Material Name.
    pub label: String,
    /// Total centerline run, meters.
    pub length_m: f64,
    /// Height assumption used for `area_m2`, meters. Full storey height
    /// ([`FULL_WALL_HEIGHT_M`]) for every category except `Half Drywall`, which
    /// reports the mean of its walls' explicit heights.
    pub height_m: f64,
    /// `length_m × height_m`, m² — the elevational area of the run.
    pub area_m2: f64,
    /// Number of modelled `Wall` segments in this category. `Core` can carry
    /// length with `segments == 0` when it comes from keep-out perimeters.
    pub segments: usize,
}

/// One door-type row. `total_width_m` is the legend's `Door_length`.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DoorQuantity {
    pub door_type: DoorType,
    pub label: String,
    pub count: usize,
    /// Σ leaf widths, meters (the long side of each door footprint).
    pub total_width_m: f64,
}

/// One room row: a `Zone`'s addressable identity plus its measured area.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomQuantity {
    /// The zone id — unique by construction (`Document::alloc_id`).
    pub room_id: u32,
    /// The zone's human/AI-facing label.
    pub name: String,
    pub zone_type: ZoneType,
    /// Human-readable `zone_type` (the workbook's "Space Type").
    pub space_type: String,
    /// Plate-clipped, de-overlapped floor area, m² — the same number the
    /// Statistics panel shows (`crate::effective_zone_areas`).
    pub area_m2: f64,
    /// `area_m2 × SQF_PER_M2`.
    pub area_sqf: f64,
    /// Measured seats: non-reference `Desk` + `Chair` components inside the zone.
    /// Desks are placed without a chair component, so nothing is double-counted.
    pub headcount: u32,
    /// Area rule-of-thumb capacity (`Zone::capacity`) — a planning estimate, kept
    /// alongside the measured `headcount` and never substituted for it.
    pub capacity: u32,
}

/// The whole quantity surface for one document.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Quantities {
    pub sqf_per_m2: f64,
    /// Full storey height assumption, meters.
    pub wall_height_m: f64,
    /// Traced plate area, m².
    pub floor_area_m2: f64,
    /// All six [`WallType`]s, in legend order, always present.
    pub walls: Vec<WallQuantity>,
    /// Both [`DoorType`]s, always present.
    pub doors: Vec<DoorQuantity>,
    pub door_count: usize,
    /// Σ door leaf widths, meters — the legend's `Door_length`.
    pub door_total_width_m: f64,
    /// One row per `Zone`, in document order.
    pub rooms: Vec<RoomQuantity>,
}

/// One wall's classification, for the **plan renderer**. Exposing this (rather
/// than letting the renderer re-derive types in TypeScript) is what guarantees
/// the coloured plan and the billed workbook cannot disagree.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WallClassification {
    /// `Wall::id`.
    pub id: u32,
    pub wall_type: WallType,
    /// `WallType::plan_key()` — the `qbiqPalette.ts` `WallType` string.
    pub plan_key: String,
    /// Centerline length, meters (so a caller can reconcile totals).
    pub length_m: f64,
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/// Minimum distance from `p` to the boundary (not the interior) of a
/// center-origin rectangle.
fn dist_to_rect_boundary(p: Point, k: &KeepOut) -> f64 {
    let (x0, y0) = (k.x - k.w / 2.0, k.y - k.h / 2.0);
    let (x1, y1) = (k.x + k.w / 2.0, k.y + k.h / 2.0);
    let corners = [
        Point::new(x0, y0),
        Point::new(x1, y0),
        Point::new(x1, y1),
        Point::new(x0, y1),
    ];
    (0..4)
        .map(|i| geometry::point_segment_dist(p, corners[i], corners[(i + 1) % 4]))
        .fold(f64::INFINITY, f64::min)
}

/// Minimum distance from `p` to a closed polygon's edges.
fn dist_to_polygon_boundary(p: Point, poly: &[Point]) -> f64 {
    if poly.len() < 2 {
        return f64::INFINITY;
    }
    (0..poly.len())
        .map(|i| geometry::point_segment_dist(p, poly[i], poly[(i + 1) % poly.len()]))
        .fold(f64::INFINITY, f64::min)
}

/// Sample a wall centerline at both ends and its midpoint. A wall lies *on* a
/// boundary only when all three samples are within tolerance — an endpoint test
/// alone would misclassify a partition that merely tees into the facade.
fn samples(w: &Wall) -> [Point; 3] {
    [
        w.a,
        Point::new((w.a.x + w.b.x) / 2.0, (w.a.y + w.b.y) / 2.0),
        w.b,
    ]
}

/// The index of the keep-out this wall runs along, if any.
fn keepout_host(w: &Wall, keepouts: &[KeepOut]) -> Option<usize> {
    keepouts.iter().position(|k| {
        samples(w)
            .iter()
            .all(|&p| dist_to_rect_boundary(p, k) <= BOUNDARY_TOL_M)
    })
}

/// True when the wall centerline runs along the traced plate polygon.
fn on_plate_boundary(w: &Wall, plate: &[Point]) -> bool {
    samples(w)
        .iter()
        .all(|&p| dist_to_polygon_boundary(p, plate) <= BOUNDARY_TOL_M)
}

/// Classify one wall. See the module docs for the rule table and the reasoning
/// behind the ordering. `plate` is `Document::plate_polygon()`, threaded in so a
/// caller classifying many walls traces it once.
pub fn classify_wall(w: &Wall, keepouts: &[KeepOut], plate: Option<&[Point]>) -> WallType {
    if keepout_host(w, keepouts).is_some() {
        return WallType::Core;
    }
    // The generator only ever emits interior partitions and glass fronts, so a
    // generated wall is never facade — this also keeps a room shell that happens
    // to sit flush against the facade from double-billing the perimeter run.
    let perimeter = if w.generated {
        false
    } else {
        match plate {
            Some(poly) => on_plate_boundary(w, poly),
            // No closed plate could be traced (open/partial walls): fall back to
            // the `generated` flag, the only signal left. Documented, lossy.
            None => true,
        }
    };
    if perimeter {
        return if w.glazing {
            WallType::PerimeterWindows
        } else {
            WallType::PerimeterWall
        };
    }
    if w.glazing {
        return WallType::Glass;
    }
    if w.is_partial_height() {
        return WallType::HalfDrywall;
    }
    WallType::Drywall
}

/// The leaf width of a door component: the long side of its footprint (the
/// generator writes `w = leaf, h = DOOR_D`, but a rotated/imported door may be
/// the other way round).
fn door_width(c: &Component) -> f64 {
    c.w.max(c.h)
}

/// Classify a door by the wall it sits in: glazed host → `Glass`, else `Solid`.
/// A door with no wall within [`DOOR_HOST_TOL_M`] is `Solid` (the conservative
/// default — a solid leaf is the cheaper, more common product).
pub fn classify_door(c: &Component, walls: &[Wall]) -> DoorType {
    let p = Point::new(c.x, c.y);
    let host = walls
        .iter()
        .map(|w| (geometry::point_segment_dist(p, w.a, w.b), w))
        .filter(|(d, _)| *d <= DOOR_HOST_TOL_M)
        .min_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
    match host {
        Some((_, w)) if w.glazing => DoorType::Glass,
        _ => DoorType::Solid,
    }
}

/// Perimeter of a keep-out rectangle, meters.
fn keepout_perimeter(k: &KeepOut) -> f64 {
    2.0 * (k.w.abs() + k.h.abs())
}

/// Measured seats in a zone: non-reference `Desk` + `Chair` components whose
/// center falls inside it. The generator places desks *without* a chair
/// component and meeting tables *with* chairs, so the two never double-count.
fn headcount(z: &Zone, components: &[Component]) -> u32 {
    z.component_ids
        .iter()
        .filter(|&&cid| {
            components.iter().any(|c| {
                c.id == cid && !c.reference && (c.category == "Desk" || c.category == "Chair")
            })
        })
        .count() as u32
}

/// Human-readable `ZoneType`, used as the workbook's "Space Type".
pub fn space_type_label(t: ZoneType) -> &'static str {
    match t {
        ZoneType::Circulation => "Circulation",
        ZoneType::Workspace => "Open Workspace",
        ZoneType::Meeting => "Meeting Room",
        ZoneType::Collaboration => "Collaboration",
        ZoneType::Core => "Core / Service",
        ZoneType::ClosedOffice => "Closed Office",
        ZoneType::Amenity => "Amenity",
    }
}

// ---------------------------------------------------------------------------
// The quantity surface
// ---------------------------------------------------------------------------

/// Classify every wall in the document, in document order. The plan renderer's
/// single source of wall colour — see [`WallClassification`].
pub fn classify_walls(doc: &Document) -> Vec<WallClassification> {
    let plate = doc.plate_polygon();
    let plate_ref = plate.as_deref();
    doc.walls
        .iter()
        .map(|w| {
            let t = classify_wall(w, &doc.keepouts, plate_ref);
            WallClassification {
                id: w.id,
                wall_type: t,
                plan_key: t.plan_key().to_string(),
                length_m: w.length(),
            }
        })
        .collect()
}

/// Compute every quantity the takeoff workbook needs, from geometry alone.
pub fn quantities(doc: &Document) -> Quantities {
    let plate = doc.plate_polygon();
    let plate_ref = plate.as_deref();

    // ---- walls: one bucket per type ---------------------------------------
    let mut length = [0.0f64; 6];
    let mut segments = [0usize; 6];
    // Half Drywall reports the mean of its walls' explicit heights, so the
    // workbook's `length × height` formula is honest for mixed screen heights.
    let mut half_height_sum = 0.0f64;
    // A keep-out whose shell IS modelled must not also contribute its perimeter.
    let mut keepout_walled = vec![false; doc.keepouts.len()];

    for w in &doc.walls {
        let t = classify_wall(w, &doc.keepouts, plate_ref);
        let i = WallType::ALL.iter().position(|&x| x == t).unwrap();
        let l = w.length();
        length[i] += l;
        segments[i] += 1;
        if t == WallType::HalfDrywall {
            half_height_sum += w.height() * l;
        }
        if let Some(k) = keepout_host(w, &doc.keepouts) {
            keepout_walled[k] = true;
        }
    }
    // Keep-outs with no modelled shell contribute their own rectangle perimeter,
    // which is what a generated test-fit always hits (the generator emits a Core
    // zone for a keep-out and no walls at all).
    let core_i = WallType::ALL.iter().position(|&x| x == WallType::Core).unwrap();
    for (k, walled) in doc.keepouts.iter().zip(&keepout_walled) {
        if !*walled {
            length[core_i] += keepout_perimeter(k);
        }
    }

    let half_i = WallType::ALL
        .iter()
        .position(|&x| x == WallType::HalfDrywall)
        .unwrap();
    let walls: Vec<WallQuantity> = WallType::ALL
        .iter()
        .enumerate()
        .map(|(i, &t)| {
            let h = if i == half_i && length[i] > 0.0 {
                half_height_sum / length[i]
            } else {
                FULL_WALL_HEIGHT_M
            };
            WallQuantity {
                wall_type: t,
                label: t.label().to_string(),
                length_m: length[i],
                height_m: h,
                area_m2: length[i] * h,
                segments: segments[i],
            }
        })
        .collect();

    // ---- doors -------------------------------------------------------------
    let mut door_count = [0usize; 2];
    let mut door_width_sum = [0.0f64; 2];
    for c in doc.components.iter().filter(|c| c.category == "Door") {
        let t = classify_door(c, &doc.walls);
        let i = DoorType::ALL.iter().position(|&x| x == t).unwrap();
        door_count[i] += 1;
        door_width_sum[i] += door_width(c);
    }
    let doors: Vec<DoorQuantity> = DoorType::ALL
        .iter()
        .enumerate()
        .map(|(i, &t)| DoorQuantity {
            door_type: t,
            label: t.label().to_string(),
            count: door_count[i],
            total_width_m: door_width_sum[i],
        })
        .collect();

    // ---- rooms -------------------------------------------------------------
    // Reuse the ONE area definition the Statistics panel and the metrics chip
    // already use: plate-clipped and de-overlapped, so the takeoff can never
    // disagree with what the user sees on screen.
    let (areas, _) = crate::effective_zone_areas(doc);
    let rooms: Vec<RoomQuantity> = doc
        .zones
        .iter()
        .enumerate()
        .map(|(i, z)| {
            let area_m2 = areas[i];
            RoomQuantity {
                room_id: z.id,
                name: z.label.clone(),
                zone_type: z.zone_type,
                space_type: space_type_label(z.zone_type).to_string(),
                area_m2,
                area_sqf: area_m2 * SQF_PER_M2,
                headcount: headcount(z, &doc.components),
                capacity: z.capacity(),
            }
        })
        .collect();

    let _ = plate_ref;
    Quantities {
        sqf_per_m2: SQF_PER_M2,
        wall_height_m: FULL_WALL_HEIGHT_M,
        floor_area_m2: doc.floor_area(),
        walls,
        doors,
        door_count: door_count.iter().sum(),
        door_total_width_m: door_width_sum.iter().sum(),
        rooms,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::DecisionState;
    use crate::zone::ZoneShape;

    // -----------------------------------------------------------------------
    // The hand-computed fixture. Every number below is arithmetic you can do on
    // paper from these coordinates — that is the whole point of the fixture.
    //
    //   Plate            20 × 12 rectangle, walls on the boundary → 240.00 m²
    //     bottom  (0,0)-(20,0)   glazed  → Perimeter windows  20.00 m
    //     top     (20,12)-(0,12) glazed  → Perimeter windows  20.00 m
    //     right   (20,0)-(20,12)         → Perimeter wall     12.00 m
    //     left    (0,12)-(0,0)           → Perimeter wall     12.00 m
    //   Keep-out         center (17,10) 4 × 3, NO modelled shell
    //                                    → Core = perimeter    14.00 m
    //   Meeting room     centerlines x 2..6, y 2..5
    //     three solid partitions          → Drywall  3 + 4 + 4 = 11.00 m
    //     glazed front at x = 6, 0.9 door gap y 3.1..4.0
    //       (6,2)-(6,3.1) = 1.1, (6,4)-(6,5) = 1.0
    //                                    → Glass              2.10 m
    //   Half-height screen (8,2)-(13,2), height 1.1
    //                                    → Half Drywall        5.00 m
    //   Doors  (6,3.55) in the glazed front → Glass, w 0.9
    //          (10,2)   in the screen       → Solid, w 0.9
    //                                    → count 2, Door_length 1.80 m
    //   Zones  Meeting  Rect(4, 3.5, 4, 3)                    12.00 m²
    //          Workspace Rect(10, 8, 10, 6)                   60.00 m²
    //          Core     Rect(17, 10, 4, 3)                    12.00 m²
    //          Circulation RectRing(10,6,20,12,18,10) 240−180 60.00 m²
    //          Collab   Poly (14,0)(20,0)(20,6)  ½·6·6        18.00 m²
    //   Headcount  4 chairs in Meeting, 6 desks in Workspace
    // -----------------------------------------------------------------------

    fn wall(doc: &mut Document, ax: f64, ay: f64, bx: f64, by: f64, generated: bool, glazing: bool) {
        let id = doc.alloc_id();
        doc.walls.push(Wall {
            id,
            a: Point::new(ax, ay),
            b: Point::new(bx, by),
            thickness: 0.1,
            generated,
            glazing,
            height_m: None,
        });
    }

    fn comp(doc: &mut Document, category: &str, x: f64, y: f64, w: f64, h: f64) {
        let id = doc.alloc_id();
        doc.components.push(Component {
            id,
            category: category.to_string(),
            x,
            y,
            w,
            h,
            rotation: 0.0,
            mirror: false,
            reference: false,
            label: format!("{category} {id}"),
            product_id: None,
            price_inr: None,
            decision: DecisionState::Open,
        });
    }

    fn zone(doc: &mut Document, t: ZoneType, shape: ZoneShape, label: &str) -> u32 {
        doc.add_zone(t, shape, label.to_string())
    }

    fn fixture() -> Document {
        let mut doc = Document::new();

        // Plate: four boundary walls; bottom + top glazed.
        wall(&mut doc, 0.0, 0.0, 20.0, 0.0, false, true);
        wall(&mut doc, 20.0, 0.0, 20.0, 12.0, false, false);
        wall(&mut doc, 20.0, 12.0, 0.0, 12.0, false, true);
        wall(&mut doc, 0.0, 12.0, 0.0, 0.0, false, false);

        // Building core as a keep-out with no modelled shell walls.
        let kid = doc.alloc_id();
        doc.keepouts.push(KeepOut {
            id: kid,
            x: 17.0,
            y: 10.0,
            w: 4.0,
            h: 3.0,
            label: "Core".to_string(),
        });

        // Meeting room: three solid partitions + a glazed front broken by a door.
        wall(&mut doc, 2.0, 2.0, 2.0, 5.0, true, false); // 3.0
        wall(&mut doc, 2.0, 5.0, 6.0, 5.0, true, false); // 4.0
        wall(&mut doc, 2.0, 2.0, 6.0, 2.0, true, false); // 4.0
        wall(&mut doc, 6.0, 2.0, 6.0, 3.1, true, true); // 1.1 glass
        wall(&mut doc, 6.0, 4.0, 6.0, 5.0, true, true); // 1.0 glass

        // Half-height screen: the ONLY way `Half Drywall` becomes non-zero.
        let id = doc.alloc_id();
        doc.walls.push(Wall {
            id,
            a: Point::new(8.0, 2.0),
            b: Point::new(13.0, 2.0),
            thickness: 0.1,
            generated: true,
            glazing: false,
            height_m: Some(1.1),
        });

        // Doors.
        comp(&mut doc, "Door", 6.0, 3.55, 0.9, 0.15); // in the glazed front
        comp(&mut doc, "Door", 10.0, 2.0, 0.9, 0.15); // in the half-height screen

        // Seats.
        for i in 0..6 {
            comp(&mut doc, "Desk", 8.0 + i as f64, 8.0, 1.4, 0.7);
        }
        for i in 0..4 {
            comp(&mut doc, "Chair", 3.0 + 0.5 * i as f64, 3.0, 0.5, 0.5);
        }
        comp(&mut doc, "Table", 4.0, 4.0, 2.0, 1.0);

        // Zones — all five ZoneShape situations the takeoff must handle.
        zone(&mut doc, ZoneType::Meeting, ZoneShape::Rect { x: 4.0, y: 3.5, w: 4.0, h: 3.0 }, "Meeting A");
        zone(&mut doc, ZoneType::Workspace, ZoneShape::Rect { x: 10.0, y: 8.0, w: 10.0, h: 6.0 }, "Open Workspace");
        zone(&mut doc, ZoneType::Core, ZoneShape::Rect { x: 17.0, y: 10.0, w: 4.0, h: 3.0 }, "Core");
        zone(
            &mut doc,
            ZoneType::Circulation,
            ZoneShape::RectRing { x: 10.0, y: 6.0, w: 20.0, h: 12.0, in_w: 18.0, in_h: 10.0 },
            "Perimeter Corridor",
        );
        zone(
            &mut doc,
            ZoneType::Collaboration,
            ZoneShape::Poly { pts: vec![[14.0, 0.0], [20.0, 0.0], [20.0, 6.0]] },
            "Breakout",
        );
        doc.reassign_components();
        doc
    }

    fn wall_len(q: &Quantities, t: WallType) -> f64 {
        q.walls.iter().find(|w| w.wall_type == t).unwrap().length_m
    }

    /// Wall run length per type matches the hand-computed values within 1 cm —
    /// the tolerance `scripts/gates/g3-quantity-truth.py` asserts.
    #[test]
    fn wall_lengths_match_hand_computed_within_1cm() {
        let q = quantities(&fixture());
        const TOL: f64 = 0.01;
        for (t, want) in [
            (WallType::Drywall, 11.0),
            (WallType::HalfDrywall, 5.0),
            (WallType::Glass, 2.1),
            (WallType::Core, 14.0),
            (WallType::PerimeterWindows, 40.0),
            (WallType::PerimeterWall, 24.0),
        ] {
            let got = wall_len(&q, t);
            assert!(
                (got - want).abs() <= TOL,
                "{} length {got:.4} m vs hand-computed {want:.4} m (off {:.2} cm, tol 1 cm)",
                t.label(),
                (got - want).abs() * 100.0
            );
        }
        // All six categories are always reported, so the workbook table is stable.
        assert_eq!(q.walls.len(), 6);
        // Core came from the keep-out perimeter, with zero modelled segments.
        let core = q.walls.iter().find(|w| w.wall_type == WallType::Core).unwrap();
        assert_eq!(core.segments, 0, "no modelled wall runs along the keep-out");
    }

    /// The height assumption B3 wires into `length × height` formulas.
    #[test]
    fn wall_heights_and_areas_are_derived_not_typed() {
        let q = quantities(&fixture());
        assert!((q.wall_height_m - 2.6).abs() < 1e-12);
        for w in &q.walls {
            assert!(
                (w.area_m2 - w.length_m * w.height_m).abs() < 1e-9,
                "{} area must be length x height",
                w.label
            );
        }
        let half = q.walls.iter().find(|w| w.wall_type == WallType::HalfDrywall).unwrap();
        assert!((half.height_m - 1.1).abs() < 1e-9, "half-height screen reports its own height");
        assert!((half.area_m2 - 5.5).abs() < 1e-9, "5.0 m x 1.1 m");
        let dry = q.walls.iter().find(|w| w.wall_type == WallType::Drywall).unwrap();
        assert!((dry.area_m2 - 11.0 * 2.6).abs() < 1e-9);
    }

    /// Door count is EXACT (G3 admits no tolerance), and the Glass/Solid split
    /// is read off the host wall's glazing.
    #[test]
    fn door_count_is_exact_and_typed_by_host_wall() {
        let q = quantities(&fixture());
        assert_eq!(q.door_count, 2);
        assert!((q.door_total_width_m - 1.8).abs() < 1e-12, "Door_length = 0.9 + 0.9");
        let glass = q.doors.iter().find(|d| d.door_type == DoorType::Glass).unwrap();
        let solid = q.doors.iter().find(|d| d.door_type == DoorType::Solid).unwrap();
        assert_eq!(glass.count, 1, "the door in the glazed front is a glass door");
        assert_eq!(solid.count, 1, "the door in the half-height screen is solid");
        assert!((glass.total_width_m - 0.9).abs() < 1e-12);
    }

    /// Per-room m² within 0.01, across all three `ZoneShape` variants, and every
    /// room id unique.
    #[test]
    fn room_areas_match_hand_computed_and_ids_are_unique() {
        let q = quantities(&fixture());
        const TOL: f64 = 0.01;
        let want: [(&str, f64); 5] = [
            ("Meeting A", 12.0),
            ("Open Workspace", 60.0),
            ("Core", 12.0),
            ("Perimeter Corridor", 60.0),
            ("Breakout", 18.0),
        ];
        assert_eq!(q.rooms.len(), want.len());
        for (name, area) in want {
            let r = q.rooms.iter().find(|r| r.name == name).unwrap();
            assert!(
                (r.area_m2 - area).abs() <= TOL,
                "room {name} area {:.4} m2 vs hand-computed {area:.4} (off {:.4}, tol {TOL})",
                r.area_m2,
                (r.area_m2 - area).abs()
            );
            assert!(
                (r.area_sqf - r.area_m2 * 10.764).abs() < 1e-9,
                "sqf must be m2 x 10.764 exactly"
            );
        }
        let mut ids: Vec<u32> = q.rooms.iter().map(|r| r.room_id).collect();
        let n = ids.len();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), n, "every room id is unique");
    }

    /// Headcount is measured from placed furniture, never assumed.
    #[test]
    fn headcount_counts_real_seats_only() {
        let doc = fixture();
        let q = quantities(&doc);
        let meeting = q.rooms.iter().find(|r| r.name == "Meeting A").unwrap();
        let ws = q.rooms.iter().find(|r| r.name == "Open Workspace").unwrap();
        assert_eq!(meeting.headcount, 4, "4 chairs, the table is not a seat");
        assert_eq!(ws.headcount, 6, "6 desks, each seating one");
        assert_eq!(meeting.space_type, "Meeting Room");
    }

    /// Reference (imported/legacy) furniture is passive context and never counts
    /// — the same rule `metrics().workstations` applies.
    #[test]
    fn reference_furniture_is_excluded_from_headcount() {
        let mut doc = fixture();
        for c in doc.components.iter_mut().filter(|c| c.category == "Desk") {
            c.reference = true;
        }
        let q = quantities(&doc);
        let ws = q.rooms.iter().find(|r| r.name == "Open Workspace").unwrap();
        assert_eq!(ws.headcount, 0, "imported reference desks seat nobody");
    }

    /// `SQF_PER_M2` is exactly 10.764 (orchestrator ruling) — not 10.76, not
    /// 10.7639. A drift here silently breaks every Inventory sqf cell.
    #[test]
    fn sqf_factor_is_exactly_10_764() {
        assert_eq!(SQF_PER_M2, 10.764);
        assert_eq!(quantities(&fixture()).sqf_per_m2, 10.764);
    }

    /// The keys `qtoWorkbook.ts::buildQtoGroundTruth` writes into
    /// `out/ground-truth.json` come from THIS module's `label()`s, and G3 matches
    /// them against `General!J*` / `General!T*` by exact string. The core no
    /// longer emits that file (see the module docs), but it still owns the
    /// vocabulary, so the vocabulary is pinned here. The file's own shape is
    /// checked end-to-end, on the real artifact, by G3.
    #[test]
    fn ground_truth_key_vocabulary_is_pinned() {
        let q = quantities(&fixture());
        let wall_keys: Vec<&str> = q.walls.iter().map(|w| w.label.as_str()).collect();
        assert_eq!(
            wall_keys,
            [
                "Drywall",
                "Half Drywall",
                "Glass",
                "Core",
                "Perimeter windows",
                "Perimeter wall"
            ],
            "these are the General!J9:J14 Material Names G3 matches on"
        );
        let door_keys: Vec<&str> = q.doors.iter().map(|d| d.label.as_str()).collect();
        assert_eq!(door_keys, ["Glass", "Solid"], "General!T9:T10 Type Names");
        // Keys must be unique — a collision would silently drop a row from the
        // ground truth's `walls` / `doors` objects.
        let mut u = wall_keys.clone();
        u.sort_unstable();
        u.dedup();
        assert_eq!(u.len(), wall_keys.len());
        assert_eq!(q.sqf_per_m2, 10.764);
    }

    /// Classification rules, exercised one at a time on the fixture's walls.
    #[test]
    fn classification_rules_hold_per_wall() {
        let doc = fixture();
        let plate = doc.plate_polygon().expect("the four boundary walls close");
        let of = |ax: f64, ay: f64| -> WallType {
            let w = doc
                .walls
                .iter()
                .find(|w| (w.a.x - ax).abs() < 1e-9 && (w.a.y - ay).abs() < 1e-9)
                .unwrap();
            classify_wall(w, &doc.keepouts, Some(&plate))
        };
        assert_eq!(of(0.0, 0.0), WallType::PerimeterWindows, "glazed facade");
        assert_eq!(of(20.0, 0.0), WallType::PerimeterWall, "solid facade");
        assert_eq!(of(2.0, 2.0), WallType::Drywall, "interior solid partition");
        assert_eq!(of(6.0, 2.0), WallType::Glass, "interior glazed front");
        assert_eq!(of(8.0, 2.0), WallType::HalfDrywall, "partial-height screen");
    }

    /// A wall running along a keep-out edge is `Core`, and that keep-out then
    /// stops contributing its own perimeter — no double count.
    #[test]
    fn modelled_core_wall_replaces_the_keepout_perimeter() {
        let mut doc = fixture();
        // The keep-out's south edge: y = 8.5, x 15..19 → 4.0 m.
        wall(&mut doc, 15.0, 8.5, 19.0, 8.5, false, false);
        let q = quantities(&doc);
        assert!(
            (wall_len(&q, WallType::Core) - 4.0).abs() < 1e-9,
            "the modelled shell (4 m) replaces the 14 m perimeter, never adds to it"
        );
        let core = q.walls.iter().find(|w| w.wall_type == WallType::Core).unwrap();
        assert_eq!(core.segments, 1);
        // And it did NOT leak into the perimeter buckets.
        assert!((wall_len(&q, WallType::PerimeterWall) - 24.0).abs() < 1e-9);
    }

    /// With no traced plate (walls don't close) the perimeter test degrades to
    /// the `generated` flag — documented, and asserted so the fallback can't
    /// silently change.
    #[test]
    fn open_walls_fall_back_to_the_generated_flag() {
        let mut doc = Document::new();
        wall(&mut doc, 0.0, 0.0, 10.0, 0.0, false, false); // architectural
        wall(&mut doc, 0.0, 0.0, 0.0, 4.0, true, false); // generated partition
        assert!(doc.plate_polygon().is_none(), "three-sided walls never close");
        let q = quantities(&doc);
        assert!((wall_len(&q, WallType::PerimeterWall) - 10.0).abs() < 1e-9);
        assert!((wall_len(&q, WallType::Drywall) - 4.0).abs() < 1e-9);
    }

    /// End-to-end on a REAL generated test-fit (not the hand fixture): the
    /// classifier must survive whatever `layout::generate` emits. This is the
    /// test that would catch a rule that only works on tidy hand-made geometry.
    #[test]
    fn a_generated_testfit_produces_a_coherent_quantity_surface() {
        let mut doc = Document::new();
        // 24 x 16 plate, four architectural walls (all glazed facade except one).
        wall(&mut doc, 0.0, 0.0, 24.0, 0.0, false, true);
        wall(&mut doc, 24.0, 0.0, 24.0, 16.0, false, true);
        wall(&mut doc, 24.0, 16.0, 0.0, 16.0, false, true);
        wall(&mut doc, 0.0, 16.0, 0.0, 0.0, false, false);
        let kid = doc.alloc_id();
        doc.keepouts.push(KeepOut {
            id: kid, x: 21.0, y: 13.5, w: 4.0, h: 3.0, label: "Stair core".into(),
        });
        let program = crate::layout::Program::default();
        crate::layout::generate(&mut doc, &program, 7, false);

        let q = quantities(&doc);

        // Facade: the four architectural walls, split glazed/solid, and NOTHING
        // else — no generated partition may leak into the perimeter buckets.
        let perim = wall_len(&q, WallType::PerimeterWindows) + wall_len(&q, WallType::PerimeterWall);
        assert!(
            (perim - 2.0 * (24.0 + 16.0)).abs() <= 0.01,
            "perimeter run must be exactly the plate perimeter, got {perim:.4} m"
        );
        assert!((wall_len(&q, WallType::PerimeterWindows) - 64.0).abs() <= 0.01);
        assert!((wall_len(&q, WallType::PerimeterWall) - 16.0).abs() <= 0.01);

        // The generator emits room shells, so interior partitions exist and the
        // keep-out (which gets no shell walls) contributes its 14 m perimeter.
        assert!(wall_len(&q, WallType::Drywall) > 0.0, "generated rooms have partitions");
        assert!((wall_len(&q, WallType::Core) - 14.0).abs() <= 0.01);
        // The generator has no partial-height primitive — honestly zero.
        assert_eq!(wall_len(&q, WallType::HalfDrywall), 0.0);

        // Doors: exactly the `Door` components, no more, no less.
        let door_components = doc.components.iter().filter(|c| c.category == "Door").count();
        assert_eq!(q.door_count, door_components);
        assert_eq!(
            q.doors.iter().map(|d| d.count).sum::<usize>(),
            door_components,
            "every door lands in exactly one type bucket"
        );

        // Rooms: one per zone, unique ids, areas summing to no more than the plate.
        assert_eq!(q.rooms.len(), doc.zones.len());
        let mut ids: Vec<u32> = q.rooms.iter().map(|r| r.room_id).collect();
        let n = ids.len();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), n, "every generated room id is unique");
        let total: f64 = q.rooms.iter().map(|r| r.area_m2).sum();
        assert!(
            total <= q.floor_area_m2 + 1e-6,
            "Sigma room area {total:.2} must not exceed the plate {:.2}",
            q.floor_area_m2
        );
        for r in &q.rooms {
            assert!(r.area_m2 >= 0.0);
            assert!((r.area_sqf - r.area_m2 * SQF_PER_M2).abs() < 1e-9);
        }
    }

    /// The per-wall classification the plan renderer consumes: one entry per
    /// wall, its `planKey` a real `palette.json` `plan.*` key, and its lengths
    /// reconciling EXACTLY with the billed wall totals. The last part is the
    /// point — it is what makes "the plan is coloured from the same truth the
    /// workbook bills" a checked property rather than a claim.
    #[test]
    fn classify_walls_feeds_the_plan_renderer_and_reconciles_with_billing() {
        let doc = fixture();
        let cls = classify_walls(&doc);
        assert_eq!(cls.len(), doc.walls.len(), "one entry per wall, document order");

        // Every plan key is a real palette key (checked against palette.json's
        // own `plan.*` names, so a rename over there fails this test).
        let palette: serde_json::Value = serde_json::from_str(include_str!(
            "../../../docs/reference/qbiq/spec/palette.json"
        ))
        .expect("palette.json parses");
        for t in WallType::ALL {
            assert!(
                palette["plan"].get(t.plan_key()).is_some(),
                "plan key '{}' is not in palette.json plan.*",
                t.plan_key()
            );
        }
        for c in &cls {
            assert_eq!(c.plan_key, c.wall_type.plan_key());
        }

        // Σ classified length per type == the billed length per type, except
        // `Core`, which additionally carries un-walled keep-out perimeters.
        let q = quantities(&doc);
        for t in WallType::ALL {
            let from_cls: f64 = cls.iter().filter(|c| c.wall_type == t).map(|c| c.length_m).sum();
            let billed = wall_len(&q, t);
            if t == WallType::Core {
                assert!((billed - from_cls - 14.0).abs() < 1e-9, "core = walls + keep-out shell");
            } else {
                assert!(
                    (billed - from_cls).abs() < 1e-9,
                    "{} billed {billed:.4} != plan {from_cls:.4}",
                    t.label()
                );
            }
        }
    }

    /// A pre-B1 snapshot has no `height_m`; it must load (full height) and an
    /// unset wall must not gain the field on the wire. This is the additive-schema
    /// guarantee `model::tests::wall_flags_default_false_and_round_trip` protects.
    #[test]
    fn wall_height_is_additive_and_round_trips() {
        let old = r#"{"id":7,"a":{"x":0.0,"y":0.0},"b":{"x":4.0,"y":0.0},"thickness":0.1}"#;
        let w: Wall = serde_json::from_str(old).expect("pre-B1 wall JSON must parse");
        assert_eq!(w.height_m, None);
        assert!((w.height() - FULL_WALL_HEIGHT_M).abs() < 1e-12);
        assert!(!w.is_partial_height());
        assert!(
            !serde_json::to_string(&w).unwrap().contains("height_m"),
            "an unset height must not appear on the wire (old-format equivalence)"
        );

        let mut half = w.clone();
        half.height_m = Some(1.1);
        let back: Wall = serde_json::from_str(&serde_json::to_string(&half).unwrap()).unwrap();
        assert_eq!(back.height_m, Some(1.1));
        assert!(back.is_partial_height());
    }
}
