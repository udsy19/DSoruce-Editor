# AI Backbone Architecture — natural-language control of the canvas

> Status: **design / proposed**. Companion to `docs/design/autonomous-testfit-loop.md`.
> Owner: AI-systems. Target models: `claude-opus-4-8` (driver), `claude-sonnet-5`
> (high-volume), `claude-haiku-4-5-20251001` (cheap intent / classification).

## 0. What this is and why

The #1 product priority is an **AI framework as a backbone** that controls every
canvas element with precision through natural language. The user types
_"merge these two rooms"_; the agent asks the questions it needs
(_which two? target headcount?_), **reasons about the consequences**
(_capacity 24 → 18, min corridor 1.2 m → 0.9 m, area/person 5.4 → 7.2 m²_),
**previews** the change, and only mutates the document **after the user approves** —
in real time, on the same live geometry, with one-click undo.

Design tenets (grounded in current human-in-the-loop agent practice — propose →
preview → approve, block commits until approval is recorded, make diffs obvious,
support "approve with edits"):

1. **The core stays the source of truth.** Claude never edits the document
   directly. It emits **tool calls**; a thin TS layer executes them against the
   Rust/Wasm `Editor`, exactly as a human click would. (`CLAUDE.md`: _never put
   document/business logic in the TS renderer_ — the AI layer is a *caller* of
   `Editor`, not a second model.)
2. **Supervised by construction.** Read-only tools auto-run. **Destructive or
   bulk mutations never touch the visible document without a consequence preview
   and an explicit approve.** Every applied step is snapshot-backed and undoable.
3. **One tool interface, two drivers.** The same `Tool` contract is satisfied by
   (a) a local deterministic intent parser that works **today with no backend and
   no API key**, and (b) Claude behind a streaming proxy. The UX
   (clarify → preview → approve → execute → undo) is identical; Claude drops in
   behind the same layer.
4. **The API key never reaches the browser.** A minimal backend proxy holds it
   and streams Anthropic messages; tool execution stays client-side against the
   Wasm document.

---

## 1. Architecture

### 1.1 Components

```
┌──────────────────────────── browser (client) ───────────────────────────────┐
│                                                                              │
│  AgentPanel.tsx ──► agent.ts (conversation state machine + agent loop)       │
│        ▲                 │            ▲                                       │
│        │ chat, chips,    │ ToolCall[] │ ToolResult[]                          │
│        │ consequence     ▼            │                                       │
│        │ card, approve   tools.ts (Tool registry: schema + client executors) │
│        │                 │            ▲                                       │
│        │                 ▼            │  state()/generate()/… + snapshot()    │
│        │            EditorCanvas.ts ──► Rust/Wasm `Editor`  (source of truth) │
│        │                 │                                                    │
│        │                 └──► canvas repaint + 3D viewer (live preview)       │
│        │                                                                      │
│  driver = LocalDriver (intentParser.ts)   ── OR ──   ClaudeDriver (fetch SSE) │
└──────────────────────────────────────┬───────────────────────────────────────┘
                                        │  POST /api/agent  (SSE)
                                        ▼
┌──────────────────────── backend proxy (holds ANTHROPIC_API_KEY) ─────────────┐
│  /api/agent : stateless streaming relay                                       │
│   • Vite dev-server middleware for local dev (server.middlewares.use(...))     │
│   • Hono/Express handler for prod (identical body)                            │
│   • client.messages.stream(...) → pipe raw SSE straight through               │
└──────────────────────────────────────┬───────────────────────────────────────┘
                                        │  Messages API (streaming, tool_use)
                                        ▼
                                 Anthropic API (Claude)
```

The **agent loop runs on the client**; the proxy is a **stateless relay for a
single `messages.create` streaming call**. This keeps the proxy trivial (no
session store, no document knowledge, survives restarts) and keeps every
`tool_use` executing client-side against the one authoritative Wasm document.
This is the "passthrough" tool-execution pattern: Anthropic streams a `tool_use`,
we execute it locally, and feed a `tool_result` back on the next request.

### 1.2 Why a proxy at all

The Anthropic API key cannot ship to the browser (CORS + secret exposure). The
proxy's *only* jobs are: attach the key, forward `{system, tools, messages}` to
Anthropic, and stream the SSE back. It never sees the Wasm document and never
executes a tool. Two interchangeable implementations:

