# Workstream W3 — D-Q pre-registration (committed BEFORE any fix code runs)

Branch `fix/dq-strings`, base `d868ec3` (= main at loop start). Scope per
`reports/editor-completion/phase0-leftovers.md`: close D-Q (strings printing
outside the building footprint), give room dims the displacement rung labels
got, and evaluate the wide-displacement rung for the three dwg services labels
at the fit ladder's floor. Files: `web/src/export/sheetSet.ts`,
`servicesSheets.ts`; gate: `scripts/gates/sheets/sg8-string-ink-crossing.mjs`
(the D-Q measurement already lives there as a note; this workstream promotes it
to an assertion).

## 1. The instrument, and the 26 → 24 reconciliation (a finding, not a baseline)

The frozen D-Q instrument is `outsideFootprintCount` in SG8 (the committed
reconstruction of `j2-outside.mjs`): footprint = the CORE-STATE wall bbox
projected with SG2/SG8's own `planProjection`; a room-name or area string
(never a dimension) whose poppler-measured centre falls outside it is out of
the building. Nothing is read from the producer.

Phase 0 pinned **26**. On this tree (d868ec3, own render, fresh wasm) the same
instrument reads **24**: seeded/A02 4 · testfit/A02 12 · dwg/A01 2 · dwg/A02 6.
Reconciled before any fix, per the phase-0 rule:

* **26 reproduces EXACTLY at the tree it was measured on.** Scratch worktree at
  `547d4a0` (B's landing commit, where "D-Q 37→26" was recorded), its own Rust
  built to wasm, its own render: 4 / 12 / **3** / **7** (seeded/A02,
  testfit/A02, dwg/A01, dwg/A02) = 26, digit for digit.
* **The instrument is byte-identical across the window** (`git diff 547d4a0
  d868ec3` over sg8, sheetlib, render-sheets, demo-doc: empty), and so are
  `sheetSet.ts` / `servicesSheets.ts` / `roomNaming.ts`.
* **The delta is confined to the dwg pack** (dwg/A01 3→2, dwg/A02 7→6) and is
  the artifact moving under merged core work in `547d4a0..d868ec3`
  (`fix/placement-inset`, packing straddle rule, corridor-classifier conjunct,
  pax series; goldens re-captured once at `b792327` citing both mechanisms) —
  the same attribution shape B pre-registered for 107 vs 87.

**24 is therefore the operative RED baseline for this workstream**; 26 remains
the loop-start figure at its own tree.

## 2. Diagnosis: which rung is missing (measured, not assumed)

Instrumented render (temporary `console.warn` in `roomLabels`, reverted,
never committed): **all 12 outside blocks — the 24 strings are 12 name+area
label blocks — were placed by the ladder's `place(forms[0], true)` rung**
(`allowSoft` over the NEAR/extended candidate tiers). `seedOutsideMargin`
prices the margin like furniture (soft), so the soft rung "sees clear" margin
candidates near shell-adjacent rooms and takes them BEFORE the strict-wide /
soft-wide in-building rungs ever run. No block reached `settleLabel`. Blocks
and rungs, this tree:

* seeded/A02: CABIN 1 (soft), FOCUS ROOM 1 (soft) — top margin
* testfit/A02: MEETING ROOM 2/3/4/5/8, PHONE BOOTH 1 (all soft) — bottom margin
* dwg/A01: OPEN WORKSPACE (4) (soft) — left margin, WITH leader (B's named rise)
* dwg/A02: OPEN WORKSPACE (4), MEETING ROOM 2, PHONE BOOTH 1 (all soft)

The missing rung is exactly phase 0's expectation: **displacement inward from
the footprint edge** — the in-building wide tiers exist but are ordered after
the margin-buying soft rung, and no rung distinguishes "soft = furniture,
inside" from "soft = margin, outside the building".

## 3. Ruling on the margin-with-leader pattern (stated, not silent)

**NOT retained as legal steady state.** A room label's rungs (strict, soft,
strict-wide, soft-wide, smaller forms) are confined to the footprint bbox ∩
plate; the margin stays reachable ONLY by the terminal `settleLabel` rung
(plate bounds, soft priced below label- and ink-overlap, always leader-backed)
— the escape for a label with NO in-building spot at any form. The D-Q gate
asserts **zero** outside strings: if the terminal escape ever fires outward on
a future document, the gate goes RED and that instance is adjudicated by name.
There is no exclusion rule; dwg/A01's `OPEN WORKSPACE (4)` margin-with-leader
placement is expected to move INSIDE (over the soft demolition hatch, with its
leader), not to be grandfathered.

## 4. Pre-registered post-fix expectations

1. **D-Q = 0 on all 12 plan sheets, all three packs** (gate: SG8 new per-sheet
   assertion, red at 24 on pre-fix artifacts first). Any survivor is named
   individually with its blocking geometry or the terminal state is
   RED-WITH-ROOT-CAUSE — never green-with-asterisk.
2. **Mechanism falsifier:** if confining the label rungs to the footprint
   closes fewer than half the 24 (>12 remain), the soft-rung-margin diagnosis
   was wrong — stop and re-register before proceeding.
3. **Dims.** The declutter guard's binary skip becomes a displacement ladder:
   the label may slide along its own dim line (and take the line's other side
   for width runs), deterministic candidate order, FIRST candidate = today's
   exact box (so currently-printing dims do not move); a candidate is accepted
   only when clear of EVERYTHING (hard ink and soft furniture alike);
   suppression only when no candidate is clear — the last rung.
   The hard-only-blocked population at this tree (measured; identical at B's
   tree, so phase 0's "five" was an under-enumeration of this same family, the
   E7-count precedent): 13 dim strings across 7 zones — seeded IT/Server
   3.00W+2.40H, Storage 3.00W+2.00H, Wellness 3.00W+2.40H; testfit IT/Server
   3.00W+2.40H, Storage 2.00W+3.00H; dwg Storage 3.00W, IT/Server 3.00W+2.40H
   — 7 of them reading `3.00 m`. **Registered: each of the 13 either returns
   (printed at 7.5 pt, inside the footprint, crossing no ink — SG8 stays 0) or
   is individually named with the geometry that still blocks every candidate.**
   Soft-blocked dims may also legitimately return where a clear slide exists;
   every returned dim is held to the same three properties. Declutter is NOT
   relaxed: nothing may print on an occupied spot.
4. **Services labels (A.03/A.04).** `roomLabelBoxes` gains the wide-displacement
   rung at the FULL-SIZE form before any shrink rung (D3 damage ordering:
   displacement before shrink before abbreviate; wrapping introduced nowhere).
   The three dwg labels at the floor — MEETING ROOM 2 (6.375 pt), PRINT POINT 1
   (5.25 pt), PRINT POINT 2 (6.375 pt), each on both A.03 and A.04 — are
   expected to return to **7.5 pt full name with a leader**; final sizes will
   be quoted. Labels that place at forms[0] today are untouched (the wide rung
   runs only after the near tiers fail). Margin remains unreachable on these
   sheets (strict-only rungs; the soft strips block them).
5. **Fences, all quoted post-fix:** SG8 crossing stays 0 on all 12 plan sheets
   (displaced strings must not land on wall/swing ink — D-P stays closed);
   SG1/SG2/SG3/SG4/SG7 green; full sheet board `run-all.mjs` green; every
   changed drawing-set digest individually justified and every check-manifest
   delta attributed (the S5 standard); scratch-worktree sabotage rounds for the
   new assertion and each enabling transform, nulls reported.
