import fitz, sys, colorsys, collections
PDF=sys.argv[1]; doc=fitz.open(PDF); page=doc[2]
W=page.rect.width; plan_x0=W*0.30

# ---- text inventory inside the plan area (the label grammar) ---------------
print("=== TEXT inside the plan area ===")
td = page.get_text("dict")
items=[]
for b in td["blocks"]:
    for l in b.get("lines",[]):
        for s in l["spans"]:
            x0,y0,x1,y1 = s["bbox"]
            if x0 < plan_x0: continue
            items.append((s["text"].strip(), round(s["size"],2), s["font"], round(x0), round(y0)))
items=[i for i in items if i[0]]
print(f"  spans in plan area: {len(items)}")
sizes=collections.Counter(i[1] for i in items)
fonts=collections.Counter(i[2] for i in items)
print(f"  sizes: {dict(sizes)}")
print(f"  fonts: {dict(fonts)}")
print("  all label texts:")
for t,sz,f,x,y in sorted(items,key=lambda a:a[4]):
    print(f"    {t!r:28} {sz}pt  {f}")

# ---- wall treatment: what fills sit under the heaviest strokes -------------
print("\n=== WALL TREATMENT ===")
dr=page.get_drawings()
heavy=[d for d in dr if d.get('width') and round(d['width'],4)==1.0234 and d['rect'].x1>=plan_x0]
print(f"  heaviest-stroke items (1.0234pt): {len(heavy)}")
for d in heavy[:4]:
    print(f"    color={d['color']} fill={d['fill']} closed={d.get('closePath')} rect={[round(v) for v in d['rect']]}")
# fills that are white and stroked black at the mid weight => double-line walls
mid=[d for d in dr if d.get('width') and round(d['width'],4)==0.2903 and d['rect'].x1>=plan_x0]
wf=collections.Counter()
for d in mid:
    wf[str(d.get('fill'))]+=1
print(f"  mid-weight (0.2903pt) items: {len(mid)}; their fills: {dict(list(wf.items())[:6])}")

# ---- scale bar: derive drawing scale ---------------------------------------
print("\n=== SCALE ===")
sb=[i for i in items if i[0] in ('0','10','20','30')]
if len(sb)>=2:
    xs={i[0]:i[3] for i in sb}
    print(f"  scale-bar tick x-positions (pt): {xs}")
    if '0' in xs and '30' in xs:
        span=xs['30']-xs['0']
        print(f"  0->30 spans {span} pt  =>  1 unit = {span/30:.3f} pt")

# ---- zone palette in HSL (for the keep-our-hues decision) ------------------
print("\n=== ZONE PALETTE (measured) -> HSL ===")
ZONES={'#9ec5fc':'Open Space','#d0fce4':'Conf Room','#ffe7a7':'Amenities',
 '#fdf0cd':'Comfort Zone','#d8e9fc':'Office','#fcddba':'Pantry',
 '#efd8ff':'Reception','#c5b898':'IT Room','#cbf1fe':'Executive'}
Ss=[];Ls=[]
for hexv,name in ZONES.items():
    r,g,b=[int(hexv[i:i+2],16)/255 for i in (1,3,5)]
    h,l,s=colorsys.rgb_to_hls(r,g,b)
    Ss.append(s);Ls.append(l)
    print(f"  {hexv}  {name:14} H={h*360:6.1f}  S={s*100:5.1f}%  L={l*100:5.1f}%")
print(f"\n  MEAN S = {sum(Ss)/len(Ss)*100:.1f}%   MEAN L = {sum(Ls)/len(Ls)*100:.1f}%")
print(f"  S range {min(Ss)*100:.1f}-{max(Ss)*100:.1f}%   L range {min(Ls)*100:.1f}-{max(Ls)*100:.1f}%")
