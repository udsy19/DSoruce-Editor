// The one-action deliverable pack — every qbiq-parity artifact from one click.
//
// ONE pack builder, TWO sinks. `buildDeliverablePack` always runs the same
// stages against the same exporters (`qtoWorkbook.buildQtoPack`,
// `roomRenders.renderRoomPack`, `walkthrough.renderWalkthrough`,
// `share.publishShareLink`); only where the bytes LAND differs, because a
// browser cannot write to a directory:
//
//   serverPackSink   POSTs each artifact to /api/pack (dev + the VPS service),
//                    which writes it into `out/` — this is what gate G10 polls.
//   zipPackSink      packs the identical byte streams into one .zip download —
//                    what a designer on any deployment gets, Vercel included.
//
// The video is the only stage that cannot always run here. Rendering 1290
// frames of a 1080p interior needs a real GPU: measured at ~90 s on hardware GL
// and ~36 min on a software rasterizer (a headless CI browser). So the sink
// ADVERTISES whether it can render the take on a GPU host with ffmpeg
// (`video: 'server'` — the dev server drives `scripts/render-walkthrough.mjs`,
// which bundles this very module); when it cannot, the browser renders and
// encodes it itself through WebCodecs (`export/mp4.ts`). Same frames, same
// camera, same scene — only the encoder differs.

import type { DocState } from '../types/doc'
import { buildQtoPack, type QtoRenderOptions, type Quantities } from './qtoWorkbook'
import { renderRoomPack, roomRenderGroundTruth, type RoomRender } from './roomRenders'
import { renderWalkthrough } from './walkthrough'
import { buildPlanGlb, publishShareLink } from './share'
import { Mp4Encoder, mp4EncodeSupported, type Mp4EncodeOpts } from './mp4'
import { triggerDownload } from './png'
import { zipStore } from './zip'

// ── progress ─────────────────────────────────────────────────────────────────

export type PackStageId = 'workbook' | 'renders' | 'walkthrough' | 'share' | 'deliver'

export interface PackProgress {
  stage: PackStageId
  /** Human-readable, e.g. "Rendering Conference room". */
  label: string
  /** Fraction of THIS stage, 0–1. */
  fraction: number
  /** Extra detail for the UI (frame counts, sizes). */
  note?: string
}

export type PackProgressFn = (p: PackProgress) => void

/** Ordered for the UI; the weights are measured wall-clock shares on hardware GL. */
export const PACK_STAGES: Array<{ id: PackStageId; label: string; weight: number }> = [
  { id: 'workbook', label: 'Quantity takeoff', weight: 1 },
  { id: 'renders', label: 'Room renders', weight: 2 },
  { id: 'walkthrough', label: 'Walkthrough video', weight: 8 },
  { id: 'share', label: 'Share link', weight: 1 },
  { id: 'deliver', label: 'Delivery', weight: 0.5 },
]

/**
 * Weighted 0–1 completion across every stage. Stages run CONCURRENTLY (the
 * server-rendered video overlaps the client-side work), so overall progress is
 * a sum of per-stage fractions, not a cursor walking a list.
 */
export function packOverall(stages: Map<PackStageId, PackProgress>): number {
  let total = 0
  let got = 0
  for (const s of PACK_STAGES) {
    total += s.weight
    got += s.weight * Math.min(1, Math.max(0, stages.get(s.id)?.fraction ?? 0))
  }
  return total ? got / total : 0
}

// ── the sink ─────────────────────────────────────────────────────────────────

/** Everything a GPU host needs to shoot the take — the same four inputs
 *  `scripts/render-walkthrough.mjs` reads for the headless artifact. */
export interface WalkthroughJob {
  state: DocState
  /** `Editor.wall_types()`, raw: the host classifies with the app's own
   *  `classifyWalls`, so a server-rendered take and a browser-rendered one
   *  cannot disagree about a wall. */
  wallTypes: unknown
  plate: [number, number][] | null
  circulation: unknown
  title: string
  subtitle: string
}

export interface PackDelivery {
  kind: 'server' | 'download'
  /** Artifact names, in the order they were produced. */
  files: string[]
  bytes: number
  /** Where the artifacts landed ("out/" or the downloaded filename). */
  where: string
}

