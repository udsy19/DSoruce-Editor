# ADR 0006 — Branch 5: materials & 3D render quality

**Status:** Part A COMPLETE and accepted · Part B pre-registered, not yet run
**Date:** 2026-08-04

**Code anchors:** `buildFurniture3D`, `TEXTURES` (`web/src/three/furniture3d.ts`) ·
`Viewer3D`, `applyPipeline`, `applySunToSky` (`web/src/three/Viewer3D.ts`) ·
`THEMES` (`web/src/three/theme.ts`) · `docStateToIFC` (`web/src/export/ifc.ts`) ·
`docStateToObj` (`web/src/export/obj.ts`) · material bank
`web/src/materialBank/`

## Two parts, deliberately not one bake-off

**Part A — the IFC upgrade is ENGINEERING, not a bake-off.** It has no
candidates and no predictions beyond "the consumer now sees spaces, quantities
and stable identity". Scoped, deterministic, and accepted by round-trip through a
strict consumer. It is branch 5's routed pre-work because `blender-offline` needs
exactly these semantics to carry materials and spaces (ADR 0004).

**Part B — materials and render quality** is the bake-off, and it is the first
branch in this campaign whose primary question is **subjective**. That changes
the protocol, not the rigour.

---

## Part A — IFC semantics upgrade (engineering)

Branch 2 measured our IFC as **exchange-grade for geometry, viewer-grade for
semantics**: 100 % of elements carry real `IfcExtrudedAreaSolid` over
`IfcRectangleProfileDef`, but there are **zero** `IfcSpace`, **zero**
`IfcElementQuantity`, **zero** `IfcPropertySet`, and no classification — so a
consumer must guess an element's category from its display `Name`, and **binding
a product renames the element**, silently reclassifying it. Pricing an item is
what makes it un-categorisable. Self-defeating, and entirely ours.

### Scope — NARROWED after re-measuring the current export

Branch 2's claim that the export lacks classification and product identity was
**wrong, and is retracted in ADR 0004**. Verified against the actual file:
`ObjectType` already carries the category (**125/125**, recovering the truth
categories exactly) and `Description` already carries `product:<id>`
(**5/5** bound). My branch-2 reader used `Name` and never looked at either.

So scope item 3 does not exist. What is genuinely absent:

1. **`IfcSpace` per zone**, in the spatial hierarchy, so room attribution exists.
   (Confirmed: `IfcSpace` count is 0.)
2. **`IfcElementQuantity`** per element (area, volume, length as applicable).
   (Confirmed: `IfcElementQuantity` count is 0.)

`Tag` stays empty deliberately: `Description` already carries the identity, and
adding a second home for it would be the dual-source bug branch 2 spent a merge
gate removing for prices.

### Acceptance — not a claim, a round-trip

`ifcopenshell 0.8.5` is installed. The acceptance test re-runs branch 2's reader
against the upgraded export and requires:

| assertion | today (verified) | required |
|---|---|---|
| `IfcSpace` count | **0** | = zone count (29) |
| elements with declared quantities | **0 / 229** | ≥ 95 % |
| category attribution via `ObjectType` | **125 / 125 already** | stays 125 / 125 |
| bound products matchable via `Description` | **5 / 5 already** | stays 5 / 5 |

The last two rows are **regression guards, not goals** — they already pass, and
the point is that adding spaces and quantities must not break them.

This **also finally exercises IfcOpenShell's untested half** — branch 2 measured
what it could *read*, never whether our file could be *fixed* to satisfy it. And
it revives `ifc-cost` for free: with quantities and identity present, its one
blocker is removed, though its own untested Vercel prediction (native code will
not run in that sandbox) stays registered.

**No candidates, no ranges.** Determinism gate, refined by what it caught: the
same document must produce a **byte-identical DATA section**. The HEADER's
`FILE_NAME` carries a real creation timestamp, so whole-file equality is not
achievable and should not be — but the *model* must be diff-able, which is
exactly why this exporter already derives its GUIDs deterministically rather than
from `crypto.getRandomValues`. The timestamp difference is pre-existing and
correct; scoping the gate to DATA is the honest form of the requirement.

---

## Part B — materials and render (bake-off)

