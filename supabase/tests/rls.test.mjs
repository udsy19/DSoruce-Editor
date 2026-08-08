// RLS behaviour suite runner. From the repo root:
//   PGHOST=127.0.0.1 PGPORT=54329 PGUSER=postgres node supabase/tests/rls.test.mjs
// @covers: supabase/migrations/0001_plans_cloud_sync.sql, 0002_tenancy.sql
//
// Stands up a throwaway database, applies bootstrap + both migrations in order,
// runs rls.sql, and fails on any FAIL line. Needs a reachable Postgres; SKIPs
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

import { execFileSync } from 'node:child_process'
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
