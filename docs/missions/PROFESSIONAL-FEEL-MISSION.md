# MISSION: Professional Feel — DSource vs Laiout / qbiq / Rayon

**You are Claude Code.** This is a run-to-completion product mission. Spin up as many
subagents / worktrees as the work requires. The human is done waiting for “almost” —
the editor must **look, pack, and feel** like a professional test-fit product, not a
colored packing demo with good unit tests.

This mission is **orthogonal** to the `integration` / qbiq-parity-endgame merge branch.
Do **not** work on `integration`. Do **not** mix cloud/tenancy/API-auth work into this
branch. Do **not** re-litigate area-census gates unless a change you make breaks them.

---

## 0. FIRST ACTIONS (before any product code)

### 0.1 Branch and isolation

```bash
# From a CLEAN mainline base — prefer main if green; if main is messy, prefer the
# last known product-stable tip that is NOT the integration merge WIP.
git fetch origin 2>/dev/null || true
git status -sb   # if dirty with integration/cloud WIP: STOP, stash or leave that tree alone

# Work on a NEW branch off main (or the stable tip):
git checkout main
git pull --ff-only 2>/dev/null || true
git checkout -b professional-feel/$(date +%Y%m%d)

# Declare ownership (project convention R24 — one writer per branch):
# Append a declaration to docs/audits/SESSION-REGISTRY.md for this branch, then commit it
# BEFORE other work if that file exists and the protocol is still in force.
```

**Branch name:** `professional-feel/<date>` or `professional-feel/v1`  
**Worktree root:** the shared checkout OR `bash scripts/worktree.sh new pro-feel` if available.  
**Mission id:** `professional-feel`  
**Session id:** invent one short id and use it in every ledger entry and worktree tag.

If `scripts/worktree.sh` exists, use it for **every** disposable/falsification tree:

```bash
export DS_MISSION=professional-feel
export DS_SESSION=<your-session-id>
bash scripts/worktree.sh new <name>   # never rm -rf trees by hand
bash scripts/worktree.sh done <name>  # when finished
```

Disk: check free space (`df -h .`). This repo has hit ENOSPC mid-write. If free < 15 GiB,
sweep only attributed-and-closed trees first; never delete unattributed trees.

### 0.2 Read order (mandatory — do not skim)

Read these **in full** before planning, and keep them open as the law of the mission:

| # | Doc | Why |
|---|-----|-----|
| 1 | `Claude.md` / `CLAUDE.md` | Architecture, commands, typography, amber rulings, verify discipline |
| 2 | `.claude/rules/no-bloat.md` | Search before write; delete superseded code in the same change |
| 3 | `.claude/rules/gate-independence.md` | Gates re-derive truth; no producer-metadata trust; sabotage protocol |
| 4 | `docs/design/testfit-pro-quality.md` | **Primary product spec** for generator quality (architecture emission, spine, program mix, alignment) |
| 5 | `docs/design/laiout-parity-critique.md` | Scorecard + free vs seats-costing levers + seats-first history |
| 6 | `docs/design/laiout-deep-research.md` | Why Laiout reads clean (one model, shell-first, projections) |
| 7 | `docs/design/laiout-visual-system.md` | Palette, line weights, zone hierarchy, symbols |
| 8 | `docs/design/editor-ux-rayon-parity.md` | Cursor-first dynamic input, command access, inspector gaps |
| 9 | `docs/design/autonomous-testfit-loop.md` if present | Generate → evaluate → optimize loop |
| 10 | `research/03-laiout.md`, `research/01-rayon.md` | Competitive baselines |
| 11 | `docs/ROADMAP.md` § Immediate next + Tracks A/D/G/H | What’s already shipped vs claimed |

Also scan current code ownership before inventing anything:

```
crates/ds-core/src/layout.rs          # orchestrator only — submodules under layout/
crates/ds-core/src/layout/{program,seed,grid,regions,jobs,place,emit,packing,conform,score,tests}.rs
crates/ds-core/src/circulation.rs
crates/ds-core/src/zone.rs
crates/ds-core/src/cost.rs
crates/ds-core/src/lib.rs
web/src/editor/{EditorCanvas,paint,planStyle,symbols,stats}.ts
web/src/ai/{designer,engine,evaluator,refine}.ts
web/src/shell/steps/GenerateStep.tsx
web/src/three/{Viewer3D,theme}.ts
```

