# Ground truth — provenance and confidence

A bake-off is only worth the truth it scores against, so every truth polygon
here records **how it was obtained**, not just what it is.

## Synthetic fixtures — truth is exact, by construction

`bench/fixtures/generate.mjs` starts from a known plate polygon and synthesizes
defective wall linework *from* it. The truth is therefore not an estimate of what
an extractor ought to find; it is the object the drawing was built out of.
Nothing infers it, so no implementation's assumptions can leak into it.

Regenerate with `node bench/fixtures/generate.mjs` — byte-identical every run
(the generator uses a seeded PRNG; `Math.random()` is banned in it).

Confidence: **exact**. Score these to 4 decimal places without hesitation.

### What each class tests

| class | fixtures | tests |
|---|---|---|
| clean | `rect-clean` | control — failure here is disqualifying |
| gaps | `rect-door-gaps`, `rect-wide-gaps` | door/window breaks (L5IN, IIETA gap closing) |
| precision | `rect-jitter` | sub-tolerance endpoint noise (dxf-fix snapping) |
| duplication | `rect-duplicated-layers` | overlapping wall layers (Wu et al. elimination) |
| non-axis | `rot17-door-gaps` | 17° rotation — regularisers must not force it square |
| concavity | `lshape-door-gaps`, `notched-core` | re-entrant corners |
| curves | `curved-facade` | arc facade — guards against over-regularisation |
| composed | `lshape-jitter-dup-gaps` | all defects at once |
| **fragmented shell** | `lshape-shell-fragments`, `notched-shell-fragments`, `rect-no-shell-only-partitions` | **the production bug** — see below |

The fragmented-shell class is the one that matters. Every other fixture leaves a
traceable perimeter loop, so the incumbent's loop tracer succeeds and scores
0.98–1.00 — those fixtures cannot discriminate between candidates. Only the
fragmented class forces the hull fallback that produces the phantom diagonals in
the reported bug. It was added *after* measuring that the first ten fixtures all
passed; keeping only those would have made the bake-off theatre.

## `real-furniture-plan` — NOT YET ESTABLISHED, and possibly not establishable

**There is no truth file for the real drawing, and `bench/run.mjs` therefore
excludes it from scoring.** This is deliberate. What the drawing actually
contains, verified by rendering each layer separately:

| layer | entities | contents |
|---|---|---|
| `I-WALL` | 335 | interior partitions, mostly one vertical spine |
| `A-WALL` | 254 | partitions + one curved feature |
| `WALL` | 87 | one room top-right + scattered fragments bottom-left |
| `COL` | 27 | isolated column squares |

**No layer contains a closed exterior envelope.** The drawing is a fit-out plan
with no building shell. Consequences:

1. The 881.5 m² the app reports today is not a measurement of anything — it is
   the area of a convex hull fitted to disconnected fragments. 46.3% of that
   hull's 170 m perimeter (78.8 m) has no wall linework beneath it, and the ring
   does not even close (3.5 m gap between first and last vertex).
2. **The correct plate cannot be recovered from the drawing**, because the
   information is not in it. Any "ground truth" derived from the linework would
   be an opinion dressed as a measurement.
3. This is a **product decision, not a geometry problem**: what *should* the
   plate be when the shell is absent — the convex extent of all linework, the
   region bounded by the column grid, a tenancy boundary supplied by the user, or
   should the importer refuse and require the user to trace it?

Until that is answered, the real drawing is still used, but only for
**truth-free metrics**, which are meaningful without a reference polygon:

- self-intersection count (must be 0)
- ring closure error (must be ~0)
- phantom-edge length / % of perimeter (must be low — currently 46.3%)
- determinism across runs
- wall-clock

Those alone will separate the candidates on this fixture. Add
`real-furniture-plan.geojson` here once the boundary question is decided, and
`bench/run.mjs` will pick it up automatically and start scoring IoU and area
against it.
