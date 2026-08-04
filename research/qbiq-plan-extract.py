import fitz, json, collections, sys
PDF = sys.argv[1]
doc = fitz.open(PDF)

def hexof(c):
    if c is None: return None
    r,g,b = [max(0,min(1,v)) for v in c[:3]]
    return '#%02x%02x%02x' % (round(r*255), round(g*255), round(b*255))

for pno in (2,3,4):
    page = doc[pno]
    dr = page.get_drawings()
    # The plan occupies the right ~2/3; the left panel is the stats card.
    W = page.rect.width
    plan_x0 = W * 0.30
    strokes = collections.Counter()   # (hex,width) -> count
    fills = collections.Counter()     # hex -> total area
    widths = collections.Counter()
    for d in dr:
        r = d['rect']
        if r.x1 < plan_x0:   # skip the stats panel
            continue
        if d.get('color') is not None and d.get('width'):
            strokes[(hexof(d['color']), round(d['width'],4))] += 1
            widths[round(d['width'],4)] += 1
        if d.get('fill') is not None:
            fills[hexof(d['fill'])] += max(r.width*r.height, 0)
    print(f'--- page {pno+1} ---  drawings in plan area: '
          f'{sum(1 for d in dr if d["rect"].x1 >= plan_x0)}')
    print('  stroke widths (pt) by frequency:')
    for w,c in widths.most_common(10):
        print(f'    {w:>8} pt   x{c}')
    print('  stroke colors x width (top 12):')
    for (h,w),c in strokes.most_common(12):
        print(f'    {h}  {w:>7} pt  x{c}')
    print('  fill colors by total area (top 14):')
    for h,a in fills.most_common(14):
        print(f'    {h}   area {a:>12.0f} pt^2')
    print()
