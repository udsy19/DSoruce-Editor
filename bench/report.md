# Bake-off report — `plate`

Regenerate with `pnpm bench plate`. Raw results: `bench/results/plate.json`.

## Implementations

| impl | portability | license | summary |
|---|---|---|---|
| `baseline` | A-port | original | Current hull/loop tracer in import/testfit.ts, unmodified. |
| `column-grid` | A-port | original | Envelope from the structural column grid, extended half a median bay. Rejects unless BOTH axes pass an IQR ≤ 25%-of-median regularity guard. |
| `partition-envelope` | A-port | original | gridContour with an escalating dilation schedule (0.5–6.0 m) stopped by furniture containment, not coverage. Reuses the incumbent rasterizer. |

## Per-fixture results

**GATES** must pass before a phantom number means anything: `self×` = 0 AND
`contain` (furniture bbox centres inside the envelope) ≥ 0.98 — phantom fraction is
minimizable by shrinking, and containment is what catches that. `linework` is a
diagnostic, never gated (keep-outs and service runs legitimately sit outside).

`IoU` vs ground truth · 
`Δarea%` signed · `dev` worst boundary deviation (m) · `orth%` length-weighted ·
`phantom` boundary metres with no supporting linework · `det` deterministic.

### `curved-facade`
_Arc facade: over-regularisation destroys it, so it guards the regularise candidate._
Truth area: **985.1175 m²** · truth source: synthetic — truth is the generating polygon, exact by construction

| impl | GATES | self× | contain | IoU | Δarea% | dev m | phantom m (%) | linework | verts | ms | det |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `baseline` | pass | 0 | 1 | 0.9904 | -0.2 | 0.187 | **1.49** (1.1%) | 0.4924 | 17 | 15.2 | y |
| `column-grid` | — | — | — | — | — | — | — | — | — | — | no plate returned |
| `partition-envelope` | pass | 0 | 1 | 0.9904 | -0.17 | 0.187 | **1.49** (1.1%) | 0.5071 | 18 | 6.6 | y |

### `lshape-door-gaps`
_Re-entrant corner: hull tracers cut the notch off — the classic phantom diagonal._
Truth area: **624 m²** · truth source: synthetic — truth is the generating polygon, exact by construction

| impl | GATES | self× | contain | IoU | Δarea% | dev m | phantom m (%) | linework | verts | ms | det |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `baseline` | pass | 0 | 1 | **0.9788** | 0.24 | 0.395 | **6.21** (5.4%) | 0.4817 | 6 | 8.3 | y |
| `column-grid` | — | — | — | — | — | — | — | — | — | — | no plate returned |
| `partition-envelope` | pass | 0 | 1 | **0.9788** | 0.24 | 0.395 | **6.21** (5.4%) | 0.4817 | 6 | 6.1 | y |

### `lshape-jitter-dup-gaps`
_All three defects at once — the composed-pipeline case the research predicts._
Truth area: **624 m²** · truth source: synthetic — truth is the generating polygon, exact by construction

| impl | GATES | self× | contain | IoU | Δarea% | dev m | phantom m (%) | linework | verts | ms | det |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `baseline` | pass | 0 | 1 | 0.9908 | 0 | 0.049 | 0 (0%) | 0.2295 | 6 | 0.5 | y |
| `column-grid` | — | — | — | — | — | — | — | — | — | — | no plate returned |
| `partition-envelope` | pass | 0 | 1 | **0.9789** | 0.24 | 0.386 | 0 (0%) | 0.4913 | 6 | 0.6 | y |

### `lshape-shell-fragments`
_PRODUCTION BUG CLASS: shell present only as fragments — forces hull fallback across the notch._
Truth area: **624 m²** · truth source: synthetic — truth is the generating polygon, exact by construction

| impl | GATES | self× | contain | IoU | Δarea% | dev m | phantom m (%) | linework | verts | ms | det |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `baseline` | pass | 0 | 1 | **0.7295** | -25.34 | 7.375 | **74.81** (44.5%) | 0.7057 | 28 | 17.7 | y |
| `column-grid` | — | — | — | — | — | — | — | — | — | — | no plate returned |
| `partition-envelope` | pass | 0 | 1 | **0.9788** | 0.24 | 0.395 | **27.48** (23.7%) | 0.7446 | 6 | 14.7 | y |

