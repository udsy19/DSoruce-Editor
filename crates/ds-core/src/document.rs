//! The editable document: walls + placed components + current selection.
//! Pure Rust, serializable, UI-agnostic (the frontend reads it to render).

use crate::layout::SpaceKind;
use crate::model::{Component, KeepOut, Wall};
use crate::zone::{Axis, Zone, ZoneError, ZoneShape, ZoneType};
use serde::{Deserialize, Serialize};

/// A position-pinned room request (workflow.md §3.5 — qbiq's "Place on Plan").
/// The user picks a room `kind` and clicks a spot; `generate()` places that room
/// FIRST at (near) `(x, y)` and bumps the kind's count. A doc-level placement
/// hint that mirrors `entries`/`keepouts`: it rides `state()`/`snapshot()` and is
/// never cleared by a regenerate (only re-uploading the plate clears it, TS-side).
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq)]
pub struct Anchor {
    pub kind: SpaceKind,
    /// pinned center, world meters
    pub x: f64,
    pub y: f64,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
pub struct Document {
    pub walls: Vec<Wall>,
    pub components: Vec<Component>,
    /// Tiled floor regions (rooms / corridors). Share the `alloc_id` space with
    /// walls + components, so any entity is addressable by one integer.
    pub zones: Vec<Zone>,
    /// Permanent interior keep-outs (building core: stairs/lifts/shafts/WCs).
    /// `default` keeps old snapshots (without the field) deserializable, and an
    /// empty vec round-trips both ways — same pattern as `cad_json`.
    #[serde(default)]
    pub keepouts: Vec<KeepOut>,
    /// Building entry points (world meters). The test-fit generator anchors its
    /// primary circulation spine to the first entry (spec §3: enter → reception
    /// → spine → neighborhoods). `default` keeps old snapshots deserializable;
    /// an empty vec means "no entry" and the generator falls back to geometry.
    #[serde(default)]
    pub entries: Vec<crate::geometry::Point>,
    /// Position-pinned room requests (workflow.md §3.5). `generate()` places each
    /// anchor's room FIRST at (near) its point and bumps that kind's count.
    /// `default` keeps old snapshots deserializable; empty = no pins (unchanged
    /// generation). Same additive-hint pattern as `entries`/`keepouts`.
    #[serde(default)]
    pub anchors: Vec<Anchor>,
    pub selection: Option<u32>,
    /// Monotonic id counter. **Serialized** (no `skip`) so a snapshot round-trip
    /// is lossless — otherwise restored ids would collide (Conflict §5). `default`
    /// keeps older/partial JSON deserializable.
    #[serde(default)]
    pub(crate) next_id: u32,
    /// Opaque TS-side CAD drafting layer (lines, dimensions, text…), serialized
    /// by the frontend. Carried in the document so snapshot/undo/save round-trip
    /// it; the core never interprets it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) cad_json: Option<String>,
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

    /// Index of the most-specific zone whose filled region contains world point
    /// `(x, y)`: a containing non-`Circulation` zone (e.g. the Workspace/Meeting
    /// rect) wins over the perimeter `Circulation` ring; the last such zone in
    /// iteration order wins ties. Returns `None` if no zone contains the point.
    /// Shared by `reassign_components` (per-component) and `zone_at` (hit-test).
    fn zone_index_at(&self, x: f64, y: f64) -> Option<usize> {
        let mut chosen: Option<usize> = None;
        let mut found_non_circ = false;
        for (i, z) in self.zones.iter().enumerate() {
            if !z.shape.contains(x, y) {
                continue;
            }
            if z.zone_type == ZoneType::Circulation {
                // Only fall back to circulation if no specific zone found yet.
                if !found_non_circ {
                    chosen = Some(i);
                }
            } else {
                // Non-circulation is preferred; last one wins.
                chosen = Some(i);
                found_non_circ = true;
            }
        }
        chosen
    }

