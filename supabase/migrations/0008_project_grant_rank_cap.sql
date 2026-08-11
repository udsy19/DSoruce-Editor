-- 0008_project_grant_rank_cap — the rule 0006 established, applied to the
-- sibling table it was not applied to.
--
-- 0006 closed a privilege escalation on `org_members` with one rule: you may not
-- act on a membership ranked above your own, may not grant a rank above your
-- own, and may not edit your own row. `project_grants` is the same shape — a
-- table whose rows feed the very oracle (`project_role_of`) that decides who may
-- write to it — and it kept the uncapped policies 0002 gave it. Fixing one and
-- not the other is how a closed hole reopens next door.
--
-- REPRODUCED FIRST, on PostgreSQL 14 with every migration through 0007 applied,
-- using the same rollback-and-observe probe 0006's suite introduced. Acting as
-- an org ADMIN (so `project_role_of` = 'admin'), all three succeeded:
--
--   E1  grant an outsider 'owner' on a project   -> 1 row written; now: owner
--   E2  delete the org owner's 'owner' grant     -> 1 row written; now: 0
--   E3  grant SELF 'owner'                       -> 1 row written; now: owner
--
-- SEVERITY, stated honestly rather than inflated. Nothing in the schema gates on
-- `project_role_of >= 'owner'` — every consumer stops at 'designer' or 'admin' —
-- so project-level 'owner' buys no capability that 'admin' does not already have,
-- and none of this reaches org-level control (deleting an organisation and
-- managing its roster are `org_role_of`-gated, and 0006/0007 govern those).
-- What is live today is narrower but real:
--
--   * E2 lets a project-admin revoke a grant held by someone ranked above them.
--   * E1 lets them install an outsider who can then grant and revoke in turn —
--     including revoking the admin who installed them.
--
-- And it is a latent full escalation: the first policy anyone writes at
-- `>= 'owner'` makes E1/E3 a way to reach it. Closing the shape now costs one
-- migration; closing it after that policy exists costs an incident.
--
-- A NEW MIGRATION, not an edit to 0002 — the same choice 0003, 0004, 0006 and
-- 0007 made when they corrected it. Applied history stays applied.

-- Cap what may be GRANTED at the granter's own effective rank on that project.
drop policy if exists project_grants_insert on public.project_grants;
create policy project_grants_insert on public.project_grants for insert
  with check (
    public.project_role_of(project_id) >= 'admin'
    and project_grants.role <= public.project_role_of(project_id)
  );

-- Cap what may be REVOKED the same way. Without this arm E1 could be closed and
-- E2 would still stand: refusing to create a superior while allowing one to be
-- deleted is not a rank rule, it is half of one.
drop policy if exists project_grants_delete on public.project_grants;
create policy project_grants_delete on public.project_grants for delete
  using (
    public.project_role_of(project_id) >= 'admin'
    and project_grants.role <= public.project_role_of(project_id)
  );

-- There is deliberately still no UPDATE policy. RLS denies by default, so a
-- grant is changed by delete-then-insert, and both halves are now capped. Adding
-- a permissive UPDATE would be a third surface to keep in step for no gain.
--
-- Note the rank cap subsumes the self-edit rule for this table: a self-grant AT
-- OR BELOW your own rank is harmless (your access already comes from the greater
-- of your org role and your grant, so it changes nothing), and a self-grant
-- ABOVE it is exactly what the cap refuses. That is why this migration does not
-- carry 0006's `user_id <> auth.uid()` arm — on `org_members` that arm stopped
-- self-promotion in a table with an UPDATE path; here the cap already does, and
-- copying the arm would forbid a legitimate no-op.
