# Phase 0 before-images — provenance

Captured 2026-08-12 against the DEPLOYED build at https://app.46.202.179.28.sslip.io/.

**Build identity:** the served entry asset was read from the live page
(`fetch('/', {cache:'no-store'})`) and matched `assets/main-DEPMJlEX.js` — the exact asset the
deploy log shows was built from merged main (`5d54713`, df10cfa included) minutes before capture.

**Reproduction path (the user's exact path):** wizard → Property → Space
(`samples/furniture-plan.dwg`, md5 `6cd4c04ef8cc1aeb7be4a010256f0ed3`, boundary confirmed) →
Program (defaults: 93 people, 25% enclosed) → Generate → candidate A ("Open") → Open in editor.

**Determinism against the fixture** (`scripts/fixtures/zone-dump.furniture-plan.json`): the
deployed run reproduced 930.1 m² gross / 906 m² NIA / 268 items / 103 pax / 13 offices / 1 conf /
efficiency 61% — matching the fixture's totals surface-for-surface. Per-zone document state could
NOT be dumped on the deployed build: the `window.__ec` seam is DEV-only by design
(`EditorCanvas.ts:287`); per-zone re-verification happens on a dev server at the same commit
(Workstream A/D).

## What each image shows

- `full-plate.png` — 12 px/m overview. The wing (western strip + lower-left of the L) renders as
  plain white ground, unhatched. Reproduced on current code: NOT stale pixels.
- `wing.png` — same zoom after re-centering; the label and wing in one frame.
- `label-garble-crop.png` — device-pixel crop: `434 m²··101 pax` — the doubled separator between
  the area and pax fragments. Reproduced on current code.
- `desks-topleft-crop.png` — the workspace's top-left corner: desks/chairs measure as contained
  at this zoom. Workstream E's stale-pixel prediction is consistent so far; the gate-level answer
  comes from document polygons, not pixels.

**Open observation for Workstream A:** no Unassigned hatch/dashed outline is visible anywhere on
the plate, although `paint.ts` draws both for `zone_type === 'Unassigned'` and the fold
(`published_zone_type`) does not touch `state()`. Either the residuals reach the renderer typed
otherwise, or the hatch style is absent/too faint at this zoom. A resolves this from the dev-side
document dump before touching any classifier code.
