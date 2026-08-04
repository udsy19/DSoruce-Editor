// H.264/MP4 encoder for canvas frames — the browser half of the walkthrough.
//
// `export/walkthrough.ts` hands out one composited canvas per frame and is
// deliberately medium-agnostic; the headless driver pipes those frames into
// ffmpeg. A browser has no ffmpeg, so the one-action deliverable pack encodes
// them here instead: Chromium's WebCodecs `VideoEncoder` produces real H.264
// (VideoToolbox / OpenH264 under the hood) and this file wraps the resulting
// access units in the smallest MP4 a player will accept.
//
// Why hand-written, like every other exporter in this repo (zip.ts / dxf.ts /
// ifc.ts / obj.ts / workbook.ts): an MP4 with ONE video track, one chunk and a
// constant frame duration is a fixed set of boxes — ~200 lines against a ~1 MB
// dependency in a bundle the editor already strains.
//
//   ftyp                       brands
//   mdat                       the AVCC access units, back to back
//   moov                       mvhd · trak(tkhd · mdia(mdhd · hdlr · minf(
//                                vmhd · dinf · stbl(stsd/avc1 · stts · stss ·
//                                stsc · stsz · stco))))
//
// Samples are length-prefixed (`avc: { format: 'avc' }`), NOT Annex-B, which is
// what an `avc1` sample entry requires; the SPS/PPS live in the `avcC` the
// encoder hands back with its first chunk.

/** One encoded frame, in decode order. */
export interface Mp4Sample {
  data: Uint8Array
  /** `true` for an IDR — goes in the sync-sample table. */
  key: boolean
}

export interface Mp4MuxOpts {
  width: number
  height: number
  fps: number
  /** `AVCDecoderConfigurationRecord` from the encoder's first chunk metadata. */
  avcC: Uint8Array
}

// ── box writing ──────────────────────────────────────────────────────────────

class Bytes {
  private buf = new Uint8Array(1024)
  private len = 0

  private fit(n: number): void {
    if (this.len + n <= this.buf.length) return
    let cap = this.buf.length * 2
    while (cap < this.len + n) cap *= 2
    const next = new Uint8Array(cap)
    next.set(this.buf.subarray(0, this.len))
    this.buf = next
  }

  u8(v: number): this {
    this.fit(1)
    this.buf[this.len++] = v & 0xff
    return this
  }

  u16(v: number): this {
    return this.u8(v >> 8).u8(v)
  }

  u32(v: number): this {
    return this.u16(v >>> 16).u16(v & 0xffff)
  }

  i16(v: number): this {
    return this.u16(v < 0 ? v + 0x10000 : v)
  }

  ascii(s: string): this {
    for (let i = 0; i < s.length; i++) this.u8(s.charCodeAt(i))
    return this
  }

  raw(b: Uint8Array): this {
    this.fit(b.length)
    this.buf.set(b, this.len)
    this.len += b.length
    return this
  }

  zeros(n: number): this {
    this.fit(n)
    this.len += n
    return this
  }

  get bytes(): Uint8Array {
    return this.buf.subarray(0, this.len)
  }
}

/** `[size][type][payload]` — the only container shape MP4 has. */
function box(type: string, ...parts: Uint8Array[]): Uint8Array {
  let payload = 0
  for (const p of parts) payload += p.length
  const b = new Bytes()
  b.u32(8 + payload).ascii(type)
  for (const p of parts) b.raw(p)
  return b.bytes
}

/** A box whose payload starts with `version` + 24-bit `flags`. */
function fullBox(type: string, version: number, flags: number, ...parts: Uint8Array[]): Uint8Array {
  const head = new Bytes().u8(version).u8(flags >> 16).u8(flags >> 8).u8(flags).bytes
  return box(type, head, ...parts)
}

/** The 3×3 unity display matrix every writer emits. */
const UNITY_MATRIX = new Bytes()
  .u32(0x00010000).u32(0).u32(0)
  .u32(0).u32(0x00010000).u32(0)
  .u32(0).u32(0).u32(0x40000000).bytes

/**
 * Wrap encoded samples in an MP4. Everything lands in ONE chunk, so the sample
 * table is a constant-duration `stts`, a flat `stsz`, and a single-entry
 * `stsc`/`stco` — an offline take has no reason to be fragmented.
 */
