// Vercel serverless function: /api/bank/* — reverse proxy to the material-bank
// origin (BANK_UPSTREAM). Catch-all so /api/bank/match etc. all route here.
// Thin adapter over deploy/apiCore.bankFetch (shared with the VPS server).
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { Readable } from 'node:stream'
import { bankFetch } from '../../deploy/apiCore'

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://internal')
  const method = req.method ?? 'GET'
  // The bank surface the client uses is GET-only; forward without a body.
  const upstream = await bankFetch(method, url.pathname, url.search, req.headers)
  res.status(upstream.status)
  for (const h of ['content-type', 'cache-control', 'etag']) {
    const v = upstream.headers.get(h)
    if (v) res.setHeader(h, v)
  }
  if (upstream.body) Readable.fromWeb(upstream.body as never).pipe(res)
  else res.end()
}
