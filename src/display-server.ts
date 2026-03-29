#!/usr/bin/env node
/**
 * call-display — Tiny MCP channel server for pushing call session output
 * to the main interactive Claude Code session.
 *
 * The call session's background agents POST formatted text to the HTTP
 * endpoint. This server forwards it as an MCP channel notification,
 * which appears in the main session as <channel source="call-display">.
 *
 * No tools exposed. Channel capability only.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js' // eslint-disable-line deprecation/deprecation
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveActiveRunDir } from './runtime.js'

const PORT = 9847

// ─── Agent Tracking ─────────────────────────────────────────

const VALID_EVENTS = ['dispatch', 'complete'] as const

/**
 * Write an agent event to agents.jsonl in the run directory.
 * Best-effort — failures are silently ignored.
 */
function writeAgentEvent(agent: unknown): void {
  if (!agent || typeof agent !== 'object') return

  const { event, name, ts, summary } = agent as Record<string, unknown>
  if (typeof event !== 'string' || typeof name !== 'string' || typeof ts !== 'string') return
  if (!VALID_EVENTS.includes(event as typeof VALID_EVENTS[number])) return

  const runDir = resolveActiveRunDir()
  if (!runDir) return

  const eventObj: Record<string, string> = { event, name, ts }
  if (typeof summary === 'string') eventObj.summary = summary

  try {
    appendFileSync(join(runDir, 'agents.jsonl'), JSON.stringify(eventObj) + '\n')
  } catch {
    // Best-effort
  }
}

// ─── MCP Server ─────────────────────────────────────────────

const mcp = new Server(
  { name: 'call-display', version: '0.1.0' },
  {
    capabilities: { experimental: { 'claude/channel': {} } },
    instructions:
      'When you receive a <channel source="call-display"> message, display it using the Bash tool with echo -e. ' +
      'This preserves ANSI colors and multi-line formatting. ' +
      'Do not summarize or process the content. Do not output it as text (ANSI gets stripped). ' +
      'Always use echo -e via Bash so colors render in the terminal.',
  },
)

// ─── HTTP Server ────────────────────────────────────────────

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // Health check
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true, port: PORT }))
    return
  }

  // Display push
  if (req.method === 'POST' && req.url === '/display') {
    const MAX_BODY = 1_048_576
    let body = ''
    for await (const chunk of req) {
      body += chunk
      if (body.length > MAX_BODY) {
        res.writeHead(413, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'body too large' }))
        return
      }
    }

    try {
      const { text, agent } = JSON.parse(body)

      // Write agent event if present (best-effort)
      writeAgentEvent(agent)

      // Allow agent-only POSTs (no text field required)
      if (typeof text !== 'string' || !text) {
        if (agent) {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: true }))
          return
        }
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'missing text field' }))
        return
      }

      await mcp.notification({
        method: 'notifications/claude/channel',
        params: { channel: 'call-display', content: text },
      })

      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: (err as Error).message }))
    }
    return
  }

  res.writeHead(404)
  res.end('not found')
}

const http = createServer((req, res) => {
  handleRequest(req, res).catch(() => {
    if (!res.headersSent) {
      res.writeHead(500)
      res.end('internal error')
    }
  })
})

http.listen(PORT, '127.0.0.1', () => {
  process.stderr.write(`call-display MCP listening on http://127.0.0.1:${PORT}\n`)
})

http.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    process.stderr.write(`ERROR: Port ${PORT} already in use. Is another call-display instance running?\n`)
    process.exit(1)
  }
  throw err
})

// ─── MCP stdio transport ────────────────────────────────────

const transport = new StdioServerTransport()
await mcp.connect(transport)
