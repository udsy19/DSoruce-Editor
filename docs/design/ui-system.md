# DSource — UI system

Status: **proposal** (Phase 1). Answers `docs/design/ux-audit.md`. No production code changed by
this document. Implementation order is §7.

**The position.** DSource's identity is *the drawing*, not the chrome around it. Rayon, qbiq and
Laiout all land the same way: the plan is the hero on every screen and the interface is a thin,
quiet instrument panel around it. Today we do the opposite — 40–52% of the wizard viewport is spent
restating a step title while the plan is clipped inside a scroll window it doesn't fit in.

So the single aesthetic bet of this overhaul: **the plan is the hero on every screen, and the chrome
becomes bands.** Everything else — the layout law, the symbol spec, the token cleanup — follows from
that one commitment. We spend our boldness on the drawing and keep the interface deliberately
undesigned around it.

---

## 1. The layout law

> **`#root` owns the viewport. Exactly one pane per screen scrolls. The canvas never scrolls — it
> pans.**

```
#root ─────────────────────── height:100dvh · overflow:hidden · the ONLY viewport owner
 └ .screen (one per route) ── display:grid · height:100% · min-height:0
    ├ chrome band(s) ──────── grid-row: auto · flex:none   (header · step bar · footer)
    └ .work ──────────────── grid-row: 1fr · min-height:0 · and EXACTLY ONE of:
         · .pane-scroll   overflow-y:auto            lists, forms, inspectors
         · .pane-canvas   position:relative;overflow:hidden   pans, never scrolls
         · a grid of both, every child min-height:0 / min-width:0
```

**Five rules. All five are lint-able.**

1. **`vh` / `dvh` appears only on `#root`.** Nowhere else, ever. This one rule alone kills audit
   finding #2 — `.space-preview`'s `74vh` inside a box that is `100vh − 359px`.
2. **A scroll pane's children never carry a fixed `px` height** that can exceed the pane. They size
   in `fr` / `%` / `auto` / `min-height:0`.
3. **A canvas pane is `position:relative; overflow:hidden`;** canvases fill it via `inset:0` and a
   `ResizeObserver`. Zoom is pan+scale, never scrollTop.
