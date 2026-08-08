# Status — CAD import remediation

Running record against the findings in [`findings/00-SUMMARY.md`](findings/00-SUMMARY.md) and the
plan in [`SOLUTIONS.md`](SOLUTIONS.md). Updated 2026-08-06, branch `testing-edge-variations`.

## Where it started, where it is

| Measure | Before | Now |
|---|---|---|
| Blocked at conversion (crash / truncation) | 3 | **0** |
| No floor plate derived | 6 | **1** (`cad33`) |
| Places furniture end-to-end | **2 / 24** | **21 / 24** |
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
| `7602805` furniture-footprint anchor | [F1](findings/F1-unit-scale-trusted-blindly.md) | 20 → 21; `CwSp_AA` 6.9 → 4 595 m² (a 4.9 × 1.8 m "office" with 1 375 walls), `AH` 885 → 9 530 m² |

Each carries its gate. `units.test.mjs` holds the independence demonstration the rules require —
`$INSUNITS` rewritten to every legal code, to garbage, and deleted, all yield byte-identical
geometry. `dwgJson.test.mjs` asserts cross-path equivalence between the two LibreDWG front ends
rather than against a stored golden. The Rust test for `feasible` asserts an *ordering* (an empty
plate must score strictly below a populated one), because a threshold on the absolute value would
not have caught the inversion — 38.7 reads as a bad score rather than a vacuous one.

## Not yet fixed

### 1. Three files still place nothing — all three now diagnosed

| File | State | Verdict |
|---|---|---|
| `BUSNSS-Offcs-Trdtnl_AL.dwg` | 21.5 m² plate, 0 desks | **Unverifiable by construction.** No door arcs, no wall-category entities, and the file carries *no layer table at all* — there is nothing to anchor scale to. Correctly flagged `low` confidence, so the user is told the size is unconfirmed rather than shown a number to trust. Nothing to fix without a human supplying a known dimension; the raster path's scale tool is the right escape hatch. |
| `BUSNSS-Offcs-Trdtnl_AM.dwg` | 20.1 m² plate, 0 desks | **Behaving correctly.** Its plate is physical (52 % of 446 wall pairs are wall-thickness) and 20 m² genuinely will not hold a 20-desk program: a clean 5 × 5 m rectangle places 1 desk and a 9.5 × 2.4 m one places 0, so this sits at the true floor. The generator now reports `feasible: false` rather than a 38/100 score. |
| `Office-furniture-blocks.zip/cad33.dwg` | no plate | **Out of scope, and now explained.** F7's re-measurement showed why: its 14 949 entities are block *definitions* piled at the origin, while the 8 INSERTs that place them spread across a 324 m sheet. `keepDominantCluster` keeps the origin pile — correct for a floor plan, fatal for a block library, because there is no floor plan in the file. It is a furniture catalogue, not a plan. The wizard now blocks with `no-shell-geometry`, whose message names exactly this case ("…or it may be a furniture library rather than a floor plan"). |

None of the three is an open defect. Two are the system correctly declining, and
one is a drawing that cannot be scaled without outside information.

### 2. Five files still import at a wrong scale — but they now say so

`AB`, `AI`, `AE`, `AH`, `muebles varios` still fail the independent physical
check. They are no longer silent: each carries `scaleConfidence: 'low'` with the
measured percentages, and the Space step shows "Check the scale" above the areas.
The **detection** is solved (25/25 agreement with `harness/scaleCheck.mjs`, which
shares no code with the importer's own grading); the **inference** is not.

### 3. The packer is NOT the blocker — that earlier diagnosis was wrong

An earlier revision of this document reported that the packer collapses on
irregular plates: `AB`'s 74 m² comb-shaped plate placed zero desks where its own
bounding box placed eight.

**That measurement was taken against mis-scaled plates.** `AB` was being read at
13 × 9.3 m; it is really 133 × 93 m. Once the scale anchors were fixed the same
file traces a 10 880 m² plate and places a full program at 100 % capacity, with
no change to the packer at all.

Recorded rather than deleted because it is the trap this whole exercise is
about: a real, repeatable, carefully-measured effect whose *cause* was one layer
upstream of where it appeared. Yield does still degrade on genuinely irregular
plates (`fast-food`: 40 desks on its true outline vs 48 on its bounding box,
−17 %), which is worth its own investigation — but it is a refinement, not a
blocker, and should be scoped against fresh measurements.

### 4. Closed since

- [F3](findings/F3-no-plate-derived.md) — `tracePlate` now returns a typed
  reason; `App.tsx`'s guessed "No wall geometry found" (wrong on 4 of 6 files)
  is gone.
- [F7](findings/F7-cluster-filter-overreach.md) — re-measured after the scaling
  change. The filter is working correctly on real plans (control drops
  441 e/100 f and lands on the right 38 × 42.4 m; AG, Apartment-1, Two-story and
  AC likewise) and needs no change. It also surfaced two real bugs, both fixed:
  corrupt coordinates from LibreDWG's JSON (`3.47e+115`) now rejected at the
  fallback boundary, and cad33's diagnosis above.
- [F10](findings/F10-zip-and-non-cad-input.md) — `.zip` archives import
  directly, via the native `DecompressionStream`.
- The `programBuckets` discrepancy — both tallies were correct and counting
  different things, but `bankCategoryForItem` was English-only with a
  `task-chair` catch-all, so *unrecognised* furniture was indistinguishable from
  *is a chair* and vanished from the program. Vocabulary extended; the readout
  now explains an all-zero program rather than leaving it to be reconciled.

## Reproduce

```bash
node cad-validation/harness/scaleCheck.mjs   # the acceptance measure
node cad-validation/harness/e2e.mjs          # plate -> core -> generate -> score
node cad-validation/harness/run.mjs          # per-stage census
```
