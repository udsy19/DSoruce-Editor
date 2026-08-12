//! DSource Editor core — compiled to WebAssembly and driven from the browser.
//!
//! Architecture (Rayon-style): this crate owns the document model, geometry,
//! hit-testing and (later) the layout engine as **pure Rust**. The only browser
//! contact is the wasm-bindgen boundary below. Rendering currently lives in the
//! TS frontend; it migrates into a Rust/WebGL renderer later (see
//! `docs/adr/0001-rendering-staging.md`).

mod circulation;
mod cost;
mod document;
mod fixtures;
mod geometry;
#[cfg(test)]
mod metrics_tests;
mod layout;
mod model;
mod qto;
mod quantity;
mod wallnet;
mod zone;

use document::{Anchor, Document};
use geometry::Point;
use layout::SpaceKind;
use model::{Component, DecisionState, KeepOut, Wall};
use serde::Serialize;
use wasm_bindgen::prelude::*;
use zone::{Axis, ZoneShape, ZoneType};

#[derive(Serialize)]
struct Metrics {
    // --- existing (Scene3D / App depend on these) ---
    floor_area: f64,
    wall_count: usize,
    component_count: usize,
    confirmed: usize,
    // --- Slice 2: Laiout Statistics-panel headline metrics (additive) ---
    /// Wall-bbox area (m²); same value as `floor_area`, named for the panel.
    gross_external_area: f64,
    /// Σ zone areas (m²); the usable/tiled area the donut sums over.
    net_internal_area: f64,
    /// Non-reference `Desk`s seated in a Workspace zone — the ONE workstation
    /// count that equals the panel's Pax (see `metrics()`); excludes imported
    /// reference furniture.
    workstations: usize,
    /// NIA / workstations (m²); 0 when there are no workstations.
    area_per_workstation: f64,
    /// Space efficiency = usable area / NIA × 100; 0 when NIA is 0. "Usable" is
    /// every occupiable zone (Workspace + Meeting + Collaboration + ClosedOffice
    /// + Amenity); the loss is Circulation + Core/service. Standard workplace
    /// space-efficiency definition (BCO 2023 / RICS IPMS / JLL), target ~70–85%.
    /// The loss now also includes `Unassigned`. Computed over the UNFOLDED
    /// truth — see `usable_area`.
    efficiency_pct: f64,
    /// Floor (m²) the generator could neither furnish nor justify as a
    /// code-width connected path: `ZoneType::Unassigned`. The honest measure of
    /// wasted floor, and the term the layout score penalises.
    ///
    /// UNFOLDED, because this struct is the core telling the truth about itself.
    /// Client-facing surfaces fold it into circulation (`published_zone_type`);
    /// nothing that folds may also read this field, or the same floor is
    /// counted twice.
    unassigned_area: f64,
    /// Wasted floor as a percentage of NIA — **waste's own name**.
    ///
    /// Efficiency is deliberately NOT the place this lives. `efficiency_pct` is
    /// usable/NIA, a benchmarked industry definition (BCO 2023 / RICS IPMS /
    /// JLL, the 70–85% band): the moment waste is folded into it, our number
    /// stops being comparable with qbiq's or anyone else's and the parity
    /// benchmark this product is measured against is destroyed. Measured after
    /// Phase 1, `efficiency_pct` did not move at all when 64 m² was reclassified
    /// — because circulation was already excluded from usable. Efficiency never
    /// measured waste; this does.
    ///
    /// **Internal only.** The editor's Areas split and the layout score read it;
    /// no published surface ever does, per the standing fold rule.
    unassigned_pct: f64,
    /// **Whether `floor_area` is a measurement.** `"traced"` · `"open"` ·
    /// `"unresolved"` — see `document::PlateResolution`.
    ///
    /// The panel must branch on this before printing GEA, NIA, efficiency or
    /// area-per-workstation. A silent bounding-box fallback on a document that
    /// previously traced is not a smaller number, it is a *different quantity*,
    /// and presenting it in the same slot is how "GEA 1 m²" read as a fact
    /// rather than as a broken wall loop.
    plate_state: &'static str,
    /// **Whether these numbers are a measurement.** Absent (`undefined` across
    /// the wasm boundary) normally; a sentence naming the impossibility when one
    /// is not.
    ///
    /// NEW POLICY, and it is the whole of finding M1's third guard. The 102.469%
    /// efficiency stood behind `debug_assert!(efficiency_pct <= 100.0 + 1e-6)`,
    /// which is **compiled out of the release wasm we ship** — so the one guard
    /// placed at the source of the defect did not exist in the only build a user
    /// ever runs. An impossible value must surface as a STATE the caller can
    /// see, exactly the way `plate_state` does, and never only as an assertion.
    ///
    /// The debug assertion is deliberately gone rather than kept alongside: two
    /// guards for one property, one of which vanishes at the boundary that
    /// matters, is how the property came to be unguarded while looking guarded.
    ///
    /// Consumers: the panel prints it. Nothing branches on its TEXT.
    metrics_error: Option<String>,
    /// Indicative fit-out cost (currency units) — see `cost.rs`.
    indicative_cost: f64,
    /// Indicative embodied carbon (kgCO2e) — see `cost.rs`.
    indicative_carbon: f64,
    /// Σ observed ₹ prices of bank-bound components (specified furniture capex).
    specified_cost: f64,
}

/// Per-zone row for the Statistics panel + AI reasoning. Serialized as an array
/// element by `zone_stats()`.
#[derive(Serialize)]
struct ZoneStat {
    id: u32,
    zone_type: ZoneType,
    label: String,
    area: f64,
    capacity: u32,
    /// Count of this zone's non-reference `Desk` components (imported reference
    /// furniture excluded). Σ over Workspace zones == `Metrics::workstations` == Pax.
    seated: usize,
    /// area / NIA × 100 (0 when NIA is 0). Slices sum to ~100 because zones tile.
    pct_of_nia: f64,
}

/// The editor handle exposed to JavaScript. Holds the single source-of-truth
/// document; the frontend calls mutators then re-reads `state()` to render.
#[wasm_bindgen]
pub struct Editor {
    doc: Document,
    /// Bumped by [`Editor::touch`] on every mutation, so the frontend can tell
    /// "nothing changed" from "changed back to an equal value" without
    /// serializing the document. See [`Editor::revision`].
    rev: u64,
    /// What the last `generate` decided — the debug overlay's source
    /// (`layout/diag.rs`). Not part of the document, so it never rides a
    /// snapshot, a save, or an export.
    diag: layout::LayoutDiag,
}

/// The open-plan share of headcount seated at open workstations.
///
/// **Exported because the frontend was keeping its own copies and one had already
/// drifted.** `program/spec.ts` used 0.85 while `ai/suggestProgram.ts` used 0.90
/// with a comment claiming it mirrored Rust — so the same headcount produced a
/// different building depending on which path the user came in through (88
/// people → 75 desks via the Program step, 79 via suggestProgram). A value that
/// decides how many desks a floor gets has exactly one owner: the generator that
/// places them. Read this; do not re-declare it.
#[wasm_bindgen]
pub fn open_share() -> f64 {
    layout::OPEN_SHARE
}

/// Depth of a door/window leaf across its wall (m) — the committed footprint;
/// the swing arc is drawn by the 2D symbol, not stored.
///
/// **Exported for the same reason as [`open_share`]:** `cad/archTools.ts` had its
/// own `LEAF_DEPTH = 0.15`, so a hand-drawn door and a generated door were one
/// object with two authored depths. Cheap to unify now, weird later.
#[wasm_bindgen]
pub fn door_depth() -> f64 {
    layout::DOOR_D
}

/// Standard office single-leaf door width (m) — 900×2100. Exported alongside
/// [`door_depth`]: `cad/archTools.ts` had `DOOR_DEFAULT = 0.9` for exactly the
/// same object.
#[wasm_bindgen]
pub fn door_width() -> f64 {
    layout::DOOR_W
}

/// Per-zone floor areas (m², clipped to the plate polygon) with the oriented
/// desk-field's plate-spanning Workspace zone **de-overlapped**, plus the index
/// of that spanning Workspace when present.
///
/// The tilted/irregular-plate packer lays one Workspace zone across the whole
/// plate bbox as the desk field's background fill (see `layout.rs`, "Fill
/// irregular/tilted plates"). Clipped to the polygon its area is ≈ the entire
/// plate, so it overlaps every room/corridor/core zone nested inside it —
/// summing raw clipped areas double-counts that floor and pushes NIA above GEA.
/// Here the spanning Workspace is given only the OPEN floor it truly contributes
/// (`plate − the zones inside it`) so the zones tile exactly (Σ = GEA) and
/// NIA ≤ GEA holds on ANY plate shape. Axis-aligned plates have no plate-spanning
/// Workspace, so every area is returned unchanged (byte-identical) and the index
/// is `None`. Pure over `Document`, so it is natively testable.
///
/// **Detection (robust, exact-by-construction).** The oriented emit site
/// (`layout.rs`) writes this zone as a `Rect` whose footprint is *exactly* the
/// wall bbox `((min+max)/2, max−min)`. That is its unique signature: every
/// axis-aligned-path Workspace *field* is strictly inset by the perimeter
/// corridor + facade gap, so no other Workspace ever spans the full wall bbox.
/// Matching that signature (not an area ratio) is what makes de-overlap fire on
/// exactly the oriented spanning zone and NEVER on a legitimate axis-aligned
/// open-plan field — the earlier `area ≥ 0.9·floor` heuristic mis-fired on large
/// bare open-plan rectangles (a 100×60 field clips to 0.95·floor), silently
/// rewriting a real rectangular plate's Workspace area + pax.
/// A component that counts as a real placed **workstation seat**: a non-reference
/// `Desk`. Imported/legacy furniture (`reference == true`) is passive context and
/// is never counted — the single predicate behind `metrics().workstations`,
/// `zone_stats().seated`, and (via `seated`) the panel's Pax, so they cannot
/// disagree (see the "ONE Workstations == Pax" definition on `metrics()`).
fn is_workstation(c: &Component) -> bool {
    c.category == "Desk" && !c.reference
}

/// THE ONE workstation count == Pax: non-reference `Desk`s seated in a Workspace
/// zone (Σ over Workspace zones of `zone_stats().seated`). Imported reference
/// furniture and desks outside the workspace never count, so the headline can't
/// re-inflate to the old "every desk-shaped block" tally. `metrics().workstations`
/// and `stats.ts` `zonePax` both derive from this, so they are identical.
fn workstation_count(doc: &Document) -> usize {
    doc.zones
        .iter()
        .filter(|z| z.zone_type == ZoneType::Workspace)
        .flat_map(|z| &z.component_ids)
        .filter(|&&cid| doc.components.iter().any(|c| c.id == cid && is_workstation(c)))
        .count()
}


/// Usable (occupiable) area — the numerator of the workplace space-efficiency
/// ratio (usable / NIA; see `Metrics::efficiency_pct`). "Usable" is every zone
/// EXCEPT `Circulation` (corridors/aisles) and `Core` (WC, stairs, lifts, MEP,
/// service): all workstations, private offices, meeting, collab AND amenity are
/// occupiable space, not overhead. `areas` are the de-overlapped effective zone
/// areas from `area_basis`, in zone order. Standard definition per
/// BCO 2023 / RICS IPMS / JLL; a good fit-out lands ~70–85%.
///
/// **`Unassigned` is excluded here and this is the whole point of the type.**
/// It counts in NIA (it is floor inside the building; pretending otherwise
/// would break NIA <= GEA) but it is usable by nobody, so it now correctly
/// DEPRESSES efficiency. While the same floor was called `Circulation` it was
/// excluded too — the number did not change, but the REASON it was excluded was
/// a lie, and the Circulation row of the areas split was inflated by it.
///
/// This function reads the UNFOLDED truth. The fold to a published vocabulary
/// happens strictly downstream, at serialization; efficiency must never be
/// computed over folded data, or the waste re-hides inside circulation.
/// **THE net internal area.** One function, because there were two.
///
/// `metrics()` summed the effective zone areas and clamped with
/// `.min(floor_area)`; `zone_rows()` summed them and did not. On a document whose
/// plate had collapsed the pair disagreed by two orders of magnitude, and the
/// panel showed both at once: **GEA 1 m² beside NIA 138 m²**, with
/// `efficiency = usable / nia` reading **1159%** because it divided by the
/// clamped one. Two derivations of one quantity is the same defect family as two
/// copies of one value (`.claude/rules/no-bloat.md`); the divergence just took
/// longer to surface because nothing compared them.
///
/// The clamp survives, conditioned on what it was always assuming: zones tile
/// the plate, so their sum cannot exceed the gross floor — **provided the gross
/// floor is a real measurement**. When the plate is unresolved it is not, and
/// clamping to it would propagate one wrong number into every metric downstream.
fn net_internal_area(doc: &Document, areas: &[f64]) -> f64 {
    let sum: f64 = areas.iter().sum();
    match doc.plate_resolution() {
        document::PlateResolution::Traced(_) => sum.min(doc.floor_area()),
        // Open / Unresolved: `floor_area()` is a bounding-box stand-in, not a
        // measurement. Clamping NIA to it is how a broken loop became a 1159%
        // efficiency. Report the zones' own sum and let the plate state say why.
        _ => sum,
    }
}

/// **THE areas every zone-derived metric is computed from.** One basis, so a
/// clamp applied to one metric is applied to all of them.
///
/// This type exists because the NIA clamp came back as the numerator's problem.
/// `net_internal_area` clamps `Σ areas` to the traced floor; `usable_area` summed
/// the SAME `areas` unclamped, and `efficiency = usable / nia` therefore divided
/// a full sum by a clamped one. Retyping every F4 zone to Workspace — ordinary
/// editing — took efficiency from 69.979% to **102.469%**; eight overlapping
/// 30 × 30 Workspace rects on F1 read **648.4%**. Identical in shape to the
/// 1159% defect, in the same function, as a different pair.
///
/// The fix is not a second clamp. When the sum exceeds a floor we trust, the
/// whole basis is scaled by the one factor `nia / sum`, so:
///
/// * NIA is byte-identical to before (`Σ scaled == sum.min(floor)`);
/// * every subset metric — usable, unassigned — carries the SAME factor;
/// * `efficiency == usable / nia == usable_raw / sum`, a ratio of a non-negative
///   subset to its own total, which cannot exceed 1 for any zone set at all.
///
/// That last line is the difference between this and the comment it replaces.
/// The old code said the ratio "cannot exceed 1 by construction" — and it was
/// true of the numerator and the denominator *separately*, which is not a
/// construction, it is two constructions that were allowed to drift.
///
/// Scaling is a *cap*, not a measurement, so it is also reported: `overflow`
/// carries the reason out to `Metrics::metrics_error`.
pub(crate) struct AreaBasis {
    /// Per-zone effective areas in zone order, after de-overlap AND after the
    /// clamp factor. `Σ == nia` exactly.
    areas: Vec<f64>,
    /// Index of the plate-spanning oriented Workspace, when present.
    spanning: Option<usize>,
    nia: f64,
    /// `Some(reason)` when the zones did not tile the plate and the basis had to
    /// be capped. Release-visible; see `Metrics::metrics_error`.
    overflow: Option<String>,
}

