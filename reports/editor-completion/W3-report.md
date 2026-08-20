# Workstream W3 — D-Q closed: 26 → 24 (reconciled) → 0

Branch `fix/dq-strings` off `d868ec3`. Pre-registration:
`reports/editor-completion/W3-preregistration.md` (committed at `f8cb7d7`,
BEFORE any fix code ran). Instrument: SG8 8.2
(`scripts/gates/sheets/sg8-string-ink-crossing.mjs`), promoted from B's note —
counting rule unchanged; footprint = core-state wall bbox via the gates' own
`planProjection`, strings = poppler word chains; nothing read from the producer.

## 1. The count, and where every string went

| stage | seeded/A02 | testfit/A02 | dwg/A01 | dwg/A02 | total |
|---|---|---|---|---|---|
| B landing tree `547d4a0` (its own wasm + render) | 4 | 12 | 3 | 7 | **26** |
| W3 base `d868ec3` (operative RED baseline) | 4 | 12 | 2 | 6 | **24** |
| post-fix `59f9601` | 0 | 0 | 0 | 0 | **0** |

26 reproduced digit-for-digit at the tree it was measured on; the 26→24 delta
is confined to the dwg pack and attributed to merged core work in
`547d4a0..d868ec3` (placement-inset, packing straddle rule, corridor-classifier
conjunct, pax; goldens re-captured once at `b792327`). Instrument and producer
files byte-identical across that window (`git diff` empty).

**Diagnosis (measured, instrumented render, instrumentation reverted):** the 24
strings are 12 name+area blocks, and every one was placed by `roomLabels`'
`allowSoft` NEAR rung buying the `seedOutsideMargin` soft strips — the
in-building wide rungs were ordered after it and never ran. The missing rung
was displacement inward from the footprint edge, exactly as Phase 0 expected.

**Fix:** every non-terminal ladder rung is confined to the building footprint
bbox ∩ plate (`wallFootprintOnSheet`, one derivation shared with
`seedOutsideMargin`). Zero survivors — including dwg/A01's
`OPEN WORKSPACE (4)` + `6.6 m²`, which moved from the left margin (80,182) to
inside the shell over the soft demolition hatch (319,211), leader redrawn.

**Ruling (stated in the pre-registration §3, not silent):** margin-with-leader
is NOT retained as legal steady state and gets NO exclusion rule. The terminal
`settleLabel` escape keeps plate bounds (a label with no in-building spot at
any form still escapes outward, leader-backed), and SG8 8.2 asserts ZERO — an
escape that fires outward is a named RED to adjudicate, never a shipped
pattern.

## 2. Dims — the displacement rung, and the 13 registered strings

Mechanism: `roomDims`' binary declutter skip became a ladder. The label may
slide along its own dim line or take its other side (`DIM_LABEL_SPOTS`,
deterministic, nearest-centre first; first candidate = today's exact box, so
printing dims did not move). A candidate is accepted only when clear of
EVERYTHING (hard ink and soft furniture alike); suppression is the last rung.

Phase 0 said "five 3.00 m dims". Measured precisely at BOTH d868ec3 and B's
tree 547d4a0 (identical sets — the population did not move): the hard-only
family is **13 strings across 7 zones, 7 of them `3.00 m`** — the "five" was an
under-enumeration of the same mechanism family (the E7 four-vs-eight
precedent).

Returned (6 of 13) — each printed at 7.5 pt, inside the footprint, 0 ink
crossings (SG8 8.1):

| pack | zone | dim | spot |
|---|---|---|---|
| seeded | 130 IT/Server | 2.40 m H | t=0.35 |
| seeded | 137 Storage | 3.00 m W | t=0.35 |
| seeded | 144 Wellness | 3.00 m W | t=0.35 |
| seeded | 144 Wellness | 2.40 m H | t=0.20 |
| testfit | 200 IT/Server | 3.00 m W | t=0.65 |
| testfit | 200 IT/Server | 2.40 m H | t=0.20 |