### Candidates

| id | what | class | licence |
|---|---|---|---|
| `baseline` | current parametric PBR + Enscape-like tier (sky dome, GTAO, bloom) | A | original |
| `materialx` | MaterialX as the *schema* under the material bank, so definitions survive OBJ/IFC round-trips without re-authoring | A (schema) | Apache-2.0 |
| `cc0-pbr` | ambientCG / Poly Haven CC0 texture sets + real HDRIs | A (assets) | CC0 |
| `blender-offline` | IFC → Bonsai/Cycles for hero renders, Three.js stays live | B (out-of-band) | GPL (Blender, out-of-process) |

`blender-offline` is evaluated as a **separate deliverable path**, not a viewer
replacement, and is **blocked on Part A** — without `IfcSpace` and materials in
the file there is nothing for it to render faithfully.

### The subjective half — protocol, pre-agreed

Visual quality is not scoreable by me. So:

- Render a **fixed-camera screenshot matrix** — same document, same camera, same
  sun angle — one column per candidate.
- **I do not declare a visual winner.** The grid is produced and flagged for
  human review, exactly as ADR 0003 handled the real plate's undecidable truth.
- Everything else is measured objectively and reported alongside, so the human
  judgement is made *with* the costs visible rather than after them.

#### The grid is BLINDED — the human judge is also an instrument

The protocol pinned the scene, camera and lighting but not the *judge*. Knowing
which column is the incumbent and which is the shiny new CC0 set is an anchoring
bias aimed at the only subjective measurement in the campaign — pro-novelty or
pro-incumbent, either way expectations are holding the ruler.

- Columns are labelled **neutrally (A / B / C …)**, in an order derived from a
  fixed seed so it is reproducible but not guessable from the candidate list.
- The mapping is written to a **separate key file** that is not shown with the
  grid, so unblinding is mechanical rather than remembered.
- The pick is **recorded before** unblinding.

**Sixth face of the rules family: the evidence conditions apply to human
judgements too.** Every other face guards a metric from the thing it measures;
this guards a judgement from what the judge already believes.

### PREDICTION — `cc0-pbr`'s network cost, before measuring

Registered now because *"biggest visual lever"* and *"web app load budget"* are
on a collision course, and a visual win that doubles time-to-first-render must
appear in the table as that trade rather than be discovered in production.

**Declared test conditions** (without these the numbers are meaningless):

- **Resolution tier: 1–2K**, not the 4–8K the libraries advertise. 8K PBR sets
  are tens of MB per material and are not a web-app option; testing at the
  advertised tier would be testing a configuration we would never ship.
- **Delivery model: BOTH measured** — bundled (in the JS/asset bundle) and
  fetched-on-demand (lazy, per material) — because it changes both the numbers
  and the architecture, and the honest comparison names which one it is.

**Predictions:**

| metric | baseline | `cc0-pbr` predicted |
|---|---|---|
| asset payload | ~0 (procedural) | **+4 to +12 MB** bundled at 1–2K for ~6 materials; **+0 MB** initial if fetched-on-demand |
| time-to-first-render | current | **+1.5× to +3×** bundled; **≈ unchanged** on-demand |
| **time-to-full-fidelity** | = TTFR (nothing to load) | **≈ TTFR** bundled; **TTFR + 1 to + 4 s** on-demand |
| **visible pop-in at the fixed camera** | no | **no** bundled; **YES** on-demand |
| frame time @ 145 components | current | **within ±15 %** — texture *memory* rises, per-frame cost barely moves at this component count |
| HDRI sky | procedural dome | **+2 to +6 MB** for a usable 2K HDRI |

**On-demand's cost does not vanish, it moves — so it is named before measuring.**
Saying bundled costs TTFR while on-demand is "≈unchanged" is true only for the
metric named: on-demand still pays, in **time-to-full-fidelity** and in a user
seeing flat-shaded geometry pop to PBR. Without those two rows the table would
show on-demand winning **by omission**, which is precisely the shape of this
campaign's budget error — *the number that wasn't measured reads as zero.*
The delivery comparison must be cost-vs-cost, never cost-vs-free.

