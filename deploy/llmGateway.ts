// deploy/llmGateway.ts — the metered path to a paid model.
//
// Phase 0's guard answered "who is calling, and are they going too fast". That
// bounds requests, not money: twenty cheap calls and twenty expensive ones look
// identical to a rate limiter. This adds the two things that actually govern the
// bill — a per-tenant spend cap checked BEFORE the call, and a ledger row
// written AFTER it.
//
// ORDERING IS THE WHOLE DESIGN:
//
//   resolve tenant → check budget → call upstream → record usage
//                         │                              │
//                    refuse here                   never skipped
//
// Checking after the call would let a tenant blow through any cap by one
// request; recording before it would bill for calls that never happened. The
// ledger write is in a `finally`-shaped path so an upstream error still records
// what was spent getting there — a failed call that consumed input tokens cost
// real money, and a ledger that only counts successes understates the bill.
//
// LEAST PRIVILEGE. Every database call here goes through PostgREST with the
// CALLER'S OWN bearer token, not a service-role key. So RLS decides what may be
// read and written, the insert policy pins `user_id` to the caller, and a bug in
// this file cannot write another tenant's ledger. Holding a service-role key in
// the API process would make this code the security boundary; this way the
// database stays the boundary and this file is just a client.

import { normalizeUsage, priceUsage, type PricedUsage } from './llmPricing'

export interface GatewayEnv {
  supabaseUrl: string
  anonKey: string
}

export interface TenantContext {
  orgId: string
  /** Nanodollars left this month; null when the org has no cap. */
  remainingNanos: bigint | null
}

/** PostgREST RPC as the signed-in user. */
async function rpc(
  env: GatewayEnv,
  token: string,
  fn: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const r = await fetch(`${env.supabaseUrl}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      apikey: env.anonKey,
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(args),
  })
  if (!r.ok) throw new Error(`rpc ${fn}: ${r.status} ${(await r.text()).slice(0, 200)}`)
  return r.json()
}

/** Which organisation this call is billed to, and what is left of its budget. */
export async function resolveTenant(env: GatewayEnv, token: string): Promise<TenantContext | null> {
  const orgId = (await rpc(env, token, 'default_org_of_current_user', {})) as string | null
  if (!orgId) return null
  const remaining = (await rpc(env, token, 'org_budget_remaining', { p_org: orgId })) as
    | string
    | number
    | null
  return {
    orgId,
    // PostgREST returns bigint as a STRING to avoid the float53 precision cliff.
    // Parsing it as a Number would quietly lose precision above 9e15 nanodollars
    // (~$9M) — unlikely, but the cost of being right here is one BigInt call.
    remainingNanos: remaining === null || remaining === undefined ? null : BigInt(remaining),
  }
}

/** Append one usage row. Failures are reported, never thrown: losing a ledger
 *  row is bad, but failing a call the user already paid for upstream is worse,
 *  and the caller cannot un-spend those tokens. Surfaced so it can be alerted on
 *  rather than swallowed. */
export async function recordUsage(
  env: GatewayEnv,
  token: string,
  tenant: TenantContext,
  route: string,
  priced: PricedUsage,
): Promise<{ recorded: boolean; error?: string }> {
  try {
    const r = await fetch(`${env.supabaseUrl}/rest/v1/usage_events`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        apikey: env.anonKey,
        authorization: `Bearer ${token}`,
        prefer: 'return=minimal',
      },
      body: JSON.stringify({
        org_id: tenant.orgId,
        route,
        model: priced.model,
        input_tokens: priced.inputTokens,
        output_tokens: priced.outputTokens,
        cache_read_tokens: priced.cacheReadTokens,
        cache_write_tokens: priced.cacheWriteTokens,
        // bigint over the wire as a string — same precision reasoning as above.
        cost_nanos: priced.costNanos.toString(),
        rate_version: priced.rateVersion,
        unpriced: priced.unpriced,
        // `user_id` is deliberately NOT sent. The insert policy pins it to
        // auth.uid(); sending it would be a value this process could get wrong.
      }),
    })
    if (!r.ok) return { recorded: false, error: `${r.status} ${(await r.text()).slice(0, 200)}` }
    return { recorded: true }
  } catch (e) {
    return { recorded: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export interface MeteredResult {
  /** The upstream JSON, whatever it was. */
  data: unknown
  /** Upstream HTTP status. */
  status: number
  priced: PricedUsage
  ledger: { recorded: boolean; error?: string }
}

/**
 * Run one upstream call inside the meter.
 *
 * `call()` performs the actual request and returns its status and parsed body;
 * this function owns everything around it. Returns `null` when the tenant is
 * over budget, so the caller can answer 402 without having spent anything.
 */
export async function metered(
  env: GatewayEnv,
  token: string,
  route: string,
  model: string,
  call: () => Promise<{ status: number; data: unknown }>,
): Promise<{ overBudget: true; tenant: TenantContext } | MeteredResult> {
  const tenant = await resolveTenant(env, token)
  if (!tenant) throw new Error('No organisation for this caller')

  // Refuse BEFORE spending. A cap enforced after the fact is a report.
  if (tenant.remainingNanos !== null && tenant.remainingNanos <= 0n) {
    return { overBudget: true, tenant }
  }

  const { status, data } = await call()

  // Record whatever was consumed, including on an upstream error — a 4xx that
  // still burned input tokens cost money, and a success-only ledger understates.
  const priced = priceUsage(model, normalizeUsage((data as { usage?: unknown } | null)?.usage))
  const ledger = await recordUsage(env, token, tenant, route, priced)

  return { data, status, priced, ledger }
}
