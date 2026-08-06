# G-1 — Parity Judge: adversarial defect report

**Agent G. Read-only.** No product file was modified. Every number below is from output I ran or
looked at myself; nothing is taken from another agent's report.

## How I ran it

The vite server occupying :5173 (pid 29121, started **15:25**) predated the `vite.config.ts` change
committed in `7560896` at **15:41** — exactly the phantom-failure trap in the brief. I killed it and
started a fresh one before touching a gate.

```
VERBOSE=1 bash scripts/gates/run-all.sh
  G1 PASS (59) · G2 PASS (17) · G3 PASS (92) · G4 PASS (14) · G5 PASS (70)
  G6 PASS (16) · G7 PASS (19) · G8 PASS  (9) · G9 PASS (21) · G10 PASS (4)
  10/10 passing — ALL GATES GREEN.
```

**The board reproduces.** It is also, in two specific ways, not measuring the artifacts it claims to.

---

# Defects, ranked

## BLOCKER

### D1 — G6's only render↔takeoff check is switched off *by the artifact under test*
**Gate: G6 (passing).** **File: `scripts/gates/g6-renders.py:92-94`** (+ the producer that writes
`ground-truth.json.renders[]`).

G6's sole assertion tying a render to the model is a floor-hue sample. It is guarded by:

```python
fm = e.get("floorMaterial")
if not fm:
    g.note(f"render '{name}': no floorMaterial in ground truth, hue check skipped")
    continue
```

The producer decides whether that key exists. For Reception it omitted it — `out/renders/manifest.json`
records why: `"floorCheck": "no-clean-floor"`, `"floorRectPurity": 0.0595`. The renderer could not find a
clean floor patch, so it dropped the field, so the gate skipped the test. **The thing being tested
controls whether it gets tested.**

Falsification (built in scratch, repo untouched) — I painted the bottom 45% of all four renders lurid
magenta `rgb(190,40,150)` and removed `floorMaterial`:

```
$ python3 scripts/gates/g6-renders.py --renders <fake> --ground-truth <fake>
  note[G6] render 'Reception': no floorMaterial in ground truth, hue check skipped
  note[G6] render 'Open_space': ... skipped
  note[G6] render 'Work_stations': ... skipped
  note[G6] render 'Conference_room': ... skipped
G6 PASS  (13 checks)
```

**Expected:** four failures. **Actual:** PASS.

Worse, the check is not wired to our own data even when it *does* run. `ground-truth.renders[].floorMaterial`
says `"Carpet Light Gray"` / `"Parquet Herringbone - dark"` — **qbiq's** material vocabulary. Our own
`ground-truth.rooms[].floorMaterial` for those same rooms says `"Carpet tile 500×500 (CPT)"` and
`"Porcelain stone, LF (POR)"`. G6 resolves the former through a hand-written `MATERIAL_KEY` table. So the
"render↔QTO agreement the mission rests on" (ORCHESTRATOR_LOG.md:181) is **not enforced by any gate** —
it is asserted against a parallel, hand-maintained string set.

---

### D2 — `run-all.sh` never validates the artifacts G10 produces; G10 passes on a half-written video
**Gates: G7 + G10 (both passing).** **Files: `scripts/gates/run-all.sh:16`,
`scripts/gates/g10-one-action.mjs:86-91` and `:112`.**

`IDS=(G1 G2 … G10)`. G10 runs **last**, and G10 drives the app to *regenerate the whole pack into `out/`*.
So G1–G9 grade the **previous** run's files, then G10 overwrites them and nobody looks again.

Measured directly (`bash scripts/gates/run-all.sh G10`):

| file | before | after |
| --- | --- | --- |
| `out/walkthrough.mp4` | 25,704,418 B @ 15:46:17 | **14,155,824 B @ 15:57:22** |
| `out/quantity-takeoff.xlsx` | 483,040 B @ 15:44:16 | 483,040 B @ 15:56:25 |
| `out/renders/Reception.png` | 5,439,976 B @ 15:45:42 | 5,439,976 B @ 15:57:23 |