    /// Rebucket every component into the zone that contains its center. Clears
    /// each zone's `component_ids`, then assigns each component to the most
    /// specific containing zone (see `zone_index_at`). Call after `generate()`
    /// and after any zone geometry change.
    pub fn reassign_components(&mut self) {
        for z in &mut self.zones {
            z.component_ids.clear();
        }
        // Collect first to avoid borrowing `self` mutably and immutably at once.
        let assignments: Vec<(usize, u32)> = self
            .components
            .iter()
            .filter_map(|c| self.zone_index_at(c.x, c.y).map(|i| (i, c.id)))
            .collect();
        for (i, cid) in assignments {
            self.zones[i].component_ids.push(cid);
        }
    }

    /// The most-specific zone id containing world point `(x, y)`, or `None`.
    /// Mirrors `reassign_components`' preference (non-`Circulation` rect over the
    /// `Circulation` ring). Powers click-to-select a room on the canvas.
    pub fn zone_at(&self, x: f64, y: f64) -> Option<u32> {
        self.zone_index_at(x, y).map(|i| self.zones[i].id)
    }

    /// Axis-aligned bounding box of all **architectural** (non-generated) wall
    /// endpoints, `(min_x, min_y, max_x, max_y)`. Generator-emitted partitions
    /// are excluded — they are output, not the building envelope (they always
    /// lie inside it anyway; the filter guards degenerate docs). `None` when
    /// there are no such walls.
    pub(crate) fn wall_bbox(&self) -> Option<(f64, f64, f64, f64)> {
        let mut min_x = f64::INFINITY;
        let mut min_y = f64::INFINITY;
        let mut max_x = f64::NEG_INFINITY;
        let mut max_y = f64::NEG_INFINITY;
        for w in self.walls.iter().filter(|w| !w.generated) {
            for p in [w.a, w.b] {
                min_x = min_x.min(p.x);
                min_y = min_y.min(p.y);
                max_x = max_x.max(p.x);
                max_y = max_y.max(p.y);
            }
        }
        if !min_x.is_finite() {
            return None;
        }
        Some((min_x, min_y, max_x, max_y))
    }

    /// The floor-plate polygon traced from the walls (largest closed loop), or
    /// `None` when the walls don't close. Metrics clip zone areas against this
    /// so a non-rectangular plate reports true areas, not its bounding box.
    /// Generated partitions are excluded from the trace: the plate is the
    /// building envelope, and re-tracing our own room shells would corrupt
    /// regeneration (see docs/design/testfit-pro-quality.md §2).
    pub(crate) fn plate_polygon(&self) -> Option<Vec<crate::geometry::Point>> {
        let segs: Vec<_> = self
            .walls
            .iter()
            .filter(|w| !w.generated)
            .map(|w| (w.a, w.b))
            .collect();
        crate::geometry::trace_floor_polygon(&segs, crate::geometry::LOOP_SNAP_TOL)
    }

    /// `plate_polygon` mapped to plain `[x, y]` pairs — the wire shape the
    /// frontend consumes (`Editor::plate`). Pure, so it is natively testable;
    /// the wasm method only serializes this.
    pub(crate) fn plate_points(&self) -> Option<Vec<[f64; 2]>> {
        self.plate_polygon()
            .map(|poly| poly.into_iter().map(|p| [p.x, p.y]).collect())
    }

    /// True floor area (meters²): the traced plate-polygon area when the walls
    /// close (exact for any shape, identical to the bbox for rectangles);
    /// bbox fallback for open walls.
    pub fn floor_area(&self) -> f64 {
        if let Some(poly) = self.plate_polygon() {
            return crate::geometry::polygon_area(&poly).abs();
        }
        match self.wall_bbox() {
            Some((min_x, min_y, max_x, max_y)) => {
                (max_x - min_x).max(0.0) * (max_y - min_y).max(0.0)
            }
            None => 0.0,
        }
    }