### `notched-core`
_Deep notch (a lift core biting into the slab) — two re-entrant corners._
Truth area: **976 m²** · truth source: synthetic — truth is the generating polygon, exact by construction

| impl | GATES | self× | contain | IoU | Δarea% | dev m | phantom m (%) | linework | verts | ms | det |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `baseline` | pass | 0 | 1 | 0.9829 | 0.2 | 0.395 | **2.96** (2%) | 0.521 | 8 | 3.4 | y |
| `column-grid` | — | — | — | — | — | — | — | — | — | — | no plate returned |
| `partition-envelope` | pass | 0 | 1 | 0.9829 | 0.2 | 0.395 | **2.96** (2%) | 0.521 | 8 | 0.4 | y |

### `notched-shell-fragments`
_PRODUCTION BUG CLASS: two re-entrant corners with a fragmented shell — worst case for a hull._
Truth area: **976 m²** · truth source: synthetic — truth is the generating polygon, exact by construction

| impl | GATES | self× | contain | IoU | Δarea% | dev m | phantom m (%) | linework | verts | ms | det |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `baseline` | **FAIL** | **2** | 1 | **0.8845** | -10.02 | 7.375 | **66.4** (35.9%) | 0.7614 | 32 | 19.7 | y |
| `column-grid` | — | — | — | — | — | — | — | — | — | — | no plate returned |
| `partition-envelope` | pass | 0 | 1 | **0.9251** | 6.56 | 8.125 | **43** (32.6%) | 0.7813 | 4 | 81.5 | y |

### `rect-clean`
_Control. If a candidate cannot do this, nothing else matters._
Truth area: **600 m²** · truth source: synthetic — truth is the generating polygon, exact by construction

| impl | GATES | self× | contain | IoU | Δarea% | dev m | phantom m (%) | linework | verts | ms | det |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `baseline` | pass | 0 | 1 | 1 | 0 | 0 | 0 (0%) | 0.5 | 4 | 0.1 | y |
| `column-grid` | — | — | — | — | — | — | — | — | — | — | no plate returned |
| `partition-envelope` | pass | 0 | 1 | 0.9835 | 0 | 0.177 | 0 (0%) | 0.5 | 4 | 0.3 | y |

### `rect-door-gaps`
_Doors/windows break wall continuity — the gap-closing case (L5IN / IIETA)._
Truth area: **600 m²** · truth source: synthetic — truth is the generating polygon, exact by construction

| impl | GATES | self× | contain | IoU | Δarea% | dev m | phantom m (%) | linework | verts | ms | det |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `baseline` | pass | 0 | 1 | 0.9835 | 0 | 0.177 | **4** (4%) | 0.4981 | 4 | 4 | y |
| `column-grid` | — | — | — | — | — | — | — | — | — | — | no plate returned |
| `partition-envelope` | pass | 0 | 1 | 0.9835 | 0 | 0.177 | **4** (4%) | 0.4981 | 4 | 0.6 | y |

### `rect-duplicated-layers`
_A second, 40 mm-offset wall layer — overlapping-wall elimination (Wu et al.)._
Truth area: **600 m²** · truth source: synthetic — truth is the generating polygon, exact by construction

| impl | GATES | self× | contain | IoU | Δarea% | dev m | phantom m (%) | linework | verts | ms | det |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `baseline` | pass | 0 | 1 | 1 | 0 | 0 | 0 (0%) | 0.5 | 4 | 0.1 | y |
| `column-grid` | — | — | — | — | — | — | — | — | — | — | no plate returned |
| `partition-envelope` | pass | 0 | 1 | 0.9835 | 0 | 0.177 | 0 (0%) | 0.5 | 4 | 0.3 | y |

### `rect-jitter`
_Endpoints 8 mm off coincident — the snap/set_precision case (dxf-fix)._
Truth area: **600 m²** · truth source: synthetic — truth is the generating polygon, exact by construction

