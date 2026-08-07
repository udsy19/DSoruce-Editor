# Rubric Q3 — does this plan read as an architect's test fit?

Scored 1–5 per row, against **both populations**: freshly generated plans (F1)
and edited ones (F2–F5, `crates/ds-core/src/fixtures.rs`). Every row names the
instrument that produced its score. A row with no named instrument is an opinion,
and this file does not carry opinions.

Evidence: `docs/evidence/qbiq-parity-q3/q3-current/` — F1–F5 × {fit, 2×, 4×},
`manifest.json` (the documents' own counts), `tag-census.json` (the text/furniture
box census). Regenerate with `node scripts/capture-fixtures.mjs --tag <name>`.

---

## Scale caveat — read before using any number below

`research/qbiq-plan-style-spec.json` was measured from a report page at roughly
**1:266** (`/scale/derived`). At that scale a 1.6 m desk is 6 mm wide and the
whole floor carries eight text spans.

**Portable:** the RATIOS (the stroke ladder, furniture 1× → wall 2× → room
enclosure 7×), the zone-fill saturation/lightness targets (S 86.2 ± 5,
L 85.7 ± 3), the figure/ground rule, the label grammar.

**Not portable:** the page's *sparseness*. Eight text spans and hairline
furniture are what 1:266 does to a drawing, not a target for an editor working at
10–100 px/m. At 96 px/m a chair is 48 px across and a reader expects to see a
chair.

Where the editor needs more than the page shows, the divergence is **declared**
in `planStyle.ts`'s editor profile, per that file's own convention — never
silently taken.

---

## Scoring

| # | Row | Instrument | F1 (generated) | F2–F5 (edited) | Notes |
|---|---|---|---|---|---|
| 1 | **Wall junction cleanliness** | `wallnet.rs` unit tests (four named artifacts) + visual read of `@4x` | **5** | **5** | Was 2. Per-wall boxes stacked four buried strokes at every junction; the union boundary removes them by construction. Falsified: re-introducing per-segment drawing is what the four tests forbid. |
| 2 | **Stroke-ladder conformance** | `bench/style-gate.mjs` (every literal must live in `planStyle.ts`) | **4** | **4** | Green. Not 5: the ladder is enforced *as a table*, but no instrument yet measures the delivered pixels against the tiers. |
| 3 | **Opening treatment** | source + `assert_room_enclosed` | **4** | **4** | Openings are real geometry (a 0.9 m gap in the wall run), so the network outline stops at them. `punchOpening`'s white overdraw is deleted. Not 5: no door-swing/threshold convention on the sheet. |
| 4 | **Figure/ground fill rule** | visual read of `@4x`; census pending | **4** | **4** | Furniture already fills white over the wash (`C.furnitureFill`), at 0.86 alpha rather than opaque. **Open:** the census inside a desk footprint (D1's stated gate) is NOT yet written, so this score is a read, not a measurement. |
| 5 | **Furniture symbol fidelity** | `symbols.test.mjs` (46) + visual read | **3** | **3** | The architecture is right — world units, seats from the model, continuous LOD, and the task chair does draw seat/back/arms. What is missing is the *vocabulary* and the *provenance*: 9 categories, all authored rather than extracted. **Q3-D2 (extract the spec from the reference PDF) is not started**, so nothing here is measured against qbiq's actual geometry. |
| 6 | **Label / tag collisions** | tag census at the canvas API (`capture-fixtures.mjs`) | **4** | **4** | label-on-label **0**; label-on-furniture **29 / 205**, down from **127 / 211** when tags were pinned to zone centres. Not 5 because of the 29, and because a zone rect wider than the room drawn inside it still lets a tag cross a wall (`OPEN WORKSPACE (2)`). |
| 7 | **Circulation legibility** | visual read of `F1@fit`; evaluator not yet re-derived by a gate | **2** | **2** | A reader cannot trace entry → spine → rooms. There is no spine to trace: the ground is one undifferentiated field. **Q3-F not started.** |
| 8 | **Plan uses the floor** | `manifest.json` + visual read | **2** | **2** | The desk field is one tall rectangle; the left third and the bottom of the plate carry no program at all. This is the largest remaining visual defect and it is a GENERATOR problem, not a renderer one. |
| 9 | **Zone fill S/L conformance** | not yet instrumented | **?** | **?** | The spec's `zone_fill_targets` (S 86.2 ± 5, L 85.7 ± 3) are not yet checked against `ZONE` in `planStyle.ts`. Unscored rather than guessed. |
| 10 | **Paper sheet completeness** | `scripts/gates/run-all.sh` G1–G11 | **4** | **—** | The board is the instrument and it is green. Not yet re-run per fixture, so the edited population is unscored. |
| 11 | **Metrics trustworthiness** | `metrics_tests.rs` (8 tests, 1 200 evaluations) + `statsPanel.test.mjs` | **5** | **5** | Was 1 — the panel showed GEA 1 m² beside NIA 138 m² and efficiency 1159%. One NIA owner, a plate that can say "unresolved", and a randomized battery that reaches broken plates. Three-part sabotage round; two parts shipped unguarded and now red under sabotage. |

**Rows below 4: 5, 7, 8** (and 9 unscored). Rows 7 and 8 are the same root cause —
the generator, not the renderer.

---

## How each instrument works, and what it cannot see

- **Wall junctions.** Four unit tests, each named for the artifact it forbids
  (buried caps at an L, caps inside a collinear run, cross-lines in a closed
  room). They measure geometry, not pixels; a renderer that ignored
  `wall_outlines()` would still pass them. The visual read covers that gap and is
  stated as a read.
- **Tag census.** `ctx.fillText` is wrapped inside the capture page, so every
  label is recorded with its real measured extent, and furniture boxes are
  computed in the same screen space. No producer claim is consulted. Two
  non-vacuity guards (≥20 text draws, ≥100 furniture boxes) — the first version
  of this check was vacuous and passed under sabotage, which is why they are
  there.
- **Metrics.** 120 seeds × 10 mutations from each of five fixtures. Non-vacuity
  asserted by requiring the population to include both `traced` and `unresolved`
  plates; it prints its census.
- **What none of them see:** whether the plan is a *good* plan. Rows 7 and 8 are
  scored from a human read of a capture, and they are the two lowest scores in the
  table. That is the honest position and it should not be dressed up with a
  number until there is an instrument behind it.
