# Plan Library, Scenario Compare & Version History — Design

Status: **design only** (nothing implemented). Builds on `.dsource` persistence
(`web/src/persist/file.ts`), the candidate gallery (`web/src/ui/CandidateGallery.tsx`),
and `Editor.snapshot()/restore()` (`crates/ds-core/src/lib.rs:377-394`, lossless incl.
CAD layer + keepouts).

## 1. Product framing

How comparable products handle this (training knowledge; confidence noted):

- **Laiout** generates several layout options per floor and keeps them as a persistent
  options strip the user flips between; options carry headline metrics (desk count,
  ratios). *Medium confidence* — our `CandidateGallery` already mirrors this, but ours
  is ephemeral React state that dies on reload.
- **qbiq** delivers each test-fit request as a set of named variants in a web portal,
  with a per-variant metrics sheet (workstations, efficiency, NIA) designed for
  side-by-side comparison by brokers/tenants. *Medium confidence on the exact compare
  UI; high that variants + metric sheets are the core deliverable.*
- **Rayon** has Figma-style file version history: automatic checkpoints plus named
  versions, restore-from-any-point, and "duplicate file" as the branch primitive.
  *Low-medium confidence on specifics; the Figma model it borrows from is well known.*

What our user needs (and what today's code loses):
1. **Park a candidate** — `GenResult.candidates` (`EditorCanvas.ts:127-133`) evaporates
   when React state resets; picking one clobbers the doc. Need "keep this one, named."
2. **Come back** — Save/Open (`App.tsx:153,163`) round-trips one file via download/
   file-picker; no in-browser library of past plans.
3. **Compare two** — the AI consequence card diffs *before→after of one edit*
   (`ai/engine.ts:71-85`); nothing diffs *two saved plans*.
4. **Restore any point** — `snapshot()/restore()` exists but there is no automatic
   trail; an unfortunate `generate()` (which clears components) is unrecoverable.

## 2. Storage architecture (v1, no server)

**IndexedDB, hand-rolled wrapper.** `idb-keyval` is tiny (~600 B) but the repo is
deliberately dependency-lean (`web/package.json` — 6 runtime deps, all load-bearing),
and we want two object stores + an index, which is beyond keyval anyway. A ~70-line
promisified wrapper (`openDB`, `get`, `put`, `del`, `getAll`) covers everything.
`localStorage` is rejected: synchronous, ~5 MB cap, string-only.

DB `dsource` v1, two object stores:

```ts
// store "plans", keyPath "id"
interface SavedPlan {
  id: string          // crypto.randomUUID()
  name: string        // user-given ("Option B — dense", default "Plan {date}")
  createdAt: string   // ISO
  updatedAt: string
  thumb: string       // dataURL from renderThumb (§3)
  metrics: PlanMetricsSummary   // denormalized for list/compare without wasm
  file: DSourceFile   // THE ENTIRE v1 on-disk format, verbatim (file.ts:30-43)
}
interface PlanMetricsSummary { // from ec.getMetrics() + ec.circulation()
  workstations: number; netInternalArea: number; efficiencyPct: number
  indicativeCost: number; circulationScore: number | null // null when wall_count === 0
  minCorridorM: number | null
}

// store "history", keyPath "at" — the autosave ring
interface HistoryEntry {
  at: number          // Date.now(), also the key → naturally ordered
  snapshot: string    // ec.snapshot()
  program: Program
  reason: 'edit' | 'generate' | 'restore'  // for list labels
}
```

Embedding `DSourceFile` verbatim is the load-bearing decision: `parseProject`
(`file.ts:85`) validates library records on read exactly as it validates opened files,
"export plan to .dsource" is a field copy, and cloud sync (§5) posts the same JSON.

**Autosave policy** (from `ec.onChange`, `EditorCanvas.ts:221`): debounce 5 s after the
last mutation, hard cap one entry per 30 s, skip if `snapshot === last.snapshot`
(string equality — cheap). Ring capped at **30 entries**: on insert, delete oldest
beyond 30. `onChange` fires only on mutations (`commit()`/`sync()`/`applyCandidate`),
never on pan/zoom, so this is quiet. History entries deliberately exclude `drawing`
and `thumb` (see budget); the DXF drawing changes only on import, not per edit.

**Budget math.** A serialized `Component` (`model.rs:57-73`: id, category, x/y/w/h,
rotation, label, product_id, price_inr, decision) is ~150–190 B of JSON — generator
coordinates are short decimals but `rotation` prints a full f64. Real doc: 70
components ≈ **13 KB**; a traced plate of 20–40 wall segments (`model.rs:32`, 2 points
+ thickness) ≈ **3–4 KB**; ~10 zones ≈ 1.5 KB; keepouts + `cad_json` drafting ≈ 1–3 KB.
**Snapshot ≈ 20 KB** typical, 50 KB worst case (200 desks). Thumbnail: 200×140 PNG of
flat rects compresses to **5–15 KB** as a dataURL. So `SavedPlan` ≈ **35–55 KB** *unless*
`file.drawing` is present — an imported DXF's entity JSON can be 0.5–5 MB, which is why
it lives once per SavedPlan and never in history. History ring: 30 × ~20 KB ≈ **600 KB**.
100 saved plans ≈ 4–10 MB. Chrome/Firefox grant hundreds of MB–GBs per origin; Safari
~1 GB. No quota concern; still surface `navigator.storage.estimate()` in the library
footer and call `navigator.storage.persist()` once.

## 3. Scenario compare UX

**Scope:** exactly 2 items, each either a `SavedPlan` or a live `Candidate` — both
reduce to `{snapshot, program, name}`.

**Rendering.** Reuse `renderThumb(st: DocState, w, h)` (`EditorCanvas.ts:920`) at
480×336 for compare panes. It is currently **module-private — must be exported**
(export change #1). To get a `DocState` from a stored snapshot without touching the
live editor, use the scratch-clone pattern from `ai/engine.ts:73`:
`Editor.from_snapshot(snap)` → `.state()` → `renderThumb` → `.free()`.

**Metric diff.** Same rows as the AI consequence card, same code: `delta()`
(`engine.ts:91-105`) builds `{label, before, after, dir, valence}` and `MetricDelta`
is already public in `ai/contract.ts`. `delta` is **module-private — must be
exported** (export change #2). New pure module `web/src/plans/compare.ts`:

```ts
export interface PlanComparison { a: PlanSide; b: PlanSide; deltas: MetricDelta[] }
export interface PlanSide { name: string; thumb: string; metrics: PlanMetricsSummary }
export function comparePlans(a: {snapshot: string; name: string},
                             b: {snapshot: string; name: string}): PlanComparison
```
Rows: Workstations · Min corridor · Area/workstation · Efficiency · NIA · Fit-out
cost · Carbon — identical to `buildDiff` (`engine.ts:115-141`); `valence` colors "B
relative to A". Circulation row only when both sides have walls (degenerate-at-0-walls
gotcha, `CLAUDE.md`).

**Where it lives: a full-screen modal**, not a right-panel tab. Two 480-px plan panes
plus a diff table cannot read in the 280-px inspector, and compare is a focused,
transient activity. Reuse the existing scrim/dialog pattern (`ShortcutsOverlay`,
`App.tsx:833-869`; `.help-scrim` in `styles.css:1623`). Entry points: a "Compare"
button in the Library panel (enabled when 2 plans are check-selected) and a long-press/
secondary action on gallery cards. Each pane gets an "Open this plan" button →
`applyProject`-style load, closing the modal.

## 4. Version history UX

**Recommendation: simple reverse-chronological list**, not a Figma-style timeline
strip. A 30-entry ring buffer has too little data for a scrubber to earn its
complexity; a list with time-ago + reason + workstation count is scannable and ships
in one component. Lives as a collapsible "History" section at the bottom of the
Library panel (§6) — history is per-session-document, so it belongs next to plans,
not in a separate mode.

- **Row:** `14:32 · edit · 68 ws` (IBM Plex Mono for numerics, per convention).
  Hover → render the entry's thumb lazily via scratch clone (never stored).
- **Restore:** `applyProject`-shaped (`file.ts:161-164`): `ec.restore(e.snapshot);
  ec.program = {...DEFAULT_PROGRAM, ...e.program}`. Before restoring, autosave the
  current state with `reason: 'restore'` so restore itself is undoable.
- **"Branch from here" = restore + keep working.** No tree. The ring stays linear;
  post-restore edits append normally and eventually evict the abandoned tip. The
  durable branch primitive is **"Save to library"** — parking a named `SavedPlan` is
  how a timeline point outlives the ring. The UI copy should say exactly this
  ("Restoring rewinds; save to library first to keep the current state forever").

## 5. Cloud-later path

Because `SavedPlan.file` **is** a v1 `DSourceFile` (additive-only contract,
`file.ts:1-16`), sync requires zero schema change:

- `POST /api/plans` (the endpoint sketched for the material-bank VPS) with the
  `SavedPlan` record as-is; server adds ownership/tenancy server-side.
- Client adds **additive** sync fields later — `remoteRev?: string`,
  `syncedAt?: string` — which v1 readers ignore, same rule as the file format.
- Sync loop: push local `updatedAt > syncedAt`, pull remote list, last-write-wins on
  `updatedAt` (single-user; real merge waits for multiplayer). Thumbnails travel as
  dataURLs initially (~15 KB each is fine); server may later strip to object storage
  and return a URL in another additive field.
- The `history` store never syncs — it is device-local scratch, like Figma's
  unsaved-changes buffer.

## 6. Implementation plan

New modules (all under `web/src/`):

| File | Public API |
|---|---|
| `persist/db.ts` | `openDB(): Promise<IDBDatabase>` (private), `dbGet/dbPut/dbDel/dbGetAll<T>(store, ...)` |
| `persist/plans.ts` | `SavedPlan`, `PlanMetricsSummary`, `buildSavedPlan(ec, name, opts:{drawing?, ui?, snapshot?}): SavedPlan`, `listPlans()`, `putPlan(p)`, `deletePlan(id)`, `loadPlan(ec, p)` (delegates to `applyProject`) |
| `persist/history.ts` | `HistoryEntry`, `noteChange(ec, reason)` (debounce+dedupe+ring), `listHistory()`, `restoreEntry(ec, e)` |
| `plans/compare.ts` | `comparePlans(a, b): PlanComparison` (pure over snapshots; wasm scratch clones) |
| `ui/LibraryPanel.tsx` | `<LibraryPanel ec plans onLoad onCompare onDelete onRename />` + History section |
| `ui/CompareView.tsx` | `<CompareView cmp onOpenSide onClose />` (scrim modal) |

Touch points in existing code — **every export change flagged**:

1. `editor/EditorCanvas.ts:920` — `renderThumb`: add `export` (⚠ export change; keep
   signature — `three/Scene3D` contract untouched).
2. `ai/engine.ts:91` — `delta`: add `export` (⚠ export change) so `plans/compare.ts`
   reuses the diff row builder instead of forking it (no-bloat rule).
3. `persist/file.ts:129-143` — extract pure `buildProjectFile(opts): DSourceFile` from
   `saveProject`; `saveProject` becomes build+download (⚠ new export; `plans.ts`
   reuses it so the library and ⌘S can never drift).
4. `App.tsx:130` — the single `ec.onChange` assignment becomes
   `ec.onChange = () => { setTick(t => t + 1); noteChange(ec, 'edit') }` (no interface
   change; `onChange` stays a single nullable callback, `EditorCanvas.ts:221`).
5. `App.tsx:508-531` — inspector `<aside>` gains a two-tab header (`Plan` | `Library`);
   `LibraryPanel` renders in the second tab. Compare modal mounts beside
   `ShortcutsOverlay`.
6. `ui/CandidateGallery.tsx:12` — add optional `onSave?: (c: Candidate) => void`;
   cards grow a small "Save" affordance → `putPlan(buildSavedPlan(ec, name,
   {snapshot: c.snap as string}))`. Additive prop, existing callers unaffected.

Milestones — each independently shippable:

1. **M1 — Library core.** `db.ts` + `plans.ts` + `LibraryPanel` list (name, thumb,
   metrics, load/delete/rename) + "Save to library" button next to Save
   (`App.tsx:328`). Requires touch points 3, 5. *Ships: park + come back.*
2. **M2 — Park a candidate.** Touch point 6 + `renderThumb` export for a proper thumb
   at save time. *Ships: gallery options survive reload.*
3. **M3 — Version history.** `history.ts` + touch point 4 + History section with
   restore. *Ships: recover from any bad generate/edit.*
4. **M4 — Compare.** `plans/compare.ts` + `CompareView` + `delta` export (touch
   point 2), checkbox-select in Library. *Ships: side-by-side with metric diff.*
5. **M5 — Sync-ready.** `navigator.storage` telemetry in the Library footer, plan
   export-to-`.dsource` from a library row, and a `sync.ts` stub gated behind the
   material-bank API becoming real (`research/08-open-questions.md`).

Testing: `db.ts` is the only DOM-bound piece; `buildSavedPlan` payload shaping,
ring-buffer eviction/dedupe, and `comparePlans` row math are pure and unit-testable in
Node, same doctrine as `parseProject` (`file.ts:14-16`).
