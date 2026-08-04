// deploy/packStore.ts — the write side of the one-action deliverable pack.
//
// A browser can download, but it cannot write to a directory, and the gates
// (scripts/gates/g10-one-action.mjs) poll a real `out/`. This is the endpoint
// that closes that gap, and — exactly like `deploy/shareStore.ts` — it is ONE
// implementation imported by both runtimes that can serve it:
//   • web/vite.config.ts  — the dev middleware   (repo `out/`)
//   • deploy/server.ts    — the VPS Node service (PACK_OUT_DIR)
// Vercel has no writable disk, so `api/pack/[[...path]].ts` answers 501 there
// and the app falls back to downloading the pack as one .zip — the SAME bytes,
// produced by the same `buildDeliverablePack` (see deploy/VERCEL.md).
//
// Routes (mounted at /api/pack by both adapters):
//   GET  /api/pack                  → { ok, writes, video, out }   capabilities
//   POST /api/pack/file/<name>      raw bytes → <out>/<name>
//   POST /api/pack/walkthrough      { state, wallTypes, plate, circulation, … }
//                                   → NDJSON progress, then { ok, bytes }
//
// The walkthrough route exists because rendering 1290 frames of a 1080p
// interior takes ~90 s on hardware GL and ~36 min on a software rasterizer
// (measured). Where a GPU-capable headless Chromium AND ffmpeg are available,
// the server shoots the take with `scripts/render-walkthrough.mjs` — which
// bundles `web/src/export/walkthrough.ts`, the same module the browser would
// run, so the camera and the scene are identical either way.

import type { IncomingMessage, ServerResponse } from 'node:http'
import { spawn, spawnSync } from 'node:child_process'
import { promises as fs, existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export interface PackStoreOpts {
  /** Directory artifacts are written to (the repo's `out/`). */
  outDir: string
  /** Repo root — where `scripts/render-walkthrough.mjs` lives. Omit on a
   *  deployment that ships only the built SPA; the video then falls back to
   *  the browser's own WebCodecs encoder. */
  repoRoot?: string
}

/** Artifact names: one optional subdirectory, no traversal, no surprises. */
const PACK_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)?$/

/** Largest single artifact accepted (a 4K still is ~6 MB, an mp4 ~40 MB). */
const MAX_FILE = 256 * 1024 * 1024

let videoCap: 'server' | null | undefined

/**
 * Can this host actually shoot the walkthrough? It needs the driver script,
 * ffmpeg on PATH, and playwright's Chromium. Probed once.
 */
export function packVideoCapability(repoRoot?: string): 'server' | null {
  if (videoCap !== undefined) return videoCap
  videoCap = null
  if (repoRoot) {
    const driver = path.join(repoRoot, 'scripts', 'render-walkthrough.mjs')
    const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0
    const hasChromium = existsSync(path.join(repoRoot, 'web', 'node_modules', 'playwright'))
    if (existsSync(driver) && hasFfmpeg && hasChromium) videoCap = 'server'
  }
  return videoCap
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader('content-type', 'application/json')
  res.setHeader('cache-control', 'no-cache')
  res.end(JSON.stringify(body))
}

