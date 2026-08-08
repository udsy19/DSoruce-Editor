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

-- Run `stmt` as `uid`, then evaluate `observe` as the table owner, both inside a
-- subtransaction that is ALWAYS rolled back. Returns '<rows>/<observation>', or
-- '-1/denied' when the statement errored (a WITH CHECK violation raises, a USING
-- violation silently filters — both are denials and both must be recognised).
--
-- WHY THE ROLLBACK, and why `affect_as` above is not enough. A privilege-
-- escalation probe that WORKS mutates the fixture, and the mutation cascades:
-- run against the unfixed policy, the very first version of these checks
-- promoted the admin, let it delete the organisation for real, and took the
-- projects, plans, grants and audit rows with it — the suite then died on a
-- foreign key 130 lines later and emitted no check lines at all. Worse, the
-- probes contaminated each other: once 'hijack the owner''s row' succeeded there
-- was no owner row left, so 'an admin cannot demote the owner' matched zero rows
-- and reported OK. A successful exploit was making the next check for the same
-- exploit pass.
--
-- Rolling back makes every probe independent and leaves the database in the same
-- state whether the policy is vulnerable or fixed, which is the only way the two
-- runs are comparable. `observe` runs as the table owner, after the mutation and
-- before the rollback, so it reads ground truth rather than what RLS would show
-- the attacker.
create or replace function pg_temp.probe_as(uid uuid, stmt text, observe text)
returns text language plpgsql as $$
declare n int; obs text; payload text;
begin
  begin
    perform set_config('request.jwt.claim.sub', uid::text, false);
    set local role authenticated;
    execute stmt;
    get diagnostics n = row_count;
    reset role;
    execute observe into obs;
    -- The only way out of a plpgsql subtransaction with its writes discarded is
    -- to raise; the measurement rides home in the message.
    raise exception using errcode = 'ZZ001', message = n::text || '/' || coalesce(obs, 'null');
  exception
    when sqlstate 'ZZ001' then
      get stacked diagnostics payload = message_text;
      reset role;
      return payload;
    when others then
      reset role;
      return '-1/denied';         -- hard denial; the subtransaction wrote nothing
  end;
end $$;

-- One probe, one run. Recording the verdict and the detail from a SINGLE call
-- matters here: probe_as is not a pure function of its arguments on a vulnerable
-- database (the first call escalates, and were it not rolled back the second
-- would see a different world), so calling it once for the condition and again
-- for the message would let the two disagree and print a detail that never
-- happened. `accept` is the set of outcomes that count as a refusal.
create or replace function pg_temp.check_probe(
  name text, uid uuid, stmt text, observe text, variadic accept text[])
returns void language plpgsql as $$
declare got text;
begin
  got := pg_temp.probe_as(uid, stmt, observe);
  perform pg_temp.check(name, got = any(accept), 'rows/observed = ' || got);
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

-- ── SELF-PROMOTION: the wall beside that door ────────────────────────────────
-- The check above tests the DOOR — an admin cannot delete the organisation. It
-- was true as written and one UPDATE from false: `org_members_update` gated on
-- `>= 'admin'` alone, so an admin could rewrite its OWN membership row to
-- 'owner' and then walk through that same door legitimately. The delete policy
-- was never wrong; the roster was writable by the people it constrains.
--
-- Every probe asserts on the role ACTUALLY STORED afterwards, not merely on
-- whether the statement threw. A policy that filters a row away and one that
-- hard-denies are both refusals; an escalation that succeeds is a changed enum,
-- and only the observation query can see it.
--
-- The five routes from 'admin' to 'owner', each closed by a different conjunct:
-- rewrite your own row · rewrite a peer's · move the owner's row onto an
-- accomplice · INSERT an accomplice at 'owner' · DELETE the owner and inherit
-- the vacancy.

-- An accomplice the admin controls, deliberately NOT a member: the INSERT route
-- needs a free primary key, which no existing fixture user has.
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a9', 'accomplice@studio.test');

