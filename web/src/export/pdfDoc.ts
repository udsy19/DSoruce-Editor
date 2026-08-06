// PDF container primitives — the byte-level writer and its text metrics.
//
// Deliberately DOM-FREE and PALETTE-FREE: it takes pre-encoded JPEG bytes plus a
// flat list of content ops, so it unit-tests in node where canvas APIs do not
// exist, and it carries no colour at all.
//
// Split out of pdf.ts under R1 (mode separation). One 1084-line module held
// three layers: these primitives, the palette-bearing print renderer, and the
// two document actions. The style-gate and bench/export-parity both anchor on
// "the file that owns the print palette" — while that file also held the byte
// writer, the guard covered code that can hold no colour. The layers form a
// strict DAG (pdfDoc <- printPlan <- pdf), so the split has no cycle.



export interface PdfMeta {
  title?: string
  project?: string
}

// ---------------------------------------------------------------------------
// PDF byte writer (DOM-free, node-testable)
// ---------------------------------------------------------------------------

/** A3 landscape in PostScript points (420 × 297 mm at 72 pt/in). */
export const PAGE_W = 1190.55
export const PAGE_H = 841.89

/** Raw JPEG bytes plus pixel dimensions (needed for /Width /Height). */
export interface PdfJpeg {
  bytes: Uint8Array
  width: number
  height: number
}

/**
 * Flat page-content operations, all in PDF user space (origin bottom-left,
 * units = points). `gray` is 0 (black) … 1 (white); default 0. `rgb` (each
 * channel 0…1) overrides `gray` when present, for the report's colored bars,
 * legend swatches, radar, and stacked bars.
 */
export type Rgb = [number, number, number]
export type ContentOp =
  | { op: 'text'; x: number; y: number; size: number; text: string; bold?: boolean; gray?: number; rgb?: Rgb }
  | { op: 'line'; x1: number; y1: number; x2: number; y2: number; width?: number; gray?: number; rgb?: Rgb }
  | { op: 'rect'; x: number; y: number; w: number; h: number; fill: boolean; gray?: number; width?: number; rgb?: Rgb }
  /** Draws an embedded JPEG scaled into the given rect. `img` selects which
   *  page image (/Im0, /Im1, …); defaults to 0 for the single-image sheets. */
  | { op: 'image'; x: number; y: number; w: number; h: number; img?: number }

/**
 * Make a string safe for a latin1-encoded PDF text literal with WinAnsi
 * Helvetica: ₹ (absent from WinAnsi) becomes "Rs.", common punctuation is
 * ASCII-folded, and anything else outside latin1 becomes '?'.
 * Note "m²" survives: ² is 0xB2 in WinAnsi.
 */
export function pdfSafeText(s: string): string {
  return s
    .replace(/₹\s?/g, 'Rs. ')
    .replace(/[–—]/g, '-')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/…/g, '...')
    .replace(/[^\x20-\x7e\xa0-\xff]/g, '?')
}

// Escape a (sanitized) string for a PDF ( ... ) literal.
function escLiteral(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')
}

// Compact number for the content stream (no float noise, no trailing zeros).
function num(n: number): string {
  return (Math.round(n * 100) / 100).toString()
}

/**
 * Approximate Helvetica advance width in points. A coarse per-character-class
 * table (digits are exactly 0.556 em in Helvetica; the rest is close enough
 * for right-aligning table columns — not for justified paragraphs).
 */
export function textWidth(s: string, size: number, bold = false): number {
  let em = 0
  for (const ch of s) {
    if ('iljI.,:;!|()[]\' '.includes(ch)) em += 0.3
    else if ('ft'.includes(ch)) em += 0.36
    else if ('mMW@'.includes(ch)) em += 0.92
    else if (ch >= 'A' && ch <= 'Z') em += 0.7
    else em += 0.56
  }
  return em * size * (bold ? 1.06 : 1)
}

// latin1-encode a string to bytes (1 char = 1 byte; input must be sanitized).
function enc(s: string): Uint8Array {
  const b = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff
  return b
}

// Set fill (stroke=false → rg/g) or stroke (stroke=true → RG/G) color: RGB when
// given, else grayscale.
function col(rgb: Rgb | undefined, gray: number | undefined, stroke: boolean): string {
  if (rgb) return `${num(rgb[0])} ${num(rgb[1])} ${num(rgb[2])} ${stroke ? 'RG' : 'rg'}`
  return `${num(gray ?? 0)} ${stroke ? 'G' : 'g'}`
}

function opToStream(o: ContentOp): string {
  switch (o.op) {
    case 'text':
      return (
        `BT /${o.bold ? 'F2' : 'F1'} ${num(o.size)} Tf ${col(o.rgb, o.gray, false)} ` +
        `${num(o.x)} ${num(o.y)} Td (${escLiteral(pdfSafeText(o.text))}) Tj ET`
      )
    case 'line':
      return (
        `${col(o.rgb, o.gray, true)} ${num(o.width ?? 1)} w ` +
        `${num(o.x1)} ${num(o.y1)} m ${num(o.x2)} ${num(o.y2)} l S`
      )
    case 'rect': {
      const r = `${num(o.x)} ${num(o.y)} ${num(o.w)} ${num(o.h)} re`
      return o.fill
        ? `${col(o.rgb, o.gray, false)} ${r} f`
        : `${col(o.rgb, o.gray, true)} ${num(o.width ?? 1)} w ${r} S`
    }
    case 'image':
      return `q ${num(o.w)} 0 0 ${num(o.h)} ${num(o.x)} ${num(o.y)} cm /Im${o.img ?? 0} Do Q`
  }
}

