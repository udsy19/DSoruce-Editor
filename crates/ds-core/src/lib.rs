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
mod geometry;
mod layout;
mod model;
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
    efficiency_pct: f64,
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
        let ZoneShape::Rect { x, y, w, h } = doc.zones[i].shape else { continue };
        let (rx0, ry0, rx1, ry1) = (x - w / 2.0, y - h / 2.0, x + w / 2.0, y + h / 2.0);
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

/// Usable (occupiable) area — the numerator of the workplace space-efficiency
/// ratio (usable / NIA; see `Metrics::efficiency_pct`). "Usable" is every zone
/// EXCEPT `Circulation` (corridors/aisles) and `Core` (WC, stairs, lifts, MEP,
/// service): all workstations, private offices, meeting, collab AND amenity are
/// occupiable space, not overhead. `areas` are the de-overlapped effective zone
/// areas from `effective_zone_areas`, in zone order. Standard definition per
/// BCO 2023 / RICS IPMS / JLL; a good fit-out lands ~70–85%.
fn usable_area(doc: &Document, areas: &[f64]) -> f64 {
    doc.zones
        .iter()
        .zip(areas)
        .filter(|(z, _)| !matches!(z.zone_type, ZoneType::Circulation | ZoneType::Core))
        .map(|(_, a)| *a)
        .sum()
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

#[wasm_bindgen]
impl Editor {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Editor {
        console_error_panic_hook::set_once();
        Editor {
            doc: Document::new(),
        }
    }

    /// Add a wall segment a→b. Returns the new wall id.
    pub fn add_wall(&mut self, ax: f64, ay: f64, bx: f64, by: f64, thickness: f64) -> u32 {
        let id = self.doc.alloc_id();
        self.doc.walls.push(Wall {
            id,
            a: Point::new(ax, ay),
            b: Point::new(bx, by),
            thickness,
            generated: false,
            glazing: false,
        });
        id
    }

    /// Place a component (footprint centered at x,y). Returns the new component id
    /// and makes it the current selection.
    pub fn add_component(&mut self, category: String, x: f64, y: f64, w: f64, h: f64) -> u32 {
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
        id
    }

    /// Add a permanent interior keep-out (building core: stairs/lifts/shafts/
    /// WCs) as a center-based rect. Keep-outs are hard obstacles `generate()`
    /// always avoids regardless of freeze state, and render as `Core` zones.
    /// Returns the new keep-out id. Serializes with the doc via `state()`.
    pub fn add_keepout(&mut self, x: f64, y: f64, w: f64, h: f64, label: String) -> u32 {
        let id = self.doc.alloc_id();
        self.doc.keepouts.push(KeepOut { id, x, y, w, h, label });
        id
    }

    /// Remove all keep-outs.
    pub fn clear_keepouts(&mut self) {
        self.doc.keepouts.clear();
    }

    /// Add a building entry point (world meters). The test-fit generator anchors
    /// its primary circulation spine to the first entry (spec §3). Serializes
    /// with the doc via `state()`/`snapshot()`.
    pub fn add_entry(&mut self, x: f64, y: f64) {
        self.doc.entries.push(Point::new(x, y));
    }

    /// Remove all entry points.
    pub fn clear_entries(&mut self) {
        self.doc.entries.clear();
    }

    /// Pin a room of `kind` onto `(x, y)` (world meters) — qbiq's "Place on Plan"
    /// (workflow.md §3.5). `generate()` places anchored rooms FIRST at (near)
    /// their point and bumps that kind's count. `kind` is a `SpaceKind` name
    /// ("Reception"/"Cabin"/"Meeting"/…); an unknown kind is ignored. Serializes
    /// with the doc via `state()`/`snapshot()`, mirroring `add_entry`.
    pub fn add_anchor(&mut self, kind: String, x: f64, y: f64) {
        if let Some(kind) = SpaceKind::from_wire(&kind) {
            self.doc.anchors.push(Anchor { kind, x, y });
        }
    }

    /// Remove all anchor pins (mirrors `clear_entries`).
    pub fn clear_anchors(&mut self) {
        self.doc.anchors.clear();
    }

    /// Hit-test components at (x,y) in world coords, topmost first. Sets and
    /// returns the selection (undefined in JS if nothing was hit).
    pub fn select_at(&mut self, x: f64, y: f64) -> Option<u32> {
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
        hit
    }

    pub fn clear_selection(&mut self) {
        self.doc.selection = None;
    }

    /// Translate the current selection by (dx,dy) meters.
    pub fn move_selected(&mut self, dx: f64, dy: f64) {
        if let Some(id) = self.doc.selection {
            if let Some(c) = self.doc.component_mut(id) {
                c.x += dx;
                c.y += dy;
            }
        }
    }

    pub fn delete_selected(&mut self) {
        if let Some(id) = self.doc.selection.take() {
            self.doc.components.retain(|c| c.id != id);
        }
    }

    /// Move a component **by id** to absolute center `(x, y)` meters. The by-id
    /// primitive the AI uses; complements the selection-based `move_selected`.
    pub fn move_component(&mut self, id: u32, x: f64, y: f64) {
        if let Some(c) = self.doc.component_mut(id) {
            c.x = x;
            c.y = y;
        }
    }

    /// Set a component's rotation (radians, clockwise in the Y-down plan).
    /// Doors/windows placed along angled walls need this; renderers already
    /// honor `Component::rotation`.
    pub fn set_component_rotation(&mut self, id: u32, radians: f64) {
        if let Some(c) = self.doc.component_mut(id) {
            c.rotation = radians;
        }
    }

    /// Set a component's hinge handedness (mirror across its long axis). Doors
    /// imported from CAD recover a left- vs right-hand swing this way; renderers
    /// reflect the leaf+arc when set. Additive: complements `set_component_rotation`
    /// and leaves `add_component` (default `mirror: false`) untouched.
    pub fn set_component_mirror(&mut self, id: u32, mirror: bool) {
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
        if let Some(c) = self.doc.component_mut(id) {
            c.reference = reference;
        }
    }

    /// Set a component's footprint (meters). Used by the object inspector's
    /// editable W/H fields; clamped to a small positive minimum so a degenerate
    /// zero-size box can't be created.
    pub fn set_component_size(&mut self, id: u32, w: f64, h: f64) {
        if let Some(c) = self.doc.component_mut(id) {
            c.w = w.max(0.05);
            c.h = h.max(0.05);
            // Seats follow the footprint: grow a table and it seats more people.
            // Re-resolved here so the stored count can never go stale — the whole
            // contract is that the renderer reads `seats` and never recomputes it.
            c.seats = crate::model::seats_for(&c.category, c.w, c.h);
        }
    }

    /// Change a component's category (which slice of the material bank + which
    /// top-view symbol it uses). The object inspector's category picker.
    pub fn set_component_category(&mut self, id: u32, category: String) {
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
        self.doc.components.retain(|c| c.id != id);
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
    ) {
        if let Some(c) = self.doc.component_mut(id) {
            c.product_id = Some(product_id);
            c.label = product_name;
            c.price_inr = price_inr;
        }
    }

    /// Advance a component's decision lifecycle. `state` is one of
    /// "Open" | "InReview" | "Confirmed".
    pub fn set_decision(&mut self, id: u32, state: &str) {
        if let Some(c) = self.doc.component_mut(id) {
            c.decision = DecisionState::from_str(state);
        }
    }

    /// Whole document, for rendering. Returned as a plain JS object.
    pub fn state(&self) -> Result<JsValue, JsValue> {
        serde_wasm_bindgen::to_value(&self.doc).map_err(|e| JsValue::from_str(&e.to_string()))
    }

    /// Live metrics panel data. Areas are clipped to the traced floor-plate
    /// polygon so non-rectangular plates report true numbers (see
    /// `Document::plate_polygon`); rectangular rooms are unchanged.
    pub fn metrics(&self) -> Result<JsValue, JsValue> {
        let floor_area = self.doc.floor_area();
        let (areas, _) = effective_zone_areas(&self.doc);
        // Zones tile the plate; the oriented desk field's plate-spanning
        // Workspace is de-overlapped in `effective_zone_areas`, so the sum can no
        // longer exceed the gross floor. `.min` stays a cheap invariant guard.
        let nia: f64 = areas.iter().sum::<f64>().min(floor_area);
        // THE ONE workstation definition (== Pax everywhere: chip, row, Zones tab,
        // CSV) — see `workstation_count`. `stats.ts` `zonePax` sums the same per-zone
        // `seated`, so the panel's Pax is identical to this number.
        let workstations = workstation_count(&self.doc);
        // Space efficiency (BCO 2023 / RICS IPMS / JLL): usable / NIA, where
        // usable = every occupiable zone and the "loss" is Circulation +
        // Core/service (WC, stairs, lifts, MEP). Private offices (ClosedOffice)
        // and amenity (reception/pantry/café) ARE usable space, not overhead —
        // excluding them (the old bug) understated efficiency by ~25 pts.
        let usable = usable_area(&self.doc, &areas);
        let area_per_workstation = if workstations > 0 {
            nia / workstations as f64
        } else {
            0.0
        };
        let efficiency_pct = if nia > 0.0 {
            usable / nia * 100.0
        } else {
            0.0
        };
        let m = Metrics {
            floor_area,
            wall_count: self.doc.walls.len(),
            component_count: self.doc.components.len(),
            confirmed: self
                .doc
                .components
                .iter()
                .filter(|c| c.decision == DecisionState::Confirmed)
                .count(),
            gross_external_area: floor_area,
            net_internal_area: nia,
            workstations,
            area_per_workstation,
            efficiency_pct,
            indicative_cost: cost::indicative_cost(&self.doc),
            indicative_carbon: cost::indicative_carbon(&self.doc),
            specified_cost: cost::specified_cost(&self.doc),
        };
        serde_wasm_bindgen::to_value(&m).map_err(|e| JsValue::from_str(&e.to_string()))
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
        // De-overlapped areas so the Zones tab / Areas donut sum to GEA (never
        // above it) on tilted/irregular plates — same source of truth as metrics.
        let (areas, spanning) = effective_zone_areas(&self.doc);
        let nia: f64 = areas.iter().sum();
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
                    z.capacity()
                };
                ZoneStat {
                    id: z.id,
                    zone_type: z.zone_type,
                    label: z.label.clone(),
                    area,
                    capacity,
                    seated,
                    pct_of_nia: if nia > 0.0 { area / nia * 100.0 } else { 0.0 },
                }
            })
            .collect();
        serde_wasm_bindgen::to_value(&stats).map_err(|e| JsValue::from_str(&e.to_string()))
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
        let program: layout::Program =
            serde_wasm_bindgen::from_value(program).map_err(|e| JsValue::from_str(&e.to_string()))?;
        layout::generate(&mut self.doc, &program, seed, keep_confirmed);
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
        let s = snap
            .as_string()
            .ok_or_else(|| JsValue::from_str("snapshot must be a string"))?;
        self.doc = serde_json::from_str(&s).map_err(|e| JsValue::from_str(&e.to_string()))?;
        // Plans saved before the `seats` facet load with 0; resolve them so an
        // old plan and a new one report the same pax for the same building.
        self.doc.backfill_seats();
        Ok(())
    }

    /// Construct a fresh `Editor` from a `snapshot` (scratch-clone for previews).
    pub fn from_snapshot(snap: JsValue) -> Result<Editor, JsValue> {
        let s = snap
            .as_string()
            .ok_or_else(|| JsValue::from_str("snapshot must be a string"))?;
        let mut doc: Document =
            serde_json::from_str(&s).map_err(|e| JsValue::from_str(&e.to_string()))?;
        doc.backfill_seats();
        Ok(Editor { doc })
    }

    // ----- Zone ops — thin wrappers over `Document` methods. Each returns the
    // new id(s) or throws the `ZoneError` reason as a string JsValue. -----

    /// Merge zones `a` and `b`; returns the resulting zone id (a clean rect union
    /// reuses `a`'s id) or the shared group id (logical L-room) as a number.
    pub fn merge_zones(&mut self, a: u32, b: u32) -> Result<JsValue, JsValue> {
        let id = self
            .doc
            .merge_zones(a, b)
            .map_err(|e| JsValue::from_str(&e.to_string()))?;
        Ok(JsValue::from_f64(id as f64))
    }

    /// Split zone `id` along `axis` ("Vertical" | "Horizontal") at world coord
    /// `at`; returns `[id1, id2]`.
    pub fn split_zone(&mut self, id: u32, axis: &str, at: f64) -> Result<JsValue, JsValue> {
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
        let t: ZoneType = serde_json::from_str(&format!("\"{}\"", zone_type))
            .map_err(|_| JsValue::from_str("unknown zone type"))?;
        self.doc
            .set_zone_type(id, t)
            .map_err(|e| JsValue::from_str(&e.to_string()))
    }

    /// Resize/move zone `id` to a `Rect` (center `x,y`, size `w,h`). Rejected if
    /// the new bbox exceeds the wall bbox.
    pub fn resize_zone(&mut self, id: u32, x: f64, y: f64, w: f64, h: f64) -> Result<(), JsValue> {
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
        let t: ZoneType = serde_json::from_str(&format!("\"{}\"", zone_type))
            .map_err(|_| JsValue::from_str("unknown zone type"))?;
        let id = self.doc.add_zone(t, ZoneShape::Rect { x, y, w, h }, label);
        Ok(JsValue::from_f64(id as f64))
    }

    /// Delete a room by zone id: removes the zone and the furniture it contains.
    pub fn delete_zone(&mut self, id: u32) -> Result<(), JsValue> {
        self.doc
            .delete_zone(id)
            .map_err(|e| JsValue::from_str(&e.to_string()))
    }

    /// Rename a zone's label (e.g. to match a reclassified type).
    pub fn rename_zone(&mut self, id: u32, label: String) -> Result<(), JsValue> {
        self.doc
            .rename_zone(id, label)
            .map_err(|e| JsValue::from_str(&e.to_string()))
    }

    /// Move an existing wall's endpoints (by id) to `a=(ax,ay)`, `b=(bx,by)`.
    /// No-op if the id is unknown. Lets an interior partition wall travel with a
    /// room during drag/resize (generated plans have none; hand-drawn walls do).
    pub fn set_wall(&mut self, id: u32, ax: f64, ay: f64, bx: f64, by: f64) {
        if let Some(w) = self.doc.walls.iter_mut().find(|w| w.id == id) {
            w.a = Point::new(ax, ay);
            w.b = Point::new(bx, by);
        }
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
        let (areas, _) = effective_zone_areas(&doc);
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
        let (areas, _) = effective_zone_areas(doc);
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
        let (areas0, _) = effective_zone_areas(&doc);
        let nia0: f64 = areas0.iter().sum();

        // Flip every component to reference.
        for c in doc.components.iter_mut() {
            c.reference = true;
        }
        let gea1 = doc.floor_area();
        let (areas1, _) = effective_zone_areas(&doc);
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

        let (areas, _) = effective_zone_areas(&doc);
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
            });
        }
        doc
    }
}