/// **R14 — the one place per-zone areas come from, enforced by the compiler.**
///
/// `effective_zone_areas` is private *to this module*, and this module contains
/// exactly one caller of it. Nothing outside can name it, so "the takeoff and
/// the panel use the same areas" is a build failure rather than a comment.
///
/// It is stated as a mechanism because the comment form was tried and lost.
/// `quantity.rs:187-188` and `:509-511` both asserted that the takeoff read "the
/// ONE area definition … the same number the Statistics panel shows", and
/// `reports/B1-1.md:132` recorded it as verified. **All three were true when
/// written.** The M1 fix then introduced [`AreaBasis`], moved the panel onto it,
/// and left the takeoff on the raw areas: on the M1 state — retype every F4 zone
/// to Workspace, four clicks — the panel billed Σ 930.063 m² and the workbook's
/// Room Schedule billed Σ 953.030 m², 22.968 m² apart across all 24 rooms, with
/// finishes priced per m² off the second number. A definition change has to
/// migrate every consumer, and only the compiler can enumerate them.
mod basis {
    use super::*;

    /// Plate-clipped, de-overlapped per-zone areas — **raw**, before the cap.
    /// Private on purpose; see the module doc. `area_basis` below is the only
    /// caller, and `raw_zone_areas_unscaled` is the one declared exemption.
    fn effective_zone_areas(doc: &Document) -> (Vec<f64>, Option<usize>) {
        let plate = doc.plate_polygon();
        let plate_ref = plate.as_deref();
        let floor_area = doc.floor_area();
        let mut areas: Vec<f64> = doc.zones.iter().map(|z| z.area_on(plate_ref)).collect();
        if floor_area <= 0.0 {
            return (areas, None);
        }
        // The oriented spanning Workspace's `Rect` footprint == the wall bbox. Only
        // the oriented desk-field background fill is emitted that way; axis-path
        // Workspace fields are inset, so they can never match. `None` bbox (open
        // walls) → no plate → nothing to de-overlap.
        let spanning = doc.wall_bbox().and_then(|(min_x, min_y, max_x, max_y)| {
            let (cx, cy) = ((min_x + max_x) / 2.0, (min_y + max_y) / 2.0);
            let (bw, bh) = (max_x - min_x, max_y - min_y);
            // 1 mm tolerance: the emit writes these exact expressions, so a match is
            // effectively exact; the epsilon only absorbs f64 round-trip noise.
            const TOL: f64 = 1e-3;
            (0..doc.zones.len()).find(|&i| {
                doc.zones[i].zone_type == ZoneType::Workspace
                    && matches!(
                        doc.zones[i].shape,
                        ZoneShape::Rect { x, y, w, h }
                            if (x - cx).abs() < TOL
                                && (y - cy).abs() < TOL
                                && (w - bw).abs() < TOL
                                && (h - bh).abs() < TOL
                    )
            })
        });
        // Non-spanning Workspace de-overlap. A Workspace *field* zone is the
        // open-floor BACKGROUND of its band; the rooms/core placed within it are
        // carved OUT of that floor, so its honest contribution is its clip MINUS the
        // floor it shares with non-Workspace zones. Without this a band Workspace laid
        // over its band's rooms double-counts their area (e.g. a 53 m² bottom-band
        // field over four ~8 m² rooms = ~33 m² counted twice) — invisible while empty
        // floor kept the total under GEA, but exposed the moment the boundary-
        // conforming Circulation fill claims that empty floor. Rooms are disjoint from
        // one another, so summing per-room overlaps is exact. The single plate-spanning
        // field keeps its own `floor − others` rule below.
        for i in 0..doc.zones.len() {
            if doc.zones[i].zone_type != ZoneType::Workspace || Some(i) == spanning {
                continue;
            }
            // **Rect OR Poly** — a Workspace field that has been conformed to the
            // plate is a polygon, and skipping it silently restored the very
            // double-count this block exists to remove (caught by
            // `statsPanel.test.mjs` F4 the moment conform-on-edit made these
            // polygons common: Σ 941.6 m² over a 930.1 m² floor).
            //
            // Subtracting over zone i's BBOX is exact for a conformed polygon,
            // not an approximation. `poly_i = plate ∩ rect_i`, so
            // `bbox(poly_i) ⊆ rect_i`, and any point of `bbox_i` outside `poly_i`
            // is therefore outside the PLATE. Every `j` is plate-clipped by
            // `zone_overlap_rect_on_plate`, so it contributes nothing there:
            // `area(j ∩ bbox_i) = area(j ∩ poly_i)`.
            //
            // `RectRing` stays excluded: its bbox is the OUTER rect, so a zone
            // inside the ring's hole would be subtracted from area it never
            // covered. Rings are Circulation, not Workspace, so this costs
            // nothing today — but it would be wrong, and wrong quietly.
            let (rx0, ry0, rx1, ry1) = match doc.zones[i].shape {
                ZoneShape::Rect { .. } | ZoneShape::Poly { .. } => doc.zones[i].shape.bbox(),
                ZoneShape::RectRing { .. } => continue,
            };
            let mut sub = 0.0;
            for j in 0..doc.zones.len() {
                if j == i || doc.zones[j].zone_type == ZoneType::Workspace {
                    continue;
                }
                sub += zone_overlap_rect_on_plate(&doc.zones[j].shape, rx0, ry0, rx1, ry1, plate_ref);
            }
            areas[i] = (areas[i] - sub).max(0.0);
        }
        if let Some(idx) = spanning {
            let others: f64 = areas
                .iter()
                .enumerate()
                .filter(|(i, _)| *i != idx)
                .map(|(_, a)| *a)
                .sum();
            areas[idx] = (floor_area - others).max(0.0);
        }
        (areas, spanning)
    }
    /// **THE per-zone areas.** Every consumer — the metrics chip, the Zones tab,
    /// the areas donut, the workbook Room Schedule — reads this and only this.
    pub(crate) fn area_basis(doc: &Document) -> AreaBasis {
        let (mut areas, spanning) = effective_zone_areas(doc);
        let sum: f64 = areas.iter().sum();
        let nia = net_internal_area(doc, &areas);
        let mut overflow = None;
        // `> 1e-9` and not `!= 0.0`: a scale factor from a sum of a few m² of float
        // noise is meaningless, and a zero sum has nothing to scale.
        if sum > 1e-9 && nia < sum - 1e-6 {
            let excess_pct = (sum - nia) / nia.max(1e-9) * 100.0;
            overflow = Some(format!(
                "zone areas do not tile the floor: Σ {sum:.3} m² exceeds the traced \
                 floor {nia:.3} m² by {excess_pct:.1}% (zones overlap). NIA, usable \
                 area and efficiency are CAPPED to the floor, not measured."
            ));
            let k = nia / sum;
            for a in &mut areas {
                *a *= k;
            }
        }
        AreaBasis { areas, spanning, nia, overflow }
    }
    /// **The one declared exemption from the module boundary, and it is
    /// `#[cfg(test)]`, so no shipped code path can reach the raw areas at all.**
    ///
    /// Tests legitimately need the UNSCALED vector, because the properties they
    /// assert are about the de-overlap itself and the cap is what would make
    /// them vacuous: `NIA ≤ GEA` is the de-overlap's job and is *tautological*
    /// after a cap that clamps NIA to the floor; `metrics_tests` compares raw
    /// against scaled precisely to detect that a cap happened, and asking the
    /// capped vector whether it was capped answers itself. The `spanning` index
    /// is carried through for the same reason — several layout tests assert the
    /// plate-spanning field was or was not detected, which the areas do not say.
    #[cfg(test)]
    pub(crate) fn raw_zone_areas_unscaled(doc: &Document) -> (Vec<f64>, Option<usize>) {
        effective_zone_areas(doc)
    }
}

pub(crate) use basis::area_basis;
#[cfg(test)]
pub(crate) use basis::raw_zone_areas_unscaled;


/// **THE usable/overhead partition**, as one predicate. Occupiable space is every
/// zone except `Circulation` (corridors/aisles), `Core` (WC, stairs, lifts, MEP)
/// and `Unassigned` (floor usable by nobody).
///
/// One owner, because this set decides the numerator of `efficiency = usable /
/// nia` and it had three hand-written copies — `usable_area`, the battery's
/// all-usable reachability probe, and the cross-surface attribution check —
/// which is exactly the drift `.claude/rules/no-bloat.md` names. `Zone::capacity`
/// keeps its own copy: it answers "how many people does this seat", not "is this
/// occupiable", and the two questions are only accidentally the same list.
pub(crate) fn is_usable_zone(t: ZoneType) -> bool {
    t.is_usable()
}

fn usable_area(doc: &Document, areas: &[f64]) -> f64 {
    doc.zones
        .iter()
        .zip(areas)
        .filter(|(z, _)| is_usable_zone(z.zone_type))
        .map(|(_, a)| *a)
        .sum()
}

/// Σ of the `Unassigned` zones' basis areas — **one owner, Line A's extraction.**
///
/// `compute_metrics` computed this inline and `layout/score.rs` computed its own;
/// two readers of one quantity is the shape this mission spends its rounds on.
pub(crate) fn unassigned_area(doc: &Document, areas: &[f64]) -> f64 {
    doc.zones
        .iter()
        .zip(areas)
        .filter(|(z, _)| z.zone_type == ZoneType::Unassigned)
        .map(|(_, a)| *a)
        .sum()
}

/// The statistics panel's numbers, derived from a document and nothing else.
///
/// **Pure on purpose.** This was the body of `Editor::metrics()`, which returns a
/// `JsValue` and is therefore unreachable from `cargo test` — so the panel's
/// arithmetic was the one part of the core no Rust test could see, and it is
/// where the 1159% shipped. Lifting it out costs nothing and puts every metric
/// under `metrics_can_never_be_impossible`.
fn compute_metrics(doc: &Document) -> Metrics {
    let resolution = doc.plate_resolution();
    let floor_area = doc.floor_area();
    let AreaBasis { areas, nia, overflow, .. } = area_basis(doc);
    // THE ONE workstation definition (== Pax everywhere: chip, row, Zones tab,
    // CSV) — see `workstation_count`. `stats.ts` `zonePax` sums the same per-zone
    // `seated`, so the panel's Pax is identical to this number.
    let workstations = workstation_count(doc);
    // Space efficiency (BCO 2023 / RICS IPMS / JLL): usable / NIA, where
    // usable = every occupiable zone and the "loss" is Circulation +
    // Core/service (WC, stairs, lifts, MEP). Private offices (ClosedOffice)
    // and amenity (reception/pantry/café) ARE usable space, not overhead —
    // excluding them (the old bug) understated efficiency by ~25 pts.
    let usable = usable_area(doc, &areas);
    let unassigned = unassigned_area(doc, &areas);
    let area_per_workstation = if workstations > 0 {
        nia / workstations as f64
    } else {
        0.0
    };
    // `usable` and `nia` now come from ONE basis carrying ONE clamp (see
    // `area_basis`), so this is `usable_raw / Σ areas` — a non-negative subset
    // over its own total.
    let mut efficiency_pct = if nia > 0.0 { usable / nia * 100.0 } else { 0.0 };
    // `.min(100.0)`: a subset over its own total is 1.0 give or take an ulp, and
    // the scaled basis makes that last bit visible (`100.00000000000003`). A real
    // excursion is caught and REPORTED below, at 1e-6; this only removes float
    // noise, so no defect can hide behind it.
    let unassigned_pct_raw =
        if nia > 0.0 { (unassigned / nia * 100.0).min(100.0) } else { 0.0 };

    // ---- The release-visible backstop that replaces the `debug_assert!`. ----
    //
    // R10 AXES — this guard's falsification varies: (1) zone TYPE, retyping
    // ALL zones rather than one (`metrics_can_never_be_impossible`'s new
    // retype-all step class); (2) zone COUNT and overlap, by adding zones that
    // overlap existing ones; (3) the BUILD PROFILE, because the guard it
    // replaces existed only in debug — `statsPanel.test.mjs` runs it against the
    // release wasm we ship. An unstated axis is an untested axis.
    let mut errors: Vec<String> = Vec::new();
    if let Some(reason) = overflow {
        errors.push(reason);
    }
    // **A GUARD (R16), and the classification was MEASURED after being got
    // wrong twice.**
    //
    // It catches any FUTURE divergence between the numerator and the
    // denominator — the failure that shipped as M1. It clamps as well as
    // reports: a panel showing 100% beside a stated reason is honest; a panel
    // showing 648% is not, and silence about either is worse.
    //
    // The previous round's ledger called this "an unsatisfiable branch (R16's
    // corollary), same class as lib.rs:481-487" and left it open as a carried
    // item to delete. **RETRACTED BY NAME — that was wrong, and it was wrong the
    // same way T2 was wrong one entry earlier.** Both used UNSATISFIABILITY
    // evidence (removing the clamps left the suite green) where R16's own
    // separating test is BREAKING THE MECHANISM. Unsatisfiability is what a
    // guard and a tautology have in common; it does not distinguish them.
    //
    // Run properly, in a disposable worktree: restore M1's exact shape — the
    // numerator reads `raw_zone_areas_unscaled` while the denominator stays
    // capped — and on the retype-all fixture this branch FIRES, with
    //
    //     metrics_error = "… zone areas do not tile the floor: Σ 953.030 m²
    //     exceeds the traced floor 930.063 m² by 2.5% … · efficiency 102.469%
    //     exceeds 100 (usable 953.030 / NIA 930.063, plate traced) —
    //     capped at 100%"
    //
    // 102.469% is M1's own number, verbatim. The condition is false today
    // because `area_basis` scales one vector by one factor and makes efficiency
    // a subset over its own total — that is a mechanism somebody built, which is
    // the definition of a guard, not an algebraic accident.
    //
    // The gap that IS real: nothing in the suite observes it, so its evidence is
    // this construction proof rather than a red. That is what R16 says a guard
    // carries.
    if efficiency_pct > 100.0 + 1e-6 {
        errors.push(format!(
            "efficiency {efficiency_pct:.3}% exceeds 100 (usable {usable:.3} / \
             NIA {nia:.3}, plate {}) — capped at 100%",
            resolution.tag()
        ));
        efficiency_pct = 100.0;
    }
    // Applied AFTER the report, so an excursion is never silently absorbed: the
    // 1e-6 window above is the only thing between "float noise" and "a finding".
    efficiency_pct = efficiency_pct.min(100.0);
    // DELETED (R16 corollary — an unsatisfiable branch is decorative coverage):
    //
    //     if matches!(resolution, Traced(_)) && nia > floor_area + 1e-6 {
    //         errors.push("NIA … exceeds a TRACED floor of …")
    //     }
    //
    // `nia` is `area_basis(doc).nia` = `net_internal_area(doc, raw)`, whose
    // Traced arm is `sum.min(doc.floor_area())`, and `floor_area` above is that
    // same `doc.floor_area()` on the same unmutated document. So under `Traced`,
    // `nia ≤ floor_area` identically — the condition is false for every document,
    // including the NaN cases (`f64::min` returns the non-NaN operand; a NaN
    // comparison is false either way). This is D2's exact shape in the producer,
    // the twin of the JS cap check `statsPanel.test.mjs` already deleted.
    //
    // FALSIFIED, not argued: replacing the body with `panic!` left the suite at
    // **196 passed / 0 failed** — 1 200 battery evaluations plus every fixture
    // test, and the branch never fired once.
    //
    // NOT the only path to its user-visible state. The cap event is reported by
    // `overflow` above ("zone areas do not tile the floor … CAPPED"), which IS
    // reachable — 13 of 35 (fixture × edit) states, frozen in
    // `statsPanel.test.mjs`'s `CAPPED` set. Nor was this branch guarding the
    // clamp: removing `.min(doc.floor_area())` from `net_internal_area` reds the
    // suite either way, and reds it HARDER without this branch (192/4) than with
    // it (193/3) — with it in place the wrong message ("NIA … exceeds a TRACED
    // floor") satisfied assertions that only ask whether *an* error was
    // reported, masking one further failure.
    for (name, v) in [
        ("floor_area", floor_area),
        ("net_internal_area", nia),
        ("efficiency_pct", efficiency_pct),
        ("area_per_workstation", area_per_workstation),
        ("unassigned_area", unassigned),
    ] {
        if !v.is_finite() || v < 0.0 {
            errors.push(format!("{name} is {v}"));
        }
    }
    let metrics_error = if errors.is_empty() { None } else { Some(errors.join(" · ")) };

    Metrics {
        floor_area,
        wall_count: doc.walls.len(),
        component_count: doc.components.len(),
        confirmed: doc
            .components
            .iter()
            .filter(|c| c.decision == DecisionState::Confirmed)
            .count(),
        gross_external_area: floor_area,
        net_internal_area: nia,
        workstations,
        area_per_workstation,
        efficiency_pct,
        unassigned_area: unassigned,
        unassigned_pct: unassigned_pct_raw,
        plate_state: resolution.tag(),
        metrics_error,
        indicative_cost: cost::indicative_cost(doc),
        indicative_carbon: cost::indicative_carbon(doc),
        specified_cost: cost::specified_cost(doc),
    }
}

