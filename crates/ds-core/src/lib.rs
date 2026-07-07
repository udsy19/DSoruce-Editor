//! DSource Editor core — compiled to WebAssembly and driven from the browser.
//!
//! Architecture (Rayon-style): this crate owns the document model, geometry,
//! hit-testing and (later) the layout engine as **pure Rust**. The only browser
//! contact is the wasm-bindgen boundary below. Rendering currently lives in the
//! TS frontend; it migrates into a Rust/WebGL renderer later (see
//! `docs/adr/0001-rendering-staging.md`).

mod circulation;
mod document;
mod geometry;
mod layout;
mod model;

use document::Document;
use geometry::Point;
use model::{Component, DecisionState, Wall};
use serde::Serialize;
use wasm_bindgen::prelude::*;

#[derive(Serialize)]
struct Metrics {
    floor_area: f64,
    wall_count: usize,
    component_count: usize,
    confirmed: usize,
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
            decision: DecisionState::Open,
        });
        self.doc.selection = Some(id);
        id
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

    /// Bind a material-bank product to a component (the "re-imagine" action).
    pub fn assign_product(&mut self, id: u32, product_id: String, product_name: String) {
        if let Some(c) = self.doc.component_mut(id) {
            c.product_id = Some(product_id);
            c.label = product_name;
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

    /// Live metrics panel data.
    pub fn metrics(&self) -> Result<JsValue, JsValue> {
        let m = Metrics {
            floor_area: self.doc.floor_area(),
            wall_count: self.doc.walls.len(),
            component_count: self.doc.components.len(),
            confirmed: self
                .doc
                .components
                .iter()
                .filter(|c| c.decision == DecisionState::Confirmed)
                .count(),
        };
        serde_wasm_bindgen::to_value(&m).map_err(|e| JsValue::from_str(&e.to_string()))
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

    /// Circulation / "walking place" evaluation of the current document.
    pub fn circulation(&self) -> Result<JsValue, JsValue> {
        let score = circulation::evaluate(&self.doc, &circulation::CirculationConfig::new());
        serde_wasm_bindgen::to_value(&score).map_err(|e| JsValue::from_str(&e.to_string()))
    }
}

impl Default for Editor {
    fn default() -> Self {
        Editor::new()
    }
}