    // ----- Zone operations (the AI's core mutators; each returns a typed
    // `Result` and, on success, calls `reassign_components`). See
    // `docs/design/rooms-zones-model.md` §3. -----

    fn zone_index(&self, id: u32) -> Option<usize> {
        self.zones.iter().position(|z| z.id == id)
    }

    /// Union two zones. If `a` and `b` are edge-adjacent, axis-aligned `Rect`s
    /// whose union is itself a rect, they collapse into one `Rect` reusing `a`'s
    /// id (stable reference for the AI): `zone_type` = the larger-area zone's
    /// type (tie → `a`'s), label = `"{a} + {b}"`, `component_ids` concatenated;
    /// returns that id. If the union isn't a clean rect, both zones get a shared
    /// new `group` id (a logical L-room without polygons) and that group id is
    /// returned. `RectRing` zones are not mergeable. `NotFound` if either id
    /// is missing.
    pub fn merge_zones(&mut self, a: u32, b: u32) -> Result<u32, ZoneError> {
        let ia = self.zone_index(a).ok_or(ZoneError::NotFound)?;
        let ib = self.zone_index(b).ok_or(ZoneError::NotFound)?;
        if ia == ib {
            return Err(ZoneError::NotMergeable);
        }
        let (ra, rb) = match (self.zones[ia].shape, self.zones[ib].shape) {
            (ZoneShape::Rect { .. }, ZoneShape::Rect { .. }) => {
                (self.zones[ia].shape, self.zones[ib].shape)
            }
            // A RectRing can't be merged in v1.
            _ => return Err(ZoneError::NotMergeable),
        };

        if let Some(union) = rect_union(&ra, &rb) {
            // Clean rect union → collapse into `a` (reuse id for stability).
            let area_a = self.zones[ia].area();
            let area_b = self.zones[ib].area();
            let win_type = if area_b > area_a {
                self.zones[ib].zone_type
            } else {
                self.zones[ia].zone_type
            };
            let label = format!("{} + {}", self.zones[ia].label, self.zones[ib].label);
            {
                let za = &mut self.zones[ia];
                za.shape = union;
                za.zone_type = win_type;
                za.label = label;
            }
            self.zones.remove(ib);
            // `component_ids` for the union are recomputed here — equivalent to
            // concatenating a's + b's contained components, but authoritative.
            self.reassign_components();
            Ok(a)
        } else {
            // Not a clean rect union → shared group id (logical L-room).
            let gid = self.alloc_id();
            self.zones[ia].group = Some(gid);
            // `ib` index is still valid (nothing removed).
            self.zones[ib].group = Some(gid);
            self.reassign_components();
            Ok(gid)
        }
    }

    /// Cut a `Rect` zone at world coordinate `at` into two tiling `Rect`s. The
    /// first reuses `id`; the second gets a fresh id. Both inherit the parent
    /// `zone_type`; labels are suffixed `" (1)"` / `" (2)"`. `InvalidCut` if the
    /// zone is a `RectRing` or if `at` is not strictly inside the zone.
    pub fn split_zone(&mut self, id: u32, axis: Axis, at: f64) -> Result<(u32, u32), ZoneError> {
        let i = self.zone_index(id).ok_or(ZoneError::NotFound)?;
        let (x, y, w, h) = match self.zones[i].shape {
            ZoneShape::Rect { x, y, w, h } => (x, y, w, h),
            ZoneShape::RectRing { .. } => return Err(ZoneError::InvalidCut),
        };
        let (first, second) = match axis {
            Axis::Vertical => {
                let x0 = x - w / 2.0;
                let x1 = x + w / 2.0;
                if at <= x0 || at >= x1 {
                    return Err(ZoneError::InvalidCut);
                }
                let w1 = at - x0;
                let w2 = x1 - at;
                (
                    ZoneShape::Rect { x: x0 + w1 / 2.0, y, w: w1, h },
                    ZoneShape::Rect { x: at + w2 / 2.0, y, w: w2, h },
                )
            }
            Axis::Horizontal => {
                let y0 = y - h / 2.0;
                let y1 = y + h / 2.0;
                if at <= y0 || at >= y1 {
                    return Err(ZoneError::InvalidCut);
                }
                let h1 = at - y0;
                let h2 = y1 - at;
                (
                    ZoneShape::Rect { x, y: y0 + h1 / 2.0, w, h: h1 },
                    ZoneShape::Rect { x, y: at + h2 / 2.0, w, h: h2 },
                )
            }
        };
        let base_label = self.zones[i].label.clone();
        let zone_type = self.zones[i].zone_type;
        let group = self.zones[i].group;
        let new_id = self.alloc_id();
        {
            let z = &mut self.zones[i];
            z.shape = first;
            z.label = format!("{} (1)", base_label);
            z.component_ids.clear();
        }
        self.zones.insert(
            i + 1,
            Zone {
                id: new_id,
                zone_type,
                shape: second,
                label: format!("{} (2)", base_label),
                component_ids: Vec::new(),
                group,
            },
        );
        self.reassign_components();
        Ok((id, new_id))
    }

