# ADR 0002 — Plate provenance and the confidence ladder

**Status:** accepted (step 1 of the open-source bake-off; UI wiring pending)
**Date:** 2026-08-04

**Code anchors:** `assessPlate`, `phantomFraction`, `PHANTOM_MAX_FOR_HIGH`
(`web/src/import/plateQuality.ts`) · `extractPlate`, `finishPlate`,
`plateFromArea`, `PlateResult.provenance` (`web/src/import/testfit.ts`) ·
calibration fixtures `bench/fixtures/` · regression test
`web/src/import/plateQuality.test.mjs`

## Context

`extractPlate` always returns something. It descends a ladder — closed loop
traced through wall linework → occupancy-grid contour → furniture-wrapped
contour → convex hull of whatever points exist — and the lower rungs are
guesses. By the time a plate reaches the UI, nothing distinguishes a traced
building shell from a hull fitted to disconnected fragments: the app prints
`881.5 m²` either way, and circulation score, cost, carbon and m²/person are all
computed from it.

On the real `samples/furniture-plan.dwg` that number is not a measurement.
Rendering each wall layer separately shows the drawing has **no closed exterior
envelope on any layer** — `I-WALL` (335 entities), `A-WALL` (254), `WALL` (87)
and `COL` (27) are all fragments: interior partitions, a curved feature,
scattered bits, column squares. It is a fit-out drawing; the architect's shell is
a separate document we do not have. The plate the app reports for it has **46.3%
of its perimeter unsupported by any wall linework**.

The defect is the *silence*, not the boundary.

## Decision

`PlateResult` carries `provenance`, and low-confidence plates are proposed
rather than asserted.

```ts
interface PlateProvenance {
  method: 'traced-loop' | 'grid-contour' | 'partition-envelope'
        | 'column-grid' | 'hull' | 'user-traced'
  phantomFraction: number   // boundary length with no wall beneath it
  orthogonality: number     // reported, NOT gated
  closingEdgeM: number      // diagnostic, NOT an error
  selfIntersections: number // any value > 0 is a hard fail
  confidence: 'high' | 'low'
  reason: string            // plain language, for the confirm prompt
}
```

`high` requires **`selfIntersections === 0` and `phantomFraction < 0.15`**.

## Calibration

Thresholds were fitted to the 14-fixture set, not chosen by feel. Ground truth
for the 13 synthetic fixtures is exact by construction (the drawing is
synthesized *from* the truth polygon), so "was this plate actually accurate?" is
answerable independently of the confidence verdict. Accuracy is IoU ≥ 0.95.

| fixture | IoU | method | phantom | self× | orth | verdict | correct |
|---|---|---|---|---|---|---|---|
| rect-clean | 1.000 | traced-loop | 0.000 | 0 | 1.000 | high | ✓ |
| rect-duplicated-layers | 1.000 | traced-loop | 0.000 | 0 | 1.000 | high | ✓ |
| rect-jitter | 1.000 | traced-loop | 0.000 | 0 | 1.000 | high | ✓ |
| rot17-door-gaps | 1.000 | grid-contour | 0.035 | 0 | 1.000 | high | ✓ |
| lshape-jitter-dup-gaps | 0.991 | traced-loop | 0.000 | 0 | 1.000 | high | ✓ |
| curved-facade | 0.990 | grid-contour | 0.011 | 0 | **0.278** | high | ✓ |
| rect-door-gaps | 0.984 | grid-contour | 0.040 | 0 | 1.000 | high | ✓ |
| rect-wide-gaps | 0.984 | grid-contour | **0.130** | 0 | 1.000 | high | ✓ |
| notched-core | 0.983 | grid-contour | 0.020 | 0 | 1.000 | high | ✓ |
| lshape-door-gaps | 0.979 | grid-contour | 0.054 | 0 | 1.000 | high | ✓ |
| notched-shell-fragments | 0.885 | hull | 0.359 | **2** | 0.830 | low | ✓ |
| lshape-shell-fragments | 0.730 | hull | 0.445 | 0 | 0.811 | low | ✓ |
| rect-no-shell-only-partitions | 0.644 | hull | 0.680 | 0 | 0.669 | low | ✓ |
| real-furniture-plan | n/a | grid-contour | 0.463 | 0 | 0.615 | low | (no truth) |

**0 misclassified of 14.** Accurate plates top out at phantom 0.130; inaccurate
ones bottom out at 0.359. The threshold sits in that gap.

Sensitivity sweep (false-high = a bad plate auto-accepted; false-low = a good
plate needlessly asks for confirmation):

| threshold | false-high | false-low | |
|---|---|---|---|
| 0.05 | 0 | 2 | over-cautious |
| 0.10 | 0 | 1 | over-cautious |
| 0.13 | 0 | 1 | over-cautious |
| **0.15** | **0** | **0** | **chosen** |
| 0.20 – 0.40 | 0 | 0 | also perfect |
| 0.50 | 1 | 0 | unsafe |

0.15 is the accurate-side edge of the perfect band (0.14–0.40). Placed there
deliberately: a false `high` silently propagates a wrong area into circulation,
cost and the takeoff, while a false `low` costs one confirmation click.

## Signals deliberately NOT gated on

Two signals from the original proposal were measured and rejected, both because
they misclassify correct plates:

- **"high requires a closed traced loop."** Six accurate plates (IoU 0.979–1.000)
  come from the `grid-contour` rung, including `rot17-door-gaps` at IoU 1.000.
  Requiring `traced-loop` would flag all six as low confidence.
- **Orthogonality.** `curved-facade` scores 0.278 and is a perfectly good plate
  (IoU 0.990) — a curved building is not a broken trace. It fails to separate at
  the other end too: bad plates score 0.615–0.830. Reported for diagnosis only.

A third was **corrected rather than rejected**: the proposed `closureGap < 0.25 m`
gate would have marked every fixture low, including a flawless rectangle. Plate
rings are **implicitly closed** — `boundary` does not repeat its first vertex —
so "distance from first to last vertex" is simply the length of the closing edge:
a clean 30×20 rectangle reports 20.0 m. The 3.5 m measured on the real plan and
previously described as "the ring doesn't close" was that plan's final edge, not
a defect. Renamed `closingEdgeM` and kept as a diagnostic.

## Consequences

- High confidence → auto-accept, exactly as today. All ten original fixtures land
  here, which is why they scored 0.98–1.00: they were measuring a path that works.
- Low confidence → the plate becomes an **editable draft preloaded into
  area-select** with `reason` shown, not a refusal and not a silent hull.
  `plateFromArea` already exists and now stamps `user-traced`, which is trusted
  unconditionally — a user-traced plate is the *answer* to low confidence.
- No hard area for a low-confidence plate, nor for anything derived from it.
- **`docs/ROADMAP.md` records "real-plate density — verified on the user's DWG
  (52 ws @ 10 m²/person)". That denominator is the 881.5 m² hull artifact.** It
  must be re-verified or annotated once the ladder is wired; tracked as an open
  item, not silently left.
- `bench/` gains a second use: it is now the calibration set for a production
  threshold, so changing the fixtures changes a shipped behaviour.
  `plateQuality.test.mjs` pins the mapping so drift fails CI rather than
  silently widening what gets auto-accepted.

## Not decided here

The best-guess ladder for low-confidence drafts (`column-grid` when `COL` has ≥ 4
columns forming a plausible grid, extended half a bay past the perimeter columns,
else `partition-envelope`, else `hull`) is branch **1b** of the bake-off. The
method vocabulary above already reserves those names; only `traced-loop`,
`grid-contour`, `hull` and `user-traced` are produced today.
