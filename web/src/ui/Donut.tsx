// Stroke-based SVG donut. Segments are drawn as dash-arced rings; slices are
// expected to sum to ~100 (zones tile the plate, so they always do here).
export interface DonutSegment {
  color: string
  pct: number
}

export function Donut({
  segments,
  center,
  unit,
  size = 150,
}: {
  segments: DonutSegment[]
  center: string
  unit: string
  size?: number
}) {
  const sw = 22
  const r = (size - sw) / 2
  const c = size / 2
  const circ = 2 * Math.PI * r
  const gap = 2
  let offset = 0

  return (
    <div className="donut-wrap">
      <div style={{ position: 'relative', width: size, height: size }}>
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
          <circle cx={c} cy={c} r={r} fill="none" stroke="var(--hairline)" strokeWidth={sw} />
          <g transform={`rotate(-90 ${c} ${c})`}>
            {segments.map((s, i) => {
              const len = (Math.max(0, s.pct) / 100) * circ
              const dash = Math.max(0, len - gap)
              const el = (
                <circle
                  key={i}
                  cx={c}
                  cy={c}
                  r={r}
                  fill="none"
                  stroke={s.color}
                  strokeWidth={sw}
                  strokeDasharray={`${dash} ${circ - dash}`}
                  strokeDashoffset={-offset}
                />
              )
              offset += len
              return el
            })}
          </g>
        </svg>
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'grid',
            placeItems: 'center',
            textAlign: 'center',
            lineHeight: 1.1,
          }}
        >
          <div>
            <div className="donut-center">{center}</div>
            <div className="donut-center-unit">{unit}</div>
          </div>
        </div>
      </div>
    </div>
  )
}
