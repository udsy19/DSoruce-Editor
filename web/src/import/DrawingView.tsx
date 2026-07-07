import { useEffect, useRef } from 'react'
import { DrawingCanvas } from './DrawingCanvas'
import type { Drawing, FurnitureItem } from './types'

/**
 * React wrapper around {@link DrawingCanvas}. Mounts a full-size container with
 * a canvas, creates the renderer once, pushes the `drawing` prop on change,
 * wires `onSelect`, and disposes on unmount. A ResizeObserver inside
 * DrawingCanvas keeps the viewport DPR-synced to the container size.
 *
 * Mirrors the pattern in `../three/Scene3D`.
 */
export function DrawingView({
  drawing,
  onSelect,
}: {
  drawing: Drawing | null
  onSelect?: (item: FurnitureItem | null) => void
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const dcRef = useRef<DrawingCanvas | null>(null)

  // Create the renderer once for the lifetime of the mounted canvas.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const dc = new DrawingCanvas(canvas)
    dcRef.current = dc
    return () => {
      dc.dispose()
      dcRef.current = null
    }
  }, [])

  // Keep the select callback current without re-creating the renderer.
  useEffect(() => {
    if (dcRef.current) dcRef.current.onSelect = onSelect ?? null
  }, [onSelect])

  // Push the drawing whenever it changes (fits + renders).
  useEffect(() => {
    if (dcRef.current && drawing) dcRef.current.setDrawing(drawing)
  }, [drawing])

  return (
    <div ref={hostRef} style={{ width: '100%', height: '100%', position: 'relative' }}>
      <canvas ref={canvasRef} style={{ display: 'block', width: '100%', height: '100%' }} />
    </div>
  )
}
