# DSource Editor — UX audit

Status: **findings only** (Phase 0). No production code changed by this document.
Companion: **`docs/design/ui-system.md`** (the design proposal that answers it).

> **Note (three-branch merge).** Every `editor/furniture.ts` reference below is
> HISTORICAL. That module was replaced by **`web/src/editor/symbols.ts`** under
> ruling R2, which owns symbol geometry and specifies it in WORLD units rather
> than screen pixels. The file:line citations were accurate when written and are
> kept so; do not follow them into the current tree.


**Method.** The app was run (`./run.sh`, dev server on :5173) and driven end-to-end in a real browser
on the real sample plate (`samples/furniture-plan.dwg`, 882 m², 533 components) at two window sizes
(1440×900 and 1200×688) and two device pixel ratios (1 and 2): create project → upload → Space →
Program → Generate → pick → editor → 3D → back to library. Every scroll container was enumerated
from the live DOM; every zoom claim is either a screenshot or a number computed from the shipped
code. Screenshots: `docs/design/ux-audit/`.

**Verdict in one line.** The engine is real and the output is genuinely good; the *shell around it*
is what reads as unfinished. Three structural mistakes — a container that sizes itself in viewport
units inside a box that doesn't own the viewport, an editor with no way home, and a symbol library
whose vocabulary is a function of zoom — account for most of the "vibe-coded" feeling.

---

## A. Scroll and layout ownership

### A0. The layout law is violated by arithmetic, not by taste

`.studio.wizard` owns the viewport and clips (`styles.css:2809`). Inside it, four fixed bands
(`.studio-top` + `.wizard-head` + `.wizard-guide` + `.wizard-nav`) consume a constant ~359 px, and
`.wizard-body` gets the remainder as the single inner scroller (`styles.css:2972`).

Then `.space-preview` sets `height: clamp(460px, 74vh, 880px)` (`styles.css:3074`).

**74vh is measured against the window; `.wizard-body` is `100vh − 359px`.** For any window shorter
than ~1380 px the preview is *taller than the box it lives in*. Measured live:

| Window | `.wizard-body` viewport | `.space-step` content | Overflow | `.space-preview` height |
|---|---|---|---|---|
| 1440×900 | **541 px** | 2817 px | 5.2× | **666 px** (125 px taller than its window) |
| 1200×688 | **329 px** | 2817 px | 8.6× | **509 px** (180 px taller than its window) |

That is the "double scroll" the user reports, and it is worse than cosmetic: **the floor plan — the
entire subject of the Space step — can never be seen whole**, at any scroll position, at any normal
window size. Scroll to see the plan and the toolbar that acts on it leaves the screen
(`ux-audit/space-loaded.png` vs `ux-audit/space-scrolled.png`).

**Root cause:** an element sized in viewport units nested inside a container that does not own the
viewport. **Fix:** nothing below the app shell may use `vh`. The scroll owner sizes its children;
children size in `fr`/`%`/`min-height:0`.

### A1. Fixed chrome outweighs the work area

At 1440×900, 359 px of a 900 px viewport (40%) is chrome that restates what the user already read;
at 1200×688 it is 52%. On the Generate step this directly costs the user the primary action:
`.wizard-body` scrollHeight 571 vs clientHeight 517 — **54 px of overflow clips the "Open in editor"
button on cards A and C** (`ux-audit/generate-gallery.png`) while 288 px of screen above it repeats
the step title, a subtitle, and a guide strip saying the same thing three ways.

### A2. Inventory of every scroll container

