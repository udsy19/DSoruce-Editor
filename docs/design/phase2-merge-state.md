# Phase 2 merge state — PARKED, merge open, all conflicts resolved

**Do not abort.** Every conflict is resolved and a 214-line seating block is
hand-ported into the index. `git merge --abort` destroys real work.

## Verifiable predicates (with the command that checks each)

| predicate | check | expected |
|---|---|---|
| merge open | `test -f .git/MERGE_HEAD && echo open` | `open` |
| merging export | `git rev-parse --short MERGE_HEAD` | `f62dd1a` |
| branch | `git rev-parse --abbrev-ref HEAD` | `integration/all` |
| base | `git log --oneline -1` | `261846a Phase 1 exit…` |
| conflicts left | `git diff --name-only --diff-filter=U \| wc -l` | **0** |
| Rust | `cargo test -p ds-core` | **151 passed, 1 failed** |
| core builds | `cargo build -p ds-core` | clean (3 warnings) |

## Resolved (17 conflicts)

| path | resolution |
|---|---|
| 4 × `web/src/wasm/*` | `--ours`; **regen from merged Rust still owed** |
| `web/src/editor/furniture.ts` | stays deleted (R2). `DU` this time — deleted by us, modified by them |
| `.gitignore`, `.claude/rules/gate-independence.md`, `AppShell.tsx`, `CLAUDE.md`, `styles.css` | additive unions |
| `web/vite.config.ts` | union: main's `buildProvenance()` + export's `shareViewer()` |
| `takeoff.ts`, `sheetSet.ts`, `servicesSheets.ts`, `App.tsx` | the Phase-1 import rule again — main's `types/` paths win, export's new symbols kept |
| `crates/ds-core/src/lib.rs` | union: `mod qto` (main's bake-off) + `mod quantity` (export) |
| `crates/ds-core/src/layout.rs` | main's decomposition kept; export's delta re-sited (see debt) |

## Fixed, with root cause

1. **`every_mutator_bumps_the_revision` went red naming `set_wall_height`** —
   export's new mutator, no `self.touch()`. **P2 confirmed.** Fixed. All three
   multi-line mutators re-inspected by hand (the scanner's known miss): all call
   `self.touch()` first.
2. **`golden_generate_output_is_frozen` went red** — component, wall, zone and
   desk counts all IDENTICAL; only `LayoutScore.total` moved. Root cause found
   by isolation, not assumption: I first suspected the new Collaboration seating
   and **removed it — the failure persisted unchanged.** The real cause is
   export's `circulation::is_loose_seating`, which exempts `Chair` components
   from the circulation raster (loose furniture people move should not block a
   corridor). That shifts the circulation sub-score and therefore `total`.
   A deliberate, ratified behaviour change → golden **RE-CAPTURED, not relaxed**,
   per the test's own rule.
3. `height_m` (export) and `seats` (ui-fixes) filled in every constructor the
   other branch predates. One over-application caught and reverted: a regex
   added `seats: 0` to literals that already resolve seats from the model.

## The one failure, diagnosed

`quantity::tests::a_generated_testfit_produces_a_coherent_quantity_surface`

```
expected  PerimeterWindows 78.8   PerimeterWall 1.2
actual    PerimeterWindows 64.0   PerimeterWall 16.0
```

64.0 is exactly the three walls authored glazed (24+16+24). 16.0 is the fourth,
authored solid and left **entirely** solid. So `layout::glaze_facade` — which
models the office facade module on a solid perimeter wall (0.6 m pier each end,
14.8 m glazed band) — **is not running**.

**This is unported work, not a merge defect.** `glaze_facade` lives in one of the
13 export layout hunks that did not context-apply. The test is correct and the
tree is incomplete.

## Port debt — 13 of 16 export layout hunks

3 context-applied (`push_gen_wall` height, `generate` keep-out comment,
`emit_job` Collaboration seating). The 214-line seating block
(`seat_around_table`, `seat_desk_chairs`) was hand-ported into `emit.rs` with its
four constants; a duplicate `footprint_overlaps` was dropped (`packing.rs` owns
it).

Still to port, by hunk header:

```
@@ -814   DOOR_JAMB region (constants)      @@ -873   CorridorSide
@@ -1065  furnish_room                      @@ -1114  +206 lines (glaze_facade et al)
@@ -1949  generate +91 lines                @@ -4671  tests
@@ -4931  tests    @@ -4986  tests          @@ -5173  tests
@@ -5274  tests    @@ -5905  +408 test lines @@ -5987  tests   @@ -6316  tests
```

Roughly 300 lines of behaviour and 450 of tests. The 19 export-unique Rust tests
arrive with them; the floor is **157 named**.

## ESCALATION — the chairs decision, not decidable by either test alone

`symbols.test.mjs` asserts the table glyph **draws** `seats`-many chairs from the
model (assertions 1–2: "the glyph renders the MODEL's seat count", invariant
across zoom). Export asserts chairs are **real billable `Chair` components** and
the glyph must draw none — its own words: *"the 2D plan glyphs draw no implied
seating, so what the plan draws is exactly what the Furniture Inventory bills"*,
pinned by `every_meeting_table_is_seated_and_every_seat_is_a_billable_component`,
`every_generated_desk_gets_exactly_one_task_chair` and
`regenerate_does_not_accumulate_chairs`.

Both ratified. Both tested. **Directly contradictory**: once the generator emits
real chairs, a glyph that also draws them shows double the seating that exists,
and export's `g11-furniture-agreement` board is built to catch exactly that.

Standing constraint 1 ("no shadow stores") and R2 ("seat count comes from
`Component.seats`") point at export's position — a drawn-but-unbilled chair is a
shadow. But acting on it means editing two assertions in a 46-assertion suite,
which R2 explicitly warns against ("not to paper over by editing whichever test
is easier to change").

**Recommendation**: adopt export's position, and rewrite those two assertions to
assert the *opposite* property — that the glyph draws NO implied seats — so the
suite still pins the behaviour rather than losing it. ui-fixes' real invariant
(seat count never derived from zoom) survives, carried now by the components
themselves. This needs a ruling before I touch `symbols.test.mjs`.

## Resume order

1. **Rule the chairs question** (above), then port the 13 hunks — `glaze_facade`
   first, since it is the one live failure.
2. Rust to **157 named**, by name.
3. `pdf.ts` splits under R1; `export-parity`'s path anchor moves in the same
   commit, proven by making the wrong file lie.
4. Paper invariant completes: `sheet.ts` + `report.ts` onto qbiq values; the
   allowlist **empties**; the check goes unconditional.
5. E7 occupancy seeding in `sheetSet.ts`; 107 → 0 label collisions.
6. quantity.rs on the 882 m² DWG; seats/QTO on the 24 m² boardroom.
7. Regen wasm; G1–G11 + SG1–SG6; `docs/design/phase2-exit.md`.

## Why this stopped here

Session length. The merge is fully resolved with a clean build and one failure
whose cause is understood and is unported work rather than breakage. Nothing is
half-decided; the one open question is escalated above with a recommendation.