    /// Reclassify a zone (recolors, rebuckets stats, recomputes capacity).
    pub fn set_zone_type(&mut self, id: u32, t: ZoneType) -> Result<(), ZoneError> {
        let i = self.zone_index(id).ok_or(ZoneError::NotFound)?;
        self.zones[i].zone_type = t;
        self.reassign_components();
        Ok(())
    }

    /// Resize/move a zone's shape. Rejected (`OutOfBounds`) if the new shape's
    /// bbox exceeds the wall bbox. Overlap with sibling zones is allowed
    /// (transient during interactive drags).
    pub fn resize_zone(&mut self, id: u32, shape: ZoneShape) -> Result<(), ZoneError> {
        let i = self.zone_index(id).ok_or(ZoneError::NotFound)?;
        if let Some((wx0, wy0, wx1, wy1)) = self.wall_bbox() {
            let (bx0, by0, bx1, by1) = shape.bbox();
            let eps = 1e-6;
            if bx0 < wx0 - eps || by0 < wy0 - eps || bx1 > wx1 + eps || by1 > wy1 + eps {
                return Err(ZoneError::OutOfBounds);
            }
        }
        self.zones[i].shape = shape;
        self.reassign_components();
        Ok(())
    }

    /// Create a new zone from a shape (the direct-manipulation "add a room" /
    /// duplicate-room primitive). Returns the new id; rebuckets components so any
    /// furniture the shape now covers is recorded in its `component_ids`.
    pub fn add_zone(&mut self, zone_type: ZoneType, shape: ZoneShape, label: String) -> u32 {
        let id = self.alloc_id();
        self.zones.push(Zone {
            id,
            zone_type,
            shape,
            label,
            component_ids: Vec::new(),
            group: None,
        });
        self.reassign_components();
        id
    }

    /// Delete a room: remove the zone **and every component it contains** (its
    /// furniture), then rebucket the remainder. Clears the selection if it
    /// pointed at a removed component. `NotFound` if the id is unknown.
    pub fn delete_zone(&mut self, id: u32) -> Result<(), ZoneError> {
        let i = self.zone_index(id).ok_or(ZoneError::NotFound)?;
        let members = std::mem::take(&mut self.zones[i].component_ids);
        self.zones.remove(i);
        self.components.retain(|c| !members.contains(&c.id));
        if let Some(sel) = self.selection {
            if members.contains(&sel) {
                self.selection = None;
            }
        }
        self.reassign_components();
        Ok(())
    }

