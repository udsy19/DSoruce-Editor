# DSource Redesign — Implementation Plan

**Status:** authoritative build order · 2026-07-07 · owner: tech lead
**Reconciles:** `laiout-visual-system.md`, `ai-backbone-architecture.md`,
`rooms-zones-model.md`, `consequence-reasoning.md` into one dependency-ordered,
conflict-checked sequence an engineer executes top-to-bottom.

The through-line: **Zones are the shared foundation.** Both the Laiout pastel
rendering *and* the AI room-ops ("merge two rooms") need a first-class,
addressable region primitive. So Zones land first (data), then the visual pivot
renders them, then the AI operates on them, then consequence-preview reasons
about them. Every Rust slice ends with `make wasm`.

---

## 0. Cross-cutting rules (apply to every slice)

- **`make wasm` after ANY Rust change** — else the frontend keeps stale bindings
  (`CLAUDE.md`). Rust-touching slices: 1, 2, 6, 8.
- **Exported `EditorCanvas.ts` types are append-only.** `three/Scene3D.tsx`
  imports `DocState/DocComponent/Metrics/Program/LayoutScore/CirculationScore/
  GenResult`. Never change their existing shape — only **add** fields (`zones` on
  `DocState`) and **add** new exports (`DocZone`, `ZoneType`, `ZoneShape`,
  `PreviewDiff`, `Consequence`, `Action`).
- **Core is the source of truth.** Document/metric/cost logic lives in Rust; TS is
  a caller. The AI layer is a *caller* of `Editor`, never a second model.
- **`seed` is a JS `bigint`** in `generate` (`BigInt(n)`).
- **`circulation()` is degenerate with 0 walls** — guard every consequence rule
  and stat that reads it (`walls.is_empty()` → report `n/a`, not `0`).
- **Don't break existing features:** generate / freeze (`keep_confirmed`) /
  circulation / re-imagine / decision lifecycle / 2D↔3D must keep working after
  each slice. `cargo test -p ds-core` (11 tests) stays green.

---

## 1. RESOLVED CONFLICTS (decide once, here — the four docs disagree)

These are real contradictions between the design docs. The plan **picks one** so
the engineer never has to.

1. **ZoneType vocabulary.** `rooms-zones-model.md` defines the enum
   `Circulation | Workspace | Meeting | Collaboration | Core | ClosedOffice |
   Amenity` (7, serde string tags). `ai-backbone-architecture.md`'s
   `set_zone_type` / `merge_rooms` schemas use a *different* set
   (`OpenDesk`, no `Amenity`). **Decision: the `rooms-zones` enum is canonical.**
   The AI tool `enum`s in `tools.ts`/`contract.ts` MUST be edited to exactly match
   the Rust serde tags (`Workspace`, not `OpenDesk`; include `Amenity`). One
   vocabulary, spoken identically by Rust, the renderer, the donut, and Claude.

