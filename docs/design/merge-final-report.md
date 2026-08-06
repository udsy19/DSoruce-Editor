# Three-branch integration — final report

`main` × `ui-fixes` × `export` → one green tree.

Phase detail lives in `merge-audit.md` (Phase 0), `phase1-exit.md`,
`phase2-exit.md`. This is the closing account: what the campaign actually
proved, what it got wrong on the way, and what it is leaving open.

## Result

| | |
|---|---|
| G1–G12 | **12/12, 1034 checks**, twice green (G12 = SG1–SG6 at 603) |
| Rust | **157 passed, 157 BY NAME** |
| bench boards, symbols (46), fonts, drawing-set (322), typecheck | all green, twice |
| working tree | clean |

`bash scripts/gates/run-all.sh` is the only trusted signal, and it **must** be
given `GATE_BASE` pointing at a server for this tree. During this campaign the
pre-flight refused a foreign worktree three times, including once when a server's
cwd had drifted to `/`.

## The six predictions, scored

Written before the merge, in `merge-audit.md`. Scoring them is the point of
having written them.

| | outcome |
|---|---|
| P1 `furniture.ts` is the hardest conflict, and git will not present it as a design conflict | **CONFIRMED** — git offered keep-or-delete; it was an API change (screen coords → world dims + view) at two call sites |
| P2 union lands at 138 named; the scanner's multi-line miss is the dangerous case | **CONFIRMED, and the miss mattered** — the scanner passed and manual inspection was still required |
| P3 style-gate goes red loudly on reintroduced zone hexes | **WRONG, informatively** — style-gate stayed GREEN; `accent-univalence`, value-keyed, caught five raw literals git auto-merged with **no conflict marker** |
| P4 `export-parity` is the gate most likely to fail subtly, because it is anchored by path | **CONFIRMED, at two other checks** — and then AGAIN in Phase 3, at a third (`sheetlib`) |
| P5 the amber conflict produces no conflict and no gate failure; it slips through | **CONFIRMED EXACTLY** |
| P6 `layout.rs` re-siting conflicts textually and resolves cleanly | **HALF RIGHT** — 10 of 25 hunks applied; 15 needed hand-porting |

P4 is the one worth reading twice. It was written about `export-parity`, held
there, fired at `coreParity` and `style-gate` in Phase 1, and fired a **third**
time in Phase 3 at `sheetlib` — inside the very commit whose subject line was
"both gate anchors move in the same commit". A prediction that keeps being right
in places you did not aim it is describing a property of the system, not an
incident.

## What the campaign got wrong, in order

Kept because the corrections are the substance.

1. **Two escalations whose reasoning did not survive contact with the code.** The
   chairs escalation made three claims about `symbols.test.mjs`, G11 and the
   export branch; all three were false. The R5.2-vs-G7 escalation described a
   board assertion that did not exist. Both were resolved by the user reading the
   tree rather than the report.
2. **An edit script that printed success on zero replacements, twice.** Now a
   permanent section in `gate-independence.md`: assert the anchor exists BEFORE
   replacing and re-read the file AFTER writing. Every scripted edit in Parts C
   and D carries `assert old in s` and a post-write read-back.
3. **Two ASCII pixel maps built with stride 4 against a 3-byte buffer.** They
   looked like data. Discarded, not reasoned from → Face 19.
4. **A confounded adversarial experiment**: two defects planted at once, so the
   first result attributed SG2's failure to the wrong cause. Separated into arms.
5. **Four Vite servers sharing one `node_modules/.vite`** fought over dep
   optimization and rendered blank pages. My harness, not the branches — the same
   shared-state family as worktree false-green.
6. **A `pdf.ts`-consumer grep with the wrong path pattern** briefly suggested
   `pdf.ts` had zero importers. Retracted on measurement.

## Two decisions worth defending

### The pixdiff debt was closed with a different instrument, deliberately

The debt (carried from Phase 1) was "pixdiff vs both parents' references". It was
closed **unevenly on purpose**:

- **vs `export`, on the deliverable plan: done, and it is the strong result.**
  4.38 % of pixels differ on an identical document (97 walls / 206 components /
  24 zones), and the diff image localises **every** changed pixel to furniture
  glyphs and door swings. Walls, zone fills, room labels and the core are
  untouched. That is the exact footprint of R2 replacing `furniture.ts` with
  `symbols.ts` → intended-(ruled).
- **vs `main` and `ui-fixes`, on the UI: NOT done as pixels, and here is why.**
  Neither branch carries `render-plan.mjs`, so there is no comparable artifact.
  The R5 amber surface lives in editor chrome that needs identical interaction
  state on branches whose generators differ — the measurement would have been
  dominated by intended differences and could not have isolated drift. A number
  produced that way would have been decoration.

  So the same question was answered **exactly** instead: every amber-valued site,
  by VALUE in all three encodings (`#e8a13c`, the decimal triplet, `0xe8a13c`),
  enumerated per branch.

  | branch | amber-valued sites |
  |---|---|
  | main | 15 |
  | ui-fixes | 22 |
  | export | 38 |
  | **integration/all** | **10** |

  All 10 are **3 declarations + 7 explanatory comments. Zero use sites.** The
  removed sites reconcile against the campaign record: ui-fixes' five in
  `DrawingCanvas.ts` (P5's no-conflict-marker literals), export's `sheet.ts` +
  `report.ts` pair (the paper-invariant allowlist Phase 2 emptied), and the
  Viewer3D / theme / Minimap / ViewerToolbar / LibraryPanel / CandidateGallery
  tokenisations.

  This is stronger evidence than a pixel count, on the specific question asked.
  It is **not** a general substitute: it says nothing about layout, spacing or
  any non-amber colour. That surface remains unmeasured across `main` and
  `ui-fixes`, and is stated here rather than implied to be clean.

### The canvas double-draw is recorded as a MISSING SENSOR, not a closed bug

`paint.ts` drew a second implied chair under every desk for the whole of Phase 2.
No gate saw it, because G11 grades the delivered pack and the editor canvas is
not in the pack. It was found by a hand-written seats/QTO cross-check — which is
the honest way to say *found by luck*.

Fixing it closes the instance. The class stays open, and is filed in ADR 0005's
trigger/sensor table as **OPEN** rather than quietly satisfied by the fix that
happened to catch it once.

## Four new faces (ADR 0005 → twenty)

17. **A red gate accuses the PRODUCER — verify the accusation.** Twice in one
    campaign the accuser was wrong (SG2's linework; the fonts guard's implied
    weight 400).
18. **A fix relocates a defect; order remedies by what survives.** E7 in three
    stages: labels-over-furniture → labels-over-labels → names drawn 0×.
19. **An unchanged measurement is evidence about the instrument first.** The G11
    falsification's byte-identical run meant the wrong flag had been flipped.
20. **A refactor's blast radius includes every CHECK that reads the file.** The
    split commit moved two anchors, proved the move load-bearing, and missed a
    third.

## Landing

`integration/all` → `main` as a merge commit. Branch deletion is
**ancestry-proven**: `git merge-base --is-ancestor <branch> main` must succeed
before `git branch -d` (never `-D`), so no branch is deleted whose commits are
not reachable from main. `backup/main-premerge` and `backup/export-premerge`
exist; **`ui-fixes` has no backup branch**, which is precisely why the ancestry
proof is the gate rather than a formality.

## Left open, deliberately

- **The 13-step manual walkthrough** (`docs/design/manual-session.md`) — a human
  task on main. No agent substitution is valid.
- **No sensor watches the editor canvas for unbilled seating** (above).
- **G11's attribution weakness** — measured (implied seating lifts p25 by 0.24;
  no billed instance depended on it, worst 1.52 vs a 0.70 floor), left open.
- **Non-amber UI surface vs `main`/`ui-fixes`** — unmeasured, as stated above.
- **dwg A.02's four 0.15 m windows** — imported/conformed geometry, pre-existing.
- **Three semantics on one amber band** (`docs/ROADMAP.md`, "Post-merge") — a
  perceptual question no value-keyed sensor can raise.
