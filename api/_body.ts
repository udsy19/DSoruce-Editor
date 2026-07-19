// Shared helper for the Vercel functions: normalise the request body into a
// plain object regardless of how @vercel/node parsed it. For an
// `application/json` POST, `req.body` is already an object; if the client sent
// a raw string (or nothing), fall back to a tolerant JSON.parse.
import type { VercelRequest } from '@vercel/node'

export function readJsonBody(req: VercelRequest): Record<string, unknown> {
  const b = req.body
  if (b && typeof b === 'object') return b as Record<string, unknown>
  if (typeof b === 'string' && b.length) {
    try {
      return JSON.parse(b) as Record<string, unknown>
    } catch {
      return {}
    }
  }
  return {}
}