-- Route 1 — the measured defect. Unfixed, this observes '1/owner'.
select pg_temp.check_probe('an admin cannot promote ITSELF to owner',
  '00000000-0000-0000-0000-0000000000a2',
  'update public.org_members set role = ''owner''
    where org_id = ''00000000-0000-0000-0000-00000000aa00''
      and user_id = ''00000000-0000-0000-0000-0000000000a2''',
  'select role::text from public.org_members
    where org_id = ''00000000-0000-0000-0000-00000000aa00''
      and user_id = ''00000000-0000-0000-0000-0000000000a2''',
  '0/admin', '-1/denied');

-- The CONSEQUENCE, asserted rather than argued: the same DELETE the door check
-- twenty lines above runs, but issued by an admin that has just promoted itself
-- IN THE SAME subtransaction. On a vulnerable database this goes red while the
-- identical check above stays green — which is the exact shape of the finding.
select pg_temp.check_probe('a self-promoting admin still cannot delete the organisation',
  '00000000-0000-0000-0000-0000000000a2',
  'update public.org_members set role = ''owner''
    where org_id = ''00000000-0000-0000-0000-00000000aa00''
      and user_id = ''00000000-0000-0000-0000-0000000000a2'';
   delete from public.organisations
    where id = ''00000000-0000-0000-0000-00000000aa00''',
  'select count(*)::text from public.organisations
    where id = ''00000000-0000-0000-0000-00000000aa00''',
  '0/1', '-1/denied');

-- Route 2 — a peer rather than itself. Closed by the WITH CHECK role cap alone,
-- so a fix that only excludes the actor's own row leaves this one open.
select pg_temp.check_probe('an admin cannot promote a PEER to owner',
  '00000000-0000-0000-0000-0000000000a2',
  'update public.org_members set role = ''owner''
    where org_id = ''00000000-0000-0000-0000-00000000aa00''
      and user_id = ''00000000-0000-0000-0000-0000000000a5''',
  'select role::text from public.org_members
    where org_id = ''00000000-0000-0000-0000-00000000aa00''
      and user_id = ''00000000-0000-0000-0000-0000000000a5''',
  '0/viewer', '-1/denied');

-- Route 3 — leave the role alone and move the ROW. Closed by the USING role cap
-- and NOT by the WITH CHECK: the new row still says 'owner', which is perfectly
-- legal for an owner's row, so a fix that caps only the value being written
-- misses this entirely.
select pg_temp.check_probe('an admin cannot move the owner''s row onto an accomplice',
  '00000000-0000-0000-0000-0000000000a2',
  'update public.org_members set user_id = ''00000000-0000-0000-0000-0000000000a9''
    where org_id = ''00000000-0000-0000-0000-00000000aa00''
      and user_id = ''00000000-0000-0000-0000-0000000000a1''',
  'select count(*)::text from public.org_members
    where org_id = ''00000000-0000-0000-0000-00000000aa00''
      and user_id = ''00000000-0000-0000-0000-0000000000a9''',
  '0/0', '-1/denied');

select pg_temp.check_probe('an admin cannot demote the owner',
  '00000000-0000-0000-0000-0000000000a2',
  'update public.org_members set role = ''viewer''
    where org_id = ''00000000-0000-0000-0000-00000000aa00''
      and user_id = ''00000000-0000-0000-0000-0000000000a1''',
  'select role::text from public.org_members
    where org_id = ''00000000-0000-0000-0000-00000000aa00''
      and user_id = ''00000000-0000-0000-0000-0000000000a1''',
  '0/owner', '-1/denied');

