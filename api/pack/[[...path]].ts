// Vercel serverless function: /api/pack[/*] — intentionally unavailable.
// The pack writer stores the deliverable pack on local disk (deploy/packStore.ts)
// and shells out to a GPU-capable headless Chromium + ffmpeg for the walkthrough;
// Vercel has neither a persistent filesystem nor those binaries. The app treats
// a non-OK answer here as "no server sink", which is a normal state, not an
// error: `buildDeliverablePack` then packs the identical artifacts into one
// .zip download and encodes the walkthrough in the browser with WebCodecs.
// To land a pack straight in `out/`, run the dev server or deploy/server.ts.
import type { VercelRequest, VercelResponse } from '@vercel/node'

export default function handler(_req: VercelRequest, res: VercelResponse): void {
  res.status(501).json({
    error:
      'Server-written deliverable packs are not available on this deployment (no persistent ' +
      'storage or video renderer). The Deliverable pack action downloads a .zip instead.',
  })
}
