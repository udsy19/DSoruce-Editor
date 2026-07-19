// Vercel serverless function: /api/agent — OpenAI-compatible LLM proxy.
// Thin adapter over the shared, env-agnostic core in deploy/apiCore.ts (the
// same core the VPS server uses). Vercel parses the JSON body into `req.body`.
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { agentInfo, agentComplete } from '../deploy/apiCore'
import { readJsonBody } from './_body'

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method === 'GET') {
    const r = agentInfo()
    res.status(r.status).json(r.json)
    return
  }
  if (req.method !== 'POST') {
    res.status(405).json({})
    return
  }
  const r = await agentComplete(readJsonBody(req))
  res.status(r.status).json(r.json)
}
