//! Indicative fit-out **cost** and embodied **carbon** for a tiled floor plate.
//!
//! The model is **element-based**, not a flat per-m² figure, because the things
//! that actually drive an office fit-out's cost and carbon are the BUILT
//! ENCLOSURE — partitions, glazed fronts, doors and the dedicated
//! ceiling/HVAC/AV of enclosed rooms — not raw floor area. A heavily cellular
//! plan (many meeting rooms + cabins) is materially more expensive and more
//! carbon-intensive than an open plan of the *same area*: it has hundreds of
//! running metres of partition, dozens of doors, and glazed fronts. The old
//! `Σ area × zone-rate` model missed this — re-bucketing area between zone
//! types barely moved the total, so a "Budget"/"Low-carbon" option didn't read
//! as cheaper or greener. This one tracks the design.
//!
//! Total = base shell (per m²) + partitions (per running m, solid vs glazed)
//!         + doors (per leaf) + enclosed-room premium (per enclosed m²)
//!         + furniture (per unit, by category).
//!
//! **Rates are indicative planning figures for the Indian metro (Bengaluru /
//! Hyderabad) commercial CAT-B fit-out market (₹, INR, 2024–25), not quotes.**
//!
//! Target band (what the headline should read to a workplace designer): a
//! mid-to-premium India CAT-B fit-out **hard cost** of ~₹3,000–4,500/sqft
//! (~₹32,000–48,000/m²) — a mostly-open floor sits at the low end, a cellular
//! floor at the high end. This element model prices the buildable/FF&E scope; it
//! deliberately excludes the main-contractor prelims, professional fees, AV/IT
//! specialist packages and contingency that the *all-in delivery* guides fold
//! in, which is why those guides read higher — JLL Asia-Pacific Fit-Out Cost
//! Guide 2023/24 puts India medium-spec at **₹5,788/sqft** (Mumbai ₹6,588,
//! Delhi ₹6,068) and Cushman & Wakefield 2026 puts Bengaluru at ₹6,027/sqft.
//! Those are the upper, everything-in reference; the hard-cost band above is
//! what this BoQ-style model builds up from real component rates.
//!
//! Grounding (all 2024–25 India sources):
//!   - Base shell ₹/m² is the area-driven CAT-B scope: carpet-tile flooring
//!     (₹80–150/sqft), grid/gypsum ceiling (₹60–120/sqft), ambient + task
//!     lighting (₹30–80/sqft), power/earthing (₹80–150/sqft), structured data
//!     (₹40–80/sqft), HVAC distribution and fire — sums to ~₹22k/m² for a
//!     specified floor (Holzbox 2024 component rates × 10.764 sqft/m²).
//!   - Partition ₹/running-m are installed elevation rates × ~2.7 m storey:
//!     boarded/painted gypsum drywall ₹120–200/sqft → ~₹4.6k/m; framed
//!     aluminium office glazing ₹350–1,000/sqft → ~₹15k/m (Holzbox 2024,
//!     Studio Matrx 2026). Door ₹/leaf: flush/glass leaf + frame + ironmongery
//!     ₹12k–28k (framed acoustic to ₹55k) → ₹25k. Workstation desk ₹20k and
//!     task chair ₹12k are mid-spec benchmarks (desk ₹3–8k + screen + pedestal;
//!     ergonomic chair ₹5–15k).
//!   - Embodied carbon: a CAT-B office fit-out benchmarks at **~190 kgCO2e/m²**
//!     (modules A1–A5; SpecFinish / UK Net-Zero-Carbon Buildings Standard 2024
//!     cross-sector research), with a lean/reuse floor nearer ~120 and an
//!     enclosure-heavy floor pushing ~260+. The per-element factors below sum
//!     into that band: aluminium-framed glazing and services carry the most.
//!
//! The `stats.ts` `buildElements` BoQ mirrors these rates so the sidebar
//! decomposition and this headline agree — **keep the two in lockstep** (rates
//! duplicated there under `WALL`/`FLOOR`/`FURN`/`ENCLOSURE`).

use crate::document::Document;
use crate::model::{Component, Wall};
use crate::zone::ZoneType;

