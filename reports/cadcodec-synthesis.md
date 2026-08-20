# cadcodec — synthesis of the verification workstream

**Analysis only.** Produced under the 2026-08-20 ruling — *"cadcodec agent — woken for synthesis
only"* (`reports/editor-completion/phase0-leftovers.md @ d868ec3`, ruling 4): no cadcodec code was
built, no corpus was contacted, nothing was added to the proposal branch. **No adoption, fork/L2,
threshold, or waiver decision is made or implied here; all remain Udaya's and remain unmade.**

Citation convention: the evaluation documents live on branch
`proposal-to-adopt-opencadstudio-for-our-editor-int`, not on `main`, so every citation is
commit-qualified:

- **EV§n** — `reports/opencadstudio-evaluation.md @ 3f8a342`
- **SA§n** — `reports/stage0-phase0-audit.md @ 3f8a342`
- **FV§n** — `reports/fork-vs-l2-verdict.md @ 8a4e881` (amended `12d302c`)
- **MCP** — `reports/mcp-server-spec.md @ 7c87104`

---

## 1. Provenance incident — the follow-up verification pass was lost, in full

This synthesis was to close a follow-up source-verification pass over the four upstream repos
(OpenCADStudio, `cadcodec`, `cadkernel`, `acadifc`), cloned into a shared scratchpad. The pass was
structured as: the plugin/IPC seam read directly by the coordinating agent, plus three deep-dive
sub-agents (`cadkernel`, `acadifc`, `cadcodec`).

**What happened.** Mid-run, the source checkouts were deleted out from under the pass by something
external to it — first `acadifc` and the `ocs` crate tree, then everything; a later sweep found every
checkout directory present but **0 bytes** (only empty `target/` build skeletons remained). The
`cadkernel` and `acadifc` sub-agents had completed and reported before the wipe; the `cadcodec`
sub-agent died without reporting. The elapsed sessions also crossed a context boundary, so the two
completed sub-agent reports — which existed only in conversation context — did not survive to
synthesis time. The likely cause of the file deletion is tmp-directory cleanup across the multi-day
gap; this is a guess and is labelled as one.

**What survives of the pass: nothing.** Verified today, from the repo and filesystem, not from
memory:

- No branch or commit from the dead `cadcodec` sub-agent exists anywhere
  (`git log --all` mentions cadcodec only at `3f8a342`, which predates the pass; no cadcodec-named
  branch; `git worktree list` clean).
- No file survives in the shared scratchpad outside empty build directories (`find` returns zero
  files; every directory `du` = 0 B).
- The two completed sub-agent reports are unrecoverable.

**Consequence, stated per the rule that unverified claims are flagged, never silently included:**

> **Nothing from the follow-up pass is citable, and none of it is cited below.** Every claim in this
> document is either (a) re-derived today from committed repo bytes, or (b) quoted from the committed
> evaluation record with that record's own verification tier attached. Nothing is reconstructed from
> memory of the lost reports.

One in-flight claim is explicitly killed rather than left ambient: the pass was probing
`ocs_plugin_api`'s IPC transport for a frame-size limit and a 64 MiB figure was hypothesized. **It
was never confirmed. No such number may be quoted.**

Two silver linings, both real:

1. **The loss changes no verdict**, because no standing verdict rested on the lost material. The
   committed record (EV/SA/FV) was complete and self-supporting before the pass began; the pass was
   additional depth, not foundation. Its only cost is that the depth must be re-done if wanted.
2. **No contaminated number entered the record.** The scratchpad's `wasmtarget`/`wasmtarget2` build
   directories show the sub-agents ran compiles; if any bundle-size number was produced, it died
   unrecorded. Under SA§0's stop line — a number seen before its threshold is ruled cannot be
   un-seen — an unrecorded number is the clean outcome, not a loss.

---

## 2. Evidence ledger

Three tiers. Tier is stated inline throughout §3.

- **[A] Verified now** — re-derived today from bytes in this repo (committed reports, commits,
  gate scripts on the named branches).
- **[B] On record, agent authority** — stated in the committed evaluation but flagged by its own
  verification log (EV§12) as *not hand-checked*: the 31.5 MB raw / 10.4 MiB gzip OCS wasm figures,
  the OCS web-build silent-data-loss list, the `cadcodec` test tally (1,267 pass / 1 fail), the
  wasm32 compile result across three feature configs, and the `cadkernel` capability inventory.
  EV§12's own instruction stands: any of these becoming load-bearing gets re-checked first.
- **[C] Lost, unverifiable** — everything the follow-up pass read or produced: the plugin-seam
  re-read, both completed deep-dive reports, and whatever the dead `cadcodec` sub-agent found.
  Nothing in this tier appears in §3.

---

## 3. The cadcodec picture, from the committed record only

### 3.1 Standing verdict — unchanged by this synthesis

**CANDIDATE, conditional on Stage 0. Not adopted.** (EV§2, L1 row — deliberately not "Adopt";
EV header: *no external system has yet successfully opened a `cadcodec`-written file*.) The whole
workstream's status line is SA§1's: **well-audited reading.** The first fact about the outside world
arrives when LibreDWG and `cadcodec` disagree about a real file; the second when AutoCAD opens
something `cadcodec` wrote. Neither has happened.

### 3.2 What the reading established for it

- Real DWG **write**, not a stub: 19,151-LOC writer against an 18,134-LOC reader, all 48
  `EntityType` variants dispatched with no `_ => skip`, R13→R2018, hand-rolled LZ77 (AC18 + AC21),
  CRC, Reed–Solomon for R2007. Zero `todo!` / `unimplemented!` in 168,100 LOC. [A: EV§6/L1,
  confirmed by hand in EV§12]
