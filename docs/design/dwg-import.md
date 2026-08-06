# DWG/DXF import + real CAD furniture

Goal: make DSource load real architectural drawings (like the user's Level-06
furniture plan) and render them with true CAD fidelity — real walls, doors,
glazing, and **actual furniture blocks** (Steelcase chairs, workstation benches,
…) — not gray rectangles. This is what closes the gap to Rayon / Revit / Laiout.

**Code anchors:** DWG→DXF conversion `web/src/import/dwgConvert.ts` + `api/dwg.ts` · DXF parse
`web/src/import/dxf.ts` (`parseDrawing`) · block → editor vocabulary `web/src/import/normalize.ts`
(`normalizeFurniture`, `inferCategory`) · plate + interior walls `web/src/import/testfit.ts`
(`extractPlate`, `extractInteriorWalls`, `plateFromArea`) · wall healing `web/src/import/heal.ts`
(`healWalls`) · area restriction `web/src/import/area.ts` (`restrictDrawing`) · review canvas
`DrawingCanvas` (`web/src/import/DrawingCanvas.ts`) + `web/src/import/DrawingView.tsx` · merge into
the plan `web/src/import/mergeFit.ts` (`baseStampAround`).

## The sample (samples/furniture-plan.dwg)

- Real AutoCAD 2018 DWG, 2.6 MB. Level-06 furniture plan, **units = inches**
  (`$INSUNITS=1`), extent ~1495×1673 in ≈ 124×139 ft.
- Converted to DXF with LibreDWG (`dwg2dxf`, installed via brew) → 15 MB DXF.
- `dxf-parser` (npm) parses it in ~160 ms:
  - **650 LINE** (walls on `I-WALL`/`A-WALL`, details), **637 INSERT** (furniture
    block instances), 11 ARC, 6 LWPOLYLINE, 6 DIMENSION, 54 MTEXT.
  - **378 block definitions** — each INSERT resolves to real geometry (e.g. a
    task-chair block = ~dozens of LINE/ARC).
  - **43 layers** (AIA-style: `A-WALL`, `I-WALL`, `A-GLAZ-CWMG`, `A-DOOR`,
    `I-FURN`, `Q-CASE`, …).
  - Furniture blocks: `Steelcase - Seating - SILQ - Task Chair`,
    `WORKSTATIONS_BENCH- SINGLE - 5 X 2 FT`, `System Panel - Glazed`, `Rectangular
    Mullion`, etc.

## Pipeline

```
.dwg ──dwg2dxf──▶ .dxf ──dxf-parser──▶ raw entities+blocks
   (LibreDWG, server/CLI)                        │
                                    flatten INSERT→block (recursive, transforms)
                                    tessellate ARC/CIRCLE/ELLIPSE
                                    inches→meters (×0.0254)
                                    layer+blockname → Category
                                                     │
                                                     ▼
                                     Drawing (web/src/import/types.ts)
                                                     │
                                       DrawingCanvas render (CAD linework)
                                       + selectable furniture items
```

- **DWG→DXF**: `dwg2dxf` can't run in the browser. Dev: a Vite middleware
  `/api/dwg` that shells out to `dwg2dxf` on upload. The app also accepts a `.dxf`
  directly (skip conversion).
- **Block flatten**: for each INSERT, transform its block's entities by
  (position, rotation, xScale/yScale); recurse for nested INSERTs. Output
  world-space meters.
- **Units**: `$INSUNITS` → scale to meters (1=in→0.0254, 4=mm→0.001, 6=m→1).
- **Category**: map layer prefixes (`A-WALL`/`I-WALL`→wall, `A-GLAZ`→glazing,
  `A-DOOR`→door, `I-FURN`/furniture blocks→furniture, `Q-CASE`→casework, …).

## The `Drawing` contract

See `web/src/import/types.ts` (authoritative). `Drawing { units, bounds, layers,
entities: DrawEntity[], furniture: FurnitureItem[] }`. Meters, Y-up (renderer
flips Y). Non-furniture geometry in `entities`; each block instance is a
`FurnitureItem` (selectable → bind to the material bank later).

## Parallel build (worktrees)

1. **Importer** (`web/src/import/dxf.ts` + `/api/dwg` middleware) — parse,
   flatten, tessellate, unit-convert, categorize → `Drawing`; Node test vs the
   sample.
2. **DrawingCanvas** (`web/src/import/DrawingCanvas.ts`) — CAD renderer for a
   `Drawing`: layer/category colors, lineweights, furniture hit-test/select,
   fit-to-view, pan/zoom.
3. **Furniture symbols** (`web/src/editor/symbols.ts`) — parametric real
   furniture line-symbols (bench, task chair, desk, meeting table, sofa, phone
   booth) so **generated** plans also show real furniture, not rectangles.

Integration (import UI in App + wiring) done on main after the agents land.

## Deferred
- Editing imported geometry (move/delete furniture) — v2.
- Committing imported walls/furniture into the Rust generative document — v2.
- IFC/RVT.
