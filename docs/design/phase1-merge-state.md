# Phase 1 merge state — PARKED, merge deliberately left OPEN

**Do not abort.** 17 judgment resolutions live in the index. `git merge --abort`
now destroys real work, which is why this file exists instead.

## Verifiable predicates (with the command that checks each)

| predicate | check | expected |
|---|---|---|
| a merge is open | `test -f .git/MERGE_HEAD && echo open` | `open` |
| merging ui-fixes | `git rev-parse --short MERGE_HEAD` | `545635a` |
| branch | `git rev-parse --abbrev-ref HEAD` | `integration/all` |
| base commit | `git rev-parse --short HEAD` | `8cc3ee2` |
| resolutions staged | `git diff --cached --name-only \| wc -l` | 130 |
| still conflicted | `git diff --name-only --diff-filter=U \| wc -l` | **6** |

The previous handoff asserted "clean tree, no merge open" as fact. It was an
assumption about an abort that never ran, and this session opened on a surprise.
**A handoff states predicates plus the command that checks them** — hence the
table above. State travels with the repo, not with a transcript.

## Resolved (17) — one line each

| path | resolution |
|---|---|
| `web/src/wasm/ds_core_bg.wasm` | `--ours`. Generated; **regen from merged Rust is still owed** as its own commit. |
| `scripts/pixdiff.py` | `--theirs` — ui-fixes is its origin; the copy on `integration/all` came from there. |
| `CLAUDE.md` | Union. R5 amber block wins. **ui-fixes' typography correction wins over main's**: it proved Space Grotesk was never loaded. Test line restated as the by-name floor. |
| `web/src/styles.css` | R5 vocabulary throughout; disjoint rule blocks unioned; `--canvas-live`/`-ink` **retired** (R3′.3) with `--review-ink` declared in their place. |
| `web/src/ui/LayersPanel.tsx` | `--theirs`. Class-modifier migration supersedes the inline style dictionaries my R5 edits touched. |
| `web/src/ui/CategoryPlan.tsx` | `--theirs`, same reason. All referenced classes verified present in merged CSS. |
| `web/src/import/PlacePalette.tsx` | `--theirs`, same reason (also drops the never-loaded font stack). |
| `web/src/ui/LibraryPanel.tsx` | `--theirs`; `.lib-row.is-selected` re-pointed to `--accent-selection-soft` (R5: library selection is live selection). |
| `web/src/ui/CandidateGallery.tsx` | ui-fixes' structure + main's `types/program` import. **AI badge restored to action-amber** (see trap below). |
| `web/src/three/ViewerToolbar.tsx` | R5 colour + ui-fixes' tokens. Their side had a raw decimal amber shadow beside a blue gradient — inconsistent and a univalence failure. |
| `web/src/ai/refine.ts` | main's `types/` paths + ui-fixes' `CORRIDOR_M`. |
| `web/src/shell/steps/ProgramStep.tsx` | main's `types/doc` + ui-fixes' `openShare`. |
| `web/src/three/Scene3D.tsx` | main's `types/doc` + ui-fixes' `MONO, UI`. |
| `web/src/three/Minimap.tsx` | union: `MINIMAP` + `MONO`. |
| `web/src/import/testfit.ts` | union: ui-fixes' one-owner `PLATE_WALL_THICKNESS_M` + main's plate-provenance line. |
| `web/src/export/pdf.ts` | R2: calls `symbols.ts`, not `furniture.ts`; main's `types/` paths. |
| `web/src/export/report.ts` | union: `ACCENT_AMBER` (an R5.2 DEFERRED entry) + `SF_PER_M2`. |

Governing rule for the import family, applied 7×: **ui-fixes imports types from
the pre-refactor `EditorCanvas`; main extracted them to `types/`.** Main's paths
win (CLAUDE.md), ui-fixes' new symbols are kept.

## Remaining (6), with known hazards