At the instant G10 printed `PASS`, `ffprobe out/walkthrough.mp4` returned **`moov atom not found —
Invalid data found when processing input`**. I then held the file under observation:

```
t+10s size=18350128  ffprobe=moov atom not found
t+20s size=22020144  ffprobe=moov atom not found
t+30s size=24117296  ffprobe=moov atom not found
t+40s size=25732241  ffprobe=43.000000   <- write finally completes
```

**To be fair to the build: the video is not corrupt.** It settles to a valid 43.00 s / 1290-frame file.
That is exactly the point — **G10 declared the deliverable pack complete ~36 seconds before the video
finished being written**, and no gate ever decoded the file it left behind.

Root cause is the readiness test at `g10-one-action.mjs:86-91`, which waits only for *mtime to advance*:

```js
pending = expected.filter(([, p]) => !present(p) || fs.statSync(p).mtimeMs <= before.get(p))
```

For a file ffmpeg is streaming, mtime advances on the **first** byte. G10's only content assertion is
`size > 100 * 1024` (`:112`) — which a truncated, un-decodable mp4 passes trivially.

This is the live form of INCIDENT 2 in the log ("G7 MUST be re-run on the final artifact"). It is not a
one-off collision; it is structural in the runner's ordering.

---

## MAJOR

### D3 — The four renders are the weakest deliverable by a wide margin, and no gate measures it
**Gate: none.** G6 checks only resolution, mean-luminance band, a stddev floor, and the (skippable) hue
sample. There is **no composition, detail, or content assertion at all.**

Measured on 960 px downsamples — `flat%` = share of 16×16 tiles with luminance σ < 0.01, `edge%` =
share of pixels with gradient magnitude > 0.02:

| render | flat% ours | flat% ref | edge% ours | edge% ref | distinct colours ours | ref |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Reception | **48.8** | 21.0 | **10.1** | 32.8 | **674** | 2133 |
| Open_space | **66.6** | 25.2 | **12.0** | 34.4 | **828** | 2783 |
| Work_stations | **41.5** | 19.0 | **14.6** | 39.3 | **842** | 3109 |
| Conference_room | **66.6** | 21.5 | **8.4** | 36.8 | **460** | 2731 |

Ours are uniformly **2–3× flatter, ~⅓ the edge density, and ~¼ the colour variety.** Looking at them:

- **Conference_room** — the log calls it "the weakest still"; that understates it. It is **an empty room**:
  a bare table edge in the bottom-left corner, blank white wall filling the majority of frame, a door and
  a screen at right. **No chairs. No occupants. No view.** 66.6% of the frame carries no detail.
- **Reception** — a glass box with a sage wall, one small desk, two ring pendants. No reception desk, no
  lounge seating, no plants. The reference is a fully furnished lobby.
- **Open_space** — competent desking, but ~45% of frame is featureless grey floor and flat grey ceiling.
- **Work_stations** — the best of the four; genuinely reads as an office.

### D4 — The workbook contradicts its own room images: chairs are drawn but not billed
**Gate: none** (G5 checks thumbnails exist, are in column B, are ~240×180 and are distinct — never what
they depict).

I extracted all 22 Inventory thumbnails and put each next to its own Inventory row. The images are
**correct and legible** (see strengths) — but they disagree with the sheet they are embedded in:

| Room | thumbnail draws | `Furniture Elements` bills | `Headcount` |
| --- | --- | --- | ---: |
| 39/47/55/63 Meeting Room 1–4 | table + **~8 chairs** each | `Table W190 X L290: 1` — **no chairs** | **0** |
| 74 Collab | table + **~8 chairs** | `Table W120 X L240: 1` — **no chairs** | **0** |
| 105/107 Print Point 1–2 | table + **~4 chairs** each | `Table W60 X L60: 1` | 0 |
| 30 Reception | table + **~6 chairs** | `Chair…: 1, Table…: 1` | 1 |

