# G3-1 — Parity Judge, round 3 (final): adversarial defect report

**Agent G3. Read-only.** No product file, gate, doc or `git` state was modified; the only file I
wrote is this one. Everything below is output I ran or an image I opened myself. Forged artifacts
were built in a scratch directory; the repo was never touched.

---

## How I ran it

The vite server on :5173 (pid 66940) predated my session, so I killed it and started a fresh one
before touching a gate. `vite.config.ts` is unchanged in this round, so this was belt-and-braces.

```
$ pnpm --dir web dev --port 5173 --strictPort        # fresh, 18:27
$ VERBOSE=1 bash scripts/gates/run-all.sh
  G1 PASS (59) · G2 PASS (17) · G3 PASS (92) · G4 PASS (14) · G5 PASS (70)
  G6 PASS (43) · G7 PASS (19) · G8 PASS  (9) · G9 PASS (24) · G10 PASS (14)
  10/10 passing · + 12/12 G9 case files · integrity PASS (12 checks)
  ALL GATES GREEN.
```

**361 gate checks + 12 integrity = 373.** A second complete run 25 minutes later reproduced it
exactly, same counts. `ffmpeg -f null -` decoded all **2580** frames of the shipped mp4 with zero
errors. `cargo test -p ds-core` → **150 passed**; `pnpm typecheck` clean; all five TS test suites
pass. **The board reproduces and is stable.**

### Measurement methodology (stated explicitly, per the brief)

* **My ruler is an independent re-implementation, calibrated against the immutable reference
  stills.** `flat%` = share of 16×16 tiles with luminance σ < 0.01 on a 960 px-wide **BILINEAR**
  downsample; `eye%` = the same over rows 40–78 %; `edge%` = share of pixels with `np.gradient`
  magnitude > 0.02; `colours` = distinct RGB after `//8` **on the 960 px downsample**; `blown%` =
  share of pixels **> 225 on all three channels**, same downsample.
* **Control.** On the four reference stills my ruler returns `flat` **21.3 / 25.5 / 19.4 / 21.6**
  and `edge` **31.9 / 33.0 / 38.1 / 35.5** against round 2's 21.2 / 25.5 / 19.5 / 21.6 and
  31.9 / 32.9 / 38.0 / 35.4 — **±0.1 pt**. Colours reproduce round 2's reference numbers
  **exactly** (1887 / 2551 / 2807 / 2510), as does `blown%` (Conference_room 5.1 %). Round 2's
  `edge%` ran ≈1.4 pt low against round 1; mine does not, because I fixed the downsample. **Deltas
  greater than 0.5 pt between round 2 and round 3 are therefore real; anything smaller I do not
  claim.**