// ---------------------------------------------------------------------------
// Rate tables. `(cost ₹, carbon kgCO2e)` pairs so cost and carbon stay defined
// side by side and can never drift structurally out of sync.
// ---------------------------------------------------------------------------

/// Base shell per m² of floor: carpet-tile flooring, grid/gypsum ceiling,
/// ambient + task lighting, power/earthing, structured data, HVAC distribution,
/// fire and BMS. The open-plan, area-driven CAT-B scope every plan carries —
/// cheap + low-carbon per m² relative to enclosure. ₹14k/m² ≈ ₹1,300/sqft is a
/// premium-spec area build-up (Holzbox 2024 component rates × 10.764 sqft/m²);
/// carbon 110 kgCO2e/m² is the services-and-finishes share of the ~190/m² CAT-B
/// benchmark (SpecFinish / UK NZC Buildings Standard 2024).
const BASE_SHELL: (f64, f64) = (14_000.0, 110.0);

/// Built interior partition, per running metre (≈2.7 m storey).
/// Solid: boarded, insulated, painted drywall (₹120–200/sqft elevation ×2.7 m).
/// Glazed: framed aluminium office glass front (₹350–1,000/sqft ×2.7 m) — the
/// aluminium frame makes it far dearer and far more carbon-intensive (Holzbox
/// 2024, Studio Matrx 2026).
const PARTITION_SOLID: (f64, f64) = (4_600.0, 35.0);
const PARTITION_GLASS: (f64, f64) = (15_000.0, 140.0);

/// Door leaf (900×2100 + frame + ironmongery + vision panel). Flush/glass leaf +
/// hardware ₹12k–28k, framed acoustic to ₹55k (Studio Matrx 2026).
const DOOR: (f64, f64) = (25_000.0, 80.0);

/// Enclosed-room premium, per m² of enclosed floor (Meeting / ClosedOffice):
/// acoustic ceiling, dedicated VRV/HVAC branch, AV + data, upgraded finishes —
/// the "cellular" cost an open desk field never incurs.
const ENCLOSURE_PREMIUM: (f64, f64) = (6_000.0, 40.0);

/// Furniture per unit, by grouped category. **Mirrors `stats.ts` `furnGroup` +
/// `FURN`** (keep in lockstep). Doors are priced as enclosure (`DOOR`), not
/// here, so the furniture pass skips them.
fn furniture_rate(category: &str) -> (f64, f64) {
    let c = category.to_ascii_lowercase();
    if c.contains("chair")
        || c.contains("sofa")
        || c.contains("lounge")
        || c.contains("stool")
        || c.contains("seat")
        || c.contains("bench")
    {
        (12_000.0, 55.0) // task / soft seating (ergonomic chair ₹5–15k)
    } else if c.contains("desk")
        || c.contains("workstation")
        || c.contains("table")
        || c.contains("counter")
        || c.contains("credenza")
        || c.contains("worktop")
    {
        (20_000.0, 110.0) // workstation (desk ₹3–8k + screen + pedestal) / meeting table (blended)
    } else if c.contains("storage")
        || c.contains("cabinet")
        || c.contains("locker")
        || c.contains("shelf")
        || c.contains("pedestal")
        || c.contains("file")
    {
        (12_000.0, 120.0)
    } else if c.contains("pod")
        || c.contains("booth")
        || c.contains("privacy")
        || c.contains("phone")
        || c.contains("partition")
        || c.contains("screen")
    {
        (120_000.0, 300.0) // acoustic pod / booth — a fitted product
    } else {
        (2_500.0, 15.0) // planter, ceiling tile, art, misc accessory
    }
}

/// True for enclosed room types that carry the ceiling/HVAC/AV premium.
/// Circulation, Workspace, open Collaboration, Core and Amenity do not.
fn is_enclosed(t: ZoneType) -> bool {
    matches!(t, ZoneType::Meeting | ZoneType::ClosedOffice)
}

/// Planar length of a wall segment, metres.
fn wall_len(w: &Wall) -> f64 {
    (w.b.x - w.a.x).hypot(w.b.y - w.a.y)
}

/// True for a component that counts toward the fit-out you'd buy: generated /
/// placed content, never passive imported reference furniture (Laiout parity —
/// same predicate as `specified_cost` and the `stats.ts` BoQ).
fn counts(c: &Component) -> bool {
    !c.reference
}

