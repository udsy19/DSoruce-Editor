# Layout-Generation & Agentic-Refinement Toolbox

The public research menu for "generate a good test-fit, then recursively improve it until the user's
criteria are met." Laiout/qbiq keep their exact methods **[Unknown]**; these are the documented approaches
we can actually build on. Sources are cited inline.

## 1. Classic optimization approaches (proven, explainable)

- **Evolutionary / genetic algorithms** — optimize element arrangement for minimal overlap within a
  boundary plus desired topological (adjacency) relations. **NSGA-II** (multi-objective genetic
  algorithm) is specifically used to explore optimal space-layout solutions across competing objectives.
  - Refs: <https://www.mdpi.com/2075-5309/13/7/1793>, ResearchGate heuristic-layout paper
    (<https://link.springer.com/chapter/10.1007/978-3-319-44989-0_25>)
- **Heuristic space-subdivision** — generate furniture/zoning layouts via space-subdivision rules +
  object–object and object–space relations. Fast, deterministic, easy to constrain.
- **Physics-inspired layout** — treat rooms as bodies with attraction/repulsion/adjacency forces and let
  the system relax to a low-energy (well-packed, constraint-satisfying) configuration.
  - Ref: <https://arxiv.org/pdf/2406.14840> (fetch blocked as binary; cited from search abstract)

**Why we care:** these give **fast, controllable, explainable** candidate generation and map cleanly onto
hard constraints (clearances, circulation width, adjacency). Good default engine.

## 2. Learned / generative approaches

- **Conditional GANs** for furniture layouts (learns plausible arrangements from example plans).
  Ref: <https://www.mdpi.com/2075-5309/13/7/1793>
- **Deep reinforcement learning** for architectural layout (e.g. laser-wall partitioning).
  Ref: <https://arxiv.org/pdf/2502.04407>
- **LLM-driven co-optimization** for interior layout (Co-Layout).
  Ref: <https://arxiv.org/pdf/2511.12474>

**Why we care:** produce more "human/aesthetic" results but need data + training and are harder to
constrain precisely. Candidate for a *later* upgrade over the classic engine.

## 3. The agentic loop (the user's "recursive until criteria met")

Documented, production-shaped pattern — the **generator → evaluator → optimizer** loop:

1. **Generator** produces a candidate layout (from constraints/program).
2. **Evaluator** scores it against an explicit **rubric / criteria** (a critique prompt or a set of
   metric validators).
3. **Optimizer** revises based on the feedback (or the generator re-rolls the weak parts).
4. **Repeat until** the result meets the criteria, is approved, or hits a retry/step limit.

Sources:
- Anthropic-style **Evaluator-Optimizer** pattern; AWS "evaluator reflect-refine loop"
  (<https://docs.aws.amazon.com/prescriptive-guidance/latest/agentic-ai-patterns/evaluator-reflect-refine-loop-patterns.html>)
- Multi-AI-agent iterative refinement (<https://arxiv.org/html/2412.17149v1>)
- "Agentic Architect" — human defines the **search space + constraints + evaluation protocol**; the agent
  explores it via iterative generate→simulate→refine (<https://arxiv.org/html/2604.25083>)
- "Physics-in-the-loop" hybrid agent for **validated CAD** — pairs an LLM with a real validator
  (<https://arxiv.org/html/2605.19717v1>)

**Key design principle from the literature:** the **human sets the search space, constraints, and the
evaluation protocol**; the agent explores within it. Loops suit tasks where the number of steps can't be
known in advance and latency is acceptable for higher-quality results — exactly the test-fit problem.

### How this maps to our product

| Agentic concept | Our editor |
|---|---|
| Search space | The room boundary + placeable component library |
| Constraints | Hard rules: clearances, circulation width, code, fixed/frozen elements |
| Criteria / objective | User-set goals: capacity, adjacency, daylight, cost, carbon, **circulation quality** |
| Generator | Classic layout engine (GA/heuristic/physics) — see §1 |
| Evaluator | Metric validators + optional LLM critique against the rubric |
| Optimizer / re-roll | Regenerate weak zones; keep **frozen** ones (Laiout's Freeze/Regenerate UX) |
| Stop condition | All criteria pass, user approves, or step/token budget hit |

**Circulation / "walking place"** becomes a concrete evaluator: compute walkable paths (e.g. clearance
graph / medial-axis of free space), score path widths, dead-ends, travel distances, and egress; feed the
score back into the loop as an objective. **[Inferred]** — this is a standard computational-geometry
approach, not something any of the three products document.

## Recommended build order (my opinion, to confirm)

1. **v1 — deterministic engine:** heuristic/constraint placement + hard-constraint validators
   (clearance, circulation width). Fast, explainable, no training data. Add Freeze/Regenerate.
2. **v2 — agentic wrapper:** generator→evaluator→optimizer loop around v1, with user criteria as the
   rubric and an LLM as the evaluator/critic for the soft/aesthetic goals.
3. **v3 — learned generation:** introduce GAN/RL/LLM generators once there's data and a metrics baseline.

This ordering front-loads controllability and defers the data-hungry parts. **Confirm before we commit.**
