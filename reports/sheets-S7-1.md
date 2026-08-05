# S7-1 — Gate & harness integrity: the four checking-layer defects, closed by falsification

**Agent S7.** Checking layer only. **No product defect was fixed** — `web/src/export/**` and
`crates/**` are untouched (`git status` shows my four files and this report; `sheetSet.ts` /
`servicesSheets.ts` are S6's, `scripts/fixtures/**` is S5's and was not written).

Files changed
* `scripts/sheets/render-all.mjs` — derived sheet count; fails **closed**, never open.
* `scripts/gates/sheets/lib/sheetlib.mjs` — `BASE_SHEETS` + `sheetsFor(pack)` +
  `deliveredSheetNumbers(pack)` + `assertRendered(pack)`.
* `scripts/gates/sheets/sg1-panel-containment.mjs` — 1.5 (schedule completeness), 1.4b made
  artifact-side, 1.4's dead `cont` arm removed.
* `scripts/gates/sheets/sg4-name-uniqueness.mjs` — 4.1 restored from tautology, 4.2's population
  re-widened.
* `scripts/drawing-set.test.mjs` — every case graded; derived sheet count.

```
$ node scripts/sheets/render-all.mjs --pack all
sheet harness: seeded · testfit · dwg → out/sheets/ at 144 dpi
  seeded: 12 sheets → out/sheets/seeded/ (2382×1684 px @ 144 dpi, pdf 1217220 B)
  testfit: 12 sheets → out/sheets/testfit/ (2382×1684 px @ 144 dpi, pdf 1138204 B)
  dwg: 12 sheets → out/sheets/dwg/ (2382×1684 px @ 144 dpi, pdf 1342864 B)
sheet harness OK — 3 pack(s) × 12 sheets

$ node scripts/gates/sheets/run-all.mjs
  SG1  Panel containment            PASS (213 checks)     ← 201 + 4 × 3 packs (1.5)
  SG2  Plate confinement            PASS  (24 checks)
  SG3  Label integrity              PASS (295 checks)
  SG4  Name uniqueness              PASS  (36 checks)
  SG5  Board integrity              FAIL  (27 checks, 4 failing)   ← 25 → 27: D-F closed
  SG6  Determinism + independence   PASS  (16 checks)
  5/6 passing                    401.9 s

$ SHEETS=1 bash scripts/gates/run-all.sh
  G1   Sheet structure    PASS  (59 checks)      G7   Video          PASS  (19 checks)
  G2   Formula liveness   PASS  (17 checks)      G8   Web viewer     PASS   (9 checks)
  G3   Quantity truth     PASS  (92 checks)      G9   Round-trip     PASS  (24 checks)
  G4   Plan graphic       PASS  (18 checks)      G10  One-action UX  PASS  (14 checks)
  G5   Thumbnails         PASS  (70 checks)      G11  Furniture agr. PASS  (56 checks)
  G6   Renders            PASS  (53 checks)
  11/11 passing
               unchanged since G10 produced it; PASS  (12 checks)
ALL GATES GREEN.
```

`59 · 17 · 92 · 18 · 70 · 53 · 19 · 9 · 24 · 14 · 56 (+12)` — the required numbers, check for check.

```
$ cd web && pnpm typecheck        → clean (tsc --noEmit, no output)
```

SG5's four reds: **two are the S5 baseline hand-off** (`drawing-set.test.mjs passes — it says FAIL`
and `281 checks now, 252 at the baseline`) — the correct end state per Law 4; **two are an
environmental flake in `scripts/gates/run-all.sh`, outside my lane** — see §5.

---

## 1. SG4 — 4.1 was a tautology and 4.2 had gone silent. Both fixed, proved by re-introducing D4.

### The falsification, run twice on the SAME sabotaged artifact

Sabotage **F4**, in a full scratch copy of the repo: `roomDisplayNames` (`web/src/export/roomNaming.ts`)
returns `new Map()` — D4 exactly as it was before S3's fix. All three packs re-rendered, workbooks
re-produced (`node scripts/export-pack.mjs`). Then the **shipped S3 gate** and **my gate** were run
against that one artifact:

```
$ node scripts/gates/sheets/sg4-OLD-s3.mjs           # `git show :…/sg4-name-uniqueness.mjs`
  FAIL dwg/A09 no two schedule rows share a room name — "Open Workspace" on rows 246, 247, 248
  FAIL dwg/A09 every row's name is the one predicted from core state — row 246: "Open Workspace"
       vs predicted "Open Workspace (5)"; row 247 …; row 248 …
  FAIL dwg workbook Inventory names are the ones predicted from core state — room 246 …
  FAIL dwg workbook Inventory names are unique — "Open Workspace" on rooms 246, 247, 248
SG4 FAIL (36 checks, 4 failing)

$ node scripts/gates/sheets/sg4-name-uniqueness.mjs  # S7
  FAIL dwg every scheduled room is given a name of its own in the delivered set
       (1 core-state label collision(s) to resolve: "Open Workspace" on 246/247/248)
       — "Open Workspace" is the core's label for 3 zones (246, 247, 248) and the delivered set
         names them 246→"Open Workspace", 247→"Open Workspace", 248→"Open Workspace"
  FAIL dwg/A02 no room name is rendered twice — "OPEN WORKSPACE" rendered 3× at (416,101) (407,130) (469,159)
  FAIL dwg/A03 no room name is rendered twice — "OPEN WORKSPACE" rendered 3× at (473,115) (412,132) (421,149)
  FAIL dwg/A04 no room name is rendered twice — "OPEN WORKSPACE" rendered 3× at (473,115) (412,132) (421,149)
  FAIL dwg/A09 no two schedule rows share a room name — "Open Workspace" on rows 246, 247, 248
  FAIL dwg/A09 every row's name is the one predicted from core state — row 246 …
  FAIL dwg workbook Inventory names are the ones predicted from core state — room 246 …
  FAIL dwg workbook Inventory names are unique — "Open Workspace" on rooms 246, 247, 248
SG4 FAIL (36 checks, 8 failing)
```

**4 → 8 on the identical bytes.** All six of S1's original fail-first failures fire again:

| S1's fail-first line | check | S3's gate | S7's gate |
| --- | --- | --- | --- |
| `dwg core state gives every scheduled room a distinct name` | 4.1 | **silent** | **fires** (renamed, see below) |
| `dwg/A02 no room name is rendered twice` | 4.2 | **silent** | **fires** |
| `dwg/A03 no room name is rendered twice` | 4.2 | **silent** | **fires** |
| `dwg/A04 no room name is rendered twice` | 4.2 | **silent** | **fires** |
| `dwg/A09 no two schedule rows share a room name` | 4.3 | fires | fires |
| `dwg workbook Inventory names are unique` | 4.4 | fires | fires |

S3's two *new* prediction checks (A.09 and the workbook against the exact predicted name) are
untouched and still fire — nothing was traded away to get the four back. Check count is still **36**.

### 4.1 — the restored assertion, and why it is not a tautology

Removed (`sg4:209-224` as shipped):

```js
const byDisplay = …groups rooms by r.display…
const clashes = [...byDisplay.entries()].filter(([, ids]) => ids.length > 1)
c.ok(`${pack} every scheduled room ends up with a distinct name…`, clashes.length === 0, …)
```

`display` is `scheduledRooms()`'s own output, so `clashes` is provably always empty (the Judge's
proof, D-E: two zones sharing a base are in a group of ≥ 2 and get `(1)…(n)`, unique within the
group; a singleton keeping label `L` cannot equal a group's `"G (i)"` or `strip(L) = G` would have
put it in G's group). **Three checks per board reporting a passing number that meant nothing.**

In its place — **conditioned on the model, asserted on the artifact**:

```js
// A.09 is the one delivered surface carrying ROOM ID beside ROOM NAME.
const rows = scheduleRows(pageWords(pack, SCHEDULE_PAGE), gA09.titleBlock.pt.y)
const deliveredName = new Map(rows.map((r) => [r.id, r.name]))

const collisions = […rooms grouped by their CORE-STATE label…].filter(([, ids]) => ids.length > 1)
const unnamed    = rooms.filter((r) => !deliveredName.get(r.id))
const unresolved = []
for (const [label, ids] of collisions) {
  const got = ids.map((id) => deliveredName.get(id) ?? '(no row)')
  if (new Set(got).size !== ids.length || got.some((n) => n === label)) unresolved.push(…)
}
c.ok(`${pack} every scheduled room is given a name of its own in the delivered set` +
     ` (${collisions.length} core-state label collision(s) to resolve: …)`,
     unresolved.length === 0 && unnamed.length === 0, …)
```

