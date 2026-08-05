# ADR 0005 — Branch 4a: generator search strategy

**Status:** results in — NULL RESULT; awaiting decision at the merge gate
**Date:** 2026-08-04

**Code anchors:** incumbent `autoGenerate` (`web/src/editor/search.ts`) ·
`STRATEGIES`, `STRATEGY_SEED_STRIDE`, `seedWindowOffset`
(`web/src/editor/strategy.ts`) · the solver `layout::generate`, `layout::score`
(`crates/ds-core/src/layout.rs`) · determinism contract
`tests::golden_generate_output_is_frozen` · harness rules `bench/README.md`

## Scope, and the conflation removed from it before it cost a round

The original Agent-4 list mixed three search strategies with one thing that is
not a search strategy. `validate-repair` guards **LLM-proposed program
parameters before the solver runs**; it composes with every search rather than
competing with any. Scoring it on best-score-within-budget would be scoring it on
not being the thing under consideration — the same conflation that had to be
split in the field for branch 1 (repair vs inference).

- **4a (this ADR)** — search strategies: `baseline`, `evolutionary`,
  `iterative-align`, `hard-constraints`.
- **4b (separate)** — `validate-repair` alone, on its own terms: catch rate on a
  corpus of deliberately bad LLM proposals, false-reject rate on known-good ones,
  repair quality where it repairs rather than rejects. Its bad-proposal corpus is
  built as ground truth **before** the validator exists. Runs after 4a, composes
  with 4a's winner.

**What is NOT in scope: the solver.** `layout::generate` stays exactly as it is,
deterministic per seed. Only the *search over seeds and programs* is swappable.
No candidate may make an LLM emit geometry.

## Seedability — the construction that makes variance definable

Variance-across-runs is undefined for a deterministic incumbent that returns
identical output by design. Rather than exempt one candidate from a metric,
**remove the undefinedness**:

> **Every candidate MUST be seedable: deterministic given a search seed.**

This extends the repo's per-seed determinism up into the search layer. A GA with
a fixed RNG seed is exactly as reproducible as the incumbent. The incumbent
needs no special-casing — `autoGenerate` already takes `opts.seedOffset`, which
*is* its search seed.

"Variance" then means **variance across search seeds at a fixed budget**, which
is defined for every candidate including baseline, and measures
reliability-of-search rather than being a metric one candidate is structurally
excused from.

**HARD GATE — determinism extends to the search layer.** Same
`(program, plate, budget, search-seed)` ⇒ **identical candidate list** (seeds,
strategies, scores, snapshots), for every strategy. A non-deterministic search is
disqualified at any score, exactly as a non-deterministic plate extractor was.

## Budget: fixed `generate()` call count, with wall-clock reported

Wall-clock and iteration-count favour different candidates, so the choice is
justified from measurement rather than taste. On the real 930.1 m² plate:

| | |
|---|---|
| `generate()` | **34.2 ms** |
| `snapshot()` | 0.2 ms |
| `state()` | 0.4 ms |

`generate()` is **161×** the surrounding bookkeeping, and it is the only cost
that scales with search effort.

**Budget = a fixed number of `generate()` calls** (primary), **wall-clock
reported alongside** (secondary, not the score).

- Machine-independent and exactly reproducible, which wall-clock is not.
- It does not hide a candidate's overhead: anything doing enough extra work to
  matter against 34 ms will show it in the wall-clock column.
- It refuses to reward a candidate for calling the solver *less* while claiming
  a better score — the comparison stays "same solver effort, whose search finds
  more".

Budgets: **15, 27 and 51 calls** — the incumbent's own spend at `maxIter` 4, 8
and 16, so the baseline is measured at exactly the budgets it was designed for
rather than at numbers chosen to suit a challenger.

**Loophole closed: work outside `generate()` is invisible to a call-count
budget.** A candidate that improves layouts through the fine-grained mutators
(`move_component`, `resize_zone`) rather than regeneration does real search work
that costs almost nothing in call-count terms. So, pre-registered as a rule
rather than left to the wall-clock column to notice:

> **A candidate whose wall-clock exceeds 2× the incumbent's at equal call count
> triggers a wall-clock-matched re-run, and BOTH results are reported.**

Call count stays the primary ruler — machine-independent and reproducible — but
no candidate can smuggle unbounded off-budget work past it.

The incumbent's `target` early-exit is **disabled for benching**: a candidate
that stops early has not spent the budget, and comparing a partial spend to a
full one measures nothing.

## Metric validity per candidate class

