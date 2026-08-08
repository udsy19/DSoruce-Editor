# CAD import validation — summary

**Corpus:** 24 files supplied by the user (21 loose `.dwg`, 3 `.dwg` extracted from `.zip`).
**Control:** `samples/furniture-plan.dwg`, the repo's own curated fixture, run through the identical
harness so every number below has a known-good reference point.

**Date:** 2026-08-05 · **Branch:** `testing-edge-variations` · **No source files were modified.**

---

## Scoreboard

| Outcome | Count | Meaning |
|---|---|---|
| **WORKS** | **2 / 24** | plate traced at a believable size, generator placed furniture |
| **SILENT FAILURE** | **13 / 24** | a plate *was* produced and the UI proceeded — but it is 1–78 m² instead of hundreds, and the generator placed **zero desks**. The user is shown a scored candidate gallery for an empty plan. |
| **BLOCKED** | **9 / 24** | hard stop: converter crash (2), truncated conversion (1), no plate derived (6) |

The control fixture passes cleanly at every stage (930 m² plate, 3 keep-outs, 104 desks, score 88.8).
**The pipeline is not broken — its tolerance for real-world CAD is.** Every failure below is a
robustness gap against files the app did not curate.

The single most important number: **13 of 24 files fail without telling the user.** Those are worse
than the 9 that block, because the wizard walks the user to "Pick a test-fit · 3 alternatives ·
best 41/100" on a document containing nothing.

---

## Root causes, ranked

| # | Finding | Files hit | Severity |
|---|---|---|---|
| [F1](F1-unit-scale-trusted-blindly.md) | `$INSUNITS` is trusted with no plausibility check; drawings land 25×–1000× too small | ≥ 8 proven, suspected in most of the 13 silent failures | **Critical** |
| [F2](F2-layer-category-inference.md) | Category inference is English/AIA-layer-only; Spanish, numeric and unnamed layers collapse to `other`, so the plate tracer sees no walls | 13 of 21 parsed files at ≥ 70 % `other`, 4 at 100 % | **Critical** |
| [F3](F3-no-plate-derived.md) | `derivePlate` returns `null` → "No plate traced", yet the wizard still advances | 6 | **High** |
| [F4](F4-empty-plan-scored-as-success.md) | Empty plans score 38–43/100 with adjacency/daylight/entry at **100** — a vacuous perfect score | 13 | **Critical** |
| [F5](F5-converter-integrity.md) | `dwg2dxf` truncates output while exiting 0; the API returns **200 OK** with a broken DXF | 1 proven | **High** |
| [F6](F6-converter-crash-ux.md) | `dwg2dxf` segfaults (exit 139); API replies `"dwg2dxf exited null:"` + 3 KB of raw C stderr | 2 | **Medium** |
| [F7](F7-cluster-filter-overreach.md) | `keepDominantCluster` drops 102 of 13 348 entities and shrinks the drawing 108× | 3 | **High** |
| [F8](F8-vacuous-coverage-claim.md) | "100 % furniture coverage" printed when the drawing contains **zero** furniture | 8 (of the 15 that produce a plate) | **Medium** |
| [F9](F9-wizard-gating.md) | No gate anywhere between a failed import and the priced deliverable | all failures | **High** |
| [F10](F10-zip-and-non-cad-input.md) | `.zip` uploads unsupported; one supplied archive contains only JPEGs | 4 archives | **Low** |

---

## Per-file matrix

Outcome, root cause and every measured value, per file. `Scale check` is an **independent**
re-derivation (see [F1](F1-unit-scale-trusted-blindly.md)) — it never reads what the importer decided.

