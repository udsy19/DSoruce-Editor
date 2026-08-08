// The guard on the token-spending proxies. Run from web/:
//   node ../deploy/apiCore.test.mjs
// @covers: deploy/apiCore.ts  (guard · claudeComplete · agentComplete)
//
// WHAT THIS ASSERTS, AND WHY IT IS SHAPED THIS WAY.
//
// The defect being guarded is not "the endpoint returns the wrong status code".
// It is "an unidentified caller can spend money on our upstream key". A test
// that only checks for a 401 would pass even if the handler answered 401 AFTER
// forwarding the request — emission is not visibility (`.claude/rules/
// gate-independence.md`). So the load-bearing assertion here is negative and
// structural: on every denied path, `api.anthropic.com` and the LLM base URL
// are NEVER contacted. That is measured by counting upstream calls through an
// injected fetch, not by trusting the handler's own account of what it did.
//
// The guard's inputs are also not taken from the thing under test: identity is
// resolved against a stubbed Supabase /auth/v1/user, and the stub decides who
// is valid. The handler cannot influence that verdict.
//
// FALSIFICATION RUN (recorded, not assumed) — with the two `guard()` calls
// removed from claudeComplete/agentComplete, this file reports:
//   FAIL no-token POST must not reach the upstream — upstream calls: 1
// i.e. the money-spending call goes through. With the guard in place: 0.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const webRequire = createRequire(path.join(here, '../web/package.json'))
const esbuildPath = createRequire(webRequire.resolve('vite')).resolve('esbuild')
const { build } = await import(pathToFileURL(esbuildPath).href)

const outFile = path.join(os.tmpdir(), `ds-guard-${process.pid}.mjs`)
await build({
  entryPoints: [path.join(here, 'apiCore.ts')],
  outfile: outFile, bundle: true, format: 'esm', platform: 'node', logLevel: 'silent',
})
const { guard, claudeComplete, agentComplete, resetGuardState } =
  await import(pathToFileURL(outFile).href)
fs.rmSync(outFile, { force: true })

// ── the injected world ──────────────────────────────────────────────────────
// One fetch stub serves both roles: it answers the identity probe, and it
// COUNTS any call to a paid upstream. The count is the measurement.

const SUPABASE = 'https://stub.supabase.co'
const VALID = 'valid-token'
const ORG = '00000000-0000-0000-0000-0000000000aa'
let upstreamCalls = 0
let identityProbes = 0
let ledgerRows = []
/** null = uncapped; a bigint string = nanodollars remaining this month. */
let budgetRemaining = null
/** Set to a status code to make the ledger write fail. */
let ledgerFailsWith = 0

globalThis.fetch = async (url, init) => {
  const u = String(url)

  if (u.startsWith(SUPABASE)) {
    const path = u.slice(SUPABASE.length)

    if (path.startsWith('/auth/v1/user')) {
      identityProbes += 1
      const auth = init?.headers?.authorization ?? ''
      return auth === `Bearer ${VALID}`
        ? new Response(JSON.stringify({ id: 'user-1' }), { status: 200 })
        : new Response(JSON.stringify({ error: 'bad jwt' }), { status: 401 })
    }
    if (path.startsWith('/rest/v1/rpc/default_org_of_current_user')) {
      return new Response(JSON.stringify(ORG), { status: 200 })
    }
    if (path.startsWith('/rest/v1/rpc/org_budget_remaining')) {
      // PostgREST returns bigint as a STRING; the stub must too, or the test
      // would validate a wire shape the real database never sends.
      return new Response(JSON.stringify(budgetRemaining), { status: 200 })
    }
    if (path.startsWith('/rest/v1/usage_events')) {
      if (ledgerFailsWith) {
        return new Response(JSON.stringify({ message: 'nope' }), { status: ledgerFailsWith })
      }
      ledgerRows.push(JSON.parse(init.body))
      return new Response('', { status: 201 })
    }
    return new Response('{}', { status: 404 })
  }

  // Anything else is a metered upstream. Reaching here on a denied or
  // over-budget path is the bug this suite exists to catch.
  upstreamCalls += 1
  // Two providers, two usage vocabularies. Anthropic's Messages API reports
  // input_tokens/output_tokens; an OpenAI-compatible endpoint reports
  // prompt_tokens/completion_tokens. The stub answers in the shape the route
  // being exercised would really receive, so `normalizeUsage` is genuinely
  // under test rather than handed pre-normalised data.
  const isAnthropic = u.includes('anthropic.com')
  return new Response(
    JSON.stringify({
      content: [], choices: [{ message: { content: 'ok', tool_calls: [] } }],
      usage: isAnthropic
        ? { input_tokens: 1000, output_tokens: 200 }
        : { prompt_tokens: 700, completion_tokens: 90 },
    }),
    { status: 200 },
  )
}

