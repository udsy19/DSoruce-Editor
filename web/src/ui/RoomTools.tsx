import type { DocZone, ZoneType, RoomSelection } from '../types/doc'
import { EditorCanvas } from '../editor/EditorCanvas'
import { Icon } from './icons'

// Room types offered in the "Assign to" dropdown (order = the design doc's
// zone vocabulary). Circulation is included so the perimeter ring is renamable.
const ROOM_TYPES: { value: ZoneType; label: string }[] = [
  { value: 'Workspace', label: 'Open Workspace' },
  { value: 'Meeting', label: 'Meeting Room' },
  { value: 'Collaboration', label: 'Collaboration' },
  { value: 'ClosedOffice', label: 'Closed Office' },
  { value: 'Amenity', label: 'Amenity' },
  { value: 'Core', label: 'Core / Service' },
  { value: 'Circulation', label: 'Circulation' },
]

/**
 * Floating contextual toolbar shown next to the selected room (Laiout-style
 * direct manipulation). Positioned in `.stage`-relative px from the room's
 * on-screen box. All ops go through the `EditorCanvas` room methods, which
 * compose the wasm core bindings.
 */
export function RoomTools({ ec, zone, box }: { ec: EditorCanvas; zone: DocZone; box: RoomSelection['box'] }) {
  const isRect = zone.shape.kind === 'Rect'
  // Sit above the room; drop below if it would collide with the top ruler.
  const gap = 46
  const top = box.top - gap < 30 ? box.top + box.height + 10 : box.top - gap
  const left = Math.max(28, Math.min(box.left, window.innerWidth - 360))

  return (
    <div className="room-tools" style={{ left, top }} data-testid="room-tools" onMouseDown={(e) => e.stopPropagation()}>
      <label className="rt-assign">
        <span className="rt-assign-label">Assign to</span>
        <select
          className="rt-select"
          value={zone.zone_type}
          onChange={(e) => ec.setZoneTypeRoom(zone.id, e.target.value as ZoneType)}
          data-testid="room-type"
        >
          {ROOM_TYPES.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>
      </label>
      <span className="rt-sep" />
      {isRect && (
        <>
          <button className="rt-btn" title="Split in half" onClick={() => ec.splitRoom(zone.id)} data-testid="room-split">
            <Icon name="mirror" size={16} />
          </button>
          <button
            className="rt-btn"
            title="Duplicate room"
            onClick={() => ec.duplicateRoom(zone.id)}
            data-testid="room-duplicate"
          >
            <Icon name="copy" size={16} />
          </button>
          <button
            className="rt-btn"
            title="Rotate 90° clockwise"
            onClick={() => ec.rotateRoom(zone.id)}
            data-testid="room-rotate"
          >
            <Icon name="rotate" size={16} />
          </button>
        </>
      )}
      <button
        className="rt-btn rt-danger"
        title="Delete room"
        onClick={() => ec.deleteRoom(zone.id)}
        data-testid="room-delete"
      >
        <TrashGlyph />
      </button>
    </div>
  )
}

// Small trash glyph (no trash icon exists in the shared icon set).
function TrashGlyph() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 7h16M9 7V5a1 1 0 011-1h4a1 1 0 011 1v2m2 0v12a1 1 0 01-1 1H7a1 1 0 01-1-1V7" />
      <path d="M10 11v5M14 11v5" />
    </svg>
  )
}
