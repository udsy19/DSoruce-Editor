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
| 7 | **Circulation legibility** | `Editor::layout_diag` (the generator's own account — diagnostic only, never a gate input) + visual read | **2** | **3** | Measured on F1: **2 spines for 3 regions, 0 entry connectors, 0 links, 4 seams**. The network is not connected and there is no entry anchor in the fixture. The spread opened real aisles between desk neighbourhoods, which is the first legible circulation the plan has had, but the drawn network is still not emitted as connected geometry. **Q3-F F2 not done.** |
| 8 | **Plan uses the floor** | **NO TRUSTED INSTRUMENT.** `scripts/gates/deadspace.py` is marked UNTRUSTED — its plate segmentation measured the wall bounding box (1597 m²) instead of the plate polygon (930 m²), and three successive versions gave 19.0% / abort / 0.0% on one unchanged drawing. Every figure it produced is retracted. | **?** | **?** | What IS measured, from core state: the maximal-rectangle tiling leaves **75.5 m² in 10 pieces** unclaimed above a 2 m² floor, and they are boundary ribbons — 8.5×2.0, 9.5×1.5, 1.0×6.5, 1.0×5.0 — not room-shaped pockets. Unscored rather than guessed, per this file's own rule. |
| 9 | **Zone fill S/L conformance** | `web/src/editor/zoneFillSpec.test.mjs` — band from the spec file, values parsed from `planStyle.ts` source | **5** | **5** | Was unscored, so it got measured, and **seven of eight zones failed saturation** — Workspace at S 55 against the spec's mean of 86. Hues untouched, S/L moved into the band, ground left neutral. |
| 10 | **Paper sheet completeness** | `scripts/gates/run-all.sh` G1–G11 | **4** | **—** | The board is the instrument and it is green. Not yet re-run per fixture, so the edited population is unscored. |
| 11 | **Metrics trustworthiness** | `metrics_tests.rs` (8 tests, 1 200 evaluations) + `statsPanel.test.mjs` | **5** | **5** | Was 1 — the panel showed GEA 1 m² beside NIA 138 m² and efficiency 1159%. One NIA owner, a plate that can say "unresolved", and a randomized battery that reaches broken plates. Three-part sabotage round; two parts shipped unguarded and now red under sabotage. |

**Rows below 4: 5, 7.** Row 8 is **unscored** — its instrument was found to be
measuring the wrong region and its numbers are retracted. Rows 7 and 8 remain the
same root cause (the generator, not the renderer); what changed is that row 8 no
longer has a number pretending otherwise.

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
- **Dead space — RETRACTED.** One instrument was applied to the reference page
  and to our plan, with the plate found by flooding from the frame. It found the
  wall BOUNDING BOX, not the plate: 1597 m² against a 930 m² polygon. Flooding on
  ink instead leaks through the anti-aliased 1 px boundary and reports 0.0%. Three
  versions, three answers, one unchanged drawing. The replacement derives our side
  from core state (plate polygon + component footprints) and keeps pixels only for
  the reference, whose plate comes from its stated floor area rather than a flood.
  Nothing from the old instrument is cited anywhere in this file.
- **`layout_diag` is NOT an instrument in this sense.** It is the generator's own
  account of what it decided, which `.claude/rules/gate-independence.md` forbids a
  gate from consuming. It is how a mechanism gets NAMED; every acceptance number
  above comes from somewhere else.
- **What none of them see:** whether the plan is a *good* plan. Row 7 is still
  scored from a read of a capture plus the generator's own network counts, and it
  is the lowest score in the table. That is the honest position and it should not
  be dressed up with a number until there is an instrument behind it.