export interface PackSink {
  readonly kind: 'server' | 'download'
  /** 'server' when the sink can render the walkthrough on a GPU host with
   *  ffmpeg; 'client' when this browser must render and encode it. */
  readonly video: 'server' | 'client'
  put(name: string, data: Uint8Array): Promise<void>
  /** Only present when {@link video} is 'server'. */
  renderWalkthrough?(job: WalkthroughJob, onProgress: PackProgressFn): Promise<number>
  finish(): Promise<PackDelivery>
}

interface PackCaps {
  writes?: boolean
  video?: 'server' | null
  out?: string
}

/**
 * Ask the deployment what it can do, and pick the sink. A 404/501/offline
 * answer is the NORMAL case on a static host — it means "download the zip",
 * not an error.
 */
export async function detectPackSink(origin = location.origin): Promise<PackSink> {
  let caps: PackCaps | null = null
  try {
    const res = await fetch(`${origin.replace(/\/$/, '')}/api/pack`, { method: 'GET' })
    if (res.ok) caps = (await res.json()) as PackCaps
  } catch {
    // No pack endpoint (static host, or offline) — the zip is the answer.
  }
  return caps?.writes ? serverPackSink(origin, caps) : zipPackSink()
}

/** Writes each artifact into the server's `out/` directory. */
export function serverPackSink(origin: string, caps: PackCaps): PackSink {
  const base = `${origin.replace(/\/$/, '')}/api/pack`
  const files: string[] = []
  let bytes = 0
  return {
    kind: 'server',
    video: caps.video === 'server' ? 'server' : 'client',
    async put(name, data) {
      const res = await fetch(`${base}/file/${name}`, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: new Blob([data as unknown as BlobPart]),
      })
      if (!res.ok) {
        const detail = await res.text().catch(() => '')
        throw new Error(`Could not write ${name} (${res.status}) ${detail.slice(0, 200)}`)
      }
      files.push(name)
      bytes += data.byteLength
    },
    async renderWalkthrough(job, onProgress) {
      const res = await fetch(`${base}/walkthrough`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(job),
      })
      if (!res.ok || !res.body) {
        const detail = await res.text().catch(() => '')
        throw new Error(`Walkthrough render failed (${res.status}) ${detail.slice(0, 200)}`)
      }
      // NDJSON progress, one line per update, terminated by an {ok} record.
      const reader = res.body.getReader()
      const dec = new TextDecoder()
      let buf = ''
      let done: { ok: boolean; bytes?: number; error?: string } | null = null
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        buf += dec.decode(chunk.value, { stream: true })
        const lines = buf.split('\n')
        buf = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.trim()) continue
          let msg: Record<string, unknown>
          try {
            msg = JSON.parse(line)
          } catch {
            continue
          }
          if (msg.ok !== undefined || msg.error) {
            done = msg as { ok: boolean; bytes?: number; error?: string }
          } else {
            const d = Number(msg.done ?? 0)
            const t = Number(msg.total ?? 0)
            onProgress({
              stage: 'walkthrough',
              label: `Rendering walkthrough on the server (${String(msg.phase ?? 'render')})`,
              fraction: t > 0 ? d / t : 0,
              note: t > 0 ? `frame ${d} / ${t}` : undefined,
            })
          }
        }
      }
      if (!done?.ok) throw new Error(done?.error ?? 'Walkthrough render produced no video')
      files.push('walkthrough.mp4')
      bytes += done.bytes ?? 0
      return done.bytes ?? 0
    },
    async finish() {
      return { kind: 'server', files, bytes, where: caps.out ?? 'out/' }
    },
  }
}

/** Collects every artifact into one .zip and downloads it. */
export function zipPackSink(filename = 'dsource-deliverable-pack.zip'): PackSink {
  const files: { name: string; data: Uint8Array }[] = []
  return {
    kind: 'download',
    video: 'client',
    async put(name, data) {
      files.push({ name, data })
    },
    async finish() {
      const zip = zipStore(files)
      triggerDownload(new Blob([zip as unknown as BlobPart], { type: 'application/zip' }), filename)
      return {
        kind: 'download',
        files: files.map((f) => f.name),
        bytes: zip.byteLength,
        where: filename,
      }
    },
  }
}

// ── the pack ─────────────────────────────────────────────────────────────────

