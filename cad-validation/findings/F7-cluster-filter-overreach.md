# F7 — `keepDominantCluster` discards 0.8 % of entities and shrinks the drawing 108×

**Severity: High** · **Files affected: 3 measurably (`AG`, `AG (1)`, `CwSp_AA`); 1 benign (`cad33`)**

---

## The defect

`web/src/import/dxf.ts:506-532` drops geometry far from the median entity centre, to defend against
mirrored xref duplicates:

```ts
const threshold = Math.max(60, md * 20) // meters
return {
  entities: entities.filter((_, i) => { const c = eCenter[i]; return !c || dist(c) <= threshold }),
  furniture: furniture.filter((_, i) => dist(fCenter[i]) <= threshold),
}
```

The docstring claims the threshold "never clips a genuinely large but contiguous drawing" because it
is relative. It is only *partly* relative: `Math.max(60, …)` makes it **absolute below 60 m**, and
`md × 20` is computed on a drawing whose scale may already be wrong ([F1](F1-unit-scale-trusted-blindly.md)).

## Evidence

Measured with an instrumented **copy** of `dxf.ts` (`harness/probe/dxfProbe.ts`) that records bounds
before and after the filter, leaving the shipped file untouched — `harness/cluster.mjs`,
output `reports/_cluster.json`:

| File | Span before | Span after | Entities dropped | Shrink |
|---|---|---|---|---|
| `BUSNSS-Offcs-Trdtnl_AG.dwg` | **293.2 × 86.7 m** | **2.7 × 1.8 m** | 102 of 13 348 (**0.8 %**) | **108×** |
| `BUSNSS-Offcs-Trdtnl_AG (1).dwg` | 293.2 × 86.7 m | 2.7 × 1.8 m | 102 of 13 348 | 108× |
| `BUSNSS-Offcs-CwSp_AA.dwg` | **1342.6 × 27.3 m** | **4.9 × 1.8 m** | **1 of 25 029** | **274×** |
| `Office-furniture-blocks.zip/cad33.dwg` | 323 903 × 42 717 m | 17.2 × 17.2 m | 10 of 15 144 | 18 832× *(benign — genuine far-flung junk)* |
| all others | — | unchanged | 0 | 1× |

`CwSp_AA` is the sharpest case: **removing a single entity out of 25 029 collapses the drawing's
extent by 274×.** The filter is doing exactly what it was written to do — but a filter whose output
is that sensitive to one input is not a robust one, and there is no logging, no threshold on how much
extent may be discarded, and no signal to the user that a third of a kilometre of drawing just
disappeared.

## Why it matters beyond the bounds

`Drawing.bounds` is not cosmetic. It feeds:

- `extractPlate`'s plausibility gate — `plausible = max(MIN_PLATE_AREA, bboxArea * 0.2)` and the
  `area <= bboxArea * 1.05` ceiling (`testfit.ts:107-108`). A 108×-shrunk bbox makes every honest
  candidate ring look implausibly large and every tiny one look correct.
- the canvas fit-to-view, so the user is zoomed to the wrong part of the drawing.

## Scoping this claim honestly

For `AG` the post-filter body genuinely holds 13 246 of 13 348 entities inside a 2.7 × 1.8 m box, so
the cluster filter is **not the sole cause** of that file's 2.5 m² plate — the drawing is *also*
mis-scaled 39.4× per [F1](F1-unit-scale-trusted-blindly.md). The two compound: F1 sets the wrong
metre-per-unit, and F7's absolute 60 m floor then behaves completely differently than intended at
that scale. Fixing F1 alone will change F7's behaviour on these files and this measurement must be
re-taken afterwards.

`cad33.dwg` is listed for completeness as the case the filter handles **correctly**: 10 entities
sitting 300 km away are real junk, and removing them is right.

## Reproduce

```bash
node cad-validation/harness/cluster.mjs
```
