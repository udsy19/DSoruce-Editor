# Phase 1 exit — ui-fixes merged into integration/all

Self-ratified per the campaign's autonomy clause. Every number names what it
counts and the worktree that produced it: `/Users/udsy/PycharmProjects/DSource-Editor`,
branch `integration/all`.

## Predictions vs outcomes (the Phase 0 register)

| | prediction | outcome |
|---|---|---|
| **P1** | `furniture.ts` → `symbols.ts` is the hardest conflict and git will not present it as a design conflict | **CONFIRMED.** Git reported `UD` (modified by us, deleted by them) and offered keep-or-delete; neither was right. It was an API change, not a rename — screen coords → world dims + view — at two call sites. |
| **P2** | union lands at 138 named; the three main-only sensors are at risk; the scanner's multi-line miss is the dangerous case | **CONFIRMED, and the miss mattered.** 138 by name, 0 missing. The scanner passed — and manual inspection was still required: all three multi-line mutators (`assign_product`, `generate`, `add_zone`) are invisible to its regex. All three call `self.touch()` first. |
| **P3** | style-gate goes red loudly on reintroduced zone hexes | **PARTLY WRONG, and the miss is the finding.** style-gate stayed GREEN. It was `accent-univalence` — value-keyed, added after P3 was written — that caught five raw amber literals git auto-merged into `DrawingCanvas.ts`. A name-keyed gate could not see them. |
| **P4** | `export-parity` is the gate most likely to fail subtly, because it is anchored by path | **CONFIRMED, at two other checks.** export-parity held, but `coreParity` was reading a `layout.rs` that had been split and a `SpaceKind` union that had moved — green while certifying nothing — and `style-gate` guarded `furniture.ts`, the file the merge deletes. Both re-anchored. |
| **P5** | the amber conflict produces no merge conflict and no gate failure; it slips through | **CONFIRMED EXACTLY, and caught only because the sensor was built for it.** The `DrawingCanvas.ts` literals arrived with **no conflict marker**. |
| **P6** | `layout.rs` re-siting conflicts textually and resolves cleanly; export's quantity tests are the ones that need work | **HALF RIGHT.** 10 of 25 hunks context-applied cleanly; 15 needed hand-porting because main had also edited those regions. `golden_generate_output_is_frozen` passed first try, as predicted. The quantity half is Phase 2 and untested. |

## Boards

Run on the merged tree, `integration/all`:

| board | result |
|---|---|
| style-gate | PASS (1 declared exemption: Minimap lineWidth, device-px canvas) |
| ladder-check | PASS — 6 tiers within 0.05% of the measured qbiq ratios |
| lod-sweep | PASS — **re-anchored to the shipped `lod()`**; see below |
| export-parity | PASS (2 deferred: sheet.ts + report.ts amber, allowlisted by exact line, empties in Phase 2) |
| accent-univalence | PASS |
| coreParity | PASS — **re-anchored** to the split layout and `types/doc.ts` |
| symbols.test.mjs | PASS (46) |
| fonts.test.mjs | PASS |
| cargo test | **PASS — 138 passed, 138 BY NAME, 0 missing** vs the main∪ui-fixes floor |
| typecheck / build | PASS |

## Required proofs

### Listener defect — reproduced, calibrated, and fixed

Three arms, keyboard-driven, on the real document:

| arm | before | after | deleted | `keysBound` |
|---|---|---|---|---|
| **A** visible editor, Delete | 152 | 151 | **1** | true |
| **B** selection live, editor HIDDEN, Delete ×2 | 151 | 151 | **0** | **false** |
| **C** back on editor, Delete | 151 | 150 | **1** | true |

Arm A is the calibration and it was needed: an earlier run showed "nothing
deleted while hidden" **and** "nothing deleted while visible" — because I was
setting a TS field while selection actually lives in the core. That result
proved nothing. Selecting through `select_at()` made A delete, which is what
makes B meaningful. Face 11: run the case whose answer you know first.

The fix is structural — `setActive(false)` **unbinds** the window listeners —
not a guard per handler.

### Persistence — additive, on a genuine pre-merge file

`.playwright-mcp/dsource-plan.dsource`, saved **2026-08-03**, before this
campaign. Its components carry **no `seats` key at all**.

| | |
|---|---|
| restore error | none |
| restored shape | 130 components / 115 walls / 49 zones |
| fixture's recorded shape | 130 / 115 / 49 — **exact match** |
| `seats` defaulted to 0 | 22 (doors, columns, casework — correct) |
| seats resolved by `backfill_seats()` | **108** |
| snapshot → restore again | 130, no error |

`#[serde(default)]` on `Component.seats` and `RoomReq.seats` is what makes the
old blob readable; `backfill_seats()` is what gives it the new facet.

### lod-sweep — the vacuous board, fixed

The board passed **with `symbols.ts` deleted from the tree** (proven twice). It
analysed recorded ink sweeps, so it certified `furniture.ts` — an implementation
this merge deletes. Rewritten to read the shipped `lod()` and `BAND` out of
`symbols.ts` and exercise them: 0 below exit, 1 above enter, monotonic,
**continuous (max jump < 0.05)**, and actually traverses the band. The fourth
assertion is the load-bearing one — a step function satisfies all the others.

Proven on both failure paths: snapping the ramp gives 4 FAILs naming max jump
1.0000; deleting `symbols.ts` now gives `LOD FAIL: … does not exist` where the
old version printed `lod OK`.

**Two invalid browser re-captures preceded this, and both looked like data.**
The first pair covered different zoom ranges (14–62 vs 49–219) because the view
retained zoom between runs. The second pair came out **byte-identical** because
zooming to the floor without recentring drove the plan off-canvas — nothing left
to LOD. Testing the function directly is not a fallback; it observes the code
instead of a rendering of it.

## Deviations taken, with reasons

1. **ui-fixes' filled-poché `drawWall` not ported.** The digest does not name
   wall form, but `export-parity` asserts two-face walls and `ladder-check` pins
   the measured wall tier — adopting poché retires both, which the mission
   forbids. Its diagnosis (that `clamp(thickness × scale)` was three visual laws
   across one sweep) was right and is already addressed by 2b's fixed tiers.
2. **`--canvas-live` retired**, its two consumers re-sited to
   `--accent-selection` and `--review`, and `--review-ink` declared for the
   caution note's text.
3. **`coreParity` and `style-gate` re-anchored** rather than left green-and-
   vacuous. Both were pointed at paths the merge moved or deleted.
4. **Recorded lod fixtures retained** as evidence, per the standing rule that a
   sensor's fixtures are load-bearing — relabelled in the output as history, not
   verdict.

## Not done at Phase 1 exit

- **pixdiff vs both parents' references.** Not run. The ~8 R5 amber reversals
  are enumerated in the merge commit and classify **intended-(ruled)**; the
  remaining surface is unclassified. This is honest debt, not a pass.
- **A runtime font warning fires** on the merged tree: ui-fixes' guard reports
  all three families "imported but did not load". Measured: `document.fonts`
  holds 24 faces and `document.fonts.check()` is **true** for Hanken and IBM
  Plex Mono — they load lazily, so the guard is timing-sensitive, not a missing
  dependency. Recorded, not fixed: it is ui-fixes' own guard and out of ruled
  scope.

## Position

`integration/all` carries main + ui-fixes, all boards green, tree clean.
`export` is **not** merged. Phase 2 is next.