export interface DeliverablePackInput {
  state: DocState
  quantities: Quantities
  /** `Editor.wall_types()`, raw (see {@link WalkthroughJob.wallTypes}). */
  wallTypes: unknown
  /** Everything the workbook + plan graphic need — `circulation`, `plate`,
   *  `wallSpans`, `roomRefs`, `bindings`, `project`, `floor`. */
  qto: QtoRenderOptions
  /** Plan name: the share link's title and the video's subtitle. */
  name: string
  /** Override the walkthrough's format. Only reaches the IN-BROWSER encoder —
   *  a server render is the deliverable and always shoots 1920×1080 @ 30 fps.
   *  Used to keep a test's take small enough to finish on a software GL. */
  video?: Mp4EncodeOpts
}

export interface DeliverablePackResult extends PackDelivery {
  rooms: number
  renders: RoomRender[]
  shareUrl: string | null
  videoBytes: number
  videoBy: 'server' | 'browser' | 'none'
}

const VIDEO: Mp4EncodeOpts = { width: 1920, height: 1080, fps: 30 }

/**
 * Build and deliver the whole pack, reporting progress the whole way; every
 * await yields to the event loop, so the tab stays responsive (a single 4K
 * still and a single walkthrough frame each block for one frame's worth of GPU
 * work, no more).
 *
 * When the sink renders the video for us, that request is fired FIRST and
 * awaited LAST: it runs on another machine's GPU for a couple of minutes while
 * this tab builds the workbook, the stills and the share link, which is most of
 * the pack's wall clock back. The stages therefore report progress
 * concurrently — the UI keeps one row per stage rather than a single cursor.
 */
export async function buildDeliverablePack(
  input: DeliverablePackInput,
  sink: PackSink,
  onProgress: PackProgressFn = () => {},
): Promise<DeliverablePackResult> {
  const { state, quantities, qto, name } = input
  const enc = new TextEncoder()

  // ---- 0. hand the walkthrough to the GPU host, if there is one ------------
  const job: WalkthroughJob = {
    state,
    wallTypes: input.wallTypes,
    plate: qto.plate ?? null,
    circulation: qto.circulation ?? null,
    title: 'DSource Test-Fit Walkthrough',
    subtitle: name,
  }
  // Settled, not raw: this promise is created before several awaits, and an
  // early rejection would otherwise surface as an unhandled rejection before
  // step 4 gets to it.
  const serverVideo =
    state.walls.length > 0 && sink.video === 'server' && sink.renderWalkthrough
      ? sink.renderWalkthrough(job, onProgress).then(
          (bytes) => ({ bytes }),
          (error: unknown) => ({ error }),
        )
      : null

  // ---- 1. workbook · plan · thumbnails · ground truth ----------------------
  onProgress({ stage: 'workbook', label: 'Building the quantity takeoff', fraction: 0 })
  const pack = await buildQtoPack(state, quantities, qto)
  await sink.put('quantity-takeoff.xlsx', pack.xlsx)
  await sink.put('plan.png', pack.planPng)
  await sink.put('plan.repeat.png', pack.planRepeatPng)
  for (const t of pack.thumbs) await sink.put(`thumbs/${t.id}.png`, t.png)
  onProgress({
    stage: 'workbook',
    label: 'Quantity takeoff',
    fraction: 1,
    note: `${pack.model.rooms.length} rooms · ${Math.round(pack.xlsx.byteLength / 1024)} KB`,
  })

  // ---- 2. the four hero stills --------------------------------------------
  onProgress({ stage: 'renders', label: 'Rendering rooms', fraction: 0 })
  const renders = await renderRoomPack(state, {
    wallSpans: qto.wallSpans as never,
    plate: qto.plate ?? null,
    onProgress: (key, i, total) =>
      onProgress({
        stage: 'renders',
        label: `Rendering ${key.replace(/_/g, ' ')}`,
        fraction: (i + 1) / total,
      }),
  })
  for (const r of renders) await sink.put(`renders/${r.key}.png`, r.png)
  await sink.put(
    'renders/manifest.json',
    enc.encode(JSON.stringify({ stills: renders.map(({ png, ...rest }) => rest) }, null, 2)),
  )
  // Ground truth carries BOTH blocks (rooms/walls/doors from the workbook,
  // `renders` from the stills) and is written once, after both exist — the
  // browser equivalent of the headless drivers' merge.
  await sink.put(
    'ground-truth.json',
    enc.encode(JSON.stringify({ ...pack.groundTruth, renders: roomRenderGroundTruth(renders) }, null, 2)),
  )
  onProgress({ stage: 'renders', label: 'Room renders', fraction: 1, note: `${renders.length} stills` })

  // ---- 3. the share link ---------------------------------------------------
  onProgress({ stage: 'share', label: 'Publishing the 3D model', fraction: 0 })
  let shareUrl: string | null = null
  try {
    const link = await publishShareLink(state, { name })
    shareUrl = link.url
    await sink.put(
      'share.json',
      enc.encode(JSON.stringify({ ...link, name, createdAt: new Date().toISOString() }, null, 2)),
    )
  } catch (e) {
    // No share store (Vercel answers 501 — deploy/VERCEL.md). The client still
    // gets a portable, viewer-ready model rather than nothing.
    const glb = await buildPlanGlb(state)
    await sink.put('plan.glb', new Uint8Array(glb))
    onProgress({
      stage: 'share',
      label: 'No share store — model saved to the pack',
      fraction: 1,
      note: e instanceof Error ? e.message : String(e),
    })
  }
  onProgress({ stage: 'share', label: 'Share link', fraction: 1, note: shareUrl ?? 'plan.glb' })

  // ---- 4. the walkthrough --------------------------------------------------
  // Either collect the server render started at step 0, or — no GPU host —
  // render and encode it right here, which is the long pole on this path.
  let videoBytes = 0
  let videoBy: DeliverablePackResult['videoBy'] = 'none'
  if (serverVideo) {
    const got = await serverVideo
    if ('error' in got) throw got.error
    videoBytes = got.bytes
    videoBy = 'server'
  } else if (state.walls.length === 0) {
    // `renderWalkthrough` needs walls to build a clearance field at all.
    onProgress({ stage: 'walkthrough', label: 'Walkthrough skipped (no walls)', fraction: 1 })
  } else {
    const mp4 = await encodeWalkthroughMp4(job, qto, onProgress, input.video ?? VIDEO)
    await sink.put('walkthrough.mp4', mp4)
    videoBytes = mp4.byteLength
    videoBy = 'browser'
  }
  onProgress({
    stage: 'walkthrough',
    label: 'Walkthrough video',
    fraction: 1,
    note: videoBytes ? `${(videoBytes / 1024 / 1024).toFixed(1)} MB` : 'skipped',
  })

  // ---- 5. deliver ----------------------------------------------------------
  onProgress({ stage: 'deliver', label: 'Finishing', fraction: 0 })
  const delivery = await sink.finish()
  onProgress({ stage: 'deliver', label: 'Done', fraction: 1, note: delivery.where })
  return {
    ...delivery,
    rooms: pack.model.rooms.length,
    renders,
    shareUrl,
    videoBytes,
    videoBy,
  }
}

