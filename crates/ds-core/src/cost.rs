//! Indicative fit-out **cost** and embodied **carbon** for a tiled floor plate.
//!
//! Both are computed as `Σ (zone.area() × per-m² rate)`, bucketed by `ZoneType`.
//! The constants below are **indicative planning figures**, not quotes — they
//! give the Statistics panel and (later) the consequence engine a consistent,
//! explainable order-of-magnitude that moves the right direction when zones
//! change. The UI owns the "indicative" caveat label.
//!
//! Rates are rough industry order-of-magnitude:
//!   - Cost: category-B office fit-out commonly ~£/$ 1–2.5k per m², higher for
//!     serviced/enclosed rooms and amenities, near-nil for bare circulation.
//!   - Carbon: fit-out embodied carbon commonly ~100–400 kgCO2e/m² depending on
//!     partitioning, joinery and services density.
//! They are deliberately tunable in one place; Slice 8's consequence engine
//! reuses this module verbatim (no second copy).

use crate::document::Document;
use crate::zone::ZoneType;

/// Indicative fit-out cost, currency-units per m², by zone purpose.
fn cost_rate(t: ZoneType) -> f64 {
    match t {
        ZoneType::Circulation => 400.0,   // finishes only, minimal fit-out
        ZoneType::Workspace => 1_200.0,   // open desk field: power/data, flooring
        ZoneType::Meeting => 2_000.0,     // enclosed: partitions, AV, glazing
        ZoneType::Collaboration => 1_500.0,
        ZoneType::Core => 2_500.0,        // WCs / MEP / risers: services-heavy
        ZoneType::ClosedOffice => 1_800.0,
        ZoneType::Amenity => 2_200.0,     // kitchen / cafe: plumbing, equipment
    }
}

/// Indicative embodied carbon, kgCO2e per m², by zone purpose.
fn carbon_rate(t: ZoneType) -> f64 {
    match t {
        ZoneType::Circulation => 60.0,
        ZoneType::Workspace => 150.0,
        ZoneType::Meeting => 280.0,
        ZoneType::Collaboration => 200.0,
        ZoneType::Core => 350.0,
        ZoneType::ClosedOffice => 260.0,
        ZoneType::Amenity => 320.0,
    }
}

/// Total indicative fit-out cost of the document's zones (currency units).
/// Areas are clipped to the plate polygon — an L-shaped plate is priced on
/// the space that exists, not its bounding box.
pub fn indicative_cost(doc: &Document) -> f64 {
    let plate = doc.plate_polygon();
    let plate_ref = plate.as_deref();
    doc.zones
        .iter()
        .map(|z| z.area_on(plate_ref) * cost_rate(z.zone_type))
        .sum()
}

/// Total indicative embodied carbon of the document's zones (kgCO2e).
/// Plate-clipped like [`indicative_cost`].
pub fn indicative_carbon(doc: &Document) -> f64 {
    let plate = doc.plate_polygon();
    let plate_ref = plate.as_deref();
    doc.zones
        .iter()
        .map(|z| z.area_on(plate_ref) * carbon_rate(z.zone_type))
        .sum()
}
