// Renders a plate with a DELIBERATELY WIDE corridor through renderPrintCanvas
// and reports whether the sheet carries the word CORRIDOR.
import path from 'node:path'; import os from 'node:os'; import fs from 'node:fs'
import { createRequire } from 'node:module'; import { fileURLToPath, pathToFileURL } from 'node:url'
const here = process.argv[2]
const webRequire = createRequire(path.join(here, 'package.json'))
const esbuildPath = createRequire(webRequire.resolve('vite')).resolve('esbuild')
const { build } = await import(pathToFileURL(esbuildPath).href)
const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'b4-')), 'pp.mjs')
await build({ entryPoints: [path.join(here, 'src/export/printPlan.ts')], outfile: out,
  bundle: true, format: 'esm', platform: 'neutral', target: 'es2022', logLevel: 'silent' })
const P = await import(pathToFileURL(out).href)
const texts = []
const ctx = new Proxy({ canvas: { width: 1400, height: 1000 }, setLineDash(){}, measureText:(t)=>({width:String(t).length*7}) }, {
  get(t, k) { if (k in t) return t[k]
    if (k === 'fillText' || k === 'strokeText') return (s) => texts.push(String(s))
    return () => undefined },
  set() { return true } })
globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => ctx }) }
const wide = { kind: 'Rect', x: 12, y: 6, w: 14, h: 4 }   // 14 m x 4 m corridor: clears any gate
const state = { walls: [{ id:1, a:{x:0,y:0}, b:{x:24,y:0}, thickness:0.2 },
                        { id:2, a:{x:24,y:0}, b:{x:24,y:12}, thickness:0.2 },
                        { id:3, a:{x:24,y:12}, b:{x:0,y:12}, thickness:0.2 },
                        { id:4, a:{x:0,y:12}, b:{x:0,y:0}, thickness:0.2 }],
  components: [], zones: [
    { id: 1, zone_type: 'Circulation', label: 'Corridor', shape: wide, component_ids: [], origin: 'Drawn' },
    { id: 2, zone_type: 'Meeting', label: 'Boardroom',
      shape: { kind: 'Rect', x: 6, y: 10, w: 8, h: 3 }, component_ids: [], origin: 'Drawn' } ] }
P.renderPrintCanvas(state, 1400, 1000)
console.log(JSON.stringify({ printed: texts, corridorOnSheet: texts.some(t => /CORRIDOR/i.test(t)) }))
