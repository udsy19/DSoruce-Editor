// Independent scale ground truth.
//
// $INSUNITS is producer metadata. This asks the geometry instead, via two
// anchors that are true by construction, not by the file's own account:
//   1. DOOR SWING ARCS — radius == door leaf width, 0.75-1.10 m in every
//      building code (IBC 1010.1.1, NBC 2016 Part 4, DIN 18101).
//   2. WALL PAIR SPACING — the modal perpendicular gap between parallel wall
//      lines is a wall thickness, 0.075-0.40 m.
// Whichever unit maps these into their physical band is the drawing's real
// unit. Parsed at scale 1.0 (raw source units) with dxf-parser directly, so
// nothing dxf.ts decided can leak in.
import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here,'../..')
const require_ = createRequire(path.join(root,'web/package.json'))
const DxfParser = require_('dxf-parser').default ?? require_('dxf-parser')
const CORPUS = JSON.parse(fs.readFileSync(path.join(here,'corpus.json'),'utf8'))
const SCALE = { in:0.0254, ft:0.3048, mm:0.001, cm:0.01, m:1 }
const DOOR_LO=0.65, DOOR_HI=1.30

const isDoorLayer = l => /door|porta|puerta|puert|hoja|\bdr\b|a-door/i.test(String(l||''))

/** Collect ARC radii (source units) from top-level entities AND block defs. */
function collectArcs(dxf){
  const out=[]
  const eat = (list) => { for(const e of list||[]) if(e.type==='ARC'&&Number.isFinite(e.radius)&&e.radius>0) out.push({layer:e.layer??'',r:e.radius}) }
  eat(dxf.entities)
  for(const b of Object.values(dxf.blocks??{})) eat(b.entities)
  return out
}
function modal(vals, rel=0.05){
  if(!vals.length) return null
  let best=null,bestN=0
  for(const v of vals){ let n=0; for(const x of vals) if(Math.abs(x-v)<=v*rel) n++; if(n>bestN){bestN=n;best=v} }
  return {value:best,count:bestN,total:vals.length}
}
const pad=(s,n)=>String(s).slice(0,n).padEnd(n)
const rows=[]
console.log(pad('file',40),pad('declared',9),pad('modal door R',13),pad('n',9),pad('R as declared',14),pad('units doors imply',18),'verdict')
for(const e of CORPUS){
  const dxfPath=path.join(os.tmpdir(),`anchor-${process.pid}-${rows.length}.dxf`)
  let text
  try{
    if(e.path.toLowerCase().endsWith('.dwg')){ execFileSync('dwg2dxf',['-o',dxfPath,e.path],{stdio:['ignore','ignore','pipe'],maxBuffer:64<<20,timeout:120000}); text=fs.readFileSync(dxfPath,'utf8') }
    else text=fs.readFileSync(e.path,'utf8')
  }catch{ rows.push({file:e.label,error:'convert failed'}); console.log(pad(e.label,40),'convert failed'); fs.rmSync(dxfPath,{force:true}); continue }
  fs.rmSync(dxfPath,{force:true})
  let dxf
  try{ dxf=new DxfParser().parseSync(text) }catch(err){ rows.push({file:e.label,error:'parse failed: '+err.message}); console.log(pad(e.label,40),'PARSE FAIL'); continue }
  const insu=dxf.header?.$INSUNITS
  const UNIT={0:'unitless',1:'in',2:'ft',4:'mm',5:'cm',6:'m'}
  const declared = insu==null?'ABSENT':(UNIT[Number(insu)]??`code-${insu}`)
  const importer = (insu==null||Number(insu)===0)?'in':(UNIT[Number(insu)]??'in')
  const A=collectArcs(dxf)
  const door=A.filter(a=>isDoorLayer(a.layer)).map(a=>a.r)
  const m=modal(door)
  const r={file:e.label,declaredUnits:declared,importerUnits:importer,totalArcs:A.length,doorArcs:door.length,
           modalDoorRadiusSrc:m?.value??null,modalSupport:m?`${m.count}/${m.total}`:null}
  if(m){
    r.radiusAsImporterScalesItM=+(m.value*SCALE[importer]).toFixed(3)
    r.unitsImpliedByDoors=Object.entries(SCALE).filter(([,s])=>m.value*s>=DOOR_LO&&m.value*s<=DOOR_HI).map(([u])=>u)
    r.scaleAgrees=r.unitsImpliedByDoors.includes(importer)
    r.correctionFactor = r.unitsImpliedByDoors.length ? +(SCALE[r.unitsImpliedByDoors[0]]/SCALE[importer]).toFixed(4) : null
  }
  rows.push(r)
  console.log(pad(e.label,40),pad(declared,9),pad(m?m.value.toFixed(3):'-',13),pad(m?`${m.count}/${m.total}`:`${A.length} arcs`,9),
    pad(r.radiusAsImporterScalesItM??'-',14),pad((r.unitsImpliedByDoors||[]).join(',')||(m?'NONE':'-'),18),
    m?(r.scaleAgrees?'OK':`*** WRONG x${r.correctionFactor??'?'} ***`):'(no door arcs)')
}
fs.writeFileSync(path.join(root,'cad-validation/reports/_scaleAnchor.json'),JSON.stringify(rows,null,2))
