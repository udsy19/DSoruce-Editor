# Open Questions — Answer Before We Design/Build

## ✅ Decisions locked (2026-07-06)

| # | Decision | Choice |
|---|----------|--------|
| 1 | Domain | **Offices first** (tune constraints for offices; keep core general) |
| 2 | Platform | Browser-based (implied by Rust/Wasm choice) |
| 3 | Core stack | **Rust → Wasm core (Rayon-style)** — geometry/document core in Rust, thin JS/TS layer, custom WebGL 2D renderer; Three.js for 3D viewer |
| 7 | AI autonomy | **Fully autonomous** — set criteria, agent runs generate→evaluate→optimize recursively until criteria met / budget hit |
| 6 | 3D depth | **Viewer + walkthrough** — edit in 2D, auto-extrude to Three.js 3D; renders later |

**Implication of the Rust/Wasm choice:** this is the ambitious, Rayon-grade path. It buys scale and
performance but is significantly more work than TS-first. Build order in `06` still holds, but the
deterministic engine (v1) and the geometry core will both be **Rust**, exposed to the browser via Wasm.

**Still blocking (need from you):**
- **Material-bank API/schema** (Q5) — the re-imagine panel depends on it. Mockable, but I need the real
  contract to finish it.
- **Project nature + existing code** (Q14/Q15) — startup/internal/prototype, and fresh vs existing repo.

---

Per your instruction (no assumptions), these are the decisions I need from you. Grouped by how much they
block progress. The **strawman** is my recommendation, but nothing is committed.

## A. Blocking — I can't propose a concrete architecture without these

1. **Space type / domain.** Office (like Laiout/qbiq)? Residential interiors? Retail/hospitality?
   Any room type? This drives the constraint library and the generator.
   - _Strawman:_ start with **offices** (best-documented constraints), design for general rooms.

2. **Web app vs desktop.** Browser-based like all three references, or desktop (Electron)?
   - _Strawman:_ **browser-based** (matches Rayon/Laiout/Materio).

3. **Tech stack for the geometry core.** **TypeScript-first** (fast to build, easy hiring) or
   **Rust/Wasm** (Rayon-grade scale, much slower to build)?
   - _Strawman:_ **TypeScript-first** for v1; revisit Rust/Wasm only if object counts demand it.

4. **Build-from-scratch vs fork OSS.** Start from **Arcada** (React+Pixi) / OpenFPC as a base, or
   green-field? (See `05-open-source-building-blocks.md`.)
   - _Strawman:_ study Arcada, **green-field the core** with Pixi.js + Three.js, reusing patterns not code.

5. **Material-bank API contract.** The searchable bank lives in another repo. What can it give us per
   item — categories/taxonomy, 3D assets (glTF?), thumbnails, dimensions, cost, vendor? Is there a
   search API I can call? This defines the entire re-imagine panel.
   - _Need:_ the repo's API/schema, or a contact/spec.

## B. Important — shapes scope, needed soon

6. **3D depth.** Is 3D a **viewer** (extrude walls + drop glTF furniture, orbit/walkthrough) or a full
   **3D editor** (edit in 3D too)? Photorealistic AI renders in scope (like Laiout/qbiq)?
   - _Strawman:_ **viewer + walkthrough** first; edits happen in 2D and reflect in 3D. Renders later.

7. **Agentic loop — how autonomous?** Fully autonomous "generate until criteria met," or
   human-in-the-loop (agent proposes, you freeze/approve each round, like Laiout)?
   - _Strawman:_ **human-in-the-loop with an auto mode** — Freeze/Regenerate by hand, or "run until
     criteria pass / budget hit."

8. **Which criteria matter most at v1?** Pick the objectives to optimize first: capacity, adjacency,
   **circulation/walking place**, daylight, cost, carbon, aesthetics.
   - _Strawman:_ **capacity + adjacency + circulation** as hard/first objectives; cost/carbon as metrics.

9. **AI provider for the agent.** Use Claude (Anthropic API) for the evaluator/critic and any
   natural-language criteria parsing? Any constraints (on-prem, cost ceilings)?
   - _Strawman:_ **Claude** for evaluation/critique + NL criteria; deterministic engine for generation.

10. **Multiplayer collaboration** in scope for v1, or single-user first?
    - _Strawman:_ **single-user v1**; design the document model CRDT-friendly (Yjs) so multiplayer can
      come later without a rewrite.

## C. Later — good to know, not blocking v1

11. Interop priority: which import/export formats are must-have first (DWG? PDF? IFC/Revit?).
12. Existing brand/design system, or free hand on UI?
13. Target users: internal designers, or client-facing self-serve?
14. Is this a product/startup, an internal tool, or a prototype/learning project? (Sets the quality bar.)
15. Any existing code in `DSource-Editor` I should build on, or is this a fresh repo?

## Proposed immediate next step (after you answer A)
1. Lock stack + domain.
2. Stand up a minimal 2D editor: draw walls, place a component, select it, open the (mocked)
   re-imagine panel.
3. Add the live-metrics panel + one real evaluator (circulation width).
4. Wrap the generator→evaluator→optimizer loop around it.
5. Add the 2D↔3D toggle.

Each step is a demoable slice. We only proceed once you've set the direction.
