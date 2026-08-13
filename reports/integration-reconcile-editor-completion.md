# Integration reconciliation — `editor-completion` merge (five workstreams)

Scope: the two red rows on the sheet board at merge commit `b792327` (SG5 board
integrity; drawing-set digest gate), reconciled without touching any workstream
source. Everything below is re-derived from artifacts and core state, never from
a producer summary (`.claude/rules/gate-independence.md`).

## 1. The drawing-set failure, attributed

At `b792327` the drawing-set gate reported **5 changed dwg digests** (sheets
3/4/5/6/11 — A.01 Demolition Plan, A.02 Construction & Furnishing Plan, A.03
RCP, A.04 Power & Data Plan, A.09 Room Finish Schedule) and **46 VANISHED
pinned checks**: `rooms/dwg/{A.01,A.02}/OPEN WORKSPACE (5)..(12)/{drawn-once,
area-line,leader}` — 16 + 16 + 14 (two of the sixteen labels sat on their room
at the pin, so no leader check ever existed for them). Zero checks gained.

### The instrument

Sheet ink depends on (renderer TS, generator wasm). The five fix branches all
fork from `4ea630b`; the committed pin was recorded by workstream B at
`547d4a0` (base generator + B's renderer). So the counterfactuals were built by
**holding the renderer at HEAD and swapping only the wasm** in a disposable
worktree (`git worktree add --detach … HEAD`, `web/node_modules` symlinked;
this tree's fixtures untouched):

| variant | wasm from | drawing-set result |
|---|---|---|
| base | `547d4a0` (= `4ea630b`, committed blob) | **PASS (339)** — reproduces the committed pin exactly |
| A-only | `7704441` (committed blob) | **PASS (339)** — dump **byte-identical to base** |
| E-only | `1d3a757` + `make wasm` in the scratch worktree (E's branch had not rebuilt wasm) | FAIL (293) — dump **byte-identical to merged** |
| merged | HEAD working copy (= committed blob at `b792327`) | FAIL (293) |

`dump(base) == dump(A-only)` and `dump(E-only) == dump(merged)`, both
byte-identical across all 24 sheet row-dumps. That closes the attribution:
**every changed digest and every vanished check is mechanism E alone; A
contributes zero ink; there is no composition residue on this surface.**

### What each mechanism does to the two case documents

Derived by dumping `state()` (zones + components + quantities) per variant:

* **seeded**: byte-identical across base / A-only / D-only / E-only / merged.
  Its digests did not move, correctly.
* **A** (conform.rs bounded-local-width conjunct): re-types **one** dwg
  Circulation clearing → Unassigned (zone id 304 at base geometry; id 292 at
  E geometry — the same clearing, reshaped by E's desk moves). Both types are
  ground classes: unlabelled, unscheduled, and drawn with identical ink — hence
  zero digest effect even in composition.
* **E** (packing.rs `no_straddle`): the dwg document stops emitting its **8
  one-desk 'Open Workspace' wrapper pockets** (zone ids 258–265, 0.98 m² each,
  a band at y = 4.8 m — each one a fill desk that straddled a workspace edge,
  wrapped as its own micro-room) and **127 of 233 components relocate**.
  Furniture is conserved by category: 11 Door / 9 Table / 118 Chair / 95 Desk
  before and after. dwg rooms 28 → 20.
* **D** (pax) and **C** (paint.ts): no effect on either case document or any
  sheet byte. D-only wasm reproduces the base documents exactly.

### Disposition

The 46 checks are **RETIRED with attribution** in
`scripts/fixtures/drawing-set.manifest.json` (339 → 293), not recovered: the
merged document contains no successor zones under new numbers — the four
generator-numbered Open Workspace rooms (ids 159/222/223/225) remain with
identical labels, and the pocket desks re-seat inside existing rooms. The
vanished "rooms" were 1.0 m² single-desk billing artifacts; their removal is
the fix working, not a loss of floor area (A.09 now bills 20 real rooms).

The five digests were re-recorded with per-sheet `--why-sheet` attribution
after rasterising A.01 / A.03 / A.09 (base vs merged) and **looking**: the
merged sheets are the base sheets minus the eight micro-room labels/rows, with
tags and fixtures following the moved desks.

Not a defect verdict: no room that should exist is missing, and no digest diff
shows breakage — every removed op is a pocket-room label/area/leader/schedule
row and every moved op follows a relocated component.

## 2. SG5, and the pack

SG5's 27 failing checks were all "no scoreboard line — the gate produced
nothing": this worktree had never built the deliverable pack in `out/`. The
pack was produced by the sanctioned one-action path — `bash
scripts/gates/run-all.sh` with `GATE_BASE=http://localhost:5306`, a dev server
started for THIS tree on port 5306 exclusively (`lsof` cwd assertion in the
runner confirms the serving tree) — G10 clicks the app's one export control,
the graders grade what that run emitted, and the closing integrity pass proves
nothing was rewritten underneath them.

## 3. Board verdicts

### `GATE_BASE=http://localhost:5306 bash scripts/gates/run-all.sh` (verbatim)

```
--------------------------- SCOREBOARD -----------------------
  G1   Sheet structure    PASS  (59 checks)
  G2   Formula liveness   PASS  (17 checks)
  G3   Quantity truth     PASS  (92 checks)
  G4   Plan graphic       PASS  (18 checks)
  G5   Thumbnails         PASS  (70 checks)
  G6   Renders            PASS  (53 checks)
  G7   Video              PASS  (19 checks)
  G8   Web viewer         PASS  (9 checks)
  G9   Round-trip         PASS  (24 checks)
  G10  One-action UX      PASS  (14 checks)
  G11  Furniture agreement PASS  (56 checks)
  G12  Drawing set (SG1-SG4,SG6,SG7) PASS  (782 checks)
  G13  Circulation (C1-C10) PASS (9 gates, 1 pending-human)
  G14  Plan quality (PQ0-PQ2) FAIL: 2 of 3 plan-quality check(s) red
--------------------------------------------------------------
  13/14 passing

  graded pack: 10/10 artifacts in out/
               + 12/12 G9 round-trip case files, written 19:38:32
               walkthrough.mp4  58920343 B  mtime 19:42:41  43.00s
               unchanged since G10 produced it; PASS  (12 checks)
```

**G1–G13: all PASS.** G14 is the plan-quality board that SHIPS RED BY DESIGN
(run-all.sh's own comment: its checks were written before any generator change
and watched fail; "its redness is a generator change, not a gate fix").
Verified in this run: PQ0, the sabotage self-test, is GREEN — the red rows are
exactly the two pre-registered quality rubrics:

```
PQ0 PASS (12 checks): sabotage round holds — 6 producer hints corrupted then deleted, verdict identical; 6 falsifications fire
PQ1 FAIL (63 checks): 63 desks -> 10 neighbourhood(s) [16, 12, 8, 8, 4, 4, 4, 4, 2, 1]; 7 outside 6-12
PQ2 FAIL (91 checks): 12 sub-minimum gap(s), 12.62 m2: 0.30m Collab|Pantry, ...
```

The generator is frozen for this reconciliation, so PQ1/PQ2 remain the product
owner's queue, unchanged in kind by the merge.

### Pack provenance

Dev server: `npx vite --port 5306 --strictPort` in `web/`, this tree —
confirmed by `lsof` cwd (`/Users/udsy/PycharmProjects/DSource-Editor/web`) and
by the runner's own pre-flight worktree assertion. G10 clicked the app's one
export control; the closing integrity pass re-hashed the graded artifacts
(`unchanged since G10 produced it; PASS (12 checks)`); the mp4 decodes at
43.00 s.

## 4. Sheet board + SG8 (verbatim, post-re-pin, `GATE_BASE=http://localhost:5306`)

```
--------------------------- SCOREBOARD -----------------------
  SG1  Panel containment            PASS (216 checks)
  SG2  Plate confinement            PASS (24 checks)
  SG3  Label integrity              PASS (283 checks)
  SG4  Name uniqueness              PASS (36 checks)
  SG5  Board integrity              PASS (32 checks)
  SG6  Determinism + independence   PASS (16 checks)
  SG7  Area identity (sheet == core) PASS (207 checks)
  SG8  String-ink crossing (D-P)    PASS (12 checks)
  drawing-set Sheet content digest         PASS (293 checks)
--------------------------------------------------------------
  9/9 passing                    402.6 s

ALL SHEET GATES GREEN.
```

SG8 (string-ink crossing) renders its population itself from core state +
delivered glyph runs; the re-pin touched no input of it, and it holds its
0-crossing verdict at **PASS (12 checks)** on the merged tree with E's moved
labels in the population.

## 5. verify-all --full (verbatim closing lines)

```
  1 step(s) SKIPPED — NOT MEASURED:
    node supabase/tests/rls.test.mjs (tenancy policies) — SKIP: no reachable Postgres (set PGHOST/PGPORT/PGUSER, or start one)
VERIFY OK — 62/63 steps green, 1 skipped
```

The same 62/63 with the same single named environmental skip the merge opened
on — the reconciliation moved no battery step.

## 6. Attribution table

| item | mechanism | evidence |
|---|---|---|
| 46 vanished checks `rooms/dwg/{A.01,A.02}/OPEN WORKSPACE (5)..(12)/*` | **E** — 8 one-desk wrapper pockets no longer emitted | dump(E-only wasm) == dump(merged) byte-identical; zones 258–265 absent from E-only document; RETIRED with attribution, 339 → 293 |
| dwg sheet 3 digest (A.01, −16 text / −6 line) | **E** | pocket labels + 1.0 m² area lines + leaders |
| dwg sheet 4 digest (A.02, −16 text / −9 line) | **E** | pocket labels/areas + W-tag repositioning after wrapper partitions vanished |
| dwg sheet 5 digest (A.03, −8 text / −189 line / −56 rect) | **E** | ceiling grid re-laid over 127 moved components |
| dwg sheet 6 digest (A.04, −8 text / −5 line / −8 rect) | **E** | power/data re-routed to moved desks |
| dwg sheet 11 digest (A.09, −72 text / −8 line / −4 rect) | **E** | 8 schedule rows (ids 258–265) removed; 20 real rooms remain |
| dwg zone id 304→292 type Circulation→Unassigned | **A** (geometry composed with E) | zero ink delta: dump(base) == dump(A-only) byte-identical — both are ground classes |
| seeded case (all 12 digests) | none | document byte-identical across base/A/D/E/merged |
| D (pax), C (paint.ts) | none on this surface | D-only wasm reproduces base documents; C touches the canvas painter, not the PDF path |

No item was papered over: no missing real room, no breakage-shaped diff. The
eight retired "rooms" were 0.98 m² single-desk billing artifacts whose removal
is workstream E behaving as specified, with furniture conserved by category.