Roughly **50+ chairs are drawn in the workbook's own images and billed nowhere in it.** The reference has
no such gap — its `conference_l` thumbnail draws 10 chairs and its Inventory bills
`Conference Chairs W58 X L55: 10`.

The log (ORCHESTRATOR_LOG.md:182-184) records the decision not to emit conference seating as a clean
trade-off. It is not clean: the contradiction is *inside a single deliverable*, visible on one screen.

### D5 — `Perimeter windows` = 0.00 m — confirmed, and the plan graphic disagrees with the takeoff
**Gate: none.** **CONFIRMS log open-defect #1, but the log's description is incomplete.**

`General!L13` = 0, so `BOM - Walls` F8 and `Main Summary` F25 both recalculate to **0.00 m**. Reference
`General!L11` = **125.47 m**. Facade instead bills entirely as `Perimeter wall` = 128.00 m (reference:
6.01 m). Confirmed on the live recalculated workbook.

The log says "no plate wall sets `glazing: true`, so facade runs correctly bill as `Perimeter wall`."
But `out/plan.png` **does** contain the perimeter-window colour: **2,406 px of `#DCDBEE`**
(`palette.json.plan.perimeter_windows`), traced as a 1-px hairline along the left (x≈50, 578 px), right
(x≈980, 578 px) and bottom (y≈670, 938 px) facades. So the plan renderer emits perimeter windows while
the classifier bills zero metres of them — plan and takeoff contradict each other.

Ratio, for the side-by-side reviewer: reference facade reads **glazed** (5,999 px windows : 236 px wall,
25:1). Ours reads **solid** (2,406 px hairline : 12,064 px wall, 1:5).

**G4 never checks this.** Its only renderer-colour assertions are `n_dry > 0` and `n_glass > 0`
(`g4-plan-graphic.py:107-110`). **Five of the seven legend colours** — Half Drywall, Core, Perimeter
windows, Perimeter wall, Door swing — have **no pixel assertion at all**, so Ruling #1's requirement
("legend == renderer, no drift") is enforced for 2 of 7 types.

### D6 — G3 is named "Quantity truth" but only proves the workbook agrees with its own producer
**Gate: G3 (passing, 92 checks).** **File: `scripts/gates/g3-quantity-truth.py:51-160`.**

Every G3 assertion compares the workbook against `out/ground-truth.json`. Per the orchestrator's own
ruling (ORCHESTRATOR_LOG.md:174-178), Inventory rows, ground-truth rooms and plan labels all descend from
**one `planRoomList` call**. The ruling frames passing "by construction" as a virtue over passing "by
coincidence" — but the consequence is that **G3 cannot detect a wrong quantity, only an inconsistent one.**

D5 is the proof: `Perimeter windows = 0.00 m` sails through G3 with 92 green checks, because
ground-truth also says 0. Nothing in the suite compares a quantity to geometry.

### D7 — The walkthrough ends on ~10 seconds of near-blank white room
**Gate: G7 (passing).** Same failure class E2 fixed at t=30/31, now relocated to the tail.

Dense sample of the settled 43 s file (`flat%` as in D3):

| t (s) | 0.2 | 5 | 13 | 21 | **25** | 29 | 33 | 37 | 41 | 42.5 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| mean L | .547 | .669 | .650 | .665 | **.609** | .626 | .764 | .789 | .798 | **.815** |
| flat% | 81.0 | 36.0 | 35.2 | 26.9 | **19.4** | 21.9 | 46.9 | 51.2 | 51.9 | **54.6** |

The middle of the take (t≈13–29) is genuinely good — 19–35% flat, dense desking, in-scene DSOURCE
branding on a wall display at t=17. Then it **monotonically degrades**: from t=33 to the end, luminance
climbs .764 → .815 and flat% climbs 47 → 55%. The last frames are a bare white meeting room with a table
edge and a wall screen — the same empty-conference-room problem as D3.

