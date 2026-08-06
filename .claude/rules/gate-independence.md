# Gate Independence

**A gate may not consume any value produced by the system under test. It must re-derive its ground
truth independently — from the artifact bytes, or from the core state.**

Trust requires positive evidence from an independent path. A gate that reads the producer's own
account of what it did is not measuring the producer; it is transcribing it.

**The unified form.** Every section below is that one statement projected onto a different surface:

> **A check is only as good as the independence of its inputs, and independence must be positively
> established, never assumed.**

Gates trusting their subject's metadata · baselines drawn from the population under test ·
presence-matching two contaminated lists · a board trusting its gates' exit codes · a falsification
harness endangering its own subject · an agent performing a trusted-human event — all the same
violation, wearing the clothes of whatever surface it appeared on. The sections earn their place by
naming a surface where it happened *in practice*, with the concrete pattern a future reader needs.

**There will be a thirteenth instance, on a surface no section below describes.** Recognise it by the
unified form, not by matching an existing example: ask what the check's inputs are, who produced them,
and what positive evidence establishes that they did not come from the thing being checked. Then add
the section — with its worked case and its falsification, like every one below.

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

## A one-sided threshold can be propped up by ink the check does not attribute

**The surface: a coverage FLOOR measured over a shared canvas.** G11's visibility
assertion (`g11-furniture-agreement.py`) takes each billed furniture instance,
counts furniture line-work ink inside its footprint, and requires
`ink / outline >= 0.70`. The intent is honest: a component the workbook bills must
actually read on the delivered PNG.

The input is not independent of the rest of the drawing. **Ink inside a
footprint is attributed to that footprint, not to the glyph that drew it.** A
neighbouring symbol whose decoration falls inside a real component's footprint
raises that component's ratio. On the merged tree the concrete case is a table's
implied seat ring landing over the real adjacent `Chair` components: decorative
line-work propping up the very measurement meant to prove the real chair is
legible. A genuinely faint or hidden chair can clear the floor **on borrowed
ink**, and the gate reports it as visible.

The same one-sidedness has a second consequence: the check has **no upper
bound**, and nothing anywhere iterates the PNG looking for ink that is *not*
billed. Over-draw — seating on a graded sheet that the Furniture Inventory does
not bill — is invisible to it. G11 has exactly two assertions: emission compares
the workbook's billed multiset against the core-state multiset (glyph-drawn
seats appear in neither), and visibility is this floor. Neither can see a glyph
drawing something nobody bills.

