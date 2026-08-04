import { useEffect, useRef, useState } from 'react'
import { DrawingCanvas } from './DrawingCanvas'
import { SelectionCard } from '../ui/SelectionCard'
import type { Drawing, FurnitureItem } from './types'

/**
 * Live DrawingCanvas instances, newest last.
 *
 * Three of these can exist at once — the Space step's preview, the Program
 * step's anchor plan, and the editor's import mode — because EditorView stays
 * mounted behind the wizard. A single `window.__dc` assigned at mount therefore
 * pointed at whichever mounted LAST, which was the hidden 300x150 editor canvas
 * rather than the 727x532 one the user was looking at. The previous answer was
 * to add more names (`__spacedc`, `__programdc`); this replaces all three with
 * one seam that resolves to the canvas actually on screen.
 */
const liveCanvases = new Set<DrawingCanvas>()

if (import.meta.env.DEV && typeof window !== 'undefined') {
  Object.defineProperty(window, '__dc', {
    configurable: true,
    get() {
      const all = [...liveCanvases]
      // The visible one, if any — a hidden canvas has a zero-size client rect.
      return (
        all.find((c) => c.canvasEl.getBoundingClientRect().width > 0) ??
        all[all.length - 1] ??
        null
      )
    },
  })
}

/**
 * React wrapper around {@link DrawingCanvas}. Mounts a full-size container with
 * a canvas, creates the renderer once, pushes the `drawing` prop on change,
 * wires `onSelect`/`onChange`, hands the instance to `onCanvas`, and disposes on
 * unmount. A ResizeObserver inside DrawingCanvas keeps the viewport DPR-synced
 * to the container size.
 *
 * Also owns the Materio-style floating {@link SelectionCard}: when a furniture
 * item is selected it renders the card anchored at the item's bbox top-center
 * (via `DrawingCanvas.anchorFor`), re-anchoring on every pan/zoom/refresh
 * through `onViewChange` (rAF-throttled). The optional `price`/`image` props
 * carry the selected item's bound bank product data from the orchestrator.
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
  price,
  image,
}: {
  drawing: Drawing | null
  onSelect?: (item: FurnitureItem | null) => void
  onChange?: (d: Drawing) => void
  onCanvas?: (c: DrawingCanvas | null) => void
  /** ₹ price of the selected item's bound bank product (from the orchestrator). */
  price?: number | null
  /** Thumbnail URL of the selected item's bound bank product. */
  image?: string | null
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const dcRef = useRef<DrawingCanvas | null>(null)
  // Latest onCanvas without re-running the create-once effect.
  const onCanvasRef = useRef(onCanvas)
  onCanvasRef.current = onCanvas
  const onSelectRef = useRef(onSelect)
  onSelectRef.current = onSelect

  // Local mirror of the canvas selection + its screen anchor for the card.
  const [sel, setSel] = useState<FurnitureItem | null>(null)
  const selRef = useRef<FurnitureItem | null>(null)
  selRef.current = sel
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null)
  const rafRef = useRef(0)

  // Create the renderer once for the lifetime of the mounted canvas.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const dc = new DrawingCanvas(canvas)
    dcRef.current = dc
    liveCanvases.add(dc)
    // rAF-throttled re-anchor: the canvas renders per pointer-move while
    // panning/zooming, but the popover only needs one reposition per frame.
    dc.onViewChange = () => {
      if (rafRef.current) return
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = 0
        const it = selRef.current
        setAnchor(it && dcRef.current ? dcRef.current.anchorFor(it) : null)
      })
    }
    onCanvasRef.current?.(dc)
    return () => {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = 0
      liveCanvases.delete(dc)
      dc.dispose()
      dcRef.current = null
      onCanvasRef.current?.(null)
    }
  }, [])

  // Wrap the selection callback once: mirror into local state for the card,
  // then forward to the parent (always the fresh closure via the ref).
  useEffect(() => {
    const dc = dcRef.current
    if (!dc) return
    dc.onSelect = (item) => {
      setSel(item)
      setAnchor(item ? dc.anchorFor(item) : null)
      onSelectRef.current?.(item)
    }
  }, [])

  // Keep the edit callback current without re-creating the renderer.
  useEffect(() => {
    if (dcRef.current) dcRef.current.onChange = onChange ?? null
  }, [onChange])

  // Push the drawing only when the PROP IDENTITY changes (a new import). Edits
  // mutate in place + re-render internally and must not reset pan/zoom/fit.
  useEffect(() => {
    if (dcRef.current && drawing) {
      dcRef.current.setDrawing(drawing)
      setSel(null) // setDrawing clears the canvas selection silently
      setAnchor(null)
    }
  }, [drawing])

  /** "Re-imagine" hands off to the existing inspector: focus its bank search
   *  (least-invasive hook — the inspector is already mounted for the selected
   *  item), falling back to re-firing the selection chain. */
  const reimagine = () => {
    const search = document.querySelector<HTMLInputElement>('.inspector input.search')
    if (search) {
      search.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
      search.focus({ preventScroll: true })
    } else if (sel) {
      onSelectRef.current?.(sel)
    }
  }

  return (
    <div ref={hostRef} style={{ width: '100%', height: '100%', position: 'relative' }}>
      <canvas ref={canvasRef} style={{ display: 'block', width: '100%', height: '100%' }} />
      {sel && anchor && (
        <SelectionCard
          title={sel.productName ?? sel.name}
          subtitle={`${sel.category} · Imported plan`}
          status={sel.productId ? 'approved' : 'open'}
          price={price}
          image={image}
          x={anchor.x}
          y={anchor.y}
          onClose={() => dcRef.current?.clearSelection()}
        >
          <button
            onClick={reimagine}
            data-testid="selection-card-reimagine"
            style={{
              border: 'none',
              background: 'transparent',
              color: 'var(--accent, #2d5bd6)',
              fontFamily: 'inherit',
              fontSize: 12,
              fontWeight: 600,
              cursor: 'pointer',
              padding: 0,
            }}
          >
            Re-imagine →
          </button>
        </SelectionCard>
      )}
    </div>
  )
}
