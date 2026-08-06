# S8-1 — D-O and D-R closed: the window half gets its anchor, the exit tile gets its seat

Two defects from `reports/sheets-defects-2.md` round 2:

* **D-O** (MAJOR, gate) — a glazed run dropped upstream of `openingSchedule` was invisible to the
  whole sheet board. Closed by **SG1 1.5e**, which anchors the *Window* half of schedule
  completeness to core state the way 1.5d already anchored the *Door* half.
* **D-R** (minor, product) — two exit-luminaire `E` glyphs on one point on seeded A.03. Closed by
  giving a word-carrying services glyph a real seat in the sheet's one shared occupancy.

Everything below is measured output, pasted.

---

## 0. Boards

```
$ node scripts/sheets/render-all.mjs --pack all
sheet harness: seeded · testfit · dwg → out/sheets/ at 144 dpi
  seeded: 12 sheets → out/sheets/seeded/ (2382×1684 px @ 144 dpi, pdf 1217356 B)
  testfit: 12 sheets → out/sheets/testfit/ (2382×1684 px @ 144 dpi, pdf 1138295 B)
  dwg: 12 sheets → out/sheets/dwg/ (2382×1684 px @ 144 dpi, pdf 1343276 B)
sheet harness OK — 3 pack(s) × 12 sheets

$ node scripts/gates/sheets/run-all.mjs
--------------------------- SCOREBOARD -----------------------
  SG1  Panel containment            PASS (216 checks)
  SG2  Plate confinement            PASS (24 checks)
  SG3  Label integrity              PASS (295 checks)
  SG4  Name uniqueness              PASS (36 checks)
  SG5  Board integrity              FAIL (27 checks, 2 failing)
  SG6  Determinism + independence   PASS (16 checks)
--------------------------------------------------------------
  5/6 passing                    354.1 s
```

SG5's two reds are the two baseline lines that are **S5's job** — unchanged, byte for byte, from my
pre-change baseline run of the same board:

```
FAIL drawing-set.test.mjs passes — it says FAIL
FAIL drawing-set.test.mjs still runs 252 checks — 281 checks now, 252 at the baseline
```

```
$ SHEETS=1 bash scripts/gates/run-all.sh
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
--------------------------------------------------------------
  11/11 passing

  graded pack: 10/10 artifacts in out/
               + 12/12 G9 round-trip case files, written 03:23:51
               walkthrough.mp4  55134990 B  mtime 03:27:41  43.00s
               unchanged since G10 produced it; PASS  (12 checks)

ALL GATES GREEN.

$ cd web && pnpm typecheck
> dsource-editor-web@0.1.0 typecheck /Users/udsy/.superset/worktrees/DSource-Editor/export/web
> tsc --noEmit
                                                    (no output — clean)
```

11/11 with the required counts **59·17·92·18·70·53·19·9·24·14·56 (+12)**, unchanged.

### The one count that moved: SG1 213 → 216

**+3, one new assertion per pack — 1.5e.** An increase from a genuinely new assertion, as expected;
no existing check was removed, merged or weakened (SG2 24 · SG3 295 · SG4 36 · SG5 27 · SG6 16 are
all exactly as S7 left them). On `--pack seeded` alone SG1 reads 71 → 72.

---

## 1. D-O — the contaminated population, inside the gate written to prevent it

### 1.1 What was actually wrong

1.5's own header was honest about the design: *"(a) and (b) compare two readings of the same
artifact; this one [1.5d] compares the delivered rows to the document"*. But 1.5d is
`components.filter(cc => cc.category === 'Door')` — **only the door half had an external anchor**.
Plan tags and schedule rows both descend from one `openingSchedule()` call, so when the Judge dropped
a real glazed run *before* that call, both sides lost it together, agreed with each other, and the
board went green on a set in which a window that exists in the building is neither tagged on the plan
nor scheduled anywhere. `.claude/rules/gate-independence.md` §*"never calibrate against the
population under test"*, recurring inside a gate authored to enforce that rule.

### 1.2 The fix — 1.5e, and why it is not "one row per glazed wall"

A window in this document is not an object: it is the glass on `DocWall.glazing === true`, and the
generator emits one glazed front as **many short collinear segments** (sixteen 0.15 m pieces on the
seeded plate). So the honest anchor is neither the wall count nor a component count — it is one row
per **run** of contiguous collinear glass. A gate that counted glazed *walls* would happen to be
green on all three packs today (24/24, 30/30, 33/33 — the merge is currently a no-op on them) and
would go red on the first set where the merge did its job: calibrated on the present population's
conditions, which is the same rule's other failure mode.

