# Phase 0 — Editor Completion Loop: facts, yardsticks, pre-registrations

Committed BEFORE any fix code exists. Scope: the circulation/zone/extraction workstreams (A–E).
Out of scope, verbatim fences: cadcodec, MCP build, anything on the proposal branch, corpus
contact, bundle measurement, item (g)/waiver resolution, calibration-log seeding (trusted-human
event — Udaya's hands only, per `.claude/rules/gate-independence.md`).

## Phase 0 facts (from the zone-dump diagnostic — now facts, not predictions)

Instrument: `scripts/fixtures/zone-dump.furniture-plan.json` — captured from the live editor via
the real path (wizard → `samples/furniture-plan.dwg` → candidate A → Open in editor), areas read
from `Editor.zone_stats_published()` (core-owned; web recomputes no magnitude), determinism shown
once against a prior run. The Phase 0 re-render on the deployed build re-verifies it.

1. **The "empty" wing is tiled, not missing.** The western L is fully covered by residual zones
   (839, 835, 840, 838, 834, 837, 796, 836 + ribbon 833, ≈166 m²), all typed `Circulation`.
   Circulation renders as white ground by design, so the renderer is faithful to the classifier.
   `fold_unassigned` works. The classifier/typing path is the target.
2. **Zone 833 is the recorded "a scalar is not geometry" instance 2** — 80.43 m², 41 vertices,
   32.8 m span, compactness 0.085. A wall-following ribbon that low compactness reads as
   corridor-like. The fix must be geometric, not a re-tuned threshold.
3. **Two stamp sites (corrected from the amendment's "ten zones"):** label≠type on 51/53 zones is
   legitimate — `label` is a display name ("Boardroom" vs `Meeting`). The real anomaly is
   **eight** residuals (834–840, 796) *named* "Unassigned" but *typed* `Circulation`, while 833
   is named AND typed Circulation. The classifier's affirmative verdict apparently drives the
   name (it ruled only on 833); something else stamps `Circulation` on every residual's type.
   Workstream A must find that second stamp site before touching conjuncts.
4. **The 434 m² question dissolves:** zone 680 "Open Workspace (1)" alone is 433.6 m² — that is
   the screenshot's label. 458.55 m² is the sum of all six Workspace zones. Plate matches;
   the label is per-zone.
5. **Document-side pax:** zone 680 has `capacity: 101, seated: 101, components: 202` — the
   "101 pax" label equals the document's seated count (202 components ≈ 101 desk+chair pairs).
   Density 433.6/101 = **4.29 m²/pax** — below GCC/BCO norms (product-owner visibility item).
6. **Workstream B's root cause is already recorded** (`reports/SHEETS-FINAL.md` D-P):
   `sheetSet.ts:1021` (line as of that report) starts the plan's occupancy empty and never seeds
   it with the base raster's ink, where `planGraphic.ts:300-304` does. 107 strings, measured at
   three commits (103 → 106 → 107), 106/107 coordinate-identical.
7. **`deploy/` has no gate script.** Finding recorded here; deployed manually; a deploy gate is
   filed as debt (owner: post-loop).

## Pinned yardsticks (fixed for the whole loop; the corpus and counting method may not change)

| yardstick | value | instrument |
|---|---|---|
| zones | 53 (41 Rect / 12 Poly) | zone dump fixture |
| total zone area | 906.33 m² | `zone_stats_published()` |
| zone 833 | 80.43 m² / 41 v / 32.8 m span / origin Residual | zone dump fixture |
| circulation total | 298.09 m² (26 zones) = 32.9 % of NIA | zone dump `byType` |
| walls / components | 186 / 268 | zone dump `totals` |
| divergent residuals | 8: 834–840, 796 (named Unassigned, typed Circulation) | zone dump fixture |
| zone 680 | 433.6 m², cap 101, seated 101, components 202 | zone dump fixture |
| B corpus | 107 strings crossing wall/furniture ink | D-P measurement, method frozen |
| Rust tests | 209 named (floor was 198) | `cargo test -p ds-core` on merge `main`+`df10cfa` |

## Pre-registered predictions — mechanism · expected finding · falsifier

**A (classifier/fold, branch `fix/wing-classifier`).**
- *Mechanism:* residual type is stamped `Circulation` by the fold (or a default) independent of
  the classifier; the classifier's verdict reaches only the name. *Falsifier:* if the type is
  stamped inside the classifier itself (one site), the two-site hypothesis is wrong — then the
  classifier misfires on ALL residuals and the name comes from elsewhere; scope changes, agent
  stops for re-registration.
- *Gate 1 (scoped by Udaya, 2026-08-12):* a Residual-origin zone's type must express the
  classifier's verdict — typed `Unassigned` unless affirmatively classified `Circulation`.
  Red today on the eight. Secondary assertion in the same gate: a residual's display name derives
  from its type — no facet may express a decision the deciding mechanism didn't make. Keys off
  `Zone.origin`, so it cannot be greened by renaming.
- *Gate 2:* the compactness scalar's role is replaced by a geometric discriminant. Candidate
  (pre-registered, agent may refine BEFORE implementing): bounded local width along the medial
  axis — a corridor is thin *everywhere*; a ribbon-wrapped region is not. Predicted verdicts:
  833 → NOT circulation; drawn corridors 664–679 → remain circulation. Both halves gated.
  No tuned parameter ships without its choosing evidence in the same commit.
- *Post-fix circulation expectation:* residual circulation totals ≈166 m². If all nine flip to
  Unassigned, circulation ≈ 132 m² (14.6 % NIA); some residuals may genuinely be corridor-shaped.
  **Pre-registered window: 132–180 m² (14.6–19.9 % NIA). Above 25 % ⇒ a second mechanism exists
  and the workstream may not close GREEN without naming it.**

**B (sheet extraction, branch `fix/sheet-occupancy`).**
- *Mechanism:* the occupancy-seeding asymmetry above. *Fix:* seed sheet plan occupancy with the
  base raster's ink as `planGraphic` does.
- *Yardstick:* the 107-string corpus, method frozen. **Pre-registered post-fix count: 0.**
  Any survivor needs a named per-string reason (e.g. a room too small for its label at maximum
  displacement) or the workstream is RED-WITH-ROOT-CAUSE, not GREEN-with-asterisk.
  The 14 outside-footprint strings (D-Q) are a DIFFERENT defect and not this yardstick.
- *Falsifier of the mechanism:* seeding occupancy moves the count by <50 % ⇒ the asymmetry was
  not the (main) cause; stop and re-register.

**C (label rendering, branch `fix/label-render`).**
- *Pre-registered question:* is the garbled second string under "OPEN WORKSPACE (1)" and the
  doubled separator ("434 m²··101 pax") the rendering-side sibling of B's family?
- *Prediction:* independent — B is sheet-export occupancy; C is editor-canvas label composition/
  anchoring. The "··" reads as a separator emitted by both the string composer and the renderer;
  the garble reads as two strings overdrawn at one anchor (the D3 knockout-halo family).
- *Falsifier / merge condition:* if the canvas label path routes through the same occupancy or
  placement helper as `sheetSet`, C merges into B and the agents consolidate.

**D (pax derivation, branch `fix/pax-derivation`).**
- *Pre-registered question:* is "101 pax" counted from placed desks or derived from area/ratio,
  and can the two silently disagree?
- *Phase 0 evidence:* label 101 = document `seated` 101 for zone 680 — they agree on this plate.
- *Remaining work:* verify in code that `seated` derives from placed components (one authoritative
  source), audit the `set_component_size` side-effect path, and write the invariant down. If a
  second derivation path exists that can disagree, that is a merge_zones-grade defect: fix to one
  source, gate with a forced-divergence fixture, watched red then green.
- *For Udaya regardless of outcome:* 4.29 m²/pax is below GCC/BCO norms — may be brief-driven.

**E (placement inset, branch `fix/placement-inset`).**
- *Prediction:* NOT reproduced on the deployed build — likeliest stale-pixel candidate, since
  conform-on-edit (df10cfa) landed after the screenshot. Then GREEN as verified-fixed-by-df10cfa
  with on-screen evidence.
- *Falsifier:* desks still cross the zone boundary on the deployed merge. Then: determine whether
  zone polygons inset while placement doesn't, or conform moved the boundary after placement;
  fix on the placement side; gate asserts no placed component's footprint exits its zone polygon,
  watched red on the defect geometry.

## Execution rules restated

File partition (Udaya, 2026-08-12): A owns classifier/fold/regions files; E owns
`place.rs`/`packing.rs`/`emit.rs`; if E needs an A-owned file it sequences behind A. Both fork
from merged main. All constructed negatives run in scratch worktrees. Every GREEN requires a gate
watched red first; every browser claim carries provenance (unconditional reload + served-module
token). Terminal states: GREEN · RED-WITH-ROOT-CAUSE · STOPPED-FOR-HUMAN — nothing else.
