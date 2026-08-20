# Phase 0 — Leftovers Loop (2026-08-20): rulings, yardsticks, pre-registrations

Commissioned by Udaya: "start a loop and get all of them done" over the FINAL.md desk list.
Out of scope, permanently: **calibration-log seeding** (trusted-human event — declined even under
instruction, per `.claude/rules/gate-independence.md`) and **the three cadcodec rulings**
(analysis synthesis only, being produced by the pre-existing evaluation agent on branch
`cadcodec-synthesis`; no cadcodec code, no corpus contact, nothing on the proposal branch).

## Rulings (2026-08-20)

1. **Chair tuck — ALLOW, BOUNDED** (Udaya): a chair may project into adjacent *circulation* up to
   its own tuck depth (`CHAIR_PROJECT`), never into another room's zone. Codify as an invariant
   with a gate; golden output must NOT move for this item.
2. **Zone 311 — BLESSED as Unassigned** (delegated "do what's best", decided by the orchestrator):
   a 3.25 m clearing is room-scale by the same `2×SPINE_W = 3.0 m` NBC-anchored bound that defines
   the conjunct; a corridor is thin everywhere, and 311 is not. Registered as a pinned fixture
   verdict. Reversal is one fixture line + a bound re-registration, should Udaya overrule.
3. **G14 — FULL MISSION** (Udaya): wing furnished, PQ1 neighbourhood band, PQ2 room gaps.
4. **cadcodec agent — woken for synthesis only** (Udaya).

## Facts at loop start

- main = `02cb002` (a Fly.io deploy target landed since 18709fd: Dockerfile, fly.toml,
  `deploy/FLY.md`, `deploy/server.ts` +48 — possibly from a still-active peer session, so
  Workstream 1 owns only NEW files plus a minimal hook).
- Boards at 18709fd: 215/215 Rust · verify-all 62/63 (named env skip) · sheet 9/9 · G1–G13 green.
- G14: **FAIL 2/3 by design** — PQ0 self-test green; PQ1: 7/10 desk neighbourhoods outside the
  6–12 band; PQ2: 12 sub-minimum room gaps totalling 12.62 m².
- Wing: 166.27 m² honestly typed Unassigned (9 residuals incl. 833); honest circulation
  131.80 m² = 14.5 % NIA.
- D-Q: **26** strings outside the building footprint (frozen instrument, sheets gate family);
  five `3.00 m` dims suppressed by declutter; three dwg labels at the fit ladder's floor
  (5.25–6.38 pt).
- Deploy hazard on record: deploy.sh failure printed exit 0 through a pipeline; smoke checks are
  the producer grading itself.

## Pinned yardsticks

| yardstick | value | instrument |
|---|---|---|
| D-Q count | 26 | the sheets D-Q measurement, method frozen |
| PQ1 | 7/10 neighbourhoods out of band | G14 rubric, standing red |
| PQ2 | 12 gaps / 12.62 m² | G14 rubric, standing red |
| Unassigned | 166.27 m² on the repro plate | `scripts/zone-dump.mjs` (surface-prefixed) |
| Rust tests | 215 named | `cargo test -p ds-core` |
| chairs tucked | 12/128 at exactly 0.20 m | containment report method (E) |

## Pre-registrations — mechanism · expectation · falsifier

**W1 `fix/deploy-gate`** — an independent deploy gate: given an origin URL and the local build,
re-derive ground truth from SERVED BYTES (entry asset md5 vs `web/dist`, wasm asset, endpoint
contract responses) — never from deploy.sh's stdout or exit code. Byte-identical-under-sabotage
proof required (gate output identical with deploy.sh's own smoke output corrupted/deleted);
falsification: serve a stale/foreign asset in a scratch environment → exactly one red. Covers VPS
now, documents the Fly hook. *Expectation:* the gate would have caught the 2026-08-12 false-green
deploy; show it (replay: gate against a mismatched dist).

**W2 `fix/sg5-manifests`** — SG5's G1–G11 pins become identity manifests (check NAMES, not
counts). Falsifier that must go red: swap one check's identity while keeping the count flat
(scratch worktree) — count-shaped pins stay green on that sabotage today, which is the standing
weakness being closed. *Expectation:* board counts unchanged; only the pin shape changes.

**W3 `fix/dq-strings`** — close D-Q. Red at 26 (re-measure first; if the instrument does not
reproduce 26 on pre-fix code, reconcile before any fix). Mechanism expectation: the labels/dims
lack the displacement rung inward from the footprint edge; give dims the rung the labels got
(D3's damage-ordering: displacement before shrink before suppress) and evaluate the wide rung for
the three floor-size labels. Pre-register the post-fix count BEFORE running it; survivors named
individually or RED-WITH-ROOT-CAUSE. SG8 must stay 0; SG3/SG1 stay green; suppressed dims may
return only via displacement, never by relaxing declutter.

**W4 `fix/g14-generator`** — the generator mission. Gates, all standing red or sabotage-proven:
PQ1 ≥ 9/10 in-band (register the target before coding; if 10/10 is achievable say so, if not name
the holdout), PQ2 = 0 sub-minimum gaps, wing furnished (Unassigned on the repro plate falls from
166.27 m² — register the expected residual before coding), chair-bound invariant (ruling 1;
sabotage-red), zone 311 verdict pinned (ruling 2). Containment, A1/A2, and pax gates must stay
green; honest circulation stays inside 12–18 % NIA; goldens WILL move — re-capture once with
per-case justification, never relax. Browser-verified on the repro plate. *Falsifier:* if
furnishing the wing pushes circulation above 18 % or breaks containment, stop and report the
tension rather than trading one red for another.

## Execution rules

Worktrees `fix-{deploy-gate,sg5-manifests,dq-strings,g14-generator}` off `02cb002`; ports
5311–5314; exclusive ownership (W4 owns `crates/ds-core/src/layout/**` alone; W3 owns
`web/src/export/**` alone; W1 new files + minimal deploy.sh hook; W2 sg5 only). Fail-first,
scratch-worktree negatives, incremental commits (sign; `--no-gpg-sign` + note if 1Password
locks), no MCP browser tools in agents, scope every negative claim, terminal states
GREEN / RED-WITH-ROOT-CAUSE / STOPPED-FOR-HUMAN.