| File | Outcome | Root cause | Declared units | Scale check (door anchor) | Ents | Furn | % other | % wall | Plate m² | Method | Conf. | Keep-outs | Entries | Desks placed | Score /100 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| BUSNSS-Offcs-Trdtnl_AG.dwg | SILENT FAILURE | plate derived but 0 desks placed | in | MIS-SCALED ~39.3701x | 13246 | 0 | 11 | 2 | 2.5 | hull | low | 0 | 2 | 0 | 38.7 |
| Apartment-1.dwg | BLOCKED | truncated DXF from dwg2dxf (exit 0) | mm | no door-arc evidence | — | — | — | — | — | — | — | — | — | — | — |
| Apartment-413201.dwg | BLOCKED | no floor plate derived | mm | MIS-SCALED ~1000x | 1687 | 0 | 90 | 2 | — | — | — | — | — | — | — |
| Apto.1404202.dwg | BLOCKED | no floor plate derived | mm | MIS-SCALED ~1000x | 7516 | 0 | 7 | 1 | — | — | — | — | — | — | — |
| BUSNSS-Offcs_AN.dwg | SILENT FAILURE | plate derived but 0 desks placed | in | no door-arc evidence | 12648 | 0 | 23 | 0 | 29.2 | hull | low | 0 | 1 | 0 | 41.6 |
| BUSNSS-Offcs-CwSp_AA.dwg | SILENT FAILURE | plate derived but 0 desks placed | in | no door-arc evidence | 25028 | 105 | 86 | 5 | 6.9 | hull | high | 0 | 1 | 0 | 39.8 |
| BUSNSS-Offcs-Trdtnl_AA.dwg | SILENT FAILURE | plate derived but 0 desks placed | in | MIS-SCALED ~39.3701x | 1398 | 50 | 5 | 48 | 4.2 | hull | high | 0 | 3 | 0 | 39 |
| BUSNSS-Offcs-Trdtnl_AB.dwg | SILENT FAILURE | plate derived but 0 desks placed | in | MIS-SCALED ~?x | 50469 | 28 | 37 | 3 | 6.9 | hull | high | 0 | 4 | 0 | 40.7 |
| BUSNSS-Offcs-Trdtnl_AC.dwg | BLOCKED | dwg2dxf crashed (SIGSEGV) | — | no door-arc evidence | — | — | — | — | — | — | — | — | — | — | — |
| BUSNSS-Offcs-Trdtnl_AE.dwg | SILENT FAILURE | plate derived but 0 desks placed | in | no door-arc evidence | 8239 | 9 | 77 | 2 | 1.7 | hull | low | 0 | 1 | 0 | 38.6 |
| BUSNSS-Offcs-Trdtnl_AF.dwg | BLOCKED | dwg2dxf crashed (SIGSEGV) | — | no door-arc evidence | — | — | — | — | — | — | — | — | — | — | — |
| BUSNSS-Offcs-Trdtnl_AG (1).dwg | SILENT FAILURE | plate derived but 0 desks placed | in | MIS-SCALED ~39.3701x | 13246 | 0 | 11 | 2 | 2.5 | hull | low | 0 | 2 | 0 | 38.7 |
| BUSNSS-Offcs-Trdtnl_AH.dwg | SILENT FAILURE | plate derived but 0 desks placed | in | MIS-SCALED ~?x | 134735 | 187 | 99 | 0 | 3.8 | wrap | low | 0 | 2 | 0 | 39.4 |
| BUSNSS-Offcs-Trdtnl_AI.dwg | SILENT FAILURE | plate derived but 0 desks placed | in | MIS-SCALED ~?x | 12129 | 0 | 70 | 6 | 2.8 | hull | high | 0 | 3 | 0 | 38.8 |
| BUSNSS-Offcs-Trdtnl_AL.dwg | SILENT FAILURE | plate derived but 0 desks placed | in | no door-arc evidence | 8356 | 0 | 100 | 0 | 21.5 | hull | low | 0 | 1 | 0 | 42.4 |
| BUSNSS-Offcs-Trdtnl_AM.dwg | SILENT FAILURE | plate derived but 0 desks placed | in | no door-arc evidence | 15524 | 0 | 91 | 2 | 3.7 | hull | low | 0 | 2 | 0 | 38.5 |
| BUSNSS-Offcs-Trdtnl_AN.dwg | BLOCKED | no floor plate derived | in | MIS-SCALED ~?x | 3317 | 21 | 13 | 8 | — | — | — | — | — | — | — |
| call-center-offices.dwg | BLOCKED | no floor plate derived | in | no door-arc evidence | 1238 | 0 | 100 | 0 | — | — | — | — | — | — | — |
| fast-food-Restaurant.dwg | WORKS |  | m | scale OK | 7907 | 17 | 94 | 5 | 342.9 | hull | low | 0 | 5 | 19 | 86.9 |
| Small-apto..dwg | BLOCKED | no floor plate derived | mm | no door-arc evidence | 1888 | 0 | 40 | 0 | — | — | — | — | — | — | — |
| Two-story-house-410202.dwg | SILENT FAILURE | plate derived but 0 desks placed | in | no door-arc evidence | 2626 | 0 | 94 | 5 | 1.3 | hull | low | 0 | 1 | 0 | 38.5 |
| Hospital-equipment.zip/MOBILIARIO HOSPITAL.dwg | WORKS |  | m | no door-arc evidence | 16233 | 0 | 100 | 0 | 450.4 | hull | low | 0 | 1 | 41 | 85.5 |
| Office-furniture-blocks.zip/cad33.dwg | SILENT FAILURE | plate derived but 0 desks placed | m | no door-arc evidence | 15134 | 1 | 98 | 0 | 78.1 | hull | low | 0 | 1 | 0 | 43.1 |
| Various-furniture-blocks.zip/muebles varios.dwg | BLOCKED | no floor plate derived | mm | no door-arc evidence | 19526 | 2 | 100 | 0 | — | — | — | — | — | — | — |
| samples/furniture-plan.dwg (repo fixture — control) | WORKS |  | — | no door-arc evidence | — | — | — | — | 930.1 | — | — | 3 | 2 | 104 | 88.8 |