**Pre-edit rule:** before introducing ANY new symbol, run the project’s `pre-edit-scan`
skill / equivalent search. Prefer extend-over-create. Delete dead code in the same commit.

### 0.3 Baseline measurement (Step 0 — write numbers, not vibes)

Before changing generator or renderer, capture a **reproducible baseline** on the real plate
(sample DWG used in CLAUDE.md / wizard E2E — find path via `rg sample.*\.dwg` / fixtures).

Record into `docs/audits/PROFESSIONAL-FEEL-LEDGER.md` (create it; append-only):

| Metric | How to measure | Baseline value |
|---|---|---|
| Workstations (generated, non-reference) | core `workstation_count` / Stats panel | |
| Efficiency % | Stats / `efficiency_pct` | |
| Usable / Circulation / Core m² split | Stats rollup | |
| Enclosed room count + how many are Poly vs Rect | zone census | |
| Circulation zone count (fragments) | zone census type==Circulation | |
| Conformed rooms (abutting angled wall) | count | |
| Door count on generated plan | components category Door | |
| Glazed wall count | walls with glazing if field exists; else 0 | |
| Density m²/person | | |
| Visual: screenshot framed plan at paper + editor profile | save under `docs/evidence/pro-feel/baseline/` | |
| Battery | `bash scripts/verify-all.sh --full` | N/N |
| Rust tests | `cargo test -p ds-core` count by name | |
| Typecheck | `cd web && pnpm typecheck` | |

**Golden generate:** if `golden_generate_output_is_frozen` exists, note it will break when
the generator deliberately changes — re-capture expectations only after intentional change,
never relax silently.

Also run: `make wasm` after any Rust change; never judge the UI against stale wasm.

### 0.4 Dual density policy (resolve seats-first vs Laiout-look)

Historically the project **parked** neighbourhoods + perimeter rooms because they cost seats
(GCC seats-first). That parking is **why** the product still doesn’t feel like Laiout.

This mission **explicitly lifts the parking** under a controlled dual-mode policy:

1. **`density: "dense"` (default, GCC)** — protect seats. Guardrail: on the real ~880–930 m²
   plate under STANDARD program, generated workstations **≥ 80** on every A/B/C candidate
   (or whatever the current measured baseline is — **ratchet: never more than 5% below
   baseline**, and never invent a lower floor). NIA ≤ GEA always.
2. **`density: "showcase"` (Laiout-feel mode)** — may spend up to **15% seats** vs dense on
   the same plate/program to buy neighbourhoods, perimeter rooms, wider spines, amenity.
   Must still produce a complete program (reception, meetings, pantry, booths). Efficiency
   target for showcase: **≥ 70%** usable on the real plate (Laiout reference ~78%).

Wire `density` (or reuse existing strategy/emphasis fields if they already express this —
**search first**) through:

- `Program` / generate API (Rust + TS types)
- Generate step UI: toggle or strategy card “Professional / Dense”
- Agentic designer defaults: showcase for marketing-style options, dense for capacity options

**Never silently lower dense-mode seats.** Every generator PR states dense-mode seat delta.

---

## 1. NORTH STAR — what “done” means

A professional architect or workplace consultant, after 60 seconds in the product, should
think: “this is a real test-fit tool,” not “this is a clever packing demo.”

### 1.1 Visual acceptance (must pass all)

On the **real sample plate**, showcase mode, framed editor view + paper mode:

1. **Rooms read as architecture** — partitions with thickness, glass corridor fronts on
   meeting/cabin/focus, one door per enclosed room with swing into room, zone tint behind.
2. **Desks read as neighbourhoods** — clusters of ~6–12 (not one monolithic field), with
   secondary aisles joining a primary spine.
3. **Circulation reads as one network** — primary spine 1.5–1.8 m along room band face
   (inboard, not facade-wasting), secondaries 1.1–1.2 m, entry → reception narrative.
4. **Alignment** — coordinates on 0.05 m module; no continuous jitter; one desk orientation
   per wing; common room depths in a band; dimensions look round.
