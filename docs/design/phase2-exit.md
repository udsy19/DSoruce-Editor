# Phase 2 exit — export merged into integration/all

Self-ratified per the campaign's autonomy clause. Every number names what it
counts and the worktree that produced it: `/Users/udsy/PycharmProjects/DSource-Editor`,
branch `integration/all`.

## Position

`integration/all` carries main + ui-fixes + export. Tree clean, all boards green.

| predicate | check | value |
|---|---|---|
| branch | `git rev-parse --abbrev-ref HEAD` | `integration/all` |
| ui-fixes merged | `git merge-base --is-ancestor ui-fixes HEAD` | yes |
| export merged | `git merge-base --is-ancestor export HEAD` | yes |
| working tree | `git status --porcelain \| wc -l` | 0 |
| Rust | `cargo test -p ds-core` | **157 passed, 157 BY NAME** |

## Boards

`bash scripts/gates/run-all.sh` is the only trusted signal, and it must be given
`GATE_BASE` pointing at a server for THIS tree — `:5173` and `:5199` are held by
the `export` and `ui-fixes` worktrees, and the pre-flight rejects both.

| | |
|---|---|
| G1–G12 | **12/12 PASS, 1034 checks** (G12 = SG1–SG6, 603) |
| Rust | 157 by name |
| style-gate · ladder-check · lod-sweep · export-parity · accent-univalence | PASS |
| symbols (46) · fonts · drawing-set (322) | PASS |
| typecheck | clean |

## What Phase 2 closed

### SG2 — the sensor was measuring linework, not tags

Three theories died first: A02 is still page 4 and still the Construction &
Furnishing Plan in all three packs (manifest intact), and the producer has
exactly two `drawTagGlyph` call sites, so nothing draws a small tag in the plate.

The two "escaping tags" were **false positives**: dense INK-coloured linework
where an 8 pt ring's sample points each find a mask pixel within ±1 px by
coincidence, scoring 0.875 and 0.906 against a 0.85 floor.

`drawTagGlyph` opens by knocking a pure-white box out of the drawing, so sitting
on a knockout is a construction property of every real tag — the third fact the
detector was not using. Over all 195 real tags across three packs the backdrop
runs 0.593–0.751; both false positives measure **exactly 0.000**. The cut sits at
0.25, an order of magnitude clear of both sides.

Specificity ADDITION, never a relaxation: it can only reject detections, and real
counts are unchanged (44/48/41 plan, 31 schedule per pack). Proven live —
disarming reproduces the original failure verbatim; rearming gives 24/24, with
the check count 24 in **both** states.

### E7 on the sheet path — and the two corrections the gates forced

Seeding furniture into `occ` was only the first third of the fix.

1. Seeding alone made SG3 red with **4 overlapping label pairs**: with desks
   blocking, strict placement failed in the band of eleven 1.0 m² slivers and
   dropped to the narrow always-yields placer. Occupancy is not one kind of
   thing, so `OccBox` gained a `weight` and furniture became SOFT.
2. That left one label unrecoverable, and re-recording the baseline exposed what
   the digests had hidden: four seeded-A.02 names (COLLAB, STORAGE, PRINT POINT 1,
   CABIN 3) drawn **0×**. The abbreviation was happening in the STRICT rung.

The ladder is now ordered by what survives: full name clear > full name over
furniture (wide, leader-backed) > abbreviated form clear > narrow fallback. Rung 2
above rung 3 is the point — a name over a desk can be read; a name that was never
written cannot.

`componentBox` moved from `planGraphic` into `sheetSet` (which owns `OccBox` and
the de-collision helpers) rather than being copied — the reverse import is a cycle.

### pdf.ts split under R1, with the anchors moved

1084 lines held three layers. Now `pdfDoc.ts` (palette-free byte writer),
`printPlan.ts` (owns `PRINT_ZONE_FILL` + PRINT inks), `pdf.ts` (A3 chrome + the
two actions). Strict DAG, no cycle, no barrel re-exports — all 8 consumers import
from the layer that owns each symbol.

The first cut was wrong and the compiler said so: seven sheet-chrome helpers sit
BETWEEN the two exported raster functions, so a single three-way line split filed
them with the raster. `printPlan` is assembled from three non-contiguous ranges.

**Anchors, and the proof.** style-gate's guard follows the PALETTE, not the
filename, and all three files stay guarded. export-parity needed TWO anchors, not
one moved: the palette assertions follow `PRINT_ZONE_FILL` into `printPlan.ts`
while the ZONE KEY assertions stay on `pdf.ts`.

Falsified in a disposable worktree. With `printPlan.ts` guarded, a planted
non-zone hex gives **exit 1**; with the guard removed and the same violation
present, **exit 0** — vacuous. Moving it was load-bearing.

Two findings from the same exercise, recorded because they contradict what I
first assumed: export-parity pointed at the old path fails **loudly** (the
constructs are not there) rather than silently, and style-gate's PALETTE COPY
scan is not path-scoped at all, so it catches zone values wherever they appear.

### quantity.rs on the DWG plate — coherent

Floor area 930.1 m², wall height 2.6 m.

| | |
|---|---|
| glazed bands | 21 segments, 160.73 m |
| solid perimeter | 55 segments, 38.35 m |
| piers implied by the bands | 21 × 2 × 0.6 = 25.20 m |
| wholly-solid runs | 13.15 m across 13 segments, **mean 1.01 m** |

