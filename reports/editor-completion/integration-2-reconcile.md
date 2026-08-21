# Integration-2 reconciliation — `editor-completion-2` (W1 deploy gate · W2 SG5 manifests · W3 D-Q · W4 generator)

Merge of four green workstreams onto main `d868ec3`. Rust 217/217 and typecheck
were green on the merge before this round; wasm rebuilt and committed. Everything
below is re-derived from artifact bytes and core state, never from a producer
summary (`.claude/rules/gate-independence.md`). Ports: this tree's dev server ran
on **5306 exclusively**; controls rendered headlessly in scratch worktrees.

## 1. The drawing-set composition, attributed (question 1)

The merged tree's sheets matched NEITHER parent baseline, as predicted: W3
re-pinned 5 digests on a pre-W4 tree; W4 changed both case documents and never
ran this fixture (its head is RED against the base baseline at 359 checks —
scoped claim: measured this round in the W4-head control worktree).

### The instrument

Sheet ink depends on (renderer TS, generator wasm). Scratch worktrees
(`git worktree add --detach`, `web/node_modules` symlinked, each tree's OWN
committed wasm + renderer) at base `d868ec3`, W3 head `51e84ef`, W4 head
`74dd408`, plus the merged tree; `drawing-set.test.mjs --dump` op rows diffed
pairwise. Tree-scope precondition, verified by `git diff` before anything ran:
merged ≡ W3 on `web/src/export/**`, merged ≡ W4 on `crates/**` + `web/src/wasm`
(both diffs empty), and no other merged file touches the sheet path — so
`merged − W4-head` isolates the W3-renderer mechanism and `merged − W3-head`
isolates the W4-document mechanism.

