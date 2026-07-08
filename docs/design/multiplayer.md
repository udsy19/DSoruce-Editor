# Multiplayer Architecture — Research & Decision

Status: **design accepted, implementation not started.** Scope: real-time co-editing of one plan
document by a small team (2–10 people), Rayon-style (`research/01-rayon.md`). No implementation here —
this document is the decision record and the seam inventory the implementation will follow.

## 0. Ground truth (verified constraints)

1. **The document of record lives inside wasm.** `Document` owns walls / components / zones /
   keepouts / selection / `next_id` / `cad_json` (`crates/ds-core/src/document.rs:8-31`), and the wasm
   `Editor` holds exactly one (`crates/ds-core/src/lib.rs:68-70`). TS renders by re-reading `state()`
   (`lib.rs:220-222`, `web/src/editor/EditorCanvas.ts:288-290`).
2. **All mutation already flows through a narrow seam**: the `Editor` wasm methods (§3 enumerates all
   32) plus the TS-side CAD store (`web/src/cad/store.ts:9-95`), which persists into the core as an
   opaque blob via `set_cad_json` on every change (`EditorCanvas.ts:250-254`, `lib.rs:358-360`).
3. **Snapshots are lossless and cheap.** `snapshot()/restore()/from_snapshot` round-trip the whole doc
   as a JSON string *including* `next_id` (`lib.rs:379-401`; identity test `document.rs:417-455`). The
   AI consequence engine already forks a scratch editor per preview (`web/src/ai/engine.ts:73`), and
   `autoGenerate` snapshots every candidate (`EditorCanvas.ts:366`) — forking is a hot path today.
4. **Mutators are deterministic.** `generate(program, seed, keep_confirmed)` is seeded and
   deterministic per seed (`lib.rs:325-339`, CLAUDE.md); zone ops return typed `Result`s whose
   success/failure depends only on doc state (`document.rs:168-300`); by-id ops on missing ids are
   silent no-ops (`lib.rs:169-174, 187-192`). Same ops in same order ⇒ same document.
5. **Ids are a single monotonic counter** (`document.rs:39-42`) allocated *inside* wasm — the one
   thing that makes concurrent op creation interesting (§1b).
6. **Server**: the material-bank VPS (FastAPI `serve.py` + Caddy at `46.202.179.28.sslip.io`) exists;
   app deployment there is parked, but a small WS relay can live behind the same Caddy eventually.

## 1. Approach comparison

### (a) CRDT libraries (Yjs / Automerge / Loro)

Mapping is natural on paper: `Y.Map<id, entity>` per collection, entity fields as map values; Loro and
Automerge similar. The killer question is *where the CRDT lives*:

- **JS-side CRDT = two sources of truth.** The doc is Rust. A Yjs doc in TS would shadow-copy every
  wall/component/zone; every local `Editor` call must be mirrored into the CRDT, and every remote CRDT
  delta must be pushed back into wasm. But the wasm API cannot apply granular remote deltas: there is
  **no `delete_wall`, no `move_wall`, no by-value zone setter beyond `resize_zone`** — the only
  universal write-back is `restore(fullJson)`, which clobbers selection and defeats the point of
  field-level merging. Shadow-copy sync is a standing drift bug factory and violates the project's
  core convention ("core is the source of truth", CLAUDE.md).
- **Rust-side CRDT (yrs / loro-rs compiled into ds-core)** is the honest strong option: rewrite
  `Document` so entities are CRDT types, export update bytes across the wasm boundary. It buys real
  field-level merge and true offline. Cost: rewriting `document.rs`/`model.rs`/`zone.rs` and all ~20
  mutators against CRDT containers (~1.5k lines touched), snapshot semantics change everywhere
  (`useAgent` undo, candidate gallery, `.dsource` files), wasm binary grows ~0.5–1 MB, and `layout.rs`
  (1.8k lines mutating `Vec`s directly) must be ported.
- **What CRDT granularity actually buys here**: automatic merge when two users edit *the same field of
  the same entity* concurrently, and offline merge. In an office test-fit editor the entity count is a
  few hundred, concurrent same-entity edits are rare and visually obvious, and per-op last-writer-wins
  is acceptable. Offline editing is not a product requirement (online web platform, per memory).
- **CRDT + `generate()` is still not magic**: two concurrent `generate()` calls merge into interleaved
  garbage under any CRDT; you need ordering or a lock for it regardless (§5).
- **Undo**: CRDT undo managers give per-user scoped undo (good), but only over CRDT ops — the CAD blob
  and `ec.program` (which lives outside the doc, `web/src/ai/useAgent.ts:57-59`) still need bespoke
  handling.

