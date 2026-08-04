# `bench/` — the open-source bake-off harness

Candidates are measured against the incumbent on fixtures with known answers,
and only winners get merged. Nothing is integrated on the strength of a README.

```bash
pnpm bench plate          # one branch
pnpm bench all            # every branch, regenerates report.md
node bench/fixtures/generate.mjs   # rebuild synthetic fixtures (deterministic)
```

Outputs: `bench/results/<branch>.json` (raw, diffable across commits) and
`bench/report.md` (the table).

## The three rules

**1. Every candidate hides behind an adapter.** `bench/adapters/<branch>/types.ts`
defines the interface; the current implementation is wrapped as `baseline` and
each candidate is a sibling file. Adapters may not import each other and may not
reach into app state. Nothing in `web/src/` knows which implementation it got —
selection is a config flag (`VITE_IMPL_PLATE=baseline|dxffix|...`), never a
call-site edit.

**2. Fixtures and scoring exist before any candidate.** A candidate written
before its yardstick tends to become its own yardstick.

**3. Portability is scored, not an afterthought.** Every adapter declares:

| class | meaning | cost |
|---|---|---|
| `A-port` | algorithm reimplemented in Rust/TS | no new runtime — preferred |
| `B-service` | runs behind `/api/*` via `deploy/apiCore.ts` | **must degrade on Vercel exactly like `/api/dwg` does today** |
| `C-reference` | we take the technique, not the code | for AGPL sources, which are never vendored |

A candidate that wins on quality but forces a Python runtime into the hot path
loses to a slightly worse `A-port` unless the quality gap is large. The ADR must
say so explicitly, in those terms.

Licenses are recorded per adapter. AGPL-3.0 sources (e.g. `poolpet/floorplan6`)
are `C-reference` only — clean-room reimplementation, never vendored.

## Metrics (`bench/metrics.ts`)

Computed from geometry alone; no implementation is ever asked about its own
quality. Raw numbers are reported, never a single blended score — collapsing them
hides the exact trade-off the ADR has to record.

Two groups, and the distinction matters:

**Truth-free** — well defined without a reference polygon, so they work on the
real drawing whose correct plate is undecided:
`selfIntersections` (must be 0) · `closureErrorM` · `orthogonalityPct`
(length-weighted, so a hundred 2 cm jags cannot outvote four 40 m walls) ·
`phantomEdgeM` and `phantomPctOfPerimeter` (boundary length with no supporting
source linework — the direct measure of the phantom-diagonal bug) ·
`deterministic` · `ms`.

**Truth-relative** — need a ground-truth polygon: `iou` (dense rasterization, on
purpose *not* a polygon-clipping library, since scoring clipping-based candidates
with the library they use would launder their own errors into the score) ·
`areaDeltaPct` · `boundaryDevM`.

Determinism is enforced, not assumed: every implementation runs twice per fixture
and a differing result fails, regardless of how well it scored.

## Fixtures

See `fixtures/truth/README.md` for provenance and confidence per fixture — that
file is the one to read before trusting any number here.

Short version: the 13 synthetic fixtures carry **exact** truth (the drawing is
synthesized *from* the truth polygon, so nothing infers it). The real
`furniture-plan.dwg` has **no established truth** and is scored on truth-free
metrics only, because it contains no closed exterior envelope on any wall layer —
its correct plate is a product decision, not something recoverable from the file.

## Adding a candidate

1. `bench/adapters/<branch>/<id>.ts`, default-exporting an object with `meta`
   (id, summary, portability, license, upstream) and the branch's method.
2. `pnpm bench <branch>`.
3. An ADR in `docs/adr/` naming the winner, the metrics behind it, and — the part
   that matters later — **what the losers were better at**.

No call-site changes. Adoption happens at the merge gate, where the losing
adapters are deleted, and the abstraction itself is deleted when only one
implementation survives: a permanent adapter layer for a settled question is
bloat.
