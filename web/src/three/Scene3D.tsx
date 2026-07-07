import { useEffect, useRef } from 'react'
import { Viewer3D } from './Viewer3D'
import type { DocState } from '../editor/EditorCanvas'

/**
 * React wrapper around {@link Viewer3D}. Mounts a full-size container, creates
 * the viewer once, pushes DocState on every change, and disposes on unmount.
 * A ResizeObserver keeps the renderer/camera synced to the container size.
 */
export function Scene3D({ state }: { state: DocState }) {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewerRef = useRef<Viewer3D | null>(null)

  // Create the viewer once for the lifetime of the mounted container.
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const viewer = new Viewer3D(host)
    viewerRef.current = viewer

    const ro = new ResizeObserver(() => viewer.resize())
    ro.observe(host)

    return () => {
      ro.disconnect()
      viewer.dispose()
      viewerRef.current = null
    }
  }, [])

  // Rebuild the scene whenever the document changes.
  useEffect(() => {
    viewerRef.current?.setState(state)
  }, [state])

  return <div ref={hostRef} style={{ width: '100%', height: '100%' }} />
}
