# Circulation semantics + figure/ground — Phase 0 audit

**Status: SUBMITTED FOR APPROVAL. No implementation has begun.**
Date: 2026-08-05 · Branch: `main` @ `425232c` · Baseline: 157 Rust tests green, `pnpm typecheck` clean.

Evidence: `docs/evidence/circulation-audit/`. Live build on **port 5199** (never 5173 — the gate
board's own pre-flight refuses a foreign tree on that port, and parallel worktrees hold it).
Sample plate: `samples/furniture-plan.dxf` through the full wizard (Property → Space → confirm
inferred boundary → Program → Generate → **Open in editor**), candidate **A · Open**, seed as
generated. GEA 930.06 m² · NIA 908.04 m² · 101 workstations · efficiency 61.63 %.

---

## Headline

Three things this audit changes about the brief's premises:

1. **The figure/ground rule is further along than the brief assumes.** Paper/presentation output is
   *already fully correct* — white circulation, no circulation labels, no swatch. The editor canvas
   already suppresses the fill. **The live defect is TEXT, not fill:** 17 of the 24 zone tags drawn
   at rest name ground (9 × `CIRCULATION`, 8 × `CORRIDOR`) — 71 % of all in-plan text.
2. **The brief's stated symptom for thumbnails is stale.** Candidate cards do not "flood blue" —
   the semantic flip already happened. They flood **grey `#d8d8d8`** (measured: 1 226 px of the
   ZONE.Circulation fill in one card). The defect is real; the colour in the brief is not.
3. **Most of Phase 3 already exists.** `export/report.ts` already computes and renders the qbiq
   left summary strip (USF · Seats · Open Space · Offices · Conf Rooms · density · daylight ·
   privacy · efficiency), a 0/10/20/30 m scale bar, and an on-sheet legend. Phase 3 is a
   **promotion job**, not a build job.

And one decision the brief leaves open that dominates the whole workstream — see **E.1**.

---

## A. Live-build verification

| Surface | Circulation fill | "Circulation" text at rest | Selectable / hover | Legend swatch | Verdict |
|---|---|---|---|---|---|
| **Editor canvas** (`A1-editor-canvas.png`) | ground tint 2 %, **not** palette fill | **17 of 24 tags** — 9 `CIRCULATION`, 8 `CORRIDOR`; 7 carry an `m² · pax` line | yes, via `Editor.zone_at` | **yes** — grey `#d8d8d8` in PLAN KEY | ✗ text + legend |
| **Presentation / paper** (`A5-presentation-paper.png`) | none — pure white | none | n/a | **yes** (panel still lists it) | ✓ plan · ✗ panel |
| **Candidate cards** (`A3-candidate-gallery.png`, `A3-thumb-A-zoom.png`) | **grey `#d8d8d8`, 1 226 px** in card A | n/a (thumbs carry no text) | n/a | n/a | ✗ |
| **3D** (`A4-3d-studio.png`) | zone-tinted carpet assigned per `theme.floorByZone` (Studio `Circulation: 0xbcd2ea`) | n/a | n/a | n/a | ✗ structurally |
| **Print sheet** (`printPlan.renderPrintCanvas`, measured) | **1 px** at the composited circulation grey `#eaeaea` across 1 400 × 1 000 | none *on this plate* | n/a | ✓ `pdf.ts` ZONE KEY already excludes ground | ✓ measured |

Notes on how each was established, because "I looked at it" is not a measurement:

- **Tag count** is derived from `paint.ts::drawZones`' own emission rule (a zone earns a tag at
  `area ≥ 6 m²`, gains the metrics line at `≥ 12 m²`) applied to the core's `zone_stats()`. It is
  not a count off a screenshot.
- **Print sheet** was verified by pixel census of the canvas `renderPrintCanvas` actually returns,
  not by opening a PDF: full RGB histogram, then an explicit probe for `0.55·#d8d8d8 over white =
  #eaeaea`. One pixel is antialiasing. *Caveat:* this used a dynamic `import()` of
  `/src/export/printPlan.ts`. CLAUDE.md warns against that pattern because a second wasm copy
  throws — it is safe **here specifically** because `renderPrintCanvas` takes a plain state object
  and touches no wasm. A sheet screenshot was not captured; the census is the stronger evidence and
  stands in its place.
- **Selectability** was established from the code path (`EditorCanvas.ts:1289` → `ed.zone_at`),
  not from a synthetic click. Dispatched `PointerEvent`s did not reach the handler, so the
  behavioural claim rests on the source, and this is stated rather than glossed.

### Incidental findings (out of scope, reported not fixed)

