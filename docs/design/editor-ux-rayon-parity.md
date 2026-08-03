# Editor UX — Rayon parity

**Status:** research + design. No product code changed by this doc.
**Author:** editor-UX research pass.
**One-line problem (verbatim from the user):** *"our editor does not feel as
intuitive and detailed as Rayon… most of it is handled through the cursor, and
look what the options are and how they do it."*

The heart of it: **Rayon is cursor-first and precision-fluid.** You draw and edit
directly on the canvas with live, typeable feedback and almost no modal
tool-switching. Our editor has a lot of the *machinery* (a real OSNAP engine, a
full CAD tool registry, grips, undo) but the *feel* is click-click-click with a
tiny status-bar readout and a tall tool rail — the precision lives in the code,
not under the cursor.

**Code anchors:** `EditorCanvas` (`web/src/editor/EditorCanvas.ts`) — transforms, cursor input,
grips, rendering · CAD layer `web/src/cad/` (OSNAP `snap.ts`, tool loop `controller.ts`, live typed
entry `dynamicInput.ts`, click-to-edit dimensions `dimEdit.ts`) · command palette + shortcuts
`web/src/editor/commands.ts` (`buildCommands`, `letterShortcuts`) · theme tokens
`web/src/styles.css`.

---

## 1. What makes Rayon feel better (the 5-line essence)

1. **The point you're drawing to is a live, editable number.** A wall/line
   in-progress shows Distance and Angle you can *type* mid-draw, with ortho/angle
   snapping and a per-segment dimension chip on everything you've committed.
2. **Commands come to you, not you to a rail.** A `Ctrl+K` command line (or
   one/two-letter shortcuts) drives every tool; the bottom dock is a compact,
   grouped fallback, not a 25-item wall.
3. **The right panel is the object's inspector.** It changes with what's selected
   — canvas properties (unit, grid, stroke scale, background, wireframe) with
   nothing selected; geometry/thickness/alignment when a wall is selected.
4. **The dimension on the drawing IS the input.** Click a wall's length label,
   type a new value, the wall resizes. Numbers are first-class, everywhere.
5. **The canvas is a publishable drawing set.** Model canvas → Views → paper
   Pages with title blocks → one-click public presentation. Not a single "paper
   toggle."

