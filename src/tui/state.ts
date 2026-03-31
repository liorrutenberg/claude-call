/**
 * State reading for the TUI monitor.
 * Reads status.json and agents.jsonl from the active run directory.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveActiveRunDir } from '../runtime.js'
import type { StatusFile, AgentEvent, AgentEntry, LogLine, SessionRegistration, MonitorState } from './types.js'

// Re-export for convenience
export { resolveActiveRunDir }

/**
 * Read status.json from a run directory.
 */
function readStatus(runDir: string): StatusFile | null {
  const statusPath = join(runDir, 'status.json')
  if (!existsSync(statusPath)) return null
  try {
    return JSON.parse(readFileSync(statusPath, 'utf-8')) as StatusFile
  } catch {
    return null
  }
}

/**
 * Parse agents.jsonl and compute agent states.
 */
function readAgents(runDir: string): AgentEntry[] {
  const agentsPath = join(runDir, 'agents.jsonl')
  if (!existsSync(agentsPath)) return []

  const now = Date.now()
  const dispatches = new Map<string, AgentEvent>()
  const completesById = new Map<string, AgentEvent>()
  const completesByName = new Map<string, AgentEvent>()

  try {
    const content = readFileSync(agentsPath, 'utf-8')
    for (const line of content.split('\n')) {
      if (!line.trim()) continue
      try {
        const event = JSON.parse(line) as AgentEvent
        if (event.event === 'dispatch') {
          const key = event.id ?? `${event.name}:${event.ts}`
          dispatches.set(key, event)
        } else if (event.event === 'complete') {
          // Index by id (preferred) and by name (fallback)
          if (event.id) {
            completesById.set(event.id, event)
          }
          completesByName.set(event.name, event)
        }
      } catch {
        // Skip malformed lines
      }
    }
  } catch {
    return []
  }

  // Build agent entries - match dispatches to completions
  const agents: AgentEntry[] = []
  const usedCompletes = new Set<string>()

  // Sort dispatches by time (oldest first) so earlier dispatches get matched first
  const sortedDispatches = [...dispatches.values()].sort(
    (a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime()
  )

  for (const dispatch of sortedDispatches) {
    const startedAt = new Date(dispatch.ts)
    const dispatchId = dispatch.id ?? `${dispatch.name}:${dispatch.ts}`

    // Match by id first, fall back to name
    const complete = (dispatch.id && completesById.get(dispatch.id)) || completesByName.get(dispatch.name)
    const completeKey = complete ? (complete.id ?? `${complete.name}:${complete.ts}`) : null

    // Check if this dispatch has a matching complete that hasn't been used
    const hasComplete = complete &&
      new Date(complete.ts) >= startedAt &&
      completeKey &&
      !usedCompletes.has(completeKey)

    if (hasComplete && completeKey) {
      usedCompletes.add(completeKey)
      const completedAt = new Date(complete.ts)
      agents.push({
        name: dispatch.name,
        status: 'done',
        startedAt,
        completedAt,
        elapsedMs: completedAt.getTime() - startedAt.getTime(),
        summary: complete.summary,
      })
    } else {
      agents.push({
        name: dispatch.name,
        status: 'running',
        startedAt,
        elapsedMs: now - startedAt.getTime(),
      })
    }
  }

  // Sort by start time (most recent first)
  agents.sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())

  return agents
}

/**
 * Parse stdout.log JSONL into displayable log lines.
 * Returns { claudeSessionId, lines }.
 *
 * Incremental: caches parsed results, only re-reads new bytes on subsequent calls.
 */
let logCache: { path: string; offset: number; claudeSessionId: string | null; lines: LogLine[] } | null = null