- **The floating "Deliverable pack" dock covers the wizard's primary CTA.** At 1600 × 1000,
  `document.elementFromPoint()` at the centre of `[data-testid=wizard-next]` returns `pack-btn`.
  Next / Create project are **unclickable by mouse** on every wizard step at this viewport. Rects:
  next `x1373 y943 w131 h37`, pack `x1432 y945 w150 h37`. Reproduced on three separate steps.
- **A DXF uploaded but whose inferred boundary is never confirmed is silently discarded** — the
  Space step returns to its empty state and Generate reports "There's no floor plate to fit."
- Fonts log three `[fonts]` errors in this headless run (Hanken Grotesk / Schibsted Grotesk /
  IBM Plex Mono imported but not loaded). Almost certainly a headless-fetch artifact; the guard
  is doing its job. Not investigated.

---

## B. Render-path inventory

Every path that reads `ZONE[...]` or iterates `state.zones`, marked against the ground rule.

### Direct palette consumers

| Path | Reads | Honors ground rule | Note |
|---|---|---|---|
| `editor/paint.ts::drawZones` (:339–347) | `ZONE[z.zone_type]` | **✓ fill · ✗ tag** | `:342` `if (ground && groundTint === null) continue` skips fill *and* tag on paper. In the editor the tint is non-null, so it falls through and **pushes a `ZoneTag`** (`:407`). This one line is the whole live defect. |
| `editor/paint.ts::renderThumb` (:998) | `ZONE[z.zone_type] ?? ZONE.Core` | **✗** | No `groundZones` check at all. Measured grey flood. |
| `editor/stats.ts::ZONE_META` (:56–63) | `ZONE.*` | n/a (data) | Correct to keep Circulation — the Areas split is data, not the plan key. |
| `editor/planStyle.ts::legendEntries` (:607) | `ZONE[kind]` | **✗** | No ground exclusion. **One consumer only** — `StatsPanel.tsx:110` — so the fix is one line, one call site. |
| `export/printPlan.ts` zone fill (:229–255) | `PRINT_ZONE_FILL` | **✓** | Explicit `paper.groundZones.includes(...) continue`, with a comment naming the parity bug it closes. Measured clean. |
| `export/printPlan.ts` `roomLabels` (:262–268) | `z.label` | **✗ latent** | Draws `z.label.toUpperCase()` for **any** `Rect` zone over ~140 × 50 px with **no ground check**. Residual circulation is `Poly` so it escapes; the drawn network (`Corridor`/`Entry`/`Aisle`) is all `Rect`. On this plate only `Open Workspace (1)` and `Core 1` clear the size gate, so it is **not live here** — it is one plate or one zoom away from printing `CORRIDOR` on a deliverable. |
| `export/pdf.ts` ZONE KEY (:218–222) | `PRINT_ZONE_FILL` | **✓** | Already excludes ground zones. The exporter is *more correct than the app's own panel*. |
| `export/report.ts::altPage` legend (:583) | `a.zoneTypes` ← `LEGEND_ORDER` (:100–109) | **✗** | `LEGEND_ORDER` lists `'Circulation'` explicitly, commented "qbiq lists rooms first, circulation last". **A surface the brief does not list.** |
| `export/roomThumbs.ts` (:180) | `ZONE_META[zone?.zone_type ?? 'Circulation']` | ✗ (defaults *to* Circulation) | Needs review under the new type. |
| `three/Viewer3D.ts::buildZonePlate` (:1153–1157) | `zoneFloorMats` ← `theme.floorByZone` | **✗** | Every zone type gets a tinted carpet, Circulation included, in all four presets. |
| `three/ViewerToolbar.tsx` (:249) | `t.floorByZone.Circulation` | n/a | Uses it as a **theme preview swatch**. Deleting the key would break this — change the *material assignment*, not the table. |

### Blast radius of adding a `ZoneType` variant — the real risk

Adding `Unassigned` touches ~40 sites in two classes, and only one class is safe:

- **5 exhaustive `Record<ZoneType, …>` maps** — `types/doc.ts:154`, `three/theme.ts:25`,
  `export/report.ts:113`, `ai/roomResolver.ts:33`, `editor/stats.ts:56`. **`tsc` catches every
  one.** These are fine.
- **~35 bare string comparisons against `'Circulation'`** — `tsc` catches **none**. The dangerous
  subset is the *semantic exclusions*, where `!== 'Circulation'` means "is a real room" and will
  silently start admitting `Unassigned`:
  `export/finishSchedule.ts:301` · `export/roomNaming.ts:82` · `export/sheetSet.ts:836,1445` ·
  `export/servicesSheets.ts:359` · `export/qtoWorkbook.ts:224` · `export/planGraphic.ts:80,222` ·
  `export/report.ts:99` (`OPEN_ZONE_TYPES`) · `ai/intentParser.ts:187,204,235,238,263`.
  Left alone, **an unassigned dead pocket acquires a finish schedule row, a room name, a sheet
  entry and an AI "which room?" option.**

  **Finding:** the fix is not 35 hand-edits. It is one predicate in `types/doc.ts` —
  `isGroundZone(t)` / `isProgramZone(t)` — with the 35 sites routed through it, so the next zone
  type added is one edit and not thirty-five. This is `.claude/rules/no-bloat.md` §1 applied to a
  discriminator instead of a function.

