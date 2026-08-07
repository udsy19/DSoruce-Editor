# Merge campaign state — Phase 1 MERGED, Phase 2 not started

## Verifiable predicates (with the command that checks each)

| predicate | check | expected |
|---|---|---|
| no merge open | `test -f .git/MERGE_HEAD \|\| echo clean` | `clean` |
| branch | `git rev-parse --abbrev-ref HEAD` | `integration/all` |
| tip | `git log --oneline -1` | `014330e regen wasm from merged core` |
| ui-fixes merged | `git merge-base --is-ancestor ui-fixes HEAD && echo yes` | `yes` |
| export merged | `git merge-base --is-ancestor export HEAD && echo yes` | (nothing — NOT merged) |
| working tree | `git status --porcelain \| wc -l` | 0 |
| Rust by name | `cargo test -p ds-core` | **138 passed** |

## Done

**Phase 1 complete through the merge commit.** `c15451b` (the merge) and
`014330e` (wasm regen) are on `integration/all`. All 23 conflicts + the
delete/modify resolved. Every board green:

| board | |
|---|---|
| style-gate, ladder-check, lod-sweep, export-parity, accent-univalence | PASS |
| coreParity, symbols (46), fonts | PASS |
| Rust | **138 passed, 138 by name, 0 missing vs the main∪ui-fixes floor** |
| typecheck, build | PASS |

> **RETRACTED (R12) — `ladder-check`, `lod-sweep` and `export-parity` were not on
> any board when this was written.** Their PASS rows above were real readings of a
> real script, taken by hand; what they were not is a standing verdict. No runner
> invoked those three: `scripts/verify-all.sh` ran deadspace-core / style-gate /
> accent-univalence, `scripts/gates/run-all.sh` ran G1-G13, the root
> `package.json` had one `bench` script pointing at `bench/run.mjs`, and there is
> no `.github/workflows`. Listing them beside `cargo test` and `style-gate` —
> which the pre-commit hook does enforce — read as "the tree holds this", and the
> tree did not. Wired into `scripts/verify-all.sh` in the same change as this
> retraction, together with `scripts/gates/reconcile.mjs`, which reds on any gate
> that exists and is never invoked.


Detail is in the merge commit message. The five things worth carrying:

1. **The governing pattern**: ui-fixes edited PRE-SPLIT files main had
   decomposed. ~12 re-sitings, not takes-or-drops.
2. **furniture.ts is gone**; symbols.ts owns geometry. The port was a real API
   change (screen coords → world dims + view) at two call sites. Seats come from
   the model at both.
3. **A design conflict decided and logged**: ui-fixes' filled-poché `drawWall`
   vs main's measured two-face grammar. The digest does not name wall form, but
   `export-parity` and `ladder-check` both enforce main's — and the mission
   forbids retiring a gate. Main's grammar wins.
4. **Two checks re-anchored** (P4/Face-14): `coreParity` read a `layout.rs` that
   had been split and a union that had moved; `style-gate` guarded the
   about-to-be-deleted `furniture.ts`.
5. **accent-univalence earned its place**: it caught five raw amber literals git
   auto-merged into `DrawingCanvas.ts` with **no conflict marker** — P5's exact
   shape, live.

## Not done — resume here, in order

### Phase 1 exit (remaining)

1. **Re-capture the lod-sweep fixtures** against the merged implementation, and
   implement the sensor-for-the-sensor: lod-sweep must record the commit its
   fixtures came from and fail when `symbols.ts` has moved since. Prove red by
   touching symbols.ts without re-capturing, then green. **The gate is still
   vacuous until this is done** — it passes with `symbols.ts` deleted.
2. **Listener-defect reproduction**: hidden EditorView + Delete; ⌘K over the
   wizard. `setActive` and its `App.tsx` caller are both merged and present —
   the fix is IN, the PROOF is not.
3. **Persistence round-trip** on pre-merge `.dsource` fixtures from both eras;
   `chosenPlanId` + `backfill_seats()` survive.
4. **pixdiff** vs both parents' references. The ~8 R5 amber reversals classify
   **intended-(ruled)**; drift reverts. Sites listed in the merge commit.
5. Write `docs/design/phase1-exit.md`.

### Phase 2 — merge export (not started)

`git merge export --no-ff`, then the campaign's Part B in order: pdf.ts splits
under R1 with export-parity's anchor moving in the same commit; export's
furniture.ts edits (+63/−133) port into symbols.ts; the paper-invariant
allowlist **empties** (sheet.ts + report.ts onto qbiq palette values) and the
check goes unconditional; E7 occupancy seeding (107 → 0 label collisions);
quantity.rs facade/partition check on the 882 m² DWG; seats/QTO cross-check on
the 24 m² boardroom. Exit: **157 named** Rust tests, G1–G11 + SG1–SG6.

### Parts C and D

Whole-system twice-green, adversarial round, deliverable pack, land on main,
ancestry-proven branch deletion, ROADMAP, the four new faces, final report.

## Why this stopped here

Session length, not an escalation-policy stop. The merge commit is the
durability milestone and it is banked; everything above is additive from a
clean, green tree. No decision is blocked and nothing is half-applied.
