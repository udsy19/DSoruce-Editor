# DSource Editor

**A browser-based office space-planning editor that designs *with* you.** Draw or import a floor
plate, state the program, and DSource autonomously generates a priced, buildable, regulation-aware
test-fit — then lets you edit any element, bind real products, and walk it in 3D. It unifies the
drafting precision of **Rayon**, the product intelligence of **Materio**, and the generative
test-fits of **Laiout** into one editable document, with an autonomous agent doing the tedious part.

The differentiator is a **fully autonomous generate → evaluate → optimize loop** that produces office
test-fits optimizing user-set criteria — including **circulation / "walking place."**

> **Niche:** DSource is curated for **India GCCs (Global Capability Centres)** — the captive India
> offices of multinationals — where **seat efficiency / cost-per-seat is the headline KPI**. It is
> India-first: prices in **₹**, regulations grounded in **NBC 2016**, ESG in IGBC/LEED terms. The
> reference bar is Laiout / qbiq.

Product vision: [`vision.md`](vision.md).

---

## Table of contents

- [The loop](#the-loop)
- [What it does](#what-it-does) — the full feature surface
  - [1. Draw & draft (CAD layer)](#1-draw--draft-cad-layer)
  - [2. Import real drawings](#2-import-real-drawings)
  - [3. Autonomous test-fit generation](#3-autonomous-test-fit-generation)
  - [4. The agentic senior designer (Claude)](#4-the-agentic-senior-designer-claude)
  - [5. Circulation & metrics](#5-circulation--metrics)
  - [6. Material bank & the decision lifecycle](#6-material-bank--the-decision-lifecycle)
  - [7. AI assistant (edit by conversation)](#7-ai-assistant-edit-by-conversation)
  - [8. 2D ↔ 3D viewer](#8-2d--3d-viewer)
  - [9. Cost & carbon](#9-cost--carbon)
  - [10. Plan library, versioning & compare](#10-plan-library-versioning--compare)
  - [11. Save / open & exports](#11-save--open--exports)
- [Architecture](#architecture)
- [Getting started](#getting-started)
- [Commands](#commands)
- [Configuration (AI keys)](#configuration-ai-keys)
- [Deployment](#deployment)
- [Project structure](#project-structure)
- [Conventions](#conventions)
- [Status](#status)

---

## The loop

The whole product is one closed loop over a single editable document:

```
draw / import  →  generate  →  evaluate  →  optimize  →  refine  →  specify  →  view  →  export
   plate         test-fit     circulation   best seed    edit /     bind real    2D/3D    CSV/PNG/DXF
                              cost/carbon   per criteria  converse   products             PDF/IFC/OBJ
```

Nothing is a black box: every generated element is a real object you can select, move, rotate,
retype, re-bind, and cost — and every AI change is previewed and undoable.

---

## What it does

### 1. Draw & draft (CAD layer)

A full 2D drafting surface on a pan/zoom canvas with rulers and snapping:

- **Draw:** walls (chained), rectangles, polylines, zones/rooms.
- **Modify:** move, copy, rotate, mirror, scale, offset, trim, extend, fillet.
- **Detail:** hatch/fill, layers (show/hide/lock), grips for precise vertex editing.
- **Elements:** place and edit office components — desks, chairs, tables, meeting rooms, columns,
  doors, windows, casework — as first-class objects with size, rotation, and mirror.
- **Zones/rooms:** create, merge, split, resize, retype, and rename zones; zones can be rectangles
  **or polygons** that conform to angled/irregular walls (no floating walls, no negative space).

### 2. Import real drawings

- **DXF** — parsed fully client-side.
- **DWG** — converted via LibreDWG on the backend (`/api/dwg`).
- **Plate extraction + keep-outs:** the importer reads walls by type, rooms, and a furniture
  inventory, then extracts the buildable **plate** (boundary polygon) and **keep-outs** (cores,
  shafts, columns) so generation respects the real building.
- Verified against a real 882 m² architectural plan (`samples/furniture-plan.dwg`).

### 3. Autonomous test-fit generation

The core is a **deterministic, seeded office generator** (Rust): it lays down a perimeter/spine
corridor, a meeting-room band, and grid-packed desk clusters, conforms rooms to the plate, and fills
the walking area into unified circulation polygons.

- **Autonomous search:** the TS-side loop (`autoGenerate`) iterates seeds and keeps the
  best-scoring layout for your criteria — the "recursive until criteria met" behaviour.
- **Irregular plates:** works on non-rectangular, angled real-world plates, not just boxes.
- **Deterministic:** the same seed always yields the same plan (reproducible, diff-able).

### 4. The agentic senior designer (Claude)

A **hybrid** where **Claude is the brain and the Rust solver is the hands**: Claude designs the
*program and strategy* (headcount, desk count, room mix, meeting ratios, placement bias, emphasis,
and a written rationale); the deterministic engine places every coordinate, corridor, and clearance.
Claude never emits geometry (LLMs are unreliable at placement).

- **Multi-objective options** (Laiout-style): one distinct fit per objective —
  **Balanced · Max seats · Cost-optimised · Collaboration · Experience** — each with a headline
  metric (pax · ₹ · kgCO₂e) and a GCC-specific rationale.
- **GCC-curated defaults:** dense India benching, heavy call/booth space for cross-timezone work,
  manager cabins, war/project rooms, and statutory spaces (mother's/wellness, first-aid, prayer).

### 5. Circulation & metrics

- **Circulation evaluator** (`circulation.rs`): an occupancy-grid + distance-transform model that
  measures **minimum corridor width**, **connectivity**, and an **ADA/IBC-grounded score** — this is
  the "walking place" the product optimizes for.
- **Live metrics:** GEA/NIA, usable vs circulation vs core split, workstation count, area-per-seat,
  m²/seat efficiency, zone stats — recomputed from the core on every edit.

### 6. Material bank & the decision lifecycle

- Select any element → search a **live material/product bank** and bind a real product (priced in ₹).
- Each placed element carries a **decision state**: **Open → In Review → Confirmed**, with a status
  dot — so a plan doubles as a specification you can track to sign-off.

### 7. AI assistant (edit by conversation)

Open the assistant and reshape the plan in natural language — *"add 30 desks,"* *"widen the corridor
to 1.5 m,"* *"make the open workspace a collaboration zone,"* *"merge the meeting rooms."*

- **Consequence preview:** before→after workstations, corridor width, area/person, cost, carbon, plus
  NBC/IBC/planning warnings. **Nothing changes until you Apply**, and every change is **undoable**.
- **Three drivers, switchable:** **Local** (deterministic intent parser — no key, offline),
  **Cerebras / any OpenAI-compatible LLM**, and **Claude**. A Claude **soft-goal evaluator** scores
  fuzzy criteria ("feels collaborative," "calm") the deterministic score can't.

### 8. 2D ↔ 3D viewer

- Toggle any plan into a **Three.js 3D walkthrough** (read-only): extruded walls, parametric PBR
  furniture (oak, fabric, glass, carpet), soft shadows, and image-based ambient light.
- An **Enscape-like "render" tier**: physical sky dome, ambient occlusion, high-res shadows, bloom.

### 9. Cost & carbon

- India **CAT-B** calibration (≈₹20.2k/m², ≈147 kgCO₂e/m²): every plan carries a live **cost (₹)** and
  **embodied-carbon (kgCO₂e)** estimate, broken down by base shell, partitions, and fit-out.

### 10. Plan library, versioning & compare

- Save any test-fit to a **plan library** (IndexedDB, in-browser).
- **Version history** per plan, and a **side-by-side compare** view to weigh options on their metrics.

### 11. Save / open & exports

- **`.dsource`** project save/open (the full editable document).
- **Exports:** CSV (takeoff), PNG (plan image), DXF, PDF (report), IFC (BIM), OBJ (3D geometry).

---

## Architecture

**Core is the single source of truth.** All document and business logic lives in a pure, UI-agnostic
Rust core compiled to WebAssembly; the frontend is a thin renderer that mutates through the core and
re-reads its state.

- **`crates/ds-core`** (Rust → WebAssembly) — the source of truth:
  - `document.rs`, `model.rs`, `geometry.rs` — the document model. A placed component is **one object
    with four facets**: geometry · category · product-binding · decision-state.
  - `circulation.rs` — the occupancy-grid + distance-transform circulation evaluator.
  - `layout.rs` — the deterministic seeded office generator + weighted `LayoutScore`.
  - `lib.rs` — the `Editor` wasm boundary (`generate`, `layout_score`, `circulation`, zones, editing).
- **`web/`** (Vite + React + TypeScript) — a thin renderer over the core:
  - `src/editor/EditorCanvas.ts` — the 2D canvas (transforms, input, rulers, rendering) and the
    TS-side autonomous search loop.
  - `src/three/` — the Three.js 3D viewer (`Viewer3D` + `<Scene3D>`).
  - `src/ai/` — the AI drivers, the agentic designer, and the Claude evaluator.
  - `src/ui/`, `src/materialBank/`, `src/persist/`, `App.tsx`, `styles.css`.
- **`api/` + `deploy/`** — the backend (`/api/agent`, `/api/claude`, `/api/bank`, `/api/dwg`,
  `/api/plans`), sharing one env-agnostic core (`deploy/apiCore.ts`) across the VPS and Vercel targets.

Rendering is TS-side today; it migrates to a Rust/WebGL renderer later — see
[`docs/adr/0001-rendering-staging.md`](docs/adr/0001-rendering-staging.md).

---

## Getting started

### Prerequisites

- **Rust** + `rustup target add wasm32-unknown-unknown`
- [`wasm-pack`](https://rustwasm.github.io/wasm-pack/)
- **Node 20+** and **pnpm**

(`make setup` and `./run.sh` bootstrap the Rust/wasm toolchain for you on first run.)

### Run it

```bash
./run.sh            # one command: bootstraps, rebuilds wasm only if Rust changed, starts dev
```

Open **http://localhost:5173**. Then: **Start a project → drop a DXF/DWG → set the program →
generate** → open a candidate in the editor.

---

## Commands

```bash
./run.sh            # auto-bootstrap + rebuild wasm if Rust changed + dev server
./run.sh build      # production build
./run.sh fresh      # force wasm rebuild + dev

make setup          # first-time bootstrap (wasm target, wasm-pack, install)
make wasm           # rebuild Rust → wasm into web/src/wasm  (REQUIRED after ANY Rust change)
make dev            # make wasm + Vite dev server
make build          # make wasm + tsc --noEmit + vite build

# lower level
cargo test -p ds-core       # Rust unit tests (layout + circulation)
cd web && pnpm typecheck    # tsc --noEmit
cd web && pnpm dev          # frontend only (uses existing wasm bindings)
```

> After editing **any Rust**, run `make wasm` or the frontend keeps using stale bindings.
> `web/src/wasm/` is generated; it is committed so Vercel can build without a Rust toolchain —
> rebuild and commit it after Rust changes.

---

## Configuration (AI keys)

The AI features call same-origin proxies so keys **stay server-side, never in the browser**.
Configure `web/.env.local` (see `web/.env.example`) for dev:

```bash
# /api/claude — designer, evaluator, refine (Anthropic)
ANTHROPIC_API_KEY=...
# ANTHROPIC_MODEL=claude-sonnet-5            # optional

# /api/agent — the OpenAI-compatible agent driver (Cerebras / OpenAI / Groq / local Ollama)
LLM_BASE_URL=https://api.cerebras.ai/v1
LLM_API_KEY=...                              # omit for a local Ollama server
LLM_MODEL=gpt-oss-120b
```

Restart `pnpm dev` after editing `.env.local`. The **Local** driver needs no key and works offline.

---

## Deployment

Two targets share the API logic via **`deploy/apiCore.ts`** (the single implementation of
`/api/agent`, `/api/claude`, `/api/bank`):

- **VPS** — one Node service (`deploy/server.ts`) serves the built SPA + all `/api/*` routes behind
  Caddy. `./deploy/deploy.sh` builds, rsyncs, and starts everything (idempotent; needs SSH). **Full
  backend**, including DWG conversion and server plan sync.
- **Vercel** — SPA on the CDN + `/api/*` as serverless functions (`vercel.json` + `api/*.ts`). Two
  routes degrade gracefully: `/api/dwg` → 503 (needs the LibreDWG binary; **DXF import still works**),
  `/api/plans` → 501 (needs disk; the plan library is IndexedDB and unaffected). Full guide:
  [`deploy/VERCEL.md`](deploy/VERCEL.md).

Set API keys as environment variables on the host / in the Vercel dashboard — never commit them.

---

## Project structure

```
crates/ds-core/     Rust → Wasm core: document model, geometry, circulation, layout engine
web/                Vite + React + TS frontend (thin renderer over the core)
  src/editor/         2D canvas + autonomous search loop
  src/three/          Three.js 3D viewer
  src/ai/             AI drivers, agentic designer, Claude evaluator
  src/materialBank/   product/material bank client
  src/persist/        plan library, versioning, sync (IndexedDB)
  src/wasm/           generated wasm bindings (committed for Vercel)
api/                Vercel serverless functions (agent/claude/bank; dwg/plans degrade)
deploy/             VPS Node server + shared apiCore + deploy scripts + VERCEL.md
docs/               ADRs and design docs (agentic designer, cloud sync, parity critique)
research/           the Rayon / Materio / Laiout research the product is grounded in
samples/            a real DWG/DXF floor plan used for verification
vision.md           product vision
```

---

## Conventions

- **Core is the source of truth.** Mutate through `Editor` methods, then re-read `state()` to render.
  Never put document/business logic in the TS renderer.
- **Units are meters** in the core; the frontend owns the pixels-per-meter scale.
- **Typography carries meaning:** numeric/dimension data uses a monospace/tabular face; UI uses a
  grotesk. A single warm-amber accent (`#E8A13C`) sits on deliberately cool content colors.
- **No bloat:** search for an existing symbol before adding a new one; delete superseded code in the
  same change (`.claude/rules/no-bloat.md`).

---

## Status

**Working:** 2D editor + CAD drafting layer (draw / modify / trim / extend / fillet / hatch / layers /
grips), DWG/DXF import with plate extraction + keep-outs, autonomous test-fit on irregular plates,
circulation scoring, 2D↔3D viewer incl. Enscape-like render tier, live material bank (₹), AI drivers
(Local / Cerebras / Claude) + a Claude soft-goal evaluator, the agentic senior designer + multi-
objective options, cost & carbon (India CAT-B), exports (CSV / PNG / DXF / PDF / IFC / OBJ), `.dsource`
save/open, and a plan library with compare + version history (IndexedDB). **Rust: 131 tests.**

**Parked:** multiplayer (designed in `docs/design/multiplayer.md`; a presence milestone was built and
reverted — recoverable from git when resumed).

**Next:** cloud plan sync; and the Laiout-parity generator work tracked in
[`docs/design/laiout-parity-critique.md`](docs/design/laiout-parity-critique.md) (denser plate fill,
desk neighbourhoods, more rooms conforming to angled walls — some deliberately parked under the
seats-first decision for GCCs).

See [`research/08-open-questions.md`](research/08-open-questions.md) for locked decisions and open items.
