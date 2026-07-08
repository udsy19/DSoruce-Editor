// dsource-api — the single production service for DSource Editor.
//
// Serves the built SPA from ./dist and the API surface the dev server provides
// via middlewares. /api/agent, /api/claude, /api/bank and /api/dwg are PORTS of
// the dev-only implementations in web/vite.config.ts (agentProxy, claudeProxy,
// server.proxy['/api/bank']) and web/src/import/dwgConvert.ts — those files
// remain the dev source of truth; change them and this file in lockstep.
// The tool schema + system prompt are NOT duplicated: buildSystem/OPENAI_TOOLS
// are imported from web/src/ai/llmSchema.ts and bundled in by esbuild.
//
// Env (all optional):
//   PORT / HOST            listen address        (default 8790 / 127.0.0.1)
//   STATIC_DIR             built SPA directory   (default ./dist)
//   LLM_BASE_URL / LLM_API_KEY / LLM_MODEL       /api/agent upstream
//   ANTHROPIC_API_KEY / ANTHROPIC_MODEL          /api/claude upstream
//   DWG2DXF_BIN            LibreDWG converter    (default 'dwg2dxf')
//   BANK_UPSTREAM          material-bank origin  (default https://46.202.179.28.sslip.io)
//   PLANS_DIR              plan-store directory  (default ./plans)

import http, { type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { spawn } from 'node:child_process'
import { createReadStream, promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { OPENAI_TOOLS, buildSystem } from '../web/src/ai/llmSchema'

const PORT = Number(process.env.PORT || 8790)
const HOST = process.env.HOST || '127.0.0.1'
const STATIC_DIR = path.resolve(process.env.STATIC_DIR || 'dist')
const PLANS_DIR = path.resolve(process.env.PLANS_DIR || 'plans')
const BANK_UPSTREAM = (process.env.BANK_UPSTREAM || 'https://46.202.179.28.sslip.io').replace(/\/$/, '')
const MAX_BODY = 25 * 1024 * 1024 // request-body cap, all endpoints

// ---------------------------------------------------------------------------
// Body readers

function readBytes(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > MAX_BODY) {
        req.destroy()
        reject(Object.assign(new Error('Request body exceeds 25 MB'), { statusCode: 413 }))
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = (await readBytes(req)).toString('utf8')
  try {
    return raw ? JSON.parse(raw) : {}
  } catch (e) {
    throw Object.assign(new Error(`Invalid JSON body: ${e instanceof Error ? e.message : e}`), { statusCode: 400 })
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify(body))
}

// ---------------------------------------------------------------------------
// /api/agent — port of agentProxy() in web/vite.config.ts (dev source; lockstep)

async function handleAgent(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const baseUrl = process.env.LLM_BASE_URL || 'https://api.openai.com/v1'
  const apiKey = process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || ''
  const model = process.env.LLM_MODEL || 'gpt-4o-mini'

  // A local server (Ollama/LM Studio) needs no key; a cloud one does.
  const localish = /localhost|127\.0\.0\.1/.test(baseUrl)
  const configured = !!apiKey || localish

  if (req.method === 'GET') return sendJson(res, 200, { configured, model })
  if (req.method !== 'POST') return sendJson(res, 405, {})
  if (!configured) return sendJson(res, 503, { error: 'No LLM endpoint configured' })

  const body = await readJson(req)
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
  if (!upstream.ok) return sendJson(res, 502, { error: data?.error ?? data })
  const msg = data.choices?.[0]?.message ?? {}
  const tool_calls = (msg.tool_calls ?? []).map(
    (tc: { function?: { name?: string; arguments?: string } }) => ({
      name: tc.function?.name,
      arguments: tc.function?.arguments,
    }),
  )
  sendJson(res, 200, { content: msg.content ?? null, tool_calls })
}

// ---------------------------------------------------------------------------
// /api/claude — port of claudeProxy() in web/vite.config.ts (dev source; lockstep)

async function handleClaude(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const apiKey = process.env.ANTHROPIC_API_KEY || ''
  const model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5'

  if (req.method === 'GET') return sendJson(res, 200, { configured: !!apiKey, model })
  if (req.method !== 'POST') return sendJson(res, 405, {})
  if (!apiKey) return sendJson(res, 503, { error: 'No ANTHROPIC_API_KEY configured' })

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
  if (!upstream.ok) return sendJson(res, 502, { error: data?.error ?? data })
  sendJson(res, 200, data)
}

// ---------------------------------------------------------------------------
// /api/dwg — port of web/src/import/dwgConvert.ts (dev source; lockstep).
// POST raw DWG bytes → { dxf }. 503 with a clear message when the LibreDWG
// binary is missing on the box.

function runDwg2Dxf(dwgPath: string, dxfPath: string): Promise<void> {
  const bin = process.env.DWG2DXF_BIN || 'dwg2dxf'
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, ['-o', dxfPath, dwgPath], { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    proc.stderr.on('data', (d) => (stderr += d))
    proc.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') {
        reject(
          Object.assign(
            new Error(`DWG conversion unavailable: '${bin}' not installed on the server (LibreDWG). Install it or set DWG2DXF_BIN.`),
            { statusCode: 503 },
          ),
        )
      } else {
        reject(new Error(`Failed to spawn ${bin}: ${err.message}`))
      }
    })
    proc.on('close', (code) => {
      // dwg2dxf prints warnings to stderr but still exits 0 on success.
      if (code === 0) resolve()
      else reject(new Error(`${bin} exited ${code}: ${stderr.trim()}`))
    })
  })
}

