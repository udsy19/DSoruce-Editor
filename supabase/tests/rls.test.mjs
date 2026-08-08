// RLS behaviour suite runner. From the repo root:
//   PGHOST=127.0.0.1 PGPORT=54329 PGUSER=postgres node supabase/tests/rls.test.mjs
// @covers: supabase/migrations/0001_plans_cloud_sync.sql, 0002_tenancy.sql,
//   0003_ensure_personal_org.sql, 0004_plan_project_org_integrity.sql,
//   0005_usage_ledger.sql, 0006_org_member_role_cap.sql, 0007_org_keeps_an_owner.sql
//
// Stands up a throwaway database, applies bootstrap + every migration in order,
// runs rls.sql, then the concurrency races rls.sql cannot express, and fails on
// any FAIL line. Needs a reachable Postgres; SKIPs
// cleanly when there isn't one, so it never fails the board for the wrong reason.
//
// WHY A REAL DATABASE. RLS is the whole authorization model here — no server code
// sits between a browser and these tables. A policy can be read, agreed with, and
// still be wrong (an OR'd leftover policy, a predicate that silently matches zero
// rows, a SECURITY DEFINER function that recurses). The only instrument that
// settles it is Postgres itself, queried as the `authenticated` role.
//
// CAVEAT, STATED RATHER THAN BURIED: this runs against whatever local Postgres is
// on PATH (14.x here) while Supabase serves 17. Every feature the migrations use
// — enum ordering, GREATEST over enums, SECURITY DEFINER, gen_random_uuid — is
// PG13-era, so the gap is small; but it is a gap, and a version-specific policy
// bug would not be caught here.

import { execFile, execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const DB = process.env.RLS_TEST_DB || 'dsource_rls_test'

const psql = (args, opts = {}) =>
  execFileSync('psql', ['-v', 'ON_ERROR_STOP=1', ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts,
  })

try {
  psql(['-d', 'postgres', '-tAc', 'select 1'])
} catch {
  console.log('SKIP: no reachable Postgres (set PGHOST/PGPORT/PGUSER, or start one)')
  process.exit(0)
}

psql(['-d', 'postgres', '-c', `drop database if exists ${DB}`])
psql(['-d', 'postgres', '-c', `create database ${DB}`])

const step = (file, label) => {
  try {
    psql(['-d', DB, '-f', file])
  } catch (e) {
    console.log(`FAIL applying ${label}\n${(e.stderr || e.stdout || e.message).trim()}`)
    process.exit(1)
  }
}

step(path.join(here, 'bootstrap.sql'), 'bootstrap.sql')
step(path.join(here, '../migrations/0001_plans_cloud_sync.sql'), '0001_plans_cloud_sync.sql')
// Applying 0001 twice must be a no-op — it is transcribed from a schema that is
// already live, so idempotence is what makes it safe to run at all. This belongs
// HERE, at 0001's own point in history. Re-applying it AFTER 0002 is a different
// and unsupported operation: 0001 recreates the owner-only policies that 0002
// deliberately drops, Postgres ORs permissive policies together, and the result
// is a database where a revoked member still reaches every plan they created.
// The suite caught exactly that when this line sat below 0002 — three checks
// went red, including REVOKED-MEMBER. Migrations run once, in order.
step(path.join(here, '../migrations/0001_plans_cloud_sync.sql'), '0001 (re-applied)')

step(path.join(here, 'pre-tenancy-seed.sql'), 'pre-tenancy-seed.sql')
step(path.join(here, '../migrations/0002_tenancy.sql'), '0002_tenancy.sql')
step(path.join(here, '../migrations/0003_ensure_personal_org.sql'), '0003_ensure_personal_org.sql')
step(path.join(here, '../migrations/0004_plan_project_org_integrity.sql'), '0004_plan_project_org_integrity.sql')
step(path.join(here, '../migrations/0005_usage_ledger.sql'), '0005_usage_ledger.sql')
step(path.join(here, '../migrations/0006_org_member_role_cap.sql'), '0006_org_member_role_cap.sql')
step(path.join(here, '../migrations/0007_org_keeps_an_owner.sql'), '0007_org_keeps_an_owner.sql')

let out
try {
  out = psql(['-d', DB, '-f', path.join(here, 'rls.sql')])
} catch (e) {
  console.log(`FAIL running rls.sql\n${(e.stderr || e.stdout || e.message).trim()}`)
  process.exit(1)
}

const lines = out.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('ok|') || l.startsWith('FAIL|'))
if (lines.length === 0) {
  console.log('FAIL: rls.sql produced no checks — the harness is broken, not the policies')
  process.exit(1)
}