-- Route 4 — never touch an existing row at all. The UPDATE policy can be perfect
-- and this still escalates, because INSERT carried no cap of its own.
select pg_temp.check_probe('an admin cannot INSERT a new member at owner',
  '00000000-0000-0000-0000-0000000000a2',
  'insert into public.org_members (org_id, user_id, role) values
     (''00000000-0000-0000-0000-00000000aa00'',
      ''00000000-0000-0000-0000-0000000000a9'', ''owner'')',
  'select count(*)::text from public.org_members
    where org_id = ''00000000-0000-0000-0000-00000000aa00'' and role = ''owner''',
  '0/1', '-1/denied');

-- Route 5 — remove the owner and inherit the vacancy. Not escalation once INSERT
-- is capped (nobody can mint a replacement), which is exactly why it must close:
-- it would strand an organisation no one can ever own, or delete.
select pg_temp.check_probe('an admin cannot remove the owner from the roster',
  '00000000-0000-0000-0000-0000000000a2',
  'delete from public.org_members
    where org_id = ''00000000-0000-0000-0000-00000000aa00''
      and user_id = ''00000000-0000-0000-0000-0000000000a1''',
  'select count(*)::text from public.org_members
    where org_id = ''00000000-0000-0000-0000-00000000aa00''
      and user_id = ''00000000-0000-0000-0000-0000000000a1'' and role = ''owner''',
  '0/1', '-1/denied');

-- AROUND IT. The five routes above are the ones that were open. These are the
-- ways a reader asks "yes, but could you not just —", answered by measurement
-- rather than by reasoning about the policy text.

-- UPSERT. `on conflict do update` is a third statement type with its own policy
-- path: Postgres checks the INSERT's WITH CHECK for the proposed row AND the
-- UPDATE's USING + WITH CHECK for the conflicting one. Believing that without
-- testing it is exactly the kind of assumption this suite exists to refuse.
select pg_temp.check_probe('an admin cannot self-promote via INSERT ... ON CONFLICT DO UPDATE',
  '00000000-0000-0000-0000-0000000000a2',
  'insert into public.org_members (org_id, user_id, role) values
     (''00000000-0000-0000-0000-00000000aa00'',
      ''00000000-0000-0000-0000-0000000000a2'', ''owner'')
   on conflict (org_id, user_id) do update set role = ''owner''',
  'select role::text from public.org_members
    where org_id = ''00000000-0000-0000-0000-00000000aa00''
      and user_id = ''00000000-0000-0000-0000-0000000000a2''',
  '0/admin', '-1/denied');

-- DELETE-then-INSERT, in one transaction. Removing your own row is allowed
-- (leaving), so the question is whether you can come back higher. You cannot:
-- the moment the row is gone `org_role_of` returns NULL for you, and NULL is not
-- >= 'admin', so the INSERT half fails on the base gate rather than on the cap.
select pg_temp.check_probe('an admin cannot leave and rejoin as owner',
  '00000000-0000-0000-0000-0000000000a2',
  'delete from public.org_members
    where org_id = ''00000000-0000-0000-0000-00000000aa00''
      and user_id = ''00000000-0000-0000-0000-0000000000a2'';
   insert into public.org_members (org_id, user_id, role) values
     (''00000000-0000-0000-0000-00000000aa00'',
      ''00000000-0000-0000-0000-0000000000a2'', ''owner'')',
  'select count(*)::text from public.org_members
    where org_id = ''00000000-0000-0000-0000-00000000aa00'' and role = ''owner''',
  '-1/denied');

-- A second membership row in the same organisation is impossible by the primary
-- key, but a row in ANOTHER organisation is not — so check the actor cannot
-- carry a role across a tenant boundary by editing the org_id column. Refused by
-- WITH CHECK: the new row's org is one where org_role_of is NULL.
select pg_temp.check_probe('an admin cannot move its own membership into another org',
  '00000000-0000-0000-0000-0000000000a2',
  'update public.org_members set org_id = ''00000000-0000-0000-0000-00000000bb00''
    where org_id = ''00000000-0000-0000-0000-00000000aa00''
      and user_id = ''00000000-0000-0000-0000-0000000000a2''',
  'select count(*)::text from public.org_members
    where org_id = ''00000000-0000-0000-0000-00000000bb00''
      and user_id = ''00000000-0000-0000-0000-0000000000a2''',
  '0/0', '-1/denied');

-- POSITIVE CONTROLS. A cap that also forbids legitimate role management is not a
-- fix, it is a different outage. All three must stay green; the first two go red
-- if the cap is written `<` instead of `<=`, the third if the own-row exclusion
-- is applied to DELETE as well as UPDATE.

