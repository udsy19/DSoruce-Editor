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

/// Semantic purpose of a region of the floor plate. Drives the pastel fill, the
/// capacity model, and the Statistics donut bucket. String-tag serde repr so the
/// TS/AI side speaks the same vocabulary ("Meeting", not `2`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum ZoneType {
    Circulation,   // corridors / "walking place"      → soft blue
    Workspace,     // open desk field                   → pale cream/yellow
    Meeting,       // enclosed meeting room             → pale lavender
    Collaboration, // breakout / lounge / open collab   → pale green
    Core,          // WC, stairs, lifts, MEP, service   → light gray
    ClosedOffice,  // private cellular office           → pale peach/orange
    Amenity,       // kitchen / cafe / reception        → pale teal
}

/// Footprint shape. `Rect` is the v1 workhorse; `RectRing` models the perimeter
/// corridor (a rect with a rectangular hole) without a polygon library.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
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
}

impl ZoneShape {
    /// Net internal floor area of the shape, m².
    pub fn area(&self) -> f64 {
        match *self {
            ZoneShape::Rect { w, h, .. } => w.max(0.0) * h.max(0.0),
            ZoneShape::RectRing { w, h, in_w, in_h, .. } => {
                (w.max(0.0) * h.max(0.0) - in_w.max(0.0) * in_h.max(0.0)).max(0.0)
            }
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
        match *self {
            ZoneShape::Rect { x, y, w, h } => clip(x, y, w, h),
            ZoneShape::RectRing { x, y, w, h, in_w, in_h } => {
                (clip(x, y, w, h) - clip(x, y, in_w, in_h)).max(0.0)
            }
        }
    }

    /// Outer AABB `(min_x, min_y, max_x, max_y)` for hit-testing / tiling checks.
    pub fn bbox(&self) -> (f64, f64, f64, f64) {
        match *self {
            ZoneShape::Rect { x, y, w, h }
            | ZoneShape::RectRing { x, y, w, h, .. } => {
                (x - w / 2.0, y - h / 2.0, x + w / 2.0, y + h / 2.0)
            }
        }
    }

    /// True if world point `(px,py)` is inside the filled region. For a
    /// `RectRing` the hole is excluded (a point in the central work zone is NOT
    /// in the perimeter corridor).
    pub fn contains(&self, px: f64, py: f64) -> bool {
        match *self {
            ZoneShape::Rect { x, y, w, h } => {
                (px - x).abs() <= w / 2.0 && (py - y).abs() <= h / 2.0
            }
            ZoneShape::RectRing { x, y, w, h, in_w, in_h } => {
                let in_outer = (px - x).abs() <= w / 2.0 && (py - y).abs() <= h / 2.0;
                let in_hole = (px - x).abs() < in_w / 2.0 && (py - y).abs() < in_h / 2.0;
                in_outer && !in_hole
            }
        }
    }
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
    pub fn capacity(&self) -> u32 {
        let per = match self.zone_type {
            ZoneType::Workspace => 6.0,     // m² per workstation
            ZoneType::Meeting => 2.5,       // m² per seat
            ZoneType::Collaboration => 3.0, // m² per seat
            ZoneType::ClosedOffice => 9.0,  // 1–2 person cellular
            ZoneType::Amenity => 4.0,       // m² per seat
            ZoneType::Circulation | ZoneType::Core => return 0,
        };
        (self.area() / per).floor().max(0.0) as u32
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
}

impl std::fmt::Display for ZoneError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let msg = match self {
            ZoneError::NotFound => "no zone with that id",
            ZoneError::NotMergeable => "those zones aren't adjacent",
            ZoneError::OutOfBounds => "that shape falls outside the floor plate",
            ZoneError::InvalidCut => "the cut line must be strictly inside the zone",
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
    fn capacity_rules() {
        let mk = |t: ZoneType, w: f64, h: f64| Zone {
            id: 1,
            zone_type: t,
            shape: ZoneShape::Rect { x: 0.0, y: 0.0, w, h },
            label: String::new(),
            component_ids: Vec::new(),
            group: None,
        };
        // 60 m² Workspace / 6 = 10.
        assert_eq!(mk(ZoneType::Workspace, 10.0, 6.0).capacity(), 10);
        // Circulation / Core always 0.
        assert_eq!(mk(ZoneType::Circulation, 10.0, 6.0).capacity(), 0);
        assert_eq!(mk(ZoneType::Core, 10.0, 6.0).capacity(), 0);
    }
}