* **Palette pixel counts are EXACT hex equality**, reported next to a ±8 near count so the two can
  never be conflated (round 1's D5 error).
* **Every gate verdict quoted is the gate's own `rc` and stdout**, not my paraphrase.

---

# Verdict up front

**No blocker. The pack is shippable as a deliverable pack; it is NOT yet at visual parity on the
four stills and the video, and five gates still cannot see the things they are named for.**

The blocker class that survived two rounds — *the gate trusts metadata supplied by the thing it
tests* — is **genuinely closed, and I proved it rather than accepted it** (§1). Round 2's exploit is
dead; `floorRect` is provably inert. That is the first time in three rounds a blocker fix has
survived falsification.

What I found instead is **coverage debt, not a false claim**: G6 now measures the right thing but
over a small part of the frame, and it has no idea *which room* a still shows. Those are MAJOR, and
one of them is reachable by a plausible product regression. Nothing in this report says the shipped
artifacts are wrong. Several things say the board would not notice if they became wrong.

---

# Defects, ranked

## MAJOR

### F1 — G6 certifies a still from the bottom ~15 % of frame; 41 % of the frame can be the *wrong floor* and it passes
**Gate: G6 (passing, 43 checks).** **File: `scripts/gates/g6-renders.py:157-214` (`ground_regions`,
the bottom-row seeding) · `:116` (`GROUND_MIN_AREA = 0.05`).**

The new segmentation grows regions **only from the bottom row**, and only across steps ≤ `EDGE_TOL`
(9 levels/channel). That is what kills round 2's exploit — and it is also the whole of the gate's
reach. **Anything separated from the bottom strip by one hard edge is never segmented, so tiers A
(tamper) and B (wrong floor) never see it.** The only coverage assertion is `ground ≥ 5 %`.

**Falsification, on the FINAL pack, repo untouched.** I painted rows **44 %–85 %** of every frame —
**41 % of the picture**, the whole mid-ground floor plane — with the *other floor family's* palette
hex (`#5D4030` herringbone parquet over the three carpet rooms, `#988F80` carpet over parquet
Reception), leaving the bottom 15 % genuine:

```
$ python3 scripts/gates/g6-renders.py --renders <forged> --ground-truth <forged>
G6 PASS  (43 checks)
  note[G6] Reception       gate found 6.16% MATCHING (of 12.2% ground = purity 51%) ...
  note[G6] Open_space      gate found 3.16% MATCHING (of 11.7% ground = purity 27%) ...
  note[G6] Work_stations   gate found 7.94% MATCHING (of 11.4% ground = purity 69%) ...
  note[G6] Conference_room 0.00% ... NOT COUNTED
rc = 0
```

**3 of 4 "evidenced", full 43 checks, on a pack in which the dominant visible floor of every still
is the material the Inventory does *not* bill.** I rendered the forged stills and looked at them: a
solid dark-parquet slab runs edge to edge across the middle of the workstation floor. The gate's own
numbers show it *noticed* the damage — ground fell 26.9→12.2, 24.8→11.7, 27.5→11.4, 38.0→12.4, i.e.
**54–67 % of the ground plane it used to find vanished** — and then said nothing, because there is
no assertion on ground coverage beyond the 5 % floor.

Related, same root: `[G magenta only inside the declared floorRect]`, the one variant **Agent M
explicitly left open and argued was correct behaviour** (M-1 §"One variant I did NOT close"). M's
argument was that the gate "does see the damage — ground fell 32.1 → 7.4 %". **The judgement is
right in kind and wrong in scale:** seeing is not failing, and I can scale the same hole from M's
7 % strip to 41 % of frame. M's rejection of the *whole-frame* sweep was correct and well evidenced
(palette.json is qbiq's reference palette; monitors measure outside it and a gate that reds on a
monitor gets switched off). But that was not the only closure available — a **coverage** assertion
(the segmented ground must not collapse relative to what a legal camera produces) needs no palette
extension at all, and would have failed every variant above. The rejected option was the expensive
one; the cheap one was not considered.

*Grading, stated plainly:* this is **not** the round-1/round-2 class. The producer has no lever
here — I proved that in §1 — and no renderer change produces a hard-edged wrong-floor band above an
intact bottom strip. It is a measurement whose scope is much narrower than the gate's own docstring
("**every** load-bearing surface on the ground plane", `:16-19`) claims. MAJOR, not blocker.

### F2 — G6 has no idea *which room* a still shows: a byte copy of one render into another's slot passes, and raises the evidence count
**Gate: G6.** **File: `scripts/gates/g6-renders.py` (no identity assertion anywhere) · producer:
`web/src/export/roomRenders.ts:135` (`avoidEyes`).**

```
$ cp out/renders/Work_stations.png <forged>/renders/Conference_room.png
$ python3 scripts/gates/g6-renders.py --renders <forged> --ground-truth <forged>
G6 PASS  (43 checks)
  note[G6] Conference_room: room 39 ... gate found 22.52% MATCHING ... purity 82%
rc = 0
```

The `Conference_room` still is now a photograph of the open workspace, and the gate **rewards** it:
evidence goes 3/4 → 4/4, exactly the metric M proposed tightening to `--min-evidenced 4`. Any two
rooms sharing a floor family (three of our four do) are interchangeable as far as G6 is concerned.
No gate anywhere asserts the four renders are distinct — I grepped: `g6`, `g10` and `g4` are the
only scripts that touch `out/renders`, and none hashes or compares them (G5 has a distinctness check,
but only for the workbook thumbnails).

**This one is producer-reachable, which is why it outranks F1 in practice.** N-1 §3 records that
`Open_space` and `Work_stations` "converged on *literally the same camera*" once the scorer improved,
and that `RoomPackOpts.avoidEyes` (a 9 m separation rule) was added to stop it. Delete or weaken that
rule and the pack ships two identical hero stills — and the board goes *greener*, not red.

### F3 — D3 is improved on all four stills and still open: 2.0× the reference's flatness, 0.43× its edge density
**Gate: none.** N-1's numbers are honest — I reproduce them to within my stated tolerance:

| | round 1 | round 2 | **round 3** | reference (control) | ours ÷ ref |
| --- | ---: | ---: | ---: | ---: | ---: |
| Reception `flat%` | 48.8 | 57.8 | **43.7** | 21.3 | 2.05× |
| Open_space | 66.6 | 66.0 | **43.4** | 25.5 | 1.70× |
| Work_stations | 41.5 | 51.0 | **36.5** | 19.4 | 1.88× |
| Conference_room | 66.6 | 68.2 | **56.0** | 21.6 | **2.59×** |
| mean `flat%` | 55.9 | 60.7 | **44.9** | 22.0 | 2.04× |
| mean `edge%` | 11.3 | 11.4 | **14.8** | 34.6 | **0.43×** |
| mean colours@960 | — | 621 | **734** | 2439 | 0.30× |
| Conference_room `blown%` | — | 23.1 | **4.0** | 5.1 | ✔ |

**All four moved forwards, and all four are better than round 1 as well as round 2** — the bar E3/D3
set. I opened every still at full resolution. The mullion through the conference table is **gone**
and the camera is inside the room, with all eight chairs, the oak door and the bronze screen behind
the glazed front (§Round-2 verdicts). Reception's blank left band measures **51.3 % flat at mean L
0.646** against round 2's 80.8 / 0.743 on the same ruler. `Open_space` and `Work_stations` are
genuinely good pictures.

It is still open because the gap is large and structural: `Conference_room` at 6.9 % edge density is
**0.19× the reference**, and its top 45 % of frame is 68.4 % flat at mean L 0.802 — one lit
plasterboard plane. N proved by a 24-heading × 4-FOV × 3-eye-height sweep that no camera fixes it,
and I accept that proof; the remaining gap is **content** (the reference's conference room has a
credenza, a screen wall and a dressed table; ours has a table). **No gate measures any of this**,
which is the durable half of the defect.

### F4 — E6 is improved by ~1 pt and still open; G7 still cannot see any of it
**Gate: G7 (passing, 19 checks).** **File: `scripts/gates/g7-video.py` — 13 `g.check`s, none of them
a flat-fraction, blank-wall or bitrate assertion.**

Dense 25-instant sweep of the shipped 43 s take, against the ten extracted reference frames on the
same script:

| | ours | reference | ratio |
| --- | ---: | ---: | ---: |
| mean `flat%` (24 frames, title card excluded) | **46.9** | 18.1 | 2.6× |
| mean `eye%` | **37.0** | 14.0 | 2.6× |
| mean `edge%` | **12.0** | 33.6 | 0.36× |
| worst frame | **64.1 % flat / 59.9 % eye @ t = 10.2 s** | 25.0 / 24.6 | — |
| worst `blown%` | **40.4 % @ t = 22.2 s** | 3.7 | 11× |

Round 2 measured 48.1 / 38.3 on 16 instants; I measure 46.9 / 37.0 on 24. **The worst-at-eye-level
frame in the film did fall 77.5 → 59.9 %, and it is no longer the opening** — that part of N's claim
is real and I verified it frame by frame. But the head of the take is still the weakest passage
(t = 1.2–10.2 mean 52.1 % flat vs the tail's ~37 %), and I looked at t = 10.2: a 2 m corridor whose
right half is one blank painted partition. N tried the same treatment on it, measured that it made
things worse, and **reverted rather than keep it** — the right call, honestly reported.

`t = 22.2` is the frame I would not have shipped: the DSOURCE wayfinding screen at close range,
**40.4 % of pixels blown out**, half the frame a white slab. It sits at mean L 0.731 against G7's
0.85 ceiling, so the gate is structurally blind to it. This is the **fourth** time the same class of
defect has been relocated rather than removed (t=30/31 → tail → head → t=10.2/22.2), and G7 still has
no assertion that could ever catch it.

### F5 — the shipped pack evidences exactly 3 of 4 renders, with zero headroom, and N's camera is what cost the fourth
**Gate: G6.** `Conference_room` reports `0.00 % strictly inside the envelope … NOT COUNTED`.
`--min-evidenced` is 3, so the board is green **at the bar, with no margin**: if any one of the other
three lost its floor, G6 goes red.

M-1 note 1 records that the 17:30 camera evidenced **7.01 %** of real carpet in that room and that
`--min-evidenced` could then go to 4. N's later camera puts the tabletop across 37 % of the ground
plane and the figure is now 0.00 %. So the composition win in F3 was **paid for in gate coverage**:
one quarter of the mission's central render↔takeoff cross-check is not performed on the delivered
pack. Both facts are individually documented by their authors; nobody has stated the trade in one
place, so I am stating it here.

---

## MINOR

### F6 — E7 reproduces **unchanged**: the plan bills furniture it does not draw
**Gate: none.** **File: `web/src/export/planGraphic.ts:268-284`.** Nobody was assigned it. I zoomed
`out/plan.png` at 4×:

| Room | workbook bills | plan draws |
| --- | --- | --- |
| 145 / 147 Print Point 1–2 | `Table W60 X L60: 1` | **nothing but the label** — no table, no room outline visible |
| 155 / 171 Phone Booth 1 / 3 | `Chair W50 X L50: 1`, HC 1 | **nothing but the label** |
| 163 Phone Booth 2 | `Chair W50 X L50: 1`, HC 1 | chair visible — its label was displaced by collision |

Room 163 remains the tell. This is the D4 contradiction (billed but not drawn) on the deliverable's
most visible page, and it is the only *artifact-level* inconsistency I found anywhere in the pack.

### F7 — G4 is still colour-blind: I deleted every perimeter window from the plan and it passed 14/14
**Gate: G4 (passing, 14 checks).** **File: `scripts/gates/g4-plan-graphic.py:107-110`.** Falsified
again, unchanged from round 2:

```
recoloured 11,676 perimeter-window px -> perimeter wall  (in BOTH plan.png and plan.repeat.png)
$ python3 scripts/gates/g4-plan-graphic.py --plan <forged> --plan2 <forged>
G4 PASS  (14 checks)
```

Five of seven legend colours still carry no pixel assertion. Ruling #1 ("legend == renderer, no
drift") is enforced for 2 of 7 wall types.

### F8 — the docs overstate what shipped, in four places
* **`reports/ORCHESTRATOR_LOG.md:205`** — "round 1 · 10/10 (**293 checks**)". `defects-1.md` records
  the actual scoreboard: 59+17+92+14+70+16+19+9+21+4 = **321**. (Round 2's "363" and today's "373"
  are both correct under the +12-integrity convention.)
* **`ORCHESTRATOR_LOG.md:224`** — heading "**Judge round 2's other findings, all fixed**", followed by
  three bullets. Round 2 filed E1–E13. E6 (the video), E7 (plan labels), E8, E9 and E10 were not
  addressed and are not recorded as open anywhere in the log. **D3 and E6 — both MAJOR, both still
  open by my own measurement — appear in no open-defect list in the document.**
* **`ORCHESTRATOR_LOG.md:192-193`** — open defect #4 "`Conference_room` weakest still" marked
  **CLOSED**. The mullion is closed; the defect as written is not. N-1 §3 calls that still "the
  honest failure", and `docs/ROADMAP.md:317` *still* lists "`Conference_room` is the weakest still
  (5×4 m room, no camera solution)" as an open follow-up. Two docs in one commit disagree.
* **`docs/ROADMAP.md`** — round 3's work (M/N/O) is not ticked off at all; the only ROADMAP change in
  the commit is `1080p30 → 1080p60`. Per the project's own convention (`MEMORY.md`: "tick items off
  in the SAME change as the work") the room-type fix, the G6 rebuild and the camera work should have
  landed with their entries.

**Correctly fixed since round 2:** `ROADMAP:308` now reads **1080p60** (measured `r_frame_rate=60/1`,
2580 frames, 10.23 Mb/s) and `CLAUDE.md:104` now reads **150 tests** (measured: 150 passed). Both of
round 2's doc catches are closed.

### F9 — `composition.ts` exports six symbols nothing outside it uses
**File: `web/src/export/composition.ts:33-41, 273, 293, 366`.** `CELL_FREE`, `CELL_WALL`,
`CELL_GLASS`, `CELL_CORE`, `CELL_CONTENT`, `FAN_STEP_DEG` and `rayInterest` have **zero** references
outside the module (`ClearanceGrid` 14, `buildClearanceGrid` 7, `clearanceAt` 10, `bestVista` 8,
`frameLook` 6). Widening a symbol's visibility during an extract-to-module is the mild form of the
no-bloat rule's target. Cosmetic, but it is what the rule is for.

*The extraction itself is clean and I verified it line by line* rather than trusting the report:
`distanceTransform`, `distToPlate`, `clearanceAt` and `rayInterest` are **character-identical** to
their pre-extraction bodies; `buildClearanceGrid` differs only in an error string and a comment;
`bestVista` and `frameLook` differ only by the two documented additions (`within?` cone,
`interest`), with `BLANK_INTEREST = 0.1` preserving `blankFraction`'s old constant exactly. **436
lines moved with no behaviour change I can find.**

---

## COSMETIC

### F10 — G9's staleness guard is mtime-based, so it is one `git checkout` away from a spurious red
**File: `scripts/gates/g9-roundtrip.py:82-130`.** It compares artifact mtime against the newest of a
64-file import closure. That is the right shape and it works (§2), but mtime is not content: a
rebase, a `git checkout` or a concurrent save inside the closure reds the suite with a
"STALE" message that is false, and conversely a content change restored with an older mtime is
invisible. `run-all.sh`'s step 0 makes this harmless on a full board. Recording it, not asking for it.

### F11 — E8 and E9 stand unchanged
16 Inventory floor finishes still render as 2 materials (`floorKeyForFinish` is
`/carpet/i ? carpet : parquet`), and G6's `palette_family` mirrors the same collapsing rule at
`g6-renders.py:126-135`, so it can never notice. Reception bills `Porcelain stone, LF (POR)` and G6
samples `#60462E H=28.8 S=0.35 L=0.28` — dark herringbone parquet — and reports MATCHES. E9's
identity tier (`fm == inv`, `:287`) is still the same expression on both sides.

---

# What I could NOT break, and what is genuinely good

An adversarial report that cannot name real strengths is useless. Each of these I attacked or
measured myself.

**1. E1's root cause is closed, and this is the strongest work in the round.** The producer's
metadata is provably inert:

```
[I floorRect independence]  baseline rc=0 · every floorRect moved onto a wall rc=0 · field deleted rc=0
    stdout+stderr byte-identical in all three:  True / True
[A drop floorMaterial]      rc=1  CORRECTLY FAILS
[C drop the renders block]  rc=1  CORRECTLY FAILS
[F rotate roomIds]          rc=1  CORRECTLY FAILS
[H round-2 exploit: bottom 34% magenta + a legal producer-chosen crop]
                            rc=1  CORRECTLY FAILS
    "the gate segmented 33.8% of frame of ground plane and 1 surface(s) match NO material in
     palette.json … 33.8% #BE2896 (H=316.0 S=0.65 L=0.45)"
[B gradient-ramped magenta bridging the fill, 2 widths]   rc=1  CORRECTLY FAILS (both)
[D all four stills the same image]                        rc=1  CORRECTLY FAILS (tier B)
[F/G whole frame above a kept strip repainted, 5 widths]  rc=1  CORRECTLY FAILS (all five)
```

Three rounds, one bug — *the gate trusted the thing it was testing* — and this is the first fix that
survived my falsification instead of relocating. Eleven of my thirteen variants fail correctly. The
two that pass (F1, F2) are scope gaps in the gate's own method, not levers the artifact holds.

**2. The new segmentation generalises — I checked, rather than assuming.** I rendered three
*independent* packs and ran G6 on each: a **seed-11** plan (4/4 evidenced), the **imported 31-vertex
DWG plate** (3/4, Conference_room correctly reported as floor-under-furniture), and the **autonomous
test-fit** (4/4, `Work_stations` at 41.2 % of frame matching, purity 95 %). **No false fail, no false
pass, no crash on any of them.** The one thin margin is seed 11's Conference_room at 2.08 % against
the 2.00 % bar.

**3. E5/G9 staleness is closed at both ends, and I falsified it myself.** `run-all.sh` step 0
regenerates all twelve case files every full run (observed: written 18:28:13 inside an 18:27–18:33
board) and they are diffed by the closing integrity pass. `touch web/src/export/qtoWorkbook.ts` (a
*deep* closure file, not just the driver M tested) → **G9 FAIL, all three cases named**; `touch
web/src/three/interiorStill.ts`, correctly outside the closure → **G9 PASS**. `bash run-all.sh G6`
correctly does **not** run step 0 (case mtimes unchanged). And the headless and in-app paths still
emit **md5-identical** workbooks and plans.

**4. E4 is closed, surgically, and the tripwire really fires.** All **18 of 18** billed rooms agree
across `Furniture Inventory` and `Inventory` in the shipped xlsx; Reception is `Reception`, not
`Kitchen`; the `seeded`/`testfit` cases are also 0 contradictions (the `dwg` case's `"OS"` catch-all
is the pre-existing upstream item O documented). A cell-by-cell diff of the whole workbook against
round 2's shows **exactly 22 changed cells, all in `Furniture Inventory` column E** — zero
collateral. **Every Room ID and all 22 thumbnails are byte-identical to round 2, and `plan.png` is
byte-identical**, so O's "Room IDs did not move" is true at the byte level. I proved
`assertOneRoomType` discriminating **without touching the repo**: I patched the *esbuild output* to
reintroduce an `Amenity → "Kitchen"` mapping and `buildQtoPack` threw
`5 room(s) carry two different types across sheets — Room 30: Furniture Inventory "Kitchen" vs
Inventory "Reception" …`, while the unpatched bundle succeeded.

**5. E2 is closed and I looked at the picture.** No post on the mullion — the camera moved inside the
room. `blown%` 23.1 → **4.0** against the reference's 5.1; colours 329 → **649**; and t = 4.2 s in the
video is now a corridor perspective, not the bisected table.

**6. E3 is closed and over-delivered.** Reception's left 46 % band: 80.8 % flat / L 0.743 →
**51.3 % / 0.641**. It is better than round 1's still as well as round 2's, which was the bar.

**7. Determinism is stronger than any previous round established.** Across two complete G10
regenerations: `quantity-takeoff.xlsx`, `plan.png`, `plan.repeat.png` and **all four 3840×2160
renders** are md5-identical. Only `walkthrough.mp4` moves (55,003,458 → 55,154,031 B), and it decodes
completely every time.

**8. D11 stays re-graded as parity.** I rasterised both workbooks (`soffice → pdf → pdftoppm -r 70`)
and compared page by page: ours is 49 pages with the plan on 1–2, legend chips on 2 and labels +
lengths on 3; the reference is 146 pages with its plan fragmented and its legend carrying **no chips
and no lengths at all**. Both are unusable on print; ours prints strictly more. Round 2's
self-correction holds.

**9. The workbook remains the strong deliverable.** 100 % formula density (300/300), live LibreOffice
recalc 0 → 412,620, 123.20 m of perimeter glazing billed and drawn (**11,616 exact `#DCDBEE` px vs
408 `#AEB6FF`, 28.5:1**), headcount 112, 12 sheets in qbiq's order.

---

# Round-1 defects: closed vs still open

| # | round-1 defect | verdict | my evidence |
| --- | --- | --- | --- |
| **D1** | G6's check switched off by the artifact | **CLOSED** | `[A]` drop `floorMaterial` → rc=1; `[C]` drop the `renders` block → rc=1. Both are hard checks now (`g6:243`, `:280`). |
| **D2** | runner graded a pack G10 replaced; PASS on a half-written mp4 | **CLOSED** | Producers first, graders second, closing integrity diff over **22** files (10 pack + 12 case). Two boards ran clean; `ffmpeg -f null -` decoded 2580/2580 frames with zero errors. |
| **D3** | renders are the weakest deliverable, no gate measures it | **STILL OPEN — but forwards on all four** | See F3. mean flat 60.7 → **44.9** (ref 22.0); mean edge 11.4 → **14.8** (ref 34.6). Still 2.0× / 0.43×. No gate measures it. |
| **D4** | chairs drawn but not billed | **CLOSED** | 22 thumbnails byte-identical to round 2's verified set; workbook `Furniture Inventory` unchanged except 22 room-type strings. |
| **D5** | Perimeter windows 0.00 m | **CLOSED (product) · gate half STILL OPEN** | 11,616 exact `#DCDBEE` px; `General!L13` = 123.20 m. **G4 still passes 14/14 with every window pixel deleted** (F7). |
| **D6** | G3 only proves the workbook agrees with its own producer | **STILL OPEN, unchanged** | `g3-quantity-truth.py` untouched; every assertion still reads `out/ground-truth.json`. |
| **D7** | walkthrough ends on ~10 s of near-blank white room | **CLOSED (tail)** | t = 32–42 s: 34.4–39.8 % flat, 17.5–34.0 % eye, mean L 0.567–0.596. I looked at t = 34.2 and t = 42.2 — the strongest frames in the film. Head/mid still weak (F4). |
| **D8** | headcount inconsistent across identical rooms | **CLOSED** | Whole-plan 112; all 18 billed rooms self-consistent. |
| **D9** | half the reference's fps, 1/7 its bitrate | **CLOSED (product) · gate half STILL OPEN** | 60 fps, 10.23 Mb/s (ref 33.1). `g7-video.py:80` still asserts `fps >= minFps`; **no bitrate assertion exists** (13 `g.check`s, I read all of them). |
| **D10** | plate normalisation defeated by an opaque background | **STILL OPEN, unchanged** | `out/plan.png` alpha min = max = **255** ⇒ `plate == canvas`. G4 reports `circ=10.80%`. |
| **D11** | legend chips print on a different page from their labels | **CLOSED (re-graded parity)** | See strength 8. |
| **D12** | Circulation thumbnail is near-empty | **STILL OPEN, unchanged** | `out/thumbs/0.png`: **8.55 % ink, 180 colours** — a white tile with a pink hairline. The other "empty" rooms measure 76.5–77.8 %. I looked at it. |
| **D13** | G1 blind to the smudge class | **STILL OPEN, unchanged** | `g1-sheet-structure.py:71-73` still asserts `max(int(i.width)) >= 1000`, the intrinsic PNG width. |
| **D14** | the mp4 is the only non-deterministic artifact | **STILL OPEN (and narrower)** | Two full runs: xlsx, plan, plan.repeat and **all four renders** md5-identical; mp4 55,003,458 → 55,154,031 B. |
| **D15** | scale ≈⅔ of the reference | **STILL OPEN, unchanged** | 22 Inventory rows vs **31**; 24 embedded media vs **34**; 12 sheets vs 12. |
| **D16** | raw float noise stored in cells | **STILL OPEN, unchanged** | **39** cells >6 dp (`Inventory!J5 = 4.319999999999979`, `K5 = 46.50047999999977`, `Plan!S11 = 15.200000000000001`). Reference: **1**. |
| **D17** | the core is a featureless grey box | **STILL OPEN, unchanged** | 16,193 px of flat `#A0A0A0`, no stairs/lifts/shafts, `193` label drawn on top of it. |

# Round-2 defects: closed vs still open

| # | round-2 defect | verdict | my evidence |
| --- | --- | --- | --- |
| **E1** | G6 defeated — the artifact chooses *where* the gate samples | **CLOSED as filed** (residual F1/F2, different class) | Round-2's exploit reproduced verbatim and now **rc=1**. `floorRect` moved onto a wall / deleted → **byte-identical gate output**. `--floor-rect` is gone; `median_rgb` deleted. 36 → 43 checks. |
| **E2** | `Conference_room` bisected by a mullion | **CLOSED** | Camera (7.50,5.30) *outside* → **(5.80,0.90) inside**. I opened the still: no post, eight chairs, table receding diagonally. `blown%` 23.1 → **4.0** (ref 5.1). |
| **E3** | `Reception` regressed as a cost of the D1 fix | **CLOSED** | left-46 % band 80.8 % flat / L 0.743 → **51.3 % / 0.641**; flat 57.8 → **43.7**; colours 663 → **737**; still evidences its floor (42 % of the bottom edge). |
| **E4** | two sheets, two room types; Reception billed as a Kitchen | **CLOSED** | 18/18 agree in the shipped xlsx; 22 changed cells total; tripwire proven discriminating on a patched bundle. |
| **E5** | `run-all.sh` never produced or watched G9's inputs | **CLOSED** | Step 0 + `CASE_FILES` in the integrity snapshot + an independent closure guard in the gate. Falsified in both directions. 21 → 24 checks. |
| **E6** | the blank-frame problem relocated to the opening | **STILL OPEN — improved ~1 pt** | mean flat 48.1 → **46.9**, mean eye 38.3 → **37.0** (ref 18.1 / 14.0). Worst-at-eye fell 77.5 → **59.9** and moved off the opening; worst frame is now t = 10.2 at 64.1 %, and t = 22.2 is **40.4 % blown**. G7 still cannot see any of it. |
| **E7** | the plan hides small rooms' furniture behind their labels | **STILL OPEN, unchanged** | See F6 — reproduced at 4× on the shipped `plan.png`. Unassigned this round. |
| **E8** | 16 finishes render as 2 materials; G6's rule guarantees it can't notice | **STILL OPEN, unchanged** | F11. |
| **E9** | G6's identity tier is a tautology | **STILL OPEN, unchanged** | `g6:287` `fm == inv`, both sides the same expression on the same zone. It does still catch a wrong `roomId` — my `[F]` variant confirms. |
| **E10** | J-1's "only Reception's camera moved" didn't describe the pack | **CLOSED (superseded)** | N re-derived every camera; `manifest.json` and N-1 agree, and I re-measured the artifact rather than the report. |
| **E11** | three docs overstate/understate | **PARTLY CLOSED** | 1080p30 → **1080p60** ✔; 147 → **150 tests** ✔; the log is no longer a cycle stale — but it now carries four *new* inaccuracies (F8). |
| **E12** | D11 should be re-graded to parity | **CLOSED (accepted)** | Re-rasterised both workbooks myself; the re-grade holds. |
| **E13** | chair glyphs overlap desk tops at plan scale | **STILL OPEN, cosmetic** | `plan.png` byte-identical to round 2. |

---

# Bottom line

**The pack is shippable.** Both prior blockers are closed, and for the first time a blocker fix
survived falsification rather than relocating the exploit. The workbook is at or above parity and now
tells one story about every Room ID; the plan, the viewer and the round-trip harness are sound; the
gate board is stable, honest about the bytes it graded, and no longer certifiable by a producer that
points it at a wall.

**It is not at visual parity, and the docs should say so.** The four stills are 2.0× the reference's
flatness and 0.43× its edge density; `Conference_room` is 2.6× / 0.19× and its own author calls it
the honest failure; the video is 2.6× flat with one 40 %-blown frame. That gap is *content and
plate*, not framing — N proved it with a 24-heading sweep, and I accept the proof. What I do not
accept is the log recording that defect as **CLOSED** while the ROADMAP, N-1 and my own measurements
all say it is open, and recording "all fixed" over a set that excludes five of round 2's thirteen
findings (F8).

The debt worth naming in one line: **five gates still cannot see the things they are named for**
(G1's smudge class, G3's self-reference, G4's five uncoloured legend types, G7's flat/blank/bitrate
blindness, and G6's blind zone above the bottom strip), and **the only render↔takeoff cross-check in
the pack is performed on 3 of 4 rooms with zero headroom.**

The pattern the brief predicted holds a **fifth** time, with one change worth recording: **every
finding in this report came from running a falsification or opening the artifact and looking at it,
and no gate reports any of them — but this round, for the first time, the falsifications mostly
came back red.** That is progress, and it is the right note to end on.
