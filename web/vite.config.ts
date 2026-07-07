import { defineConfig, loadEnv, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { OPENAI_TOOLS, buildSystem } from './src/ai/llmSchema'
import { dwgConvertPlugin } from './src/import/dwgConvert'

// Dev-only agent proxy. Holds the LLM key server-side and relays to any
// OpenAI-compatible endpoint (OpenAI / Groq / OpenRouter / Together / local
// Ollama or LM Studio). Configure via env:
//   LLM_BASE_URL  (default https://api.openai.com/v1)
//   LLM_API_KEY   (default $OPENAI_API_KEY)
//   LLM_MODEL     (default gpt-4o-mini)
// For a local, no-key setup: LLM_BASE_URL=http://localhost:11434/v1 LLM_MODEL=llama3.1
function agentProxy(): Plugin {
  return {
    name: 'ds-agent-proxy',
    configureServer(server) {
      server.middlewares.use('/api/agent', async (req: IncomingMessage, res: ServerResponse) => {
        const baseUrl = process.env.LLM_BASE_URL || 'https://api.openai.com/v1'
        const apiKey = process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || ''
        const model = process.env.LLM_MODEL || 'gpt-4o-mini'
        res.setHeader('content-type', 'application/json')

        // A local server (Ollama/LM Studio) needs no key; a cloud one does.
        const localish = /localhost|127\.0\.0\.1/.test(baseUrl)
        const configured = !!apiKey || localish

        if (req.method === 'GET') {
          res.end(JSON.stringify({ configured, model }))
          return
        }
        if (req.method !== 'POST') {
          res.statusCode = 405
          res.end('{}')
          return
        }
        if (!configured) {
          res.statusCode = 503
          res.end(JSON.stringify({ error: 'No LLM endpoint configured' }))
          return
        }
        try {
          const body = await readJson(req)
          const messages = [
            { role: 'system', content: buildSystem(body.context) },
            ...(Array.isArray(body.history) ? body.history : []),
            { role: 'user', content: String(body.text ?? '') },
          ]
          const headers: Record<string, string> = { 'content-type': 'application/json' }
          if (apiKey) headers.authorization = `Bearer ${apiKey}`
          const upstream = await fetch(`${baseUrl}/chat/completions`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ model, messages, tools: OPENAI_TOOLS, tool_choice: 'auto', temperature: 0.2 }),
          })
          const data = await upstream.json()
          if (!upstream.ok) {
            res.statusCode = 502
            res.end(JSON.stringify({ error: data?.error ?? data }))
            return
          }
          const msg = data.choices?.[0]?.message ?? {}
          const tool_calls = (msg.tool_calls ?? []).map(
            (tc: { function?: { name?: string; arguments?: string } }) => ({
              name: tc.function?.name,
              arguments: tc.function?.arguments,
            }),
          )
          res.end(JSON.stringify({ content: msg.content ?? null, tool_calls }))
        } catch (e) {
          res.statusCode = 500
          res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }))
        }
      })
    },
  }
}

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {})
      } catch (e) {
        reject(e)
      }
    })
    req.on('error', reject)
  })
}

export default defineConfig(({ mode }) => {
  // Let the LLM_* config live in a gitignored web/.env.local as well as the
  // shell env. Command-line env wins over .env files.
  const env = loadEnv(mode, process.cwd(), 'LLM_')
  for (const k of ['LLM_BASE_URL', 'LLM_API_KEY', 'LLM_MODEL']) {
    if (env[k] && !process.env[k]) process.env[k] = env[k]
  }
  return {
    plugins: [react(), agentProxy(), dwgConvertPlugin()],
    server: { port: 5173 },
  }
})