Verdict: high cost, and the benefit (field-level merge, offline) is mostly outside our requirements.

### (b) Op-log replication with server sequencing ← **recommended**

Every mutating `Editor` call is also serialized as an `Op` (§3), sent to a relay that assigns a global
sequence number and broadcasts; every client applies ops **in sequence order** against its own wasm
editor. Because mutators are deterministic (ground truth #4), identical op order ⇒ identical documents
— classic state-machine replication, and the relay *is* the sequencer, so there is no distributed
consensus to solve.

- **Convergence with concurrent ops**: the server picks the order. Cross-entity conflicts (A moves a
  desk B just deleted) resolve as no-ops (ground truth #4). Same-field conflicts are per-op LWW —
  acceptable at this granularity. Zone-op errors are deterministic functions of doc state, so all
  replicas fail identically (the origin client surfaces the error, others silently no-op).
- **Latency / optimistic echo**: apply locally at once; if a foreign op arrives sequenced *before* an
  un-acked local op, roll back to the last acked snapshot and replay in server order. Rollback is
  exactly `restore()` + re-apply — cheap (ground truth #3; the AI does snapshot-fork-apply per
  keystroke today). At 2–10 users the rebase path is rare.
- **The id wrinkle** (ground truth #5): `add_wall`/`add_component` allocate ids inside wasm, so a
  locally-echoed create may get a *different* id after rebase. Convergence is unaffected (everyone
  replays server order), and selection is local-only (§3), so a provisional id is only a transient UI
  reference. If it ever bites, the escape hatch is client-partitioned ids (client tag in high bits) —
  a small core change, deferred.
- **`generate()` is the best case for op-log**: the op is just `{program, seed, keep_confirmed}` —
  bytes, not the thousand entities it produces. A CRDT would ship the whole diff. One required change:
  `autoGenerate` currently runs its 18-seed search by mutating the **live** editor
  (`EditorCanvas.ts:349-375`); under multiplayer the search must run on a `from_snapshot` scratch
  clone and only the winning generate is dispatched as an op.
- **The CAD store**: v1 keeps the existing blob seam — a `set_cad_json` op, whole-layer LWW. Honest
  cost: two people drafting CAD linework simultaneously lose to each other. Acceptable initially
  (drafting is a solo activity in practice); the `CadStore` contract already has granular
  `add/update/remove` (`web/src/cad/model.ts:128-148`), so upgrading to per-entity CAD ops later is a
  contained change. Throttle/debounce the blob op (it currently fires per change).
- **Undo**: snapshot-stack undo (both current stacks: `useAgent.ts:59`, `store.ts:6-7`) breaks under
  co-editing — restoring my snapshot reverts your work. §3 picks per-user inverse-op undo.

### (c) Snapshot turn-taking / edit lease (Figma-style locking)

One client holds the **edit lease** per plan; everyone else is a live follower. The editor dispatches
ops (or, crudest form, throttled snapshots) through the relay; followers apply/`restore()`. Trivially
correct — no concurrency exists. This is not a rival end-state but **milestone 2 of the op-log plan**
(§6): the lease version already needs the relay, the op envelope, join-snapshot, and reconnect logic;
releasing the lease requirement later upgrades it to (b) without discarding anything.

### Decision

**Op-log with server sequencing**, staged behind presence and an edit-lease milestone. It is the only
option that keeps the wasm core as the single source of truth, exploits the two properties this
codebase already paid for (deterministic mutators, cheap lossless snapshots), and reaches co-editing
in weeks not months. Revisit CRDT-in-Rust only if offline editing becomes a requirement.

## 2. Presence layer (independent, ships first)

Zero consistency requirements — pure fan-out through the same WS room, separate message kind, never
sequenced, never persisted. Shippable before any doc sync.

```ts
type Presence =
  | { t: 'hello';  u: string; name: string; color: string; schema: number } // on join
  | { t: 'cur';    u: string; x: number; y: number }            // 2D cursor, world meters, ≤30 Hz
  | { t: 'sel';    u: string; ids: number[]; zone: number|null } // selection highlight (doc ids)
  | { t: 'cam';    u: string; pos: [n,n,n]; target: [n,n,n] }   // 3D frustum, ≤10 Hz
  | { t: 'tool';   u: string; tool: string }                    // optional: what they're doing
  | { t: 'bye';    u: string }
```

Client renders remote cursors/selection tints in `EditorCanvas.render()` (world→screen transform
already exists, `EditorCanvas.ts:269-271`) and camera frustums as cheap line meshes in
`three/Scene3D`. Server keeps a per-room `Map<user, lastPresence>` and replays it to joiners; that is
the entire server-side state for this milestone. Note: today selection lives *in the doc*
(`document.rs:20`) — presence broadcasts it, but it must **not** ride the op-log (§3).

## 3. Seam inventory & the `Op` type

All 32 `Editor` wasm methods (`crates/ds-core/src/lib.rs`), classified:

| Class | Methods (lib.rs line) |
|---|---|
| **Replicated mutators (15)** | `add_wall`:83, `add_component`:96, `add_keepout`:120, `clear_keepouts`:127, `move_component`:169, `set_component_rotation`:179, `delete_component`:187, `assign_product`:197, `set_decision`:213, `generate`:328, `set_cad_json`:358, `merge_zones`:408, `split_zone`:418, `set_zone_type`:433, `resize_zone`:443 |
| **Local-only mutators (4)** | `select_at`:133, `clear_selection`:147, `move_selected`:152, `delete_selected`:161 — selection is per-user; the dispatch seam resolves selection → id and emits `move_component`/`delete_component` ops instead |
| **Privileged whole-doc (1)** | `restore`:385 — becomes a `replace` op (candidate apply `EditorCanvas.ts:385-393`, project open `App.tsx:164`) |
| **Read-only (12)** | `state`, `metrics`, `zones`, `zone_stats`, `layout_score`, `plate`, `get_cad_json`, `circulation`, `snapshot`, `zone_at`, `new`, `from_snapshot` — untouched |

```ts
// web/src/net/ops.ts (future) — one variant per replicated mutator, args = wasm signature.
type Op =
  | { op: 'add_wall'; ax: number; ay: number; bx: number; by: number; thickness: number }
  | { op: 'add_component'; category: string; x: number; y: number; w: number; h: number }
  | { op: 'add_keepout'; x: number; y: number; w: number; h: number; label: string }
  | { op: 'clear_keepouts' }
  | { op: 'move_component'; id: number; x: number; y: number }
  | { op: 'set_component_rotation'; id: number; radians: number }
  | { op: 'delete_component'; id: number }
  | { op: 'assign_product'; id: number; product_id: string; name: string; price_inr: number | null }
  | { op: 'set_decision'; id: number; state: 'Open' | 'InReview' | 'Confirmed' }
  | { op: 'generate'; program: Program; seed: string /* bigint-safe */; keep_confirmed: boolean }
  | { op: 'set_cad_json'; json: string }                       // v1: whole-blob LWW, debounced
  | { op: 'merge_zones'; a: number; b: number }
  | { op: 'split_zone'; id: number; axis: 'Vertical' | 'Horizontal'; at: number }
  | { op: 'set_zone_type'; id: number; zone_type: string }
  | { op: 'resize_zone'; id: number; x: number; y: number; w: number; h: number }
  | { op: 'replace'; snapshot: string }                        // restore(): candidate apply / import

interface OpMsg { t: 'op'; room: string; seq?: number; client: string; clientSeq: number; body: Op }
```

**Interception point**: one `dispatch(op)` method on `EditorCanvas` that (1) applies to `this.ed`,
(2) sends to the relay. Every current direct `this.ed.<mutator>()` call site
(`EditorCanvas.ts:242-243, 311, 315, 319, 500, 509, 536, 586`; keepout/import path `App.tsx:235`)
routes through it. The AI already funnels through two functions — `applyLive`/`applyCall`
(`web/src/ai/engine.ts:18-57`) — whose `ToolCall`s (`web/src/ai/contract.ts:6-27`) map 1:1 onto ops
(`regenerate`→`generate`, `remove_selection`→resolved `delete_component`, zone ops verbatim), so **AI
approve = dispatch the plan's ops**; previews stay on scratch clones and never touch the network.
`ec.program` rides the `generate` op (it is an arg), fixing the "program lives outside the doc"
wrinkle (`useAgent.ts:57-58`) for free.

**Undo: per-user, via inverse ops.** Global snapshot undo (`useAgent.ts:59-116`, CAD
`store.ts:56-64`) would revert teammates' work. `dispatch` captures the inverse at emit time (before-
values read from `state()`): `add_*`→`delete_component`, `move/rotate/assign/decision/zone ops`→same
op with prior values, `delete_component`→`add_component`+restyle. `generate`/`replace` get a snapshot-
valued `replace` inverse — undoing one honestly reverts concurrent edits made in between; surface it
in UI copy ("Restore layout before generate?"), same blast radius the op itself had. Per-user undo =
pop my inverse stack, dispatch as a *new* op (never rewind `seq`).

## 4. Server component: the relay/sequencer

Rooms keyed by plan id; per room: `seq` counter, latest snapshot + `snapSeq`, op ring buffer since the
snapshot, presence map. Join: send `{t:'init', seq, snapshot, ops[]}`; client `restore()`s and
replays. Ops: assign `seq`, append, broadcast (including originator — the ack). Compaction: every N
ops (e.g. 200) ask one client for `snapshot()` (server never runs wasm), or accept it lazily.
Persistence v1: room snapshot to a JSON file on compaction. ~150 lines of Python asyncio behind the
existing Caddy (`wss://plans.<vps>/ws/{plan_id}`), same box as `serve.py`; deployment stays parked
until the app itself deploys. Sketch:

```python
# relay.py — asyncio + websockets, no framework needed
rooms: dict[str, Room] = {}          # Room: clients, seq, snapshot, snap_seq, ops[], presence

async def handle(ws, plan_id):
    room = rooms.setdefault(plan_id, Room())
    await ws.send(json.dumps({"t": "init", "seq": room.seq,
                              "snapshot": room.snapshot, "ops": room.ops_since_snapshot}))
    for p in room.presence.values(): await ws.send(p)      # replay presence
    room.clients.add(ws)
    try:
        async for raw in ws:
            msg = json.loads(raw)
            if msg["t"] == "op":
                if msg.get("schema") != room.schema: continue   # version gate, §5
                room.seq += 1; msg["seq"] = room.seq
                room.ops.append(msg)
                await broadcast(room, msg)                  # includes sender = ack
                if len(room.ops) > COMPACT_EVERY: await request_snapshot(room)
            elif msg["t"] in PRESENCE_KINDS:
                room.presence[msg["u"]] = raw
                await broadcast(room, msg, exclude=ws)
            elif msg["t"] == "snapshot":                    # compaction reply / resync source
                room.snapshot, room.snap_seq = msg["snapshot"], msg["seq"]; room.ops.clear()
    finally:
        room.clients.discard(ws); await broadcast_bye(room, ws)
```

## 5. Failure modes

- **Reconnect / seq gap**: client tracks `lastSeq`; any received `seq != lastSeq + 1` or WS drop →
  send `{t:'resync'}`, get `init` (snapshot + tail ops), `restore()` + replay. Undo stack survives
  (inverse ops are content-addressed by entity id, not seq).
- **Stale wasm schema**: add a `SCHEMA_VERSION: u32` const exposed from ds-core; clients send it in
  `hello` and on every op; the room pins the highest seen. Mismatched client → relay flags it,
  client drops to read-only + "refresh to update" banner. (The doc already tolerates *older*
  snapshots via `#[serde(default)]` (`document.rs:18-30`), but an old client applying ops it doesn't
  understand — or serializing a snapshot that *drops* new fields on compaction — would corrupt the
  room; hard-gating is the only safe rule.)
- **`generate()`'s multi-second story**: the expensive part is the client-side 18-seed search
  (`App.tsx:892`), not the op. Rule: **search on a scratch clone, dispatch one op**. The applied
  `generate` op itself is a single synchronous wasm call (fast); no lock is needed for correctness —
  sequencing already serializes it. UX guard: dispatch a presence `tool:'generating'` so others see
  a spinner-badge, and let last-writer-wins apply (identical to two users clicking Generate today).
  Optional politeness: relay-granted soft lock (`{t:'lock', scope:'generate'}`) with a 15 s TTL.
- **Op application error on a replica** (zone op `Err`): deterministic ⇒ every replica errs
  identically; log + no-op. If a replica ever *diverges* (bug), a snapshot-hash field piggybacked on
  compaction detects it → forced resync.

## 6. Milestones (each independently shippable)

| # | Deliverable | Contents | Effort |
|---|---|---|---|
| 1 | **Presence** | Relay (rooms + presence only) on VPS; `hello/cur/sel/cam` messages; remote cursors in 2D, frustums in 3D | 2–4 days |
| 2 | **Edit lease + followers** | `Op` type + `dispatch()` seam refactor (no behavior change solo); relay sequences ops; one lease holder edits, followers apply ops live; join-snapshot + resync; schema gate | ~1 week |
| 3 | **Full co-editing** | Drop the lease: optimistic echo + rollback-replay; per-user inverse-op undo (replaces `useAgent` snapshot stack); scratch-clone `autoGenerate`; CAD blob debounce; AI approve → ops | 2–3 weeks |
| 4 | *(later, as needed)* | Granular CAD ops; client-partitioned ids; snapshot persistence/history on server; CRDT revisit only if offline becomes a requirement | — |

The seam refactor in milestone 2 is the real investment; everything after it is policy. Nothing in
milestones 1–3 touches `crates/ds-core` except adding `SCHEMA_VERSION` — the core's determinism and
snapshot machinery are already multiplayer-shaped.
