// deploy/shareStore.ts — the store + API behind the shareable web 3D viewer.
//
// ONE implementation, imported by BOTH runtimes that can actually serve it
// (they share Node's IncomingMessage/ServerResponse, so the handler itself is
// shared, not just the storage helpers):
//   • deploy/server.ts    — the Node service on the VPS   (PLANS_DIR)
//   • web/vite.config.ts  — the dev-server middleware      (web/.dev-plans)
// Vercel has no persistent disk, so `api/share/[[...path]].ts` answers 501
// there, exactly as `/api/plans` does — see deploy/VERCEL.md.
//
// This is deliberately NOT part of the plan store (`handlePlans`): the payload
// is binary (a glTF-binary scene), the audience is a client with a link rather
// than the plan's owner, and it carries none of the library's record semantics.
// It reuses the plan store's DIRECTORY, under its own `share/` subdirectory so
// a bundle can never be listed as a plan by that store's `*.json` readdir:
//
//   <dir>/share/<id>.glb    the exported scene   (model/gltf-binary)
//   <dir>/share/<id>.json   { id, name, createdAt, bytes }
//
// Routes (mounted at /api/share by both adapters):
//   POST /api/share/:id?name=<plan name>   raw GLB body  → { ok, id, bytes }
//   GET  /api/share/:id                    → ShareMeta
//   GET  /api/share/:id/model.glb          → the GLB bytes
// The viewer PAGE lives at /share/:id and is served by each adapter (dev: vite
// transforms web/viewer.html; prod: dist/viewer.html).

import type { IncomingMessage, ServerResponse } from 'node:http'
import { promises as fs } from 'node:fs'
import path from 'node:path'

/** Same shape as the plan store's id rule — also keeps ids filename-safe. */
export const SHARE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

/** A published scene's metadata (what the viewer's header is built from). */
export interface ShareMeta {
  id: string
  name: string
  createdAt: string // ISO
  bytes: number
}

/** Largest GLB accepted by POST (a fit-out scene is a few MB). */
const MAX_GLB = 64 * 1024 * 1024

const shareDir = (dir: string): string => path.join(dir, 'share')
const glbPath = (dir: string, id: string): string => path.join(shareDir(dir), `${id}.glb`)
const metaPath = (dir: string, id: string): string => path.join(shareDir(dir), `${id}.json`)

/** Store one published scene (atomic tmp+rename, as the plan store writes). */
export async function putShare(
  dir: string,
  id: string,
  name: string,
  glb: Uint8Array,
): Promise<ShareMeta> {
  await fs.mkdir(shareDir(dir), { recursive: true })
  const meta: ShareMeta = {
    id,
    name: name || 'Untitled Plan',
    createdAt: new Date().toISOString(),
    bytes: glb.byteLength,
  }
  const stamp = `${process.pid}.${Date.now()}`
  const gTmp = `${glbPath(dir, id)}.${stamp}.tmp`
  const mTmp = `${metaPath(dir, id)}.${stamp}.tmp`
  await fs.writeFile(gTmp, glb)
  await fs.rename(gTmp, glbPath(dir, id))
  await fs.writeFile(mTmp, JSON.stringify(meta))
  await fs.rename(mTmp, metaPath(dir, id))
  return meta
}

/** Metadata for a published scene, or null when the link is unknown. */
export async function getShareMeta(dir: string, id: string): Promise<ShareMeta | null> {
  try {
    return JSON.parse(await fs.readFile(metaPath(dir, id), 'utf8')) as ShareMeta
  } catch {
    return null
  }
}

/** The stored GLB, or null when the link is unknown. */
export async function getShareModel(dir: string, id: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(glbPath(dir, id))
  } catch {
    return null
  }
}

/** `/share/<id>` → `<id>`; null when the path is not a viewer-page request. */
export function sharePageId(pathname: string): string | null {
  const m = /^\/share\/([^/]+)\/?$/.exec(pathname)
  if (!m) return null
  const id = decodeURIComponent(m[1])
  return SHARE_ID.test(id) ? id : null
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
      if (size > MAX_GLB) {
        req.destroy()
        reject(Object.assign(new Error('Model exceeds 64 MB'), { statusCode: 413 }))
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/**
 * Serve one `/api/share/*` request. `sub` is the path AFTER `/api/share`,
 * with no leading slash ('' · '<id>' · '<id>/model.glb') — connect strips the
 * mount prefix in dev, and `deploy/server.ts` slices it off in prod.
 */
export async function handleShareApi(
  req: IncomingMessage,
  res: ServerResponse,
  sub: string,
  dir: string,
): Promise<void> {
  const [rawId, tail] = sub.split('/')
  const id = rawId ? decodeURIComponent(rawId) : ''
  if (!id || !SHARE_ID.test(id)) {
    return sendJson(res, 400, { error: 'Share links are /api/share/<id>' })
  }

  if (req.method === 'POST' || req.method === 'PUT') {
    const name = new URL(req.url ?? '/', 'http://internal').searchParams.get('name') ?? ''
    const glb = await readBytes(req)
    // A GLB always starts with the ASCII magic 'glTF'.
    if (glb.length < 20 || glb.toString('ascii', 0, 4) !== 'glTF') {
      return sendJson(res, 400, { error: 'Body must be a glTF-binary (.glb) model' })
    }
    const meta = await putShare(dir, id, name, glb)
    return sendJson(res, 200, { ok: true, ...meta })
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendJson(res, 405, { error: 'Use GET or POST' })
  }

  if (tail === 'model.glb') {
    const glb = await getShareModel(dir, id)
    if (!glb) return sendJson(res, 404, { error: 'No shared model with that link' })
    res.statusCode = 200
    res.setHeader('content-type', 'model/gltf-binary')
    res.setHeader('content-length', String(glb.byteLength))
    res.setHeader('cache-control', 'no-cache')
    return void res.end(req.method === 'HEAD' ? undefined : glb)
  }
  if (tail) return sendJson(res, 404, { error: 'Unknown share endpoint' })

  const meta = await getShareMeta(dir, id)
  if (!meta) return sendJson(res, 404, { error: 'No shared model with that link' })
  return sendJson(res, 200, meta)
}