| metric | baseline | evolutionary | iterative-align | hard-constraints |
|---|---|---|---|---|
| best `LayoutScore.total` @ budget | ranking | ranking | ranking | ranking |
| circulation score @ budget | ranking | ranking | ranking | ranking |
| placed desks / pax | ranking | ranking | ranking | ranking |
| variance across search seeds | ranking | ranking | ranking | ranking |
| hard-constraint violations | **diagnostic** | **diagnostic** | **diagnostic** | **gate (must be 0)** |
| determinism | gate | gate | gate | gate |
| wall-clock | diagnostic | diagnostic | diagnostic | diagnostic |

Constraint violations are a **gate only for the code-aware candidate**, which
claims to enforce them in-pipeline. For the others the same number is a
diagnostic: they never claimed it, and gating them on it would be the mistake
this campaign has now made three times.

Any metric added after candidates exist is post-hoc, marked, and advisory until
it survives a round it did not shape (ADR 0004 amendment).

## Fixtures — and what stops this being theatre

Branch 1b's lesson was that fixtures the incumbent aces cannot discriminate. The
search-layer analogue is **fixtures that all favour re-seeding**: a plate where
seed variety alone finds a good answer will rank every candidate the same.

| fixture | why it is in the set |
|---|---|
| **real plate 930.1 m², standard program** | primary — the production case |
| real plate, **dense program** (desks 200) | capacity pressure: re-seeding cannot manufacture room, so a smarter search must show up in placed desks |
| real plate, **explicit `rooms` program** | counts are pinned, so search can only vary layout/scoring — isolates search from program luck |
| **small plate** (~90 m²) | the regime where the incumbent historically hit dead zones; little seed variety to exploit |
| **rot17 / tilted plate** | non-axis-aligned, where the packer's oriented path engages |
| **L-shape / notched plate** | concave, where a corrective step should beat a re-roll |
| **high-constraint program** (corridor 1.5 m, clearance 1.2 m) | the case `hard-constraints` exists for; the others should show violations here as a diagnostic |

The set is deliberately weighted toward regimes where **re-seeding has little to
find** — that is precisely where a genuinely better search must separate, and
where a null result would be meaningful rather than an artifact of easy fixtures.

## Predicted outcomes, with mechanism

Scores are `LayoutScore.total` (0–100-ish scale as produced today). Ranges are
deltas against baseline at the same budget, on the primary fixture.

**`baseline` — disjoint-seed-window re-seeding.** Three strategies × N seeds,
each seed an independent draw; no information carries between draws. Its ceiling
is the best of N independent samples, so it improves roughly with log(N) and
plateaus. Measured reference, not a prediction.

**`evolutionary` — multi-objective GA over program/strategy parameters.**
Mechanism: crossover/mutation over the weight vector and room mix, selection on
`LayoutScore`. Predicted **+2 to +6 total at 51 calls, −1 to +2 at 15 calls** —
a GA needs population turnover before it beats sampling, so at small budgets it
should *lose* to plain re-seeding by spending calls on a population it never
exploits. **If it wins at 15 calls, suspect the implementation is re-seeding
with extra steps.** Predicted variance **lower** than baseline at 51 (selection
concentrates), **higher** at 15 (population noise dominates).

**`iterative-align` — corrective step instead of a fresh draw.** Mechanism:
after evaluating, perturb the current best's placement/program locally rather
than re-drawing a new seed. Predicted **+3 to +8 on the concave and small
fixtures**, where the failure is a fixable local defect, and **−1 to +2 on the
primary**, where the plate is forgiving and re-seeding already samples well.
Its predicted signature is *fixture-dependent gains* — a uniform gain across all
fixtures would suggest it is not actually doing local correction.

**`hard-constraints` — code as in-pipeline constraint (AGPL clean-room).**
Mechanism: NBC 2016 rules as generator constraints rather than post-hoc scoring.
Predicted **0 violations by construction** (its gate) and **−2 to +3 total** —
constraint satisfaction costs search freedom, so a *lower* score at zero
violations is a legitimate, adoptable outcome and must not be read as a loss.
Predicted to win decisively on the high-constraint fixture and to be roughly
neutral elsewhere.

**Licence:** `poolpet/floorplan6` is AGPL-3.0 — **reference only, never
vendored**. Clean-room reimplementation against our own NBC 2016 rules, which
already exist in `layout.rs`/`circulation.rs`.

## Falsification

- `evolutionary`: no gain at 51 calls ⇒ the population never pays for itself at
  the budgets this product actually uses; drop it regardless of asymptotic
  promise.