| control | result |
|---|---|
| base | **PASS (293)** — reproduces the committed pin exactly |
| W3 head | **PASS (293)** — reproduces its own re-pin exactly |
| W4 head | **FAIL (359)** — its own baseline (= base's) never re-pinned; dwg grew a 13th sheet |
| merged (at merge) | **FAIL (356)** — see the two live reds below |

### Per-sheet verdicts (md5 table over all four dumps)

* **8 sheets identical everywhere** (covers, sections, moodboard: dwg 1,7,8,10 ·
  seeded 1,2,7,8,10).
* **10 sheets W4-only** (merged == W4-head, W3-head == base): dwg 2 (contents,
  13-sheet set), dwg 9 / seeded 9 (F&F counts), dwg 11 / seeded 11 (finish
  schedule rows), dwg 12 (the NEW `ROOM FINISH SCHEDULE (CONT.)` sheet),
  dwg 13 / seeded 12 (D&W continuation), seeded 3 (demolition labels on the
  regrown program). W3's renderer contributes zero ink to these.
* **7 sheets composed** — exactly the plan sheets where W3's annotation rungs
  operate on W4's changed documents: dwg 3–6 (A.01–A.04), seeded 4–6
  (A.02–A.04). Decomposed row-by-row: every op in the W3-effect direction
  (`merged − W4-head`) is annotation-family ink — room/services labels, area
  lines, dims (+6 returned on seeded A.02, +3/−1 on dwg A.02), D/W/E/LC/DB
  tags, leaders, knockouts, circuit/ceiling re-nudges. Text rows classified
  exhaustively: **0 unexplained**. Document-scale ink (walls, furniture,
  schedule rows) appears only in the W4 direction.

### Two live reds at the merge, root-caused (neither is a re-pin)

**R1 — `dwg A.02: 'OPEN WORKSPACE (7)' is drawn 0x` (composition; merged only).**
The sheet printed `OWS (7)` at 5.6 pt — the abbreviation rung. Mechanism: under
the base renderer the label sat in the plate margin (one of the D-Q defects W3
exists to kill — the W4-head control shows it there); W3's footprint confinement
correctly removed that spot, and on W4's 31-room A.02 the full-name wide tier
(±3 col × ±6 row) exhausted, so the ladder fell through displacement to damage —
the exact failure the D3 ordering exists to avoid, surfacing one tier up.
**Fix:** `wideCandidates` now spans ±6 × ±10 (displacement before damage; the
walk stays nearest-first and deterministic). Measured blast radius: seeded pack
byte-identical; every moved dwg string is a wide-tier settler or its sequential
occupancy cascade, all annotation ink. OW(7) prints full-size at 8 pt
in-building, leader-backed.

**R2 — `dwg: 1 sheet carries a continuation banner for 2 pages past the 11
unconditional` (W4-document; both W4-head and merged).** Sheet 12 is
`ROOM FINISH SCHEDULE (CONT.)` — A.09's pagination rung, dormant until a
document exceeded its ~29-row panel, first exercised by W4's 31 rooms. The test
recognized only the door/window continuation banner: the D-C family — the test
wrong, the drawing right. **Fix (instrument):** `CONT_TITLES` is the set of
banners the product can emit; the arithmetic is unchanged (every page past the
unconditional 11 carries exactly one continuation banner, and they are the last
pages).

**Sabotage round** (disposable worktree at the fix commit, each mechanism cut in
turn; no null results):

| sabotage | expected red | result |
|---|---|---|
| S1: wide tier back to ±3×±6 | drawn-once | **RED** — exactly `OPEN WORKSPACE (7) drawn 0x` + the 4 dwg plan digests |
| S2: finish-schedule banner removed from the test's known set | continuation arithmetic | **RED** — `1 banner for 2 pages past 11` (reproduces the watched pre-fix red) |
| S3: product emits the extra page UNBANNERED (`finishSchedule.ts` cont suffix suppressed) | banner checks | **RED** on two independent checks (banner-count 2x + continuation arithmetic) + sheet-12 digest |

### The re-pin

16 digests moved (7 seeded, 8 dwg changed + dwg sheet-13 new), re-recorded with
per-sheet `--why-sheet` attribution; **all 16 sheets viewed as rasters before
blessing** (S5). Baseline reproduces on an independent process:
`drawing-set PASS (360 checks)`.

Check manifest 293 → 360, disposed by name in
`scripts/fixtures/drawing-set.manifest.json`
(`the_71_gains_4_losses_disposed_integration2`): +69 W4-document (68 room
checks for the 16 newly named dwg rooms + sheet-13 row-present; all present in
the W4-head control manifest), +1 composition (`rooms/dwg/A.01/MEETING ROOM
4/leader` — displaced only under W3's rungs), +1 new sheet-13 digest pin; −4
conditional `/leader` checks whose labels reattached (3 W4-alone, 1
composition-only: `A.01/CORE 2`), each room keeping drawn-once + area-line.

### The same rung, one gate layer up: SG1/SG3/SG4/SG7 and the paginated schedule

The first full sheet board on the merged tree (pre-fix, kept as the watched red:
`SG1 FAIL (222, 1 failing) · SG3 FAIL (327, 2) · SG4 FAIL (36, 2)`) failed on
the SAME dormant rung: `sheetlib.sheetsFor` titled every continuation sheet as
the door/window kind (so A.10's own title words were "foreign" to SG1's purity
vocabulary), and SG3 3.4 / SG4 read schedule rows from page 11 alone (so Core
2/3 — legally rowed on the continuation page — counted as "no named row").
D-C family again: the drawing right, the gates wrong.

Fix, spec-anchored: `CONT_KINDS` is the closed set of continuation kinds the
product can emit (banners quoted from the producers' literals); each delivered
page past A.09 names its kind by its own banner (artifact bytes, pdftotext),
and an unknown banner is a hard GateError. The schedule surface for SG3/SG4
is A.09 + delivered `rfs` continuation pages; the expected room set stays
core-state-derived (the completeness rule: derive the full expected set from
core state, match each artifact against it). SG7 was already title-keyed and
picks the continuation up through the same change.

**Falsification round** (disposable worktree at `a7f6086`, own renders):

| falsifier | result |
|---|---|
| F1: product drops the last row of each schedule page | **RED** — SG4 `2 room(s) have no named row: 748, 750` + SG3 names both rooms; the anchor reaches core state, not the producer's list |
| F2: continuation banner renamed (`ROOM FINISH TABLE`) | **RED** — hard GateError `page 12 … carries no known continuation banner`, the closed-vocabulary guard |
| F3: schedule surface narrowed back to A.09 alone | **RED** — the pre-fix red reproduces digit-for-digit (749, 750) |

No null results.

### SG5's G11 count pin, re-derived and re-pinned

`SG5 FAIL (67, 1 failing): G11 still runs 56 checks — 58 now`. G11's emission
loop runs one equality check per distinct (room, item) pair; measured with the
gate's OWN `zone_at`/`item_description` over `core_state('seeded')` in both the
base scratch worktree and the merged tree: **30 pairs at base, 32 on W4's
regrown demo document** (zone ids renumber; the multiset diff is net +2). The
call-site identity manifest (W2) is UNCHANGED and held — this is document-driven
growth in a data-driven loop, the precise case W2's design keeps the count
beside the manifest for. `BASELINE.G11` re-pinned 56 → 58 with the attribution
in the pin comment.

## 2. D-Q on the merged tree (question 2)

Pre-registered expectation: W3's displacement rungs handle W4's new labels → 0
(W4-head alone measured 27; W3-head alone 0). Measured on the merged packs by
W3's instrument (SG8 assertion 8.2, counting rule frozen), verbatim:

```
  seeded/A01..A04, testfit/A01..A04, dwg/A01..A04:
    0 crossing (wall 0, arc 0); D-Q outside-footprint 0     (all 12 rows)
  TOTAL strings on wall/arc ink: 0   (frozen D-P corpus: 107)
  TOTAL D-Q outside-footprint strings: 0   (assertion 8.2 — fail-first 26 @ 547d4a0, 24 @ d868ec3)
SG8 PASS (24 checks)
```

**D-Q = 0, zero survivors** — nothing to name per W3's convention. Note the
composition detail that made this non-trivial: keeping OW(7) OUT of the margin
(D-Q's zero) while keeping its full name printed (drawn-once) is exactly what
required the wider displacement tier in §1 R1.

## 3. SG5 with W2's manifests (question 3)

W2's `g-board.manifest.json` pins the G1–G11 call-site identities; W3/W4 did
not edit gate files, and the pin HELD — the only SG5 red on this tree was the
G11 runtime COUNT (§1), which is the manifest's complementary pin doing its
separate job on a data-driven loop. `SG5 PASS (67 checks)` on the final board,
with the identity manifests re-derived from the gate source bytes in that run.

## 4. G10's 300 s stopwatch (question 4)

Boards were run SERIALLY on a quiet machine (no parallel walkthrough encodes,
no sibling worktree missions). **G10 made its window: PASS (14 checks)**; the
walkthrough.mp4 landed 286 s after the pack write (18:40:37 → mtime 18:45:23),
inside the 300 s stopwatch with ~14 s of margin. The W3-era misses (~348 s and
~360 s, measured under four concurrent worktree missions; the base-tree control
was also red under that load) are attributable to machine contention, not to
this tree — scoped claim: this machine, this session, serial run. The margin is
thin; if the gate reds again under load, the finding stands on record here
rather than the gate being edited.

## 5. Boards (verbatim)

### `GATE_BASE=http://localhost:5306 node scripts/gates/sheets/run-all.mjs`

```
--------------------------- SCOREBOARD -----------------------
  SG1  Panel containment            PASS (222 checks)
  SG2  Plate confinement            PASS (24 checks)
  SG3  Label integrity              PASS (327 checks)
  SG4  Name uniqueness              PASS (36 checks)
  SG5  Board integrity              PASS (67 checks)
  SG6  Determinism + independence   PASS (16 checks)
  SG7  Area identity (sheet == core) PASS (240 checks)
  SG8  String-ink crossing (D-P)    PASS (24 checks)
  drawing-set Sheet content digest         PASS (360 checks)
--------------------------------------------------------------
  9/9 passing                    431.7 s

ALL SHEET GATES GREEN.
```

### `GATE_BASE=http://localhost:5306 bash scripts/gates/run-all.sh`

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
  G11  Furniture agreement PASS  (58 checks)
  G12  Drawing set (SG1-SG4,SG6,SG7) PASS  (865 checks)
  G13  Circulation (C1-C10) PASS (9 gates, 1 pending-human)
  G14  Plan quality (PQ0-PQ2) PASS (3 checks)
--------------------------------------------------------------
  14/14 passing

  graded pack: 10/10 artifacts in out/
               + 12/12 G9 round-trip case files, written 18:40:37
               walkthrough.mp4  69571946 B  mtime 18:45:23  43.00s
               unchanged since G10 produced it; PASS  (12 checks)

ALL GATES GREEN.
```

### `bash scripts/verify-all.sh --full`

```
  1 step(s) SKIPPED — NOT MEASURED:
    node supabase/tests/rls.test.mjs (tenancy policies) — SKIP: no reachable Postgres (set PGHOST/PGPORT/PGUSER, or start one)
VERIFY OK — 62/63 steps green, 1 skipped
```

The same single named environmental skip the merge opened on.
`cargo test -p ds-core`: **217 passed; 0 failed** (this tree, this round —
integration touched no Rust).

## 6. Attribution table (every changed digest / manifest delta, one row each class)

| item | mechanism | evidence |
|---|---|---|
| dwg s2, s9, s11, s12, s13 · seeded s3, s9, s11, s12 digests | **W4** | merged dump == W4-head dump byte-identical; W3-head == base |
| dwg s3–s6 · seeded s4–s6 digests | **W3×W4 composition** | W3-effect (`merged − W4-head`) classified per text row: labels/areas/dims/tags only, 0 unexplained; W4-effect carries all document-scale ink |
| `OWS (7)` drawn-once red | **composition, fixed** | wide-tier reach; sabotage S1 reproduces the exact red |
| continuation-banner structure red | **W4 (dormant product rung) + stale test spec, fixed** | present in W4-head control; sabotages S2/S3 fire |
| manifest +68 room checks, +1 sheet-13 row-present | **W4** | all present in W4-head control manifest |
| manifest +1 `A.01/MEETING ROOM 4/leader` | **composition** | absent in W4-head control; conditional check born of W3 displacement |
| manifest −3 `/leader` (IT / SERVER, PHONE BOOTH 1, RECEPTION) | **W4** | vanish in W4-head control too (labels reattached) |
| manifest −1 `A.01/CORE 2/leader` | **composition** | vanishes only in merged (reattached under W3 rungs) |
| SG1/SG3/SG4 pagination reds | **W4 doc × pre-pagination gate vocabulary, fixed** | falsifiers F1–F3 fire, no nulls |
| SG5 G11 count 56→58 | **W4** (data-driven loop growth) | 30→32 (room,item) pairs, gate's own functions, both trees |
| SG8 / D-Q | **W3 holds on W4's documents** | 0 crossing, 0 outside-footprint, all 12 sheets |

Scope note: every "byte-identical"/"unchanged" claim above is scoped to the
populations named in its row (op dumps of the 25 sheets, the check-name
manifests, and the three packs' plan sheets), measured this round on this tree.

## 7. Desk items (for the owner's queue, none blocking)

1. **Contents-page naming**: the dwg contents lists A.10 as "Room Finish
   Schedule" (same as A.09) while A.11 reads "Door & Window Schedule (cont.)" —
   the finish-schedule continuation's title-block/contents title carries no
   "(cont.)" though its banner does. Cosmetic inconsistency in
   `finishSchedule.ts` `schedulePage`'s `tb(..., 'Room Finish Schedule', ...)`.
2. **G10 margin is thin**: 286 s used of the 300 s window, serial and quiet.
   Under any parallel encode this gate will red again for machine reasons; the
   control evidence (base tree red under 4-mission load) is in W3's report.
3. **Process note**: W4's branch shipped with `drawing-set FAIL (359)` against
   its own committed baseline — the fixture was in no board W4 quoted (its
   verify battery passes because the drawing-set fixture lives on the SHEET
   board, exercised via SG5/G12, which W4 never ran end-to-end). Worth a rule:
   a workstream that changes generator output runs the sheet board once before
   handing to integration.
4. **The wide tier's bound is empirical, not structural**: ±6×±10 covers the
   31-room A.02; a future document that exhausts it will fall to the
   abbreviation rung again, and the drawn-once gate will name it (that is the
   correct failure mode — the gate holds the property, the tier holds the
   budget).