/// The zone type a **published** artifact is allowed to show.
///
/// `Unassigned` folds to `Circulation`; everything else is itself. This is the
/// ONE place the fold happens, so "which surfaces fold?" is answered by who
/// calls this rather than by thirty scattered conditionals.
///
/// **Why fold at all.** No shipping product publishes a dead-space category
/// (qbiq, Laiout, TestFit, Hypar, CBRE Plans), and no measurement standard
/// defines one: BOMA Z65.1 treats circulation — primary and secondary — as part
/// of Usable Area and reports it as a factor; IPMS's only "quantify separately"
/// bucket is Limited Use Areas, which is about headroom and columns, not
/// leftover pockets. A "Dead space: 170 m²" row in a client takeoff would be
/// unreadable against every convention its reader has.
///
/// **Why not fold everywhere.** The editor is a working surface, and showing a
/// planner exactly where floor is being wasted is the entire value of the
/// distinction. So `zone_stats` stays honest and `zone_stats_published` folds.
pub(crate) fn published_zone_type(t: ZoneType) -> ZoneType {
    // GENERATED CLASS, not a second list. `ZoneType::is_ground` comes out of
    // `zone_domain!`'s class column, so "which types fold" and "which types are
    // ground" are one declaration and cannot drift. This used to be a `match`
    // naming `Unassigned` — the arm a regex read, a prose comment poisoned, and
    // an `if`/`return` evaded.
    if t.is_ground() {
        ZoneType::Circulation
    } else {
        t
    }
}

/// **Is this zone GROUND — the floor a plan sits on rather than a room on it?**
///
/// DERIVED from [`published_zone_type`], not restated beside it. Ground is
/// exactly "what the client-facing fold turns into circulation, plus
/// circulation itself", so the two can never disagree: adding a type to the
/// fold adds it here, in the same edit, with no second site to remember.
///
/// **It did not exist, and three production sites spelled it by hand** —
/// `Document::zone_index_at`, `conform`'s residual filter, and `is_usable_zone`
/// — each carrying its own `matches!(t, Circulation | Unassigned)`. That is the
/// private-definition class, and it has now fired three times in this codebase:
/// once on G12's fold boundary, once in `drawing-set.test.mjs` (whose private
/// `!= 'Circulation'` demanded twelve labels the fold forbids, red for 73
/// commits), and here. TypeScript closed it with `isGroundZone`; Rust never
/// had the predicate at all.
pub(crate) fn is_ground_zone(t: ZoneType) -> bool {
    t.is_ground()
}

/// Area (m²) of `shape ∩ rect`, clipped to the plate — the floor a Workspace
/// field shares with the zone `shape` sitting inside it. `Rect`/`RectRing` reduce
/// to axis-aligned rect intersections; a `Poly` (a boundary-conforming zone) is
/// already ⊆ plate, so clipping it to the rect gives the overlap directly.
fn zone_overlap_rect_on_plate(
    shape: &ZoneShape,
    rx0: f64,
    ry0: f64,
    rx1: f64,
    ry1: f64,
    plate: Option<&[geometry::Point]>,
) -> f64 {
    let clip = |x0: f64, y0: f64, x1: f64, y1: f64| -> f64 {
        let (ix0, iy0, ix1, iy1) = (x0.max(rx0), y0.max(ry0), x1.min(rx1), y1.min(ry1));
        if ix0 >= ix1 || iy0 >= iy1 {
            return 0.0;
        }
        match plate {
            Some(p) => geometry::rect_polygon_clip_area(p, ix0, iy0, ix1, iy1),
            None => (ix1 - ix0) * (iy1 - iy0),
        }
    };
    match shape {
        ZoneShape::Rect { x, y, w, h } => clip(x - w / 2.0, y - h / 2.0, x + w / 2.0, y + h / 2.0),
        ZoneShape::RectRing { x, y, w, h, in_w, in_h } => {
            (clip(x - w / 2.0, y - h / 2.0, x + w / 2.0, y + h / 2.0)
                - clip(x - in_w / 2.0, y - in_h / 2.0, x + in_w / 2.0, y + in_h / 2.0))
            .max(0.0)
        }
        ZoneShape::Poly { pts } => {
            let poly: Vec<geometry::Point> =
                pts.iter().map(|p| geometry::Point::new(p[0], p[1])).collect();
            geometry::polygon_area(&geometry::clip_rect_to_polygon(&poly, rx0, ry0, rx1, ry1))
        }
    }
}

/// **Every `f64` that crosses the wasm boundary into the document is a real
/// number.** One owner, called by every mutator that takes one.
///
/// JavaScript hands us `NaN` for free — `parseFloat("")`, `0/0`, an
/// `undefined` arithmetic chain, a slider read before layout. Rust then accepts
/// it silently, because a NaN satisfies no comparison: `resize_zone`'s
/// `OutOfBounds` guard is written entirely in `<`/`>` and every one of them is
/// false for NaN, so `resize_zone(id, NaN, NaN, NaN, NaN)` returned **Ok**, NIA
/// fell 899.789 → 348.029 with no error, and the zone serialized as
/// `{"x":null,…}` — a `.dsource` that **saves and can never be reopened**
/// (`from_snapshot` → `invalid type: null, expected f64`).
///
/// **A document that cannot round-trip is a defect at WRITE time**, so the
/// refusal is here, at the write, and not at the load. Checked at the BOUNDARY
/// rather than per-field inside the document, because the class is "values
/// arriving from JS", not "zone shapes": patching the one mutator the report
/// named would have left fourteen others live — the "known hazard patched at one
/// call site" family in `.claude/rules/gate-independence.md`.
fn finite(vals: &[f64]) -> Result<(), JsValue> {
    if let Some(bad) = vals.iter().find(|v| !v.is_finite()) {
        return Err(JsValue::from_str(&format!(
            "non-finite coordinate ({bad}) — NaN and ±∞ are not positions, and a \
             document holding one cannot be reopened"
        )));
    }
    Ok(())
}

#[wasm_bindgen]
impl Editor {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Editor {
        console_error_panic_hook::set_once();
        Editor {
            doc: Document::new(),
            rev: 0,
            diag: Default::default(),
        }
    }

    /// Hierarchical quantity schedule (level → room → category → item) derived
    /// from the document directly — no IFC round-trip, works offline.
    pub fn qto_schedule(&self) -> Result<JsValue, JsValue> {
        serde_wasm_bindgen::to_value(&qto::schedule(&self.doc))
            .map_err(|e| JsValue::from_str(&e.to_string()))
    }

    /// Monotonic mutation counter. Every `&mut self` method bumps it exactly
    /// once (enforced by `tests::every_mutator_bumps_the_revision`), so a caller
    /// that remembers the last value it saw can skip a `state()` re-read — and
    /// the full-document serialize behind it — when nothing has changed.
    ///
    /// Deliberately coarse: it reports *that* the document changed, never what.
    /// Rendering stays correct if a caller ignores it entirely.
    pub fn revision(&self) -> u64 {
        self.rev
    }

    /// Record a mutation. Called at the top of every mutating method; wrapping
    /// is fine, callers only ever compare for equality.
    fn touch(&mut self) {
        self.rev = self.rev.wrapping_add(1);
    }

    /// Add a wall segment a→b. Returns the new wall id.
    pub fn add_wall(
        &mut self,
        ax: f64,
        ay: f64,
        bx: f64,
        by: f64,
        thickness: f64,
    ) -> Result<u32, JsValue> {
        self.touch();
        finite(&[ax, ay, bx, by, thickness])?;
        let id = self.doc.alloc_id();
        self.doc.walls.push(Wall {
            id,
            a: Point::new(ax, ay),
            b: Point::new(bx, by),
            thickness,
            generated: false,
            glazing: false,
            height_m: None,
        });
        Ok(id)
    }

    /// Place a component (footprint centered at x,y). Returns the new component id
    /// and makes it the current selection.
    pub fn add_component(
        &mut self,
        category: String,
        x: f64,
        y: f64,
        w: f64,
        h: f64,
    ) -> Result<u32, JsValue> {
        self.touch();
        finite(&[x, y, w, h])?;
        let id = self.doc.alloc_id();
        let label = format!("{} {}", category, id);
        let seats = crate::model::seats_for(&category, w, h);
        self.doc.components.push(Component {
            id,
            category,
            x,
            y,
            w,
            h,
            rotation: 0.0,
            mirror: false,
            reference: false, // placed/generated content counts; only imported furniture is reference
            seats,
            label,
            product_id: None,
            price_inr: None,
            decision: DecisionState::Open,
        });
        self.doc.selection = Some(id);
        // Membership follows existence: the room the desk landed in counts it
        // from this call on, not from the next zone edit (see `rebucket_component`).
        self.doc.rebucket_component(id);
        Ok(id)
    }

    /// Add a permanent interior keep-out (building core: stairs/lifts/shafts/
    /// WCs) as a center-based rect. Keep-outs are hard obstacles `generate()`
    /// always avoids regardless of freeze state, and render as `Core` zones.
    /// Returns the new keep-out id. Serializes with the doc via `state()`.
    pub fn add_keepout(
        &mut self,
        x: f64,
        y: f64,
        w: f64,
        h: f64,
        label: String,
    ) -> Result<u32, JsValue> {
        self.touch();
        finite(&[x, y, w, h])?;
        let id = self.doc.alloc_id();
        self.doc.keepouts.push(KeepOut { id, x, y, w, h, label });
        Ok(id)
    }

    /// Remove all keep-outs.
    pub fn clear_keepouts(&mut self) {
        self.touch();
        self.doc.keepouts.clear();
    }

    /// Add a building entry point (world meters). The test-fit generator anchors
    /// its primary circulation spine to the first entry (spec §3). Serializes
    /// with the doc via `state()`/`snapshot()`.
    pub fn add_entry(&mut self, x: f64, y: f64) -> Result<(), JsValue> {
        self.touch();
        finite(&[x, y])?;
        self.doc.entries.push(Point::new(x, y));
        Ok(())
    }

    /// Remove all entry points.
    pub fn clear_entries(&mut self) {
        self.touch();
        self.doc.entries.clear();
    }

    /// Pin a room of `kind` onto `(x, y)` (world meters) — qbiq's "Place on Plan"
    /// (workflow.md §3.5). `generate()` places anchored rooms FIRST at (near)
    /// their point and bumps that kind's count. `kind` is a `SpaceKind` name
    /// ("Reception"/"Cabin"/"Meeting"/…); an unknown kind is ignored. Serializes
    /// with the doc via `state()`/`snapshot()`, mirroring `add_entry`.
    pub fn add_anchor(&mut self, kind: String, x: f64, y: f64) -> Result<(), JsValue> {
        self.touch();
        finite(&[x, y])?;
        if let Some(kind) = SpaceKind::from_wire(&kind) {
            self.doc.anchors.push(Anchor { kind, x, y });
        }
        Ok(())
    }

    /// Remove all anchor pins (mirrors `clear_entries`).
    pub fn clear_anchors(&mut self) {
        self.touch();
        self.doc.anchors.clear();
    }

    /// Hit-test components at (x,y) in world coords, topmost first. Sets and
    /// returns the selection (undefined in JS if nothing was hit).
    pub fn select_at(&mut self, x: f64, y: f64) -> Result<Option<u32>, JsValue> {
        self.touch();
        finite(&[x, y])?;
        let mut hit = None;
        for c in self.doc.components.iter().rev() {
            let dx = (c.x - x).abs();
            let dy = (c.y - y).abs();
            if dx <= c.w / 2.0 && dy <= c.h / 2.0 {
                hit = Some(c.id);
                break;
            }
        }
        self.doc.selection = hit;
        Ok(hit)
    }

    pub fn clear_selection(&mut self) {
        self.touch();
        self.doc.selection = None;
    }

    /// Translate the current selection by (dx,dy) meters.
    pub fn move_selected(&mut self, dx: f64, dy: f64) -> Result<(), JsValue> {
        self.touch();
        finite(&[dx, dy])?;
        if let Some(id) = self.doc.selection {
            if let Some(c) = self.doc.component_mut(id) {
                c.x += dx;
                c.y += dy;
            }
            // Membership follows the center (see `rebucket_component`).
            self.doc.rebucket_component(id);
        }
        Ok(())
    }

    pub fn delete_selected(&mut self) {
        self.touch();
        if let Some(id) = self.doc.selection.take() {
            self.doc.components.retain(|c| c.id != id);
            // Membership follows existence (see `rebucket_component`).
            self.doc.rebucket_component(id);
        }
    }

    /// Move a component **by id** to absolute center `(x, y)` meters. The by-id
    /// primitive the AI uses; complements the selection-based `move_selected`.
    pub fn move_component(&mut self, id: u32, x: f64, y: f64) -> Result<(), JsValue> {
        self.touch();
        finite(&[x, y])?;
        if let Some(c) = self.doc.component_mut(id) {
            c.x = x;
            c.y = y;
            // Membership follows the center (see `rebucket_component`).
            self.doc.rebucket_component(id);
        }
        Ok(())
    }

    /// Set a component's rotation (radians, clockwise in the Y-down plan).
    /// Doors/windows placed along angled walls need this; renderers already
    /// honor `Component::rotation`.
    pub fn set_component_rotation(&mut self, id: u32, radians: f64) -> Result<(), JsValue> {
        self.touch();
        finite(&[radians])?;
        if let Some(c) = self.doc.component_mut(id) {
            c.rotation = radians;
        }
        Ok(())
    }

    /// Set a component's hinge handedness (mirror across its long axis). Doors
    /// imported from CAD recover a left- vs right-hand swing this way; renderers
    /// reflect the leaf+arc when set. Additive: complements `set_component_rotation`
    /// and leaves `add_component` (default `mirror: false`) untouched.
    pub fn set_component_mirror(&mut self, id: u32, mirror: bool) {
        self.touch();
        if let Some(c) = self.doc.component_mut(id) {
            c.mirror = mirror;
        }
    }

    /// Mark a component as **passive reference** (imported/legacy CAD furniture)
    /// or back to counted. Reference components render but are excluded from every
    /// metric (workstations, pax, cost, CO2) — see `Component::reference`. The
    /// merge-stamp path (`App.stampBaseInto`) sets this `true` on imported
    /// surroundings. Additive: leaves `add_component` (default `false`) untouched.
    pub fn set_component_reference(&mut self, id: u32, reference: bool) {
        self.touch();
        if let Some(c) = self.doc.component_mut(id) {
            c.reference = reference;
        }
    }