---

## How this was measured

Four harnesses under `cad-validation/harness/`, all running the **real production modules**
(`web/src/import/{dxf,heal,plate,testfit,plateQuality,normalize}.ts`) bundled for Node, plus the real
`web/src/wasm` build — the same code paths `App.tsx` calls on import and test-fit:

| Script | What it establishes |
|---|---|
| `run.mjs` | per-stage pass/fail, timings, entity + category census, plate provenance |
| `units.mjs` | header facts and true source-unit extents, read from the DXF bytes |
| `scaleAnchor.mjs` | **scale ground truth from door-swing radii** — independent of `$INSUNITS` |
| `cluster.mjs` | what `keepDominantCluster` discards (instrumented *copy* of `dxf.ts`) |
| `e2e.mjs` | plate → Rust core → `generate()` → `circulation()` / `layout_score()` |

Raw output: `cad-validation/reports/*.json`. Browser evidence: `findings/screens/`.

### On gate independence

Per `.claude/rules/gate-independence.md`, no measurement here consumes the importer's own account of
what it did:

- **Scale** is judged against door-swing arc radii (0.65–1.30 m by IBC 1010.1.1 / NBC 2016 Part 4),
  read from raw DXF at scale 1.0 — not against `Drawing.units`.
- **Plate area** is recomputed from the boundary ring by the shoelace formula, not read from
  `PlateResult.areaM2`. **Coverage** is recomputed by point-in-polygon over furniture bbox centres,
  not read from `PlateResult.coverage`. Both agree with the reported values on every file — the
  reported numbers are honest; what they *describe* is wrong.
- **Desk placement** is read from core state after `generate()`, not from the returned metrics.
- Conversion is judged on **exit code *and* signal *and* whether the DXF parses** — F5 exists
  precisely because the current code trusts the exit code alone.
