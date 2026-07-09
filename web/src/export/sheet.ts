// Shared sheet primitives for the PDF exporters — the `Page` helper (top-down
// coords over pdf.ts's ContentOp list) plus the architectural title block + key
// plan used by the drawing-set generator. Promoted out of report.ts so the
// report AND the drawing set draw on ONE primitive set (no-bloat,
// docs/design/drawing-set-generator.md §3.1). No new PDF engine, no new deps.

import {
  PAGE_W,
  PAGE_H,
  ContentOp,
  PdfJpeg,
  Rgb,
  textWidth,
  pdfSafeText,
  canvasToJpeg,
} from './pdf'
import type { DocState } from '../editor/EditorCanvas'

/** Outer page margin (pt), shared by report + drawing-set pages. */
export const MARGIN = 40
/** RES px per pt for embedded rasters — ~187 dpi, crisp line-work. */
export const RES = 2.6

export function hex2rgb(hex: string): Rgb {
  const h = hex.replace('#', '')
  return [
    parseInt(h.slice(0, 2), 16) / 255,
    parseInt(h.slice(2, 4), 16) / 255,
    parseInt(h.slice(4, 6), 16) / 255,
  ]
}

/** Warm-amber brand accent (CLAUDE.md) — KPI bars, headings. */
export const ACCENT: Rgb = hex2rgb('#E8A13C')

/**
 * A single PDF page: accumulates content ops (top-down y, converted to PDF
 * bottom-left space here) and image XObjects. The one primitive set every sheet
 * builder composes on.
 */
export class Page {
  ops: ContentOp[] = []
  images: PdfJpeg[] = []

  /** Convert a top-down y to PDF (bottom-left origin) space. */
  private y(yTop: number): number {
    return PAGE_H - yTop
  }

  text(
    x: number,
    yTop: number,
    size: number,
    s: string,
    o?: { bold?: boolean; gray?: number; rgb?: Rgb; align?: 'left' | 'center' | 'right' },
  ): void {
    const w = textWidth(pdfSafeText(s), size, o?.bold)
    const x0 = o?.align === 'right' ? x - w : o?.align === 'center' ? x - w / 2 : x
    this.ops.push({ op: 'text', x: x0, y: this.y(yTop), size, text: s, bold: o?.bold, gray: o?.gray, rgb: o?.rgb })
  }

  /** Filled/stroked box given a TOP-DOWN top-left corner. */
  box(
    xLeft: number,
    yTop: number,
    w: number,
    h: number,
    o: { fill?: boolean; gray?: number; rgb?: Rgb; width?: number },
  ): void {
    this.ops.push({
      op: 'rect',
      x: xLeft,
      y: this.y(yTop + h),
      w,
      h,
      fill: o.fill ?? true,
      gray: o.gray,
      rgb: o.rgb,
      width: o.width,
    })
  }

  line(x1: number, y1Top: number, x2: number, y2Top: number, o?: { gray?: number; rgb?: Rgb; width?: number }): void {
    this.ops.push({ op: 'line', x1, y1: this.y(y1Top), x2, y2: this.y(y2Top), gray: o?.gray, rgb: o?.rgb, width: o?.width })
  }

  /** Place a JPEG given a TOP-DOWN top-left corner; returns its /Im index. */
  image(jpeg: PdfJpeg, xLeft: number, yTop: number, w: number, h: number): void {
    const img = this.images.length
    this.images.push(jpeg)
    this.ops.push({ op: 'image', x: xLeft, y: this.y(yTop + h), w, h, img })
  }
}

/** Brand mark (dsource) top-left, centered caption, client name top-right. */
export function pageHeader(p: Page, center: string, client?: string): void {
  p.text(MARGIN, MARGIN + 6, 15, 'dsource', { bold: true, rgb: ACCENT })
  p.text(PAGE_W / 2, MARGIN + 4, 11, center, { align: 'center', gray: 0.35 })
  if (client) p.text(PAGE_W - MARGIN, MARGIN + 4, 11, client, { align: 'right', gray: 0.2, bold: true })
}