- **Dev (zero new infra):** a Vite dev-server middleware in `web/vite.config.ts`
  so `pnpm dev` already serves `/api/agent`.
- **Prod:** a ~40-line Hono (or Express) handler with the identical contract,
  deployable as a serverless function.

### 1.3 Request / response contract

**`POST /api/agent`** — request body:

```jsonc
{
  "phase": "clarify" | "plan" | "converse",   // hint only; drives model/effort/system
  "model": "claude-opus-4-8",                  // optional; server clamps to an allowlist
  "system": "…",                               // optional caller override (else server default)
  "messages": [ /* Anthropic MessageParam[]: full running transcript incl. tool_results */ ],
  "docDigest": { /* compact JSON state summary — see §4.3 */ }
}
```

- Response: `Content-Type: text/event-stream`. The proxy **pipes the raw
  Anthropic SSE events through unchanged** (`message_start`, `content_block_start`,
  `content_block_delta`, `content_block_stop`, `message_delta`, `message_stop`).
  The client reconstructs the assistant message from the deltas (live text for the
  chat bubble; accumulated `tool_use` blocks for execution).
- The proxy **injects** `tools` (the frozen registry from §2), merges `docDigest`
  into the request as a trailing `{"role":"system"}` message (Opus 4.8 —
  mid-conversation system message; preserves the cached prefix), and sets
  `thinking`/`effort` from `phase`.
- Errors: proxy forwards HTTP status + Anthropic error body as a terminal
  `event: error` SSE frame so the client can surface it in the panel.

Minimal proxy handler (Node/Hono; the Vite-middleware form is byte-identical in
the handler body):

```ts
// api/agent.ts  — the whole server side of the backbone
import Anthropic from '@anthropic-ai/sdk'
import { TOOLS, SYSTEM, phaseParams } from '../shared/agentContract' // shared with client

const client = new Anthropic() // reads ANTHROPIC_API_KEY from env
const ALLOWED = new Set(['claude-opus-4-8', 'claude-sonnet-5', 'claude-haiku-4-5-20251001'])

export async function agentHandler(req: Request): Promise<Response> {
  const { messages, model, docDigest, phase } = await req.json()
  const stream = client.messages.stream({
    model: ALLOWED.has(model) ? model : 'claude-opus-4-8',
    max_tokens: 8000,
    ...phaseParams(phase),                 // thinking + output_config.effort
    system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
    tools: TOOLS,                          // frozen list → stays in the cached prefix
    messages: [
      ...messages,
      { role: 'system', content: `CURRENT DOCUMENT:\n${JSON.stringify(docDigest)}` },
    ],
  })
  // Pipe raw SSE straight to the browser.
  return new Response(stream.toReadableStream(), {
    headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
  })
}
```

> The SDK's `stream.toReadableStream()` emits the raw event stream; the browser
> parses it with the same event shapes. If you prefer, `client.messages.stream`
> on the client is not possible (needs the key) — hence the relay.

### 1.4 Sequence diagram — "merge these two rooms"

```
User        AgentPanel      agent.ts(loop)     tools.ts        Editor(Wasm)     /api/agent → Claude
 │  type       │                │                 │                │                  │
 │────────────►│  addUserMsg    │                 │                │                  │
 │             │───────────────►│  build digest ◄─┼─ query_state ──┤ state()          │
 │             │                │  POST /api/agent (messages, docDigest, phase=clarify)│──────────►│
 │             │                │◄───────────── SSE: text deltas + tool_use? ──────────│◄──────────│
 │             │  render text   │                 │                │                  │
 │             │◄───────────────│  (assistant asks: "which two rooms? target HC?")     │
 │◄─ chips ────│                │                 │                │                  │
 │  pick 2 +   │                │                 │                │                  │
 │  "18 ppl"──►│───────────────►│  POST /api/agent (phase=plan)  ─────────────────────►│──────────►│
 │             │                │◄── SSE: tool_use merge_rooms{a,b,target_headcount:18}─│◄──────────│
 │             │                │  DRY-RUN on scratch clone ───────►│ snapshot→apply→   │
 │             │                │                 │  diff metrics   │ metrics/circ      │
 │             │  consequence   │◄────────────────┤ (before/after)  │ restore scratch   │
 │◄─ card ─────│  card + [Approve][Reject]        │                │                  │
 │  Approve ──►│───────────────►│  apply for real │─ merge_zones ──►│ (live repaint)   │
 │             │                │  tool_result ───┼────────────────┤                  │
 │             │                │  POST /api/agent (tool_result) ─────────────────────►│──────────►│
 │             │                │◄── SSE: text "Merged. Capacity 24→18…" + stop ────────│◄──────────│
 │◄─ summary + [Undo] ──────────│                 │                │                  │
```