Sources for this section and §2: Rayon docs — [Shape tools](https://docs.rayon.design/documentation/design/shape-tools),
[Elements: walls/zones/openings](https://docs.rayon.design/documentation/design/elements-walls-zones-openings-etc),
[Shortcuts](https://docs.rayon.design/documentation/design/shortcuts),
[Setup](https://docs.rayon.design/documentation/design/setup),
[Layers](https://docs.rayon.design/documentation/design/layers),
[Canvases](https://docs.rayon.design/documentation/layout-and-present/canvases),
[Pages](https://docs.rayon.design/documentation/layout-and-present/pages),
[Presenting](https://docs.rayon.design/documentation/layout-and-present/presenting-your-project),
[Work with AI](https://docs.rayon.design/documentation/work-with-ai);
[Rayon V3 blog](https://www.rayon.design/blog/rayon-v3),
[Pricing](https://www.rayon.design/pricing).
Borrowed patterns: AutoCAD Dynamic Input —
[Autodesk help](https://help.autodesk.com/view/ACD/2024/ENU/?guid=GUID-683349C0-E5C2-4E16-8846-5523E71172A9),
[CAD Master Coach](https://cadmastercoach.com/commands/drafting-aids/dynamic-input);
Figma command palette —
[Figma Quick Commands](https://www.figma.com/community/plugin/1078657295141928162/quick-commands),
[Command-palette UX (Mobbin)](https://mobbin.com/glossary/command-palette).

---

## 2. Rayon's interaction model, decomposed

### 2.1 The cursor-first drawing loop (the thing the user is pointing at)
Trigger a draw tool (Wall = `W`, Line = `L`, etc.), click a start point, then
**every subsequent point is entered either by click or by typing**:

- **Dynamic Distance / Angle input.** Line and Polyline accept **Distance and
  Angle arguments** for precision entry; Arc adds a **Radius** argument. These
  live in the active command bar for real-time entry, so you type an exact length
  and/or bearing instead of clicking. This is a browser re-implementation of
  **AutoCAD Dynamic Input** (F12): a tooltip that follows the crosshair with
  editable length + angle fields, **Tab** to jump between them, **Ortho (F8) /
  Polar (F10)** to constrain direction. [shape-tools], [Autodesk help], [CAD
  Master Coach]
- **Live per-segment dimensions ("helper dimensions").** Committed wall segments
  render their length as an on-canvas label; the labels are **editable** — click
  one, type a new value, the wall resizes. The dimension is the input.
  [elements-walls-zones]
- **Segment-type toggle.** Line/Polyline flip between **straight and arc**
  mid-run (bound to `A`); Rectangle toggles axis-aligned vs three-point (`M`).
  [shape-tools]
- **Snap + ortho.** A "snapping cursor" magnet pulls to endpoint/midpoint/
  center/perpendicular/grid; the Angle argument gives polar/ortho constraint.
  [setup]
- **Commit.** A **Done** button or `Space`/`Enter` validates the run; `Esc`
  cancels; loop mode keeps placing. [elements-walls-zones], [shortcuts]

### 2.2 Command system
Onboarding asks you to **choose how to access commands**: (a) **command line** —
type the command, `Space`/`Enter` to run (AutoCAD muscle memory); or (b)
**shortcuts** — one/two-letter codes fire immediately (`W`, `L`, `CI`). A
`Ctrl+K` command palette searches every command by name (the Figma Quick-Actions
pattern). You can even pick an **AutoCAD-like keymap** (`PLINE`, `REC`, `QDIM`).
~60+ commands grouped drawing / modify / organize / analyze / utility.
[setup], [shortcuts], [Figma Quick Commands]

### 2.3 Properties inspector (context-sensitive right panel)
- **Nothing selected → canvas/model properties:** Unit (Meters/Feet), **Stroke
  scale** (e.g. 1:1), **Wireframe** on/off, **Grid**, **Axis**, **Views**,
  **Background color**, Active layer. [setup], [canvases]
- **Wall selected:** thickness, alignment (left/center/right), reshape.
- **Layer selected:** name, color, opacity, parent. [layers]
- **Page selected:** orientation, format, paper size, scale, background. [pages]
- **Custom data (V3):** typed properties (length/price/cost/URL/formula) tagged
  onto walls/zones/blocks/layers/pages, feeding a spreadsheet table. [V3]

### 2.4 Tool dock, layers, pages/publishing, AI
- **Bottom toolbar**, grouped by function; tools also trigger by shortcut.
  [shape-tools], [editing-tools]
- **Left panel** stacks **Canvases · Layers · Pages** (show/hide, lock, active,
  reorder, nest). [layers]
- **Model canvas → Views → paper Pages**: real sheets at A4/A3/Letter with
  stroke-scale 1:1 (WYSIWYG), then **one-click public presentation** URL.
  [canvases], [pages], [presenting]
- **Unified AI panel**: educate / generate (image→wireframe tracing, axon from a
  plan) / search libraries. [work-with-ai]

*(Confidence: the Distance/Angle **arguments**, Line↔Arc toggle, editable
helper-dimensions, command modes, canvas props, Views/Pages/publish, and snap set
are all documentation-confirmed. The exact **floating tabbed chip** visual and
the **bottom-center dock with expander carets** are inferred from screenshots +
the AutoCAD/Figma patterns Rayon openly copies — not named verbatim in public
text.)*

---

## 3. Gap analysis vs OUR editor (cited to file:line)

Legend: ✅ we have it · 🟡 partial/plumbing-only · ❌ missing.

### 3.1 Cursor-first dynamic input — **❌ the core gap**
- **No typed distance/angle anywhere.** The wall tool commits only on click:
  `EditorCanvas.ts:776–784` (`onDown`, `tool==='wall'`) chains `add_wall` between
  clicked, grid-snapped points. There is **no keyboard path to set a length or
  bearing** — `onKey` (`EditorCanvas.ts:870–912`) handles only Space/Esc/Delete/
  'p'; CAD `onKey` (`model.ts:239`, `controller.ts:108–125`) handles only
  Esc/Enter/close/tool letters. The plumbing to receive keystrokes exists; **it
  never parses a number.**
- **Live length/angle is computed but hidden.** Every CAD draw tool already
  returns a live readout — `geomTools.ts:140–143` (`hint()` → `"L 5.19 m 45°"`),
  and rect/circle/arc/ellipse hints (`:307–312, :359–362, :436–443, :497–501`).
  But it's dumped as **plain text into the status bar**, not a cursor-anchored
  input: `EditorCanvas.ts:810–811` writes `this.cad.hint()` into `coordEl`
  (the footer `x/y` span, `App.tsx:1060–1065`). It is **display-only and
  detached from the cursor.** 🟡
- **No per-segment dimension chips.** Committed walls draw as bare strokes
  (`EditorCanvas.ts:972–981`, `drawSegment` `:1193–1209`); the in-progress wall
  preview (`:982–989`) shows no length. There is a full dimension *entity*
  renderer, but nothing auto-labels segments while drawing. ❌
- **No ortho/polar angle snap.** `snap.ts` is a **point** OSNAP engine
  (endpoint/intersection/midpoint/center/quadrant/perpendicular/nearest/grid,
  `snap.ts:20–31`) — it has **no angle constraint**. Holding Shift or typing an
  angle does nothing to the direction. The wall tool doesn't even use OSNAP: it
  snaps to a **0.1 m grid only** (`EditorCanvas.ts:288, 423–425, 777–781`). ❌
- **No segment-type toggle while drawing** (straight↔arc mid-run). Line and Arc
  are separate tools (`geomTools.ts:512–520`); no `A` flip. ❌

### 3.2 Command access — **❌ missing palette; 🟡 shortcuts half-wired**
- **No command palette.** There is no `Ctrl+K` / search-commands surface
  anywhere in `App.tsx`. Tools are reached only by clicking the rail
  (`pickTool`, `App.tsx:555–558`).
- **Tool shortcuts are decorative, not functional.** The rail renders hint
  badges like `V` (Select) and `W` (Wall) — `App.tsx:816–817` pass `hint="V"`/
  `hint="W"`, shown in the tooltip (`RailButton`, `:1375–1378`) — but **no
  keydown handler maps `v`/`w`/`l`/… to a tool.** `EditorCanvas.onKey`
  (`:870–912`) only knows Space/Esc/Delete/'p'; the 20-tool `CAD_RAIL`
  (`App.tsx:80–101`) has **zero keyboard bindings.** So the badges promise a
  shortcut model that doesn't exist. 🟡
- The `?` help overlay (`App.tsx:518–535, 1092`) lists shortcuts but the CAD
  ones aren't wired.

### 3.3 Tool surface — **🟡 tall left rail, not a grouped dock**
- Tools live in a **single vertical rail** (`App.tsx:813–852`): avatar, Select,
  Wall, the whole `CATALOG` of furniture, then the 20-item `CAD_RAIL`
  (`:80–101`, `:832–842`) — ~30+ buttons in one column. No grouping/carets, no
  compact dock, no "modes/arguments" surface for the active tool.

### 3.4 Properties inspector — **🟡 informative, but not an object inspector**
- The right `aside.inspector` (`App.tsx:943–1056`) is **content**, not
  **properties**: `StatsPanel` (area/zone/CO₂/cost donut, `StatsPanel.tsx:29–70`),
  `GenerateCard`, `LayersCard` (only while a CAD tool is active, `:1023–1043`),
  `ReimaginePanel` when a *component* is selected (`:959–960` — product binding,
  not geometry).
- **No canvas/model properties panel at all** — nothing exposes unit, grid
  on/off, stroke scale, background, wireframe, axis (grid is hard-coded
  `GRID_M=1`, `EditorCanvas.ts:286`; unit is implicitly meters).
- **No geometry inspector for a selected wall or CAD entity** — you cannot select
  a wall and edit its length/thickness/angle as numbers. Selecting a doc
  component opens the product-binding panel, not dimensions. `CadEntity` selection
  (`controller.ts:133` grips) has **no property panel** behind it.

### 3.5 Live dimensions on selection — **❌**
- Selecting anything shows no dimension. A dimension entity type exists
  (`model.ts:65–74`) and renders, but there's no auto-dimension of a selected
  wall/segment and no click-to-edit-length. ❌

### 3.6 Pages / sheets / publishing — **🟡 one paper toggle, no sheet set**
- We have a **single boolean "paper" mode** (`presentation`,
  `EditorCanvas.ts:344–348, 457–462`) that whites out the canvas and draws one
  summary block (`drawSummary`, `:1240–1284`). PDF export is a single sheet
  (`App.tsx:1219–1231`).
- **No multi-page sheets, no Views into the model, no title blocks, no publish
  URL.** Rayon's model→Views→paper-Pages→one-click-publish flow has no analogue.

### 3.7 Where we're already close (protect these)
- ✅ **OSNAP engine** — rich, prioritized, tolerance-aware (`snap.ts` whole file),
  with per-type magnet radii (`:36–47`) — arguably deeper than Rayon's documented
  set. It just needs **ortho/polar** added and a **visible toggle UI**
  (`SnapContext.enabled`, `model.ts:207` already supports per-mode gating; no UI).
- ✅ **CAD tool registry** — line/polyline/rect/circle/arc/ellipse/dimension/
  text/door/window/column/hatch + move/copy/rotate/mirror/scale/trim/extend/
  fillet, grips, CAD undo (`controller.ts:14–20`, `geomTools.ts:512`,
  `editTools.ts:1537`, ROADMAP Track D `docs/ROADMAP.md:117–120`).
- ✅ **Layers panel** (`App.tsx:1110–1141`, `LayersPanel`), commit-sketch-to-plan
  (`:1030–1039`).
- ✅ **Fluid pan/zoom** (trackpad + wheel + space-drag, `EditorCanvas.ts:842–868`).
- ✅ **Live hint text already computed per tool** — the raw material for dynamic
  input already exists; it's just wired to the wrong place.

**Headline:** *We have the CAD spine (OSNAP, tools, grips, undo) but not the CAD
feel. The single highest-value gap is that the point you're drawing to is dumb —
you can't see it as a number at the cursor and you can't type it. Everything the
user pointed at (typed distance/angle, live dimensions, a command line, a real
inspector, sheets) is downstream of making the cursor precision-fluid.*

---

## 4. Prioritized plan (by feel-impact per unit effort)

Ordered so the earliest milestones move the "feel" needle most. Effort is
rough eng-days for one engineer. Each reuses existing infra per no-bloat.

### M1 — Cursor-first **Dynamic Input** ⭐ (the user's core ask) · ~3–4 d
Type Distance/Angle mid-draw; live dimension chip on the current + committed
segments; ortho/polar angle snap; Tab between fields; `Enter`/Done to commit.
- **Touches:** `web/src/cad/dynamicInput.ts` (new — small), `web/src/cad/model.ts`
  (extend `CadTool` with `anchor?()`), `web/src/cad/controller.ts` (inject typed
  point), `web/src/cad/geomTools.ts` (line/polyline expose anchor + angle snap),
  `web/src/editor/EditorCanvas.ts` (floating input DOM + key routing + wall path),
  `web/src/styles.css` (chip styling).
- **Reuse:** `CadTool.hint()` already computes distance/angle
  (`geomTools.ts:140`); `onKey` already receives keystrokes (`model.ts:239`);
  `toScreen` positions the chip (`EditorCanvas.ts:420`); dimension-label render
  style exists in `render.ts`. **No new geometry math beyond a polar helper.**
- **Acceptance:** with the Line (and Wall) tool, after the first point: a chip at
  the cursor shows editable **Distance** and **Angle**; typing `5` + `Enter`
  places a 5.000 m segment at the (snapped) angle; `Tab` then `90` + `Enter`
  locks 90°; holding **Shift** constrains to 90° ortho; each committed segment
  shows a length chip; `Esc` cancels, `Enter` on empty finishes the chain.
- **First-slice spec in §6.**

### M2 — Command palette + real shortcuts · ~2–3 d
`Ctrl+K` opens a searchable command list (all rail tools + view/mode actions);
one/two-letter shortcuts fire tools directly.
- **Touches:** `web/src/ui/CommandPalette.tsx` (new), `web/src/App.tsx` (mount +
  global key handler + a single `COMMANDS` registry derived from `CAD_RAIL`
  (`:80–101`) + `CATALOG` + mode toggles), `EditorCanvas.onKey` (map letters →
  `setTool`).
- **Reuse:** `pickTool` (`App.tsx:555`), existing `CAD_RAIL`/`CATALOG` arrays as
  the command source; the `?`-overlay key-handling pattern (`App.tsx:518–535`).
- **Acceptance:** `Ctrl+K` → type "wall"/"dimension" → Enter selects the tool;
  pressing `w`/`l`/`r`/`d` (when not typing) selects Wall/Line/Rect/Dimension;
  the rail's hint badges now do what they claim.

### M3 — Object inspector (context-sensitive properties) · ~2–3 d
Right panel gains a **Properties** mode: canvas props when nothing is selected
(unit, grid on/off, stroke scale, background, wireframe, axis), and geometry
props when a wall/CAD entity is selected (length, angle, thickness — editable).
- **Touches:** `web/src/ui/PropertiesPanel.tsx` (new), `web/src/App.tsx`
  (route selection → panel, `:943–1056`), `EditorCanvas.ts` (expose grid/axis/
  unit toggles it already renders — `drawGrid` `:1170`, `presentation` `:344`),
  wall-edit binding through the Rust `Editor`.
- **Reuse:** `StatsPanel`/`LayersCard` tab pattern (`App.tsx:963–982`); selection
  already tracked (`getSelected` `EditorCanvas.ts:450`, CAD `selected`
  `controller.ts:35`). Editing a wall length reuses the same math as M1's dynamic
  input (a wall is two points + a length).
- **Acceptance:** deselect → canvas card toggles grid/axis and shows unit + stroke
  scale; select a wall → its length/thickness/angle appear and editing the length
  field resizes the wall live.

### M4 — Live dimensions on selection + click-to-edit · ~1–2 d
Selecting a wall/segment auto-draws its dimension; clicking the number edits it.
- **Touches:** `EditorCanvas.ts` (draw a dimension label for the selected wall,
  reusing `drawSummary`/dimension text style), `render.ts` (dimension label
  already exists), a small on-canvas input (share M1's floating input).
- **Reuse:** M1's floating input widget + M3's wall-length edit path — this is
  mostly wiring, hence cheap once M1/M3 land.
- **Acceptance:** click a wall → its length renders as an editable chip; edit →
  wall resizes.

### M5 — Grouped tool dock · ~2 d
Replace the tall rail with a compact, grouped dock (draw · modify · annotate ·
arch · AI) with expander carets; keep the rail's data (`CAD_RAIL`/`CATALOG`).
- **Touches:** `web/src/ui/ToolDock.tsx` (new), `App.tsx` (`:813–852`),
  `styles.css`.
- **Reuse:** same `pickTool` + arrays; purely presentational refactor.
- **Acceptance:** tools reachable in ≤2 clicks from a bottom dock; active tool's
  modes/args (e.g. dynamic-input toggle, snap toggles) surface next to it.

### M6 — Sheets / Pages / publish · ~5–8 d (largest; do last)
Multi-page paper sheets with Views into the model, title blocks, and a shareable
presentation. Generalizes today's single `presentation` boolean into a Pages
model.
- **Touches:** a Pages/Views model (likely in the Rust core `document.rs` +
  `web/src/editor`), `EditorCanvas.ts` (`presentation` → page renderer,
  `:344–348, 1240–1284`), PDF export (already multi-alt capable,
  `export/report.ts`), a Pages panel.
- **Reuse:** `drawSummary` title-block block, `exportSpacePlanningReport`
  multi-page path (`App.tsx:1247–1266`), presentation mode.
- **Acceptance:** create ≥2 pages, drop a View of the model on each, export/share
  the set.

---

## 5. The three highest-leverage changes

If we ship only three things to make the editor *feel* like Rayon:

1. **M1 — Dynamic input at the cursor.** This is the user's literal ask and the
   root of "cursor-first, precision-fluid." Highest feel-per-day because the live
   readout already exists (`geomTools.ts:140`) — we're relocating and making it
   typeable, not inventing geometry.
2. **M2 — Command palette + working shortcuts.** Converts a 30-button rail into
   "commands come to you." Small, self-contained, and it makes the *existing*
   tool depth discoverable (right now the shortcut badges lie, `App.tsx:816`).
3. **M3 — Object inspector.** Turns the right panel from a stats readout into
   Rayon's "select-anything-and-tune-its-numbers" surface — the "detailed" half
   of the user's complaint ("not as intuitive **and detailed**").

M1 + M2 + M3 together convert *click-click-click + read-the-footer* into
*type-the-number + press-a-key + tune-in-the-panel* — which is the whole gap.

---

## 6. First slice, ready to build: **Dynamic Input (M1)**

Goal: while drawing a **Line** and a **Wall**, the point you're heading to is a
live, editable number at the cursor, with ortho/polar snap and per-segment
dimension chips. Scope this slice to Line + Wall (not arc/rect/dimension) to
prove the interaction; the same widget then generalizes.

### 6.1 New module — `web/src/cad/dynamicInput.ts`
Pure, UI-agnostic state + math (unit-testable in node, like `strategy.ts`).

```ts
export type DynField = 'distance' | 'angle'
export interface DynState {
  active: DynField          // which field the typed digits go to
  distance: string          // raw text, '' = follow cursor
  angle: string             // raw text (degrees), '' = follow cursor / snap
}
/** Nearest ortho/polar direction to `raw` bearing, within `snapDeg` tolerance. */
export function polarSnap(rawDeg: number, stepDeg: number): number
/** Point = anchor + distance∠angle. Falls back to the live cursor for any
 *  field left blank, so a half-typed value still previews. */
export function resolvePoint(
  anchor: Vec2, cursor: Vec2, st: DynState, orthoStep: number,
): { point: Vec2; lockedAngleDeg: number; distance: number }
```

`resolvePoint` logic: bearing = typed angle if present, else cursor bearing
snapped to `orthoStep` when Shift/ortho is on (else raw cursor bearing);
distance = typed distance if present, else `dist(anchor, cursor)`.

### 6.2 `CadTool` contract — expose the anchor (`web/src/cad/model.ts`)
Add one optional method so the dynamic-input layer can compute the candidate
point from the tool's last committed point without the tool knowing about the UI:

```ts
export interface CadTool {
  /** …existing… */
  /** The point new segments extend from (line/polyline/wall = last vertex),
   *  or null before the first click. Enables cursor dynamic input. */
  anchor?(): Vec2 | null
}
```

`lineTool` returns its `start` (`geomTools.ts:104–149`); the chain tool returns
`pts[pts.length-1]` (`:165–233`). No behavior change when `anchor` is undefined.

### 6.3 Controller — inject a typed point (`web/src/cad/controller.ts`)
Add a method that feeds a resolved point to the active tool exactly as a click
would, so all commit logic stays in the tools:

```ts
commitTypedPoint(p: Vec2): void {
  if (!this.tool) return
  const synthetic: SnapResult = { point: p, type: 'none' }
  this.tool.onDown(p, synthetic, this.ctx(), /* no MouseEvent */ undefined as any)
  this.host.requestRender()
}
anchor(): Vec2 | null { return this.tool?.anchor?.() ?? null }
```
(Give `onDown`'s `ev` an optional signature, or pass a minimal stub — the line/
chain tools only read `ev.detail` for double-click, `geomTools.ts:180`.)

### 6.4 Angle snap in the preview (`web/src/cad/geomTools.ts`)
In `lineTool.onMove`, before storing `cur`, apply `polarSnap` when ortho is
armed (a flag passed via `ctx`, or read from a shared `DynState`). The ghost
(`drawPreview`, `:132–139`) then rubber-bands along the locked angle, and
`hint()` reflects the locked bearing. This is the only geometry change; OSNAP
still wins when it grabs a real point (osnap runs first in `controller.snap`,
`:80–82`, and a grabbed point overrides the polar direction).

### 6.5 The floating input + key routing (`web/src/editor/EditorCanvas.ts`)
- **DOM widget.** Add a `dynEl: HTMLDivElement` (sibling of the canvas, like
  `coordEl`) containing two labeled fields, **Distance (m)** and **Angle (°)**,
  positioned each frame at `toScreen(anchor or cursor)` offset a few px. Show it
  only while a draw tool has an `anchor()` and the cursor is on-canvas. Reuse
  IBM Plex Mono for the numbers (CLAUDE.md typography rule).
- **Key routing.** In `onKey` (`:870–912`), when `cad.active` and
  `cad.anchor()` is non-null: digits/`.`/`-` append to `DynState[active]`;
  `Tab` toggles `active` (preventDefault); `Backspace` edits the buffer;
  `Enter`/`Space` → `controller.commitTypedPoint(resolvePoint(...).point)` and
  clear the buffer; `Esc` clears the buffer first, then (second Esc) cancels the
  tool. Route these **before** the existing `cad.key(e.key)` fallthrough
  (`:893`).
- **Ortho.** Track `Shift` held (or a dock toggle) → pass `orthoStep=90` (Ctrl →
  45) into `resolvePoint`; overlay the locked angle on the ghost.
- **Wall path.** Route the non-CAD wall tool (`onDown` `:776–784`) through the
  same widget: on the second+ point, if the buffer is non-empty use
  `resolvePoint(wallStart, mouseWorld, …)` instead of `snap(mouseWorld)`. Better
  (and it retires a divergent code path): **reuse a CAD `wallTool`** so walls
  inherit OSNAP + dynamic input for free — today walls get 0.1 m grid snap only
  (`:288, 777`). Either is acceptable for this slice; note the reuse win.

### 6.6 Per-segment dimension chips (`web/src/editor/EditorCanvas.ts`)
While a draw tool is active, render a small length label at the midpoint of (a)
the in-progress segment and (b) each committed segment of the current chain,
using the dimension-label text style already in `render.ts`. Draw them in the
CAD render pass (`:996–1002`) so they sit above linework.

### 6.7 Acceptance checklist (drive via the dev `__ec` seam, `:404`)
- [ ] Line tool, first click set; a chip at the cursor shows Distance + Angle.
- [ ] Type `5` `Enter` → segment is 5.000 m at the current (snapped) bearing.
- [ ] `Tab` `90` `Enter` → next segment locks to 90°.
- [ ] Hold **Shift** → cursor preview snaps to 90° ortho; angle chip shows the lock.
- [ ] Each committed segment shows a length chip; chips track pan/zoom.
- [ ] OSNAP endpoint/midpoint still wins over polar when the cursor is near a point.
- [ ] `Esc` clears a half-typed value, second `Esc` cancels the chain.
- [ ] Wall tool exhibits the same behavior (or is now a CAD `wallTool`).
- [ ] `pnpm typecheck` clean; existing CAD undo (`⌘Z`) still pops segments.

### 6.8 Explicitly out of scope for this slice
Arc/rect/dimension dynamic input, editable helper-dimensions on already-committed
walls (that's M4), a snap-toggle UI, and the command palette (M2). Keep the
exported TS interfaces in `EditorCanvas.ts` stable — `three/Scene3D` depends on
them (CLAUDE.md gotcha).

---

## 7. Sources
Rayon: [docs.rayon.design](https://docs.rayon.design) — shape-tools, editing-tools,
elements-walls-zones, shortcuts, setup, layers, canvases, pages, presenting,
work-with-ai; [rayon.design/blog/rayon-v3](https://www.rayon.design/blog/rayon-v3);
[rayon.design/pricing](https://www.rayon.design/pricing);
community snapping-UI request (feature-request board).
Borrowed patterns: AutoCAD Dynamic Input —
[Autodesk help GUID-683349C0](https://help.autodesk.com/view/ACD/2024/ENU/?guid=GUID-683349C0-E5C2-4E16-8846-5523E71172A9),
[CAD Master Coach](https://cadmastercoach.com/commands/drafting-aids/dynamic-input);
Figma command palette — [Quick Commands](https://www.figma.com/community/plugin/1078657295141928162/quick-commands),
[Mobbin: command palette](https://mobbin.com/glossary/command-palette).
Comparisons: [Spaces by Dee — AutoCAD vs Rayon](https://www.spacesbydee.com/autocad-vs-rayon-which-software-is-better-for-architectural-drawings/),
[Architech CAD Tutor — AutoCAD & Rayon compared](https://www.architechcadtutor.com/2025/07/autocad-and-rayon-compared.html),
[Foundamental — Rayon 2D vs 3D](https://www.foundamental.com/perspectives/rayon-2d-vs-3d-the-future-design-software-stack).
Our code: `web/src/editor/EditorCanvas.ts`, `web/src/cad/{controller,snap,geomTools,model}.ts`,
`web/src/App.tsx`, `web/src/ui/StatsPanel.tsx`, `docs/ROADMAP.md`.
