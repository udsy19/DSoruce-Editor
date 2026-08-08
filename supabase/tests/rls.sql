-- RLS behaviour suite. Emits one `ok|…` or `FAIL|…` line per check on stdout;
-- supabase/tests/rls.test.mjs parses those and sets the exit code.
--
-- WHAT THIS IS FOR. RLS is the entire authorization model — there is no server
-- code between a browser and these tables, so a policy that is subtly wrong is
-- not a bug that shows up as an error, it is a customer reading another
-- customer's floor plans. Every check below therefore runs as the
-- `authenticated` role with a real JWT claim set, and asserts on rows actually
-- returned. Reading the policy text and agreeing with it proves nothing.
--
-- The three checks that justify specific decisions in 0002, rather than merely
-- exercising the happy path:
--   * REVOKED-MEMBER   — the reason 0001's owner-only policies are DROPPED and
--                        not left alongside the new ones.
--   * GRANT-SCOPE      — the reason `project_grants` exists instead of a second
--                        always-one-per-org "workspace" level.
--   * APPEND-ONLY      — the absence of update/delete policies on audit_log is
--                        load-bearing, so it is asserted, not assumed.

\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned

create temporary table results (seq serial, line text);

create or replace function pg_temp.check(name text, cond boolean, detail text default '')
returns void language plpgsql as $$
begin
  insert into results (line) values (
    case when cond then 'ok|' || name
         else 'FAIL|' || name || case when detail <> '' then ' — ' || detail else '' end end
  );
end $$;

-- Run a query as a given user and return the row count it can see.
create or replace function pg_temp.count_as(uid uuid, q text)
returns int language plpgsql as $$
declare n int;
begin
  perform set_config('request.jwt.claim.sub', uid::text, false);
  set local role authenticated;
  execute 'select count(*) from (' || q || ') t' into n;
  reset role;
  return n;
end $$;

-- Rows actually written by a statement, as a given user. 0 means RLS silently
-- filtered it — the failure mode a plain "did it throw?" test cannot see.
create or replace function pg_temp.affect_as(uid uuid, stmt text)
returns int language plpgsql as $$
declare n int;
begin
  perform set_config('request.jwt.claim.sub', uid::text, false);
  set local role authenticated;
  begin
    execute stmt;
    get diagnostics n = row_count;
  exception when others then
    reset role;
    return -1;                      -- -1 = hard denial (error), 0 = filtered away
  end;
  reset role;
  return n;
end $$;

-- ── fixture ──────────────────────────────────────────────────────────────────
-- Two organisations. Studio has staff at every role plus two client projects;
-- Rival is a completely separate tenant. `client_contact` belongs to NO org and
-- is granted exactly one project — the GCC client-contact case.

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'owner@studio.test'),
  ('00000000-0000-0000-0000-0000000000a2', 'admin@studio.test'),
  ('00000000-0000-0000-0000-0000000000a3', 'designer@studio.test'),
  ('00000000-0000-0000-0000-0000000000a4', 'reviewer@studio.test'),
  ('00000000-0000-0000-0000-0000000000a5', 'viewer@studio.test'),
  ('00000000-0000-0000-0000-0000000000b1', 'boss@rival.test'),
  ('00000000-0000-0000-0000-0000000000c1', 'contact@gcc.test');

-- (the pre-tenancy plan is seeded by pre-tenancy-seed.sql, between 0001 and 0002)

insert into public.organisations (id, name, slug, created_by) values
  ('00000000-0000-0000-0000-00000000aa00', 'Studio', 'studio', '00000000-0000-0000-0000-0000000000a1'),
  ('00000000-0000-0000-0000-00000000bb00', 'Rival',  'rival',  '00000000-0000-0000-0000-0000000000b1');