The loop repeats while `stop_reason === "tool_use"`: execute the block(s),
append `tool_result`, re-POST. It ends on `stop_reason === "end_turn"`.

---

## 2. The tool schema

Tools are the **only** vocabulary Claude uses to touch the document. Each maps to
an existing `Editor` method or a **flagged core addition** (§6). Every tool
declares a **class** that drives the supervision policy (§3.3):

- `read` — no mutation; auto-executes, never previewed.
- `stage` — mutates *agent-local* intent (e.g. the `Program`), not the document;
  auto-executes.
- `mutate` — mutates the document; **requires consequence preview + approve**
  unless it is a single, trivially-reversible edit (see per-tool `autoApply`).
- `destructive` — clears/replaces/removes geometry; **always** preview + approve.

The registry is **frozen and deterministically ordered** so it stays in the
cached prompt prefix (`shared/prompt-caching.md`).

### 2.1 Tool list (summary)

| Tool | Class | Maps to `Editor` | Status |
|---|---|---|---|
| `query_state` | read | `state()` | ✅ exists |
| `query_metrics` | read | `metrics()` + `layout_score(program)` + `circulation()` | ✅ exists |
| `set_program` | stage | agent-local `Program` (feeds `generate`) | ✅ (client state) |
| `generate` | destructive | `generate(program, seed, keep_confirmed=false)` | ✅ exists |
| `regenerate` | destructive | `generate(program, seed, keep_confirmed=true)` | ✅ exists |
| `add_component` | mutate | `add_component(category,x,y,w,h)` | ✅ exists |
| `move_component` | mutate | **needs** `move_component(id,x,y)` | ⚠️ core add |
| `delete_component` | destructive | **needs** `delete_component(id)` | ⚠️ core add |
| `set_decision` | mutate | `set_decision(id,state)` (freeze = `Confirmed`) | ✅ exists |
| `assign_product` | mutate | `assign_product(id,product_id,name)` | ✅ exists |
| `merge_rooms` | destructive | **needs** zones model → `merge_zones(a,b)` | ⚠️ core add (§6) |
| `split_room` | destructive | **needs** `split_zone(id,axis,at)` | ⚠️ core add (§6) |
| `set_zone_type` | mutate | **needs** `set_zone_kind(id,kind)` | ⚠️ core add (§6) |
| `resize_room` | mutate | **needs** `resize_zone(id,x,y,w,h)` | ⚠️ core add (§6) |

### 2.2 Concrete definitions

Read/query:

```jsonc
{ "name": "query_state",
  "description": "Read the current document: walls, components (id, category, position, size, decision, product), zones, and the current selection. Call this before reasoning about ANY change so you refer to real ids. Returns the same shape the renderer uses.",
  "input_schema": { "type": "object",
    "properties": { "include": { "type": "array", "items": { "type": "string", "enum": ["walls","components","zones","selection"] } } },
    "additionalProperties": false } }

{ "name": "query_metrics",
  "description": "Read live metrics: floor_area, component_count, confirmed count; the weighted LayoutScore (capacity, adjacency, circulation, density, total, placed_desks); and the CirculationScore (min_corridor_width, mean_clearance, pct_corridors_below_min, largest_connected_free_region, enclosed). Use to quote real before/after numbers when reasoning about consequences. Only meaningful when wall_count > 0.",
  "input_schema": { "type": "object", "properties": {}, "additionalProperties": false } }
```

Program + generation:

```jsonc
{ "name": "set_program",
  "description": "Set the test-fit program used by generate/regenerate. All fields optional; omitted fields keep their current value. desks/meeting_rooms are counts; *_w/*_h are footprints in METERS; target_corridor_m and desk_clearance_m are hard constraints; w_* are objective weights (0..1).",
  "input_schema": { "type": "object", "properties": {
    "desks": {"type":"integer","minimum":0}, "meeting_rooms": {"type":"integer","minimum":0},
    "desk_w": {"type":"number"}, "desk_h": {"type":"number"},
    "meeting_w": {"type":"number"}, "meeting_h": {"type":"number"},
    "cluster_cols": {"type":"integer","minimum":1},
    "target_corridor_m": {"type":"number"}, "desk_clearance_m": {"type":"number"},
    "w_capacity": {"type":"number"}, "w_adjacency": {"type":"number"},
    "w_circulation": {"type":"number"}, "w_density": {"type":"number"} },
    "additionalProperties": false } }

{ "name": "generate",
  "description": "Autonomously generate a fresh test-fit for the current program. CLEARS all existing components first — destructive. Runs the seed-search loop (autoGenerate) keeping the best-scoring candidate. Returns the winning LayoutScore. Use for 'lay this out', 'fill the space', 'set headcount to N and re-fit'.",
  "input_schema": { "type": "object", "properties": {
    "max_iter": {"type":"integer","minimum":1,"maximum":64,"description":"seeds to try"},
    "target_total": {"type":"number","description":"early-stop score 0..100"} },
    "additionalProperties": false } }

{ "name": "regenerate",
  "description": "Re-fit only the NON-frozen part of the plan, keeping every Confirmed component in place as an obstacle (Freeze/Regenerate). Use for 'keep these desks, redo the rest'. Destructive to non-confirmed components.",
  "input_schema": { "type": "object", "properties": {
    "max_iter": {"type":"integer"}, "target_total": {"type":"number"} },
    "additionalProperties": false } }
```

Per-element edits:

```jsonc
{ "name": "add_component",
  "description": "Place one component. category ∈ Desk|Chair|Table|MeetingRoom|FallCeiling. x,y is the footprint CENTER in meters; omit w,h to use the catalog default for the category.",
  "input_schema": { "type":"object",
    "properties": { "category":{"type":"string","enum":["Desk","Chair","Table","MeetingRoom","FallCeiling"]},
      "x":{"type":"number"},"y":{"type":"number"},"w":{"type":"number"},"h":{"type":"number"} },
    "required":["category","x","y"], "additionalProperties": false } }

{ "name": "move_component",
  "description": "Move component `id` so its center is at (x,y) meters. Absolute, not relative.",
  "input_schema": { "type":"object","properties":{ "id":{"type":"integer"},"x":{"type":"number"},"y":{"type":"number"} },
    "required":["id","x","y"], "additionalProperties": false } }

{ "name": "delete_component",
  "description": "Delete component `id`. Destructive.",
  "input_schema": { "type":"object","properties":{ "id":{"type":"integer"} }, "required":["id"], "additionalProperties": false } }

{ "name": "set_decision",
  "description": "Advance a component's decision lifecycle. state ∈ Open|InReview|Confirmed. Confirmed = FREEZE (regenerate will keep it in place).",
  "input_schema": { "type":"object","properties":{ "id":{"type":"integer"},"state":{"type":"string","enum":["Open","InReview","Confirmed"]} },
    "required":["id","state"], "additionalProperties": false } }

{ "name": "assign_product",
  "description": "Bind a real material-bank product to a component (the 're-imagine' action). Provide product_id and its display name.",
  "input_schema": { "type":"object","properties":{ "id":{"type":"integer"},"product_id":{"type":"string"},"product_name":{"type":"string"} },
    "required":["id","product_id","product_name"], "additionalProperties": false } }
```

Room / zone operations (depend on the new zones model — §6):

