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

## Status

2D editor (draw/place/select/re-imagine), autonomous test-fit generation, circulation scoring, and a
2D↔3D viewer all work. Rust: 11 tests pass. Not yet done: real material-bank API, import/export
(DWG/PDF/IFC), Claude-in-the-loop soft-goal evaluation, multiplayer. See `research/08-open-questions.md`.
