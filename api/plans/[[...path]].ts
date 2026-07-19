// Vercel serverless function: /api/plans[/*] — intentionally unavailable.
// The server plan store writes to local disk, which Vercel's serverless
// filesystem doesn't persist. The plan library is primarily client-side
// (IndexedDB); syncPlans() in web/src/persist/sync.ts is network-resilient and
// treats a non-200 here as "offline", leaving local data intact. To enable
// cross-device sync, run deploy/server.ts (with a persistent PLANS_DIR) or back
// this route with a durable store (Vercel Blob/KV).
import type { VercelRequest, VercelResponse } from '@vercel/node'

export default function handler(_req: VercelRequest, res: VercelResponse): void {
  res.status(501).json({
    error:
      'Server plan sync is not available on this deployment; plans are stored locally in your browser (IndexedDB).',
  })
}