const FONT = (base: string) =>
  `<< /Type /Font /Subtype /Type1 /BaseFont /${base} /Encoding /WinAnsiEncoding >>`

/**
 * Serialize an ordered list of PDF objects (each a list of byte chunks so image
 * streams stay binary) into a complete PDF 1.4 file: header, the objects in
 * numeric order, then an xref table + trailer with byte-accurate offsets.
 * Objects must be pushed in ascending object-number order (obj 1 first); the
 * trailer's /Root is always object 1.
 */
function assemblePdf(objects: Uint8Array[][]): Uint8Array<ArrayBuffer> {
  const chunks: Uint8Array[] = []
  let pos = 0
  const push = (b: Uint8Array) => {
    chunks.push(b)
    pos += b.length
  }

  // Header: version + the conventional binary-content marker comment.
  push(enc('%PDF-1.4\n%âãÏÓ\n'))

  const offsets: number[] = []
  for (const parts of objects) {
    offsets.push(pos)
    for (const p of parts) push(p)
  }

  const xrefPos = pos
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const off of offsets) xref += `${off.toString().padStart(10, '0')} 00000 n \n`
  xref += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF`
  push(enc(xref))

  const out = new Uint8Array(pos)
  let at = 0
  for (const c of chunks) {
    out.set(c, at)
    at += c.length
  }
  return out
}

/** One page of a multi-page PDF: content ops + any embedded JPEGs (/Im0…). */
export interface PdfPage {
  ops: ContentOp[]
  images: PdfJpeg[]
}

/**
 * Assemble a multi-page PDF 1.4 file. Shared fonts are objects 3 (/F1
 * Helvetica) and 4 (/F2 Helvetica-Bold); each page contributes a content
 * stream, its image XObjects (/Im0, /Im1, …, DeviceRGB /DCTDecode), and a Page
 * object, in that order so object numbers stay ascending. All pages are A3
 * landscape. `image` ops whose `img` index exceeds a page's image count are
 * dropped (matches the single-image sheet's "no image → skip" behavior).
 */
export function buildMultiPagePdfBytes(pages: PdfPage[]): Uint8Array<ArrayBuffer> {
  // Pre-assign object numbers: fixed 1–4, then per page content/images/page.
  let next = 5
  const meta = pages.map((p) => {
    const contentNum = next++
    const imageNums = p.images.map(() => next++)
    const pageNum = next++
    return { contentNum, imageNums, pageNum }
  })

  const objects: Uint8Array[][] = [
    [enc('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n')],
    [
      enc(
        `2 0 obj\n<< /Type /Pages /Kids [${meta.map((m) => `${m.pageNum} 0 R`).join(' ')}] ` +
          `/Count ${pages.length} >>\nendobj\n`,
      ),
    ],
    [enc(`3 0 obj\n${FONT('Helvetica')}\nendobj\n`)],
    [enc(`4 0 obj\n${FONT('Helvetica-Bold')}\nendobj\n`)],
  ]

  pages.forEach((p, i) => {
    const m = meta[i]
    const drawable = p.ops.filter((o) => o.op !== 'image' || (o.img ?? 0) < p.images.length)
    const contentBytes = enc(drawable.map(opToStream).join('\n'))
    objects.push([
      enc(`${m.contentNum} 0 obj\n<< /Length ${contentBytes.length} >>\nstream\n`),
      contentBytes,
      enc('\nendstream\nendobj\n'),
    ])
    p.images.forEach((img, j) => {
      objects.push([
        enc(
          `${m.imageNums[j]} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${img.width} ` +
            `/Height ${img.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 ` +
            `/Filter /DCTDecode /Length ${img.bytes.length} >>\nstream\n`,
        ),
        img.bytes,
        enc('\nendstream\nendobj\n'),
      ])
    })
    const xobject = p.images.length
      ? ` /XObject << ${p.images.map((_, j) => `/Im${j} ${m.imageNums[j]} 0 R`).join(' ')} >>`
      : ''
    objects.push([
      enc(
        `${m.pageNum} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] ` +
          `/Resources << /Font << /F1 3 0 R /F2 4 0 R >>${xobject} >> /Contents ${m.contentNum} 0 R >>\nendobj\n`,
      ),
    ])
  })

  return assemblePdf(objects)
}

/**
 * Single-page PDF 1.4 file (A3 landscape) — a thin wrapper over
 * {@link buildMultiPagePdfBytes} for the one-off drawing sheets.
 */
export function buildPdfBytes(ops: ContentOp[], image: PdfJpeg | null): Uint8Array<ArrayBuffer> {
  return buildMultiPagePdfBytes([{ ops, images: image ? [image] : [] }])
}
