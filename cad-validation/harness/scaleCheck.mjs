// Acceptance measure for the import: is the drawing PHYSICAL at the scale we chose?
//
// "The generator placed desks" is not evidence of a correct import — an
// over-scaled plate places desks happily. This asks the question the artifact
// can answer on its own: in the final metres-space Drawing, what fraction of
// the door swings are legal doors, and what fraction of the wall pairs are
// legal wall assemblies?
//
// Bands are external specifications (IBC 1010.1.1 / NBC 2016 Part 4 / DIN
// 18101 for leaves; wall-assembly thicknesses), not values measured from this
// corpus — per .claude/rules/gate-independence.md, never calibrate against the
// population under test.
import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os'
import { createRequire } from 'node:module'; import { fileURLToPath, pathToFileURL } from 'node:url'
const here=path.dirname(fileURLToPath(import.meta.url)); const root=path.resolve(here,'../..')
const { loadConverter }=await import(pathToFileURL(path.join(here,'convert.mjs')).href)
const convert=await loadConverter(root)
const webRequire=createRequire(path.join(root,'web/package.json'))
const { build }=await import(pathToFileURL(createRequire(webRequire.resolve('vite')).resolve('esbuild')).href)
const b=async f=>{const o=path.join(os.tmpdir(),`sc-${path.basename(f,'.ts')}-${process.pid}.mjs`)
  await build({entryPoints:[path.join(root,'web/src/import',f)],outfile:o,bundle:true,format:'esm',platform:'node',logLevel:'silent'})
  const m=await import(pathToFileURL(o).href); fs.rmSync(o,{force:true}); return m}
const { parseDrawing }=await b('dxf.ts'); const { derivePlate }=await b('plate.ts')

const DOOR=[0.65,1.30], WALL=[0.05,0.60]
const fit=(a,c,d)=>{const D=2*(a[0]*(c[1]-d[1])+c[0]*(d[1]-a[1])+d[0]*(a[1]-c[1]));if(Math.abs(D)<1e-12)return null
 const a2=a[0]**2+a[1]**2,c2=c[0]**2+c[1]**2,d2=d[0]**2+d[1]**2
 const ux=(a2*(c[1]-d[1])+c2*(d[1]-a[1])+d2*(a[1]-c[1]))/D, uy=(a2*(d[0]-c[0])+c2*(a[0]-d[0])+d2*(c[0]-a[0]))/D
 return {cx:ux,cy:uy,r:Math.hypot(a[0]-ux,a[1]-uy)}}
const doorRadii=(d)=>{const out=[]
 for(const e of [...d.entities,...d.furniture.flatMap(x=>x.entities)]){
  if(e.category!=='door'||!e.pts||e.closed||e.pts.length<5)continue
  const g=fit(e.pts[0],e.pts[e.pts.length>>1],e.pts[e.pts.length-1]); if(!g)continue
  let ok=true; for(const [x,y] of e.pts) if(Math.abs(Math.hypot(x-g.cx,y-g.cy)-g.r)>g.r*0.02){ok=false;break}
  if(ok) out.push(g.r)} return out}
const wallGaps=(d)=>{const segs=[]
 for(const e of d.entities){ if(e.category!=='wall'||!e.pts)continue
  for(let i=0;i+1<e.pts.length;i++) segs.push([...e.pts[i],...e.pts[i+1]])}
 const L=segs.map(s=>({s,l:Math.hypot(s[2]-s[0],s[3]-s[1])})).filter(x=>x.l>0).sort((a,c)=>c.l-a.l).slice(0,300)
 const g=[]
 for(let i=0;i<L.length;i++){const[ax,ay,bx,by]=L[i].s,al=L[i].l,ux=(bx-ax)/al,uy=(by-ay)/al
  for(let j=i+1;j<L.length;j++){const[cx,cy,dx,dy]=L[j].s,bl=L[j].l,vx=(dx-cx)/bl,vy=(dy-cy)/bl
   if(Math.abs(ux*vy-uy*vx)>0.035)continue
   const gap=Math.abs((cx-ax)*-uy+(cy-ay)*ux); if(gap<=0||gap>al*0.5)continue
   const t0=(cx-ax)*ux+(cy-ay)*uy,t1=(dx-ax)*ux+(dy-ay)*uy
   if(Math.max(t0,t1)<al*0.25||Math.min(t0,t1)>al*0.75)continue
   g.push(gap)}}
 return g}
const frac=(v,[lo,hi])=>v.length?v.filter(x=>x>=lo&&x<=hi).length/v.length:null
const pad=(s,n)=>String(s).slice(0,n).padEnd(n)
const CORPUS=JSON.parse(fs.readFileSync(path.join(here,'corpus.json'),'utf8'))
const rows=[]
console.log(pad('file',34),pad('units/source',20),pad('span m',15),pad('doors ok',12),pad('walls ok',12),pad('plate m2',9),'verdict')
for(const e of CORPUS){
  const c=convert(e.path); if(c.error){console.log(pad(e.label,34),'CONVERT FAILED');rows.push({file:e.label,error:'convert'});continue}
  let d; try{ d=parseDrawing(c.dxf) }catch(err){ console.log(pad(e.label,34),'PARSE FAILED'); rows.push({file:e.label,error:'parse'}); continue }
  const plate=derivePlate(d,null,true)
  const dr=doorRadii(d), wg=wallGaps(d)
  const df=frac(dr,DOOR), wf=frac(wg,WALL)
  const span=[d.bounds[2]-d.bounds[0],d.bounds[3]-d.bounds[1]]
  // Physical if either anchor is majority-satisfied. Neither present -> unknown.
  const verdict = df==null&&wf==null ? 'NO EVIDENCE'
    : (df!=null&&df>=0.5)||(wf!=null&&wf>=0.5) ? 'PHYSICAL'
    : 'NOT PHYSICAL'
  rows.push({file:e.label,units:d.units,unitsSource:d.unitsSource,spanM:span,doorSamples:dr.length,doorFrac:df,wallSamples:wg.length,wallFrac:wf,plateM2:plate?.areaM2??null,verdict})
  console.log(pad(e.label,34),pad(`${d.units}/${d.unitsSource}`,20),pad(`${span[0].toFixed(1)}x${span[1].toFixed(1)}`,15),
    pad(df==null?'—':`${(df*100).toFixed(0)}% of ${dr.length}`,12),
    pad(wf==null?'—':`${(wf*100).toFixed(0)}% of ${wg.length}`,12),
    pad(plate?plate.areaM2.toFixed(0):'NONE',9), verdict)
}
fs.writeFileSync(path.join(root,'cad-validation/reports/_scaleCheck.json'),JSON.stringify(rows,null,2))
const n=rows.filter(r=>r.verdict==='PHYSICAL').length
console.log(`\nPHYSICAL: ${n}/${rows.length}   NOT PHYSICAL: ${rows.filter(r=>r.verdict==='NOT PHYSICAL').length}   NO EVIDENCE: ${rows.filter(r=>r.verdict==='NO EVIDENCE').length}   FAILED: ${rows.filter(r=>r.error).length}`)
