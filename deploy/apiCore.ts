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

import { OPENAI_TOOLS, buildSystem } from '../web/src/ai/llmSchema'

/** A JSON response the adapter serialises: `res.status(status).json(json)`. */
export interface JsonResult {
  status: number
  json: unknown
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

/** POST /api/agent — forward a driver turn to the LLM, normalise tool calls. */
export async function agentComplete(body: Record<string, unknown>): Promise<JsonResult> {
  const { baseUrl, apiKey, model, configured } = agentEnv()
  if (!configured) return { status: 503, json: { error: 'No LLM endpoint configured' } }

  const messages = [
    { role: 'system', content: buildSystem(body.context as Parameters<typeof buildSystem>[0]) },
    ...(Array.isArray(body.history) ? body.history : []),
    { role: 'user', content: String(body.text ?? '') },
  ]
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (apiKey) headers.authorization = `Bearer ${apiKey}`
  const upstream = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ model, messages, tools: OPENAI_TOOLS, tool_choice: 'auto', temperature: 0.2 }),
  })
  const data = await upstream.json()
  if (!upstream.ok) return { status: 502, json: { error: data?.error ?? data } }
  const msg = data.choices?.[0]?.message ?? {}
  const tool_calls = (msg.tool_calls ?? []).map(
    (tc: { function?: { name?: string; arguments?: string } }) => ({
      name: tc.function?.name,
      arguments: tc.function?.arguments,
    }),
  )
  return { status: 200, json: { content: msg.content ?? null, tool_calls } }
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

/** POST /api/claude — forward a Messages request; optional tools/tool_choice. */
export async function claudeComplete(body: Record<string, unknown>): Promise<JsonResult> {
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

  const upstream = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(payload),
  })
  const data = await upstream.json()
  if (!upstream.ok) return { status: 502, json: { error: data?.error ?? data } }
  return { status: 200, json: data }
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
