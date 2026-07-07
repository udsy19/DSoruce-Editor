# DSource Editor

A smart 2D/3D interior space-planning editor. It blends three inspirations (see [`research/`](research/)):

- **Rayon** — effortless, browser-based CAD editing.
- **Materio** — select any element and bind a real product/material from a searchable bank, with an
  open → in-review → confirmed decision lifecycle.
- **Laiout** — AI-generated, regulation-aware test-fits with 2D/3D viewing.

The differentiator is a **fully autonomous agentic loop** (generate → evaluate → optimize, recursively
until user criteria — including circulation / "walking place" — are met).

## Stack (chosen)

- **Core:** Rust → WebAssembly (`crates/ds-core`) — document model, geometry, hit-testing, and the
  layout engine. Rayon-style pure core; see [`docs/adr/0001-rendering-staging.md`](docs/adr/0001-rendering-staging.md).
- **Frontend:** Vite + React + TypeScript (`web/`). 2D canvas rendering for now; Three.js 3D viewer next.
- **AI:** deterministic layout engine wrapped in an autonomous evaluator/optimizer loop (Claude for
  natural-language criteria + critique). *Not built yet.*

## Prerequisites

- Rust + `rustup target add wasm32-unknown-unknown`
- [`wasm-pack`](https://rustwasm.github.io/wasm-pack/)
- Node 20+ and `pnpm`

## Run it

```bash
make setup     # first time: wasm target + wasm-pack + build wasm + pnpm install
make dev       # builds the wasm core, then starts the Vite dev server (http://localhost:5173)
```

Or step by step:

```bash
make wasm            # compile Rust core → web/src/wasm
cd web && pnpm install && pnpm dev
```

## What works today (v1 slice)

- Draw walls (click to chain, Esc to stop), on a pan/zoom 2D canvas.
- Place office components (Desk, Chair, Table, Meeting Room, Fall Ceiling).
- Select a component → **re-imagine** side panel: search a (mock) material bank and bind a product.
- Decision lifecycle per component (Open / In Review / Confirmed) with a status dot.
- Live metrics (floor area, component/confirmed/wall counts).
- All document state lives in the **Rust/Wasm core**; the UI is a thin renderer over it.

## AI assistant

Click the **✦ FAB** (bottom of the tool rail) to open the assistant. Ask it to reshape the plan —
_"add 30 desks"_, _"widen the corridor to 1.5 m"_, _"make the open workspace a collaboration zone"_,
_"merge the meeting rooms"_. It proposes a **consequence preview** (before→after workstations, corridor,
area/person, cost, carbon, with IBC/planning warnings), and nothing changes until you **Apply**; every
change is **undoable**.

Two brains, switchable in the panel header:

- **Local** (default) — a deterministic intent parser. No key, works offline.
- **A real LLM** — the `AgentDriver` seam is **provider-agnostic** (OpenAI-compatible function calling),
  so it does **not** require any specific model. Configure `web/.env.local` (see `web/.env.example`):

  ```bash
  # any OpenAI-compatible endpoint — the key stays server-side (never in the browser)
  LLM_BASE_URL=https://api.cerebras.ai/v1   # or OpenAI / Groq / OpenRouter / local Ollama
  LLM_API_KEY=...                            # omit for a local Ollama server
  LLM_MODEL=gpt-oss-120b
  ```

  The proxy is a dev-only Vite middleware at `/api/agent`. Restart `pnpm dev` after editing `.env.local`.
  Verified end-to-end with **Cerebras `gpt-oss-120b`** and a local **Ollama** model.

## Roadmap (next slices)

1. Circulation evaluator ("walking place") + more live metrics.
2. Autonomous generate → evaluate → optimize test-fit loop against user-set criteria.
3. 2D ↔ 3D toggle (Three.js viewer: extrude walls, drop glTF furniture).
4. Real material-bank API (replace the mock).
5. Import/export (DWG/PDF in; DWG/DXF/IFC/PDF out) and multiplayer (CRDT) later.

See [`research/08-open-questions.md`](research/08-open-questions.md) for locked decisions and open items.
