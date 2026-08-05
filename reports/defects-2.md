# G2-1 — Parity Judge, round 2: adversarial defect report

**Agent G2. Read-only.** No product file, gate or doc was modified; the only file I wrote is this
one. Every number below is from output I ran or an image I looked at myself. Where I compare against
round 1, I say explicitly whether the comparison is safe (see *Measurement methodology*).

---

## How I ran it

The vite server on :5173 (pid 93016) was started **16:19**, after the last config-time change
(`deploy/packStore.ts`, 16:16) — so it was probably clean. I killed and restarted it anyway before
touching a gate, per the brief.

```
$ pnpm --dir web dev --port 5173 --strictPort        # fresh, 16:53
$ VERBOSE=1 bash scripts/gates/run-all.sh
  G1 PASS (59) · G2 PASS (17) · G3 PASS (92) · G4 PASS (14) · G5 PASS (70)
  G6 PASS (36) · G7 PASS (19) · G8 PASS  (9) · G9 PASS (21) · G10 PASS (14)
  10/10 passing
  graded pack: 10/10 artifacts in out/
               walkthrough.mp4  53130923 B  mtime 16:57:12  43.00s
               unchanged since G10 produced it; PASS  (12 checks)
  ALL GATES GREEN.
```

Re-run of the nine reader gates against that same pack: **9/9, identical check counts.** 363 checks
total, matching the fix commit's claim exactly. **The board reproduces and is stable.**

### Measurement methodology (round 1's D5 evidence was wrong; I am not repeating that)

* **Palette pixel counts are EXACT** (`==`), reported separately from a near count with the tolerance
  named. Round 1 counted anti-aliased blends inside ±8 as matches and concluded the plan drew
  perimeter windows when it drew none. My `planpal.py` never conflates the two.
* **`flat%`** = share of 16×16 tiles with luminance σ < 0.01 on a **960 px-wide BILINEAR** downsample.
  **`edge%`** = share of pixels with `np.gradient` magnitude > 0.02. **`eye%`** = `flat%` restricted to
  rows 40–78 % of frame height.
* **Cross-round comparison is validated against a fixed control.** The reference stills are immutable,
  so I re-measured them: my `flat%` on all four reproduces round 1's to **±0.5 pt** (21.2 vs 21.0,
  25.5 vs 25.2, 19.5 vs 19.0, 21.6 vs 21.5). My `edge%` runs a systematic **≈1.4 pt low**. Therefore
  `flat%` deltas > 1 pt and `edge%` deltas > 2 pt between rounds are real; anything smaller I do not
  claim.
* **Video:** metrics on native 1920×1080 frames, same downsample.
* Colour envelopes quoted as `H a–b, S a–b, L a–b` are `palette.json`'s own, as G6 reads them.

---

# Defects, ranked

## BLOCKER

### E1 — G6 is defeated: the artifact still chooses **where** the gate samples
**Gate: G6 (passing, 36 checks).** **Files: `scripts/gates/g6-renders.py:162-168` (the `floorRect`
acceptance rule) · `web/src/export/roomRenders.ts:243,256` (the producer supplies `floorRect`).**

D1's specific exploit is dead — I confirmed that first, hard (see *Round-1 verdicts*). But the fix
moved the artifact's control from *whether* to *where*. `floorRect` is still **producer-supplied**,
and the gate's only constraints on it are geometric:

```python
rect[1] >= 0.30 and rect[3] <= 1.0 and (rect[2]-rect[0])*(rect[3]-rect[1]) >= 0.005
```

Nothing verifies the crop contains floor. So the gate reads whatever rectangle the artifact points it
at, anywhere in the lower 70 % of frame, and compares that to the material envelope.

**Falsification — built in scratch, repo untouched.** I painted the bottom **34 %** of all four
stills solid magenta `rgb(190,40,150)` (the entire visible floor of every render destroyed), then
brute-force searched each *unpainted* upper frame for a **legal** crop (y₀ ≥ 0.30, y₁ ≤ 0.66,
1.2–1.8 % of frame) whose median lands inside that room's own envelope, and wrote it into
`ground-truth.renders[].floorRect`:

```
Reception        herringbone_parquet  crop=[0.65,0.30,0.95,0.36]  #A4794C H=30.7 S=0.37 L=0.47
Open_space       light_gray_carpet    crop=[0.00,0.30,0.20,0.36]  #9B958D H=34.3 S=0.07 L=0.58
Work_stations    light_gray_carpet    crop=[0.175,0.30,0.375,0.36] #C9C6C0 H=40.0 S=0.08 L=0.77
Conference_room  light_gray_carpet    crop=[0.40,0.48,0.60,0.54]  #A89E93 H=31.4 S=0.11 L=0.62

$ python3 scripts/gates/g6-renders.py --renders <fake> --ground-truth <fake>
G6 PASS  (35 checks)
  note[G6] Reception       … (MATCHES H 15-32, S 0.18-0.48, L 0.15-0.48)
  note[G6] Open_space      … (MATCHES H 28-48, S 0.03-0.24, L 0.45-0.8)
  note[G6] Work_stations   … (MATCHES H 28-48, S 0.03-0.24, L 0.45-0.8)
  note[G6] Conference_room … (MATCHES H 28-48, S 0.03-0.24, L 0.45-0.8)
```

**4 of 4 "evidenced" — not 3, 4 — on a pack in which the floor material is visible nowhere.** I
rendered the forged stills with the sampled crop outlined in green and looked at them: the samples are
a **wood slat wall**, a **ceiling/wall junction**, a **wall above the glazing** and a **wall behind a
chair**. Not one is floor.

**Why this is not merely theoretical:** it is already happening on the shipped pack, benignly. The
producer records `"floorCheck": "no-clean-floor"`, `"floorRectPurity": 0.0` for `Conference_room` —
it *states* that the published rect is not floor — and then publishes the **default** rect
`[0.05,0.8,0.95,0.98]`. G6 reads that rect, gets `#4B423B H=26.3 S=0.12 L=0.26`, and certifies it as
"carpet under shadow". One of the four render↔takeoff cross-checks on the delivered pack is already
being made against a crop the producer itself declares is not the room's floor.

The fix that closes this is small and entirely gate-side: derive the crop **in the gate** (e.g. the
largest low-texture region in the lower third), or require the producer to publish a floor **mask**
whose coverage the gate can verify, rather than a rectangle it must trust.

*Consistency note:* round 1 graded "the artifact controls whether it gets tested" a BLOCKER. "The
artifact controls where it gets tested, and I have a working whole-pack exploit" is the same class on
the same gate, so I grade it the same. It is a **narrower** hole than D1 — three of the four tiers
(mandatory block, identity, name equality) are genuinely solid, and I could not defeat it without
rewriting `floorRect`.

---

## MAJOR

### E2 — The `Conference_room` hero still is bisected by a mullion standing in the middle of the table
**Gate: none** (G6 has no composition or content assertion; the still is the one G6's `--min-evidenced 3`
bar exists to exempt). **Files: `web/src/three/interiorStill.ts::placeRoomCamera` ·
`web/src/three/materialTheme.ts:985-1003` (mullion caps, `GLAZING_MODULE = 1.2`).**

I looked at the still at full resolution. A **floor-to-ceiling white post runs down the middle of the
frame, through the conference table** — the table top passes behind it and continues on the other
side, and the ceiling pendant is cut into two segments by it.

I traced it to geometry rather than guessing:

```
zone 39 "Meeting Room 1"  Rect centre (7.5, 2.1)  5 × 4 m   →  x 5.0-10.0, y 0.1-4.1
camera (out/renders/manifest.json)  eye world (7.50, 5.30)   target (7.685, 2.295)   fovH 75°
glass front  wall 36  (5.05,4.05)->(8.90,4.05)  glazing=true
mullion pitch 1.2 m along the run  →  posts at x = 6.25, 7.45, 8.65
```

