-- 0003_ensure_personal_org — make a first-time user able to save anything.
--
-- THE GAP THIS CLOSES. 0002 backfilled an organisation for every user who
-- already had plans, and defaulted `plans.org_id` to the caller's org. A user
-- who signs up AFTER that migration has no organisation at all, so the default
-- resolves to NULL and their very first save is refused — by the NOT NULL
-- constraint if the policy let it through, and by the insert policy before that
-- (`org_role_of(NULL) >= 'designer'` is NULL, which is not true). Verified
-- against a real Postgres before writing this file: `INSERT FAILED: new row
-- violates row-level security policy for table "plans"`.
--
-- WHY AN RPC AND NOT A TRIGGER ON auth.users. The usual Supabase pattern hangs
-- a trigger off user creation, but that mints a personal organisation for every
-- signup — including someone invited into an existing org, who then carries an
-- empty junk org forever. Resolving it lazily and idempotently means an invited
-- user simply gets the org they were invited to.
--
-- WHY IT LIVES IN THE DATABASE. The client could do select-then-insert itself,
-- but that is a race (two tabs signing in at once) and it is a rule every future
-- client would have to reimplement identically. Here it is one definition, and
-- the unique constraint on `slug` is what makes the race safe rather than a
-- comment asking callers to be careful.

create or replace function public.ensure_personal_org()
returns uuid
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_uid uuid;
  v_org uuid;
begin
  v_uid := (select auth.uid());
  if v_uid is null then
    raise exception 'ensure_personal_org: not authenticated';
  end if;

  -- Already a member of something? Then that is their home, invited or not.
  -- Highest role first, then oldest — the same ordering as
  -- default_org_of_current_user(), so the two never disagree about "home".
  select m.org_id into v_org
    from public.org_members m
   where m.user_id = v_uid
   order by m.role desc, m.created_at asc
   limit 1;
  if v_org is not null then
    return v_org;
  end if;

  begin
    insert into public.organisations (name, slug, created_by)
    values ('Personal', 'personal-' || replace(v_uid::text, '-', ''), v_uid)
    returning id into v_org;
  exception when unique_violation then
    -- A concurrent call won the race. Adopt its organisation rather than
    -- failing: the slug is derived from the user id, so the row that exists is
    -- necessarily theirs.
    select o.id into v_org
      from public.organisations o
     where o.slug = 'personal-' || replace(v_uid::text, '-', '');
  end;

  -- The `org_creator_is_owner` trigger normally does this. Doing it explicitly
  -- too costs nothing and keeps the function correct if that trigger is ever
  -- dropped — an ownerless organisation is unreachable by every policy.
  insert into public.org_members (org_id, user_id, role)
  values (v_org, v_uid, 'owner')
  on conflict (org_id, user_id) do update set role = 'owner';

  return v_org;
end $$;

revoke all on function public.ensure_personal_org() from public;
grant execute on function public.ensure_personal_org() to authenticated;