| impl | GATES | self× | contain | IoU | Δarea% | dev m | phantom m (%) | linework | verts | ms | det |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `baseline` | pass | 0 | 1 | 1 | 0.02 | 0.007 | 0 (0%) | 0.7463 | 4 | 0.1 | y |
| `column-grid` | — | — | — | — | — | — | — | — | — | — | no plate returned |
| `partition-envelope` | pass | 0 | 1 | 0.9835 | 0 | 0.169 | 0 (0%) | 0.5 | 4 | 0.2 | y |

### `rect-no-shell-only-partitions`
_PRODUCTION BUG CLASS: no exterior wall at all, only interior partitions + scattered columns — the real DWG condition._
Truth area: **600 m²** · truth source: synthetic — truth is the generating polygon, exact by construction

| impl | GATES | self× | contain | IoU | Δarea% | dev m | phantom m (%) | linework | verts | ms | det |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `baseline` | **FAIL** | 0 | **0.9615** | **0.6442** | -35.58 | 5.304 | **69.32** (68%) | 0.8729 | 36 | 24.9 | y |
| `column-grid` | — | — | — | — | — | — | — | — | — | — | no plate returned |
| `partition-envelope` | **FAIL** | 0 | **0.6154** | **0.6457** | -35.43 | 4.72 | **45.65** (54.1%) | 0.9215 | 18 | 63.9 | y |

### `rect-regular-column-grid`
_Fair test for the column-grid rung: no shell, a REGULAR 4x3 column grid inset half a bay._
Truth area: **600 m²** · truth source: synthetic — truth is the generating polygon, exact by construction

| impl | GATES | self× | contain | IoU | Δarea% | dev m | phantom m (%) | linework | verts | ms | det |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `baseline` | pass | 0 | 1 | **0.7747** | -22.53 | 4.043 | **76.39** (90.6%) | 1 | 13 | 12.6 | y |
| `column-grid` | pass | 0 | 1 | 1 | 0 | 0 | **100** (100%) | 1 | 4 | 0.2 | y |
| `partition-envelope` | **FAIL** | 0 | **0.5417** | **0.6049** | -39.52 | 4.585 | **48.25** (56.2%) | 0.8727 | 20 | 60.3 | y |

### `rect-wide-gaps`
_Gaps widened to 2.4 m — past a door leaf, where naive closing over-bridges._
Truth area: **600 m²** · truth source: synthetic — truth is the generating polygon, exact by construction

| impl | GATES | self× | contain | IoU | Δarea% | dev m | phantom m (%) | linework | verts | ms | det |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `baseline` | pass | 0 | 1 | 0.9835 | 0 | 0.177 | **13** (13%) | 0.5035 | 4 | 4.8 | y |
| `column-grid` | — | — | — | — | — | — | — | — | — | — | no plate returned |
| `partition-envelope` | pass | 0 | 1 | 0.9835 | 0 | 0.177 | **13** (13%) | 0.5035 | 4 | 2.3 | y |

### `rot17-door-gaps`
_Rotated 17°: every axis-aligned assumption breaks; regularisation must not force it square._
Truth area: **600 m²** · truth source: synthetic — truth is the generating polygon, exact by construction

| impl | GATES | self× | contain | IoU | Δarea% | dev m | phantom m (%) | linework | verts | ms | det |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `baseline` | pass | 0 | 1 | 1 | 0 | 0 | **3.47** (3.5%) | 0.4819 | 6 | 9.4 | y |
| `column-grid` | — | — | — | — | — | — | — | — | — | — | no plate returned |
| `partition-envelope` | **FAIL** | 0 | **0.0556** | **0.0371** | -96.26 | 26.753 | **11.49** (36.1%) | 0.1166 | 4 | 49.3 | y |

### `real-furniture-plan`
_The real 882 m² plan. No closed exterior envelope on any wall layer._
Truth area: **not established** · truth source: TRUTH NOT ESTABLISHED — truth-free metrics only (see truth/README.md)

| impl | GATES | self× | contain | IoU | Δarea% | dev m | phantom m (%) | linework | verts | ms | det |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `baseline` | **FAIL** | 0 | **0.9606** | — | — | — | **78.81** (46.3%) | 0.9133 | 31 | 77.2 | y |
| `column-grid` | — | — | — | — | — | — | — | — | — | — | no plate returned |
| `partition-envelope` | **FAIL** | 0 | **0.7617** | — | — | — | **71.74** (43.7%) | 0.9548 | 27 | 199.3 | y |
