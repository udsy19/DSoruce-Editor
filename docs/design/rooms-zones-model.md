# Rooms / Zones model (v1)

Design for first-class **Zones** in `crates/ds-core`. Zones are the missing
spatial primitive between *walls* (thin geometry) and *components* (furniture).
They are the foundation for two things at once:

1. **Laiout pastel rendering** — a floor plate tiled into soft-colored regions
   (circulation = blue, workspace = cream, meeting = lavender, …).
2. **The AI backbone** — the natural-language operator ("merge two rooms",
   "make this a phone booth") needs a first-class, addressable, mergeable object
   with a stable id, a type, and derived stats it can reason about *before*
   executing (capacity drops from X→Y, min corridor becomes Z).

Scope note: **design only.** No Rust is written into the crate here — the
snippets below are representative, so the implementer can land them without
merge conflicts against parallel work.

Grounding: the current core is `Document { walls, components, selection }` with
`Component { id, category:String, x,y,w,h (meters, center-origin), rotation,
label, product_id, decision }`. `layout::generate()` already computes the exact
sub-rectangles this design turns into zones (perimeter inset, meeting-room
column `col_x0..x1`, desk field `dz_x0..dz_x1 × dz_y0..dz_y1`). `circulation.rs`
and `Document::floor_area()` are the stat sources the Statistics panel reads.

---

## 1. The `Zone` struct

### Rect vs polygon — decision: **rect for v1**

Choose an **axis-aligned rectangle** footprint (center-origin, matching
`Component`), not a polygon. Justification:

- **Everything else in the core is already AABB.** Components are center+w+h,
  hit-testing (`select_at`), overlap (`footprint_overlaps`), and the whole
  `generate()` carve are rectangle math. A polygon zone would be the *only*
  non-rect primitive and force new geometry code (point-in-polygon, polygon
  union/clip) for merge/split — exactly the ops the AI needs to be cheap.
- **`generate()` emits rectangles by construction.** The corridor inset, the
  meeting column, and the desk field are all rects. Zone emission is free.
- **Merge/split stay trivial and lossless on a rect grid.** Union of two
  edge-adjacent rects, and splitting a rect by a cut line, are closed-form.
  General polygon union is not, and produces concave shapes the renderer and
  the AI both have to special-case.
- The **perimeter circulation zone is the one genuine non-rect** (a rectangular
  ring / picture-frame around the work zone). We model it as a **rectangular
  ring** via an optional inner hole rather than a general polygon — see §2.

Cost of the choice: an L-shaped merged room can't be one zone. That's
acceptable for v1 — represent it as a **zone group** (two rects sharing a
`group` label) and revisit polygons only if real floor plates demand it. The
`kind` field below is the escape hatch that keeps the door open without paying
for polygons now.

```rust
// zone.rs  (std + serde only; no wasm, no rand)
use serde::{Deserialize, Serialize};

/// Semantic purpose of a region of the floor plate. Drives the pastel fill,
/// the capacity model, and the Statistics donut bucket. String-tag serde repr
/// so the TS/AI side speaks the same vocabulary ("Meeting", not `2`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum ZoneType {
    Circulation,   // corridors / "walking place"      → soft blue
    Workspace,     // open desk field                   → pale cream/yellow
    Meeting,       // enclosed meeting room             → pale lavender
    Collaboration, // breakout / lounge / open collab   → pale green
    Core,          // WC, stairs, lifts, MEP, service   → light gray
    ClosedOffice,  // private cellular office           → pale peach/orange
    Amenity,       // kitchen / cafe / reception        → pale teal
}

/// Footprint shape. Rect is the v1 workhorse; RectRing models the perimeter
/// corridor (a rect with a rectangular hole) without a polygon library.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind")]
pub enum ZoneShape {
    /// Filled axis-aligned rectangle, center-origin (matches Component).
    Rect { x: f64, y: f64, w: f64, h: f64 },
    /// Rectangular ring: outer rect minus inner rect (the perimeter corridor).
    /// Both center-origin; inner is fully contained in outer.
    RectRing { x: f64, y: f64, w: f64, h: f64, in_w: f64, in_h: f64 },
}

/// A first-class region of the floor plate. `id` is stable across edits so the
/// AI and the frontend can address it ("merge 4 and 7"). Everything is meters.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Zone {
    pub id: u32,
    pub zone_type: ZoneType,
    pub shape: ZoneShape,
    /// Human/AI-facing name ("Open Workspace", "Meeting Room A").
    pub label: String,
    /// Ids of components whose center falls inside this zone (derived, cached on
    /// (re)assignment; see §3). Lets the AI answer "what's in this room".
    pub component_ids: Vec<u32>,
    /// Optional grouping tag for multi-rect (e.g. L-shaped) logical rooms.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group: Option<u32>,
}
```