4. **No ancestor of a floating surface declares `overflow` other than `visible`.** Flyouts are
   `position:absolute` against a `position:relative` ancestor — never `fixed`, never re-anchored on
   scroll. (Kills finding #14 and ~35 lines of `ToolDock` workaround.)
5. **Chrome bands are `flex:none`; the work area is `1fr; min-height:0`.** A band may not grow to fit
   its content; long copy truncates or moves into the work area.

### 1.1 The wizard, re-laid

Today the wizard is a document that scrolls. It becomes a canvas-first split.

```
BEFORE (measured, 1440×900)              AFTER
┌───────────────────────────────┐        ┌───────────────────────────────────────┐
│ brand      stepper            │ 70     │ ⬛ DSOURCE  Chronos ▸ L07   ①─②─③─④   │ 56  fixed
├───────────────────────────────┤        ├───────────────────────────────────────┤
│ STEP 2 OF 4 · SPACE           │        │ 2 · SPACE  Drop the floor plate       │ 40  fixed
│ Drop the floor plate          │ 130    │ › Drop a DXF/DWG or an image.         │
│ Upload a CAD floor plan and…  │        ├──────────────────────────┬────────────┤
├───────────────────────────────┤        │ [Area][Marker][Heal]     │ USABLE     │
│ › Drop a DXF or DWG below…    │ 44     │                          │ 882 m²     │
├───────────────────────────────┤        │                          │ 9,489 sf   │
│ ░░ .wizard-body — 541px ░░░░░ │        │      P L A N             ├────────────┤
│ ░ .space-preview 666px ░░░░░░ │ 541    │      fills the pane      │ COMPONENTS │ 1fr
│ ░ (clipped, unreachable) ░░░░ │        │      at every size       │ 533        │
│ ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ │        │                          │ …scrolls   │
├───────────────────────────────┤        ├──────────────────────────┴────────────┤
│ Back                   Next › │ 70     │ ‹ Back        ⓘ reason      Next ›    │ 56  fixed
└───────────────────────────────┘        └───────────────────────────────────────┘
   chrome 359px (40%)                       chrome 152px (17%) · plan 748px (83%)
   plan visible: never whole                 plan visible: always whole
```

- Title + subtitle + guide (three restatements) collapse to **one line of context + one imperative**.
- The plan pane is `.pane-canvas` — it never scrolls; the drawing re-fits on resize.
- The side rail is the only `.pane-scroll` on the screen.
- Toolbar moves **inside** the plan pane as a floating band that never occludes the plan's centre and
  never hides its own controls (audit #15).
- Generate's cards get a reserved badge row so all three CTAs align, and the pane is tall enough that
  no CTA is clipped (audit #8).
- Program leads with its **program builder**; anchor pins move into the plan pane beside it, not above
  it (audit #5).

### 1.2 The editor, re-laid

Structure is already right (`.app` grid, canvas pans, one inspector scroller). Two changes:

- **The inspector becomes one contextual pane, not seven stacked ones.** Its content is a function of
  selection: nothing → Plan (stats + regs); a component → Object + Product; a room → Room; import
  staging → Detected. `LibraryPanel` / `CompareView` / `CloudSyncPanel` / `SheetsPanel` move to
  tertiary (summoned), where they belong. 2119 px of pile → ~600 px of relevance.
- **Panels follow the mode.** In 3D the inspector shows view/theme/quality, the rail's 2D tools are
  disabled with a reason, and the status bar reports camera state, not 2D cursor coordinates.

---

## 2. Navigation model

### 2.1 Persistent context — on every screen, including the editor

```
⬛ DSOURCE   Chronos GCC Fit-out ▸ L07                    [2D|3D]  Export ▾  ?
             └─ link → project    └─ link → floor switcher
```

Every segment is a real link. This is the way back, and it exists in the editor for the first time
(audit #4). It answers "where am I, in what project, on what floor" without a stepper.

### 2.2 One primary action per screen

| Screen | Primary | Secondary | Way back |
|---|---|---|---|
| Landing | Start a project | open a project card | — |
| Property | Create project | Cancel | breadcrumb |
| Space | Next: Program | tools, replace plan | breadcrumb / Back |
| Program | Next: Generate | Concept ⇄ Detailed, anchors | breadcrumb / Back |
| Generate | Open in editor (per card) | Regenerate | breadcrumb / Back |
| Editor | **Export** | edit, bind, 3D | breadcrumb |

The landing's two identical CTAs collapse to one (the empty state's), with the header CTA appearing
only once projects exist.

### 2.3 The stepper tells the truth

- **Property joins the stepper.** `CreateProject` renders inside the chrome, so step 1 is a step.
- **Delete `EDITOR_STEPS`.** Review / Design / Visualise / Share do not exist (audit #11). The rail
  ends at Generate and hands off to a labelled **Editor** terminus. If phases are wanted later, they
  get added when they are real.
- **Every completed step is clickable, always** — including from the editor via the breadcrumb.
- The `@media (max-width:1120px) { .wizard-step.future { display:none } }` hack goes with the tail.

### 2.4 Reopening a project goes where the user left off

`ProjectLibrary` → `AppShell.onOpen` reads the `chosenPlanId` the app already stores and routes to
`{ name:'editor', projectId, planId }`; only a project with no chosen floor lands on Space. Audit
finding #1, the critical one, is a two-line fix to already-persisted data.

### 2.5 Panel hierarchy — three tiers, expressed

| Tier | Rule | Members |
|---|---|---|
| **Primary** — always visible | never more than 4 | topbar, tool rail, stage, status bar |
| **Secondary** — contextual, **at most one at a time**, in the inspector | driven by selection or mode | Plan/Stats · Object+Product · Room · Detected · 3D view |
| **Tertiary** — summoned, dismissible with Esc, never two at once | modal or popover | ⌘K palette, Sheets, Compare, Layers, AI, Export, Library, Cloud, Help |

### 2.6 Disabled always says why

`WizardChrome` already has `disabledReason` — it is simply not passed on Program (audit #17). The rule
generalises: **any disabled control carries a `title` and, where it is a step gate, a visible reason
beside it.** In 3D, the 2D tools are disabled with "Switch to 2D to draw".

### 2.7 Delete the apology

The four inert Canvas rows and the sentence "…the rest are display-only until per-canvas settings
land" are removed. Units/Grid/Axis/Background become a read-only *status* line (they do reflect the
plan), or they go. A product does not ship an apology for its own controls.

---

## 3. Canvas symbology spec

This is the substance of the fix. Four rules.

### 3.1 World vs screen — the printed-sheet test

> **If it would be printed on the drawing at 1:100, it is drawn in WORLD units.
> If it would be printed on the sheet around the drawing, it is drawn in SCREEN units.**

| WORLD (metres · scales with zoom) | SCREEN (constant CSS px · DPR-snapped) |
|---|---|
| Wall poché and thickness | Room tags and their pills |
| Furniture footprints | Dimension chips, the dyn-input widget |
| **Furniture internal detail** — chair positions, drawer divisions, ceiling tile grid (600 mm), column hatch (150 mm) | Marker pins, anchor pins, snap indicators |
| Door leaf + swing arc | Grips, selection halos, corner ticks |
| Zone fills and outlines | Rulers, scale bar, cursor readout |
| Glazing lines | Area-ring handles, the scale reference line |

Everything currently in the wrong column is listed in audit §C4. The migration is mechanical: the
fifteen screen-px thresholds in `editor/furniture.ts` become metre constants.

### 3.2 Line weights: a pen set, snapped to device pixels

Architects draw with a **pen set**, not a continuous function. Four weights, defined in *device*
pixels so a hairline is exactly one physical pixel at any DPR:

```ts
// One helper, used by every stroke on both canvases.
const PEN = { hair: 1, thin: 1.5, med: 2, thick: 3 } as const   // device px
const pen = (w: number, dpr: number) => Math.max(1, Math.round(w * dpr)) / dpr  // → CSS px on-grid
```

| Element | Pen |
|---|---|
| Exterior / plate wall outline | `thick` |
| Interior wall outline | `med` |
| Generated partition outline | `thin` |
| Furniture, glazing, door | `thin` |
| Furniture detail, hatch, grid | `hair` |
| Annotation, dimensions | `hair` |

**And walls become filled poché.** A wall is a 200 mm-thick *object*: it is filled at true thickness
in world units with a `thick`/`med`/`thin` hairline outline — not stroked with a fudged
`clamp(t·k, min, max)` width (audit #6). This is the single biggest lever on "a drawing an architect
would sign", and it removes the three-regime hybrid entirely, because the wall's mass is world and
only its outline is screen. Below ~3 device px of true thickness (≈ 7 px/m) a wall degrades to one
`med` stroke — a *fade*, per §3.3, not a snap.

**DPR is re-read on every resize.** `EditorCanvas`'s constructor-only `dpr` (audit #7) moves into
`resize()`, matching `DrawingCanvas`, plus a `matchMedia('(resolution: …)')` listener so a
display change repaints correctly.

### 3.3 Continuous LOD with hysteresis — and countables are never LOD'd

**No boolean detail switch exists anywhere.** A detail tier fades across a band:

```ts
// s = the symbol's projected size in CSS px. exit < enter.
const lod = (s: number, exit: number, enter: number) =>
  Math.max(0, Math.min(1, (s - exit) / (enter - exit)))
// drawn as: ctx.globalAlpha = base * lod(s, 14, 26)
```

**Hysteresis.** The band itself is the hysteresis: because detail is *fading*, not *toggling*, a user
wiggling the wheel at the boundary sees a smooth 0.4 → 0.6 → 0.4 alpha, never a pop. Where a genuine
threshold is unavoidable (a symbol dropping to a footprint at the very bottom), the appear threshold
sits 25% above the disappear threshold so the two never chatter.

**The rule that fixes the audit's headline bug:**

> **Countable content is a property of the object, never of its screen size.**

A 1.2 × 0.6 m table seats the number of people the model says it seats — at 8 px/m and at 300 px/m.
Seat count derives from world dimensions at a fixed 0.65 m pitch (or from the zone's `capacity` where
the core supplies one), so it is *constant across zoom* and *consistent with the room tag*. Same for
casework drawer divisions (one per 450 mm), ceiling tiles (600 mm grid), and column hatch (150 mm).

Today (measured) vs proposed, for the real 1.2 × 0.6 m table in the generated plan:

| px/m | 8 | 16 | 20 | 30 | 45 | 70 | 110 | 200 | 300 |
|---|---|---|---|---|---|---|---|---|---|
| **now** | chip | chip | rect **0** | rect **0** | rect **6** | stadium **8** | stadium **10** | stadium **10** | stadium **10**+arms |
| **proposed** | 4 (α .0) | 4 (α .3) | 4 (α .6) | 4 (α 1) | 4 | 4 | 4 | 4 | 4 |

Shape is world-determined too: a table is a racetrack when its true aspect ratio exceeds 1.5 *and*
its true long side exceeds 2.4 m — a fact about the table, not about the wheel.

### 3.4 One symbol vocabulary, one module

`editor/furniture.ts` is **extended and renamed** to `editor/symbols.ts` (not forked — the existing
symbols are good and stay). Its signature changes from screen-space to world-space + a view:

```ts
export interface View { pxPerM: number; dpr: number; yUp: boolean }
export interface SymbolSpec {
  category: string
  x: number; y: number; w: number; h: number   // WORLD metres
  rotation: number; mirror?: boolean
  capacity?: number                            // from the core, when known
  ink: Ink                                     // stroke/detail/fill/seat/accent — ONE palette type
  state?: 'normal' | 'selected' | 'reference' | 'confirmed'
}
export function drawSymbol(ctx: CanvasRenderingContext2D, s: SymbolSpec, v: View): void
```

Both canvases call it identically. The Y-convention difference is handled **once**, by `View.yUp`
inside the module, instead of `-norm.rotation` at one call site and `rotation + π` at another
(audit #10). `state: 'reference'` — not a missing `fill` argument — is what makes imported furniture
recede, so the Space preview and the editor render the same desk the same way.

### 3.5 Annotation visibility is a world decision

Room tags today appear and vanish on screen measurements (audit #9). Replace with:

- **Show a name** iff `zone.area ≥ 6 m²` (world). **Show metrics** iff `area ≥ 12 m²` (world).
- **Fade the whole tag layer** below ~10 px/m via `lod(pxPerM, 7, 12)` — at overview zoom a plan is
  read as shape, not as labels, and the pill mat in `ux-audit/zoom-08pxm.png` disappears.
- **De-collide by world priority.** When two pills overlap, the smaller-area zone yields. Priority is
  a world quantity, so the choice is stable under zoom and pan — it never flickers.
- **One tag per zone.** The four separate `CIRCULATION` pills merge; circulation is labelled once,
  at the largest component's centroid.

### 3.6 Ownership: who owns "how many people sit here"

**Traced before writing any drawing code.** The answer changes the design, so it is recorded here as
a rule.

**Where the room tag's `· 9 pax` comes from:**

```
EditorCanvas.ts:2670,:2727   stat.capacity
  └─ Editor::zone_stats()    lib.rs:558-562
       ├─ plate-spanning Workspace → `seated` (real desk count)
       └─ every other zone         → Zone::capacity()   zone.rs:183-194
                                     = floor(zone_area / m²-per-seat)
                                       Meeting 2.5 · Collab 3.0 · Workspace 6.0 · Office 9.0
```

So `BOARDROOM 24 m² · 9 pax` is `floor(24 / 2.5)`. **It is an area rule-of-thumb about the room. It
is not a count of seats at the table.** The table is a separate `Component` with its own `w`/`h`, and
its seat count is derived independently — today, from *screen pixels*.

That is the `price_inr` dual-source pattern, and it is already latent: two quantities, computed from
two different inputs, presented adjacently as if they agreed. Rendering "the tag's value" in the
glyph would not fix it — it would make a 1.2 × 0.6 m table draw nine chairs.

**The real defect is upstream.** `layout.rs:1069` comments, on emitting a conference table:
*"chairs live in its 2D glyph / 3D build"*. The generator knows exactly what it placed — the seat
count is literally in the name (`SpaceKind::Meeting4P`, `Meeting6P`, `Boardroom`) — and throws it
away, leaving the renderer to guess it back from the zoom level.

**The rule:**

> **A seated object's seat count is a facet of the object, resolved once at its origin, carried on
> the model, and rendered — never derived at draw time.**
>
> - **Room pax** is a property of the **zone**. Owner: `Zone::capacity()` (core). The room tag
>   renders it. Already single-source; unchanged.
> - **Seats at an object** is a property of the **component**. Owner: a new additive
>   `Component.seats: u32` (`#[serde(default)]`), set where the component is created — the generator
>   for generated furniture, `normalizeFurniture` for imported CAD blocks (whose names carry it
>   outright: *"ROUND 4 CONF TABLE"*, *"Workroom Tables 6 SEATS"*). Same shape as the existing
>   `mirror` / `reference` / `price_inr` facets.
> - **No glyph ever labels itself with the zone's pax, and no tag ever counts chairs.** They are
>   different facts about different objects and the UI never conflates them.

The glyph therefore draws exactly `spec.seats` chairs. The *arrangement* of those chairs is a pure
function of the object's world dimensions and a world seat pitch — so both the count and the layout
are zoom-invariant by construction, not by threshold tuning.

### 3.6.1 Verification method — how to not fool yourself in the browser

Two rules, learned the hard way while verifying these slices.

1. **After any crash — WebGL especially — `goto` to the same URL + hash does NOT reload.** The page
   keeps a React root that has already unmounted itself, so the next thing you measure is a corpse.
   This produced a *false regression*: the app looked broken on a route that doesn't even mount the
   editor. Force an explicit `location.reload()` before drawing any conclusion. The dangerous version
   of this mistake is the inverse — a stale *working* DOM answering questions about code that no
   longer runs, i.e. a **false green**, which is the one that survives review.
2. **The console is a log of the session, not a description of current source.** During the same
   check it carried a `Cannot access 'docEmpty' before initialization` from an intermediate HMR build
   — a real-looking error for code that had already been fixed. Match error timestamps to the current
   build, or reload and re-read, before believing one.

### 3.7 Acceptance test for the whole spec

A zoom sweep at 8 / 20 / 45 / 110 / 300 px/m on the same plan, in both canvases, at DPR 1 and 2, in
which: no symbol changes shape; no symbol changes its countable content; no detail pops; every
hairline is crisp; and the two canvases are pixel-comparable for the same object.

---

## 4. Design language

### 4.1 The state of it, honestly

`CLAUDE.md` documents IBM Plex Mono + Space Grotesk + amber `#E8A13C`. The app ships Hanken Grotesk +
Schibsted Grotesk + blue `#2d5bd6`. **IBM Plex Mono is referenced 40 times and never loaded**; Space
Grotesk is referenced in two canvas draws and never loaded. Amber survives as a *second* accent on
toggles and the entire 3D toolbar. Three sources of truth, all disagreeing (audit #19).

**Decided: converge on what shipped.**

- **Hanken Grotesk** (UI) + **Schibsted Grotesk** (display) stay. They are coherent; nothing about
  them was the complaint.
- **IBM Plex Mono is loaded, subsetted** (digits, punctuation, basic Latin) and used for
  **numerics only** — dimensions, areas, counts, prices, coordinates, scale readouts. This is what
  CLAUDE.md's rule actually means: numbers read as an instrument, not as prose. It makes the 40
  existing Plex Mono call-sites correct instead of deleting them.
- **`CLAUDE.md` is corrected to state the shipped truth** — currently it documents a system the app
  does not have.

### 4.1.1 The canvas/UI colour boundary (rule, not preference)

> **Canvas colour is semantic data. UI colour is brand. The two palettes are disjoint and neither
> may cross into the other.**

**The canvas owns a closed palette, governed by what the object *is*:**

| Canvas token | Value | Means |
|---|---|---|
| `--canvas-unbound` | gray | no product bound — the default state of drawn geometry |
| `--canvas-bound` | `#2d5bd6` | a product is bound / the item is specified |
| `--canvas-live` | `#E8A13C` | live selection or hover — transient, pointer-driven |

That is the complete canvas palette for *state*. (Zone fills remain a separate, closed,
zone-type-keyed set — also data, also governed by what the object is.)

**The rules that follow, and are enforceable:**

1. **The UI accent token (`--accent`) must never appear on canvas geometry.** No `C.accent` on a
   wall, a symbol, a grip, or a tag. Canvas code reads only canvas tokens.
2. **Canvas state tokens must never appear in UI chrome.** A button is not amber because a selection
   is amber.
3. **`#2d5bd6` appearing in both is a coincidence of value, not a shared token.** `--accent` and
   `--canvas-bound` are separate declarations that happen to hold the same hex today; changing the
   brand accent must not recolour "bound" on the plan. They are never aliased.
4. **Amber has exactly one meaning: live selection/hover on canvas.** Its current uses as a UI accent
   — the Space step's *Heal gaps* toggle, the entire 3D `ViewerToolbar` active state — are
   **incorrect** and move to the shipped blue in slice 5.

The practical consequence: `EditorCanvas`'s `C` palette object and `DrawingCanvas`'s module colours
are the canvas palette's only readers, and they resolve canvas tokens — not `--accent`.

### 4.2 Token discipline

- **One token set, in `:root` in `styles.css`.** Extend it; never open a parallel one.
- **Zero hex literals in `.tsx`.** All 174 (audit #20) resolve to tokens. Canvas code — which cannot
  read CSS variables cheaply per frame — reads them once into the existing `C` palette object in
  `EditorCanvas.ts` and the equivalent in `DrawingCanvas.ts`, refreshed on theme change.
- **Zero `style={{…}}` for anything a class can express.** The ~93 inline objects across
  `CategoryPlan` (18), `ViewerToolbar` (16), `SelectionCard` (14), `LibraryPanel` (10), `Scene3D` (7),
  `CloudSyncPanel` (7), `LayersPanel` (6), `PlacePalette` (5), `Minimap` (4), `CandidateGallery` (4)
  become classes. Inline stays only for computed geometry (a flyout's `left/top`, a swatch's colour).
- **Delete vestigial fallbacks**: `var(--accent, #e8a13c)`, `var(--font-ui, 'Space Grotesk', …)`.

### 4.3 Rhythm, states, motion

- **Spacing** on a 4 px grid; section rhythm 8 / 12 / 16 / 24 / 32.
- **Type scale** (5 steps, no more): display 40/26 · title 20 · body 14 · label 12.5 · micro 11.
- **Every interactive element has all four states** — rest, hover, `:focus-visible` (2 px accent ring,
  1 px offset), active — plus `[disabled]` with a reason. Focus rings are currently inconsistent.
- **Empty states are invitations**, and each names the one next action (the landing's already does).
- **Loading states are honest**: generate shows candidate progress, not a spinner with no end.
- **Motion is minimal and purposeful**: 120 ms for state, 180 ms for panel entry, no page transitions.
  All of it inside `@media (prefers-reduced-motion: no-preference)`.

---

## 5. What gets deleted

Per `.claude/rules/no-bloat.md` §2 — each deletion lands in the same change as its replacement.

| Delete | Because |
|---|---|
| `.rail { overflow-y:auto; overflow-x:clip }` (`styles.css:264-265`) | superseded by M5's 6-tile dock; it is what clips the flyout |
| `ToolDock`'s `pos` state, `anchor()`, `openBtnRef`, 3 window listeners, `useLayoutEffect` (`:70-137`) | ~35 lines that exist only to work around the line above |
| `.tdock-flyout { position: fixed }` (`styles.css:370`) | flyout returns to `absolute` |
| `EDITOR_STEPS` + `.wizard-step.future` + the `@media (max-width:1120px)` hack | four steps that do not exist |
| `.space-preview { height: clamp(460px,74vh,880px) }` (`styles.css:3074`) | the `vh`-in-a-non-viewport bug |
| `.wizard-head` subtitle block | title + subtitle + guide said the same thing three times |
| `MIN_DETAIL`, `ALWAYS_DETAIL` and all 15 screen-px thresholds (`furniture.ts`) | replaced by world constants + continuous LOD |
| The four inert Canvas rows + the "display-only until per-canvas settings land" paragraph | shipped dead UI with an apology |
| `var(--accent, #e8a13c)`, `var(--font-ui, 'Space Grotesk', …)` fallbacks | point at a design system that no longer exists |
| 174 hex literals, ~93 inline style objects | duplicate existing tokens |
| Duplicate `data-testid="category-plan"` | breaks strict `getByTestId` |
| `clamp(t·k, min, max)` wall-stroke logic (`EditorCanvas.ts:2508-2521`) | replaced by poché + pen set |

**Wired, not deleted:** `ProjectRecord.chosenPlanId` — written and never read today; it becomes the
route home.

---

## 6. Constraints this proposal keeps

- Core stays the source of truth; no document logic moves into the renderer. Metres in the core,
  px/m in the frontend. §3.6 tightens this: seat count moves *into* the core rather than being
  re-derived by the renderer.
- **One new runtime dependency**, approved: `@fontsource/ibm-plex-mono`, self-hosted, subsetted to
  digits + punctuation + basic Latin, in the same family as the two font packages already present.
  No other dependency is added.
- Every existing `data-testid` is preserved. The one duplicate is resolved by *renaming the
  SpaceStep instance* and updating E2E in the same commit.
- `EditorCanvas`'s exported TS interfaces stay stable (`three/Scene3D` depends on them).
- `EditorView` stays mounted-not-unmounted in `AppShell`.
- `.dsource` and persisted records: additive only. Nothing here changes either.

---

## 7. Implementation order (Phase 2)

Each slice is independently verifiable and independently shippable.

1. **Layout + scroll law** — `#root` owns the viewport; wizard becomes a canvas-first split; `vh`
   purged below root; `.rail` overflow deleted and `ToolDock` simplified; Generate cards align and
   stop clipping; **`chosenPlanId` routes a finished project home**; **Program leads with its program
   builder** (both are layout-law consequences, not polish); **the `EDITOR_STEPS` tail is deleted**.
   *Verify: one scroll owner per screen, listed; plan fully visible at 1280×720, 1440×900, 1920×1080;
   flyout opens and is clickable; reopening a finished project lands in the editor.*
2. **Canvas symbology** — world/screen split; pen set + DPR snapping + wall poché; continuous LOD
   with countables derived from world size; `symbols.ts` shared by both canvases; tag visibility by
   world rules. *Verify: the §3.6 zoom sweep, both canvases, DPR 1 and 2, screenshots attached.*
3. **Navigation hierarchy** — persistent breadcrumb incl. the editor; truthful stepper with Property
   in and the editor tail out; inspector reduced to one contextual pane; panels follow the mode;
   disabled-with-reason everywhere; the apology deleted. *Verify: reach `#/` from every screen without
   the browser back button.*
4. **Workflow repairs** — `chosenPlanId` routes home; Program leads with the program builder; unit
   consistency; guarded delete; Save/Open disambiguated; Import warns; `ROADMAP.md` raster line
   corrected. *Verify: full naive walkthrough on the real DWG, recorded.*
5. **Polish** — typography decision applied (§4.1), tokens, states, empty/loading, motion with
   `prefers-reduced-motion`. *Verify: `make build` clean, `cargo test -p ds-core` green, E2E green,
   exports byte-compared against pre-change output.*
