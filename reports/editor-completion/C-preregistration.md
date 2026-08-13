# Workstream C pre-registration — label render (branch `fix/label-render`)

Committed BEFORE any fix code exists on this branch. Evidence below is from code reading
and from magnifying the committed before-image only; no browser run yet, no edits yet.

## The pre-registered question: is C the rendering-side sibling of B's ink-crossing family?

**Answer: INDEPENDENT — confirmed at the import graph, not just predicted.**

- B's mechanism (recorded, `reports/SHEETS-FINAL.md` D-P): `sheetSet.ts` starts the sheet
  plan's occupancy raster empty and never seeds it with the base raster's ink.
- C's code path is `web/src/editor/paint.ts` — `drawZones` composes the tag strings
  (lines 582, 674) and `drawZoneTags` (line 782) places and draws them. `sheetSet.ts`
  imports nothing from `editor/paint.ts` (checked its import block, lines 12–42), and
  `drawZoneTags`/`ZoneTag` are referenced only by `paint.ts` and `EditorCanvas.ts`.
  No shared occupancy or placement helper exists between the two paths.
- The merge condition ("routes through the same occupancy or placement helper as
  `sheetSet`") is therefore NOT met. C proceeds as its own workstream.

The two families are conceptual cousins — both are "foreign ink contests the label" —
but the mechanisms and the fixes are disjoint: B seeds an occupancy grid; C (hypothesis
below) grounds the label's full extent instead of only its glyph outlines.

## Mechanism hypothesis (pre-fix), with falsifiers

**Fact, byte-verified in source:** both composition sites emit EXACTLY ONE separator —
`` `${fmtArea(area)} m²${cap > 0 ? ` · ${cap} pax` : ''}` `` — hex `20 c2 b7 20`
(space, U+00B7, space). The composer is not emitting "··". Phase 0's reading of the
"··" as "a separator emitted by both the string composer and the renderer" is
**already falsified**: there is one composer per shape branch, each emitting one
separator, and `drawZoneTags` draws `t.metrics` verbatim (one `fillText` per line).

**Hypothesis C-1 (defect 1, the doubled separator):** the second "dot" is not a glyph.
Draw order is zones → furniture → walls → tags-on-top; at rest over furniture the label
gets a knockout halo that is `strokeText` of the same string, `lineWidth` 3
(`planStyle.ts` `labelHalo`). A stroke of a glyph run covers only glyph outlines —
space characters carry no ink, so the ` · ` region leaves an uncovered channel of
roughly (space-width + side bearings − 2×1.5 px). Furniture linework beneath shows
through that channel and reads as a second dot. The magnified before-crop supports
this: the phantom mark is connected to a desk-divider vertical stroke that descends
from above the label into exactly that gap, and it is square-cut, unlike the round
middot beside it.
*Falsifier:* dump the composed `metrics` string from the live tag (dev seam
`window.__ec`) — if it contains two U+00B7 (or any second separator codepoint), C-1 is
wrong and the defect is composer-side after all.

**Hypothesis C-2 (defect 2, the garbled "second string" in the user's screenshot):**
same mechanism, not a distinct overdraw. The name line is drawn at `ay − 6` (10 px) and
the metrics line at `ay + 7.5` (9.5 px); between and around the two glyph runs the halo
leaves uncovered inter-line and inter-glyph channels, and over a dense desk field the
show-through slivers read as a garbled extra string. There are not two strings at one
anchor: one `fillText` per line, and the placement ladder (`hits`) rejects overlapping
tags.
*Falsifier:* if the live tag list contains two tags whose placed boxes overlap at the
label anchor, or two draws of the same metrics string per frame (instrument the
recorder ctx), C-2 is wrong and it IS the D3 two-strings-at-one-anchor family.

**Hypothesis C-3 (the 12 vs 35 px/m LOD question):** there is no zoom-LOD gate on tags
anywhere in `paint.ts` — no `v.scale` threshold touches the tag path. Predicted cause:
`place()` scores candidate anchors over the zone's WHOLE screen-space bbox with no
viewport awareness, so at 35 px/m (zone far larger than the viewport) the winning
anchor is usually off-screen — the label is drawn, just not where you can see it.
Verdict to establish: defect or intentional. Nothing documents it as intentional; if
confirmed, it is a placement defect (this workstream's scope), severity low, and the
fix must not break the no-spill rule ("a tag never borrows the next room's floor").
*Falsifier:* at 35 px/m the tag is absent from the returned tag list entirely (culled,
not off-screen) — then the cause is a rung/fit failure, not viewport-unawareness, and
the analysis restarts from `place()`.

## Pre-registered gates (fail-first)

1. **Composition guard** (expected born-green, kept as regression guard): a zone with
   known {label, area, capacity} composes exactly one U+00B7 between fragments, no
   other separator codepoints, and each line is one glyph run (no wrap: the string
   passed to each `fillText`/`strokeText` call equals the composed line verbatim).
2. **Ground-coverage gate** (the RED one): for an at-rest label overlapping furniture
   (halo engaged), the painted ground must cover the label line's FULL measured extent
   — including spaces and the inter-line band — before the text is filled. Anchored to
   the property (no foreign ink can read inside the label's box), not to a prescribed
   fix. Watched RED on pre-fix code (which grounds only glyph outlines), then green.
   Pixel-level confirmation comes from the browser step by differencing before/after
   captures at the same 12 px/m framing.

## Expected post-fix on-screen result

`434 m² · 101 pax` with exactly one visible separator; no furniture ink readable inside
either label line's box; name line unchanged; no amber anywhere in the label (labels
are canvas content — `pal.line` / `labelSub` / `pillFill` only).