async function handleDwg(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'Use POST with raw DWG bytes' })

  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`
  const dwgPath = path.join(tmpdir(), `ds-${stamp}.dwg`)
  const dxfPath = path.join(tmpdir(), `ds-${stamp}.dxf`)
  try {
    const bytes = await readBytes(req)
    if (bytes.length === 0) return sendJson(res, 400, { error: 'Empty request body' })
    await fs.writeFile(dwgPath, bytes)
    await runDwg2Dxf(dwgPath, dxfPath)
    const dxf = await fs.readFile(dxfPath, 'utf8')
    sendJson(res, 200, { dxf })
  } finally {
    fs.unlink(dwgPath).catch(() => {})
    fs.unlink(dxfPath).catch(() => {})
  }
}

// ---------------------------------------------------------------------------
// /api/bank/* — port of server.proxy['/api/bank'] in web/vite.config.ts (dev
// source; lockstep). The upstream sends no CORS headers, so same-origin
// proxying stays mandatory in prod. Rewrite /api/bank → /api, stream both ways.

async function handleBank(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const target = BANK_UPSTREAM + url.pathname.replace(/^\/api\/bank/, '/api') + url.search
  const headers: Record<string, string> = {}
  for (const h of ['content-type', 'accept', 'authorization']) {
    const v = req.headers[h]
    if (typeof v === 'string') headers[h] = v
  }
  const init: RequestInit & { duplex?: 'half' } = { method: req.method, headers }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    init.body = Readable.toWeb(req) as unknown as BodyInit
    init.duplex = 'half'
  }
  const upstream = await fetch(target, init)
  res.statusCode = upstream.status
  for (const h of ['content-type', 'cache-control', 'etag']) {
    const v = upstream.headers.get(h)
    if (v) res.setHeader(h, v)
  }
  if (upstream.body) await pipeline(Readable.fromWeb(upstream.body as never), res)
  else res.end()
}

// ---------------------------------------------------------------------------
// /api/plans — minimal plan store per docs/design/plan-library.md §5.
// Accepts a web/src/persist/plans.ts SavedPlan record VERBATIM (validation is
// deliberately light and standalone — ownership/tenancy comes later). Storage:
// one JSON file per plan under PLANS_DIR, atomic tmp+rename writes.

const PLAN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/ // also keeps ids filename-safe

function planPath(id: string): string {
  return path.join(PLANS_DIR, `${id}.json`)
}

async function handlePlans(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
  const sub = pathname.slice('/api/plans'.length).replace(/^\//, '')

  if (sub === '') {
    if (req.method === 'POST') {
      const body = await readJson(req)
      const file = body?.file as Record<string, unknown> | undefined
      const valid =
        body !== null &&
        typeof body === 'object' &&
        !Array.isArray(body) &&
        typeof body.id === 'string' &&
        PLAN_ID.test(body.id) &&
        typeof file === 'object' &&
        file !== null &&
        file.format === 'dsource' &&
        file.version === 1
      if (!valid) {
        return sendJson(res, 400, {
          error: 'Expected a SavedPlan record: { id: string, file: { format: "dsource", version: 1, ... }, ... }',
        })
      }
      await fs.mkdir(PLANS_DIR, { recursive: true })
      const dest = planPath(body.id as string)
      const tmp = `${dest}.${process.pid}.${Date.now()}.tmp`
      await fs.writeFile(tmp, JSON.stringify(body))
      await fs.rename(tmp, dest)
      return sendJson(res, 200, { ok: true, id: body.id })
    }
    if (req.method === 'GET') {
      let names: string[] = []
      try {
        names = (await fs.readdir(PLANS_DIR)).filter((n) => n.endsWith('.json'))
      } catch {
        // PLANS_DIR not created yet — empty library.
      }
      const list: unknown[] = []
      for (const n of names) {
        try {
          const p = JSON.parse(await fs.readFile(path.join(PLANS_DIR, n), 'utf8'))
          // Summary only — no file/thumb payloads in the list.
          list.push({ id: p.id, name: p.name, updatedAt: p.updatedAt, metrics: p.metrics })
        } catch {
          // Skip unreadable/corrupt records rather than failing the list.
        }
      }
      list.sort((a, b) => String((b as { updatedAt?: string }).updatedAt ?? '').localeCompare(String((a as { updatedAt?: string }).updatedAt ?? '')))
      return sendJson(res, 200, list)
    }
    return sendJson(res, 405, { error: 'Use GET or POST' })
  }

  if (!PLAN_ID.test(sub)) return sendJson(res, 400, { error: 'Invalid plan id' })
  if (req.method === 'GET') {
    try {
      const raw = await fs.readFile(planPath(sub), 'utf8')
      res.statusCode = 200
      res.setHeader('content-type', 'application/json')
      return void res.end(raw) // full record, verbatim
    } catch {
      return sendJson(res, 404, { error: 'Plan not found' })
    }
  }
  if (req.method === 'DELETE') {
    try {
      await fs.unlink(planPath(sub))
      return sendJson(res, 200, { ok: true })
    } catch {
      return sendJson(res, 404, { error: 'Plan not found' })
    }
  }
  return sendJson(res, 405, { error: 'Use GET or DELETE' })
}

// ---------------------------------------------------------------------------
// Static SPA from STATIC_DIR with fallback to index.html for client routes.

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
}

async function handleStatic(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'Method not allowed' })

  let filePath = path.resolve(STATIC_DIR, `.${path.posix.normalize(decodeURIComponent(pathname))}`)
  if (filePath !== STATIC_DIR && !filePath.startsWith(STATIC_DIR + path.sep)) {
    return sendJson(res, 403, { error: 'Forbidden' })
  }
  let stat = await fs.stat(filePath).catch(() => null)
  if (stat?.isDirectory()) {
    filePath = path.join(filePath, 'index.html')
    stat = await fs.stat(filePath).catch(() => null)
  }
  if (!stat) {
    // SPA fallback: unknown non-asset paths get the app shell.
    filePath = path.join(STATIC_DIR, 'index.html')
    stat = await fs.stat(filePath).catch(() => null)
    if (!stat) return sendJson(res, 404, { error: 'Not found (no dist build?)' })
  }
  const ext = path.extname(filePath).toLowerCase()
  res.statusCode = 200
  res.setHeader('content-type', MIME[ext] ?? 'application/octet-stream')
  // Vite emits hashed filenames under /assets — safe to cache hard; the shell isn't.
  res.setHeader(
    'cache-control',
    pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
  )
  res.setHeader('content-length', String(stat.size))
  if (req.method === 'HEAD') return void res.end()
  await pipeline(createReadStream(filePath), res)
}

// ---------------------------------------------------------------------------
// Router

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://internal')
  const p = url.pathname
  if (p === '/api/agent') return handleAgent(req, res)
  if (p === '/api/claude') return handleClaude(req, res)
  if (p === '/api/dwg') return handleDwg(req, res)
  if (p === '/api/bank' || p.startsWith('/api/bank/')) return handleBank(req, res, url)
  if (p === '/api/plans' || p.startsWith('/api/plans/')) return handlePlans(req, res, p)
  if (p.startsWith('/api/')) return sendJson(res, 404, { error: 'Unknown API endpoint' })
  return handleStatic(req, res, p)
}

const server: Server = http.createServer((req, res) => {
  route(req, res).catch((e: Error & { statusCode?: number }) => {
    if (!res.headersSent) sendJson(res, e.statusCode ?? 500, { error: e.message ?? String(e) })
    else res.end()
  })
})

server.listen(PORT, HOST, () => {
  console.log(`dsource-api listening on http://${HOST}:${PORT} (static: ${STATIC_DIR}, plans: ${PLANS_DIR})`)
})
