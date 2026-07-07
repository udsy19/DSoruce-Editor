import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The Rust core is built by `make wasm` into src/wasm and imported directly.
// Vite natively handles the `new URL('..._bg.wasm', import.meta.url)` pattern
// that wasm-pack's `web` target emits.
export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
})
