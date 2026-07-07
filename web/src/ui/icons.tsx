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
    case 'generate':
      return (
        <svg {...p}>
          <path d="M12 3v3M12 18v3M3 12h3M18 12h3M6 6l2 2M16 16l2 2M18 6l-2 2M8 16l-2 2" />
          <circle cx="12" cy="12" r="3.2" />
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