### Derived area & capacity (methods, not stored fields)

Area and capacity are **computed**, never persisted, so they can't drift from
the shape. They live as `impl Zone`:

```rust
impl ZoneShape {
    /// Net internal floor area of the shape, m².
    pub fn area(&self) -> f64 {
        match *self {
            ZoneShape::Rect { w, h, .. } => w.max(0.0) * h.max(0.0),
            ZoneShape::RectRing { w, h, in_w, in_h, .. } =>
                (w * h - in_w * in_h).max(0.0),
        }
    }
    /// AABB (min_x, min_y, max_x, max_y) for hit-testing / tiling checks.
    pub fn bbox(&self) -> (f64, f64, f64, f64) { /* center±w/2, center±h/2 */ }
    /// True if world point (px,py) is inside the filled region (ring excludes hole).
    pub fn contains(&self, px: f64, py: f64) -> bool { /* … */ }
}

impl Zone {
    pub fn area(&self) -> f64 { self.shape.area() }

    /// Nominal seated capacity by area rule-of-thumb, per ZoneType. Circulation
    /// and Core seat nobody. Workspace uses the ~6 m²/workstation planning rule
    /// already cited in layout.rs; meeting/collab use per-seat densities.
    pub fn capacity(&self) -> u32 {
        let a = self.area();
        let per = match self.zone_type {
            ZoneType::Workspace    => 6.0, // m² per workstation
            ZoneType::Meeting      => 2.5, // m² per seat
            ZoneType::Collaboration=> 3.0,
            ZoneType::ClosedOffice => 9.0, // 1–2 person cellular
            ZoneType::Amenity      => 4.0,
            ZoneType::Circulation | ZoneType::Core => return 0,
        };
        (a / per).floor().max(0.0) as u32
    }
}
```

`capacity()` is a **planning estimate** (area-based). The *actual* seated count
for a Workspace zone is `component_ids` filtered to desks — the AI reports both:
"this zone fits ~12 by area, currently holds 9 desks."

### Where zones live

Add to `Document`:

```rust
pub struct Document {
    pub walls: Vec<Wall>,
    pub components: Vec<Component>,
    pub zones: Vec<Zone>,      // NEW — tiled floor regions
    pub selection: Option<u32>,
    next_id: u32,              // shared id space: zones + walls + components
}
```

Zones share the existing `alloc_id()` monotonic counter, so a zone id can never
collide with a component id — the AI addresses any entity by one integer.

---

## 2. How `generate()` emits zones

`layout::generate()` already carves the exact rectangles. It currently throws
them away after placing furniture; the change is to **also record them as
zones** so the floor plate is tiled. Clear `doc.zones` at the top exactly like
`doc.components`, then push zones from the same variables.

The partition (a **tiling** — every m² of the wall bbox belongs to exactly one
zone, no gaps, no overlaps, within what a rect model allows):

| Region | Source rect in `generate()` | ZoneType |
|---|---|---|
| Perimeter corridor | wall bbox **minus** work-zone inset `(x0,y0)…(x1,y1)` | `Circulation` (RectRing) |
| Meeting column | `col_x0..x1 × y0..y1` (only if `claimed`) | one `Meeting` **per room**, stacked at `mr_pitch` |
| Aisle strip | `clear`-wide gap between desk field and meeting column | folded into Circulation (see note) | 
| Desk field | `dz_x0..dz_x1 × dz_y0..dz_y1` | `Workspace` |
| Leftover / undersized remainder | any strip too small for desks | `Core` |

