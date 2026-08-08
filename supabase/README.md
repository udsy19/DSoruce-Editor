# `supabase/` — the database, as code

Until this directory existed the schema lived **only** as a fenced SQL block inside
`docs/design/cloud-sync.md`, applied by hand to a project the repo cannot reach. There was no
reproducible way to stand the database up from source, and no way to test a policy change before
it was live. That is what this fixes.

```
migrations/
  0001_plans_cloud_sync.sql   the owner-only plan store (transcribed from the design doc)
  0002_tenancy.sql            organisations · roles · projects · grants · audit log
tests/
  bootstrap.sql               local stand-in for Supabase's `auth` schema + roles
  pre-tenancy-seed.sql        data that predates 0002, so the backfill is actually exercised
  rls.sql                     28 behaviour checks
  rls.test.mjs                runner
```

## Running the suite

Needs any reachable Postgres. It creates a throwaway database, applies everything in order, runs the
checks, and drops it again.

```bash
# a disposable cluster, if you don't already have one
initdb -D /tmp/dspg -U postgres --auth=trust
pg_ctl -D /tmp/dspg -o "-p 54329 -c listen_addresses=127.0.0.1" -l /tmp/dspg/log start

PGHOST=127.0.0.1 PGPORT=54329 PGUSER=postgres node supabase/tests/rls.test.mjs
```

With no Postgres reachable it prints `SKIP` and exits 0, so it never fails a board for the wrong
reason. **A skip is not a pass** — quote a green result only from a run that actually connected.

## Two rules that are easy to get wrong

**Migrations run once, in order.** `0001` is written idempotently, which means "safe to run twice at
its own point in history" — *not* "safe to run at any later point". Re-applying it after `0002`
recreates the four owner-only policies that `0002` deliberately drops; Postgres ORs permissive
policies together, so the result is a database where a revoked member still reaches every plan they
personally created. The suite catches this (`REVOKED-MEMBER`), because it happened.

**Authorization lives here, not in the client.** There is no server code between a browser and these
tables. Do not add client-side `.eq('org_id', …)` filtering to "help" — RLS already scopes every
query, and a second weaker copy of the rule is the one that drifts out of sync. If a query returns
fewer rows than expected, read the policy.

## Applying to a real project

These have **not** been applied anywhere. `docs/design/cloud-sync.md` names project
`nkjigrogbobtklotupkt` as carrying `0001` already; that project is not reachable from this repo's
credentials, so `0001`'s idempotence has been proven only locally. Before running it against a live
database, diff it against the real schema.
