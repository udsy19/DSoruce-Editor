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
//   DWGREAD_BIN            LibreDWG JSON reader  (default 'dwgread'), fallback path
//   BANK_UPSTREAM          material-bank origin  (default https://46.202.179.28.sslip.io)
//   PLANS_DIR              plan-store directory  (default ./plans)

import http, { type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { spawn } from 'node:child_process'
import { createReadStream, promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import {
  agentInfo,
  agentComplete,
  claudeInfo,
  claudeComplete,
  bankFetch,
  guard,
} from './apiCore'
import { handleShareApi, sharePageId } from './shareStore'
import { handlePackApi } from './packStore'
// Shared with the dev middleware (web/src/import/dwgConvert.ts) so the two
// /api/dwg implementations cannot drift on what a successful conversion is.
import { describeExit, trimStderr, verifyDxf } from '../web/src/import/dwgVerify'
import { dwgJsonToDxf } from '../web/src/import/dwgJson'

const PORT = Number(process.env.PORT || 8790)
const HOST = process.env.HOST || '127.0.0.1'
const STATIC_DIR = path.resolve(process.env.STATIC_DIR || 'dist')
const PLANS_DIR = path.resolve(process.env.PLANS_DIR || 'plans')
// Where the one-action deliverable pack lands, and (when the full repo is
// present) the checkout whose scripts/render-walkthrough.mjs shoots the video.
const PACK_OUT_DIR = path.resolve(process.env.PACK_OUT_DIR || 'out')
const PACK_REPO_DIR = process.env.PACK_REPO_DIR ? path.resolve(process.env.PACK_REPO_DIR) : undefined
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
// /api/agent — Node adapter over apiCore.agent* (dev source: web/vite.config.ts)

async function handleAgent(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method === 'GET') {
    const r = agentInfo()
    return sendJson(res, r.status, r.json)
  }
  if (req.method !== 'POST') return sendJson(res, 405, {})
  const r = await agentComplete(await readJson(req), req.headers)
  sendJson(res, r.status, r.json)
}

// ---------------------------------------------------------------------------
// /api/claude — Node adapter over apiCore.claude* (dev source: web/vite.config.ts)

async function handleClaude(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method === 'GET') {
    const r = claudeInfo()
    return sendJson(res, r.status, r.json)
  }
  if (req.method !== 'POST') return sendJson(res, 405, {})
  const r = await claudeComplete(await readJson(req), req.headers)
  sendJson(res, r.status, r.json)
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
    // `close` gives (code, signal). A signalled child reports code === null,
    // so reading the code alone turned a SIGSEGV into "dwg2dxf exited null".
    proc.on('close', (code, signal) => {
      if (code === 0 && !signal) resolve()
      else {
        const tail = trimStderr(stderr)
        // Full stderr to the server log, a bounded tail to the caller.
        if (stderr.trim()) console.error(`[dwg] ${bin} failed:\n${stderr.trim()}`)
        reject(new Error(describeExit(bin, code, signal) + (tail ? ` (${tail})` : '')))
      }
    })
  })
}

/**
 * Fallback conversion via LibreDWG's other front end — lockstep with
 * web/src/import/dwgConvert.ts. `dwg2dxf` cannot finish every file (segfaults
 * on two corpus files, silently truncates a third); `dwgread -O JSON` reads all
 * three, because the DWG reading is the same library and it is the DXF writer
 * that fails. Re-emitted as DXF by dwgJsonToDxf so there is one importer.
 */
function runDwgReadJson(dwgPath: string, jsonPath: string): Promise<void> {
  const bin = process.env.DWGREAD_BIN || 'dwgread'
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, ['-O', 'JSON', '-o', jsonPath, dwgPath], {
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    proc.stderr.on('data', (d) => (stderr += d))
    proc.on('error', (err) => reject(new Error(`Failed to spawn ${bin}: ${err.message}`)))
    proc.on('close', (code, signal) => {
      if (code === 0 && !signal) resolve()
      else {
        if (stderr.trim()) console.error(`[dwg] ${bin} failed:\n${stderr.trim()}`)
        const tail = trimStderr(stderr)
        reject(new Error(describeExit(bin, code, signal) + (tail ? ` (${tail})` : '')))
      }
    })
  })
}

