// Minimal STORE-mode (no compression) ZIP writer.
//
// The repo hand-writes every exporter's byte stream rather than pulling a
// heavy dependency (see dxf.ts / ifc.ts / obj.ts). An .xlsx is just a ZIP of
// OOXML parts, so `takeoff.ts` needs a ZIP container — this is the smallest
// one that real readers (Excel, LibreOffice, Numbers, python `zipfile`) accept:
// a local file header + raw data + CRC32 per entry, then a central directory,
// then an end-of-central-directory (EOCD) record. STORE mode (method 0) means
// we skip DEFLATE entirely; XLSX parts are tiny text, so the size cost is
// irrelevant and we avoid shipping a compressor.

/** CRC-32 (IEEE 802.3, the polynomial ZIP uses), computed via a lazy table. */
let CRC_TABLE: Uint32Array | null = null
function crcTable(): Uint32Array {
  if (CRC_TABLE) return CRC_TABLE
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  CRC_TABLE = t
  return t
}

function crc32(bytes: Uint8Array): number {
  const t = crcTable()
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) c = t[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

interface ZipFile {
  name: string
  data: Uint8Array
}

/**
 * Pack files into a single STORE-mode ZIP byte stream. Entry order is
 * preserved (OOXML wants `[Content_Types].xml` readable, order otherwise
 * doesn't matter). Names use forward slashes and ASCII only (all our part
 * names are literal), so UTF-8 vs. code-page flags are moot.
 */
export function zipStore(files: ZipFile[]): Uint8Array {
  const enc = new TextEncoder()
  const locals: Uint8Array[] = []
  const centrals: Uint8Array[] = []
  let offset = 0

  for (const f of files) {
    const nameBytes = enc.encode(f.name)
    const crc = crc32(f.data)
    const size = f.data.length

    // Local file header (30 bytes + name), then the stored data.
    const local = new Uint8Array(30 + nameBytes.length)
    const lv = new DataView(local.buffer)
    lv.setUint32(0, 0x04034b50, true) // local file header signature "PK\x03\x04"
    lv.setUint16(4, 20, true) // version needed to extract (2.0)
    lv.setUint16(6, 0, true) // general purpose bit flag
    lv.setUint16(8, 0, true) // compression method 0 = store
    lv.setUint16(10, 0, true) // mod time
    lv.setUint16(12, 0, true) // mod date
    lv.setUint32(14, crc, true) // crc-32
    lv.setUint32(18, size, true) // compressed size
    lv.setUint32(22, size, true) // uncompressed size
    lv.setUint16(26, nameBytes.length, true) // file name length
    lv.setUint16(28, 0, true) // extra field length
    local.set(nameBytes, 30)

    locals.push(local, f.data)

    // Central directory header (46 bytes + name).
    const central = new Uint8Array(46 + nameBytes.length)
    const cv = new DataView(central.buffer)
    cv.setUint32(0, 0x02014b50, true) // central dir header signature "PK\x01\x02"
    cv.setUint16(4, 20, true) // version made by
    cv.setUint16(6, 20, true) // version needed
    cv.setUint16(8, 0, true) // flags
    cv.setUint16(10, 0, true) // method
    cv.setUint16(12, 0, true) // mod time
    cv.setUint16(14, 0, true) // mod date
    cv.setUint32(16, crc, true) // crc-32
    cv.setUint32(20, size, true) // compressed size
    cv.setUint32(24, size, true) // uncompressed size
    cv.setUint16(28, nameBytes.length, true) // name length
    cv.setUint16(30, 0, true) // extra length
    cv.setUint16(32, 0, true) // comment length
    cv.setUint16(34, 0, true) // disk number start
    cv.setUint16(36, 0, true) // internal attributes
    cv.setUint32(38, 0, true) // external attributes
    cv.setUint32(42, offset, true) // relative offset of local header
    central.set(nameBytes, 46)
    centrals.push(central)

    offset += local.length + size
  }

  const centralSize = centrals.reduce((n, c) => n + c.length, 0)
  const centralOffset = offset

  // End of central directory record (22 bytes, no comment).
  const eocd = new Uint8Array(22)
  const ev = new DataView(eocd.buffer)
  ev.setUint32(0, 0x06054b50, true) // EOCD signature "PK\x05\x06"
  ev.setUint16(4, 0, true) // disk number
  ev.setUint16(6, 0, true) // disk with central dir
  ev.setUint16(8, files.length, true) // entries on this disk
  ev.setUint16(10, files.length, true) // total entries
  ev.setUint32(12, centralSize, true) // central dir size
  ev.setUint32(16, centralOffset, true) // central dir offset
  ev.setUint16(20, 0, true) // comment length

  const total =
    locals.reduce((n, b) => n + b.length, 0) + centralSize + eocd.length
  const out = new Uint8Array(total)
  let p = 0
  for (const b of locals) {
    out.set(b, p)
    p += b.length
  }
  for (const c of centrals) {
    out.set(c, p)
    p += c.length
  }
  out.set(eocd, p)
  return out
}