    /// Set a component's footprint (meters). Used by the object inspector's
    /// editable W/H fields; clamped to a small positive minimum so a degenerate
    /// zero-size box can't be created.
    pub fn set_component_size(&mut self, id: u32, w: f64, h: f64) -> Result<(), JsValue> {
        self.touch();
        finite(&[w, h])?;
        if let Some(c) = self.doc.component_mut(id) {
            c.w = w.max(0.05);
            c.h = h.max(0.05);
            // Seats follow the footprint: grow a table and it seats more people.
            // Re-resolved here so the stored count can never go stale — the whole
            // contract is that the renderer reads `seats` and never recomputes it.
            c.seats = crate::model::seats_for(&c.category, c.w, c.h);
        }
        Ok(())
    }

    /// Change a component's category (which slice of the material bank + which
    /// top-view symbol it uses). The object inspector's category picker.
    pub fn set_component_category(&mut self, id: u32, category: String) {
        self.touch();
        if let Some(c) = self.doc.component_mut(id) {
            c.category = category;
            // Reclassifying changes what the object IS, so it changes how many
            // people sit at it (a Desk seats 1; the same footprint as a Table
            // seats its perimeter). Kept in lockstep with `set_component_size`.
            c.seats = crate::model::seats_for(&c.category, c.w, c.h);
        }
    }

    /// Delete a component **by id** (complements `delete_selected`). Clears the
    /// selection if it pointed at the deleted component.
    pub fn delete_component(&mut self, id: u32) {
        self.touch();
        self.doc.components.retain(|c| c.id != id);
        // Membership follows existence (see `rebucket_component`).
        self.doc.rebucket_component(id);
        if self.doc.selection == Some(id) {
            self.doc.selection = None;
        }
    }

    /// Bind a material-bank product to a component (the "re-imagine" action).
    /// `price_inr` is the observed bank price (undefined/None for spec-only
    /// suppliers); it feeds the specified-furniture cost line in `metrics()`.
    pub fn assign_product(
        &mut self,
        id: u32,
        product_id: String,
        product_name: String,
        price_inr: Option<f64>,
    ) -> Result<(), JsValue> {
        self.touch();
        // **Found by the source scan, not by the audit.** The reported defect and
        // the fifteen mutators I probed were all coordinates; this one is a
        // PRICE, and it corrupts the document just as completely — `Some(NaN)`
        // makes `serde_json::to_string` fail outright, so a bound product with a
        // NaN price is a plan that cannot be saved at all. A behavioural audit
        // covers the mutators you thought to list; this is why the structural
        // guard is the one that has to exist.
        finite(&[price_inr.unwrap_or(0.0)])?;
        if let Some(c) = self.doc.component_mut(id) {
            c.product_id = Some(product_id);
            c.label = product_name;
            c.price_inr = price_inr;
        }
        Ok(())
    }

    /// Advance a component's decision lifecycle. `state` is one of
    /// "Open" | "InReview" | "Confirmed".
    pub fn set_decision(&mut self, id: u32, state: &str) {
        self.touch();
        if let Some(c) = self.doc.component_mut(id) {
            c.decision = DecisionState::from_str(state);
        }
    }

    /// Whole document, for rendering. Returned as a plain JS object.
    pub fn state(&self) -> Result<JsValue, JsValue> {
        serde_wasm_bindgen::to_value(&self.doc).map_err(|e| JsValue::from_str(&e.to_string()))
    }

    /// **What the last `generate` decided**, for the debug overlay — see
    /// `layout/diag.rs`. Empty until `generate` has run in this session.
    ///
    /// The generator's own account of itself. It exists to point at a mechanism
    /// when a plate comes out with empty wings; it is explicitly NOT a gate
    /// input, because a check that reads this is reading the thing it checks.
    pub fn layout_diag(&self) -> Result<JsValue, JsValue> {
        serde_wasm_bindgen::to_value(&self.diag).map_err(|e| JsValue::from_str(&e.to_string()))
    }

    /// **The wall network's outline**, as strokes: `[{ a, b, wall, exterior,
    /// glazed }]` in world meters — see `wallnet.rs`.
    ///
    /// The renderer used to draw each wall as its own box (two faces plus two
    /// end caps), so every junction stacked four strokes that lie *inside* the
    /// solid, and the plan read spidery. This is the boundary of the merged
    /// network, computed where the geometry lives. Wall thickness, junction
    /// mitring and cut/interior classification all leave the renderer.
    pub fn wall_outlines(&self) -> Result<JsValue, JsValue> {
        let ext: std::collections::HashSet<u32> =
            self.doc.exterior_wall_ids().into_iter().collect();
        let segs = wallnet::outline(&self.doc.walls, &|id| ext.contains(&id));
        serde_wasm_bindgen::to_value(&segs).map_err(|e| JsValue::from_str(&e.to_string()))
    }

    /// Live metrics panel data. Areas are clipped to the traced floor-plate
    /// polygon so non-rectangular plates report true numbers (see
    /// `Document::plate_polygon`); rectangular rooms are unchanged.
    pub fn metrics(&self) -> Result<JsValue, JsValue> {
        serde_wasm_bindgen::to_value(&compute_metrics(&self.doc))
            .map_err(|e| JsValue::from_str(&e.to_string()))
    }

    /// All zones, for rendering. Part of `state()`, but exposed standalone for a
    /// cheap re-read after a zone-only edit.
    pub fn zones(&self) -> Result<JsValue, JsValue> {
        serde_wasm_bindgen::to_value(&self.doc.zones)
            .map_err(|e| JsValue::from_str(&e.to_string()))
    }

    /// Per-zone stats for the Statistics panel + AI reasoning. Array of
    /// `{ id, zone_type, label, area, capacity, seated, pct_of_nia }`.
    pub fn zone_stats(&self) -> Result<JsValue, JsValue> {
        serde_wasm_bindgen::to_value(&self.zone_rows(false))
            .map_err(|e| JsValue::from_str(&e.to_string()))
    }

    /// `zone_stats()` for **published** artifacts: identical rows, except every
    /// `Unassigned` zone reports as `Circulation`.
    ///
    /// THE fold boundary, expressed as one boolean rather than as a conditional
    /// at each export site. Every client-facing path — takeoff CSV, the PDF
    /// sheet, the QTO workbook, the report's areas split — reads this; the
    /// editor's Areas/Zones tabs read `zone_stats()` and see the truth.
    ///
    /// Rows are otherwise byte-identical, INCLUDING ids and areas, so a folded
    /// and an unfolded read of the same document agree about every number and
    /// disagree only about the word.
    pub fn zone_stats_published(&self) -> Result<JsValue, JsValue> {
        serde_wasm_bindgen::to_value(&self.zone_rows(true))
            .map_err(|e| JsValue::from_str(&e.to_string()))
    }

    /// Wrap a document so the pure readers below can be tested natively — the
    /// `#[wasm_bindgen]` methods return `JsValue` and are unreachable from
    /// `cargo test`, which is precisely why the panel's arithmetic went untested.
    #[cfg(test)]
    pub(crate) fn for_test(doc: Document) -> Editor {
        Editor { doc, rev: 0, diag: Default::default() }
    }

    /// `zone_rows`, for the invariant battery. Reads the Zones tab's actual rows
    /// rather than re-calling the metric function they are supposed to agree with.
    #[cfg(test)]
    pub(crate) fn zone_rows_for_test(&self, fold: bool) -> Vec<ZoneStat> {
        self.zone_rows(fold)
    }

    fn zone_rows(&self, fold: bool) -> Vec<ZoneStat> {
        // De-overlapped areas so the Zones tab / Areas donut sum to GEA (never
        // above it) on tilted/irregular plates — same source of truth as metrics.
        //
        // ONE BASIS. This used to call `effective_zone_areas` + `net_internal_area`
        // itself; that is one owner short of enough, because the clamp inside
        // `net_internal_area` then applied to the total while the rows kept their
        // unclamped areas, and a donut whose slices sum above its own total is the
        // Zones-tab face of the 102.469% efficiency. `area_basis` carries the clamp
        // into the areas, so `Σ row.area == nia` on every document.
        let AreaBasis { areas, spanning, nia, .. } = area_basis(&self.doc);
        let stats: Vec<ZoneStat> = self
            .doc
            .zones
            .iter()
            .enumerate()
            .map(|(i, z)| {
                let seated = z
                    .component_ids
                    .iter()
                    .filter(|&&cid| {
                        self.doc
                            .components
                            .iter()
                            .any(|c| c.id == cid && is_workstation(c))
                    })
                    .count();
                let area = areas[i];
                // FURNITURE WINS over the area rule-of-thumb.
                //
                // `Zone::capacity()` is a planning estimate (floor area ÷ m² per
                // seat) for an EMPTY room. Once a room is furnished we know the
                // real answer: the seats its furniture provides. Using the
                // estimate anyway is what put "BOARDROOM 24 m² · 9 pax" over a
                // table the plan draws with 12 chairs — the tag and the drawing
                // disagreeing about the same room, from two different sources.
                //
                // Σ of `Component::seats` is the same owner the glyph renders
                // (ui-system.md §3.6), so tag and drawing now agree by
                // construction rather than by coincidence. An unfurnished zone
                // has no seats and keeps the area estimate.
                //
                // This also subsumes the old plate-spanning-Workspace special
                // case: every desk seats exactly 1, so Σ seats over a desk field
                // IS its seated-desk count.
                // `Chair` is EXCLUDED: a chair is seating *for* a table or desk,
                // and that table already reports the seats it provides. Counting
                // both double-books the same person — a cabin holding a 2-seat
                // table plus its one chair would report 3. A desk seats its own
                // occupant (its chair is part of the desk symbol), so desks count.
                let furnished: u32 = z
                    .component_ids
                    .iter()
                    .filter_map(|&cid| self.doc.components.iter().find(|c| c.id == cid))
                    .filter(|c| !c.reference) // imported context furniture seats nobody
                    .filter(|c| c.category != "Chair")
                    .map(|c| c.seats)
                    .sum();
                let capacity = if furnished > 0 {
                    furnished
                } else if Some(i) == spanning {
                    seated as u32
                } else {
                    // THE SAME AREA THIS ROW PRINTS (R17). It read `z.capacity()`,
                    // which measured the raw shape, so the row could publish
                    // `area: 8.0, capacity: 5` — five 6 m² workstations inside
                    // eight square metres, on the unedited F1 fixture.
                    z.capacity_from_area(area)
                };
                ZoneStat {
                    id: z.id,
                    zone_type: if fold { published_zone_type(z.zone_type) } else { z.zone_type },
                    // The label follows the type through the fold, so a folded
                    // row can never read "Circulation" beside the word
                    // "Unassigned" and invite the reader to spot the seam.
                    label: if fold && z.zone_type == ZoneType::Unassigned {
                        "Circulation".to_string()
                    } else {
                        z.label.clone()
                    },
                    area,
                    capacity,
                    seated,
                    pct_of_nia: if nia > 0.0 { area / nia * 100.0 } else { 0.0 },
                }
            })
            .collect();
        stats
    }

    /// Autonomously generate a test-fit from a `Program` (plain JS object).
    /// Clears existing components, places desks + meeting rooms deterministically
    /// for `seed`, and returns the resulting `LayoutScore`.
    pub fn generate(
        &mut self,
        program: JsValue,
        seed: u64,
        keep_confirmed: bool,
    ) -> Result<JsValue, JsValue> {
        self.touch();
        let program: layout::Program =
            serde_wasm_bindgen::from_value(program).map_err(|e| JsValue::from_str(&e.to_string()))?;
        // The same rule as `finite`, applied to a struct instead of an argument
        // list: `serde_json` refuses to serialize NaN/±∞, so "is every f64 in
        // here real?" and "can this round-trip?" are literally the same question,
        // asked once. A NaN `desk_w` reaches the document as NaN geometry on
        // every desk it places — the resize_zone defect with more blast radius.
        serde_json::to_value(&program).map_err(|_| {
            JsValue::from_str(
                "the program contains a non-finite number (NaN or ±∞) — generation \
                 would place geometry no document could reopen",
            )
        })?;
        self.diag = layout::generate(&mut self.doc, &program, seed, keep_confirmed);
        serde_wasm_bindgen::to_value(&layout::score(&self.doc, &program))
            .map_err(|e| JsValue::from_str(&e.to_string()))
    }

    /// Score the current document against a `Program` without regenerating.
    pub fn layout_score(&self, program: JsValue) -> Result<JsValue, JsValue> {
        let program: layout::Program =
            serde_wasm_bindgen::from_value(program).map_err(|e| JsValue::from_str(&e.to_string()))?;
        serde_wasm_bindgen::to_value(&layout::score(&self.doc, &program))
            .map_err(|e| JsValue::from_str(&e.to_string()))
    }

    /// The traced floor-plate polygon as `[[x, y], ...]`, or `null` when the
    /// walls don't close. For frontend zone-render clipping.
    pub fn plate(&self) -> Result<JsValue, JsValue> {
        serde_wasm_bindgen::to_value(&self.doc.plate_points())
            .map_err(|e| JsValue::from_str(&e.to_string()))
    }

    /// Store the frontend CAD drafting-layer blob (opaque JSON; the core never
    /// parses it). It rides in snapshots, so undo/save round-trip it.
    pub fn set_cad_json(&mut self, json: String) {
        self.touch();
        self.doc.cad_json = if json.is_empty() { None } else { Some(json) };
    }

    /// The stored CAD drafting-layer blob, or `""` when none.
    pub fn get_cad_json(&self) -> String {
        self.doc.cad_json.clone().unwrap_or_default()
    }

    /// Circulation / "walking place" evaluation of the current document.
    pub fn circulation(&self) -> Result<JsValue, JsValue> {
        let score = circulation::evaluate(&self.doc, &circulation::CirculationConfig::new());
        serde_wasm_bindgen::to_value(&score).map_err(|e| JsValue::from_str(&e.to_string()))
    }

    /// The scoring engine's density verdict for this document, 0..100 — 100
    /// across the professional 8–12 m²/person band, tapering to 0 at ≤4.5
    /// (crammed) and ≥20 (sparse).
    ///
    /// **Exported because the frontend was deciding "too dense" on its own.**
    /// `ai/engine.ts` compared `area_per_workstation` against a hand-typed
    /// 6.0 m² whose comment said "planning norm (see layout.rs)" — a citation to
    /// a constant that has never existed there. It was also the wrong quantity:
    /// the scorer judges m² per SEAT (desks + meeting capacity), not per desk.
    /// So the AI preview warned the user off layouts the engine was perfectly
    /// happy with, in the engine's name. Whether a plan is professionally dense
    /// is one question with one answer; this is it.
    ///
    /// **`None` — `undefined` across the wasm boundary — when the plate is
    /// `Unresolved`**, and that is the whole reason the return type is not a bare
    /// `f64`. Density is m² per seat: with no identifiable floor there is no
    /// numerator, and the honest answer is that we could not measure, not a
    /// number. It used to return a confident **0.000/100** in that state — the
    /// most extreme value on the scale, indistinguishable from a genuinely
    /// crammed plan — and `ai/engine.ts` printed it verbatim as "the layout
    /// scorer's density rating". This is `Metrics::metrics_error`'s convention,
    /// not a new one: an unmeasurable value surfaces as a STATE the caller can
    /// see, absent across the boundary, never as an assertion and never as a
    /// number that looks like the others.
    ///
    /// `Open` still returns a number. `PlateResolution`'s own doc comment says
    /// the bounding box is "a reasonable stand-in" there, and it is the ordinary
    /// case for a plate imported as loose segments; `Unresolved` is the state
    /// that means the walls DO close and no face holds this plan.
    pub fn density_score(&self) -> Option<f64> {
        match self.doc.plate_resolution() {
            document::PlateResolution::Unresolved => None,
            _ => Some(layout::density_of_doc(&self.doc)),
        }
    }

