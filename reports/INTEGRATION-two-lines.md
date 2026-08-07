# Integration report — two independent lines on one mission

**Written without touching either branch.** No merge, rebase, reset or
force-move was performed. The only git actions taken were the commit of
session B's work and `git branch qbiq-parity-endgame-session-b` to make it
reachable.

| | ref | commits since base | files | insertions |
|---|---|---|---|---|
| **Line A** (on the branch) | `qbiq-parity-endgame` @ `048d99e` | 12 | 43 | 5 559 |
| **Line B** (this session) | `qbiq-parity-endgame-session-b` @ `6e49ba3` | 1 (squashed) | 58 | 4 229 |
| merge base | `49502e5` | — | — | — |

`git merge-tree --write-tree` (writes nothing) reports **27 conflicting files**.

## Both lines independently found and fixed the SAME headline defect

Sheet A.09 billing zone 244 `Open Workspace (2)` at **35.0 m²** against the
workbook's **8.0** — same zone id, same delivered pack, unedited fixture. Both
diagnosed R14's certification failure identically: the census was run with
`rustc`, and `rustc` cannot see `web/src/export/`.

They then built **different mechanisms for the same job**:

| concern | Line A | Line B |
|---|---|---|
| area receiver | `web/src/util/publishedArea.ts` — `PublishedZoneAreas`, `publishedZoneArea()` | `web/src/types/metrics.ts` — `ZoneAreas`, `zoneAreasFromStats/Rooms()` |
| missing id | **THROWS** — *"a missing id is a FAILURE, never a skip"* | returns `NaN` (A.09) / omits the label — **weaker** |
| ordering helper | `rawShapeAreaForOrderingOnly(s)` — a magnitude, named to warn | `compareZoneExtent(a,b)` — an **ordering**; no m² value exists to print — **stronger** |
| census | `web/src/util/areaCensus.test.mjs` (globbed into the battery) | `scripts/gates/area-census.mjs` (register + reconciliation, wired to `verify-all`) |

**Neither is a superset.** A's missing-id discipline is better; B's ordering
helper is structurally stronger. The censuses reach the same conclusion by
different construction and cite different sabotages (A cites S18).

## Work unique to Line A (9 files) — not present in B at all

* `crates/ds-core/src/geometry.rs`, `layout/grid.rs`, `model.rs`, `fixtures.rs`
* **F1 — the plate polygon has one owner**, and the scorer reports which floor
  it used (`d0b0260`)
* the seat count reads the floor its own row bills (`c1b1515`)
* `web/src/ai/engine.ts`, `ai/evaluator.ts`, `export/publishedArea.test.mjs`
* its own **BELIEF FOUR: NOT BELIEVED on both axes, independently** (`8adfb0d`)

Its open list contains a defect **Line B does not have and has never measured**:

> `stats.ts:345` bills NIA where `cost.rs:158` bills GEA — headline − panel =
> (GEA − NIA) × 14 000, exact to the rupee on all 25 states, **−35.75% on F3
> unedited**. Two furniture rate tables. `w.generated` as the partition
> predicate after being deleted **by name** in `takeoff.ts` — an imported DWG
> bills **₹0 of partition** in its headline.

…plus a CHECK/GUARD re-partition of eleven items, three false self-claims, a
wasm build-identity requirement for gates, and a five-sighting generalised sweep.

## Work unique to Line B (24 files) — not present in A at all

* **The whole drawing-set round**: `scripts/drawing-set.test.mjs` (red at base
  with 19 failures for 73 commits), its baseline with per-digest provenance
  (`--update` refused without `--why`), `sg5-board-integrity`, **`sg7-area-identity`**
  (the sheet as a read surface), the sheet board's `drawing-set` row
* **R12-amended** `reconcile.mjs` — the asserting-file population derived
  repo-wide (79 files, 0 unclassified) instead of two authored directory names
* **R18** conjunct enumeration + **R15** surface census in `metrics_tests.rs`
* **R22** — `zone_domain!`, the single authoring point, plus `gen-zone-domain.mjs`
  and the generated TS view (staleness = battery step 52)
* `groundConsumers.test.mjs`, `worktree.sh`, `deadspace-core`, `sheetlib`,
  `document.rs`, `conform.rs`, `theme.ts`, `planStyle.ts`, `EditorCanvas.ts`

## What I have NOT verified

**Line A's board.** Confirming it means checking out its tree and building —
~2 GB against **3.9 GiB free**, under a session that has already hit ENOSPC.
Its ledger claims its own state; I am not repeating that claim as measurement.

Line B's board IS measured, on freshly rebuilt artifacts: **Rust 200, battery
52/52** (`--full`, alone), pre-commit gate green at commit time. Line B's sheet
board was last direct-run at 8/8 **before** the macro round and is not claimed
after it.

## Assessment

The two lines are **complementary, not redundant** — A went deeper on the
area/plate/cost axis, B went wider on the gate/board/domain axis — but they
collide in 27 files including `lib.rs`, `zone.rs`, `metrics_tests.rs`,
`quantity.rs`, `cost.rs` and the ledger both append to.

Integration is real work, not a merge commit: two implementations of one
mechanism must be reconciled (keeping A's throw-on-missing-id and B's ordering
helper is the strictly better combination), and two ledgers must be interleaved
without either's retractions being lost — those retractions are the mission's
primary artifact.

**Recommended order**, when it is done with room to work:

1. Take `048d99e` as the base (it is the branch, and its unique work includes a
   live rupee-exact cost defect).
2. Port B's unique 24 files — they touch mostly files A never edited.
3. Reconcile the area mechanism deliberately: A's `publishedArea` throw
   semantics + B's `compareZoneExtent`, one census surviving, the other retired
   by name with its reasoning preserved.
4. Interleave the ledgers chronologically; no retraction may be dropped.
5. Re-run everything and dispatch a fresh adversary against the merged tree —
   neither line's verdict covers the merge.

**Do not attempt steps 2–5 without disk headroom.** The grandfathered worktrees
must be disposed of by whoever owns them first.
