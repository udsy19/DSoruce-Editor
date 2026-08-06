// Dev-only DWG→DXF conversion endpoint.
//
// The browser can't run LibreDWG, so in dev we POST the raw .dwg bytes to
// `/api/dwg`; this middleware writes them to a temp file, shells out to
// `dwg2dxf` (LibreDWG, installed system-wide), reads the resulting .dxf text
// back, and responds `{ dxf }`. On failure it responds `{ error }` with a
// non-2xx status. Register in vite.config.ts: `plugins: [..., dwgConvertPlugin()]`.
//
// Request:  POST /api/dwg   body = raw DWG bytes (application/octet-stream)
// Response: 200 { dxf: string }   |   4xx/5xx { error: string }

import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Plugin } from 'vite'
import { describeExit, trimStderr, verifyDxf } from './dwgVerify'

function readBytes(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function runDwg2Dxf(dwgPath: string, dxfPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn('dwg2dxf', ['-o', dxfPath, dwgPath], { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    proc.stderr.on('data', (d) => (stderr += d))
    proc.on('error', (err) =>
      reject(
        new Error(
          `Failed to spawn dwg2dxf (is LibreDWG installed and on PATH?): ${err.message}`,
        ),
      ),
    )
    // `close` gives (code, signal). A signalled child reports code === null,
    // so reading the code alone turned a SIGSEGV into "dwg2dxf exited null".
    proc.on('close', (code, signal) => {
      if (code === 0 && !signal) resolve()
      else {
        const tail = trimStderr(stderr)
        reject(new Error(describeExit('dwg2dxf', code, signal) + (tail ? ` (${tail})` : '')))
      }
    })
  })
}

export function dwgConvertPlugin(): Plugin {
  return {
    name: 'ds-dwg-convert',
    apply: 'serve', // dev-only
    configureServer(server) {
      // Params are left to vite's connect inference, then narrowed to the
      // Node http shapes we use (vite's Connect types degrade without
      // @types/node, which this browser-only project intentionally omits).
      server.middlewares.use('/api/dwg', async (rawReq, rawRes) => {
        const req = rawReq as unknown as IncomingMessage
        const res = rawRes as unknown as ServerResponse
        res.setHeader('content-type', 'application/json')
        if (req.method !== 'POST') {
          res.statusCode = 405
          res.end(JSON.stringify({ error: 'Use POST with raw DWG bytes' }))
          return
        }

        const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`
        const dwgPath = join(tmpdir(), `ds-${stamp}.dwg`)
        const dxfPath = join(tmpdir(), `ds-${stamp}.dxf`)
        try {
          const bytes = await readBytes(req)
          if (bytes.length === 0) {
            res.statusCode = 400
            res.end(JSON.stringify({ error: 'Empty request body' }))
            return
          }
          await fs.writeFile(dwgPath, bytes)
          await runDwg2Dxf(dwgPath, dxfPath)
          const dxf = await fs.readFile(dxfPath, 'utf8')
          // The exit code said this worked; check the bytes before believing
          // it. dwg2dxf truncates and still exits 0 (see dwgVerify.ts).
          const verdict = verifyDxf(dxf)
          if (!verdict.ok) {
            res.statusCode = 502
            res.end(
              JSON.stringify({
                error: `DWG conversion did not complete: ${verdict.message}.`,
                defect: verdict.defect,
              }),
            )
            return
          }
          res.statusCode = 200
          res.end(JSON.stringify({ dxf }))
        } catch (e) {
          res.statusCode = 500
          res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }))
        } finally {
          fs.unlink(dwgPath).catch(() => {})
          fs.unlink(dxfPath).catch(() => {})
        }
      })
    },
  }
}