---

## C. Core inventory

### Where Circulation zones are born — five sites, not two

| # | Site | Class | Emits |
|---|---|---|---|
| 1 | `layout.rs:626–660` residual pass | **residual** | `decompose_plate(poly, 0.25, 0.5, 0.3, &used)`, 0.25 m inset, label `"Circulation"`. Gated `!single_region && !use_oriented_field`. |
| 2 | `layout/conform.rs:540` `fill_untyped_as_circulation` | **residual** | Melts residual rects **and** untyped wedges into merged wall-following `Poly`s. `CELL 0.25` · `MIN_AREA 0.5` · `SNAP 0.3` · `OVERLAP_TOL 0.08`. |
| 3 | `layout/regions.rs` perimeter ring + spine | **network** | `RectRing` / drawn spine, labels `Corridor`. |
| 4 | drawn connectors | **network** | labels `Entry`, `Aisle`. |
| 5 | **`document.rs:115` `zone_index_at`** | — | **Not a producer — a consumer with a hardcoded `ZoneType::Circulation` tie-break** (`:122–128`): circulation loses to any containing non-circulation zone. |

**Site 5 is the highest-risk item in Phase 1 and the brief does not mention it.** It governs
`reassign_components` — which zone owns each desk. If `Unassigned` is not given the same
loses-every-tie treatment, component bucketing changes, `component_ids` change, and the workstation
count can move. That is a direct G7 violation arriving through a file nobody was told to edit.

### Measured split on the sample plate

From the core's own `zone_stats()` (plate-clipped areas), zones joined to labels via `state()`:

| Class | Zones | m² | % NIA |
|---|---|---|---|
| Network — `Corridor` | 13 | 118.95 | 13.10 |
| Network — `Aisle` | 2 | 4.49 | 0.49 |
| Network — `Entry` | 1 | 1.80 | 0.20 |
| **Network subtotal** | **16** | **125.23** | **13.79** |
| **Residual — label `"Circulation"`** | **10** | **170.66** | **18.79** |
| **Circulation total** | **26** | **295.89** | **32.59** |

Other zones: Workspace 6 / 454.78 · Core 3 / 52.51 · ClosedOffice 13 / 46.72 · Meeting 2 / 34.48 ·
Amenity 4 / 23.66.

**Residual is 57.7 % of all circulation, 18.8 % of NIA, 18.3 % of GEA.** The largest single residual
poly is **80.4 m²** — the whole upper-right wing, labelled `CIRCULATION 80 m²` on the canvas. It is
not a corridor by any reading.

**Fragmentation is already solved.** All 10 residual zones are `Poly` — `fill_untyped_as_circulation`
already merged them. Brief §2.7's "rect confetti" concern is **not live**; hover noise is 10 objects,
not 50. Extending the same merge to `Unassigned` (brief 1.2) preserves this rather than creating it.

**A BOMA finding that affects the fold rule (§1.4).** Current Circulation = 32.6 % of NIA, inside
BOMA's 25–40 % band — *but only because residual is folded in*. Honest network circulation is
**13.8 %, below the band**. That is not necessarily a defect in the plan: BOMA *secondary*
circulation (aisles between workstations) lives **inside** our Workspace polygons and is never a
zone at all. So DSource's "Circulation" row is not BOMA circulation in either direction, and any
doc comment citing the 25–40 % band as a target would be citing a number we do not measure.
**Recommendation: cite the band as context, never as a target, and say which components we exclude.**

### The label seam — your question, answered

**The `label == "Circulation"` string seam is not robust enough to carry the reclassification. It
should be promoted to a structural field in Phase 1.**

Evidence:

- The seam is load-bearing in exactly one place today (`conform.rs:556–557`, `is_residual`) and it
  works *because* both sides are written three lines apart in one file.
- It is **already fragile in a way that is invisible**: nothing prevents a user renaming a zone.
  `RoomTools.tsx:14` offers `Circulation` as a room type in the UI, and zone labels are editable.
  A user who renames a drawn `Corridor` to `Circulation` **converts network into residual** and it
  will be melted by the next conform pass. A user who renames a residual poly to anything else
  makes it un-meltable. Neither is detectable.
- Under Phase 1 the seam stops being local: the classifier, the merge, the score penalty, the fold
  boundary and the invariant test all need to ask "is this residual?". Five consumers of a string
  literal, in four files, is the shape that rots.

