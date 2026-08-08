// deploy/apiCore.ts — env-agnostic core for the /api/agent, /api/claude and
// /api/bank proxies. ONE implementation, shared by two runtime adapters:
//   • deploy/server.ts  — the Node http server on the VPS (Caddy front)
//   • api/*.ts           — Vercel serverless functions
// There are NO http/fs/process side effects at import time; each adapter reads
// the request in its own way (Node stream vs Vercel `req.body`) and hands plain
// inputs here. This file is the lockstep source of truth for the three proxies
// and mirrors the dev middlewares in web/vite.config.ts — change them together.
//
// Env (all optional):
//   LLM_BASE_URL / LLM_API_KEY (or OPENAI_API_KEY) / LLM_MODEL   /api/agent
//   ANTHROPIC_API_KEY / ANTHROPIC_MODEL                          /api/claude
//   BANK_UPSTREAM                                                /api/bank origin
//   SUPABASE_URL / SUPABASE_ANON_KEY                             guard: identity
//   API_AUTH / ALLOWED_ORIGINS / API_RATE_PER_MIN / API_RATE_BURST   guard: policy

import { OPENAI_TOOLS, buildSystem } from '../web/src/ai/llmSchema'
import { metered } from './llmGateway'

/** A JSON response the adapter serialises: `res.status(status).json(json)`. */
export interface JsonResult {
  status: number
  json: unknown
}

// ---------------------------------------------------------------------------
// GUARD — the gate every token-spending call passes through.
//
// WHY THIS EXISTS. `/api/claude` and `/api/agent` forward to a metered upstream
// on OUR key. Before this guard they accepted any POST from any caller with no
// identity, no quota and no origin check, which made the entire variable cost
// of the product an open endpoint: anyone who read the client bundle could
// spend the Anthropic budget without limit, and nothing would have reported it.
//
// The guard is deliberately INSIDE `claudeComplete`/`agentComplete` rather than
// beside them. Their signatures now require the request headers, so a new
// adapter physically cannot reach the upstream without passing the material the
// guard needs — forgetting to call it is a type error, not a silent hole.
//
// Three layers, cheapest first:
//   1. Origin allowlist  — defence in depth only. Trivially spoofed outside a
//                          browser, so it is never the thing being relied on.
//   2. Bearer identity   — the actual gate. A Supabase access token, verified
//                          against the project's own /auth/v1/user endpoint, so
//                          this file needs no JWT library and no signing secret,
//                          and works with both legacy HS256 and asymmetric keys.
//   3. Per-user rate cap — a token bucket keyed by the verified user id.
//
// KNOWN LIMIT, STATED PLAINLY: layer 3 is per-process memory. On the single VPS
// service that is a real cap; on Vercel it is per-instance and resets on cold
// start, so it is a speed bump rather than a wall. It is NOT the backstop. The
// backstop is a hard spend cap set in the Anthropic console, which does not
// depend on this code being correct. A distributed limiter belongs with the
// usage ledger in the API service, not here.

/** Inbound request headers, as Node and Vercel both present them. */
export type HeaderBag = Record<string, string | string[] | undefined>

/** The caller, once established. `userId` is a Supabase user id, or the
 *  sentinel `'anonymous'` when the guard is explicitly disabled for local dev. */
export interface Identity {
  userId: string
  /** The verified bearer token, carried forward so the metering layer can act
   *  AS THE CALLER rather than with a service-role key — RLS then decides what
   *  it may read and write. `null` only when auth is disabled for local dev,
   *  which is exactly the case where there is no tenant to meter. */
  token: string | null
}

export type GuardOutcome =
  | { ok: true; identity: Identity }
  | { ok: false; deny: JsonResult }

function headerOf(h: HeaderBag, name: string): string | undefined {
  const v = h[name] ?? h[name.toUpperCase()]
  return Array.isArray(v) ? v[0] : v
}

function guardEnv() {
  const url = (process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '').replace(/\/+$/, '')
  const anonKey = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || ''
  const configured = !!url && !!anonKey
  // FAIL CLOSED. Once a Supabase project is configured, auth is required unless
  // an operator explicitly opts out — so forgetting to set API_AUTH in
  // production protects the endpoint instead of exposing it.
  const mode = (process.env.API_AUTH || (configured ? 'required' : 'off')).toLowerCase()
  return { url, anonKey, configured, mode }
}

