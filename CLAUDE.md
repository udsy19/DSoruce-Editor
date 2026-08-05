# CLAUDE.md

Guidance for Claude Code (and humans) working in this repository.

## What this is

**DSource Editor** — a browser-based office space-planning editor. It blends three products
(see `research/`): **Rayon** (effortless CAD editing), **Materio** (select an element → bind a real
product from a searchable bank, with an open→in-review→confirmed decision lifecycle), and **Laiout**
(AI-generated, regulation-aware test-fits, 2D/3D). The differentiator is a **fully autonomous
generate → evaluate → optimize loop** that produces office test-fits optimizing user-set criteria —
including **circulation / "walking place."**

Product vision: **`vision.md`**.

## Architecture

- **`crates/ds-core`** (Rust → WebAssembly): the pure, UI-agnostic source of truth.
  - `document.rs`, `model.rs`, `geometry.rs` — the document model (a placed component is one object with
    four facets: geometry · category · product-binding · decision-state).
  - `circulation.rs` — occupancy-grid + distance-transform circulation evaluator (min corridor width,
    connectivity, ADA/IBC-grounded score).
  - `layout.rs` — deterministic seeded office generator (perimeter corridor, meeting-room band,
    grid-packed desk clusters) + weighted `LayoutScore`.
  - `lib.rs` — the `Editor` wasm boundary (`generate`, `layout_score`, `circulation`, plus editing).
- **`web`** (Vite + React + TypeScript): a thin renderer over the core.
  - `src/editor/EditorCanvas.ts` — 2D canvas: transforms, input, rulers, and rendering. Also the
    TS-side **autonomous search loop** (`autoGenerate` iterates seeds, keeps the best score).
  - `src/three/` — Three.js 3D viewer (`Viewer3D` + `<Scene3D>`), read-only walkthrough.
  - `src/ui/`, `src/materialBank/` (mock bank), `App.tsx`, `styles.css`.
- Rendering is TS-side for now; it migrates to a Rust/WebGL renderer later — see
  `docs/adr/0001-rendering-staging.md`.

## Commands

```bash
./run.sh      # one-command run: auto-bootstraps, rebuilds wasm only if Rust changed, starts dev
              #   ./run.sh build → production build · ./run.sh fresh → force wasm rebuild + dev
make wasm     # rebuild Rust → wasm into web/src/wasm  (REQUIRED after ANY Rust change)
make dev      # make wasm + vite dev server on http://localhost:5173
make build    # make wasm + tsc --noEmit + vite build
make setup    # first-time bootstrap (wasm target, wasm-pack, install)

# lower level
export PATH="$HOME/.cargo/bin:$PATH"
cargo test -p ds-core            # Rust unit tests (layout + circulation)
cd web && pnpm typecheck         # tsc --noEmit
cd web && pnpm dev               # frontend only (uses existing wasm bindings)
```

## Conventions

- **Core is the source of truth.** Mutate through `Editor` methods, then re-read `state()` to render.
  Never put document/business logic in the TS renderer.
- **Units are meters** in the core; the frontend owns pixels-per-meter scale.
- **Typography carries meaning:** all numeric/dimension data uses **IBM Plex Mono**; UI uses
  **Space Grotesk**. A single warm-amber accent (`#E8A13C`) sits on deliberately cool content colors.
- **No bloat** (`.claude/rules/no-bloat.md`): search for an existing symbol before adding a new one;
  delete superseded code in the same change.

## Gotchas

- After editing **any Rust**, run `make wasm` or the frontend keeps using stale bindings.
- `Editor.generate(program, seed)` — **`seed` is a JS `bigint`** (`BigInt(n)`), not a number.
- `generate()` **clears existing components** and is deterministic per seed; `autoGenerate` in
  `EditorCanvas.ts` loops seeds to realize the "recursive until criteria met" search.
- `circulation()` is degenerate with 0 walls — only call it when `wall_count > 0`.
- Keep the exported TS interfaces in `EditorCanvas.ts` stable — `three/Scene3D` depends on them.
- `web/src/wasm/` is generated (gitignored). Fresh clones must `make wasm` before `pnpm dev`.

## Deployment (`deploy/`)

Two deploy targets share the API logic via **`deploy/apiCore.ts`** — the single, env-agnostic
implementation of `/api/agent`, `/api/claude`, `/api/bank` (imported by both servers below).

- **VPS** (`deploy/server.ts`): one Node service (`dsource-api`) serves the built SPA + all `/api/*`
  routes (agent/claude/dwg/bank/plans/share) + the share viewer page, behind Caddy at
  `app.46.202.179.28.sslip.io`.
  `./deploy/deploy.sh` builds, rsyncs, starts everything (idempotent; needs SSH). Full backend.
- **Vercel** (`vercel.json` + `api/*.ts`): SPA on the CDN + `/api/*` as serverless functions.
  `web/src/wasm/` is **committed** so Vercel builds without Rust (rebuild + commit after Rust changes).
  Three routes degrade gracefully: `/api/dwg` → 503 (needs the LibreDWG binary; DXF still works),
  `/api/plans` → 501 (needs disk; plan library is IndexedDB), `/api/share` → 501 (needs disk; the
  Export menu falls back to downloading the .glb and `/share/<id>` says so). Guide: `deploy/VERCEL.md`.
- **Shareable 3D viewer**: `/share/<id>` serves `web/viewer.html` (the SPA build's second entry,
  `web/src/viewer/`) over a GLB published by `web/src/export/share.ts`. The store + `/api/share/*`
  handler is **one implementation** — `deploy/shareStore.ts`, imported by `deploy/server.ts` AND the
  dev middleware in `web/vite.config.ts` (dev bundles land in `web/.dev-plans/share/`).

**Lockstep:** the dev middlewares in `web/vite.config.ts` remain the dev source of truth for
agent/claude/bank — change them and `deploy/apiCore.ts` together.

## Status

Working: 2D editor + CAD drafting layer (draw/modify/trim/extend/fillet/hatch/layers/grips),
DWG/DXF import with plate extraction + keep-outs, autonomous test-fit on irregular plates,
circulation scoring, 2D↔3D viewer incl. Enscape-like render tier, live material bank (₹),
AI drivers (Local/Cerebras/Claude) + Claude soft-goal evaluator, exports (CSV/PNG/DXF/PDF/IFC/OBJ),
.dsource save/open, plan library + compare + version history (IndexedDB).
**Qbiq output parity pack** — one action emits a 12-sheet formula-wired QTO workbook (embedded plan +
per-room thumbnails, live pricing), four 4K room renders, a 43 s 1080p walkthrough mp4, and a
self-hosted `/share/<id>` 3D viewer; all derived from one `Editor` state. Acceptance gates live in
`scripts/gates/` — **`bash scripts/gates/run-all.sh` is the only trusted signal** (10/10 green).
Rust: 150 tests.
Parked: multiplayer (designed in `docs/design/multiplayer.md`; a presence milestone was built and
reverted — recover from commits `3a923ea` + `706c7cf` when resumed). Next: cloud plan sync.
See `research/08-open-questions.md`.
