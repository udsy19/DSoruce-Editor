# ADR 0004 — Branch 2: hierarchical BOM / quantity takeoff

**Status:** ADOPTED — `qto-native` shipped; `ifc-cost` dropped, its finding routed
**Date:** 2026-08-04

**Code anchors:** incumbent `buildTakeoffModel`, `takeoffToXlsx`
(`web/src/export/takeoff.ts`) · `finishScheduleSheets`
(`web/src/export/finishSchedule.ts`) · `docStateToIfc` (`web/src/export/ifc.ts`) ·
`cost::indicative_cost` (`crates/ds-core/src/cost.rs`) · truth
`bench/fixtures/qto/truth.json` · harness rules `bench/README.md`

## Why this branch exists

The incumbent produces a **flat** takeoff: `furniture[]`, `summary[]`, `walls[]`
and a `totals` block. There is no level → category → type → item hierarchy, no
parametric quantity links, and no rolled-up subtotals — the structure every BIM
tool exposes and every quantity surveyor expects.

## Ground truth — and what "hand-count" honestly means

Nobody counted 500+ blocks by eye, and a count done that way would be *less*
trustworthy, not more. `bench/fixtures/qto/truth.json` is derived **mechanically
from the document the quantity engine is asked to price** (`Editor.state()`),
using nothing from `export/takeoff.ts`. It is exact, reproducible, and
independent of every candidate.

The document is pinned: real DWG → the ADR 0003 ladder plate (930.1 m², via
`partition-envelope`) → deterministic generate at **seed 3**.

| | |
|---|---|
| components | 125 (Desk 92 · Door 14 · Table 12 · Chair 7) |
| walls | 104, 322.6 m total |
| zones | 29 — Workspace 3 / 561.9 m² · Circulation 10 / 246.8 m² · Meeting 6 / 54.6 m² · Amenity 4 / 26.0 m² · ClosedOffice 6 / 14.4 m² |
| NIA | 903.611 m² |
| workstations | 92 |

**What this verifies:** the ROLLUP. Given this document, do quantities, groupings
and cost lines come out right?
**What it does NOT verify:** that the document faithfully reflects the DWG. That
is the importer's job, covered by `import/*.test.mjs` — a different branch's
truth, deliberately not conflated with this one.

**Inherited limit, stated plainly.** Mechanical truth verifies the ROLLUP
CONTRACT against the document. If the document itself miscounts — a wall dedup
bug, say — truth inherits that error silently, because both read the same
`Editor.state()`. In scope for this branch to *note*; out of scope to solve.

**Independence requirement — the condition under which `qto-native`'s accuracy
score means anything.** Where a truth generator and a candidate share logic,
agreement is tautology rather than verification, and "exact by construction" is
the warning label for it. Therefore: the truth stays a **deliberately dumb, flat
summation** over the serialized `Editor.state()` in JS, while `qto-native` is a
rollup over the in-memory `Document` in Rust — **zero shared aggregation code**.
Its leaf totals are scored against that independent summation and its hierarchy
on internal consistency. If the cleanest implementation of `qto-native` ever
becomes "the code that computes truth, plus grouping", that must be said out
loud: at that moment its accuracy score stops being evidence and the branch's
real question narrows to hierarchy-correctness and the class-A-vs-B trade-offs.

**Known limitation of the regression fixture, stated up front.** The ROADMAP
Track F bug was that *the re-imagine panel's binds never reached the App bindings
map*, so priced binds surfaced neither price nor supplier. The fixture binds via
`Editor.assign_product`, i.e. the **core** path — so it tests core → takeoff, and
the original defect lived in App-state → takeoff, one layer above. It is a real
regression test for the cost-line invariant but **not** a faithful reproduction of
that bug. **Due before this branch's merge gate**, not owed indefinitely: "every priced
binding reaches a cost line" is this branch's pre-registered regression case, the
historical bug lived at the App layer, and a gate exercising only the core path
certifies the layer that did not break while skipping the one that did.

## Pre-registration

### The bars

