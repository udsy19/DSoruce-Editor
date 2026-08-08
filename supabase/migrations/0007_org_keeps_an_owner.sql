-- 0007_org_keeps_an_owner — an organisation must never reach zero owners.
--
-- THE REGRESSION 0006 INTRODUCED. 0006 capped every write on `org_members` at
-- the actor's own rank. On DELETE that reads:
--
--     public.org_role_of(org_id) >= 'admin'
--     and org_members.role <= public.org_role_of(org_id)
--
-- `owner <= owner` is true, so an owner may delete its OWN membership row. That
-- was already true before 0006 and 0006 deliberately kept it — leaving an
-- organisation is not escalation, and forbidding it outright would trap people
-- in orgs. What changed is what happens next. Measured end to end on this
-- schema, PostgreSQL 14, with 0001–0006 applied:
--
--     DELETE 1
--     OWNERS AFTER OWNER LEAVES: 0
--     MEMBERS REMAINING:         4
--     -- the remaining admin then tries to recover:
--     UPDATE 0                                    (self-promotion, capped)
--     R2 INSERT owner: DENIED (new row violates row-level security policy)
--     R3 ensure_personal_org -> …aa00             (adopts the stranded org, seats nobody)
--     DELETE 0                                    (organisations_delete needs 'owner')
--     FINAL owners: 0
--     FINAL org rows: 1
--
-- Every one of those four refusals is correct, and every one is already asserted
-- in rls.sql. That is the whole shape of the defect: 0006 closed the escalation
-- route (an admin minting itself an owner) and in doing so closed the ONLY exit
-- from the ownerless state. Pre-0006 the identical sequence was self-healing —
-- the admin self-promoted and the org had an owner again. 0006 converted a
-- recoverable state into a permanent one: the org can then never be owned, never
-- be deleted, never be billed, and recovery needs out-of-band `service_role`.
--
-- 0006's own file names this harm and guards it one statement type over. On
-- UPDATE it keeps `user_id <> auth.uid()` expressly for "an organisation
-- stranded with no owner, which no admin can refill afterwards because INSERT is
-- capped", under the check 'an owner cannot demote ITSELF and strand the org'.
-- That check is green. The same property was simply false on DELETE.
--
-- THE PROPERTY, and why it is not "you may not delete your own row". The narrow
-- statement is: an organisation must never reach zero owners. The last owner may
-- not remove itself; an owner with a co-owner may. The safe exit 0006 prescribes
-- — promote a successor, THEN leave — keeps working unchanged, and rls.sql
-- asserts it does rather than assuming it.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY THIS IS A TRIGGER AND NOT A POLICY CONJUNCT.
--
-- The obvious fix is one more conjunct on `org_members_delete`, counting owners
-- through a SECURITY DEFINER oracle the way `org_role_of` already does:
--
--     and (org_members.role < 'owner' or public.org_owner_count(org_id) > 1)
--
-- That candidate was written and MEASURED, not reasoned about, and it fails
-- twice. Both numbers below are from the two-owner fixture with that policy
-- live:
--
--   1. ONE STATEMENT, TWO ROWS. An RLS `USING` predicate is evaluated per row
--      against the STATEMENT's snapshot. For `delete … where role = 'owner'` in
--      a two-owner org, `org_owner_count` returns 2 for BOTH rows, both pass,
--      and both go:
--          DELETE 2
--          CASE C owners after one multi-row DELETE: 0
--
--   2. TWO TRANSACTIONS. The same check-then-act race one level up. Two owners,
--      each in its own transaction, each seeing two owners, each removing
--      itself. Nothing serialises them:
--          [T1] DELETE 1   [T1] COMMIT
--          [T2] DELETE 1   [T2] COMMIT
--          RACE RESULT owners = 0
--
-- A guard for this property has to see the END of the statement, not the start
-- of it, and it has to serialise concurrent departures. A row-level policy
-- predicate can do neither. A constraint trigger does both, and it is strictly
-- stronger than the conjunct on every input, so the conjunct is NOT also added:
-- a part whose removal changes nothing is unguarded weight, and rls.sql already
-- says so in as many words about a conjunct of 0006's.
--
-- The failure mode is better too. The policy conjunct would answer the last
-- owner's "Leave organisation" with a silent `DELETE 0`; the trigger answers
-- with a message naming the organisation and the remedy.
--
-- WHY `after … deferrable initially immediate` AND NOT A PLAIN AFTER TRIGGER.
-- Both fire at end of statement, which is what closes case 1. The constraint
-- form additionally lets a deliberate multi-statement handover run under
-- `set constraints all deferred` — demote-then-promote in either order inside
-- one transaction — while still refusing to let that transaction COMMIT
-- ownerless. Deferral widens what is expressible, never what is reachable.
--
-- WHY THE `for update` ON `organisations`. It is the serialisation point for
-- case 2, and it does double duty. Taking it BEFORE the owner count is what
-- makes the count meaningful: under READ COMMITTED the second transaction
-- blocks on the lock, and the count that follows takes a fresh snapshot which
-- now includes the first transaction's committed departure. It also answers the
-- cascade question for free — when the organisation row is itself being deleted
-- the lock finds nothing, and a roster vanishing underneath a deleted org is
-- deletion, not stranding.
--
-- WHY THE EARLY EXIT. Stated as what it is: contention, not safety. Removing it
-- leaves the guard correct and the suite green — the sabotage round confirmed
-- that null result. It earns its place because without it EVERY write to
-- `org_members` takes an exclusive row lock on the organisation, including
-- `ensure_personal_org()`'s `on conflict do update set role = 'owner'`, which
-- runs on ordinary sign-in and would serialise every concurrent login for a
-- busy org behind one row.
--
-- WHAT THIS DELIBERATELY ALSO REFUSES, so it is a decision and not an oversight.
-- `org_members` cascades from `auth.users`, so deleting the account of an
-- organisation's sole owner now fails, loudly, naming the org. That path is
-- reachable only with `service_role`/admin privileges, and failing there is the
-- point: the operator is the one person who can reassign the organisation or
-- delete it, and a silent strand would hand them the same unrecoverable state
-- by a different door. Measured, as the table owner, on an org whose sole owner
-- is not its creator (an org creator is held by `organisations_created_by_fkey`
-- first and never reaches this trigger):
--
--     ERROR:  organisation …ee00 would be left with no owner
--     HINT:   promote another member to owner first, or delete the organisation
--     -- and after the prescribed handover:
--     P6 after handover, account deletion: owners = 1
--
-- THE COST, measured rather than left for someone to discover. Row locks make
-- deadlock reachable where two transactions touch two organisations' owner rows
-- in opposite orders. Probed directly — transaction A removing an owner from
-- org DA then DB while B does DB then DA:
--
--     [T-AB] ERROR:  deadlock detected
--     => DA owners = 2, DB owners = 2
--
-- Postgres detects it, aborts one side, and the invariant holds on both orgs;
-- the caller sees `deadlock detected` and retries. Accepted: it needs one
-- transaction to remove owners from two organisations, which no path in this
-- application does, and the alternative — advisory locks taken in org-id order
-- — buys a rarer failure with a second locking scheme to keep in step.

