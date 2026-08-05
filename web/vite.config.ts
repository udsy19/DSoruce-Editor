import { defineConfig, loadEnv, type Plugin } from 'vite'
import { execSync } from 'node:child_process'
import react from '@vitejs/plugin-react'
import type { IncomingMessage, ServerResponse } from 'node:http'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import { OPENAI_TOOLS, buildSystem } from './src/ai/llmSchema'
import { dwgConvertPlugin } from './src/import/dwgConvert'

// Dev-only agent proxy. Holds the LLM key server-side and relays to any
// OpenAI-compatible endpoint (OpenAI / Groq / OpenRouter / Together / local
// Ollama or LM Studio). Configure via env:
//   LLM_BASE_URL  (default https://api.openai.com/v1)
//   LLM_API_KEY   (default $OPENAI_API_KEY)
//   LLM_MODEL     (default gpt-4o-mini)
// For a local, no-key setup: LLM_BASE_URL=http://localhost:11434/v1 LLM_MODEL=llama3.1
function agentProxy(): Plugin {
  return {
    name: 'ds-agent-proxy',
    configureServer(server) {
      server.middlewares.use('/api/agent', async (req: IncomingMessage, res: ServerResponse) => {
        const baseUrl = process.env.LLM_BASE_URL || 'https://api.openai.com/v1'
        const apiKey = process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || ''
        const model = process.env.LLM_MODEL || 'gpt-4o-mini'
        res.setHeader('content-type', 'application/json')

        // A local server (Ollama/LM Studio) needs no key; a cloud one does.
        const localish = /localhost|127\.0\.0\.1/.test(baseUrl)
        const configured = !!apiKey || localish

        if (req.method === 'GET') {
          res.end(JSON.stringify({ configured, model }))
          return
        }
        if (req.method !== 'POST') {
          res.statusCode = 405
          res.end('{}')
          return
        }
        if (!configured) {
          res.statusCode = 503
          res.end(JSON.stringify({ error: 'No LLM endpoint configured' }))
          return
        }
        try {
          const body = await readJson(req)
          const messages = [
            { role: 'system', content: buildSystem(body.context) },
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
          if (!upstream.ok) {
            res.statusCode = 502
            res.end(JSON.stringify({ error: data?.error ?? data }))
            return
          }
          const msg = data.choices?.[0]?.message ?? {}
          const tool_calls = (msg.tool_calls ?? []).map(
            (tc: { function?: { name?: string; arguments?: string } }) => ({
              name: tc.function?.name,
              arguments: tc.function?.arguments,
            }),
          )
          res.end(JSON.stringify({ content: msg.content ?? null, tool_calls }))
        } catch (e) {
          res.statusCode = 500
          res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }))
        }
      })
    },
  }
}

// Dev-only Claude proxy for the soft-goal candidate evaluator AND the
// ClaudeDriver assistant (which adds Anthropic-format `tools`). Holds the
// Anthropic key server-side and relays a single Messages API call. Configure
// via env (shell or gitignored web/.env.local):
//   ANTHROPIC_API_KEY   (required for POST; GET reports configured=false without it)
//   ANTHROPIC_MODEL     (default claude-sonnet-5)
function claudeProxy(): Plugin {
  return {
    name: 'ds-claude-proxy',
    configureServer(server) {
      server.middlewares.use('/api/claude', async (req: IncomingMessage, res: ServerResponse) => {
        const apiKey = process.env.ANTHROPIC_API_KEY || ''
        const model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5'
        res.setHeader('content-type', 'application/json')

        if (req.method === 'GET') {
          res.end(JSON.stringify({ configured: !!apiKey, model }))
          return
        }
        if (req.method !== 'POST') {
          res.statusCode = 405
          res.end('{}')
          return
        }
        if (!apiKey) {
          res.statusCode = 503
          res.end(JSON.stringify({ error: 'No ANTHROPIC_API_KEY configured' }))
          return
        }
        try {
          const body = await readJson(req)
          // Optional Anthropic-format tools (the ClaudeDriver sends them; the
          // evaluator doesn't) — passed through to the API body verbatim.
          const payload: Record<string, unknown> = {
            model,
            system: body.system,
            messages: body.messages,
            max_tokens: typeof body.max_tokens === 'number' ? body.max_tokens : 1024,
          }
          if (Array.isArray(body.tools)) payload.tools = body.tools
          // Optional tool_choice (the designer FORCES design_layout). Forcing a tool
          // also disables extended thinking, so the full budget goes to a complete
          // tool call — no truncated JSON. (lockstep: deploy/server.ts handleClaude)
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
          if (!upstream.ok) {
            res.statusCode = 502
            res.end(JSON.stringify({ error: data?.error ?? data }))
            return
          }
          res.end(JSON.stringify(data))
        } catch (e) {
          res.statusCode = 500
          res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }))
        }
      })
    },
  }
}

// Dev-only plan store — the dev-server counterpart of handlePlans() in
// deploy/server.ts (PROD source of truth; keep the two in lockstep, same
// convention as agentProxy/claudeProxy). Mirrors the exact routes the client
// sync loop (src/persist/sync.ts) talks to: POST /api/plans (store one JSON
// file per SavedPlan), GET /api/plans (id/name/updatedAt/metrics summaries),
// GET /api/plans/:id (full record verbatim), DELETE /api/plans/:id. The vite
// dev server does NOT proxy /api/plans, so without this middleware sync has no
// endpoint in `pnpm dev`. Storage: one JSON file per plan under DEV_PLANS_DIR.
const DEV_PLANS_DIR = path.resolve('.dev-plans')
const PLAN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/ // also keeps ids filename-safe

