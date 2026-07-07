# Laiout — AI-Generated, Regulation-Aware Test Fits

Sources: <https://laiout.co/>, <https://www.laiout.co/blog-posts/...>,
AEC Magazine (<https://aecmag.com/cad/laiout-enhances-automated-floor-planning-software/>),
datadrivenaec profile (<https://datadrivenaec.com/tools/laiout>).

## What it is

**[Confirmed]** Laiout is cloud software that automatically generates office floor plans/layouts using
AI, positioned as "the world's only software for generating, iterating, and sharing floor plans live."
Used in 36 countries; customers include British Land, Grosvenor, JLL, Cushman & Wakefield, Match Group.

This is the **intelligence & generation** inspiration: the engine that produces smart test-fits from
requirements and lets you view them in 2D or 3D.

## Feature set (what to learn from)

**[Confirmed] Generation & automation**
- Generates **multiple** floor-plan options **in under ~10 seconds** from an uploaded CAD/PDF
- **Regulation-aware / parametric** generation (compliance baked in)
- Instantly adjusts to **headcount, desk ratios, meeting-room requirements**
- No CAD expertise required (built for non-technical workplace/real-estate teams)
- **Freeze / Regenerate**: lock the parts you like, regenerate the rest — this is the iterative loop

**[Confirmed] Space planning & test fits**
- Fits teams into space (desks, meeting rooms, collaboration zones)
- **Instant feasibility studies** comparing multiple buildings side-by-side
- Auto occupancy + compliance calculation
- Live validation of **clearance rules and seat counts**

**[Confirmed] 2D / 3D viewing**
- Toggle **2D plan ↔ immersive 3D walkthrough**
- Photorealistic AI renders
- Shareable interactive floor plans via links; 3D presentations with no install for viewers

**[Confirmed] Analysis**
- Indicative **fit-out cost** estimates
- **Carbon footprint** (CO₂) per design
- Live area / zone / cost breakdown that updates as you edit

**[Confirmed] Interop**
- Import DWG, PDF
- Export DWG, DXF, Revit (RVT), IFC, OBJ, PDF, CSV
- **CAD file cleaner**: converts messy drawings into planning-ready files
- Custom furniture library (upload brand-specific pieces); portfolio-wide design standards

## How the generation works

**[Confirmed] Workflow:** upload building plan → input preferences/needs (desks, meeting rooms,
collaboration areas) → AI generates multiple compliant options → tweak zoning via preferences →
Freeze/Regenerate to iterate on specific areas.

**[Confirmed]** They describe "proprietary algorithms and generative design" producing hundreds of
regulation-compliant options.

**[Unknown]** The exact algorithm is proprietary and **not public**. It is *not* documented whether it is
GAN-based, RL-based, evolutionary, constraint-solver-based, or LLM-driven. We should **not** assume.
See `06-layout-generation-algorithms.md` for the public research toolbox that spans these options.

## Takeaways for our editor

1. **Generation is requirement-driven, not blank-canvas.** Inputs are a boundary (the space) + a program
   (headcounts, room mix, ratios). Output is *many* candidates, fast.
2. **Freeze/Regenerate is the core iteration UX.** Lock what's good, re-roll the rest. This is exactly the
   "recursive until criteria met" behavior the user wants — with a human (or an evaluator agent) in the
   loop deciding what to freeze.
3. **Compliance/criteria are validated live** (clearances, seat counts, occupancy). Our "criteria set by
   the user" maps directly onto this: criteria become the objective function *and* the validators.
4. **2D↔3D toggle + shareable link** is table stakes for the viewing experience.
5. **Every design carries live metrics** (area, cost, carbon, efficiency). Metrics are what let an
   agent (or user) judge "is this plan good enough yet?"

## Boundary / differentiation for us
- Laiout is **office-focused**. The user wants to "make the most out of the room, handling walking place"
  (circulation) with an agentic loop that runs **recursively until criteria are met**. That agentic,
  criteria-driven refinement is where our product can go beyond a fixed generator.

## Open items to verify
- Whether Laiout's 3D is real geometry or a render pass — **[Inferred]** real geometry given OBJ/IFC
  export, but the walkthrough fidelity is **[Unknown]**.
