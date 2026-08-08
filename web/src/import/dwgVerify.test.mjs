// Node test for the DWG→DXF conversion integrity check (dwgVerify.ts).
// Run from web/:  node src/import/dwgVerify.test.mjs
//
// `dwg2dxf` decides success by exit code, and the exit code lies: on
// Apartment-1.dwg it errors, writes a file that stops partway through the
// BLOCKS section, and exits 0. /api/dwg returned HTTP 200 with it.
//
// The gate must therefore re-derive "did the conversion finish?" from the DXF
// BYTES, never from the converter's own status. So this test never consults an
// exit code — it feeds byte patterns directly and asserts the verdict, and
// where the real converter is installed it proves the check fires on the actual
// file that motivated it and stays inert on the ones that convert cleanly.

// @covers: web/src/import/dwgVerify.ts

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const webRequire = createRequire(path.join(here, '../../package.json'))
const esbuildPath = createRequire(webRequire.resolve('vite')).resolve('esbuild')
const { build } = await import(pathToFileURL(esbuildPath).href)

const outFile = path.join(os.tmpdir(), `ds-dwgverify-${Date.now()}.mjs`)
await build({
  entryPoints: [path.join(here, 'dwgVerify.ts')],
  outfile: outFile,
  bundle: true,
  format: 'esm',
  platform: 'node',
  logLevel: 'silent',
})
const { verifyDxf, describeExit, trimStderr } = await import(pathToFileURL(outFile).href)
fs.rmSync(outFile, { force: true })

let failed = 0
let checks = 0
const ok = (cond, label) => {
  checks++
  if (!cond) {
    failed++
    console.log(`FAIL: ${label}`)
  }
}

const CRLF = (parts) => parts.join('\r\n')

// --- A complete DXF passes -------------------------------------------------
const complete = CRLF([
  '0', 'SECTION', '2', 'HEADER', '0', 'ENDSEC',
  '0', 'SECTION', '2', 'ENTITIES',
  '0', 'LINE', '8', 'WALL', '10', '0', '20', '0', '11', '1', '21', '0',
  '0', 'ENDSEC', '0', 'EOF',
])
ok(verifyDxf(complete).ok, 'a complete DXF passes')
ok(verifyDxf(complete).defect === null, 'a complete DXF names no defect')

// --- The real failure: truncated before ENTITIES ---------------------------
const truncatedAtBlocks = CRLF([
  '0', 'SECTION', '2', 'HEADER', '0', 'ENDSEC',
  '0', 'SECTION', '2', 'BLOCKS',
  '0', 'BLOCK', '2', 'A$C72CD3181', '0', 'ENDBLK',
  '0', 'ENDSEC',
])
{
  const v = verifyDxf(truncatedAtBlocks)
  ok(!v.ok, 'a DXF truncated in BLOCKS is rejected')
  ok(v.defect === 'no-entities-section', `defect is no-entities-section (got ${v.defect})`)
}

// --- Has entities, but the writer died before EOF --------------------------
{
  const v = verifyDxf(CRLF([
    '0', 'SECTION', '2', 'ENTITIES',
    '0', 'LINE', '8', 'WALL', '10', '0', '20', '0', '11', '1', '21', '0',
  ]))
  ok(!v.ok, 'a DXF with no EOF marker is rejected')
  ok(v.defect === 'no-eof-marker', `defect is no-eof-marker (got ${v.defect})`)
}

// --- Degenerate inputs -----------------------------------------------------
ok(verifyDxf('').defect === 'empty', 'empty string is rejected as empty')
ok(verifyDxf('   \n  \n').defect === 'empty', 'whitespace-only is rejected as empty')

// --- LF line endings must behave identically to CRLF -----------------------
ok(verifyDxf(complete.replace(/\r\n/g, '\n')).ok, 'LF line endings pass identically')

// --- describeExit: a crash must read as a crash, never "exited null" -------
{
  const crash = describeExit('dwg2dxf', null, 'SIGSEGV')
  ok(/crashed/.test(crash), 'a signalled child is described as a crash')
  ok(/SIGSEGV/.test(crash), 'the signal is named')
  ok(!/null/.test(crash), 'a crash is never reported as "exited null"')
  ok(/exit code 1/.test(describeExit('dwg2dxf', 1, null)), 'a plain non-zero exit reports its code')
}

// --- trimStderr bounds the payload -----------------------------------------
{
  const huge = 'Warning: Unstable Class object 505 MATERIAL (0x481) 37/0\n'.repeat(500)
  ok(trimStderr(huge).length <= 401, 'stderr is bounded (was 3 KB on the wire, 98 KB in the DOM)')
  ok(trimStderr('short').length === 5, 'short stderr passes through unchanged')
}

// --- Against the real converter, on the real files -------------------------
// Skipped when LibreDWG is absent; the byte-pattern assertions above stand
// alone. Where present, this is the falsification: the file that shipped a
// 200 OK must now be caught, and the files that convert cleanly must not be.
const CORPUS = path.resolve(here, '../../../cad-validation/raw')
let haveConverter = true
try {
  execFileSync('dwg2dxf', ['--version'], { stdio: 'ignore' })
} catch {
  haveConverter = false
}

if (haveConverter && fs.existsSync(CORPUS)) {
  const convert = (dwg) => {
    const out = path.join(os.tmpdir(), `ds-verify-${Date.now()}-${Math.random().toString(36).slice(2)}.dxf`)
    let signalled = false
    try {
      execFileSync('dwg2dxf', ['-o', out, dwg], { stdio: ['ignore', 'ignore', 'pipe'], maxBuffer: 64 << 20 })
    } catch {
      signalled = true
    }
    const text = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : ''
    fs.rmSync(out, { force: true })
    return { text, signalled }
  }

  const truncating = path.join(CORPUS, 'Apartment-1.dwg')
  if (fs.existsSync(truncating)) {
    const { text, signalled } = convert(truncating)
    // The point of the case: the converter did NOT signal, i.e. it claimed
    // success. The gate must reject anyway, on the bytes alone.
    ok(!signalled, 'Apartment-1.dwg: dwg2dxf claims success (exit 0) — the lie under test')
    ok(!verifyDxf(text).ok, 'Apartment-1.dwg: truncated output is caught despite exit 0')
  }

  for (const clean of ['fast-food-Restaurant.dwg', 'call-center-offices.dwg']) {
    const p = path.join(CORPUS, clean)
    if (!fs.existsSync(p)) continue
    const { text } = convert(p)
    ok(verifyDxf(text).ok, `${clean}: a good conversion is not rejected`)
  }
} else {
  console.log('(skipped real-converter cases: dwg2dxf or cad-validation/raw absent)')
}

console.log(failed === 0 ? `PASS (${checks} checks)` : `FAIL (${checks} checks, ${failed} failing)`)
process.exit(failed === 0 ? 0 : 1)
