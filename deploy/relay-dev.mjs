// Standalone presence relay for local dev. Node >= 23.6 required (24 is fine):
// relay.ts is imported directly via Node's built-in TypeScript type-stripping,
// so there is no build step.
//
//   cd deploy && npm install && node relay-dev.mjs      # ws://localhost:8787/ws
//   PORT=9000 node relay-dev.mjs                        # custom port
//
// The vite dev server proxies '/ws' here (web/vite.config.ts), so app pages
// just open a WebSocket to /ws?room=<plan-id>.
import http from 'node:http'
import process from 'node:process'

const { attachPresence } = await import('./relay.ts')

const port = Number(process.env.PORT || 8787)
const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain' })
  res.end('dsource presence relay — connect via ws at /ws?room=<id>\n')
})
attachPresence(server)
server.listen(port, () => {
  console.log(`[relay-dev] presence relay listening on ws://localhost:${port}/ws`)
})