select pg_temp.check_probe('an admin CAN still promote a viewer to designer',
  '00000000-0000-0000-0000-0000000000a2',
  'update public.org_members set role = ''designer''
    where org_id = ''00000000-0000-0000-0000-00000000aa00''
      and user_id = ''00000000-0000-0000-0000-0000000000a5''',
  'select role::text from public.org_members
    where org_id = ''00000000-0000-0000-0000-00000000aa00''
      and user_id = ''00000000-0000-0000-0000-0000000000a5''',
  '1/designer');

select pg_temp.check_probe('an OWNER can promote an admin to owner',
  '00000000-0000-0000-0000-0000000000a1',
  'update public.org_members set role = ''owner''
    where org_id = ''00000000-0000-0000-0000-00000000aa00''
      and user_id = ''00000000-0000-0000-0000-0000000000a2''',
  'select role::text from public.org_members
    where org_id = ''00000000-0000-0000-0000-00000000aa00''
      and user_id = ''00000000-0000-0000-0000-0000000000a2''',
  '1/owner');

-- The own-row exclusion guards NO escalation route — the role cap already blocks
-- promotion whoever's row it is, and the falsification round proved it: deleting
-- `user_id <> auth.uid()` from both clauses left all 61 other checks green. It
-- earns its place on a different harm, the same one route 5 causes — an
-- organisation stranded with no owner, which no admin can refill afterwards
-- because INSERT is capped. Without this check that conjunct would be unguarded
-- weight, and the honest move would have been to delete it instead.
select pg_temp.check_probe('an owner cannot demote ITSELF and strand the org',
  '00000000-0000-0000-0000-0000000000a1',
  'update public.org_members set role = ''viewer''
    where org_id = ''00000000-0000-0000-0000-00000000aa00''
      and user_id = ''00000000-0000-0000-0000-0000000000a1''',
  'select role::text from public.org_members
    where org_id = ''00000000-0000-0000-0000-00000000aa00''
      and user_id = ''00000000-0000-0000-0000-0000000000a1''',
  '0/owner', '-1/denied');

select pg_temp.check_probe('an admin can still remove ITSELF from the org (leaving is not escalation)',
  '00000000-0000-0000-0000-0000000000a2',
  'delete from public.org_members
    where org_id = ''00000000-0000-0000-0000-00000000aa00''
      and user_id = ''00000000-0000-0000-0000-0000000000a2''',
  'select count(*)::text from public.org_members
    where org_id = ''00000000-0000-0000-0000-00000000aa00''',
  '1/5');

