//! The editable document: walls + placed components + current selection.
//! Pure Rust, serializable, UI-agnostic (the frontend reads it to render).

use crate::model::{Component, Wall};
use serde::Serialize;

#[derive(Clone, Debug, Serialize, Default)]
pub struct Document {
    pub walls: Vec<Wall>,
    pub components: Vec<Component>,
    pub selection: Option<u32>,
    #[serde(skip)]
    next_id: u32,
}

impl Document {
    pub fn new() -> Self {
        Document::default()
    }

    /// Monotonic id allocator. Ids start at 1 so 0 can never collide with a real entity.
    pub fn alloc_id(&mut self) -> u32 {
        self.next_id += 1;
        self.next_id
    }

    pub fn component_mut(&mut self, id: u32) -> Option<&mut Component> {
        self.components.iter_mut().find(|c| c.id == id)
    }

    /// Axis-aligned floor area from the wall bounding box (meters²).
    /// A rough v1 metric; replaced by true room polygons later.
    pub fn floor_area(&self) -> f64 {
        if self.walls.is_empty() {
            return 0.0;
        }
        let mut min_x = f64::INFINITY;
        let mut min_y = f64::INFINITY;
        let mut max_x = f64::NEG_INFINITY;
        let mut max_y = f64::NEG_INFINITY;
        for w in &self.walls {
            for p in [w.a, w.b] {
                min_x = min_x.min(p.x);
                min_y = min_y.min(p.y);
                max_x = max_x.max(p.x);
                max_y = max_y.max(p.y);
            }
        }
        (max_x - min_x).max(0.0) * (max_y - min_y).max(0.0)
    }
}