- `iterative-align`: gains are uniform across fixtures ⇒ it is not doing local
  correction, and the mechanism claim is wrong even if the number is up.
- `hard-constraints`: any violation > 0 ⇒ its one claim is false; drop.
- Any candidate: non-deterministic given a search seed ⇒ disqualified at any
  score.
- All candidates within noise of baseline on every fixture ⇒ **null result**,
  recorded as such. Re-seeding across disjoint windows would then be the right
  design, and knowing that is worth the round.

## Protected invariants

- `layout::generate(program, seed)` unchanged and deterministic; the golden test
  must stay green.
- Claude designs strategy; the solver places every coordinate. No candidate may
  make an LLM emit geometry.
- Consequence-preview-before-apply for AI edits is untouched.

## Note for 4b — corpus provenance tiers

The 4b corpus would otherwise be the synthetic-fixture trap in a new costume: a
validator tested only against failures we imagined scores well and says little
about the failures Claude actually produces. The calibration log's humans-only
discipline does **not** transfer whole — that log needed evidence of human
*trust*, so automation was poison; this corpus needs coverage of Claude's actual
output *distribution*, and a harness driving the real prompt path produces genuine
Claude outputs. **Automation is not the contaminant here; unlabeled provenance
is.** Three tiers, and claims grade by tier:

| tier | source | status |
|---|---|---|
| 1 | hand-authored bad proposals | build-time; scores **advisory only** |
| 2 | harness-elicited across varied briefs (incl. absurd headcounts, contradictory emphasis, tiny plates) | genuine Claude distribution; brief distribution ≠ real users', so labeled |
| 3 | live-session, `isTrusted`-gated, with outcome (applied / rejected / scored-below-base) | **evidentiary** |

Built on 1, validated on 2, **trusted** on 3. Tier 3's outcome label is free
ground truth the refine loop already computes. Corpus size per tier is recorded
so 4b's claims are sized to their evidence.

## Results — a null result, and the metric error that nearly hid it

`node bench/runSearch.mjs`. 4 strategies × 7 fixtures × 3 budgets × 3 search
seeds. Predictions frozen in `9e2a182`.

### The headline metric was invalid, and the first run was a false positive

The first run showed large wins: `iterative-align` +4.1 to +6.8 on the primary,
`evolutionary` +1.6 to +4.8, both far outside their predicted ranges. Checking
*why* before writing it up found the flaw:

> `LayoutScore.total` is a weighted sum **using the program's own weights**
> (`layout/score.rs`: `total = w_capacity·capacity + …`). Two of the four
> candidates MUTATE those weights. They were raising `total` by shifting weight
> onto whatever already scored well — **optimizing the ruler, not the design.**

The fix was already in the codebase: `ai/refine.ts` computes `refScore` against
**fixed** weights for exactly this reason, so an LLM's program change cannot
flatter itself. Every candidate is now scored on the base program's weights
whatever program it searched with.

How much of the apparent gain was ruler-gaming, on `lshape-concave@51`:

| candidate | raw `total` | fixed yardstick | gap |
|---|---|---|---|
| baseline | 90.60 | 88.86 | +1.74 |
| evolutionary | 95.01 | 88.86 | **+6.15** |
| iterative-align | 97.60 | 88.68 | **+8.92** |
| hard-constraints | 90.16 | 88.33 | +1.83 |

The two weight-mutating candidates carry 3–5× the baseline's gap. **Their entire
advantage was the metric.**

### On the fixed yardstick — delta vs baseline, all budgets

| fixture | evolutionary | iterative-align | hard-constraints |
|---|---|---|---|
| real/standard | +0.00 | −0.36 | −0.51 |
| **real/dense** | **+1.57 / +1.61 / +1.73** | −0.30 | −0.65 |
| real/pinned-rooms | −0.05 | −0.11 | −0.61 |
| small-90m2 | +0.17 / 0 / 0 | +0.17 / 0 / 0 | −0.83 |
| tilted-17deg | −0.01 | −0.22 | −0.44 |
| lshape-concave | +0.00 | −0.18 | −0.53 |
| high-constraint | +0.00 | −0.30 | +0.00 |

(three numbers = budgets 15 / 27 / 51 where they differ.)

**This is the pre-registered null result.** Falsification said: *"All candidates
within noise of baseline on every fixture ⇒ null result, recorded as such.
Re-seeding across disjoint windows would then be the right design."*

### Mechanism tells, checked explicitly

