-- 0004_plan_project_org_integrity — a plan's organisation must be its project's.
--
-- THE HOLE. 0002 gave `plans` both `org_id` and `project_id` and constrained them
-- separately: `org_id` references organisations, `project_id` references
-- projects. Nothing tied the two together, so `plans(org_id = A, project_id = P)`
-- where P belongs to organisation B was a perfectly legal row.
--
-- It is not a privilege escalation — the insert policy requires designer on BOTH
-- the org and the project, so nobody can smuggle a row somewhere they lack
-- access. It is an integrity and visibility bug: the select policy reads through
-- `project_id` when one is set and ignores `org_id`, so such a row would be
-- visible to organisation B's staff while claiming to belong to A, and would be
-- counted under A by anything that aggregates on `org_id`. That is the kind of
-- inconsistency that is cheap to forbid now and archaeology to unpick later.
--
-- Enforced with a COMPOSITE FOREIGN KEY rather than a trigger: it is declarative,
-- the planner enforces it on every path including bulk loads, and there is no
-- function body that can drift from its intent. The extra unique constraint on
-- `projects (id, org_id)` is redundant with the primary key on `id` alone — it
-- exists only because a composite FK needs a matching unique index to point at.

-- Belt-and-braces: if any row already violates this, fail loudly here rather
-- than let `not valid` quietly park bad data. Nothing is live yet, so this
-- should be a no-op — but a migration that cannot say so is worth less.
do $$
declare bad int;
begin
  select count(*) into bad
    from public.plans pl
    join public.projects pr on pr.id = pl.project_id
   where pl.org_id <> pr.org_id;
  if bad > 0 then
    raise exception '0004: % plan(s) disagree with their project''s organisation — reconcile before applying', bad;
  end if;
end $$;

alter table public.projects
  add constraint projects_id_org_key unique (id, org_id);

alter table public.plans
  add constraint plans_project_org_fk
  foreign key (project_id, org_id)
  references public.projects (id, org_id)
  on delete set null;
