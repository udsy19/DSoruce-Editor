# Cloud Plan Sync + Auth + Multi-user — Research & Design

Status: **design accepted; PoC slice built behind a flag (opt-in, off by default).** Scope: sign in,
mirror a user's saved plans to the cloud, share across their own devices, and lay the groundwork for
team sharing + scale. Cloud is **additive and opt-in** — with the flag off, the app is exactly as
before: plans live only in the browser's IndexedDB.

Today plans persist only client-side: `web/src/persist/plans.ts` writes `SavedPlan` records into an
IndexedDB store (`web/src/persist/db.ts`), and a homegrown single-user REST loop
(`web/src/persist/sync.ts` → `/api/plans`, served by `deploy/server.ts:237`) mirrors them to the VPS
with **no auth and no per-user isolation**. This document specifies the auth + multi-user cloud layer.

---

## 0. Ground truth (verified constraints)

1. **`SavedPlan` embeds the entire v1 `.dsource` file verbatim** (`persist/plans.ts:33-60`,
   `persist/file.ts:1-16`). The on-disk format is additive-only, so a plan can round-trip through any
   store — a row, a Storage object, a POST body — with **zero schema change**. The sync bookkeeping
   fields (`syncedAt`, `remoteRev`) are already reserved on `SavedPlan` and are device-local (stripped
   before upload).
2. **Plans are small.** A `SavedPlan` is JSON: the opaque wasm `snapshot`, denormalized metrics, and a
   thumbnail dataURL (~15 KB). Whole records are tens-to-hundreds of KB — comfortably a Postgres row,
   not an object-store blob (§5).
3. **The document of record lives in wasm**, not in the plan store. Cloud sync moves *saved plans*
   (library records), never live co-editing state — that is the separate multiplayer track
   (`docs/design/multiplayer.md`).
4. **The prod deploy is one Node service behind Caddy** (`deploy/server.ts`, CLAUDE.md §Deployment).
   Cloud sync must not require standing up and operating a database ourselves.

---

## 1. Recommendation (one line)

**Adopt Supabase** (hosted Postgres + Auth + Row-Level Security + Realtime + Storage) as the cloud
backend. Store each plan as **one row** with the `SavedPlan` JSON in a `jsonb` column, isolate rows
per-user with an `owner = auth.uid()` RLS policy, authenticate with passwordless email (magic link) or
anonymous sessions, and keep IndexedDB as the offline-first source of truth that syncs last-write-wins.

---

## 2. Why Supabase (vs the alternatives)

The constraint that dominates: **we are a client-heavy (wasm) React SPA and do not want to build or
operate a backend.** We need auth, per-user data isolation, and a queryable store — as a managed
service with a generous free tier, reachable directly from the browser.

| Option | Auth | Per-user isolation | Realtime | Offline story | Ops burden | Fit |
|---|---|---|---|---|---|---|
| **Supabase** | Built-in (magic link, OAuth, anon) | **RLS in Postgres** | Yes | LWW today, CRDT/RxDB later | **Managed, free tier** | **Chosen** |
| Firebase/Firestore | Built-in | Security Rules | Yes | Strong (SDK offline cache) | Managed | NoSQL; no SQL/RLS; less portable; our data is already relational-friendly |
| Roll our own on the existing Node/VPS | Build it | Build it | Build it | Build it | **We operate Postgres + auth** | Rejected — reinvents auth + RLS; the thing we're avoiding |
| PocketBase / Appwrite | Built-in | Rules | Yes | Weaker | **We self-host** | Viable but adds a service to run; Supabase removes that |

Supabase wins because **Row-Level Security lets the database itself enforce "you can only touch your
own plans"** — the isolation lives next to the data, not in app code that can be bypassed
([Supabase RLS docs][rls-docs]). Auth, RLS, Realtime, and Storage are one managed product on a free
tier, so there is **no new server for us to run** — it slots beside the existing Node service rather
than replacing it (§8). The `.dsource` blob is already JSON, and Postgres `jsonb` stores + indexes
it natively ([Managing JSON in Supabase][json-docs]).