async function handleDwg(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'Use POST with raw DWG bytes' })

  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`
  const dwgPath = path.join(tmpdir(), `ds-${stamp}.dwg`)
  const dxfPath = path.join(tmpdir(), `ds-${stamp}.dxf`)
  const jsonPath = path.join(tmpdir(), `ds-${stamp}.json`)
  try {
    const bytes = await readBytes(req)
    if (bytes.length === 0) return sendJson(res, 400, { error: 'Empty request body' })
    await fs.writeFile(dwgPath, bytes)

    // Primary path. The exit code said it worked; check the bytes before
    // believing it — dwg2dxf truncates and still exits 0 (dwgVerify.ts).
    let primaryFailure: string | null = null
    try {
      await runDwg2Dxf(dwgPath, dxfPath)
      const dxf = await fs.readFile(dxfPath, 'utf8')
      const verdict = verifyDxf(dxf)
      if (verdict.ok) return sendJson(res, 200, { dxf })
      primaryFailure = verdict.message
    } catch (e) {
      // A missing LibreDWG install is a server-config problem, not a bad file:
      // surface it as-is rather than retrying a binary from the same package.
      if ((e as { statusCode?: number }).statusCode === 503) throw e
      primaryFailure = e instanceof Error ? e.message : String(e)
    }

    try {
      await runDwgReadJson(dwgPath, jsonPath)
      const dxf = dwgJsonToDxf(JSON.parse(await fs.readFile(jsonPath, 'utf8')))
      const verdict = verifyDxf(dxf)
      if (verdict.ok) return sendJson(res, 200, { dxf })
      return sendJson(res, 502, {
        error: `DWG conversion did not complete. Direct conversion: ${primaryFailure}. Fallback: ${verdict.message}.`,
      })
    } catch (e) {
      const fallbackFailure = e instanceof Error ? e.message : String(e)
      return sendJson(res, 502, {
        error: `DWG conversion failed. Direct conversion: ${primaryFailure}. Fallback: ${fallbackFailure}.`,
      })
    }
  } finally {
    fs.unlink(dwgPath).catch(() => {})
    fs.unlink(dxfPath).catch(() => {})
    fs.unlink(jsonPath).catch(() => {})
  }
}

// ---------------------------------------------------------------------------
// /api/bank/* — Node adapter over apiCore.bankFetch (dev source: web/vite.config.ts).
// The upstream sends no CORS headers, so same-origin proxying stays mandatory.

async function handleBank(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const method = req.method ?? 'GET'
  const body =
    method !== 'GET' && method !== 'HEAD'
      ? (Readable.toWeb(req) as unknown as BodyInit)
      : undefined
  const upstream = await bankFetch(method, url.pathname, url.search, req.headers, body)
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
// /share/:id — the shareable web 3D viewer (deliverable 4). The /api/share
// store handler is SHARED with the dev middleware in web/vite.config.ts
// (./shareStore, one implementation); only the page differs, and here it is the
// SPA build's second entry, dist/viewer.html. The viewer derives its id from
// the URL and fetches /api/share/:id itself, so the HTML is served verbatim —
// nothing is templated into it.

async function handleSharePage(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const file = path.join(STATIC_DIR, 'viewer.html')
  const stat = await fs.stat(file).catch(() => null)
  if (!stat) return sendJson(res, 404, { error: 'Viewer not built (no dist/viewer.html?)' })
  res.statusCode = 200
  res.setHeader('content-type', MIME['.html'])
  res.setHeader('cache-control', 'no-cache')
  res.setHeader('content-length', String(stat.size))
  if (req.method === 'HEAD') return void res.end()
  await pipeline(createReadStream(file), res)
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
//
// AUTH POSTURE, in one place. `/api/agent` and `/api/claude` call guard() inside
// apiCore, where it is a required parameter of agentComplete/claudeComplete so a
// new adapter cannot forget it. The four routes below had no such forcing
// function and simply never called it — `grep -c 'guard(' deploy/server.ts`
// returned 0 while the guard sat imported one module away. That is the shape the
// project already names as a hazard understood, localised, and left standing: the
// mitigation existed, was applied at the two call sites someone was thinking
// about, and the class stayed live everywhere else.
//
// Measured before this table existed, against a server with SUPABASE_URL set
// (so the guard was in fail-closed 'required' mode) and no credentials sent:
//   POST /api/plans      → 200, plan file overwritten
//   DELETE /api/plans/x  → 200, plan file deleted
//   POST /api/share/<id> → 200, published bundle overwritten
//   POST /api/pack/file  → 200, artifact written
//   POST /api/dwg        → 502, i.e. it reached the handler and spawned
//
// Stated as a table rather than a call at the top of each handler so the posture
// of every /api/ route is readable in one screen, and so a route added later
// shows up as an ABSENCE here rather than as a missing line buried in a handler.
type AuthPosture = 'public' | 'authenticated' | 'writes-authenticated'

function postureOf(pathname: string): AuthPosture {
  if (pathname === '/api/plans' || pathname.startsWith('/api/plans/')) return 'authenticated'
  if (pathname === '/api/dwg') return 'authenticated'
  // A share link must open for a recipient who has no account — that IS the
  // feature. Only publishing over an existing id is privileged.
  if (pathname === '/api/share' || pathname.startsWith('/api/share/')) return 'writes-authenticated'
  // GET /api/pack is a capability probe that leaks nothing; the POSTs write to
  // disk and spawn the walkthrough renderer (measured at ~90 s to 36 min).
  if (pathname === '/api/pack' || pathname.startsWith('/api/pack/')) return 'writes-authenticated'
  // /api/agent and /api/claude guard themselves inside apiCore; /api/bank is an
  // unauthenticated read-through proxy to a public catalogue and is unchanged by
  // this commit.
  return 'public'
}

function needsAuth(pathname: string, method: string): boolean {
  const posture = postureOf(pathname)
  if (posture === 'authenticated') return true
  if (posture === 'writes-authenticated') return method !== 'GET' && method !== 'HEAD'
  return false
}

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://internal')
  const p = url.pathname
  if (needsAuth(p, req.method ?? 'GET')) {
    const gate = await guard(req.headers)
    if (!gate.ok) return sendJson(res, gate.deny.status, gate.deny.json)
  }
  if (p === '/api/agent') return handleAgent(req, res)
  if (p === '/api/claude') return handleClaude(req, res)
  if (p === '/api/dwg') return handleDwg(req, res)
  if (p === '/api/bank' || p.startsWith('/api/bank/')) return handleBank(req, res, url)
  if (p === '/api/plans' || p.startsWith('/api/plans/')) return handlePlans(req, res, p)
  if (p === '/api/share' || p.startsWith('/api/share/')) {
    return handleShareApi(req, res, p.slice('/api/share'.length).replace(/^\//, ''), PLANS_DIR)
  }
  if (p === '/api/pack' || p.startsWith('/api/pack/')) {
    return handlePackApi(req, res, p.slice('/api/pack'.length).replace(/^\//, ''), {
      outDir: PACK_OUT_DIR,
      repoRoot: PACK_REPO_DIR,
    })
  }
  if (p.startsWith('/api/')) return sendJson(res, 404, { error: 'Unknown API endpoint' })
  if (sharePageId(p)) return handleSharePage(req, res)
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