| path | hunks | hazard |
|---|---|---|
| `web/src/editor/EditorCanvas.ts` | 10 | The re-siting. main split into paint/interaction/search; ui-fixes edited pre-split paths. The listener `active` flag lands in whichever module owns window-listener binding. **Required proof:** reproduce the defect (hidden EditorView + Delete, ⌘K over the wizard) and confirm no cross-surface firing. Structural fix — a hidden EditorView does not listen — not a per-handler guard. |
| `web/src/editor/furniture.ts` | delete/modify | **Not a rename.** `drawFurnitureSymbol(ctx, o)` takes SCREEN coords; `drawSymbol(ctx, s, ink, v)` takes WORLD dims + view. Both call sites (`paint.ts`, `drawingRender.ts`) grow a coordinate conversion — **Face 9's re-entry point.** `strokePx` never mentions DPR, through the conversion. furniture.ts must not exist at phase exit. |
| `web/src/import/DrawingCanvas.ts` | 4 | See the silent regression below. Constants belong in `drawingScene.ts` (main's split); resolve toward that, deleting the pre-split copies. |
| `crates/ds-core/src/lib.rs` | 1 | Union of ui-fixes' `seats`/`open_share()`/`door_depth()`/`door_width()`/`density_score()`/`backfill_seats()` with main's layout. `revision()` scanner will go red naming new `&mut self` mutators — that is it working. **Known miss:** its regex fails on multi-line signatures; inspect every new mutator manually regardless of verdict. |
| `crates/ds-core/src/layout.rs` | 2 | main decomposed it into program/seed/grid/regions/jobs/place/emit/packing/conform/score. Re-site ui-fixes' edits into the right submodule. `golden_generate_output_is_frozen` is the sensor. |
| `web/src/App.tsx` | 1 | Import union, same family rule as the other 7. |

## Findings from this session

### 1. A SILENT REGRESSION the sensor caught, with no conflict marker

`DrawingCanvas.ts` lines 78–80, 108, 111 now carry raw amber
(`'#E8A13C'`, `'rgba(232,161,60,0.28)'`, …). main has **0** such constants — it
moved them to `drawingScene.ts`, where they are `SELECTION_ACCENT`-derived.
ui-fixes has **3**, pre-split. Git auto-merged ui-fixes' side with **no conflict
marker**, and the style-gate does not watch that file.

`bench/accent-univalence.mjs` flagged all five. This is prediction **P5's exact
shape**, occurring live: a conflict that produces no marker and no gate failure
in any name-keyed check. The value-keyed sensor is why it is not silent.

ui-fixes' own comment there reads *"LIVE selection/hover = warm amber. Its one
and only meaning across the app."* — a premise R5 measured and superseded.

### 2. Flag-2 characterization: outcome **(c)**, sharper than the ruling framed it

Both suites, run against **unmodified** `symbols.ts`:

- `symbols.test.mjs` — **ALL PASS (46)**.
- `bench/lod-sweep.mjs` — **passes, and says nothing.**

lod-sweep reads only `bench/fixtures/lod-sweep-*.txt`. It opens no source file.
Proven by **deleting `symbols.ts` from the tree and re-running: still green.**

So it is not anchored by path or name to `furniture.ts` — it is anchored to a
**recording of an implementation that will not exist at phase exit**. Its green
is vacuous for the merged tree. Re-anchoring means **re-capturing the sweep
against the merged implementation** (procedure is in the fixture headers), and
per the P4 rule the re-anchor lands in the same commit as the port, proven by
making the wrong implementation lie.

**Face candidate — a check that runs but observes a recording is a REPLAY, not a
sensor.** `bench/lod-sweep.mjs` was deliberately built as a fixture analyser
because Playwright is not a repo dependency — "a check that cannot run is not a
sensor". That trade has a cost I did not state at the time: it can always run,
and it no longer watches the code. Pairs with, and bounds, the existing rule.
Sensor for the sensor: a fixture-analysing check must record the commit and
implementation its fixtures came from, and fail when the subject has moved.

### 3. AI badge trap ARMED (three incidents = a pattern)

`bench/accent-univalence.mjs` now asserts `.cand-ai-badge` resolves **both** its
text and its ground to the `--accent-amber` family. Proven red by sending the
badge blue exactly as ui-fixes did, then green. Checking colour alone would have
passed two of the three incidents — the failure has always been the two halves
disagreeing.

### 4. Systematic amber reversal — for the exit report

ui-fixes made an approved "amber→blue chrome move"; R5 rules live selection
amber, so ~8 sites revert. **Approved against a premise R5's measurement
falsified** — the ruling propagating, not a taste call. These sites must be
classified **intended-(ruled)** in the exit pixdiff against ui-fixes' reference
captures.

Sites: `.space-tool.on`, `.space-marker-pin`, `.dyn-field.active`,
`.space-plate-draft/confirm`, `.lib-row.is-selected`, `.cand-ai-badge`,
ViewerToolbar actives (×4 hunks), plus `DrawingCanvas.ts` once resolved.

## Next actions, in order

1. `web/src/import/DrawingCanvas.ts` — resolve toward `drawingScene.ts`; delete the pre-split amber constants; re-run accent-univalence (expect 0).
2. `web/src/App.tsx` — import union.
3. `crates/ds-core/src/lib.rs`, `layout.rs` — union + re-site; run the `revision()` scanner AND inspect multi-line mutators by hand.
4. `web/src/editor/EditorCanvas.ts` — the re-siting; then reproduce the listener defect and prove it fixed.
5. `furniture.ts` — port main's +23/−15 (`git diff e1c8740..main -- web/src/editor/furniture.ts`) into `symbols.ts` by behaviour; repoint `paint.ts` and `drawingRender.ts`; delete furniture.ts.
6. **Re-capture the lod-sweep fixtures** against the merged implementation and re-anchor the gate (finding 2).
7. `make wasm` from merged Rust; commit separately as "regen wasm from merged core".
8. Persistence round-trip, golden fingerprint, full boards, Rust **by name** ≥138, pixdiff with the reversal sites classified intended-(ruled).

## Gate status at park

| gate | state |
|---|---|
| style-gate, ladder-check, export-parity | PASS |
| lod-sweep | PASS but **vacuous** — see finding 2 |
| accent-univalence | **FAIL (5)** — all in the unresolved `DrawingCanvas.ts`; clears with next action 1 |
| symbols.test.mjs | ALL PASS (46) |
| typecheck / build / Rust | not run — tree is mid-merge and does not compile |
