# Editor Completion Loop — final report (2026-08-12)

Phase 0 doc: `reports/phase0-editor-completion.md`. Before-images: `before/` (deployed pre-fix
build, provenance in `before/PROVENANCE.md`). After-images: `after/` (per-branch evidence from
A/C/E, plus `merged-*` captured on the MERGED tree via dev :5307, provenance: served
`paint.ts` asserted to contain `LABEL_GROUND_RADIUS` before capture; same wizard path; yardsticks
reproduced 930.1 m² / 268 items / 103 pax).

## The table

| workstream | terminal state | evidence artifact | commits |
|---|---|---|---|
| A — wing classifier | **GREEN** | three-surface dump (conflation confirmed, no second stamp site); `A-gate-red.txt`; 5/5 sabotage; wing toggle-diffs; circulation 33 % → **14.5 % NIA** (honest surface) | `f10f9a8 255a71b b321228 9cb866d ef566d0 7704441` |
| B — sheet occupancy | **GREEN** | SG8 (reconstructed D-P instrument) red **87** → green **0**, pre-registered; 0 survivors; D-Q 37→26 with the one rise named | `756cc05 6b8933d 547d4a0` |
| C — label rendering | **GREEN** | `labelRender.test.mjs` (26 checks) red→green; 7-mutation sabotage; before/after ink-component differencing 2→1; LOD viewport fix | `8e3ce1a 46eee3c 746e9a9` |
| D — pax derivation | **GREEN (as fix)** | registered window excluded by construction (gated); two real staleness windows fixed red-first (mutator membership, revision-keyed stats cache) | `6a6da9e 1914411` |
| E — placement inset | **GREEN** | stale-pixel on repro plate CONFIRMED (0/103 out) AND true-red latent defect: 9 desks / 0.55 m on 3 golden cases; `containment/` reports; 5-part sabotage | `8c51372 49bf422 1d3a757` |
| Integration | **GREEN, deploy pending human** | goldens re-captured ONCE on merge (E's 3 cases moved vs A's capture, zero interference); **215/215 Rust · verify-all 62/63 (1 named env skip) · sheet board 9/9 · G1–G13 green**; reconciliation attribution table in `reports/integration-reconcile-editor-completion.md` | merges + `7c6c932 d89fd04 90a4886` |

Diagnoses that died on contact with evidence, per the pre-registration discipline: the
"second stamp site" (dump instrument conflation — the eight rows exist on no core surface);
the "doubled separator emitted twice" (composer emits one `·`; the halo strokeText left the
space uncovered and desk ink showed through); "desks crossing = placement inset" (the live
mechanism was fill-slot straddle, and only on golden cases, not the user's plate).

## Everything on Udaya's desk

1. **Unlock 1Password, then one command each**: `git push origin main` (after re-signing:
   the unsigned commits are listed in `git log --format='%G? %h %s' origin/main..main` —
   everything after `4ea630b`) and `./deploy/deploy.sh` (failed at rsync: the SSH key lives in
   the locked 1Password agent — same lock as commit signing). Both are otherwise ready; boards
   are green on the exact tree.
2. **Calibration-log seeding** — trusted-human event, untouched by this loop per
   gate-independence.
3. **The three cadcodec sentences** — untouched per the fence; nothing in this loop brushed
   `web/src/cad/**` (zero (g)-adjacent collisions occurred).
4. **Product rulings surfaced, none resolved in-loop:**
   - Chair tuck: 12/128 chairs overhang zone 680's west edge by exactly 0.20 m (deliberate
     corridor tuck; a fix lives in `emit.rs` and moves goldens). May a chair back cross the
     zone line?
   - Zone 311 (real_plate, 63.5 m², 3.25 m clearing) flips to Unassigned under the new
     conjunct — no desired verdict was ever registered for it.
   - The dwg deliverable's room count went 28→20: eight 0.98 m² one-desk wrapper pockets are
     no longer billed as "Open Workspace" micro-rooms (E's fix working as intended — flagging
     for any downstream consumer keying on the old room list).
   - Density: zone 680 sits at 4.29 m²/pax (generator lattice output under the Program brief;
     the knob is the Program step, not a rate table). Below GCC/BCO norms.
   - G14 (plan quality) remains red by design: PQ1/PQ2 are pre-registered generator rubrics;
     the generator was frozen for this loop. The empty wing is now *honestly labelled* waste
     (hatched Unassigned), but furnishing it is generator-coverage work — the laiout-parity
     north-star gap, not a classifier defect.
5. **Standing debt recorded:** `deploy/` has no independent gate (its smoke checks are the
   producer grading itself — and this session's deploy failure printed exit 0 through a
   pipeline, caught only by reading the output); SG5's G1–G11 pins are count-shaped, not
   manifests (recorded, unchanged).