export function muxMp4(samples: Mp4Sample[], opts: Mp4MuxOpts): Uint8Array {
  if (!samples.length) throw new Error('mp4: no samples to mux')
  const { width, height, fps, avcC } = opts
  // Media timescale of fps×1000 keeps the per-sample delta an exact integer
  // (1000) at any frame rate the walkthrough can be asked for.
  const timescale = Math.round(fps * 1000)
  const delta = 1000
  const n = samples.length
  const mediaDuration = n * delta
  const movieTimescale = 1000
  const movieDuration = Math.round((n / fps) * movieTimescale)

  const ftyp = box('ftyp', new Bytes()
    .ascii('isom').u32(0x200)
    .ascii('isom').ascii('iso2').ascii('avc1').ascii('mp41').bytes)

  let dataSize = 0
  for (const s of samples) dataSize += s.data.length
  const mdatHeader = new Bytes().u32(8 + dataSize).ascii('mdat').bytes
  // ftyp · mdat header · samples · moov  → the first sample's file offset.
  const chunkOffset = ftyp.length + mdatHeader.length

  // ---- sample tables ------------------------------------------------------
  const stts = fullBox('stts', 0, 0, new Bytes().u32(1).u32(n).u32(delta).bytes)

  const syncs: number[] = []
  for (let i = 0; i < n; i++) if (samples[i].key) syncs.push(i + 1)
  const stss = fullBox('stss', 0, 0, (() => {
    const b = new Bytes().u32(syncs.length)
    for (const s of syncs) b.u32(s)
    return b.bytes
  })())

  const stsc = fullBox('stsc', 0, 0, new Bytes().u32(1).u32(1).u32(n).u32(1).bytes)

  const stsz = fullBox('stsz', 0, 0, (() => {
    const b = new Bytes().u32(0).u32(n)
    for (const s of samples) b.u32(s.data.length)
    return b.bytes
  })())

  const stco = fullBox('stco', 0, 0, new Bytes().u32(1).u32(chunkOffset).bytes)

  const avc1 = box('avc1', new Bytes()
    .zeros(6).u16(1) //                       reserved + data_reference_index
    .u16(0).u16(0).zeros(12) //               pre_defined / reserved
    .u16(width).u16(height)
    .u32(0x00480000).u32(0x00480000) //       72 dpi
    .u32(0).u16(1) //                         reserved + frame_count
    .u8(12).ascii('DSource H264').zeros(32 - 1 - 12) // compressorname (padded)
    .u16(0x0018) //                           depth
    .i16(-1).bytes, //                        pre_defined
    box('avcC', avcC))

  const stsd = fullBox('stsd', 0, 0, new Bytes().u32(1).bytes, avc1)
  const stbl = box('stbl', stsd, stts, stss, stsc, stsz, stco)

  const vmhd = fullBox('vmhd', 0, 1, new Bytes().u16(0).u16(0).u16(0).u16(0).bytes)
  const dref = fullBox('dref', 0, 0, new Bytes().u32(1).bytes, fullBox('url ', 0, 1))
  const dinf = box('dinf', dref)
  const minf = box('minf', vmhd, dinf, stbl)

  const mdhd = fullBox('mdhd', 0, 0, new Bytes()
    .u32(0).u32(0) //                         creation / modification time
    .u32(timescale).u32(mediaDuration)
    .u16(0x55c4).u16(0).bytes) //             'und' language, pre_defined

  const hdlr = fullBox('hdlr', 0, 0, new Bytes()
    .u32(0).ascii('vide').u32(0).u32(0).u32(0)
    .ascii('VideoHandler').u8(0).bytes)

  const mdia = box('mdia', mdhd, hdlr, minf)

  // flags 0x7 = enabled | in movie | in preview
  const tkhd = fullBox('tkhd', 0, 0x7, new Bytes()
    .u32(0).u32(0).u32(1).u32(0).u32(movieDuration)
    .u32(0).u32(0) //                         reserved
    .u16(0).u16(0).u16(0).u16(0) //           layer, alt group, volume, reserved
    .raw(UNITY_MATRIX)
    .u32(width * 0x10000).u32(height * 0x10000).bytes) // 16.16 display size

  const trak = box('trak', tkhd, mdia)

  const mvhd = fullBox('mvhd', 0, 0, new Bytes()
    .u32(0).u32(0).u32(movieTimescale).u32(movieDuration)
    .u32(0x00010000).u16(0x0100).u16(0).u32(0).u32(0) // rate, volume, reserved
    .raw(UNITY_MATRIX)
    .zeros(24) //                             pre_defined
    .u32(2).bytes) //                         next_track_ID

  const moov = box('moov', mvhd, trak)

  const out = new Uint8Array(ftyp.length + mdatHeader.length + dataSize + moov.length)
  let at = 0
  out.set(ftyp, at); at += ftyp.length
  out.set(mdatHeader, at); at += mdatHeader.length
  for (const s of samples) { out.set(s.data, at); at += s.data.length }
  out.set(moov, at)
  return out
}

