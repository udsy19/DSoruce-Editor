// MOCK material bank.
// -------------------------------------------------------------------------
// The real, searchable material bank lives in a separate repo and will be wired
// in later (see research/08-open-questions.md, Q5). This mock exists only so the
// "re-imagine" side panel is fully interactive now. Keep the shape close to what
// we expect the real API to return (id, name, vendor, price, a visual swatch) so
// swapping the data source is a one-file change.

export interface Product {
  id: string
  name: string
  vendor: string
  price: number
  swatch: string // stand-in for a real thumbnail/3D asset
}

const BANK: Record<string, Product[]> = {
  Desk: [
    { id: 'desk-oak-ss', name: 'Oak Sit-Stand Desk', vendor: 'Herman Miller', price: 920, swatch: '#b5834f' },
    { id: 'desk-white-140', name: 'White Bench Desk 140', vendor: 'Vitra', price: 640, swatch: '#e8e8ea' },
    { id: 'desk-walnut', name: 'Walnut Executive Desk', vendor: 'Steelcase', price: 1480, swatch: '#5a3b28' },
  ],
  Chair: [
    { id: 'chair-aeron', name: 'Aeron Task Chair', vendor: 'Herman Miller', price: 1150, swatch: '#2b2b30' },
    { id: 'chair-mesh', name: 'Mesh Ergo Chair', vendor: 'Steelcase', price: 480, swatch: '#3f6f8f' },
    { id: 'chair-felt', name: 'Felt Stackable Chair', vendor: 'Muuto', price: 210, swatch: '#9aa0ab' },
  ],
  Table: [
    { id: 'table-round-16', name: 'Round Meeting Table 1.6m', vendor: 'Vitra', price: 890, swatch: '#c9a06a' },
    { id: 'table-marble', name: 'Marble Cafe Table', vendor: 'Muuto', price: 720, swatch: '#dfe1e6' },
  ],
  MeetingRoom: [
    { id: 'mr-glass', name: 'Glass Partition Pod', vendor: 'Framery', price: 8600, swatch: '#bfe3ea' },
    { id: 'mr-acoustic', name: 'Acoustic Meeting Pod (6p)', vendor: 'Room', price: 12400, swatch: '#6b7280' },
  ],
  FallCeiling: [
    { id: 'fc-acoustic', name: 'Acoustic Baffle Ceiling', vendor: 'Armstrong', price: 54, swatch: '#cbd5e1' },
    { id: 'fc-wood', name: 'Wood Slat Ceiling', vendor: 'Hunter Douglas', price: 96, swatch: '#8a5a34' },
  ],
}

export function searchBank(category: string, q: string): Product[] {
  const items = BANK[category] ?? []
  const query = q.trim().toLowerCase()
  if (!query) return items
  return items.filter(
    (p) =>
      p.name.toLowerCase().includes(query) || p.vendor.toLowerCase().includes(query),
  )
}