-- ── STRANDING: an organisation must never reach zero owners ──────────────────
-- 0006 closed route 5 from below (an ADMIN may not delete the owner's row) and
-- left it open from above. `owner <= owner` is true, so the owner may delete
-- ITSELF, and the org lands on zero owners with no way back: measured on this
-- schema, the remaining admin's self-promotion is `UPDATE 0`, its
-- `INSERT … 'owner'` raises, `ensure_personal_org()` adopts the same stranded
-- org without seating anyone, and `DELETE FROM organisations` affects 0 rows.
-- Every one of those refusals is correct and each is already asserted above —
-- which is precisely the shape of the harm. 0006 made the exit unreachable
-- while leaving the entrance open, converting a self-healing state into a
-- permanent one. The permanence therefore needs no new check; the entrance does.
--
-- The same harm is already guarded one statement type over, on UPDATE, by
-- 'an owner cannot demote ITSELF and strand the org'. That check is green. This
-- section is the DELETE half of the identical property.
--
-- The property is NOT "you may not delete your own row" — 0006 rejects that
-- reading in as many words, because it would trap people in organisations, and
-- the safe exit (promote a successor, then leave) has to keep working. It is
-- narrower: an organisation must never reach zero owners. So the last owner may
-- not remove itself; an owner with a co-owner may.

-- A second organisation with TWO owners. Studio cannot express the co-owner
-- cases — it has exactly one — and widening Studio's roster would move the
-- counts every check above asserts on. Fresh users, so no membership count
-- elsewhere in this file changes.
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a6', 'owner-a@duo.test'),
  ('00000000-0000-0000-0000-0000000000a7', 'owner-b@duo.test'),
  ('00000000-0000-0000-0000-0000000000a8', 'admin@duo.test');

-- The `org_creator_is_owner` trigger seats d1; d2 is the co-owner that makes
-- leaving legal, d3 the admin that makes it illegal again once they have gone.
insert into public.organisations (id, name, slug, created_by) values
  ('00000000-0000-0000-0000-00000000cc00', 'Duo', 'duo',
   '00000000-0000-0000-0000-0000000000a6');
insert into public.org_members (org_id, user_id, role) values
  ('00000000-0000-0000-0000-00000000cc00', '00000000-0000-0000-0000-0000000000a7', 'owner'),
  ('00000000-0000-0000-0000-00000000cc00', '00000000-0000-0000-0000-0000000000a8', 'admin');

-- THE DEFECT. Unfixed this observes '1/0': one row deleted, zero owners left.
select pg_temp.check_probe('the LAST owner cannot leave and strand the org',
  '00000000-0000-0000-0000-0000000000a1',
  'delete from public.org_members
    where org_id = ''00000000-0000-0000-0000-00000000aa00''
      and user_id = ''00000000-0000-0000-0000-0000000000a1''',
  'select count(*)::text from public.org_members
    where org_id = ''00000000-0000-0000-0000-00000000aa00'' and role = ''owner''',
  '0/1', '-1/denied');

-- The same delete wearing a CTE and a USING join. A predicate attached to the
-- simple form and not to the row can be walked around by reshaping the
-- statement, so the reshaped form is measured rather than argued about.
select pg_temp.check_probe('nor by routing that delete through a CTE and USING',
  '00000000-0000-0000-0000-0000000000a1',
  'with victim as (
     select org_id, user_id from public.org_members
      where org_id = ''00000000-0000-0000-0000-00000000aa00''
        and user_id = ''00000000-0000-0000-0000-0000000000a1'')
   delete from public.org_members m using victim v
    where m.org_id = v.org_id and m.user_id = v.user_id',
  'select count(*)::text from public.org_members
    where org_id = ''00000000-0000-0000-0000-00000000aa00'' and role = ''owner''',
  '0/1', '-1/denied');

-- THE CASE THAT KILLS THE OBVIOUS FIX, and the reason this is not a policy
-- conjunct. An RLS `USING` predicate is evaluated per row against the
-- STATEMENT'S snapshot, so a `count(owners) > 1` conjunct is true for BOTH rows
-- of a two-owner org and one statement removes them both. Measured against
-- exactly that candidate: '2/0' — `DELETE 2`, zero owners. The guard has to see
-- the end of the statement, not the start of it.
select pg_temp.check_probe('nor can ONE statement remove both owners at once',
  '00000000-0000-0000-0000-0000000000a6',
  'delete from public.org_members
    where org_id = ''00000000-0000-0000-0000-00000000cc00''
      and role = ''owner''',
  'select count(*)::text from public.org_members
    where org_id = ''00000000-0000-0000-0000-00000000cc00'' and role = ''owner''',
  '0/2', '-1/denied');

-- TRUNCATE fires no row-level trigger and is governed by a table privilege
-- rather than by RLS, so it is the one statement that would walk past the guard
-- entirely. `authenticated` holds select/insert/update/delete and nothing else;
-- this asserts that, rather than trusting the grant list to stay that way.
select pg_temp.check_probe('nor by TRUNCATE, which fires no row trigger at all',
  '00000000-0000-0000-0000-0000000000a1',
  'truncate public.org_members',
  'select count(*)::text from public.org_members
    where org_id = ''00000000-0000-0000-0000-00000000aa00'' and role = ''owner''',
  '-1/denied');

-- POSITIVE CONTROLS. A guard that also forbids the safe exit is not a fix, it is
-- the trap 0006 explicitly declined to build. All four must stay green.