So the gate derives the runs itself. **`glazedRuns(state)`** in
`scripts/gates/sheets/lib/sheetlib.mjs` states the grammar so it is falsifiable rather than borrowed
— canonical line direction + signed perpendicular offset group the segments; spans that touch or come
within `GAP` along one line are one run; the width is the union span's length — and re-implements it
from the wall geometry. This is the same construction SG4's room-name grammar already uses
(`displayNameByZoneId`, "re-derived here from CORE STATE, never imported from the drawing layer").

The three tolerances (`ANG_TOL`, `OFF_TOL`, `GAP`) are read out of `sheetSet.ts` **by name** with
`sourceNumber`, exactly as SG1 already reads `MARGIN`, `PANEL_W` and `bandStrokePt`: the drafting
policy is a spec the gate can cite. What the gate refuses to consume is the producer's *answer* — the
run list. Geometry cannot lose a run when a downstream list drops one.

**1.5e** then matches the delivered `Window` rows against those runs **by printed width** — the one
property of a run a schedule row actually prints (`38.80 × 1.50 m`, read as the first `d.dd` word in
the SIZE column, `x + 118`, between the TYPE and MATERIAL cells). Matching is a multiset with a
0.006 m tolerance (half the printed 2-dp step), so the assertion is independent of tag order and of
which sheet a row landed on; ordering is used for **naming only**. A `Window` row that prints a tag
and a type but no size cell raises a `GateError` — a missing input is a failure, never a skip.

Verified equal on the honest set before anything else:

```
seeded  runs 24  0.15 ×10 · 0.65 ×2 · 1.85 · 2.15 ×2 · 2.75 · 3.85 ×4 · 22.80 ×2 · 38.80 ×2
        rows 24  identical multiset          Σ 150.30 m core  vs  150.30 m scheduled
testfit runs 30 / rows 30                    Σ 158.60 m       vs  158.60 m
dwg     runs 33 / rows 33                    Σ 147.18 m       vs  147.17 m (2-dp row rounding)
```

### 1.3 Falsification A — the Judge's own sabotage, old gate reproduced first

Scratch tree (`rsync` copy, `web/node_modules` symlinked; **the repo was never sabotaged**). The
Judge's line, at `web/src/export/sheetSet.ts:249`, one glazed run dropped upstream of tags and rows:

```js
const windows = mergeGlazedRuns(state.walls).sort((a, b) => a.y - b.y || a.x - b.x)
  .filter((_, i) => i !== 3)     // JUDGE SABOTAGE: one glazed run silently dropped
```

The **old** gate first, to confirm I am measuring the same thing (a copy of SG1 with the 1.5e block
removed, run against the sabotaged render):

```
$ node scripts/sheets/render-all.mjs --pack seeded          → sheet harness OK — 1 pack(s) × 12 sheets
--- OLD GATE (pre-S8) ---
SG1 PASS (71 checks)
SG2 PASS (8 checks)
SG3 PASS (97 checks)
```

**71 / 8 / 97 — the Judge's three numbers, exactly.** The artifact really has lost the window:

```
$ pdftotext -f 4 -l 4 out/sheets/seeded/drawing-set.pdf - | grep -oE '\bW[0-9]+\b' | sort -uV
  sabotaged: W1 … W23            $ … | grep CONTINUED → SCHEDULE CONTINUED ON A.10 (9 MORE)
  shipped  : W1 … W24                                   SCHEDULE CONTINUED ON A.10 (10 MORE)
```

The **new** gate, same render:

```
--- NEW GATE (S8) ---
  FAIL seeded one schedule row per glazed run in core state — 1 of 24 glazed run(s) in core state
       have NO Window row: W4 0.65 m at (37.68, 2.45) (core-state runs 24, Window rows 23,
       total glazed 150.30 m vs 149.65 m scheduled)
SG1 FAIL (72 checks, 1 failing)
```

It names the missing opening — by tag, by width, and by where in the building the glass is.

### 1.4 Falsification B — the drop moved *inside* the merge

A gate that merely watched the producer's run list could be satisfied by catching a `.filter(...)`
one line downstream. So: second scratch tree, one glazed segment dropped **inside**
`mergeGlazedRuns` itself, before any run exists:

```js
let seen = 0
for (const w of walls) {
  if (w.glazing !== true) continue
  if (++seen === 7) continue   // JUDGE SABOTAGE 2: one glazed segment lost INSIDE the merge
```