- Compiles for `wasm32-unknown-unknown` in three feature configs after a two-line consumer-side
  `getrandom` fix; no C, no `build.rs`, pure-Rust `miniz_oxide`. [B — and EV§10 reopens the thread:
  it was not established that any tested config is the config we would ship, nor that ACIS was
  enabled in them]
- XDATA (`EntityCommon.extended_data`, typed `XDataValue` union) round-trips through both DXF and
  DWG for every entity type — the carrier that would let product-binding and decision-state facets
  survive an AutoCAD round trip. [A: EV§6/L1]
- The concrete prize, resized honestly: **not** "DWG export we lack" (DWG write appears nowhere in
  the qbiq parity set) but **removal of a standing production defect in DWG import** — Vercel
  `/api/dwg` 503, the server round-trip, and LibreDWG's recorded segfaults/truncation
  (`web/src/import/dwgConvert.ts:58`). [A: EV§10]

### 3.3 What is established against it, and never established at all

- **The evidence base under it is hollow in exactly the way this repo has a rule about**: no real
  DWG/DXF fixtures in its tree; the nine `real_dwg_*` interop tests early-return when the file is
  missing — a skip reported as `ok`; every green test is the codec reading back its own bytes.
  Suite not green at HEAD: 1 write-side failure (`dwg_roundtrip_annotative_styles`). [A: EV§7;
  tally itself B]
- **Bus factor 1** — 1,904 of 2,008 OCS-org commits by one author; mitigation on record is vendor
  and pin, never track HEAD. Adopting relocates 168k LOC of that liability into our tree — recorded
  as a relocation of liability, not a cleanup. [A: EV§7, EV§10]
- **Sharp edges to design around** (all cheap if known in advance): no XDATA schema or index;
  32,767-byte silent EED truncation; unregistered APPID = silent DWG data loss; XRecord edits bypass
  copy-on-write undo; name-string block/layer references; deliberate stale handles in
  `remove_entity_arc`. [A: EV§7]
- **Unmeasured and blocking any size claim**: the wasm bundle delta of the read path. The threshold
  must be ruled before the number is seen (SA§0, SA§5b). [A]
- **Licensing is not clean-closed**: MPL-2.0 at repo level but 0 of 201 source files carry the
  Exhibit A notice; ACadSharp derivation claims in-source ("Based on", "mirrors", "matches") with no
  MIT copyright notice anywhere in the tree. The waiver under which the evaluation was written is
  still in force. [A: EV§11, SA§5c]

### 3.4 Stage 0 — prepared and stopped; the stop line is binding

SA§0–§4, all [A], re-verified today as committed and wired:

- The interop gate is redesigned around two independent anchors: LibreDWG as second reader on the
  read side; a **named trusted-human step** (AutoCAD / ODA File Converter) on the write side, which
  no agent may perform, drive, or proxy. The three LibreDWG-hostile corpus files route directly to
  the human step.
- Predictions P1–P5 are pre-registered; the triage rule (disagreement = flag, never verdict) is
  binding; deep-diff semantics are pinned.
- The inventory differ exists (`scripts/gates/stage0/inventory-differ.mjs` + test), was watched to
  fail on constructed inputs, survived a six-way sabotage round whose one null result (the
  absent-vs-zero rule, shipped unguarded) was found and fixed, and is wired into `verify-all.sh` —
  after `reconcile.mjs` refused the commit that left it orphaned.
- **Zero corpus contact has occurred**, including by the lost pass so far as any recoverable
  evidence shows — and any result produced before the §5 rulings are ratified is contaminated and
  discarded by pre-registration.

### 3.5 Context: the fork question is settled on architecture, not price

For completeness of the cadcodec picture only (no re-ruling here): FV§3 records the fork-vs-L2
verdict as **L2, decided by C2 (reach) and C4 (integrity), not by a cost ratio** — `CadDocument` has
no zone, program role, or circulation, so a forked OCS would not replace the domain layer; and three
fork lines are *unknown, would require spike*, which under the pre-registered rule bars declaring
either column cheaper. The L2 surface is drafted as an MCP server over the 34-mutator / 60-export
vocabulary (MCP). [A]

---

## 4. Decisions that remain open — none made here

All Udaya's, all unmade as of `d868ec3`:

| Item | What it decides | Where the branches are written |
|---|---|---|
| SA§5a / EV item (g) | Do drafting edits enter the AI's command vocabulary, or stay ruled out? | SA§5a (recommendation: out, **by ruling** not accident) |
| SA§5b / EV item (h) | The wasm bundle-delta accept / hard-reject lines — drawn before measuring | SA§5b (proposal: +2.5 / +4 MiB gzip) |
| SA§5c / EV item (d) | Lifting the licensing waiver, with Exhibit A + ACadSharp facts in view | SA§5c, EV§11 |
| EV item (f) | Sequencing against open production blockers | EV§10 |
| Stage 0 human step | AutoCAD/ODA verification of cadcodec-written files | SA§1, EV§8 |

Until the §5 rulings are ratified, the stop line holds: no corpus contact, no
cadcodec-vs-LibreDWG comparison on real files, no bundle measurement.

## 5. Cost of the incident

Re-doing the lost depth pass, if wanted: re-clone the four repos, re-run the plugin-seam read and
the three deep dives, and land their findings **in committed files, not in conversation context** —
that last clause being the lesson. The committed record's verdicts required none of it; Stage 0
required none of it; nothing blocks on it.