-- Belt-and-braces, in 0004's idiom: if anything already violates this, say so
-- here rather than install a guard over data that cannot satisfy it. 0002's
-- backfill and the `org_creator_is_owner` trigger mean this should be a no-op —
-- but a migration that cannot say so is worth less.
do $$
declare bad int;
begin
  select count(*) into bad
    from public.organisations o
   where not exists (select 1 from public.org_members m
                      where m.org_id = o.id and m.role = 'owner');
  if bad > 0 then
    raise exception '0007: % organisation(s) already have no owner — reconcile before applying', bad;
  end if;
end $$;

-- SECURITY DEFINER for the same reason every membership lookup in 0002 is:
-- `org_members` carries RLS, and a trigger body that reads it as the caller
-- would see the caller's filtered view of the roster rather than the roster.
-- `search_path` is pinned so a caller cannot shadow `public`.
create or replace function public.tg_org_keeps_an_owner()
returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  -- Only a statement that takes an owner AWAY from `old.org_id` can break the
  -- invariant. See WHY THE EARLY EXIT above: this is contention, not safety.
  if old.role <> 'owner' then
    return null;
  end if;
  if tg_op = 'UPDATE' and new.role = 'owner' and new.org_id = old.org_id then
    return null;
  end if;

  -- Serialise concurrent departures, and distinguish stranding from deletion.
  -- Must come before the count; the count's snapshot is taken after the wait.
  perform 1 from public.organisations where id = old.org_id for update;
  if not found then
    return null;                    -- the organisation itself is going away
  end if;

  if not exists (select 1 from public.org_members m
                  where m.org_id = old.org_id and m.role = 'owner') then
    raise exception using
      errcode = '23514',
      message = format('organisation %s would be left with no owner', old.org_id),
      hint = 'promote another member to owner first, or delete the organisation';
  end if;

  return null;
end $$;

drop trigger if exists org_keeps_an_owner on public.org_members;
create constraint trigger org_keeps_an_owner
  after delete or update on public.org_members
  deferrable initially immediate
  for each row execute function public.tg_org_keeps_an_owner();