- **`evolutionary`** predicted −1 to +2 at 15 calls: **in range** (+0.00). Predicted
  +2 to +6 at 51: **below** (+0.00 on the primary). Its one real gain is
  **+1.73 on `real/dense`**, and it *grows with budget* (+1.57 → +1.73) — exactly
  the mechanism working, in the one regime where program tuning has something to
  find, because `cluster_cols`/`bench_pairs` genuinely change packing under
  capacity pressure. Small, real, and confined.
- **`iterative-align`** predicted +3 to +8 on concave/small: **below** (−0.18 on
  lshape, 0 on small). Its registered tell was *"a uniform gain would falsify the
  mechanism"* — the actual is a **uniform slight loss** (−0.11 to −0.36 nearly
  everywhere), which falsifies it just as decisively: holding the seed and
  climbing in program space finds nothing the seed sweep did not.
- **`hard-constraints`** predicted −2 to +3: **in range** (−0.44 to −0.83). It
  costs a little score everywhere, as constraint satisfaction should. But see the
  gate below.

### The constraint gate is UNRESOLVED, not passed or failed

Every candidate — including baseline — reports **2 violations** on
`high-constraint`. A metric that returns the same value for a candidate designed
to eliminate violations and one that never claimed to is not measuring what it
claims.

`violations()` was written **after** the candidates existed, so per the ADR 0004
amendment it is **post-hoc and advisory**. It reads
`CirculationScore.min_corridor_width`, which is a global minimum over the whole
occupancy grid — including pinch points between furniture — not a corridor-width
compliance check. **`hard-constraints`' one claim is therefore untested**, and
this ADR does not record it as passed or failed. A real check needs a
corridor-specific measure the core does not currently expose.

### Variance across search seeds

Near-zero for every candidate on almost every fixture (sd ≤ 0.03 outside
`real/dense`, where evolutionary shows 0.24–0.66). Baseline's own sd is **0.00**:
different seed windows converge on the same best. That is itself the explanation
for the null result — **the solver's output quality is largely insensitive to
seed on these plates**, so there is little for any search to exploit, and
re-seeding is hard to beat because the thing it varies barely matters.

### Determinism gate

All four pass: same `(program, plate, budget, search-seed)` reproduces an
identical candidate list.

### Recommendation

**Adopt nothing.** The incumbent's disjoint-seed-window re-seeding is the right
design at the budgets this product uses, and that is now measured rather than
assumed.

Two things worth keeping from the round:

1. **The yardstick rule is now load-bearing beyond the AI loop.** Any future
   search comparison MUST score on fixed weights. Registering this as a standing
   rule alongside the metric-validity one — the failure mode is identical in
   shape: *a metric read as a score for something it was not defined over*, here
   across programs rather than across candidate classes.
2. **`evolutionary` under capacity pressure** (+1.73 on dense, growing with
   budget) is the only live thread. It is not adoptable as a general search, but
   "tune `cluster_cols`/`bench_pairs` when the program is capacity-bound" is a
   narrower, cheaper intervention that does not need a GA. Worth its own
   pre-registration if dense fit-outs matter commercially.

## Follow-ups: the seed-insensitivity finding, banked

### 1. Layouts DIFFER at equal score — Regenerate is not broken, but it is thin

`sd = 0.00` on the yardstick did not distinguish "all seeds find the same plan"
from "many different plans tie". Measured directly by hashing component
positions of the winning layout across five seed windows:

| window | best (yardstick) | winning seed | layout hash |
|---|---|---|---|
| 0 | 88.147 | 5 | `301dabf62918` |
| 1000 | 88.146 | 1005 | `170c7cec58cc` |
| 5000 | 88.146 | 5005 | `170c7cec58cc` |
| 20000 | 88.147 | 20005 | `301dabf62918` |
| 60000 | 88.147 | 60005 | `301dabf62918` |

**Two distinct layouts at effectively identical scores (Δ 0.001).** So:

- **Regenerate's premise holds** — sliding the window does produce a different
  plan, not the same plan re-dressed. No fix to file.
- **But diversity is thin**: five windows yield two plans, not five. The feature
  delivers *some* variety, less than its affordance implies.
- **Re-seeding's real value is diversity, which no metric in this branch
  measured.** That is a footnote the null result needs: the incumbent was scored
  only on best-score, and it may be earning its keep on a dimension the bake-off
  never looked at. Candidate diversity — the A/B/C the user actually picks
  among — is a genuine product dimension and currently unmeasured.

Observed and not over-claimed: the winning seed is the 5th of its window in all
five cases. Five samples is not enough to call that a pattern; noted for whoever
looks next.

