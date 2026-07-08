// PLACEHOLDER — discarded at merge; real impl lands from the presence agent.
//
// Contract (fixed): attachPresence(server, { path: '/ws' }) — attaches the
// WebSocket presence relay to an existing node:http server. This stub keeps
// server.ts compiling and refuses upgrades at the path cleanly.

import type { Server } from 'node:http'

export function attachPresence(server: Server, opts?: { path?: string }): void {
  const path = opts?.path ?? '/ws'
  server.on('upgrade', (req, socket) => {
    if ((req.url ?? '').split('?')[0] === path) socket.destroy()
  })
}
