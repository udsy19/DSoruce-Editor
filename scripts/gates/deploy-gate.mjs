#!/usr/bin/env node
// DG — the independent deploy gate.
//
//   node scripts/gates/deploy-gate.mjs --origin https://app.46.202.179.28.sslip.io \
//                                      [--dist web/dist] [--expect-revision <sha>] \
//                                      [--allow-unconfigured]
//
// CONTRACT — what a green DG means, precisely:
//
//   "The origin is serving, byte for byte, the build directory given as --dist,
//    and its API answers the deployed contract."
//
// DG is a POST-DEPLOY verification of ONE deploy: run it against the dist you
// just deployed, immediately after deploying it. It is NOT a drift monitor —
// running it later, against a freshly rebuilt dist of a tree that has moved on,
// SHOULD go red, and that red is correct: it says "this build is not what is
// being served", which is exactly the 2026-08-12 hazard (rsync failed on a
// locked SSH agent, the served build stayed stale, and the invoking pipeline
// printed exit 0). Both directions of that mismatch are failures on purpose:
//   served asset missing from the local build  -> FAIL (origin serves a foreign build)
//   local build file missing/mismatched at origin -> FAIL (deploy did not land)
//
// INDEPENDENCE (.claude/rules/gate-independence.md): ground truth is re-derived
// from two inputs only — the bytes the origin serves over HTTP, and the bytes
// of the --dist directory (the gate's declared reference input). The gate never
// reads deploy.sh's stdout, its exit code, its smoke-check output, or any file
// any deploy pipeline writes about itself. A missing input is a FAILURE, never
// a skip: an unfetchable index, an empty dist, a 404'd asset and a wrong-shaped
// API response all fail. Output is deterministic (no timestamps, no nonces), so
// independence is provable byte-for-byte under sabotage of producer artifacts.
//
// EXIT-CODE INTEGRITY: the exit code IS the verdict (0 pass / non-zero fail,
// via gatelib). HAZARD, recorded 2026-08-12: in bash, `deploy-gate.mjs | tee log`
// reports the exit code of `tee`, not the gate — a red gate prints FAIL and the
// pipeline still exits 0. Any invoker that pipes this gate MUST `set -o pipefail`
// (or read PIPESTATUS[0]); the hook at the end of deploy/deploy.sh invokes it
// as a bare last command under `set -euo pipefail`, so the gate's code is the
// script's code.
//
// CHECKS
//   1  GET /            -> 200 HTML; must reference >=1 JS and >=1 CSS asset
//   2  served index     -> byte-identical to <dist>/index.html
//   3  served->local    -> every asset the served index references exists in
//                          <dist> and hash-matches the served bytes
//   4  local->served    -> every file in <dist> (recursive; the full expected
//                          set, derived from the build, not from any list the
//                          producer emits) is served byte-identical
//   5  wasm             -> <dist> contains >=1 .wasm asset (anti-vacuity) and
//                          each is served byte-identical (inside check 4)
//   6  GET /api/claude  -> 200 {configured:boolean, model:string}; configured
//                          must be true unless --allow-unconfigured (a keyless
//                          deploy boots fine and then every AI call 503s —
//                          deploy/FLY.md §2's silent failure)
//   7  GET /api/plans   -> 200 JSON array
//   8  POST /api/claude {} unauthenticated -> anything but 200 (200 means the
//                          endpoint is OPEN and forwarding on the metered key —
//                          deploy/FLY.md §3's hand check, mechanised)
//   9  GET /api/health  -> if present: {ok:true, revision}; revision must equal
//                          --expect-revision when given. If absent, FAIL only
//                          when --expect-revision was asked for; otherwise a
//                          named note (the pre-health VPS server predates it).
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { runGate, arg, hasFlag } from './lib/gatelib.mjs'

const originArg = arg('--origin')
const distArg = arg('--dist', 'web/dist')
const expectRevision = arg('--expect-revision')
const allowUnconfigured = hasFlag('--allow-unconfigured')

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex')
const short = (h) => h.slice(0, 12)

// Cache-buster nonce: defeats any cache between us and the origin. Random by
// design, and therefore NEVER printed — gate output must stay deterministic.
const NONCE = crypto.randomBytes(8).toString('hex')

