import { useEffect, useRef } from 'react'
import { DrawingCanvas } from './DrawingCanvas'
import type { Drawing, FurnitureItem } from './types'

/**
 * React wrapper around {@link DrawingCanvas}. Mounts a full-size container with
 * a canvas, creates the renderer once, pushes the `drawing` prop on change,
 * wires `onSelect`/`onChange`, hands the instance to `onCanvas`, and disposes on
 * unmount. A ResizeObserver inside DrawingCanvas keeps the viewport DPR-synced
 * to the container size.
 *
 * The `drawing` prop is only re-applied (which refits/resets pan+zoom) when its
 * IDENTITY changes — i.e. a new import. In-place edits mutate the same Drawing
 * object and re-render internally, so they must NOT re-run `setDrawing`.
 *
 * Mirrors the pattern in `../three/Scene3D`.
 */
export function DrawingView({
  drawing,
  onSelect,
  onChange,
  onCanvas,
}: {
  drawing: Drawing | null
  onSelect?: (item: FurnitureItem | null) => void
  onChange?: (d: Drawing) => void
  onCanvas?: (c: DrawingCanvas | null) => void
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const dcRef = useRef<DrawingCanvas | null>(null)
  // Latest onCanvas without re-running the create-once effect.
  const onCanvasRef = useRef(onCanvas)
  onCanvasRef.current = onCanvas

  // Create the renderer once for the lifetime of the mounted canvas.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const dc = new DrawingCanvas(canvas)
    dcRef.current = dc
    onCanvasRef.current?.(dc)
    return () => {
      dc.dispose()
      dcRef.current = null
      onCanvasRef.current?.(null)
    }
  }, [])

  // Keep the callbacks current without re-creating the renderer.
  useEffect(() => {
    if (dcRef.current) dcRef.current.onSelect = onSelect ?? null
  }, [onSelect])
  useEffect(() => {
    if (dcRef.current) dcRef.current.onChange = onChange ?? null
  }, [onChange])

  // Push the drawing only when the PROP IDENTITY changes (a new import). Edits
  // mutate in place + re-render internally and must not reset pan/zoom/fit.
  useEffect(() => {
    if (dcRef.current && drawing) dcRef.current.setDrawing(drawing)
  }, [drawing])

  return (
    <div ref={hostRef} style={{ width: '100%', height: '100%', position: 'relative' }}>
      <canvas ref={canvasRef} style={{ display: 'block', width: '100%', height: '100%' }} />
    </div>
  )
}