Concretely:

```rust
// after the inset is computed (x0,y0,x1,y1) and BEFORE placing furniture:
let outer_w = max_x - min_x;
let outer_h = max_y - min_y;
push_zone(doc, ZoneType::Circulation, ZoneShape::RectRing {
    x: (min_x+max_x)/2.0, y: (min_y+max_y)/2.0,
    w: outer_w, h: outer_h,
    in_w: x1 - x0, in_h: y1 - y0,      // the hole = the work zone
}, "Circulation");

// per meeting room, at the moment it's pushed as a component:
push_zone(doc, ZoneType::Meeting,
    ZoneShape::Rect { x: cx, y: cy, w: mw, h: mh },
    &format!("Meeting Room {}", rooms_placed));

// after the desk field bounds (dz_x0,dz_y0)..(dz_x1,dz_y1) are final:
push_zone(doc, ZoneType::Workspace,
    ZoneShape::Rect {
        x: (dz_x0+dz_x1)/2.0, y: (dz_y0+dz_y1)/2.0,
        w: dz_x1-dz_x0, h: dz_y1-dz_y0,
    }, "Open Workspace");
```

**Tiling guarantees & the honest caveats:**

- The Circulation ring's hole is *exactly* the union of the Workspace rect and
  the Meeting column, so ring + work zone tile the whole bbox with **zero gap**.
- The Meeting column and Workspace rect are separated by a `clear`-wide aisle.
  Two clean options; pick **(a)** for v1:
  - **(a)** Extend the Workspace rect's right edge to `col_x0` (absorb the aisle
    into Workspace) — simplest, keeps a strict 3-zone tile
    (ring · workspace · meeting-stack). The aisle is still *walkable* because no
    desk is placed there; it just reads as cream not blue. Acceptable for v1.
  - **(b)** Emit the aisle as a thin `Circulation` Rect between them — truer
    coloring, one extra zone. Defer to v2.
- **Meeting rooms stacked in the column**: the column height may exceed
  `rooms × mh`; the leftover bottom strip becomes a `Core` zone (or is absorbed
  into the last meeting room). Emit `Core` only if the strip ≥ a small
  threshold (e.g. 1 m²) to avoid slivers.
- **`keep_confirmed`**: zones are regenerated wholesale each call (like
  components). Frozen confirmed components keep their ids and simply get
  re-bucketed into whatever zone now contains their center (§3). Zones
  themselves are *not* frozen in v1 — the layout defines them.

A helper mirrors `push_component`:

```rust
fn push_zone(doc: &mut Document, t: ZoneType, shape: ZoneShape, label: &str) {
    let id = doc.alloc_id();
    doc.zones.push(Zone { id, zone_type: t, shape,
        label: label.to_string(), component_ids: Vec::new(), group: None });
}
```

After all zones+components exist, call `reassign_components(doc)` once to fill
each zone's `component_ids` (point-in-zone by component center).

---

## 3. Operations the AI needs

These are the **core-level** mutators the AI tool-use layer calls (propose →
preview → approve). Each is a pure `Document` method (unit-testable) and gets a
thin wasm wrapper (§4). All return a `Result<(), ZoneError>` so the AI can
report *why* something can't happen ("those two rooms aren't adjacent").