---

## 3. Auth

**Passwordless, browser-first.** Two entry points, both via Supabase Auth (GoTrue), implemented in
`web/src/cloud/auth.ts`:

- **Magic link (email OTP)** — the durable identity a user re-opens on any device. `supabase-js`
  persists the session in `localStorage` and auto-refreshes the token, so a signed-in user stays
  signed in across reloads with no work on our side ([Supabase sessions][sessions],
  [passwordless][magic]). Links are one-time-use and expire after 1 hour.
- **Anonymous sign-in** — a zero-friction "just sync this tab" identity that behaves like a permanent
  user and is **upgradable to email later without losing rows** (the user id is preserved)
  ([anonymous sign-ins][anon]). Requires a one-toggle enable in the project's Auth settings (§7).

OAuth (Google/Microsoft) is a drop-in addition later — same `signInWith*` surface, no data-model
change. **Security note:** `getSession()` reads the unverified token from `localStorage` (fine for
gating UI); the server re-verifies the JWT on **every** request under RLS, so trust is never placed in
the client ([token security][token-sec]).

---

## 4. The `SyncProvider` abstraction

Cloud is introduced behind a small storage-backend interface so the local and cloud stores are
interchangeable and reconciling one against the other needs no special-casing
(`web/src/cloud/provider.ts`):

```ts
interface SyncProvider {
  readonly kind: string                 // 'local' | 'supabase'
  ready(): Promise<boolean>             // local: always; cloud: signed in
  list(): Promise<PlanSummary[]>        // {id, name, updatedAt} — no blob hydration
  get(id): Promise<SavedPlan | null>
  put(plan: SavedPlan): Promise<void>   // insert-or-replace by id
  remove(id): Promise<void>
}
```

- **`LocalSyncProvider`** — pure delegation to `persist/plans.ts` (IndexedDB). The default, always
  available, unchanged offline behavior.
- **`SupabaseSyncProvider`** — the same interface over the `plans` table (§5). Reads are re-validated
  through the existing `sanitizeSavedPlan` (`persist/plans.ts:142`), so a corrupt/hostile row is
  skipped exactly like a bad `.dsource` file — **one format contract, no new validator**.

Both speak `SavedPlan`, so a reconcile is just a diff of two `list()`s.

---

## 5. Data model — rows, not Storage objects

Plans are stored **as rows**, one per `SavedPlan`. The whole record (including the embedded `.dsource`
file) goes in a `data jsonb` column; `name` / `updated_at` / `metrics` are **denormalized** so list
views never hydrate a blob. Rows beat Storage objects here because the payloads are small (§0.2), we
want the metrics queryable, and rows get RLS + Realtime for free. Storage is reserved for a **later**
optimization — stripping large thumbnails/attachments to an object and keeping a URL in an additive
field (exactly as `plan-library.md §5` anticipated).

Applied migration (`create_plans_cloud_sync`, live on project `nkjigrogbobtklotupkt`):

```sql
create table public.plans (
  id          uuid        primary key,                 -- = SavedPlan.id (client-minted)
  owner       uuid        not null default auth.uid()  -- stamped server-side
                          references auth.users(id) on delete cascade,
  name        text        not null default 'Untitled',
  updated_at  timestamptz not null default now(),      -- = SavedPlan.updatedAt, the LWW clock
  created_at  timestamptz not null default now(),
  metrics     jsonb       not null default '{}'::jsonb, -- denormalized headline numbers
  data        jsonb       not null,                     -- the whole SavedPlan, verbatim
  synced_at   timestamptz not null default now()        -- server receive time
);

alter table public.plans enable row level security;
create index plans_owner_idx on public.plans (owner);  -- RLS predicate column MUST be indexed
```

**RLS policy sketch — owner-only, all four verbs:**

