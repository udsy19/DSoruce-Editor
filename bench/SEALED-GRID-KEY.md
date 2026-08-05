# Sealed grid — KEY

**Do not read this before looking at `bench/sealed-grid/panel-*.png`.** The
panels are the artifact; this file is what they mean. Keeping it separate is the
whole mechanism — a caption under each image would unblind the comparison at a
glance.

## Method

- **Fixed camera.** Both DSource panels are the default framing from "Open in
  editor" on the same 930.1 m² plate, alternative A, at 13 px/m. No manual pan
  or zoom, so before and after differ ONLY in rendering.
- **Same crop**, excluding rulers and the presentation toggle, so the panels
  show drawings rather than UI.
- **Fixed-seed order.** Letters come from `SHA256(seed | name)`; the seed is in
  `sealed-grid/ORDER.txt`. I did not choose which drawing got which letter.
- **No identifying marks** were added to any panel.

## What the blinding does and does not achieve — stated, not implied

It is real for the pair that matters: the two DSource panels are mutually
blinded, same plate, same camera, same crop, differing only in the campaign's
changes. Which of them is "after" is not recoverable from the images without
this file.

It is NOT real for the reference. `qbiq-reference` is a different building on a
different plate and is obviously a different artifact — no letter assignment
hides that. Claiming a blind three-way comparison would be false. The reference
panel is there as a BAR to judge against, not as a hidden option.

## Key

| panel | is |
|---|---|
| **A** | qbiq-reference |
| **B** | ours-after |
| **C** | ours-before |

## The claim being tested

That the "after" panel reads as an architectural drawing where "before" read as
a UI: corridors unfilled so program zones are figure and circulation is ground,
a weight hierarchy (room enclosure > wall > furniture) instead of near-uniform
line-work, text on the drawing instead of a pill per room, and two-face walls
with a hatched core.

`qbiq-reference` is the measured PARITY BENCHMARK, not the styling target. The
target grammar is composed — Rayon wall form, Laiout palette — so the after
panel is NOT expected to match it hue for hue. It answers whether we meet its
bar as a drawing.
