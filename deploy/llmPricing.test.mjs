// Cost arithmetic for the usage ledger. Run from web/:
//   node ../deploy/llmPricing.test.mjs
// @covers: deploy/llmPricing.ts
//
// This is billing code, so the assertions are about EXACTNESS, not plausibility.
// The three properties that matter:
//   1. Integer money — no float anywhere, so a month of usage sums exactly.
//   2. An unknown model is flagged, never guessed at or dropped.
//   3. Every priced row carries the rate version that produced it, so a price
//      change cannot retroactively rewrite what last month cost.

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
const outFile = path.join(os.tmpdir(), `ds-pricing-${process.pid}.mjs`)
await build({
  entryPoints: [path.join(here, 'llmPricing.ts')],
  outfile: outFile, bundle: true, format: 'esm', platform: 'node', logLevel: 'silent',
})
const { priceUsage, formatNanos, normalizeUsage, RATES, RATE_VERSION } = await import(pathToFileURL(outFile).href)
fs.rmSync(outFile, { force: true })

let failed = 0
const check = (name, cond, detail = '') => {
  if (cond) console.log(`  ok   ${name}`)
  else { failed += 1; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`) }
}

// ── the arithmetic ───────────────────────────────────────────────────────────
// Hand-computed, not derived from the table the code reads — a test that
// recomputes the answer the same way the implementation does only proves the
// expression was typed twice.
//
// Sonnet 5 at $3/$15 per MTok: 1,000,000 in = $3.00 = 3e9 nanodollars.
{
  const p = priceUsage('claude-sonnet-5', { input_tokens: 1_000_000, output_tokens: 0 })
  check('1M Sonnet input tokens costs exactly $3', p.costNanos === 3_000_000_000n,
        `got ${p.costNanos}`)
}
{
  const p = priceUsage('claude-sonnet-5', { input_tokens: 0, output_tokens: 1_000_000 })
  check('1M Sonnet output tokens costs exactly $15', p.costNanos === 15_000_000_000n,
        `got ${p.costNanos}`)
}
{
  // One AI-assisted test-fit as measured from the repo: designer (3.0K in /
  // 1.8K out) + evaluator (4.0K / 0.9K) + 2x refine (2.0K / 0.45K).
  const calls = [
    [3000, 1800], [4000, 900], [2000, 450], [2000, 450],
  ]
  const total = calls.reduce(
    (acc, [i, o]) => acc + priceUsage('claude-sonnet-5', { input_tokens: i, output_tokens: o }).costNanos,
    0n,
  )
  // 11,000 in * 3000n + 3,600 out * 15000n = 33,000,000 + 54,000,000 = 87,000,000n = $0.087
  check('a whole test-fit prices at $0.087, matching the costing model',
        total === 87_000_000n, `got ${total} (${formatNanos(total)})`)
}
{
  const opus = priceUsage('claude-opus-5', { input_tokens: 1_000_000 }).costNanos
  const haiku = priceUsage('claude-haiku-4-5', { input_tokens: 1_000_000 }).costNanos
  check('Opus input is 5x Haiku input', opus === haiku * 5n, `${opus} vs ${haiku}`)
}
{
  // Cache reads bill at ~0.1x input — the reason prompt caching only pays on
  // models whose minimum cacheable prefix your prompts actually clear.
  const p = priceUsage('claude-opus-5', { input_tokens: 0, cache_read_input_tokens: 1_000_000 })
  check('cache reads bill at a tenth of input', p.costNanos === 500_000_000n, `got ${p.costNanos}`)
}
{
  const p = priceUsage('claude-sonnet-5', { input_tokens: 0, cache_creation_input_tokens: 1_000_000 })
  check('cache writes bill at 1.25x input', p.costNanos === 3_750_000_000n, `got ${p.costNanos}`)
}

// ── integer money ────────────────────────────────────────────────────────────
{
  const p = priceUsage('claude-sonnet-5', { input_tokens: 1, output_tokens: 1 })
  check('cost is a bigint, never a float', typeof p.costNanos === 'bigint')
  check('a single token has an exact, non-zero cost', p.costNanos === 18_000n, `got ${p.costNanos}`)
}
{
  // The property float money fails: summing many tiny amounts must be exact.
  let acc = 0n
  for (let i = 0; i < 100_000; i++) {
    acc += priceUsage('claude-sonnet-5', { input_tokens: 1 }).costNanos
  }
  check('100k single-token calls sum exactly, with no drift',
        acc === 300_000_000n, `got ${acc}`)
}

// ── unknown models ───────────────────────────────────────────────────────────
{
  const p = priceUsage('claude-some-future-model', { input_tokens: 5000, output_tokens: 1000 })
  check('an unpriced model is flagged, not guessed', p.unpriced === true)
  check('an unpriced model costs zero rather than an invented number', p.costNanos === 0n)
  check('an unpriced model still records its token counts',
        p.inputTokens === 5000 && p.outputTokens === 1000)
}
{
  const p = priceUsage('claude-sonnet-5', undefined)
  check('missing usage from upstream prices to zero without throwing', p.costNanos === 0n)
  check('...and is not mislabelled as unpriced', p.unpriced === false)
}

// ── rate provenance ──────────────────────────────────────────────────────────
{
  const p = priceUsage('claude-sonnet-5', { input_tokens: 10 })
  check('every priced row carries the rate version that produced it',
        p.rateVersion === RATE_VERSION && typeof RATE_VERSION === 'string')
}
{
  // The intro-price trap: Sonnet 5 was $2/$10 until 2026-08-31 and is $3/$15
  // after. The card must hold ONE of those, unambiguously, and say which.
  check('the shipped card is the post-introductory Sonnet rate',
        RATES['claude-sonnet-5'].input === 3000n && RATES['claude-sonnet-5'].output === 15000n,
        `${RATES['claude-sonnet-5'].input}/${RATES['claude-sonnet-5'].output}`)
}


// ── provider normalisation ───────────────────────────────────────────────────
// Both spending routes bill through one ledger, so both usage vocabularies must
// land in the same columns. Getting this wrong under-bills silently rather than
// failing, which is the worst failure mode a billing path can have.
{
  const a = normalizeUsage({ input_tokens: 10, output_tokens: 5 })
  check('Anthropic shape passes through', a.input_tokens === 10 && a.output_tokens === 5)
}
{
  const o = normalizeUsage({ prompt_tokens: 700, completion_tokens: 90 })
  check('OpenAI shape maps onto input/output',
        o.input_tokens === 700 && o.output_tokens === 90, JSON.stringify(o))
}
{
  const p = priceUsage('claude-sonnet-5', normalizeUsage({ prompt_tokens: 1_000_000 }))
  check('an OpenAI-shaped response prices identically to its Anthropic twin',
        p.costNanos === priceUsage('claude-sonnet-5', { input_tokens: 1_000_000 }).costNanos)
}
{
  check('an unrecognised usage block is undefined, not zeros',
        normalizeUsage({ tokens: 5 }) === undefined)
  check('a missing usage block is undefined', normalizeUsage(undefined) === undefined)
  check('a non-object usage block is undefined', normalizeUsage('nope') === undefined)
}

// ── display ──────────────────────────────────────────────────────────────────
{
  check('formats whole dollars', formatNanos(3_000_000_000n) === '$3.00', formatNanos(3_000_000_000n))
  check('formats cents', formatNanos(87_000_000n) === '$0.08', formatNanos(87_000_000n))
  check('formats zero', formatNanos(0n) === '$0.00')
}

console.log(failed === 0 ? '\nPASS  llmPricing — all checks green'
                         : `\nFAIL  llmPricing — ${failed} failing`)
process.exit(failed === 0 ? 0 : 1)