function readBytes(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > MAX_FILE) {
        req.destroy()
        reject(Object.assign(new Error('Artifact exceeds 256 MB'), { statusCode: 413 }))
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/** Atomic tmp+rename, as the plan and share stores write. */
async function writeArtifact(outDir: string, name: string, data: Buffer): Promise<void> {
  const dest = path.join(outDir, name)
  await fs.mkdir(path.dirname(dest), { recursive: true })
  const tmp = `${dest}.${process.pid}.${Date.now()}.tmp`
  await fs.writeFile(tmp, data)
  await fs.rename(tmp, dest)
}

/**
 * Shoot the walkthrough with the headless driver and stream its progress back
 * as NDJSON. Resolves once the mp4 is on disk.
 */
async function renderWalkthrough(
  res: ServerResponse,
  outDir: string,
  repoRoot: string,
  job: unknown,
): Promise<void> {
  const tmp = path.join(os.tmpdir(), `dsource-walk-${process.pid}-${Date.now()}.json`)
  await fs.writeFile(tmp, JSON.stringify(job))
  res.statusCode = 200
  res.setHeader('content-type', 'application/x-ndjson')
  res.setHeader('cache-control', 'no-cache')
  const line = (o: unknown): void => void res.write(`${JSON.stringify(o)}\n`)
  line({ phase: 'start', done: 0, total: 0 })

  const mp4 = path.join(outDir, 'walkthrough.mp4')
  await fs.mkdir(outDir, { recursive: true })
  const child = spawn(
    process.execPath,
    [path.join(repoRoot, 'scripts', 'render-walkthrough.mjs'), '--state', tmp, '--out', outDir],
    { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  let tail = ''
  const watch = (buf: Buffer): void => {
    const text = buf.toString()
    tail = `${tail}${text}`.slice(-4000)
    // The driver reports `  frame 123/1290  9.5%  …` on a carriage return.
    const m = /frame\s+(\d+)\/(\d+)/g
    let last: RegExpExecArray | null = null
    for (let x = m.exec(text); x; x = m.exec(text)) last = x
    if (last) line({ phase: 'render', done: Number(last[1]), total: Number(last[2]) })
  }
  child.stdout.on('data', watch)
  child.stderr.on('data', watch)

  const code = await new Promise<number>((resolve) => {
    child.on('error', () => resolve(-1))
    child.on('close', (c) => resolve(c ?? -1))
  })
  await fs.rm(tmp, { force: true })

  if (code !== 0) {
    line({ ok: false, error: `walkthrough renderer exited ${code}: ${tail.slice(-400)}` })
    return void res.end()
  }
  const stat = await fs.stat(mp4).catch(() => null)
  if (!stat || stat.size === 0) {
    line({ ok: false, error: 'walkthrough renderer produced no mp4' })
    return void res.end()
  }
  line({ ok: true, bytes: stat.size })
  res.end()
}

/**
 * Serve one `/api/pack/*` request. `sub` is the path AFTER `/api/pack` with no
 * leading slash ('' · 'file/<name>' · 'walkthrough') — connect strips the mount
 * prefix in dev, and `deploy/server.ts` slices it off in prod.
 */
export async function handlePackApi(
  req: IncomingMessage,
  res: ServerResponse,
  sub: string,
  opts: PackStoreOpts,
): Promise<void> {
  const outDir = path.resolve(opts.outDir)

  if (!sub) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return sendJson(res, 405, { error: 'Use GET for capabilities' })
    }
    return sendJson(res, 200, {
      ok: true,
      writes: true,
      video: packVideoCapability(opts.repoRoot),
      out: `${path.basename(outDir)}/`,
    })
  }

  if (req.method !== 'POST' && req.method !== 'PUT') {
    return sendJson(res, 405, { error: 'Use POST' })
  }

  if (sub === 'walkthrough') {
    if (!opts.repoRoot || packVideoCapability(opts.repoRoot) !== 'server') {
      return sendJson(res, 501, {
        error: 'This deployment cannot render video (no renderer, ffmpeg or Chromium)',
      })
    }
    const body = JSON.parse((await readBytes(req)).toString('utf8')) as { state?: unknown }
    if (!body?.state) return sendJson(res, 400, { error: 'Body must carry the document state' })
    return renderWalkthrough(res, outDir, opts.repoRoot, body)
  }

  const name = sub.startsWith('file/') ? decodeURIComponent(sub.slice('file/'.length)) : ''
  if (!name || !PACK_NAME.test(name)) {
    return sendJson(res, 400, { error: 'Artifacts are POSTed to /api/pack/file/<name>' })
  }
  const data = await readBytes(req)
  if (!data.length) return sendJson(res, 400, { error: 'Empty artifact' })
  await writeArtifact(outDir, name, data)
  return sendJson(res, 200, { ok: true, name, bytes: data.length })
}