```jsonc
{ "name": "merge_rooms",
  "description": "Merge two adjacent zones into one, removing the shared partition. Optionally re-fit the merged zone to a target headcount. Destructive: dissolves a wall and re-flows contents.",
  "input_schema": { "type":"object","properties":{
    "zone_a":{"type":"integer"},"zone_b":{"type":"integer"},
    "result_kind":{"type":"string","enum":["OpenDesk","Meeting","Collaboration","Core","ClosedOffice","Circulation"]},
    "target_headcount":{"type":"integer","description":"if set, re-fit desks to seat this many"} },
    "required":["zone_a","zone_b"], "additionalProperties": false } }

{ "name": "split_room",
  "description": "Split one zone into two along an axis at a position. axis 'x' splits left/right, 'y' splits top/bottom; at is meters from the zone's min corner. Inserts a partition wall. Destructive.",
  "input_schema": { "type":"object","properties":{
    "zone":{"type":"integer"},"axis":{"type":"string","enum":["x","y"]},"at":{"type":"number"},
    "kind_a":{"type":"string"},"kind_b":{"type":"string"} },
    "required":["zone","axis","at"], "additionalProperties": false } }

{ "name": "set_zone_type",
  "description": "Recolor/retag a zone's purpose. kind drives the pastel fill and which contents belong (Circulation, OpenDesk, Meeting, Collaboration, Core=WC/stairs/lifts, ClosedOffice).",
  "input_schema": { "type":"object","properties":{ "zone":{"type":"integer"},
    "kind":{"type":"string","enum":["Circulation","OpenDesk","Meeting","Collaboration","Core","ClosedOffice"]} },
    "required":["zone","kind"], "additionalProperties": false } }

{ "name": "resize_room",
  "description": "Set a zone's axis-aligned bounds to (x,y,w,h) meters (x,y = min corner). Adjacent zones and shared walls are adjusted to stay contiguous. Mutate.",
  "input_schema": { "type":"object","properties":{
    "zone":{"type":"integer"},"x":{"type":"number"},"y":{"type":"number"},"w":{"type":"number"},"h":{"type":"number"} },
    "required":["zone","x","y","w","h"], "additionalProperties": false } }
```

> **Descriptions are prescriptive about *when* to call** and always tell the model
> that `x,y` is a footprint **center in meters** — Opus 4.8 reaches for tools
> conservatively and follows literal units, so this materially improves calls
> (`shared/tool-use-concepts.md`).

---

## 3. Conversation state machine

```
        ┌───────────┐  underspecified   ┌──────────┐  answered
 user ─►│  INTENT   │──────────────────►│ CLARIFY  │───────────┐
        └─────┬─────┘                   └──────────┘           │
              │ specified                                       ▼
              ▼                                            ┌──────────┐
        ┌───────────┐  tool_use (mutate/destructive)       │   PLAN   │
        │  EXECUTE  │◄────────────── approve ──────┐        └────┬─────┘
        │(streaming)│                              │             │ dry-run
        └─────┬─────┘                   ┌──────────┴───┐         ▼
              │ stop_reason=end_turn    │   PREVIEW    │◄─ consequence diff
              ▼                         │ (approve /   │
        ┌───────────┐   reject          │  reject /    │
        │ SUMMARISE │◄──────────────────│  edit)       │
        │ + UNDO    │                   └──────────────┘
        └───────────┘
   read/stage tools auto-run in any state (no PREVIEW gate)
```

### 3.1 Phases

- **INTENT** — classify the utterance and gather referents. The driver always
  fires `query_state`/`query_metrics` (read, auto) first so it reasons about real
  ids and real numbers.
