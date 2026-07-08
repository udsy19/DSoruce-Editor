// Presence client — multiplayer milestone 1 (docs/design/multiplayer.md §2).
// Pure fan-out state, no consistency: connects to the relay room, announces
// itself with `hello`, streams throttled cursor / selection / tool messages,
// and merges peers' presence into a Map surfaced via `onPeersChange`.
// Pure TS, no React — the host (App) owns wiring it to EditorCanvas + UI.

/** Presence protocol version, sent in `hello` (design §5 schema gate). */
export const PRESENCE_SCHEMA = 1

/** Cursor throttle: ≤30 Hz, trailing edge (the final position always lands). */
const CURSOR_MIN_INTERVAL_MS = 1000 / 30
const BACKOFF_MIN_MS = 500
const BACKOFF_MAX_MS = 8000

export interface PresenceSelf {
  u: string
  name: string
  color: string
}

/** A remote participant: identity from `hello`, live fields merged per kind. */
export interface Peer {
  u: string
  name: string
  color: string
  /** 2D cursor, world meters. */
  x?: number
  y?: number
  /** Selected doc component ids + zone id. */
  ids?: number[]
  zone?: number | null
  tool?: string
}

type PresenceMsg =
  | { t: 'hello'; u: string; name: string; color: string; schema: number }
  | { t: 'cur'; u: string; x: number; y: number }
  | { t: 'sel'; u: string; ids: number[]; zone: number | null }
  | { t: 'cam'; u: string; pos: [number, number, number]; target: [number, number, number] }
  | { t: 'tool'; u: string; tool: string }
  | { t: 'bye'; u: string }

export interface PresenceClientOpts {
  /** Relay endpoint: absolute (`ws://…`) or a path like `/ws` (scheme+host
   *  then derive from `location`, `wss:` on https pages). */
  url: string
  /** Room id (plan id). */
  room: string
  self: PresenceSelf
}

/**
 * One WS presence session. Auto-reconnects with capped exponential backoff
 * (0.5 s → 8 s), re-announcing `hello` on every (re)connect; the relay replays
 * existing peers to us on join, so the peers map self-heals.
 */
export class PresenceClient {
  /** Fired with a fresh Map on every peer add / update / remove. */
  onPeersChange: ((peers: Map<string, Peer>) => void) | null = null

  private readonly url: string
  private readonly self: PresenceSelf
  private ws: WebSocket | null = null
  private peers = new Map<string, Peer>()
  private closed = false
  private backoffMs = BACKOFF_MIN_MS
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null

  private pendingCur: { x: number; y: number } | null = null
  private curTimer: ReturnType<typeof setTimeout> | null = null
  private lastCurSent = 0

  constructor(opts: PresenceClientOpts) {
    this.self = opts.self
    const base = /^wss?:\/\//.test(opts.url)
      ? opts.url
      : `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}${opts.url}`
    this.url = `${base}${base.includes('?') ? '&' : '?'}room=${encodeURIComponent(opts.room)}`
    this.connect()
  }

  // ---- outbound ----

  /** Throttled (≤30 Hz, trailing edge) cursor broadcast in world meters. */
  sendCursor(x: number, y: number): void {
    this.pendingCur = { x, y }
    if (this.curTimer != null) return
    const wait = Math.max(0, this.lastCurSent + CURSOR_MIN_INTERVAL_MS - Date.now())
    this.curTimer = setTimeout(() => {
      this.curTimer = null
      this.lastCurSent = Date.now()
      if (this.pendingCur) {
        const { x: cx, y: cy } = this.pendingCur
        this.pendingCur = null
        this.send({ t: 'cur', u: this.self.u, x: cx, y: cy })
      }
    }, wait)
  }

  sendSelection(ids: number[], zone: number | null): void {
    this.send({ t: 'sel', u: this.self.u, ids, zone })
  }

  sendTool(tool: string): void {
    this.send({ t: 'tool', u: this.self.u, tool })
  }

  /** Intentional leave: announce bye, stop reconnecting, drop all peers. */
  close(): void {
    this.closed = true
    if (this.reconnectTimer != null) clearTimeout(this.reconnectTimer)
    if (this.curTimer != null) clearTimeout(this.curTimer)
    this.reconnectTimer = null
    this.curTimer = null
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.send({ t: 'bye', u: this.self.u })
    }
    this.ws?.close()
    this.ws = null
    if (this.peers.size > 0) {
      this.peers = new Map()
      this.emitPeers()
    }
  }

  // ---- connection ----

  private connect(): void {
    if (this.closed) return
    const ws = new WebSocket(this.url)
    this.ws = ws
    ws.onopen = () => {
      this.backoffMs = BACKOFF_MIN_MS
      this.send({
        t: 'hello',
        u: this.self.u,
        name: this.self.name,
        color: this.self.color,
        schema: PRESENCE_SCHEMA,
      })
    }
    ws.onmessage = (ev) => {
      if (typeof ev.data !== 'string') return
      let msg: PresenceMsg
      try {
        msg = JSON.parse(ev.data)
      } catch {
        return
      }
      if (!msg || typeof msg.t !== 'string' || typeof msg.u !== 'string') return
      this.merge(msg)
    }
    ws.onclose = () => {
      if (this.ws !== ws) return // superseded by a newer socket
      this.ws = null
      // Peers are unknowable while offline; the join replay restores them.
      if (this.peers.size > 0) {
        this.peers = new Map()
        this.emitPeers()
      }
      this.scheduleReconnect()
    }
    ws.onerror = () => {
      // onclose follows and owns the retry; nothing to do here.
    }
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer != null) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, this.backoffMs)
    this.backoffMs = Math.min(this.backoffMs * 2, BACKOFF_MAX_MS)
  }

  private send(msg: PresenceMsg): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg))
    // Presence is lossy by design — silently drop while disconnected.
  }

  // ---- inbound merge ----

  private merge(msg: PresenceMsg): void {
    if (msg.u === this.self.u) return // relay excludes the sender, but be safe
    if (msg.t === 'bye') {
      if (!this.peers.delete(msg.u)) return
      this.emitPeers()
      return
    }
    if (msg.t === 'cam') return // 3D frustums are a later milestone
    let peer = this.peers.get(msg.u)
    if (!peer) {
      // cur/sel/tool can outrun hello after a race — placeholder until it lands.
      peer = { u: msg.u, name: '', color: '#8a9099' }
    }
    const next: Peer = { ...peer }
    switch (msg.t) {
      case 'hello':
        next.name = msg.name
        next.color = msg.color
        break
      case 'cur':
        next.x = msg.x
        next.y = msg.y
        break
      case 'sel':
        next.ids = msg.ids
        next.zone = msg.zone
        break
      case 'tool':
        next.tool = msg.tool
        break
    }
    this.peers.set(msg.u, next)
    this.emitPeers()
  }

  private emitPeers(): void {
    this.onPeersChange?.(new Map(this.peers))
  }
}