| Screen | Scrollers found (live DOM) | Compliant? |
|---|---|---|
| Landing `#/` | none (page fits) | ✅ |
| Create `#/new` | none | ✅ |
| Space | `document` (no) + **`.wizard-body`** 541/2817 | ⚠️ one scroller, but 5–9× overflow and it clips a fixed-height child |
| Program | **`.wizard-body`** 517/992 | ⚠️ same |
| Generate | **`.wizard-body`** 517/571 | ⚠️ same; clips the CTA |
| Editor 2D/3D | **`.inspector`** 818/2119 (`styles.css:571-575`) | ✅ one owner, but 2.6× deep and unstructured |
| Editor canvas | `.canvas-wrap { position:absolute; inset:0; overflow:hidden }` (`styles.css:466-470`) | ✅ pans, never scrolls |

Strictly, there is exactly one scroll *element* per screen already. The bug is not a second
scrollbar — it is a **fixed-height child taller than its scroll window**, which produces the same
"two nested viewports" sensation and is what the user actually saw.

### A3. `.space-tools` overlays the drawing it controls

`.space-tools` is `position:absolute; top:10px; left:10px; right:10px` over the canvas
(`styles.css:3081-3096`). At 1200 px wide its hint text wraps to two lines and paints on top of the
plan (`ux-audit/reopen-dead-end.png`, `ux-audit/drawingcanvas-zoomed.png`), and the
Fresh-fit / Keep-existing toggle the hint describes is pushed under the fold of its own bar. A
toolbar that occludes its own subject and hides the control its help text explains.

### A4. `ToolDock`'s `position: fixed` flyout is a symptom; the rail is the cause

`.rail` is declared `overflow-y: auto; overflow-x: clip` (`styles.css:264-265`). Being a scroll
container makes it a **clip** container, which is why the flyout had to become `position: fixed`
with coordinates recomputed from the tile's live rect on every scroll and resize — three window
listeners plus a `useLayoutEffect` (`ui/ToolDock.tsx:96-137`), documented in its own comment
(`:90-95`) and in `styles.css:366-369`.

The rail holds an avatar, **six** tiles, a spring and one FAB. It has never needed to scroll. The
`overflow-y: auto` is left over from the flat rail that M5's grouped dock replaced (ROADMAP Track D
M5) — superseded code that was never deleted, exactly the case `.claude/rules/no-bloat.md` §2 covers.
Delete the overflow, delete the fixed-positioning workaround with it.

---

## B. Navigation and information architecture

### B1. The editor is a dead end — and the app knows the way out

The editor topbar is: brand · `/ Chronos GCC Fit-out` (a plain `<span>`, not a link) · 2D/3D · Save ·
Open · Import · Export · help. **There is no control anywhere in the editor that returns to the
project, the wizard, or the library.** The browser back button is the only exit.

Worse, the return trip is broken in the other direction too. `ProjectLibrary`'s open handler routes
unconditionally to the Space step (`shell/AppShell.tsx:89`), so re-opening a finished project drops
the user back on "Drop the floor plate" — even though the card advertises "1 floor"
(`ux-audit/library-with-project.png` → `ux-audit/reopen-dead-end.png`).

The app has the answer and discards it. Verified in IndexedDB after a full run:

```
projects[0].chosenPlanId = "97903754-e714-471a-8fe3-658904a79b93"
plans[0].id              = "97903754-e714-471a-8fe3-658904a79b93"   // "Chronos GCC Fit-out · L07"
```

`chosenPlanId` is **written once (`shell/steps/GenerateStep.tsx:165`) and read nowhere** — a
repo-wide grep returns only that write and the type declaration (`persist/projects.ts:95`). The
generated plan a user spent the whole flow producing is unreachable from the landing page.

### B2. The stepper misrepresents the journey in three ways

`shell/WizardChrome.tsx:25-31`:

1. **Step 1 never shows the stepper.** `CreateProject` renders outside `WizardChrome`
   (`shell/AppShell.tsx:92-97`), so "Property" only ever appears already ticked, for a step the user
   was never shown as a step (`ux-audit/property-create.png`).