5. **Line hierarchy** — shell heavy, partitions medium, furniture hairline; furniture symbols
   remain legible at plan-framing zoom (not collapsed chips).
6. **2D / 3D / Stats / exports** all describe the **same** Document (one model).
7. **A/B/C options look spatially different**, not just different room counts.

### 1.2 Interaction acceptance (Rayon bar — partial but real)

1. While drawing a wall/line, user can **type length** (and optionally angle) and Enter to
   commit — cursor-anchored or dynamic input chip, not status-bar-only.
2. **Ortho / polar** constraint (Shift or typed angle) while drawing.
3. Tool letter shortcuts that the rail advertises actually work (or remove the fake badges).
4. Selecting a wall/room shows **editable numeric properties** (length / W×H) somewhere
   non-janky — prefer extending existing inspector, not a new panel framework.

### 1.3 Metrics acceptance

1. Workstations = non-reference Desks seated in Workspace (existing rule) — never imported junk.
2. Efficiency formula correct; usable / circ / core rollup honest.
3. Dense mode holds seat guardrail; showcase mode documents seat trade.
4. Cost panel and headline cost must not disagree by a GEA−NIA × rate (if you touch cost surfaces,
   add an independent cross-surface gate **before** or **with** the fix — see gate-independence).
5. Battery `--full` green; `cargo test -p ds-core` green; typecheck green.

### 1.4 Explicit non-goals (do not boil the ocean)

- Multiplayer, cloud tenancy UI, Vercel/VPS deploy, PDF import, photoreal AI renders as a
  required deliverable (nice if cheap; not blocking).
- Full AutoCAD command set; full Rayon pages/sheets publish flow.
- Replacing the Rust core with a new engine.
- Touching `integration` merge debt / LOOP-LEDGER belief rounds.

---

## 2. WORKSTREAM MAP — parallel where legal, serial where not

`layout.rs` is the orchestrator; **generator geometry is SERIAL** (one agent at a time on
`crates/ds-core/src/layout/**`). Renderer, AI wiring, Rayon UX, metrics, and tests may run
**in parallel** in separate worktrees, merging into the mission branch via small PRs/commits.

```
                    ┌─────────────────────────────────────┐
                    │  ORCHESTRATOR (you)                 │
                    │  branch: professional-feel/*        │
                    │  ledger + guardrails + merges       │
                    └──────────────┬──────────────────────┘
           ┌───────────┬───────────┼───────────┬───────────┬───────────┐
           ▼           ▼           ▼           ▼           ▼           ▼
        WS-G0       WS-G1       WS-G2       WS-V        WS-AI       WS-R
      free wins   architecture spine+     visual      AI path     Rayon
      accounting   emission    neighb.    hierarchy   un-neuter   UX
      (serial G)  (serial G)  (serial G)  (// ok)     (// ok)     (// ok)
           │           │           │
           └──── layout/** only one writer at a time ────┘
```

**Spawn pattern for each workstream agent:**

```
You are a focused builder agent for workstream <ID>.
Mission: professional-feel. Branch: <branch>. Session: <id>.
Read: CLAUDE.md, no-bloat, gate-independence, testfit-pro-quality.md §relevant,
      PROFESSIONAL-FEEL-MISSION.md §this workstream.
Scope files: <list>. Do NOT edit files outside scope without orchestrator approval.
Guardrails: dense seats; NIA≤GEA; determinism; make wasm after Rust; no --no-verify.
Deliver: commits with message prefix "pro-feel(<id>): ...", ledger entry, measured before/after,
         tests that fail when the feature is sabotaged.
```

Use **reviewer agents** after each serial generator landing:

```
You are an ADVERSARY / reviewer. You did NOT write the change.
Sabotage: disable the enabling transform; inject wrong geometry; drop doors passable.
Expect RED. Independent measurement. Return BELIEVED / NOT BELIEVED with coverage list.
```

---

## 3. WORKSTREAM SPECS (implement in this order unless free-tier parallel)

### WS-G0 — Free generator / accounting wins (SERIAL, first)

**Owner files:** `layout/**`, `lib.rs` efficiency/usable, `stats.ts` only if numbers surface.

From `laiout-parity-critique.md` free tier:

1. **Facade ribbon** — `FACADE_GAP` must not be taxed as Circulation when it’s desk-clearance
   behind window-line desks. Prefer growing Workspace to the straight wall (seat-neutral).
2. **Axis vs oriented leftover** — axis path must absorb honest open-floor leftover as usable
   the same way oriented path does (no 15-pt efficiency lie on the real plate branch).
3. **Circulation fragment melt** — continue unify contiguous walking area; label + re-merge all
   circulation families; target: few Circulation zones, ideally one network poly per plate
   component (spine+secondaries may still be multiple Rects that *read* as one system).

**Acceptance:** efficiency up **without** seat loss on dense mode; document numbers in ledger.
Rust tests for each accounting rule with sabotage.

---

### WS-G1 — Architecture emission: rooms are buildings (SERIAL, highest leverage)

**Primary law:** `docs/design/testfit-pro-quality.md` §2.

Implement (search existing first — `generated` walls, glazing, emit helpers may partially exist):

1. **`Wall.generated: bool`** (serde default false). `generate()` clears generated walls.
   Plate tracing / `wall_bbox` / shell ownership **filter `!generated`**.
2. **`Wall.glazing: bool`** (or equivalent already present). Corridor-facing walls of
   Meeting / ClosedOffice / Focus / Cabins glazed; booths/IT/storage solid.
3. **`emit_room` (or extend existing emit path)** per enclosed room:
   - partition segments 0.1 m thick, shared walls once, no double plate boundary
   - door gap 0.9 m (1.0 m where NBC exit), Door component, swing into room, hinge near corner
   - zone typed correctly (use full `ZoneType` vocabulary — not only Workspace/Meeting/Core)
   - furniture sized to capacity (table+chairs), not half-scale glyphs
4. **Circulation:** Door components **passable** in `circulation.rs` occupancy grid or every
   room seals and connectivity dies. Test: rooms connected to spine through doors.
5. **Renderer:** wall poche / true thickness; glazed triple-line; door swing already exists —
   ensure generated walls use the architectural path, not hairline centerlines only.
6. **3D:** glazed walls transparent; partitions solid; doors as openings.

**Guardrails:** dense seats; regenerate clears old generated walls; golden tests updated
deliberately with new frozen outputs **after** visual sign-off on real plate.

**Falsification:** sabotage passable-doors → connectivity red; leave `generated` walls in plate
trace → plate area drifts → red; double-emit shared wall → wall count / cost spike → red.

---

### WS-G2 — Spine circulation + entry narrative (SERIAL, after G1 or tightly coupled)

**Law:** `testfit-pro-quality.md` §3.

1. Primary spine 1.5–1.8 m along **meeting-band face** (inboard), not facade ring.
2. Secondary aisles 1.1–1.2 m between desk neighbourhoods, join spine at right angles.
3. Bench access 0.9 m remains implicit gap.
4. **Entry anchor:** `Document.entries` or existing equivalent — import heuristic + UI “place
   entry” if cheap; deterministic fallback.
5. Emission as explicit Circulation geometry (Rect list or merged poly); retire
   leftover-only-as-circulation as the primary story.
6. Reception placed at entry; boardroom/visitor meetings adjacent; pantry social at far end.

**Acceptance:** on real plate, path entry→reception→spine→desk aisle exists in both geometry
and circulation evaluator connectivity; screenshot shows narrative.

---

### WS-G3 — Neighbourhood desk packing + perimeter rooms (SERIAL, after G0+G1+G2)

**Law:** critique § Workstation arrangement + Rooms vs angled walls; `testfit-pro-quality` §4.

1. **Cluster pack** of 6–12 desks with aisle between clusters (not one field).
   Density-aware: dense mode uses larger clusters / fewer aisles; showcase uses clearer
   neighbourhoods and may spend seats.
2. **Remove continuous jitter** as seed variety. Variety = discrete structural choices
   (band side, spine offset, room order, wing pantry). Snap all coords to **0.05 m**.
3. **One orientation per wing**; portrait wings get ±π/2 desk rotation with footprint swap.
4. **Common room depths** in a band; variable widths.
5. **Perimeter placement** for cabins/focus so conform has something to grow into; re-emit
   shells on conform (mechanism may already exist — raise conformed count by placement).