function parseStdoutLog(runDir: string): { claudeSessionId: string | null; lines: LogLine[] } {
  const logPath = join(runDir, 'stdout.log')
  if (!existsSync(logPath)) return { claudeSessionId: null, lines: [] }

  // Check if we can use cached results
  let startOffset = 0
  let claudeSessionId: string | null = null
  let lines: LogLine[] = []

  if (logCache && logCache.path === logPath) {
    startOffset = logCache.offset
    claudeSessionId = logCache.claudeSessionId
    lines = [...logCache.lines]
  }

  try {
    const fd = require('node:fs').openSync(logPath, 'r')
    const stat = require('node:fs').fstatSync(fd)
    if (stat.size <= startOffset) {
      require('node:fs').closeSync(fd)
      return { claudeSessionId, lines }
    }
    const buf = Buffer.alloc(stat.size - startOffset)
    require('node:fs').readSync(fd, buf, 0, buf.length, startOffset)
    require('node:fs').closeSync(fd)

    const newContent = buf.toString('utf-8')
    for (const raw of newContent.split('\n')) {
      if (!raw.trim()) continue
      try {
        const msg = JSON.parse(raw)

        // Extract Claude session ID from init
        if (msg.type === 'system' && msg.subtype === 'init' && msg.session_id) {
          claudeSessionId = msg.session_id
          continue
        }

        // Skip noise
        if (msg.type === 'rate_limit_event') continue

        // Tool errors from user messages (is_error: true)
        if (msg.type === 'user' && msg.message?.content) {
          for (const block of msg.message.content) {
            if (block.type === 'tool_result' && block.is_error) {
              const errText = typeof block.content === 'string' ? block.content : JSON.stringify(block.content)
              lines.push({ type: 'error', content: errText })
            }
          }
          continue
        }

        // Assistant messages
        if (msg.type === 'assistant' && msg.message?.content) {
          for (const block of msg.message.content) {
            if (block.type === 'text' && block.text) {
              lines.push({ type: 'text', content: block.text })
            } else if (block.type === 'tool_use') {
              const input = block.input || {}
              let summary = block.name
              // Show spoken text for voice
              if (block.name === 'mcp__voice__speak' && input.text) {
                summary = `speak: "${input.text}"`
              } else if (input.command) summary += `: ${input.command}`
              else if (input.file_path) summary += `: ${input.file_path}`
              else if (input.pattern) summary += `: ${input.pattern}`
              else if (input.prompt) summary += `: ${String(input.prompt).slice(0, 80)}...`
              else if (input.description) summary += `: ${input.description}`
              lines.push({ type: 'tool', content: summary, toolName: block.name })
            }
          }
        }

        // Result errors only (skip success — duplicates assistant text)
        if (msg.type === 'result' && msg.subtype !== 'success') {
          const err = msg.errors?.join(', ') || 'Unknown error'
          lines.push({ type: 'error', content: err })
        }
      } catch {
        // Skip malformed lines
      }
    }

    // Update cache
    logCache = { path: logPath, offset: stat.size, claudeSessionId, lines: [...lines] }
  } catch {
    // File read error
  }

  return { claudeSessionId, lines }
}

/**
 * Read sessions.jsonl — maps subagent claude session IDs to agent types.
 */
function readSessions(runDir: string): SessionRegistration[] {
  const sessionsPath = join(runDir, 'sessions.jsonl')
  if (!existsSync(sessionsPath)) return []

  const registrations: SessionRegistration[] = []
  try {
    const content = readFileSync(sessionsPath, 'utf-8')
    for (const line of content.split('\n')) {
      if (!line.trim()) continue
      try {
        registrations.push(JSON.parse(line) as SessionRegistration)
      } catch { /* skip */ }
    }
  } catch { /* file read error */ }

  return registrations
}

/**
 * Read all monitor state from the active run directory.
 */
export function readMonitorState(): MonitorState {
  const runDir = resolveActiveRunDir()

  if (!runDir) {
    return {
      connected: false,
      runDir: null,
      status: null,
      agents: [],
      uptimeMs: 0,
      claudeSessionId: null,
      logLines: [],
      agentCounts: { total: 0, active: 0 },
    }
  }

  const status = readStatus(runDir)
  const agents = readAgents(runDir)
  const sessions = readSessions(runDir)
  const { claudeSessionId, lines } = parseStdoutLog(runDir)
  const now = Date.now()
  const uptimeMs = status ? now - new Date(status.startedAt).getTime() : 0

  // Merge claude session IDs from hook registrations into agent entries
  // Match by agent_type containing the agent name (best effort)
  for (const agent of agents) {
    const match = sessions.find(s =>
      s.agent_type.toLowerCase().includes(agent.name.toLowerCase()) ||
      agent.name.toLowerCase().includes(s.agent_type.toLowerCase())
    )
    if (match) agent.claudeSessionId = match.session_id
  }

  return {
    connected: true,
    runDir,
    status,
    agents,
    uptimeMs,
    claudeSessionId,
    logLines: lines,
    agentCounts: {
      total: agents.length,
      active: agents.filter(a => a.status === 'running').length,
    },
  }
}
