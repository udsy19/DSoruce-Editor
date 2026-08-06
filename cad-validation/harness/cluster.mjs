// How much geometry does keepDominantCluster() discard? Uses an instrumented
// COPY of dxf.ts (harness/probe/dxfProbe.ts) — the shipped file is untouched.
import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../..')
const webRequire = createRequire(path.join(root, 'web/package.json'))
const esbuildPath = createRequire(webRequire.resolve('vite')).resolve('esbuild')
const { build } = await import(pathToFileURL(esbuildPath).href)
const out = path.join(os.tmpdir(), `probe-${process.pid}.mjs`)
await build({ entryPoints: [path.join(here, 'probe/dxfProbe.ts')], outfile: out, bundle: true, format: 'esm', platform: 'node', logLevel: 'silent', nodePaths: [path.join(root,'web/node_modules')] })
const { parseDrawing } = await import(pathToFileURL(out).href)
const { loadConverter } = await import(pathToFileURL(path.join(here, 'convert.mjs')).href)
const convert = await loadConverter(root)
const CORPUS = JSON.parse(fs.readFileSync(path.join(here, 'corpus.json'), 'utf8'))
const rows = []
const pad=(s,n)=>String(s).slice(0,n).padEnd(n)
console.log(pad('file',40),pad('pre-cluster span (m)',24),pad('post span (m)',20),pad('ents pre>post',16),'dropped')
for (const e of CORPUS) {
  const dxfPath = path.join(os.tmpdir(), `probe-${process.pid}-${rows.length}.dxf`)
  const conv = convert(e.path)
  if (conv.error) { rows.push({file:e.label,error:'convert'}); console.log(pad(e.label,40),'convert failed'); continue }
  const text = conv.dxf
  let d
  try { d = parseDrawing(text) } catch (err) { rows.push({file:e.label,error:'parse: '+err.message}); console.log(pad(e.label,40),'PARSE FAIL: '+String(err.message).slice(0,60)); continue }
  const p = globalThis.__probe
  const span = b => Number.isFinite(b[0]) ? [ +(b[2]-b[0]).toFixed(1), +(b[3]-b[1]).toFixed(1) ] : null
  const pre = span(p.preBounds), post = span(d.bounds)
  const droppedE = p.preCount.entities - p.postCount.entities
  const droppedF = p.preCount.furniture - p.postCount.furniture
  const r = { file:e.label, units:d.units, preSpanM:pre, postSpanM:post, preCount:p.preCount, postCount:p.postCount, droppedEntities:droppedE, droppedFurniture:droppedF,
    shrinkFactor: pre&&post&&post[0]>0 ? +(Math.max(...pre)/Math.max(...post)).toFixed(1) : null }
  rows.push(r)
  console.log(pad(e.label,40), pad(pre?`${pre[0]} x ${pre[1]}`:'-',24), pad(post?`${post[0]} x ${post[1]}`:'-',20),
    pad(`${p.preCount.entities}>${p.postCount.entities}`,16), `${droppedE}e ${droppedF}f  shrink x${r.shrinkFactor??'-'}`)
}
fs.writeFileSync(path.join(root,'cad-validation/reports/_cluster.json'), JSON.stringify(rows,null,2))
