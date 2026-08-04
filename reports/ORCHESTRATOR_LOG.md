# Orchestrator log — qbiq output parity

Mission: make DSource emit a deliverable pack at parity with qbiq's output
(12-sheet formula-wired QTO workbook · per-room renders · walkthrough mp4 · web 3D viewer).
Gate definitions live in `scripts/gates/`; only `scripts/gates/run-all.sh` output is trusted.

## Cycle 0 — setup (orchestrator)

### Environment resolved
| Tool | Status |
| --- | --- |
| ffmpeg / ffprobe | `/opt/homebrew/bin` — OK |
| python3 + openpyxl 3.1.2 + PIL | OK |
| node / pnpm / cargo / wasm-pack | OK |
| **soffice** | **was MISSING** → installed LibreOffice 26.2.5.2 at `/Applications/LibreOffice.app/Contents/MacOS/soffice`. Not on PATH — gate scripts must resolve PATH *then* that absolute path. Unblocks G2 (recalc), G9 (round-trip), Judge rasterization. |

### Deviations from the mission brief (documented, not silent)
1. **Reference path.** Brief says `reference/qbiq/`. The repo already had `docs/reference/qbiq/`
   containing the reference workbook + Revit HTMLs. Per no-bloat, we extend the existing tree
   instead of creating a second one. All spec/media land under `docs/reference/qbiq/{spec,media}/`.
2. **Reference artifacts were not in the repo**, only the workbook + Revit HTML. The video and the
   four renders were sourced from `~/Downloads/Modern - Formal/` and staged into
   `docs/reference/qbiq/media/`. Large binaries are gitignored (146 MB mp4, 4×~9 MB PNGs).
3. The user supplied `qbiq-workbook-spec.json`; it is staged as
   `docs/reference/qbiq/spec/workbook-spec.provided.json` and treated as a **hint only** —
   Agent A regenerates the spec from the actual xlsx and diffs against it.

### Repo facts that shape the briefs (orchestrator survey)
- `web/src/export/takeoff.ts` (605 ln) is a **deliberately consolidated 4-sheet** takeoff; its header
  comment explains it collapsed qbiq's 12 sheets on purpose. This mission reverses that decision —
  Agent B extends this file's model (`buildTakeoffModel`), it does not fork it.
- **Gap: the core has no wall-type enum.** `crates/ds-core/src/model.rs` `Wall` carries only
  `thickness`, `generated`, `glazing`. The qbiq legend needs seven types (Drywall, Half Drywall,
  Glass, Core, Perimeter windows, Perimeter wall, Door_length). Classification must be added in the
  core and derived from: `glazing` → Glass · `KeepOut` → Core · plate-boundary adjacency → Perimeter
  wall/windows · generated interior → Drywall · `Component{category:"Door"}` → Door_length.
- **Materials already exist**: `finishSchedule.ts` `FINISH_SPEC` (16 room types × floor/base/wall/
  ceiling, India-market, deterministic) with `finishTypeFor(zone)` at :228. This is the single source
  for Inventory's Floor/Ceiling Material, the General catalog, and Agent D's palette mapping.
- Doors are `Component`s with `category: "Door"`; zones carry `ZoneType` (7 variants) + `ZoneShape`
  (`Rect`/`RectRing`/`Poly`).
- ROADMAP tick-offs belong under **Track C — Qbiq-grade deliverables** (`docs/ROADMAP.md:279`).

### Decision: xlsx writer — extend the hand-rolled OOXML writer, exceljs as sanctioned fallback
The brief nominates **exceljs**. The repo instead hand-writes every exporter's byte stream on
purpose (`zip.ts:3` — "rather than pulling a heavy dependency"), and `takeoff.ts:523`
`takeoffToXlsx` already emits xlsx that Excel/LibreOffice/openpyxl all read, via `sheetXml` +
`zipStore`. The parity workbook adds images (33+), data validations, ~1000 formulas, styling,
col widths and merges — a real jump in OOXML surface, but each piece is small and well-specified
(`xl/media/*` + `xl/drawings/*` + rels; `<dataValidations>`; `<f>` inside `<c>`).

Extending wins on no-bloat and avoids a ~1 MB browser bundle in an app whose export path must stay
**client-side, one user action** (a Python/openpyxl step would force a server round-trip and is
therefore rejected outright for the in-app path).