2. **The editor tail is fiction.** `EDITOR_STEPS = ['Review','Design','Visualise','Share']` are
   rendered as four pipped stops on the same rail as the real steps. None exists — the editor has no
   phase concept at all, and the tail is `display:none` below 1120 px (`styles.css:2904-2908`), so
   the "whole journey at a glance" disappears exactly on the screens that most need orientation.
3. **Back-navigation is one-way-only.** Only `done` steps are clickable
   (`WizardChrome.tsx:97`), and once in the editor the stepper is gone entirely.

### B3. Surface count in the editor: ~25, in three tiers that aren't expressed

Always-on (5): topbar, tool rail, stage, inspector, status bar.
Contextual (12): `ObjectInspector`, `ReimaginePanel`, `RoomTools`, `PlacePalette`,
`FurnitureInspector`, `StatsPanel`, `LibraryPanel`, `CategoryPlan`, `CloudSyncPanel`, `DesignWithAI`,
`CandidateGallery`, `SelectionCard`.
Summoned (8): `CommandPalette` ⌘K, `SheetsPanel`, `CompareView`, `LayersPanel`, `AgentPanel` (FAB),
`ExportMenu`, help modal, 3D `ViewerToolbar`.

Seven of the contextual twelve are stacked into the single `.inspector` column, which measures
**2119 px of content in an 818 px window** with no sectioning, no collapse, no priority. There is no
hierarchy — just a pile ordered by the sequence the features shipped in.

### B4. The panels don't follow the mode

In 3D (`ux-audit/editor-3d.png`) the inspector still shows "CANVAS · Units / Grid / Axis /
Background / **Presentation**" — five 2D-canvas settings; the status bar still reports 2D cursor
coordinates and `55 px/m`; the left rail still offers Line, Wall, Dimension, Arc and Move, none of
which do anything. Nothing is disabled and nothing says why.

### B5. The app tells the user its own controls are dead

Verbatim, shipped, in the inspector: *"Units, grid, axis and background follow the plan. Presentation
mode swaps the plan for a paper sheet — **the rest are display-only until per-canvas settings
land.**"* Four inert rows presented as settings, with an apology underneath. Delete the rows or
implement them; do not ship the apology.

### B6. Unguarded and ambiguous controls

- **Project delete** is a bare `×` on the library card (`.project-card-del`) with no label and no
  confirmation.
- **Save / Open** in the editor mean `.dsource` *file* save/open, sitting next to a project that
  already autosaves to IndexedDB. Two persistence models, same verb, no distinction.
- **Import** inside the editor replaces the plan the user just generated, with no warning.
- **Property Name** is the only `required` field on the create form but carries no marker; the user
  discovers it via a native browser bubble on submit.
- **`Lo | Hi`** in the 3D toolbar is unlabelled.

### B7. State survives navigation; the UI doesn't say so

`AppShell` keeps `EditorView` mounted under `display:none` (`shell/AppShell.tsx:171-181`) and the
framing machinery is genuinely careful — `frameContent` gates on the *container* via
`viewportReady()` (`EditorCanvas.ts:2336-2344`) with a `ResizeObserver` completing a pending frame
(`:2326-2334`) and an rAF retry (`:1888`). Opening a candidate framed correctly at 16 px/m, centred,
in every run. **No stale or blank canvas was reproduced.** This part works.

Two real defects nearby:

- **Duplicate `data-testid`.** `category-plan` is rendered by both `SpaceStep` and the hidden
  `EditorView`, so it appears twice in the DOM on the Space step. Any strict `getByTestId` breaks.
