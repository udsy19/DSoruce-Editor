// Minimal ZIP reader — enough to pull a CAD file out of an archive.
//
// Three of the four archives in the validation corpus wrap exactly one `.dwg`,
// which is how CAD block libraries and drawing sets are distributed. The
// uploader accepted only `.dxf/.dwg/.png/.jpg`, so every one of them had to be
// extracted by hand before the app would look at it.
//
// No dependency: `DecompressionStream('deflate-raw')` has been in browsers
// since May 2023 and in Node since v18, and deflate is what every one of these
// archives uses. Adding a zip library to a 7-dependency runtime to read a
// 30-byte header and call a built-in would be the wrong trade.
//
// Deliberately partial. This reads the central directory (the only correct way
// to enumerate a zip — the local headers can lie about sizes when a data
// descriptor is used) and handles the two storage methods that exist in
// practice: stored (0) and deflate (8). Zip64, encryption, split archives and
// deflate64 are reported as unsupported rather than mis-read.

/** One file inside the archive, as listed by the central directory. */
export interface ZipEntry {
  name: string
  /** Compression method: 0 = stored, 8 = deflate. */
  method: number
  compressedSize: number
  uncompressedSize: number
  /** Offset of the local file header. */
  localHeaderOffset: number
  encrypted: boolean
}

export type ZipError =
  | 'not-a-zip'
  | 'zip64-unsupported'
  | 'encrypted'
  | 'unsupported-compression'
  | 'truncated'

const EOCD_SIG = 0x06054b50
const CEN_SIG = 0x02014b50
const LOC_SIG = 0x04034b50
/** Zip64 end-of-central-directory locator — presence means we must decline. */
const EOCD64_LOCATOR_SIG = 0x07064b50

/**
 * List the archive's entries, or an error naming why we cannot.
 *
 * Never guesses: an archive we cannot read correctly must say so, because the
 * alternative is handing the importer bytes that are not the file the user
 * thinks they uploaded.
 */
export function listZipEntries(buf: ArrayBuffer): { entries: ZipEntry[] } | { error: ZipError } {
  const view = new DataView(buf)
  const bytes = new Uint8Array(buf)
  if (bytes.length < 22) return { error: 'not-a-zip' }

  // The EOCD sits at the end, after a comment of up to 65 535 bytes. Scan back
  // for its signature rather than assuming a zero-length comment.
  const maxScan = Math.min(bytes.length, 22 + 0xffff)
  let eocd = -1
  for (let i = bytes.length - 22; i >= bytes.length - maxScan && i >= 0; i--) {
    if (view.getUint32(i, true) === EOCD_SIG) {
      eocd = i
      break
    }
  }
  if (eocd < 0) return { error: 'not-a-zip' }

  // Zip64 archives put the real counts elsewhere; the 32-bit EOCD then carries
  // 0xffffffff sentinels. Decline rather than read the sentinel as a offset.
  for (let i = Math.max(0, eocd - 20); i < eocd; i++) {
    if (view.getUint32(i, true) === EOCD64_LOCATOR_SIG) return { error: 'zip64-unsupported' }
  }

  const count = view.getUint16(eocd + 10, true)
  const cenOffset = view.getUint32(eocd + 16, true)
  if (cenOffset === 0xffffffff || count === 0xffff) return { error: 'zip64-unsupported' }
  if (cenOffset >= bytes.length) return { error: 'truncated' }

  const entries: ZipEntry[] = []
  let p = cenOffset
  for (let i = 0; i < count; i++) {
    if (p + 46 > bytes.length || view.getUint32(p, true) !== CEN_SIG) return { error: 'truncated' }
    const flags = view.getUint16(p + 8, true)
    const method = view.getUint16(p + 10, true)
    const compressedSize = view.getUint32(p + 20, true)
    const uncompressedSize = view.getUint32(p + 24, true)
    const nameLen = view.getUint16(p + 28, true)
    const extraLen = view.getUint16(p + 30, true)
    const commentLen = view.getUint16(p + 32, true)
    const localHeaderOffset = view.getUint32(p + 42, true)
    // Bit 11 = the name is UTF-8; otherwise it is CP437. Decoding as UTF-8
    // either way is fine for our purpose (we match on the extension), and the
    // corpus's `MOBILIARIO HOSPITAL.dwg` / `muebles varios.dwg` are ASCII.
    const name = new TextDecoder('utf-8').decode(bytes.subarray(p + 46, p + 46 + nameLen))
    entries.push({
      name,
      method,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
      encrypted: (flags & 0x1) !== 0,
    })
    p += 46 + nameLen + extraLen + commentLen
  }
  return { entries }
}

/** Extract one entry's bytes. */
export async function readZipEntry(
  buf: ArrayBuffer,
  entry: ZipEntry,
): Promise<{ bytes: Uint8Array } | { error: ZipError }> {
  if (entry.encrypted) return { error: 'encrypted' }
  if (entry.method !== 0 && entry.method !== 8) return { error: 'unsupported-compression' }

  const view = new DataView(buf)
  const all = new Uint8Array(buf)
  const off = entry.localHeaderOffset
  if (off + 30 > all.length || view.getUint32(off, true) !== LOC_SIG) return { error: 'truncated' }
  // The local header's own name/extra lengths, NOT the central directory's —
  // they legitimately differ (extra fields are often present in only one).
  const nameLen = view.getUint16(off + 26, true)
  const extraLen = view.getUint16(off + 28, true)
  const start = off + 30 + nameLen + extraLen
  const end = start + entry.compressedSize
  if (end > all.length) return { error: 'truncated' }

  const raw = all.subarray(start, end)
  if (entry.method === 0) return { bytes: raw }

  try {
    const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
    const out = new Uint8Array(await new Response(stream).arrayBuffer())
    return { bytes: out }
  } catch {
    return { error: 'unsupported-compression' }
  }
}

const CAD_RE = /\.(dwg|dxf)$/i
const RASTER_RE = /\.(png|jpe?g)$/i
/** Directory entries and macOS resource forks are not files the user meant. */
const isJunk = (name: string) =>
  name.endsWith('/') || name.startsWith('__MACOSX/') || name.split('/').pop()?.startsWith('.')

export interface ZipPick {
  /** CAD entries, the ones we can actually import. */
  cad: ZipEntry[]
  /** Images — importable via the raster path, but only after a scale is set. */
  raster: ZipEntry[]
  /** Everything else, for an accurate "what's in here" message. */
  other: ZipEntry[]
}

/** Sort an archive's entries into what the importer can do with them. */
export function classifyZip(entries: ZipEntry[]): ZipPick {
  const pick: ZipPick = { cad: [], raster: [], other: [] }
  for (const e of entries) {
    if (isJunk(e.name)) continue
    if (CAD_RE.test(e.name)) pick.cad.push(e)
    else if (RASTER_RE.test(e.name)) pick.raster.push(e)
    else pick.other.push(e)
  }
  return pick
}

export const ZIP_ERROR_MESSAGE: Record<ZipError, string> = {
  'not-a-zip': 'that file is not a readable ZIP archive',
  'zip64-unsupported': 'that ZIP uses the Zip64 format, which this importer cannot read',
  encrypted: 'that ZIP is password-protected',
  'unsupported-compression': 'that ZIP uses a compression method this importer cannot read',
  truncated: 'that ZIP appears to be incomplete',
}
