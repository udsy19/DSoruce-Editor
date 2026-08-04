# ADR 0004 — Branch 2: hierarchical BOM / quantity takeoff

**Status:** pre-registered — ground truth committed, candidates NOT yet written
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

_Not yet run._