G7's ceiling is 0.85 and the worst frame is 0.826, so it passes. But **the final ~23% of the deliverable
is more than half featureless**, and the closing image is the weakest in the film.

### D8 — Headcount is internally inconsistent across identical rooms
**Gate: none.** **Extends log open-defect #2 (which records only "meeting rooms report headcount 0").**

From `out/quantity-takeoff.xlsx` `Inventory`:

| Room ID | Name | Furniture | Headcount |
| ---: | --- | --- | ---: |
| 71 | Cabin 1 | `Chair W50 X L50: 1, Table W60 X L120: 1` | **1** |
| 139 | Cabin 2 | `Chair W50 X L50: 1, Table W60 X L120: 1` | **0** |
| 148 | Cabin 3 | `Chair W50 X L50: 1, Table W60 X L120: 1` | **0** |
| 115/123/131 | Phone Booth 1–3 | `Chair W50 X L50: 1` | **0** |
| 12/21 | Focus Room 1–2 | `Chair W50 X L50: 1, Table W60 X L120: 1` | **1** |

Three rooms with byte-identical furniture strings report headcounts of 1, 0 and 0. Whole-plan headcount
totals **67** (63 of them the open workspace) against the reference's ~155. This is not only "meeting
rooms are 0" — the rule itself is non-deterministic across identical inputs.

---

## MINOR

### D9 — Video is half the reference's frame rate and 1/7th its bitrate; G7 checks neither
**Gate: G7 (passing).** `g7-video.py:76` asserts `fps >= tgt["minFps"]` — a floor, not a match — and there
is **no bitrate assertion anywhere**.

| | ours | reference |
| --- | --- | --- |
| fps | **30** | **60** |
| bitrate | **4.78 Mb/s** | **33.1 Mb/s** |
| duration / frames | 43.00 s / 1290 | 37.00 s / 2220 |

A 60 fps reference walkthrough at 33 Mb/s versus 30 fps at 4.8 Mb/s is a visible smoothness and
compression-artefact gap that the gate is structurally unable to see.

### D10 — G4's plate normalisation is defeated by an opaque background; the reported circulation % is wrong
**Gate: G4 (passing).** Ruling #4 ("normalise against the PLATE, not the canvas") is implemented as the
**alpha** bounding box. Measured:

```
out/plan.png        canvas 1040x780   opaque 100.0%   alpha-bbox = the whole canvas
ref xl/media/1.png  canvas 1040x780   opaque  28.8%   alpha-bbox = 1008x322
```

Our plan is fully opaque, so `plate == canvas` and the ruling silently reverts to canvas-relative:

```
circulation pixels 86,233
  / canvas 1040x780   = 10.63%   <- what G4 reports ("circ=10.65%")
  / true ink bbox 950x572 = 15.87%   <- actual plate-relative
  reference plate-relative = 12.86%
```

Not a false pass (it clears the >2% floor either way), but the headline number is wrong and the ruling is
unimplemented for our own artifact.

### D11 — Plan legend chips print on a different page from their labels
**Gate: none.** In `soffice → pdf`, the `Plan` sheet legend splits: **page 2** carries the colour chips and
the merged `Wall type` header with no readable labels; **page 3** carries the labels and lengths
(`Drywall 158.70 … Door_length 15.20`) with no chips. Neither page is a usable legend on its own. Fine on
screen in Excel, broken on print — and the deliverable is a client hand-off.

### D12 — The Circulation thumbnail is near-empty
**Gate: G5 (passing).** Inventory row 26 (Room ID 0, Circulation, 63.45 m²) renders as a **near-white tile
with a few thin lines** — the only unreadable tile of the 22. The reference's equivalent (row 35) is a bold
red circulation spine on black, instantly legible. G5 only requires distinctness, so this passes.

