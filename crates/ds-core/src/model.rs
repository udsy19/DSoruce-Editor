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
    pub label: String,
    /// bound product from the material bank (None until re-imagined)
    pub product_id: Option<String>,
    /// observed price of the bound product, ₹ INR (None = unbound or the
    /// supplier publishes no price). `default` keeps old snapshots readable.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub price_inr: Option<f64>,
    pub decision: DecisionState,
}
