# DSource Editor — Vision

## The one-liner

**A space editor that designs with you.** Draw or import a space, set your criteria, and let it
autonomously generate the best-fitting plan — then edit any element and swap in real products, in 2D
or 3D. It is the drafting precision of Rayon, the product intelligence of Materio, and the generative
test-fits of Laiout, unified — with an autonomous agent doing the tedious part.

## Why

Space planning today is split across disconnected tools: you draft in CAD, you track selections in a
spreadsheet or a separate app, and you either hand-place every desk or pay for a black-box generator
that hands back a picture you can't edit. Nobody owns the whole loop — **draw → generate → refine →
specify → view → export** — and nobody makes the generation *truly* interactive and *truly*
accountable to the constraints that matter (circulation, clearances, capacity, cost).

DSource closes that loop in one editable document.

## Who it's for

Interior architects, workplace strategists, and commercial real-estate teams who need credible office
test-fits fast — and need the output to be *real* (editable geometry, a costed schedule, exportable
CAD), not a marketing render.

## The three inspirations, unified

| Layer | Inspiration | In DSource |
|-------|-------------|------------|
| **Edit** | Rayon | Effortless, precise 2D CAD in the browser; rulers, snapping, a Rust/Wasm core built for scale. |
| **Specify** | Materio | Select any element → bind a real product from a searchable bank; every component carries a decision lifecycle (open → in-review → confirmed) and a cost. |
| **Generate** | Laiout | AI test-fits from a program; regulation-aware; view in 2D or 3D; freeze what you like, regenerate the rest. |

The unifying idea: **a placed component is one object with four facets** — geometry, semantics
(category), a product binding, and a decision state. That's what lets editing, specification, and
generation all act on the same entities.

## The differentiator: an autonomous test-fit agent

Laiout and qbiq generate layouts. DSource **optimizes them autonomously against your criteria.** You
set the program (headcount, room mix) and the goals (capacity, adjacency, **circulation**, cost,
carbon); the engine runs a **generate → evaluate → optimize** loop — proposing candidates, scoring
them, and keeping the best — recursively until the criteria are met or the budget is spent.

Two things make this credible rather than magical:

1. **Circulation is a first-class objective.** "Making the most of the room" means the *walking space*
   is good, not just the desk count. We compute a real walkability metric — an occupancy grid, a
   distance transform for corridor widths, connectivity of the free space — grounded in ADA/IBC
   clearance norms. The corridor the generator reserves is the same corridor the evaluator measures.
2. **The output is editable and accountable.** Every generated plan is live geometry you can hand-edit,
   re-imagine element by element, price into a schedule, and export.

Today this runs as a deterministic generator wrapped in a seed-search loop. Next, a **Claude-in-the-loop
evaluator** judges the soft, aesthetic goals a metric can't — gated behind the hard-constraint metrics
so it only spends tokens on plans that already pass the numbers.

## The pipeline

```
Import / Draw ─▶ Define criteria ─▶ Generate (autonomous loop) ─▶ Review & edit (2D/3D)
                                                                      │
                     Export / share ◀── Spec & cost ◀── Re-imagine ◀──┘
```

- **Import / Draw** — wall tools + DWG/PDF import with a "CAD cleaner."
- **Define criteria** — program + hard constraints + weighted objectives.
- **Generate** — the autonomous loop; freeze/regenerate for human-in-the-loop control.
- **Review & edit** — hand-edit anything; toggle 2D ↔ 3D; live metrics (area, capacity, circulation, cost).
- **Re-imagine** — click any component → swap a real product from the searchable bank.
- **Spec & cost** — a costed, approvable schedule by room and vendor.
- **Export / share** — DWG/DXF/IFC/OBJ/PDF/CSV; a shareable interactive link.

## Principles

- **The plan is the hero.** The interface is a precise instrument, not a dashboard. Every number reads
  like a dimension on a technical drawing.
- **Editable or it doesn't count.** Generation produces real geometry, never a dead image.
- **Constraints are explicit.** The user sets the search space and the rules; the agent explores within
  them. Circulation, clearances, and capacity are measured, not asserted.
- **One document.** Editing, specification, and generation operate on the same entities.

## Where we are / where we're going

**Working now:** browser 2D editor (draw, place, select, drag), autonomous test-fit generation with a
weighted score, circulation evaluation, per-element re-imagine against a (mock) material bank, decision
lifecycle, live metrics, and a 2D↔3D viewer.

**Next:** real material-bank API · Claude-in-the-loop soft-goal evaluation · freeze/regenerate UI ·
import/export (DWG/PDF/IFC) · richer objectives (daylight, cost, carbon) · multiplayer (CRDT) · the
Rust/WebGL renderer for very large plans.

See `research/` for the grounded competitive/technical research and `research/08-open-questions.md` for
the locked decisions and open questions.
