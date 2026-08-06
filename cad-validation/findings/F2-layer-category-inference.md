# F2 — Category inference is English/AIA-layer-only; real drawings collapse to `other`

**Severity: Critical** · **Files affected: 11 at ≥ 70 % `other`, 5 at 100 %**

---

## The defect

`web/src/import/dxf.ts`, `categoryFor()` — the sole classifier for every entity in the drawing:

```ts
if (/DIM/.test(L)) return 'dimension'
if (/ANNO|TTLB|TEXT|AREA-IDEN|SCHD|NPLT/.test(L)) return 'annotation'
if (/GLAZ|GLAZING|CURT|CWMG|MULLION|G-WINDOW/.test(L) || ...) return 'glazing'
if (/(^|[-_])DOOR/.test(L) || /\bDOOR\b/.test(B)) return 'door'
if (/WALL|COL|RAILING|STAIR/.test(L)) return 'wall'
...
return 'other'
```

It is a pure **layer-name** match against English AIA/NCS conventions. It assumes the drawing was
authored to a US layer standard in English. Nothing falls back to geometry.

That assumption fails on this corpus in three distinct ways:

1. **Non-English layer names.** `MOBILIARIO HOSPITAL.dwg` and `muebles varios.dwg` (Spanish, from
   the user's archives): *muro*, *puerta*, *ventana*, *mobiliario* match none of the patterns.
2. **Numeric layer names.** `BUSNSS-Offcs-Trdtnl_AG.dwg` carries layers named `1`, `2`, `10`, `100`,
   `1005`, `290`, `360` alongside a few real ones. `AL` and `call-center-offices` are entirely
   numeric.
3. **No layer table at all.** `BUSNSS-Offcs-Trdtnl_AL.dwg` reports **0 layers**. Layer-based
   inference is not merely inaccurate there, it is structurally impossible.

## Independent evidence

Category census re-derived from the parsed entities, `harness/run.mjs` → `reports/_all.json`:

| File | Layers | `other` | `wall` | Plate outcome |
|---|---|---|---|---|
| `Various-furniture-blocks.zip/muebles varios.dwg` | 22 | **100 %** | 0 % | **no plate** |
| `Hospital-equipment.zip/MOBILIARIO HOSPITAL.dwg` | 19 | **100 %** | 0 % | 450 m² (via the `other`-polyline fallback) |
| `call-center-offices.dwg` | 11 | **100 %** | 0 % | **no plate** |
| `BUSNSS-Offcs-Trdtnl_AL.dwg` | **0** | **100 %** | 0 % | 21 m², 0 desks |
| `BUSNSS-Offcs-Trdtnl_AH.dwg` | 17 | 99 % | 0 % | 3.8 m², 0 desks |
| `Office-furniture-blocks.zip/cad33.dwg` | 9 | 98 % | 0 % | 78 m², 0 desks |
| `fast-food-Restaurant.dwg` | 101 | 94 % | 5 % | **343 m², 19 desks — works** |
| `samples/furniture-plan.dwg` *(control)* | — | — | — | **930 m², 104 desks** |

## Why it breaks the plate

`testfit.ts:773`:

```ts
export function collectWallSegments(drawing: Drawing): Segment[] {
  for (const e of drawing.entities) if (SHELL_CATEGORIES.has(e.category)) pushEntitySegments(e, segs)
}
```

and `extractPlate` (`testfit.ts:101`):

```ts
if (wallSegs.length === 0 && shellSegs.length === 0) return null
```

With 0 % of entities classified `wall`/`glazing`/`door`/`casework`, `collectWallSegments` returns an
empty array. The only thing standing between that and an immediate `null` is the `other`-closed-
polyline clause inside `collectShellSegments` — which is why `MOBILIARIO HOSPITAL` scrapes through at
100 % `other` while `call-center-offices` and `muebles varios`, whose linework is open polylines and
lines, do not.

**The plate tracer is being fed a category signal that is absent on 5 of 24 files and near-absent on
6 more.** Where it survives, it survives by accident of drafting style.

## Knock-on: furniture is not detected either

`ITEM_CATEGORIES` (`dxf.ts:539`) admits an INSERT as a selectable `FurnitureItem` only when
`categoryFor` returns furniture/casework/fixture/glazing/door. So the same failure blanks the
furniture tally:

- **9 of 24 files report 0 furniture items**, including `MOBILIARIO HOSPITAL.dwg` — a file whose
  entire content is hospital furniture blocks, and `cad33.dwg` — an office furniture block library,
  which yields exactly **1**.
- The Space step then prints "Detected program — Offices/desks **0**, Conference **0**,
  Collaboration **0**, Amenities **0**" (`findings/screens/AG-space-step.png`), and the material-bank
  binding path has nothing to bind.
- It also makes the plate's furniture-coverage score vacuous — see
  [F8](F8-vacuous-coverage-claim.md).

## Reproduce

```bash
node cad-validation/harness/run.mjs
node -e 'for (const x of require("./cad-validation/reports/_all.json")) {
  const p = x.stages.parse; if (!p?.ok) continue
  console.log(x.file, p.layers + " layers", JSON.stringify(p.byCat)) }'
```