**Mechanism:** textures cost *bandwidth and VRAM*, not draw calls. At 145
components the GPU is nowhere near limited, so the visual gain should be large
and the frame-time cost near zero — the entire real cost is delivery. **If frame
time degrades more than 15 %, suspect texture size or mipmapping, not the
material count.**

**Falsification:** if bundled payload lands under 2 MB at 1–2K, my sense of PBR
set sizes is wrong and the delivery question is moot — the honest and welcome
outcome.

### Metric validity per candidate

| metric | baseline | materialx | cc0-pbr | blender-offline |
|---|---|---|---|---|
| visual quality | **human only** | human only | human only | human only |
| asset payload delta | ranking | **≈0 by construction** | ranking | n/a (out-of-band) |
| time-to-first-render | ranking | ranking | ranking | n/a |
| frame time @ real component count | ranking | ranking | ranking | n/a |
| material survives OBJ round-trip | ranking | **ranking (its whole claim)** | ranking | n/a |
| material survives IFC round-trip | ranking | **ranking (its whole claim)** | ranking | gate (needs Part A) |
| offline capability | pass | pass | pass by construction if bundled | **fails — out-of-band by design** |
| render wall-clock | n/a | n/a | n/a | diagnostic |

`materialx` is a **schema** change: scoring it on visual quality would be scoring
it on not being a texture pack. Its claim is round-trip fidelity, and that is
where it is ranked. Per the standing rules, this table is fixed **now**, and any
metric added later is post-hoc and advisory.

### Fixtures

The real 930.1 m² plan at seed 3 (branch 2's pinned document, 125 components) is
primary — the same document every other branch measured, so numbers compose. Plus
a single-room close-up, because material quality is judged at reading distance
and a whole-floor view hides exactly what a texture pack buys.

### Falsification

- `materialx`: a material does not survive OBJ **and** IFC round-trip ⇒ its only
  claim fails; drop.
- `cc0-pbr`: bundled payload or time-to-first-render lands outside the ranges
  above ⇒ the mechanism claim is wrong, whatever the screenshots show.
- `blender-offline`: cannot render the Part-A IFC faithfully ⇒ the pre-work did
  not deliver what it was scoped for, which is a Part-A finding, not a Part-B one.
- All candidates visually indistinguishable in the human grid ⇒ null result,
  recorded as such, and the branch's value is Part A alone.

## Results — Part A (complete)

Verified with `bench/adapters/qto/ifc_semantics_check.py`, which reads the export
with IfcOpenShell — an independent, strict consumer.

| assertion | before | after | required |
|---|---|---|---|
| `IfcSpace` per zone | 0 | **29** | 29 ✓ |
| elements with **reachable** quantities | 0 / 229 | **229 / 229** | ≥ 95 % ✓ |
| category via `ObjectType` (regression guard) | 125 / 125 | **125 / 125** | unchanged ✓ |
| identity via `Description` (regression guard) | 5 / 5 | **5 / 5** | unchanged ✓ |

"Reachable" is deliberate: the check requires each quantity set to be related to
its element through `IfcRelDefinesByProperties`, not merely present in the file.
A floating quantity set is invisible to a cost engine, so counting entities would
have passed a file no consumer could use.

**Determinism:** the DATA section is byte-identical across exports (3,416 lines).
Only the HEADER `FILE_NAME` timestamp differs — pre-existing, correct IFC
semantics, and the reason the gate is scoped to DATA.

### What this changes

- **Room attribution now exists.** A consumer can build level → room → category
  from our file; before, `IfcSpace = 0` made that impossible for anyone.
- **`ifc-cost`'s blocker is removed**, and with the ADR 0004 retraction its
  reported failure is now understood as my reader's bug plus this one real gap.
  Reviving it is cheap if the Python service class is ever stood up; its untested
  Vercel prediction stays registered.
- **`blender-offline` is unblocked**, which was Part A's routing reason.

### Scope honesty

`IfcSpace` for a `Poly` zone is emitted as its bounding box. The space *exists*
and is placed correctly, which is what attribution needs, but its boundary is not
the conformed polygon. A consumer wanting exact area reads the quantity, not the
box. Recorded rather than glossed: this is a known simplification, not a claim of
boundary fidelity.

## Results — Part B

_Not yet run._