Still suppressed (7 of 13), each with its per-candidate blocking row
(candidates in `DIM_LABEL_SPOTS` order; `hN`= N hard-ink boxes hit, `sN` = N
soft boxes hit, `extent` = label leaves its own line):

| pack | zone | dim | per-candidate blocking |
|---|---|---|---|
| seeded | 130 IT/Server | 3.00 m W | h6s0,h0s1,h1s0,h5s1,h6s0,extent×4 |
| seeded | 137 Storage | 2.00 m H | h7s0,h2s0,h2s0,h7s0,h7s0,h6s0,h7s0,h9s0,h8s0 |
| testfit | 207 Storage | 2.00 m W | h6s0,h2s0,h4s0,h6s0,h7s0,extent×4 |
| testfit | 207 Storage | 3.00 m H | h7s0,h3s0,h4s0,h7s0,h5s0,h3s0,h4s0,h6s0,h5s0 |
| dwg | 94 Storage | 3.00 m W | h5s0,h7s0,h7s0,h7s0,h7s0,extent×4 |
| dwg | 123 IT/Server | 3.00 m W | h6s0,h3s0,h3s0,h6s0,h6s0,extent×4 |
| dwg | 123 IT/Server | 2.40 m H | h7s0,h3s0,h3s0,h8s0,h6s1,h6s0,extent,h9s0,extent |

Every candidate for these lands on wall/door-swing ink or leaves the line —
these rooms are 2–3 m cells whose dim band is blanketed by swing envelopes and
wall bands. Printing there would trade D-Q's closure for a D-P regression;
suppression is the correct last rung. (Declutter was NOT relaxed.)

Also returned — soft-blocked dims for which a clear slide now exists, same
three properties held: seeded Collab 4.20 W (t=0.65 flip) and
Open Workspace 38.20 W (t=0.5 flip); testfit Collab 4.80 W (t=0.5 flip); dwg
OW(1) 14.40 W (t=0.8 flip), OW(4) 8.30 W (t=0.2).

## 3. Services labels — wide displacement instead of the floor

`roomLabelBoxes` (A.03/A.04) tries the wide strict sweep at the FULL-SIZE form
before any shrink rung (D3: displacement before damage; wrapping introduced
nowhere; strict-only, so the soft margin strips still block every candidate and
these sheets stay D-Q 0).

The three dwg labels at the ladder's floor, final sizes measured from the
delivered text layer (poppler cap-height 6.9375 pt = 7.5 pt type):

| label | pre-fix | post-fix |
|---|---|---|
| MEETING ROOM 2 (A.03 + A.04) | 6.375 pt | **7.5 pt**, leader |
| PRINT POINT 1 (A.03 + A.04) | 5.25 pt | **7.5 pt**, leader |
| PRINT POINT 2 (A.03 + A.04) | 6.375 pt | **7.5 pt**, leader |

Zero room-name strings below full size remain on any pack's A.03/A.04.

## 4. Digests — five moved, each individually justified

Method: op-level dump-diff (`--dump`) between the pre-fix tree (`f8cb7d7`,
scratch worktree, own render) and post-fix; **all five sheets viewed as
rasters before blessing** (S5 standard). Recorded per-sheet via `--why-sheet`
in `scripts/fixtures/drawing-set.baseline.json`:

* **seeded s4 (A.02)** `7215f367…→787aedf7…`: CABIN 1 + FOCUS ROOM 1 blocks (4
  strings) moved inside from the top margin; 6 returned dims (+6 text/+30 line
  ops, 897→927); tags re-nudged around the moved blocks.
* **dwg s3 (A.01)** `d850ca0b…→4ccff44b…`: OPEN WORKSPACE (4) + 6.6 m² moved
  inside; leader redrawn; op counts unchanged (6 diff lines total).
* **dwg s4 (A.02)** `c5f062bc…→a19dfa86…`: three blocks (6 strings) moved
  inside; 2 returned dims (+2 text/+10 line); tags re-nudged.
