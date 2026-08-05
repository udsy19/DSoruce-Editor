import { useLayoutEffect, useEffect, useRef, useState, type ReactNode, type CSSProperties } from 'react'
import { formatINR } from '../materialBank/client'
import { Icon } from './icons'

/**
 * Materio-style floating selection card. Purely presentational: the parent
 * anchors it at a CSS-pixel point inside a `position: relative` container
 * (typically the canvas wrapper) and supplies title / status / price / image.
 * The card floats ABOVE the anchor with a caret pointing at it, clamps itself
 * to the container so it never clips, and flips below the anchor when there is
 * no room above.
 *
 * Appearance lives in `styles.css` (`.selcard*`). The only inline styles left
 * are the MEASURED ones — left/top/caret-x are computed from the anchor and the
 * container at layout time, and a stylesheet cannot know them.
 */

const CARD_W = 260
const EDGE = 8 // min gap to the container edge, px
const GAP = 12 // gap between anchor and card (room for the caret)
const CARET = 10 // caret square size, px

export type SelectionStatus = 'open' | 'review' | 'approved'

/** Decision lifecycle → chip label + its class modifier. */
const STATUS_CHIP: Record<SelectionStatus, { cls: string; label: string }> = {
  open: { cls: 'is-open', label: 'OPEN' },
  review: { cls: 'is-review', label: 'IN REVIEW' },
  approved: { cls: 'is-approved', label: 'APPROVED' },
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

export function SelectionCard({
  title,
  subtitle,
  status,
  price,
  image,
  x,
  y,
  onClose,
  children,
}: {
  title: string
  subtitle?: string
  status?: SelectionStatus
  /** ₹ (en-IN). Hidden when undefined; em-dash when null. */
  price?: number | null
  /** Product thumbnail URL (bank binding). */
  image?: string | null
  /** CSS px anchor within the positioned parent (bbox top-center). */
  x: number
  y: number
  onClose?: () => void
  children?: ReactNode
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number; caretX: number; below: boolean } | null>(null)
  const [entered, setEntered] = useState(false)

  // Subtle enter transition — fade/rise once on mount.
  useEffect(() => {
    const raf = requestAnimationFrame(() => setEntered(true))
    return () => cancelAnimationFrame(raf)
  }, [])

  // Measure + clamp to the positioned parent. Re-runs whenever the anchor or
  // content changes (content can change the card height).
  useLayoutEffect(() => {
    const el = ref.current
    const parent = el?.offsetParent as HTMLElement | null
    if (!el || !parent) return
    const h = el.offsetHeight
    const pw = parent.clientWidth
    const ph = parent.clientHeight
    const left = clamp(x - CARD_W / 2, EDGE, Math.max(EDGE, pw - CARD_W - EDGE))
    let top = y - h - GAP
    let below = false
    if (top < EDGE) {
      top = y + GAP
      below = true
    }
    top = clamp(top, EDGE, Math.max(EDGE, ph - h - EDGE))
    const caretX = clamp(x - left, 18, CARD_W - 18)
    setPos({ left, top, caretX, below })
  }, [x, y, title, subtitle, status, price, image, children])

  // Measured geometry only — everything else is in `.selcard*`.
  const cardStyle: CSSProperties = {
    left: pos?.left ?? x - CARD_W / 2,
    top: pos?.top ?? y,
  }
  const caretStyle: CSSProperties = { left: (pos?.caretX ?? CARD_W / 2) - CARET / 2 }

  const chip = status ? STATUS_CHIP[status] : null

  return (
    <div
      ref={ref}
      data-testid="selection-card"
      role="dialog"
      aria-label={title}
      className={`selcard${entered ? ' is-entered' : ''}${pos ? '' : ' is-measuring'}`}
      style={cardStyle}
    >
      <div className={`selcard-caret${pos?.below ? ' is-below' : ''}`} style={caretStyle} aria-hidden />
      <div className="selcard-head">
        {image ? (
          <img src={image} alt="" loading="lazy" className="selcard-thumb" />
        ) : image === null ? (
          <span aria-hidden className="selcard-thumb is-empty" />
        ) : null}
        <div className="selcard-text">
          <div className="selcard-title">{title}</div>
          {subtitle && <div className="selcard-sub">{subtitle}</div>}
        </div>
        {onClose && (
          <button onClick={onClose} aria-label="Close" className="selcard-close">
            <Icon name="close" size={13} />
          </button>
        )}
      </div>

      {(chip || price !== undefined) && (
        <div className="selcard-meta">
          {chip && <span className={`selcard-chip ${chip.cls}`}>{chip.label}</span>}
          {price !== undefined && <span className="selcard-price num">{formatINR(price)}</span>}
        </div>
      )}

      {children && <div className="selcard-actions">{children}</div>}
    </div>
  )
}
