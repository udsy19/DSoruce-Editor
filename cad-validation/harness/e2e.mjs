// End-to-end: imported plate -> Rust core -> generate() -> circulation score.
// Mirrors App.tsx testFitPlan(): push plate walls, keep-outs, entries, then
// run the autonomous generator, then score. Uses the real wasm build.
import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
const here=path.dirname(fileURLToPath(import.meta.url)); const root=path.resolve(here,'../..')
const webRequire=createRequire(path.join(root,'web/package.json'))
const esbuildPath=createRequire(webRequire.resolve('vite')).resolve('esbuild')
const { build }=await import(pathToFileURL(esbuildPath).href)
const bundle=async(entry)=>{const o=path.join(os.tmpdir(),`e2e-${path.basename(entry,'.ts')}-${process.pid}.mjs`)
  await build({entryPoints:[path.join(root,'web/src/import',entry)],outfile:o,bundle:true,format:'esm',platform:'node',logLevel:'silent'})
  const m=await import(pathToFileURL(o).href); fs.rmSync(o,{force:true}); return m}
const { parseDrawing }=await bundle('dxf.ts')
const { healWalls }=await bundle('heal.ts')
const { derivePlate }=await bundle('plate.ts')
const tf=await bundle('testfit.ts')
const { loadConverter }=await import(pathToFileURL(path.join(here,'convert.mjs')).href)
const convert=await loadConverter(root)

const wasm=await import(pathToFileURL(path.join(root,'web/src/wasm/ds_core.js')).href)
if (typeof wasm.default === 'function') {
  await wasm.default({ module_or_path: fs.readFileSync(path.join(root,'web/src/wasm/ds_core_bg.wasm')) })
}
const { Editor }=wasm
// DEFAULT_PROGRAM from web/src/types/program.ts — the exact object the
// generate card and the AI both send.
const PROGRAM = { desks:20, meeting_rooms:2, desk_w:1.6, desk_h:0.8, meeting_w:3, meeting_h:3,
  cluster_cols:4, target_corridor_m:1.2, desk_clearance_m:0.9, bench_pairs:true, support_spaces:true,
  rooms:[], w_capacity:0.35, w_adjacency:0.2, w_circulation:0.25, w_density:0.2, w_program:0.1,
  w_daylight:0.05, w_entry:0.05 }

const CORPUS=JSON.parse(fs.readFileSync(path.join(here,'corpus.json'),'utf8'))
const pad=(s,n)=>String(s).slice(0,n).padEnd(n)
const rows=[]
console.log(pad('file',40),pad('plate m2',9),pad('walls',6),pad('keepout',8),pad('entry',6),pad('generate',30),'circulation')
for(const e of CORPUS){
  const r={file:e.label}
  const conv=convert(e.path)
  if(conv.error){ r.stage='convert'; r.error=conv.error; rows.push(r); console.log(pad(e.label,40),'CONVERT FAILED: '+conv.error.slice(0,60)); continue }
  const text=conv.dxf; r.via=conv.via
  let d; try{ d=parseDrawing(text) }catch(err){ r.stage='parse'; r.error=err.message; rows.push(r); console.log(pad(e.label,40),'parse failed'); continue }
  let plate; try{ plate=derivePlate(d,null,true) }catch(err){ r.stage='plate'; r.error=err.message; rows.push(r); console.log(pad(e.label,40),'plate threw: '+err.message.slice(0,50)); continue }
  if(!plate){ r.stage='plate'; r.error='no plate'; rows.push(r); console.log(pad(e.label,40),'NO PLATE — user sees "No wall geometry found in this drawing"'); continue }
  const healed=healWalls(d)
  r.plateAreaM2=+plate.areaM2.toFixed(1)
  // push into the core exactly as pushPlateToEditor does (boundary ring as walls)
  const ed=new Editor()
  let walls=0
  const B=plate.boundary
  for(let i=0;i<B.length;i++){ const a=B[i],b=B[(i+1)%B.length]; try{ ed.add_wall(a[0],a[1],b[0],b[1],0.15); walls++ }catch{} }
  r.walls=walls
  let ko=[],en=[]
  try{ ko=tf.extractKeepouts(healed,plate) }catch(err){ r.keepoutError=err.message }
  try{ en=tf.extractEntries(healed,plate) }catch(err){ r.entryError=err.message }
  r.keepouts=ko.length; r.entries=en.length
  const t0=Date.now()
  try{
    const res=ed.generate(PROGRAM, 1n, false)
    r.generateMs=Date.now()-t0
    r.generated=typeof res==='object'&&res? Object.fromEntries(Object.entries(res).filter(([,v])=>typeof v!=='object'&&typeof v!=='function')) : res
    const st=ed.state?.()
    r.componentCount = st?.components?.length ?? null
    r.desksPlaced = st?.components?.filter(c=>/desk/i.test(c.kind??c.category??'')).length ?? null
    r.roomsPlaced = st?.rooms?.length ?? null
  }catch(err){ r.stage='generate'; r.error=String(err.message||err); r.generateMs=Date.now()-t0 }
  try{ const c=ed.circulation(); r.circulation={score:c?.score??null,minWidth:c?.min_corridor_width??c?.minWidth??null,connected:c?.connected??null} }
  catch(err){ r.circulationError=String(err.message||err).slice(0,120) }
  try{ const s=ed.layout_score(PROGRAM); r.layoutScore = s?.total ?? s?.score ?? (typeof s==='number'?s:null); r.layoutRaw=s }catch(err){ r.layoutScoreError=String(err.message||err).slice(0,120) }
  ed.free?.()
  rows.push(r)
  console.log(pad(e.label,40),pad(r.plateAreaM2,9),pad(walls,6),pad(r.keepouts,8),pad(r.entries,6),
    pad(r.error?('ERR '+String(r.error).slice(0,25)):JSON.stringify(r.generated).slice(0,29),30),
    r.circulationError?('ERR '+r.circulationError.slice(0,40)):JSON.stringify(r.circulation))
}
fs.writeFileSync(path.join(root,'cad-validation/reports/_e2e.json'),JSON.stringify(rows,null,2))
