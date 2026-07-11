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
    pub decision: DecisionState,
}

#[cfg(test)]
mod tests {
    use super::*;

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
            decision: DecisionState::Open,
        };
        let json = serde_json::to_string(&door).unwrap();
        let back: Component = serde_json::from_str(&json).unwrap();
        assert!(back.mirror, "mirror survives the round-trip");
        assert!(back.reference, "reference survives the round-trip");
        assert_eq!(back.category, "Door");
    }
}