### 2. The plateau is at ≤ 15 calls — the search can be cheaper

Best-vs-calls on the primary fixture reaches its ceiling at **13 calls** and
gains nothing over the next 38. The bench data confirms it is not a
one-fixture artifact — baseline's yardstick score from 15 → 51 calls:

| fixture | gain |
|---|---|
| real/standard, real/dense, real/pinned-rooms, lshape-concave, high-constraint | **+0.000** |
| tilted-17deg | +0.010 |
| small-90m2 | +0.170 |

`autoGenerate`'s default (`maxIter 8`) spends **27 calls ≈ 0.9 s**; the ceiling is
reached by 15 (≈ 0.5 s). **The default buys nothing measurable after ~13 calls.**

**Recommended but NOT applied here, because of finding 1:** score plateaus at 15,
but *diversity* may not, and diversity is the value the null suggests re-seeding
is actually providing. Cutting the default without measuring layout diversity at
each budget would optimise the metric we measured at the expense of the one we
just discovered we do not. The measurement is cheap and the machinery exists;
that is the next step, not a blind reduction.

## The rules family — one failure mode, nine faces

> **Four faces of one error: something read as evidence outside the conditions
> that made it evidence.**

Each was learned from a live mistake in this campaign.

1. **Metric validity** (ADR 0004) — a metric is only readable as a score for a
   candidate class it was defined over; otherwise UNDEFINED, not zero, not failed.
   *From:* phantom for `column-grid`, hierarchy for `baseline`, totals across
   differently-scoped engines.
2. **Late metrics** (ADR 0004 amendment) — a metric added after candidates exist
   is post-hoc: marked, given its own validity declaration at the moment of
   addition, and ADVISORY until it survives a round it did not shape.
   *From:* the accuracy metric fitted to the candidates' shapes.
3. **Fixed yardstick** (this ADR) — **any process able to modify the objective
   must be scored on a yardstick outside its reach.**
   *From:* two search candidates mutating the weights `total` is computed from,
   producing a false positive worth +6 to +9 points.
4. **Provenance of evidence** (ADR 0003) — evidence must carry how it was
   obtained; detection of the untrusted party fails open, so require positive
   proof of the trusted one.
   *From:* an automated confirm polluting the calibration log, and
   `navigator.webdriver` failing to catch it.
5. **Config is not conduct** (this ADR) — **a config value read as the spend,
   instead of the spend measured.** An allowance is not a behaviour.
   *From:* budgets of 15/27/51 derived from `maxIter` 4/8/16 while production
   actually spent 6, because an early-exit the config does not mention fired
   every time.

5b. **Declared conditions must be the DOMINANT variables** (ADR 0006) — the
   asset-shaped sibling of *config is not conduct*. **An asset-payload prediction
   must declare format and channel selection alongside resolution, or it is not a
   prediction about anything shippable.** Generally: checking *which variables
   dominate* is part of writing a prediction, not a discovery made against it.
   *From:* a `cc0-pbr` payload prediction that declared resolution (1–2K) and
   delivery model, while format and channel selection moved the number **5×** —
   more than the declared tier did. The prediction landed in range and the range
   was **accidental**: it was satisfied by numbers it never constrained.

6. **The instrument held the evidence** (ADR 0006) — **new measurement code is
   itself an untested candidate until something independent corroborates it. An
   indictment of an artifact must be verified against the ARTIFACT, not only
   through the instrument that produced the indictment. Re-measure before
   ROUTING a finding, not only before adopting one.**
   *From two instances, which makes it a pattern:*
   - the **position hash** declared "layouts differ across seed windows"; under a
     declared, product-meaningful definition they do not.
   - the **IFC reader** indicted our exporter for carrying no classification and
     no product identity, and derived a "self-defeating pricing" loop from it.
     Both attributes were present all along; the reader read `Name`. A five-minute
     look at the SPF would have shown `ObjectType` carrying the category.

   And the rule applies to the people holding the instruments, not only the
   code: the screenshot grid was blinded to protect the judge from expectation,
   and the render half of branch 5 was **stopped rather than rushed** to protect
   it from a degraded builder. Same recognition twice — *evidence quality is
   bounded by instrument quality, and the humans and agents are instruments.*

   Worth recording that the second one was **ratified, not merely made**: the
   finding was called the round's sharpest *in the review*, and an issue was
   routed partly on it. A reviewer amplifying an unverified indictment is part of
   the failure — the rule is not only "the measurer must check", it is "nobody
   promotes an indictment without the artifact being read directly".

