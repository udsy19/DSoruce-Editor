# F8 — "100 % furniture coverage" is printed when the drawing contains zero furniture

**Severity: Medium** · **Files affected: 8 — every file that produces a plate *and* has zero
furniture. (12 files parse with zero furniture; on 4 of them no plate is traced, so the claim is
never reached.)**

---

## The defect

`PlateResult.coverage` is documented in `testfit.ts:44` as:

> *Fraction (0–1) of furniture bbox centers inside the boundary; **1 when the drawing has no
> furniture**.*

The `1` is a sensible internal default — you cannot fail a coverage test with nothing to cover, and
the plate ladder needs a number to sort candidates by. The defect is that this default is **surfaced
to the user as a quality claim**.

The Space step prints (`findings/screens/AG-space-step.png`, `BUSNSS-Offcs-Trdtnl_AG.dwg`):

> Counts are exact. The boundary and room labels are best-effort where the walls don't fully close
> (traced by hull, **100 % furniture coverage**).

directly beneath:

> **COMPONENTS 0** · 0 categories

"100 % furniture coverage" and "0 components" on the same screen. The statement is *true* — 100 % of
zero items are inside the boundary — and it is **evidence of nothing**. It reads as corroboration of
a boundary that, in this file, is a triangle missing the actual floor plan entirely.

## Scale

Eight files reach the Space step with a plate and `furniture: 0`, and therefore display this claim:

`BUSNSS-Offcs-Trdtnl_AG`, `AG (1)`, `AI`, `AL`, `AM`, `BUSNSS-Offcs_AN`, `Two-story-house-410202`,
`Hospital-equipment.zip/MOBILIARIO HOSPITAL`.

Four more parse with `furniture: 0` but trace no plate, so the claim is never rendered:
`Apartment-413201`, `Apto.1404202`, `Small-apto.`, `call-center-offices`.

Most of them have zero furniture only because of [F2](F2-layer-category-inference.md), not because
the drawing is empty — `MOBILIARIO HOSPITAL.dwg` is *entirely* hospital furniture blocks.

## Verified independently

Coverage was recomputed from the boundary ring and the furniture bbox centres by point-in-polygon
(`harness/run.mjs`, `recomputeCoverage`), never read from `PlateResult.coverage`. On every file where
furniture exists, the recomputed value matches the reported one to within 0.02 — **the number is
honestly computed; the problem is that it is reported at all when the denominator is zero.**

## The family this belongs to

Same shape as [F4](F4-empty-plan-scored-as-success.md)'s `adjacency: 100` / `daylight: 100` on a plan
with no components: **a metric over an empty population returning its maximum**, then presented as
confirmation. A quantity that is undefined should be reported as undefined ("no furniture in this
drawing to check the boundary against"), which is *also* the more useful message — it tells the user
the boundary is unverified and why.

## Reproduce

```bash
node -e 'for (const x of require("./cad-validation/reports/_all.json")) {
  const p = x.stages.parse, pl = x.stages.plate
  if (p?.ok && pl?.ok && p.furniture === 0)
    console.log(x.file, "furniture=0  reportedCoverage=" + pl.reportedCoverage) }'
```
