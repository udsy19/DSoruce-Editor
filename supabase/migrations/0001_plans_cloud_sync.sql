-- 0001_plans_cloud_sync — the owner-only plan store.
--
-- PROVENANCE: this is the schema `docs/design/cloud-sync.md` §5 records as
-- already applied (migration `create_plans_cloud_sync`). Until now it existed
-- ONLY as a fenced code block inside a markdown document, applied by hand to a
-- project the repo cannot reach — so there was no reproducible way to stand the
-- database up from source. Transcribing it here makes the schema code.
--
-- Written IDEMPOTENTLY (`if not exists` / `drop policy if exists`) precisely so
-- it is a safe no-op against a database where it is already live. Applying it
-- to the existing project should change nothing; applying it to an empty one
-- reproduces the current state exactly.
--
-- ⚠️  DO NOT RE-APPLY THIS AFTER 0002. Idempotent means "safe to run twice at
-- this point in history", not "safe to run at any later point". 0002 drops the
-- four owner-only policies below because it supersedes them; Postgres ORs
-- permissive policies together, so recreating them afterwards silently restores
-- access for anyone whose org membership has since been revoked — they would
-- keep every plan they had personally created. supabase/tests/rls.sql asserts
-- this (REVOKED-MEMBER) and went red the one time the harness did it.

create table if not exists public.plans (
  id          uuid        primary key,                  -- = SavedPlan.id (client-minted)
  owner       uuid        not null default auth.uid()   -- stamped server-side
                          references auth.users(id) on delete cascade,
  name        text        not null default 'Untitled',
  updated_at  timestamptz not null default now(),       -- = SavedPlan.updatedAt, the LWW clock
  created_at  timestamptz not null default now(),
  metrics     jsonb       not null default '{}'::jsonb, -- denormalized headline numbers
  data        jsonb       not null,                     -- the whole SavedPlan, verbatim
  synced_at   timestamptz not null default now()        -- server receive time
);

alter table public.plans enable row level security;

-- The RLS predicate column MUST be indexed — a missing index here is the single
-- most common cause of slow RLS.
create index if not exists plans_owner_idx on public.plans (owner);

-- `auth.uid()` is wrapped in `(select …)` so Postgres evaluates it once per
-- statement via the initPlan cache rather than once per row.
drop policy if exists "plans_select_own" on public.plans;
create policy "plans_select_own" on public.plans for select
  using ((select auth.uid()) = owner);

drop policy if exists "plans_insert_own" on public.plans;
create policy "plans_insert_own" on public.plans for insert
  with check ((select auth.uid()) = owner);

drop policy if exists "plans_update_own" on public.plans;
create policy "plans_update_own" on public.plans for update
  using ((select auth.uid()) = owner) with check ((select auth.uid()) = owner);

drop policy if exists "plans_delete_own" on public.plans;
create policy "plans_delete_own" on public.plans for delete
  using ((select auth.uid()) = owner);
