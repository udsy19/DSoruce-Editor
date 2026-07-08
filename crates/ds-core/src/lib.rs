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

use document::Document;
use geometry::Point;
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
    /// Count of `Desk` components.
    workstations: usize,
    /// NIA / workstations (m²); 0 when there are no workstations.
    area_per_workstation: f64,
    /// (Workspace + Meeting + Collaboration area) / NIA × 100; 0 when NIA is 0.
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
    /// Count of this zone's components whose category is "Desk".
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
        });
        id
    }

    /// Place a component (footprint centered at x,y). Returns the new component id
    /// and makes it the current selection.
    pub fn add_component(&mut self, category: String, x: f64, y: f64, w: f64, h: f64) -> u32 {
        let id = self.doc.alloc_id();
        let label = format!("{} {}", category, id);
        self.doc.components.push(Component {
            id,
            category,
            x,
            y,
            w,
            h,
            rotation: 0.0,
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
        let plate = self.doc.plate_polygon();
        let plate_ref = plate.as_deref();
        let floor_area = self.doc.floor_area();
        let nia: f64 = self.doc.zones.iter().map(|z| z.area_on(plate_ref)).sum();
        let workstations = self
            .doc
            .components
            .iter()
            .filter(|c| c.category == "Desk")
            .count();
        let programmed: f64 = self
            .doc
            .zones
            .iter()
            .filter(|z| {
                matches!(
                    z.zone_type,
                    ZoneType::Workspace | ZoneType::Meeting | ZoneType::Collaboration
                )
            })
            .map(|z| z.area_on(plate_ref))
            .sum();
        let area_per_workstation = if workstations > 0 {
            nia / workstations as f64
        } else {
            0.0
        };
        let efficiency_pct = if nia > 0.0 {
            programmed / nia * 100.0
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
        let plate = self.doc.plate_polygon();
        let plate_ref = plate.as_deref();
        let nia: f64 = self.doc.zones.iter().map(|z| z.area_on(plate_ref)).sum();
        let stats: Vec<ZoneStat> = self
            .doc
            .zones
            .iter()
            .map(|z| {
                let seated = z
                    .component_ids
                    .iter()
                    .filter(|&&cid| {
                        self.doc
                            .components
                            .iter()
                            .any(|c| c.id == cid && c.category == "Desk")
                    })
                    .count();
                let area = z.area_on(plate_ref);
                ZoneStat {
                    id: z.id,
                    zone_type: z.zone_type,
                    label: z.label.clone(),
                    area,
                    capacity: z.capacity(),
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
        Ok(())
    }

    /// Construct a fresh `Editor` from a `snapshot` (scratch-clone for previews).
    pub fn from_snapshot(snap: JsValue) -> Result<Editor, JsValue> {
        let s = snap
            .as_string()
            .ok_or_else(|| JsValue::from_str("snapshot must be a string"))?;
        let doc: Document =
            serde_json::from_str(&s).map_err(|e| JsValue::from_str(&e.to_string()))?;
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
}

impl Default for Editor {
    fn default() -> Self {
        Editor::new()
    }
}
