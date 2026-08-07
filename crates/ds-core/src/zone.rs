//! First-class **Zones**: the spatial primitive between thin wall geometry and
//! furniture components. A Zone is an addressable, typed region of the floor
//! plate (a room / corridor / desk field) with a stable id.
//!
//! Two consumers depend on this at once (see `docs/design/rooms-zones-model.md`):
//!   1. Laiout pastel rendering — the plate tiled into soft-colored regions.
//!   2. The AI backbone — a mergeable, addressable object with derived stats
//!      ("capacity 24→18") the model reasons about before executing.
//!
//! Rect-based v1: footprints are axis-aligned rectangles (center-origin, matching
//! `Component`), plus a `RectRing` for the perimeter corridor (a rect with a
//! rectangular hole) — no polygon library. std + serde only; no wasm, no rand.

use serde::{Deserialize, Serialize};

/// **THE SINGLE AUTHORING POINT FOR THE ZONE DOMAIN (R22).**
///
/// One declaration emits the enum, `ZoneType::ALL`, `name()`, the published
/// fold, and both partitions. There is nowhere else to type a variant.
///
/// **The ladder this closes.** A regex read the FORM of the definition and a
/// prose comment defeated it. The fix authored a VALUE — and belief attempt
/// five showed an authored value is form one level deeper: `ground_zone_types()`
/// said it iterated "every `ZoneType`" and iterated an eight-element array
/// literal. Adding a ninth variant and fixing only what the compiler demanded
/// left `is_ground_zone(Utility)` true in Rust and false in TypeScript, 25
/// people seated in a non-usable zone, and every board green.
///
/// A detector cannot close that, because the defect is an author forgetting a
/// list. **The floor is generation: an incomplete enumeration must be not
/// merely detected but UNAUTHORABLE.** Every list below is emitted from the one
/// table, so "the array lags the enum" is not a bug you can write.
///
/// Each variant declares its CLASS, which is what the partitions are made of:
///   * `ground`  — the floor a plan sits on. Folds to `Circulation` on every
///                 published surface, seats nobody, is never usable area.
///   * `service` — a real, named, scheduled room that is NOT usable area
///                 (a WC or riser is a room; it is landlord/overhead).
///   * `program` — a room somebody occupies. Usable area.
macro_rules! zone_domain {
    ($( $(#[$meta:meta])* $variant:ident : $class:ident ),+ $(,)?) => {
        /// Semantic purpose of a region of the floor plate. Drives the pastel
        /// fill, the capacity model, and the Statistics donut bucket. String-tag
        /// serde repr so the TS/AI side speaks the same vocabulary ("Meeting",
        /// not `2`).
        ///
        /// **Generated from `zone_domain!` — see it for why.** Do not add a
        /// variant here; there is no "here" to add it to.
        #[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
        pub enum ZoneType {
            $( $(#[$meta])* $variant ),+
        }

        impl ZoneType {
            /// **Every variant, GENERATED.** Not an array literal that an author
            /// has to remember to grow — this list and the enum have one source.
            pub const ALL: &'static [ZoneType] = &[ $( ZoneType::$variant ),+ ];

            /// The name serde and the wasm boundary publish for this variant.
            pub fn name(self) -> &'static str {
                match self { $( ZoneType::$variant => stringify!($variant) ),+ }
            }

            /// GROUND — the floor a plan sits on, generated from the class
            /// column. `published_zone_type` and `is_ground_zone` both read
            /// this, so the fold and the predicate cannot disagree.
            pub(crate) fn is_ground(self) -> bool {
                match self { $( ZoneType::$variant => zone_domain!(@is_ground $class) ),+ }
            }

            /// USABLE — occupiable floor: everything that is neither ground nor
            /// service. The efficiency numerator's membership test.
            pub(crate) fn is_usable(self) -> bool {
                match self { $( ZoneType::$variant => zone_domain!(@is_usable $class) ),+ }
            }
        }
    };
    (@is_ground ground)  => { true };
    (@is_ground service) => { false };
    (@is_ground program) => { false };
    (@is_usable ground)  => { false };
    (@is_usable service) => { false };
    (@is_usable program) => { true };
}

zone_domain! {
    /// corridors / "walking place" — soft blue
    Circulation: ground,
    /// open desk field — pale cream/yellow
    Workspace: program,
    /// enclosed meeting room — pale lavender
    Meeting: program,
    /// breakout / lounge / open collab — pale green
    Collaboration: program,
    /// WC, stairs, lifts, MEP, service — light gray.
    ///
    /// `service`, not `program`: a core IS a real scheduled room (so it is not
    /// ground and it is named on drawings), but it is not USABLE area — that is
    /// the landlord/overhead half of the efficiency ratio.
    Core: service,
    /// private cellular office — pale peach/orange
    ClosedOffice: program,
    /// kitchen / cafe / reception — pale teal
    Amenity: program,
    /// Floor the generator could neither furnish nor justify as circulation:
    /// too narrow to host a code-width path, or sealed off from the walking
    /// network. **A finding, not a program.**
    ///
    /// It exists because conflating leftover residue with *circulation* told
    /// two lies at once: it inflated the Circulation row of the areas split,
    /// and it flattered efficiency by counting waste as a working corridor. On
    /// the reference plate that was 170.66 m² — 57.7% of everything the plan
    /// called circulation.
    ///
    /// **Editor-only in presentation, never a published line item.** No
    /// surveyed product (qbiq, Laiout, TestFit, Hypar, CBRE Plans) publishes a
    /// "dead space" category, and neither BOMA Z65.1 nor IPMS defines one —
    /// IPMS "Limited Use Areas" is about headroom and columns, not leftover
    /// pockets. So every export folds this back into Circulation; only the
    /// working surface shows it, where its whole job is to say *fix me*.
    Unassigned: ground,
}


/// Footprint shape. `Rect` is the v1 workhorse; `RectRing` models the perimeter
/// corridor (a rect with a rectangular hole); `Poly` is a boundary-conforming
/// filled simple polygon — a zone that hugs an angled/stepped wall edge-to-edge
/// (its wall-facing side follows the plate exactly, its other sides flex to
/// absorb it). Not `Copy`: `Poly` carries a `Vec`; sites clone/borrow instead.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind")]
pub enum ZoneShape {
    /// Filled axis-aligned rectangle, center-origin (matches Component).
    Rect { x: f64, y: f64, w: f64, h: f64 },
    /// Rectangular ring: outer rect minus inner rect (the perimeter corridor).
    /// Both center-origin and concentric; inner is fully contained in outer.
    RectRing {
        x: f64,
        y: f64,
        w: f64,
        h: f64,
        in_w: f64,
        in_h: f64,
    },
    /// Filled simple polygon in **world coordinates** (absolute meters, same
    /// units as `Rect`), CCW or CW winding. Built by clipping an expanded rect
    /// to the floor-plate polygon so its footprint reaches an irregular wall
    /// exactly, closing the triangular "wedge" gaps a rect leaves along a
    /// diagonal boundary. Editing ops (cut/merge/resize) reject `Poly` in v1.
    Poly { pts: Vec<[f64; 2]> },
}

impl ZoneShape {
    /// Net internal floor area of the shape, m².
    pub fn area(&self) -> f64 {
        match self {
            ZoneShape::Rect { w, h, .. } => w.max(0.0) * h.max(0.0),
            ZoneShape::RectRing { w, h, in_w, in_h, .. } => {
                (w.max(0.0) * h.max(0.0) - in_w.max(0.0) * in_h.max(0.0)).max(0.0)
            }
            ZoneShape::Poly { pts } => crate::geometry::polygon_area(&poly_points(pts)),
        }
    }

    /// Area clipped to the floor-plate polygon, m². Zone shapes stay
    /// rectangular even on an L-shaped plate (the model can't represent the
    /// notch), so honest metrics clip each shape against the plate before
    /// summing. With no plate (open walls) the full shape area is returned —
    /// identical for rectangular rooms, where shape ⊆ plate.
    pub fn area_on(&self, plate: Option<&[crate::geometry::Point]>) -> f64 {
        let Some(poly) = plate else { return self.area() };
        let clip = |x: f64, y: f64, w: f64, h: f64| {
            crate::geometry::rect_polygon_clip_area(
                poly,
                x - w / 2.0,
                y - h / 2.0,
                x + w / 2.0,
                y + h / 2.0,
            )
        };
        match self {
            ZoneShape::Rect { x, y, w, h } => clip(*x, *y, *w, *h),
            ZoneShape::RectRing { x, y, w, h, in_w, in_h } => {
                (clip(*x, *y, *w, *h) - clip(*x, *y, *in_w, *in_h)).max(0.0)
            }
            // A `Poly` is built by clipping to the plate, so it is already ⊆ plate
            // and its own polygon area is the plate-clipped area. Returning
            // `polygon_area` directly avoids a polygon-polygon clip against a
            // possibly-non-convex plate (Sutherland–Hodgman only clips against a
            // convex window). With no plate the raw area is likewise correct.
            ZoneShape::Poly { pts } => crate::geometry::polygon_area(&poly_points(pts)),
        }
    }

    /// **Every coordinate of this shape is a real number.**
    ///
    /// The predicate `resize_zone`'s bounds guard silently assumed. `NaN < x` and
    /// `NaN > x` are both false, so a shape of NaNs passed an `OutOfBounds` check
    /// written entirely in `<`/`>` — and then serialized as `{"x":null,…}`, which
    /// `from_snapshot` refuses with `invalid type: null, expected f64`. One edit
    /// produced a `.dsource` that saves and can never be reopened, so the
    /// finiteness question is asked here, once, in the shape's own vocabulary
    /// rather than re-spelled at each caller.
    pub fn is_finite(&self) -> bool {
        match self {
            ZoneShape::Rect { x, y, w, h } => {
                x.is_finite() && y.is_finite() && w.is_finite() && h.is_finite()
            }
            ZoneShape::RectRing { x, y, w, h, in_w, in_h } => {
                x.is_finite()
                    && y.is_finite()
                    && w.is_finite()
                    && h.is_finite()
                    && in_w.is_finite()
                    && in_h.is_finite()
            }
            ZoneShape::Poly { pts } => pts.iter().all(|p| p[0].is_finite() && p[1].is_finite()),
        }
    }

    /// Outer AABB `(min_x, min_y, max_x, max_y)` for hit-testing / tiling checks.
    pub fn bbox(&self) -> (f64, f64, f64, f64) {
        match self {
            ZoneShape::Rect { x, y, w, h }
            | ZoneShape::RectRing { x, y, w, h, .. } => {
                (x - w / 2.0, y - h / 2.0, x + w / 2.0, y + h / 2.0)
            }
            ZoneShape::Poly { pts } => {
                let (mut minx, mut miny, mut maxx, mut maxy) =
                    (f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY);
                for p in pts {
                    minx = minx.min(p[0]);
                    miny = miny.min(p[1]);
                    maxx = maxx.max(p[0]);
                    maxy = maxy.max(p[1]);
                }
                if pts.is_empty() {
                    (0.0, 0.0, 0.0, 0.0)
                } else {
                    (minx, miny, maxx, maxy)
                }
            }
        }
    }

    /// True if world point `(px,py)` is inside the filled region. For a
    /// `RectRing` the hole is excluded (a point in the central work zone is NOT
    /// in the perimeter corridor).
    pub fn contains(&self, px: f64, py: f64) -> bool {
        match self {
            ZoneShape::Rect { x, y, w, h } => {
                (px - x).abs() <= w / 2.0 && (py - y).abs() <= h / 2.0
            }
            ZoneShape::RectRing { x, y, w, h, in_w, in_h } => {
                let in_outer = (px - x).abs() <= w / 2.0 && (py - y).abs() <= h / 2.0;
                let in_hole = (px - x).abs() < in_w / 2.0 && (py - y).abs() < in_h / 2.0;
                in_outer && !in_hole
            }
            ZoneShape::Poly { pts } => {
                crate::geometry::point_in_polygon(px, py, &poly_points(pts))
            }
        }
    }
}

/// View a `Poly`'s `[x, y]` pairs as `geometry::Point`s (the geometry helpers
/// speak `Point`). Cheap allocation; polys are small (≤ ~12 pts).
fn poly_points(pts: &[[f64; 2]]) -> Vec<crate::geometry::Point> {
    pts.iter().map(|p| crate::geometry::Point::new(p[0], p[1])).collect()
}

/// room type, so renaming a drawn `Corridor` to `Circulation` silently
/// converted network into residual — and the next conform pass would melt it.
/// Phase 1 would have made that seam load-bearing across five consumers in
/// four files.
///
/// **`Residual` is generator-only.** No UI path and no wasm mutator may set
/// it; a zone a user draws, retypes or renames is always `Drawn`. That is what
/// keeps the discriminator meaning what it says.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum ZoneOrigin {
    /// Designed: the drawn corridor network, rooms, the desk field, keep-outs —
    /// and anything a user creates. The serde default, so a `.dsource` written
    /// before this field existed loads with every zone `Drawn`, which is the
    /// truth for those files: they predate the residual classifier.
    #[default]
    Drawn,
    /// Emitted by the generator's residual pass over floor nothing claimed.
    /// Carries [`ZoneType::Circulation`] or [`ZoneType::Unassigned`] depending
    /// on whether it can host a code-width path connected to the network.
    Residual,
}

/// A first-class region of the floor plate. `id` is stable across edits so the
/// AI and the frontend can address it ("merge 4 and 7"). Everything is meters.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Zone {
    pub id: u32,
    pub zone_type: ZoneType,
    pub shape: ZoneShape,
    /// Human/AI-facing name ("Open Workspace", "Meeting Room A").
    pub label: String,
    /// Ids of components whose center falls inside this zone (derived, cached on
    /// (re)assignment). Lets the AI answer "what's in this room".
    pub component_ids: Vec<u32>,
    /// Optional grouping tag for multi-rect (e.g. L-shaped) logical rooms.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group: Option<u32>,
    /// Designed, or left over? See [`ZoneOrigin`]. `#[serde(default)]` makes
    /// this additive: every `.dsource` written before the field existed loads
    /// with `Drawn`, byte-stably.
    #[serde(default)]
    pub origin: ZoneOrigin,
}

impl Zone {
    /// Net internal floor area, m².
    pub fn area(&self) -> f64 {
        self.shape.area()
    }

    /// Net internal floor area clipped to the plate polygon, m².
    /// See [`ZoneShape::area_on`].
    pub fn area_on(&self, plate: Option<&[crate::geometry::Point]>) -> f64 {
        self.shape.area_on(plate)
    }

    /// Nominal seated capacity by an area rule-of-thumb, per `ZoneType`. This is
    /// a *planning estimate* (area-based); the actual seated count is
    /// `component_ids` filtered to desks. Circulation and Core seat nobody.
    ///
    /// **It takes the area rather than measuring one (R17), and the parameter is
    /// the whole point.** This was `capacity(&self)` reading `self.area()` — the
    /// raw, unclipped shape — while the area printed beside it in the very same
    /// `ZoneStat` came from the core's basis. Live at HEAD on the unedited F1
    /// fixture, `Open Workspace (2)` published `area: 8.0, capacity: 5`: five
    /// workstations at a declared 6 m² each, inside eight square metres. The row
    /// contradicted itself, and `quantities()` billed the same pair.
    ///
    /// A quantity derived from a core-owned quantity has to be handed that
    /// quantity. The generator still passes `z.area()` at its two sites, and now
    /// it says so at the call site instead of getting the raw estimate silently
    /// from a method that decides for it.
    /// The seat estimate for an ORDERING or a generator heuristic — the raw
    /// shape's own area, named so the call site says which area it used.
    ///
    /// **Line A's naming discipline, kept in the merge.** A renamed the old
    /// `capacity()` to this "following the `rawShapeAreaForOrderingOnly`
    /// precedent: the previous name read like the published quantity and was
    /// twice mistaken for it." Line B's fix was the SIGNATURE — make the caller
    /// supply the area, so a published surface cannot get the raw one by
    /// accident. Both survive here because they solve different halves: B's
    /// parameter makes the wrong area impossible on published paths, A's name
    /// makes the right one legible on ordering paths.
    pub(crate) fn seat_estimate_for_ordering(&self) -> u32 {
        self.capacity_from_area(self.area())
    }

    pub fn capacity_from_area(&self, area: f64) -> u32 {
        let per = match self.zone_type {
            ZoneType::Workspace => 6.0,     // m² per workstation
            ZoneType::Meeting => 2.5,       // m² per seat
            ZoneType::Collaboration => 3.0, // m² per seat
            ZoneType::ClosedOffice => 9.0,  // 1–2 person cellular
            ZoneType::Amenity => 4.0,       // m² per seat
            // Circulation and Core seat nobody; Unassigned seats nobody BY
            // DEFINITION — it is floor the generator failed to use, and giving
            // it a nominal capacity would let waste inflate the headcount the
            // plan claims it can hold.
            //
            // This arm is a fourth spelling of `!is_usable_zone`, and it stays
            // spelled out ON PURPOSE: an exhaustive match is what makes a NEW
            // `ZoneType` a compile error here rather than a silent 0. Replacing
            // it with a derived early-return would trade that for an unreachable
            // branch, which R16 rules decorative coverage. Instead the two are
            // tied by a CHECK — `capacity_seats_nobody_exactly_where_the_usable_partition_does`
            // below — which reds if either side moves without the other.
            ZoneType::Circulation | ZoneType::Core | ZoneType::Unassigned => return 0,
        };
        (area / per).floor().max(0.0) as u32
    }
}

/// Typed failure reasons for zone ops, so the AI can report *why* an op can't
/// happen ("those two rooms aren't adjacent"). `Display` surfaces the reason to
/// the JS/AI layer through the wasm wrappers.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ZoneError {
    NotFound,
    NotMergeable,
    OutOfBounds,
    InvalidCut,
    /// A coordinate was NaN or ±∞. Its own variant rather than folded into
    /// `OutOfBounds`, because it is not a geometry complaint: a non-finite
    /// coordinate is not a shape in the wrong place, it is not a shape.
    NonFinite,
}