// -- layer 2: identity -------------------------------------------------------

const TOKEN_TTL_MS = 60_000
const TOKEN_CACHE_MAX = 500
const tokenCache = new Map<string, { userId: string; until: number }>()

/** Resolve a Supabase access token to a user id, or null. Cached for 60 s so a
 *  burst of calls in one session costs one round trip, not one per request. */
async function verifyBearer(token: string, url: string, anonKey: string): Promise<string | null> {
  const now = Date.now()
  const hit = tokenCache.get(token)
  if (hit && hit.until > now) return hit.userId

  let upstream: Response
  try {
    upstream = await fetch(`${url}/auth/v1/user`, {
      headers: { authorization: `Bearer ${token}`, apikey: anonKey },
    })
  } catch {
    return null // network failure verifying identity → deny, never allow
  }
  if (!upstream.ok) return null
  const user = (await upstream.json().catch(() => null)) as { id?: string } | null
  const userId = user?.id
  if (!userId) return null

  if (tokenCache.size >= TOKEN_CACHE_MAX) tokenCache.clear()
  tokenCache.set(token, { userId, until: now + TOKEN_TTL_MS })
  return userId
}

// -- layer 3: rate limit -----------------------------------------------------

const buckets = new Map<string, { tokens: number; last: number }>()

/** Token bucket per identity. Refills at API_RATE_PER_MIN, caps at API_RATE_BURST. */
function withinRate(key: string): boolean {
  const perMin = Number(process.env.API_RATE_PER_MIN || 20)
  const burst = Number(process.env.API_RATE_BURST || 40)
  const now = Date.now()
  const b = buckets.get(key) ?? { tokens: burst, last: now }
  b.tokens = Math.min(burst, b.tokens + ((now - b.last) / 60_000) * perMin)
  b.last = now
  if (b.tokens < 1) {
    buckets.set(key, b)
    return false
  }
  b.tokens -= 1
  buckets.set(key, b)
  return true
}

let warnedOpen = false

/** Establish and authorise the caller. Exported so the dev middleware in
 *  `web/vite.config.ts` uses this implementation rather than a second copy. */
export async function guard(headers: HeaderBag): Promise<GuardOutcome> {
  const { url, anonKey, configured, mode } = guardEnv()

  // 1. Origin allowlist — skipped when unset, since we cannot guess the host.
  const allowed = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  const origin = headerOf(headers, 'origin')
  if (allowed.length && origin && !allowed.includes(origin)) {
    return { ok: false, deny: { status: 403, json: { error: 'Origin not allowed' } } }
  }

  // 2. Identity.
  if (mode === 'off') {
    if (!warnedOpen) {
      warnedOpen = true
      console.warn(
        '[apiCore] API_AUTH=off — /api/claude and /api/agent are UNAUTHENTICATED. ' +
          'Local development only. Never run this configuration on a public host.',
      )
    }
    return { ok: true, identity: { userId: 'anonymous', token: null } }
  }
  if (!configured) {
    return {
      ok: false,
      deny: {
        status: 503,
        json: { error: 'Auth required but SUPABASE_URL / SUPABASE_ANON_KEY are not configured' },
      },
    }
  }
  const authHeader = headerOf(headers, 'authorization') ?? ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : ''
  if (!token) return { ok: false, deny: { status: 401, json: { error: 'Sign in required' } } }

  const userId = await verifyBearer(token, url, anonKey)
  if (!userId) {
    return { ok: false, deny: { status: 401, json: { error: 'Invalid or expired session' } } }
  }

  // 3. Rate limit.
  if (!withinRate(userId)) {
    return {
      ok: false,
      deny: { status: 429, json: { error: 'Rate limit exceeded — try again shortly' } },
    }
  }
  return { ok: true, identity: { userId, token } }
}

/** Test seam: drop cached identities and rate-limit state. */
export function resetGuardState(): void {
  tokenCache.clear()
  buckets.clear()
  warnedOpen = false
}

// ---------------------------------------------------------------------------
// /api/agent — OpenAI-compatible chat/completions proxy (LLM driver, agent panel)

