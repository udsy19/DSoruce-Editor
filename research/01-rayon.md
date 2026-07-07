# Rayon — Effortless Collaborative CAD

Source of truth: <https://www.rayon.design/> and the Browsertech technical profile
(<https://digest.browsertech.com/archive/browsertech-digest-how-rayon-is-making-cad/>).

## What it is

**[Confirmed]** Rayon is a browser-based, multiplayer CAD tool aimed at interior designers and
architects — positioned as "the effortless CAD." The entire CAD application runs in the browser while
staying fast enough for complex architectural drawings.

This is the **drawing & editing** inspiration for our editor: precise vector CAD that feels as light as
Figma, with real-time collaboration.

## Feature set (what to learn from)

**[Confirmed] Drawing & drafting**
- Professional 2D CAD optimized for speed and precision
- Wall tool + a BIM/CAD command set for fast drafting
- Built-in distance and angle measurement
- Import DWG, PDF, images; export PDF drawing sets and DWG
- Schedule/table generation from the drawing (item scheduling for procurement/budgeting)

**[Confirmed] Components & libraries**
- 4,000+ pre-built elements/components and 4,000+ textures/finishes
- Custom libraries
- 100+ templates with customizable drawing standards

**[Confirmed] AI features**
- AI-enabled asset generation/find via conversational assistance
- AI visualization (sketch → image)
- AI tracing (image → vectorized sketch/wireframe)
- An AI assistance panel for guidance on features/CAD best practice

**[Confirmed] Real-time collaboration**
- Multi-user simultaneous editing with live cursors
- Comments and "doodles" directly on the canvas
- One-click share links with public access
- Version history with restore
- Role-based permissions (Owner / Editor / Viewer)

## How it's built (the important part for us)

**[Confirmed]** Rayon's core is written in **Rust, compiled to WebAssembly**. The document model lives
in the Wasm linear-memory buffer; JavaScript is a thin communication layer between the browser and the
Wasm runtime. Because a project can hold **hundreds of thousands of objects**, Rust+Wasm was chosen not
just for speed but for tight memory layout.

**[Confirmed]** They built their **own WebGL renderer** (in Rust) rather than using an off-the-shelf
library, after benchmarking alternatives and concluding a custom renderer was needed to scale. The
renderer has domain-specific GPU tricks: **hatched areas and dashed lines computed directly in GPU
shaders**.

**[Confirmed]** The Rust libraries are kept "as pure as possible" — almost no browser-API calls except
the WebGL renderer. This keeps the geometry/document core portable and testable.

**[Confirmed]** It is a **multiplayer** platform with real-time collaboration.
**[Inferred]** Multiplayer over a large shared document strongly implies a CRDT or OT sync layer, but
the exact conflict-resolution mechanism is **[Unknown]** from public sources.

## Takeaways for our editor

1. **A vector CAD core deserves a dedicated, high-performance renderer.** Rayon proves a custom WebGL
   pipeline beats generic scene graphs at CAD scale. For us, the pragmatic first step is a mature 2D
   WebGL library (e.g. Pixi.js) or 2D-canvas, with the option to specialize later. (See
   `05-open-source-building-blocks.md`.)
2. **Keep the geometry/document core UI-agnostic.** Rayon's "pure core, thin JS layer" split is a good
   architectural north star even if we start in TypeScript rather than Rust.
3. **Collaboration is a first-class concern, not a bolt-on.** If we want multiplayer, the data model
   must be designed for it from day one (CRDT-friendly document).
4. **"Effortless" is the product bar.** The differentiator is not feature count; it's that drafting
   feels light and immediate.

## Open items to verify
- Exact multiplayer sync mechanism (CRDT vs OT) — **[Unknown]**.
- Whether their DWG import is client-side or server-side — **[Unknown]**.