// ── the two checks rls.sql structurally cannot make ──────────────────────────
// "An organisation never reaches zero owners" is a check-then-act property, and
// its interesting failures need two transactions OVERLAPPING: two owners, each
// looking at a roster that still holds two owners, each removing the other one
// or itself. One psql session cannot produce that, so these live here — in the
// same tally, not in a comment promising they were considered.
//
// Both races were watched failing before 0007 existed, and each is the sole
// guard for one part of it: the DELETE race for the `for update` serialisation
// point, the UPDATE race for the trigger firing `after delete OR UPDATE` at all.
// Dropping `or update` leaves every one of rls.sql's checks green.
//
// rls.sql leaves the 'Duo' org (cc00) with exactly two owners, a6 and a7. The
// first race consumes one; the fixture is restored between races, as the table
// owner, and each race asserts it really started from two.
const CC00 = '00000000-0000-0000-0000-00000000cc00'
const A6 = '00000000-0000-0000-0000-0000000000a6'
const A7 = '00000000-0000-0000-0000-0000000000a7'
const owners = () => Number(psql(['-d', DB, '-tAc',
  `select count(*) from public.org_members where org_id = '${CC00}' and role = 'owner'`]).trim())

// One overlapping pair. `hold` keeps the first transaction open across the
// second's arrival, which is what makes the overlap deterministic rather than
// a hope about scheduling.
const concurrently = async (first, second, hold = 1) => {
  const fire = (stmt, uid, sleep) => new Promise((resolve) => {
    execFile('psql', ['-d', DB, '-tAc', `
      begin;
      select set_config('request.jwt.claim.sub', '${uid}', false);
      set local role authenticated;
      ${stmt}
      select pg_sleep(${sleep});
      commit;`], { encoding: 'utf8' }, (e, o, r) => resolve(`${o}${r}`))
  })
  const a = fire(first.stmt, first.uid, hold)
  await new Promise((r) => setTimeout(r, 300))
  const b = fire(second.stmt, second.uid, 0)
  await Promise.all([a, b])
}

const race = async (name, first, second) => {
  // Restore the fixture to two owners, as the table owner, and MEASURE that it
  // took — a race that starts from one owner passes for the wrong reason.
  psql(['-d', DB, '-c', `
    insert into public.org_members (org_id, user_id, role) values
      ('${CC00}', '${A6}', 'owner'), ('${CC00}', '${A7}', 'owner')
    on conflict (org_id, user_id) do update set role = 'owner'`])
  const before = owners()
  await concurrently(first, second)
  const after = owners()
  lines.push(before === 2 && after === 1
    ? `ok|${name}`
    : `FAIL|${name} — owners went ${before} → ${after}, want 2 → 1`)
}

const leaves = (uid) => ({ uid,
  stmt: `delete from public.org_members where org_id = '${CC00}' and user_id = '${uid}';` })
const demotes = (uid, victim) => ({ uid,
  stmt: `update public.org_members set role = 'viewer'
          where org_id = '${CC00}' and user_id = '${victim}';` })

await race('two owners LEAVING concurrently cannot both succeed', leaves(A6), leaves(A7))
await race('two owners DEMOTING each other concurrently cannot both succeed',
  demotes(A6, A7), demotes(A7, A6))

let failed = 0
for (const l of lines) {
  const [status, ...rest] = l.split('|')
  const name = rest.join('|')
  if (status === 'ok') console.log(`  ok   ${name}`)
  else { failed += 1; console.log(`  FAIL ${name}`) }
}

psql(['-d', 'postgres', '-c', `drop database if exists ${DB}`])

console.log(failed === 0
  ? `\nPASS  RLS — ${lines.length} checks green`
  : `\nFAIL  RLS — ${failed} of ${lines.length} failing`)
process.exit(failed === 0 ? 0 : 1)