impl std::fmt::Display for ZoneError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let msg = match self {
            ZoneError::NotFound => "no zone with that id",
            ZoneError::NotMergeable => "those zones aren't adjacent",
            ZoneError::OutOfBounds => "that shape falls outside the floor plate",
            ZoneError::InvalidCut => "the cut line must be strictly inside the zone",
            ZoneError::NonFinite => "coordinates must be finite numbers",
        };
        f.write_str(msg)
    }
}

/// Cut direction for `split_zone`. `Vertical` cuts along a vertical line
/// (`at` = world x), producing left/right halves; `Horizontal` cuts along a
/// horizontal line (`at` = world y), producing top/bottom halves.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Axis {
    Vertical,
    Horizontal,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rect_area_and_contains() {
        let s = ZoneShape::Rect { x: 5.0, y: 5.0, w: 4.0, h: 2.0 };
        assert!((s.area() - 8.0).abs() < 1e-9);
        assert!(s.contains(5.0, 5.0));
        assert!(s.contains(6.9, 5.9));
        assert!(!s.contains(7.1, 5.0));
        assert_eq!(s.bbox(), (3.0, 4.0, 7.0, 6.0));
    }

    #[test]
    fn ring_area_excludes_hole() {
        // 10×10 outer, 6×6 hole → 100 − 36 = 64 m².
        let s = ZoneShape::RectRing {
            x: 0.0, y: 0.0, w: 10.0, h: 10.0, in_w: 6.0, in_h: 6.0,
        };
        assert!((s.area() - 64.0).abs() < 1e-9);
        // Point in the ring band.
        assert!(s.contains(4.0, 0.0));
        // Point in the central hole is NOT in the corridor.
        assert!(!s.contains(0.0, 0.0));
        // Point outside the outer rect.
        assert!(!s.contains(6.0, 0.0));
    }

    #[test]
    fn poly_area_contains_and_bbox() {
        // A right-triangle footprint (legs 4): area 8, bbox the full leg span.
        let s = ZoneShape::Poly { pts: vec![[0.0, 0.0], [4.0, 0.0], [0.0, 4.0]] };
        assert!((s.area() - 8.0).abs() < 1e-9);
        // area_on with no plate == raw polygon area (a Poly is built ⊆ plate).
        assert!((s.area_on(None) - 8.0).abs() < 1e-9);
        assert_eq!(s.bbox(), (0.0, 0.0, 4.0, 4.0));
        assert!(s.contains(1.0, 1.0)); // inside the triangle
        assert!(!s.contains(3.0, 3.0)); // beyond the hypotenuse x + y = 4
        assert!(!s.contains(-1.0, 1.0));
    }

    #[test]
    fn poly_area_equals_clipped_polygon_area() {
        // A Poly built by clipping a rect to a diagonal plate reports exactly the
        // clipped polygon's area (the boundary-conforming invariant).
        let tri: Vec<crate::geometry::Point> = [(0.0, 0.0), (10.0, 0.0), (0.0, 10.0)]
            .iter()
            .map(|&(x, y)| crate::geometry::Point::new(x, y))
            .collect();
        let clipped = crate::geometry::clip_rect_to_polygon(&tri, 0.0, 0.0, 8.0, 8.0);
        let pts: Vec<[f64; 2]> = clipped.iter().map(|p| [p.x, p.y]).collect();
        let s = ZoneShape::Poly { pts };
        assert!((s.area() - crate::geometry::polygon_area(&clipped)).abs() < 1e-12);
        assert!((s.area() - 46.0).abs() < 1e-9);
    }

    /// **The rate table's zero-set IS the usable partition.**
    ///
    /// `capacity_from_area` spells `Circulation | Core | Unassigned => 0` for
    /// exhaustiveness (a new ZoneType must not compile), so that list is a
    /// fourth copy of a set `is_usable_zone` already owns. Nothing made them
    /// move together — and this is the private-definition class, which has now
    /// fired three times in this codebase. This is the tie.
    ///
    /// It is falsifiable in both directions: drop a type from the match's zero
    /// arm, or from `is_usable_zone`, and it reds.
    /// The variant domain, DERIVED — `ZoneType::ALL`, whose completeness is
    /// proved by `index_in_all`. This was a hand-written array here with a
    /// comment claiming the neighbouring match kept it complete; it did not, and
    /// a ninth variant left both guards below grading 8 of 9 types in silence.
    use super::ZoneType as ZT;
    const ALL_ZONE_TYPES: &[ZoneType] = ZT::ALL;

    /// **GROUND IS NEVER USABLE — a GUARD (R16), with its construction proof.**
    ///
    /// It cannot fail today because `is_usable_zone` is literally
    /// `!is_ground_zone(t) && t != Core`, so the implication is the definition.
    /// It is recorded as a guard rather than dropped because it is what makes
    /// the derivation SAFE to rely on: break the derivation — restore
    /// `!matches!(t, Circulation | Core | Unassigned)` — and this becomes
    /// falsifiable the instant the fold gains a type.
    ///
    /// **Why it is here at all**, stated as the null result that produced it:
    /// folding `Core` into the published ground set in a sabotage worktree left
    /// `cargo test` at **199 green**. The change was real — `is_ground_zone(Core)`
    /// went false → true, measured by probe — and every Rust consumer followed
    /// automatically, but NOTHING IN THE RUST SUITE OBSERVED IT. The only red
    /// was the TypeScript mirror (`coreParity`). A change that propagates
    /// correctly and invisibly is still a change nobody would see on this side.
    #[test]
    fn ground_is_never_usable() {
        for &t in ALL_ZONE_TYPES {
            assert!(
                !(crate::is_ground_zone(t) && crate::is_usable_zone(t)),
                "{t:?} is both ground and usable — the two partitions have come \
                 apart, which is what `is_usable_zone` deriving from \
                 `is_ground_zone` exists to prevent"
            );
        }
        // Non-vacuity: the ground set is non-empty and is not everything.
        let n = ALL_ZONE_TYPES.iter().filter(|t| crate::is_ground_zone(**t)).count();
        assert!(
            n > 0 && n < ALL_ZONE_TYPES.len(),
            "the ground set is {n} of {} types — a partition check over an empty \
             or total set is green for the wrong reason",
            ALL_ZONE_TYPES.len()
        );
    }

    #[test]
    fn capacity_seats_nobody_exactly_where_the_usable_partition_does() {
        for &t in ALL_ZONE_TYPES {
            let z = Zone {
                id: 1,
                zone_type: t,
                label: String::new(),
                shape: ZoneShape::Rect { x: 0.0, y: 0.0, w: 10.0, h: 10.0 },
                component_ids: Vec::new(),
                group: None,
                origin: ZoneOrigin::default(),
            };
            let seats_nobody = z.capacity_from_area(100.0) == 0;
            assert_eq!(
                seats_nobody,
                !crate::is_usable_zone(t),
                "{t:?}: capacity_from_area says seats_nobody={seats_nobody}, but \
                 is_usable_zone says usable={} — the rate table and the usable \
                 partition disagree about the same set",
                crate::is_usable_zone(t)
            );
        }
    }

    #[test]
    fn capacity_rules() {
        let mk = |t: ZoneType, w: f64, h: f64| Zone {
            id: 1,
            zone_type: t,
            shape: ZoneShape::Rect { x: 0.0, y: 0.0, w, h },
            label: String::new(),
            component_ids: Vec::new(),
            group: None,
            origin: Default::default(),
        };
        // 60 m² Workspace / 6 = 10.
        assert_eq!(mk(ZoneType::Workspace, 10.0, 6.0).capacity_from_area(60.0), 10);
        // Circulation / Core always 0.
        assert_eq!(mk(ZoneType::Circulation, 10.0, 6.0).capacity_from_area(60.0), 0);
        assert_eq!(mk(ZoneType::Core, 10.0, 6.0).capacity_from_area(60.0), 0);
    }
}
