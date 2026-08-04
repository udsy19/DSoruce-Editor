// Minimal 24×24 line icons, stroked with currentColor for a consistent
// technical/drafting feel. Keys match tool ids and catalog `icon` fields.

type Props = { name: string; size?: number }

export function Icon({ name, size = 19 }: Props) {
  const p = {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.6,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  }
  switch (name) {
    case 'select':
      return (
        <svg {...p}>
          <path d="M5 3l0 15 4-4 3 6 2-1-3-6 5 0z" fill="currentColor" stroke="none" />
        </svg>
      )
    case 'wall':
      return (
        <svg {...p} strokeWidth={2.2}>
          <path d="M5 19V6h14" />
        </svg>
      )
    case 'desk':
      return (
        <svg {...p}>
          <rect x="3.5" y="8.5" width="17" height="7" rx="1" />
          <path d="M9 8.5V6.5h6v2" />
        </svg>
      )
    case 'chair':
      return (
        <svg {...p}>
          <rect x="7.5" y="9.5" width="9" height="9" rx="1.2" />
          <path d="M7.5 9.5V6.5h9v3" />
        </svg>
      )
    case 'table':
      return (
        <svg {...p}>
          <rect x="3.5" y="7.5" width="17" height="9" rx="4.5" />
          <circle cx="12" cy="12" r="1.4" />
        </svg>
      )
    case 'meeting':
      return (
        <svg {...p}>
          <rect x="3" y="5.5" width="18" height="13" rx="1.6" />
          <rect x="9" y="10" width="6" height="4" rx="1" />
        </svg>
      )
    case 'ceiling':
      return (
        <svg {...p}>
          <rect x="4" y="4" width="16" height="16" rx="1" />
          <path d="M4 12h16M12 4v16" strokeDasharray="2 2.4" strokeWidth={1.2} />
        </svg>
      )
    case 'bolt':
      return (
        <svg {...p}>
          <path d="M13 2L4 14h6l-1 8 9-12h-6z" />
        </svg>
      )
    case 'people':
      return (
        <svg {...p}>
          <circle cx="9" cy="8" r="3" />
          <path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6" />
          <path d="M16 5.5a3 3 0 0 1 0 5.6M21 20c0-2.5-1.4-4.6-3.4-5.6" />
        </svg>
      )
    case 'leaf':
      return (
        <svg {...p}>
          <path d="M4 20c0-9 7-16 16-16 0 9-7 16-16 16z" />
          <path d="M4 20C8 14 12 11 18 8" />
        </svg>
      )
    case 'dollar':
      return (
        <svg {...p}>
          <path d="M12 3v18M16 7.5c0-1.9-1.8-3-4-3s-4 1.1-4 3 1.8 2.7 4 3.2 4 1.3 4 3.3-1.8 3-4 3-4-1.1-4-3" />
        </svg>
      )
    case 'caret':
      return (
        <svg {...p}>
          <path d="M6 9l6 6 6-6" />
        </svg>
      )
    case 'sparkles':
      return (
        <svg {...p}>
          <path d="M12 3l1.8 4.7L18.5 9.5 13.8 11.3 12 16l-1.8-4.7L5.5 9.5l4.7-1.8z" />
          <path d="M18 15l.7 1.8 1.8.7-1.8.7L18 20l-.7-1.8-1.8-.7 1.8-.7z" />
        </svg>
      )
    case 'marquee':
      return (
        <svg {...p}>
          <rect x="4" y="5" width="16" height="14" rx="0.5" strokeDasharray="2.5 2" />
        </svg>
      )
    case 'move':
      return (
        <svg {...p}>
          <path d="M12 3v18M3 12h18" />
          <path d="M12 3l-2.5 2.5M12 3l2.5 2.5M12 21l-2.5-2.5M12 21l2.5-2.5M3 12l2.5-2.5M3 12l2.5 2.5M21 12l-2.5-2.5M21 12l-2.5 2.5" strokeWidth={1.2} />
        </svg>
      )
    case 'copy':
      return (
        <svg {...p}>
          <rect x="8" y="8" width="11" height="11" rx="1" />
          <path d="M5 15V5h10" />
        </svg>
      )
    case 'rotate':
      return (
        <svg {...p}>
          <path d="M20 12a8 8 0 1 1-2.3-5.6" />
          <path d="M20 4v4h-4" strokeWidth={1.2} />
        </svg>
      )
    case 'mirror':
      return (
        <svg {...p}>
          <path d="M12 3v18" strokeDasharray="2.5 2" />
          <path d="M9 7L4 12l5 5zM15 7l5 5-5 5z" />
        </svg>
      )
    case 'scale':
      return (
        <svg {...p}>
          <rect x="5" y="9" width="10" height="10" rx="0.5" />
          <path d="M14 10l6-6M20 4v5M20 4h-5" strokeWidth={1.2} />
        </svg>
      )
    case 'trim':
      return (
        <svg {...p}>
          <path d="M4 6l10 10M14 6L4 16" />
          <path d="M14 16l6-2M14 6l6 2" strokeWidth={1.2} strokeDasharray="2 2" />
          <circle cx="15.5" cy="17" r="2" />
          <circle cx="15.5" cy="5" r="2" />
        </svg>
      )
    case 'extend':
      return (
        <svg {...p}>
          <path d="M20 4v16" />
          <path d="M4 12h9" />
          <path d="M13 12h5M18 12l-2.5-2.5M18 12l-2.5 2.5" strokeWidth={1.2} strokeDasharray="2 2" />
        </svg>
      )
    case 'fillet':
      return (
        <svg {...p}>
          <path d="M5 20v-8q0-7 7-7h8" />
          <path d="M5 12V5h7" strokeWidth={1.2} strokeDasharray="2 2" />
        </svg>
      )
    case 'hatch':
      return (
        <svg {...p}>
          <rect x="4" y="4" width="16" height="16" rx="0.5" />
          <path d="M4 12l8-8M4 20L20 4M12 20l8-8" strokeWidth={1.2} />
        </svg>
      )
    case 'layers':
      return (
        <svg {...p}>
          <path d="M12 3l9 5-9 5-9-5z" />
          <path d="M3 13l9 5 9-5" strokeWidth={1.2} />
        </svg>
      )
    case 'line':
      return (
        <svg {...p}>
          <path d="M4 20L20 4" />
          <circle cx="4" cy="20" r="1.4" fill="currentColor" stroke="none" />
          <circle cx="20" cy="4" r="1.4" fill="currentColor" stroke="none" />
        </svg>
      )
    case 'polyline':
      return (
        <svg {...p}>
          <path d="M3 18l5-8 5 5 8-11" />
        </svg>
      )
    case 'rect':
      return (
        <svg {...p}>
          <rect x="4" y="6" width="16" height="12" rx="0.5" />
        </svg>
      )
    case 'circle':
      return (
        <svg {...p}>
          <circle cx="12" cy="12" r="8" />
        </svg>
      )
    case 'arc':
      return (
        <svg {...p}>
          <path d="M4 18a12 12 0 0 1 16-4" />
        </svg>
      )
    case 'ellipse':
      return (
        <svg {...p}>
          <ellipse cx="12" cy="12" rx="9" ry="6" />
        </svg>
      )
    case 'dimension':
      return (
        <svg {...p}>
          <path d="M4 8v8M20 8v8M4 12h16" />
          <path d="M4 12l3-2M4 12l3 2M20 12l-3-2M20 12l-3 2" strokeWidth={1.2} />
        </svg>
      )
    case 'text':
      return (
        <svg {...p}>
          <path d="M5 6h14M12 6v13" />
        </svg>
      )
    case 'door':
      return (
        <svg {...p}>
          <path d="M6 20V5h1" />
          <path d="M7 5a13 13 0 0 1 12 12" />
          <path d="M19 17v3" strokeWidth={1.2} />
        </svg>
      )
    case 'window':
      return (
        <svg {...p}>
          <rect x="4" y="9" width="16" height="6" rx="0.5" />
          <path d="M12 9v6" />
        </svg>
      )
    case 'column':
      return (
        <svg {...p}>
          <rect x="7" y="7" width="10" height="10" rx="0.5" fill="currentColor" fillOpacity="0.25" />
        </svg>
      )
    case 'generate':
      return (
        <svg {...p}>
          <path d="M12 3v3M12 18v3M3 12h3M18 12h3M6 6l2 2M16 16l2 2M18 6l-2 2M8 16l-2 2" />
          <circle cx="12" cy="12" r="3.2" />
        </svg>
      )
    case 'check':
      return (
        <svg {...p}>
          <path d="M4 12.5l5 5 11-12" />
        </svg>
      )
    case 'warn':
      return (
        <svg {...p}>
          <path d="M12 3L2 20h20z" />
          <path d="M12 10v4" />
          <circle cx="12" cy="17" r="0.6" fill="currentColor" stroke="none" />
        </svg>
      )
    case 'cross':
      return (
        <svg {...p}>
          <path d="M6 6l12 12M18 6L6 18" />
        </svg>
      )
    case 'dash':
      return (
        <svg {...p}>
          <path d="M6 12h12" />
        </svg>
      )
    case 'help':
      return (
        <svg {...p}>
          <circle cx="12" cy="12" r="9" />
          <path d="M9.2 9.3a2.8 2.8 0 0 1 5.4 1c0 1.9-2.6 2.3-2.6 4" />
          <circle cx="12" cy="17.2" r="0.7" fill="currentColor" stroke="none" />
        </svg>
      )
    case 'close':
      return (
        <svg {...p}>
          <path d="M6 6l12 12M18 6L6 18" />
        </svg>
      )
    case 'upload':
      return (
        <svg {...p}>
          <path d="M12 16V4M7 9l5-5 5 5" />
          <path d="M4 15v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4" />
        </svg>
      )
    // The same tray, arrow reversed — a file leaving rather than arriving.
    case 'download':
      return (
        <svg {...p}>
          <path d="M12 4v12M7 11l5 5 5-5" />
          <path d="M4 15v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4" />
        </svg>
      )
    case 'pin':
      return (
        <svg {...p}>
          <path d="M12 21s6-5.3 6-10a6 6 0 1 0-12 0c0 4.7 6 10 6 10z" />
          <circle cx="12" cy="11" r="2.2" />
        </svg>
      )
    default:
      return (
        <svg {...p}>
          <rect x="5" y="5" width="14" height="14" rx="2" />
        </svg>
      )
  }
}