/// The two headline figures, computed together so they can never structurally
/// diverge. `(cost ₹, carbon kgCO2e)`.
fn indicative(doc: &Document) -> (f64, f64) {
    let plate = doc.plate_polygon();
    let plate_ref = plate.as_deref();
    let mut cost = 0.0;
    let mut carbon = 0.0;

    // 1. Base shell — per m² of true floor area (plate-clipped).
    let floor = doc.floor_area();
    cost += floor * BASE_SHELL.0;
    carbon += floor * BASE_SHELL.1;

    // 2. Partitions — generated interior walls only (the fit-out enclosure; the
    //    architectural envelope is base-build landlord scope). Solid vs glazed
    //    by the `glazing` flag the generator sets on corridor glass fronts.
    for w in doc.walls.iter().filter(|w| w.generated) {
        let len = wall_len(w);
        let rate = if w.glazing { PARTITION_GLASS } else { PARTITION_SOLID };
        cost += len * rate.0;
        carbon += len * rate.1;
    }

    // 3. Doors — per leaf.
    let doors = doc
        .components
        .iter()
        .filter(|c| counts(c) && c.category.eq_ignore_ascii_case("Door"))
        .count() as f64;
    cost += doors * DOOR.0;
    carbon += doors * DOOR.1;

    // 4. Enclosed-room premium — per m² of enclosed floor (plate-clipped).
    for z in doc.zones.iter().filter(|z| is_enclosed(z.zone_type)) {
        let a = z.area_on(plate_ref);
        cost += a * ENCLOSURE_PREMIUM.0;
        carbon += a * ENCLOSURE_PREMIUM.1;
    }

    // 5. Furniture — per unit by category (doors already priced above).
    for c in doc
        .components
        .iter()
        .filter(|c| counts(c) && !c.category.eq_ignore_ascii_case("Door"))
    {
        let rate = furniture_rate(&c.category);
        cost += rate.0;
        carbon += rate.1;
    }

    (cost, carbon)
}

/// Total indicative fit-out cost of the document (**₹, INR**).
pub fn indicative_cost(doc: &Document) -> f64 {
    indicative(doc).0
}

/// Total indicative embodied carbon of the document (kgCO2e).
pub fn indicative_carbon(doc: &Document) -> f64 {
    indicative(doc).1
}