The camera stands **1.25 m OUTSIDE the room**, in the corridor, shooting through the glass front. The
mullion at x = 7.45 is 0.13 m off the view axis at 1.25 m range — dead centre. A 0.05 m post at that
distance subtends ≈2.6 % of frame width, which is what I measure.

Consequences, measured:

| | value | reference |
| --- | ---: | ---: |
| top 45 % of frame, `flat%` | **92.5** | — |
| top 45 % of frame, mean L | **0.892** | — |
| whole frame, pixels >225 on all channels | **23.4 %** | 5.8 % |
| whole frame `edge%` | **5.9** | 35.4 |
| whole frame distinct colours (÷8 quantised) | **329** | 2510 |

The same shot appears in the walkthrough at **t = 4.2 s** — same mullion, same bisected table — so it
is not confined to one still.

This is a *regression in composition* alongside a genuine content fix: the room now has eight chairs
(K's work, visible and correct), but the camera moved out of the room and behind a post.

### E3 — The `Reception` still regressed as a direct cost of the D1 fix, further than J-1 stated
**Gate: none.** **File: `web/src/three/interiorStill.ts:137` (`FLOOR_EVIDENCE_MIN = 0.15`).**

J-1 owned this cost ("it is also a plainer picture") but the numbers say more than "plainer". Against
the reference control that reproduces round 1's measurement to ±0.2 pt:

| | round 1 | **round 2** | reference (control) |
| --- | ---: | ---: | ---: |
| Reception `flat%` | 48.8 | **57.7** | 21.2 (was 21.0) |
| Reception `edge%` | 10.1 | 15.1 | 31.9 |
| Reception colours | 674 | 663 | 1887 |

**The left 46 % of the frame is 88.9 % flat at mean L 0.740** — one continuous blank plasterboard
plane. What is left in the picture: a wood-slat wall, a door, a desk slab entering from the right and
cut by the frame edge, and a small patch of floor bottom-left. Round 1 could at least describe
Reception as "a glass box with a sage wall, one small desk, two ring pendants"; none of that is in
frame now. The reference is a fully furnished lobby with a green feature wall, ring pendants, lounge
chairs and a planter.

The trade was made to satisfy a gate check that E1 shows can be satisfied by pointing at a wall
anyway. That is the sharp edge of it: **the deliverable got worse to satisfy a check that does not
work.**

### E4 — `Furniture Inventory` and `Inventory` name the same room two different things; Reception is billed as a **Kitchen**
**Gate: none.** **File: `web/src/export/takeoff.ts:79-87` (`ROOM_TYPE`).**

`ROOM_TYPE` collapses the core's 7 `ZoneType` values onto a 7-value vocabulary, while the `Inventory`
sheet in the *same workbook* carries a proper per-room `Subcategory` from a different source. They
contradict each other on **8 of 18** rooms that have furniture:

| Room ID | `Inventory` Program Room Name | `Furniture Inventory` Room Type |
| ---: | --- | --- |
| 30 | **Reception** | **Kitchen** |
| 145 / 147 | Print Point 1 / 2 | **Kitchen** |
| 122 | Pantry | Kitchen *(fair)* |
| 12 / 21 | Focus Room 1 / 2 | **Executive Office** |
| 155 / 163 / 171 | Phone Booth 1–3 | **Executive Office** |
| 103 / 179 / 188 | Cabin 1–3 | Executive Office *(fair)* |
| 106 | Collab | **Comfort Zone** |

A quantity takeoff that bills the reception's chair under "Kitchen" is the first thing a reviewer
will circle. It is the exact D4 failure mode — one deliverable telling two stories about one Room ID
— surviving one sheet away from where D4 was fixed. (The reference puts a *numeric* room reference in
that column, so there is no parity argument for the current strings either way; ours is a divergence
that happens to be wrong.)

### E5 — D2's guarantee has a hole: `run-all.sh` never produces or watches G9's inputs
**Gates: G9 (passing, 21 checks) + the suite integrity pass.** **Files: `scripts/gates/run-all.sh:59-70`
(`PACK_FILES`) · `scripts/gates/g9-roundtrip.py:72`.**

G9 grades `out/cases/{seeded,dwg,testfit}/` — 12 files, and it re-runs G1–G5 against each. Those files
are written **only** by `node scripts/export-pack.mjs` (`export-pack.mjs:163`), which `run-all.sh`
never invokes, and they are **not in `PACK_FILES`**, so the closing snapshot diff does not watch them.

Measured across two complete green boards (16:44–16:51 and 16:53–16:58):

```
out/quantity-takeoff.xlsx        mtime 16:53:47   (G10's click)
out/cases/seeded/…xlsx           mtime 16:26:19   (a 27-minute-old, unrelated invocation)
                                 md5 identical before and after both runs — never touched
```

The suite prints *"graded pack: 10/10 artifacts in out/ … unchanged since G10 produced it"*. That
sentence is true of ten files and silent about the twelve carrying 21 of the 351 checks. Change the
generator, run `run-all.sh`, and G9 will certify round-trip robustness of the **previous**
generator's workbooks with no staleness complaint — the precise failure D2 was raised to end.

*It is benign today, and that is worth saying:* `out/cases/seeded/quantity-takeoff.xlsx` is
**byte-identical** (md5 `3a611757`) to the workbook the browser click produced, so the headless
harness and the in-app one-action path currently emit the same bytes. The guarantee is missing, not
the correctness.

### E6 — D7 was relocated, not eliminated: the blank-frame problem is now the **opening**
**Gate: G7 (passing, 19 checks).** **File: `web/src/export/walkthrough.ts` (`planWalkRoute`,
`addBrandedDisplays`).**

The tail is genuinely fixed and is now the best part of the film (see *Round-1 verdicts*). But a dense
1 s sweep of all 43 s shows the same defect sitting at the head:

| t (s) | 0.2 | 1.2 | **2.2** | 3.2 | **4.2** | 5.2 | 10.2 | 26.2 | 34.2 | 42.2 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| mean L | .547 | .636 | .758 | .700 | **.783** | .721 | .776 | .663 | .575 | .570 |
| flat% | 87.4 | 63.4 | **65.2** | 47.7 | 58.9 | 55.8 | **64.1** | 42.6 | 37.4 | 34.5 |
| eye% | 73.5 | 64.4 | **77.5** | 62.4 | 72.6 | 52.8 | 59.9 | 20.6 | 21.1 | 27.1 |

The first ~5.5 s (13 % of the runtime) runs 56–65 % flat with **53–78 % blank at eye level**, and
t = 10.2 (a corridor shot) is 64.1 % flat. Round 1's tail — the thing that was fixed — peaked at
54.6 % flat. Reference control, same script, 3 s sweep: **mean flat% 16.6, mean eye% 12.9, max flat%
27.6.** Ours: **mean flat% 48.1, mean eye% 38.3.** ~2.9× the reference throughout.

L-1 predicted this exactly ("the opening is now the weakest passage") and measured t=2.2 at
64.9 % / 80.5 %; I measure 65.2 % / 77.5 %, so we agree. It was declared out of scope. It is the third
time this defect has been moved rather than removed (t=30/31 → tail → head), and **G7 still has no
flat-fraction or blank-wall assertion at all** — its luminance ceiling is 0.85 and the worst frame is
0.783, so it cannot see any of this.

---

## MINOR

### E7 — The plan graphic hides small rooms' furniture behind their room-ID label
**Gate: none.** **File: `web/src/export/planGraphic.ts:268-284`.**

Labels are drawn **last**, at `Math.round(15 * scale)` px with a 4 px halo, and `placeNear` de-collides
them only against **other labels** (`occ` is seeded with label boxes only), never against furniture
ink. At the delivered 1040×780 the plate maps to ≈23.75 px/m, so a 0.6 m table is 14 px and a 0.5 m
chair is 12 px — smaller than the label that lands on top of them.

Confirmed against the model (`Print Point 1` zone 145 holds a `Table` 0.6×0.6 at its centre; `Phone
Booth 1` zone 155 holds a `Chair` 0.5×0.5):

| Room | workbook bills | plan draws |
| --- | --- | --- |
| 145 / 147 Print Point 1–2 | `Table W60 X L60: 1` | **nothing but the label** |
| 155 / 171 Phone Booth 1 / 3 | `Chair W50 X L50: 1`, HC 1 | **nothing but the label** |
| 163 Phone Booth 2 | `Chair W50 X L50: 1`, HC 1 | chair visible — its label was displaced by collision |

Room 163 is the tell: the only one of the three whose furniture reads is the one whose label got
pushed out of the room. This is the D4 contradiction (billed but not drawn) in the deliverable's most
visible page.

### E8 — 16 Inventory floor finishes render as 2 materials, and G6's rule guarantees it can never notice
**Gate: G6 (structural).** **Files: `web/src/three/materialTheme.ts:140-142` · `scripts/gates/g6-renders.py:59-68`.**

`floorKeyForFinish` is `/carpet/i ? light_gray_carpet : herringbone_parquet`, and G6's `palette_family`
mirrors it exactly — deliberately, "expressed as a RULE, not a lookup table". The consequence is that
every hard floor in `FINISH_SPEC` renders as **dark wood herringbone**:

* Reception (room 30) bills **`Porcelain stone, LF (POR)`**; the still shows dark herringbone parquet
  (G6's own sample: `#5B3F30 H=20.9 S=0.31 L=0.27`).
* Cabins 1–3 bill `Engineered timber (TIM)`, Collab bills `Luxury vinyl tile (LVT)`, Pantry bills
  `Anti-skid vitrified tile (VIT)` — all render identically.

The gate reports `MATCHES` because it resolves the name through the same collapsing rule the renderer
uses. Naming the material honestly in the workbook and rendering a different one is the render↔QTO
disagreement the mission is about, one level down from where G6 looks.

### E9 — G6's identity tier is a tautology on the shipped code path
**Gate: G6.** `g6-renders.py:142` asserts `fm == inv`, where `fm` is `FINISH_SPEC[room.finishKey].floor`
(`roomRenders.ts:208`) and `inv` is `spec.floor` for the same zone (`qtoWorkbook.ts:286`). Both sides
are the *same expression on the same zone*. It fires only if the render declares the wrong `roomId`
**and** that room has a different finish — my variant F confirmed it does catch that case, so it is
not worthless, but it is much weaker than "renders and takeoff name the same finish" reads. Same
by-construction pattern as D6.

### E10 — J-1's "only Reception's camera moved" does not describe the shipped pack
**Doc claim vs artifact.** J-1 states only Reception's camera moved, and supports the
`Conference_room` ≥3 decision with a candidate grid `eye(6.0…9.0, 0.9…3.3)` — **every point of which
is inside** room 39 (x 5.0–10.0, y 0.1–4.1). The camera that actually shipped is at **world (7.50,
5.30)**, 1.2 m *outside* the room in the corridor (`out/renders/manifest.json`, `placement: "corner"`).
Round 1 described `Conference_room` as an inside-the-room shot ("a bare table edge in the bottom-left
corner… a door and a screen at right"), which is not this picture. Whatever the cause (J's
`FLOOR_EVIDENCE_MIN`, or K's eight new chairs rescoring the candidates — both landed in one commit),
**the "no camera can evidence this floor" analysis was conducted over a candidate set that excludes
the camera that shipped**, so it does not support the conclusion drawn from it. See E2 for what that
camera produces.

### E11 — Three docs overstate or understate what shipped
* **`docs/ROADMAP.md:308`** — "Walkthrough video … 43 s H.264 **1080p30**". Measured:
  `r_frame_rate=60/1`, `nb_frames=2580`, 9.88 Mb/s. **It is 1080p60.** The doc understates the one
  encode change L-1 made.
* **`CLAUDE.md:104`** — "Rust: 147 tests". Actual: `cargo test -p ds-core` → **150 passed, 0 failed**.
* **`reports/ORCHESTRATOR_LOG.md`** — last touched in `7560896`, i.e. **two commits and one whole
  Judge cycle stale**. It records no Judge round, no D1/D2, no runner reorder, and its four tracked
  open defects are **all four now closed**: #1 Perimeter windows 0.00 m → 123.20 m; #2 meeting-room
  headcount 0 → 8; #3 the 150 ms flake → now `assert!(ms < 3000)` with a "blow-up guard, NOT a
  performance budget" comment (`layout.rs:6746-6753`); the `gen_spec_md.py:198` narration → fixed.
  K-1 §8 says the log's items are closed, but the log itself was never edited.

---

## COSMETIC

### E12 — `D11` reproduces, but the reference is at least as broken — downgrade it
Round 1 filed the split legend as a MINOR print defect. I rasterised **both** workbooks through
`soffice → pdf → pdftoppm -r 90`. Ours: plan on pages 1–2, legend **chips** on page 3, legend
**labels + lengths** on page 4. The reference: plan fragmented across pages **1, 2, 5, 6**, legend
labels on page 4 with **no chips and no lengths at all**, and its `Furniture Inventory` splits with the
Room Type / Item Description columns rendering blank. Both are unusable on print; ours prints strictly
more information. **This is parity, not a gap** — I would close D11 rather than fix it.

### E13 — Chair glyphs overlap desk tops at plan scale
A consequence of K removing `drawTable`'s 17 % footprint inset (correctly — it existed only to leave
room for the deleted implied seats). On the right-hand desk banks a tucked chair now overlaps the desk
rectangle's ink; on the bottom row, where desks face the other way, it reads cleanly. Correct as
geometry, slightly muddy as a plan symbol. Not worth a change on its own.

---

# Round-1 defects: closed vs still open

| # | round-1 defect | verdict | evidence |
| --- | --- | --- | --- |
| **D1** | G6's check switched off by the artifact | **CLOSED** (see E1 for the residual) | All 8 falsification variants now fail: dropped field, magenta+kept, whole `renders` block dropped, **each of the four single-painted floors**, swapped roomIds, and magenta painted only inside the declared rect. `MATERIAL_KEY` is gone; the check resolves through `FINISH_SPEC`. 13→36 checks. |
| **D2** | runner graded a pack G10 replaced; PASS on a half-written mp4 | **CLOSED** | Observed live: during a G10 render, `out/.walkthrough-66940-…/walkthrough.mp4` grew 15→47 MB answering `moov atom not found`, while `out/walkthrough.mp4` stayed at a stable 53,125,378 B and **decoded 43.00 s at every sample**. At the rename it became the new complete take. Immediately after the green board: `ffprobe` rc=0, and a **full `ffmpeg -f null -` decode of all 2580 frames** returned zero errors. Staging dir cleaned up. Producer-side atomicity in `packStore.ts` + `export-pack.mjs:126`. **Hole remains at G9 — see E5.** |
| **D3** | renders are the weakest deliverable, no gate measures it | **STILL OPEN — and worse on 3 of 4** | flat% ours/ref: Reception **57.7**/21.2 (was 48.8/21.0) · Open_space 66.0/25.5 · Work_stations **51.0**/19.5 (was 41.5/19.0) · Conference_room **68.1**/21.6 (was 66.6/21.5). Conference_room `edge%` 8.4→**5.9**, colours 460→**329**, despite gaining 8 chairs. See E2, E3. |
| **D4** | chairs drawn but not billed | **CLOSED** | I counted every thumbnail by eye at 3×: Meeting Room 1–4 and Collab draw exactly **8** chairs and bill `Chair W50 X L50: 8`; Print Points draw **0** and bill 0; Reception/Cabins/Focus draw 1 and bill 1; Open Workspace draws one chair per desk, **once** — no doubled or missing ink. `Furniture Inventory Summary` totals `Chair W50 X L50: 112`. |
| **D5** | Perimeter windows = 0.00 m; plan disagrees with takeoff | **CLOSED (product) · gate half STILL OPEN** | EXACT hex counts on `out/plan.png`: `#DCDBEE` = **11,616 px**, `#AEB6FF` = **408 px** (28.5:1 glazed; reference 25:1). LibreOffice recalc: `General!L13` = **123.2 m**, `BOM-Walls F8` = `Main Summary F25` = **320.32**; Perimeter wall 4.80 → 12.48. Reference 125.47 m. **But G4 is byte-identical to round 1** — I recoloured every window pixel to wall (0 perimeter-window px) and **G4 still PASSED 14/14**. Five of seven legend colours still carry no pixel assertion. |
| **D6** | G3 only proves the workbook agrees with its own producer | **STILL OPEN** | `g3-quantity-truth.py` untouched by the fix commit; every assertion still reads `out/ground-truth.json`. |
| **D7** | walkthrough ends on ~10 s of near-blank white room | **CLOSED (tail) — see E6 (head)** | Last 10 s now: worst flat% **43.6**, worst eye% **37.4**, worst mean L **0.599** (round 1: climbing to .815 / 54.6 %). I looked at t=34.2 and t=42.2: deep desk bays, full perimeter glazing with the green horizon, pendant rhythm — genuinely the strongest frames in the film. |
| **D8** | headcount inconsistent across identical rooms | **CLOSED** | Every Inventory row now self-consistent: Meeting Room 1–4 HC **8** each, Cabin 1–3 HC **1** each, Phone Booth 1–3 HC **1** each, Focus Room 1–2 HC 1, Print Point 1–2 HC 0, Collab HC 8, Open Workspace 63. Whole-plan **112** (was 67; reference ≈155). |
| **D9** | half the reference's fps, 1/7 its bitrate; G7 checks neither | **CLOSED (product) · gate half STILL OPEN** | fps **30 → 60**, exactly matching the reference. Bitrate 4.78 → **9.88** Mb/s vs 33.09 (gap 7× → 3.35×). `g7-video.py:80` still asserts `fps >= minFps` where `minFps: 30` — a floor, not a match — and there is still **no bitrate assertion**. A silent revert to 30 fps would pass. |
| **D10** | plate normalisation defeated by an opaque background | **STILL OPEN, unchanged** | `out/plan.png` alpha min = max = 255, fully opaque ⇒ `plate == canvas`. G4 reports `circ=10.80%`; true ink bbox is 950×572 giving **16.12 %** (reference plate-relative 12.86 %). Ruling #4 remains unimplemented for our own artifact. |
| **D11** | legend chips print on a different page from their labels | **REPRODUCES but re-graded → close it** | See E12: the reference's own print layout is worse. |
| **D12** | Circulation thumbnail is near-empty | **STILL OPEN, unchanged** | `out/thumbs/0.png` is **9.11 % ink**, 180 distinct colours — a white tile with a pink hairline. The other "empty" rooms (130/137/144) are 76–78 % ink. |
| **D13** | G1 blind to the smudge class | **STILL OPEN, unchanged** | `g1-sheet-structure.py:70-73` still asserts `max(int(i.width)) >= 1000`, the intrinsic PNG width, not the `twoCellAnchor` rendered extent. |
| **D14** | the mp4 is the only non-deterministic artifact | **STILL OPEN, unchanged** | Two independent full runs: `quantity-takeoff.xlsx`, `plan.png`, `ground-truth.json`, `renders/Reception.png`, `renders/Conference_room.png` all **md5-identical**; `walkthrough.mp4` 53,125,378 → 53,130,923 B. `plan.png` == `plan.repeat.png` (sha256 `59a705b3…`). Determinism is in fact *stronger* than round 1 proved — the renders are byte-stable too. |
| **D15** | scale ≈⅔ of the reference | **STILL OPEN, unchanged** | 22 Inventory rows vs **31**; 24 embedded media vs **34**; 12 sheets vs 12. |
| **D16** | raw float noise stored in cells | **STILL OPEN, unchanged** | **39** cells store >6 dp float noise (`Inventory!J5 = 4.319999999999979`, `K5 = 46.50047999999977`, `Plan!S11 = 15.200000000000001`, …). The reference has **1**, and it is a genuine value, not accumulation noise. Number formats mask it in the render. |
| **D17** | the core is a featureless grey box | **STILL OPEN, unchanged** | Looked at it at 3×: a plain grey rectangle, no stairs, lifts or shafts, with the `193` Open Workspace label still drawn on top of it. The 3D viewer shows the same solid box. |

---

# What is genuinely good (verified independently, round 2)

1. **D2's fix is the best work in this round.** I watched the race the gate used to lose and could not
   reproduce it: staging file un-decodable, published file complete and decoding, throughout. A full
   2580-frame decode of the shipped mp4 is clean. This is a real engineering fix at the producer, not
   a threshold change.
2. **The workbook now agrees with itself about furniture and people.** 8 chairs drawn, 8 billed, HC 8,
   in four identical rooms and the collab setting — and the thumbnails embedded in the workbook show
   it. Chairs render exactly once.
3. **The facade is right in three places at once.** 123.20 m glazed / 4.80 m solid in the model, the
   same run coloured in the plan at 28.5:1, and 320.32 m² recalculating live through
   `General → BOM-Walls → Main Summary`. Arrived at from a 0.6 m pier convention and landing within
   2 % of the reference is convincing.
4. **`glaze_facade` is well-behaved on every case I could throw at it.** Across `seeded`, `testfit`
   and the **31-vertex imported DWG plate**: every glazed non-generated segment lies within 0.35 m of
   the traced plate boundary — **zero** wrongly-glazed interior walls, and `classify_wall` returns
   `Core` before `PerimeterWall`, so a core-hosted wall can never be reached. The DWG case honestly
   bills more solid perimeter (35.57 m) because its many short runs each cost two piers.
5. **The headless harness and the in-app one-action path emit identical bytes.**
   `out/cases/seeded/quantity-takeoff.xlsx` (from `export-pack.mjs`) is md5-identical to
   `out/quantity-takeoff.xlsx` (from the browser click). The "same code path" claim is true.
6. **The walkthrough's ending is now genuinely strong**, and the middle holds: t = 26–42 runs 34–43 %
   flat with 20–27 % at eye level, dense desking, the full glazing band and the green horizon.
7. **The 3D viewer is real and now shows the glazing.** 1280×748, `webgl=true`, ink 16.78 %,
   axonometric with the mullion band around the whole plate, branded chrome, working controls.
8. **The gate board is stable.** 10/10 with G10 producing, then 9/9 on a re-run of the readers against
   the same bytes, identical check counts — 363 in total, exactly as the commit claims.
9. **Determinism is stronger than round 1 established** — the 3840×2160 renders are byte-identical
   across independent runs, not just the workbook and plan.

---

# Bottom line

**In my judgement the pack is NOT yet shippable at parity — but it is much closer than round 1, and
only one finding is a stop-ship.**

The product fixes are real and I verified every one of them by falsification or by looking at the
artifact: D2, D4, D5, D7 and D8 are properly closed, and D1's specific exploit is dead. That is five
of seven.

What stops it:

* **E1 (blocker).** G6 — the pack's only render↔model check — can be passed in full by a pack whose
  four stills show no floor at all, because the artifact still supplies the crop the gate samples. I
  have the working exploit and the screenshot. Round 1's central lesson was that a gate the artifact
  can steer is not a gate; that is still true one level down, and the shipped `Conference_room` entry
  is already being certified against a rect its own producer marks `purity 0.0`.
* **E2 and E3 (major, product).** The two hero stills a client sees first are now, respectively, a
  conference table with a post through the middle of it and a photograph of a corner of drywall — and
  E3 was paid *for* the check E1 shows does not work. `Conference_room` is 23.4 % blown-white against
  the reference's 5.8 %; the whole render set remains 2.6–3.2× flatter than the reference with a
  quarter of its colour variety. D3 is not only open, it moved backwards on three of four stills.

The rest is honest debt: five gates (G1, G3, G4, G7 and the D10 normalisation) still cannot see the
things they are named for, and the docs have drifted a cycle behind the code.

The pattern the brief predicted holds a **fourth** time. Every blocker and major in this report —
E1 through E7 — came from running a falsification or **opening the artifact and looking at it**.
None of them is reported by any gate, and the board was green throughout.
