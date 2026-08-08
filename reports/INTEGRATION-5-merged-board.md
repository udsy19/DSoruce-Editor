# §5 — the merged board runs green, and the cost defect walks through it

**Measured in `/private/tmp/i6-backlog` at `95be135`** (= `integration@b9ec338` +
the R23/backlog work). Dev server on **5271**, never 5173; `run-all.sh`'s
worktree pre-flight passed on its own `lsof` check, and provenance was proved
independently before grading — the **served** `/src/wasm/ds_core_bg.wasm` is md5
`9cd9c0a4…`, byte-identical to the on-disk build, so the freshness precondition
applies to the bytes the app actually served. `trace_floor_polygon` survives only
in comments: Line A's plate ownership is in the tree that was graded.

Battery first, then the sheet board, strictly sequential — never concurrent.

## Both boards, green

```
  13/13 passing        ALL GATES GREEN
  G12 Drawing set 838 checks · G13 Circulation 9 gates + 1 pending-human
  graded pack: 10/10 artifacts + 12/12 G9 case files · walkthrough.mp4 43.00s

  8/8 passing          ALL SHEET GATES GREEN        396.6 s
  SG5 Board integrity  PASS (32 checks)
  SG7 Area identity    PASS (231 checks)
  drawing-set          PASS (329 checks)
```

**This is the first time Line B's gate layer has graded Line A's core work, and
no red is attributable to the merge.**

### SG5's 25 failures were the measurer's, and the proof is that the count did not move

Line A's earlier run reported `SG5 FAIL (32 checks, 25 failing)`. Now:
`SG5 PASS (32 checks)`. **Same gate, same pin, same count — only `out/`
differed.** A controlled confirmation rather than an argument.

The general form, now paid for twice: *a gate that reads another board's output
fails in bulk when that board has not run, and the bulk is indistinguishable at a
glance from defects in the subject.* The way to tell is to build the artifacts and
re-run, not to reason about the failure text.

## The first-value test: the machinery does NOT catch A's cost defect — and cannot

The defect is live on the very packs both boards graded, measured here, not
inherited:

| pack | GEA | NIA | headline | panel | Δ | residual vs (GEA−NIA)×14 000 |
|---|---|---|---|---|---|---|
| seeded | 960.0000 | 850.4900 | ₹1,86,21,300 | ₹1,70,88,160 | −8.23% | **₹0.00** |
| testfit | 960.0000 | 872.4800 | ₹1,84,27,960 | ₹1,72,02,680 | −6.65% | **₹0.00** |
| dwg | 930.0625 | 898.0835 | ₹1,77,68,315 | ₹1,73,20,608 | −2.52% | **₹0.00** |

Over the core fixture family, unedited: **5/5 rupee-exact**, and **F3 reproduces
−35.75% to the digit** (its plate is unresolved, so a 1594.94 m² bbox stand-in
sits against 899.79 m² NIA — that is why it is the worst case).

**Worse than briefed.** The `w.generated` partition predicate is not only in
`stats.ts`: **`cost.rs:165` filters `doc.walls.iter().filter(|w| w.generated)`
itself.** An imported DWG with 34 boundary walls and **199.07 m of wall** bills
`Σ generated-wall length = 0.00 m`, and `headline − GEA×14 000 = ₹0` exactly. So
**the core's headline, not merely the panel, bills ₹0 of partition on imported
geometry** — carrying the predicate `takeoff.ts:10-13` deleted **by name** for
disagreeing with the core on exactly this input.

### Why it is a scope finding, not a gate bug

Three independent measurements, none of them a reading of a gate's intent:

1. **Every graded byte scanned** — workbook unzipped to every XML part,
   `ground-truth.json`, `share.json`, PNGs, mp4, GLB, case files — for
   `18621300`, `186213`, `17088160`, `14000`, `indicative_cost`: **0 hits, all
   five needles.**
2. **`pdftotext` over all three delivered `drawing-set.pdf`s** for `₹|INR|[Cc]ost`:
   **0 matches.** No rupee figure exists anywhere in the pack.
3. **The workbook is a quantity surface, not a priced one.** `qtoWorkbook.ts`
   carries no fit-out rate table; unit prices are opt-in and default to `0` — "the
   honest default". G2/G3's cost columns are formula-live over zeros.

SG7 is an **area↔area** identity across the paper/core seam, and it is *correct* —
both its sides agree, which is why it is green at 231. The cost defect is a
**basis↔basis** disagreement between two rupee formulas (`floor_area()` vs
`Σ zone areas`) whose output never enters a deliverable. **The machinery is
well-formed and pointed elsewhere.**

### The sharpest sub-finding, and a correction to the report that produced it

> **RETRACTED BY NAME, from the agent report this file is built on.** It concluded
> *"No runner invokes the web node suite."* **False.** `scripts/verify-all.sh:92`
> globs `cd web && find src -name '*.test.mjs'`, and both tests appear as battery
> rows on every run — verified: `✓ node export/publishedArea.test.mjs` and
> `✓ node editor/referenceMetrics.test.mjs`. What is true is narrower: they are not
> on the **gates board** or the **sheet board**.

The corrected finding is **stronger than the retracted one**. It is not that
nothing looks. It is that:

> **`publishedArea.test.mjs` (1160/1160) and `referenceMetrics.test.mjs` both run
> on every commit, both explicitly declare `@covers: crates/ds-core/src/cost.rs`,
> and both are green with the defect live.** `publishedArea` asserts the
> **enclosed-premium** term agrees between `cost.rs` and `buildElements`
> (line 452) — the reconciliation reached that term and **stopped one term short
> of the base shell.**

A gate that does not exist is a gap. **A gate that runs every commit, claims the
file by name, and stops one term short is a false assurance** — and this defect
has now survived exactly that once already.

## Disposition — the gate goes before the fix

Per §5, a miss outranks the cost fix. The gate needs a surface to grade: either
the headline enters the pack (a model-conditioned `General!` fit-out total), or
the gate is a **core-state identity** — `indicative_cost` against the panel BoQ
over the fixture family — **added to a board**, not left as a test that is green
for the wrong reason.

**Writing the fix first would produce a gate calibrated to the fix**, and the
reconciliation that already stopped one term early is the evidence that this
particular defect is good at surviving that.

## Hygiene

`git status` clean at `95be135` before and after; **no source edited, no wasm
rebuilt or overwritten**; probe scripts confined to the session scratchpad; `out/`
written only by the boards' own producers and gitignored; dev server on 5271
killed and the port confirmed free. Scope of the negatives: *"no rupee figure in
the pack"* covers everything under `out/` from this run — 10 pack artifacts, 12
case files, 33 sheets × 3 packs, 3 PDFs. *"Nothing imports `buildElements`"* covers
`web/src` + `scripts` at `95be135`.
