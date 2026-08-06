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

Each carries its gate. `units.test.mjs` holds the independence demonstration the rules require —
`$INSUNITS` rewritten to every legal code, to garbage, and deleted, all yield byte-identical
geometry. `dwgJson.test.mjs` asserts cross-path equivalence between the two LibreDWG front ends
rather than against a stored golden.

## Not yet fixed

### 1. Four files still place nothing

| File | Plate | Why |
|---|---|---|
| `BUSNSS-Offcs-CwSp_AA.dwg` | 6.9 m² | scale still wrong — 845 wall gaps are 70% physical at inches, but a 4.9 × 1.8 m "office" is not |
| `BUSNSS-Offcs-Trdtnl_AL.dwg` | 21.5 m² | **no anchor exists**: 0 wall-category entities, no door arcs, and the file has *no layer table at all* |
| `BUSNSS-Offcs-Trdtnl_AM.dwg` | 20.1 m² | plate is physical but small; needs the packer fix below |
| `Office-furniture-blocks.zip/cad33.dwg` | none | a furniture block library, not a floor plan — arguably correct to refuse, but it must say so |

### 2. Five files import at a wrong scale while *looking* successful

`AB` (10 880 m²), `AI` (5 253 m²), `AE`, `AH`, `muebles varios` (1 253 m²) place furniture and score
well, but fail the physical check. **These are the dangerous ones** — they are exactly the
[F4](findings/F4-empty-plan-scored-as-success.md) failure mode wearing a success badge, and the user
cannot tell them apart from the correct ones today.

### 3. The packer collapses on irregular plates — a core limitation, not an import bug

Measured directly (`/tmp/shape.mjs` methodology, reproducible from the plate rings in
`reports/_e2e.json`):

| File | Actual plate | Convex hull | Bounding box |
|---|---|---|---|
| `BUSNSS-Offcs-Trdtnl_AB` | **0 desks** | 2 | 8 |
| `Apartment-1` | **0 desks** | 3 | 4 |
| `BUSNSS-Offcs-Trdtnl_AL` | **0 desks** | 0 | 2 |
| `fast-food-Restaurant` | 40 | 38 | 48 |

A clean 13 × 9.3 m rectangle places 8 desks; `AB`'s 74 m² comb-shaped plate with the same bounding
box placed **zero, even when asked for one desk**. Yield degrades mildly on large irregular plates
(fast-food, −17%) and totally on small ones.

The cause is in `crates/ds-core/src/layout.rs`: a non-rectangular plate is decomposed into
axis-aligned rectangles (`decompose_plate`, `REGION_MIN_DIM = 3.0`, `REGION_MIN_AREA = 9.0`), each
region then loses 0.9 m of facade inset per boundary edge. A comb of 3.5 m fingers survives the
minimum but has ~1.7 m left after insets, and nothing packs.

This is the boundary-conforming-rooms gap already on the roadmap. It is **core layout work, not
importer work**, and `golden_generate_output_is_frozen` pins `generate()` output for 10 (program,
seed) cases — so any packer change must re-capture that golden deliberately, never relax it.

### 4. Untouched from the original findings

[F3](findings/F3-no-plate-derived.md) (typed plate-failure reasons),
[F4](findings/F4-empty-plan-scored-as-success.md) (empty plans scoring 38–43/100 with three
sub-scores at 100), [F8](findings/F8-vacuous-coverage-claim.md) (vacuous coverage claim),
[F9](findings/F9-wizard-gating.md) (no gate between a failed import and the priced deliverable),
[F10](findings/F10-zip-and-non-cad-input.md) (`.zip` support).

**F4 and F9 matter more now, not less.** With scale mostly fixed, the remaining failures are subtler
— a plate that is 30× too large rather than 1000× too small — and the UI still reports every one of
them as a success with a score attached.

## Reproduce

```bash
node cad-validation/harness/scaleCheck.mjs   # the acceptance measure
node cad-validation/harness/e2e.mjs          # plate -> core -> generate -> score
node cad-validation/harness/run.mjs          # per-stage census
```
