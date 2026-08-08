-- 0006_org_member_role_cap — an admin may not promote itself, or anyone, to owner.
--
-- THE HOLE. 0002 gated all three write policies on `org_members` at `>= 'admin'`
-- and nothing else. The roster is the table that decides what `>= 'admin'` MEANS,
-- so gating it on itself with no further condition let an admin rewrite its own
-- role. Measured on PostgreSQL 17, against the policies as 0002 shipped them:
--
--     ok|BASELINE:    admin cannot delete the org (as rls.sql asserts)
--     ok|ESCALATION:  admin promotes ITSELF to owner            (1 row)
--     ok|ROLE AFTER:  a2 is now owner
--     ok|CONSEQUENCE: the promoted admin CAN now delete the organisation (1 row)
--
-- `supabase/tests/rls.sql` asserted "admin cannot DELETE the organisation (owner
-- only)" and that assertion was TRUE — the delete policy was never wrong. The
-- suite tested the door while the wall beside it was open. Both lines now sit
-- next to each other in that file, and on the unfixed policy the second one is
-- the only one that reds.
--
-- FIVE ROUTES, not one. Capping the value an admin may WRITE closes two of them.
-- The others come from the row it may write TO, and from the two statements that
-- are not UPDATE at all:
--
--   1. UPDATE own row      → role = 'owner'                     (the report)
--   2. UPDATE a peer's row → role = 'owner', then log in as them
--   3. UPDATE the OWNER's row, changing only `user_id` to an account the admin
--      controls. The role written is 'owner', which is the value that row
--      already had, so no WITH CHECK on the new role can see this. It is
--      refused by the USING clause or not at all.
--   4. INSERT a fresh member at 'owner'. Touches no existing row, so a perfect
--      UPDATE policy is irrelevant.
--   5. DELETE the owner's row. Not escalation once (4) is capped — nobody can
--      mint a replacement owner — which is exactly why it has to close too:
--      it would otherwise strand an organisation that no one can own or delete.
--
-- THE RULE, one sentence: you may not act on a membership ranked above your own,
-- you may not grant a rank above your own, and you may not edit your own row.
-- Expressed as a plain enum comparison against the same SECURITY DEFINER oracle
-- 0002 already uses, so there is no second notion of "rank" to drift.
--
-- WHY `<=` AND NOT `<`. An admin managing other admins is normal administration
-- and 0002 allowed it; `<` would forbid an admin from creating or removing an
-- admin, which is a different product, not a security fix. `<=` removes exactly
-- the escalation routes and leaves every previously-legal operation legal —
-- asserted by three positive controls in rls.sql, not assumed.
--
-- WHAT IS DELIBERATELY STILL ALLOWED, so it is a decision and not an oversight:
--   * An admin may DELETE its own row — leaving an organisation is not
--     escalation, and forbidding it would trap people in orgs.
--   * An owner may act on other owners. Owner is the top of the ladder; there
--     is no higher role to escalate to, so the cap is vacuous for them.
--   * Nobody may UPDATE their own row, owner included. An owner therefore
--     cannot demote itself in one step; it must promote a second owner first.
--     That is a deliberate guard against an org losing its last owner, and it
--     is the one previously-legal operation this migration removes.
--
-- The SECURITY DEFINER paths are unaffected: `ensure_personal_org()` (0003) and
-- the `org_creator_is_owner` trigger (0002) both run as the table owner and
-- bypass RLS, which is what still lets a brand-new organisation acquire its
-- first owner. rls.sql exercises both after this migration.

-- `org_members.role` is written qualified throughout: `role` alone is a keyword
-- in enough contexts that the unqualified form reads as a question.

-- INSERT — route 4. May not seat anyone above your own rank.
drop policy if exists org_members_write on public.org_members;
create policy org_members_write on public.org_members for insert
  with check (
    public.org_role_of(org_id) >= 'admin'
    and org_members.role <= public.org_role_of(org_id)
  );

-- UPDATE — routes 1, 2 and 3. The predicate is repeated in USING and WITH CHECK
-- on purpose and they are NOT redundant: USING decides which existing rows are
-- visible to the statement (route 3, where the new role is unchanged), WITH
-- CHECK decides what the row may become (routes 1 and 2). Dropping either one
-- reopens a different route, which the falsification round confirmed one at a
-- time.
drop policy if exists org_members_update on public.org_members;
create policy org_members_update on public.org_members for update
  using (
    public.org_role_of(org_id) >= 'admin'
    and org_members.user_id <> (select auth.uid())
    and org_members.role <= public.org_role_of(org_id)
  )
  with check (
    public.org_role_of(org_id) >= 'admin'
    and org_members.user_id <> (select auth.uid())
    and org_members.role <= public.org_role_of(org_id)
  );

-- DELETE — route 5. No own-row exclusion here: leaving is allowed.
drop policy if exists org_members_delete on public.org_members;
create policy org_members_delete on public.org_members for delete
  using (
    public.org_role_of(org_id) >= 'admin'
    and org_members.role <= public.org_role_of(org_id)
  );
