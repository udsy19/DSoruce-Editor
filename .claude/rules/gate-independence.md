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

## A prescribed fix is a hypothesis — the gate falsifies the FIX as much as the defect

Write the gate against the **property that must hold**, never against the fix someone specified. The
person specifying the fix — including whoever wrote the task — is not exempt.

**Worked case (drawing set, D3).** The brief diagnosed "text drawn at fixed size into a clip region
with no fit check" and prescribed a fit ladder: wrap → shrink → abbreviate → displace. Both the
diagnosis and the prescription were wrong.
- The real cause was one step further back: labels were placed **at their zone centre and nowhere
  else**, and each label's white knockout halo then *erased* the previous one. A fit ladder would not
  have touched it.
- **Two prescribed rungs were actively harmful.** Wrapping a name onto two lines made the gate report
  `"Open Workspace (4)" rendered 0×` — because a wrapped name is no longer **one recoverable glyph
  run**, the very property the gate anchors on. The prescribed remedy destroyed what it was meant to
  preserve. Rungs are now ordered by damage, displacement first.

Only a gate anchored to the property (one recoverable glyph run) could reveal that. A gate written to
confirm the prescription would have certified the harm.

Across two missions the count is: **10 defects fixed against 4 reported, and 3 of 4 root causes
falsified before a line of fix code was written.**

## The board runner is itself a system under test

A grading system whose summary can disagree with its own rows is the meta-instance of everything here:
**the scoreboard trusted a status code supplied by the thing it was summarising.**

It shipped. While the sheet gates were being wired onto the board, `FAILED` incremented on the gate's
**exit code alone**, so a gate that exited 0 while printing `FAIL` was tallied as passing — the board
printed `12/12 passing` directly above `G12 FAIL`. Both runners now fail on the exit code **or** the
scoreboard line.

The durable rule is not the fix, it is the check: **keep a deliberately lying gate as a permanent
fixture.** `GATE_SELFTEST=1` appends `GSELF`, which exits 0 while printing `FAIL`; SG5 runs it every
time and asserts the board reports it red. Proven, not assumed — and falsified: reverting the counting
fix reproduces `1/1 passing` above a `FAIL` row, and SG5 goes `FAIL (28 checks, 1 failing)`.

## Completeness gates: derive the full expected set, never presence-match two artifact-derived lists

Anchoring **one side** of a completeness check to ground truth is not enough. If the other side is
also derived from the artifact, the two contaminated sides **agree with each other about the missing
element** and the gate sees nothing. Presence-matching between two artifact-derived lists is mutual
contamination wearing a gate's clothes.

**Worked case (drawing set, D-O)** — the fourth recurrence, *inside a gate written to enforce this
file*. SG1's schedule-completeness check anchored only the **Door** half to core state; the **Window**
half compared plan tags against schedule rows, both descended from one upstream list. Dropping a
glazed run upstream removed the tag **and** the row together — and `SG1 71 / SG2 8 / SG3 97` all
passed.

The rule: **derive the complete expected set from core state, then check each artifact against it
independently.** The fix re-derives glazed runs from wall geometry and matches delivered rows against
*that*; its falsification drops a segment **inside** the merge, proving the anchor reaches the
geometry rather than the producer's list.

## An agent must never perform or simulate a trusted-human event

**Where a store's value IS its provenance, an agent may not produce its entries — not when
mechanically possible, and not when instructed.** Decline, and say why.

The canonical case is the plate calibration log (`web/src/persist/plateLog.ts`, ADR 0003). Per that
ADR, promotion of any inference rung to high confidence comes **from that log only**, never from
fixtures — because we build the fixtures. The log therefore inverts the usual gate and demands
*positive proof of a human*: `Event.isTrusted`, which page script cannot forge, so a synthetic
`element.click()` never counts. Its own comment concedes the limit at `plateLog.ts:82` — a
sufficiently capable automated driver "still register[s]", and distinguishing that from a human "is
not solvable in-page".

So the rule is not enforced by the check. **It is enforced by the most capable potential violator
declining to route around it.** That is a real enforcement mechanism, but only while it is written
down: an unwritten norm resident in one agent's judgment is exactly what this program has learned not
to depend on.

Two failure modes, equally disqualifying:
- **Performing** the event (driving the real flow) — the rows become indistinguishable from human ones
  in the one store that exists to be non-synthetic.
- **Staging** the event so the data looks right. A human event performed to produce a desired outcome
  is contaminated exactly as an agent event is; the contamination is in the intent, not the actor.

What an agent *may* do: prepare the environment, observe, and verify **afterwards** from the recorded
artifact. What it may not do is supply the provenance.

Generalise it: **if an artifact's worth comes from who or what produced it, producing it destroys the
worth.** Calibration logs, human review sign-offs, user-acceptance records, ground-truth labels
collected to grade a model. Handle them like the signing key — the one step in the loop that is
somebody else's by design.

## Falsify against a disposable copy — never mutate the protected artifact

**Gates are read-only with respect to what they check, and their falsification harnesses must be too.**
Negative-case falsification runs in a scratch worktree or temp clone. Never delete, move or corrupt the
real artifact in place.

**Worked case, caught in the act.** Falsifying SG5's "the rules file exists" check was done by moving
`.claude/rules/gate-independence.md` aside, running the gate, and moving it back. The gate takes ~10
minutes; the command timed out **inside that window**, leaving the accumulated law of two missions
deleted from the working tree. It was restored and verified byte-identical (md5 `f3b79cd5…`), but the
exposure was real: any crash, timeout or interruption in that window loses the artifact.

This is the recurring family in new clothes — **a verification procedure that endangered the very
thing it verifies**, and made the protected artifact its own test fixture.

The correct shape costs no more:

```
git worktree add --detach /tmp/falsify HEAD
ln -s "$PWD/web/node_modules" /tmp/falsify/web/node_modules   # gates need their deps
cp -R out /tmp/falsify/out                                     # so the board grades real artifacts
rm /tmp/falsify/<the protected artifact>                       # sabotage the COPY
cd /tmp/falsify && <run the gate>                              # expect exactly one new failure
git worktree remove --force /tmp/falsify
```

It also buys **stronger** evidence than the unsafe version: full end-to-end gate wiring on the negative
case, matching `GSELF`'s grade, instead of a predicate proven in isolation with the wiring untested.
Cheaper *and* better is the usual sign the unsafe path was never the shortcut it looked like.

## Reporting convention: scope every negative claim

An Orchestrator aggregates agent reports, and **an unscoped negative aggregates into a global one.**
Say "untouched **by this change**" or "untouched **in this mission**" — never bare "untouched".

**Worked case.** An agent correctly reported `planGraphic.ts` untouched — true of *its* changes (a
`placeNear` signature addition whose default path is byte-identical). A different agent had legitimately
routed that file through the shared naming helper in the same mission. Aggregated without its scope,
the true claim became a false one, and the final commit was one hygiene check away from asserting it.
This is distinct from the failures above: not a gate trusting the wrong source, but a **scoped truth
presented without its scope.**

Same rule for "no regression", "nothing else changed" and "byte-identical" — name the population the
claim covers. `git diff --cached --stat` against the report before committing costs ten seconds and
catches the residue.

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