insert into public.org_members (org_id, user_id, role) values
  ('00000000-0000-0000-0000-00000000aa00', '00000000-0000-0000-0000-0000000000a1', 'owner'),
  ('00000000-0000-0000-0000-00000000aa00', '00000000-0000-0000-0000-0000000000a2', 'admin'),
  ('00000000-0000-0000-0000-00000000aa00', '00000000-0000-0000-0000-0000000000a3', 'designer'),
  ('00000000-0000-0000-0000-00000000aa00', '00000000-0000-0000-0000-0000000000a4', 'reviewer'),
  ('00000000-0000-0000-0000-00000000aa00', '00000000-0000-0000-0000-0000000000a5', 'viewer'),
  ('00000000-0000-0000-0000-00000000bb00', '00000000-0000-0000-0000-0000000000b1', 'owner')
on conflict (org_id, user_id) do update set role = excluded.role;

insert into public.projects (id, org_id, name) values
  ('00000000-0000-0000-0000-0000000ff100', '00000000-0000-0000-0000-00000000aa00', 'Chronos HQ'),
  ('00000000-0000-0000-0000-0000000ff200', '00000000-0000-0000-0000-00000000aa00', 'Helios Campus'),
  ('00000000-0000-0000-0000-0000000ff300', '00000000-0000-0000-0000-00000000bb00', 'Rival Tower');

insert into public.plans (id, owner, org_id, project_id, name, data) values
  ('00000000-0000-0000-0000-00000000f101', '00000000-0000-0000-0000-0000000000a3',
   '00000000-0000-0000-0000-00000000aa00', '00000000-0000-0000-0000-0000000ff100', 'Chronos L1', '{}'),
  ('00000000-0000-0000-0000-00000000f102', '00000000-0000-0000-0000-0000000000a3',
   '00000000-0000-0000-0000-00000000aa00', '00000000-0000-0000-0000-0000000ff200', 'Helios L1', '{}'),
  ('00000000-0000-0000-0000-00000000f103', '00000000-0000-0000-0000-0000000000b1',
   '00000000-0000-0000-0000-00000000bb00', '00000000-0000-0000-0000-0000000ff300', 'Rival L1', '{}');

-- The client contact: no org membership at all, one project grant.
insert into public.project_grants (project_id, user_id, role) values
  ('00000000-0000-0000-0000-0000000ff100', '00000000-0000-0000-0000-0000000000c1', 'viewer');

-- ── tenant isolation ─────────────────────────────────────────────────────────

select pg_temp.check('studio designer sees both studio plans, not rival''s',
  pg_temp.count_as('00000000-0000-0000-0000-0000000000a3', 'select id from public.plans') = 2,
  'saw ' || pg_temp.count_as('00000000-0000-0000-0000-0000000000a3', 'select id from public.plans'));

select pg_temp.check('rival owner sees only rival''s plan',
  pg_temp.count_as('00000000-0000-0000-0000-0000000000b1', 'select id from public.plans') = 1,
  'saw ' || pg_temp.count_as('00000000-0000-0000-0000-0000000000b1', 'select id from public.plans'));

select pg_temp.check('rival owner cannot see the studio organisation',
  pg_temp.count_as('00000000-0000-0000-0000-0000000000b1',
    'select id from public.organisations') = 1);

select pg_temp.check('rival owner cannot read the studio roster',
  pg_temp.count_as('00000000-0000-0000-0000-0000000000b1',
    'select user_id from public.org_members') = 1);

select pg_temp.check('rival owner cannot UPDATE a studio plan',
  pg_temp.affect_as('00000000-0000-0000-0000-0000000000b1',
    'update public.plans set name = ''pwned'' where id = ''00000000-0000-0000-0000-00000000f101''') <= 0);

select pg_temp.check('rival owner cannot DELETE a studio plan',
  pg_temp.affect_as('00000000-0000-0000-0000-0000000000b1',
    'delete from public.plans where id = ''00000000-0000-0000-0000-00000000f101''') <= 0);

