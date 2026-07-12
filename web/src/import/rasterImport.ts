// Raster (image) floor-plan import — the non-CAD path.
//
// A user without a DXF/DWG can drop a PNG/JPG of a floor plan (a scan, a screen
// grab, an estate-agent plan). We show it as a scaled BACKDROP under the drawing
// surface and let them CALIBRATE it: draw a reference line over a known
// dimension, type its real length, and the whole image snaps to real meters
// (the standard "scale by reference line" pattern — SmartDraw / magicplan /
// Concepts). Then the existing area-select / plate tracing works over it exactly
// as it does for CAD linework, because the canvas world is now real meters.
//
// PDF is a deliberate follow-up: pdf.js renders a PDF page to a canvas that would
// feed straight into {@link makeBackdrop}, and it bundles under Vite via the
// `new URL('pdfjs-dist/build/pdf.worker.mjs', import.meta.url)` worker pattern
// (no runtime CDN, so it satisfies the app's no-network rule) — it only needs
// the `pdfjs-dist` dependency added. Until then we accept images only.

import type { Drawing } from './types'

/** A calibrated raster underlay: the decoded image, its pixel size, and the
 *  meters-per-pixel scale that maps it into the canvas's world (meters). */
export interface Backdrop {
  image: CanvasImageSource
  /** Natural pixel width/height of the source image. */
  wpx: number
  hpx: number
  /** World meters per source pixel. Set by calibration; starts at a guess. */
  mpp: number
}

/** Accepted raster MIME/type check (extension-based, mirrors the CAD gate). */
export function isRasterFile(file: File): boolean {
  return /\.(png|jpe?g|webp|gif|bmp)$/i.test(file.name)
}

/** Uncalibrated default: assume the longer edge is ~20 m so the backdrop lands
 *  at a sane on-screen size before the user calibrates it. */
const DEFAULT_LONG_EDGE_M = 20

/** World rect [minX, minY, maxX, maxY] a backdrop occupies — anchored bottom-left
 *  at the world origin, Y-up (so it lines up with the CAD convention). */
export function backdropBounds(b: Backdrop): [number, number, number, number] {
  return [0, 0, b.wpx * b.mpp, b.hpx * b.mpp]
}

/** Wrap a decoded image as a {@link Backdrop} at the default (uncalibrated) scale. */
export function makeBackdrop(image: CanvasImageSource, wpx: number, hpx: number): Backdrop {
  const mpp = DEFAULT_LONG_EDGE_M / Math.max(1, Math.max(wpx, hpx))
  return { image, wpx, hpx, mpp }
}

/** An empty {@link Drawing} sized to the backdrop, so the existing DrawingView /
 *  DrawingCanvas render + area-select machinery works with no CAD linework. */
export function emptyDrawingFor(b: Backdrop): Drawing {
  return {
    units: 'm',
    bounds: backdropBounds(b),
    layers: [],
    entities: [],
    furniture: [],
  }
}

/**
 * Decode a raster File into a {@link Backdrop} + a matching empty {@link Drawing}.
 * Uses `createImageBitmap` (fast, off-thread decode; supported in all modern
 * browsers) and returns geometry in the canvas's world convention.
 */
export async function loadRasterBackdrop(
  file: File,
): Promise<{ backdrop: Backdrop; drawing: Drawing }> {
  if (!isRasterFile(file)) throw new Error('Not a supported image (PNG, JPG, WEBP).')
  const bitmap = await createImageBitmap(file)
  const backdrop = makeBackdrop(bitmap, bitmap.width, bitmap.height)
  return { backdrop, drawing: emptyDrawingFor(backdrop) }
}