function agentEnv() {
  const baseUrl = process.env.LLM_BASE_URL || 'https://api.openai.com/v1'
  const apiKey = process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || ''
  const model = process.env.LLM_MODEL || 'gpt-4o-mini'
  // A local server (Ollama/LM Studio) needs no key; a cloud one does.
  const localish = /localhost|127\.0\.0\.1/.test(baseUrl)
  return { baseUrl, apiKey, model, configured: !!apiKey || localish }
}

/** GET /api/agent — readiness probe. */
export function agentInfo(): JsonResult {
  const { configured, model } = agentEnv()
  return { status: 200, json: { configured, model } }
}

/** POST /api/agent — forward a driver turn to the LLM, normalise tool calls.
 *  `headers` is required so the guard cannot be omitted by a new adapter. */
export async function agentComplete(
  body: Record<string, unknown>,
  reqHeaders: HeaderBag,
): Promise<JsonResult> {
  const gate = await guard(reqHeaders)
  if (!gate.ok) return gate.deny

  const { baseUrl, apiKey, model, configured } = agentEnv()
  if (!configured) return { status: 503, json: { error: 'No LLM endpoint configured' } }

  // `buildSystem` dereferences `context.zones` and `context.program` with no
  // guard of its own, so a POST missing either threw a TypeError and surfaced as
  // a 500 — an operator reading the logs would see a server fault where the
  // truth is a malformed request. Validate at the boundary and say so.
  const ctx = body.context as { zones?: unknown; program?: unknown } | undefined
  if (!ctx || !Array.isArray(ctx.zones) || !ctx.program) {
    return {
      status: 400,
      json: { error: 'context.zones (array) and context.program are required' },
    }
  }

  const messages = [
    { role: 'system', content: buildSystem(body.context as Parameters<typeof buildSystem>[0]) },
    ...(Array.isArray(body.history) ? body.history : []),
    { role: 'user', content: String(body.text ?? '') },
  ]
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (apiKey) headers.authorization = `Bearer ${apiKey}`

  const callUpstream = async () => {
    const upstream = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model, messages, tools: OPENAI_TOOLS, tool_choice: 'auto', temperature: 0.2 }),
    })
    return { status: upstream.status, data: await upstream.json() }
  }

  /** Shape the upstream body into this route's contract. */
  const shape = (data: any): JsonResult => {
    const msg = data?.choices?.[0]?.message ?? {}
    const tool_calls = (msg.tool_calls ?? []).map(
      (tc: { function?: { name?: string; arguments?: string } }) => ({
        name: tc.function?.name,
        arguments: tc.function?.arguments,
      }),
    )
    return { status: 200, json: { content: msg.content ?? null, tool_calls } }
  }

  const { url, anonKey, configured: authConfigured } = guardEnv()

  // Unmetered dev path, same as /api/claude: no tenant, no ledger.
  if (!gate.identity.token || !authConfigured) {
    const { status, data } = await callUpstream()
    if (status !== 200) return { status: 502, json: { error: data?.error ?? data } }
    return shape(data)
  }

  // Both spending routes go through ONE meter. `normalizeUsage` maps this
  // route's OpenAI-shaped `usage` onto the ledger's vocabulary, so a single
  // table answers "what did this org spend" regardless of provider.
  const result = await metered(
    { supabaseUrl: url, anonKey },
    gate.identity.token,
    'agent',
    model,
    callUpstream,
  )

  if ('overBudget' in result) {
    return {
      status: 402,
      json: { error: 'Monthly AI budget exhausted for this organisation', code: 'budget_exhausted' },
    }
  }
  if (!result.ledger.recorded) {
    console.error(
      `[llmGateway] UNRECORDED USAGE — user=${gate.identity.userId} model=${model} ` +
        `cost=${result.priced.costNanos}n rate=${result.priced.rateVersion}: ${result.ledger.error}`,
    )
  }
  if (result.status !== 200) {
    const d = result.data as { error?: unknown } | null
    return { status: 502, json: { error: d?.error ?? d } }
  }
  return shape(result.data)
}

// ---------------------------------------------------------------------------
// /api/claude — Anthropic Messages proxy (refine loop, evaluator, designer)

function claudeEnv() {
  return {
    apiKey: process.env.ANTHROPIC_API_KEY || '',
    model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-5',
  }
}

