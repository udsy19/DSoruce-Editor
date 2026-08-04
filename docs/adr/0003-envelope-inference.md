# ADR 0003 — Branch 1b: envelope inference when no shell exists

**Status:** pre-registered — predictions recorded, candidates NOT yet written
**Date:** 2026-08-04

**Code anchors:** `extractPlate` ladder rungs (`web/src/import/testfit.ts`) ·
`PlateMethod` vocabulary (`web/src/import/plateQuality.ts`) · fixtures
`bench/fixtures/plate/*-fragments.json`, `rect-no-shell-only-partitions`,
`rect-regular-column-grid` · confidence ladder ADR 0002

## Why this branch exists

ADR 0002 makes a low-confidence plate a *proposal*. This branch decides what to
propose. Today the answer is a convex hull, which is our worst guess — shipping
the confirm UI on top of it would introduce the honesty feature with its weakest
possible draft.

Scope is capped at four rungs: `hull` (baseline), `partition-envelope`,
`column-grid`, `raster-roundtrip`. Scored on the four fragmented fixtures plus
the real DWG.

## Pre-registration

Written **before any candidate exists**, so results confirm or surprise rather
than get rationalized. Baseline numbers are measured; the rest are predictions
with the reasoning that produced them.

### Two findings that constrain the predictions

**1. `partition-envelope` is largely what the baseline already does.**
The grid-contour rung feeds `collectShellSegments` into `gridContour`, and
`WIDE_SHELL_CATEGORIES` includes `wall` — so interior partitions are *already*
in the raster. The only real degrees of freedom are the dilation schedule
(currently `[2, 4, 8]` cells at 0.25 m = up to 2.0 m of gap bridging) and
whether furniture is included. This is a tuning candidate, not a new algorithm,
and should be judged as such. Per the no-bloat rule it must extend
`gridContour`/`contourRing` rather than introduce a parallel rasterizer.

**2. The partitions in `rect-no-shell-only-partitions` cannot determine the
answer.** They are generated inset ≥ 1.5 m from the truth boundary and never
touch it. The expectation that partition-envelope "should approach 1.0" there is
therefore not achievable — the information is absent, exactly as it is in the
real DWG. An IoU above ~0.90 on that fixture should be treated as *suspicious*
(a fixed outward margin that happens to fit), not as success.

### Expected IoU per rung

Bold = the fixture that rung is expected to win. `n/a` = rung not applicable.

| fixture | truth | baseline (measured) | partition-envelope | column-grid | raster-roundtrip |
|---|---|---|---|---|---|
| `lshape-shell-fragments` | exact | **0.730** | 0.85 – 0.93 | n/a (no COL) | **0.90 – 0.96** |
| `notched-shell-fragments` | exact | **0.885**, 2 self× | 0.90 – 0.95 | n/a (no COL) | **0.90 – 0.96** |
| `rect-no-shell-only-partitions` | exact | **0.644** | **0.70 – 0.82** | n/a (guard should reject) | 0.75 – 0.90 |
| `rect-regular-column-grid` | exact | **0.775** | 0.70 – 0.85 | **≥ 0.97** | 0.75 – 0.90 |
| `real-furniture-plan` | none | phantom **0.463** | phantom 0.25 – 0.40 | n/a (guard should reject) | phantom 0.15 – 0.35 |

Every rung must additionally reach **0 self-intersections** on every fixture.
That is a gate, not a score: `notched-shell-fragments` currently produces 2, and
a candidate that improves IoU while still self-crossing has not fixed the bug.

### Reasoning behind each number

**`partition-envelope`** — On the two shell-fragment fixtures the surviving
fragments lie *on* the true boundary, so the ceiling is high; the gaps are 3.2 m
and 3.6 m while the baseline's maximum dilation bridges only 2.0 m, which is
precisely why it currently fails. Escalating dilation should close them, at the
cost of rounding the notch corners and inflating area — hence a predicted range,
not a point. On `rect-no-shell-only-partitions` the cap is structural (see
finding 2). On the real plan, phantom 0.25–0.40 is an improvement that still
leaves a quarter of the boundary unsupported: **useful, not sufficient**.

**`column-grid`** — Predicted to win exactly one fixture, the one built for it,
and to be inapplicable everywhere else. `rect-regular-column-grid` places a 4×3
grid on 7.5 × 6.667 m bays inset exactly half a bay, so the half-bay extension
rule recovers the 30 × 20 truth *exactly*; anything below 0.97 is the rung's
error, not the fixture's ambiguity.

The guard ("≥ 4 columns forming a plausible grid") is doing the real work, and
two fixtures are deliberately built to make it fire:

- `rect-no-shell-only-partitions` has 12 columns at **11 distinct x positions** —
  random scatter, no inferable bay. The guard must reject.
- The **real DWG** has 27 `COL` entities of which only 8 are column-like: 4
  distinct x lines with plausible spacings (10.2 / 11.6 / 12.3 m) but 7 distinct
  y lines spaced 1.3 / 2.9 / 4.2 / 6.0 / 11.2 / 11.2 m — not a bay. Taking the
  median y-spacing (6.02 m) and extending half a bay yields a **45.6 × 42.8 m =
  1950 m² envelope, larger than the entire 1611 m² drawing extent**. The guard
  must reject on that irregularity. If it passes and the rung ships that number,
  the rung is worse than the hull it replaced.

Compute the bay from **median column spacing per axis**, and require the spacing
distribution itself to be regular (predicted rule: reject when the interquartile
spread exceeds ~25% of the median) — not an assumed module.

**`raster-roundtrip`** — Predicted best on the fragmented fixtures because
segmentation infers enclosure from pixel evidence rather than requiring connected
endpoints, which is the exact structural limitation of the vector path. Three
ways it can still lose, all of which must be measured rather than assumed:

1. **Determinism.** Run each fixture 3× and assert byte-identical output. If it
   does not hold it can only ever feed the confirm step as a suggestion, never
   auto-accept — which ADR 0002's ladder tolerates.
2. **Quantization.** Compare recovered edge positions against the source
   linework. If the error exceeds half a wall thickness (~0.05–0.10 m here) the
   output is a shape hint, not geometry.
3. **Cost.** Weights, a Python environment and service plumbing, with mandatory
   graceful degradation on Vercel exactly like `/api/dwg`. Per the timebox: if
   this turns into a model-serving yak-shave it is parked as a note here and the
   ladder ships with the best deterministic rung. **The honest default must not
   wait on the best candidate.**

### Falsification — what would make each rung be dropped

- `partition-envelope`: fails to beat baseline on both shell-fragment fixtures,
  or reaches its IoU only by inflating area (Δarea > +15% while IoU rises).
- `column-grid`: scores below 0.97 on `rect-regular-column-grid`, or its guard
  fails to reject either `rect-no-shell-only-partitions` or the real DWG.
- `raster-roundtrip`: non-deterministic across 3 runs *and* edge error above half
  a wall thickness — either alone demotes it to suggestion-only; both together
  drop it.
- Any rung producing a self-intersection on any fixture is disqualified
  regardless of IoU.

### Adoption bar

A rung is adopted only if it beats `hull` on the fixtures where it applies, holds
0 self-intersections everywhere, is deterministic, and reduces phantom fraction
on the real plan. Winners on the real plan are **not** declared here — its truth
is undecided, so each candidate's envelope is rendered as a fixed-viewport
overlay on the source linework and chosen visually by the user (same pattern as
the Agent 5 screenshot matrix).

A null result — no rung beats the hull enough to justify its cost — is a
legitimate outcome and will be recorded as such rather than resolved by picking
a winner.

## Results

_Not yet run._
