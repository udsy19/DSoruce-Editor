//! The core domain model.
//!
//! A placed `Component` is the "one object, four facets" entity from the research
//! (`research/07-synthesis-and-proposed-pipeline.md`):
//!   1. geometry      — x/y/w/h/rotation
//!   2. semantics     — `category` (drives the re-imagine panel)
//!   3. product bind  — `product_id` (+ label) from the material bank
//!   4. decision      — `decision` lifecycle state

use crate::geometry::Point;
use serde::{Deserialize, Serialize};

/// Selection/approval lifecycle, mirroring Materio's open → in-review → confirmed.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq)]
pub enum DecisionState {
    Open,
    InReview,
    Confirmed,
}

impl DecisionState {
    pub fn from_str(s: &str) -> DecisionState {
        match s {
            "InReview" => DecisionState::InReview,
            "Confirmed" => DecisionState::Confirmed,
            _ => DecisionState::Open,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Wall {
    pub id: u32,
    pub a: Point,
    pub b: Point,
    /// meters
    pub thickness: f64,
    /// Emitted by the test-fit generator (room partitions/glass fronts).
    /// `generate()` clears and re-emits these every run; user-drawn and
    /// imported walls stay `false` and are never touched. `serde(default)`
    /// keeps pre-M1 snapshots loading unchanged.
    #[serde(default)]
    pub generated: bool,
    /// Glazed partition (a meeting room's corridor-facing glass front).
    /// Renders as the triple-line window convention in 2D and translucent
    /// glass in 3D. Independent of `generated` so imported glazing can use it.
    #[serde(default)]
    pub glazing: bool,
    /// **Partial-height** partition, meters. `None` (the default, and what every
    /// generator/import path writes) means the wall runs full storey height
    /// ([`FULL_WALL_HEIGHT_M`]). A `Some(h)` with `h < FULL_WALL_HEIGHT_M` is a
    /// half-height screen — the qbiq legend's "Half Drywall" — and is the ONLY
    /// way that quantity category becomes non-zero (see `quantity::classify_wall`).
    /// `serde(default)` + `skip_serializing_if` keep pre-B1 `.dsource` snapshots
    /// loading AND keep unset walls byte-identical on the wire, preserving the
    /// additive-schema guarantee asserted by `wall_flags_default_false_and_round_trip`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub height_m: Option<f64>,
}

/// Full storey height of a wall, meters — the single height assumption behind
/// every `length × height` wall-area quantity. Matches `WALL_HEIGHT` in
/// `web/src/three/Viewer3D.ts`, so the 2D takeoff and the 3D model agree.
pub const FULL_WALL_HEIGHT_M: f64 = 2.6;

impl Wall {
    /// Centerline length, meters.
    pub fn length(&self) -> f64 {
        self.a.dist(&self.b)
    }

    /// Effective height, meters: the explicit `height_m` when set, else the full
    /// storey height.
    pub fn height(&self) -> f64 {
        self.height_m.unwrap_or(FULL_WALL_HEIGHT_M)
    }

    /// True when this wall is a partial-height screen (explicitly shorter than
    /// the full storey height).
    pub fn is_partial_height(&self) -> bool {
        matches!(self.height_m, Some(h) if h < FULL_WALL_HEIGHT_M - 1e-9)
    }
}

/// A permanent interior **keep-out**: the building core (stairs, lifts, shafts,
/// WCs) that the traced plate now includes but that can never hold furniture.
/// Center-based like `Component`. Keep-outs are hard obstacles the generator
/// always avoids (independent of the freeze state) and surface as `Core` zones.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct KeepOut {
    pub id: u32,
    /// center position, meters
    pub x: f64,
    pub y: f64,
    /// footprint, meters
    pub w: f64,
    pub h: f64,
    pub label: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Component {
    pub id: u32,
    /// e.g. "Desk", "Chair", "Table", "MeetingRoom", "FallCeiling"
    pub category: String,
    /// center position, meters
    pub x: f64,
    pub y: f64,
    /// footprint, meters
    pub w: f64,
    pub h: f64,
    /// radians
    pub rotation: f64,
    /// Hinge handedness: reflect the symbol across its own long (local-x) axis.
    /// Only doors carry a meaningful mirror — a left- vs right-hand swing that
    /// `rotation` alone can't express (see `web/src/editor/furniture.ts`). Every
    /// other category is left-right symmetric, so `mirror` is a no-op there.
    /// `serde(default)` keeps pre-mirror snapshots + every non-setting caller at
    /// `false`, so old `.dsource` blobs and the generator are unaffected.
    #[serde(default)]
    pub mirror: bool,
    /// **Passive reference** facet (Laiout parity, see `docs/design/laiout-deep-research.md`).
    /// `true` = imported/legacy CAD furniture that is drawn for context but is NOT
    /// part of the generated fit-out: it is EXCLUDED from every count (workstations,
    /// pax, cost, CO2). Only generated/placed content (`false`) counts. `serde(default)`
    /// false keeps every pre-M snapshot, the generator, and `add_component` unaffected.
    #[serde(default)]
    pub reference: bool,
    pub label: String,
    /// bound product from the material bank (None until re-imagined)
    pub product_id: Option<String>,
    /// observed price of the bound product, ₹ INR (None = unbound or the
    /// supplier publishes no price). `default` keeps old snapshots readable.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub price_inr: Option<f64>,
    /// **How many people sit AT this object** — a facet of the object, resolved
    /// once HERE where it is created and then only ever read (see
    /// `docs/design/ui-system.md` §3.6).
    ///
    /// This exists because the renderer used to derive a table's chair count
    /// from its size **in screen pixels**, so the same table drew 0 chairs at
    /// 20 px/m, 6 at 45 and 10 at 110 — the drawing contradicted its own room
    /// tag at every zoom but one. Seat count is not a property of the zoom
    /// level; it is a property of the table.
    ///
    /// NOT the same quantity as a room's `Zone::capacity_from_area()`, which is
    /// an area rule-of-thumb for the ROOM. A tag never counts chairs and a glyph
    /// never renders room pax; they are different facts about different things.
    ///
    /// (F5) This read `Zone::capacity_on()` until now — Line A's name for the
    /// same method, RETIRED in the merge in favour of Line B's
    /// `capacity_from_area`. The merge adopted B's signature and left A's name
    /// standing in this one doc comment, so the tree named a method that exists
    /// nowhere in it. Doc-comment only: `capacity_on` has no code path here,
    /// which is exactly why nothing caught it — `rustc` does not resolve names
    /// inside `///`, and an intra-doc link would have.
    ///
    /// 0 = seats nobody (a door, a column, casework). `serde(default)` keeps
    /// every pre-seats snapshot and `.dsource` blob readable.
    #[serde(default)]
    pub seats: u32,
    pub decision: DecisionState,
}

/// Centre-to-centre spacing of people seated side by side, in meters. A chair
/// plus elbow room; the standard planning figure for table seating.
pub const SEAT_PITCH_M: f64 = 0.65;
/// A table end narrower than this can't seat anyone across it, so no head seats.
const HEAD_SEAT_MIN_M: f64 = 0.8;

/// How many people a component of this category and WORLD footprint seats.
///
/// The single resolver for {@link Component::seats}, called wherever a component
/// is created — the generator, the wasm `add_component` boundary, and (mirrored)
/// the TS importer's `normalizeFurniture`. Because it takes meters and never
/// pixels, the answer is the same at every zoom level, which is the whole point.
pub fn seats_for(category: &str, w: f64, h: f64) -> u32 {
    match category {
        // One person per desk / per chair, regardless of size.
        "Desk" | "Chair" => 1,
        // Perimeter seating: a run of people down each long side, plus one at
        // each end if the table is deep enough to seat across.
        "Table" | "MeetingRoom" => {
            let long = w.max(h);
            let short = w.min(h);
            if !(long > 0.0) || !(short > 0.0) {
                return 0;
            }
            let per_side = (long / SEAT_PITCH_M).floor().max(0.0) as u32;
            let heads = if short >= HEAD_SEAT_MIN_M { 2 } else { 0 };
            per_side * 2 + heads
        }
        _ => 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Seat count must depend ONLY on world size — never on a view. These are the
    /// real footprints the generator emits, and the numbers must hold forever.
    #[test]
    fn seats_are_a_property_of_the_object() {
        assert_eq!(seats_for("Desk", 1.4, 0.7), 1);
        assert_eq!(seats_for("Chair", 0.5, 0.5), 1);
        // The 1.2 x 0.6 m table from the real generated plan: a 2-person table.
        // The renderer used to draw 0, 6, 8 or 10 chairs for this exact object
        // depending on the zoom level.
        assert_eq!(seats_for("Table", 1.2, 0.6), 2);
        // Deep enough to seat across the ends.
        assert_eq!(seats_for("Table", 1.2, 0.9), 4);
        // A boardroom table.
        assert_eq!(seats_for("Table", 4.5, 2.5), 14);
        // Orientation must not matter.
        assert_eq!(seats_for("Table", 2.5, 4.5), seats_for("Table", 4.5, 2.5));
        // Things nobody sits at.
        assert_eq!(seats_for("Door", 0.9, 0.15), 0);
        assert_eq!(seats_for("Column", 0.4, 0.4), 0);
        assert_eq!(seats_for("Furniture", 1.8, 0.5), 0);
        // Degenerate footprints never panic or produce nonsense.
        assert_eq!(seats_for("Table", 0.0, 0.0), 0);
    }

    /// `seats` is additive: every pre-seats snapshot must still deserialize.
    #[test]
    fn seats_defaults_to_zero_on_old_snapshots() {
        let old = r#"{"id":3,"category":"Table","x":1.0,"y":2.0,"w":1.2,"h":0.6,
            "rotation":0.0,"label":"Table 3","product_id":null,"decision":"Open"}"#;
        let c: Component = serde_json::from_str(old).expect("pre-seats component must parse");
        assert_eq!(c.seats, 0, "missing `seats` defaults to 0");
    }

    /// …and a load BACKFILLS it, so a plan saved before the facet reports the
    /// same pax as an identical plan generated today. Without this, an existing
    /// library would reopen on the old area rule-of-thumb while new plans used
    /// furniture seats — the same building reading two ways.
    #[test]
    fn backfill_resolves_seats_on_an_old_document() {
        let old = r#"{
            "walls":[],
            "components":[
                {"id":1,"category":"Table","x":0,"y":0,"w":2.4,"h":3.3,"rotation":0,
                 "label":"Table 1","product_id":null,"decision":"Open"},
                {"id":2,"category":"Desk","x":5,"y":0,"w":1.4,"h":0.7,"rotation":0,
                 "label":"Desk 2","product_id":null,"decision":"Open"},
                {"id":3,"category":"Door","x":9,"y":0,"w":0.9,"h":0.15,"rotation":0,
                 "label":"Door 3","product_id":null,"decision":"Open"}
            ],
            "zones":[],"keepouts":[],"entries":[],"selection":null,"next_id":4
        }"#;
        let mut doc: crate::document::Document =
            serde_json::from_str(old).expect("pre-seats document must parse");
        assert!(doc.components.iter().all(|c| c.seats == 0), "loads at 0");

        doc.backfill_seats();
        // 2.4 x 3.3 m: floor(3.3 / 0.65) = 5 a side, + 2 heads = 12. This is the
        // real boardroom table the generator emits on the sample plate.
        assert_eq!(doc.components[0].seats, 12, "boardroom table resolved");
        assert_eq!(doc.components[1].seats, 1, "desk resolved");
        assert_eq!(doc.components[2].seats, 0, "nobody sits at a door");

        // Idempotent: re-running must never inflate an already-resolved doc.
        let before: Vec<u32> = doc.components.iter().map(|c| c.seats).collect();
        doc.backfill_seats();
        let after: Vec<u32> = doc.components.iter().map(|c| c.seats).collect();
        assert_eq!(before, after, "backfill is idempotent");
    }

    /// Pre-M1 snapshots carry walls WITHOUT the `generated`/`glazing` flags —
    /// they must deserialize (flags default false), and a full round-trip must
    /// preserve explicitly set flags. This is the additive-schema guarantee.
    #[test]
    fn wall_flags_default_false_and_round_trip() {
        // Byte-for-byte what pre-M1 builds serialized: no flag fields at all.
        let old = r#"{"id":7,"a":{"x":0.0,"y":0.0},"b":{"x":4.0,"y":0.0},"thickness":0.1}"#;
        let w: Wall = serde_json::from_str(old).expect("old wall JSON must parse");
        assert!(!w.generated, "missing `generated` defaults to false");
        assert!(!w.glazing, "missing `glazing` defaults to false");

        // Round-trip with the flags set: nothing is lost.
        let glass = Wall {
            id: 8,
            a: Point::new(0.0, 0.0),
            b: Point::new(3.0, 0.0),
            thickness: 0.05,
            generated: true,
            glazing: true,
            height_m: None,
        };
        let json = serde_json::to_string(&glass).unwrap();
        let back: Wall = serde_json::from_str(&json).unwrap();
        assert!(back.generated && back.glazing, "flags survive the round-trip");
        assert_eq!(back.id, 8);
        assert!((back.thickness - 0.05).abs() < 1e-12);
    }

    /// Pre-mirror snapshots carry components WITHOUT the `mirror` flag — they must
    /// deserialize (flag defaults false), and a component with `mirror: true` (an
    /// imported door's recovered hinge hand) must survive a full round-trip.
    #[test]
    fn component_mirror_defaults_false_and_round_trips() {
        // A component blob exactly as pre-mirror builds serialized it: no `mirror`.
        let old = r#"{"id":3,"category":"Desk","x":1.0,"y":2.0,"w":1.4,"h":0.7,
            "rotation":0.0,"label":"Desk 3","product_id":null,"decision":"Open"}"#;
        let c: Component = serde_json::from_str(old).expect("old component JSON must parse");
        assert!(!c.mirror, "missing `mirror` defaults to false");
        assert!(!c.reference, "missing `reference` defaults to false (counts by default)");

        // A left-hand door round-trips with its recovered hinge hand intact, and an
        // imported REFERENCE desk round-trips carrying its non-counted flag.
        let door = Component {
            id: 9,
            category: "Door".to_string(),
            x: 4.0,
            y: 5.0,
            w: 0.9,
            h: 0.15,
            rotation: std::f64::consts::FRAC_PI_2,
            mirror: true,
            reference: true,
            label: "Door 9".to_string(),
            product_id: None,
            price_inr: None,
            seats: 0, // test fixture: seat count is irrelevant to what these assert
            decision: DecisionState::Open,
        };
        let json = serde_json::to_string(&door).unwrap();
        let back: Component = serde_json::from_str(&json).unwrap();
        assert!(back.mirror, "mirror survives the round-trip");
        assert!(back.reference, "reference survives the round-trip");
        assert_eq!(back.category, "Door");
    }
}