```
$ node scripts/gates/sheets/sg1-panel-containment.mjs --pack seeded
  FAIL seeded one schedule row per glazed run in core state — 1 of 24 glazed run(s) in core state
       have NO Window row: W14 3.85 m at (27.83, 4.05) (core-state runs 24, Window rows 23,
       total glazed 150.30 m vs 146.45 m scheduled)
SG1 FAIL (72 checks, 1 failing)
$ node scripts/gates/sheets/sg2-plate-confinement.mjs --pack seeded   SG2 PASS (8 checks)
$ node scripts/gates/sheets/sg3-label-integrity.mjs   --pack seeded   SG3 PASS (97 checks)
```

Caught, with a different tag and a different length — the anchor reaches the geometry, not the list.

### 1.5 And the honest artifact still passes

`SG1 PASS (216 checks)` on all three packs, twice (before and after the D-R render), plus
`SG6 PASS (16 checks)` — the determinism/independence gate — and 11/11 on the repo board. 1.5e adds
no red anywhere on a correct set.

---

## 2. D-R — two glyphs on one point

### 2.1 What was wrong

S6 reduced `clearOfLabels` to the shared strict placer but handed it a **copy** of `occ`,
deliberately: a fixture must not reserve against its neighbours, because the ceiling grid is regular
by intent and glyph-on-glyph is not a defect. S6 §9.4 called the consequence latent: *"Measured on
all three packs it does not happen."* It does — once, and §4's "0 overlapping pairs" was one short.

The rule S6 stated is right for a **line figure** and wrong for a **word**. Two troffers on one spot
are two rectangles and a reader sees two fixtures; two exit tiles on one spot are one amber square
with an unreadable letter on it, and a luminaire has vanished from the drawing. Exactly two services
glyphs carry a glyph run rather than a shape: the exit luminaire's `E` and the distribution board's
`DB`, both reversed out of an opaque amber tile.

### 2.2 The fix — a seat, and the third rung of the ladder that already exists

`web/src/export/servicesSheets.ts`. **No fourth placement system**; `clearOfLabels` still calls the
shared `tryPlaceNear` (the same 13 candidates + `extendedCandidates`' 20 wider rings every room label
and opening tag walks), and the shared `placeNear` / `labelLeader`:

* `glyphCarriesType(t)` — `'exit' | 'db'` — is the one new predicate, and it is the whole defect: a
  glyph that carries a WORD is annotation, so it **reserves in the sheet's one occupancy**; a line
  figure still gets a copy and reserves nothing.
* When the strict placer finds nowhere clear, a word-carrying tile takes the **third rung of A.02's
  own tag ladder**, `placeNear` — the least-overlapping spot inside the plate, which always places
  and always reserves. Staying put is not open to it: "nowhere clear" is precisely the case that put
  two on one point, and the true spot is the one square already known to be taken. (Reserving without
  this rung was measured and rejected mid-fix: it traded the `E`↔`E` pair for `E`↔`BOOTH` at 20 % and
  `E`↔`LC-03` at 17 %.)
* A tile that ends up away from its fixture draws a `labelLeader` back to it — the same disclosure
  S6 gave the circuit tags. Leaders are stroked before the ink passes, so no leader can erase
  anything.

### 2.3 Measured: the pair, before and after

`scratchpad/pairs.mjs` — poppler word boxes inside the plate, overlap as a fraction of the smaller
box, same-baseline words excluded (one drawn run); plus the centre-to-centre distance of the closest
`E`↔`E` pair on each A.03.

```
BEFORE                                          AFTER
seeded   A03  pairs >0%: 1                      seeded   A03  pairs >0%: 0
   39% "E"@(459,305) ↔ "E"@(461,306)
seeded/testfit/dwg × A02/A03/A04: 1 pair total  … all nine combinations: 0 pairs total

closest exit-"E" pair, centre to centre
   seeded   2.91 pt   (next 20.53)              seeded   20.53 pt  (next 36.90)
   testfit 13.69 pt                             testfit 13.69 pt   (unchanged)
   dwg      9.01 pt   (next 16.71)              dwg      16.71 pt  (next 23.74)
```

**2.91 pt → 20.53 pt on seeded**, and dwg's second-worst pair (9.01 pt — two tiles 10 pt wide, i.e.
overlapping tiles whose word boxes happened not to) opens to 16.71 pt as well. Zero overlapping
delivered-word pairs on all nine plan sheet × pack combinations.

Viewed, not just measured — `out/sheets/seeded/A03.png`, px (860,510)–(1080,660), the exact knot the
Judge cited: **before**, one amber tile sitting on another with a single readable `E`; **after**, two
separate tiles, both `E`s legible, the displaced one carrying its leader stub back to its fixture.
The dwg pair at (553,259)/(573,286) was viewed the same way.