```rust
impl Document {
    /// Union two zones into one. v1 requires the two rects be edge-adjacent and
    /// aligned so the union is itself a rect; otherwise Err(NotMergeable) and the
    /// AI falls back to a `group` (shared group id, two zones kept).
    pub fn merge_zones(&mut self, a: u32, b: u32) -> Result<u32, ZoneError>;

    /// Split a zone by an axis-aligned cut. `axis` = Vertical|Horizontal,
    /// `at` = world coordinate of the cut line. Returns the two new zone ids.
    pub fn split_zone(&mut self, id: u32, axis: Axis, at: f64)
        -> Result<(u32, u32), ZoneError>;

    /// Reclassify a zone (recolors, re-buckets stats, recomputes capacity).
    pub fn set_zone_type(&mut self, id: u32, t: ZoneType) -> Result<(), ZoneError>;

    /// Resize/move a zone's rect (AI "make this room 1m wider"). Rejected if it
    /// would push the zone outside the wall bbox.
    pub fn resize_zone(&mut self, id: u32, shape: ZoneShape) -> Result<(), ZoneError>;

    /// Rebucket every component into the zone that contains its center. Called
    /// after any zone geometry change and after generate().
    fn reassign_components(&mut self);
}

pub enum ZoneError { NotFound, NotMergeable, OutOfBounds, InvalidCut }
```

### Merge semantics

- **Geometry**: if `a` and `b` are edge-adjacent, axis-aligned rects whose union
  is a rectangle → produce one `Rect` covering both; delete `a` and `b`, mint a
  new id (or reuse `a`'s id — reuse `a`'s to keep references stable for the AI's
  "merge B into A"). If not a clean rect union → set both zones' `group` to a
  shared new id and return that (a logical L-room without polygons).
- **Resulting `zone_type`**: rule = **the larger-area zone's type wins**; ties
  → `a`'s type. The AI overrides explicitly when the user says "…into a meeting
  room" by chaining `set_zone_type`.
- **Label**: `"{a.label} + {b.label}"` unless the AI supplies one.
- **Contained components**: **untouched** (desks stay put); their
  `component_ids` are simply concatenated into the merged zone. Merging is a
  *reclassification of space*, not a delete of furniture. The AI then decides,
  in a follow-up tool call, whether to remove now-redundant desks/walls to hit a
  target headcount — it is *not* automatic, so the preview is truthful.

### Split semantics

- Cut a `Rect` at world line `at` on `axis` → two `Rect`s tiling the original
  (no gap). Reject if `at` isn't strictly inside the zone (`InvalidCut`).
- Both halves inherit the parent `zone_type` and a suffixed label
  (`"… (1)"`, `"… (2)"`). The AI then `set_zone_type`s one half if the intent
  was "split off a phone booth".
- **Contained components** are partitioned by center into the half that contains
  them (`reassign_components`). None are deleted or moved.

### set_zone_type / resize

- `set_zone_type` only rewrites the tag → recolor + recompute `capacity()` +
  donut rebucket. Cheap, always safe.
- `resize_zone` validates against the wall bbox; on success calls
  `reassign_components`. Overlap with sibling zones is *allowed* to be reported
  as a warning by the AI layer (it can compute overlap area) but is not hard-
  blocked in v1, because during an interactive drag transient overlap is normal.

**Why the AI likes this shape:** every op is (1) addressable by integer id,
(2) returns a `Result` with a typed reason, (3) leaves furniture decisions
explicit. So the AI can *dry-run* — clone the `Document`, apply the op, diff
`ZoneStats` before/after, and present "capacity 24→18, min corridor 1.2→0.9 m,
area/person 6.1→8.0 m²" **without committing**. Commit is the same call on the
real doc, and undo is a document snapshot.

---

## 4. Serialized shape + new wasm methods

### What the frontend receives

`state()` already serializes the whole `Document`; adding `pub zones: Vec<Zone>`
means zones flow to TS for free. The JSON per zone:

```jsonc
{
  "id": 12,
  "zone_type": "Workspace",                 // string tag → pastel lookup + donut bucket
  "shape": { "kind": "Rect", "x": 8.0, "y": 6.0, "w": 12.0, "h": 9.0 },
  "label": "Open Workspace",
  "component_ids": [3, 4, 5, 6]
  // area & capacity are NOT serialized here (derived) — see zone_stats()
}
```

