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

## The positive complement: write the gate first, and watch it fail first

Independence says what a gate must not consume. Writing it **before** the fix is what buys you a gate
calibrated against ground truth instead of against the fix.

**The canonical case — E7, eight rooms vs four.** A hand-written defect report identified four rooms
whose furniture the plan billed but hid (145, 147, 155, 171). The gate was written first and watched
fail on the unfixed plan. It named **eight**: `12(0.06) 155(0.15) 21(0.21) 188(0.21) 171(0.28)
179(0.38) 147(0.44) 145(0.48)`. **The defect report had undercounted its own defect by half**, and
rooms 12, 21, 179 and 188 would have shipped — a gate written afterwards is calibrated to pass
whatever the fix produced, so it can only ever confirm the fix, never audit it.

The same run also showed why the *shape* of the assertion has to be chosen before the fix, not after:
E7's reported cause (a symbol library skip-drawing unknown types) was wrong, and the obvious
count-exact **emission** gate would have passed while the defect persisted — the emission half scored
**189/189 on the unfixed plan**. The furniture was drawn and then painted over. Hence the corollary
already stated below: *emission is not visibility.*

## Corollary: never calibrate against the population under test

**A baseline or reference population drawn from the artifact under test inherits its defects.
Calibrate against an external anchor, or against a property that holds by construction.**

Two instances, one level apart, both caught only by re-measuring:

- **A contaminated reference certifying its own contamination.** The first visibility metric normalised
  each furniture instance against its same-size siblings. It was blind to rooms 145/147, whose only two
  0.6×0.6 tables are *each other's only peer* — and both were occluded. Relative to a defective
  population, each defect looked normal.
- **A threshold implicitly calibrated on one population's conditions.** The first ink classifier
  separated furniture from labels with `b > r`. That held on the seeded pack and was silently
  invalidated by the DWG pack, whose pink circulation wash lifts red — it scored those chairs `0.00`
  even *after* they were fixed.

The landing fix is the rule in action: furniture is cool-neutral **by palette definition**
(`b > g`), labels are pure neutral **by renderer definition** (`r == g == b`). Both anchors come from
specifications the gate can cite, not from the data being judged. Prefer, in order: a property true by
construction → an external specification (`palette.json`, `FINISH_SPEC`) → a population explicitly
verified clean. Never the artifact under test.

Watch for this in review — it is the third member of the family, alongside producer-supplied metadata
and emission-vs-visibility, and it is the hardest to see because the measurement looks rigorous.

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
