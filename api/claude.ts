// Vercel serverless function: /api/claude — Anthropic Messages proxy.
// Thin adapter over deploy/apiCore.ts (shared with the VPS server).
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { claudeInfo, claudeComplete } from '../deploy/apiCore'
import { readJsonBody } from './_body'

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method === 'GET') {
    const r = claudeInfo()
    res.status(r.status).json(r.json)
    return
  }
  if (req.method !== 'POST') {
    res.status(405).json({})
    return
  }
  const r = await claudeComplete(readJsonBody(req))
  res.status(r.status).json(r.json)
}