    // ----- Undo primitive: lossless Document snapshot/restore (Conflict §5).
    // A snapshot is an opaque JSON string carrying the whole document *including*
    // `next_id`, so a restore can never collide ids. -----

    /// Serialize the whole document to an opaque snapshot (JSON string). Pass it
    /// back to `restore` / `from_snapshot` to undo.
    pub fn snapshot(&self) -> Result<JsValue, JsValue> {
        let s = serde_json::to_string(&self.doc).map_err(|e| JsValue::from_str(&e.to_string()))?;
        Ok(JsValue::from_str(&s))
    }

    /// Replace the current document with a previously taken `snapshot`.
    pub fn restore(&mut self, snap: JsValue) -> Result<(), JsValue> {
        self.touch();
        let s = snap
            .as_string()
            .ok_or_else(|| JsValue::from_str("snapshot must be a string"))?;
        self.doc = serde_json::from_str(&s).map_err(|e| JsValue::from_str(&e.to_string()))?;
        // Plans saved before the `seats` facet load with 0; resolve them so an
        // old plan and a new one report the same pax for the same building.
        self.doc.backfill_seats();
        Ok(())
    }

    /// Load one of the frozen **edited-plan fixtures** (`"F1"`…`"F5"`) — see
    /// `src/fixtures.rs` for what each state is and why they exist.
    ///
    /// The browser harness and `cargo test` build these from the same code, so a
    /// capture and an assertion are looking at one document rather than two that
    /// were meant to match. Unknown name → an error, never a silent empty doc.
    pub fn load_fixture(&mut self, name: &str) -> Result<(), JsValue> {
        self.touch();
        let doc = fixtures::build(name)
            .ok_or_else(|| JsValue::from_str(&format!("no such fixture: {name}")))?;
        self.doc = doc;
        // The fixture ran `generate` itself, so carry its diagnostics over —
        // otherwise the debug overlay would be blank on exactly the documents
        // the capture harness renders.
        self.diag = fixtures::last_diag();
        Ok(())
    }

    /// **THE ground set, as a VALUE across the boundary — not a shape to parse.**
    ///
    /// Every consumer of "which zone types are ground?" used to recover it by
    /// regexing `published_zone_type` for `X => ZoneType::Circulation` match
    /// arms. The adversary defeated that in two ways, both with the semantics
    /// unchanged:
    ///
    /// * **an `if`/`return` instead of a match arm** — `if t == Core { return
    ///   Circulation; }` folds `Core` into ground and the regex sees nothing.
    ///   The whole 50-step battery stayed green with the ground set silently
    ///   one type larger.
    /// * **a prose comment inside the function body** — this repo's own
    ///   convention is heavy inline explanation, and a comment merely NAMING a
    ///   type beside the arrow (`// we deliberately do NOT write
    ///   ZoneType::Meeting => ZoneType::Circulation`) put `Meeting` into the
    ///   parsed set. Size 3 passed the parser's `size < 2` non-vacuity guard,
    ///   because that guard checks the parse's SIZE, not its CORRECTNESS.
    ///
    /// Both are one class: **a form-specific reader standing in for a semantic
    /// property.** The same class produced the `.area()` census, the three TS
    /// spellings, and the `pub fn ` impl-block scan. Grepping for the shape of a
    /// definition is defeated by rewriting the shape; asking for the VALUE is
    /// not. CLAUDE.md prescribes exactly this — *"prefer exporting the value
    /// across the wasm boundary"* — and this is that export.
    ///
    /// Computed by iterating every `ZoneType` through [`is_ground_zone`], so it
    /// is the predicate's own answer rather than a second list to keep in step.
    pub fn ground_zone_types() -> Result<JsValue, JsValue> {
        // `ZoneType::ALL`, not a list written here. The previous version said it
        // iterated "every ZoneType" and iterated an eight-element literal; a
        // ninth, ground variant was invisible to it while every board stayed
        // green. See `ZoneType::ALL` for the run.
        let ground: Vec<&str> = ZoneType::ALL
            .iter()
            .copied()
            .filter(|t| is_ground_zone(*t))
            .map(ZoneType::name)
            .collect();
        serde_wasm_bindgen::to_value(&ground).map_err(|e| JsValue::from_str(&e.to_string()))
    }

    /// **The type space itself, published** — `ZoneType::ALL`, so no consumer
    /// has to author a list of variants to iterate. Three did, and a ninth
    /// variant was invisible to all three at once.
    pub fn zone_type_names() -> Result<JsValue, JsValue> {
        let names: Vec<&str> = ZoneType::ALL.iter().copied().map(ZoneType::name).collect();
        serde_wasm_bindgen::to_value(&names).map_err(|e| JsValue::from_str(&e.to_string()))
    }

    /// The fixture ids, in order, so a harness enumerates rather than hard-codes.
    pub fn fixture_ids() -> Result<JsValue, JsValue> {
        serde_wasm_bindgen::to_value(&fixtures::FIXTURE_IDS)
            .map_err(|e| JsValue::from_str(&e.to_string()))
    }

    /// Construct a fresh `Editor` from a `snapshot` (scratch-clone for previews).
    pub fn from_snapshot(snap: JsValue) -> Result<Editor, JsValue> {
        let s = snap
            .as_string()
            .ok_or_else(|| JsValue::from_str("snapshot must be a string"))?;
        let mut doc: Document =
            serde_json::from_str(&s).map_err(|e| JsValue::from_str(&e.to_string()))?;
        doc.backfill_seats();
        Ok(Editor { doc, rev: 0, diag: Default::default() })
    }

    // ----- Zone ops — thin wrappers over `Document` methods. Each returns the
    // new id(s) or throws the `ZoneError` reason as a string JsValue. -----

    /// Merge zones `a` and `b`; returns the resulting zone id (a clean rect union
    /// reuses `a`'s id) or the shared group id (logical L-room) as a number.
    pub fn merge_zones(&mut self, a: u32, b: u32) -> Result<JsValue, JsValue> {
        self.touch();
        let id = self
            .doc
            .merge_zones(a, b)
            .map_err(|e| JsValue::from_str(&e.to_string()))?;
        Ok(JsValue::from_f64(id as f64))
    }

    /// Split zone `id` along `axis` ("Vertical" | "Horizontal") at world coord
    /// `at`; returns `[id1, id2]`.
    pub fn split_zone(&mut self, id: u32, axis: &str, at: f64) -> Result<JsValue, JsValue> {
        self.touch();
        let axis = match axis {
            "Vertical" => Axis::Vertical,
            "Horizontal" => Axis::Horizontal,
            _ => return Err(JsValue::from_str("axis must be \"Vertical\" or \"Horizontal\"")),
        };
        let (a, b) = self
            .doc
            .split_zone(id, axis, at)
            .map_err(|e| JsValue::from_str(&e.to_string()))?;
        serde_wasm_bindgen::to_value(&[a, b]).map_err(|e| JsValue::from_str(&e.to_string()))
    }

    /// Reclassify zone `id` to `zone_type` (one of the serde `ZoneType` tags,
    /// e.g. "Workspace"). Distinct from the component-level `set_decision`.
    pub fn set_zone_type(&mut self, id: u32, zone_type: &str) -> Result<(), JsValue> {
        self.touch();
        let t: ZoneType = serde_json::from_str(&format!("\"{}\"", zone_type))
            .map_err(|_| JsValue::from_str("unknown zone type"))?;
        self.doc
            .set_zone_type(id, t)
            .map_err(|e| JsValue::from_str(&e.to_string()))
    }

    /// Resize/move zone `id` to a `Rect` (center `x,y`, size `w,h`). Rejected if
    /// the new bbox exceeds the wall bbox.
    pub fn resize_zone(&mut self, id: u32, x: f64, y: f64, w: f64, h: f64) -> Result<(), JsValue> {
        self.touch();
        self.doc
            .resize_zone(id, ZoneShape::Rect { x, y, w, h })
            .map_err(|e| JsValue::from_str(&e.to_string()))
    }

    /// The most-specific zone id containing world point `(x, y)`, or undefined.
    pub fn zone_at(&self, x: f64, y: f64) -> Option<u32> {
        self.doc.zone_at(x, y)
    }

    /// Create a `Rect` zone (center `x,y`, size `w,h`) of `zone_type`; returns the
    /// new zone id. The direct-manipulation "duplicate room" / "draw room"
    /// primitive.
    pub fn add_zone(
        &mut self,
        zone_type: &str,
        x: f64,
        y: f64,
        w: f64,
        h: f64,
        label: String,
    ) -> Result<JsValue, JsValue> {
        self.touch();
        let t: ZoneType = serde_json::from_str(&format!("\"{}\"", zone_type))
            .map_err(|_| JsValue::from_str("unknown zone type"))?;
        let id = self
            .doc
            .add_zone(t, ZoneShape::Rect { x, y, w, h }, label)
            .map_err(|e| JsValue::from_str(&e.to_string()))?;
        Ok(JsValue::from_f64(id as f64))
    }

    /// Delete a room by zone id: removes the zone and the furniture it contains.
    pub fn delete_zone(&mut self, id: u32) -> Result<(), JsValue> {
        self.touch();
        self.doc
            .delete_zone(id)
            .map_err(|e| JsValue::from_str(&e.to_string()))
    }

    /// Rename a zone's label (e.g. to match a reclassified type).
    pub fn rename_zone(&mut self, id: u32, label: String) -> Result<(), JsValue> {
        self.touch();
        self.doc
            .rename_zone(id, label)
            .map_err(|e| JsValue::from_str(&e.to_string()))
    }

    /// Move an existing wall's endpoints (by id) to `a=(ax,ay)`, `b=(bx,by)`.
    /// No-op if the id is unknown. Lets an interior partition wall travel with a
    /// room during drag/resize (generated plans have none; hand-drawn walls do).
    pub fn set_wall(
        &mut self,
        id: u32,
        ax: f64,
        ay: f64,
        bx: f64,
        by: f64,
    ) -> Result<(), JsValue> {
        self.touch();
        finite(&[ax, ay, bx, by])?;
        if let Some(w) = self.doc.walls.iter_mut().find(|w| w.id == id) {
            w.a = Point::new(ax, ay);
            w.b = Point::new(bx, by);
        }
        Ok(())
    }

    /// Set a wall's height in meters. Anything `>= 0` and below the full storey
    /// height ([`model::FULL_WALL_HEIGHT_M`]) makes it a **partial-height screen**
    /// and moves its run into the takeoff's `Half Drywall` category; pass a
    /// negative value (or the full height) to clear the override back to full
    /// height. No-op if the id is unknown. This is the only writer of
    /// `Wall::height_m` — the generator has no partial-height primitive.
    pub fn set_wall_height(&mut self, id: u32, height_m: f64) -> Result<(), JsValue> {
        self.touch();
        finite(&[height_m])?;
        if let Some(w) = self.doc.walls.iter_mut().find(|w| w.id == id) {
            w.height_m = if height_m > 0.0 && height_m < model::FULL_WALL_HEIGHT_M {
                Some(height_m)
            } else {
                None
            };
        }
        Ok(())
    }

    // ----- Quantity surface (`quantity.rs`): the geometric truth the Quantity
    // Takeoff workbook reads. Every number is computed from the document, never
    // typed. `qtoWorkbook.ts` joins it with the TS-only finish/furniture data to
    // produce `out/ground-truth.json`, which `scripts/gates/g3-quantity-truth.py`
    // then cross-checks against the workbook's cells. -----

    /// Wall run length + elevational area per wall type, door count/width per
    /// door type, and per-room area/headcount — all derived from geometry.
    /// Shape: `{ sqfPerM2, wallHeightM, floorAreaM2, walls[], doors[],
    /// doorCount, doorTotalWidthM, rooms[] }`. See `quantity::Quantities`.
    pub fn quantities(&self) -> Result<JsValue, JsValue> {
        serde_wasm_bindgen::to_value(&quantity::quantities(&self.doc))
            .map_err(|e| JsValue::from_str(&e.to_string()))
    }

    /// Per-wall classification for the **plan renderer**:
    /// `[{ id, wallType, planKey, lengthM }, ...]` in document order, where
    /// `planKey` is a `qbiqPalette.ts` `WallType` (`"drywall"`, `"glass"`, …).
    /// The renderer must colour from THIS rather than re-deriving types in TS —
    /// that is what keeps the coloured plan and the billed workbook in agreement.
    pub fn wall_types(&self) -> Result<JsValue, JsValue> {
        serde_wasm_bindgen::to_value(&quantity::classify_walls(&self.doc))
            .map_err(|e| JsValue::from_str(&e.to_string()))
    }

}

