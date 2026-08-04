// Vercel serverless function: /api/share[/*] — intentionally unavailable.
// The share store writes a GLB + its metadata to local disk (deploy/shareStore.ts),
// which Vercel's serverless filesystem doesn't persist. `/share/<id>` still
// loads the viewer page (vercel.json rewrites it to the built viewer.html); the
// viewer surfaces this 501 as "this deployment has no share store" instead of
// spinning on a model that can never arrive, and the Export menu falls back to
// downloading the .glb. To publish share links, run deploy/server.ts (with a
// persistent PLANS_DIR) or back this route with a durable blob store.
import type { VercelRequest, VercelResponse } from '@vercel/node'

export default function handler(_req: VercelRequest, res: VercelResponse): void {
  res.status(501).json({
    error:
      'Shareable 3D links are not available on this deployment (no persistent storage). Run the DSource server (deploy/server.ts) to publish share links.',
  })
}
