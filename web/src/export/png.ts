// Raster export: snapshot the stage's visible canvas to a downloadable PNG.
//
// The stage shows a 2D-context canvas in plan mode and the WebGL viewer's
// canvas in 3D mode, and the Export menu hands us whichever one is visible
// (App.tsx picks by `offsetParent`). Those two behave DIFFERENTLY under
// `toBlob`: a 2D canvas keeps its pixels indefinitely, while a WebGL canvas
// created without `preserveDrawingBuffer` (three/Viewer3D.ts) has its drawing
// buffer cleared as soon as the frame is composited — so a `toBlob` issued
// from a click handler, i.e. between frames, reads an already-empty buffer.
//
// Measured on the live app before this was fixed: 3D mode downloaded a
// 1044x818 PNG that was 100% transparent — one distinct colour, zero opaque
// pixels — reproducibly (3/3 runs, byte-identical at 20,004 B), with no error
// anywhere. A blank file that downloads successfully is the worst possible
// failure for a deliverable.
//
// The fix is to take the snapshot INSIDE a frame callback instead of between
// frames. `Viewer3D.animate` re-registers its rAF at the top of its own
// callback, so its render runs before any callback registered later in the
// frame; by the time ours runs the buffer holds the frame just drawn and is
// not cleared until compositing. For the 2D canvas this is a no-op beyond a
// one-frame delay, so one path serves both and there is no context sniffing
// (probing `getContext('2d')` on a WebGL canvas measurably broke the very
// capture it was meant to describe).

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

/** Export the given canvas (2D plan or WebGL viewer) as a PNG image download. */
export function exportPNG(canvas: HTMLCanvasElement, filename: string): void {
  requestAnimationFrame(() => {
    canvas.toBlob((blob) => {
      // A null blob means the encode failed outright. It used to return here in
      // silence, which is indistinguishable from a successful export the user
      // never finds; say so instead.
      if (!blob) {
        console.error(`exportPNG: the browser produced no image for ${filename}`)
        return
      }
      triggerDownload(blob, filename)
    }, 'image/png')
  })
}