The perimeter corridor serializes as
`"shape": { "kind": "RectRing", "x", "y", "w", "h", "in_w", "in_h" }` so the
renderer draws it as an even-odd filled ring (outer path + reversed inner path).

Frontend adds to `EditorCanvas.ts`:

```ts
export type ZoneType =
  | 'Circulation' | 'Workspace' | 'Meeting'
  | 'Collaboration' | 'Core' | 'ClosedOffice' | 'Amenity'
export type ZoneShape =
  | { kind: 'Rect'; x: number; y: number; w: number; h: number }
  | { kind: 'RectRing'; x: number; y: number; w: number; h: number; in_w: number; in_h: number }
export interface DocZone {
  id: number; zone_type: ZoneType; shape: ZoneShape
  label: string; component_ids: number[]
}
```

Pastel fills (single source of truth on the TS side, Laiout palette):

| ZoneType | Fill |
|---|---|
| Circulation | soft blue `#DCE8F5` |
| Workspace | pale cream `#F6EED6` |
| Meeting | pale lavender `#E7E0F3` |
| Collaboration | pale green `#DDEEDD` |
| Core | light gray `#E7E9EC` |
| ClosedOffice | pale peach `#F6E4D6` |
| Amenity | pale teal `#D9EDEA` |

Render order: **zone fills first (behind everything), then walls, then furniture
line-icons, then labels** — this is exactly the Laiout stack.

### New `Editor` wasm methods (`lib.rs`)

```rust
/// All zones for rendering. Part of state(), but exposed standalone for cheap
/// re-reads after a zone-only edit.
pub fn zones(&self) -> Result<JsValue, JsValue>;

/// Per-zone stats for the Statistics panel + AI reasoning (see §5). Array of
/// { id, zone_type, label, area, capacity, seated, pct_of_nia }.
pub fn zone_stats(&self) -> Result<JsValue, JsValue>;

/// AI ops — thin wrappers over Document methods; each returns the new id(s) or
/// throws with the ZoneError reason so the JS/AI layer can surface it.
pub fn merge_zones(&mut self, a: u32, b: u32) -> Result<u32, JsValue>;
pub fn split_zone(&mut self, id: u32, axis: &str, at: f64) -> Result<JsValue, JsValue>; // "Vertical"|"Horizontal"
pub fn set_zone_type(&mut self, id: u32, zone_type: &str) -> Result<(), JsValue>;
pub fn resize_zone(&mut self, id: u32, x: f64, y: f64, w: f64, h: f64) -> Result<(), JsValue>;

/// Zone hit-test (center of which zone contains the point) — for click-to-select
/// a room on the canvas. Ring-aware. Returns the zone id or undefined.
pub fn zone_at(&mut self, x: f64, y: f64) -> Option<u32>;
```

Naming: `set_zone_type` is new; it does **not** collide with the existing
component-level `set_decision`. Keep the exported TS `Doc*` interfaces additive
(add `zones` to `DocState`) so `three/Scene3D` keeps compiling — 3D can extrude
zone fills to colored floor plates later.

---

## 5. Feeding the Statistics panel

The Laiout Statistics panel wants: **Gross External Area, Net Internal Area,
Workstations, Area/Workstation, Efficiency %**, and the **Areas | Zones** donut.
Zones supply all of it; `zone_stats()` is the single feed.

```rust
#[derive(Serialize)]
struct ZoneStat {
    id: u32,
    zone_type: ZoneType,
    label: String,
    area: f64,          // zone.area()
    capacity: u32,      // zone.capacity() — area-based estimate
    seated: u32,        // desks whose id ∈ component_ids (Workspace) 
    pct_of_nia: f64,    // area / NIA * 100
}
```

Panel-level derived metrics (computed in a small `stats.rs` or inline in
`lib.rs::metrics()`, reusing existing sources — **no new geometry**):

- **Gross External Area (GEA)** = `Document::floor_area()` (wall bbox) — exists.
- **Net Internal Area (NIA)** = Σ `zone.area()` over all zones (≈ GEA minus wall
  thickness losses; for v1 the rect tiling makes NIA ≈ GEA, which is fine — the
  ratio surfaces as Efficiency).