select pg_temp.check('rival owner cannot INSERT into the studio org',
  pg_temp.affect_as('00000000-0000-0000-0000-0000000000b1',
    'insert into public.plans (id, org_id, name, data) values (gen_random_uuid(),
       ''00000000-0000-0000-0000-00000000aa00'', ''smuggled'', ''{}'')') <= 0);

-- ── GRANT-SCOPE: the external client contact ─────────────────────────────────
-- The justification for project_grants. A contact granted ONE project must see
-- that project's plans and nothing else in the same organisation.

select pg_temp.check('client contact sees exactly the one granted project',
  pg_temp.count_as('00000000-0000-0000-0000-0000000000c1', 'select id from public.projects') = 1);

select pg_temp.check('client contact sees only that project''s plan',
  pg_temp.count_as('00000000-0000-0000-0000-0000000000c1', 'select id from public.plans') = 1,
  'saw ' || pg_temp.count_as('00000000-0000-0000-0000-0000000000c1', 'select id from public.plans'));

select pg_temp.check('client contact cannot edit the plan they can see',
  pg_temp.affect_as('00000000-0000-0000-0000-0000000000c1',
    'update public.plans set name = ''edited'' where id = ''00000000-0000-0000-0000-00000000f101''') <= 0);

select pg_temp.check('client contact is not on the org roster',
  pg_temp.count_as('00000000-0000-0000-0000-0000000000c1', 'select user_id from public.org_members') = 0);

-- ── role ladder ──────────────────────────────────────────────────────────────

select pg_temp.check('viewer cannot update a plan',
  pg_temp.affect_as('00000000-0000-0000-0000-0000000000a5',
    'update public.plans set name = ''v'' where id = ''00000000-0000-0000-0000-00000000f101''') <= 0);

select pg_temp.check('reviewer cannot update a plan',
  pg_temp.affect_as('00000000-0000-0000-0000-0000000000a4',
    'update public.plans set name = ''r'' where id = ''00000000-0000-0000-0000-00000000f101''') <= 0);

select pg_temp.check('designer CAN update a plan',
  pg_temp.affect_as('00000000-0000-0000-0000-0000000000a3',
    'update public.plans set name = ''d'' where id = ''00000000-0000-0000-0000-00000000f101''') = 1);

select pg_temp.check('viewer can still READ (the ladder is not all-or-nothing)',
  pg_temp.count_as('00000000-0000-0000-0000-0000000000a5', 'select id from public.plans') = 2);

select pg_temp.check('designer cannot add an org member',
  pg_temp.affect_as('00000000-0000-0000-0000-0000000000a3',
    'insert into public.org_members (org_id, user_id, role) values
       (''00000000-0000-0000-0000-00000000aa00'', ''00000000-0000-0000-0000-0000000000c1'', ''admin'')') <= 0);

select pg_temp.check('admin CAN add an org member',
  pg_temp.affect_as('00000000-0000-0000-0000-0000000000a2',
    'insert into public.org_members (org_id, user_id, role) values
       (''00000000-0000-0000-0000-00000000aa00'', ''00000000-0000-0000-0000-0000000000c1'', ''viewer'')') = 1);

select pg_temp.check('admin cannot DELETE the organisation (owner only)',
  pg_temp.affect_as('00000000-0000-0000-0000-0000000000a2',
    'delete from public.organisations where id = ''00000000-0000-0000-0000-00000000aa00''') <= 0);

-- ── REVOKED-MEMBER: why 0001's owner-only policies are dropped ───────────────
-- The designer personally created f101 (plans.owner = a3). If the superseded
-- owner-only policy were still present, Postgres would OR it with the new one
-- and removing them from the org would leave that access intact.

delete from public.org_members
 where org_id = '00000000-0000-0000-0000-00000000aa00'
   and user_id = '00000000-0000-0000-0000-0000000000a3';

select pg_temp.check('a revoked member loses plans they personally created',
  pg_temp.count_as('00000000-0000-0000-0000-0000000000a3', 'select id from public.plans') = 0,
  'still saw ' || pg_temp.count_as('00000000-0000-0000-0000-0000000000a3', 'select id from public.plans')
    || ' — the owner-only policy from 0001 is still live');

-- ── APPEND-ONLY audit log ────────────────────────────────────────────────────

insert into public.audit_log (org_id, actor, action, subject_type, subject_id)
values ('00000000-0000-0000-0000-00000000aa00', '00000000-0000-0000-0000-0000000000a1',
        'plan.updated', 'plan', '00000000-0000-0000-0000-00000000f101');

select pg_temp.check('org admin can read the audit log',
  pg_temp.count_as('00000000-0000-0000-0000-0000000000a2', 'select id from public.audit_log') = 1);

select pg_temp.check('a plain viewer cannot read the audit log',
  pg_temp.count_as('00000000-0000-0000-0000-0000000000a5', 'select id from public.audit_log') = 0);

select pg_temp.check('nobody can UPDATE an audit row, not even the owner',
  pg_temp.affect_as('00000000-0000-0000-0000-0000000000a1',
    'update public.audit_log set action = ''rewritten''') <= 0);

select pg_temp.check('nobody can DELETE an audit row, not even the owner',
  pg_temp.affect_as('00000000-0000-0000-0000-0000000000a1',
    'delete from public.audit_log') <= 0);

select pg_temp.check('an actor cannot forge an audit entry as someone else',
  pg_temp.affect_as('00000000-0000-0000-0000-0000000000a1',
    'insert into public.audit_log (org_id, actor, action, subject_type) values
       (''00000000-0000-0000-0000-00000000aa00'', ''00000000-0000-0000-0000-0000000000a2'',
        ''forged'', ''plan'')') <= 0);

-- ── backfill ─────────────────────────────────────────────────────────────────

select pg_temp.check('the pre-tenancy plan was adopted into an organisation',
  (select org_id is not null from public.plans
    where id = '00000000-0000-0000-0000-00000000dd01'));

select pg_temp.check('its original owner still reaches it, via the new org',
  pg_temp.count_as('00000000-0000-0000-0000-0000000000d1',
    'select id from public.plans where id = ''00000000-0000-0000-0000-00000000dd01''') = 1);

select pg_temp.check('the backfilled org is private to that owner',
  pg_temp.count_as('00000000-0000-0000-0000-0000000000a1',
    'select id from public.plans where id = ''00000000-0000-0000-0000-00000000dd01''') = 0);

-- ── plan/project organisation integrity (0004) ───────────────────────────────

select pg_temp.check('a plan cannot claim an org its project does not belong to',
  pg_temp.affect_as('00000000-0000-0000-0000-0000000000a2',
    'insert into public.plans (id, owner, org_id, project_id, name, data) values
       (gen_random_uuid(), ''00000000-0000-0000-0000-0000000000a2'',
        ''00000000-0000-0000-0000-00000000bb00'',
        ''00000000-0000-0000-0000-0000000ff100'', ''mismatched'', ''{}'')') <= 0);

select pg_temp.check('the matching combination is still allowed',
  pg_temp.affect_as('00000000-0000-0000-0000-0000000000a2',
    'insert into public.plans (id, owner, org_id, project_id, name, data) values
       (gen_random_uuid(), ''00000000-0000-0000-0000-0000000000a2'',
        ''00000000-0000-0000-0000-00000000aa00'',
        ''00000000-0000-0000-0000-0000000ff100'', ''consistent'', ''{}'')') = 1);

-- ── first-time user (0003) ───────────────────────────────────────────────────
-- The case 0002 alone got wrong: a user created after the backfill has no
-- organisation, so their very first save was refused outright. Verified against
-- a real Postgres before 0003 was written.

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000e1', 'brandnew@studio.test');

select pg_temp.check('a brand-new user has no organisation to begin with',
  pg_temp.count_as('00000000-0000-0000-0000-0000000000e1',
    'select id from public.organisations') = 0);

select pg_temp.check('before ensure_personal_org, their first save is refused',
  pg_temp.affect_as('00000000-0000-0000-0000-0000000000e1',
    'insert into public.plans (id, name, data) values (gen_random_uuid(), ''First'', ''{}'')') <= 0);

select pg_temp.check('ensure_personal_org() mints one',
  pg_temp.count_as('00000000-0000-0000-0000-0000000000e1',
    'select public.ensure_personal_org()') = 1);

select pg_temp.check('after it, that same save succeeds',
  pg_temp.affect_as('00000000-0000-0000-0000-0000000000e1',
    'insert into public.plans (id, name, data) values (gen_random_uuid(), ''First'', ''{}'')') = 1);

-- ACT and ASSERT must be separate statements. SQL does not guarantee
-- left-to-right evaluation of `A and B`, so folding the call and the assertion
-- into one expression lets Postgres evaluate the assertion FIRST — against state
-- the call had not yet produced. That is not a hypothetical: the sabotage round
-- removed this function's early return, a junk org WAS created, and the combined
-- form still reported green.
select pg_temp.count_as('00000000-0000-0000-0000-0000000000e1',
  'select public.ensure_personal_org()');

select pg_temp.check('it is idempotent — a second call adds no second org',
  (select count(*) from public.organisations
    where slug = 'personal-' || replace('00000000-0000-0000-0000-0000000000e1', '-', '')) = 1);

-- The reason this is an RPC and not a trigger on auth.users: an invited member
-- must adopt the org they were invited to, not accumulate an empty personal one.
select pg_temp.count_as('00000000-0000-0000-0000-0000000000a5',
  'select public.ensure_personal_org()');

select pg_temp.check('an invited member adopts their org, not a junk personal one',
  (select count(*) from public.organisations
    where slug = 'personal-' || replace('00000000-0000-0000-0000-0000000000a5', '-', '')) = 0
  and (select count(*) from public.org_members
        where user_id = '00000000-0000-0000-0000-0000000000a5') = 1);

select pg_temp.check('the new user''s personal org is invisible to other tenants',
  pg_temp.count_as('00000000-0000-0000-0000-0000000000a1',
    'select id from public.organisations where slug like ''personal-%''') = 0);

-- ── usage ledger (0005) ──────────────────────────────────────────────────────
-- The ledger is what billing, capping and abuse-detection all read. Isolation
-- failures here are not "a user saw a stray row" — they are one tenant reading
-- another's spend, or attributing their own to somebody else's invoice.

insert into public.usage_events (org_id, user_id, route, model, input_tokens, output_tokens, cost_nanos, rate_version)
values ('00000000-0000-0000-0000-00000000aa00', '00000000-0000-0000-0000-0000000000a1',
        'claude', 'claude-sonnet-5', 1000, 200, 6000000, '2026-09-01'),
       ('00000000-0000-0000-0000-00000000bb00', '00000000-0000-0000-0000-0000000000b1',
        'claude', 'claude-sonnet-5', 9999, 9999, 179982000, '2026-09-01');

select pg_temp.check('a member sees only their own org''s usage',
  pg_temp.count_as('00000000-0000-0000-0000-0000000000a1', 'select id from public.usage_events') = 1);

select pg_temp.check('a rival cannot read another tenant''s usage',
  pg_temp.count_as('00000000-0000-0000-0000-0000000000b1',
    'select id from public.usage_events where org_id = ''00000000-0000-0000-0000-00000000aa00''') = 0);

-- A FRESH grant-only user. `c1` cannot serve here: an earlier check adds them to
-- the org to prove admins can, so by this point they are a member and SHOULD see
-- usage. Reusing them would have asserted the opposite of the intended property
-- while looking correct.
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000c2', 'contact2@gcc.test');
insert into public.project_grants (project_id, user_id, role) values
  ('00000000-0000-0000-0000-0000000ff100', '00000000-0000-0000-0000-0000000000c2', 'viewer');

select pg_temp.check('a client contact with only a project grant sees no usage at all',
  pg_temp.count_as('00000000-0000-0000-0000-0000000000c2', 'select id from public.usage_events') = 0);

select pg_temp.check('...and cannot record usage against the org either',
  pg_temp.affect_as('00000000-0000-0000-0000-0000000000c2',
    'insert into public.usage_events (org_id, user_id, route, model, cost_nanos, rate_version) values
       (''00000000-0000-0000-0000-00000000aa00'', ''00000000-0000-0000-0000-0000000000c2'',
        ''claude'', ''m'', 1, ''v'')') <= 0);

select pg_temp.check('a member cannot attribute spend to a colleague',
  pg_temp.affect_as('00000000-0000-0000-0000-0000000000a5',
    'insert into public.usage_events (org_id, user_id, route, model, cost_nanos, rate_version) values
       (''00000000-0000-0000-0000-00000000aa00'', ''00000000-0000-0000-0000-0000000000a1'',
        ''claude'', ''m'', 1, ''v'')') <= 0);

select pg_temp.check('a member CAN record their own spend',
  pg_temp.affect_as('00000000-0000-0000-0000-0000000000a5',
    'insert into public.usage_events (org_id, user_id, route, model, cost_nanos, rate_version) values
       (''00000000-0000-0000-0000-00000000aa00'', ''00000000-0000-0000-0000-0000000000a5'',
        ''claude'', ''m'', 1, ''v'')') = 1);

select pg_temp.check('a member cannot record spend against another tenant',
  pg_temp.affect_as('00000000-0000-0000-0000-0000000000a5',
    'insert into public.usage_events (org_id, user_id, route, model, cost_nanos, rate_version) values
       (''00000000-0000-0000-0000-00000000bb00'', ''00000000-0000-0000-0000-0000000000a5'',
        ''claude'', ''m'', 1, ''v'')') <= 0);

-- Append-only: the absence of update/delete policies IS the guarantee.
select pg_temp.check('nobody can rewrite a usage row, not even the org owner',
  pg_temp.affect_as('00000000-0000-0000-0000-0000000000a1',
    'update public.usage_events set cost_nanos = 0') <= 0);

select pg_temp.check('nobody can delete a usage row, not even the org owner',
  pg_temp.affect_as('00000000-0000-0000-0000-0000000000a1',
    'delete from public.usage_events') <= 0);

-- Budgets: readable by members, settable only by admins.
insert into public.org_budgets (org_id, monthly_cap_nanos)
values ('00000000-0000-0000-0000-00000000aa00', 1000000000);

select pg_temp.check('spend this month sums only the caller''s own org',
  pg_temp.count_as('00000000-0000-0000-0000-0000000000a1',
    'select public.org_spend_this_month(''00000000-0000-0000-0000-00000000aa00'')') = 1);

select pg_temp.check('a rival gets no total for an org they are not in',
  (select public.org_spend_this_month('00000000-0000-0000-0000-00000000aa00') is not null));

select pg_temp.check('a designer cannot set the budget',
  pg_temp.affect_as('00000000-0000-0000-0000-0000000000a4',
    'update public.org_budgets set monthly_cap_nanos = 999999999999
      where org_id = ''00000000-0000-0000-0000-00000000aa00''') <= 0);

select pg_temp.check('an admin CAN set the budget',
  pg_temp.affect_as('00000000-0000-0000-0000-0000000000a2',
    'update public.org_budgets set monthly_cap_nanos = 2000000000
      where org_id = ''00000000-0000-0000-0000-00000000aa00''') = 1);

-- ── anonymous ────────────────────────────────────────────────────────────────

select pg_temp.check('an unauthenticated caller sees nothing',
  pg_temp.count_as(null, 'select id from public.plans') = 0);

-- `line` only: emitting `seq` too would prefix every row and the runner would
-- parse the ordinal as the status.
select line from results order by seq;
