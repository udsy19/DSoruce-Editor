# Bake-off report — `plate`

Regenerate with `pnpm bench plate`. Raw results: `bench/results/plate.json`.

## Implementations

| impl | portability | license | summary |
|---|---|---|---|
| `baseline` | A-port | original | Current hull/loop tracer in import/testfit.ts, unmodified. |

## Per-fixture results

`self×` = boundary self-intersections (**must be 0**) · `IoU` vs ground truth · 
`Δarea%` signed · `dev` worst boundary deviation (m) · `orth%` length-weighted ·
`phantom` boundary metres with no supporting linework · `det` deterministic.

### `curved-facade`
_Arc facade: over-regularisation destroys it, so it guards the regularise candidate._
Truth area: **985.1175 m²** · truth source: synthetic — truth is the generating polygon, exact by construction

| impl | self× | IoU | Δarea% | dev m | orth% | phantom m | verts | ms | det |
|---|---|---|---|---|---|---|---|---|---|
| `baseline` | 0 | 0.9904 | -0.2 | 0.187 | 27.8 | **1.49** (1.1%) | 17 | 13.6 | y |

### `lshape-door-gaps`
_Re-entrant corner: hull tracers cut the notch off — the classic phantom diagonal._
Truth area: **624 m²** · truth source: synthetic — truth is the generating polygon, exact by construction

| impl | self× | IoU | Δarea% | dev m | orth% | phantom m | verts | ms | det |
|---|---|---|---|---|---|---|---|---|---|
| `baseline` | 0 | **0.9788** | 0.24 | 0.395 | 100 | **6.21** (5.4%) | 6 | 10.1 | y |

### `lshape-jitter-dup-gaps`
_All three defects at once — the composed-pipeline case the research predicts._
Truth area: **624 m²** · truth source: synthetic — truth is the generating polygon, exact by construction

| impl | self× | IoU | Δarea% | dev m | orth% | phantom m | verts | ms | det |
|---|---|---|---|---|---|---|---|---|---|
| `baseline` | 0 | 0.9908 | 0 | 0.049 | 100 | 0 (0%) | 6 | 0.2 | y |

### `lshape-shell-fragments`
_PRODUCTION BUG CLASS: shell present only as fragments — forces hull fallback across the notch._
Truth area: **624 m²** · truth source: synthetic — truth is the generating polygon, exact by construction

| impl | self× | IoU | Δarea% | dev m | orth% | phantom m | verts | ms | det |
|---|---|---|---|---|---|---|---|---|---|
| `baseline` | 0 | **0.7295** | -25.34 | 7.375 | 81.1 | **74.81** (44.5%) | 28 | 18.2 | y |

### `notched-core`
_Deep notch (a lift core biting into the slab) — two re-entrant corners._
Truth area: **976 m²** · truth source: synthetic — truth is the generating polygon, exact by construction

| impl | self× | IoU | Δarea% | dev m | orth% | phantom m | verts | ms | det |
|---|---|---|---|---|---|---|---|---|---|
| `baseline` | 0 | 0.9829 | 0.2 | 0.395 | 100 | **2.96** (2%) | 8 | 3.3 | y |

### `notched-shell-fragments`
_PRODUCTION BUG CLASS: two re-entrant corners with a fragmented shell — worst case for a hull._
Truth area: **976 m²** · truth source: synthetic — truth is the generating polygon, exact by construction

| impl | self× | IoU | Δarea% | dev m | orth% | phantom m | verts | ms | det |
|---|---|---|---|---|---|---|---|---|---|
| `baseline` | **2** | **0.8845** | -10.02 | 7.375 | 83 | **66.4** (35.9%) | 32 | 21.5 | y |

### `rect-clean`
_Control. If a candidate cannot do this, nothing else matters._
Truth area: **600 m²** · truth source: synthetic — truth is the generating polygon, exact by construction

| impl | self× | IoU | Δarea% | dev m | orth% | phantom m | verts | ms | det |
|---|---|---|---|---|---|---|---|---|---|
| `baseline` | 0 | 1 | 0 | 0 | 100 | 0 (0%) | 4 | 0.1 | y |

### `rect-door-gaps`
_Doors/windows break wall continuity — the gap-closing case (L5IN / IIETA)._
Truth area: **600 m²** · truth source: synthetic — truth is the generating polygon, exact by construction

| impl | self× | IoU | Δarea% | dev m | orth% | phantom m | verts | ms | det |
|---|---|---|---|---|---|---|---|---|---|
| `baseline` | 0 | 0.9835 | 0 | 0.177 | 100 | **4** (4%) | 4 | 4.2 | y |

### `rect-duplicated-layers`
_A second, 40 mm-offset wall layer — overlapping-wall elimination (Wu et al.)._
Truth area: **600 m²** · truth source: synthetic — truth is the generating polygon, exact by construction

| impl | self× | IoU | Δarea% | dev m | orth% | phantom m | verts | ms | det |
|---|---|---|---|---|---|---|---|---|---|
| `baseline` | 0 | 1 | 0 | 0 | 100 | 0 (0%) | 4 | 0.1 | y |

### `rect-jitter`
_Endpoints 8 mm off coincident — the snap/set_precision case (dxf-fix)._
Truth area: **600 m²** · truth source: synthetic — truth is the generating polygon, exact by construction

| impl | self× | IoU | Δarea% | dev m | orth% | phantom m | verts | ms | det |
|---|---|---|---|---|---|---|---|---|---|
| `baseline` | 0 | 1 | 0.02 | 0.007 | 100 | 0 (0%) | 4 | 0 | y |

### `rect-no-shell-only-partitions`
_PRODUCTION BUG CLASS: no exterior wall at all, only interior partitions + columns — the real DWG condition._
Truth area: **600 m²** · truth source: synthetic — truth is the generating polygon, exact by construction

| impl | self× | IoU | Δarea% | dev m | orth% | phantom m | verts | ms | det |
|---|---|---|---|---|---|---|---|---|---|
| `baseline` | 0 | **0.6442** | -35.58 | 5.304 | 66.9 | **69.32** (68%) | 36 | 25.9 | y |

### `rect-wide-gaps`
_Gaps widened to 2.4 m — past a door leaf, where naive closing over-bridges._
Truth area: **600 m²** · truth source: synthetic — truth is the generating polygon, exact by construction

| impl | self× | IoU | Δarea% | dev m | orth% | phantom m | verts | ms | det |
|---|---|---|---|---|---|---|---|---|---|
| `baseline` | 0 | 0.9835 | 0 | 0.177 | 100 | **13** (13%) | 4 | 4.6 | y |

### `rot17-door-gaps`
_Rotated 17°: every axis-aligned assumption breaks; regularisation must not force it square._
Truth area: **600 m²** · truth source: synthetic — truth is the generating polygon, exact by construction

| impl | self× | IoU | Δarea% | dev m | orth% | phantom m | verts | ms | det |
|---|---|---|---|---|---|---|---|---|---|
| `baseline` | 0 | 1 | 0 | 0 | 100 | **3.47** (3.5%) | 6 | 9.3 | y |

### `real-furniture-plan`
_The real 882 m² plan. No closed exterior envelope on any wall layer._
Truth area: **not established** · truth source: TRUTH NOT ESTABLISHED — truth-free metrics only (see truth/README.md)

| impl | self× | IoU | Δarea% | dev m | orth% | phantom m | verts | ms | det |
|---|---|---|---|---|---|---|---|---|---|
| `baseline` | 0 | — | — | — | 61.5 | **78.81** (46.3%) | 31 | 58.1 | y |
