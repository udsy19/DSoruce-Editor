# F1 — `$INSUNITS` is trusted blindly; no plausibility check on scale

**Severity: Critical** · **Files affected: ≥ 8 proven wrong, the prime suspect in most of the 13
silent failures** · **Root cause of F3 and F4 in most cases**

---

## The defect

`web/src/import/dxf.ts:26-40`:

```ts
/** $INSUNITS code → meters-per-unit. Defaults to inches (AutoCAD arch default). */
function metersPerUnit(insunits: unknown): { scale: number; label: string } {
  switch (Number(insunits)) {
    case 1:  return { scale: 0.0254, label: 'in' }
    ...
    default: return { scale: 0.0254, label: 'in' }   // ← also catches 0 / absent
  }
}
```

and `dxf.ts:549`:

```ts
const { scale, label } = metersPerUnit(dxf.header?.$INSUNITS)
```

That is the beginning and the end of unit handling. `$INSUNITS` is **producer metadata written by
whoever last saved the DWG**, and in this corpus it is frequently a lie. Nothing downstream checks
whether the resulting drawing is a plausible building — and everything downstream (plate area,
circulation, cost, m²/person, the takeoff) is denominated in it.

## Independent evidence

Scale was re-derived from a property that is **true by construction, not by the file's own account**:
a door swing arc's radius equals the door leaf width, which every building code on earth fixes at
0.75–1.10 m (IBC 1010.1.1, NBC 2016 Part 4, DIN 18101). Arcs were read at raw scale 1.0 from the
DXF entity and block sections — `harness/scaleAnchor.mjs`, output `reports/_scaleAnchor.json`.

| File | Declared `$INSUNITS` | Modal door-arc radius (source units) | Radius as the importer scales it | Unit the doors imply | Error |
|---|---|---|---|---|---|
| `BUSNSS-Offcs-Trdtnl_AG.dwg` | `in` | 1.125 (4/5 arcs agree) | **0.029 m** | `m` | **39.4× too small** |
| `BUSNSS-Offcs-Trdtnl_AG (1).dwg` | `in` | 1.125 (4/5) | 0.029 m | `m` | 39.4× too small |
| `BUSNSS-Offcs-Trdtnl_AA.dwg` | `in` | 0.897 (2/3) | 0.023 m | `m` | 39.4× too small |
| `Apartment-413201.dwg` | `mm` | 0.855 (10/16) | **0.001 m** | `m` | **1000× too small** |
| `Apto.1404202.dwg` | `mm` | 0.855 (6/22) | 0.001 m | `m` | 1000× too small |
| `fast-food-Restaurant.dwg` | `m` | 1.119 (1/1) | **1.119 m** | `m` | **correct** |

A 29 mm door. A 1 mm door. The one file whose declared unit survives the anchor —
`fast-food-Restaurant.dwg` — is also **one of only two files in the corpus that completes an
end-to-end test-fit**. The anchor predicts success without being told anything about the outcome.

Four more files (`AB`, `AH`, `AI`, `AN`) return a modal door-layer radius of 0.004–1.765 that lands
in no unit's door band. Those are hinge/hardware detail arcs, not leaves — **inconclusive by this
anchor**, not proof of a third failure mode. They are recorded as `MIS-SCALED ~?x` in the matrix and
should not be counted as proven.

## What the user sees

`findings/screens/AG-space-step.png` — `BUSNSS-Offcs-Trdtnl_AG.dwg`, a real multi-room office plan,
through the actual wizard:

> **USABLE AREA ≈ 3 m²** · **COMPONENTS 0** · ROOMS 1

The traced plate is drawn as a large orange triangle while the actual floor plan sits as a
postage-stamp in the corner, entirely outside it.

## Downstream consequences

`MIN_PLATE_AREA = 1` m² (`testfit.ts:72`) is an absolute floor. A drawing shrunk 1000× has every
candidate ring fall below it, so `extractPlate` rejects all of them and returns `null` — **this is
the mechanism behind 4 of the 6 "no plate derived" blocks in [F3](F3-no-plate-derived.md)**. A
drawing shrunk 39× survives the floor but yields a 2–7 m² plate into which the generator cannot fit
a single 1.6 × 0.8 m desk — **the mechanism behind [F4](F4-empty-plan-scored-as-success.md)**.

## Why the existing safety net does not catch it

`plateQuality.ts` is working correctly and is not at fault. It flagged AG as `confidence: 'low'` and
the UI correctly refused to print a hard area ("≈ 3 m², approximate — confirm the boundary"). But it
measures *whether the boundary rests on real linework* — it has no notion of whether the drawing is
the right **size**. A perfectly-traced boundary around a 39×-shrunk plan is `confidence: 'high'`:
`BUSNSS-Offcs-Trdtnl_AA.dwg` is mis-scaled 39.4×, produces a 4.2 m² plate, places zero desks, and is
certified **`high`**.

## Reproduce

```bash
node cad-validation/harness/scaleAnchor.mjs      # door-arc ground truth
node cad-validation/harness/units.mjs            # header facts + true source extents
```