```sql
create policy "plans_select_own" on public.plans for select
  using ((select auth.uid()) = owner);
create policy "plans_insert_own" on public.plans for insert
  with check ((select auth.uid()) = owner);
create policy "plans_update_own" on public.plans for update
  using ((select auth.uid()) = owner) with check ((select auth.uid()) = owner);
create policy "plans_delete_own" on public.plans for delete
  using ((select auth.uid()) = owner);
```

Two best-practices baked in ([RLS performance][rls-docs], [designrevision][rls-guide]): the RLS
predicate column `owner` is **indexed** (missing indexes are the top RLS performance killer), and
`auth.uid()` is **wrapped in `(select …)`** so Postgres runs it once per statement (initPlan cache)
instead of once per row. `owner` defaults to `auth.uid()` so the client never sends it — the insert
`with check` then guarantees a client cannot forge a row owned by someone else.

**Verified end-to-end** against the live project by impersonating two `authenticated` JWTs in one
transaction: `user1_sees=1`, `owner_defaulted_ok=t`, `user2_sees=0` (isolation holds), and a spoofed
insert of another user's row was **blocked** by the with-check.

---

## 6. Offline-first sync + conflict resolution

**IndexedDB stays the source of truth.** The UI always reads/writes locally and never blocks on the
network; sync is a background reconcile. This is the standard offline-first shape — mutate locally,
converge when connectivity returns ([offline-first with Supabase][offline]).

- **v1 — last-write-wins on `updatedAt`.** Single user across their own devices: push local records
  whose `updatedAt > syncedAt`, pull remote records newer than local, newer timestamp wins. This is
  precisely the loop `persist/sync.ts` already implements for `/api/plans`; pointing that loop at the
  `SupabaseSyncProvider` (instead of raw REST) is the phase-2 step. The `syncedAt` / `remoteRev`
  bookkeeping already on `SavedPlan` makes the loop **idempotent** (re-running with nothing new is a
  no-op) and is stripped before upload so it never travels.
- **Deletes** are v1-simple (no tombstones) — a locally deleted plan can reappear on a later pull, the
  same tradeoff `persist/sync.ts` documents. Tombstones arrive with the team story.
- **Later — versioned / CRDT.** True concurrent merge (two devices editing the *same* plan offline)
  is out of scope for LWW. The upgrade path is a `version` / `rev` column with optimistic concurrency,
  or an RxDB↔Supabase replication layer for document-level CRDT sync
  ([RxDB Supabase replication][rxdb]). This converges with the multiplayer track
  (`docs/design/multiplayer.md`), which handles *live* co-editing; cloud sync handles *saved plans*.

---

## 7. Migrating the existing IndexedDB store

No data migration is required, and nothing is destructive:

1. Existing IndexedDB records already carry stable `id`s and are already valid `SavedPlan`s.
2. On first sign-in with the flag on, **push** the local library to the cloud (`pushAll`) — every
   local plan becomes a row owned by the new user. This is the "adopt my existing work" step.
3. Thereafter the background reconcile (§6) keeps both sides converged. IndexedDB is never emptied;
   the cloud is a mirror, not a replacement.

The PoC exposes this as explicit **"Save all to cloud"** / **"Load from cloud"** buttons so the
behavior is observable before it is automated.

---

## 8. How it fits the current prod deploy

Supabase is reached **directly from the browser** with the publishable (anon) key; RLS makes that
safe. So:

- The existing single Node service (`deploy/server.ts`) is **unchanged** — cloud sync does not proxy
  through it. The homegrown `/api/plans` store stays as-is for the flag-off path and can be retired
  once cloud sync is the default.
- The only deploy delta is **three build-time env vars** (`VITE_CLOUD_SYNC`, `VITE_SUPABASE_URL`,
  `VITE_SUPABASE_ANON_KEY`) baked into the SPA bundle. The anon key is browser-safe (gated by RLS);
  it still lives in env so the repo carries no keys and each environment points at its own project.
- Secrets never enter git: keys go in `web/.env.local` (gitignored via `.env.*`), documented in
  `web/.env.example`.