**Proposed shape:** `Zone.origin: ZoneOrigin { Drawn, Residual }` (serde-additive, defaults to
`Drawn` so existing `.dsource` files load unchanged). `label` returns to being a display string.
`is_residual` becomes `z.origin == Residual`. This also gives the TS side an honest discriminator
instead of a string compare, and it is what lets `Unassigned` and `Circulation` share a merge path
without either one string-matching the other.

Cost: one field, one serde default, ~6 call sites. Cheaper than the third time this seam is asked
to carry a semantic it was not designed for.

### C-i. `walking_area_is_unified_no_white_floor` — decided, per your ruling

`crates/ds-core/src/layout/tests.rs:3646`. Current assertions on 6 seeds:
(a) untyped white floor ≤ 5 %; (b) NIA ≤ GEA; (c) residual fragments collapse to a handful of
merged `Poly`s, **filtered on `zone_type == Circulation && label == "Circulation"`**.

Check (c)'s filter goes **vacuous** under Phase 1 — the residual class is renamed out from under it,
the filter matches zero zones, and a "handful or fewer" bound passes trivially. Green, guarding
nothing.

**Ruling recorded as decided (not open): rewrite, do not delete.** The invariant's spirit — *no
untyped floor* — survives verbatim; only the vocabulary widens from "circulation" to
"circulation ∪ unassigned". The rewritten assertions are pre-registered in **E.4** below, before any
implementation, so the test is not shaped by the code it exists to check. It lands **with** the
Phase 1 commit.

---

## D. Walkability ground truth — can `circulation.rs` be reused?

**Yes for the arithmetic. No for the semantics, and that gap is the real design question.**

### What already exists and is directly reusable

| Machinery | Location | Reusable for the ≥1.2 m test? |
|---|---|---|
| Occupancy grid over padded wall bbox | `build_grid` (:462) | **Yes** — walls + components rasterised, doors stamped *free*, loose seating (`Chair`) excluded per ADA §403. |
| Chamfer distance transform | `distance_transform` (:697) | **Yes, exactly.** Clear width at a cell = `2 · dt · cell`. This *is* the 1.2 m test. |
| 4-/8-connected component labelling | `label_free_regions` (:597) | **Yes** — gives "one connected network". |
| Entry reachability from the door | `entry_reachable_fraction` (:653) | **Yes** — the pattern for "connected to the network", already written. |
| Saddle-point chokepoint detection | `choke_axis` (:865), `separates_area` (:776) | Available; probably more than 1.2 needs. |

**No second geometry system is required.** Everything the brief asks for exists.

### Two obstacles, both real, neither fatal

**1. Visibility.** `Grid`, `build_grid`, `distance_transform`, `label_free_regions` are all
module-private (`fn`, `struct` — confirmed by symbol scan). `layout/conform.rs` cannot call them.

The minimal change is `fn` → `pub(crate) fn` on three items plus `pub(crate) struct Grid`. **No
signature changes, no semantic changes, nothing crosses the wasm boundary.** I do not think that
meets brief §7's escalation trigger ("requires restructuring its public surface") — the *public*
surface (`evaluate`, `CirculationConfig`, `CirculationScore`) is untouched. **But it is a judgment
call on your escalation clause, so I am flagging it rather than assuming: please confirm
`pub(crate)` widening is acceptable, or say you want a different arrangement.**

**2. The masks mean different things — this is the substantive finding.**

| | `circulation.rs` grid | `conform.rs` walking mask |
|---|---|---|
| Blocked by | walls + components | walls + components **+ every non-residual zone** |
| A meeting room's floor is | **free** | blocked (owned) |
| Cell size | 0.15 m (default) | 0.25 m |
| Origin | padded wall bbox | plate bbox |

So `circulation.rs` answers *"can a body physically stand and walk here?"* — its free space runs
**through rooms**. `conform.rs` answers *"is this floor unclaimed?"*. The brief's test —
"4-connected to the walking network through cells of ≥ 1.2 m clear width" — needs a **third** mask:
free *and* unclaimed, i.e. `circulation.rs`'s obstacle rasterisation **plus** zone ownership.

Otherwise a dead pocket that happens to abut a meeting room would be judged "connected to the
network" **through the meeting room** and promoted to Circulation. That is a false negative for the
whole workstream, and it is not visible in any screenshot.

**Minimal proposal:** add `pub(crate) fn walkable_grid(doc, cfg, blocking_zones: &[usize]) -> Grid`
to `circulation.rs` — one function, one extra rasterisation step over the existing `build_grid`,
reusing `stamp_footprint`'s established pattern. `evaluate()` calls it with an empty slice and is
**byte-identical** (this must be asserted, not assumed — see E.5). `conform.rs` calls it with the
non-residual zone indices. One grid implementation, two masks, no duplicated geometry.