function withEnv(env, fn) {
  const saved = { ...process.env }
  Object.assign(process.env, env)
  for (const k of Object.keys(env)) if (env[k] === undefined) delete process.env[k]
  resetGuardState()
  upstreamCalls = 0
  identityProbes = 0
  ledgerRows = []
  budgetRemaining = null
  ledgerFailsWith = 0
  return Promise.resolve(fn()).finally(() => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
    Object.assign(process.env, saved)
  })
}

const SECURED = {
  SUPABASE_URL: SUPABASE,
  SUPABASE_ANON_KEY: 'anon',
  ANTHROPIC_API_KEY: 'sk-test',
  LLM_API_KEY: 'sk-test',
  API_AUTH: undefined,          // unset on purpose — must default to REQUIRED
  ALLOWED_ORIGINS: undefined,
  API_RATE_PER_MIN: undefined,
  API_RATE_BURST: undefined,
}
const bearer = (t) => ({ authorization: `Bearer ${t}` })

// The minimum DriverContext `buildSystem` will accept. Noted while writing this:
// `agentComplete` dereferences `body.context.zones` with no validation, so a
// POST missing `context` throws rather than returning 400. Pre-existing and out
// of scope for the guard, but it belongs on the list — see the summary.
const AGENT_CTX = {
  zones: [],
  selection: null,
  counts: {},
  program: { desks: 0, meeting_rooms: 0, target_corridor_m: 1.2 },
}