### D13 — G1's image-size check still cannot catch the smudge class
**Gate: G1 (passing).** `g1-sheet-structure.py:71-73` asserts `max(widths) >= 1000` from openpyxl's
`image.width`, which reports the **intrinsic PNG width (1040)**. The master plan is a `twoCellAnchor` whose
rendered size derives from the column/row range, not from that number. The 19×3 px smudge was fixed in the
writer and pinned by a unit test — **but G1 itself remains blind to a recurrence.** (I confirmed by eye
that the plan currently renders full-size on PDF pages 1–2; this is a coverage gap, not a live defect.)

### D14 — The mp4 is the only non-deterministic artifact
Across two runs: `walkthrough.mp4` = 25,704,418 B then 25,732,241 B. By contrast
`quantity-takeoff.xlsx` md5 was **identical** (`d665b07bcada37d2802ea9367997eaa7`) and
`plan.png` == `plan.repeat.png` (`2b1f0cf8…`). Determinism holds everywhere except the video.

### D15 — Scale is ~⅔ of the reference throughout
22 rooms vs 31 · 24 embedded media vs 34 · 6 wall types vs 7 (`Half Drywall` = 0.00 m, matching the
reference's own unused legend row) · 17 doors vs 16. Not a defect per se — the demo plate is smaller — but
it is the first thing a side-by-side reviewer registers.

---

## COSMETIC

### D16 — Raw float noise is stored in cells
`Inventory!J5 = 4.319999999999979`, `J11 = 20.000000000000007`, `K25 = 5926.335479999999`;
`BOM - Floors!F11` recalculates to `6.00000000000001`. Number formats mask this in the rendered PDF
(`4.32`, `215.28`), so it is display-safe — but the reference stores clean 2-dp values (`12.58`, `25.53`),
and anything that reads the cells rather than the formatting will see the noise.

### D17 — The core is a featureless grey box
On `out/plan.png` the core reads as a plain grey rectangle (17,325 px) with no stairs, lifts or shafts, and
the `153` Open Workspace label is drawn over it. The reference draws a fully detailed core with stair
flights, lift cars and shafts.

---

# Corrections to the orchestrator log

The brief asked me to confirm or correct the four tracked open defects.

| Log entry | Verdict |
| --- | --- |
| **#1 Perimeter windows = 0.00 m vs 125.47 m** | **CONFIRMED**, description **incomplete** — see D5. The plan renderer *does* emit `#DCDBEE`, so this is also a plan↔takeoff contradiction, not purely an upstream generator gap. |
| **#2 Meeting rooms headcount 0** | **CONFIRMED and worse** — see D4/D8. The chairs are missing from `Furniture Elements` too, the thumbnails draw them anyway, and the headcount rule is inconsistent across identical rooms. |
| **#4 `Conference_room` is the weakest still** | **CONFIRMED and understated** — see D3. 66.6% featureless, 8.4% edge density vs the reference's 36.8%. It is not "weakest", it is an empty room. |
| **`gen_spec_md.py:198` stale narration** | **ALREADY FIXED — the log is out of date.** `scripts/gates/lib/gen_spec_md.py:197-205` now reads *"XLSX writer capabilities parity requires — ALL IMPLEMENTED … This section was originally a gap analysis"*, and the references to `sheetXml`/`takeoffToXlsx` are correct past-tense history. `grep` finds no live reference to either deleted symbol anywhere outside `workbook.ts`'s own unrelated `worksheetXml`/`sheetXmls` locals. Close this item. |

Log entry #3 (`real_building_plate_spreads_the_program` timing flake) was out of my scope; not assessed.

---

# What genuinely reaches parity

An adversarial report that cannot name real strengths is useless. These I verified independently, and
they are good:

**1. The formula wiring is real, live, and correct.** Not "formula strings present" — I converted the
workbook through LibreOffice and read the recalculated values. **300/300 body cells carry formulas
(100% density)** and every one resolves:

```
Main Summary F5  =SUMIF('Inventory'!$L$5:$L$26,$C5,'Inventory'!$J$5:$J$26)             -> 706.95
Main Summary D5  =VLOOKUP(C5,'General'!$B$9:$E$16,2,FALSE)                             -> 4323
BOM-Walls    F5  ='General'!$D$5*(VLOOKUP(C5,'General'!$J$9:$N$14,3,FALSE))            -> 412.62
General      Q9  =L11                                                                  -> 27.1
```

Cross-sheet references, VLOOKUP across five lookup tables, SUMIF over the Inventory, and the ceiling/glass
height multipliers all compute to sane values consistent with the geometry.

**2. It fixes two of the reference's own bugs rather than copying them.** Total cost is
`=IF(ISBLANK(Cn),"",Hn*IF(Gn>0,Gn,Fn))` — the reference's `Hn*Gn` yields 0 for every area row because `G`
is a blank override slot. The Circulation row is labelled `GENERAL / Circulation / Circulation` where the
reference literally stores the string `NaN` in eleven columns. `Floor Height` is 4 m; the reference says
**400**.

**3. Zero unit prices are parity, not a defect.** I expected to file this as a blocker. The reference ships
`E9=I9=N9=S9=X9=0` too — prices are a deliberate user-fill slot in both. Correctly replicated.

**4. Determinism holds where it matters.** `quantity-takeoff.xlsx` md5-identical across two full runs;
`plan.png` byte-identical to `plan.repeat.png`.

**5. The 22 thumbnails are correct, not merely distinct.** I extracted every one and paired it with its own
Inventory row. Each depicts the right room, carries the right room-ID stamp, shows the right furniture, and
is legible at 240×180 — meeting rooms show tables, phone booths show a booth chair, the pantry shows its
580 cm counter run, storage/IT show correctly empty rooms. This is the single strongest part of the pack
and G5 does not deserve the credit — the producer does.

**6. Sheet structure is exact.** 12 sheets in the reference order, gridlines off on all 12, logo on 11,
`dropdowns` bare, headers matching, Glass-Partitions row offset handled. G1's 59 checks are real.

**7. The plan graphic is clean and readable.** Room-ID labels place correctly, door swings, circulation
wash, glass vs drywall colour separation all render properly — and the 19×3 px smudge is genuinely fixed
(verified by eye at full size on PDF pages 1–2, not by trusting G1).

**8. The 3D viewer is real.** `out/g8-viewer.png` shows a WebGL axonometric with correct desking, room
volumes, perimeter mullions, branded chrome and `Frame plan` / `Walk through` controls — 1280×748, 16.91%
ink, `webgl=true`.

**9. The middle of the walkthrough is at reference quality.** t≈13–29 s holds 19–35% flat with dense
desking, correct materials, soft ceiling lighting and **in-scene** DSOURCE branding on a wall display at
t=17 — which is exactly how qbiq brands, arrived at independently.

---

# Bottom line

The workbook is the strong deliverable — structurally exact, genuinely formula-live, deterministic, with
correct room thumbnails. The renders are the weak one, and `Conference_room` and the video's final ten
seconds share one root cause: **rooms with no seating, framed head-on.** That single modelling gap (D4/D8)
is what makes D3 and D7 look like rendering problems.

Two gate defects are more serious than any artifact defect, because they mean the board cannot be trusted
to catch the next regression: **G6 lets the artifact disable its own test (D1)**, and **`run-all.sh` grades
a pack that G10 then replaces (D2)**. Both are proven above with reproducible output, not argued.

The pattern the brief predicted holds a third time. The first two blind spots (the 19×3 px smudge, the
t=30/31 luminance breach) were found by looking at output. So were D1, D2, D3, D4 and D7 — **none of which
any gate reports.**