impl Default for Editor {
    fn default() -> Self {
        Editor::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::geometry::Point;
    use crate::zone::Zone;

    /// The revision counter is only safe to cache against if EVERY mutator bumps
    /// it — one that forgets makes the frontend render a stale document, and the
    /// bug would surface as "the canvas didn't update", far from its cause.
    ///
    /// Rather than trust review, scan our own source: every `pub fn` taking
    /// `&mut self` must open its body with `self.touch()`. A new mutator added
    /// without one fails here, at the moment it is written. (Signatures wrap
    /// across lines, so this matches the whole parameter list, not one line —
    /// the miss that this test was written to catch.)
    #[test]
    fn every_mutator_bumps_the_revision() {
        let src = include_str!("lib.rs");
        let mut missing: Vec<&str> = Vec::new();
        let mut checked = 0usize;
        for (idx, _) in src.match_indices("pub fn ") {
            let after = &src[idx + "pub fn ".len()..];
            let Some(open) = after.find('(') else { continue };
            let name = after[..open].trim();
            let Some(close) = after.find(')') else { continue };
            if close < open || !after[open..close].contains("&mut self") {
                continue;
            }
            let Some(brace) = after[close..].find('{') else { continue };
            let body = &after[close + brace + 1..];
            checked += 1;
            if !body.trim_start().starts_with("self.touch();") {
                missing.push(name);
            }
        }
        assert!(checked >= 30, "expected to find the mutator set, saw {checked}");
        assert!(
            missing.is_empty(),
            "these &mut self methods do not bump the revision counter — add \
             `self.touch();` as the first statement of each: {missing:?}"
        );
    }

    /// **Every `f64` mutator is guarded, and a new one cannot be added without a
    /// guard.** The structural half of finding M2; the behavioural half is
    /// `no_mutator_can_write_a_document_that_cannot_reopen` below.
    ///
    /// Written as a source scan for the same reason `every_mutator_bumps_the_revision`
    /// is: the failure being prevented is *a method somebody adds next year*, and
    /// no behavioural test can enumerate a method that does not exist yet. M2 was
    /// reported against `resize_zone`; the audit found **all fifteen** f64
    /// mutators accepting NaN, which is what a report about one call site usually
    /// means (`.claude/rules/gate-independence.md`, "a known hazard patched at one
    /// call site").
    ///
    /// **R10 AXES — this guard's falsification varies:** the MUTATOR (all fifteen,
    /// not the one reported), the VALUE (`NaN`, `+∞`, `-∞` — the audit's first
    /// pass tested only NaN and would have missed an `is_nan()`-only guard), and
    /// the LAYER (wasm boundary via `finite`, document layer via
    /// `zone_shape_admissible`, struct layer via `serde_json::to_value`).
    #[test]
    fn every_f64_mutator_is_guarded_against_non_finite_input() {
        // Guarded one layer down, in `Document`, by `zone_shape_admissible` /
        // `split_zone`'s own check — which is STRICTER, because it also covers
        // Rust callers the wasm boundary never sees. Each name here is a claim
        // the behavioural test below re-checks by driving it with NaN.
        const GUARDED_IN_DOCUMENT: [&str; 3] = ["resize_zone", "add_zone", "split_zone"];
        // Guarded by `serde_json::to_value`, which refuses NaN/±∞ for the whole
        // struct at once — the f64s arrive inside `Program`, not as arguments.
        const GUARDED_BY_SERDE: [&str; 1] = ["generate"];

        let src = include_str!("lib.rs");
        let mut unguarded: Vec<&str> = Vec::new();
        let mut checked = 0usize;
        for (idx, _) in src.match_indices("pub fn ") {
            let after = &src[idx + "pub fn ".len()..];
            let Some(open) = after.find('(') else { continue };
            let name = after[..open].trim();
            let Some(close) = after.find(')') else { continue };
            if close < open {
                continue;
            }
            let params = &after[open..close];
            if !params.contains("&mut self") || !params.contains("f64") {
                continue;
            }
            checked += 1;
            if GUARDED_IN_DOCUMENT.contains(&name) || GUARDED_BY_SERDE.contains(&name) {
                continue;
            }
            let Some(brace) = after[close..].find('{') else { continue };
            // The real body, by brace balance — not a fixed window. A fixed
            // window is a threshold on comment length, and this file's comments
            // are long on purpose: the first draft used 400 chars and reported
            // `assign_product` unguarded when its guard was simply below a
            // paragraph explaining why it exists.
            let body_start = close + brace;
            let mut depth = 0i32;
            let mut end = after.len();
            for (i, ch) in after[body_start..].char_indices() {
                match ch {
                    '{' => depth += 1,
                    '}' => {
                        depth -= 1;
                        if depth == 0 {
                            end = body_start + i;
                            break;
                        }
                    }
                    _ => {}
                }
            }
            let body = &after[body_start..end];
            // **Before the first write, not merely somewhere in the body.** A
            // guard that runs after the document has been touched is not a guard.
            let guard = body.find("finite(&[");
            let write = body.find("self.doc");
            match (guard, write) {
                (Some(g), Some(w)) if g < w => {}
                (Some(_), None) => {}
                _ => unguarded.push(name),
            }
        }
        assert!(checked >= 12, "expected the f64 mutator set, saw {checked}");
        assert!(
            unguarded.is_empty(),
            "these &mut self methods take an f64 and never check it is finite — \
             add `finite(&[..])?;` after `self.touch();`, or guard it one layer \
             down and name it in this test's list: {unguarded:?}"
        );
    }

    /// **No zone mutator may write a document that cannot be reopened.**
    ///
    /// The property, not the fix. `resize_zone(id, NaN, NaN, NaN, NaN)` returned
    /// `Ok`, dropped NIA 899.789 → 348.029 with no error, serialized the zone as
    /// `{"x":null,…}`, and `from_snapshot` then threw
    /// `invalid type: null, expected f64` — the `.dsource` saved and could never
    /// be reopened. So the assertion is the round trip itself: `serde_json`
    /// refuses to serialize NaN/±∞, which makes "did this write a non-finite
    /// number?" and "can this still be saved?" the same question.
    ///
    /// **This covers the DOCUMENT layer only.** The `Editor` (wasm) layer cannot
    /// be driven from `cargo test` on its error paths at all: `JsValue::from_str`
    /// panics with *"function not implemented on non-wasm32 targets"*, which is
    /// the same reason the panel's arithmetic went untested and produced the
    /// 1159%. The boundary audit therefore lives in
    /// `web/src/core/mutatorGuards.test.mjs`, against the RELEASE wasm — the
    /// build the user runs, and the build M1's `debug_assert!` did not exist in.
    #[test]
    fn no_zone_mutator_can_write_a_document_that_cannot_reopen() {
        for bad in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
            let base = fixtures::build("F1").expect("F1 builds");
            let before = serde_json::to_string(&base).expect("F1 round-trips to begin with");
            let zid = base.zones[0].id;

            let mut d = base.clone();
            assert!(
                d.resize_zone(zid, ZoneShape::Rect { x: bad, y: bad, w: bad, h: bad }).is_err(),
                "resize_zone({bad}) returned Ok"
            );
            assert_eq!(serde_json::to_string(&d).unwrap(), before, "resize_zone({bad}) still wrote");

            let mut d = base.clone();
            assert!(
                d.add_zone(
                    ZoneType::Workspace,
                    ZoneShape::Rect { x: bad, y: bad, w: bad, h: bad },
                    "z".into()
                )
                .is_err(),
                "add_zone({bad}) returned Ok"
            );
            assert_eq!(serde_json::to_string(&d).unwrap(), before, "add_zone({bad}) still wrote");

            let mut d = base.clone();
            assert!(
                d.split_zone(zid, Axis::Vertical, bad).is_err(),
                "split_zone(at = {bad}) returned Ok"
            );
            assert_eq!(serde_json::to_string(&d).unwrap(), before, "split_zone({bad}) still wrote");
        }
    }

    /// **M3: `add_zone` was unguarded where `resize_zone` was guarded.**
    /// `add_zone(5000, 5000, 200, 200)` billed `area 0 · capacity 6666` and took
    /// a plan's published capacity from 131 to 6797. Both writers now share one
    /// admissibility test, so the pair is asserted together — a guard on only one
    /// of two writers of the same invariant is the bypass, not the guard.
    #[test]
    fn both_zone_writers_refuse_an_off_plate_shape() {
        let base = fixtures::build("F1").expect("F1 builds");
        let off = ZoneShape::Rect { x: 5000.0, y: 5000.0, w: 200.0, h: 200.0 };

        let mut d = base.clone();
        assert!(d.add_zone(ZoneType::Workspace, off.clone(), "off".into()).is_err());
        assert_eq!(d.zones.len(), base.zones.len(), "the off-plate zone was created anyway");

        let mut d = base.clone();
        assert!(d.resize_zone(base.zones[0].id, off).is_err());
    }

    /// The guard must not have been bought by refusing ordinary input.
    #[test]
    fn the_non_finite_guard_does_not_refuse_ordinary_edits() {
        let mut d = fixtures::build("F1").expect("F1 builds");
        let before = d.zones.len();
        let zid = d.zones[0].id;
        let (x, y, w, h) = match d.zones[0].shape {
            ZoneShape::Rect { x, y, w, h } => (x, y, w, h),
            _ => panic!("F1's first zone is a Rect"),
        };
        d.resize_zone(zid, ZoneShape::Rect { x, y, w: w * 0.9, h: h * 0.9 })
            .expect("a real resize");
        d.add_zone(ZoneType::Workspace, ZoneShape::Rect { x, y, w: 2.0, h: 2.0 }, "real".into())
            .expect("a real zone");
        d.split_zone(zid, Axis::Vertical, x).expect("a real split");
        assert!(d.zones.len() > before);
        serde_json::to_string(&d).expect("still saveable");
    }

    #[test]
    fn revision_advances_on_mutation_and_holds_still_on_reads() {
        let mut ed = Editor::new();
        let start = ed.revision();
        // Reads must never advance it, or the cache invalidates on every frame.
        let _ = ed.revision();
        assert_eq!(ed.revision(), start, "revision() itself must not mutate");

        ed.add_wall(0.0, 0.0, 5.0, 0.0, 0.2).expect("finite");
        let after_wall = ed.revision();
        assert_ne!(after_wall, start, "add_wall must bump the revision");

        let id = ed.add_component("Desk".into(), 1.0, 1.0, 1.4, 0.7).expect("finite");
        assert_ne!(ed.revision(), after_wall, "add_component must bump the revision");
        let after_add = ed.revision();

        // A no-op-looking mutation still counts: the frontend needs to re-read
        // rather than guess whether the write changed anything.
        ed.move_component(id, 1.0, 1.0).expect("finite");
        assert_ne!(ed.revision(), after_add, "move_component must bump the revision");
    }

    fn desk(id: u32, x: f64, y: f64, reference: bool) -> Component {
        Component {
            id,
            category: "Desk".into(),
            x,
            y,
            w: 1.4,
            h: 0.7,
            rotation: 0.0,
            mirror: false,
            reference,
            label: format!("Desk {id}"),
            product_id: None,
            price_inr: None,
            seats: 0, // test fixture: seat count is irrelevant to what these assert
            decision: DecisionState::Open,
        }
    }

    /// The metrics count only GENERATED (non-reference) content: a doc with N
    /// generated desks + M imported reference desks — all inside the Workspace —
    /// reports `workstations == N` and `area_per_workstation == NIA / N`, never
    /// the polluted N+M that the old "every `Desk` component" count produced.
    #[test]
    fn workstations_exclude_reference_and_drive_area_per_ws() {
        let mut doc = Document::new();
        // A 20×10 plate (wall bbox → floor area 200 m²).
        for (a, b) in [
            ((0.0, 0.0), (20.0, 0.0)),
            ((20.0, 0.0), (20.0, 10.0)),
            ((20.0, 10.0), (0.0, 10.0)),
            ((0.0, 10.0), (0.0, 0.0)),
        ] {
            let id = doc.alloc_id();
            doc.walls.push(Wall {
                id,
                a: Point::new(a.0, a.1),
                b: Point::new(b.0, b.1),
                thickness: 0.1,
                generated: false,
                glazing: false,
                height_m: None,
            });
        }
        // One Workspace zone covering the whole plate.
        let zid = doc.alloc_id();
        doc.zones.push(Zone {
            id: zid,
            zone_type: ZoneType::Workspace,
            shape: ZoneShape::Rect { x: 10.0, y: 5.0, w: 20.0, h: 10.0 },
            label: "Open Workspace".into(),
            component_ids: Vec::new(),
            group: None,
            origin: Default::default(),
        });

        let n_generated = 8;
        let m_reference = 5;
        for i in 0..n_generated {
            let id = doc.alloc_id();
            doc.components.push(desk(id, 2.0 + i as f64, 3.0, false));
        }
        for i in 0..m_reference {
            let id = doc.alloc_id();
            doc.components.push(desk(id, 2.0 + i as f64, 7.0, true)); // imported reference
        }
        doc.reassign_components(); // bucket all desks into the workspace zone

        // Only the N generated desks count — the M reference desks are excluded.
        assert_eq!(workstation_count(&doc), n_generated as usize);

        // area_per_workstation == NIA / N (NIA == 200 here, so ~25 m²/ws), NOT
        // NIA / (N+M) which would be the polluted, too-tight figure.
        let (areas, _) = raw_zone_areas_unscaled(&doc);
        let floor_area = doc.floor_area();
        let nia: f64 = areas.iter().sum::<f64>().min(floor_area);
        let apw = nia / workstation_count(&doc) as f64;
        assert!((apw - nia / n_generated as f64).abs() < 1e-9);
        assert!(apw > nia / (n_generated + m_reference) as f64, "reference must not tighten m²/ws");
    }

    // =====================================================================
    // Reference-facet invariants (INV1–INV5). These drive the SAME pure
    // functions `metrics()` / `zone_stats()` / `cost::specified_cost` delegate
    // to, so a green suite here == the wasm surface agrees. (The wasm methods
    // themselves return `JsValue`, so they are exercised end-to-end from the
    // node harnesses `mergePricing.test.mjs` + `stats.test.mjs`.)
    // =====================================================================

    /// General component builder (any category / reference / bound price).
    fn comp(id: u32, category: &str, x: f64, y: f64, reference: bool, price: Option<f64>) -> Component {
        Component {
            id,
            category: category.into(),
            x,
            y,
            w: 1.4,
            h: 0.7,
            rotation: 0.0,
            mirror: false,
            reference,
            label: format!("{category} {id}"),
            product_id: price.map(|_| format!("p{id}")),
            price_inr: price,
            seats: 0, // test fixture: seat count is irrelevant to what these assert
            decision: DecisionState::Open,
        }
    }

    fn add_rect_zone(doc: &mut Document, zt: ZoneType, x: f64, y: f64, w: f64, h: f64) -> u32 {
        let id = doc.alloc_id();
        doc.zones.push(Zone {
            id,
            zone_type: zt,
            shape: ZoneShape::Rect { x, y, w, h },
            label: format!("{zt:?}"),
            component_ids: Vec::new(),
            group: None,
            origin: Default::default(),
        });
        id
    }

    /// A 20×10 plate (floor 200 m²). Left half is a Workspace zone (x∈[0,10]); a
    /// Meeting zone sits at x∈[10,16]; x∈[16,20] is left UNZONED so both the
    /// "desk in a non-Workspace zone" and "desk in NO zone" cases are reachable.
    /// No zone's footprint equals the wall bbox, so `effective_zone_areas` never
    /// treats one as the plate-spanning field (no de-overlap surprise).
    fn plate_ws_meeting_gap() -> Document {
        let mut doc = Document::new();
        for (a, b) in [
            ((0.0, 0.0), (20.0, 0.0)),
            ((20.0, 0.0), (20.0, 10.0)),
            ((20.0, 10.0), (0.0, 10.0)),
            ((0.0, 10.0), (0.0, 0.0)),
        ] {
            let id = doc.alloc_id();
            doc.walls.push(Wall {
                id,
                a: Point::new(a.0, a.1),
                b: Point::new(b.0, b.1),
                thickness: 0.1,
                generated: false,
                glazing: false,
                height_m: None,
            });
        }
        add_rect_zone(&mut doc, ZoneType::Workspace, 5.0, 5.0, 10.0, 10.0); // x∈[0,10]
        add_rect_zone(&mut doc, ZoneType::Meeting, 13.0, 5.0, 6.0, 6.0); // x∈[10,16]
        doc
    }

    /// RHS of INV1: Σ over Workspace zones of the per-zone `seated`, recomputed
    /// byte-for-byte as `zone_stats()` computes it. Must equal `workstation_count`.
    fn workspace_seated_sum(doc: &Document) -> usize {
        doc.zones
            .iter()
            .filter(|z| z.zone_type == ZoneType::Workspace)
            .map(|z| {
                z.component_ids
                    .iter()
                    .filter(|&&cid| doc.components.iter().any(|c| c.id == cid && is_workstation(c)))
                    .count()
            })
            .sum()
    }

    /// `metrics().area_per_workstation`, recomputed from identical pure inputs.
    fn area_per_ws(doc: &Document) -> f64 {
        let (areas, _) = raw_zone_areas_unscaled(doc);
        let nia: f64 = areas.iter().sum::<f64>().min(doc.floor_area());
        let ws = workstation_count(doc);
        if ws > 0 {
            nia / ws as f64
        } else {
            0.0
        }
    }

