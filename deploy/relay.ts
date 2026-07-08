// Presence relay — multiplayer milestone 1 (docs/design/multiplayer.md §2, §4).
// Pure fan-out of presence messages through per-plan WS rooms: no ops, no doc
// sync, no sequencing, no persistence, no auth. Server state per room is just
// Map<user, lastMessageByKind>, replayed to joiners so a late join still sees
// everyone's hello/cursor/selection/tool.
import { WebSocketServer, WebSocket } from 'ws'
import type { Server, IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'

/** Presence message kinds (design §2). Everything else is ignored. */
const KINDS = new Set(['hello', 'cur', 'sel', 'cam', 'tool', 'bye'])
const MAX_MSG_BYTES = 16 * 1024
const HEARTBEAT_MS = 30_000

interface Client {
  ws: WebSocket
  /** Learned from the first valid presence message (normally `hello`). */
  u: string | null
  alive: boolean
}

interface Room {
  clients: Set<Client>
  /** u → (kind → last raw JSON frame) — the entire server-side state. */
  presence: Map<string, Map<string, string>>
}

/**
 * Attach the presence relay to an existing HTTP server. Handles the upgrade
 * at `opts.path` (default `/ws`); the room id comes from the URL query
 * `?room=<id>`. Multiple rooms share one WebSocketServer.
 */
export function attachPresence(server: Server, opts?: { path?: string }): void {
  const path = opts?.path ?? '/ws'
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MSG_BYTES })
  const rooms = new Map<string, Room>()

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? '/', 'http://relay')
    if (url.pathname !== path) {
      // Not ours — destroy only if no other upgrade handler could claim it.
      if (server.listenerCount('upgrade') === 1) socket.destroy()
      return
    }
    const roomId = url.searchParams.get('room')
    if (!roomId) {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\nmissing ?room=<id>\n')
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req)
      join(roomId, ws)
    })
  })

  function join(roomId: string, ws: WebSocket): void {
    let room = rooms.get(roomId)
    if (!room) {
      room = { clients: new Set(), presence: new Map() }
      rooms.set(roomId, room)
    }
    const client: Client = { ws, u: null, alive: true }
    room.clients.add(client)

    // Replay existing peers' presence to the joiner, hello first per user so
    // the client knows name/color before any cursor lands.
    for (const byKind of room.presence.values()) {
      const hello = byKind.get('hello')
      if (hello && ws.readyState === WebSocket.OPEN) ws.send(hello)
      for (const [kind, raw] of byKind) {
        if (kind === 'hello') continue
        if (ws.readyState === WebSocket.OPEN) ws.send(raw)
      }
    }

    ws.on('pong', () => {
      client.alive = true
    })

    ws.on('message', (data, isBinary) => {
      if (isBinary) return
      const raw = data.toString()
      if (Buffer.byteLength(raw) > MAX_MSG_BYTES) return
      let msg: { t?: unknown; u?: unknown }
      try {
        msg = JSON.parse(raw)
      } catch {
        return
      }
      if (typeof msg?.t !== 'string' || typeof msg?.u !== 'string' || !KINDS.has(msg.t)) return
      client.u = msg.u
      if (msg.t === 'bye') room.presence.delete(msg.u)
      else {
        let byKind = room.presence.get(msg.u)
        if (!byKind) {
          byKind = new Map()
          room.presence.set(msg.u, byKind)
        }
        byKind.set(msg.t, raw)
      }
      broadcast(room, raw, client)
    })

    ws.on('close', () => leave(roomId, room, client))
    ws.on('error', () => ws.terminate())
  }

  function leave(roomId: string, room: Room, client: Client): void {
    if (!room.clients.delete(client)) return
    if (client.u) {
      // Same user may hold another socket (second tab) — only bye when gone.
      let stillHere = false
      for (const c of room.clients) if (c.u === client.u) stillHere = true
      if (!stillHere) {
        room.presence.delete(client.u)
        broadcast(room, JSON.stringify({ t: 'bye', u: client.u }), client)
      }
    }
    if (room.clients.size === 0) rooms.delete(roomId)
  }

  function broadcast(room: Room, raw: string, exclude: Client): void {
    for (const c of room.clients) {
      if (c !== exclude && c.ws.readyState === WebSocket.OPEN) c.ws.send(raw)
    }
  }

  // Heartbeat: ping every 30 s, terminate sockets that never ponged back.
  const heartbeat = setInterval(() => {
    for (const room of rooms.values()) {
      for (const c of room.clients) {
        if (!c.alive) {
          c.ws.terminate()
          continue
        }
        c.alive = false
        c.ws.ping()
      }
    }
  }, HEARTBEAT_MS)
  heartbeat.unref?.()
  server.on('close', () => {
    clearInterval(heartbeat)
    wss.close()
  })
}
