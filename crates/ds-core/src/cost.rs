//! Indicative fit-out **cost** and embodied **carbon** for a tiled floor plate.
//!
//! Both are computed as `Σ (zone.area() × per-m² rate)`, bucketed by `ZoneType`.
//! The constants below are **indicative planning figures**, not quotes — they
//! give the Statistics panel and (later) the consequence engine a consistent,
//! explainable order-of-magnitude that moves the right direction when zones
//! change. The UI owns the "indicative" caveat label.
//!
//! Rates are calibrated for the **Indian commercial fit-out market (₹, INR)**:
//!   - Cost: Indian industry norm quotes ₹/sqft; we convert ×10.764 to ₹/m².
//!     Mid-spec (cat-B equivalent) office fit-out in India runs roughly
//!     ₹1,600–2,600/sqft all-in (~₹17k–28k/m²) — open workspace at the low end,
//!     meeting/conference above it (AV + acoustics), amenity/cafeteria high
//!     (plumbing + kitchen equipment), core/service low because WCs/MEP/risers
//!     are largely base-build (landlord) scope, and bare circulation near-nil.
//!   - Carbon: cat-B fit-out embodied carbon commonly ~100–400 kgCO2e/m²
//!     (LETI / RICS fit-out benchmarks) depending on partitioning, joinery and
//!     services density; the Indian material mix is comparable in magnitude.
//! They are deliberately tunable in one place; Slice 8's consequence engine
//! reuses this module verbatim (no second copy).

use crate::document::Document;
use crate::zone::ZoneType;

/// Indicative fit-out cost, **₹ (INR) per m²**, by zone purpose.
/// Each rate is a ₹/sqft ballpark × 10.764, rounded to a planning figure.
fn cost_rate(t: ZoneType) -> f64 {
    match t {
        ZoneType::Circulation => 6_000.0, // ~₹560/sqft: finishes + lighting only
        ZoneType::Workspace => 15_000.0,  // ~₹1,400/sqft: open desk field — flooring, power/data, loose furniture
        ZoneType::Meeting => 26_000.0,    // ~₹2,400/sqft: enclosed — partitions, glazing, AV, acoustics
        ZoneType::Collaboration => 18_500.0, // ~₹1,700/sqft: semi-open — soft seating, writable walls
        ZoneType::Core => 9_500.0,        // ~₹880/sqft: WCs/MEP/risers mostly landlord scope; tenant finish only
        ZoneType::ClosedOffice => 21_500.0, // ~₹2,000/sqft: full-height partitions, dedicated HVAC/lighting
        ZoneType::Amenity => 28_000.0,    // ~₹2,600/sqft: cafeteria/kitchen — plumbing, equipment, ventilation
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

/// Total indicative fit-out cost of the document's zones (**₹, INR**).
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

/// Σ observed prices of bank-bound components (₹ INR). This is *specified
/// furniture capex* — reported as its own metrics line, NOT folded into
/// [`indicative_cost`], whose zone rates already include a generic loose-
/// furniture allowance (adding both would double-count).
pub fn specified_cost(doc: &Document) -> f64 {
    doc.components.iter().filter_map(|c| c.price_inr).sum()
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