**Acceptance:** showcase mode looks “designed”; dense mode within seat guardrail; no 3.1841 m
junk dimensions on primary alignments.

---

### WS-G4 — Program completeness (can start in parallel as data-only, land with G1)

**Law:** `testfit-pro-quality.md` §1 program table.

Ensure headcount-driven (or template) program expands to: open work, cabins, meeting 4/6–8,
boardroom when N large, phone booths distributed, focus, collab, reception, pantry, print,
IT, storage, wellness when N large. Generator must **place** them, not only list them.

Wire Program UI / templates so the wizard shows the mix. Deterministic derive.

---

### WS-V — Visual hierarchy & furniture LOD (PARALLEL)

**Law:** `laiout-visual-system.md`, critique visual layer.

1. Wall poche / double-line or true thickness path for generated partitions (coord with G1).
2. Furniture LOD: at plan-framing zoom, desks/chairs remain **symbol-legible**, not chips.
   (`symbols.ts` owns world-unit geometry — do not revive deleted `furniture.ts` patterns
   without checking current R2 ruling.)
3. Zone-first labels: name + count per zone; suppress ground/circulation name tags at rest
   (figure/ground work may already exist — extend, don’t fork).
4. Paper profile: chrome gone; qbiq palette; amber never on paper.
5. Optional amenity: plants/sofas only if generator places them OR a cheap prop layer —
   don’t fake BoQ.

**Acceptance:** side-by-side baseline vs after screenshots in `docs/evidence/pro-feel/`;
`bench/accent-univalence.mjs` / `style-gate` still green; no hardcoded amber hexes.

---

### WS-AI — Un-neuter agentic designer + option diversity (PARALLEL)

**Law:** critique §C; `docs/design/agentic-designer.md` if present.

1. When Claude emits explicit `rooms[]`, generator must still honor **strategy / emphasis /
   meeting_rooms overrides** (today silently dropped — find and kill that drop).
2. Generate options: **multi-seed** (or multi-structure choice) so A/B/C differ spatially;
   objective cards must move layout character, not only counts.
3. Cost/carbon: if fixed shell dominates (~70%), expose variable generated partitions/furniture
   so options’ cost deltas are real.
4. Showcase vs dense available as designer/strategy lever.
5. Keep hybrid: LLM designs program/strategy; **Rust places geometry** (no LLM coordinates).

**Acceptance:** five objective cards produce visually distinct plans on the real plate;
log seed/strategy actually used per card.

---

### WS-R — Rayon interaction feel (PARALLEL, no layout.rs)

**Law:** `editor-ux-rayon-parity.md` §3.1–3.5.

Priority order:

1. **Dynamic input** — parse typed numbers during wall/line draw; live length/angle at cursor;
   Enter commits. Reuse existing `hint()` length computation — rewire display to input.
2. **Ortho / polar** — Shift = ortho; typed angle locks polar; OSNAP still wins near points.
3. **Wire advertised shortcuts** or remove badges.
4. **Selection dimensions / numeric edit** for wall length and room W×H (extend inspector).
5. Stretch: command palette Ctrl+K for tools — only if 1–4 green.

**Acceptance:** browser-verified script: draw wall, type `5`, Enter → wall length 5.00 m ± snap;
Shift constrains ortho; `pnpm typecheck` clean.

---

### WS-M — Metrics honesty + cost cross-surface (PARALLEL, careful)

1. Keep single workstation definition; reference desks never count.
2. Efficiency / usable rollup matches geometry post-G0.
3. **If cost NIA vs GEA defect still live** (`stats.ts` vs `cost.rs`): write an **independent**
   gate that compares headline vs panel (or vs core) **before** fixing; fix with gate green.
   Do not “fix by feel.”
4. Furniture rate tables: one owner or `coreParity` row that fails on drift.

---

### WS-T — Test & evidence battery (continuous)

1. Rust unit tests for every new emission rule (doors, glazing, generated walls, passable doors,
   snap module, cluster size bounds).
2. Re-capture `golden_generate` only with explicit commit message + table of old→new.
3. Browser evidence: real DWG wizard path — create → upload → program → generate A/B/C →
   open editor framed → paper mode → 3D matches counts. Save screenshots.