/**
 * Render + encode the walkthrough in THIS browser. Frames stream one at a time
 * out of `renderWalkthrough` straight into the WebCodecs encoder, so a 1290
 * frame take never sits in memory as bitmaps.
 */
export async function encodeWalkthroughMp4(
  job: WalkthroughJob,
  qto: QtoRenderOptions,
  onProgress: PackProgressFn = () => {},
  video = VIDEO,
): Promise<Uint8Array> {
  if (!(await mp4EncodeSupported(video))) {
    throw new Error(
      'This browser cannot encode H.264 video. Open DSource over https (or localhost), ' +
        'or run the DSource server, which renders the walkthrough for you.',
    )
  }
  const encoder = new Mp4Encoder(video)
  await renderWalkthrough(job.state, {
    ...video,
    wallSpans: qto.wallSpans as never,
    plate: job.plate,
    circulation: job.circulation as never,
    title: job.title,
    subtitle: job.subtitle,
    onProgress: (_done, _total, phase) => {
      if (phase !== 'render') {
        onProgress({ stage: 'walkthrough', label: `Walkthrough — ${phase}`, fraction: 0 })
      }
    },
    onFrame: async (f) => {
      await encoder.addFrame(f.canvas)
      if (f.index % 5 === 0 || f.index === f.total - 1) {
        onProgress({
          stage: 'walkthrough',
          label: 'Rendering the walkthrough',
          fraction: (f.index + 1) / f.total,
          note: `frame ${f.index + 1} / ${f.total}`,
        })
      }
    },
  })
  return encoder.finish()
}