/** Client logo (data URL) → JPEG; null on any failure/absence. */
export async function logoJpeg(dataUrl: string | undefined, maxW: number): Promise<PdfJpeg | null> {
  if (!dataUrl || typeof Image === 'undefined') return null
  return new Promise<PdfJpeg | null>((resolve) => {
    const img = new Image()
    img.onload = () => {
      try {
        const scale = Math.min(1, maxW / img.width)
        const w = Math.max(1, Math.round(img.width * scale))
        const h = Math.max(1, Math.round(img.height * scale))
        const cv = document.createElement('canvas')
        cv.width = w
        cv.height = h
        const ctx = cv.getContext('2d')
        if (!ctx) return resolve(null)
        ctx.fillStyle = '#ffffff' // JPEG has no alpha
        ctx.fillRect(0, 0, w, h)
        ctx.drawImage(img, 0, 0, w, h)
        resolve({ bytes: canvasToJpeg(cv), width: w, height: h })
      } catch {
        resolve(null)
      }
    }
    img.onerror = () => resolve(null)
    img.src = dataUrl
  })
}

// ---------------------------------------------------------------------------
// Key plan — whole-plate thumbnail with THIS sheet's covered region filled.
// ---------------------------------------------------------------------------

/** Region a key plan highlights: the whole floor, or a world-rect strip. */
export type KeyRegion = 'all' | { x: number; y: number; w: number; h: number }

/**
 * Render the whole floor plate (wall outline) at thumbnail size with `region`
 * filled solid amber — so a reader knows which part of the building a sheet
 * covers (docs/design/drawing-set-generator.md §1.0). For plan sheets the
 * region is the whole floor. Returns a JPEG sized `wPx × hPx`.
 */
export function keyPlanJpeg(state: DocState, region: KeyRegion, wPx: number, hPx: number): PdfJpeg {
  const cv = document.createElement('canvas')
  cv.width = wPx
  cv.height = hPx
  const ctx = cv.getContext('2d')
  if (!ctx) return { bytes: canvasToJpeg(cv), width: wPx, height: hPx }
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, wPx, hPx)

  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const w of state.walls) {
    minX = Math.min(minX, w.a.x, w.b.x)
    minY = Math.min(minY, w.a.y, w.b.y)
    maxX = Math.max(maxX, w.a.x, w.b.x)
    maxY = Math.max(maxY, w.a.y, w.b.y)
  }
  if (minX === Infinity) return { bytes: canvasToJpeg(cv), width: wPx, height: hPx }

  const pad = 8
  const spanX = Math.max(maxX - minX, 0.001)
  const spanY = Math.max(maxY - minY, 0.001)
  const k = Math.min((wPx - pad * 2) / spanX, (hPx - pad * 2) / spanY)
  const ox = (wPx - spanX * k) / 2 - minX * k
  const oy = (hPx - spanY * k) / 2 - minY * k
  const X = (m: number) => m * k + ox
  const Y = (m: number) => m * k + oy

  // Highlight fill — the covered region (amber, translucent).
  ctx.fillStyle = 'rgba(232,161,60,0.5)'
  if (region === 'all') {
    ctx.fillRect(X(minX), Y(minY), spanX * k, spanY * k)
  } else {
    ctx.fillRect(X(region.x), Y(region.y), region.w * k, region.h * k)
  }

  // Plate outline — walls as thin grey lines.
  ctx.strokeStyle = '#6b7280'
  ctx.lineWidth = 1
  ctx.lineCap = 'round'
  for (const w of state.walls) {
    ctx.beginPath()
    ctx.moveTo(X(w.a.x), Y(w.a.y))
    ctx.lineTo(X(w.b.x), Y(w.b.y))
    ctx.stroke()
  }

  return { bytes: canvasToJpeg(cv), width: wPx, height: hPx }
}

// ---------------------------------------------------------------------------
// Title block — the spine of the set (Studio-Nova / Rayon anatomy, §1.0).
// ---------------------------------------------------------------------------

export interface TitleBlockInfo {
  no: string // 'A.01'
  title: string // 'Demolition Plan'
  scale: string // '1:75'
  studio?: string
  client?: string
  project: string
  address?: string
  revision?: string
  date: string // '07/07/26'
  drawnBy?: string
  approvedBy?: string
  keyPlan: PdfJpeg | null
}

/** Height (pt) of the bottom title-block band. */
export const TITLE_BLOCK_H = 116