    /// INV1: `workstation_count` (== `metrics().workstations`) equals Σ over
    /// Workspace zones of `zone_stats().seated` — the two are the SAME computation,
    /// so they can't drift. A desk in a Meeting zone is `seated` there but is never
    /// a workstation/pax; a desk in NO zone counts nowhere. Both facts hold in Rust
    /// AND (by the same `seated`) in `stats.ts` `zonePax`, so the surfaces agree.
    #[test]
    fn inv1_workstations_equal_workspace_seated_and_define_unzoned_and_wrong_zone() {
        let mut doc = plate_ws_meeting_gap();
        // 3 counted desks (workspace), 1 desk in the Meeting zone, 1 desk in the
        // unzoned strip, 2 reference desks in the workspace.
        for (x, y) in [(2.0, 5.0), (4.0, 5.0), (6.0, 5.0)] {
            let id = doc.alloc_id();
            doc.components.push(comp(id, "Desk", x, y, false, None));
        }
        let meeting_desk = doc.alloc_id();
        doc.components.push(comp(meeting_desk, "Desk", 13.0, 5.0, false, None)); // in Meeting zone
        let unzoned = doc.alloc_id();
        doc.components.push(comp(unzoned, "Desk", 18.0, 5.0, false, None)); // in NO zone (x∈[16,20])
        for (x, y) in [(3.0, 3.0), (3.5, 7.0)] {
            let id = doc.alloc_id();
            doc.components.push(comp(id, "Desk", x, y, true, None)); // reference, in workspace
        }
        doc.reassign_components();

        // INV1: the single number agrees between the two Rust surfaces.
        assert_eq!(workstation_count(&doc), 3, "3 non-reference desks in the Workspace");
        assert_eq!(
            workstation_count(&doc),
            workspace_seated_sum(&doc),
            "metrics().workstations must equal Σ Workspace zone_stats().seated"
        );

        // A desk in the Meeting zone is `seated` there (documented behavior) but is
        // NOT a workstation/pax — the Meeting zone contributes 0 to pax in stats.ts.
        let meeting = doc.zones.iter().find(|z| z.zone_type == ZoneType::Meeting).unwrap();
        let meeting_seated = meeting
            .component_ids
            .iter()
            .filter(|&&cid| doc.components.iter().any(|c| c.id == cid && is_workstation(c)))
            .count();
        assert_eq!(meeting_seated, 1, "the desk in the Meeting zone is seated there");
        // …yet it never inflates workstations (only Workspace seats count).

        // The unzoned desk belongs to no zone's component_ids at all.
        assert!(
            !doc.zones.iter().any(|z| z.component_ids.contains(&unzoned)),
            "an unzoned desk is in no component_ids → counted nowhere"
        );
    }

    /// D-FRESH (Workstream D gate, watched RED 2026-08-12 before the fix):
    /// **every component mutator that changes existence or center keeps the pax
    /// membership fresh.**
    ///
    /// `Zone::component_ids` is DERIVED state — "the components whose center the
    /// zone contains" (`reassign_components`'s own definition) — and every pax
    /// figure reads it as ground truth: `zone_stats().seated`, the furnished arm
    /// of `capacity` (the canvas tag's "N pax"), `metrics().workstations`, QTO
    /// room attribution (`qto.rs`), and `delete_zone`'s furniture sweep. Zone
    /// mutators all rebuild it; the five component mutators (`add_component`,
    /// `move_component`, `move_selected`, `delete_component`, `delete_selected`)
    /// did not — so a desk hand-added into a room was invisible to the room's
    /// tag until an unrelated zone edit, a desk dragged OUT kept being counted
    /// where it no longer was, and `delete_zone` would delete furniture the user
    /// had already dragged elsewhere. The tag asserting what the document's
    /// geometry doesn't contain is exactly the silent-disagreement window
    /// Workstream D pre-registered.
    ///
    /// RED transcript (pre-fix): `seated == 0` right after `add_component` into
    /// the room ("a desk added inside a room is seated there immediately"), and
    /// the Workspace row still `seated == 1` after `move_component` took the
    /// desk to the Meeting room.
    #[test]
    fn component_mutators_keep_pax_membership_fresh() {
        let mut ed = Editor::for_test(plate_ws_meeting_gap());
        let row = |ed: &Editor, t: ZoneType| {
            ed.zone_rows_for_test(false)
                .into_iter()
                .find(|r| r.zone_type == t)
                .expect("plate has this zone")
        };

        // Hand-add a desk inside the Workspace half (palette / paste /
        // duplicate-room path — all route through `add_component`).
        let id = ed.add_component("Desk".into(), 5.0, 5.0, 1.4, 0.7).expect("finite");
        assert_eq!(
            row(&ed, ZoneType::Workspace).seated,
            1,
            "a desk added inside a room is seated there immediately"
        );
        assert_eq!(
            row(&ed, ZoneType::Workspace).capacity,
            1,
            "…and the tag's capacity takes the furnished arm, not the area estimate"
        );

        // Drag it into the Meeting room (inspector X/Y + AI move path).
        ed.move_component(id, 13.0, 5.0).expect("finite");
        assert_eq!(
            row(&ed, ZoneType::Workspace).seated,
            0,
            "a desk dragged out stops being counted where it no longer is"
        );
        assert_eq!(
            row(&ed, ZoneType::Meeting).seated,
            1,
            "…and starts being counted where it now is"
        );

        // The selection-based move (canvas drag / arrow keys).
        ed.select_at(13.0, 5.0).expect("finite");
        ed.move_selected(-8.0, 0.0).expect("finite"); // back to (5, 5)
        assert_eq!(
            row(&ed, ZoneType::Workspace).seated,
            1,
            "move_selected re-buckets exactly like move_component"
        );

        // A desk added in the unzoned strip (x∈[16,20]) joins NO membership.
        let outside = ed.add_component("Desk".into(), 18.0, 5.0, 1.4, 0.7).expect("finite");
        assert!(
            !ed.doc.zones.iter().any(|z| z.component_ids.contains(&outside)),
            "a desk added outside every zone is counted nowhere"
        );

        // Independence check (gate-independence): the incremental bookkeeping
        // must agree with a full rebuild — re-derive ground truth by running
        // `reassign_components` on a CLONE and comparing memberships as sets.
        let mut rebuilt = ed.doc.clone();
        rebuilt.reassign_components();
        let sets = |d: &Document| -> Vec<Vec<u32>> {
            d.zones
                .iter()
                .map(|z| {
                    let mut v = z.component_ids.clone();
                    v.sort_unstable();
                    v
                })
                .collect()
        };
        assert_eq!(
            sets(&ed.doc),
            sets(&rebuilt),
            "incremental rebucketing and a full reassign must agree zone-by-zone"
        );

        // Deletion strips the id from every membership (both delete paths).
        ed.delete_component(outside);
        ed.select_at(5.0, 5.0).expect("finite");
        ed.delete_selected();
        assert_eq!(row(&ed, ZoneType::Workspace).seated, 0, "deleted desks seat nobody");
        assert!(
            !ed.doc.zones.iter().any(|z| {
                z.component_ids.contains(&id) || z.component_ids.contains(&outside)
            }),
            "no membership retains a deleted component's id"
        );
    }

    /// INV2 (count side): flipping a desk to `reference` decrements the count IFF
    /// it was a counted (in-Workspace, non-reference) desk; flipping an unzoned or
    /// wrong-zone or already-reference desk is a no-op. `set_component_reference`
    /// is the live mutator; here we flip the field directly (same effect).
    #[test]
    fn inv2_flip_to_reference_decrements_only_counted_desks() {
        let mut doc = plate_ws_meeting_gap();
        let ws_desk = doc_next(&mut doc);
        doc.components.push(comp(ws_desk, "Desk", 2.0, 5.0, false, None));
        let meeting_desk = doc_next(&mut doc);
        doc.components.push(comp(meeting_desk, "Desk", 13.0, 5.0, false, None));
        let unzoned = doc_next(&mut doc);
        doc.components.push(comp(unzoned, "Desk", 18.0, 5.0, false, None));
        doc.reassign_components();
        assert_eq!(workstation_count(&doc), 1);

        // Flip the wrong-zone (Meeting) desk → no change (was never counted).
        doc.component_mut(meeting_desk).unwrap().reference = true;
        assert_eq!(workstation_count(&doc), 1, "flipping a Meeting-zone desk changes nothing");
        // Flip the unzoned desk → no change.
        doc.component_mut(unzoned).unwrap().reference = true;
        assert_eq!(workstation_count(&doc), 1, "flipping an unzoned desk changes nothing");
        // Flip the counted workspace desk → decrement to 0.
        doc.component_mut(ws_desk).unwrap().reference = true;
        assert_eq!(workstation_count(&doc), 0, "flipping the counted desk decrements");
        // Flip it back → increment.
        doc.component_mut(ws_desk).unwrap().reference = false;
        assert_eq!(workstation_count(&doc), 1, "un-referencing re-counts it");
    }

    /// INV2 (cost side): `specified_cost` excludes reference furniture regardless
    /// of category, and flipping a bound desk to reference drops its price. A
    /// reference desk with a real bound price must contribute 0 (Laiout: legacy
    /// isn't purchased); a non-reference bound item MUST count.
    #[test]
    fn inv2_specified_cost_excludes_reference() {
        let mut doc = plate_ws_meeting_gap();
        let paid = doc_next(&mut doc);
        doc.components.push(comp(paid, "Desk", 2.0, 5.0, false, Some(5_000.0))); // counts
        let legacy = doc_next(&mut doc);
        doc.components.push(comp(legacy, "Desk", 4.0, 5.0, true, Some(9_000.0))); // reference → 0
        let legacy_chair = doc_next(&mut doc);
        doc.components.push(comp(legacy_chair, "Chair", 5.0, 5.0, true, Some(1_500.0))); // reference → 0
        doc.reassign_components();

        assert_eq!(cost::specified_cost(&doc), 5_000.0, "only the non-reference bound item counts");

        // Flip the counted desk to reference → cost drops to 0.
        doc.component_mut(paid).unwrap().reference = true;
        assert_eq!(cost::specified_cost(&doc), 0.0, "reference furniture contributes 0 to cost");
        // Adopt the legacy desk into the fit-out (un-reference) → its price counts.
        doc.component_mut(legacy).unwrap().reference = false;
        assert_eq!(cost::specified_cost(&doc), 9_000.0, "un-referenced bound desk re-enters cost");
    }

    /// INV3: `area_per_workstation` is NIA / workstations, and is a defined finite
    /// 0.0 (never NaN / div-by-zero) when workstations == 0 — including the
    /// all-reference doc and the empty doc (floor_area 0).
    #[test]
    fn inv3_area_per_workstation_is_finite_and_zero_guarded() {
        // All-reference doc: workstations 0 → apw 0.0 finite.
        let mut doc = plate_ws_meeting_gap();
        for i in 0..4 {
            let id = doc_next(&mut doc);
            doc.components.push(comp(id, "Desk", 2.0 + i as f64, 5.0, true, None));
        }
        doc.reassign_components();
        assert_eq!(workstation_count(&doc), 0);
        let apw = area_per_ws(&doc);
        assert!(apw.is_finite() && apw == 0.0, "all-reference → 0 m²/ws, no NaN (got {apw})");

        // Empty doc: no walls, no zones, no components — still 0.0, no NaN.
        let empty = Document::new();
        let apw_e = area_per_ws(&empty);
        assert!(apw_e.is_finite() && apw_e == 0.0, "empty doc → 0 m²/ws, no NaN (got {apw_e})");

        // A single counted desk → apw = NIA / 1, finite and positive.
        let one = doc_next(&mut doc);
        doc.components.push(comp(one, "Desk", 3.0, 5.0, false, None));
        doc.reassign_components();
        assert_eq!(workstation_count(&doc), 1);
        assert!(area_per_ws(&doc) > 0.0 && area_per_ws(&doc).is_finite());
    }

    /// INV4: GEA (floor_area), NIA (Σ effective zone areas) and the usable
    /// area that drives efficiency are floor-plate/zone based and NEVER move when
    /// component `reference` flags flip — the counts change, the areas don't.
    #[test]
    fn inv4_areas_and_efficiency_are_invariant_to_reference() {
        let mut doc = plate_ws_meeting_gap();
        for i in 0..5 {
            let id = doc_next(&mut doc);
            doc.components.push(comp(id, "Desk", 2.0 + i as f64, 5.0, false, None));
        }
        doc.reassign_components();

        let gea0 = doc.floor_area();
        let (areas0, _) = raw_zone_areas_unscaled(&doc);
        let nia0: f64 = areas0.iter().sum();

        // Flip every component to reference.
        for c in doc.components.iter_mut() {
            c.reference = true;
        }
        let gea1 = doc.floor_area();
        let (areas1, _) = raw_zone_areas_unscaled(&doc);
        let nia1: f64 = areas1.iter().sum();

        assert_eq!(gea0, gea1, "GEA is wall-bbox based, unaffected by reference");
        assert_eq!(areas0, areas1, "per-zone effective areas unaffected by reference");
        assert!((nia0 - nia1).abs() < 1e-12, "NIA unaffected by reference");
        // …while the workstation count DID collapse (proving the flip took effect).
        assert_eq!(workstation_count(&doc), 0);
    }

    /// Space efficiency counts every OCCUPIABLE zone — workstations, private
    /// offices (ClosedOffice), meeting, collab AND amenity — and treats ONLY
    /// Circulation + Core/service as the "loss". This is the fix for the bug
    /// that excluded ClosedOffice + Amenity, understating efficiency ~25 pts.
    #[test]
    fn efficiency_usable_excludes_only_circulation_and_core() {
        // 70×10 plate = 700 m². Seven disjoint 10×10 (=100 m²) bands, one per
        // zone type, none equal to the wall bbox (no plate-spanning de-overlap)
        // and mutually non-overlapping (effective area == raw area).
        let mut doc = Document::new();
        for (a, b) in [
            ((0.0, 0.0), (70.0, 0.0)),
            ((70.0, 0.0), (70.0, 10.0)),
            ((70.0, 10.0), (0.0, 10.0)),
            ((0.0, 10.0), (0.0, 0.0)),
        ] {
            let id = doc.alloc_id();
            doc.walls.push(Wall {
                id,
                a: Point::new(a.0, a.1),
                b: Point::new(b.0, b.1),
                thickness: 0.1,
                generated: false,
                glazing: false,
                height_m: None,
            });
        }
        for (i, zt) in [
            ZoneType::Workspace,
            ZoneType::Meeting,
            ZoneType::Collaboration,
            ZoneType::ClosedOffice,
            ZoneType::Amenity,
            ZoneType::Circulation,
            ZoneType::Core,
        ]
        .into_iter()
        .enumerate()
        {
            add_rect_zone(&mut doc, zt, 5.0 + 10.0 * i as f64, 5.0, 10.0, 10.0);
        }

        let (areas, _) = raw_zone_areas_unscaled(&doc);
        let nia: f64 = areas.iter().sum::<f64>().min(doc.floor_area());
        let usable = usable_area(&doc, &areas);

        // Five occupiable bands (500 m²); Circulation + Core (200 m²) excluded.
        assert!((usable - 500.0).abs() < 1e-9, "usable = {usable}, want 500");
        assert!((nia - 700.0).abs() < 1e-9, "NIA = {nia}, want 700");
        let eff = usable / nia * 100.0;
        assert!((eff - 500.0 / 7.0).abs() < 1e-9, "efficiency = {eff}%, want ~71.4");
        // The old (buggy) formula summed only Workspace+Meeting+Collab = 300 m²
        // → 42.9%; the fix must NOT reproduce that.
        assert!(eff > 60.0, "ClosedOffice + Amenity must count as usable");
    }