* **dwg s5 (A.03)** `f9d7afba…→55d63f8d…`: the three labels to 7.5 pt; E
  glyphs, LC tags and circuit polylines re-nudged around the new boxes
  (1857→1854 line ops).
* **dwg s6 (A.04)** `bf0106f8…→7605546c…`: same three labels to 7.5 pt (+1
  leader line, 2396→2397).

Check manifest: membership **byte-identical** to the committed pin (293 = 293,
zero gone, zero new) — scoped claim: measured by name-set diff of
`--manifest` output vs `scripts/fixtures/drawing-set.manifest.json` on this
tree. Not re-pinned.

## 5. Sabotage round (disposable worktree at `59f9601`, each mechanism cut in turn)

| sabotage | expected red | result |
|---|---|---|
| S1: label rungs back to plate bounds | SG8 8.2 | **RED** — seeded/A02 exactly the original 4 strings, same coordinates |
| S2: `wallFootprintOnSheet` → null (enabling transform) | SG8 8.2 | **RED** — 3 sheets (the shared helper also feeds the margin strips, so its loss reaches A.03/A.04) |
| S3: `DIM_LABEL_SPOTS` emptied | digest baseline | **RED** — exactly seeded s4 + dwg s4 |
| S4: services wide rung disabled | digest baseline | **RED** — exactly dwg s5 + s6 |

No sabotage left the suite green; there were no null results to report.
Falsification of the assertion itself: SG8 8.2 was watched RED at exactly 24
(4 sheets failing, every string named) on pre-fix artifacts before the fix ran.

## 6. Boards (this tree's own renders and server, port 5313)

Final sheet board, one clean uncontended run (`GATE_BASE=http://localhost:5313
node scripts/gates/sheets/run-all.mjs`), verbatim:

```
  SG1  Panel containment            PASS (216 checks)
  SG2  Plate confinement            PASS (24 checks)
  SG3  Label integrity              PASS (283 checks)
  SG4  Name uniqueness              PASS (36 checks)
  SG5  Board integrity              FAIL (32 checks, 6 failing)
  SG6  Determinism + independence   PASS (16 checks)
  SG7  Area identity (sheet == core) PASS (207 checks)
  SG8  String-ink crossing (D-P)    PASS (24 checks)
  drawing-set Sheet content digest         PASS (293 checks)
  8/9 passing                    615.5 s
```

**SG5 is RED-WITH-ROOT-CAUSE, and the cause is not this workstream.** Its six
failing rows are one event: inside SG5's inner G1–G11 board, **G10 (one-action
UX) missed its hard-coded 300 s artifact-completeness window** — the 43 s
walkthrough.mp4 takes ~6 min of wall clock to render+encode on this machine
today (measured twice: mp4 landed at ~348 s and ~360 s after the click, with
three sibling worktree missions running their own boards concurrently) — and
G8 (web viewer) plus the integrity/board-green rows cascade from that one
red. The pack itself is COMPLETE and valid: the runner's own closing pass
printed `walkthrough.mp4 58898044 B … 43.00s · unchanged since G10 produced
it; PASS (12 checks)`. Scope evidence that W3 cannot be the cause: G10's one
action drives `web/src/export/deliverablePack.ts`, whose imports are
qtoWorkbook / roomRenders / walkthrough / share / mp4 — neither `sheetSet.ts`
nor `servicesSheets.ts` is on that path, and none of G10's ten pack artifacts
is a drawing-set file. Every gate whose subject W3 touched — SG1–SG4,
SG6–SG8, the digest test — is green. (The earlier SG5 red on the interim
board additionally had `GATE_BASE` unset, so its inner board died on the
foreign-server preflight for port 5173 — also not a content failure.)

`drawing-set.test.mjs` PASS 293. SG8: 0 crossing + 0 outside on all 12 plan
sheets. Web-side tests exercising the changed modules: publishedArea 3764
checks green, printLabels / roomrefs / legendParity / report / workbook /
coreParity / fonts all PASS (exit 0).
