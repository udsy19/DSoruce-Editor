# CAD import — solution plan

Companion to [`findings/00-SUMMARY.md`](findings/00-SUMMARY.md). One section per finding, in the
order they should be built. **Nothing here is implemented yet** — this is the design to approve.

---

## Sequencing, and why it matters

The ten findings are not ten independent bugs. Two of them are root causes and the rest are
downstream:

```
F1 scale ──┬──► F3 no plate (4 of 6 files)
           ├──► F4 empty plan scored as success (all 13)
           └──► F7 cluster filter (interacts: its 60 m floor is scale-dependent)

F2 category ─┬─► F3 no plate (2 of 6 files)
             ├─► F8 vacuous coverage (zero furniture detected)
             └─► empty "Detected program" readouts

F5/F6 converter ── independent, cheap, do first
F9 gating ──────── independent of all of them, and the only one that limits the blast radius
```

**Build order: S5+S6 → S9 → S1 → S2 → re-measure → S3/S4/S7/S8 → S10.**

The converter fixes (S5, S6) are small and independent. **S9 (gating) comes before the deep fixes**
on purpose: it converts every remaining silent failure into a visible one, so the rest of the work
can be verified by a user rather than only by a harness. F1 and F2 are then the substance. F3, F4,
F7 and F8 must be **re-measured after S1 and S2 land** — several of them may shrink to nothing, and
any fix written before that re-measurement would be calibrated against the wrong population.

## Method: the gate comes first

Per `.claude/rules/gate-independence.md`, for each fix below:

1. **Write the gate first and watch it fail** on the unfixed corpus. A gate written afterwards can
   only confirm the fix; it can never audit it.
2. **Anchor the gate to the property, not the prescription.** Every root cause named in this document
   is a hypothesis. Two of them (F7's contribution to AG, F4's split into two defects) are already
   flagged as uncertain, and the gate must be able to falsify them.
3. **Re-derive independently** — the gate may not read the value the fix produces. The harnesses in
   `harness/` are already built this way and become the regression suite.

The corpus is the fixture set: 24 files, of which 2 pass today. **The number to move is
2/24 → as high as it goes**, with the control fixture never regressing.

---

# S1 — Derive scale from geometry; treat `$INSUNITS` as a hint

**Fixes [F1](findings/F1-unit-scale-trusted-blindly.md). Critical. Largest single win.**

### The change

`web/src/import/dxf.ts`, `metersPerUnit()` currently returns a scale from `$INSUNITS` alone.
Replace with a two-stage decision:

1. **Candidate scale** from `$INSUNITS` as today (unchanged, including the inches default).
2. **Validate it against the geometry**, and if it fails, pick the unit that passes.

The validator uses anchors that are true by construction, in descending order of strength:

| Anchor | Physical band | Source of the band |
|---|---|---|
| Modal door-swing arc radius on door-ish layers | 0.65–1.30 m | IBC 1010.1.1, NBC 2016 Part 4, DIN 18101 |
| Modal parallel-wall pair spacing | 0.075–0.40 m | wall assembly thickness |
| Overall drawing extent (long side) | 3–500 m | a building |

`harness/scaleAnchor.mjs` already implements the first anchor and returns the correction factor per
file — that code is the prototype for this, not a throwaway.

Choose the unit for which the strongest available anchor lands in band. Record the decision on
`Drawing` as `unitsSource: 'header' | 'door-anchor' | 'wall-anchor' | 'extent' | 'header-unverified'`
so the UI can say *why*, and so the gate can assert on it.

### Where it must NOT go

Not a "if the plate looks small, multiply by 25" patch downstream. The scale is wrong at
`parseDrawing`, and every consumer — bounds, cluster filter, plate, circulation, cost, takeoff —
inherits it. Fix it at the root or it resurfaces in each consumer separately.

### Gate — `scale-anchor.test.mjs`

Anchored to the property *"a door in this drawing is a legal door"*, not to the fix.

- **Falsification, written and run first:** on the unfixed corpus it must name
  `AG, AG (1), AA, Apartment-413201, Apto.1404202` as mis-scaled. It does today
  (`reports/_scaleAnchor.json`) — this is the E7 discipline: watch it fail before fixing, and
  believe its count over the defect report's.
- **Independence demonstration:** rewrite `$INSUNITS` in the DXF to every legal code, and to
  garbage, and delete the variable entirely — **the chosen scale must be byte-identical** on any
  file where a door anchor exists. That single check proves the header has no influence left.
  An assertion that merely "still passes" proves nothing.
