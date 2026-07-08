# Multi-Floor / Multi-Plan Projects — Design (Milestone 1)

Status: **decided + M1 implemented**. Builds directly on the plan library
(`docs/design/plan-library.md`, `web/src/persist/{plans,db,file,history}.ts`).

## Decision

**A project is a library-level grouping; each floor is an ordinary `SavedPlan`.**
Three additive, optional fields on `SavedPlan` (`persist/plans.ts`):

```ts
projectId?: string                          // groups sibling floors
projectName?: string                        // denormalized onto every floor record
floor?: { label: string; index: number }    // "L2", ordinal within the project
```

- **No `.dsource` format change.** A `.dsource` file stays exactly one floor;
  `SavedPlan.file` remains a v1 `DSourceFile` verbatim. A future "export project"
  is a zip of per-floor `.dsource` files — still zero format change.
- **The session stays single-floor.** Switching floors = `openSavedPlan` of a
  sibling record; the library already restores full sessions losslessly
  (snapshot + program + drawing + bindings + ui), so a floor switch is exactly
  the open-a-saved-plan path — no new restore semantics to get wrong.
- Grouping is *derived*, never stored: `listProjects()` folds `listPlans()` by
  `projectId` (records without one form a trailing pseudo-group). There is no
  "projects" object store to keep consistent — a project exists iff a plan
  references it, deleting the last floor deletes the project, and old records
  keep working with zero migration.

## Rejected alternative: `floors: DSourceFile[]` inside the file/record

- **Bloats every save**: one floor's edit rewrites N floors' snapshots (and a
  single imported DXF drawing is 0.5–5 MB — per §2 budget math, multiplying it
  is the one thing the library design explicitly avoids).
- **Breaks the verbatim equivalence** that everything downstream leans on:
  `SavedPlan.file` *is* what ⌘S writes, `parseProject` validates library records
  exactly like opened files, and "export to .dsource" is a field copy. A floors
  array forks the format into "file shape" vs "library shape".
- **Complicates history & compare for no gain**: the autosave ring
  (`history.ts`) snapshots *the live document* — which is per-floor anyway —
  and compare (`plans/compare.ts`) diffs two snapshots. Both already do the
  right thing when floors are plain `SavedPlan`s.
- A session-level multi-floor document (core-owned floors) is real future work
  (stacked 3D, inter-floor circulation) but is a core/model change, not a
  persistence change — nothing in this milestone forecloses it.

## Consequences

- **Compare across floors already works**: check L1 of Tower A and L3 of
  Tower B — `comparePlans` takes two `SavedPlan`s and never asks about projects.
- **Autosave history stays per-session** (device-local scratch, unsynced,
  unaware of projects) — correct, since a session is one floor.
- **Cloud sync unaffected**: `/api/plans` stores `SavedPlan` records verbatim;
  the new keys ride along like any additive field (`remoteRev` precedent, §5).
- `projectName` is denormalized per record; renaming a project (later
  milestone) = rewrite of its floor records. Acceptable at library scale, and
  it keeps every record self-describing for sync.

## API (persist/plans.ts) & wiring

- `listProjects(): Promise<ProjectGroup[]>` — groups ordered by most recently
  updated floor; floors sorted by `floor.index`; pseudo-group (`projectId: ''`)
  last. Pure fold `groupPlans(plans)` exported for the panel + tests.
- `resolveProject(name)` — case-insensitive match against existing
  `projectName`s (returns the canonical existing id+name) or mints a new
  `projectId`. Lives here, not in the panel: the panel stays presentational
  and hands the host `onAssign(planId, projectName, floorLabel)`.
- `assignToProject(planId, projectId, projectName, floor)` — `putPlan` wrapper;
  bumps `updatedAt`; when `floor.index` is omitted it keeps the plan's existing
  index (re-label within the same project) or appends `max+1`.
- `buildSavedPlan(ec, name, { …, project? })` — save straight into a project.
- Nothing may assume the fields exist: every reader treats them as optional
  (old records are the compatibility test fixture, not an afterthought).