1. **Accuracy** — per-category quantity (count, area) must match truth to **< 1 %**.
2. **Cost-line invariant** — all **5** priced bindings reach a cost line, Σ
   **₹78,533**. A candidate that prices 4 of 5 fails outright; this is the
   ROADMAP Track F regression restated as a gate.
3. **Determinism** — same document, byte-identical output.

Gates before scores, per the phantom lesson: a candidate failing 1–3 has no
meaningful hierarchy score.

### Which metrics are meaningful for which candidate

| metric | baseline | ifc-cost | qto-native |
|---|---|---|---|
| quantity accuracy | ranking | ranking | ranking |
| cost-line invariant | gate | gate | gate |
| hierarchical rollup | **undefined** (no hierarchy exists) | ranking | ranking |
| offline capability | pass by construction | **fails by construction** | pass by construction |
| IFC round-trip fidelity | n/a | **ranking** | n/a |
| wall-clock | ranking | ranking | ranking |

Scoring `baseline` on hierarchy would be scoring it on not being the thing we are
considering building — recorded so a future round does not read a 0 as a defect.

Note the pinned document is a **single floor**, so the `level` dimension of the
hierarchy is degenerate here. Level-correctness cannot be established on this
fixture and must not be claimed from it.

### Predicted outcomes, with mechanism

**`baseline` (flat CSV)** — counts exact (it reads the same `DocState`), cost-line
invariant **passes** (the Track F fix landed and the core carries `price_inr`),
hierarchy undefined. Predicted role: the accuracy floor everything else must
match, not beat.

**`ifc-cost` (class B — IfcOpenShell consuming our IFC)** — mechanism: our IFC
export → `ifcopenshell.api.cost` → hierarchical schedule with parametric quantity
links. Needs no new export format, which is why it is the highest-leverage
candidate on paper.

The original single prediction conflated two separable questions. Split, and
sharpened by first reading what `export/ifc.ts` actually emits — which changed
the answer:

**(a) Does the file carry declared quantities?**
> **Predicted: NO.** Verified by inspection before predicting: the exporter emits
> **zero** `IFCELEMENTQUANTITY`, `IFCPROPERTYSET` and `IFCRELDEFINESBYPROPERTIES`.
> So `ifcopenshell.api.cost` will find **0 of 125** components with declared
> quantities. This is now near-certain rather than a guess, which is why it alone
> cannot decide the candidate.

**(b) Can IfcOpenShell DERIVE quantities from our geometry anyway?**
> **Predicted: YES for magnitudes, NO for attribution.**
>
> The exporter is better formed than "hand-written SPF" implies. It writes real
> `IFCEXTRUDEDAREASOLID` over `IFCRECTANGLEPROFILEDEF` — genuine swept solids,
> not placement-plus-bounding-box — inside a complete
> `IFCPROJECT → IFCSITE → IFCBUILDING → IFCBUILDINGSTOREY` hierarchy with
> `IFCRELAGGREGATES`, `IFCRELCONTAINEDINSPATIALSTRUCTURE`, `IFCOWNERHISTORY` and
> a real `IFCUNITASSIGNMENT`. So predicted derivable, for **≥ 90 % of the 125
> components**: count (enumeration), footprint area (profile XDim × YDim),
> volume (profile area × extrusion depth), wall length (extrusion axis).
>
> **What is NOT derivable: room attribution.** The exporter emits **zero
> `IFCSPACE`** and does not export zones at all, so nothing in the file says
> which room an element sits in. A level → **room** → category → item hierarchy
> therefore cannot be built from our IFC by any consumer — the information is
> absent, not merely undeclared.

**Verdicts these distinguish.** (a) fails + (b) succeeds ⇒ the export is
viewer-grade for properties but exchange-grade for geometry, and `ifc-cost`
**lives**, with the work moved from reading to deriving. Both fail ⇒ `ifc-cost` is
dead and the finding is about our exporter. (b)'s attribution half failing while
its magnitude half succeeds ⇒ `ifc-cost` can produce quantities but not the
*hierarchy* this branch exists to add, which would be the most interesting
outcome of the three.