- **Control:** `samples/furniture-plan.dwg` and `fast-food-Restaurant.dwg` must be **unchanged** —
  their headers are already correct, and a fix that moves a correct file is a regression.
- **No-evidence case:** a drawing with no doors, no wall pairs and an ambiguous extent must fall
  back to the header and mark `unitsSource: 'header-unverified'` — and the UI must surface that,
  because an unverified scale is exactly the state that produced this finding.

### Open question for the user

When the anchors contradict the header, do we **auto-correct** silently, or **auto-correct and tell
the user** ("this drawing declares millimetres; its doors are 855 mm wide, so it was read as
metres")? Recommendation: **correct and tell**, matching the existing "Check the floor plate"
pattern, which is already the right precedent in this codebase.

---

# S2 — Classify by geometry, not only by layer name

**Fixes [F2](findings/F2-layer-category-inference.md). Critical.**

### The change

`categoryFor(layer, blockName)` stays as the **first** rung — it is correct and cheap when layer
names follow AIA/NCS. Add rungs beneath it, so `other` becomes a genuine last resort:

1. **Multilingual layer vocabulary.** `muro`/`pared`, `puerta`, `ventana`, `mobiliario`/`mueble`,
   `piso`, `columna` (Spanish — 3 files in this corpus alone); the same for the handful of other
   languages worth carrying. Cheap, and it fixes `MOBILIARIO HOSPITAL` and `muebles varios` outright.
2. **Geometric wall detection**, which needs no names at all: long, parallel, closely-spaced line
   pairs (0.075–0.40 m apart, > 1 m long) are walls. This is what rescues the numeric-layer files
   and `AL`, which has **no layer table**.
3. **Block-content heuristics** for furniture: a repeated INSERT of a 0.4–2.0 m block placed many
   times is furniture regardless of its layer.

Set a `categorySource` field per entity for the same reason as `unitsSource` — so the gate can tell
which rung fired, and so a regression in rung 1 cannot hide behind rung 2.

### Gate — `category-inference.test.mjs`

- **Falsification first:** assert that today's classifier yields ≥ 70 % `other` on 13 of 21 parsed
  files and 100 % on 4. It does (`reports/_all.json`).
- **Property anchored, not fix anchored:** the assertion is *"a drawing that a human reads as
  having walls yields wall segments"* — specifically, `collectWallSegments(drawing).length > 0` for
  every file whose linework contains ≥ 20 qualifying parallel pairs. Note this deliberately does
  **not** assert a category *count*, because emission is not correctness: an entity classified
  `wall` that is actually a hatch line satisfies any count-exact check while making the plate worse.
- **Anti-contamination:** the parallel-pair thresholds come from wall-assembly dimensions, **not**
  from measuring this corpus. Calibrating the classifier on the files it is being tested against is
  the mistake `.claude/rules/gate-independence.md` documents under "never calibrate against the
  population under test".
- **Control:** the control fixture's category histogram must not change — it already classifies
  correctly via rung 1, so rungs 2 and 3 must be inert on it.

---

# S3 — `extractPlate`: fail loudly, and stop using an absolute area floor

**Fixes [F3](findings/F3-no-plate-derived.md). High. Re-measure after S1+S2.**

Expect most of the 6 failures to disappear once scale and categories are right. What remains is a
design flaw worth fixing regardless:

1. **`MIN_PLATE_AREA = 1` m² is absolute** (`testfit.ts:72`) and silently rejects every candidate on
   an under-scaled drawing. Make it relative to the drawing's own extent, so it means "this loop is
   noise relative to this building" rather than "smaller than one square metre".
2. **`null` must carry a reason.** `derivePlate` returning bare `null` forces `App.tsx` to guess a
   message ("No wall geometry found in this drawing"), which was wrong on 4 of the 6 files — they
   had wall geometry; it was 1000× too small. Return a discriminated failure
   (`{ ok: false, reason: 'no-shell-segments' | 'all-candidates-below-area-floor' | … }`) and let
   the UI say the true thing. A missing input must be a failure with a name, never a silent skip.

### Gate

Re-run `harness/e2e.mjs`; assert the count of `NO PLATE` files strictly decreases and that each
remaining one reports a specific `reason`. Control fixture unchanged at 930.1 m².

---

# S4 — A generation that places nothing is a failure, not a low score

**Fixes [F4](findings/F4-empty-plan-scored-as-success.md). Critical. The user-facing headline.**

Two separable defects; fix both.

### S4a — `generate()` must report placement failure distinguishably

`placed_desks: 0` against a program requesting 20 desks is a failed generation. The caller
(`EditorCanvas.autoGenerate`, the wizard's candidate gallery) must be able to see that without
inspecting core state. Today it is buried in a metrics field nobody gates on.

### S4b — A score over an empty population must be undefined, not 100

`adjacency: 100`, `daylight: 100`, `entry_adjacency: 100` on a plan with zero components. Each
divides by an empty set and returns its maximum. `circulation` is worse than uninformative: an empty
78 m² plate scores **90.5**, *higher than the control's 82.2* with 104 real desks and real corridors.

These must return an explicit "not applicable" that propagates — a plan with no components has no
adjacency, and the composite `total` must not be computed as though it did. This is the same vacuous
-truth family as [F8](findings/F8-vacuous-coverage-claim.md); fix the family, not the instances, or
it relocates (which is exactly what the `floorRectPurity` case in the rules file did).

### Gate — `empty-plan-is-not-a-success.test.mjs`

- **Falsification first:** build the artifact the gate must catch — an `Editor` with a 2.5 m² plate
  and `DEFAULT_PROGRAM` — and assert it currently reports `total: 38.7` with three sub-scores at 100.
  It does (`reports/_e2e.json`).
- **Model-conditioned, not flag-conditioned:** assert *"when the document bills zero components, no
  sub-score is 100"* — conditioned on core state, which cannot be dropped, rather than on a
  generator-emitted success flag, which can.
- **Ordering property:** assert the empty 78 m² plate scores **strictly below** the control's
  populated plate on circulation. This is the assertion that catches the inversion; a threshold on
  the absolute value would not.

---

# S5 — Verify the DXF the converter produced, from its bytes

**Fixes [F5](findings/F5-converter-integrity.md). High. Small, independent — do first.**

`dwgConvert.ts:40-45` and the matching path in `deploy/apiCore.ts` accept the conversion on the
child's **exit code alone**. `Apartment-1.dwg` exits 0 having written a file with no `ENTITIES`
section and no `EOF` marker, and the API returns **200 OK** with it.

Add a structural check on the produced bytes before responding — derived from the artifact, not from
the producer's status:

- the text contains a `SECTION` / `ENTITIES` pair, and
- it terminates with an `EOF` group, and
- `parseDrawing` on it does not throw.

Any failure → the same non-2xx path as a crash, with a message that says the **conversion** was
incomplete rather than blaming the user's file.

**Lockstep:** `web/vite.config.ts`'s dev middleware and `deploy/apiCore.ts` must change together —
per `CLAUDE.md` they are one derivation with two copies, and drift between them is exactly what
`.claude/rules/no-bloat.md` catches from the other side.

### Gate

Assert `POST /api/dwg` with `Apartment-1.dwg` returns **non-2xx** (it returns 200 today), and that
all 21 currently-converting files still return 200 with a DXF that parses. Byte-compare one known
-good conversion before and after to prove the check is inert on the happy path.

---

# S6 — Report converter crashes honestly

**Fixes [F6](findings/F6-converter-crash-ux.md). Medium. Trivial.**

`proc.on('close', (code) => …)` ignores the signal argument, so a SIGSEGV becomes the string
`"dwg2dxf exited null"`. Accept `(code, signal)` and report the crash as a crash.

Cap the forwarded `stderr` — 3 KB of LibreDWG internals crossed the wire per failure, and the DOM
held 98 410 characters of it. Log it server-side in full; send the user a bounded, plain message.

### Gate

Assert the `/api/dwg` error body for `BUSNSS-Offcs-Trdtnl_AC.dwg` is under a fixed size and contains
no `dwg2dxf exited null`. Keep the current behaviour of **discarding** the partial DXF — S5's check
must reject these too, not salvage them.

---

# S7 — Make the cluster filter accountable

**Fixes [F7](findings/F7-cluster-filter-overreach.md). High. Re-measure after S1.**

Removing 1 entity from `CwSp_AA` collapses the drawing's extent 274×. Removing 102 of 13 348 from
`AG` collapses it 108×. The filter is doing what it was written to do, but nothing bounds how much
of the drawing it may discard, and its `Math.max(60, …)` floor is an **absolute metre value applied
to a drawing whose scale may be wrong** — so S1 changes its behaviour and this must be re-measured
before any change is designed.

Then: bound the extent it is permitted to discard, or make the threshold fully relative; and record
what it dropped on the `Drawing` so the decision is inspectable rather than invisible.

### Gate

Assert that on the corpus no file loses > N % of its extent to the filter without that being
recorded — and that `cad33.dwg`, where the filter is **correct** (10 entities 300 km away), still
has them removed. A gate that only checks "nothing was dropped" would break the one case that works.

---

# S8 — Never present a metric computed over an empty population

**Fixes [F8](findings/F8-vacuous-coverage-claim.md). Medium. Same family as S4b.**

"Counts are exact … (traced by hull, **100 % furniture coverage**)" printed directly beneath
"**COMPONENTS 0**". The `coverage = 1` default is correct *internally* — the plate ladder needs a
sortable number — but must not surface as a quality claim.

Where furniture is absent, say the useful thing instead: *"no furniture in this drawing to check the
boundary against"*. That is both honest and more actionable — it tells the user the boundary is
unverified, and why.

Most of the 8 affected files have zero furniture only because of F2, so **re-measure after S2**.

---

# S9 — Gate the wizard on import quality

**Fixes [F9](findings/F9-wizard-gating.md). High. Build this early — it bounds the blast radius.**

Today the wizard advances on *"a file was uploaded"*. It walked from **no plate at all** to
"Pick a test-fit · 3 alternatives · best 41/100" with three blank thumbnails, then on toward the
priced report and takeoff (`findings/screens/callcenter-generate-step.png`).

Every input the gate needs already exists and is already correct — `derivePlate` returned `null`,
`plate.provenance.confidence` is `'low'`, `placed_desks` is `0`. Nothing consumes them as a
precondition. Three states, three behaviours:

| State | Behaviour |
|---|---|
| no plate | **block** `Next`, explain which stage failed and why (needs S3's reason) |
| plate present, `confidence: 'low'` | proceed **after** the existing "Confirm boundary" step — already built and working; route through it, do not add a parallel mechanism |
| plate present, generation placed 0 components | **block** the candidate gallery; show the failure, not three scored blanks |

Also fix, from the same session: the uploaded drawing is **lost when navigating back to Space**
while `Next` stays enabled, so the user can advance from a Space step with no file at all; and
`GET /api/dwg` returns 405 into the console on every page load, which will mask real errors.

### Gate — end-to-end, through the real path

Per the project's testing discipline, drive the **actual wizard** — project → Space → upload →
Next → Next — not a shortcut. Assert that `call-center-offices.dwg` cannot reach `#/…/generate`,
and that `fast-food-Restaurant.dwg` and the control still reach it and produce non-blank candidates.

---

# S10 — Accept `.zip`, and say something useful about non-CAD content

**Fixes [F10](findings/F10-zip-and-non-cad-input.md). Low. Do last.**

Three of four supplied archives wrap exactly one `.dwg` — unwrapping a single-entry archive is
unambiguous and needs no user choice. Multi-entry archives should offer a pick-list.

`Library-of-furniture.zip` contains only JPEG catalogue scans. The raster path exists
(`rasterImport.ts`) but these are furniture catalogue pages, not a floor plan, so scale-and-trace has
nothing to trace. The right behaviour is to **say so plainly** rather than route them into a flow
that cannot work.

---

## What the fixes must not break

The corpus contains three things that **work correctly today** and are the regression baseline:

1. **`samples/furniture-plan.dwg`** — 930.1 m² plate, 3 keep-outs, 104 desks, score 88.8.
2. **`fast-food-Restaurant.dwg`** — 342.9 m², 19 desks. Its `$INSUNITS` is honest; S1 must leave it
   untouched.
3. **The low-confidence plate mechanism** in `plateQuality.ts` — it correctly flagged the worst file
   in the corpus, refused to print a hard area for it, and offered "Confirm boundary". It is the
   right precedent for how every fix above should communicate uncertainty. Extend it; do not
   duplicate it.

## One reporting note

Per `.claude/rules/gate-independence.md`'s reporting convention: every claim in this document and in
`findings/` is scoped to **this corpus of 24 files plus the control fixture, on branch
`testing-edge-variations`, measured 2026-08-05**. "Works", "unchanged" and "not affected" all mean
*with respect to that population* — not in general.
