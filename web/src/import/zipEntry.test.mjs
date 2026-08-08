// Node test for the minimal ZIP reader (zipEntry.ts).
// Run from web/:  node src/import/zipEntry.test.mjs
//
// Three of the four archives in the validation corpus wrap exactly one .dwg —
// that is how CAD block libraries are distributed — and the uploader could not
// open any of them. The fourth holds two JPEG catalogue scans and no CAD at all.
//
// The load-bearing assertion is EXTRACTION FIDELITY, checked against an
// independent extractor: what this module pulls out of an archive must be
// byte-identical to what `unzip` pulls out of the same archive. A test that
// only asserted "we got some bytes" would pass on a truncated or mis-offset
// read, which is precisely the failure mode of hand-rolled zip parsing.

// @covers: web/src/import/zipEntry.ts

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

const outFile = path.join(os.tmpdir(), `ds-zip-${Date.now()}.mjs`)
await build({
  entryPoints: [path.join(here, 'zipEntry.ts')],
  outfile: outFile,
  bundle: true,
  format: 'esm',
  platform: 'node',
  logLevel: 'silent',
})
const { listZipEntries, readZipEntry, classifyZip, ZIP_ERROR_MESSAGE } = await import(
  pathToFileURL(outFile).href
)
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

const toArrayBuffer = (buf) => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)

// --- degenerate input ------------------------------------------------------
ok(listZipEntries(new ArrayBuffer(0)).error === 'not-a-zip', 'empty buffer is not a zip')
ok(listZipEntries(new ArrayBuffer(8)).error === 'not-a-zip', 'tiny buffer is not a zip')
{
  const junk = new Uint8Array(200).fill(0x41)
  ok(listZipEntries(toArrayBuffer(junk)).error === 'not-a-zip', 'non-zip bytes are rejected')
}
ok(
  Object.values(ZIP_ERROR_MESSAGE).every((m) => typeof m === 'string' && m.length > 0),
  'every zip error has a user-facing message',
)

// --- classification --------------------------------------------------------
{
  const c = classifyZip([
    { name: 'plan.dwg' },
    { name: 'plan.DXF' },
    { name: 'page-1.jpg' },
    { name: 'readme.txt' },
    { name: 'folder/' },
    { name: '__MACOSX/._plan.dwg' },
    { name: 'notes/.DS_Store' },
  ])
  ok(c.cad.length === 2, `both CAD entries found, case-insensitively (got ${c.cad.length})`)
  ok(c.raster.length === 1, `the image is separated (got ${c.raster.length})`)
  ok(c.other.length === 1, `only readme.txt is 'other' (got ${c.other.length})`)
  ok(
    !c.cad.some((e) => e.name.startsWith('__MACOSX/')),
    'macOS resource forks are not offered as drawings',
  )
}

// --- against the REAL archives, verified by an independent extractor --------
const CORPUS = '/Users/udsy/Downloads'
let haveUnzip = true
try {
  execFileSync('unzip', ['-v'], { stdio: 'ignore' })
} catch {
  haveUnzip = false
}

const ARCHIVES = [
  ['Hospital-equipment.zip', 'MOBILIARIO HOSPITAL.dwg', 1],
  ['Office-furniture-blocks.zip', 'cad33.dwg', 1],
  ['Various-furniture-blocks.zip', 'muebles varios.dwg', 1],
  ['Library-of-furniture.zip', null, 0], // JPEG scans, no CAD
]

let ran = 0
for (const [archive, expectCad, cadCount] of ARCHIVES) {
  const p = path.join(CORPUS, archive)
  if (!fs.existsSync(p)) continue
  ran++
  const buf = toArrayBuffer(fs.readFileSync(p))
  const listed = listZipEntries(buf)
  ok(!('error' in listed), `${archive}: central directory reads (${listed.error ?? 'ok'})`)
  if ('error' in listed) continue

  const { cad, raster } = classifyZip(listed.entries)
  ok(cad.length === cadCount, `${archive}: ${cadCount} CAD entr(y|ies) (got ${cad.length})`)

  if (cadCount === 0) {
    ok(raster.length === 2, `${archive}: holds 2 images instead (got ${raster.length})`)
    continue
  }

  ok(cad[0].name === expectCad, `${archive}: names the entry ${expectCad} (got ${cad[0].name})`)

  const read = await readZipEntry(buf, cad[0])
  ok(!('error' in read), `${archive}: entry decompresses (${read.error ?? 'ok'})`)
  if ('error' in read) continue

  ok(
    read.bytes.length === cad[0].uncompressedSize,
    `${archive}: length matches the directory (${read.bytes.length} vs ${cad[0].uncompressedSize})`,
  )
  // A DWG begins with "AC" + a version code. Cheap proof we landed on the file
  // and not on a header or an adjacent entry.
  ok(
    read.bytes[0] === 0x41 && read.bytes[1] === 0x43,
    `${archive}: extracted bytes start with the DWG magic "AC"`,
  )

  // THE assertion: byte-identical to an independent extractor.
  if (haveUnzip) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-zip-ref-'))
    try {
      execFileSync('unzip', ['-q', '-o', p, cad[0].name, '-d', dir], { stdio: 'ignore' })
      const ref = fs.readFileSync(path.join(dir, cad[0].name))
      ok(
        ref.length === read.bytes.length && Buffer.from(read.bytes).equals(ref),
        `${archive}: extraction is byte-identical to \`unzip\` (${read.bytes.length} vs ${ref.length} bytes)`,
      )
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }
}

if (ran === 0) console.log('(skipped real-archive cases: corpus archives not present)')
else if (!haveUnzip) console.log('(skipped byte-identity check: `unzip` not installed)')

console.log(failed === 0 ? `PASS (${checks} checks)` : `FAIL (${checks} checks, ${failed} failing)`)
process.exit(failed === 0 ? 0 : 1)
