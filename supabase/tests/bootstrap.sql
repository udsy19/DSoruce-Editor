-- Local stand-in for the parts of Supabase the migrations depend on, so the RLS
-- policies can be exercised against a real Postgres instead of read and hoped
-- over. Faithful on the two things that matter for authorization:
--
--   * `auth.uid()` resolves from a per-session JWT claim, exactly as it does on
--     Supabase (both the legacy `request.jwt.claim.sub` GUC and the current
--     `request.jwt.claims` JSON form are honoured, so the migrations are not
--     quietly coupled to whichever one this file happens to pick).
--   * queries run as the `authenticated` role, which is what RLS actually sees.
--     Running as the table owner would silently BYPASS every policy and the whole
--     suite would pass while proving nothing.
--
-- This file is test scaffolding. It is never applied to a Supabase project —
-- there, `auth` is real.

create schema if not exists auth;

create table if not exists auth.users (
  id    uuid primary key,
  email text
);

create or replace function auth.uid() returns uuid
language sql stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
  )::uuid
$$;

do $$ begin
  create role authenticated nologin;
exception when duplicate_object then null;
end $$;

do $$ begin
  create role anon nologin;
exception when duplicate_object then null;
end $$;

grant usage on schema public, auth to authenticated, anon;

-- Mirrors Supabase's default grants: the role can reach the tables, and RLS —
-- not the grant — decides which rows it sees.
alter default privileges in schema public
  grant select, insert, update, delete on tables to authenticated;
alter default privileges in schema public
  grant usage, select on sequences to authenticated;