/** GET /api/claude — readiness probe. */
export function claudeInfo(): JsonResult {
  const { apiKey, model } = claudeEnv()
  return { status: 200, json: { configured: !!apiKey, model } }
}

/** POST /api/claude — forward a Messages request; optional tools/tool_choice.
 *  `headers` is required so the guard cannot be omitted by a new adapter. */
export async function claudeComplete(
  body: Record<string, unknown>,
  reqHeaders: HeaderBag,
): Promise<JsonResult> {
  const gate = await guard(reqHeaders)
  if (!gate.ok) return gate.deny

  const { apiKey, model } = claudeEnv()
  if (!apiKey) return { status: 503, json: { error: 'No ANTHROPIC_API_KEY configured' } }

  const payload: Record<string, unknown> = {
    model,
    system: body.system,
    messages: body.messages,
    max_tokens: typeof body.max_tokens === 'number' ? body.max_tokens : 1024,
  }
  // Optional Anthropic-format tools (the ClaudeDriver sends them; the evaluator
  // doesn't). Optional tool_choice — the designer FORCES design_layout, which
  // disables extended thinking so the tool call arrives complete.
  if (Array.isArray(body.tools)) payload.tools = body.tools
  if (body.tool_choice) payload.tool_choice = body.tool_choice

  const callUpstream = async () => {
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(payload),
    })
    return { status: upstream.status, data: await upstream.json() }
  }

  const { url, anonKey, configured } = guardEnv()

  // Unmetered path: local dev with API_AUTH=off. There is no tenant to bill and
  // no ledger to write to, so the call goes straight out — the same behaviour
  // this proxy has always had. Every OTHER path is metered.
  if (!gate.identity.token || !configured) {
    const { status, data } = await callUpstream()
    if (status !== 200) return { status: 502, json: { error: data?.error ?? data } }
    return { status: 200, json: data }
  }

  const result = await metered(
    { supabaseUrl: url, anonKey },
    gate.identity.token,
    'claude',
    model,
    callUpstream,
  )

  // Over budget. 402 rather than 429: this is not "slow down", it is "the
  // organisation's cap for this month is spent", and the fix is a billing
  // decision by an admin, not a retry.
  if ('overBudget' in result) {
    return {
      status: 402,
      json: { error: 'Monthly AI budget exhausted for this organisation', code: 'budget_exhausted' },
    }
  }

  // A ledger write that failed is reported but never fails the request — the
  // tokens are already spent and the caller cannot un-spend them. It is logged
  // loudly because unbilled usage is a revenue hole, not a cosmetic problem.
  if (!result.ledger.recorded) {
    console.error(
      `[llmGateway] UNRECORDED USAGE — user=${gate.identity.userId} model=${model} ` +
        `cost=${result.priced.costNanos}n rate=${result.priced.rateVersion}: ${result.ledger.error}`,
    )
  }

  if (result.status !== 200) {
    const d = result.data as { error?: unknown } | null
    return { status: 502, json: { error: d?.error ?? d } }
  }
  return { status: 200, json: result.data }
}

// ---------------------------------------------------------------------------
// /api/bank/* — reverse proxy to the material-bank origin (no CORS upstream, so
// same-origin proxying is mandatory). Rewrites /api/bank → /api and returns the
// raw fetch Response for the adapter to stream both ways.

const BANK_UPSTREAM = (process.env.BANK_UPSTREAM || 'https://46.202.179.28.sslip.io').replace(/\/$/, '')

/** Forward one /api/bank/* request; caller streams the returned Response out. */
export function bankFetch(
  method: string,
  pathname: string,
  search: string,
  reqHeaders: Record<string, string | string[] | undefined>,
  body?: BodyInit,
): Promise<Response> {
  const target = BANK_UPSTREAM + pathname.replace(/^\/api\/bank/, '/api') + search
  const headers: Record<string, string> = {}
  for (const h of ['content-type', 'accept', 'authorization']) {
    const v = reqHeaders[h]
    if (typeof v === 'string') headers[h] = v
  }
  const init: RequestInit & { duplex?: 'half' } = { method, headers }
  if (method !== 'GET' && method !== 'HEAD' && body) {
    init.body = body
    init.duplex = 'half'
  }
  return fetch(target, init)
}
