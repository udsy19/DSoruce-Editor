// PROVENANCE GATE for scripted browser verification.
//
// Run this against the URL you are about to measure, BEFORE measuring anything:
//
//   node bench/assert-build.mjs http://localhost:5210
//
// It fails if the server is serving a different git tree than the one you are
// editing. That is not a hypothetical failure: three verification passes in the
// plan-grammar campaign ran against :5173, which a SEPARATE git worktree was
// serving, and confidently reported deleted CSS custom properties as still
// live. The measurements were real; they were about the wrong tree.
//
// This is the same failure class as the IFC reader indicting our exporter — an
// instrument pointed somewhere unexamined, reporting precisely. The fix is the
// same shape too: make the instrument state its provenance, and check it before
// believing the reading.
//
// ROOT is the load-bearing field. The worktree that caused the mix-up had a
// plausible commit; what it did not have was this directory. Commit is reported
// as INFO rather than enforced, because a dev server legitimately serves a
// dirty tree ahead of HEAD — the question is "which tree", not "which commit".

import { execSync } from 'node:child_process'

const url = process.argv[2]
if (!url) {
  console.error('usage: node bench/assert-build.mjs <url>')
  process.exit(2)
}

const sh = (cmd) => execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()

let html
try {
  const res = await fetch(url, { redirect: 'follow' })
  html = await res.text()
} catch (err) {
  console.error(`PROVENANCE FAIL: cannot reach ${url} — ${err.message}`)
  process.exit(1)
}

const meta = (name) =>
  html.match(new RegExp(`<meta\\s+name="${name}"\\s+content="([^"]*)"`))?.[1] ?? null

const servedRoot = meta('build-root')
const servedCommit = meta('build-commit')

if (!servedRoot) {
  console.error(
    'PROVENANCE FAIL: page carries no build-root meta.\n' +
      '  Either the server predates the build-provenance plugin (restart it), or\n' +
      '  it is not this app at all. Do not measure an unidentified page.',
  )
  process.exit(1)
}

const localRoot = sh('git rev-parse --show-toplevel')
const localCommit = sh('git rev-parse HEAD')

if (servedRoot !== localRoot) {
  console.error(
    'PROVENANCE FAIL: that URL is serving a DIFFERENT TREE.\n' +
      `  served : ${servedRoot}\n` +
      `  local  : ${localRoot}\n` +
      '  Measuring it would describe code you have not changed. Start a dev\n' +
      '  server for this tree on a free port and point the check at that.',
  )
  process.exit(1)
}

const dirty = sh('git status --porcelain').length > 0
console.log(`provenance OK — ${url}`)
console.log(`  root   ${servedRoot}`)
console.log(
  `  commit ${servedCommit === localCommit ? `${servedCommit.slice(0, 8)} (matches HEAD)` : `${String(servedCommit).slice(0, 8)} vs HEAD ${localCommit.slice(0, 8)}`}` +
    (dirty ? ' · working tree dirty (dev serves the files, not the commit)' : ''),
)