**`qto-native` (class A — hierarchical rollup in the Rust core)** — mechanism:
derive the hierarchy from `Document` directly, quantities from geometry, no IFC
round-trip. Predicted exact on counts (same source as truth), the only candidate
that is hierarchical **and** offline, at the cost of owning the cost math
ourselves rather than inheriting a standard.

### The class-B question is the real question

`ifc-cost` forces the Python service class into existence — the same plumbing
`raster-roundtrip` is parked on (ADR 0003). Its A/B must therefore price in:

- **Vercel degradation**, mirroring `/api/dwg`'s 503.
  > **Predicted: ifcopenshell's native code does not run in Vercel serverless**,
  > so `ifc-cost`'s Vercel story is a 503 exactly like `/api/dwg`. That is a
  > legitimate class-B cost because it is a PRODUCTION constraint.

  Class-B costs are measured deliberately and scored as their own rows — wheel
  size, native-dependency footprint, cold-start time, Vercel viability.
  **Installation difficulty in this sandbox is NOT one of them**: the dev box's
  package luck says nothing about production plumbing, and recording it would put
  noise where signal belongs. (For the record, `ifcopenshell 0.8.5` installed
  without incident.)
- **Round-trip proof** that our IFC is well-formed enough to consume — valuable
  even if `ifc-cost` loses.
- **Offline capability**, which it fails by construction; the takeoff is
  something a user expects to work on a plane.

Per ADR 0003's reusable test: identify what the external component adds over the
deterministic incumbent *before* paying for the service class. Here that is
**standards-compliant cost structure**, which is real — unlike the raster case,
where the deterministic incumbent already did the job.

### Falsification

- `baseline`: fails the cost-line invariant ⇒ the Track F fix regressed, and that
  is a bug to fix before any bake-off continues.
- `ifc-cost`: cannot read ≥ 90 % of components as quantity-bearing ⇒ dropped for
  this branch, and the IFC export's grade is recorded as the finding.
- `qto-native`: per-category quantities diverge > 1 % from truth ⇒ its rollup is
  wrong, since it reads the same document the truth came from.
- Any candidate that is non-deterministic ⇒ disqualified regardless of accuracy.

## Results

`node bench/runQto.mjs` against the truth frozen in `03acdaa`; predictions frozen
in `5a88d96`. Neither was touched after candidates ran.

| engine | class | gates | per-category worst err | priced lines | Σ₹ | hierarchical | depth | rollup | ms |
|---|---|---|---|---|---|---|---|---|---|
| `baseline` | A-port | **pass** | **0 %** | 5 | 78,533 | no | 0 | ok | 7.9 |
| `ifc-cost` | B-service | **FAIL** | 14.3 % | **0** | 0 | yes | 1 | ok | 152.5 |
| `qto-native` | A-port | **pass** | **0 %** | 5 | 78,533 | **yes** | **2** | ok | **0.9** |

### The IFC predictions, both confirmed — and one thing neither anticipated

**(a) declared quantities — CONFIRMED exactly.** `IfcElementQuantity = 0`,
`IfcPropertySet = 0` across 229 products. `api.cost` has nothing to read.

**(b) magnitudes derivable — CONFIRMED, better than predicted.** Predicted ≥ 90 %;
actual **100 %** (229/229). Every element carries a real
`IfcExtrudedAreaSolid` over `IfcRectangleProfileDef`, so footprint area and
volume compute cleanly. The export is genuinely exchange-grade *for geometry*.

**(b) room attribution absent — CONFIRMED.** `IfcSpace = 0`. No consumer can
build a room level from our IFC.

**Not predicted, and the sharper finding: category attribution fails too.** The
export carries no classification, so a consumer must guess an element's category
from its display `Name`. Binding a product renames the element — and the counts
land in the wrong buckets:

| category | ifc-cost | truth | short |
|---|---|---|---|
| Desk | 89 | 92 | 3 |
| Table | 11 | 12 | 1 |
| Chair | 6 | 7 | 1 |
| Door | 14 | 14 | 0 |
| | | **total short** | **5** |

**Exactly the 5 bound components**, reclassified into a phantom "Bound" category.
So `ifc-cost`'s counts are *exact*; 100 % of its error is misattribution caused by
the exporter, and **the act of pricing an item is what makes it un-categorisable**.
That is a self-defeating loop for a cost engine, and no amount of work on the
consumer side fixes it.

**0 priced lines**, for the same root cause: nothing in the IFC identifies a bound
product, so a binding cannot be matched back to an element. Recorded honestly
rather than faked by index.

### Verdict on `ifc-cost`

Against the three verdicts the split prediction was built to distinguish: the
export is **viewer-grade for properties, exchange-grade for geometry, and
unusable for attribution**. `ifc-cost` fails the cost-line gate and cannot build
the hierarchy this branch exists to add — not because IfcOpenShell is weak, but
because our IFC does not carry the information. **Dropped for this branch; the
finding is about our exporter.**

Its class-B costs were measured and are recorded, but did not decide it:
cold-start ~150 ms per call vs 0.9 ms in-core, out-of-process Python, and the
Vercel prediction (native code will not run in that sandbox ⇒ a 503 mirroring
`/api/dwg`) stands untested because the candidate died on correctness first.

### `qto-native` — and the honest limit of its accuracy score

Passes every gate: per-category exact, cost-line invariant exact (5 lines,
₹78,533), deterministic, hierarchy **depth 2** (level → room → category → item)
with a consistent rollup, at **0.9 ms** — ~170× faster than the service round-trip
and, unlike it, offline.

**Where its score is and is not evidence**, per the independence requirement:

- Per-category counts matching truth is **weak** evidence. Both read the same
  document, so this shows the rollup does not *lose* items — worth having, not
  probative.
- The cost-line result is **stronger**: ₹78,533 has to survive product-grouped
  line construction, so it exercises real logic the truth never runs.
- Rollup consistency is **independent**: an internal invariant (every node's
  subtotal equals its own lines plus its children), checked without reference to
  truth at all.
- Hierarchy depth is a **capability**, not an accuracy claim.

The accuracy score did not turn out to be tautological, but it is the weakest of
the four and should not be quoted alone.

### `baseline` — correct within its scope

Per-category exact on everything it covers (Desk 92, Table 12, Chair 7) and it
passes the cost-line gate. It omits `Door` **by design** (`NON_FURNITURE`), which
the first version of this runner scored as an 11.2 % accuracy failure — a metric
bug, not an engine one. Flat, so hierarchy is undefined for it as pre-registered.

### Two errors in this branch's own harness, recorded

1. **The fixture bound prices under the wrong key** (`priceInr` where
   `BindingInfo` declares `price`), which silently priced everything at 0 and
   fired the pre-registered falsification "baseline fails the cost-line invariant
   ⇒ the Track F fix regressed". It had not. **But the false alarm exposed a real
   fragility**: the incumbent reads price from the App-layer bindings *map*, not
   from the `price_inr` the core already carries on the component. A component
   bound through `Editor.assign_product` is therefore unpriced in the takeoff
   unless the App map is separately kept in sync — which is precisely the shape of
   the Track F bug, and nothing enforces it. This raises the priority of the owed
   App-level fixture from bookkeeping to real coverage.
2. **The accuracy metric compared totals across engines that cover different
   category sets**, scoring `baseline` (excludes doors) and `ifc-cost` (includes
   walls) as failures for being correctly scoped. Now per-category over the shared
   set, with coverage reported separately. Same lesson as the phantom metric one
   branch earlier: **a metric must be defined per candidate class before it is
   read as a score.**

### Recommendation for the merge gate

Adopt **`qto-native`**. It is the only candidate that is hierarchical, accurate,
correctly priced, offline and fast, and it is class A — no new runtime.