4. `bash scripts/verify-all.sh --full` at each serial merge gate.
5. Optional: add a small `scripts/pro-feel-smoke.mjs` that loads wasm, generates fixed
   (program, seed), asserts door_count ≥ enclosed_rooms, circulation_components ≤ N,
   dense seats ≥ floor, coords on 0.05 module for desks.

---

## 4. ORCHESTRATION PROTOCOL

### 4.1 How you run the mission

1. Complete §0 (branch, read, baseline ledger).
2. Spawn **in parallel** after G0 starts landing: WS-V, WS-AI, WS-R, WS-M (read-only on
   layout until their needs are known).
3. Run **serial** generator track: G0 → G1 → G2 → G3 (G4 data can prep in parallel).
4. After each serial landing: adversary agent + battery + real-plate seat check + screenshots.
5. Integration merge of parallel streams into mission branch frequently (small commits).
6. Final: full battery, typecheck, real-plate showcase gallery (3 seeds × 2 density modes),
   write `docs/audits/PROFESSIONAL-FEEL-FINAL.md` with measured scorecard vs baseline.

### 4.2 Commit discipline

- Prefix: `pro-feel(g0):`, `pro-feel(g1):`, `pro-feel(v):`, `pro-feel(ai):`, `pro-feel(r):`, …
- One concern per commit when possible.
- Never commit secrets. Never `--no-verify` unless pre-commit is broken for infra reasons —
  then say so in the message.
- After Rust: `make wasm` and commit wasm bindings if this repo requires them on the branch
  (Vercel path commits wasm — follow existing convention on your base branch).
- Update `docs/ROADMAP.md` checkboxes **in the same change** as the work.

### 4.3 Ledger discipline

Append-only `docs/audits/PROFESSIONAL-FEEL-LEDGER.md`:

```
## <timestamp> · <workstream> · <commit>

Intent:
Change:
Measured before → after (seats, efficiency, door count, circ fragments, …):
Guardrail status (dense seats, NIA≤GEA, determinism):
Falsification run:
Open risks:
```

### 4.4 Conflict rules

- Only **one** agent edits `crates/ds-core/src/layout/**` at a time.
- `paint.ts` / `planStyle.ts` / `symbols.ts`: coordinate with V + G1 (glazing/poche).
- `lib.rs` Editor API: additive when possible; every `&mut self` mutator bumps revision
  (existing test enforces).
- Do not “help” by rewriting the qbiq sheet pack unless emission breaks it — then fix gates
  with independent checks.

### 4.5 Agent fan-out budget

Use as many agents as needed, with structure:

| Role | Count guidance |
|---|---|
| Orchestrator | 1 (you) |
| Generator serial builder | 1 at a time |
| Visual / AI / Rayon / Metrics builders | up to 4 parallel |
| Adversary / reviewer | 1 per generator landing |
| Explore (read-only) | as needed for file maps |
| Browser verifier | 1 for E2E screenshots |

If a builder and adversary disagree, **measurement wins**. Builder does not self-certify.

---

## 5. REFERENCE IMPLEMENTATION CHECKLIST (copy into PR bodies)

### Generator

- [ ] `Wall.generated` / clear on generate / excluded from plate trace
- [ ] `Wall.glazing` on corridor fronts of appropriate rooms
- [ ] Door per enclosed room; passable in circulation grid
- [ ] Spine + secondary aisles; entry narrative
- [ ] No continuous jitter; 0.05 m snap
- [ ] Neighbourhood packing (showcase); dense mode seat guardrail held
- [ ] Program table completeness for headcount N
- [ ] Strategy/emphasis honored with explicit rooms[]
- [ ] Multi-seed / multi-structure A/B/C diversity
- [ ] Density dual-mode wired Program → UI → designer

### Visual / UX

- [ ] Architectural wall drawing (thickness/poche)
- [ ] Furniture LOD at frame zoom
- [ ] Zone labels hierarchy; ground unnamed at rest
- [ ] Typed length input while drawing
- [ ] Ortho/polar
- [ ] Shortcuts real or badges removed
- [ ] Numeric properties on selection (minimum viable)

### Proof