select pg_temp.check_probe('an owner CAN leave when a co-owner remains',
  '00000000-0000-0000-0000-0000000000a7',
  'delete from public.org_members
    where org_id = ''00000000-0000-0000-0000-00000000cc00''
      and user_id = ''00000000-0000-0000-0000-0000000000a7''',
  'select count(*)::text from public.org_members
    where org_id = ''00000000-0000-0000-0000-00000000cc00'' and role = ''owner''',
  '1/1');

-- The safe exit, in the order 0006 prescribes: name a successor, then go. Both
-- statements in one subtransaction, so what is asserted is that the sequence
-- works — not that each half works in isolation.
select pg_temp.check_probe('promote-then-leave: the last owner CAN leave after naming a successor',
  '00000000-0000-0000-0000-0000000000a1',
  'update public.org_members set role = ''owner''
    where org_id = ''00000000-0000-0000-0000-00000000aa00''
      and user_id = ''00000000-0000-0000-0000-0000000000a2'';
   delete from public.org_members
    where org_id = ''00000000-0000-0000-0000-00000000aa00''
      and user_id = ''00000000-0000-0000-0000-0000000000a1''',
  'select count(*)::text from public.org_members
    where org_id = ''00000000-0000-0000-0000-00000000aa00'' and role = ''owner''',
  '1/1');

select pg_temp.check_probe('an owner can still remove a MEMBER''s row',
  '00000000-0000-0000-0000-0000000000a1',
  'delete from public.org_members
    where org_id = ''00000000-0000-0000-0000-00000000aa00''
      and user_id = ''00000000-0000-0000-0000-0000000000a5''',
  'select count(*)::text from public.org_members
    where org_id = ''00000000-0000-0000-0000-00000000aa00''',
  '1/5');

-- Deleting the organisation is not stranding it, it is deleting it, and the
-- roster cascades away underneath. A guard that cannot tell those apart makes
-- an owned organisation undeletable — the same permanence, entered from the
-- other side. This is the check that reds if that distinction is dropped.
select pg_temp.check_probe('deleting the organisation still takes its roster with it',
  '00000000-0000-0000-0000-0000000000a1',
  'delete from public.organisations
    where id = ''00000000-0000-0000-0000-00000000aa00''',
  'select count(*)::text from public.org_members
    where org_id = ''00000000-0000-0000-0000-00000000aa00''',
  '1/0');

-- The probes are only comparable across a fixed and an unfixed run if they left
-- nothing behind. Asserted, not assumed — this is the check that reds if a
-- future probe is added without going through probe_as.
select pg_temp.check('the escalation probes left the roster untouched',
  (select count(*) from public.org_members
    where org_id = '00000000-0000-0000-0000-00000000aa00') = 6
  and (select role from public.org_members
        where org_id = '00000000-0000-0000-0000-00000000aa00'
          and user_id = '00000000-0000-0000-0000-0000000000a1') = 'owner'
  and (select role from public.org_members
        where org_id = '00000000-0000-0000-0000-00000000aa00'
          and user_id = '00000000-0000-0000-0000-0000000000a2') = 'admin'
  and (select role from public.org_members
        where org_id = '00000000-0000-0000-0000-00000000aa00'
          and user_id = '00000000-0000-0000-0000-0000000000a5') = 'viewer'
  and (select count(*) from public.organisations
        where id = '00000000-0000-0000-0000-00000000aa00') = 1
  -- the stranding probes above, under the same guard
  and (select count(*) from public.org_members
        where org_id = '00000000-0000-0000-0000-00000000cc00') = 3
  and (select count(*) from public.org_members
        where org_id = '00000000-0000-0000-0000-00000000cc00' and role = 'owner') = 2,
  'roster is ' || (select count(*) from public.org_members
    where org_id = '00000000-0000-0000-0000-00000000aa00')::text || ' rows, duo is '
    || (select count(*) from public.org_members
         where org_id = '00000000-0000-0000-0000-00000000cc00')::text || ' rows / '
    || (select count(*) from public.org_members
         where org_id = '00000000-0000-0000-0000-00000000cc00' and role = 'owner')::text
    || ' owners');

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