Every wholly-solid run is below `MIN_GLAZED_RUN` = 1.7 m — exactly what
`glaze_facade` leaves alone. Facade 199.07 m (80.7 % glazed); partitions
(Drywall + Glass = 99.10 m) untouched by glazing.

The apparent 45.15 m divergence between `quantities()` and `wall_types()` is not
one: `quantities()` adds `keepout_perimeter` for keepouts carrying no wall, and
`wall_types()` maps only over `doc.walls`. Different populations, by design.

### Seats/QTO — one non-defect, one live defect

**Non-defect.** A meeting table carries `seats = 10` while 8 chairs are placed.
`Table.seats` is capacity intent; the billable truth is the chair components, and
`quantity::headcount` follows THEM — which is what the ratified invariant asserts
(`headcount == chairs`, `chairs >= 4`). Verified on all four 20 m² rooms: capacity
8, headcount 8, chairs 8.

**Live defect, found by this cross-check and not by any gate.** `paint.ts` drew
every component as its own glyph AND passed the shared symbol module its default
`implySeats: true`. Each desk drew its real chair plus a second implied one; each
10-seat table drew a full implied ring over the 8 chairs that exist. Every other
consumer already set `implySeats: false`. Same ruling (R6), same shape: fix the
CONSUMER. `symbols.test.mjs` still pins that the glyph reads its seat count from
the MODEL (46 assertions, unchanged).

### G11 falsification — run, with a recorded result

Flipping `implySeats` in `printPlan.ts` (NOT `planGraphic.ts`, whose flag governs
a different draw call — the first attempt flipped the wrong one and byte-identical
statistics were the signal):

| | min | p25 | median |
|---|---|---|---|
| shipped (`implySeats: false`) | 1.52 | 1.94 | 2.18 |
| implied seating ON | 1.52 | 2.18 | 2.31 |

The borrowing effect is real and measurable, but **no billed instance depends on
it**: with that ink gone the worst instance still scores 1.52 against a 0.70
floor. The attribution weakness itself survives, unchanged, and is recorded as
such in `.claude/rules/gate-independence.md`.

### Fonts guard — it was the guard that was wrong

Every dev page load logged `[fonts] "Schibsted Grotesk" is imported but did not
load`. `check('12px "X"')` implies weight 400, and the imports deliberately load
only the weights the app sets — Schibsted is display-only, at 500 and 700. The
family registers 500/500/700/700 and `check('700 32px …')` is true.

Phase 1 recorded this as "timing-sensitive, out of ruled scope". That diagnosis
was **wrong** — the guard already awaits `document.fonts.ready`. Two of three
families happen to ship a 400 and passed by luck.

The guard now reads the registered weights back off the document (a second
hardcoded list would drift from the imports) and keeps both failure modes
distinct. Proven both ways in the live page.

## End-to-end, in the browser, on this tree

Server on a dedicated port, pre-flight clear (`verify-preflight.sh 5311
implySeats src/editor/paint.ts` — note Vite's root IS `web/`, so the module path
is `src/…`, not `web/src/…`).

| step | result |
|---|---|
| landing → wizard (4 steps) | renders, validates, advances |
| DXF import | plate traced, area + room detected |
| **Deliverable pack (one action)** | **Pack ready — 33 artifacts, walkthrough 52.5 MB** |
| `/share/<id>` 3D viewer | loads; glazed-facade mullions visible |
| draw walls → Generate test-fit | 18 workstations, 85 % efficiency, 141 m² NIA, 53 items |
| canvas seating | **exactly one chair per desk** (zoomed) |
| 2D ↔ 3D | 3D renders desks + one chair each |
| console | no errors after the fonts fix |

## Deviations taken, with reasons

1. **The drawing-set baseline was re-recorded once**, after looking at the sheets
   and after E7 landed, per the test's own instruction. All 8 changed digests are
   deliberate; **zero non-digest failures** remained at the time of recording. The
   baseline came from `export` (f95c9b0 is an ancestor of export only), which is
   why `seeded` passed while `dwg` moved — the irregular plate is where main's
   conformed rooms meet export's seating, a combination neither parent rendered.
2. **`paint.ts` was fixed under R6 although R6 named only the print path.** The
   ruling's reasoning applies verbatim once real chairs exist, and the canvas is
   the most visible instance. Logged rather than escalated.
3. **The sheet gates' `PAGE_W`/`PAGE_H` anchor was missed in the split commit**
   and fixed in the next one. It failed loudly (`sourceNumber` treats a missing
   declaration as an error, never a skip), which is the difference between a gate
   that re-derives its spec and one that assumes it.

## Not done at Phase 2 exit

- **pixdiff vs both parents' references.** Still not run — carried from Phase 1.
  Honest debt, not a pass.
- **G11's attribution weakness** — measured, quantified above, deliberately left
  open, exactly as the rule's scope section allows.
- **dwg A.02 carries four 0.15 m windows.** Imported/conformed geometry, not from
  `glaze_facade` (minimum band 0.5 m). Pre-existing, not merge-introduced.
- **Parts C and D**: whole-system twice-green, adversarial round, landing on main
  as a merge commit, ancestry-proven branch deletion, ROADMAP, the four new faces,
  `merge-final-report.md`.
- **The 13-step manual walkthrough** (`docs/design/manual-session.md`) — a human
  task on main after landing. No agent substitution is valid.
