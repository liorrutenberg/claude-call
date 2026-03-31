/**
 * Types for the TUI monitor.
 */

export interface StatusFile {
  status: 'running' | 'muted' | 'crashed' | 'stopped'
  callPid: number
  claudePid: number
  startedAt: string
  projectRoot: string
  sessionId: string
}

export interface AgentEvent {
  event: 'dispatch' | 'complete'
  name: string
  ts: string
  id?: string
  summary?: string
}

export interface AgentEntry {
  name: string
  status: 'running' | 'done'
  startedAt: Date
  completedAt?: Date
  elapsedMs: number
  summary?: string
  claudeSessionId?: string
  hookAgentId?: string
}

export interface SessionRegistration {
  session_id: string
  agent_id: string
  agent_type: string
  ts: string
}

/** A parsed line from stdout.log for display */
export interface LogLine {
  type: 'text' | 'tool' | 'thinking' | 'error' | 'system'
  content: string
  toolName?: string
  ts?: string
}

export interface MonitorState {
  connected: boolean
  runDir: string | null
  status: StatusFile | null
  agents: AgentEntry[]
  uptimeMs: number
  claudeSessionId: string | null
  logLines: LogLine[]
  agentCounts: {
    total: number
    active: number
  }
}
