# Gate Independence

**A gate may not consume any value produced by the system under test. It must re-derive its ground
truth independently — from the artifact bytes, or from the core state.**

Trust requires positive evidence from an independent path. A gate that reads the producer's own
account of what it did is not measuring the producer; it is transcribing it.

## Why this is a rule and not a preference

Every blocker found in the qbiq-parity mission — three of them, across two adversarial review rounds,
all against a board reporting **10/10 green** — was one instance of this single failure. Not an
adversarial edge case: in each one the gate was *structurally measuring nothing*.

**The canonical case — `floorRectPurity`.** G6's only assertion tying a render to the model was a
floor-hue sample.

1. **The producer chose _whether_ it was checked.** `ground-truth.json.renders[].floorMaterial` was
   emitted only when the renderer found a clean floor patch; the gate's response to a missing field
   was `continue`. Painting all four render floors magenta and dropping the field gave
   **`G6 PASS (13 checks)`**.
2. **Fixing that made the field unconditional, so the producer chose _where_ instead.** `floorRect`
   was still producer-supplied and the gate never checked the crop was floor. Painting the bottom 34%
   of every still magenta and picking a *legal* crop from the untouched upper frame gave
   **`G6 PASS (35 checks), 4/4 "MATCHES"`** — sampling a slat wall and a ceiling junction.
   This was **live, not theoretical**: the shipped `Conference_room` entry recorded
   `floorRectPurity: 0.0` and was certified "carpet under shadow" under two consecutive green boards.
3. **Only re-deriving independently closed it.** The gate now segments the image itself — a
   gradient-limited flood fill seeded on the frame's bottom row, the one place an eye-height interior
   camera is always looking at the ground — and reads no producer metadata at all.

The first fix addressed the symptom and the exploit simply relocated. Fix this class at the class
level or it comes back.

## The required demonstration: byte-identical under sabotage

Any gate that touches producer-adjacent data must ship with proof of independence, in this form:

> Sabotage every producer-supplied hint the gate could plausibly be reading — corrupt it, move it
> somewhere impossible, and delete it entirely — and show the gate's output is **byte-identical**.

For G6 that was: *moving every `floorRect` onto a wall, and deleting the field, produce byte-identical
gate output.* That single check proves the crop has no influence left. An assertion that merely
"still passes" proves nothing; identical bytes prove the value was never consulted.

Pair it with a falsification: build the wrong artifact the gate is supposed to catch, and show it
**fails**. Where practical, first reproduce the exploit against the *old* gate to confirm you are
measuring the same thing (G6's fix reproduced the original 35-check pass exactly before closing it).

## In practice

- **Derive from bytes or core state.** Segment the image; parse the workbook; re-project from the
  camera pose and room polygon. Do not read "what I drew" summaries.
- **A missing input is a FAILURE, never a skip.** `if not x: continue` hands the producer a veto over
  its own test. If a field is absent, fail and say so.
- **Metadata the gate can _validate_ is acceptable; metadata it must _trust_ is not.** A
  producer-emitted mask is fine if the gate checks the mask against the render before sampling
  through it.
- **Condition on the model, not on a producer flag.** G4 asserts facade pixels are drawn *when the
  model bills facade glazing* (`General!L13`), because a flag can be dropped and geometry cannot.
- **Emission is not visibility.** Counting what the renderer emitted does not prove it can be seen.
  Furniture drawn and then painted over by a room label satisfies every count-exact check (E7).
  Where the deliverable is an image, assert against the delivered pixels.
- **Watch the graded artifact is the emitted artifact.** A runner that grades a pack a later step
  overwrites is the same failure in the time dimension: `run-all.sh` once passed G1–G9 on the previous
  run's files, and G10 declared a pack complete ~36 s before its video finished writing (mtime
  advances on ffmpeg's first byte). Assert completeness — the mp4 decodes, the xlsx has an EOCD —
  and snapshot what was graded.

## Scope — where this rule stops

The threat model is **regression and drift in our own code**, not a malicious producer forging
outputs. Perceptual gates that catch a plan collapsing to a 19×3 px smudge, or a render going black,
are doing their job; making them forgery-proof is a security posture this problem does not call for.

Accepted, measured, and deliberately not pursued further (see `reports/P-1.md`): a ≤21%-of-frame
mid-band repaint survives G6, and G4 tolerates *erasing* ~50% of window pixels. Both were quantified
and left open on purpose.

The producer-metadata class is different, and is in scope, because it was never an edge case — the
gate was measuring nothing at all.

## Related

- `.claude/rules/no-bloat.md` — one derivation, one source; drift between two copies is the defect
  this rule catches from the other side.
- Worked examples: `scripts/gates/g6-renders.py` (self-segmentation), `g4-plan-graphic.py`
  (model-conditioned), `g10-one-action.mjs` + `run-all.sh` (completeness + integrity snapshot).
- Full history: `reports/defects-{1,2,3}.md`, `reports/FINAL.md`.