**Tripwire (anti-stall, decided up front):** hand-rolled OOXML risks G9 repair warnings, where
exceljs is battle-tested. If G9 fails **twice** on the hand-rolled writer, Agent B switches to
exceljs immediately rather than retrying harder.

### Baseline (verified before any change)
- `cargo test -p ds-core` → **131 passed, 0 failed** (CLAUDE.md's "50 tests" is stale; fix on tick-off).
- `pnpm typecheck` → blocked, `node_modules` missing → `pnpm install` run.

### Gate scoreboard
All gates red — no gate scripts exist yet (Agent A is authoring them). Baseline pending.

| Gate | Owner | Status |
| --- | --- | --- |
| G1 sheet structure | B | ⬜ not yet runnable |
| G2 formula liveness | B | ⬜ |
| G3 quantity truth | B (+core) | ⬜ |
| G4 plan graphic | C | ⬜ |
| G5 thumbnails | C | ⬜ |
| G6 renders | D | ⬜ |
| G7 video | E | ⬜ |
| G8 web viewer | F | ⬜ |
| G9 round-trip | B | ⬜ |
| G10 one-action UX | orchestrator | ⬜ |

### Dispatched
- **Agent A — Reference Auditor**: DONE (`reports/A-1.md`).

---

## Cycle 1 — Agent A verified, rulings issued

Orchestrator re-ran `bash scripts/gates/run-all.sh` on an empty `out/`: **0/10 passing**, every gate
failing with an actionable artifact-missing message and no crashes. Gate suite accepted as the contract.
Playwright + chromium installed (unblocks G8/G10).

### Artifact contract (every agent writes to these exact paths)
`out/quantity-takeoff.xlsx` · `out/plan.png` + `out/plan.repeat.png` (independent re-render, same seed —
this is how G4 tests determinism) · `out/ground-truth.json` (schema:
`docs/reference/qbiq/spec/ground-truth.schema.json`, required `rooms`/`walls`/`doors`/`planLabels`) ·
`out/renders/` · `out/walkthrough.mp4` · `out/share.json` `{"planId","url"}` · `out/cases/<case>/` for G9.

### Rulings on the four brief-vs-reference contradictions
1. **Core colour → `#A0A0A0` (Agent A's choice CONFIRMED).** The reference contradicts itself: legend
   chip `#D5BDD6`, plan lines `#A0A0A0` (the chip hex appears zero times in the PNG). The brief says
   "core/structure filled dark gray", and G4's actual requirement is *legend == renderer, no drift* —
   which unifying satisfies. Reference bug, not ours to copy.
2. **Title card → KEEP.** qbiq brands in-scene only, but §4 and G7 both explicitly require a 1.5 s
   title card. Explicit requirement beats reference behaviour; deliberate divergence from qbiq.
3. **sqf factor → `10.764` exactly.** The brief self-conflicts ("×10.764" stated twice, vs "match
   qbiq's conversion exactly" — qbiq actually uses 10.76; true value 10.7639). Taking the brief's
   literal, twice-stated number. Gate default set to 10.764, `--sqf-factor` retained.
4. **Circulation % → normalise against the PLATE, not the canvas (Agent A CONFIRMED).** G4's own
   wording is ">2% of *plate* area"; 71% of the reference canvas is transparent padding. Plate-relative
   (12.86% on the reference) is the correct denominator.

### Approach change: Agent B split into three (anti-stall, applied pre-emptively)
Agent A found `takeoff.ts`'s writer emits only `inlineStr`/numeric cells — it has **no `<f>` formulas,
no drawing layer, no `showGridLines`, no col/row sizing, no merges, no validations, 2 colourless fills**.
That is seven writer capabilities *before any sheet content*, on top of a Rust wall-classification gap.
Too much for one agent, so B is split into independently-testable units:
- **B1** — Rust quantity surface + wall-type classification (core truth; no TS).
- **B2** — the seven OOXML writer capabilities (verifiable against a synthetic workbook alone).
- **B3** — the 12 sheets + formula wiring (needs B1 + B2), dispatched after they land.
B1, B2 and C are mutually independent → dispatched in parallel now.
</content>