`ifc-cost` is dropped, but its finding is the branch's most valuable output and
should be actioned separately: **our IFC export is viewer-grade**. Emitting
`IfcSpace` for zones, `IfcElementQuantity` for quantities, and a classification or
`Tag` carrying `product_id` would make it consumable by any BIM tool — worth an
issue of its own, independent of costing.

## Standing rule, from the third instance of one mistake

Three times now a metric has been read as a score for a candidate it was never
defined over: phantom fraction for `column-grid` (ADR 0003), hierarchy depth for
`baseline`, and here totals across engines covering different category sets.

> **A metric is only readable as a score for a candidate class it was defined
> over; otherwise it is UNDEFINED — not zero, not failed.**

Applied at pre-registration, not in results: every branch states its per-candidate
metric validity table before running. Two of the three instances above were caught
that way; the third was not, and scored two correct engines as failures.

**Amendment — late metrics.** The instance that escaped was the metric written
*after* seeing the candidates' shapes, which is exactly when a metric is most at
risk of being fitted to what exists rather than defined over what is valid. So:

> **Any metric added after candidates exist is POST-HOC. It must be marked as
> such in the ADR, carry its own per-class validity declaration at the moment of
> addition, and its readings are ADVISORY until it survives one round it was not
> shaped by.**

Pre-registered metrics earn scores; late metrics earn scrutiny first.

## Adoption

`qto-native` is shipped:

- `crates/ds-core/src/qto.rs` — the rollup, exposed as `Editor.qto_schedule()`.
- `web/src/types/qto.ts` — the TS mirror of its serde output.
- `web/src/ui/BomPanel.tsx` — Level → Room → Category with rolled-up subtotals,
  collapsible, following the OpenConstructionERP grouping pattern pre-registered
  as this branch's UX reference. The level row is shown for structural honesty
  and **not** claimed as a feature, since the document has no multi-storey
  concept yet.
- Unpriced renders as an em dash, never ₹0: a bound product with no price and a
  free product are different facts.
- `ifc-cost`'s adapter and runner are deleted; its numbers live in this ADR.

### Price is core-authoritative — the dual-source bug this branch found

The branch surfaced a two-store design for money: the core's `price_inr` (written
by `Editor.assign_product`) and the App-layer bindings map, with every cost-line
constructor reading the **map**. A component priced through the core was unpriced
in the takeoff unless a second, unenforced sync happened.

Root cause: `DocComponent` — the TS mirror of the core document — **did not model
`price_inr` at all**, so the map became the only price the frontend could see.
That is EditorCanvas's accidental type mirror again, in miniature, for money.

Resolved rather than patched:

1. `DocComponent` now models `price_inr`, so the core's price is visible.
2. `takeoff.ts`'s `priceOf` reads the component, not the map. The map demotes to
   what it honestly is — display metadata (supplier, brand, thumbnail).
3. `qto.rs` reads the core by construction, so adopting it removed the second
   path rather than adding one.

`priceSourceOfTruth.test.mjs` asserts the invariant end to end, including the case
that would have caught both the historical Track F bug and the latent one: bind
through the App entry point, build the takeoff with the bindings map
**deliberately empty**, and require the price to arrive anyway. It also pins that
a *stale* map cannot override the core, that unpriced stays unpriced, and that
price survives a snapshot round-trip.

### Routed, not scheduled: the IFC upgrade

Our IFC is **exchange-grade for geometry, viewer-grade for semantics**. One issue,
scoped: `IfcSpace` for zones · `IfcElementQuantity` for quantities · a
classification or `Tag` carrying `product_id` — which also fixes the rename
problem, since identity stops riding on the display name.

**Trigger: it is pre-work for Agent 5's `blender-offline` candidate**, which
routes scenes through Bonsai/IfcOpenShell and needs exactly these semantics to
carry materials and spaces. That gives it a real activation condition rather than
a backlog grave, and it revives `ifc-cost` as a future option for free. The
untested Vercel prediction (ifcopenshell native code will not run in that sandbox)
stays registered and resolves if that revival happens.