---

## E. Pre-registered predictions

Stated **before** implementation. Anything added after the fact is advisory, not binding.

### E.1 — THE OPEN DECISION, and it dominates everything

**The brief specifies a 1.2 m threshold but not what it is measured over, and the two defensible
readings differ by an order of magnitude.**

Measured now, per residual poly (0.1 m chamfer DT over each poly, clear width = `2·dt`):

| zone | m² | widest inscribed point | fraction of its area at ≥ 1.2 m |
|---|---|---|---|
| 847 | 80.4 | 4.4 m | 0.45 |
| 853 | 18.4 | 1.2 m | 0.02 |
| 849 | 13.6 | 1.8 m | 0.11 |
| 852 | 11.5 | 2.4 m | 0.27 |
| 848 | 10.8 | 3.0 m | 0.47 |
| 854 | 8.7 | 1.4 m | 0.04 |
| 810 | 7.5 | 2.0 m | 0.36 |
| 851 | 7.4 | 1.8 m | 0.31 |
| 812 | 7.2 | 1.0 m | **0.00** |
| 850 | 5.1 | 0.6 m | **0.00** |

- **Reading A — "the pocket's widest point clears 1.2 m":** 8 of 10 pass → **Unassigned ≈ 12.3 m²**
  (1.3 % of GEA). Almost nothing changes. The 80 m² wing stays "Circulation".
- **Reading B — "most of the pocket sits on a ≥ 1.2 m path":** only zones 847 and 848 clear 45 % →
  **Unassigned ≈ 150 m²** (16 % of GEA). Efficiency drops hard, the plan reads honestly.

Reading A makes the workstream cosmetic. Reading B delivers what the user actually asked for.
**I recommend B, quantified as: a pocket is Circulation iff ≥ 50 % of its area lies on cells of
clear width ≥ 1.2 m AND it is 4-connected to the drawn network through such cells.** Pre-registering
the 50 % now, before seeing what it produces.

**This is an escalation under brief §7 ("the classification changes more than predicted") in
advance rather than after the fact. Please rule on A vs B, or confirm the 50 % figure.** Everything
below assumes B @ 50 %.

### E.2 — Quantitative predictions (Reading B, 50 %)

| Quantity | Now | Predicted after Phase 1 | Direction is binding |
|---|---|---|---|
| Circulation m² | 295.89 | 125–170 | ↓ |
| — of which network | 125.23 | 125.23 (unchanged) | = |
| Unassigned m² | 0 | **130–160** | ↑ |
| `efficiency_pct` | 61.63 | **57–60** | **↓ or =, never ↑** |
| Workstations | 101 | **101 exactly** | **=** |
| NIA | 908.04 | 908.04 ± 0.5 | = |
| NIA ≤ GEA | holds | holds | = |
| Residual zone count | 10 | 10 ± 3 | ≈ |

If efficiency *rises*, waste has been hidden again and Phase 1 is wrong.

### E.3 — Which gates I expect to be hardest

1. **G6 (efficiency must not increase)** — not because it is hard to satisfy, but because the fold
   rule (§1.4) makes it easy to satisfy *dishonestly*. Folding Unassigned into Circulation for
   publication while efficiency reads the unfolded number is the correct design and a one-character
   mistake away from the wrong one.
2. **G7 (workstation count unchanged)** — because of `zone_index_at` (site 5, §C). I predict this
   breaks on first run if that tie-break is not extended.
3. **G2 (hatch in editor, nothing on paper)** — needs a real pixel diff of the same view in two
   profiles; "looks white" is not a measurement.
4. **G10 (naive-user walkthrough)** — the only gate that cannot be automated and the only one that
   answers the question the user actually asked.

### E.4 — Rewritten invariant, pre-registered (per your ruling)

`walking_area_is_unified_no_white_floor`, over the same 6 seeds and fixture plate:

```
(a) untyped_floor_frac(&doc) <= 0.05                       // UNCHANGED bound
(b) nia <= gea + 1e-6                                       // UNCHANGED
(c) fragmentation bound applied to Circulation ∪ Unassigned // WIDENED
(d) NON-VACUITY GUARD — new, and the point of the rewrite:
       assert!(residual_count > 0,
         "seed {seed}: the residual filter matched NOTHING — the class was renamed \
          out from under this test and checks (a)/(c) are now vacuous");
    where residual_count counts zones with origin == Residual
    (Circulation or Unassigned), on a fixture plate KNOWN to produce them.
(e) coverage is preserved, not merely re-labelled:
       circulation_m2 + unassigned_m2  ==  old_circulation_m2  ± 1.0 m²
    — the reclassification MOVES floor between buckets; it must not LOSE any.
```

