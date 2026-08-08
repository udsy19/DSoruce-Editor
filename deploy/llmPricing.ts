// deploy/llmPricing.ts — what a model call costs, and how that is recorded.
//
// TWO DECISIONS HERE ARE LOAD-BEARING.
//
// 1. MONEY IS AN INTEGER. Costs are nanodollars (1e-9 USD) as `bigint`, never
//    floats. Anthropic prices are dollars per million tokens, so every rate is
//    an exact integer in these units — $3/MTok is 3000 nanodollars per token,
//    with nothing to round. Summing a month of usage is then exact addition.
//    A float ledger drifts, and it drifts in the direction nobody notices until
//    an invoice is disputed.
//
// 2. THE RATE IS RECORDED, NOT RE-DERIVED. Every usage row stores the rate
//    version that priced it. Prices move — Sonnet 5's introductory $2/$10 ends
//    2026-08-31 and becomes $3/$15 — and a ledger that recomputes historical
//    cost from today's table silently rewrites what last month cost. Storing
//    `rate_version` makes a past month reproducible and an audit answerable.
//    That is why RATES below is append-only and versions are never edited.

/** Nanodollars (1e-9 USD). Integer arithmetic end to end. */
export type Nanos = bigint

export interface ModelRate {
  /** Per input token. */
  input: Nanos
  /** Per output token. */
  output: Nanos
  /** Per token read from the prompt cache — ~0.1x input. */
  cacheRead: Nanos
  /** Per token written to the prompt cache — 1.25x input at the 5-minute TTL. */
  cacheWrite: Nanos
}

/** The current rate card. BUMP THE VERSION AND ADD A NEW ENTRY when prices
 *  change; never edit an existing one, or historical rows reprice themselves. */
export const RATE_VERSION = '2026-09-01' as const

const M = 1_000n // dollars-per-MTok → nanodollars-per-token: $1/MTok = 1000 n/token

export const RATES: Record<string, ModelRate> = {
  // Post-introductory list prices. Sonnet 5's intro rate ($2/$10) lapses
  // 2026-08-31; this card is the rate that applies from 2026-09-01.
  'claude-opus-5':    { input: 5n * M, output: 25n * M, cacheRead: 500n,  cacheWrite: 6250n },
  'claude-sonnet-5':  { input: 3n * M, output: 15n * M, cacheRead: 300n,  cacheWrite: 3750n },
  'claude-haiku-4-5': { input: 1n * M, output: 5n * M,  cacheRead: 100n,  cacheWrite: 1250n },
  'claude-opus-4-8':  { input: 5n * M, output: 25n * M, cacheRead: 500n,  cacheWrite: 6250n },
}

/** Token counts as the Messages API reports them in `usage`. */
export interface TokenUsage {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

/** The OpenAI-compatible shape `/api/agent` receives (Cerebras, OpenAI, Ollama). */
interface OpenAiUsage {
  prompt_tokens?: number
  completion_tokens?: number
}

/**
 * Normalise either provider's `usage` block into the Anthropic shape.
 *
 * Both routes bill through one ledger, so the ledger needs one vocabulary. Doing
 * this here rather than at the call site means a third provider is a case in one
 * function, not a second set of column meanings — and it keeps `priceUsage`
 * from having to know which route it is serving.
 */
export function normalizeUsage(raw: unknown): TokenUsage | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const u = raw as TokenUsage & OpenAiUsage
  // Anthropic's names win when present; an OpenAI response has neither.
  if (u.input_tokens !== undefined || u.output_tokens !== undefined) return u
  if (u.prompt_tokens !== undefined || u.completion_tokens !== undefined) {
    return { input_tokens: u.prompt_tokens ?? 0, output_tokens: u.completion_tokens ?? 0 }
  }
  return undefined
}

export interface PricedUsage {
  model: string
  rateVersion: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  costNanos: Nanos
  /** True when the model was not on the rate card — cost is 0 and the row is
   *  flagged rather than silently dropped or guessed at. */
  unpriced: boolean
}

/**
 * Price one call.
 *
 * An UNKNOWN MODEL is recorded with `unpriced: true` and zero cost rather than
 * throwing or being estimated from a neighbour. Throwing would fail a request
 * the user already paid for upstream; estimating would put a number nobody can
 * defend into a billing ledger. A zero with a flag is the only honest option,
 * and it is queryable — `select … where unpriced` is the alert that a model was
 * rolled out without its rate.
 */
export function priceUsage(model: string, usage: TokenUsage | undefined): PricedUsage {
  const inputTokens = usage?.input_tokens ?? 0
  const outputTokens = usage?.output_tokens ?? 0
  const cacheReadTokens = usage?.cache_read_input_tokens ?? 0
  const cacheWriteTokens = usage?.cache_creation_input_tokens ?? 0

  const rate = RATES[model]
  if (!rate) {
    return {
      model, rateVersion: RATE_VERSION,
      inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens,
      costNanos: 0n, unpriced: true,
    }
  }

  const costNanos =
    BigInt(inputTokens) * rate.input +
    BigInt(outputTokens) * rate.output +
    BigInt(cacheReadTokens) * rate.cacheRead +
    BigInt(cacheWriteTokens) * rate.cacheWrite

  return {
    model, rateVersion: RATE_VERSION,
    inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens,
    costNanos, unpriced: false,
  }
}

/** Nanodollars → a display string in USD. Presentation only — never round-trip
 *  money through this. */
export function formatNanos(n: Nanos): string {
  const cents = n / 10_000_000n // 1 cent = 1e7 nanodollars
  const whole = cents / 100n
  const frac = (cents % 100n).toString().padStart(2, '0')
  return `$${whole}.${frac}`
}
