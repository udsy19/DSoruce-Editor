// Vercel serverless function: /api/dwg — intentionally unavailable.
// DWG→DXF conversion needs the LibreDWG `dwg2dxf` native binary, which can't run
// in Vercel's serverless sandbox. The frontend catches this and surfaces the
// message; DXF upload is fully client-side and unaffected. For DWG support, run
// the Node service in deploy/server.ts on a host with LibreDWG installed.
import type { VercelRequest, VercelResponse } from '@vercel/node'

export default function handler(_req: VercelRequest, res: VercelResponse): void {
  res.status(503).json({
    error:
      'DWG conversion is unavailable on this serverless deployment (needs the LibreDWG dwg2dxf binary). Upload a DXF instead, or run the deploy/server.ts service on a host with LibreDWG.',
  })
}