---

## 9. Path to team sharing + scale

The owner-only model is the floor; sharing is a purely additive extension:

- **Sharing a plan** — a `plan_shares(plan_id, shared_with, role)` table + an extra `select` policy
  `exists (select 1 from plan_shares s where s.plan_id = id and s.shared_with = auth.uid())`. No
  change to the base table or the client blob.
- **Workspaces/teams** — add `workspace_id` to `plans` and a `memberships(workspace_id, user_id, role)`
  table; policies switch from `owner = auth.uid()` to "member of the plan's workspace." `owner` stays
  for attribution.
- **Realtime** — Supabase Realtime can broadcast row changes on `plans` so a teammate's save appears
  live in another's library, a natural precursor to the multiplayer track.
- **Scale** — the `owner`/`workspace_id` indexes keep RLS predicates fast; heavy thumbnails move to
  Storage (§5); PostgREST rate limits + a retention cron keep the store lean ([best practices][rls-guide]).

---

## 10. Phased plan

- **Phase 0 — PoC (this change, behind `VITE_CLOUD_SYNC=1`).** `SyncProvider` abstraction + Local &
  Supabase impls; passwordless auth (`auth.ts`); the `plans` table + RLS live on Supabase; a
  self-contained `CloudSyncPanel` doing cloud **save + load** of plans. Default behavior unchanged.
- **Phase 1 — background reconcile.** Point the existing `persist/sync.ts` LWW loop at
  `SupabaseSyncProvider`; auto-push on save, auto-pull on open; surface sync status in the library.
- **Phase 2 — sharing.** `plan_shares` + share UI; Realtime library updates.
- **Phase 3 — teams + scale.** Workspaces/memberships; Storage offload for thumbnails; retention +
  rate limits; optional CRDT/versioned merge for concurrent edits.

---

## 11. Setup (one command from live)

The Supabase project already exists and the migration is applied — only two steps remain:

1. **Enable an auth provider** in the dashboard (Auth → Providers): turn on **Anonymous sign-ins**
   (and/or configure email so magic links deliver). Anonymous is currently disabled, which is the only
   reason the browser demo can't complete sign-in yet.
2. **Create `web/.env.local`** (gitignored) from the template in `web/.env.example`:

   ```
   VITE_CLOUD_SYNC=1
   VITE_SUPABASE_URL=https://nkjigrogbobtklotupkt.supabase.co
   VITE_SUPABASE_ANON_KEY=sb_publishable_...   # from the project's API settings
   ```

   Then `pnpm dev` → the library panel shows the **Cloud sync (beta)** control.

Project ref: **`nkjigrogbobtklotupkt`** · region `us-east-1` · migration `create_plans_cloud_sync`.

---

## Sources

- [Row Level Security — Supabase Docs][rls-docs]
- [Supabase RLS Guide 2026 — designrevision][rls-guide]
- [Managing JSON and unstructured data — Supabase Docs][json-docs]
- [User sessions — Supabase Docs][sessions]
- [Passwordless email logins — Supabase Docs][magic]
- [Anonymous Sign-Ins — Supabase Docs][anon]
- [Token Security and RLS — Supabase Docs][token-sec]
- [Building Offline-First Apps with Supabase][offline]
- [Supabase Replication Plugin for RxDB][rxdb]

[rls-docs]: https://supabase.com/docs/guides/database/postgres/row-level-security
[rls-guide]: https://designrevision.com/blog/supabase-row-level-security
[json-docs]: https://supabase.com/docs/guides/database/json
[sessions]: https://supabase.com/docs/guides/auth/sessions
[magic]: https://supabase.com/docs/guides/auth/auth-email-passwordless
[anon]: https://supabase.com/docs/guides/auth/auth-anonymous
[token-sec]: https://supabase.com/docs/guides/auth/oauth-server/token-security
[offline]: https://www.devadnani.com/blog/flutter-offline-first-supabase
[rxdb]: https://rxdb.info/replication-supabase.html