- **`window.__dc` is unreliable.** Two `DrawingCanvas` instances exist (the Space preview and the
  editor's import mode); the global resolves to the hidden editor one, stuck at its 300×150
  intrinsic size (`__dc.cssSize()` → `{w:150,h:75}` while the visible preview is 602×507). The
  documented E2E seam points at a dead canvas.

---

## C. Canvas rendering consistency — the zoom bug

### C1. The symbol vocabulary is a function of zoom (the actual root cause)

`MIN_DETAIL` is the least of it. **Fifteen** decisions inside `editor/furniture.ts` are made in
*screen pixels*, so they change as the user zooms:

| Line | Decision | Changes with zoom |
|---|---|---|
| `furniture.ts:37,50,61` | `MIN_DETAIL = 11` → symbol collapses to a filled chip | hard binary snap |
| `furniture.ts:213` | `stadium = min(w,h) > 34 && ratio > 1.5` | **table shape** rect ⇄ racetrack |
| `furniture.ts:220` | `perSide = clamp(round(longLen / 26), 2, 4)` | **number of chairs** |
| `furniture.ts:239` | head chairs iff `shortLen > cs*1.3` | ±2 chairs |
| `furniture.ts:223` | `arms = cs > 26` | chairs gain armrests |
| `furniture.ts:362-363` | `cols/rows = clamp(round(w/20),1,8)` | **ceiling tile count** |
| `furniture.ts:515` | `n = clamp(round(long/20),1,5)` | **casework drawer count** |
| `furniture.ts:157` | keyboard iff `kbW>12 && minDim>22` | detail pops in |
| `furniture.ts:165,187` | chair iff `seat>4`, arms iff `s>24` | detail pops in |
| `furniture.ts:141,155` | `monW = min(w*0.4, 34)`, `kbW = min(w*0.46, 36)` | proportions distort past the cap |
| `furniture.ts:334` | column hatch `step = max(3, min(w,h)/4)` | hatch density |
| `furniture.ts:49` | `lw = selected ? 1.8 : 1.35` | fixed screen px, never DPR-snapped |

Computed from the shipped formulas for **one real 1.2 × 0.6 m table** in the generated plan:

| Zoom (px/m) | 8–16 | 20–30 | 45 | 70 | 110–200 | 300 |
|---|---|---|---|---|---|---|
| Shape | chip | rounded rect | rounded rect | **stadium** | stadium | stadium |
| Chairs drawn | — | **0** | **6** | **8** | **10** | 10 + arms |

Visually confirmed on the boardroom table: `ux-audit/zoom-20pxm.png` (a small rectangle, no seats) →
`ux-audit/zoom-45pxm.png` (a racetrack ringed with chairs) → `ux-audit/zoom-110pxm.png`.

This is not only ugly, it is **wrong**: the room tag says `24 m² · 9 pax` while the drawing under it
shows 0, 6, 8 or 10 chairs depending on how far the user has scrolled the wheel. The drawing
contradicts its own label at every zoom but one.

### C2. Room tags pop in and out

`EditorCanvas.drawZones` suppresses tags on **screen** measurements: skip the whole tag if
`h < 18 px` (`:2717`), drop the metrics line if `h < 34 px` (`:2730`), shrink 10 px → 8 px → give up
if `measureText(name) > w − 10` (`:2720-2726`). Room names therefore appear and vanish as the user
zooms. The one world-space rule (`area < 6 m²`, `:2664,:2717`) is the correct kind, and it is the
minority.

Because the pills are constant screen size and never culled by density, at 8 px/m they collide into
an unreadable mat over the plan (`ux-audit/zoom-08pxm.png`), and four separate `CIRCULATION` pills
label what reads as one continuous zone (`ux-audit/editor-2d.png`). Label collision at the bottom of
that same screenshot ("CIRCULATION" / "RECEPTION" / "TEAM ROOM 1") shows the de-collision pass
failing outright.

### C3. Line weights are a three-regime hybrid, and never land on device pixels

`EditorCanvas.wallStyle` (`:2508-2521`) uses `clampN(thickness × scale, min, max)`:

| Tier | Formula | Behaviour |
|---|---|---|
| exterior | `clamp(t·k, 2.4, 5)` | constant → proportional → constant |
| interior | `clamp(t·k, 1.7, 3.8)` | " |
| generated | `clamp(t·k·0.85, 1.3, 3.2)` | " |

Below ~12 px/m every tier is pinned to its floor (2.4 / 1.7 / 1.3) and the hierarchy compresses to
near-nothing; above ~25 px/m every tier is pinned to its ceiling and the wall stops thickening while
the room around it keeps growing. In between it is proportional. Three different visual laws across
one zoom sweep is exactly "the line weight relative to the drawing changes at every zoom level".

`import/DrawingCanvas.ts` has the same class of problem in the simplest form: `LINE_WEIGHT`
(`:73-83`) is a flat `{wall:1.6, glazing:1, door:1, annotation:0.75}` in CSS pixels, applied via
`ctx.lineWidth = b.lw` (`:1301`) — so at 300 px/m a 200 mm wall and a dimension line are still 1.6 px
and 0.75 px, and the imported plan degenerates into an undifferentiated web of hairlines.

Nothing anywhere snaps to device pixels. At DPR 1, `1.35` and `1.6` straddle the pixel grid → soft
grey smear instead of a crisp hairline. At DPR 2 they are 2.7 and 3.2 device px → same problem, one
level down. The half-pixel `+0.5` trick is used for rulers and the summary block
(`EditorCanvas.ts:2900,:2703`) but never for walls or furniture.

**And `EditorCanvas` never refreshes its DPR.** `private dpr = Math.max(1, devicePixelRatio || 1)`
is a field initialiser read once at construction (`:478`); `resize()` (`:2355-2364`) and `onResize`
(`:2317-2320`) both reuse it. Move the window to a display with a different DPI, or change browser
zoom, and the backing store is sized with the stale ratio. `DrawingCanvas` re-reads it every resize
(`:1228`) — so the two canvases don't even agree on this.

### C4. World vs screen: what is currently which

| Element | Today | Should be |
|---|---|---|
| Walls, furniture footprints, zone fills, door swings | world ✅ | world |
| Furniture *internal detail* (chairs, drawers, tiles, hatch) | **screen ❌** | **world** |
| Wall stroke weight | hybrid ❌ | screen, DPR-snapped |
| Room tags / dimension chips / marker + anchor pins / grips / selection halos / area ring / scale line | screen ✅ | screen, DPR-snapped |
| Tag *visibility* | screen ❌ | world (area) + density culling |

### C5. The two canvases render the same object differently

`EditorCanvas.drawComponent` passes `fill` and `seat` to `drawFurnitureSymbol` (`:2940-2954`);
`DrawingCanvas.drawItemSymbol` passes **neither**. Same function, same desk, two looks: filled
worktop, filled monitor bar and filled seat in the editor
(`ux-audit/zoom-45pxm.png`) versus hollow outlines in the import view
(`ux-audit/drawingcanvas-zoomed.png`). Crossing the Space → editor boundary looks like crossing into
a different application. The Y-axis convention also differs (DrawingCanvas Y-up, EditorCanvas
Y-down) and is reconciled per call-site (`-norm.rotation`, `rotation + π` in `mergeFit`) rather than
once in a shared layer.

---

## D. End-to-end workflow — the honest verdict

Walked cold on the real DWG. **The job does get done**: a first-timer can reach a branded report and
a costed takeoff without help. But four transitions leak, and one is a hard dead end.

| Transition | What a first-timer must figure out unaided | Severity |
|---|---|---|
| `#/` → create | Two identical "Start a project" CTAs; "YOUR PROJECTS 0" sits above an empty state that also says "No projects yet". Redundant, not broken. | low |
| create → Space | Only Property Name is required, and nothing says so. The stepper claims "Property" is a completed step the user never saw as one. | med |
| Space | **The plan can never be fully seen** (A0). Toolbar and plan can't be on screen together (A0). Toolbar hint text paints over the drawing and hides the Fresh-fit/Keep-existing toggle (A3). Guide strip says "DXF or DWG" while the drop zone (correctly) offers PNG/JPG — the raster + scale-calibration path is real (`import/rasterImport.ts`), so the guide copy and `docs/ROADMAP.md:369` ("CAD-only v1") are both stale. | **high** |
| Space → Program | The step's own instruction ("Pick a template or type a headcount") points at controls **475 px below the fold**, behind a full-viewport panel for *anchor pins* — a tertiary feature. The primary control of the step is invisible on arrival. Units flip: m² on Space, "5,681 of 9,489 sf" on Program; "Desk size 140 × 70" carries no unit at all. | **high** |
| Program → Generate | Good screen, genuinely useful. But the primary CTA is clipped on 2 of 3 cards (A1), and the cards misalign because the winner-badge row isn't reserved (A has 2 badges, B has 0, C has 1). The three thumbnails are near-indistinguishable at card size, which is the one job this screen has. | med |
| Generate → editor | Opens correctly framed. Then: no way back (B1), no phase UI to match the promised Review→Design→Visualise→Share (B2), inspector is a 2119 px pile (B3), inert canvas settings ship with an apology (B5). | **high** |
| editor → export | Report and takeoff are correct and branded ("Chronos GCC Fit-out", address, L07). Reaching them requires knowing to look under a dropdown labelled "Export". Nothing in the flow points there — the wizard's promised "Share" phase does not exist. | med |
| back to `#/` | **Hard dead end.** The chosen floor is unreachable; the card says "1 floor" and clicking it restarts at upload. `chosenPlanId` is persisted and never read (B1). | **critical** |

### Where the app knows something the user doesn't

1. `chosenPlanId` — the exact floor to reopen. Written, never read.
2. `Program.rooms` / `program_fit` — the generator reports which requested rooms it couldn't place;
   the Generate cards never surface it.
3. `Next` is disabled with a reason on Space (`disabledReason`) but **not** on Program
   (`AppShell.tsx:149` passes `nextDisabled` with no `disabledReason`) — same component, half-wired.
4. Every tool in the left rail and every canvas setting in the inspector is inert in 3D, silently.

---

## E. Design-language defects (the "vibe-coded" tells)

1. **The documented design language is not the shipped one.** `CLAUDE.md` specifies IBM Plex Mono
   for all numerics, Space Grotesk for UI, and a single warm amber `#E8A13C`. Shipped: Hanken
   Grotesk + Schibsted Grotesk (`main.tsx:4-9`), a blue `--accent: #2d5bd6` (`styles.css:23`), and
   amber surviving only as a second accent on toggles (Heal gaps, the whole 3D toolbar) and in the
   favicon (`index.html:8`). **Two accent colours, neither documented.**
2. **IBM Plex Mono is referenced 12× in `styles.css` and 28× across `.ts`/`.tsx` — and never
   loaded.** It is not in `package.json`; every one of those call sites silently falls back to
   `ui-monospace`. Meanwhile `main.tsx:2-3` comments assert the opposite policy ("ALL data/numbers …
   no monospace"). Three sources of truth, all disagreeing.
3. **Two dead font references in canvas code**: `"Space Grotesk"` (`DrawingCanvas.ts:1502`,
   `sectionRender.ts:502`) — never loaded either.
4. **174 hardcoded hex literals in `.ts`/`.tsx`**, led by `#ffffff` ×33, `#E8A13C` ×21, `#1a1d21`
   ×18, `#2d5bd6` ×11 — each duplicating a token that already exists in `:root`.
5. **~93 inline `style={{…}}` objects** in components that a stylesheet already covers, concentrated
   in `CategoryPlan` (18), `ViewerToolbar` (16), `SelectionCard` (14), `LibraryPanel` (10),
   `Scene3D` (7), `CloudSyncPanel` (7), `LayersPanel` (6), `PlacePalette` (5), `Minimap` (4),
   `CandidateGallery` (4).
6. **Vestigial fallbacks** betray the migration: `var(--accent, #e8a13c)` (`styles.css:540`),
   `var(--font-ui, 'Space Grotesk', sans-serif)` (`:544,:566`) — defaults pointing at a design system
   that no longer exists.

---

## F. What is genuinely good (don't regress it)

- The **generated plan itself** at 20–45 px/m reads like an architect's drawing: zone tinting, wall
  hierarchy, door swings, area + pax tags, poché on cores.
- **Framing on open** is robust (B7) — container-gated, ResizeObserver-completed, rAF-retried.
- The **Generate gallery** is the strongest screen in the product: winner badges, real KPIs,
  strategy names that mean something.
- **3D** frames correctly, materials read, themes work.
- **Export meta threading** works end to end — the report and takeoff carry the real project.
- The **canvas never scrolls; it pans.** That law is already right.

---

## G. Findings by severity

| # | Finding | Where | Fix in |
|---|---|---|---|
| 1 | Re-opening a project can't reach its finished floor; `chosenPlanId` written, never read | `AppShell.tsx:89`, `GenerateStep.tsx:165` | Phase 2 · slice 4 |
| 2 | `.space-preview` sized in `vh` inside a non-viewport-owning box → plan never fully visible | `styles.css:3074` | slice 1 |
| 3 | Symbol vocabulary (chair count, table shape, drawer count) is a function of zoom | `furniture.ts:213,220,239,362,515` | slice 2 |
| 4 | No route out of the editor | `App.tsx` topbar | slice 3 |
| 5 | Program step opens with its primary control below the fold | `ProgramStep.tsx` | slice 4 |
| 6 | Line weights are a three-regime hybrid; nothing DPR-snapped | `EditorCanvas.ts:2508`, `DrawingCanvas.ts:73` | slice 2 |
| 7 | `EditorCanvas.dpr` never refreshed after construction | `EditorCanvas.ts:478,2355` | slice 2 |
| 8 | Generate CTA clipped; badge row unreserved → cards misalign | `styles.css` + `GenerateStep.tsx` | slice 1 |
| 9 | Room tags pop in/out and collide at overview zoom | `EditorCanvas.ts:2717,2730` | slice 2 |
| 10 | Two canvases render the same object differently (fill/seat) | `EditorCanvas.ts:2950`, `DrawingCanvas.ts` | slice 2 |
| 11 | Stepper lies (no Property step, fictional editor tail) | `WizardChrome.tsx:25-31` | slice 3 |
| 12 | Inert canvas settings shipped with an in-product apology | inspector | slice 3 |
| 13 | Inspector = 2119 px unstructured pile; panels don't follow mode | `App.tsx:1146+` | slice 3 |
| 14 | `.rail` overflow (superseded) forces the fixed-flyout workaround | `styles.css:264`, `ToolDock.tsx:96-137` | slice 1 |
| 15 | `.space-tools` occludes the plan; hides its own toggle | `styles.css:3081` | slice 1 |
| 16 | Unguarded delete, ambiguous Save/Open, destructive Import | library card, topbar | slice 4 |
| 17 | Program `Next` disabled with no reason (Space has one) | `AppShell.tsx:149` | slice 4 |
| 18 | Unit drift (m² vs sf), unitless "140 × 70" | `ProgramStep.tsx` | slice 4 |
| 19 | Documented type/colour system ≠ shipped; Plex Mono referenced 40× and never loaded | `CLAUDE.md`, `main.tsx`, `styles.css` | slice 5 |
| 20 | 174 hex literals + ~93 inline style objects duplicating tokens | 10 components | slice 5 |
| 21 | Duplicate `data-testid="category-plan"`; `window.__dc` points at a dead canvas | `SpaceStep`/`App` | slice 3 |
| 22 | `ROADMAP.md:369` says raster import is deferred; it shipped | `docs/ROADMAP.md` | slice 4 |