**Why it cannot be a tautology:** every value on the assertion side comes from the **delivered PDF's
text layer** (`deliveredName`), and only the *condition* comes from core state. The gate has no way
to make the drawing print what it predicts. The proof is not the argument — it is the run above: the
check **fires**, naming the three zones and the three identical strings the delivered set gave them.

**Why it does not revert to the raw-`label` form S3 removed.** The old check asserted that
*core state* hands out distinct labels — unsatisfiable without editing `crates/ds-core/src/layout.rs`,
which is barred. This one asserts that the **drawing layer resolves** what the core left ambiguous,
which is exactly the lane that owns it: the shipped `roomDisplayNames` greens it, F4 reds it. The
core-state collision stays printed in the check's own name on a green board, as S3 intended.

The always-live second arm (`unnamed`) keeps the check from being vacuous on seeded/testfit, which
have no collisions: every scheduled room must have a named row on A.09 at all — 22 real lookups per
pack, not a skipped branch.

### 4.2 — the population, re-widened

```js
- const expected = rooms.map((r) => r.display.toUpperCase())
+ const expected = [...new Set(rooms.flatMap((r) => [r.display.toUpperCase(), r.label.toUpperCase()]))]
```

The narrowing was the whole defect: with the population reduced to *predicted* names, "OPEN
WORKSPACE" printed three times was **never searched for**, because the gate had predicted
"OPEN WORKSPACE (5)/(6)/(7)". Both members of the union come from the **input document**, so nothing
is scraped off the page; and `findLabelRuns(words, name, expected)` still rejects a run whose next
adjacent word makes it the head of a different expected name, so on a **correct** set the raw label
yields **zero** runs and the check is not made noisier — only un-blinded. Measured: SG4 stays
`PASS (36 checks)` on the delivered set, and goes to 8 failures on F4.

---

## 2. D-B — SG1 is no longer blind to a fabricated schedule

**New: 1.5, four checks per pack (201 → 213).** All of it reads the delivered PDF, with one core-state
anchor:

| # | assertion | where the ground truth comes from |
| --- | --- | --- |
| 1.5a | every opening **tagged on the plan** has exactly one schedule row across A.02 + every continuation sheet | plan tags = `[DW]\d+` words inside the `plate` rect (template geometry); rows = the `Door`/`Window` TYPE cell of a printed row with the tag word beside it on the same baseline |
| 1.5b | no **orphan row** — every row's tag is on the plan | the same two populations |
| 1.5c | the `SCHEDULE CONTINUED ON A.NN  (n MORE)` pointer names a sheet the delivered set carries, that sheet **is** a continuation sheet, and the count equals the rows actually continued — and the pointer is absent exactly when nothing overflowed | the delivered pointer text vs. the delivered sheet numbers |
| 1.5d | the **Door** rows equal `components.filter(category === 'Door')` | **core state** — the external anchor, so 1.5a/b are not two readings of one contaminated population |

Anchoring on the *type* word is what makes 1.5 count one hit per printed row: a row's tag is drawn
twice (once inside the hexagon glyph at `x + 18`, once in the TAG column at `x + 30`) and the glyph's
baseline sits 1.04 pt off the row's, which the `SAME_BASELINE = 0.05` tolerance excludes.

### The falsification — the Judge's own fabricated set

Both sabotages applied to `web/src/export/sheetSet.ts` in the scratch copy: A.02's pointer forced to
`SCHEDULE CONTINUED ON A.99  (0 MORE)`, and `openingOverflow.slice(0, -1)` so the last overflow row
is silently dropped. The Judge measured this artifact as `SG1 201 / SG2 24 / SG3 295` **all green**.

