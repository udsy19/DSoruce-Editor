# Materio — Selections, Products & Floor-Plan Mapping

Source of truth: <https://www.materio.co/>

## What it is

**[Confirmed]** Materio is an all-in-one visual workspace for interior design and design-build
professionals. It centralizes project management, **material/product selection**, client communication,
and financial tracking. It is used by 1,500+ design/build professionals.

This is the **specification & product-bank** inspiration: the part of our editor where a user picks a
component in the plan and attaches a *real* product/material to it, tracks the decision, and prices it.

## Feature set (what to learn from)

**[Confirmed] Selections & material management** — the core idea we want
- A decision workflow with states: **open → in-review → confirmed**
- Full approval history (who authorized what, and when)
- Product/material libraries organized by **category** (Electrical, Tile, Countertops, Cabinetry,
  Furniture, …)
- Per-item specification with **cost tracking by item and by location**

**[Confirmed] Visual planning — "Floor Plan Mapping™"** — the mechanic closest to our "re-imagine" flow
- Place **selection markers directly on an uploaded floor plan**
- Turns a flat material list into a **location-based visual schedule** — you can see exactly *where*
  each item belongs in the space
- Multiple plan pages + elevation documentation pages

**[Confirmed] Project organization & money**
- Budget by category, phase, and room
- Cost breakdown by material type and vendor; itemized grand total
- Phase model: Space Planning → Design Development → Procurement/PM
- Purchase orders, invoices, expense tracking
- QuickBooks + MaterioPay integrations

**[Confirmed] Collaboration**
- Contextual comments on plans and products
- Client-visibility controls per comment
- Change notifications + evening digest of action items

## The key mechanic for us: element → selection panel → product bank

Materio's **Floor Plan Mapping** + **selections workflow** is essentially the "re-imagine" interaction
the user described, minus live 2D/3D geometry:

> Click a marker on the plan (a component/location) → see its selection → pick/confirm a real product
> from a categorized, costed library → the choice is tracked, priced, and approved.

Our version upgrades this from *markers on a static plan image* to *selectable live geometry in a 2D/3D
editor*, backed by the user's own **searchable material bank** (already built in a separate repo).

## Takeaways for our editor

1. **Every placed component should carry a "selection" state and a product binding**, not just geometry.
   A chair in the plan is both a shape *and* a spec line (product, vendor, cost, approval status).
2. **Categories drive the side panel.** When a component is selected, the panel should filter the
   material bank by that component's category (chair → seating; ceiling → ceiling systems).
3. **Decisions are first-class objects** with lifecycle (open/in-review/confirmed) and history — this is
   what turns a pretty layout into a real, procurable spec.
4. **Location-aware costing** (by room/zone) is a natural output once components are placed geometry.
5. **Client-facing vs internal views** matter — some data (margins, internal comments) stays private.

## Boundary with our project
- The **material/product bank itself is out of scope** (built in another repo). We consume it via an API
  and treat it as a searchable, categorized catalog. Interface contract TBD — see `08-open-questions.md`.

## Open items to verify
- Whether Floor Plan Mapping supports true vector geometry or only pin markers on an image — **[Inferred]**
  it is pin-on-image, not live CAD geometry, but not explicitly confirmed.
