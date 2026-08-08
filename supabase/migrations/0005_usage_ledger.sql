-- 0005_usage_ledger — per-tenant token accounting and spend caps.
--
-- WHY THIS EXISTS. At scale the model bill is the overwhelming majority of the
-- variable cost, and until now nothing measured it per customer. Without this
-- table you cannot bill for usage, cap a runaway tenant, answer "why did our
-- invoice move", or notice abuse — and none of it can be reconstructed later,
-- because the tokens are gone the moment the response is returned. A usage
-- ledger is the one thing that genuinely cannot be retrofitted.
--
-- SHAPE. Append-only, one row per model call, denormalized enough that a month's
-- spend is a single indexed sum with no joins.
--
-- `cost_nanos` is nanodollars (1e-9 USD) as bigint — integer money, exact
-- addition. `rate_version` records WHICH rate card priced the row so a past
-- month stays reproducible when prices change (Sonnet 5's introductory rate
-- lapses 2026-08-31). Recomputing history from today's prices would silently
-- rewrite what last month cost; see deploy/llmPricing.ts.
--
-- `unpriced` marks a call whose model was not on the rate card. Such a row is
-- recorded with zero cost and flagged rather than dropped or estimated —
-- `select … where unpriced` is how you find a model rolled out without a rate,
-- instead of discovering it as a hole in the revenue.

create table if not exists public.usage_events (
  id            bigserial   primary key,
  org_id        uuid        not null references public.organisations(id) on delete cascade,
  user_id       uuid        not null references auth.users(id) on delete set null,
  route         text        not null,                      -- 'claude' | 'agent'
  model         text        not null,
  input_tokens        int   not null default 0,
  output_tokens       int   not null default 0,
  cache_read_tokens   int   not null default 0,
  cache_write_tokens  int   not null default 0,
  cost_nanos    bigint      not null default 0,
  rate_version  text        not null,
  unpriced      boolean     not null default false,
  at            timestamptz not null default now()
);

-- The predicate every spend query uses. Covering both columns keeps the monthly
-- sum an index-only scan rather than a heap walk over a growing table.
create index if not exists usage_events_org_at_idx on public.usage_events (org_id, at desc);

create table if not exists public.org_budgets (
  org_id            uuid        primary key references public.organisations(id) on delete cascade,
  monthly_cap_nanos bigint,                                -- null = uncapped
  updated_at        timestamptz not null default now()
);

-- ── spend queries ────────────────────────────────────────────────────────────
-- SECURITY DEFINER so the gateway gets a straight answer without needing read
-- access to every row, and so a member cannot see another org's total by
-- probing. Both pin search_path.

create or replace function public.org_spend_this_month(p_org uuid)
returns bigint
language sql stable security definer set search_path = public, pg_temp
as $$
  select coalesce(sum(u.cost_nanos), 0)::bigint
    from public.usage_events u
   where u.org_id = p_org
     and u.at >= date_trunc('month', now())
     -- Callers must be in the org. Without this the function would happily
     -- total up a tenant the caller cannot otherwise see.
     and public.org_role_of(p_org) is not null
$$;

/** Nanodollars still available this calendar month; null when uncapped. */
create or replace function public.org_budget_remaining(p_org uuid)
returns bigint
language sql stable security definer set search_path = public, pg_temp
as $$
  select case
           when b.monthly_cap_nanos is null then null
           else greatest(b.monthly_cap_nanos - public.org_spend_this_month(p_org), 0)
         end
    from public.org_budgets b
   where b.org_id = p_org
     and public.org_role_of(p_org) is not null
$$;

grant execute on function public.org_spend_this_month(uuid) to authenticated;
grant execute on function public.org_budget_remaining(uuid) to authenticated;
-- The column default on plans.org_id calls this; the gateway resolves a tenant
-- with it too. It was never granted, so the grant is explicit rather than
-- inherited by accident.
grant execute on function public.default_org_of_current_user() to authenticated;
grant execute on function public.org_role_of(uuid) to authenticated;
grant execute on function public.project_role_of(uuid) to authenticated;

-- ── RLS ──────────────────────────────────────────────────────────────────────

alter table public.usage_events enable row level security;
alter table public.org_budgets  enable row level security;

-- A member may see their organisation's usage; only admins set the cap.
drop policy if exists usage_events_select on public.usage_events;
create policy usage_events_select on public.usage_events for select
  using (public.org_role_of(org_id) is not null);

-- A caller records only their OWN usage, and only in an org they belong to.
-- Without the `user_id = auth.uid()` arm a member could attribute their spend to
-- a colleague, which is exactly the kind of thing a billing dispute turns on.
drop policy if exists usage_events_insert on public.usage_events;
create policy usage_events_insert on public.usage_events for insert
  with check (
    public.org_role_of(org_id) is not null
    and user_id = (select auth.uid())
  );

-- No update, no delete, by anyone. RLS denies by default, so the ABSENCE of
-- those policies is the append-only guarantee — there is no switch to flip.

drop policy if exists org_budgets_select on public.org_budgets;
create policy org_budgets_select on public.org_budgets for select
  using (public.org_role_of(org_id) is not null);

drop policy if exists org_budgets_write on public.org_budgets;
create policy org_budgets_write on public.org_budgets for insert
  with check (public.org_role_of(org_id) >= 'admin');

drop policy if exists org_budgets_update on public.org_budgets;
create policy org_budgets_update on public.org_budgets for update
  using (public.org_role_of(org_id) >= 'admin')
  with check (public.org_role_of(org_id) >= 'admin');