- [ ] Baseline vs after table in FINAL.md
- [ ] Screenshots: dense + showcase, 2D paper + editor, 3D
- [ ] `cargo test -p ds-core` green (count by name)
- [ ] `bash scripts/verify-all.sh --full` green
- [ ] `pnpm typecheck` green
- [ ] Real-plate seat numbers for dense A/B/C
- [ ] Adversary notes for G1/G2/G3

---

## 6. DEFINITION OF DONE (mission exit)

The mission exits **only** when all of the following are true:

1. Showcase mode on the real plate produces a plan that an uninvolved reviewer (adversary
   agent + your own screenshot rubric) scores as **professional architecture emission**
   (partitions, doors, glass, spine, neighbourhoods) — not “desks on pastels.”
2. Dense mode holds the seat guardrail (± measurement).
3. Rayon dynamic input works for wall length.
4. A/B/C options are spatially distinct.
5. Full battery green; no known “green board over missing cost gate” if you touched cost —
   if cost still disagrees across surfaces, either gate+fix or explicitly list as
   **out of scope residual** in FINAL.md (do not claim fixed).
6. `PROFESSIONAL-FEEL-FINAL.md` written with scorecard vs baseline and remaining known gaps
   (honest). Handoff for any residual is a short next-mission prompt, not vibes.

**Belief language:** do not say “we match Laiout 100%.” Say measured deltas (efficiency,
seats, door coverage, circ fragment count, qualitative screenshot rubric 1–5).

---

## 7. STARTER COMMANDS

```bash
export PATH="$HOME/.cargo/bin:$PATH"
export DS_MISSION=professional-feel
export DS_SESSION=pf-$(date +%H%M)

# baseline
make wasm
cargo test -p ds-core -- --list | tail -5
bash scripts/verify-all.sh --full   # or the project’s standing full battery
cd web && pnpm typecheck

# after Rust edits
make wasm
cargo test -p ds-core

# browser (own port — never steal 5173 from other worktrees)
cd web && pnpm dev -- --port 5190 --strictPort
# verify: scripts/verify-preflight.sh 5190 <token-from-your-change>
```

---

## 8. TONE AND STANDARDS

- Write like a senior architect shipping a product, not a research intern collecting docs.
- Prefer **measured** claims. Screenshots with build-identity tokens. Sabotage before believe.
- Delete dead code when superseding (no-bloat).
- Units: meters in core. Numeric UI: IBM Plex Mono / `.num`.
- Amber: only AI action + selection (Ruling R5). Never on paper.
- When stuck between “pretty” and “dense,” implement **both modes** rather than re-parking.

---

## 9. ONE-LINE MISSION

**Make DSource generate and present a professional test-fit — architecture, circulation,
neighbourhoods, honest metrics, and CAD-feel input — on a branch that never touches
integration merge debt, proved by measurements and adversaries, dense seats protected,
showcase mode allowed to spend seats for beauty.**

Begin at §0. Do not write product code before the baseline ledger exists.

---

## Appendix A — Pasteable orchestrator system prompt (short)

If your Claude Code session wants a shorter sticky system reminder, use:

```
Mission professional-feel on branch professional-feel/*. Never edit integration.
Law: docs/missions/PROFESSIONAL-FEEL-MISSION.md + testfit-pro-quality.md + laiout-parity-critique.md.
Serial: layout/** one writer. Parallel: visual, AI un-neuter, Rayon dynamic input, metrics.
Dual density: dense (seats ≥ baseline−5%) + showcase (may −15% seats, efficiency ≥70% target).
G0 free accounting → G1 rooms as architecture → G2 spine/entry → G3 neighbourhoods.
Adversary after each G landing. make wasm after Rust. Ledger append-only.
Exit only with PROFESSIONAL-FEEL-FINAL.md + green battery + real-plate evidence.
```

## Appendix B — Suggested first agent dispatches

1. **Explore:** map current wall/door/glazing/generated flags, emit path, pack_desks, facade gap, AI rooms[] drop sites — return file:line map only.
2. **G0 builder:** free efficiency wins only.
3. **V builder:** furniture LOD + label hierarchy (no layout).
4. **R builder:** typed length dynamic input (no layout).
5. **AI builder:** find and remove strategy drop; multi-seed options (may touch strategy.ts + GenerateStep; avoid layout packing).

After G0 green → G1 sole focus until doors+partitions land on real plate.
