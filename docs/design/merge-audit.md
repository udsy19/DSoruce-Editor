# Merge audit — main × ui-fixes × export

**Phase 0 of the Three-Branch Integration campaign. No tree has been merged.**
Every number below names what it counts and which worktree produced it.

Measured on `main` @ `869d652` unless stated.

---

## 0. Corrections to the campaign brief

Four of the brief's premises do not survive measurement. Recorded first, because
later phases are scoped by them.

| brief says | measured | consequence |
|---|---|---|
| run `scripts/verify-preflight.sh` | **does not exist on `main`.** It lives on `ui-fixes` (`scripts/`, 2 files). `main` has no `scripts/` directory at all. | §1 executed manually; the script arrives with the Phase 1 merge |
| diff "the Laiout hex adoptions between main (2e) and **ui-fixes (slice 5)**" | **`ui-fixes` has no Laiout adoption and no `planStyle.ts`.** Its slices 5a/5b are typography (IBM Plex Mono) + the amber question. | there is no palette *reconciliation*; there is a palette **conflict** — see §5 |
| "the stale 19-files figure" | superseded, and by more than expected: **main ∩ ui-fixes = 40**, main ∩ export = 20, ui-fixes ∩ export = 18, all three = 11, **56 distinct** files touched by 2+ branches | Phase 2's "19-both-sides files" list must be re-derived, not reused |
| boards "G1–G12 … GSELF proving itself" | **G12 and GSELF do not exist on `export`.** Present: `g1`–`g11` (11 board scripts) + `sg1`–`sg6` (6 sheet boards) + `lib/` + two `run-all` drivers | Phase 2/3 exit criteria should read G1–G11 + SG1–SG6, or the missing boards must be produced |

`gate-independence.md` is already on `main` (`869d652`), as the brief states —
that commit is on main but was authored after this session's Campaign-4 work.

---

## 1. Preflight

`scripts/verify-preflight.sh` exists only on `ui-fixes`, and derives its notion
of "this worktree" from `dirname($BASH_SOURCE)/..`, so it cannot run from a tree
without `scripts/`. Its three assertions were executed manually against this
worktree's dev server:

```
1. listening on :5210  -> pid 34558
2. listener IS this worktree -> /Users/udsy/PycharmProjects/DSource-Editor/web
3. served module contains the identifier 'planStyle' -> current code
```

Cross-checked with `main`'s own instrument, `bench/assert-build.mjs`:

```
provenance OK — http://localhost:5210
  root   /Users/udsy/PycharmProjects/DSource-Editor
  commit 799f620b vs HEAD 869d6520
```

Both agree the worktree is this one. (The commit delta is expected and reported
as info: a dev server serves working files, not a commit.)

**Finding — two instruments, one failure mode.** `ui-fixes`'
`verify-preflight.sh` and `main`'s `bench/assert-build.mjs` were built
independently, in different campaigns, against *the same* defect: a
`vite --strictPort` server from another worktree answering normally while
serving another branch. Both comment on it in almost the same words. They differ
in mechanism, and **ui-fixes' is stronger**: it checks the listening PID's cwd,
which works with no cooperation from the app, whereas `assert-build.mjs` needs
the page to carry meta tags a foreign build may not emit. The merge should give
this one owner rather than shipping both. Proposed: keep the PID-cwd check as
the primary assertion, keep the commit/root meta as reporting.

---

## 2. Measured conflict surface

Merge-bases — all three pairs, and the octopus base, are **the same commit**:

```
main..ui-fixes    e1c8740
main..export      e1c8740
ui-fixes..export  e1c8740
octopus           e1c8740
```

A clean three-way star: no branch has merged another, so there is no hidden
prior reconciliation to account for.

| branch | tip | commits since base | files touched |
|---|---|---|---|
| main | `869d652` | 60 | 240 |
| ui-fixes | `545635a` | 26 | 130 |
| export | `f62dd1a` | 24 | 152 |

| intersection | files |
|---|---|
| main ∩ ui-fixes | **40** |
| main ∩ export | **20** |
| ui-fixes ∩ export | **18** |
| all three | **11** |
| distinct, touched by ≥2 | **56** |

### All three (11)