async function fetchBytes(origin, rel) {
  const sep = rel.includes('?') ? '&' : '?'
  const url = `${origin}${rel}${sep}dg=${NONCE}`
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      headers: { 'cache-control': 'no-cache', pragma: 'no-cache' },
    })
    const buf = Buffer.from(await res.arrayBuffer())
    return { status: res.status, buf, type: res.headers.get('content-type') || '' }
  } catch (e) {
    return { status: 0, buf: Buffer.alloc(0), type: '', err: e?.cause?.code || e?.message || String(e) }
  }
}

function walk(dir, base = dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = path.join(dir, ent.name)
    if (ent.isDirectory()) walk(p, base, out)
    else out.push(path.relative(base, p).split(path.sep).join('/'))
  }
  return out
}

/** Asset paths referenced by an index HTML: src/href attributes on same-origin
 *  absolute paths. Derived from the SERVED bytes, never from a manifest. */
function refsOf(html) {
  const refs = new Set()
  for (const m of html.matchAll(/(?:src|href)="(\/[^"]+)"/g)) {
    const p = m[1]
    if (p.startsWith('//')) continue // protocol-relative = external
    refs.add(p)
  }
  return [...refs].sort()
}

runGate('DG', async (g) => {
  if (!originArg) { g.fail('usage: --origin <url> is required'); return }
  const origin = originArg.replace(/\/+$/, '')
  const dist = path.resolve(distArg)

  // ---- the reference input: the build being deployed --------------------
  if (!fs.existsSync(dist) || !fs.statSync(dist).isDirectory()) {
    g.fail(`local build directory missing: ${dist} — build before gating (a missing input is a failure, not a skip)`)
    return
  }
  const localFiles = walk(dist)
  g.check(localFiles.length > 0, `local build directory is empty: ${dist}`)
  const localWasm = localFiles.filter((f) => f.endsWith('.wasm'))
  g.check(localWasm.length >= 1, 'local build contains no .wasm asset — the core would be missing; refusing to certify a wasm-less build')
  if (!localFiles.includes('index.html')) { g.fail(`no index.html in ${dist}`); return }

  // ---- 1+2: the served index --------------------------------------------
  const idx = await fetchBytes(origin, '/')
  if (idx.status !== 200) { g.fail(`GET / -> ${idx.status}${idx.err ? ` (${idx.err})` : ''} — origin unreachable or not serving`); return }
  const idxHtml = idx.buf.toString('utf8')
  g.check(/<!doctype html>/i.test(idxHtml), 'GET / did not return an HTML document')
  const refs = refsOf(idxHtml)
  g.check(refs.some((r) => r.endsWith('.js')), 'served index references no JS entry — nothing would run')
  g.check(refs.some((r) => r.endsWith('.css')), 'served index references no stylesheet')

  const localIndex = fs.readFileSync(path.join(dist, 'index.html'))
  const servedIdxHash = sha256(idx.buf)
  const localIdxHash = sha256(localIndex)
  if (!g.check(servedIdxHash === localIdxHash,
    `served index != local build index (served ${short(servedIdxHash)}, local ${short(localIdxHash)}) — the origin is serving a different build than --dist`)) {
    const sc = /name="build-commit" content="([0-9a-f]+)"/.exec(idxHtml)?.[1]
    const lc = /name="build-commit" content="([0-9a-f]+)"/.exec(localIndex.toString('utf8'))?.[1]
    if (sc || lc) g.note(`build-commit meta: served=${sc ? short(sc) : 'none'} local=${lc ? short(lc) : 'none'}`)
  }

  // ---- 3: served -> local (a foreign served build cannot pass) ----------
  const localSet = new Set(localFiles)
  for (const r of refs) {
    const rel = r.replace(/^\//, '')
    if (!localSet.has(rel)) {
      g.check(false, `served index references ${r} which does not exist in the local build — origin serves a foreign/stale build`)
    }
  }

  // ---- 4+5: local -> served, the full expected set, byte-compared -------
  const CONCURRENCY = 8
  const results = []
  let i = 0
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (i < localFiles.length) {
      const rel = localFiles[i++]
      const local = fs.readFileSync(path.join(dist, rel))
      const served = await fetchBytes(origin, '/' + rel)
      results.push({ rel, local, served })
    }
  }))
  results.sort((a, b) => a.rel.localeCompare(b.rel))
  let matched = 0
  for (const { rel, local, served } of results) {
    if (served.status !== 200) {
      g.check(false, `/${rel} -> HTTP ${served.status}${served.err ? ` (${served.err})` : ''} — a build file the origin does not serve is a FAILURE, not a skip`)
      continue
    }
    const sh = sha256(served.buf)
    const lh = sha256(local)
    if (sh === lh) { matched++; g.checks++ }
    else if (sha256(served.buf) === servedIdxHash && rel !== 'index.html') {
      g.check(false, `/${rel} served the SPA index instead of the asset (SPA-fallback masking a missing file) — deploy did not land this file`)
    } else {
      g.check(false, `/${rel} byte mismatch (served ${short(sh)}, local ${short(lh)})`)
    }
  }
  g.note(`assets byte-verified against ${origin}: ${matched}/${localFiles.length} (wasm: ${localWasm.length})`)

  // ---- 6: /api/claude readiness shape -----------------------------------
  const claude = await fetchBytes(origin, '/api/claude')
  let cj = null
  try { cj = JSON.parse(claude.buf.toString('utf8')) } catch { /* checked below */ }
  if (g.check(claude.status === 200 && cj && typeof cj === 'object',
    `GET /api/claude -> ${claude.status}, expected 200 JSON`)) {
    g.check(typeof cj.configured === 'boolean' && typeof cj.model === 'string' && cj.model.length > 0,
      `GET /api/claude shape wrong: got ${JSON.stringify(cj).slice(0, 120)}, expected {configured:boolean, model:string}`)
    if (cj.configured !== true && !allowUnconfigured) {
      g.check(false, '/api/claude reports configured:false — the deploy boots but every AI call will 503 (set the key in the remote env, or pass --allow-unconfigured for a deliberately keyless deploy)')
    }
  }

  // ---- 7: /api/plans is a JSON array ------------------------------------
  const plans = await fetchBytes(origin, '/api/plans')
  let pj = null
  try { pj = JSON.parse(plans.buf.toString('utf8')) } catch { /* checked below */ }
  g.check(plans.status === 200 && Array.isArray(pj),
    `GET /api/plans -> ${plans.status} ${Array.isArray(pj) ? '' : `non-array: ${plans.buf.toString('utf8').slice(0, 80)}`} — expected 200 + JSON array`)

  // ---- 8: unauthenticated POST must not be answered 200 ------------------
  let postStatus = 0
  try {
    const res = await fetch(`${origin}/api/claude?dg=${NONCE}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    })
    await res.arrayBuffer()
    postStatus = res.status
  } catch { postStatus = 0 }
  g.check(postStatus !== 200,
    'POST /api/claude {} (no auth) answered 200 — the endpoint is OPEN and forwarding on the metered key (deploy/FLY.md §3); stop and fix before anything else')
  if (postStatus === 401 || postStatus === 403) g.note(`POST /api/claude (no auth) -> ${postStatus}: guarded`)
  else g.note(`POST /api/claude (no auth) -> ${postStatus}: WARNING — not a guard rejection. An empty body ` +
    'cannot come back 200 even from an open endpoint (the upstream 400s it), so a 4xx/5xx here means the ' +
    'request was FORWARDED on the metered key without auth. Guarded deploys answer 401 before any forward.')

  // ---- 9: /api/health provenance ----------------------------------------
  const health = await fetchBytes(origin, '/api/health')
  let hj = null
  try { hj = JSON.parse(health.buf.toString('utf8')) } catch { /* handled below */ }
  const hasHealth = health.status === 200 && hj && hj.ok === true
  if (hasHealth) {
    g.check(typeof hj.revision === 'string' && hj.revision.length > 0,
      'GET /api/health lacks a revision — a served bundle that cannot be traced to a commit (deploy/FLY.md: pass GIT_SHA)')
    if (expectRevision) {
      g.check(hj.revision === expectRevision,
        `GET /api/health revision=${hj.revision}, expected ${expectRevision} — the origin runs a different server build`)
    } else {
      g.note(`health: revision=${hj.revision}`)
    }
  } else if (expectRevision) {
    g.check(false, `GET /api/health -> ${health.status} (no {ok:true}) but --expect-revision was given — provenance unverifiable is a FAILURE, not a skip`)
  } else {
    g.note(`no /api/health at this origin (HTTP ${health.status}) — provenance not verifiable over HTTP for this deploy; scope: this origin's server bundle predates /api/health`)
  }
})
