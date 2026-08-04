# ADR 0003 — Branch 1b: envelope inference when no shell exists

**Status:** results in — awaiting adoption decision at the merge gate
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

`pnpm bench plate`, 15 fixtures × 3 implementations. Predicted ranges were frozen
in commit `6a6da3b`; containment gates in `6754e72`. Neither was touched after
candidates ran.

### Against the pre-registered ranges

| fixture | rung | predicted | actual | verdict |
|---|---|---|---|---|
| `lshape-shell-fragments` | partition-envelope | 0.85 – 0.93 | **0.979** | **ABOVE** |
| `notched-shell-fragments` | partition-envelope | 0.90 – 0.95 | 0.925 | in range |
| `rect-no-shell-only-partitions` | partition-envelope | 0.70 – 0.82 | 0.646 | **BELOW** |
| `rect-regular-column-grid` | partition-envelope | 0.70 – 0.85 | 0.605 | **BELOW** |
| `rect-regular-column-grid` | column-grid | ≥ 0.97 | **1.000** | in range (exact) |
| `rect-no-shell-only-partitions` | column-grid | reject | rejected | as predicted |
| `real-furniture-plan` | column-grid | reject | rejected | as predicted |

### What surprised us

**1. `gridContour` is a morphological closing, so `partition-envelope` can bridge
gaps but can never extrapolate.** It dilates the linework then erodes by the same
box, which recovers a boundary that gaps have broken — hence 0.979 on
`lshape-shell-fragments`, well above prediction — but cannot reach a boundary the
linework never touched. That is why both no-shell fixtures came in BELOW: the
partitions are inset from the truth, so no dilation reaches it. The failures are
structural, not tuning. This should have been foreseen from the closing property
and was not.

**2. The containment gate changed the winner on the real plan.** On
`real-furniture-plan`, `partition-envelope` scores phantom **0.437 against the
baseline's 0.463** — on the headline truth-free metric alone it wins. Its
furniture containment is **0.762 against the baseline's 0.961**: it achieves the
better phantom by hugging wall linework on the left and centre and excluding the
entire right-hand region, where furniture exists but walls do not. Without the
gate added in `6754e72` this branch would have adopted it. The gate was proposed
against exactly this failure mode and caught it on its first run.

**3. `column-grid` behaved exactly as pre-registered — including its rejections.**
IoU **1.000** on the fixture built for it (the half-bay rule recovers the truth
exactly), and correct rejection on both negative cases. Its phantom fraction on
its own winning fixture is **1.000**, i.e. 100 % of its boundary rests on no wall
— *correctly*, because the columns are inside the plate and there is no shell.
**Phantom fraction is therefore not a valid score for a column-derived envelope**,
and must not be used to rank this rung against contour-derived ones.

**4. No rung passes both gates on the real DWG.** baseline 0.961 containment
(just under the 0.98 gate), partition-envelope 0.762, column-grid rejects. This
is a legitimate null result for that drawing, recorded rather than resolved by
picking a winner.

**5. A correction to this branch's own framing.** ADR 0002 and earlier notes
described the baseline plate on the real DWG as "a convex hull fitted to
disconnected fragments" and "not a measurement of anything". The overlay render
shows that is too harsh: the boundary follows real walls along its left, top and
much of its stepped right edge, and contains 96.1 % of the furniture. What is
true is narrower — roughly half its perimeter (46 %) is inferred rather than
traced, concentrated on the right and bottom where no linework exists. It is a
plausible envelope with unsupported stretches, not an arbitrary one.

### `raster-roundtrip` — parked, with reasoning

Not built, per the timebox. The environment is not the blocker: `torch 2.7.1` is
present and the network is reachable. Weights, model architecture and service
plumbing (plus mandatory Vercel degradation) all are.

The stronger reason to park it: on a shell-less drawing a raster path **without**
learned priors adds nothing over `gridContour` — flood-fill from outside reaches
everywhere when there is no enclosure, and morphological closing is already what
the incumbent does. So the entire value of this rung is the learned prior, which
is precisely the expensive part. It cannot be cheaply approximated to test the
hypothesis first.

Revisit when there is a reason to stand up a Python inference service anyway
(`ifc-cost` in branch 2 is the likely trigger — same class B plumbing).

### Recommendation

Adopt as a ladder, ordered by trustworthiness, each rung guarded:

1. `traced-loop` — unchanged.
2. `column-grid` — when both axes pass the IQR guard. Narrow but *exact* when it
   applies, and it declines cleanly when it does not.
3. `partition-envelope` — when its contour contains ≥ 98 % of the furniture.
   Wins decisively where shell fragments exist (0.730 → 0.979) and must be
   prevented from firing where they do not.
4. `grid-contour` / `hull` — unchanged last resorts.

Every rung below `traced-loop` still produces `confidence: 'low'` under ADR 0002,
so all of them are proposals the user confirms. The ladder improves the *draft*;
it does not change what is asserted.

### Not adopted, and why

`partition-envelope` fed with furniture bounding boxes (as the incumbent's `wrap`
rung does) would plausibly fix its containment collapse. It is **not** tested here
because it was conceived after seeing results — adding it now is the post-hoc
tuning that pre-registration exists to prevent. Recorded as a candidate for a
future round with its own pre-registered range.