```
$ node scripts/sheets/render-all.mjs --pack all      → sheet harness OK — 3 pack(s) × 12 sheets
$ node scripts/gates/sheets/sg1-panel-containment.mjs
  FAIL seeded  every tagged opening has exactly one schedule row in the set — 1 of 41 plan tag(s)
       have NO schedule row anywhere: W24 (plan tags 41, rows 40 across A.02+A.10)
  FAIL seeded/A02 the continuation pointer resolves — the pointer names A.99, which the delivered
       set does not carry; the pointer says (0 MORE) but 9 row(s) are continued
  FAIL testfit every tagged opening has exactly one schedule row in the set — 1 of 48 plan tag(s)
       have NO schedule row anywhere: W30 (plan tags 48, rows 47 across A.02+A.10)
  FAIL testfit/A02 the continuation pointer resolves — … A.99 … (0 MORE) but 16 row(s) are continued
  FAIL dwg every tagged opening has exactly one schedule row in the set — 1 of 44 plan tag(s)
       have NO schedule row anywhere: W33 (plan tags 44, rows 43 across A.02+A.10)
  FAIL dwg/A02 the continuation pointer resolves — … A.99 … (0 MORE) but 12 row(s) are continued
SG1 FAIL (213 checks, 6 failing)
```

**W24 / W30 / W33 — the Judge named W24 on seeded and W30 on testfit; the gate names all three, by
tag, per pack.** On the shipped artifact 1.5 is green: 41 / 48 / 44 plan tags, one row each across
A.02 + A.10, no orphan, pointer resolving to A.10 with the right count.

**1.4b (D-I) went with it.** It compared the contents index to the *static* table while building a
`delivered` array nothing read. Both sides are now the artifact: the index page's own `A.NN` list vs.
the number each delivered title block carries in its number box.

---

## 3. D-C — the harness fails **closed**, and the sheet count is derived

### The derived rule, stated so it is falsifiable

> **expected = the 11 unconditional sheets, in order, carrying A.01 … A.09, followed by ZERO OR MORE
> continuation sheets numbered A.10, A.11, …**

A.02's legend panel *measures* its own capacity (31 rows on A3) and paginates only what it cannot
hold, so the continuation count is a function of the **document**: 41 / 48 / 44 tagged openings give
one each, 25 give none. The *count* comes from the delivered PDF's own pages; the **identity of every
page** is then held to the sequence by reading the `A.NN` out of each page's sheet-number box
(`deliveredSheetNumbers`, template rect `sheet.ts:325/371`). That is what keeps the swiftshader
tripwire live rather than loosened — see the third falsification below.

Three hard-coded 12s removed: `render-all.mjs:80-94/:205`, `sheetlib.mjs:141`,
`drawing-set.test.mjs:472`.

### Falsification 1 — a 25-opening document is graded, not lost

Sabotage: `openingSchedule(state).slice(0, 25)` — the Judge's exact scenario. Before, this exited 1,
blamed swiftshader and **emptied the pack directory**.

```
$ node scripts/sheets/render-all.mjs --pack seeded
sheet harness: seeded → out/sheets/ at 144 dpi
  seeded: 11 sheets → out/sheets/seeded/ (2382×1684 px @ 144 dpi, pdf 1188393 B)
sheet harness OK — 1 pack(s) × 11 sheets            rc=0
$ ls out/sheets/seeded/ | wc -l                      24     (was: empty)

$ node scripts/gates/sheets/sg1-panel-containment.mjs --pack seeded   SG1 PASS (65 checks)
$ node scripts/gates/sheets/sg3-label-integrity.mjs   --pack seeded   SG3 PASS (97 checks)
$ node scripts/gates/sheets/sg4-name-uniqueness.mjs   --pack seeded
  FAIL missing input: out/cases/seeded/quantity-takeoff.xlsx — … produce it with
       `node scripts/export-pack.mjs`                                  SG4 FAIL (9 checks, 1 failing)
```

