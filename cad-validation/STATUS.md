# Status — CAD import remediation

Running record against the findings in [`findings/00-SUMMARY.md`](findings/00-SUMMARY.md) and the
plan in [`SOLUTIONS.md`](SOLUTIONS.md). Updated 2026-08-06, branch `testing-edge-variations`.

## Where it started, where it is

| Measure | Before | Now |
|---|---|---|
| Blocked at conversion (crash / truncation) | 3 | **0** |
| No floor plate derived | 6 | **1** (`cad33`) |
| Places furniture end-to-end | **2 / 24** | **20 / 24** |
| **Scale independently verified physical** | 2 / 24 | **17 / 24** |
| Wrongly-scaled imports that *say so* | 0 / 7 | **7 / 7** |
| Failed imports presented as scored candidates | 13 | **0** |

The control fixture `samples/furniture-plan.dwg` is unchanged throughout at 930.1 m², 3 keep-outs,
104 desks. 134 Rust tests and all 13 `web/src/import` suites pass.

## The acceptance measure is not "it placed desks"

An over-scaled plate places desks happily. `harness/scaleCheck.mjs` asks the question the artifact
can answer on its own: in the final metres-space `Drawing`, **what fraction of the door swings are
legal doors, and what fraction of the wall pairs are legal wall assemblies?** Bands come from
external specifications (IBC 1010.1.1, NBC 2016 Part 4, DIN 18101; wall-assembly thicknesses) — never
from this corpus, per `.claude/rules/gate-independence.md`.

`PHYSICAL` = at least one anchor majority-satisfied. That is the number in the table above, and it
is deliberately stricter than the end-to-end one.

## Shipped

| Commit | Fixes | Effect on the corpus |
|---|---|---|
| `3b05fcc` category vocabulary | [F2](findings/F2-layer-category-inference.md) | walls found on 4 files that had none (`MURO`, `PUERTAS`, `VENTANAS`, `MOBILIARIO`, `ARREDI`, `MEBEL`); trees/hatch/cut-lines classified as decoration so they stop polluting wall tracing |
| `f1a79d7` scale from geometry | [F1](findings/F1-unit-scale-trusted-blindly.md) | 2 → 9 placing furniture |
| `61a218c` converter integrity | [F5](findings/F5-converter-integrity.md), [F6](findings/F6-converter-crash-ux.md) | `Apartment-1` 200-OK-with-garbage → honest 502; SIGSEGV reported as a crash, error payload 3 KB → 540 B |
| `5c47d2c` `dwgread -O JSON` fallback | [F5](findings/F5-converter-integrity.md) | 3 unopenable files now import; `AC` → 1141 m², 100% capacity |
| `5be7f7a` world-space anchors + wall anchor | [F1](findings/F1-unit-scale-trusted-blindly.md) | 9 → 15; plates also became *more plausible* (AG 1551 → 144 m²) |
| `ce0e15f` consensus across anchors | [F1](findings/F1-unit-scale-trusted-blindly.md) | AB 6.3 → 74 m², AM 1.3 → 20 m² |
| `c2ff4ba` population support scoring | [F1](findings/F1-unit-scale-trusted-blindly.md) | 15 → 20; hardware arcs can no longer outvote door leaves |
| `6faced2` empty plans are failures | [F4](findings/F4-empty-plan-scored-as-success.md), [F8](findings/F8-vacuous-coverage-claim.md), [F9](findings/F9-wizard-gating.md) | `LayoutScore.feasible`; infeasible candidates never rendered; Space step gates on a **plate**, not on a file arriving |
| `5f90cca` scale confidence | [F1](findings/F1-unit-scale-trusted-blindly.md) | every wrongly-scaled import now says so — 25/25 agreement with the independent gate |

Each carries its gate. `units.test.mjs` holds the independence demonstration the rules require —
`$INSUNITS` rewritten to every legal code, to garbage, and deleted, all yield byte-identical
geometry. `dwgJson.test.mjs` asserts cross-path equivalence between the two LibreDWG front ends
rather than against a stored golden. The Rust test for `feasible` asserts an *ordering* (an empty
plate must score strictly below a populated one), because a threshold on the absolute value would
not have caught the inversion — 38.7 reads as a bad score rather than a vacuous one.

## Not yet fixed

### 1. Four files still place nothing

| File | Plate | Assessment |
|---|---|---|
| `BUSNSS-Offcs-CwSp_AA.dwg` | 6.9 m² | **real bug.** Scale wrong: 70% of 845 wall gaps read as physical at inches, but a 4.9 × 1.8 m "office" with 1 375 wall entities is not one. The wall anchor is satisfiable at more than one scale and the header wins ties. |
| `BUSNSS-Offcs-Trdtnl_AL.dwg` | 21.5 m² | **unverifiable.** No door arcs, no wall-category entities, and the file has *no layer table at all* — there is nothing to anchor to. Correctly flagged `low` confidence. |
| `BUSNSS-Offcs-Trdtnl_AM.dwg` | 20.1 m² | **probably correct.** The plate is physical (52% of 446 wall gaps); 20 m² genuinely will not hold a 20-desk program. A clean 5 × 5 m rectangle places 1 desk and a 9.5 × 2.4 m one places 0, so this is near the true floor. |
| `Office-furniture-blocks.zip/cad33.dwg` | none | **out of scope.** A furniture block library, not a floor plan. Refusing is right; it now says so and blocks the wizard rather than proceeding. |

### 2. Five files still import at a wrong scale — but they now say so

`AB`, `AI`, `AE`, `AH`, `muebles varios` still fail the physical check. They are no longer silent:
each carries `scaleConfidence: 'low'` with the measured percentages, and the Space step shows
"Check the scale" above the areas. The **detection** is solved (25/25 against the independent gate);
the **inference** is not.

### 3. The packer is NOT the blocker — that earlier diagnosis was wrong

An earlier revision of this document reported that the packer collapses on irregular plates: `AB`'s
74 m² comb-shaped plate placed zero desks where its own bounding box placed eight.

**That measurement was taken against mis-scaled plates.** `AB` was being read at 13 × 9.3 m; it is
really 133 × 93 m. Once the scale anchors were fixed the same file traces a 10 880 m² plate and
places a full program at 100% capacity, with no change to the packer at all. Every file in that
table now places furniture.

Recorded rather than deleted because it is the trap this whole exercise is about: a real, repeatable,
carefully-measured effect whose *cause* was one layer upstream of where it appeared. Yield does still
degrade on genuinely irregular plates (`fast-food`: 40 desks on its true outline vs 48 on its bounding
box, −17%), which is worth its own investigation — but it is a refinement, not a blocker, and the
boundary-conforming-rooms work should be scoped against fresh measurements.

### 4. Remaining from the original findings

- [F3](findings/F3-no-plate-derived.md) — `derivePlate` still returns a bare `null`; the Space step
  now explains the failure generically, but a typed reason would let it say *which* stage failed.
- [F10](findings/F10-zip-and-non-cad-input.md) — `.zip` uploads still unsupported.
- [F7](findings/F7-cluster-filter-overreach.md) — `keepDominantCluster` now runs *after* scaling
  (it has an absolute 60 m floor), which changes its behaviour; it has not been re-measured since.

## Reproduce

```bash
node cad-validation/harness/scaleCheck.mjs   # the acceptance measure
node cad-validation/harness/e2e.mjs          # plate -> core -> generate -> score
node cad-validation/harness/run.mjs          # per-stage census
```