```
CLAUDE.md                        docs/ROADMAP.md
crates/ds-core/src/layout.rs     web/src/App.tsx
crates/ds-core/src/lib.rs        web/src/editor/furniture.ts
web/src/styles.css               web/src/wasm/ds_core.d.ts
web/src/wasm/ds_core.js          web/src/wasm/ds_core_bg.wasm
web/src/wasm/ds_core_bg.wasm.d.ts
```

Four of the eleven are generated (§6), leaving **seven real three-way files**.

---

## 3. Semantic-overlap classification

Every intersected file is classified. No `unknown` remains.

### Semantic — covered by R2 (the hardest conflict in the merge)

| file | why |
|---|---|
| `web/src/editor/furniture.ts` | **delete/modify from two directions.** `ui-fixes` DELETED it and introduced `web/src/editor/symbols.ts` + `symbols.test.mjs`. **`main` and `export` both still have it and both modified it** — main heavily (2c continuous LOD, ladder tiers, crossfade). Neither main nor export has `symbols.ts`. R2 rules the outcome (symbols.ts owns; furniture.ts stays deleted; main's LOD behaviour merges in), but the *work* is a port of two branches' edits into a module that exists on neither. |

### Semantic — covered by R1

| file | why |
|---|---|
| `web/src/styles.css` | three-way. main added `--accent-amber*`, `--danger-deep*`, deleted 14 dead `--zone-*`; ui-fixes migrated ~6 components from inline styles to classes; export added qbiq palette surfaces. R1: product UI = main's grammar, export modules = qbiq. |
| `web/src/export/pdf.ts` | main ∩ ui-fixes. main routed it onto `planStyle` (`PRINT` inks, `PRINT_ZONE_FILL` derived from `ZONE`, two-face walls, ZONE KEY). R1 explicitly requires resolving this file to exactly one mode or splitting it. **It currently serves both** — `renderPrintCanvas` feeds the A3 sheet *and* `servicesSheets`/`sheetSet`. Expect a split. |
| `web/src/export/report.ts`, `sheetSet.ts`, `servicesSheets.ts`, `finishSchedule.ts`, `takeoff.ts` | export-owned deliverables; R1 assigns them the qbiq palette + the path-scoped style-gate allowlist. |
| `web/src/editor/stats.ts` (ui-fixes/export side) | holds `ZONE_META`; on main this was reduced to labels-only with colours spread from the table. Merge must not reintroduce the copy. |

### Semantic — NOT covered by R1 or R2 → **escalation, see §5**

| file | conflict |
|---|---|
| `web/src/ui/LibraryPanel.tsx`, `web/src/ui/CandidateGallery.tsx` | amber vs blue on the same elements — two ratified, opposite rulings |
| zone palette + semantic flip (`EditorCanvas.ts` on ui-fixes/export vs `planStyle.ts` on main) | arguably R1 ("canvas obeys main's visual grammar") decides it; recorded as **R1-covered but worth confirming**, because it silently discards ui-fixes' and export's palette assumptions app-wide |

### Semantic — same problem solved twice

| file / thing | detail |
|---|---|
| worktree false-green | `verify-preflight.sh` (ui-fixes) vs `bench/assert-build.mjs` (main) — §1 |
| dead `var(--accent, #E8A13C)` fallbacks | **both branches independently found the same defect** — §5 |

### Textual-only

`CLAUDE.md`, `docs/ROADMAP.md`, `.gitignore`, `.claude/rules/gate-independence.md`,
`web/package.json`, `web/vite.config.ts`, and the remaining `web/src/**` files
(AI modules, shell steps, three/, import/, persist/) — additive edits in
different regions. Expect textual conflicts, not design conflicts.

### Rust core

`lib.rs`, `layout.rs` are three-way; `model.rs`, `document.rs`, `cost.rs`,
`circulation.rs` are ui-fixes ∩ export. main decomposed `layout.rs` into stage
submodules; ui-fixes and export both edited the pre-decomposition file. Same
re-siting problem as EditorCanvas, one layer down.

---

## 4. Test inventory — the floor

Rust, by running `cargo test -p ds-core` **in each branch's own worktree**:

| branch | worktree | passing |
|---|---|---|
| main | `/Users/udsy/PycharmProjects/DSource-Editor` | **134** |
| ui-fixes | `~/.superset/worktrees/DSource-Editor/ui-fixes` | **135** |
| export | `~/.superset/worktrees/DSource-Editor/export` | **150** |

By **name**, not count (`cargo test -- --list`):

- **union floor = 157 named tests** — 7 above the largest single branch.
- branch-unique: main **3**, ui-fixes **4**, export **19** (= 26; 134+4+19 = 157 ✓).

main-only (all three are this session's sensors):
```
layout::tests::golden_generate_output_is_frozen
tests::every_mutator_bumps_the_revision
tests::revision_advances_on_mutation_and_holds_still_on_reads
```
ui-fixes-only:
```
layout::tests::briefed_room_seats_match_the_brief
model::tests::backfill_resolves_seats_on_an_old_document
model::tests::seats_are_a_property_of_the_object
model::tests::seats_defaults_to_zero_on_old_snapshots
```
export-only: 19, all in `quantity::tests` (13) and `layout::tests` (6) —
wall classification, headcount, glazing, chair accounting.

Other suites:

| | main | ui-fixes | export |
|---|---|---|---|
| `*.test.mjs` files | 25 | 24 | 23 |
| `bench/*.mjs` gates | **10** (5 standing: style-gate, ladder-check, lod-sweep, export-parity, assert-build) | 0 | 0 |
| `scripts/gates/` | 0 | 0 | **27 files** — g1–g11, sg1–sg6, lib/, 2 run-all drivers |

**No branch's suite is a superset of another's.** The merged tree owes all three.

> **RETRACTED (R12) — "5 standing" counted files, not invocations.** Of the five
> named, only `style-gate` was invoked by any runner; `ladder-check`, `lod-sweep`
> and `export-parity` were invoked by none, and `assert-build` is a manual
> preflight that takes a URL and cannot stand on a battery at all. "Standing" is a
> claim about a runner, and the audit derived it from `ls`. The three are now
> wired into `scripts/verify-all.sh`; `assert-build` is exempted by name in
> `scripts/gates/reconcile.mjs`, which fails if it ever stops requiring its URL.


---

## 5. Palette reconciliation — a conflict, not a reconciliation

The brief asks for a value-by-value diff of two Laiout adoptions. **Only one
exists.**

| | main `planStyle.ts` | ui-fixes `EditorCanvas.ts` |
|---|---|---|
| Circulation | `#d8d8d8` / `#8b8b8b` *(and unfilled — ground)* | `#dcebfb` / `#4a82c4` |
| Workspace | `#d9e7f4` / `#487cad` | `#fbf3d6` / `#b99527` |
| Meeting | `#eae4f6` / `#6b4ca8` | `#e9e3f7` / `#7e63c0` |
| Core | `#d1f1d5` / `#49ab56` | `#eceef1` / `#8b939e` |
| Amenity | `#faf4de` / `#bea137` | `#d9f0ef` / `#3f9c95` |
| Collaboration | `#fae0c3` / `#c87f2d` | `#def1e2` / `#4b9e66` |
| ClosedOffice | `#f6dadf` / `#b14356` | `#fce6d6` / `#cb8150` |

**Zero values in common.** ui-fixes carries the pre-2e palette *with the
pre-flip semantics* — its blue is Circulation, main's blue is Workspace. This is
not drift between two adoptions of one source; ui-fixes never adopted.

R1 decides it (canvas obeys main's grammar), and the merge must also carry
main's *structural* palette work or it regresses: ui-fixes and export both still
hold zone colours in `EditorCanvas.ts`, `stats.ts`, `pdf.ts` and `styles.css` —
the second, third and fourth palettes Campaign 4 eliminated.

### ESCALATION — the amber ruling collides

Not covered by R1 or R2. Both branches found the **same** defect and ruled
**oppositely**, and both rulings were ratified in their own campaign:

- **main** (owner ruling, this session): the dead `var(--accent, #E8A13C)`
  fallbacks documented *intent*. Amber restored on AI-action controls; amber
  means "the act of generating"; rule written into `CLAUDE.md`; applied forward
  to `Test-fit this plan` and `Autonomous test-fit`.
- **ui-fixes** (`919bcde`, `9c6370b`): the same fallbacks are *dead refs*.
  Deleted — "11 dead amber refs deleted" — and `CandidateGallery`'s AI badge
  moved to blue, described as "the approved amber→blue chrome move".

Both diagnosed the mechanism identically (the fallback can never fire, so those
controls always rendered `--accent`). ui-fixes additionally found a real
inconsistency main did not: the badge's *tint* was a live
`rgba(232, 161, 60, 0.12)` while its text used the fallback, so it rendered
**blue text on an amber ground**. Either ruling fixes that; they disagree only on
which colour wins.

They cannot both land: they target the same DOM in `LibraryPanel.tsx` (11 sites)
and `CandidateGallery.tsx`. **This needs the owner.** It is a conflict of two
approvals, not an oversight.

---

## 6. Generated artifacts — merge-excluded

```
web/src/wasm/ds_core.d.ts          web/src/wasm/ds_core.js
web/src/wasm/ds_core_bg.wasm       web/src/wasm/ds_core_bg.wasm.d.ts
web/pnpm-lock.yaml
```

The four wasm files are in **all three** branches' diffs and must never be
content-merged: take either side to clear the conflict, then `make wasm` from
the merged Rust and commit the regeneration separately. `pnpm-lock.yaml` is
ui-fixes ∩ export; regenerate from the merged `package.json` rather than
resolving hunks.

---

## 7. Pre-registered predictions

Stated before resolving anything. Post-hoc explanations of surprises are
advisory only.

**P1 — `furniture.ts` → `symbols.ts` is the hardest conflict, and git will not
present it as one.** Two branches modified a file the third deleted. Git reports
delete/modify and offers "keep" or "delete"; neither is right. Both main's LOD
work and export's edits must be *ported* into a module that exists on neither
branch. **Predicted failure if done wrong:** `lod-sweep` goes red (the snapped
build's in-band discontinuity reappears, or the ramp introduces one), *or*
`symbols.test.mjs` (46 assertions) fails on countables. R2 anticipates exactly
this disagreement — I expect it to *actually happen*, not to be hypothetical.

**P2 — the union Rust count will land at 157 and the three main-only sensors are
the ones at risk.** `every_mutator_bumps_the_revision` scans `lib.rs` source and
requires every `pub fn …(&mut self` to begin `self.touch()`. ui-fixes and export
add mutators (`backfill_seats`, quantity surface) written with no knowledge of
that rule. **Predicted failure:** that test goes red naming the new mutators —
which is the sensor working. The dangerous case is the known miss: a multi-line
signature the regex does not match, passing silently. Constraint 6 says inspect
manually; I will diff `&mut self` occurrences against scanner hits rather than
trusting green.

**P3 — the style-gate will go red on merge, loudly, and that is correct.**
ui-fixes and export reintroduce zone hexes in `EditorCanvas.ts`, `stats.ts`,
`pdf.ts`, `styles.css`. The palette-uniqueness check is repo-wide and
value-based, so it fires on any file. **Predicted failure:** `PALETTE COPY`
lines naming those files. Resolution is R1's path-scoped allowlist for export
modules only — *not* widening the rule.

**P4 — `export-parity` is the gate most likely to fail for a subtle reason.** It
asserts `pdf.ts` derives `PRINT_ZONE_FILL` from `ZONE`, honours `groundZones`,
takes weight from the ladder, and prints a derived ZONE KEY. R1 may split
`pdf.ts` by surface; if the split moves `renderPrintCanvas` the assertions still
pass while pointing at the wrong file. **This is Face 14 waiting to happen** —
the checks are anchored to `pdf.ts` by path.

**P5 — the amber conflict will not surface as a merge conflict at all.**
ui-fixes deleted the fallbacks; main rewrote them to `var(--accent-amber)`.
Different lines, different files in places. Git may auto-merge into a tree where
some controls are amber and some blue, with no conflict marker and no gate
failing — the style-gate checks *provenance*, not *which* token. **Predicted
symptom:** none, until a human looks. This is the one I expect to slip through.

**P6 — `layout.rs` re-siting will conflict textually and resolve cleanly.** main
decomposed it into stage submodules; the other two edited the monolith. Noisy
but mechanical, and `golden_generate_output_is_frozen` is the sensor: if a
re-sited hunk changes generation, the fingerprint says so. I predict it passes
first try, and that the *quantity* tests from export are the ones that need
work, because they read geometry main's conform stage may have moved.

---

## Status

Phase 0 complete. Two items require a decision before Phase 1:

1. **The amber ruling (§5).** Two ratified, opposite decisions on the same
   elements. Not covered by R1/R2.
2. **Brief corrections (§0).** G12/GSELF do not exist; the Phase 2/3 exit
   criteria naming them cannot be met as written.

No tree has been merged. `integration/all` has not been created.
