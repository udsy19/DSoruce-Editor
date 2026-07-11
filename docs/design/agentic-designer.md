# Design — Agentic Senior Designer ("Claude designs the space with you")

**Status:** Draft · 2026-07-11 · owner: AI-systems
**Companions:** `ai-backbone-architecture.md` (the tool-call control plane),
`autonomous-testfit-loop.md` (the deterministic generate→evaluate→optimize loop),
`consequence-reasoning.md` (dry-run preview/approve). This doc is the **orchestration
layer above all three** — it does not restate them.

---

## 0. What this is, in one paragraph

Today the user sets a program and DSource searches seeds for the best-scoring fit.
This feature adds a **senior-designer brain**: the user gives a brief in plain language
("a 120-person sales floor, collaborative, client-facing reception, quiet focus zone
away from the pantry"), and **Claude decides the design** — the program, the spatial
**strategy**, the **zoning**, the **adjacencies**, the **anchored** placements, and the
product/material intent — then invokes the existing deterministic generator to realize
it, evaluates the result against the brief and the metrics, and **iterates in an
autonomous loop** until it is satisfied or the turn budget is spent. It can explain
*why* it made each move. The geometry — packing, clearances, collision, corridor width
— stays with the Rust solver, which already does it well.

**One line:** Claude is the designer's *brain* (program, strategy, adjacency, critique);
the Rust solver (`layout::generate`) is the designer's *hands* (coordinates, compliance).

---

## 1. Why a hybrid — the feasibility finding

Pure-LLM geometric placement is unreliable: LLMs "lack intrinsic spatial understanding,"
mis-align and overlap elements, and produce inconsistent sizes when asked to emit
coordinates directly — this holds even for frontier models. But LLMs are strong at the
*design reasoning* around the geometry: interpreting a brief, choosing a program and
strategy, reasoning about adjacencies, and critiquing a candidate. The 2025 state of the
art pairs LLM reasoning with a **verifiable / symbolic constraint layer** (RL-with-
verifiable-rewards, symbolic reasoning layers) rather than trusting the model with raw
placement. See the feasibility notes and sources tracked with this feature.

DSource already *is* that split: our `layout::generate` is the verifiable constraint
layer (it guarantees corridors and clearances by construction and returns a real
`LayoutScore` + `CirculationScore`). The only missing piece is a Claude loop that
**drives** it at the design level instead of a blind seed search.

**Hard rule:** Claude never emits final x/y for furniture. It proposes *intent*
(program, strategy, room requirements, adjacency preferences, and at most **anchor
points** — coarse "put reception near the entry" pins the solver already supports); the
solver places and verifies.

---

## 2. Where it sits (reuse, don't reinvent)

```
        BRIEF (natural language)  ─────────────────────────────┐
                                                                ▼
   ┌───────────────────────────── SENIOR-DESIGNER AGENT (new) ──────────────────┐
   │  system prompt: workplace-design standards (NBC 2016 / BCO / RICS / ergo)   │
   │  loop: interpret → PROPOSE design-spec → generate → EVALUATE → CRITIQUE →   │
   │        refine, bounded by a turn budget + a must-pass hard gate             │
   └───────┬───────────────────────┬────────────────────────┬───────────────────┘
           │ design tools           │ generate               │ evaluate
           ▼ (extend vocabulary)    ▼ (reuse)                ▼ (reuse)
   set_program / set_strategy   EditorCanvas.autoGenerate    evaluator.ts
   place_room / set_placement   refineWithAI / generateOnce  (soft-goal judge)
   set_adjacency / place_anchor  → layout::generate (Rust)   + LayoutScore
   bind_product / generate       → LayoutScore + circulation() + CirculationScore
           │
           ▼ every document mutation is accountable
   engine.ts preview()  →  consequence card  →  approve/undo  (consequence-reasoning.md)
```

Concretely, this feature is: **(a)** a new `AgentDriver`-shaped *design agent* (a
long-horizon sibling of `ClaudeDriver`), **(b)** an extended tool vocabulary, **(c)** a
senior-designer system prompt, and **(d)** a bounded autonomous loop that composes
`refineWithAI` + `evaluateCandidates`. Everything below the dashed box already exists.

---

## 3. Input — the brief and the design spec

**Brief (user):** free text + the current context the drivers already assemble
(`DriverContext`: program, zones, walls, workstations) plus the plate area (from the
traced floor plate). Optionally a few structured toggles (headcount, budget band,
culture: open ↔ cellular) surfaced in the UI.

**Design spec (Claude's structured output):** a superset of the existing `Program`
(EditorCanvas.ts) plus explicit **rooms**, **strategy**, **adjacencies**, and
**anchors** — all of which the core *already* accepts:

| Spec field | Backed by (existing) | Notes |
|---|---|---|
| `program` (desks, meeting_rooms, dims, weights) | `Program` / `DEFAULT_PROGRAM` | Claude sets the levers, seeded by `suggestProgram(drawing, plateArea, current)` |
| `strategy` | `Strategy = Open \| Balanced \| Cellular` | drives `weight_bias()` + open/cellular share |
| `rooms: RoomReq[]` | `RoomReq { kind: SpaceKind; count; w?; d?; placement? }` | 14 `SpaceKind`s already serialize to `generate` |
| `placement` per room | `Placement = Window \| Core \| Flexible` | **soft** bias in the solver (never a hard fail) |
| `anchors: DocAnchor[]` | `add_anchor(kind, x, y)` / `clear_anchors()` | solver places anchored rooms FIRST (Pass 0) |
| `adjacency emphasis` | `w_adjacency`, `relationship_adjacency` | today a scalar weight; see §4 for surfacing the graph |

The spec is deliberately **semantic/zonal**, never per-desk coordinates.

---

## 4. Tool vocabulary (what to add)

Extend the single source of truth, `llmSchema.ts::OPENAI_TOOLS` (and its Anthropic
mirror via `openaiToolsToAnthropic`). New **design tools**, each mapping to an existing
`Editor` mutation or generator call — no new geometric capability is invented:

| Tool | Maps to | Owner of geometry |
|---|---|---|
| `set_program(delta)` | `refine.ts::applyDelta` (extended past the 6 levers) | — |
| `set_strategy(Open\|Balanced\|Cellular)` | `program.strategy` | — |
| `add_room(kind, count, placement?)` | append `RoomReq` to `program.rooms` | solver |
| `set_room_placement(kind, Window\|Core\|Flexible)` | `RoomReq.placement` | solver (soft bias) |
| `place_anchor(kind, x, y)` | `Editor.add_anchor` | solver (Pass 0 pin) |
| `clear_anchors()` | `Editor.clear_anchors` | — |
| `set_adjacency(a, b, want\|avoid)` | new weight/hint feeding `relationship_adjacency` (see below) | solver (scored) |
| `generate(seed?)` | `autoGenerate` / `generateOnce` | solver |
| `evaluate()` | `getMetrics` + `circulation()` + `evaluateCandidates` | — |
| `bind_product(zone_or_category, query)` | existing material-bank binding | — |

Plus the **existing** assistant tools (`regenerate`, `merge_zones`, `set_zone_type`,
`split_zone`, `remove_selection`) for post-generation touch-ups.

Two vocabulary notes:
- **Adjacency is currently only a scalar** (`w_adjacency` + Rust `relationship_adjacency`
  with fixed relations: meeting↔entry, focus↔facade, pantry-central). To let Claude
  reason about relationships as a graph, surface a small **adjacency hint list**
  `[{a: SpaceKind, b: SpaceKind, pref: 'near'|'far'}]` into `score`'s adjacency term. This
  is the one genuinely new *scoring* input; keep it a soft term, never a hard constraint.
- **Lockstep fork:** `mapCall`/`summarize` are duplicated in `claudeDriver.ts` and
  `llmDriver.ts`. Any tool added here must be added to **both** (they are kept in
  lockstep against `OPENAI_TOOLS` by hand).

---

## 5. The agentic loop

A long-horizon loop that composes what exists. Pseudocode (TS side, one "design run"):

```
designSpec = await propose(brief, ctx)            // Claude → structured spec (§3)
applySpecToProgram(ec, designSpec)                // program + rooms + strategy + anchors
let best = ec.autoGenerate(program, {maxIter, target})     // solver realizes it
for (round of 0..TURN_BUDGET) {
  const facts = { score: best, circ: ec.circulation(), zones: ec.getZoneStats() }
  const critique = await evaluate(brief, facts)   // reuse evaluator.ts soft-goal judge
  if (critique.satisfied || round === TURN_BUDGET) break
  const move = await nextMove(brief, facts, critique)   // Claude → ≤1 design tool call
  const trial = applyAndGenerate(ec, move)              // snapshot-guarded
  best = keepIfBetter(best, trial)                      // refScore (fixed original weights)
}
narrateRationale(designSpec, steps)               // "why" transcript for the user
```

This is `refineWithAI` **generalized**: instead of only proposing a numeric
`ProgramDelta`, each round may propose any single design tool call (strategy flip, add a
focus room, pin reception, nudge adjacency). Keep `refineWithAI`'s two proven
guardrails: **snapshot rollback** of rejected rounds, and **fixed-weight `refScore`** as
the yardstick so re-weighting moves aren't judged circularly.

**Convergence:** bounded by `TURN_BUDGET` (default 4–6 rounds) AND a hard gate — the
final plan must pass the non-negotiables (`engine.ts` already encodes `MIN_CORRIDOR =
1.5` m NBC 2016, `MIN_AREA_PER_WS = 6.0`); a plan that fails the gate is never accepted.

**Modes:** ship as an opt-in **"Design with AI" (deep) mode** alongside the fast
deterministic *Generate*. The loop is several Claude calls (~10–60 s); the deterministic
path stays the default for quick iteration.

---

## 6. The senior-designer system prompt (outline)

A dedicated `buildDesignerSystem(ctx)` (sibling of `buildSystem`), encoding a defensible,
India-first design reasoner:

1. **Role:** a senior workplace interior designer producing a code-compliant office
   test-fit; decisions are explained, not asserted.
2. **Standards:** NBC 2016 (India) egress/corridor minima; BCO 2023 / RICS density bands
   (≈8–12 m²/person); ergonomic clearances; daylight/facade for open plan; acoustic
   zoning (focus/phone away from pantry/collab/entry).
3. **Method:** zone before you place — circulation spine first, support/service rooms to
   the core, benches on daylight, meeting rooms banded, reception at the entry.
4. **Boundaries (critical):** *never output coordinates for furniture*; work in program,
   strategy, rooms, placement bias, adjacency preference, and coarse anchors only. The
   solver owns geometry and will reject anything illegal.
5. **Output contract:** on propose → the design-spec tool; per round → at most one design
   tool call + a one-line rationale; on finish → a short design narrative.

Models (per `ai-backbone-architecture.md` targets): **`claude-opus-4-8`** for the designer
brain (heavy reasoning), **`claude-sonnet-5`** for the per-round critique/next-move
(higher volume). Both already route through `/api/claude` (key server-side; not streaming
today).

---

## 7. What Claude decides vs. what the solver owns

| Claude (brain) | Solver `layout::generate` (hands) |
|---|---|
| headcount → program, desk/meeting counts | desk packing, bench pairing, cluster columns |
| strategy (Open/Balanced/Cellular) | corridor reservation + min-width guarantee |
| which rooms, how many, placement bias | collision-free room placement, keepout respect |
| adjacency preferences (near/far) | anchored-room Pass-0 pinning |
| coarse anchor points ("reception here") | exact coordinates, clearances, glazing |
| critique: "focus rooms too close to pantry" | `LayoutScore` + `CirculationScore` (verifiable) |
| product/material intent | — |

If Claude proposes something the solver can't satisfy (e.g. an anchor with no room to
place), the solver degrades gracefully (unknown anchor kinds are already silently
ignored) and the critique step sees the unmet intent and adjusts.

---

## 8. Accountability & guardrails

- **Propose → preview → approve** for anything that mutates a *live* document the user is
  editing: route design tool calls through `engine.ts::preview()` → consequence card →
  approve/undo (`useAgent`), exactly like the assistant. Fully-autonomous "design from
  scratch" runs on a fresh/empty document need no per-step approval, but present the final
  result + rationale before it replaces anything the user made (mirror `testFitPlan`'s
  replace-confirm).
- **Bounded autonomy:** `TURN_BUDGET` cap + must-pass hard gate → converges, never wanders.
- **Snapshot-guarded:** every rejected round reverts via `Editor.snapshot`/`restore`.
- **Token discipline:** reuse `evaluator.ts`'s batch gate — only spend Claude on plans that
  already clear the hard numeric target.

---

## 9. Integration points (files to touch)

- `web/src/ai/contract.ts` — add the design `ToolName`s + arg shapes.
- `web/src/ai/llmSchema.ts` — add design tools to `OPENAI_TOOLS`; new `buildDesignerSystem`.
- `web/src/ai/claudeDriver.ts` **and** `web/src/ai/llmDriver.ts` — extend `mapCall` in
  **both** (lockstep fork).
- `web/src/ai/refine.ts` — generalize `applyDelta` past the 6 levers (rooms/strategy/
  anchors); or a new `applyDesignMove`.
- `web/src/editor/EditorCanvas.ts` — a `designWithAI(brief, opts)` sibling of
  `refineWithAI` driving the loop of §5; extend the TS `CirculationScore` interface to
  include `entry_reachable_fraction` + `corridor_coverage` (current TS↔Rust drift) so the
  designer can reason over entry reachability.
- `crates/ds-core/src/layout.rs` — extend `score`'s adjacency term to read an optional
  soft **adjacency hint list** (the one new scoring input); `#[serde(default)]` so all
  existing callers/blobs are unaffected. Run `make wasm` after.
- `web/vite.config.ts` + `deploy/server.ts` — no contract change needed (`/api/claude`
  already accepts `{system, messages, tools}`); keep the two in lockstep as always.
- UI: a "Design with AI" entry point + a rationale/critique transcript panel (extend
  `AgentPanel`).

---

## 10. Build phases

1. **Spec + prompt (no loop):** brief → `buildDesignerSystem` → propose a design-spec →
   `applySpecToProgram` → single `autoGenerate`. Ship the "one-shot designer" first; it's
   already better than blind seeds and validates the prompt + spec contract.
2. **The loop:** add critique (`evaluate`) + per-round `nextMove` with snapshot rollback
   and the turn budget — i.e. `designWithAI`.
3. **Adjacency graph:** surface the soft adjacency hint list into `score`; let Claude
   reason about relationships explicitly.
4. **Accountability polish:** consequence previews on live edits + the rationale panel.
5. **Product/material intent:** `bind_product` moves in the loop (Materio tie-in).

Each phase is independently shippable and browser-tested against `samples/furniture-plan.dwg`.

---

## 11. Limits & non-goals

- **Geometry stays with the solver.** No per-furniture coordinates from Claude — ever.
- **Latency/cost:** the loop is multi-call; it is a *deep* mode, not the default.
- **Not a replacement** for the deterministic generator — it *drives* it.
- **Adjacency stays soft** — a scored preference, never a hard solver constraint (matches
  how `Placement` is already treated).

---

## 12. Open questions

- Adjacency: full user-editable graph vs. a fixed relation set + Claude-tuned weights?
- Turn budget vs. token budget — cap by rounds, by tokens, or by "no score improvement
  for N rounds"?
- Should the one-shot designer (phase 1) replace the current default *Generate* for
  imported plans, or stay a separate button?
- How much of the rationale transcript to persist into the `.dsource` file (design intent
  as a first-class, saved artifact)?