// ── encoding ─────────────────────────────────────────────────────────────────

export interface Mp4EncodeOpts {
  width: number
  height: number
  fps: number
  /** Target bitrate. 6 Mbps at 1080p ≈ the reference take's own 4.3 Mbps CRF-18
   *  encode with headroom for a hardware encoder's looser rate control. */
  bitrate?: number
  /** Seconds between IDR frames — 2 s is the streaming convention and keeps a
   *  43 s take seekable without spending much on key frames. */
  keyFrameIntervalS?: number
  /** High\@4.0. Overridable so a caller can drop to Main for an old decoder. */
  codec?: string
}

function h264Config(o: Mp4EncodeOpts): VideoEncoderConfig {
  return {
    codec: o.codec ?? 'avc1.640028',
    width: o.width,
    height: o.height,
    bitrate: o.bitrate ?? 6_000_000,
    framerate: o.fps,
    // 'avc' (length-prefixed) rather than 'annexb': an `avc1` sample entry
    // carries its SPS/PPS in avcC, and the samples must not repeat them.
    avc: { format: 'avc' },
  }
}

/**
 * Whether this browser can encode H.264 at this size. WebCodecs needs a SECURE
 * CONTEXT — on plain http (other than localhost) `VideoEncoder` is undefined,
 * and the caller must fall back rather than throw.
 */
export async function mp4EncodeSupported(o: Mp4EncodeOpts): Promise<boolean> {
  if (typeof VideoEncoder === 'undefined') return false
  try {
    return !!(await VideoEncoder.isConfigSupported(h264Config(o))).supported
  } catch {
    return false
  }
}

/**
 * Streaming canvas → MP4 encoder. Frames go in one at a time (the walkthrough
 * never holds more than one), encoded chunks accumulate, and {@link finish}
 * muxes them.
 */
export class Mp4Encoder {
  private samples: Mp4Sample[] = []
  private avcC: Uint8Array | null = null
  private enc: VideoEncoder
  private failure: Error | null = null
  private index = 0
  private readonly keyEvery: number

  constructor(private opts: Mp4EncodeOpts) {
    if (typeof VideoEncoder === 'undefined') {
      throw new Error(
        'This browser cannot encode video (WebCodecs VideoEncoder is unavailable — ' +
          'it needs a secure context: https, or localhost).',
      )
    }
    this.keyEvery = Math.max(1, Math.round((opts.keyFrameIntervalS ?? 2) * opts.fps))
    this.enc = new VideoEncoder({
      output: (chunk, meta) => {
        const desc = meta?.decoderConfig?.description
        if (desc && !this.avcC) {
          // `description` is an AllowSharedBufferSource — a view or a buffer.
          this.avcC = ArrayBuffer.isView(desc)
            ? new Uint8Array(desc.buffer, desc.byteOffset, desc.byteLength).slice()
            : new Uint8Array(desc).slice()
        }
        const data = new Uint8Array(chunk.byteLength)
        chunk.copyTo(data)
        this.samples.push({ data, key: chunk.type === 'key' })
      },
      error: (e) => {
        this.failure = e instanceof Error ? e : new Error(String(e))
      },
    })
    this.enc.configure(h264Config(opts))
  }

  /** Encode one frame. Awaits the encoder's queue so a fast renderer cannot
   *  outrun it and blow memory (the frames are 1920×1080 RGBA). */
  async addFrame(source: CanvasImageSource): Promise<void> {
    if (this.failure) throw this.failure
    const i = this.index++
    const frame = new VideoFrame(source, {
      timestamp: Math.round((i * 1e6) / this.opts.fps),
      duration: Math.round(1e6 / this.opts.fps),
    })
    try {
      this.enc.encode(frame, { keyFrame: i % this.keyEvery === 0 })
    } finally {
      frame.close()
    }
    while (this.enc.encodeQueueSize > 4 && !this.failure) {
      await new Promise((r) => setTimeout(r, 1))
    }
    if (this.failure) throw this.failure
  }

  /** Flush the encoder and return the finished MP4. */
  async finish(): Promise<Uint8Array> {
    await this.enc.flush()
    this.enc.close()
    if (this.failure) throw this.failure
    if (!this.avcC) throw new Error('mp4: encoder produced no avcC configuration record')
    return muxMp4(this.samples, {
      width: this.opts.width,
      height: this.opts.height,
      fps: this.opts.fps,
      avcC: this.avcC,
    })
  }

  /** Frames accepted so far (progress + the report's frame count). */
  get frames(): number {
    return this.index
  }
}
