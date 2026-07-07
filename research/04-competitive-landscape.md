# Competitive & Adjacent Landscape

Products beyond the three references that reveal what's proven, what's hard, and where the gaps are.
Everything here is from public sources and tagged for confidence.

## qbiq — AI space planning / test fits (closest to Laiout)

Source: <https://www.qbiq.ai/>

**[Confirmed] Four-step workflow:** Upload (CAD/PDF/JPEG) → Define (program: usage, capacity, specs; or
let AI recommend) → Customize (themes/finishes) → Receive (full planning package).

**[Confirmed] Outputs** — a notably complete deliverable set:
- 2D floor plans (single/multi-floor, conceptual + programmatic test fits)
- 3D virtual tours (theme/finish customizable)
- Photorealistic renders
- **Editable Revit/CAD models**
- **Quantity takeoffs** (material + furniture inventory with costs)
- Comparative data: efficiency, privacy, daylight exposure

**[Confirmed]** Marketed as "optimized with billions of sqft" and validated by in-house architects —
i.e. **AI generation + human architectural QA**, not pure end-to-end automation.

**Takeaway:** qbiq shows the *deliverable bar* (editable CAD + takeoffs + comparative metrics) and that
a **human-in-the-loop QA** step is normal. Their "efficiency / privacy / daylight" metrics are a good
starting menu for the **criteria/objective functions** our agentic loop will optimize.

## Archilogic — floor-plan SDK / engine

Source: <https://developers.archilogic.com/floor-plan-engine/guide>

**[Confirmed]** A commercial **Floor Plan SDK / engine** with a developer API — evidence that a
reusable, embeddable 2D/3D floor-plan engine is a viable building block (buy-vs-build reference point).

## Pascal Editor 3D — free online 3D architecture/floor-plan design

Source: <https://pascaleditor3d.com/> (open-source; React + Three.js + WebGPU per search results)

**[Confirmed]** Free online 3D architecture & floor-plan design tool. Relevant as an OSS reference for
the **3D** side (see `05-open-source-building-blocks.md`).

## Where the gap is (our opportunity)

Reading across all of them, the combination the user wants is **not** offered as one product:

| Capability | Rayon | Materio | Laiout | qbiq | **Our target** |
|---|---|---|---|---|---|
| Precise editable 2D CAD | ✅ | ❌ | partial | partial | ✅ |
| Attach real products/materials per element (product bank) | partial | ✅ | partial | partial (takeoffs) | ✅ |
| AI test-fit generation | partial | ❌ | ✅ | ✅ | ✅ |
| **Agentic, recursive refinement until user criteria met** | ❌ | ❌ | partial (Freeze/Regen) | ❌ | ✅ **(differentiator)** |
| 2D ↔ 3D viewing | partial | ❌ | ✅ | ✅ | ✅ |
| Circulation / "walking place" optimization | ❌ | ❌ | partial | partial | ✅ |
| Per-element "re-imagine" swap from searchable bank | ❌ | ✅ (pins) | ❌ | ❌ | ✅ |

**[Inferred]** The white space is the **union of Rayon's editing + Materio's product binding + Laiout's
generation**, tied together by an **agentic loop** that optimizes for *user-defined* criteria (including
circulation), and a **per-element re-imagine panel** wired to the user's own material bank.

_Confidence note: the ✅/partial marks are judgments from public marketing, not audits of each product._