65 = 71 − 6, i.e. exactly A.10's six containment checks and nothing else; every other check still
runs. (SG4's red is the scratch tree having no workbook — "a missing input is a FAILURE, never a
skip", working as designed.)

### Falsification 2 — a harness failure keeps its evidence, and the gates fail loudly

Sabotage: the section-sheet builder throws inside its try-wrapper (the swiftshader failure mode).

```
$ ls out/sheets/seeded | wc -l            24
$ shasum -a256 out/sheets/seeded/A02.png  c4ac966081fd820c955a81f460a96e9f51017b58b11f202375b9ded875461897

$ node scripts/sheets/render-all.mjs --pack seeded ; echo $?
sheet harness FAILED: seeded: drawing set came back with 10 sheets, and 11 are unconditional. A short
set means a sheet builder threw and was swallowed by its try-wrapper — classically the two section
sheets, when Chromium has no GL context (render-sheets.mjs must launch with --use-gl=swiftshader).
  the pack directory was NOT emptied — its previous contents are intact and RENDER-FAILED.json names
  this failure, so every sheet gate fails on this error rather than on "missing input".
1

$ ls out/sheets/seeded | wc -l            25          ← 24 + RENDER-FAILED.json
$ shasum -a256 out/sheets/seeded/A02.png  c4ac966081fd820c955a81f460a96e9f51017b58b11f202375b9ded875461897   (identical)

$ for g in sg1 sg2 sg3 sg4 …
  FAIL seeded: the sheet harness FAILED on its last run and this pack was not re-rendered —
       seeded: drawing set came back with 10 sheets, and 11 are unconditional. …
       (the previous render is still on disk beside RENDER-FAILED.json; it is not the artifact under test)
  SG1 FAIL (1 checks, 1 failing) · SG2 FAIL (1) · SG3 FAIL (1) · SG4 FAIL (2, 1 failing)
```

**Was:** `FAIL missing input: … — render the sheets first`, with the evidence destroyed.
**Now:** the harness's own error, quoted, on every gate, with the previous render byte-identical on
disk. Mechanism: `renderPackSheets` builds into `<out>/.<pack>.staging` and swaps only when the whole
pack is on disk (`dir → .prev`, `staging → dir`, drop `.prev`); a throw removes the staging tree,
writes `RENDER-FAILED.json` into the pack directory and rethrows. `assertRendered(pack)` in
`loadGeometry` / `pageWords` / `pageLines` / `deliveredSheetNumbers` is what turns the marker into a
loud gate failure.

### Falsification 3 — deriving the count did not buy the producer a way to shrink its own test

The one thing a derived count could have cost: a sheet vanishing while a continuation sheet backfills
the page count, so the set is *still* 11 pages. Sabotage: the A.08 moodboard builder is skipped, and
because sheets self-number from `numbered.length` the set renumbers into a **perfectly consistent
11-sheet A.01…A.09 sequence**. The harness therefore accepts it (correctly — it *is* a legal
sequence), and the gates catch it:

```
$ node scripts/sheets/render-all.mjs --pack seeded    → 11 sheets, rc=0
$ node scripts/gates/sheets/sg1-panel-containment.mjs --pack seeded
  FAIL seeded/A08 title-block purity — 3 foreign word(s) printed over the title block: Room Finish Schedule
  FAIL seeded/A09 title-block purity — 4 foreign word(s) printed over the title block: Door & Window (cont.)
  FAIL seeded every tagged opening has exactly one schedule row in the set — 10 of 41 plan tag(s)
       have NO schedule row anywhere: W17 W18 W16 W15 W22 W19 W23 W20 (plan tags 41, rows 31 across A.02)
  FAIL seeded/A02 the continuation pointer resolves — nothing overflowed but A.02 still says
       "SCHEDULE CONTINUED ON A.09 (10 MORE)"
SG1 FAIL (65 checks, 4 failing)
```

Four independent failures, on a set a flat page-count assertion would also have caught — and that
1.1 and 1.5 catch it *positionally* is why the derived list is a strengthening rather than a hole.
The harness's own positional check fires on the simpler shape (a numbered page carrying the wrong
`A.NN`), with the swiftshader diagnostic attached.

---

## 4. D-F — `drawing-set.test.mjs` grades every case again; SG5 is back to 27 checks

The abort was `assert.ok` at `:504` firing on the **first** case, so `dwg` was never rendered and
never graded, and SG5 could only reach 25 of its 27 checks.

* every case now runs inside its own `try/catch` and failures are **recorded, not thrown**
  (`ok()` pushes to `failures`); the process still exits 1;
* a baseline row that does not exist for a rendered sheet is a counted failure, not a `TypeError`;
* the scoreboard line keeps its exact shape in either colour — `drawing-set FAIL (281 checks)` — which
  is what SG5's reader needs;
* the structure check is derived: `BASE_SHEETS = 11` unconditional, plus one continuation sheet per
  further page, and every continuation banner must sit **past** the base sheets (so a set that
  dropped a sheet and grew a continuation one cannot pass by arithmetic).