2. **Two dry-run mechanisms.** `ai-backbone` proposes a **TS scratch-clone** via
   `snapshot()/from_snapshot()`; `consequence-reasoning` proposes a **Rust
   `preview_action(action, program)`**. **Decision: split responsibilities —**
   - `preview_action` (Rust) is the **authoritative consequence diff** (metrics,
     cost, carbon, R1–R10 rules). It is the single place metric logic lives
     (`CLAUDE.md`: core is truth; `no-bloat`: don't reimplement metrics in TS).
   - `snapshot()/restore()` (Rust) is the **undo primitive** and the optimistic
     live-preview backer.
   - In the no-backend MVP (Slice 7) `tools.ts.dryRun` may do a quick TS
     scratch-clone for an *instant* card; once Slice 8 lands, `dryRun` **delegates
     to `preview_action`** and the TS metric math is deleted (no-bloat).

3. **`Action::MergeRooms` shape.** `consequence-reasoning` sketches
   `MergeRooms { wall_ids }` (delete shared walls). The zones model does merge via
   `merge_zones(a, b)` (zone ids). **Decision: `Action::MergeRooms { zone_a,
   zone_b, result_type?, target_headcount? }`** delegating to
   `Document::merge_zones` (which dissolves the shared partition wall internally).
   Zone ids are the AI's referents, not wall ids.

4. **Palette hex drift.** `laiout-visual-system.md` (`--zone-circ #DCEBFB`) and
   `rooms-zones-model.md` (`#DCE8F5`) differ by a few points. **Decision:
   `styles.css` `:root` tokens from `laiout-visual-system.md §1` are the single
   source of truth.** `EditorCanvas.ts`'s `ZONE`/`C` maps and the 3D materials
   mirror those exact hexes (ideally read via `getComputedStyle`).

5. **Snapshot needs `Deserialize`.** `Document.next_id` is `#[serde(skip)]` and the
   model structs derive `Serialize` only. `snapshot/restore/from_snapshot` require
   a lossless round-trip **including `next_id`** (else restored ids collide).
   **Decision: add `Deserialize` to `Document`, `Wall`, `Component`,
   `DecisionState`, `Zone`, `ZoneType`, `ZoneShape`, and serialize `next_id`**
   (drop the `skip`, or snapshot a dedicated `DocSnapshot` struct that carries it).

---

## 2. Build sequence (dependency-ordered, demoable slices)

### Slice 1 — Zone core model + generator tiling (Rust) · FOUNDATION
The single most important change: first-class rooms.
- **Create** `crates/ds-core/src/zone.rs`: `Zone { id, zone_type, shape, label,
  component_ids, group }`; `ZoneType` (7-variant serde-string enum);
  `ZoneShape::{ Rect, RectRing }` (`#[serde(tag="kind")]`); `ZoneError`;
  derived `ZoneShape::{area,bbox,contains}`, `Zone::{area,capacity}`. std+serde
  only (no wasm/rand). Derive `Serialize + Deserialize`.
- **Modify** `document.rs`: add `pub zones: Vec<Zone>`; add
  `reassign_components()` (point-in-zone by component center); derive
  `Deserialize`; make `next_id` serializable (see Conflict §5).
- **Modify** `layout.rs::generate()`: clear `doc.zones` like `doc.components`;
  emit the tiling from the rects it already computes — perimeter `Circulation`
  `RectRing` (hole = work zone), one `Meeting` `Rect` per room, one `Workspace`
  `Rect` (absorbs the aisle, v1), leftover→`Core`; call `reassign_components()`.
- **Modify** `lib.rs`: `zones` flows through `state()` for free (Document is
  serialized). No new wasm method yet.
- **Modify** `mod.rs`/`lib.rs`: `mod zone;`.
- **wasm methods added:** none (rides `state()`).
- **make wasm.**
- **Test (one line):** `cargo test -p ds-core` — new test asserts zone areas sum
  ≈ wall-bbox area with no overlap. Playwright: after a generate,
  `await page.evaluate(() => window.__ec.state().zones.length) > 0`.

### Slice 2 — Zone stats + extended metrics + cost/carbon (Rust)
Feeds the Statistics panel; cost/carbon shared later with the consequence engine.
- **Create** `crates/ds-core/src/cost.rs`: per-`ZoneType` `$ /m²` + `kgCO2e/m²`
  rate table + per-workstation allowance; `indicative_cost(doc)` /
  `indicative_carbon(doc)` (pure, tunable constants, "indicative" label owned by
  UI). This module is reused verbatim by Slice 8 — do not duplicate it there.
- **Modify** `lib.rs`: add `zone_stats() -> [{ id, zone_type, label, area,
  capacity, seated, pct_of_nia }]`; extend `metrics()` (additive) with
  `gross_external_area` (=`floor_area()`), `net_internal_area` (Σ zone areas),
  `workstations` (Desk count), `area_per_workstation`, `efficiency_pct`
  (programmed zones / NIA), `indicative_cost`, `indicative_carbon`.
- **wasm methods added:** `zone_stats()`; `metrics()` extended (same name).
- **make wasm.**
- **Test:** `cargo test` — `zone_stats` `pct_of_nia` sums to ~100. Playwright:
  `window.__ec.metrics().efficiency_pct` is a number after generate.
- *(Slices 1+2 may land in one `make wasm` cycle; kept separate for review clarity.)*

### Slice 3 — Light-theme visual pivot (CSS + fonts) · no Rust
The Laiout look, chrome only — no zone rendering yet.
- **Modify** `web/src/styles.css`: replace the entire dark `:root{}` with the
  `laiout-visual-system.md §1` token block; remap `--shell/--panel/--line` →
  `--app-bg/--surface/--hairline`; `body{background:var(--app-bg)}`; delete
  `--font-mono` + `.mono`, add `.num` (tabular figures); re-skin `.rail-tip`
  (light) and the `.seg.on` mode toggle (light segmented, not accent-filled).
- **Modify** `web/src/main.tsx` + `web/package.json`: remove `@fontsource/
  ibm-plex-mono` + `@fontsource/space-grotesk`; add `@fontsource/hanken-grotesk`
  (400/500/600/700) + `@fontsource/schibsted-grotesk` (500/700). *Verify both
  packages exist on install; Hanken-only is the documented fallback.*
- **Modify** `web/src/editor/EditorCanvas.ts`: swap the `const C` palette +
  `DECISION_DOT` to the light "floor-plate" values (`laiout-visual-system.md §4.2`).
  **Touches only the private `C`/`DECISION_DOT` consts — no exported type changes.**
- **Modify** `web/src/editor/catalog.ts`: recolor to pastel zone fills
  (Desk→workspace, MeetingRoom→meeting, Table→collab, Chair→furniture-line,
  FallCeiling→core) so 2D/3D/donut stay in sync.
- **wasm methods added:** none.
- **Test:** Playwright: `getComputedStyle(document.documentElement)
  .getPropertyValue('--accent').trim() === '#2D5BD6'`; screenshot is light.

### Slice 4 — Zone rendering on canvas + 3D floor tints (TS) · no Rust
Now the plate turns pastel — the visual signature.
- **Modify** `EditorCanvas.ts`: **append** exports `ZoneType`, `ZoneShape`,
  `DocZone`, and add `zones?: DocZone[]` to `DocState` (additive — Scene3D safe).
  Add the `ZONE` fill/line map. In `drawBackground`/render: paint `--canvas-mat`
  outside footprint, white plate inside, then **zone fills first** (Rect fill;
  RectRing via even-odd outer+reversed-inner path), 1px zone-line inset, zone
  label in the line color; **then** walls (interior `--wall` / exterior
  `--wall-ext`), **then** furniture as thin line-icons, **then** labels. Exact
  Laiout stack.
- **Modify** `web/src/three/Viewer3D.ts` + `Scene3D.tsx`: tint 3D floor plates
  from the same `ZONE` fills; neutral studio background.
- **wasm methods added:** none.
- **Test:** Playwright screenshot after generate shows pastel regions; assert
  `state().zones.length` regions rendered (pixel spot-check on a known zone center).

### Slice 5 — Statistics panel + donut + Export dropdown (React) · no Rust
The right-hand Laiout panel.
- **Create** `web/src/ui/StatsPanel.tsx` (+ a small `Donut.tsx` or inline SVG):
  tabs `Statistics | Regulations`; metric rows from extended `metrics()` (GEA,
  NIA, Workstations, Area/Workstation, Efficiency %, Carbon, Cost); metric chips
  (blue/coral/green/teal); sub-tabs `Areas | Zones | CO2 | Costs`; donut =
  group-by `zone_type` over `zone_stats()` (slices sum to 100% by tiling), legend
  = colored square + label + % + m², all tabular figures. Colors = the `ZONE`
  table (donut == plate by construction).
- **Modify** `App.tsx`: mount `StatsPanel` in the inspector; add the top-right
  **Export dropdown** (`Export CSV` wired now; PDF/DWG/DXF/IFC/OBJ/RVT/Share are
  stubbed menu items — see Deferrable).
- **wasm methods added:** none.
- **Test:** Playwright: donut legend percentages sum to ~100; the Efficiency %
  row renders a number.

### Slice 6 — AI core additions: edit primitives + zone ops + snapshot (Rust)
Unblocks the whole AI tool set.
- **Modify** `document.rs`: `merge_zones(a,b)->Result<u32,ZoneError>` (edge-adjacent
  rect union; larger-area type wins; components untouched, ids concatenated;
  non-adjacent → shared `group`; dissolves shared partition wall),
  `split_zone(id,axis,at)`, `set_zone_type(id,t)`, `resize_zone(id,shape)`
  (bbox-validated) — each calls `reassign_components()`.
- **Modify** `lib.rs`: add `move_component(id,x,y)`, `delete_component(id)`
  (by-id variants of the existing selection-only `move_selected`/`delete_selected`
  — keep those), `snapshot()->JsValue`, `restore(snap)`, `from_snapshot(snap)->
  Editor`, and the zone-op wrappers `merge_zones/split_zone/set_zone_type/
  resize_zone/zone_at`. `set_zone_type` does NOT collide with `set_decision`.
- **wasm methods added:** `move_component`, `delete_component`, `snapshot`,
  `restore`, `from_snapshot`, `merge_zones`, `split_zone`, `set_zone_type`,
  `resize_zone`, `zone_at`.
- **make wasm.**
- **Test:** `cargo test` — merge of two adjacent rects yields one covering rect;
  split partitions components by center; snapshot→mutate→restore is identity.
  Playwright: `window.__ec.merge_zones(a,b)` reduces `zones.length` by 1.

### Slice 7 — AI tool layer + agent panel + local intent parser (TS) · NO BACKEND
The #1 priority UX, demoable today with no API key.
- **Create** `web/src/ai/contract.ts` (`Tool[]`, `ToolCall`, `ToolResult`,
  `ConsequenceDiff`, `DriverEvent`, `AgentDriver`; ZoneType enum matches Rust —
  Conflict §1); `tools.ts` (frozen, ordered registry: schema + client `execute`
  + `dryRun` + class `read|stage|mutate|destructive` + `autoApply`, bound to
  `window.__ec`); `agent.ts` (conversation state machine INTENT→CLARIFY→PLAN→
  PREVIEW→EXECUTE→SUMMARISE, supervision policy, **undo stack via
  snapshot/restore**, batch approval, `AgentDriver` seam); `intentParser.ts`
  (`LocalDriver`: merge rooms / add N desks / set headcount→regenerate / widen
  corridor, each emitting the same `ToolCall`s Claude would); `AgentPanel.tsx`
  (chat, clarify chips, streaming text, `ConsequenceCard`,
  Approve/Reject/Edit/Undo).
- **Modify** `App.tsx`: mount `AgentPanel`; wire the round `+` FAB to open it.
- **Supervision (enforced in `agent.ts`, not the model):** `destructive` never
  hits `liveEd` before an explicit approve; any dry-run regulation warning forces
  the gate; one Undo reverts a whole batch.
- **wasm methods added:** none (consumes Slice 6).
- **Test:** Playwright: type "fit 30 people" → preview card → Approve →
  `state().components` desk count rises; Undo restores prior snapshot.

### Slice 8 — Consequence-preview engine (Rust) + PreviewCard (TS)
Ground-truth "if you do X then Y" reasoning.
- **Create** `crates/ds-core/src/consequence.rs` (or fold into `lib.rs`):
  `Action` enum (`AddComponent/MoveComponent/DeleteComponent/AddWall/DeleteWall/
  Generate/MergeRooms{zone_a,zone_b,…}` — Conflict §3); one pure
  `apply(doc,&action)`; `MetricSnapshot` + `MetricDiff`; the R1–R10 consequence
  rules (thresholds already in `circulation.rs`/`layout.rs`); `area_per_person`.
  **Reuse `cost.rs` from Slice 2** for the cost/carbon deltas — do not re-add.
- **Modify** `lib.rs`: `preview_action(action,program)->PreviewDiff` (clone→apply→
  diff, live doc untouched) and `apply_action(action)->state()` (same `apply` on
  `&mut self.doc` — one code path); add `delete_wall` if `DeleteWall` needs it.
- **Modify** `EditorCanvas.ts`: **append** `PreviewDiff`/`Consequence`/`Action`
  types + a `preview(action)` wrapper. **Create** `web/src/ai/PreviewCard.tsx`
  (before→after rows, arrow=change / color=valence, top 1–3 consequences,
  Discard/Apply, live-recompute for parametric slider actions).
- **Modify** `web/src/ai/tools.ts`: `dryRun` now **delegates to `preview_action`**;
  delete the interim TS metric math (Conflict §2, no-bloat).
- **wasm methods added:** `preview_action`, `apply_action`, (`delete_wall`).
- **make wasm.**
- **Test:** `cargo test` — R1 (egress breach) fires when a merge removes a wall
  and narrows the corridor below 1.12 m. Playwright: merge preview card shows the
  `min corridor 1.30→0.86 ▼ RED` row.

### Slice 9 — ClaudeDriver + backend proxy (TS + minimal server)
Swap the local brain for Claude behind the identical interface.
- **Create** `web/shared/agentContract.ts` (`TOOLS`, `SYSTEM`, `phaseParams`) —
  extracted so client and proxy share one frozen tool list;
  `web/src/ai/claudeDriver.ts` (`ClaudeDriver`: `fetch('/api/agent')`, parse SSE,
  accumulate `tool_use` blocks); `web/api/agent.ts` (Anthropic streaming relay,
  model allowlist `claude-opus-4-8`/`claude-sonnet-5`/`claude-haiku-4-5-20251001`,
  `docDigest` as trailing system message, prompt caching on system+tools).
- **Modify** `web/vite.config.ts`: `server.middlewares.use('/api/agent', …)` for
  dev; **modify** `web/package.json`: add `@anthropic-ai/sdk`.
- **Modify** `web/src/ai/agent.ts`: driver toggle (`LocalDriver` default,
  `ClaudeDriver` behind a flag) — **one-line swap**, the state machine/UI/undo are
  driver-agnostic.
- **Env:** `ANTHROPIC_API_KEY` server-side only — never reaches the browser.
- **wasm methods added:** none.
- **Test:** with a key set, Playwright: "merge these two rooms" streams a clarify
  question then a preview; with no key, `LocalDriver` still works (fallback).

---

## 3. Risk / conflict register (flagged, with mitigations)

| Risk | Mitigation |
|---|---|
| Break `Scene3D` by changing exported types | All type changes are **append-only**; `zones?` is optional on `DocState`. Run `pnpm typecheck` after Slices 4 & 8. |
| Stale bindings after Rust edits | `make wasm` gate on Slices 1, 2, 6, 8. `web/src/wasm/` is gitignored — fresh clones must build. |
| Live-Claude blocked on backend + API key | **LocalDriver (Slice 7) ships the full UX with no backend.** Claude is a one-line driver swap (Slice 9). The demo never depends on the key. |
| Snapshot id collisions on restore | Add `Deserialize` + serialize `next_id` (Conflict §5). Unit-test snapshot→restore identity in Slice 6. |
| Two dry-run code paths diverging | `preview_action` is the sole metric authority; `tools.ts.dryRun` delegates to it after Slice 8; interim TS math deleted (Conflict §2). |
| ZoneType vocabulary mismatch Rust↔AI | Canonical enum fixed in Conflict §1; `tools.ts` enums must byte-match serde tags — assert in a unit test. |
| Regressing generate/freeze/circulation | `keep_confirmed` untouched (zones regenerate wholesale, confirmed components keep ids); `circulation()` 0-wall guard preserved; existing 11 Rust tests stay green each slice. |
| Palette drift across docs | `styles.css` tokens are the single source; canvas + 3D mirror them (Conflict §4). |

---

## 4. Core vs deferrable

**Core to this redesign (Slices 1–9, in order):** Zones model + tiling; zone
stats/metrics/cost; light theme + fonts; zone rendering (2D+3D); Statistics panel
+ donut + Export-CSV; AI core additions (by-id edits, zone ops, snapshot);
AI tool layer + agent panel + local parser; consequence preview engine +
PreviewCard; ClaudeDriver + proxy.

**Genuinely deferrable (do NOT block the redesign):**
- **Scenario compare / plan library / version history** — nice once single-plan
  editing is solid; no dependency inbound.
- **AI photorealistic render** — orthogonal to the geometry/AI backbone.
- **DWG/DXF/PDF/IFC/OBJ/RVT import & export** — Export dropdown ships with **CSV
  wired and the rest as stubbed menu items** (Slice 5); real converters later.
- **Real material-bank API** — `materialBank/mock.ts` stays; `assign_product`
  already works against the mock.
- **Multiplayer / CRDT**, **Rust/WebGL renderer**, **polygon/L-shaped zones**
  (use `group`), **aisle-as-its-own-Circulation-zone (v2)**, **3D zone
  extrusion**, **prod Hono proxy + per-workspace model + telemetry** (Slice 9
  ships the dev Vite middleware; prod hardening is later).

---

## Appendix — new wasm method inventory (by slice)

- Slice 1: *(none — `zones` rides `state()`)*
- Slice 2: `zone_stats()`; `metrics()` extended
- Slice 6: `move_component`, `delete_component`, `snapshot`, `restore`,
  `from_snapshot`, `merge_zones`, `split_zone`, `set_zone_type`, `resize_zone`,
  `zone_at`
- Slice 8: `preview_action`, `apply_action`, `delete_wall`