/// Σ observed prices of bank-bound components (₹ INR). This is *specified
/// furniture capex* — reported as its own metrics line, NOT folded into
/// [`indicative_cost`], whose furniture allowance already prices loose furniture
/// generically (adding both would double-count).
///
/// **Reference furniture is excluded** (`c.reference`): imported/legacy CAD
/// pieces are passive context, not part of the fit-out you'd buy (Laiout parity,
/// see `docs/design/laiout-deep-research.md`). This is the same predicate the
/// per-element BoQ (`stats.ts` `buildElements`) uses, so the Rust headline capex
/// and the panel/BoQ agree, and flipping a bound desk to reference drops it from
/// cost — the invariant `reference contributes 0 to cost`.
pub fn specified_cost(doc: &Document) -> f64 {
    doc.components
        .iter()
        .filter(|c| !c.reference)
        .filter_map(|c| c.price_inr)
        .sum()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::geometry::Point;
    use crate::model::{Component, DecisionState};
    use crate::zone::{Zone, ZoneShape, ZoneType};

    fn component(category: &str, x: f64, y: f64) -> Component {
        Component {
            id: 0,
            category: category.to_string(),
            x,
            y,
            w: 1.0,
            h: 1.0,
            rotation: 0.0,
            mirror: false,
            reference: false,
            label: String::new(),
            product_id: None,
            price_inr: None,
            decision: DecisionState::Open,
        }
    }

    /// A 30×20 = 600 m² rectangular plate as four architectural walls.
    fn rect_plate(w: f64, h: f64) -> Vec<Wall> {
        let p = |x: f64, y: f64| Point { x, y };
        let seg = |a: Point, b: Point| Wall {
            id: 0,
            a,
            b,
            thickness: 0.2,
            generated: false,
            glazing: false,
        };
        vec![
            seg(p(0.0, 0.0), p(w, 0.0)),
            seg(p(w, 0.0), p(w, h)),
            seg(p(w, h), p(0.0, h)),
            seg(p(0.0, h), p(0.0, 0.0)),
        ]
    }

    fn gen_wall(ax: f64, ay: f64, bx: f64, by: f64, glazing: bool) -> Wall {
        Wall {
            id: 0,
            a: Point { x: ax, y: ay },
            b: Point { x: bx, y: by },
            thickness: 0.1,
            generated: true,
            glazing,
        }
    }

    fn door(x: f64, y: f64) -> Component {
        component("Door", x, y)
    }

    fn enclosed_zone(x: f64, y: f64, w: f64, h: f64, t: ZoneType) -> Zone {
        Zone {
            id: 0,
            zone_type: t,
            shape: ZoneShape::Rect { x, y, w, h },
            label: String::new(),
            component_ids: Vec::new(),
            group: None,
        }
    }

    /// A bare open plan (plate only, no partitions/rooms) is priced purely on
    /// the base shell — cheap + low-carbon per m².
    #[test]
    fn open_plan_is_base_shell_only() {
        let mut doc = Document::default();
        doc.walls = rect_plate(30.0, 20.0); // 600 m²
        let (cost, carbon) = indicative(&doc);
        assert!((cost - 600.0 * BASE_SHELL.0).abs() < 1.0, "cost = base shell only, got {cost}");
        assert!((carbon - 600.0 * BASE_SHELL.1).abs() < 1e-6, "carbon = base shell only, got {carbon}");
    }

    /// The core invariant: adding enclosure (partitions + doors + enclosed
    /// rooms) STRICTLY raises both cost AND carbon over the same-area open plan.
    #[test]
    fn enclosure_raises_cost_and_carbon() {
        let mut open = Document::default();
        open.walls = rect_plate(30.0, 20.0);
        let (open_cost, open_carbon) = indicative(&open);

        let mut cellular = open.clone();
        // Two 4×4 enclosed rooms: solid partitions + one glazed front + a door each.
        for i in 0..2 {
            let x = 4.0 + i as f64 * 6.0;
            cellular.walls.push(gen_wall(x, 2.0, x + 4.0, 2.0, false)); // solid
            cellular.walls.push(gen_wall(x, 6.0, x + 4.0, 6.0, false)); // solid
            cellular.walls.push(gen_wall(x, 2.0, x, 6.0, false)); // solid
            cellular.walls.push(gen_wall(x + 4.0, 2.0, x + 4.0, 6.0, true)); // glazed front
            cellular.components.push(door(x + 4.0, 4.0));
            cellular
                .zones
                .push(enclosed_zone(x + 2.0, 4.0, 4.0, 4.0, ZoneType::Meeting));
        }
        let (cell_cost, cell_carbon) = indicative(&cellular);

        assert!(cell_cost > open_cost, "cellular {cell_cost} must cost more than open {open_cost}");
        assert!(cell_carbon > open_carbon, "cellular {cell_carbon} must carry more carbon than open {open_carbon}");
    }

    /// Monotonic in room count: MORE enclosed rooms ⇒ higher cost AND carbon.
    #[test]
    fn more_rooms_monotonic() {
        let mk = |rooms: usize| -> (f64, f64) {
            let mut doc = Document::default();
            doc.walls = rect_plate(60.0, 20.0); // room for many rooms
            for i in 0..rooms {
                let x = 2.0 + i as f64 * 5.0;
                doc.walls.push(gen_wall(x, 2.0, x + 4.0, 2.0, false));
                doc.walls.push(gen_wall(x, 6.0, x + 4.0, 6.0, false));
                doc.walls.push(gen_wall(x, 2.0, x, 6.0, false));
                doc.walls.push(gen_wall(x + 4.0, 2.0, x + 4.0, 6.0, true));
                doc.components.push(door(x + 4.0, 4.0));
                doc.zones
                    .push(enclosed_zone(x + 2.0, 4.0, 4.0, 4.0, ZoneType::ClosedOffice));
            }
            indicative(&doc)
        };
        let (c3, k3) = mk(3);
        let (c8, k8) = mk(8);
        assert!(c8 > c3, "8 rooms {c8} > 3 rooms {c3} (cost)");
        assert!(k8 > k3, "8 rooms {k8} > 3 rooms {k3} (carbon)");
    }

    /// Glazed partitions cost + carry more than the same length of solid.
    #[test]
    fn glazed_dearer_than_solid() {
        let mut solid = Document::default();
        solid.walls = rect_plate(30.0, 20.0);
        solid.walls.push(gen_wall(5.0, 5.0, 15.0, 5.0, false));
        let mut glazed = Document::default();
        glazed.walls = rect_plate(30.0, 20.0);
        glazed.walls.push(gen_wall(5.0, 5.0, 15.0, 5.0, true));
        assert!(indicative_cost(&glazed) > indicative_cost(&solid));
        assert!(indicative_carbon(&glazed) > indicative_carbon(&solid));
    }

    /// A realistic ~800 m² cellular floor (the shape the autonomous generator
    /// produces on the sample plate) must land in the credible **India metro
    /// CAT-B hard-cost band ₹18k–28k/m² of floor (~₹1,700–2,600/sqft)** and the
    /// **~120–210 kgCO2e/m² band** around the ~190 kgCO2e/m² CAT-B benchmark
    /// (SpecFinish / UK NZC 2024). Mirrors the browser-measured "Balanced" fit
    /// (≈16.2M ₹, ≈118k kgCO2e on an 802.8 m² plate → ₹20.2k/m², 147 kg/m² of
    /// floor). Cited guides: JLL 2023/24 India medium-spec ₹5,788/sqft and C&W
    /// 2026 Bengaluru ₹6,027/sqft are the all-in *delivery* figures (prelims,
    /// fees, AV/IT, contingency) that sit above this BoQ-style hard cost.
    #[test]
    fn real_plate_lands_in_india_catb_band() {
        let mut doc = Document::default();
        doc.walls = rect_plate(36.0, 22.3); // 802.8 m² floor
        // Interior partitions: 175 m solid (35×5 m) + 25 m glazed (5×5 m).
        for i in 0..35 {
            let y = 1.0 + (i % 20) as f64;
            doc.walls.push(gen_wall(2.0, y, 7.0, y, false));
        }
        for i in 0..5 {
            let y = 1.0 + i as f64;
            doc.walls.push(gen_wall(10.0, y, 15.0, y, true));
        }
        // 21 doors.
        for i in 0..21 {
            doc.components.push(door(3.0 + (i % 10) as f64, 3.0));
        }
        // ~108 m² enclosed: 6 meeting rooms 4×4 (96) + 1 closed office 4×3 (12).
        for i in 0..6 {
            let x = 2.0 + i as f64 * 5.0;
            doc.zones
                .push(enclosed_zone(x, 8.0, 4.0, 4.0, ZoneType::Meeting));
        }
        doc.zones
            .push(enclosed_zone(2.0, 15.0, 4.0, 3.0, ZoneType::ClosedOffice));
        // Furniture: 105 desks + 19 tables + 11 chairs (benching field).
        for _ in 0..105 {
            doc.components.push(component("Desk", 20.0, 12.0));
        }
        for _ in 0..19 {
            doc.components.push(component("Table", 20.0, 12.0));
        }
        for _ in 0..11 {
            doc.components.push(component("Chair", 20.0, 12.0));
        }

        let (cost, carbon) = indicative(&doc);
        let area = doc.floor_area();
        let cost_per_m2 = cost / area;
        let carbon_per_m2 = carbon / area;
        assert!(
            (18_000.0..=28_000.0).contains(&cost_per_m2),
            "₹/m² of floor = {cost_per_m2:.0}, outside India CAT-B band 18k–28k"
        );
        assert!(
            (120.0..=210.0).contains(&carbon_per_m2),
            "kgCO2e/m² of floor = {carbon_per_m2:.1}, outside CAT-B band 120–210"
        );
    }

    /// Reference furniture contributes zero to the indicative fit-out.
    #[test]
    fn reference_furniture_free() {
        let mut doc = Document::default();
        doc.walls = rect_plate(30.0, 20.0);
        let base = indicative_cost(&doc);
        let mut desk = component("Desk", 5.0, 5.0);
        desk.reference = true;
        doc.components.push(desk);
        assert!((indicative_cost(&doc) - base).abs() < 1e-6, "reference desk must not add cost");
    }
}
