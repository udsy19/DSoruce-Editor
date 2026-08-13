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

/// Fraction of a plan's anchor points a wall-network face must contain before it
/// may be called the floor plate.
///
/// **0.9, and the slack is for furniture, not for doubt.** Components are
/// centre-referenced and sit hard against walls; a desk pushed to a facade or a
/// door leaf swinging through a threshold can put a centre a few centimetres
/// outside the centreline polygon, and a chair placed in a lobby recess likewise.
/// Measured on the sample plate's generated plan: **253 of 254 anchors, 0.9961**
/// — the one straggler is exactly that case, and the number is re-derived by
/// `plate_containment_on_a_real_plan_is_not_near_the_threshold` rather than
/// remembered here.
///
/// The failures this rejects are not near the line: a scratch loop inside the
/// plan contains ~0, and a plate cut in half by a committed CAD line contains
/// ~0.5. Nothing legitimate lives between 0.5 and 0.99, so the threshold is not
/// a tuned parameter; it is a gap, and 0.9 sits in the middle of it.
pub(crate) const PLATE_CONTAINMENT: f64 = 0.9;

/// What the wall network could tell us about the floor plate.
///
/// The point of the type is that **"we don't know" is a value**. The old code
/// had two outcomes — a polygon or a silent bounding-box fallback — so a
/// document whose envelope had just been broken reported a confident number
/// derived from the wrong loop. Callers that render to a user must branch on
/// this; callers that need geometry may take `floor_area()`'s fallback and know
/// what they are taking.
#[derive(Clone, Debug)]
pub(crate) enum PlateResolution {
    /// A face of the wall network contains this plan: the floor plate.
    Traced(Vec<crate::geometry::Point>),
    /// The walls close nowhere — an open envelope. Historically the ordinary
    /// case for a plate imported as loose segments, and the bounding box is a
    /// reasonable stand-in.
    Open,
    /// The walls DO close, but no closed face contains the plan. Something the
    /// user drew changed which loops exist, and the honest answer is that the
    /// floor is no longer identifiable — not a number from the wrong loop.
    Unresolved,
}