**Why it is the unified form.** Ask the three questions: what are the check's
inputs (ink pixels within a footprint), who produced them (any glyph that
rendered there, not only the subject's), and what positive evidence establishes
they did not come from something other than the thing being checked (none —
attribution is assumed from position).

**The falsification: RUN, and the result is recorded below.** Render the pack
twice, once with implied seating on and once off (`implySeats: false` on the
print path), and diff the per-instance `ink / outline` ratios. Any chair whose ratio drops below the floor
when the implied seats disappear was being carried by ink that was never its
own. Fixing the double-draw is necessary but not sufficient: the attribution
weakness survives it, because any future glyph whose decoration overlaps a
billed footprint reintroduces it.

**RESULT (three-branch merge, seeded pack, 189 instances / 18 rooms).** Run in a
disposable worktree, flipping `implySeats` in `printPlan.ts` — NOT in
`planGraphic.ts`, whose own flag governs a different draw call. The first attempt
flipped the wrong one and produced byte-identical statistics; that identity was
the signal the wrong flag had been flipped, not evidence of independence.

| | min | p25 | median |
|---|---|---|---|
| shipped (`implySeats: false`) | 1.52 | 1.94 | 2.18 |
| implied seating ON | 1.52 | 2.18 | 2.31 |

The borrowing effect is **real and measurable** — implied rings lift the quartile
by 0.24 and the median by 0.13, so ink that is not a component's own does reach
its footprint. But **no billed instance depends on it**: with that ink gone the
worst instance still scores 1.52 against a 0.70 floor, 2.2x clear. The concern
this section raises is therefore not live on this pack.

The attribution weakness itself SURVIVES that result and is unchanged: nothing
attributes ink to the glyph that drew it, so any future decoration overlapping a
billed footprint reintroduces it, and over-draw (ink nobody bills) is still
invisible to a one-sided floor.

**The fix shape**, when it is addressed: attribute ink to the glyph that drew it
rather than to the footprint it lands in — draw each billed instance to an
isolated buffer and measure there — or add the missing upper bound so unbilled
ink is a failure in its own right. Until then the floor is a real check with a
stated blind spot, not a proof of legibility.


## The tooling layer: a success message is not evidence that anything changed

**The surface: an edit script reporting its own result.** A script applies a
string replacement and prints "applied". Python's `str.replace` returns the
original string when the pattern does not match, and the print runs regardless —
so the report is produced by the thing being reported on, with nothing
independent confirming the write landed.

**The worked case.** `implySeats: false` was added to `pdf.ts` and the script
said so. The anchor used twelve-space indentation where the file has ten; the
replace silently no-opped; the line was never in the tree. A commit then
described the change as landed. **The identical pattern repeated on the first
retry**, printing success while `grep` showed zero occurrences — which is how it
was finally caught. Two rounds, and the only reason it surfaced at all is that a
reviewer read the tree instead of the report.

No board caught it: `out/plan.png` comes from a renderer that HAD the fix, so the
graded artifact was clean while the ungraded PDF deliverable double-drew seating.

**Why it is the unified form.** The check's input is the script's own stdout,
produced by the process under test, with no positive evidence the file changed.
It is `gate trusting its subject's metadata`, one layer down — the subject here
being the tooling rather than an artifact.

**The falsification, and it is free.** Assert the anchor exists BEFORE replacing,
and re-read the file AFTER writing:

    assert old in s, 'anchor not found — refusing to report success'
    s = s.replace(old, new, 1); open(p,'w').write(s)
    assert new_marker in open(p).read(), 'write did not take'

A script that cannot fail loudly will report success quietly. The same applies to
any generated report: if the producer also writes the verdict, the verdict is a
claim, not a measurement.


## A scalar is not geometry — settle shape disputes with tables

**The surface: a classification or identity argument decided from one summary
number.** Three instances in a single audit cycle, each pointing the wrong way,
each corrected the moment somebody printed a table instead.

| # | the scalar | what it said | what a table said |
|---|---|---|---|
| 1 | per-pocket distance transform, computed *inside* each pocket | ~150 m² of leftover floor is too narrow to be circulation | 64 m². The DT was truncated at each pocket's own boundary; the classifier measures clearance over the whole walkable mask, which is the space a person actually has. Off by ~2×. |
| 2 | "the 80 m² upper-right **wing**", plus one max-inscribed-width of 4.4 m | an 80 m² room-shaped void is being billed as corridor | compactness 0.085 over 41 vertices spanning 32.8 m — *less* compact than a 2 × 40 m corridor. A wall-following ribbon. The prose label and the scalar agreed with each other and were both wrong. |
| 3 | "residual pockets overlap rooms, so the tie-break is load-bearing" | reverting `zone_index_at`'s ground tie-break will move the workstation count | zero failures. Residual pockets are strictly disjoint by construction; the tie-break never fires. |

In all three the scalar was *correctly computed*. It was the wrong measurement,
or a measurement of the wrong population, and nothing about the number itself
said so. A max-inscribed width cannot distinguish a 4 m-wide blob from a 4 m-wide
spot in a ribbon; an area cannot distinguish a corridor from a clearing; a
truncated DT is a different quantity from the one the classifier uses.

**The rule.** When a dispute is about *what a shape is* — corridor vs clearing,
room vs residue, whether two things are the same object — produce the **table**:
one row per instance, with the descriptors that can actually separate the classes
(area AND perimeter AND compactness AND vertex count AND bbox aspect), computed
the way the system under test computes them. One number, or a prose noun, is a
hypothesis. It may be right; it may not be checkable.

**Corollary — a prose label is a scalar.** "The wing", "the corridor", "the dead
corner" are compressions with the same failure mode, and they are more dangerous
because they read as observation rather than inference. Instance 2 was a label
the author (an agent) wrote and the reviewer (a human) then reasoned from; the
error survived a round-trip through both because neither had looked at the shape.

## The falsification round is the closing move — and it must include the enabling step

**The surface: a commit that adds a guard, whose guard is itself unguarded.**

A falsification pair built around a *feature* can leave the *step that makes the
feature meaningful* completely untested, and the suite stays green.

**Worked case.** A shape conjunct was added to a classifier, with the correct
pair: a compact pocket must be rejected (watched RED before the conjunct existed,
green after) and a corridor-shaped one must survive (falsified by driving the
threshold until it failed, since a true red was structurally unavailable — that
asymmetry is normal and should be reported, not papered over). Both fired.

The conjunct only means anything because the shape is measured on an
RDP-**simplified** boundary: raw, a staircase-traced corridor scores 0.095 and a
smooth one of identical footprint scores 0.142, so the threshold would have been
deciding verdicts on tracing resolution. **Disabling the simplification entirely
left all 168 tests green.** The fix had shipped with no guard at all — not a
guard that rotted, a guard that was never written — and only a third sabotage,
run because the round was being done exhaustively rather than to a checklist,
found it.

**The rule.** Any commit claiming to add or repair a guard closes with a
**sabotage round**: disable each part of the mechanism in turn — the assertion,
the threshold, **and every enabling transform the assertion depends on** — and
confirm each produces a red. A part whose removal changes nothing is not
conservative; it is unguarded, and the suite is asserting coverage it does not
have. Sabotage runs against a disposable copy (see above), and the null results
are reported, not just the fires: *"disabling X left the suite green"* is the
most valuable line the round produces.

**Family.** This joins *a check whose subject moved out from under it* — the
vacuous residual filter, and a parity guard that crashed for two months while
listed as passing. They are not the same defect (one is a guard that lost its
grip; this is a guard that was never attached) but they are one family:
**green boards that do not guard what they claim.** The unified question is the
same one this file opens with — what positive evidence establishes that this
check would fail if the thing it checks were broken?

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
