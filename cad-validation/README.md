# `cad-validation/` — CAD import validation against 24 real-world DWG files

Current progress: **[`STATUS.md`](STATUS.md)**. Original findings:
[`findings/00-SUMMARY.md`](findings/00-SUMMARY.md), then
[`SOLUTIONS.md`](SOLUTIONS.md) for the fix plan (designed, **not yet implemented**).

**Headline: 2 of 24 files complete an end-to-end test-fit. 13 fail without telling the user.**
The repo's own control fixture passes cleanly through the identical harness, so the pipeline works —
its tolerance for CAD it did not curate does not.

## Layout

```
findings/
  00-SUMMARY.md            scoreboard, ranked root causes, full per-file matrix
  F1 … F10                 one document per root cause: defect, evidence, reproduction
  screens/                 browser evidence captured through the real wizard
harness/
  run.mjs                  per-stage pass/fail, category census, plate provenance
  units.mjs                DXF header facts + true source-unit extents, from the bytes
  scaleAnchor.mjs          scale ground truth from door-swing radii (independent of $INSUNITS)
  cluster.mjs              what keepDominantCluster discards
  e2e.mjs                  plate → Rust core → generate() → circulation/score
  corpus.json              the file manifest
  probe/                   instrumented COPY of dxf.ts (the shipped file is untouched)
reports/                   raw JSON output — one per file, plus _matrix/_e2e/_units/_scaleAnchor/_cluster
raw/                       .dwg files extracted from the supplied .zip archives
```

## Running it

```bash
cd web && pnpm install          # once
node cad-validation/harness/run.mjs
node cad-validation/harness/units.mjs
node cad-validation/harness/scaleAnchor.mjs
node cad-validation/harness/cluster.mjs
node cad-validation/harness/e2e.mjs
```

Requires `dwg2dxf` (LibreDWG) on PATH — the same binary `/api/dwg` shells out to — and a built
`web/src/wasm`. The harnesses bundle the real `web/src/import/*.ts` modules for Node via esbuild,
so they exercise production code, not a reimplementation.

## Nothing under `web/`, `crates/`, `api/` or `deploy/` was modified

This directory is additive. The only copy of application code is
`harness/probe/dxfProbe.ts` — a deliberately instrumented duplicate of `web/src/import/dxf.ts` used
to measure the cluster filter, clearly marked as such and never imported by the app.

## Measurement discipline

Per `.claude/rules/gate-independence.md`, no number here is read from the importer's own account of
what it did. Scale is judged against door-swing arc radii (code-mandated 0.65–1.30 m) read at raw
scale; plate area is recomputed by shoelace from the ring; coverage is recomputed by point-in-polygon;
desk placement is read from core state after `generate()`. Where a reported value and the
independently derived one agree, that is stated — several of these numbers are honestly computed and
still describe the wrong thing.