/**
 * Draw the shared title block across the bottom band of a sheet: studio mark +
 * key plan + Client/Project/Revision/Date + Drawing Title/Drawn/Approved/Scale
 * + a big sheet number. Identical furniture on every sheet except title, scale,
 * key-plan highlight, and number — the invariance that reads as "a set."
 */
export function titleBlock(p: Page, o: TitleBlockInfo): void {
  const left = MARGIN
  const right = PAGE_W - MARGIN
  const top = PAGE_H - MARGIN - TITLE_BLOCK_H
  const bottom = PAGE_H - MARGIN

  // Band frame + top rule.
  p.box(left, top, right - left, TITLE_BLOCK_H, { fill: false, gray: 0.3, width: 1.1 })

  // Column x-dividers.
  const x1 = left + 150 // studio | key plan
  const x2 = x1 + 150 // key plan | notes
  const x3 = x2 + 175 // notes | client
  const x4 = x3 + 230 // client | drawing-title
  const x5 = right - 130 // drawing-title | sheet no.
  for (const x of [x1, x2, x3, x4, x5]) p.line(x, top, x, bottom, { gray: 0.3, width: 0.8 })

  // 1) Studio mark + address.
  p.box(left + 16, top + 20, 22, 22, { fill: false, gray: 0.35, width: 1.4 })
  p.box(left + 21, top + 25, 12, 12, { fill: true, rgb: ACCENT })
  p.text(left + 46, top + 30, 13, o.studio ?? 'DSOURCE', { bold: true, gray: 0.15 })
  p.text(left + 46, top + 44, 7, 'DRAWING SET', { gray: 0.5 })
  p.text(left + 16, bottom - 12, 7, o.address ?? 'dsource.editor', { gray: 0.5 })

  // 2) Key plan.
  p.text(x1 + 10, top + 16, 7.5, 'KEY PLAN', { gray: 0.45, bold: true })
  const kpX = x1 + 10
  const kpY = top + 24
  const kpW = x2 - x1 - 20
  const kpH = TITLE_BLOCK_H - 36
  if (o.keyPlan) {
    const s = Math.min(kpW / o.keyPlan.width, kpH / o.keyPlan.height)
    const w = o.keyPlan.width * s
    const h = o.keyPlan.height * s
    p.image(o.keyPlan, kpX + (kpW - w) / 2, kpY + (kpH - h) / 2, w, h)
  }
  p.box(kpX, kpY, kpW, kpH, { fill: false, gray: 0.7, width: 0.6 })

  // 3) Notes — ruled writing area.
  p.text(x2 + 12, top + 16, 7.5, 'NOTES', { gray: 0.45, bold: true })
  for (let i = 0; i < 4; i++) p.line(x2 + 12, top + 34 + i * 18, x3 - 12, top + 34 + i * 18, { gray: 0.82, width: 0.5 })

  // 4) Client / Project / Revision / Date.
  const fieldRow = (colL: number, colR: number, yTop: number, label: string, value: string) => {
    p.text(colL + 12, yTop, 7, label, { gray: 0.5 })
    p.text(colL + 60, yTop, 8.5, value, { gray: 0.12, bold: true })
    p.line(colL + 12, yTop + 5, colR - 12, yTop + 5, { gray: 0.85, width: 0.4 })
  }
  fieldRow(x3, x4, top + 24, 'CLIENT', o.client ?? '-')
  fieldRow(x3, x4, top + 48, 'PROJECT', o.project)
  fieldRow(x3, x4, top + 72, 'REVISION', o.revision ?? '-')
  fieldRow(x3, x4, top + 96, 'DATE', o.date)

  // 5) Drawing Title / Drawn / Approved / Scale.
  fieldRow(x4, x5, top + 24, 'TITLE', o.title)
  fieldRow(x4, x5, top + 48, 'DRAWN', o.drawnBy ?? 'DSOURCE')
  fieldRow(x4, x5, top + 72, 'APPROVED', o.approvedBy ?? '-')
  fieldRow(x4, x5, top + 96, 'SCALE', o.scale)

  // 6) Big sheet number.
  p.box(x5 + 12, top + 24, right - x5 - 24, TITLE_BLOCK_H - 44, { fill: false, gray: 0.7, width: 0.6 })
  p.text((x5 + right) / 2, top + 78, 34, o.no, { align: 'center', bold: true, gray: 0.1 })
}