7. **The brief is also an instrument** (plan-visual-grammar campaign) — **a
   reference description inside a brief is UNVERIFIED until Phase 0 confirms it
   against the primary artifact.** An imitation-shaped claim ("the reference does
   X, so build X") deserves the same scepticism as an indictment-shaped one.
   *From:* a styling brief whose three highest-leverage sub-steps described the
   qbiq reference as using dark wall poche, in-room name/area/pax labels, and
   near-white zone fills. Measured against the artifact sitting in the repo, the
   reference uses **none** of those — thin unfilled double-line walls, eight tiny
   service-room abbreviations with all identification in a legend, and
   high-saturation pastels at L 80–92%. The brief also asserted a file path and a
   prior spec (`research/qbiq-workbook-spec.json`) that do not exist, from stale
   context.

   The instruction was to build to the description; the artifact was two
   directories away. Checking it — rather than producing a spec that agreed with
   the brief — is what the phase was for.

8. **Re-measure, do not widen** (plan-grammar campaign) - a measurement reported
   through a lossy method carries that method's error. **The fix is a better
   measurement of the same primary artifact, not a wider tolerance.** Widening
   preserves the error and hides it inside the acceptance band.
   *From:* an owner palette first sampled with 8-value quantization - every
   channel on the ladder {8c, c4, d4, dc, e4, ec, f4, fc}, i.e. plus/minus 18
   approximations by construction. The first instinct was to absorb that by
   widening conformance tolerance to match. The correct move, taken instead, was
   re-sampling the same screenshots losslessly: exact hexes, two-source
   agreement, and tolerance *shrank* to delta-E <= 3 covering capture
   colour-profile only.

   Two riders worth keeping. **Source rank matters**: the marketing feature card
   disagreed with the app views (#d4e4f3 vs #d9e7f4) - resampling degradation in
   a resized embed, which is why app views outrank marketing assets and why the
   disagreement is useful as a negative control rather than noise. And **the
   artifact can be the authority, not a proxy for it**: the owner pointed at
   these screenshots and said "this", so if the live product drifts a hex, the
   target does not move. Verifying against the live site was worth attempting and
   worth recording as inconclusive, but promotion never depended on it.

9. **A uniform error hides inside a ratio** (plan-grammar campaign) — **when a
   system is judged on RELATIVE values, any error applied uniformly to all of
   them is invisible in the thing being judged.** Checking the output cannot
   find it; only a rule about the code can.
   *From:* `strokePx` multiplied by `devicePixelRatio` while the canvas context
   was already `setTransform(dpr, …)`, so every stroke drew at exactly 2× on a
   retina display. The weight ladder is defined purely by ratios
   (furniture 1× → wall 2× → enclosure 7.05×), and 2× preserves all of them
   perfectly. It was written, reviewed and shipped in 2a, and every screenshot
   taken to verify 2a showed a correct-looking hierarchy.

   The rider is about justification, not just code: the function's docstring
   argued *for* the multiply ("so a 2× display does not draw half-weight
   hairlines") and a further comment reasoned carefully about clamping before
   versus after it. Both were rigorous arguments about a term that should not
   have existed, and the clamp comment's stated goal — the clamp meaning the
   same physical width on every display — was precisely what the double-apply
   destroyed. **A confident rationale attached to a value is not evidence the
   value belongs; it is what stops anyone asking.**

   **Ownership, recorded because it changes who the rider is aimed at:** the
   clamp-order comment was not the author's flourish — the REVIEWER mandated it.
   A comment was ordered to protect the ordering of an operand that should not
   have existed. So the general form is not "watch out for authors defending
   their code":

   > **A careful justification is not evidence that the thing justified should
   > exist. Rigour about the relationship between terms proves nothing about the
   > terms.**

   Both artifacts — the author's docstring and the reviewer's mandated comment —
   were locally rigorous and globally wrong, and the second was produced by the
   very process meant to catch the first. Review that reasons *within* a
   construct cannot see that the construct is unnecessary. Ask what a term is
   for before asking whether it is handled correctly.

   Detection rule that follows: for a ratio-defined system, assert the
   ABSOLUTE contract somewhere a uniform error cannot satisfy — here, a gate
   rule that `strokePx` may not reference DPR at all.

**And a standing requirement that falls out of the same discipline: every
trigger needs a SENSOR.** A trigger without something watching for it is a wish.
Audited across the campaign:

| trigger | sensor | status |
|---|---|---|
| 1a activates on a real-world plate correction | `plateLog` outcomes | exists |
| 4b opens on tier-2/tier-3 corpus rows | `proposalLog` + `corpusSizes()` | exists |
| IFC upgrade is pre-work for `blender-offline` | Agent 5's own scope | exists |
| compliance metric before any compliance claim | *(human gate — no sensor possible)* | declared |
| **`target: 82` revisit** | **`searchLog` — added in this change** | **now exists** |
| **`strokePx` must not re-apply DPR** | **`bench/style-gate.mjs` DPR-contract rule** | **now exists** |
| **no style literal in the plan render path** | **`bench/style-gate.mjs` (4 files guarded)** | **exists** |
| **`ACCENT_AMBER` must equal `--accent-amber`** | **`bench/style-gate.mjs` MIRRORS check** | **now exists** |
| **a browser check must prove WHICH TREE it measures** | **`bench/assert-build.mjs` + build-provenance meta tags** | **now exists** |

The fourth instance of the family will come. When it does, add it here rather
than treating it as new.

### Worked example — the rule applied one level up

The plateau finding offered a free 0.4 s: score tops out at 15 calls and the
default spends 27. It was **declined**, because the same measurement showed
diversity is a real and *unmeasured* dimension of what re-seeding buys.

Cutting the default would have optimised the metric we had at the expense of the
one we had just learned we lacked — Goodhart one level up. Not merely *"don't let
the measured hold the ruler"*, but:

> **Don't act on a ruler you know is missing a dimension. Measure the missing
> dimension first, or state that you are trading it away.**

## Closing measurement — diversity per budget

Pre-registered here **before running**, per the discipline.

### What "distinct" means — declared, because it is a product judgment

Position-hashing is too brittle (one chair moves ⇒ "new layout") to support a
diversity claim. Two plans are **distinct** if EITHER:

- **(a) zone topology differs** — the multiset of `(zone_type, area rounded to
  5 m²)` is not equal; or
- **(b) placement diverges** — more than **20 %** of components sit more than
  **1.0 m** from the nearest same-category component in the other plan.

Coarse on purpose: (a) catches "a different room mix", (b) catches "same rooms,
genuinely rearranged". Every diversity number below is made under this
definition, and a different threshold would give different numbers — which is
exactly why it is stated rather than assumed.

### The grid measured is the one the product shows

Users pick among **A/B/C cards** — one per strategy, each the best seed in its
window — not among seed windows in isolation. So both questions are answered on
that grid:

1. **Between windows:** does pressing Regenerate produce a different card set?
2. **Within a set:** do the three cards the user is shown differ from each other?

The 2-of-5 seed-side finding says seed diversity is thin; whether **strategy**
diversity carries the product is the open half.

### Decision rule — pre-stated

- **If diversity@15 ≈ diversity@27** (within one distinct plan): cut the default
  to 15 calls and bank the speed-up.
- **If diversity grows past the score plateau**: set the default at the
  *diversity* plateau, and record that the product pays calls for **options, not
  points**.
- **If the A/B/C cards are near-duplicates of each other**: that is a product
  finding filed with a trigger, not something fixed in this branch.

### Results

**Q2 — do the three A/B/C cards differ from each other? YES, 3 of 3**, at every
window and both budgets (scores 88.15 / 87.73 / 87.17). Strategy-side diversity
carries the product; the cards the user picks among are genuinely different
plans. No product finding here.

**Q1 — does Regenerate change the card set? NO.** One distinct card set across
four windows, at both budgets. Pooled across all windows × strategies: **3
distinct plans out of 12** — and those 3 are exactly the 3 strategies.

**This contradicts, and corrects, the earlier finding in this ADR.** The previous
"layouts DIFFER at equal score (2 of 5)" was measured with a position hash, and
that hash is too brittle to support a diversity claim — one chair moving reads as
a new layout. Under the declared definition, different seed windows produce
**equivalent** plans. The earlier conclusion is withdrawn; declaring the
definition first is what surfaced the error.

### The decision rule's premise was void — and the reason is the finding

The rule said: *diversity@15 ≈ diversity@27 ⇒ cut the default to 15 and bank the
speed-up.* Diversity is indeed equal. **But there is no speed-up to bank**, because
the premise "the default spends 27 calls" is false.

A faithful replay of `autoGenerate` **with production settings** (`maxIter: 18`,
`target: 82`, early-exit ACTIVE — which benching correctly disabled but production
does not):

| configuration | calls | wall-clock |
|---|---|---|
| **production default (18, target 82)** | **6** | **129 ms** |
| same, early-exit disabled | 57 | 1930 ms |
| maxIter 4, target 82 | 6 | 106 ms |
| Regenerate round 1 / 2 / 3 (maxIter 26 / 34 / 42) | **6 / 6 / 6** | ~107 ms each |

**The search does not search.** `target: 82` is below what seed 1 of each strategy
already scores (~87–90 raw), so every strategy exits after its first draw. Three
generates plus three snapshot re-generates = 6 calls, and that number does not
move whatever `maxIter` says.

Three consequences:

1. **No speed-up exists.** Cutting `maxIter` changes nothing; the earlier "free
   0.4 s" claim in this ADR was reasoned from the benched configuration and is
   withdrawn.
2. **`maxIter` is dead configuration on this plate**, and `GenerateStep`'s
   "grow the budget each Regenerate round" (`18 + round*8`) does nothing at all.
3. **The bake-off's budgets did not match production.** 15/27/51 were derived
   from `maxIter` 4/8/16 without checking what production actually spends — 6.
   The null likely holds a fortiori (less search cannot beat more), but the
   budgets were 2.5–8.5× reality, and that is my error to own: **I read a config
   value as the spend instead of measuring the spend.** Same family as the rest —
   evidence read outside the conditions that made it evidence.

### Filed with a trigger, not fixed here

> ### PRODUCT FINDING: Regenerate delivers no new plans
>
> Both halves together: seed windows produce **equivalent** plans under the
> declared definition, **and** every strategy exits on its first draw. So the
> Regenerate button re-serves the same three plans, while the `maxIter` it grows
> each round (`18 + round*8`) changes nothing. **It is a user-visible control
> that appears to act and does not.**
>
> Not a config nuance, and not fixed here — variety costs either exploration
> (raise `target`, eat 129 ms → 1.9 s) or diversity-aware selection (keep N
> distinct layouts, new logic), and that trade belongs to a product owner. Filed
> so the decision is made looking at the actual behaviour.
>
> **Trigger:** a plate where seed 1 does *not* clear the target (today's
> behaviour silently becomes a 1.9 s search), or diversity becoming a priority.
> **Sensor:** `persist/searchLog.ts` — records calls made vs `maxIter` allowed,
> which strategies exited early, wall-clock, and Regenerate presses.
> `searchTriggers()` answers both halves directly. Without it the trigger could
> never fire, because nobody was watching.

## 4a's closing conclusion

Adopt-nothing stands *a fortiori*: production runs **6** calls, the bake-off
tested 15–51, and no candidate won even at 2.5–8.5× production's budget.

But the branch's real conclusion is different in kind from "no challenger won":

> **The product's search quality is currently determined by one knob (`target`)
> and the generator's seed-1 strength — not by the search loop at all.**

Every strategy clears the bar on its first draw, which is why `maxIter` is inert,
why Regenerate re-serves the same plans, why variance across seed windows is
~0.00, and why no search strategy could separate. It is also a compliment to
`layout.rs`: the generator is good enough that its *first* attempt is good
enough. That single fact explains every number in this branch.

## Untested claim, routed with a trigger

`hard-constraints` claimed zero code violations and that claim is **untested** —
`violations()` returned 2 for every candidate including baseline, which measures
nothing (see above). It is not resurrected here: it lost on score and its
adoption question is moot.

But the unresolved gate revealed something larger than one candidate. **The
product claims NBC 2016-grounded generation and an ADA/IBC-grounded circulation
score, and we currently have no metric able to verify a compliance claim.**
`min_corridor_width` is a global occupancy-grid minimum including furniture pinch
points — not corridor compliance as any code defines it.

> **Trigger: before any production or marketing claim of code compliance, a
> validated compliance metric must exist** — measuring corridor width as the code
> defines it, not a grid minimum.

Same species as "our IFC is viewer-grade": a product assertion whose truth is
unmeasured. `hard-constraints`' claim is recorded as *untested-pending-that-metric*
so that if the metric is ever built, its one question is an afternoon's work.

## Branch 4b — deferred on its own evidence rule

Tier 2 is empty (no `ANTHROPIC_API_KEY`) and tier 3 is empty (no live sessions
yet). Building the validator now means building against tier 1 alone — hand-
authored failures we imagined — which is exactly the trap the tier system was
designed to avoid.

> **Trigger: 4b opens when tier 2 has a first elicited batch (key present) or
> tier 3 has its first live rows, whichever comes first.**

Tier-3 capture shipped with this branch (`persist/proposalLog.ts`, DB v4), so the
trigger is real rather than aspirational. Deferring a branch because its evidence
does not exist yet is the discipline.