- **Workstations** = count of `Desk` components (already available), or Σ
  `seated` over Workspace zones.
- **Area / Workstation** = NIA / Workstations.
- **Efficiency %** = `(Workspace + Meeting + Collaboration area) / NIA * 100`
  — i.e. *usable/programmed* area over total, the inverse of circulation+core
  overhead. Circulation % (blue) is its complement and comes straight from the
  Circulation zone's `pct_of_nia`. This is *cheaper and more explainable* than
  the grid circulation ratio for the headline; keep `circulation()`'s grid score
  for the **quality** number (min corridor width etc.), which zones can't give.

### Areas / Zones donut

The donut is a **direct group-by**: bucket `zone_stats()` by `zone_type`, sum
`area` per bucket, and each slice's % is `bucket_area / NIA`. The slice color is
the same pastel table from §4 (donut and floor plate agree by construction).
Legend row = colored square + ZoneType label + `%` + `m²`, tabular figures.

```
donut = groupBy(zoneStats, z => z.zone_type)
          .map(g => ({ type: g.key,
                       area: sum(g, 'area'),
                       pct:  sum(g, 'area') / NIA * 100,
                       color: PASTEL[g.key] }))
```

Because zones *tile* the plate (§2), the donut slices **sum to 100%** with no
"unaccounted" wedge — the property that makes the Laiout panel feel trustworthy,
and the exact invariant the AI leans on when it says "merging these two shifts
4% of NIA from Meeting to Workspace."

---

## Summary for the orchestrator

**New struct (zone.rs, std+serde only):**

- `Zone { id:u32, zone_type:ZoneType, shape:ZoneShape, label:String, component_ids:Vec<u32>, group:Option<u32> }`
- `ZoneType` enum (serde string tag): `Circulation | Workspace | Meeting | Collaboration | Core | ClosedOffice | Amenity`
- `ZoneShape` enum (serde `tag="kind"`): `Rect{x,y,w,h}` | `RectRing{x,y,w,h,in_w,in_h}` — **rect-based v1** (justified: whole core is AABB, merge/split closed-form, perimeter corridor = ring not polygon)
- Derived (methods, not fields): `Zone::area()`, `Zone::capacity()`, `ZoneShape::{area,bbox,contains}`
- `Document` gains `pub zones: Vec<Zone>` (shared `alloc_id` space) + `merge_zones/split_zone/set_zone_type/resize_zone/reassign_components` + `ZoneError`.

**generate() change:** also emit a tiling — perimeter `Circulation` RectRing (hole = work zone), one `Meeting` Rect per room (stacked in the right column), one `Workspace` Rect (desk field, absorbs the aisle in v1), leftover → `Core`. Zones tile the bbox with no gaps/overlaps.

**AI ops:** `merge_zones(a,b)` (edge-adjacent rect union; larger type wins; components untouched, ids concatenated; non-adjacent → shared `group`), `split_zone(id,axis,at)` (rect cut, components partitioned by center), `set_zone_type`, `resize_zone`. All return typed `Result` so the AI can dry-run on a cloned doc and preview capacity/corridor deltas before commit.

**New Editor wasm methods:** `zones()`, `zone_stats()`, `merge_zones(a,b)`, `split_zone(id,axis,at)`, `set_zone_type(id,type)`, `resize_zone(id,x,y,w,h)`, `zone_at(x,y)`. `zones` also added to `state()` / `DocState`.

**Statistics feed:** `zone_stats()` → per-zone `{area, capacity, seated, pct_of_nia}`. GEA=`floor_area()`, NIA=Σ zone areas, Efficiency%=(programmed zones/NIA), donut = group-by `zone_type` summing area (slices sum to 100% because zones tile). Pastel palette is one shared table used by both floor fills and donut.

**Deferred to v2:** polygon/L-shaped zones (use `group` for now), aisle as its own thin Circulation zone, freezing zones under `keep_confirmed`, 3D extrusion of zone fills.
