# F3 — `derivePlate` returns `null` on 6 of 24 files

**Severity: High** · **Files affected: 6**

---

## Symptom

`extractPlate` exhausts its whole candidate ladder — traced-loop → grid-contour →
partition-envelope → column-grid → hull → wrap — and returns `null`. `App.tsx:774`:

```ts
const plate = derivePlate(drawing, opts?.areaPolygon, opts?.heal !== false)
if (!plate) {
  setImportErr('No wall geometry found in this drawing to derive a floor plate from.')
  return
}
```

The Space step renders `USABLE AREA — m², no plate traced`, `COMPONENTS 0`, `ROOMS 0`
(`findings/screens/callcenter-no-plate.png`).

## Affected files, with the upstream cause

| File | Entities parsed | `wall` | Proven upstream cause |
|---|---|---|---|
| `Apartment-413201.dwg` | 1 687 | 2 % | [F1](F1-unit-scale-trusted-blindly.md) — 1000× under-scale (0.0 × 0.0 m drawing) |
| `Apto.1404202.dwg` | 7 516 | 1 % | [F1](F1-unit-scale-trusted-blindly.md) — 1000× under-scale (5.7 × 0.0 m) |
| `Small-apto..dwg` | 1 888 | 0 % | under-scale (0.0 × 0.0 m) + [F2](F2-layer-category-inference.md) |
| `Various-furniture-blocks.zip/muebles varios.dwg` | 19 526 | 0 % | [F2](F2-layer-category-inference.md) — 100 % `other`, Spanish layers |
| `call-center-offices.dwg` | 1 238 | 0 % | [F2](F2-layer-category-inference.md) — 100 % `other`, numeric layers |
| `BUSNSS-Offcs-Trdtnl_AN.dwg` | 3 317 | 8 % | under-scale — drawing spans 0.7 × 1.6 m |

**All six are downstream of F1 or F2.** None is an independent defect in the plate tracer, and the
tracer itself is sound — it produces a 930 m² plate on the control fixture and a correct 343 m² plate
on the one corpus file whose units survive the anchor.

Two mechanisms produce the `null`:

1. **Area floor.** `MIN_PLATE_AREA = 1` m² (`testfit.ts:72`) is absolute. A drawing scaled 1000× too
   small has *every* candidate ring below it, so `accept()` rejects each one and `best` stays
   `null` — regardless of how well the ring traces the linework.
2. **No shell segments.** `extractPlate:104` returns `null` immediately when both
   `collectWallSegments` and `collectShellSegments` are empty, which is what F2 produces on files
   whose linework is open polylines on unrecognised layers.

## The real defect is what happens next

`null` is handled — but only as a message. It is not a stop.
`findings/screens/callcenter-generate-step.png` shows the wizard reached **"Pick a test-fit ·
3 alternatives · best 41/100"** with blank thumbnails, from a document with no plate at all. See
[F9](F9-wizard-gating.md).

## Reproduce

```bash
node cad-validation/harness/e2e.mjs   # prints 'NO PLATE' per file
```