    /// Rename a zone's human/AI-facing label (e.g. after reclassifying its type).
    /// `NotFound` if the id is unknown.
    pub fn rename_zone(&mut self, id: u32, label: String) -> Result<(), ZoneError> {
        let i = self.zone_index(id).ok_or(ZoneError::NotFound)?;
        self.zones[i].label = label;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::geometry::Point;
    use crate::model::DecisionState;

    fn rect_zone(id: u32, t: ZoneType, x: f64, y: f64, w: f64, h: f64) -> Zone {
        Zone {
            id,
            zone_type: t,
            shape: ZoneShape::Rect { x, y, w, h },
            label: format!("Zone {id}"),
            component_ids: Vec::new(),
            group: None,
        }
    }

    fn desk(id: u32, x: f64, y: f64) -> Component {
        Component {
            id,
            category: "Desk".to_string(),
            x,
            y,
            w: 1.0,
            h: 1.0,
            rotation: 0.0,
            mirror: false,
            label: format!("Desk {id}"),
            product_id: None,
            price_inr: None,
            decision: DecisionState::Open,
        }
    }

    #[test]
    fn merge_adjacent_rects_into_one_with_larger_type() {
        let mut doc = Document::new();
        doc.next_id = 10;
        // A: bbox 0..4 × 0..4 (area 16), Workspace.
        doc.zones.push(rect_zone(1, ZoneType::Workspace, 2.0, 2.0, 4.0, 4.0));
        // B: bbox 4..10 × 0..4 (area 24), Meeting — edge-adjacent to A's right.
        doc.zones.push(rect_zone(2, ZoneType::Meeting, 7.0, 2.0, 6.0, 4.0));

        let id = doc.merge_zones(1, 2).expect("adjacent rects merge");
        assert_eq!(id, 1, "reuses a's id");
        assert_eq!(doc.zones.len(), 1, "two zones collapse to one");
        let z = &doc.zones[0];
        // Union bbox 0..10 × 0..4 → Rect{x:5,y:2,w:10,h:4}.
        match z.shape {
            ZoneShape::Rect { x, y, w, h } => {
                assert!((x - 5.0).abs() < 1e-9);
                assert!((y - 2.0).abs() < 1e-9);
                assert!((w - 10.0).abs() < 1e-9);
                assert!((h - 4.0).abs() < 1e-9);
            }
            _ => panic!("expected Rect"),
        }
        // Larger-area zone (B, Meeting) wins the type.
        assert_eq!(z.zone_type, ZoneType::Meeting);
    }

    #[test]
    fn merge_non_adjacent_sets_shared_group() {
        let mut doc = Document::new();
        doc.next_id = 10;
        // A bbox 0..4, B bbox 6..10 — a gap between them (not a clean rect union).
        doc.zones.push(rect_zone(1, ZoneType::Workspace, 2.0, 2.0, 4.0, 4.0));
        doc.zones.push(rect_zone(2, ZoneType::Meeting, 8.0, 2.0, 4.0, 4.0));

        let gid = doc.merge_zones(1, 2).expect("non-adjacent falls back to group");
        assert_eq!(doc.zones.len(), 2, "both zones kept");
        assert_eq!(doc.zones[0].group, Some(gid));
        assert_eq!(doc.zones[1].group, Some(gid));
        assert!(gid > 2, "group id is freshly allocated");
    }

    #[test]
    fn merge_missing_id_is_not_found() {
        let mut doc = Document::new();
        doc.zones.push(rect_zone(1, ZoneType::Workspace, 2.0, 2.0, 4.0, 4.0));
        assert_eq!(doc.merge_zones(1, 99), Err(ZoneError::NotFound));
    }

    #[test]
    fn split_partitions_components_by_center() {
        let mut doc = Document::new();
        doc.next_id = 20;
        // One 10×10 zone spanning bbox 0..10 × 0..10.
        doc.zones.push(rect_zone(1, ZoneType::Workspace, 5.0, 5.0, 10.0, 10.0));
        doc.components.push(desk(101, 2.0, 5.0)); // left half
        doc.components.push(desk(102, 8.0, 5.0)); // right half
        doc.reassign_components();

        let (a, b) = doc.split_zone(1, Axis::Vertical, 5.0).expect("interior cut");
        assert_eq!(a, 1, "first half reuses id");
        assert!(b > 20, "second half is a fresh id");
        assert_eq!(doc.zones.len(), 2);

        let left = doc.zones.iter().find(|z| z.id == a).unwrap();
        let right = doc.zones.iter().find(|z| z.id == b).unwrap();
        assert_eq!(left.component_ids, vec![101]);
        assert_eq!(right.component_ids, vec![102]);
    }

    #[test]
    fn add_zone_returns_id_and_buckets_contained_components() {
        let mut doc = Document::new();
        doc.next_id = 30;
        doc.components.push(desk(101, 5.0, 5.0));
        let id = doc.add_zone(
            ZoneType::Meeting,
            ZoneShape::Rect { x: 5.0, y: 5.0, w: 4.0, h: 4.0 },
            "Meeting Room".into(),
        );
        assert!(id > 30, "fresh id allocated");
        let z = doc.zones.iter().find(|z| z.id == id).unwrap();
        assert_eq!(z.component_ids, vec![101], "covers the desk at its center");
    }

    #[test]
    fn delete_zone_removes_room_and_its_furniture() {
        let mut doc = Document::new();
        doc.next_id = 40;
        doc.zones.push(rect_zone(1, ZoneType::Workspace, 5.0, 5.0, 10.0, 10.0));
        doc.components.push(desk(101, 3.0, 3.0)); // inside
        doc.components.push(desk(102, 30.0, 30.0)); // far outside
        doc.reassign_components();
        doc.selection = Some(101);

        doc.delete_zone(1).expect("zone exists");
        assert!(doc.zones.is_empty(), "the room is gone");
        assert!(doc.components.iter().all(|c| c.id != 101), "its furniture deleted");
        assert!(doc.components.iter().any(|c| c.id == 102), "outside furniture kept");
        assert_eq!(doc.selection, None, "selection on a deleted member cleared");
        assert_eq!(doc.delete_zone(1), Err(ZoneError::NotFound));
    }

    #[test]
    fn rename_zone_updates_label() {
        let mut doc = Document::new();
        doc.zones.push(rect_zone(1, ZoneType::Workspace, 5.0, 5.0, 4.0, 4.0));
        doc.rename_zone(1, "Board Room".into()).unwrap();
        assert_eq!(doc.zones[0].label, "Board Room");
        assert_eq!(doc.rename_zone(99, "x".into()), Err(ZoneError::NotFound));
    }

    #[test]
    fn split_outside_zone_is_invalid_cut() {
        let mut doc = Document::new();
        doc.zones.push(rect_zone(1, ZoneType::Workspace, 5.0, 5.0, 10.0, 10.0));
        assert_eq!(
            doc.split_zone(1, Axis::Vertical, 99.0),
            Err(ZoneError::InvalidCut)
        );
    }

    #[test]
    fn snapshot_round_trip_is_identity_including_next_id() {
        let mut doc = Document::new();
        // Populate walls, components, zones and advance next_id.
        let wid = doc.alloc_id();
        doc.walls.push(Wall {
            id: wid,
            a: Point::new(0.0, 0.0),
            b: Point::new(10.0, 0.0),
            thickness: 0.2,
            generated: false,
            glazing: false,
        });
        let cid = doc.alloc_id();
        let mut c = desk(cid, 3.0, 3.0);
        c.decision = DecisionState::Confirmed;
        doc.components.push(c);
        let zid = doc.alloc_id();
        doc.zones
            .push(rect_zone(zid, ZoneType::Workspace, 5.0, 5.0, 8.0, 8.0));
        doc.reassign_components();
        doc.selection = Some(cid);

        let before = serde_json::to_value(&doc).unwrap();
        let snap = serde_json::to_string(&doc).unwrap();
        let saved_next_id = doc.next_id;

        // Mutate the live doc so restore has something to undo.
        doc.merge_zones(zid, 9999).ok();
        let extra = doc.alloc_id();
        doc.components.push(desk(extra, 1.0, 1.0));
        doc.selection = None;

        // Restore from the snapshot.
        let restored: Document = serde_json::from_str(&snap).unwrap();
        assert_eq!(restored.next_id, saved_next_id, "next_id survives round-trip");
        assert_eq!(
            serde_json::to_value(&restored).unwrap(),
            before,
            "restored document is field-for-field identical"
        );
    }

    #[test]
    fn cad_json_round_trips_through_snapshot() {
        let mut doc = Document::new();
        doc.cad_json = Some(r#"{"lines":[{"a":[0,0],"b":[3,4]}]}"#.to_string());

        let snap = serde_json::to_string(&doc).unwrap();
        let restored: Document = serde_json::from_str(&snap).unwrap();
        assert_eq!(restored.cad_json, doc.cad_json, "cad_json survives snapshot/restore");
    }

    #[test]
    fn keepouts_round_trip_through_snapshot() {
        let mut doc = Document::new();
        let kid = doc.alloc_id();
        doc.keepouts.push(KeepOut {
            id: kid, x: 5.0, y: 6.0, w: 2.5, h: 3.0, label: "Stair core".into(),
        });
        let snap = serde_json::to_string(&doc).unwrap();
        let restored: Document = serde_json::from_str(&snap).unwrap();
        assert_eq!(restored.keepouts.len(), 1);
        let k = &restored.keepouts[0];
        assert_eq!((k.x, k.y, k.w, k.h, k.label.as_str()), (5.0, 6.0, 2.5, 3.0, "Stair core"));
    }

    #[test]
    fn entries_round_trip_through_snapshot() {
        let mut doc = Document::new();
        doc.entries.push(Point::new(12.5, 0.0));
        doc.entries.push(Point::new(0.0, 8.25));
        let snap = serde_json::to_string(&doc).unwrap();
        let restored: Document = serde_json::from_str(&snap).unwrap();
        assert_eq!(restored.entries.len(), 2, "entries survive the snapshot round-trip");
        assert!((restored.entries[0].x - 12.5).abs() < 1e-12);
        assert!((restored.entries[1].y - 8.25).abs() < 1e-12);
        // A pre-M4 snapshot without the field restores to an empty entries vec.
        let old = r#"{"walls":[],"components":[],"zones":[],"selection":null,"next_id":0}"#;
        let r2: Document = serde_json::from_str(old).unwrap();
        assert!(r2.entries.is_empty(), "missing entries field defaults to empty");
    }

    #[test]
    fn anchors_round_trip_through_snapshot() {
        let mut doc = Document::new();
        doc.anchors.push(Anchor { kind: SpaceKind::Reception, x: 3.5, y: 2.0 });
        doc.anchors.push(Anchor { kind: SpaceKind::Cabin, x: 9.0, y: 6.25 });
        let snap = serde_json::to_string(&doc).unwrap();
        let restored: Document = serde_json::from_str(&snap).unwrap();
        assert_eq!(restored.anchors.len(), 2, "anchors survive the snapshot round-trip");
        assert_eq!(restored.anchors[0].kind, SpaceKind::Reception);
        assert!((restored.anchors[0].x - 3.5).abs() < 1e-12);
        assert!((restored.anchors[1].y - 6.25).abs() < 1e-12);
        // A pre-S6 snapshot without the field restores to an empty anchors vec.
        let old = r#"{"walls":[],"components":[],"zones":[],"selection":null,"next_id":0}"#;
        let r2: Document = serde_json::from_str(old).unwrap();
        assert!(r2.anchors.is_empty(), "missing anchors field defaults to empty");
    }

    #[test]
    fn old_snapshot_without_keepouts_restores_to_empty() {
        // A hand-written pre-keepouts snapshot (the field simply absent) must
        // deserialize with `keepouts` defaulting to an empty vec.
        let old = r#"{"walls":[],"components":[],"zones":[],"selection":null,"next_id":0}"#;
        let restored: Document = serde_json::from_str(old).unwrap();
        assert!(restored.keepouts.is_empty(), "missing keepouts field defaults to empty");
    }

    #[test]
    fn old_snapshot_without_cad_json_restores_fine() {
        // Capture a snapshot BEFORE cad_json is ever set — this is byte-for-byte
        // what pre-cad_json builds produced, since `None` is skipped on serialize.
        let doc = Document::new();
        let old_snap = serde_json::to_string(&doc).unwrap();
        assert!(
            !old_snap.contains("cad_json"),
            "unset cad_json must not appear in snapshots (old-format equivalence)"
        );

        let restored: Document = serde_json::from_str(&old_snap).unwrap();
        assert_eq!(restored.cad_json, None, "missing field defaults to None");
    }

    fn wall(id: u32, ax: f64, ay: f64, bx: f64, by: f64) -> Wall {
        Wall {
            id,
            a: Point::new(ax, ay),
            b: Point::new(bx, by),
            thickness: 0.2,
            generated: false,
            glazing: false,
        }
    }

    #[test]
    fn plate_points_is_four_corners_for_rect_room() {
        let mut doc = Document::new();
        doc.walls.push(wall(1, 0.0, 0.0, 10.0, 0.0));
        doc.walls.push(wall(2, 10.0, 0.0, 10.0, 6.0));
        doc.walls.push(wall(3, 10.0, 6.0, 0.0, 6.0));
        doc.walls.push(wall(4, 0.0, 6.0, 0.0, 0.0));

        let pts = doc.plate_points().expect("closed rectangle traces a plate");
        assert_eq!(pts.len(), 4, "rectangular room has 4 corners");
        for corner in [[0.0, 0.0], [10.0, 0.0], [10.0, 6.0], [0.0, 6.0]] {
            assert!(
                pts.iter()
                    .any(|p| (p[0] - corner[0]).abs() < 1e-6 && (p[1] - corner[1]).abs() < 1e-6),
                "missing corner {corner:?} in {pts:?}"
            );
        }
    }

    #[test]
    fn plate_points_is_none_for_open_walls() {
        let mut doc = Document::new();
        // Three sides only — the loop never closes.
        doc.walls.push(wall(1, 0.0, 0.0, 10.0, 0.0));
        doc.walls.push(wall(2, 10.0, 0.0, 10.0, 6.0));
        doc.walls.push(wall(3, 10.0, 6.0, 0.0, 6.0));
        assert_eq!(doc.plate_points(), None);
    }
}

/// Union of two axis-aligned, center-origin rects **iff** they are edge-adjacent
/// and share a full edge so the union is itself a rectangle; otherwise `None`.
fn rect_union(a: &ZoneShape, b: &ZoneShape) -> Option<ZoneShape> {
    let (ax0, ay0, ax1, ay1) = a.bbox();
    let (bx0, by0, bx1, by1) = b.bbox();
    let eps = 1e-6;
    let close = |p: f64, q: f64| (p - q).abs() < eps;
    // Same vertical extent, touching along a shared vertical edge (side by side).
    let horiz = close(ay0, by0) && close(ay1, by1) && (close(ax1, bx0) || close(bx1, ax0));
    // Same horizontal extent, touching along a shared horizontal edge (stacked).
    let vert = close(ax0, bx0) && close(ax1, bx1) && (close(ay1, by0) || close(by1, ay0));
    if !horiz && !vert {
        return None;
    }
    let x0 = ax0.min(bx0);
    let y0 = ay0.min(by0);
    let x1 = ax1.max(bx1);
    let y1 = ay1.max(by1);
    Some(ZoneShape::Rect {
        x: (x0 + x1) / 2.0,
        y: (y0 + y1) / 2.0,
        w: x1 - x0,
        h: y1 - y0,
    })
}
