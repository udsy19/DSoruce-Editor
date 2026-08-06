# FINAL — DSource → qbiq output parity

**Board: 11/11 gates, 443 checks** (431 gate + 12 integrity), reproduced on consecutive runs against
the artifacts the product's own one-click action produced. 150 Rust tests, clean typecheck, clean
`pnpm build`. Judge round 3 verdict: **shippable, no blocker.**

Only `bash scripts/gates/run-all.sh` is a trusted signal. This document exists because, twice, it
said 10/10 while the product was wrong.

---

## 1. What was built

| Deliverable | Where | Evidence |
| --- | --- | --- |
| **12-sheet formula-wired QTO workbook** | `web/src/export/qtoWorkbook.ts` | G1 (59) · G2 (17) · G3 (92) · G9 (24) |
| General SpreadsheetML writer | `web/src/export/workbook.ts` | `workbook.test.mjs`, openpyxl + LibreOffice recalc |
| Core quantity truth + wall classification | `crates/ds-core/src/quantity.rs` | 150 Rust tests |
| Highlighted plan + room thumbnails | `export/planGraphic.ts`, `roomThumbs.ts` | G4 (18) · G5 (70) |
| Four 4K room renders | `export/roomRenders.ts`, `three/interiorStill.ts` | G6 (53) |
| Walkthrough video | `export/walkthrough.ts` | G7 (19) |
| Shareable web 3D viewer | `web/viewer.html`, `deploy/shareStore.ts` | G8 (9) |
| One-action deliverable pack | `export/deliverablePack.ts`, `export/mp4.ts` | G10 (14) + integrity (12) |

One `Editor` state feeds every artifact. Shared sources, so drift is structurally impossible rather
than merely checked: `palette.json` → `qbiqPalette.ts` (plan lines **and** workbook legend chips **and**
render materials); `FINISH_SPEC`/`finishTypeFor` → Inventory materials **and** render floors;
`roomTypeLabel` → every sheet's room type; `planRoomList` → the plan labels **and** the Inventory rows.

## 2. Evidence per gate

| Gate | Checks | The assertion that matters |
| --- | ---: | --- |
| G1 sheet structure | 59 | 12 sheets in qbiq's order, gridlines off, logo on 11, legend strings + chip fills |
| G2 formula liveness | 17 | **100% density (300/300)**; +1000 on a `General` price → total moves by exactly 1000 × 2.60 × 158.70 via LibreOffice recalc |
| G3 quantity truth | 92 | wall length/type ≤1 cm, exact door counts, room m² ≤0.01, sqf = m²×10.764, every Room ID appears once in the plan labels |
| G4 plan graphic | 18 | circulation/drywall/glass pixels, legend chips == palette exactly, byte-identical re-render, **facade drawn ⇔ facade billed (±15 pt)** |
| G5 thumbnails | 70 | one 240×180 per Inventory row in column B; rooms distinct |
| G6 renders | 53 | 4×≥1920×1080; **gate-segmented** floor matches the Inventory finish; ground ≥15% of frame, band coverage ≥60%; pairwise dHash > 10 |
| G7 video | 19 | h264 1080p ≥30 fps, 30–45 s; **dense sweep of all 43 s**; title-card logo |
| G8 web viewer | 9 | `/share/:id` 200, WebGL canvas, >5% non-background, walk toggles |
| G9 round-trip | 24 | three independent inputs pass G1–G5; zero LibreOffice repair warnings; cases fail if staler than the generator's 64-file import closure |
| G10 one-action UX | 14 | one click → all 10 artifacts, each asserted **complete** (mp4 decodes, xlsx has an EOCD, PNGs an IEND) |
| G11 furniture agreement | 56 | per room, the workbook's furniture multiset == one the gate **re-derives from core state**, AND every billed instance is **visible** in the delivered PNG (ink-per-outline ≥ 0.70) |
| integrity | 12 | the graded pack is byte-identical to what G10 produced |

## 3. The central finding

**Two of three Judge rounds found BLOCKERS against a 10/10 board, and both were defects in a GATE,
not the product.** Every one was proven by falsification — building a deliberately wrong artifact
and showing the gate still passed.

The recurring root cause, three times: **the gate trusted metadata supplied by the thing it tests.**
1. The producer chose *whether* its floor was checked — omit `floorMaterial`, G6 skipped. Magenta
   floors: `G6 PASS (13 checks)`.
2. Made unconditional, the producer instead chose *where* — `floorRect` was still its own. Paint the
   bottom 34%, pick a legal crop above it: `G6 PASS (35), 4/4 MATCHES`, sampling a slat wall. **Live,
   not theoretical**: the shipped `Conference_room` recorded `floorRectPurity: 0.0` and was certified
   "carpet under shadow" under two green boards.
3. Fixed at the class level: G6 now segments the image itself (bottom-row-seeded, gradient-limited
   flood fill) and reads no producer metadata. Proof: moving every `floorRect` onto a wall **and**
   deleting the field give **byte-identical** gate output.

**Corollary:** structural gates verify presence, not correctness. Four separate agents found real
defects by *looking* at output every gate waved through — a 1040×780 plan rendering as a **19×3 px
smudge**; video frames breaching **G7's own luminance ceiling**; a **mullion through the conference
table** (camera 1.25 m outside the room); and the workbook billing **Reception as a "Kitchen"**.