```
$ node scripts/drawing-set.test.mjs ; echo $?
  seeded: 12 sheets · 1120 text / 4229 line / 866 rect ops · rooms 22 ·
          A.01 2 off-room, 1 led [PHONE BOOTH 1] · A.02 4 off-room, 2 led [PRINT POINT 2, PHONE BOOTH 3]
  dwg:    12 sheets · 1143 text / 5155 line / 1095 rect ops · rooms 23 ·
          A.01 9 off-room, 6 led [...] · A.02 14 off-room, 10 led [...]
drawing-set FAIL (281 checks)
1
```

**Both cases render, both are graded**, 281 checks against the 25 SG5 could previously see. All 14
recorded failures are the stale baseline and nothing else:

```
seeded: baseline has 11 sheets, this render has 12          dwg: baseline has 11 sheets, this render has 12
seeded sheet 2/4/5/6: content digest changed                dwg sheet 2/3/4/5/6/11: content digest changed
seeded sheet 12: the baseline has no row for this sheet     dwg sheet 12: the baseline has no row for this sheet
```

Structure, determinism and the room-labelled-once / off-room-leader assertions **pass on both cases**.
`SG5 FAIL (27 checks, …)` — the count delta SG5 correctly caught is closed. **The baseline was not
regenerated** (Law 4 — S5's, from renders the Judge has signed off), so
`drawing-set.test.mjs passes` and `still runs 252 checks` stay red. That is the intended end state.

---

## 5. What I could not close, and why

**`scripts/gates/run-all.sh`'s closing integrity pass is flaky on this machine, and it is not in my
lane.** Measured, three runs of `SHEETS=1 bash scripts/gates/run-all.sh`:

```
run A   11/11 passing · CHANGED under the gates: out/walkthrough.mp4 54913839 → 55049414   rc≠0
run B   11/11 passing · CHANGED under the gates: out/walkthrough.mp4 54984715 → 54919980   rc≠0
run C   11/11 passing · unchanged since G10 produced it; PASS (12 checks) · ALL GATES GREEN
```

A 3-second poll of the file across run C recorded exactly **one** write (`01:35:08`), and the file is
stable when nothing is running. In runs A and B it was written a second time ~70 s after the `BEFORE`
snapshot — the ffmpeg/browser-write race `.claude/rules/gate-independence.md` documents under "watch
the graded artifact is the emitted artifact", surfacing because the grading window is long enough for
it. `bash scripts/gates/run-all.sh G10` alone is green every time. Nothing I changed touches
`run-all.sh`, `g10-one-action.mjs`, `export-pack.mjs` or the video; the machine was also running four
dev servers and several browsers. **Run C is the board of record above.** When SG5 hits the same
race it reports it as two extra reds on top of its two real ones — that is what the 4-failing SG5
line means.

**S6 was editing `sheetSet.ts` / `servicesSheets.ts` throughout.** I re-rendered and re-ran against
their state at the end (`sheetSet.ts` mtime 01:04:32, board and gates run after 01:22). Every number
here is from that render. I was not blocked; if S6 lands further changes, only the drawing-set
digests move, and those are S5's to re-record anyway.

**Not touched, on purpose:** `scripts/fixtures/drawing-set.baseline.json` (S5, Law 4),
`web/src/export/**` and `crates/**` (product), `scripts/gates/run-all.sh` (out of lane).

---

## 6. Independence, re-proved

`SG6 PASS (16 checks)` in the board run above — the three-run
{pristine, corrupted, deleted} proof over SG1–SG4 is byte-identical after these changes. That
matters more than usual here, because the new derivations were built to keep it true:

* `deliveredSheetNumbers` reads the **delivered PDF's text layer**, not `geometry.json`'s `no` field
  (which SG6 vandalises);
* `sheetsFor` takes the continuation **title** from a quoted spec constant, not from `geometry.json`'s
  `title` (also vandalised);
* 1.5's populations are the delivered plate tags and the delivered rows, anchored to core state by
  1.5d;
* 4.1's condition is core state, its assertion the delivered A.09 rows;
* 4.2's population is the input document, in both its forms.

No `continue`-on-missing was added; the one new failure mode (`RENDER-FAILED.json`) exists precisely
to convert a silent missing input back into a loud, named one.
