// Headless driver for the shareable web 3D viewer (gate G8).
//
// SAME CODE PATH AS THE APP — mirrors scripts/render-rooms.mjs exactly. The
// Export menu's "Copy share link" calls `publishShareLink()` in
// `web/src/export/share.ts`; that function needs a real WebGL/canvas context to
// serialize the scene, so this script bundles it with esbuild and runs it inside
// headless Chromium via Playwright, ON THE RUNNING SERVER'S ORIGIN (the POST is
// same-origin, exactly as it is in the app). Nothing is re-implemented for Node.
//
//   node scripts/share-plan.mjs [--base http://localhost:5173] [--seed 7]
//                               [--id <share id>] [--name "<plan name>"] [--out out]
//
// Writes, per the artifact contract:
//   out/share.json    { "planId": "...", "url": "http://…/share/<planId>" }
//
// The server (vite dev middleware, or deploy/server.ts in prod) stores the GLB
// under its plan directory's share/ subfolder — see deploy/shareStore.ts.

import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { REPO, buildDemoDoc } from './lib/demo-doc.mjs'

const argv = process.argv.slice(2)
const arg = (flag, dflt) => {
  const i = argv.indexOf(flag)
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : dflt
}

const OUT = path.resolve(REPO, arg('--out', 'out'))
const BASE = (process.env.DSOURCE_BASE_URL || arg('--base', 'http://localhost:5173')).replace(/\/$/, '')
const SEED = Number(arg('--seed', '7'))
const ID = arg('--id', `demo-seed-${SEED}`)
const NAME = arg('--name', `DSource Test-Fit — seed ${SEED}`)

const webRequire = createRequire(path.join(REPO, 'web/package.json'))
const { build } = await import(
  pathToFileURL(createRequire(webRequire.resolve('vite')).resolve('esbuild')).href
)
const playwright = await import(pathToFileURL(webRequire.resolve('playwright')).href)
const chromium = playwright.chromium ?? playwright.default.chromium

// --- 1. the document, straight out of the Rust core --------------------------
const { state, wallTypes, plate } = await buildDemoDoc({ seed: SEED })
console.log(
  `doc: ${state.walls.length} walls · ${state.components.length} components · ` +
    `${(state.zones ?? []).length} zones · seed ${SEED}`,
)

// --- 2. bundle the app's own share export for the browser --------------------
const bundle = await build({
  stdin: {
    contents: `
      import { publishShareLink } from './src/export/share'
      import { classifyWalls } from './src/export/wallTypes'
      window.DS = { publishShareLink, classifyWalls }
    `,
    resolveDir: path.join(REPO, 'web'),
    loader: 'ts',
  },
  bundle: true,
  write: false,
  format: 'iife',
  target: 'chrome120',
  logLevel: 'warning',
})
const code = bundle.outputFiles[0].text

// --- 3. publish from a page on the server's own origin -----------------------
const browser = await chromium.launch({ args: ['--use-angle=metal', '--enable-unsafe-swiftshader'] })
const page = await browser.newPage()
page.on('pageerror', (e) => console.log('  [page error]', e.message))
try {
  // Any same-origin document will do; viewer.html is the lightest one served by
  // BOTH the dev middleware and deploy/server.ts.
  await page.goto(`${BASE}/viewer.html`, { waitUntil: 'domcontentloaded', timeout: 30000 })
} catch (e) {
  await browser.close()
  console.error(
    `share-plan: ${BASE} is unreachable (${e.message}) — start the app first ` +
      '(pnpm --dir web dev, or the deploy server).',
  )
  process.exit(1)
}
await page.addScriptTag({ content: code })

const link = await page.evaluate(
  async ({ state, wallTypes, plate, id, name }) => {
    const wallSpans = window.DS.classifyWalls(state, wallTypes)
    return window.DS.publishShareLink(state, { name, planId: id, scene: { wallSpans, plate } })
  },
  { state, wallTypes, plate, id: ID, name: NAME },
)
await browser.close()

// --- 4. write the artifact ----------------------------------------------------
fs.mkdirSync(OUT, { recursive: true })
fs.writeFileSync(
  path.join(OUT, 'share.json'),
  JSON.stringify({ planId: link.planId, url: link.url, name: NAME, bytes: link.bytes }, null, 2),
)
console.log(
  `published ${(link.bytes / 1024 / 1024).toFixed(2)} MB glb → ${link.url}\n` +
    `wrote ${path.relative(REPO, path.join(OUT, 'share.json'))}`,
)
