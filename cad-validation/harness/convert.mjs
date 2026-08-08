// DWG -> DXF text, mirroring exactly what /api/dwg now does:
// dwg2dxf, verify the BYTES, and on failure fall back to `dwgread -O JSON`
// re-emitted as DXF. Uses the production dwgVerify.ts / dwgJson.ts modules, so
// the harness cannot drift from the endpoint it is measuring.
import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

export async function loadConverter(root) {
  const webRequire = createRequire(path.join(root, 'web/package.json'))
  const esbuildPath = createRequire(webRequire.resolve('vite')).resolve('esbuild')
  const { build } = await import(pathToFileURL(esbuildPath).href)
  const bundle = async (f) => {
    const o = path.join(os.tmpdir(), `cv-${path.basename(f, '.ts')}-${process.pid}.mjs`)
    await build({ entryPoints: [path.join(root, 'web/src/import', f)], outfile: o, bundle: true,
      format: 'esm', platform: 'node', logLevel: 'silent', nodePaths: [path.join(root, 'web/node_modules')] })
    const m = await import(pathToFileURL(o).href); fs.rmSync(o, { force: true }); return m
  }
  const { verifyDxf } = await bundle('dwgVerify.ts')
  const { dwgJsonToDxf } = await bundle('dwgJson.ts')

  /** @returns {{dxf:string, via:'dwg2dxf'|'dwgread-json'} | {error:string}} */
  return function convert(src) {
    if (!src.toLowerCase().endsWith('.dwg')) return { dxf: fs.readFileSync(src, 'utf8'), via: 'dxf' }
    const stamp = `${process.pid}-${Math.random().toString(36).slice(2)}`
    const dxfPath = path.join(os.tmpdir(), `cv-${stamp}.dxf`)
    const jsonPath = path.join(os.tmpdir(), `cv-${stamp}.json`)
    let primary = null
    try {
      execFileSync('dwg2dxf', ['-o', dxfPath, src], { stdio: ['ignore','ignore','pipe'], maxBuffer: 128<<20, timeout: 180000 })
      const text = fs.readFileSync(dxfPath, 'utf8')
      const v = verifyDxf(text)
      if (v.ok) { fs.rmSync(dxfPath,{force:true}); return { dxf: text, via: 'dwg2dxf' } }
      primary = v.message
    } catch (e) { primary = String(e.message || e).slice(0, 120) }
    finally { fs.rmSync(dxfPath, { force: true }) }
    try {
      execFileSync('dwgread', ['-O','JSON','-o',jsonPath, src], { stdio:['ignore','ignore','pipe'], maxBuffer: 512<<20, timeout: 300000 })
      const dxf = dwgJsonToDxf(JSON.parse(fs.readFileSync(jsonPath, 'utf8')))
      const v = verifyDxf(dxf)
      if (v.ok) return { dxf, via: 'dwgread-json' }
      return { error: `primary: ${primary}; fallback: ${v.message}` }
    } catch (e) {
      return { error: `primary: ${primary}; fallback: ${String(e.message || e).slice(0,120)}` }
    } finally { fs.rmSync(jsonPath, { force: true }) }
  }
}