(d) is the assertion that would have caught the original hazard. (e) is added because a vacuity
guard alone would not catch floor silently vanishing from both buckets.

Test name: keep it. `no_white_floor` still describes the property.

### E.5 — Independence proofs to be delivered with the code

Per `.claude/rules/gate-independence.md`, each ships **with** its phase, in a disposable worktree,
never mutating the tree under test:

- **`walkable_grid` refactor:** `evaluate()`'s output is **byte-identical** before/after on the
  fixture set. Not "still passes" — identical bytes.
- **The classifier:** falsify with a hand-built plate carrying one 0.9 m dead pocket (must be
  `Unassigned`) and one 1.5 m corridor-connected pocket (must be `Circulation`). Written and
  watched to fail **before** the classifier exists.
- **Ground-rule gates:** sabotage by forcing `groundZones: []` and prove each gate goes red.

---

## F. Design proposal

### Phase 1 — core (one commit)

| File | Change |
|---|---|
| `zone.rs` | `ZoneType::Unassigned` (serde `"Unassigned"`); `capacity()` → 0; **`Zone.origin: ZoneOrigin`** (§C, serde-additive, default `Drawn`) |
| `circulation.rs` | 3 items → `pub(crate)`; new `walkable_grid(doc, cfg, blocking_zones)`; `evaluate()` byte-identical |
| `layout.rs` (:626) | residual pass emits `origin: Residual`, type decided by the classifier |
| `layout/conform.rs` (:540) | `is_residual` → `z.origin == Residual`; merge extended over both types; classify after merge (a pocket's width is a property of the *merged* shape) |
| **`document.rs` (:115)** | **tie-break extended: `Unassigned` loses to every specific zone, exactly as `Circulation` does** |
| `layout/score.rs` | `unassigned_penalty`, weight pre-registered below |
| `lib.rs` | `Metrics`: Unassigned own bucket; counts in NIA, never in usable; `fold_unassigned: bool` at the **serialization boundary only** |
| `layout/tests.rs` | the E.4 rewrite + 5 new tests per brief 1.5 |

**Score weight, pre-registered:** `unassigned_penalty = 0.10 × (unassigned_m² / plate_m²) × 100`,
entering `total` at weight 0.10. On the current plate that is ≈ 1.6 points — enough to break ties
toward less waste, not enough to reorder A/B/C (88/86/87). **If it reorders the winner, I stop and
report before tuning**, per §7.

### Phase 2 — renderers (one commit each, before/after screenshots)

`2.1` `planStyle.ts` — `groundZones: ['Circulation','Unassigned']`, editor-only hatch via the
existing `FillStyle` hatch union (no fourth kind). `2.2` `paint.ts:342` — do not push a `ZoneTag`
for ground zones; selection pill still allowed. **The single highest-value change in the
workstream.** `2.3` `renderThumb` — apply the rule. `2.4` `Viewer3D::buildZonePlate` — neutral
material for ground; **`theme.floorByZone` keeps its keys** (ViewerToolbar swatch). `2.5`
`printPlan.ts:262` — add the missing ground check to `roomLabels` (latent, §B). `2.6`
`legendEntries` — exclude ground; **also `report.ts` `LEGEND_ORDER`**, which the brief missed.
`2.7` — verification only; fragmentation is already solved (§C). `2.8` `style-gate.mjs` extension.
**Plus, ahead of all of them: the `isGroundZone` predicate + the ~35 string-comparison sites (§B).**

### Phase 3 — promotion, not construction

`report.ts` already has the KPI rail, the scale bar, the legend, and `daylightPct` / `privacyPct` /
`efficiencyPct` with documented definitions (`report.ts:140–151`). Phase 3 extracts those into a
shared module and renders them on-screen, adding **only** what is genuinely missing: the three
benchmark bars and the per-batch "average" tick.

**Do not invent new Daylight/Privacy definitions.** `LayoutScore.daylight` (Rust,
`DAYLIGHT_REACH_M = 5.0`) and `report.ts` (`DAYLIGHT_RADIUS_M = 5`) already agree — and that
agreement is an **unregistered mirror**, exactly the class CLAUDE.md requires be pinned.
`coreParity.test.mjs` currently checks only `SEAT_PITCH_M`, `HEAD_SEAT_MIN_M` and the SpaceKind
union. **Register the daylight constant there in Phase 3.** (Pre-existing defect, found while
auditing, not caused by this workstream.)

### Phase 4 — gates: map onto the existing harness

**Name collision, and it matters.** `scripts/gates/run-all.sh` already owns `G1–G12` for the
deliverable pack. The brief's G1–G10 are a different set. Reusing the numbers makes the board
ambiguous and would make `GATE_SELFTEST`'s scoreboard-line matching unreliable.

**Proposal — follow the `sheets/` precedent exactly.** `sheets/` has its own board (`SG1–SG6`,
`sheets/run-all.mjs`) folded into the main board as one row (`G12`). Do the same:

- `scripts/gates/circulation/run-all.mjs`, gates **`C1–C10`**, own scoreboard, same
  `FAIL`-on-exit-code-**or**-scoreboard-line counting the main runner uses.
- Folded into `run-all.sh` as one new row, `G13`, invoked
  `node $HERE/circulation/run-all.mjs --no-produce --as-gate G13 C1 … C10`.
- Add a lying gate to the circulation board too (the `GSELF` pattern) — a sub-board that cannot
  detect its own false green is the exact meta-failure the rules file records.

| Brief gate | Home | Automatable |
|---|---|---|
| G1 white ground · zero labels · still selectable | `C1` | yes — tag census from `zone_stats`, not a screenshot |
| G2 hatch in editor only | `C2` | yes — `pixdiff.py` on the same view in both profiles |
| G3 thumbnails | `C3` | yes — colour census of `renderThumb` (method proven in §A) |
| G4 3D neutral floors | `C4` | yes — assert material identity per zone type, all 4 themes |
| G5 legend program-only | `C5` | yes — `legendEntries` + `pdf.ts` + `report.ts` |
| G6 areas split · fold · efficiency ≤ | `C6` | yes — re-derive from core state, never from the workbook |
| G7 workstations · tests · typecheck · determinism | `C7` | yes |
| G8 metrics card matches core | `C8` | yes — spot-check density = NIA/pax independently |
| G9 scale bar | `C9` | yes — measure against a known wall dimension from core state |
| **G10 naive-user walkthrough** | **no home** | **no — written note in `docs/evidence/`, by design** |

Nine of ten automate. G10 stays a human artifact, which is correct: it is the only one that
measures whether the plan *reads* right.

---

## Conflicts with the brief — declared, not silently resolved

1. **§2.3** "candidate cards currently show flooded circulation … no flooded blue" — stale.
   They flood **grey `#d8d8d8`**. Defect real, colour wrong.
2. **§2** "several render paths bypass the rule — thumbnails, zone tags, possibly 3D floors and PDF
   layers" — PDF zone fill is **correct and measured correct**; the PDF's own legend is *more*
   correct than the app panel. The unlisted misses are `report.ts::LEGEND_ORDER` and
   `printPlan.ts` `roomLabels`.
3. **§2.7** "with conform now merging Unassigned regions … negative space should be at most a few
   selectable polys" — already true (10 `Poly`s). Nothing to fix; verify only.
4. **§3.4** "these are OUR definitions … we design our own" — they are already designed,
   implemented and documented in `report.ts`. Reuse, do not redesign. (`.claude/rules/no-bloat.md`)
5. **§1 / §D** the brief assumes `circulation.rs`'s classification is reusable as-is. Its mask is
   **free space including room interiors**, not the walking network. Reusable, but only with the
   third mask described in §D.
6. **§7 escalation, raised now rather than later:** the 1.2 m threshold's *measure* is unspecified
   and swings the result 12 m² ↔ 150 m² (E.1).

---

## Requests before Phase 1 starts

1. **Rule on E.1** — Reading A or B, and confirm or change the 50 % figure. *(blocking)*
2. **Confirm** `pub(crate)` widening in `circulation.rs` is not a §7 escalation. *(blocking)*
3. **Approve** promoting the label seam to `Zone.origin` (§C). *(blocking — it changes Phase 1's diff)*
4. **Approve** the `isGroundZone` predicate + 35-site sweep as part of Phase 1, not deferred (§B).
5. **Note** the two incidental defects (pack dock over the wizard CTA; unconfirmed-boundary data
   loss) — file separately or ignore, but they are not mine to fix here.

**STOP. Awaiting approval.**

---

# Phase 1 — result (implementation landed)

Approved 2026-08-06 with Reading B @ 50%, the connectivity conjunct kept, `pub(crate)` widening
sanctioned, `Zone.origin` approved (`Residual` generator-only), and the `isGroundZone` sweep deferred
to a pre-commit ahead of Phase 2.

**Suite: 165 Rust tests green (157 + 8 new), `pnpm typecheck` clean.**

## Measured, on the real DXF plate, through the wizard (candidate A · Open)

| | Phase 0 | Phase 1 | |
|---|---|---|---|
| GEA / NIA | 930.06 / 908.04 | 930.06 / 908.04 | unchanged |
| Workstations | 101 | **101** | **G7 holds** |
| Circulation (honest) | 26 z / 295.89 m² | 20 z / 231.43 m² | |
| Unassigned (honest) | — | **6 z / 64.47 m²** | |
| Circulation (published) | 295.89 m² | **295.89 m²** | **fold is exact** |
| `efficiency_pct` | 61.63 | **61.63** | see below |
| Candidate A score | 88/100 | 87/100 | the waste penalty |

Conservation: 231.43 + 64.47 = 295.90 ≈ 295.89 — no floor lost, only moved. The published projection
reproduces the Phase 0 number **exactly**, which is the fold working.

## Two of my predictions were falsified. Both matter.

**1. `efficiency_pct` did not move (predicted 57–60, ↓).** It is 61.63 before and after, and the
reason is structural: `usable_area` already excluded `Circulation`, so renaming part of that floor
`Unassigned` changes the label, not the arithmetic. E.2 reasoned as though unassigned floor were
being newly removed from usable; it was never in usable.

The G6 direction constraint ("must not increase") holds. But the honest conclusion is sharper:
**efficiency does not measure waste and never did** — a plan that leaves 170 m² dead scores the same
as one that uses it, because both count as "not usable". After Phase 1 the *only* term that sees
waste is the score penalty. If efficiency should reflect it, that is a separate definitional change
(a utilisation ratio over unassigned-excluded NIA), not something Phase 1 delivers. **Flagging, not
fixing.**

**2. Unassigned came out at 64.47 m², not the predicted 130–160 — and not the "essentially all
170 m²" the approval anticipated.** 106.20 m² of residual floor stayed Circulation.

The cause is a methodology error in my own §E.1 table, and it is worth naming precisely: that table
computed each pocket's distance transform **within the pocket alone**, so clearance was truncated at
the pocket's own boundary. The classifier computes it over the **whole walkable mask**, where a
pocket adjoining a 2 m corridor measures the clear space a person actually has. Real pockets are
therefore *wider* than §E.1 estimated, and more of them clear 50% than that table implied.

The ruling (Reading B @ 50%, no nudging) is unaffected and was applied exactly as ratified. The
arithmetic behind its predicted consequence was mine, and it was wrong by roughly 2×.

## Independence proofs (§E.5), all run in a disposable worktree

| proof | method | result |
|---|---|---|
| `evaluate()` unchanged | identical probe appended to pre- and post-change trees, 3 hand-built fixtures (one carrying zones, which `evaluate` must ignore), full `CirculationScore` JSON | **byte-identical**, 1196 B each, md5 `ff6d20ff…` |
| width/extent conjunct | `CIRC_WIDE_FRACTION` 0.5 → 0.0 | `dead_pocket_below_min_clear_width_is_unassigned` **FAILS** ✓ |
| connectivity conjunct | `connected` forced `true` | `wide_but_sealed_pocket_is_unassigned` **FAILS** ✓ |
| non-vacuity guard | classifier re-flags residual zones `Drawn` (the class renamed away) | `walking_area_is_unified_no_white_floor` **FAILS** naming the hazard ✓ |
| `zone_index_at` tie-break | reverted to `== Circulation` | **0 failures — prediction falsified** |

The first byte-identity run produced two empty files and reported "identical". It was caught only
because the check printed byte counts; the probe had failed to compile. A vacuous pass is the exact
failure this file legislates against, and it took one line of `wc -c` to catch — recorded here
because the next person writing an identity proof should print the size too.

**The tie-break result deserves its own line.** §C called it "the highest-risk item in Phase 1" and
E.3 predicted G7 would break without it. Reverting it broke nothing, because `conform` emits residual
pockets with corner clearance against every other zone: they are strictly disjoint by construction, so
a desk centre inside an `Unassigned` poly is inside no other zone and the tie-break never fires. The
line is kept as defence for the day that disjointness is relaxed, and its comment now says so instead
of claiming a consequence that does not hold.

## Scope moved, declared

One line of Phase 2.6 — `legendEntries` excluding ground zones — was pulled into Phase 1. Without it,
the moment the core emitted `Unassigned` the Plan Key sprouted an "Unassigned" swatch: a visible
regression shipped deliberately and fixed a commit later. Phase 2.6 keeps the rest of its scope
(`stats.ts` ordering, `report.ts` `LEGEND_ORDER`, the on-sheet legend). Verified in-browser: the Plan
Key now lists program zones only.

Editor tags currently read `UNASSIGNED` where they read `CIRCULATION` — a truthful relabel, not a
regression. Phase 2.2 removes ground tags entirely.

## Also found, pre-existing, NOT fixed here

`web/src/ai/suggestProgram.test.mjs` **crashes at HEAD** (verified by stashing this work): it parses
`pub const OPEN_SHARE` out of `crates/ds-core/src/layout.rs`, but the constant now lives in
`layout/program.rs:581`. The regex returns `null` and the test dies before asserting anything — a
parity guard that has been guarding nothing since the split at `c15451b`. One-line fix, deliberately
left out of a semantic commit; file separately.
