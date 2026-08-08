-- Applied BETWEEN 0001 and 0002, so the tenancy migration meets data that
-- genuinely predates it. Seeding this after 0002 instead would test nothing:
-- the backfill would already have run, and `plans.org_id` would be satisfied by
-- its new default rather than by the migration doing its job.

insert into auth.users (id, email)
values ('00000000-0000-0000-0000-0000000000d1', 'legacy@studio.test');

insert into public.plans (id, owner, name, data)
values ('00000000-0000-0000-0000-00000000dd01',
        '00000000-0000-0000-0000-0000000000d1',
        'Legacy plan',
        '{}'::jsonb);
