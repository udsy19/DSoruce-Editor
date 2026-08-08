-- 0002_tenancy — organisations, roles, projects, and per-project grants.
--
-- WHAT THIS CHANGES. Until now one user owned one plan library: `plans.owner =
-- auth.uid()` was the whole authorization model. That cannot express the thing
-- the product is actually sold into — a design studio, several people, several
-- GCC client engagements, and a client contact who must see exactly one project
-- and nothing else. This migration adds that, following the extension path
-- `docs/design/cloud-sync.md` §9 already sketched ("add workspace_id to plans
-- and a memberships table; policies switch from owner = auth.uid() to member of
-- the plan's workspace; owner stays for attribution").
--
-- THE SHAPE, and why there is no separate "workspace" level:
--
--     organisation ──< org_members (role)          the tenant + billing boundary
--          │
--          └──< project ──< project_grants (role)  a client engagement
--                  │                               + per-project external access
--                  └──< plans (floors)             unchanged blob, now scoped
--
-- The design doc says "workspaces"; this uses the organisation as the workspace
-- and puts the second axis on `project_grants` instead. A studio's own staff see
-- everything in the org; a GCC client contact is granted one project. Inserting
-- an extra always-one-per-org level would have been a table nobody reads.
--
-- ROLES are a native Postgres enum, declared in ascending order of privilege, so
-- `role >= 'designer'` is a plain enum comparison — no rank table, no CASE.
-- `reviewer` is not decoration: it maps onto the decision lifecycle the document
-- model already carries (open → in-review → confirmed), so "may move a binding
-- to confirmed but may not edit geometry" becomes expressible.
--
-- RECURSION. A policy on `org_members` that itself queries `org_members` would
-- recurse forever. Every membership lookup therefore goes through a
-- SECURITY DEFINER function, which runs as the owner and is not subject to RLS.
-- Those functions pin `search_path` so a caller cannot shadow `public`.

-- ── roles ────────────────────────────────────────────────────────────────────

do $$ begin
  create type public.org_role as enum ('viewer', 'reviewer', 'designer', 'admin', 'owner');
exception when duplicate_object then null;
end $$;

-- ── organisations + membership ───────────────────────────────────────────────

create table if not exists public.organisations (
  id          uuid        primary key default gen_random_uuid(),
  name        text        not null,
  slug        text        not null unique,
  created_by  uuid        not null default auth.uid() references auth.users(id) on delete set default,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists public.org_members (
  org_id      uuid          not null references public.organisations(id) on delete cascade,
  user_id     uuid          not null references auth.users(id) on delete cascade,
  role        public.org_role not null default 'designer',
  created_at  timestamptz   not null default now(),
  primary key (org_id, user_id)
);
create index if not exists org_members_user_idx on public.org_members (user_id);

-- ── the membership oracle (breaks RLS recursion) ─────────────────────────────

create or replace function public.org_role_of(p_org uuid)
returns public.org_role
language sql stable security definer set search_path = public, pg_temp
as $$
  select m.role from public.org_members m
   where m.org_id = p_org and m.user_id = (select auth.uid())
$$;

-- Creating an organisation must also make the creator its owner, atomically —
-- otherwise the row is orphaned the instant it exists and no policy can rescue
-- it. A trigger keeps that invariant server-side rather than trusting a client
-- to make two calls in the right order.
create or replace function public.tg_org_creator_is_owner()
returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  insert into public.org_members (org_id, user_id, role)
  values (new.id, coalesce(new.created_by, (select auth.uid())), 'owner')
  on conflict (org_id, user_id) do update set role = 'owner';
  return new;
end $$;

drop trigger if exists org_creator_is_owner on public.organisations;
create trigger org_creator_is_owner
  after insert on public.organisations
  for each row execute function public.tg_org_creator_is_owner();

-- Where a plan lands when a client that predates tenancy inserts one. Keeps the
-- old single-user write path working unchanged after this migration.
create or replace function public.default_org_of_current_user()
returns uuid
language sql stable security definer set search_path = public, pg_temp
as $$
  select m.org_id from public.org_members m
   where m.user_id = (select auth.uid())
   order by m.role desc, m.created_at asc
   limit 1
$$;

-- ── projects + per-project grants ────────────────────────────────────────────

create table if not exists public.projects (
  id             uuid        primary key,   -- client-minted, = ProjectRecord.id
  org_id         uuid        not null references public.organisations(id) on delete cascade,
  name           text        not null default 'Untitled project',
  property_name  text        not null default '',
  address        text,
  logo_url       text,                      -- object-store URL, NOT an inlined data: URL
  created_by     uuid        default auth.uid() references auth.users(id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  archived_at    timestamptz
);
create index if not exists projects_org_idx on public.projects (org_id);

create table if not exists public.project_grants (
  project_id  uuid          not null references public.projects(id) on delete cascade,
  user_id     uuid          not null references auth.users(id) on delete cascade,
  role        public.org_role not null default 'viewer',
  created_at  timestamptz   not null default now(),
  primary key (project_id, user_id)
);
create index if not exists project_grants_user_idx on public.project_grants (user_id);

-- Effective role on a project = the better of the org role and any direct grant.
-- GREATEST ignores NULLs, so a pure-grant user (no org membership) and a pure
-- staff user (no grant) both resolve correctly, and neither can be demoted by
-- the absence of the other.
create or replace function public.project_role_of(p_project uuid)
returns public.org_role
language sql stable security definer set search_path = public, pg_temp
as $$
  select greatest(
    (select m.role
       from public.org_members m
       join public.projects p on p.org_id = m.org_id
      where p.id = p_project and m.user_id = (select auth.uid())),
    (select g.role
       from public.project_grants g
      where g.project_id = p_project and g.user_id = (select auth.uid()))
  )
$$;

-- ── plans: scope the existing table ──────────────────────────────────────────

alter table public.plans
  add column if not exists org_id      uuid references public.organisations(id) on delete cascade,
  add column if not exists project_id  uuid references public.projects(id) on delete set null,
  add column if not exists floor_label text,
  add column if not exists floor_index int;

create index if not exists plans_org_idx     on public.plans (org_id);
create index if not exists plans_project_idx on public.plans (project_id);

-- ── audit log (append-only) ──────────────────────────────────────────────────

create table if not exists public.audit_log (
  id            bigserial   primary key,
  org_id        uuid        references public.organisations(id) on delete cascade,
  actor         uuid        references auth.users(id) on delete set null,
  action        text        not null,
  subject_type  text        not null,
  subject_id    text,
  at            timestamptz not null default now(),
  meta          jsonb       not null default '{}'::jsonb
);
create index if not exists audit_log_org_at_idx on public.audit_log (org_id, at desc);

-- ── backfill: every existing owner gets a personal organisation ──────────────
--
-- Runs before the NOT NULL below, so no existing row is stranded. Idempotent:
-- re-running adopts only plans that still have no org.

do $$
declare
  r record;
  new_org uuid;
begin
  for r in select distinct owner from public.plans where org_id is null loop
    select m.org_id into new_org
      from public.org_members m
     where m.user_id = r.owner and m.role = 'owner'
     limit 1;

    if new_org is null then
      insert into public.organisations (name, slug, created_by)
      values ('Personal', 'personal-' || replace(r.owner::text, '-', ''), r.owner)
      returning id into new_org;
      -- The trigger fires as the definer and reads auth.uid(), which is NULL in
      -- a migration. Stamp membership explicitly rather than relying on it.
      insert into public.org_members (org_id, user_id, role)
      values (new_org, r.owner, 'owner')
      on conflict (org_id, user_id) do update set role = 'owner';
    end if;

    update public.plans set org_id = new_org where owner = r.owner and org_id is null;
  end loop;
end $$;

alter table public.plans alter column org_id set not null;
alter table public.plans alter column org_id set default public.default_org_of_current_user();

-- ── RLS ──────────────────────────────────────────────────────────────────────

alter table public.organisations  enable row level security;
alter table public.org_members    enable row level security;
alter table public.projects       enable row level security;
alter table public.project_grants enable row level security;
alter table public.audit_log      enable row level security;

-- organisations: visible to members; only owner/admin may rename; anyone may
-- create one (the trigger makes them its owner); only an owner may delete.
drop policy if exists organisations_select on public.organisations;
create policy organisations_select on public.organisations for select
  using (public.org_role_of(id) is not null);

drop policy if exists organisations_insert on public.organisations;
create policy organisations_insert on public.organisations for insert
  with check ((select auth.uid()) is not null);

drop policy if exists organisations_update on public.organisations;
create policy organisations_update on public.organisations for update
  using (public.org_role_of(id) >= 'admin') with check (public.org_role_of(id) >= 'admin');

drop policy if exists organisations_delete on public.organisations;
create policy organisations_delete on public.organisations for delete
  using (public.org_role_of(id) >= 'owner');

-- org_members: a member sees the roster; admins manage it. Every predicate goes
-- through the SECURITY DEFINER oracle, so none of these re-enter this table.
drop policy if exists org_members_select on public.org_members;
create policy org_members_select on public.org_members for select
  using (public.org_role_of(org_id) is not null);

drop policy if exists org_members_write on public.org_members;
create policy org_members_write on public.org_members for insert
  with check (public.org_role_of(org_id) >= 'admin');

drop policy if exists org_members_update on public.org_members;
create policy org_members_update on public.org_members for update
  using (public.org_role_of(org_id) >= 'admin') with check (public.org_role_of(org_id) >= 'admin');

drop policy if exists org_members_delete on public.org_members;
create policy org_members_delete on public.org_members for delete
  using (public.org_role_of(org_id) >= 'admin');

-- projects: any org member (or granted external) may read; designer+ may write.
drop policy if exists projects_select on public.projects;
create policy projects_select on public.projects for select
  using (public.project_role_of(id) is not null);

drop policy if exists projects_insert on public.projects;
create policy projects_insert on public.projects for insert
  with check (public.org_role_of(org_id) >= 'designer');

drop policy if exists projects_update on public.projects;
create policy projects_update on public.projects for update
  using (public.project_role_of(id) >= 'designer')
  with check (public.project_role_of(id) >= 'designer');

drop policy if exists projects_delete on public.projects;
create policy projects_delete on public.projects for delete
  using (public.org_role_of(org_id) >= 'admin');

-- project_grants: visible to anyone who can see the project; only admin+ grants.
drop policy if exists project_grants_select on public.project_grants;
create policy project_grants_select on public.project_grants for select
  using (public.project_role_of(project_id) is not null);

drop policy if exists project_grants_insert on public.project_grants;
create policy project_grants_insert on public.project_grants for insert
  with check (public.project_role_of(project_id) >= 'admin');

drop policy if exists project_grants_delete on public.project_grants;
create policy project_grants_delete on public.project_grants for delete
  using (public.project_role_of(project_id) >= 'admin');

-- plans: the owner-only policies from 0001 are SUPERSEDED, not supplemented.
-- Postgres ORs multiple permissive policies together, so leaving the old ones in
-- place would mean "org member OR original owner" — and a user removed from an
-- org would keep access to every plan they had personally created. Drop them.
drop policy if exists "plans_select_own" on public.plans;
drop policy if exists "plans_insert_own" on public.plans;
drop policy if exists "plans_update_own" on public.plans;
drop policy if exists "plans_delete_own" on public.plans;

-- A plan is reachable through its project when it has one, else through its org.
-- Keeping both arms means a plan not yet filed under a project stays visible to
-- the org instead of vanishing.
drop policy if exists plans_select on public.plans;
create policy plans_select on public.plans for select
  using (
    case when project_id is not null
      then public.project_role_of(project_id) is not null
      else public.org_role_of(org_id) is not null
    end
  );

drop policy if exists plans_insert on public.plans;
create policy plans_insert on public.plans for insert
  with check (
    public.org_role_of(org_id) >= 'designer'
    and (project_id is null or public.project_role_of(project_id) >= 'designer')
  );

drop policy if exists plans_update on public.plans;
create policy plans_update on public.plans for update
  using (
    case when project_id is not null
      then public.project_role_of(project_id) >= 'designer'
      else public.org_role_of(org_id) >= 'designer'
    end
  )
  with check (
    case when project_id is not null
      then public.project_role_of(project_id) >= 'designer'
      else public.org_role_of(org_id) >= 'designer'
    end
  );

drop policy if exists plans_delete on public.plans;
create policy plans_delete on public.plans for delete
  using (
    case when project_id is not null
      then public.project_role_of(project_id) >= 'designer'
      else public.org_role_of(org_id) >= 'designer'
    end
  );

-- audit_log: readable by admins of the org, written by anyone acting in it, and
-- mutable by nobody. The absence of update/delete policies IS the append-only
-- guarantee — RLS denies by default, so there is nothing to bypass.
drop policy if exists audit_log_select on public.audit_log;
create policy audit_log_select on public.audit_log for select
  using (public.org_role_of(org_id) >= 'admin');

drop policy if exists audit_log_insert on public.audit_log;
create policy audit_log_insert on public.audit_log for insert
  with check (public.org_role_of(org_id) is not null and actor = (select auth.uid()));
