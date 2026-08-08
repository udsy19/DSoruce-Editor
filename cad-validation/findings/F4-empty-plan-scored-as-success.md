# F4 — An empty plan scores 38–43/100, with three sub-scores at a perfect 100

**Severity: Critical** · **Files affected: 13 (every "silent failure")**

This is the finding that matters most. The other defects produce a wrong plan; this one is why the
user is never told.

---

## What was measured

`harness/e2e.mjs` runs the real `web/src/wasm` build exactly as `App.tsx testFitPlan()` does — push
the plate boundary as walls, push keep-outs and entries, call `generate(DEFAULT_PROGRAM, seed, false)`,
then `circulation()` and `layout_score()`. Desk counts are read back from **core state**, not from the
metrics object the generator returns.

Result for `BUSNSS-Offcs-Trdtnl_AG.dwg` — a 2.5 m² plate on which nothing was placed:

```json
{
  "capacity":        0,
  "adjacency":     100,
  "circulation":    65.88,
  "density":         0,
  "program_fit":     0,
  "daylight":      100,
  "entry_adjacency": 100,
  "total":          38.73,
  "placed_desks":    0
}
```

Component count read back from core state: **0**. Circulation reports `score: 69.3, minWidth: 1.2 m`.

**Adjacency 100, daylight 100, entry-adjacency 100, and a 1.2 m minimum corridor — for a plan
containing nothing.** Each of those metrics divides by a population that is empty, and an empty
population has no violations. Emptiness is being scored as perfection.

## Scale of it

| File | Plate m² | Desks placed | `total` | Circulation score |
|---|---|---|---|---|
| `BUSNSS-Offcs-Trdtnl_AL.dwg` | 21.5 | **0** | 42.4 | 87.7 |
| `Office-furniture-blocks.zip/cad33.dwg` | 78.1 | **0** | 43.1 | **90.5** |
| `BUSNSS-Offcs_AN.dwg` | 29.2 | **0** | 41.6 | 84.4 |
| `BUSNSS-Offcs-Trdtnl_AB.dwg` | 6.9 | **0** | 40.7 | 80.9 |
| `BUSNSS-Offcs-Trdtnl_AG.dwg` | 2.5 | **0** | 38.7 | 69.3 |
| `Two-story-house-410202.dwg` | 1.3 | **0** | 38.5 | 65.0 |
| … 7 more | 1.7–6.9 | **0** | 38.5–39.8 | 68.1–78.1 |
| `fast-food-Restaurant.dwg` | 342.9 | 19 | 86.9 | 77.7 |
| `samples/furniture-plan.dwg` *(control)* | 930.1 | **104** | 88.8 | 82.2 |

An empty plan scores **90.5 on circulation** — higher than the control's 82.2, which actually has
104 desks and real corridors to measure. A metric that rewards an empty floor over a working one is
inverted, not merely uninformative.

## What the user sees

`findings/screens/callcenter-generate-step.png` — the wizard's Generate step, reached from a file
with **no plate at all**:

> **Pick a test-fit** — "The engine generated a few alternatives against your program."
> **3 ALTERNATIVES · BEST 41/100**
> A · Open **27**/100 · B · Balanced **33**/100 · C · Cellular **41**/100

Three cards with **entirely blank thumbnails**, scored, badged, and ready to "Open in editor".
Nothing on the screen says the import failed. A user who does not notice the blank thumbnails
proceeds to Review → Design → Visualise → Share, and to the priced report and quantity takeoff, on
an empty document.

## The two separable defects

1. **`generate()` reports success when it placed nothing.** `placed_desks: 0` against a program
   requesting 20 is a failed generation, not a low-scoring one. It should be distinguishable by the
   caller without inspecting core state.
2. **Sub-scores return 100 for an empty population.** `adjacency`, `daylight` and `entry_adjacency`
   are vacuously perfect. A score computed over zero items must be undefined, not maximal — this is
   the "vacuous truth" family that also produces [F8](F8-vacuous-coverage-claim.md).

## Reproduce

```bash
node cad-validation/harness/e2e.mjs
node -e 'for (const r of require("./cad-validation/reports/_e2e.json"))
  if (r.generated) console.log(r.file, "plate", r.plateAreaM2, "m2 | desks",
    r.generated.placed_desks, "| total", r.generated.total?.toFixed(1),
    "| adjacency", r.generated.adjacency, "| daylight", r.generated.daylight)'
```