## 4. Defects found and fixed (17 + 10 across three rounds)

Blockers: D1, D2, E1 (above). Majors fixed: renders↔takeoff vocabulary; the runner grading a pack
G10 then replaced; **14 of 18 rooms carrying two different types**; chairs drawn but unbilled (~50+);
`headcount` inconsistent across identical rooms (root cause: `zone_index_at` took the *last*
containing zone, so the plate-spanning Workspace field swallowed each room's furniture); a solid
facade (`glaze_facade` → **123.20 m** vs the reference's 125.47 m); the video's blank tail and
opening; G9 inputs 27 minutes stale under two green boards; G6 certifying 41% of a repainted frame;
G6 accepting a duplicated render; G4 passing with all 11,676 window pixels deleted; and **E7** — the
plan billing furniture it did not show.

**E7 is the clearest illustration of why gate-before-fix matters.** The reported cause (a symbol
library skip-drawing unknown types) was wrong: `drawFurnitureSymbol` already has a `default:` case
stroking a footprint at true W×H, so emission was never the problem — the gate confirmed it at
**189/189**. The furniture was *drawn and then painted over*: room-ID labels render last with a 4 px
halo and `placeNear` de-collided them against other labels only, never furniture ink. At 23.75 px/m a
0.5 m chair is 12 px, smaller than the label on top of it. A count-exact emission gate would have
passed while the defect persisted, so G11 also asserts **visibility in the delivered pixels** — and
that assertion, calibrated on 552 instances across three packs, named **eight** occluded rooms where
the hand-written defect report had found four.

## 5. Known open — stated, not hidden

- **Renders are the weakest deliverable**: ~2.0× the reference's flatness, 0.43× its edge density.
  **Routed, not deferred**: this needs a richer 3D asset library, which makes it a candidate-evaluation
  problem for the materials/rendering bake-off track, with fixture targets pre-registered in
  `docs/ROADMAP.md` *before* candidates run. Fixing it ad hoc here would short-circuit that evaluation
  and manufacture a post-hoc metric. `Conference_room` is a **program-fit** problem — a 2.9 m table and
  8 chairs in a 5×4 m room — so it scores against the generator's furnishing rules, not the renderer.
- **Video**: 3.2× less bitrate than the reference; a 40.4%-blown frame at t=22.2 that G7 cannot see.
- **Only 3 of 4 renders evidence their floor**, with zero headroom; the camera that fixed
  `Conference_room`'s composition is what cost the fourth.
- **Gate limits — measured, and ACCEPTED as a ruling, not left as debt** (`reports/P-1.md`): a
  ≤21%-of-frame mid-band repaint survives G6 (down from 41%); above the horizon clamp is unmeasured;
  G4 tolerates *erasing* ~50% of window pixels; G6 proves distinctness, not room identification.
  **Deliberately not pursued further.** The threat model is regression and drift in our own code, not
  a producer forging outputs. Perceptual gates that catch a plan collapsing to a 19×3 px smudge, or a
  render going black, are doing their job; making them forgery-proof is a security posture this
  problem does not call for. The producer-metadata class was in scope precisely because it was *not*
  an adversarial edge case — the gate was structurally measuring nothing.
- Headless-vs-in-app divergence: `render-rooms.mjs` passes `--lamp 2`, `deliverablePack.ts` none.
- On the DWG case, a component outside every zone bills to an `"OS"` catch-all with no Inventory row.
- Round-1 minors D6, D10, D12–D17; round-2 E8–E10.

Two approaches were **built, measured and rejected** rather than shipped: a whole-frame foreign-colour
sweep (flags the monitor screens — `palette.json` is qbiq's palette, not an inventory of what we draw)
and a "straight top edge" proxy (3–51% real vs 34–62% forged — not separable).

## 6. Deviations from the brief, all deliberate

1. **`docs/reference/qbiq/`**, not a new `reference/qbiq/` — the tree already existed (no-bloat).
2. **No exceljs.** The repo hand-writes every exporter; extending `workbook.ts` kept the export
   client-side and one-action. A Python/openpyxl step was rejected outright — it forces a server
   round-trip. The two-strike tripwire never fired.
3. **Core colour `#A0A0A0`** — the reference contradicts itself (its legend chip `#D5BDD6` appears
   zero times in its own plan).
4. **Title card kept** though qbiq has none — §4 and G7 both require it.
5. **sqf = 10.764** (the brief's literal, stated twice); qbiq uses 10.76.
6. **Circulation % normalised against the plate**, not the 71%-transparent canvas.
7. **Agent B split into B1/B2/B3**, and D→E→F sequenced rather than parallel, after the writer was
   found to be missing seven capabilities and D was found to own the shared material theme.
8. **G7 hardened mid-mission** to sweep all frames (it sampled 3 of 1290 and missed a breach of its
   own ceiling). Strengthening, documented here rather than done silently.

Side-by-side pack: **`out/parity/`** (see its README for the measured comparison).
Full history: `reports/ORCHESTRATOR_LOG.md`. Defects: `reports/defects-{1,2,3}.md`.
