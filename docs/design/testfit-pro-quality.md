# Professional Test-Fit Quality — Anatomy Spec + Generator Rework Plan

Status: approved design target for the `layout.rs` rework.

> **Note (three-branch merge).** Every `editor/furniture.ts` reference below is
> HISTORICAL. That module was replaced by **`web/src/editor/symbols.ts`** under
> ruling R2, which owns symbol geometry and specifies it in WORLD units rather
> than screen pixels. The file:line citations were accurate when written and are
> kept so; do not follow them into the current tree.

Trigger (user, verbatim): *"when creating a test fit plans, why does it not look like a cad
design... it still feels really broken and its creating something basic. What our testfit
generates should be the quality of a professional architect who's worked for years."*

Reference bar: **qbiq.ai** ("Architectural outputs. In hours, not weeks." — AI plans validated
by in-house architects, delivered as editable RVT/DWG with real wall/door geometry, scored on
efficiency/privacy/daylight; <https://www.qbiq.ai/>), **laiout.co** (regulation-aware plans in
seconds, 100+ furniture blocks auto-populating rooms, per-zone area/cost/CO₂ tags, freeze +
regenerate; <https://laiout.co/>, <https://aecmag.com/news/laiout-enhances-automated-floor-planning-software/>),
and **Rayon** (the manual-editing bar: walls with thickness, an Opening tool for doors/windows
with swings, dimensions, styled line weights; <https://docs.rayon.design/documentation/rayons-basics/drawing>).

The one-sentence diagnosis: **our generator emits furniture and colored rectangles; a
professional test-fit is a small building** — enclosed rooms with partitions, doors and glass
fronts, a legible corridor network anchored to the entry, a complete space program (not just
desks + meeting rooms), and disciplined alignment. Neither qbiq nor Laiout publishes corridor
widths or named codes ("clearances," generic "regulation") — grounding ours in NBC 2016 (India-first)
is a citable differentiator, not just parity.

**Code anchors:** `layout::generate` + `layout::score` (`crates/ds-core/src/layout.rs`) with
`Program`, `SpaceProgram`, `SpaceKind`, `SpaceReq`, `RoomReq`, `Placement`, `Strategy`,
`LayoutScore` · `circulation::evaluate` (`crates/ds-core/src/circulation.rs`) · zones
`crates/ds-core/src/zone.rs` · costing `crates/ds-core/src/cost.rs` · wasm entry
`Editor::generate` / `Editor::layout_score` (`crates/ds-core/src/lib.rs`) · strategy wiring
`web/src/editor/strategy.ts`.

---

## 1. Space program mix — what rooms a professional test-fit contains

A test-fit is judged first on **program completeness**: for N headcount it must show every
space type a workplace consultant would program, at defensible ratios. Overall density target:
**8–12 m²/person NIA** (BCO 2023 sets 10 m²/person as the design occupancy for general
workspace — <https://workinmind.org/2023/02/16/bcos-guide-to-specification-for-healthier-offices-updated-to-include-increased-levels-of-outdoor-air-supply/>;
NBC 2016 uses 10 m²/person as the business occupant-load factor —
<https://infralens.in/knowledge/nbc-2016-part-4-fire-safety>). Zone split sanity check:
~60% workstations / 20% meeting / 15% social / 5% quiet
(<https://anny.co/en/blog/office-layout-guide-complete-guide-for-optimal-office-planning-2026>).

### 1.1 The program table (input: headcount N; all counts `ceil` unless noted)

| Space type | Count formula | Unit size m² (dims) | Placement rule |
|---|---|---|---|
| Open workstation (bench) | `N × open_share` (default 0.85) | 1.4×0.7 desk; 3.7–4.6 m²/desk incl. share of aisle | Wings along the facade (daylight to desks); rows aligned to the wing's long axis; back-to-back bench pairs |
| Cabin / private office (India convention: MD/HR/finance cabins) | `N / 25` | 9–12 (3.0×3.3) | Perimeter corner or facade end of a wing; glass front optional |
| Meeting 4P (huddle) | `N / 24` | 7.5–10 (2.7×3.3) | In the meeting band along the primary spine, glass front to corridor |
| Meeting 6–8P | `N / 40` | 12–16 (3.6×4.2) | Same band, nearer reception (visitor zone) |
| Boardroom 12P | 1 if `N ≥ 60` | 24–32 (4.5×6.5) | Adjacent to reception; solid rear wall for AV |
| Phone booth 1P | `N / 12` (rule: 1 per 10–15 FTE — <https://www.gable.to/blog/post/office-phone-booth>) | 1.2–1.7 (1.1×1.3) | **Distributed**, one cluster per wing, against core/columns, never on the facade |
| Focus room 1–2P | `N / 30` | 3.5–6 (1.8×2.4) | Quiet edges, ≥6 m from pantry/collab (<https://sketchure.com/office-zones-office-space-zoning-layout-guide/>) |
| Collaboration / breakout (open) | 1 seat per 8 desks; 1 setting per wing | 15–30 per setting | Between desk neighborhoods; buffers meeting band from desks |
| Reception + wait | 1 if `N ≥ 20` | 12–20 (min ~7.4 — <https://www.dimensions.com/collection/lobby-layouts-reception-areas>) | **At the entry door**, facing it; boardroom/visitor meeting adjacent |
| Pantry / café | 1; area `max(9, 0.35·N)` (1.2–1.8 m²/seated person — <https://architecture-student.com/design-guide/cafeteria-design-guide-architectural-design/>) | 9–40 | Away from focus/meeting (≥6 m); near core/wet riser; social anchor at the far end of the spine from entry |
| Print / copy point | `N / 50` | 2–4 | On the spine, central to each wing (open alcove, no door) |
| IT / server + UPS | 1 | 6–12 (<https://phoenixnap.com/blog/server-room-design>) | Against the core; no window; solid walls + door |
| Storage | 1 per floor | 5–10 | Deep-plan pockets the desk grid can't use |
| Wellness / mother's room | 1 if `N ≥ 50` | 6–9 | Quiet edge near WC core |

Meeting-seat cross-check: ~1 meeting spot per 8 workstations; size mix ≈ 50% small / 30%
medium / 20% large (<https://anny.co/en/blog/office-layout-guide-complete-guide-for-optimal-office-planning-2026>).
Enclosed focus+booth area should be ≥~15% of usable floor for knowledge work
(<https://www.tandfonline.com/doi/full/10.1080/09613218.2023.2180343>).

Sanity: N=50 → 42 desks (155 m²) + 2 cabins + 2×4P + 1×6P + 1×8P meeting + 4 booths +
2 focus + collab + pantry 18 + reception 12 + print + IT 8 + storage 6 ≈ 315 m² net +
25–30% circulation ≈ **420 m² ≈ 8.4 m²/person** — inside the BCO/NBC band.

The `Program` struct keeps `desks`/`meeting_rooms` as overrides, but gains
`headcount: Option<u32>`; when set, a pure `SpaceProgram::derive(n)` expands it to the table
above (deterministic — no RNG), and the UI shows the derived mix for editing.

## 2. Architecture emission — rooms are ENCLOSED

This is the single biggest "looks like CAD" lever. Both reference products draw rooms as real
architecture: qbiq ships "fully structured, editable" Revit/CAD models
(<https://www.qbiq.ai/capabilities/customized-planning-engine>); Laiout auto-populates rooms
from 100+ furniture blocks inside drawn walls (<https://aecmag.com/news/laiout-enhances-automated-floor-planning-software/>).
Today a "MeetingRoom" is one furniture component whose symbol is a table drawn at 50% of the
footprint (`web/src/editor/furniture.ts:228-239`) sitting on a pastel zone. It must become:

**Partition walls.** Drywall partitions at **0.1 m** thickness (50 mm stud + boards ≈ 75–100 mm;
100 mm is the standard double-boarded fit-out partition —
<https://www.rodleyinteriors.co.uk/office-partitioning/75mm-100mm/>). Emitted as `Wall` segments
(`model.rs:31-38` already carries `thickness`). Rules:
- Shared wall between adjacent rooms is emitted **once** (rooms in a band share cross-walls).
- A room against the plate boundary reuses the existing boundary wall — never double it.
- Generated walls must be distinguishable from user/imported walls so `generate()` can clear and
  re-emit them each run: add `#[serde(default)] pub generated: bool` to `Wall`. Plate tracing
  (`layout.rs:372`, `geometry::trace_floor_polygon`) and `wall_bbox` must **filter to
  `!generated`** walls, or regeneration would re-trace its own partitions.

**Glass fronts.** The corridor-facing wall of every meeting/focus/cabin room is glazed — the
universal test-fit convention (borrowed daylight + visual supervision along the spine; frameless
glass is 10–12 mm, framed ~50 mm — <https://crystaliaglass.com/choosing-the-right-glass-partition-thickness-a-guide-for-perfect-balance/>).
Representation: add `#[serde(default)] pub glazing: bool` to `Wall`; render glazed walls at
0.05 m with the triple-line window convention (the glyph already exists in
`furniture.ts:276-304` `drawWindow`); 3D gives them a transparent material. Booths, IT, and
storage keep solid fronts. (Alternative — overlaying a `Window` component on a solid wall — was
rejected: two objects for one fact, and exports/3D would need to reconcile them.)

**A door per room.** Leaf **0.9 m** (standard office single leaf 900×2100 —
<https://www.zonledoors.com/standard-door-sizes-chart-full-guide-for-residential-commercial-projects.html>);
use **1.0 m** for rooms whose occupant load makes them exits per NBC 2016 (exit doorways min
1000 mm — <https://infralens.in/knowledge/nbc-2016-travel-distance-exit-width>) — pantry,
boardroom. Swing **into the room**, hinge on the jamb nearest the adjacent wall corner so the
leaf opens flat against it (rooms under 50 occupants swing inward by convention; ≥50 must swing
with egress — IBC §1010.1.2.1, <https://codes.iccsafe.org/s/IBC2021P1/chapter-10-means-of-egress/IBC2021P1-Ch10-Sec1010.1.2.1>).
Emission mechanics with our model:
- The wall run containing a door is emitted as **two collinear `Wall` segments leaving a 0.9 m
  gap** (hinge-side jamb ≥0.15 m from the perpendicular wall).
- A `Component { category: "Door", w: 0.9, h: 0.15, rotation: wall angle }` is placed in the
  gap. The renderer already draws jambs + leaf + quarter swing arc (`furniture.ts:244-272`);
  the CAD layer independently has `DoorEnt` (`web/src/cad/model.ts:83-94`) for hand-drafting —
  the generator emits doc components, not CAD entities, so they reach metrics/3D/export.
- **Circulation evaluator change:** components rasterize as blocked cells
  (`circulation.rs` module doc: "cells covered by a wall … or a component footprint are
  blocked"). Doors must be **whitelisted as passable** or every room reads as sealed and
  connectivity collapses. Door position then genuinely feeds the score: the evaluator's
  connected-region metric starts doing real work.

**What the generator must emit per enclosed room** (one `emit_room` helper): the partition
segments (minus shared/boundary edges, minus the door gap), the door component, the glazing
flags, a typed `Zone` (Meeting/ClosedOffice/Amenity/Core — the variants already exist at
`zone.rs:20-28` but the generator only ever emits Circulation/Workspace/Meeting/Core), and the
room's furniture (table + chairs sized to capacity, not a half-scale glyph).

## 3. Circulation as drawn geometry — a network, not leftovers

Today circulation is the **complement** of placement: a perimeter `RectRing` per region
(`layout.rs:661-675`) plus half-inset seams (`layout.rs:275-300`). Two professional failures:
(a) the ring hugs the **facade**, spending prime daylight on corridor — real plans put desks at
the windows and run the corridor inboard along the room band; (b) nothing anchors circulation
to an **entry**, so the plan has no narrative ("enter → reception → spine → neighborhoods").

Spec:
- **Primary spine, 1.5–1.8 m** (planning guidance 1.5–2.4 m —
  <https://www.rayon.design/knowledge-base/open-space-office/rules>; NBC 2016 corridor minimum
  **1.5 m** — <https://infralens.in/knowledge/nbc-2016-travel-distance-exit-width>): one
  straight run per wing along the meeting-band face, connected across wings, from the entry to
  the pantry/core. Every enclosed room's door opens onto it (or onto a secondary).
- **Secondary aisles, 1.1–1.2 m** (IBC corridor 1118 mm —
  <https://codes.iccsafe.org/s/IBC2018/chapter-10-means-of-egress/IBC2018-Ch10-Sec1020.2>):
  cross-aisles between desk neighborhoods, joining the spine at right angles.
- **Bench access, 0.9 m** (ADA/accessible route 915 mm —
  <https://www.access-board.gov/ada/guides/chapter-4-accessible-routes/>): between bench pairs;
  this is today's `desk_clearance_m` and stays implicit (gap, not zone).
- **Entry anchor:** new `Document.entries: Vec<Point>` (serde-default empty). DWG import can
  set it from a door block; UI gets a "place entry" affordance; heuristic fallback = midpoint
  of the plate edge nearest the largest keepout (the core). Deterministic.
- **Emission:** the spine + secondaries are emitted as explicit `Circulation` **`Rect` zones**
  (the network is a rect list; `RectRing` retires from the generator, staying in `zone.rs` for
  compatibility). The generator guarantees connectivity by construction (each secondary
  originates on the spine; the spine touches the entry edge); `circulation.rs` remains the
  independent auditor. NBC travel-distance check (30 m unsprinklered / 45 m sprinklered —
  same infralens source) becomes a scored metric, not a construction rule, in M5.
- Desk fields keep a 0.9 m gap to the facade wall (maintenance/blinds), not a full corridor.

## 4. Orientation & alignment discipline — why plans "read" professional

At a glance, a senior architect's plan shows **few, long, straight alignment lines**. Concrete
rules, each violated by the current generator:

1. **No continuous jitter.** Every generated coordinate snaps to a **0.05 m module**; desks sit
   on exact pitches. Today one global jitter of up to `0.25·clearance` ≈ 0.22 m shifts the whole
   lattice off any structural line (`layout.rs:408-419`) — this is *why* output feels "broken":
   nothing lands on a round number, dimensions read 3.1841 m. Seed variety must come from
   **discrete structural choices** (which side the meeting band sits, spine position, room order
   permutation, which wing gets the pantry) — the existing seed-rotated round-robin
   (`layout.rs:538`) and odd-seed half-phase (`layout.rs:413`) show the pattern; jitter does not.
2. **One desk orientation per wing**, rows parallel to the facade. The lattice transpose exists
   (`column_major`, `layout.rs:439,847-856`) but desks only ever rotate 0 or π
   (`layout.rs:888-899`) — in a portrait wing, bench "pairs" are placed side-by-side along X yet
   flipped in Y, so the symbols read scrambled. Portrait wings need **±π/2 desk rotation** with
   w/h swapped in the collision footprint.
3. **Common room depths.** All rooms in a band share one depth so the corridor-facing wall is a
   single unbroken line; room widths vary, depths don't. (Today every meeting room is one global
   size, `layout.rs:692-693`, and bands only align by accident of the pitch.)
4. **Structural grid.** Lattice origin anchors to the plate corner (already true —
   `layout.rs:402-419`) and, once DWG import supplies columns, to the column grid; desk runs
   break at columns rather than straddling them.
5. **Consistent door placement** (hinge to the near corner, every room) and **consistent
   furniture centering** inside rooms. Uniformity is the tell of professionalism; the current
   half-pitch phase-2 desk infill (`layout.rs:930-985`) that half-offsets stragglers into gaps
   should be dropped once rooms stop stealing lattice slots.

## 5. Graphic quality — mostly already built

The rendering layer needs little; docs/design/laiout-visual-system.md §3.8 already specifies it.
- **Wall poche**: walls stroke at true thickness (`EditorCanvas.ts:767-779`); with 0.1 m
  partitions this reads correctly. Add the §3.8 interior/exterior weight split (`--wall` vs
  `--wall-ext`), and render `glazing` walls with the triple-line glyph.
- **Door swings**: symbol done (`furniture.ts:244-272`).
- **Room labels with area tags**: zone labels render name-only (`EditorCanvas.ts:707-738`);
  extend to `LABEL\n62.5 m² · 8P` (area from `zone.area_on(plate)`, capacity from
  `zone.capacity()`, `zone.rs:143-153`) — the Laiout-style per-zone tag.
- **Furniture symbols**: desk/chair/table exist (`furniture.ts`); need small additions —
  phone-booth (chair + shelf), sofa/lounge for collab, pantry counter run, reception desk,
  storage shelving. All are ~20-line line-glyphs in the existing pattern.
- **New zone pastels**: Collaboration/ClosedOffice/Amenity fills already have tokens
  (laiout-visual-system.md §1) and `ZONE` entries in EditorCanvas — they're just never emitted.

## 6. Gap analysis — current generator vs the spec

| # | Spec item | Current state (evidence) |
|---|---|---|
| 1 | Full space program | `Program` has only `desks` + `meeting_rooms` (`layout.rs:36-67`); no booths, focus, pantry, reception, cabins, print, IT, storage. `ZoneType::{Collaboration, ClosedOffice, Amenity}` exist (`zone.rs:20-28`) but are never emitted. |
| 2 | Enclosed rooms | `MeetingRoom` is a furniture component (`layout.rs:707`) + pastel zone; zero partition walls, zero doors emitted anywhere in `generate()`. |
| 3 | Room size mix | One global meeting size for all rooms, clamped to fit (`layout.rs:692-693`). |
| 4 | Doors as document objects | `Wall` is an unbroken segment (`model.rs:31-38`); no opening concept in the core. Door exists only as a hand-drafted CAD entity (`cad/model.ts:83-94`) and a renderer glyph (`furniture.ts:244`). |
| 5 | Circulation network from entry | Perimeter `RectRing` + seam half-insets (`layout.rs:661-675, 275-300`) — corridor on the facade, no entry concept, no spine; connectivity is emergent, not designed. |
| 6 | Alignment discipline | Global lattice jitter ≤ ~0.22 m (`layout.rs:408-419`) puts every object off-module; portrait wings mis-rotate bench pairs (`layout.rs:888-899`, π-flip on the wrong axis); phase-2 half-pitch infill breaks row rhythm (`layout.rs:930-937`). |
| 7 | Professional density objective | `score()` rewards desk-area/floor of **30–55%** (`layout.rs:1046-1054`) ≈ 2.3–4.3 m²/desk gross — far denser than the BCO/NBC 8–12 m²/person band; the optimizer is literally steered toward unprofessional plans. |
| 8 | Program-completeness scoring | `adjacency` sub-score is desk nearest-neighbor pitch only (`layout.rs:1009-1033`); nothing scores room mix, entry adjacency, booth distribution, or daylight (qbiq scores density/daylight/privacy/program-fit — <https://www.qbiq.ai/capabilities/customized-planning-engine>). |
| 9 | Doors passable in evaluation | `circulation.rs` blocks all component footprints (module doc) — fine today, wrong the moment doors exist (§2). |
| 10 | Labels with metrics | Zone label renders name only (`EditorCanvas.ts:729`); no area/capacity tag. |

What already **meets** the spec and must be preserved: determinism per seed
(`generate_is_deterministic_for_same_seed`), keep_confirmed freeze
(`layout.rs:346-353, 1379`), keepouts as hard obstacles (`layout.rs:322-344`), irregular-plate
decomposition + shared-seam corridors (`layout.rs:390-400, 432-477`), bench pairing
(`layout.rs:879-899`), and the wasm `Editor.generate` surface (`lib.rs:328`).

## 7. Staged implementation plan

Every stage ships independently, keeps all 50 Rust tests green (extending them), preserves
determinism / keep_confirmed / keepouts / decomposition / bench_pairs, and keeps `Program`
JSON backward-compatible via serde field defaults. Ordered so visual impact lands early.

### M1 — Enclosed rooms: partitions + doors + glass fronts (~3 days) ← the "CAD look" jump
- **model.rs**: `Wall` gains `#[serde(default)] generated: bool` and `#[serde(default)] glazing: bool`.
- **layout.rs**: new `struct RoomSpec { zone_type, label, w, h, glass_front, door_w }` and
  `fn emit_room(doc, rect, spec, corridor_side) `→ walls (shared-edge + boundary dedupe, door
  gap), Door component, zone, interior furniture (full-size table + chairs as components).
  `generate()` clears `generated` walls up front; frozen (Confirmed) rooms get their walls
  re-emitted at the frozen rect. Meeting placement (`layout.rs:691-766`) routes through it.
- **layout.rs / geometry callers**: `wall_segments()` (`layout.rs:207-209`), `wall_bbox`,
  and the CirculationConfig rasterizer keep partitions but plate tracing filters `!generated`.
- **circulation.rs**: whitelist `category == "Door"` from the blocked-cell rasterization.
- **furniture.ts**: delete the half-scale `drawMeetingRoom` table hack once real interiors land.
- New Rust structures: `RoomSpec`; tests: doors present per room, rooms connected (circulation
  connectivity ≥ threshold with partitions in), determinism, keep_confirmed keeps room shells.

### M2 — Alignment discipline (~1.5 days, cheap + high visual impact)
- Kill lattice jitter (`layout.rs:408-419`); snap all emissions to 0.05 m; replace with discrete
  seed choices (band side L/R, meeting-order permutation, spine offset in 0.6 m steps) threaded
  through the existing seed round-robin (`layout.rs:538`).
- Portrait-wing desk rotation ±π/2 with swapped collision w/h (`layout.rs:847-899`).
- Drop the phase-2 half-pitch infill (`layout.rs:930-937`); recover capacity via the top-up
  pass that already exists (`layout.rs:455-477`).
- Update `different_seeds_produce_different_layouts` to assert structural (not positional) variety.

### M3 — Space program derivation + support rooms (~4 days)
- **layout.rs**: `enum SpaceKind` + `struct SpaceReq { kind, count, w, h }`;
  `SpaceProgram::derive(headcount)` per the §1.1 table; `Program` gains
  `#[serde(default)] headcount: Option<u32>` (absent → legacy desks/meetings behavior).
- `allocate_regions` (`layout.rs:501-599`) generalizes from `(meetings, desks)` to
  `Vec<SpaceReq>` with placement classes: **banded** (meetings/cabins/boardroom — via
  `emit_room`), **distributed** (booths/focus — one cluster per region, near core/keepouts),
  **anchored** (reception at entry, pantry at spine end, IT/storage against keepouts),
  **open** (collab settings between neighborhoods → `Collaboration` zones).
- **App.tsx / ProgramPanel**: headcount input; show derived mix. **furniture.ts**: booth,
  sofa, pantry-counter, reception glyphs.

### M4 — Circulation spine as drawn geometry (~4 days, deepest pack_region change)
- **model.rs / document.rs**: `entries: Vec<Point>` (serde default), `Editor.set_entry(x,y)`
  in lib.rs; DWG import + UI affordance; deterministic core-edge fallback.
- **layout.rs `pack_region`**: replace the perimeter-ring inset (`layout.rs:649-675`) with:
  meeting band on the spine side, spine rect (1.5 m) along the band face, secondary aisles
  (1.2 m) between desk neighborhoods, desks to the facade with a 0.9 m wall gap. Circulation
  emitted as connected `Rect` zones; `RectRing` no longer emitted (type stays for old snapshots).
- Cross-region: spine segments join at seams (reuses the half-inset adjacency math,
  `layout.rs:275-300`). Tests: every door center adjacent to a circulation rect; network
  connected; corridor-width assertions moved from ring to spine.

### M5 — Professional scoring (~2 days)
- Recenter `density` on **m²/person NIA 8–12** (replace the 30–55% desk-coverage band,
  `layout.rs:1046-1054`).
- New sub-scores: `program_fit` (delivered vs derived program), `daylight` (mean desk distance
  to facade), `entry_adjacency` (reception/boardroom near entry, pantry far), NBC travel
  distance ≤30 m via the existing distance-transform grid. Extend `LayoutScore` + weights
  (serde defaults keep old Program JSON valid) — this is qbiq's published scoring vocabulary
  (density/daylight/privacy/program-fit) grounded in real code.

### M6 — Graphic polish (~1.5 days)
- Zone labels gain area + capacity tags (`EditorCanvas.ts:707-738`, data from
  `zone.area_on`/`capacity`).
- Interior/exterior wall weight split; glazing triple-line rendering; 3D glass material in
  `three/`.
- Summary table export (program delivered vs requested, m²/person, efficiency %) in the
  Statistics panel — the test-fit deliverable convention
  (<https://watchdogpm.com/blueprint/what-is-the-difference-between-a-test-fit-and-a-space-plan/>).

Total ≈ 16 dev-days. Dependency notes: M2 is independent of M1; M3 depends on M1 (`emit_room`);
M4 depends on M3's placement classes only loosely (can land after M1 with meetings only);
M5/M6 land anytime after M1. After every Rust stage: `make wasm` (CLAUDE.md gotcha).