- **CLARIFY** — if the request is underspecified (ambiguous referents, missing
  a required parameter, a target the model shouldn't guess), the assistant asks
  **targeted** questions. The panel renders answers as quick-pick **chips**
  (candidate room ids, headcount presets) plus free text. Nothing mutates.
- **PLAN** — the model emits the concrete `tool_use` block(s). For `read`/`stage`
  tools the loop just executes them. For `mutate`/`destructive` tools it goes to
  PREVIEW.
- **PREVIEW (consequence dry-run)** — see §3.2. Produces a **diff card**.
- **EXECUTE** — on approve, apply the tool(s) for real against the live `Editor`;
  the canvas + 3D viewer repaint immediately. Streaming text ("Merging…") shows
  progress; each applied step pushes an undo snapshot.
- **SUMMARISE** — final assistant text quotes the realized before→after numbers
  and offers **Undo** (and "undo all" for a multi-step turn).

### 3.2 Consequence preview (dry-run diff) — the mechanism

The preview must compute _"if I did this, capacity 24 → 18, min corridor
1.2 → 0.9 m, area/person 5.4 → 7.2 m²"_ **without disturbing the visible canvas**.
Two supported strategies, both built on one core primitive — `Editor.snapshot()`
/ `Editor.restore(snap)` (§6):

1. **Scratch-clone dry-run (default for `destructive` / bulk):**
   - `before = liveEd.snapshot()` and read `before` metrics.
   - Run the tool executor on a **scratch `Editor`** seeded from `before`
     (`Editor.fromSnapshot(before)`), read `after` metrics.
   - Emit `ConsequenceDiff { before, after, deltas, warnings }`. The visible
     document is never touched. On approve, replay the same executor on `liveEd`.
2. **Optimistic live preview (for cheap single `mutate`):**
   - `push undo snapshot`, apply on `liveEd`, repaint with a dashed "pending"
     style, show the diff card. Reject → `restore(snapshot)`. This gives an
     instant on-canvas preview for e.g. `move_component`.

`ConsequenceDiff` is computed by the tool layer, not the model, so the numbers are
always ground-truth from `metrics()`/`layout_score()`/`circulation()`:

```ts
interface ConsequenceDiff {
  summary: string                       // "Merge Meeting-A + Meeting-B → one OpenDesk zone"
  before: MetricSnapshot                // capacity, min_corridor, area_per_person, cost…
  after: MetricSnapshot
  deltas: { label: string; from: number; to: number; unit: string; good: boolean }[]
  warnings: string[]                    // e.g. "min corridor 0.9 m < IBC 1.118 m"
}
```

The card renders `deltas` as before → after rows (green/red by `good`) and
surfaces `warnings` (regulation breaches from the circulation evaluator) so the
user approves with eyes open.

### 3.3 What "supervised" means (the policy)

| Tool class | Auto-run | Preview required | Approve required | Undoable |
|---|---|---|---|---|
| `read` | yes | no | no | n/a |
| `stage` | yes | no | no | yes (revert program) |
| `mutate` (single, reversible) | optimistic live preview | yes (diff card) | yes (or auto if `autoApply` + no warnings) | yes |
| `destructive` / bulk | no | **yes (scratch dry-run)** | **yes, always** | yes |

Rules enforced in `agent.ts`, not left to the model:
- A `destructive` tool call is **never** applied to `liveEd` before an explicit
  approve event. The model cannot bypass this by phrasing.
- Any tool whose dry-run raises a **regulation warning** (min corridor below
  target, disconnected free space) forces the approve gate even if it was
  `autoApply`.
- Multi-tool turns accumulate into **one approval batch** with a combined diff,
  and one **undo** reverts the whole batch (snapshot taken before the batch).

---

## 4. Model choice, params, and state injection

### 4.1 Models

| Role | Model | Why |
|---|---|---|
| Driver (clarify, plan, consequence reasoning, summarise) | `claude-opus-4-8` | Best autonomous reasoning + literal instruction following; drives the whole loop. |
| High-volume / cost-sensitive default | `claude-sonnet-5` | Near-Opus quality on tool/agentic work at lower cost; swap per-workspace. |
| Cheap intent classification (optional pre-router) | `claude-haiku-4-5-20251001` | Fast "is this a command vs a question vs chit-chat" gate before spending Opus tokens. |

The proxy clamps `model` to this allowlist.

### 4.2 Params

- **Thinking:** `thinking: { type: "adaptive" }` — on for PLAN/PREVIEW (the model
  must reason about consequences), and set `display: "summarized"` so the panel
  can show a "thinking…" trace. For pure CONVERSE/CLARIFY turns, effort `low`.
- **Effort:** `output_config.effort` by phase — `high` for PLAN (correctness of
  the mutation matters), `low` for CLARIFY/CONVERSE (latency). `phaseParams()`
  centralises this.
- **Streaming:** always (`client.messages.stream`) — needed for live text and for
  the timeout headroom on tool-loop turns.
- **Prompt caching:** `system` + `tools` form the stable cached prefix; the
  volatile `docDigest` goes **after** the last breakpoint as a trailing
  `{"role":"system"}` message (Opus 4.8 mid-conversation system message) so a
  changing document doesn't invalidate the tool/system cache.

```ts
export const phaseParams = (phase: string) => ({
  clarify:  { thinking: { type: 'adaptive', display: 'summarized' }, output_config: { effort: 'low'  } },
  plan:     { thinking: { type: 'adaptive', display: 'summarized' }, output_config: { effort: 'high' } },
  converse: { thinking: { type: 'adaptive' },                        output_config: { effort: 'low'  } },
}[phase] ?? { output_config: { effort: 'medium' } })
```

### 4.3 System prompt outline

```
You are the design copilot inside DSource Editor, a browser office space-planner.
You do not edit the document yourself — you call TOOLS; a client executes them
against the authoritative geometry engine. Units are METERS. Component x,y is a
footprint CENTER.

WORKFLOW (always):
1. Read before you reason. Call query_state / query_metrics to get real ids and
   real numbers. Never invent an id or quote a number you didn't read.
2. If the request is underspecified — ambiguous which element, a missing count or
   target, or a choice you shouldn't guess — ASK a short, targeted question and
   stop. Prefer offering concrete options (candidate ids, sensible presets).
3. When specified, emit the tool call(s). For anything that changes geometry,
   the client will show the user a consequence preview and require approval — so
   in your text, state the intended change and the consequence you expect
   (capacity, min corridor width, area per person), grounded in the numbers you
   read.
4. After the change is applied, summarize what changed with real before→after
   numbers and stop.

CONSTRAINTS you must reason about: minimum corridor width (IBC ≈ 1.118 m),
per-desk clearance, capacity vs area-per-person, circulation connectivity.
If a change pushes a metric past a regulation threshold, say so plainly.
Be concise. One recommendation, not a survey. Do not narrate routine tool calls.
```

### 4.4 How the model learns the document each turn

The client builds a **compact `docDigest`** (not the full serialized state — that
can be large and volatile) and appends it as the trailing system message:

```jsonc
{ "floor_area": 300, "wall_count": 4,
  "zones": [ {"id":7,"kind":"Meeting","x":16,"y":1,"w":4,"h":8,"label":"Meeting-A"},
             {"id":8,"kind":"Meeting","x":16,"y":9,"w":4,"h":6,"label":"Meeting-B"} ],
  "counts": { "Desk": 24, "MeetingRoom": 2, "Confirmed": 3 },
  "metrics": { "capacity": 100, "min_corridor_width": 1.2, "area_per_person": 5.4,
               "circulation_total": 78, "layout_total": 84 },
  "selection": 42 }
```

Full detail (every component's coordinates) is fetched on demand via
`query_state` — keeping the per-turn prompt small and cache-friendly.

---

## 5. Pragmatic MVP — works **today**, no backend, no API key

Ship the entire UX (clarify → preview → approve → execute → undo) behind a
**local deterministic intent parser** that satisfies the *same* `Tool` interface
Claude will use. Swapping in Claude is a one-line driver change.

### 5.1 The driver seam

```ts
// web/src/ai/agent.ts
export interface AgentDriver {
  // Given the transcript + doc digest, yield assistant text deltas and tool calls.
  step(input: DriverInput): AsyncIterable<DriverEvent>  // {type:'text'|'tool_use'|'clarify'|'done'}
}
export class LocalDriver implements AgentDriver { /* wraps intentParser.ts */ }
export class ClaudeDriver implements AgentDriver { /* fetch('/api/agent') SSE */ }
```

`agent.ts` (the state machine + supervision policy) is **driver-agnostic**: it
consumes `DriverEvent`s, runs the same PREVIEW/approve/undo logic, and calls the
same `tools.ts` executors regardless of which driver produced the tool call.

### 5.2 The local parser (MVP command set)

`intentParser.ts` — deterministic, keyword/regex → `ToolCall[]` + clarifying
questions, covering at least:

- **merge rooms** — _"merge (these|room X and Y)"_ → if 2 zones selected/named,
  `merge_rooms`; else `clarify("Which two rooms?", candidateChips)` then
  `clarify("Target headcount?", ["keep","12","18","24"])`.
- **add N desks** — _"add 8 desks"_ → `set_program({desks: current+8})` +
  `regenerate` (keep confirmed), or `add_component` ×N if a target zone is given.
- **set headcount → regenerate** — _"fit 30 people"_ → `set_program({desks:30})`
  + `generate`.
- **widen corridor** — _"widen the corridor to 1.5 m"_ →
  `set_program({target_corridor_m:1.5})` + `regenerate`.

Each returns the same `ToolCall` objects `ClaudeDriver` would, so the preview and
approval flow are byte-for-byte identical. Where the parser can't map an
utterance, it emits a `clarify` event ("I can merge rooms, add desks, set
headcount, or widen corridors — which did you mean?"), exercising the same UI.

### 5.3 TS module boundaries

```
web/src/ai/
  contract.ts      # Tool[], ToolCall, ToolResult, ConsequenceDiff, DriverEvent — shared types
  tools.ts         # TOOL REGISTRY: schema + client executor for each tool, bound to EditorCanvas.
                   #   execute(call, ed): applies via Editor methods.
                   #   dryRun(call, ed): scratch-clone → ConsequenceDiff (no live mutation).
                   #   classifies each tool (read/stage/mutate/destructive, autoApply).
  agent.ts         # Conversation state machine + supervision policy + agent loop.
                   #   AgentDriver seam; PREVIEW gate; undo stack; batch approval.
  intentParser.ts  # LocalDriver's brain: NL → ToolCall[] + clarifying questions (MVP).
  claudeDriver.ts  # ClaudeDriver: POST /api/agent, parse SSE, accumulate tool_use blocks.
  AgentPanel.tsx   # Chat UI: message list, clarify chips, streaming text, ConsequenceCard,
                   #   [Approve]/[Reject]/[Edit], [Undo]. Talks only to agent.ts.
web/vite.config.ts # dev: server.middlewares.use('/api/agent', agentHandler)  (prod: Hono/Express)
```

`tools.ts` is the single place that knows how to turn a `ToolCall` into
`Editor` calls (via the existing `EditorCanvas` methods and the `window.__ec`
handle). Neither driver contains document logic — matching the no-bloat rule and
"core is the source of truth."

---

## 6. Core (Rust/Wasm) additions required

The AI tool layer targets a stable `Editor` surface. These additions unblock the
per-element and room/zone tools; ship them in `crates/ds-core` and rebuild with
`make wasm`.

| Need | Method (proposed) | Used by | Notes |
|---|---|---|---|
| Move by id | `move_component(id, x, y)` | `move_component` | Absolute; current `move_selected(dx,dy)` only moves the selection. |
| Delete by id | `delete_component(id)` | `delete_component` | Current `delete_selected` only deletes the selection. |
| Snapshot / restore | `snapshot() -> JsValue`, `restore(snap)`, `from_snapshot(snap) -> Editor` | dry-run + undo | Serialize the whole `Document` **including `next_id`** so ids stay stable across restore. This is the primitive behind both preview and undo. |
| **Zones / rooms (the key gap)** | `add_zone(kind,x,y,w,h) -> id`, `merge_zones(a,b) -> id`, `split_zone(id,axis,at) -> (id,id)`, `set_zone_kind(id,kind)`, `resize_zone(id,x,y,w,h)` | `merge_rooms`, `split_room`, `set_zone_type`, `resize_room` | Add a first-class `Zone { id, kind: ZoneKind, x,y,w,h (AABB v1), label }` to `model.rs`, serialized in `state()`. `ZoneKind ∈ Circulation, OpenDesk, Meeting, Collaboration, Core, ClosedOffice` — matches the Laiout pastel taxonomy. Zones own partition walls; merge dissolves the shared wall, split inserts one. The generator (`layout.rs`) should emit zones alongside components so the AI has real rooms to operate on. |

**There are no first-class rooms today** — this is the single most important core
change for the room/zone half of the tool set. Everything else already exists on
`Editor` or is a small by-id variant of an existing method.

---

## 7. Phasing

1. **P0 (today):** `contract.ts`, `tools.ts` (existing tools only:
   query/set_program/generate/regenerate/add/set_decision/assign_product),
   `agent.ts` state machine, `intentParser.ts` (4 commands), `AgentPanel.tsx`.
   Add `snapshot`/`restore` to core for preview + undo. Fully demoable with **no
   backend**.
2. **P1:** `/api/agent` Vite middleware + `claudeDriver.ts`; flip the driver to
   `ClaudeDriver`. Add `move_component`/`delete_component` to core.
3. **P2:** First-class `Zone` model in `ds-core` + the four room/zone tools;
   generator emits zones; canvas renders pastel zone fills (the Laiout look).
4. **P3:** prod proxy (Hono), per-workspace model selection, cost/telemetry.

---

## Appendix — final tool list (for the orchestrator)

`query_state`, `query_metrics`, `set_program`, `generate`, `regenerate`,
`add_component`, `move_component`, `delete_component`, `set_decision`,
`assign_product`, `merge_rooms`, `split_room`, `set_zone_type`, `resize_room`.
