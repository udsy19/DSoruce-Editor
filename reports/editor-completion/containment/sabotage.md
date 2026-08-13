# Sabotage round — the placement containment gate

Gate: `layout::tests::placed_desks_and_tables_stay_inside_their_zone_on_the_golden_cases`
(crates/ds-core/src/layout/tests.rs). Fix under guard: `FieldGrid::build`'s `no_straddle`
rejection (commit 49bf422). All runs in a disposable `git worktree add --detach` at 49bf422
(`.claude/rules/gate-independence.md`: falsify against a copy, never the protected tree);
every sabotage edit asserted its anchor before replacing and re-read the file after writing.

Scope of every claim below: the ten golden (program, seed) cases, this gate only.

| # | sabotage | expectation | result |
|---|---|---|---|
| baseline | none (HEAD 49bf422) | green | **green** (1 passed) |
| S1 | fix reverted — the fill passes `&[]` instead of `&ws_edges` (layout.rs) | red | **RED** — the identical 9 desks: #258/#261/#262 on `default/real_plate/seed1` and `seed3`, #207/#213/#214 on `explicit_rooms/real_plate/seed1`, all exiting "Open Workspace (1)" (Rect x 12.4..23.4, y 4.9..40.1), worst 0.55 m at the south edge |
| S2 | gate's enabling transform — footprint rotation dropped (`sin_cos()` → `(0, 1)`) | red | **RED** — rotated Tables/Desks read at their unrotated extents and falsely "exit" (first: Table #67, Pantry, `default/rect20x14/*`). Removal changes verdicts ⇒ the rotation transform is load-bearing, not decorative |
| S3 | gate's assignment — ground-loses-to-rooms rule inverted (`ground = false`) | red or null | **NULL — reported, not papered over.** Gate stays green: for Desk/Table centers on the golden cases, no ground zone both contains a component center and is smaller than the room zone containing it (residuals are corner-cleared disjoint from rooms by construction — the same measured fact as the `zone_index_at` revert experiment in document.rs). The guard against this family going quiet is the gate's population floor (`measured >= 100`), which is independent of the rule |
| S4 | producer sabotage — per-slot field bounds check loosened by 1.0 m (packing.rs) | red | **NULL, and it is a finding:** the per-slot bounds check is a BELT. The axis extents (`inner_n` / `outer_n`) are derived against the field limits before any slot is walked, so loosening the per-slot check alone adds no out-of-field candidates (it exists for snap-shift ±0.025 m and aisle-shifted slots) |
| S4b | producer sabotage — per-slot bounds check **and** the `outer_n` extent loosened/extended by 1.0 m | red | **RED** — desks placed 0.3 m past "Open Workspace (1)"'s east edge on `no_support/real_plate/seed2` (a case the fill fix never touched, so the gate catches per-region overruns independently of the fill mechanism) |

Nulls are the most valuable lines of the round (gate-independence.md, "the falsification
round is the closing move"): S3 says the ground rule is defensive for this population and
names the vacuity floor as the real guard; S4/S4b say the packer's true containment
mechanism is the extent derivation, not the per-slot check — a future edit that touches
`outer_n`/`inner_n` arithmetic is the one to watch, and the gate fires on it.