    /// INV5: a clean full test-fit is byte-identical to the pre-fix semantics —
    /// with nothing marked reference, `workstations == every placed Desk` and the
    /// INV1 identity holds on real generated output. If a generated desk ever fell
    /// outside a Workspace zone this would fail (a real regression signal).
    #[test]
    fn inv5_clean_generate_counts_all_desks() {
        use crate::layout::{generate, Program};
        let program = Program::default();
        let mut doc = layout_test_room(30.0, 20.0);
        generate(&mut doc, &program, 3, false);

        let desks = doc.components.iter().filter(|c| c.category == "Desk").count();
        assert!(desks > 0, "a clean fit must seat desks");
        assert!(
            doc.components.iter().all(|c| !c.reference),
            "generated content is never reference"
        );
        assert_eq!(workstation_count(&doc), desks, "clean fit: workstations == every placed Desk");
        assert_eq!(
            workstation_count(&doc),
            workspace_seated_sum(&doc),
            "INV1 holds on real generated output"
        );
    }

    /// Only `Desk` ever counts as a workstation — Tables/Chairs/MeetingRooms in a
    /// Workspace zone never do, reference or not.
    #[test]
    fn only_desks_count_as_workstations() {
        let mut doc = plate_ws_meeting_gap();
        for (cat, x) in [("Chair", 2.0), ("Table", 3.0), ("MeetingRoom", 4.0)] {
            let id = doc_next(&mut doc);
            doc.components.push(comp(id, cat, x, 5.0, false, None));
        }
        let desk = doc_next(&mut doc);
        doc.components.push(comp(desk, "Desk", 6.0, 5.0, false, None));
        doc.reassign_components();
        assert_eq!(workstation_count(&doc), 1, "only the Desk counts");
    }

    /// Persistence / serde gap: an old `.dsource` Document blob written BEFORE the
    /// `reference` field deserializes with every component defaulting to `false`,
    /// so it counts exactly as it did pre-fix. Simulated by stripping the field
    /// from a serialized snapshot (the shape a pre-fix build emitted).
    #[test]
    fn old_document_blob_without_reference_deserializes_and_counts() {
        let mut doc = plate_ws_meeting_gap();
        let id = doc_next(&mut doc);
        doc.components.push(comp(id, "Desk", 2.0, 5.0, false, None));
        doc.reassign_components();
        let json = serde_json::to_string(&doc).unwrap();
        assert!(json.contains("\"reference\":false"), "new blobs carry the field");
        // Strip it → exactly what a pre-`reference` build serialized.
        let old_blob = json.replace(",\"reference\":false", "");
        assert!(!old_blob.contains("\"reference\""), "old blob has no reference field");
        let restored: Document = serde_json::from_str(&old_blob).expect("old blob must parse");
        assert!(restored.components.iter().all(|c| !c.reference), "missing field → false");
        assert_eq!(workstation_count(&restored), 1, "counts as before the facet existed");
    }

    /// Small id allocator so the tests don't juggle a closure borrowing `doc`.
    fn doc_next(doc: &mut Document) -> u32 {
        doc.alloc_id()
    }

    /// Rectangular `w`×`h` plate with SW corner at origin (mirrors layout's test
    /// helper; local so this module needn't reach into `layout::tests`).
    fn layout_test_room(w: f64, h: f64) -> Document {
        let mut doc = Document::new();
        for (a, b) in [
            ((0.0, 0.0), (w, 0.0)),
            ((w, 0.0), (w, h)),
            ((w, h), (0.0, h)),
            ((0.0, h), (0.0, 0.0)),
        ] {
            let id = doc.alloc_id();
            doc.walls.push(Wall {
                id,
                a: Point::new(a.0, a.1),
                b: Point::new(b.0, b.1),
                thickness: 0.1,
                generated: false,
                glazing: false,
                height_m: None,
            });
        }
        doc
    }

    /// **A source scan for `mod basis`, and an honest statement of what it does
    /// NOT close.**
    ///
    /// This file already carries the precedent twice —
    /// [`every_mutator_bumps_the_revision`] and
    /// [`every_f64_mutator_is_guarded_against_non_finite_input`] both scan our
    /// own source, because the failure they prevent is *a line somebody writes
    /// next year* and no behavioural test can enumerate code that does not exist
    /// yet. `mod basis` had no such guard. It has one now.
    ///
    /// # ROUTES CLOSED
    ///
    /// **Naming, in production code, anywhere in this crate.** A non-`#[cfg(test)]`
    /// site outside `mod basis` that calls `effective_zone_areas` or
    /// `raw_zone_areas_unscaled` fails here. `rustc` already refuses the first
    /// (`E0603`/`E0425`) — what it does NOT refuse is somebody *widening the
    /// exemption*: delete the `#[cfg(test)]` from `raw_zone_areas_unscaled` and
    /// the compiler goes quiet while a production reader of the raw vector
    /// appears. That is the route this scan owns, and it is the reason a
    /// compiler-enforced boundary still wants a scan.
    ///
    /// **New recompute sites.** A production `Zone::area_on` / `ZoneShape::area_on`
    /// call outside `mod basis` must be REGISTERED below with a reason. Adding
    /// one silently fails here.
    ///
    /// # ROUTES NOT CLOSED — stated, because a guard that claims more than it
    /// covers is worse than none
    ///
    /// 1. **A registered recompute site is registered, not fixed.** Registering
    ///    means "a NEW one fails"; it does not mean the registered one is gone.
    ///    `cost.rs`'s enclosed-room premium WAS such a site — a live second owner
    ///    feeding `indicative_cost`/`indicative_carbon`, 2.20% divergent from the
    ///    panel at F5 `Focus Room 1`. It was routed through `area_basis` in the
    ///    same round, its entry deleted, and the deletion was forced by this test
    ///    failing as a stale exemption rather than noticed by a reader. What
    ///    remains registered is `zone.rs` (the accessor's own definition) and
    ///    `score.rs` (a rank-only penalty, never billed).
    /// 2. **Recompute by any other arithmetic.** `w * h` on a `Rect` shape,
    ///    `polygon_area` on a zone's own polygon, a bbox difference — all
    ///    re-derive the same quantity without naming anything this scan looks
    ///    for. **A census of a symbol cannot see a census of a quantity**, which
    ///    is exactly how `cost.rs` stayed invisible to the R14 claim.
    /// 3. **Everything outside this crate.** This walks `crates/ds-core/src`.
    ///    The R14 entry was RETRACTED BY NAME for asserting a global negative
    ///    from a crate-local instrument: `rustc` cannot see `web/src/export/`,
    ///    and neither can this. **Scoped claim: no unregistered production site
    ///    IN THIS CRATE reads the raw per-zone areas.** Nothing more.
    ///
    ///    The four TS owners this route could not reach — `finishSchedule.ts`,
    ///    `sheetSet.ts`, `services.ts`, `editor/stats.ts` — were closed in the
    ///    same round from the other side: three published the raw shape area
    ///    (sheet A.09 billed 35.0 m² against the workbook's 8.0 on an UNEDITED
    ///    fixture) and the fourth wrote a field nothing read. Their guard is
    ///    `web/src/export/publishedArea.test.mjs`, which anchors the delivered
    ///    page ops against `Editor.quantities()`. Two instruments, one per
    ///    language, neither claiming the other's territory — the R14 retraction
    ///    was about a census asserting reach it did not have, and the fix is
    ///    coverage on both sides, not a wider claim from one.
    /// 4. **Strings.** Line comments are stripped (so the many prose references
    ///    to these names do not fire); a call spelled inside a string literal
    ///    would be missed, and is not a call.
    #[test]
    fn no_unregistered_production_site_reads_the_raw_per_zone_areas() {
        // (file suffix, the exact trimmed source line, why it is allowed)
        //
        // Keyed on the LINE, not on the file: a second `area_on` call in an
        // already-registered file still fails. An entry that no longer matches
        // anything also fails — a stale exemption is how a real gap hides behind
        // an old excuse.
        const REGISTERED: [(&str, &str, &str); 1] = [(
            "zone.rs",
            "self.shape.area_on(plate)",
            "the accessor's OWN definition: `Zone::area_on` delegating to \
             `ZoneShape::area_on`. This is the function `mod basis` calls, not a \
             second reader of it.",
        )];
        // TWO entries stood beside it and BOTH were deleted the same way — by the
        // site being routed through `area_basis`, so the exemption stopped matching
        // and this test failed as a stale one. `cost.rs` (the enclosed-room premium)
        // went at integration. `score.rs` — `.map(|z| z.area_on(plate_poly.as_deref()))`,
        // the `unassigned_penalty` numerator — goes here.
        //
        // Its stated ground was: "Not a published area and never billed: a relative
        // penalty compared only against itself." **A scoped truth presented without
        // its scope.** True of the AREA; false of the NUMBER derived from it —
        // `unassigned_penalty` is a serialized `LayoutScore` field, and `total` is an
        // absolute 0..100 rendered in the candidate gallery, printed as "best N/100",
        // and pasted into the Claude evaluator's prompt. Nothing about that is
        // compared only against itself.
        //
        // Its second clause — "sharing the cap-scaled basis would make a candidate's
        // score depend on whether its zones happened to overlap" — was measured and
        // is backwards. NOT sharing made it depend on overlap: the un-de-overlapped
        // sum billed the same floor twice and put the debit at 15.2783 points on a
        // term specified at ~1.8. Sharing makes it depend on overlap not at all for
        // every generated candidate (zones tile, `k == 1`, byte-identical) and bounds
        // it at 10 for a hand-edited one.
        //
        // Sized from the table rather than hard-coded: `[false; 3]` against a
        // 2-entry table was left here by the `cost.rs` deletion, and a fourth entry
        // would have panicked with an index-out-of-bounds — red by crash, naming no
        // cause.
        let mut used = [false; REGISTERED.len()];

        let root = concat!(env!("CARGO_MANIFEST_DIR"), "/src");
        let mut files: Vec<std::path::PathBuf> = Vec::new();
        collect_rs(std::path::Path::new(root), &mut files);
        files.sort();
        assert!(
            files.len() >= 20,
            "the crate walk found {} .rs files — the instrument is the finding",
            files.len()
        );

        // Test-only FILES, derived from the `#[cfg(test)] mod <name>;`
        // declarations rather than hard-coded, so a new one is picked up.
        let mut test_only: Vec<String> = Vec::new();
        for f in &files {
            let src = std::fs::read_to_string(f).expect("readable");
            for (i, _) in src.match_indices("#[cfg(test)]") {
                let rest = src[i..].trim_start_matches("#[cfg(test)]").trim_start();
                if let Some(name) = rest.strip_prefix("mod ") {
                    if let Some(semi) = name.find(';') {
                        if !name[..semi].contains('{') {
                            test_only.push(format!("{}.rs", name[..semi].trim()));
                        }
                    }
                }
            }
        }
        assert!(
            test_only.iter().any(|m| m == "metrics_tests.rs"),
            "the test-only module derivation found {test_only:?} — it must at least \
             find `metrics_tests`, or it is stripping nothing"
        );

        let mut offences: Vec<String> = Vec::new();
        let mut production_lines = 0usize;
        for f in &files {
            let name = f.file_name().unwrap().to_string_lossy().to_string();
            if test_only.contains(&name) {
                continue;
            }
            let src = std::fs::read_to_string(f).expect("readable");
            let prod = strip_test_items(&strip_line_comments(&src));
            // `mod basis` is the sanctioned owner: its whole body is exempt.
            let prod = strip_named_mod(&prod, "mod basis {");
            for (lineno, raw) in prod.lines().enumerate() {
                let line = raw.trim();
                if line.is_empty() {
                    continue;
                }
                production_lines += 1;
                // The BARE name, not `name(`. Matching the call paren left
                // `strip_line_comments` inert (sabotage S3d stayed green): no
                // production comment spells these with a paren, so the transform
                // guarded nothing. Matching the bare name closes a real route —
                // a `use`, a re-export, a function pointer — and makes the
                // comment stripper load-bearing, which S3d now proves.
                let names = line.contains("effective_zone_areas")
                    || line.contains("raw_zone_areas_unscaled");
                let recompute = line.contains(".area_on(");
                if !names && !recompute {
                    continue;
                }
                if names {
                    offences.push(format!(
                        "{name}: a production site NAMES the raw per-zone areas — \
                         `{line}`. `mod basis` is the only owner; if the \
                         `#[cfg(test)]` on `raw_zone_areas_unscaled` was removed, \
                         put it back"
                    ));
                    continue;
                }
                match REGISTERED.iter().position(|(fs, l, _)| name.ends_with(fs) && line == *l) {
                    Some(i) => used[i] = true,
                    None => offences.push(format!(
                        "{name} (line ~{}): a production site RECOMPUTES a zone's area \
                         — `{line}`. Read it from `crate::area_basis` instead, or \
                         register it in this test with the reason it must not",
                        lineno + 1
                    )),
                }
            }
        }
        assert!(
            production_lines > 5000,
            "only {production_lines} production lines survived stripping — the \
             stripper has eaten the crate and the scan is vacuous"
        );
        assert!(offences.is_empty(), "{}", offences.join("\n"));
        for (i, (f, l, _)) in REGISTERED.iter().enumerate() {
            assert!(
                used[i],
                "the registered exemption {f}: `{l}` no longer matches any production \
                 line. If the site was routed through `area_basis`, DELETE the entry \
                 — a stale exemption covers nothing and hides the next one"
            );
        }
    }

    fn collect_rs(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
        for e in std::fs::read_dir(dir).expect("src/ is readable") {
            let p = e.expect("dir entry").path();
            if p.is_dir() {
                collect_rs(&p, out);
            } else if p.extension().is_some_and(|x| x == "rs") {
                out.push(p);
            }
        }
    }

    /// `//`-to-end-of-line, blanked rather than deleted so line numbers survive.
    /// Doc comments in this crate quote these names constantly; a scan that read
    /// them would report the prose instead of the code.
    fn strip_line_comments(src: &str) -> String {
        src.lines()
            .map(|l| match l.find("//") {
                Some(i) => l[..i].to_string(),
                None => l.to_string(),
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// Blank out every `#[cfg(test)]` / `#[test]` item by brace balance (or to
    /// the `;` for a bare `mod x;`), preserving line count.
    fn strip_test_items(src: &str) -> String {
        let mut keep: Vec<bool> = vec![true; src.len()];
        for attr in ["#[cfg(test)]", "#[test]"] {
            for (i, _) in src.match_indices(attr) {
                let tail = &src[i..];
                let brace = tail.find('{');
                let semi = tail.find(';');
                let end = match (brace, semi) {
                    (Some(b), Some(s)) if s < b => i + s + 1,
                    (Some(b), _) => {
                        let mut depth = 0i32;
                        let mut e = src.len();
                        for (o, ch) in tail[b..].char_indices() {
                            match ch {
                                '{' => depth += 1,
                                '}' => {
                                    depth -= 1;
                                    if depth == 0 {
                                        e = i + b + o + 1;
                                        break;
                                    }
                                }
                                _ => {}
                            }
                        }
                        e
                    }
                    (None, Some(s)) => i + s + 1,
                    (None, None) => src.len(),
                };
                for k in keep.iter_mut().take(end).skip(i) {
                    *k = false;
                }
            }
        }
        src.char_indices()
            .map(|(i, c)| if keep[i] || c == '\n' { c } else { ' ' })
            .collect()
    }

    /// Blank out one named module's body by brace balance.
    fn strip_named_mod(src: &str, head: &str) -> String {
        let Some(i) = src.find(head) else { return src.to_string() };
        let from = i + head.len() - 1;
        let mut depth = 0i32;
        let mut end = src.len();
        for (o, ch) in src[from..].char_indices() {
            match ch {
                '{' => depth += 1,
                '}' => {
                    depth -= 1;
                    if depth == 0 {
                        end = from + o + 1;
                        break;
                    }
                }
                _ => {}
            }
        }
        src.char_indices()
            .map(|(k, c)| if k < i || k >= end || c == '\n' { c } else { ' ' })
            .collect()
    }
}
