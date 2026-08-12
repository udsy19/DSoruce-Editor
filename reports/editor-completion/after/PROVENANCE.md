# Workstream C after-images — provenance

Captured 2026-08-12 against the DEV build on **http://localhost:5303** (this worktree,
branch `fix/label-render`), headless Playwright (chromium, 1440×900, dpr 2) driven by a
node script — never the shared MCP browser tools.

**Build identity, asserted before every capture:** the page is `location.reload()`ed
unconditionally, then the served `src/editor/paint.ts` is fetched in-page and the run
aborts unless it contains `LABEL_GROUND_RADIUS` — a constant that exists only in this
change. `scripts/verify-preflight.sh 5303 LABEL_GROUND_RADIUS src/editor/paint.ts` also
passed (listener pid cwd = this worktree).

**Reproduction path (the user's exact path):** wizard → new project →
`samples/furniture-plan.dwg` (converted by the local `dwg2dxf`), boundary confirmed →
Program defaults → Generate → candidate A ("Open") → Open in editor.

**Determinism against the fixture** (`scripts/fixtures/zone-dump.furniture-plan.json`),
read from `window.__ec.ed` (dev seam): 53 zones / 268 components / 186 walls; zone 680
"Open Workspace (1)" area 433.64 m², capacity 101 — surface-for-surface match.

## What each image shows

- `after-12pxm-full.png` — full canvas at 12 px/m centred on zone 680. The tag reads
  `OPEN WORKSPACE (1)` / `434 m² · 101 pax` on a continuous knockout ground — ONE
  separator, no desk show-through.
- `after-label-crop.png` — 1200×390 device-px crop centred on the metrics line (same
  size class as `../before/label-garble-crop.png`, same 12 px/m, same dpr).
- `after-35pxm-centred.png` — 35 px/m centred on the zone: label in-viewport.
- `after-35pxm-northend.png` — 35 px/m centred on the zone's north end (19, 5). BEFORE
  the viewport-aware placement this framing drew the label at y=862 in an 818 px
  viewport (drawn, off-screen — the Phase 0 "no label at 35 px/m" observation,
  reproduced and measured via instrumented `fillText`). AFTER: label at y=520,
  in-viewport, on clear floor (bare text — halo correctly off).

## The separator measurement (one instrument, both artifacts)

Connected dark-ink components (luminance < 150, 8-connected, ≥3 px) in the separator
band between the area fragment and the pax fragment, each crop measured in its own
frame:

| artifact | components | detail |
|---|---|---|
| `before/label-garble-crop.png` (deployed, pre-fix) | **2** | middot x570-575 (28 px) + a 19×9 px blob x585-603 sitting under the desk vertical that descends from above — furniture ink, not a glyph |
| `after/after-label-crop.png` (this build) | **1** | the middot, x597-598 |

The phantom "second separator" was never composed (source composes exactly one U+00B7,
byte-verified) and is gone from the delivered pixels.

Label anchor at 12 px/m is unchanged by the viewport term: (532, 553) css before and
after adding it — the resting full-plate drawing is untouched by that part of the change
(claim scoped to this capture's framing).