function plansStore(): Plugin {
  const planPath = (id: string) => path.join(DEV_PLANS_DIR, `${id}.json`)
  const send = (res: ServerResponse, status: number, body: unknown) => {
    res.statusCode = status
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(body))
  }
  return {
    name: 'ds-plans-store',
    configureServer(server) {
      server.middlewares.use('/api/plans', async (req: IncomingMessage, res: ServerResponse) => {
        // connect strips the mount prefix: req.url is '/' (collection) or '/:id'.
        const sub = new URL(req.url ?? '/', 'http://internal').pathname.replace(/^\//, '')
        try {
          if (sub === '') {
            if (req.method === 'POST') {
              const body = await readJson(req)
              const file = body?.file as Record<string, unknown> | undefined
              const valid =
                typeof body?.id === 'string' &&
                PLAN_ID.test(body.id) &&
                typeof file === 'object' &&
                file !== null &&
                file.format === 'dsource' &&
                file.version === 1
              if (!valid) {
                return send(res, 400, {
                  error:
                    'Expected a SavedPlan record: { id: string, file: { format: "dsource", version: 1, ... }, ... }',
                })
              }
              await fs.mkdir(DEV_PLANS_DIR, { recursive: true })
              const dest = planPath(body.id as string)
              const tmp = `${dest}.${process.pid}.${Date.now()}.tmp`
              await fs.writeFile(tmp, JSON.stringify(body))
              await fs.rename(tmp, dest)
              return send(res, 200, { ok: true, id: body.id })
            }
            if (req.method === 'GET') {
              let names: string[] = []
              try {
                names = (await fs.readdir(DEV_PLANS_DIR)).filter((n) => n.endsWith('.json'))
              } catch {
                // DEV_PLANS_DIR not created yet — empty library.
              }
              const list: unknown[] = []
              for (const n of names) {
                try {
                  const p = JSON.parse(await fs.readFile(path.join(DEV_PLANS_DIR, n), 'utf8'))
                  list.push({ id: p.id, name: p.name, updatedAt: p.updatedAt, metrics: p.metrics })
                } catch {
                  // Skip unreadable/corrupt records rather than failing the list.
                }
              }
              list.sort((a, b) =>
                String((b as { updatedAt?: string }).updatedAt ?? '').localeCompare(
                  String((a as { updatedAt?: string }).updatedAt ?? ''),
                ),
              )
              return send(res, 200, list)
            }
            return send(res, 405, { error: 'Use GET or POST' })
          }

          if (!PLAN_ID.test(sub)) return send(res, 400, { error: 'Invalid plan id' })
          if (req.method === 'GET') {
            try {
              const raw = await fs.readFile(planPath(sub), 'utf8')
              res.statusCode = 200
              res.setHeader('content-type', 'application/json')
              return void res.end(raw) // full record, verbatim
            } catch {
              return send(res, 404, { error: 'Plan not found' })
            }
          }
          if (req.method === 'DELETE') {
            try {
              await fs.unlink(planPath(sub))
              return send(res, 200, { ok: true })
            } catch {
              return send(res, 404, { error: 'Plan not found' })
            }
          }
          return send(res, 405, { error: 'Use GET or DELETE' })
        } catch (e) {
          return send(res, 500, { error: e instanceof Error ? e.message : String(e) })
        }
      })
    },
  }
}

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {})
      } catch (e) {
        reject(e)
      }
    })
    req.on('error', reject)
  })
}


/**
 * BUILD PROVENANCE — stamp the served page with the tree it came from.
 *
 * A scripted browser check that has not proven WHICH tree it is talking to is
 * measuring an unknown. This is not hypothetical: three verification passes in
 * the plan-grammar campaign were run against :5173, which a different git
 * worktree was serving, and they reported deleted CSS tokens as still live.
 * Same failure class as trusting a reader over the artifact — the instrument
 * was pointed at the wrong thing and said so only if asked.
 *
 * The ROOT is the load-bearing field, not the commit: the worktree mix-up had a
 * plausible commit and the wrong directory. Emitted as meta tags so a plain
 * `curl` can check them without executing the app.
 */
function buildProvenance(): Plugin {
  const run = (cmd: string) => {
    try {
      return execSync(cmd, { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'ignore'] })
        .toString()
        .trim()
    } catch {
      return ''
    }
  }
  const commit = run('git rev-parse HEAD') || 'unknown'
  const root = run('git rev-parse --show-toplevel') || process.cwd()
  return {
    name: 'build-provenance',
    transformIndexHtml(html) {
      return html.replace(
        '</head>',
        `  <meta name="build-commit" content="${commit}" />\n` +
          `    <meta name="build-root" content="${root}" />\n  </head>`,
      )
    },
  }
}

export default defineConfig(({ mode }) => {
  // Let the LLM_* / ANTHROPIC_* config live in a gitignored web/.env.local as
  // well as the shell env. Command-line env wins over .env files.
  const env = loadEnv(mode, process.cwd(), ['LLM_', 'ANTHROPIC_'])
  for (const k of ['LLM_BASE_URL', 'LLM_API_KEY', 'LLM_MODEL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL']) {
    if (env[k] && !process.env[k]) process.env[k] = env[k]
  }
  return {
    plugins: [
      react(),
      buildProvenance(),
      agentProxy(),
      claudeProxy(),
      plansStore(),
      dwgConvertPlugin(),
    ],
    server: {
      port: 5173,
      proxy: {
        // Live material-bank API (separate repo, hosted on the VPS). Proxied
        // because the upstream sends no CORS headers; /api/bank/* → /api/*.
        '/api/bank': {
          target: 'https://46.202.179.28.sslip.io',
          changeOrigin: true,
          rewrite: (p: string) => p.replace(/^\/api\/bank/, '/api'),
        },
      },
    },
  }
})
