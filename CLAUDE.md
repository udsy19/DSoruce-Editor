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
  - `layout.rs` — the deterministic seeded office generator. This file is the **orchestrator**:
    `generate` drives one stage per submodule in `layout/` — `program` (what to place) · `seed` (PRNG +
    desk lattice) · `grid` · `regions` (wings, corridors, bands) · `jobs` · `place` · `emit` ·
    `packing` · `conform` · `score`. `generate` and `score` are the only entry points `lib.rs` calls.
  - `lib.rs` — the `Editor` wasm boundary (`generate`, `layout_score`, `circulation`, `revision`, plus
    editing). Every `&mut self` method bumps `revision()`; `tests::every_mutator_bumps_the_revision`
    scans this file's source to enforce it.
- **`web`** (Vite + React + TypeScript): a thin renderer over the core.
  - `src/types/` — the shared vocabulary, an acyclic chain `program → metrics → doc` (+ `cad.ts`).
    Import document/metrics/program types from HERE, never from a canvas.
  - `src/editor/` — `EditorCanvas.ts` is the façade (canvas, transforms, input routing, `render()`)
    delegating to `paint.ts` (all drawing), `interaction.ts` (drag/resize/room edits) and `search.ts`
    (the **autonomous search loop**: `autoGenerate` iterates seeds, keeps the best score).
  - `src/import/` — `DrawingCanvas.ts` is the façade over `drawingScene` / `drawingRender` /
    `drawingEdit` / `drawingInput`.
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
- **Typography carries meaning:** quantitative data — areas, counts, dimensions, prices,
  coordinates — uses **IBM Plex Mono** (the `.num` class / `--font-mono` / `ui/type.ts` `MONO`), so a
  metrics column reads as an instrument. Not every integer in a sentence: `num` marks the *value*.
  UI text uses **Hanken Grotesk**; large display headlines use **Schibsted Grotesk**.
  *(This section previously specified Space Grotesk for UI — a font the app never loaded. Both it and
  Plex Mono were named in ~47 places and shipped in neither; `src/ui/fonts.test.mjs` now fails the
  build if a named family isn't imported.)*
- **Two palettes, never crossed** (`docs/design/ui-system.md` §4.1.1). **UI chrome** uses the brand
  accent `--accent` (blue `#2d5bd6`). **The canvas** uses a closed, semantic set — gray
  `--canvas-unbound`, blue `--canvas-bound` (a product is specified) — governed by what an object
  *is*. `--canvas-bound` holds the same hex as `--accent` today and is deliberately **not** aliased
  to it: a rebrand must not silently recolour every specified item on every plan.
  *(`--canvas-live` was RETIRED by Ruling R3′/R5: selection/hover is `--accent-selection`, one of
  amber's two declared meanings below. UI elements that are legends for canvas state — a marker's
  ref pin — correctly use the canvas/selection token.)*
- **One scroll owner per screen** (`docs/design/ui-system.md` §1). `#root` owns the viewport
  (`100dvh`); exactly one pane per screen scrolls; the canvas pans and never scrolls; `vh`/`dvh`
  appears nowhere but `#root`. A viewport-unit box inside a non-viewport box is how the double
  scrollbar happened.
- **Appearance lives in `styles.css`, state lives in class modifiers.** No inline `CSSProperties`
  dictionaries, no hard-coded hexes in components; state variants are `.is-active` / `.is-selected` /
  `.is-collapsed`, never merged style objects at the call site. When a colour genuinely belongs to
  one component and no token fits, declare it once as a component-scoped custom property on that
  component's block — not in `:root`.
- **A named resource is verified on four levels** (`docs/design/ui-system.md` §3.6.3): its name
  resolves, its value matches its owner, its stated provenance is true, and the facet you use is the
  facet the owner defines. **A `// mirrors X` comment is a claim to verify, not documentation.**
  Prefer exporting the value across the wasm boundary (`open_share()`, `door_depth()`,
  `Editor::density_score()`); if a mirror is genuinely unavoidable, register it in
  `web/src/coreParity.test.mjs`, which parses the value out of the Rust source and fails on
  divergence.
- **The amber accent has EXACTLY TWO meanings (Ruling R5), and nothing else may be amber.**
  1. **AI action** — `--accent-amber` / `ACCENT_AMBER`: the acts and verdicts of generation
     (sparkle FAB, Regenerate, Test-fit, Autonomous test-fit, the AI verdict badge).
  2. **Live selection** — `--accent-selection` / `SELECTION_ACCENT`: selection, hover, active,
     pick (CAD selection, 3D highlight, import hover, viewer active states, tool toggles,
     the minimap "you are here" puck, plan-library and candidate-card selection).

  **One value, two names.** The selection family *references* the amber declaration
  (`--accent-selection: var(--accent-amber)`) rather than restating it, so amber has a single
  owner and a rebrand touches one line. Two names exist because the two meanings are
  independent, not because the colours differ — reading `SELECTION_ACCENT` at a call site tells
  you *why* that mark is amber.

  **Paper invariant:** amber never appears in deliverable output, in any encoding. Both meanings
  are chrome, and chrome vanishes on paper; the sheet belongs to the qbiq palette.

  Choosing among already-generated options is **navigation**, not an AI action — but it *is*
  selection, so card selection is selection-amber while the AI badge on the same card is
  action-amber. When adding a control, ask which of the three it is.

  Never hardcode the value in any encoding: `#E8A13C`, `#e8a13c`, `rgba(232, 161, 60, …)` and
  `0xe8a13c` are all the same colour and all banned outside the declaration. Campaign 4 searched
  only the first and reported the tree clean while 11 sites in the other three encodings were
  live. `bench/accent-univalence.mjs` enforces this by VALUE; `bench/style-gate.mjs` pins
  `ACCENT_AMBER` equal to `--accent-amber`.

- **Typography carries meaning:** all numeric/dimension data uses **IBM Plex Mono**; UI uses
  **Space Grotesk**. A single warm-amber accent (`#E8A13C`) sits on deliberately cool content colors.
- **Gate independence** (`.claude/rules/gate-independence.md`): a gate may not consume any value
  produced by the system under test — it must re-derive its ground truth from the artifact bytes or
  the core state. Every blocker in the qbiq-parity mission was one instance of violating this, each
  against a 10/10 board. Any gate touching producer-adjacent data ships with the byte-identical-
  under-sabotage proof.
- **No bloat** (`.claude/rules/no-bloat.md`): search for an existing symbol before adding a new one;
  delete superseded code in the same change.

## Verifying a change in the browser

Non-negotiable, because each of these cost real time (`docs/design/ui-system.md` §3.6.1):

```bash
scripts/verify-preflight.sh <port> <identifier-from-your-change> [module-path]
scripts/pixdiff.py before.png after.png [diff.png]   # "nothing changed" is a measurement
```

- **Bind your dev server to its own port.** Never reuse 5173 — parallel worktrees hold it, and a
  `vite --strictPort` from another branch answers normally while serving someone else's code.
- **Reload is not `goto`.** After a crash (WebGL especially) navigating to the same URL+hash does not
  reload; force `location.reload()`.
- **Grep the served module for an identifier, never comment text** — esbuild strips comments in dev.
- **Verify through the app's own module graph**, not a hand-rolled `import()` of the same file — a
  second, uninitialised copy of the wasm module throws and looks exactly like a broken export.

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
**Tests** (`cargo test -p ds-core`; `node src/**/*.test.mjs` from `web/`): Rust ≥138 named after the
ui-fixes merge, ≥157 after export — counted BY NAME, because a matching number with a missing name
is a regression. Includes `golden_generate_output_is_frozen`, which pins `generate()` output for 10
(program, seed) cases — if you change the generator deliberately, re-capture its expectations,
never relax it.
**Qbiq output parity pack** — one action emits a 12-sheet formula-wired QTO workbook (embedded plan +
per-room thumbnails, live pricing), four 4K room renders, a 43 s 1080p walkthrough mp4, and a
self-hosted `/share/<id>` 3D viewer; all derived from one `Editor` state. Acceptance gates live in
`scripts/gates/` — **`bash scripts/gates/run-all.sh` is the only trusted signal** (10/10 green).
Rust: 150 tests.
Parked: multiplayer (designed in `docs/design/multiplayer.md`; a presence milestone was built and
reverted — recover from commits `3a923ea` + `706c7cf` when resumed). Next: cloud plan sync.
See `research/08-open-questions.md`.