### 2.4 Blast radius: exactly two words moved in the entire 36-sheet set

Every delivered word in all three packs, before vs after (a pre-D-R reconstruction rendered in a
scratch tree, `scratchpad/worddiff.mjs`):

```
seeded : 2341 words after, 2341 before · moved: 1 · gone: 1
   after : p5 E 481.71,266.44        before: p5 E 458.71,305.44
testfit: 2441 words after, 2441 before · moved: 0 · gone: 0
dwg    : 2416 words after, 2416 before · moved: 1 · gone: 1
   after : p5 E 570.83,289.31        before: p5 E 559.33,263.31
```

**Two `E` glyphs on page 5 (A.03). Nothing else in the set moved** — not a room name, not an area
string, not a dimension, not a tag, on any sheet of any pack. A.04 is untouched (`db` reserves, but
there is nothing for it to collide with in-family, and no word moved on p6).

The only other delta is the new leader strokes on A.03: **+3 seeded, +2 testfit, +9 dwg**, `-0`
everywhere. Those disclose displacements that were *already happening silently* before this change
(testfit's two exits did not move at all — they were already off their fixtures and now say so).

---

## 3. Left untouched, deliberately — the ROADMAPed pre-existing defects

The word-for-word diff in §2.4 is the proof, not a claim:

| defect | status | evidence it was not touched |
| --- | --- | --- |
| **D-P** — 107 room-name / area / dimension strings over wall + door-swing ink | **left as-is** | not one of those strings moved: 0 word-position changes on A.01/A.02/A.04 in any pack, and on A.03 only the two `E`s. `sheetSet.ts:1021` unchanged; `planGraphic.ts` not opened |
| **D-Q** — 14 strings outside the building footprint | **left as-is** | same measurement; same file untouched |
| dwg A.01 labels over demolition hatch | **left as-is** | A.01 not touched by either fix |
| dwg A.03 ceiling grid not clipped to the polygon (D-S) | **left as-is** | `ceilingLayout` not opened; the grid ops are byte-identical (`-0` removed line ops) |
| A.08 blank · A.07 placeholder thumbnails (D-U) | **left as-is** | `moodboardSheet` / `furnitureSheet` not opened |

Out-of-lane files were not opened at all: `scripts/fixtures/**`, `crates/**`,
`web/src/export/planGraphic.ts`. No `git stash / reset / checkout / clean / commit` was run; both
sabotages lived in `rsync` copies under the session scratchpad and the repository was never sabotaged
(`grep -rn SABOTAGE web/src scripts` → nothing).

---

## 4. Files changed

* **`scripts/gates/sheets/lib/sheetlib.mjs`** — `glazedRuns(state)`: the window-run grammar, stated
  and re-derived from core state, tolerances read from source by name.
* **`scripts/gates/sheets/sg1-panel-containment.mjs`** — 1.5e (+1 check per pack, 213 → 216);
  `scheduleRowsOn` now also reads the SIZE cell and fails loudly when a row has none; header
  amended with the D-O amendment and both falsifications.
* **`web/src/export/servicesSheets.ts`** — `glyphCarriesType`; `clearOfLabels` takes `reserve` and
  finishes on `placeNear`; both fixture loops pass it and draw a `labelLeader` for a displaced
  word-carrying tile.

Nothing was superseded and left behind: `clearOfLabels` has exactly two call sites, both updated, and
no other placement helper was added or orphaned.

## 5. Residue I am not closing

* **1.5e reads the merge policy, not the merge.** If `GAP` / `ANG_TOL` / `OFF_TOL` were themselves
  changed to something absurd, the gate would follow the published policy and agree with the producer
  about the resulting run set. That is a policy change, not a lost opening, and it is visible in a
  source diff; the class 1.5e exists for — glass in the building that appears nowhere in the
  deliverable — cannot survive it, as §1.4 shows.
* **1.5e matches width, not position.** A schedule that swapped two rows' *positions* while keeping
  every width would pass. Position is not printed on a schedule row, so closing that would need the
  plan tag's own plate coordinate re-projected to world — a bigger instrument than this defect
  justifies, and 1.5a/b already tie every row to a tag that is drawn at the opening.
* **`clearOfLabels`' probe is still `s × s` square** while the `DB` tile is `2.4s × 2s`, so a
  distribution board can overhang its reserved box by `0.2s` a side. Pre-existing, unmeasured on
  A.04 today (0 overlapping word pairs), and untouched here.