impl PlateResolution {
    /// Wire tag for the frontend, so the panel can branch without re-deriving.
    pub(crate) fn tag(&self) -> &'static str {
        match self {
            PlateResolution::Traced(_) => "traced",
            PlateResolution::Open => "open",
            PlateResolution::Unresolved => "unresolved",
        }
    }
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

    /// Resolve `Component::seats` for anything deserialized without it.
    ///
    /// `seats` is `#[serde(default)]`, so every plan saved before the facet
    /// existed loads with 0. Left alone that is not a crash — `zone_stats`
    /// falls back to the area rule-of-thumb — but it is worse: an OLD plan would
    /// report area-estimated pax while a NEWLY generated one reports the seats
    /// its furniture actually provides, so the same building would read
    /// differently depending on when it was saved, and a room tag could once
    /// again disagree with the chairs drawn under it.
    ///
    /// So every load backfills. `seats_for` is the same resolver used at
    /// creation and returns 0 for things nobody sits at, which makes this
    /// idempotent and safe to run unconditionally: re-running it on an
    /// already-resolved document changes nothing.
    pub fn backfill_seats(&mut self) {
        for c in &mut self.components {
            if c.seats == 0 {
                c.seats = crate::model::seats_for(&c.category, c.w, c.h);
            }
        }
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
    /// rect) wins over the perimeter `Circulation` ring, and among the winning
    /// class the **smallest-area** zone wins — an enclosed room beats the
    /// plate-spanning open-workspace field it sits inside. Returns `None` if no
    /// zone contains the point. Shared by `reassign_components` (per-component)
    /// and `zone_at` (hit-test).
    ///
    /// **Smallest-area, not last-in-order.** The generator emits its rooms
    /// BEFORE the workspace field, and the oriented field is a plate-spanning
    /// rect that encloses the band rooms, so "last one wins" silently bucketed a
    /// meeting room's or cabin's furniture into Open Workspace — which is why
    /// three cabins with byte-identical furniture reported headcounts of 1, 0
    /// and 0 (only the cabins the field rect happened to miss kept their own
    /// chairs). Smallest-area is order-independent, so identical rooms are now
    /// bucketed identically by construction. It is also exactly the ownership
    /// rule `layout::conform_zones_to_plate` already uses ("a cell inside one or
    /// more zone rects is owned by the SMALLEST-area one"), so the two passes
    /// agree on which zone owns a piece of floor.
    fn zone_index_at(&self, x: f64, y: f64) -> Option<usize> {
        let mut chosen: Option<(usize, f64)> = None;
        let mut found_non_circ = false;
        for (i, z) in self.zones.iter().enumerate() {
            if !z.shape.contains(x, y) {
                continue;
            }
            // GROUND, not figure: circulation and unassigned floor are the
            // surface a plan sits on, so both lose to any specific zone.
            //
            // `Unassigned` belongs here on semantics — it is ground, and ground
            // never outranks a room. It is DEFENSIVE, not load-bearing, and the
            // difference was measured rather than assumed: the Phase 0 audit
            // called this "the highest-risk item in Phase 1" and predicted the
            // workstation count would move without it. **That prediction was
            // falsified.** Reverting this line to `== ZoneType::Circulation` and
            // running the whole suite in a disposable worktree produced ZERO
            // failures.
            //
            // The reason is an invariant one file over: `conform` emits residual
            // pockets with corner clearance against every other zone, so they
            // are strictly disjoint from rooms and fields by construction. A
            // desk centre inside an `Unassigned` poly is therefore inside no
            // other zone, and this tie-break never fires for it. The guard costs
            // nothing and matters the moment that disjointness is relaxed — but
            // it is not what keeps the count at 85 today, and a comment claiming
            // otherwise would be a false claim in the one place nobody re-checks.
            let circ = crate::is_ground_zone(z.zone_type);
            if circ && found_non_circ {
                continue; // a specific zone already outranks any ground zone
            }
            let area = z.shape.area();
            if !circ && !found_non_circ {
                found_non_circ = true; // first specific zone displaces circulation
                chosen = Some((i, area));
            } else if chosen.is_none_or(|(_, best)| area < best) {
                chosen = Some((i, area));
            }
        }
        chosen.map(|(i, _)| i)
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

    /// Rebucket ONE component after its center moved, or it was created or
    /// deleted: strip `cid` from every zone's membership, then (if the component
    /// still exists) insert it into the zone containing its center.
    ///
    /// The per-component form of `reassign_components` — a deliberate second
    /// entry point, not a second definition: ownership is decided by the same
    /// `zone_index_at`, so the two cannot disagree (the freshness gate
    /// cross-checks them against each other on a clone). It exists because the
    /// component mutators run per pointer-move during a drag, where a full
    /// all-components rebuild is avoidable O(components × zones) work.
    ///
    /// Before the component mutators called this, `component_ids` went stale on
    /// every hand edit: a desk added into a room was invisible to the room's
    /// "N pax" tag until an unrelated zone edit rebuilt membership, a desk
    /// dragged out kept being counted where it no longer was, and `delete_zone`
    /// deleted furniture the user had already dragged elsewhere. See the
    /// `component_mutators_keep_pax_membership_fresh` gate (watched red).
    pub fn rebucket_component(&mut self, cid: u32) {
        for z in &mut self.zones {
            z.component_ids.retain(|&c| c != cid);
        }
        if let Some(c) = self.components.iter().find(|c| c.id == cid) {
            if let Some(i) = self.zone_index_at(c.x, c.y) {
                self.zones[i].component_ids.push(cid);
            }
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

    /// The floor-plate polygon traced from the walls, or `None` when no face of
    /// the wall network can be identified as the building envelope.
    ///
    /// **This used to be "the largest closed loop", and that was a defect.**
    /// Largest-wins is right exactly while the envelope's own loop is closed;
    /// one user gesture breaks that assumption. Draw a phone-booth outline while
    /// the envelope is open — or commit a CAD line that snaps across the plate
    /// and splits its face in two — and the largest surviving face is no longer
    /// the building. A 930 m² floor reported **1 m²**, the panel divided by it,
    /// and space efficiency read **1159%**. Nothing in `generate` was wrong; the
    /// number had simply never been measured after an edit.
    ///
    /// So selection now asks the question largest-wins was standing in for:
    /// *which face is the floor this plan sits on?* A candidate must **contain
    /// the plan** — see [`PLATE_CONTAINMENT`]. A document with too little plan to
    /// judge by (a plate just imported, before `generate`) has no evidence
    /// either way and keeps largest-wins; a document with a plan and no face that
    /// contains it is **unresolved**, which is a state the panel reports rather
    /// than a number it invents.
    ///
    /// Generated partitions stay excluded from the trace: the plate is the
    /// building envelope, and re-tracing our own room shells would corrupt
    /// regeneration (see docs/design/testfit-pro-quality.md §2).
    pub(crate) fn plate_polygon(&self) -> Option<Vec<crate::geometry::Point>> {
        match self.plate_resolution() {
            PlateResolution::Traced(poly) => Some(poly),
            _ => None,
        }
    }

    /// Points the plate must contain to count as this plan's floor: every
    /// component centre and every zone's representative point.
    ///
    /// Derived from the DOCUMENT, never from anything the plate trace produced —
    /// the check would otherwise be asking the candidate to vouch for itself.
    fn plan_anchors(&self) -> Vec<crate::geometry::Point> {
        let mut pts: Vec<crate::geometry::Point> = self
            .components
            .iter()
            .map(|c| crate::geometry::Point::new(c.x, c.y))
            .collect();
        for z in &self.zones {
            match z.shape {
                ZoneShape::Rect { x, y, .. } | ZoneShape::RectRing { x, y, .. } => {
                    pts.push(crate::geometry::Point::new(x, y))
                }
                ZoneShape::Poly { pts: ref ring } => {
                    if !ring.is_empty() {
                        let n = ring.len() as f64;
                        let (sx, sy) =
                            ring.iter().fold((0.0, 0.0), |(ax, ay), p| (ax + p[0], ay + p[1]));
                        pts.push(crate::geometry::Point::new(sx / n, sy / n));
                    }
                }
            }
        }
        pts
    }

    /// `plan_anchors`, for the test that publishes the containment measurement.
    #[cfg(test)]
    pub(crate) fn plan_anchors_for_test(&self) -> Vec<crate::geometry::Point> {
        self.plan_anchors()
    }

    /// Which face — if any — is this plan's floor, and how confident are we.
    pub(crate) fn plate_resolution(&self) -> PlateResolution {
        let segs: Vec<_> = self
            .walls
            .iter()
            .filter(|w| !w.generated)
            .map(|w| (w.a, w.b))
            .collect();
        let faces =
            crate::geometry::trace_floor_faces(&segs, crate::geometry::LOOP_SNAP_TOL);
        if faces.is_empty() {
            return PlateResolution::Open;
        }
        let anchors = self.plan_anchors();
        // **Acceptance is the FRACTION and nothing else — there is no count gate.**
        //
        // There used to be one: `anchors.len() < MIN_PLAN_ANCHORS (8)` skipped the
        // containment test entirely and fell back to largest-wins. Its stated
        // justification was the wizard's zero-plan import, but its PREDICATE
        // covered every document with one to seven anchors — and seven anchors is
        // a real plan. Measured on a 40×30 envelope with one wall deleted plus a
        // 1.2 × 1.0 m scratch box, 2 zones + 5 components:
        // `plate_state "traced" · GEA 1.20 m²` for a 1200 m² building, with
        // `Open Workspace 1.2 m² / 80 pax`. A 1000× under-report, and `"traced"`
        // is a positive claim that the number is a measurement.
        //
        // The wizard case needs no exception, because the fraction already covers
        // it: with zero anchors `0 >= PLATE_CONTAINMENT * 0` holds, the largest
        // face is accepted, and behaviour is byte-identical to the old special
        // case. A gate whose only justified case is handled by the general rule
        // was never a gate; it was a hole.
        //
        // The cost is stated rather than hidden: with a one- or two-anchor plan a
        // single straggling component centre outside the centreline polygon now
        // yields `unresolved` instead of a traced plate. That is the conservative
        // direction — a state the panel reports, not a number it invents — and it
        // is what the ledger's "we don't know is a value" rule asks for.
        for face in faces {
            let inside = anchors
                .iter()
                .filter(|p| crate::geometry::point_in_polygon(p.x, p.y, &face))
                .count();
            if inside as f64 >= PLATE_CONTAINMENT * anchors.len() as f64 {
                return PlateResolution::Traced(face);
            }
        }
        PlateResolution::Unresolved
    }

    /// `plate_polygon` mapped to plain `[x, y]` pairs — the wire shape the
    /// frontend consumes (`Editor::plate`). Pure, so it is natively testable;
    /// the wasm method only serializes this.
    pub(crate) fn plate_points(&self) -> Option<Vec<[f64; 2]>> {
        self.plate_polygon()
            .map(|poly| poly.into_iter().map(|p| [p.x, p.y]).collect())
    }

    /// Ids of the walls that lie ON the traced plate boundary — the CUT walls,
    /// which take the heavier line tier.
    ///
    /// Moved here from `EditorCanvas.updatePlate`, which re-derived it TS-side
    /// from a serialized plate polygon on every wall change. It is geometry and
    /// the plate is the core's; the renderer should be told, not made to work it
    /// out. Same rule as before: a non-generated wall whose BOTH endpoints sit
    /// within 8 cm of the boundary.
    pub(crate) fn exterior_wall_ids(&self) -> Vec<u32> {
        let Some(poly) = self.plate_polygon() else { return Vec::new() };
        if poly.len() < 3 {
            return Vec::new();
        }
        const ON_BOUNDARY_M: f64 = 0.08;
        self.walls
            .iter()
            .filter(|w| !w.generated)
            .filter(|w| {
                crate::geometry::dist_to_polygon(w.a, &poly) < ON_BOUNDARY_M
                    && crate::geometry::dist_to_polygon(w.b, &poly) < ON_BOUNDARY_M
            })
            .map(|w| w.id)
            .collect()
    }

    /// The wall bounding box's area — the fallback floor figure, and an upper
    /// bound on any face inside it.
    fn bbox_area(&self) -> f64 {
        match self.wall_bbox() {
            Some((min_x, min_y, max_x, max_y)) => {
                (max_x - min_x).max(0.0) * (max_y - min_y).max(0.0)
            }
            None => 0.0,
        }
    }

    /// True floor area (meters²): the traced plate-polygon area when the plate
    /// resolves (exact for any shape, identical to the bbox for rectangles);
    /// the wall bounding box otherwise.
    ///
    /// **The fallback is a number, and the fallback is not trustworthy** — which
    /// is why callers that show it to a user must ask [`Self::plate_resolution`]
    /// first. Geometry consumers (the 3D floor slab, zone clipping) need *a*
    /// number and are better served by a defensible over-estimate than by zero;
    /// the statistics panel is served by the truth, which is that we do not know.
    pub fn floor_area(&self) -> f64 {
        match self.plate_resolution() {
            PlateResolution::Traced(poly) => crate::geometry::polygon_area(&poly).abs(),
            _ => self.bbox_area(),
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
        let (ra, rb) = match (&self.zones[ia].shape, &self.zones[ib].shape) {
            (ZoneShape::Rect { .. }, ZoneShape::Rect { .. }) => {
                (self.zones[ia].shape.clone(), self.zones[ib].shape.clone())
            }
            // A RectRing / Poly can't be merged in v1.
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
        // Same reason as `zone_shape_admissible`: the "strictly inside" test below
        // is `at <= x0 || at >= x1`, and a NaN `at` answers false to both, cutting
        // the zone into two NaN-wide halves that no snapshot can reload.
        if !at.is_finite() {
            return Err(ZoneError::NonFinite);
        }
        let i = self.zone_index(id).ok_or(ZoneError::NotFound)?;
        let (x, y, w, h) = match self.zones[i].shape {
            ZoneShape::Rect { x, y, w, h } => (x, y, w, h),
            // A RectRing / Poly zone is not axis-cuttable in v1.
            _ => return Err(ZoneError::InvalidCut),
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
                // A user split produces a DRAWN zone, even when the zone it
                // came from was residual: the moment a person shapes it, it is
                // designed. `Residual` is generator-only (see `ZoneOrigin`).
                origin: crate::zone::ZoneOrigin::Drawn,
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

    /// **The one admissibility test for a zone shape**, shared by every writer of
    /// `Zone::shape` (`resize_zone`, `add_zone`).
    ///
    /// It exists as a function because it used to exist as a copy-of-zero: the
    /// bounds test lived inline in `resize_zone` and `add_zone` had NO check at
    /// all, so `add_zone(5000, 5000, 200, 200)` billed `area 0 · capacity 6666`
    /// and took a plan's published capacity from 131 to 6797. Two writers of one
    /// invariant, one of them empty, is the `no-bloat` divergence in its cheapest
    /// form.
    ///
    /// Finiteness is checked FIRST and separately. `NaN` satisfies neither `<`
    /// nor `>`, so it walked through the bounds test untouched; a guard written
    /// in comparisons cannot be handed a value that answers `false` to all of
    /// them and still be a guard.
    fn zone_shape_admissible(&self, shape: &ZoneShape) -> Result<(), ZoneError> {
        if !shape.is_finite() {
            return Err(ZoneError::NonFinite);
        }
        if let Some((wx0, wy0, wx1, wy1)) = self.wall_bbox() {
            let (bx0, by0, bx1, by1) = shape.bbox();
            let eps = 1e-6;
            if bx0 < wx0 - eps || by0 < wy0 - eps || bx1 > wx1 + eps || by1 > wy1 + eps {
                return Err(ZoneError::OutOfBounds);
            }
        }
        Ok(())
    }

    /// Conform an edit's target rect to the floor plate — the SAME rule the
    /// generator applies (`layout/conform.rs:345`), so a room the user moves and
    /// a room the generator placed obey one definition of "inside the building".
    ///
    /// Before this existed, `resize_zone` stored whatever rect the drag produced.
    /// A conforming `Poly` room — one whose edge follows a diagonal or stepped
    /// wall — was therefore **silently replaced by its bounding box** on the first
    /// drag, gaining floor that is outside the building and losing the geometry
    /// the generator computed. `zone.rs` claimed edits "reject `Poly`"; cut and
    /// merge do, resize did not.
    ///
    /// **Why re-deriving from a rect is stable, not erosive.** A conformed shape
    /// is `S = plate ∩ R`. Since `S ⊆ bbox(S) ⊆ R`, clipping again gives
    /// `plate ∩ bbox(S) ⊆ plate ∩ R = S`, and `S ⊆ plate ∩ bbox(S)` because `S`
    /// is inside both. So `plate ∩ bbox(S) = S` **exactly** — dragging a room
    /// away and back cannot nibble it down, and a no-op drag is a no-op.
    ///
    /// Returns `Rect` unchanged when the plate does not cut it: an unclipped room
    /// stays the cheap, exactly-representable shape the user drew, so this does
    /// not turn every rectangle in the document into a 4-point polygon.
    /// `was_on_plate` is whether the zone's CURRENT shape touches the plate, and
    /// it is what makes an empty clip interpretable. See the body.
    fn conform_to_plate(
        &self,
        shape: ZoneShape,
        was_on_plate: bool,
    ) -> Result<ZoneShape, ZoneError> {
        let ZoneShape::Rect { x, y, w, h } = shape else {
            // Already a polygon (or a ring): the caller owns that geometry and it
            // is not a drag target. Pass it through untouched.
            return Ok(shape);
        };
        // `plate_polygon` is `Traced` only — `Open` and `Unresolved` both give
        // `None` — so this is the existing owner of "do we actually know where
        // the floor is", not a second opinion. No plate, no conforming.
        let Some(plate) = self.plate_polygon() else {
            return Ok(shape);
        };
        let (x0, y0, x1, y1) = (x - w / 2.0, y - h / 2.0, x + w / 2.0, y + h / 2.0);
        let clipped = crate::geometry::clip_rect_to_polygon(&plate, x0, y0, x1, y1);
        if clipped.len() < 3 {
            // The target has no floor under it. TWO very different situations
            // produce that, and conflating them broke a real document:
            //
            // 1. The user dragged a room out of the building. Refuse it.
            // 2. **The plate is not this room's floor.** `plate_resolution`
            //    identifies the plate as the face containing the PLAN — so on a
            //    document with an open envelope and one stray closed loop, and
            //    before enough plan exists to disqualify it, the "plate" can be a
            //    1.2 m² scratch box forty metres away
            //    (`a_seven_anchor_plan_cannot_certify_a_scratch_box_as_the_floor`).
            //    Refusing there would make every room on an imperfectly-closed
            //    import unplaceable — and imperfectly-closed is the normal state
            //    of an imported DWG.
            //
            // Telling them apart without circularity: ask whether the zone was on
            // the plate BEFORE this edit. If it was, the plate is demonstrably the
            // floor this room lives on and leaving it is a real error. If it was
            // never on it, this plate has nothing to say about this room, and the
            // conservative act is to leave the user's rect alone.
            return if was_on_plate { Err(ZoneError::OutOfBounds) } else { Ok(shape) };
        }
        // Did the plate actually cut it? Compare areas rather than point counts:
        // a rect clipped by a collinear plate edge can come back as 4 points that
        // are the same rectangle.
        let rect_area = w * h;
        let clip_area = crate::geometry::polygon_area(&clipped);
        if (rect_area - clip_area).abs() <= 1e-6 * rect_area.max(1.0) {
            return Ok(shape);
        }
        Ok(ZoneShape::Poly { pts: clipped.into_iter().map(|p| [p.x, p.y]).collect() })
    }

    /// Resize/move a zone's shape. Rejected (`OutOfBounds`) if the new shape's
    /// bbox exceeds the wall bbox or falls entirely off the floor plate, or
    /// (`NonFinite`) if any coordinate is NaN/±∞.
    ///
    /// A `Rect` target is **conformed to the plate** first — see
    /// [`Document::conform_to_plate`] — so an edit can neither flatten a
    /// boundary-following room into a box nor push floor outside the building.
    /// Overlap with sibling zones is allowed (transient during interactive drags).
    pub fn resize_zone(&mut self, id: u32, shape: ZoneShape) -> Result<(), ZoneError> {
        let i = self.zone_index(id).ok_or(ZoneError::NotFound)?;
        self.zone_shape_admissible(&shape)?;
        // Measured BEFORE the edit lands: does this room currently stand on the
        // plate? Distinguishes "dragged out of the building" from "this plate is
        // not this room's floor" — see `conform_to_plate`.
        //
        // A PREDICATE, deliberately, not an area. `area_on` would answer this too,
        // but a magnitude has exactly one owner (`mod basis`) and recomputing one
        // here is the cross-language defect `area-census` exists to catch — it
        // caught this line. Overlap is a question about shapes, so it is asked
        // with the clipper and answered yes/no.
        let was_on_plate = self.plate_polygon().is_some_and(|p| {
            let (bx0, by0, bx1, by1) = self.zones[i].shape.bbox();
            crate::geometry::clip_rect_to_polygon(&p, bx0, by0, bx1, by1).len() >= 3
        });
        self.zones[i].shape = self.conform_to_plate(shape, was_on_plate)?;
        self.reassign_components();
        Ok(())
    }

    /// Create a new zone from a shape (the direct-manipulation "add a room" /
    /// duplicate-room primitive). Returns the new id; rebuckets components so any
    /// furniture the shape now covers is recorded in its `component_ids`.
    ///
    /// Held to the SAME admissibility test as `resize_zone` — see
    /// `zone_shape_admissible`. Returning `Result` rather than a bare id is the
    /// point: an unguarded creator is a bypass around a guarded mutator.
    pub fn add_zone(
        &mut self,
        zone_type: ZoneType,
        shape: ZoneShape,
        label: String,
    ) -> Result<u32, ZoneError> {
        self.zone_shape_admissible(&shape)?;
        // Same conforming rule as `resize_zone`: a room drawn over an irregular
        // wall follows it from the moment it is created, rather than becoming a
        // box the next pass has to reconcile.
        //
        // `was_on_plate: false` — a zone being created has no previous position,
        // so there is no evidence this plate is its floor. A creation is never
        // refused on plate grounds; it is conformed when the plate cuts it and
        // left alone when the plate has nothing to say.
        let shape = self.conform_to_plate(shape, false)?;
        let id = self.alloc_id();
        self.zones.push(Zone {
            id,
            zone_type,
            shape,
            label,
            component_ids: Vec::new(),
            group: None,
            // THE UI/wasm entry point for creating a zone. Hard-wired to
            // `Drawn`: there is deliberately no parameter here, so no caller
            // outside the generator can mint a `Residual` zone.
            origin: crate::zone::ZoneOrigin::Drawn,
        });
        self.reassign_components();
        Ok(id)
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
            origin: Default::default(),
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
            reference: false,
            label: format!("Desk {id}"),
            product_id: None,
            price_inr: None,
            seats: 0, // test fixture: seat count is irrelevant to what these assert
            decision: DecisionState::Open,
        }
    }

    /// An L-shaped floor plate: a 20×20 square with the top-right 10×10 quadrant
    /// removed. This is the shape a real import produces — the notch is where
    /// `conform.rs` earns its keep, and where a rectangle lies about the floor.
    ///
    /// ```text
    ///   (0,20) ┌──────────┐ (10,20)
    ///          │          │
    ///          │      (10,10)──────┐ (20,10)
    ///          │                   │
    ///   (0,0)  └───────────────────┘ (20,0)
    /// ```
    fn l_plate(doc: &mut Document) {
        let pts = [
            (0.0, 0.0),
            (20.0, 0.0),
            (20.0, 10.0),
            (10.0, 10.0),
            (10.0, 20.0),
            (0.0, 20.0),
        ];
        for (i, w) in pts.iter().enumerate() {
            let n = pts[(i + 1) % pts.len()];
            doc.walls.push(wall(100 + i as u32, w.0, w.1, n.0, n.1));
        }
    }

    /// **A room must not gain floor that is outside the building when dragged.**
    ///
    /// Written before the fix and watched fail: a room resized over the L's notch
    /// stored the raw drag rect, so 25 m² of the missing quadrant became billable
    /// room. `generate` never had this bug — it clips to the plate
    /// (`layout/conform.rs:345`) — which is the point: **the generator and the
    /// editor disagreed about what "inside" means**, and only one of them was
    /// consulted when the user dragged something.
    #[test]
    fn resizing_a_room_over_the_notch_conforms_to_the_plate_instead_of_boxing_it() {
        let mut doc = Document::new();
        doc.next_id = 10;
        l_plate(&mut doc);
        doc.zones.push(rect_zone(1, ZoneType::Meeting, 5.0, 5.0, 6.0, 6.0));

        // Drag it up-right so its top-right corner reaches into the cut quadrant:
        // rect 5..15 × 5..15, of which the 10..15 × 10..15 corner is NOT floor.
        doc.resize_zone(1, ZoneShape::Rect { x: 10.0, y: 10.0, w: 10.0, h: 10.0 })
            .expect("a room overlapping real floor is a legal edit");

        let shape = &doc.zones[0].shape;
        assert!(
            matches!(shape, ZoneShape::Poly { .. }),
            "the plate cuts this rect, so the room must conform to it — got {shape:?}",
        );
        // 10×10 rect minus the 5×5 quadrant the building does not have.
        let area = doc.zones[0].area();
        assert!(
            (area - 75.0).abs() < 1e-6,
            "room must bill only real floor: expected 75 m² (100 − 25 outside), got {area:.3} m²",
        );
    }

    /// The stability property the conforming rule rests on: `plate ∩ bbox(S) = S`
    /// for any `S` that is itself `plate ∩ rect`. Without it, every drag would
    /// nibble a conformed room down and a no-op drag would not be a no-op.
    #[test]
    fn re_deriving_a_conformed_room_from_its_own_bbox_is_idempotent() {
        let mut doc = Document::new();
        doc.next_id = 10;
        l_plate(&mut doc);
        doc.zones.push(rect_zone(1, ZoneType::Meeting, 10.0, 10.0, 10.0, 10.0));
        doc.resize_zone(1, ZoneShape::Rect { x: 10.0, y: 10.0, w: 10.0, h: 10.0 }).unwrap();
        let first = doc.zones[0].shape.clone();
        let area_first = doc.zones[0].area();

        // Re-apply the drag the UI would send next: the shape's own bbox.
        for _ in 0..5 {
            let (bx0, by0, bx1, by1) = doc.zones[0].shape.bbox();
            doc.resize_zone(
                1,
                ZoneShape::Rect {
                    x: (bx0 + bx1) / 2.0,
                    y: (by0 + by1) / 2.0,
                    w: bx1 - bx0,
                    h: by1 - by0,
                },
            )
            .unwrap();
        }
        assert!(
            (doc.zones[0].area() - area_first).abs() < 1e-9,
            "five no-op drags eroded the room: {area_first:.6} m² → {:.6} m². \
             First shape {first:?}, now {:?}",
            doc.zones[0].area(),
            doc.zones[0].shape,
        );
    }

    /// A room dragged completely off the floor plate is refused, not stored with
    /// no floor under it.
    #[test]
    fn dragging_a_room_entirely_off_the_plate_is_refused() {
        let mut doc = Document::new();
        doc.next_id = 10;
        l_plate(&mut doc);
        doc.zones.push(rect_zone(1, ZoneType::Meeting, 5.0, 5.0, 4.0, 4.0));
        // Inside the wall BBOX (0..20 × 0..20) but inside the notch, which is
        // not floor — exactly the case a bbox-only guard waves through.
        let r = doc.resize_zone(1, ZoneShape::Rect { x: 15.0, y: 15.0, w: 4.0, h: 4.0 });
        assert_eq!(
            r,
            Err(ZoneError::OutOfBounds),
            "the notch is inside the wall bbox but is not floor; got {:?}",
            doc.zones[0].shape,
        );
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
        let id = doc
            .add_zone(
                ZoneType::Meeting,
                ZoneShape::Rect { x: 5.0, y: 5.0, w: 4.0, h: 4.0 },
                "Meeting Room".into(),
            )
            .expect("finite shape, no walls to be out of");
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
            height_m: None,
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
            height_m: None,
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