let failures = 0
const check = (name, cond, detail = '') => {
  if (cond) { console.log(`  ok   ${name}`) }
  else { failures += 1; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`) }
}

console.log('guard — identity')

// 1. FAIL CLOSED BY DEFAULT. API_AUTH unset + Supabase configured => required.
//    This is the property that makes a forgotten env var safe rather than fatal.
await withEnv(SECURED, async () => {
  const r = await claudeComplete({ messages: [] }, {})
  check('no token is rejected', r.status === 401, `got ${r.status}`)
  check('no-token POST must not reach the upstream', upstreamCalls === 0,
        `upstream calls: ${upstreamCalls}`)
})

// 2. A token the identity provider rejects is rejected here too — and again,
//    nothing is spent. The verdict comes from the stub, never from the handler.
await withEnv(SECURED, async () => {
  const r = await claudeComplete({ messages: [] }, bearer('forged'))
  check('forged token is rejected', r.status === 401, `got ${r.status}`)
  check('forged-token POST must not reach the upstream', upstreamCalls === 0,
        `upstream calls: ${upstreamCalls}`)
  check('identity was actually checked', identityProbes === 1, `probes: ${identityProbes}`)
})

// 3. The positive case must still work, or the guard has broken the product.
await withEnv(SECURED, async () => {
  const r = await claudeComplete({ messages: [] }, bearer(VALID))
  check('valid token is allowed through', r.status === 200, `got ${r.status}`)
  check('valid-token POST reaches the upstream exactly once', upstreamCalls === 1,
        `upstream calls: ${upstreamCalls}`)
})

// 4. Same contract on the other spending route — one guard, both doors.
await withEnv(SECURED, async () => {
  const denied = await agentComplete({ text: 'hi', context: AGENT_CTX }, {})
  check('agent: no token is rejected', denied.status === 401, `got ${denied.status}`)
  check('agent: no-token POST must not reach the upstream', upstreamCalls === 0,
        `upstream calls: ${upstreamCalls}`)
  const ok = await agentComplete({ text: 'hi', context: AGENT_CTX }, bearer(VALID))
  check('agent: valid token is allowed through', ok.status === 200, `got ${ok.status}`)
})

// 5. Identity caching must not become an auth bypass: a cached VALID token is
//    reused, but a DIFFERENT token still gets its own verdict.
await withEnv(SECURED, async () => {
  await claudeComplete({ messages: [] }, bearer(VALID))
  await claudeComplete({ messages: [] }, bearer(VALID))
  check('valid token is verified once, then cached', identityProbes === 1,
        `probes: ${identityProbes}`)
  const r = await claudeComplete({ messages: [] }, bearer('forged'))
  check('cache does not launder a different token', r.status === 401, `got ${r.status}`)
})

console.log('guard — policy')

// 6. Rate limit. Burst of 2 means the third call in the window is refused, and
//    the refusal must also cost nothing upstream.
await withEnv({ ...SECURED, API_RATE_PER_MIN: '1', API_RATE_BURST: '2' }, async () => {
  const a = await claudeComplete({ messages: [] }, bearer(VALID))
  const b = await claudeComplete({ messages: [] }, bearer(VALID))
  const c = await claudeComplete({ messages: [] }, bearer(VALID))
  check('burst is allowed', a.status === 200 && b.status === 200,
        `got ${a.status}/${b.status}`)
  check('over-burst is refused with 429', c.status === 429, `got ${c.status}`)
  check('refused call spends nothing', upstreamCalls === 2, `upstream calls: ${upstreamCalls}`)
})

// 7. Origin allowlist, when configured, blocks a foreign origin before identity
//    is even consulted — cheapest layer first.
await withEnv({ ...SECURED, ALLOWED_ORIGINS: 'https://app.dsource.studio' }, async () => {
  const bad = await claudeComplete({ messages: [] }, {
    ...bearer(VALID), origin: 'https://evil.example',
  })
  check('foreign origin is refused', bad.status === 403, `got ${bad.status}`)
  check('foreign origin spends nothing', upstreamCalls === 0, `upstream calls: ${upstreamCalls}`)
  check('foreign origin short-circuits before identity', identityProbes === 0,
        `probes: ${identityProbes}`)
  const good = await claudeComplete({ messages: [] }, {
    ...bearer(VALID), origin: 'https://app.dsource.studio',
  })
  check('allowed origin passes', good.status === 200, `got ${good.status}`)
})

// 8. The local-dev escape hatch works, and ONLY when asked for explicitly.
await withEnv({ ...SECURED, API_AUTH: 'off' }, async () => {
  const r = await claudeComplete({ messages: [] }, {})
  check('API_AUTH=off allows an unauthenticated call (dev only)', r.status === 200,
        `got ${r.status}`)
})

// 9. Auth demanded but no identity provider configured => refuse, never open up.
await withEnv({ ...SECURED, SUPABASE_URL: undefined, SUPABASE_ANON_KEY: undefined,
                API_AUTH: 'required' }, async () => {
  const r = await claudeComplete({ messages: [] }, bearer(VALID))
  check('misconfigured auth fails closed, not open', r.status === 503, `got ${r.status}`)
  check('misconfigured auth spends nothing', upstreamCalls === 0,
        `upstream calls: ${upstreamCalls}`)
})

// 10. guard() is exported and usable standalone — the dev middleware in
//     web/vite.config.ts calls exactly this, rather than carrying a second copy.
await withEnv(SECURED, async () => {
  const denied = await guard({})
  const allowed = await guard(bearer(VALID))
  check('guard() denies anonymously', denied.ok === false && denied.deny.status === 401)
  check('guard() returns the identity it verified',
        allowed.ok === true && allowed.identity.userId === 'user-1',
        JSON.stringify(allowed))
})


console.log('gateway — metering')

// A metered call must write exactly one ledger row, and that row must carry the
// tokens the upstream actually reported — not an estimate, and not the request's
// own idea of what it would use.
await withEnv(SECURED, async () => {
  const r = await claudeComplete({ messages: [] }, bearer(VALID))
  check('a metered call succeeds', r.status === 200, `got ${r.status}`)
  check('exactly one ledger row is written', ledgerRows.length === 1,
        `rows: ${ledgerRows.length}`)
  const row = ledgerRows[0] ?? {}
  check('the row carries the tokens the UPSTREAM reported',
        row.input_tokens === 1000 && row.output_tokens === 200,
        JSON.stringify(row))
  // 1000 in * 3000n + 200 out * 15000n = 3,000,000 + 3,000,000 = 6,000,000n
  check('the row carries an exactly-priced cost as a string',
        row.cost_nanos === '6000000', `cost_nanos=${row.cost_nanos}`)
  check('the row records which rate card priced it', typeof row.rate_version === 'string' && !!row.rate_version)
  check('the row is attributed to the resolved organisation', row.org_id === ORG)
  check('the row does NOT carry user_id — the insert policy pins it',
        !('user_id' in row), JSON.stringify(Object.keys(row)))
})

// The cap must be enforced BEFORE the call. A cap checked afterwards is a
// report, not a limit — the money is already gone.
await withEnv(SECURED, async () => {
  budgetRemaining = '0'
  const r = await claudeComplete({ messages: [] }, bearer(VALID))
  check('an exhausted budget returns 402', r.status === 402, `got ${r.status}`)
  check('...and the upstream is never contacted', upstreamCalls === 0,
        `upstream calls: ${upstreamCalls}`)
  check('...and nothing is added to the ledger', ledgerRows.length === 0)
  check('...with a machine-readable reason', r.json?.code === 'budget_exhausted',
        JSON.stringify(r.json))
})

await withEnv(SECURED, async () => {
  budgetRemaining = '100000000'   // $0.10 left
  const r = await claudeComplete({ messages: [] }, bearer(VALID))
  check('a budget with headroom still allows the call', r.status === 200, `got ${r.status}`)
  check('...and still meters it', ledgerRows.length === 1)
})

await withEnv(SECURED, async () => {
  budgetRemaining = null          // uncapped
  const r = await claudeComplete({ messages: [] }, bearer(VALID))
  check('an uncapped org is not blocked', r.status === 200, `got ${r.status}`)
})

// A ledger failure must not fail the request: the tokens are already spent
// upstream and the caller cannot un-spend them. Losing the row is a revenue
// problem to alert on, not a reason to also lose the user's work.
await withEnv(SECURED, async () => {
  ledgerFailsWith = 500
  const r = await claudeComplete({ messages: [] }, bearer(VALID))
  check('a failed ledger write does not fail the request', r.status === 200, `got ${r.status}`)
  check('...and the upstream call still happened exactly once', upstreamCalls === 1)
})

// The local-dev path has no tenant, so it must not try to meter — and must not
// silently start spending against nobody's budget either.
await withEnv({ ...SECURED, API_AUTH: 'off' }, async () => {
  const r = await claudeComplete({ messages: [] }, {})
  check('the unmetered dev path still works', r.status === 200, `got ${r.status}`)
  check('...and writes no ledger row (there is no tenant)', ledgerRows.length === 0,
        `rows: ${ledgerRows.length}`)
})



console.log('gateway — /api/agent parity')

// Both spending routes must go through the same meter. An unmetered second door
// is the whole point of having a gateway defeated.
await withEnv(SECURED, async () => {
  const r = await agentComplete({ text: 'hi', context: AGENT_CTX }, bearer(VALID))
  check('an agent call succeeds', r.status === 200, `got ${r.status}`)
  check('an agent call is metered too', ledgerRows.length === 1, `rows: ${ledgerRows.length}`)
  check('...and is attributed to the agent route', ledgerRows[0]?.route === 'agent',
        `route=${ledgerRows[0]?.route}`)
  // The stub returns the OpenAI shape (prompt_tokens/completion_tokens). If
  // normalizeUsage were missing, these would land as zeros and the row would
  // silently under-bill rather than fail.
  check('the OpenAI usage shape is normalised into the ledger vocabulary',
        ledgerRows[0]?.input_tokens === 700 && ledgerRows[0]?.output_tokens === 90,
        JSON.stringify(ledgerRows[0]))
})

await withEnv(SECURED, async () => {
  budgetRemaining = '0'
  const r = await agentComplete({ text: 'hi', context: AGENT_CTX }, bearer(VALID))
  check('agent: an exhausted budget returns 402', r.status === 402, `got ${r.status}`)
  check('agent: ...and the upstream is never contacted', upstreamCalls === 0,
        `upstream calls: ${upstreamCalls}`)
})

// A model with no rate card entry must be flagged, not silently free. This is
// live for /api/agent today: gpt-4o-mini is not on an Anthropic rate card.
await withEnv(SECURED, async () => {
  const r = await agentComplete({ text: 'hi', context: AGENT_CTX }, bearer(VALID))
  check('an off-card model is recorded as unpriced, not as zero-cost silence',
        r.status === 200 && ledgerRows[0]?.unpriced === true,
        JSON.stringify(ledgerRows[0]))
})

console.log('boundary validation')

await withEnv(SECURED, async () => {
  const r = await agentComplete({ text: 'hi' }, bearer(VALID))
  check('a body with no context is a 400, not a 500', r.status === 400, `got ${r.status}`)
  check('...and costs nothing', upstreamCalls === 0 && ledgerRows.length === 0)
})

await withEnv(SECURED, async () => {
  const r = await agentComplete({ text: 'hi', context: { zones: [] } }, bearer(VALID))
  check('a context missing `program` is also a 400', r.status === 400, `got ${r.status}`)
})


console.log(failures === 0
  ? `\nPASS  apiCore guard — all checks green`
  : `\nFAIL  apiCore guard — ${failures} failing`)
process.exit(failures === 0 ? 0 : 1)
