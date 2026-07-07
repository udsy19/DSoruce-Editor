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
 */

const CARD_W = 260
const EDGE = 8 // min gap to the container edge, px
const GAP = 12 // gap between anchor and card (room for the caret)
const CARET = 10 // caret square size, px

export type SelectionStatus = 'open' | 'review' | 'approved'

const STATUS_STYLE: Record<SelectionStatus, { bg: string; fg: string; label: string }> = {
  open: { bg: '#eef0f3', fg: '#5c6670', label: 'OPEN' },
  review: { bg: '#fdf3e0', fg: '#a06a12', label: 'IN REVIEW' },
  approved: { bg: '#e5f4ea', fg: '#1e7d3e', label: 'APPROVED' },
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

  const caretStyle: CSSProperties = {
    position: 'absolute',
    width: CARET,
    height: CARET,
    background: '#fff',
    transform: 'rotate(45deg)',
    left: (pos?.caretX ?? CARD_W / 2) - CARET / 2,
    ...(pos?.below
      ? { top: -CARET / 2, boxShadow: '-2px -2px 4px rgba(24,30,40,0.05)' }
      : { bottom: -CARET / 2, boxShadow: '2px 2px 4px rgba(24,30,40,0.05)' }),
  }

  const chip = status ? STATUS_STYLE[status] : null

  return (
    <div
      ref={ref}
      data-testid="selection-card"
      role="dialog"
      aria-label={title}
      style={{
        position: 'absolute',
        left: pos?.left ?? x - CARD_W / 2,
        top: pos?.top ?? y,
        width: CARD_W,
        visibility: pos ? 'visible' : 'hidden',
        background: '#fff',
        borderRadius: 12,
        boxShadow: '0 8px 28px rgba(24,30,40,0.14), 0 1px 3px rgba(24,30,40,0.10)',
        padding: '12px 14px',
        zIndex: 20,
        fontFamily: '"Space Grotesk", system-ui, sans-serif',
        opacity: entered ? 1 : 0,
        transform: entered ? 'translateY(0)' : 'translateY(4px)',
        transition: 'opacity 140ms ease, transform 140ms ease',
        pointerEvents: 'auto',
      }}
    >
      <div style={caretStyle} aria-hidden />
      <div style={{ position: 'relative', display: 'flex', gap: 10, alignItems: 'flex-start' }}>
        {image ? (
          <img
            src={image}
            alt=""
            loading="lazy"
            style={{
              width: 44,
              height: 44,
              borderRadius: 8,
              objectFit: 'cover',
              flex: 'none',
              background: '#eef0f3',
            }}
          />
        ) : image === null ? (
          <span
            aria-hidden
            style={{ width: 44, height: 44, borderRadius: 8, flex: 'none', background: '#e6e9ee' }}
          />
        ) : null}
        <div style={{ minWidth: 0, flex: 1 }}>
          <div
            style={{
              fontSize: 13.5,
              fontWeight: 600,
              color: '#1e2329',
              lineHeight: 1.25,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              display: '-webkit-box',
              WebkitLineClamp: 2,
              WebkitBoxOrient: 'vertical',
            }}
          >
            {title}
          </div>
          {subtitle && (
            <div
              style={{
                fontSize: 11.5,
                color: '#7a828c',
                marginTop: 2,
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {subtitle}
            </div>
          )}
        </div>
        {onClose && (
          <button
            onClick={onClose}
            aria-label="Close"
            style={{
              flex: 'none',
              border: 'none',
              background: 'transparent',
              color: '#9aa2ad',
              cursor: 'pointer',
              padding: 2,
              margin: '-2px -4px 0 0',
              lineHeight: 0,
            }}
          >
            <Icon name="close" size={13} />
          </button>
        )}
      </div>

      {(chip || price !== undefined) && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10 }}>
          {chip && (
            <span
              style={{
                fontSize: 9.5,
                fontWeight: 700,
                letterSpacing: '0.08em',
                padding: '3px 8px',
                borderRadius: 999,
                background: chip.bg,
                color: chip.fg,
              }}
            >
              {chip.label}
            </span>
          )}
          {price !== undefined && (
            <span
              style={{
                marginLeft: 'auto',
                fontFamily: '"IBM Plex Mono", ui-monospace, monospace',
                fontSize: 13,
                fontWeight: 600,
                color: '#1e2329',
              }}
            >
              {formatINR(price)}
            </span>
          )}
        </div>
      )}

      {children && (
        <div
          style={{
            marginTop: 10,
            paddingTop: 10,
            borderTop: '1px solid #eef0f3',
            display: 'flex',
            gap: 8,
          }}
        >
          {children}
        </div>
      )}
    </div>
  )
}
