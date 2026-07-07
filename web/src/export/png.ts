// Raster export: snapshot the 2D editor canvas to a downloadable PNG.
// The editor canvas is a plain 2D-context canvas, so `toBlob` captures its
// current pixels directly (no WebGL preserveDrawingBuffer dance needed).

/**
 * Trigger a browser download for a Blob via a temporary object URL + <a download>.
 * Shared by the PNG and DXF exporters so the download plumbing lives in one place.
 */
export function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

/** Export the given 2D canvas as a PNG image download. */
export function exportPNG(canvas: HTMLCanvasElement, filename: string): void {
  canvas.toBlob((blob) => {
    if (!blob) return
    triggerDownload(blob, filename)
  }, 'image/png')
}
