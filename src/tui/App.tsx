import { useState, useEffect } from 'react'
import { Box, Text, useInput } from 'ink'
import { spawn } from 'node:child_process'
import { openSync, closeSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { VoiceStatus } from './VoiceStatus.js'
import { AgentList } from './AgentList.js'
import { AgentDetail } from './AgentDetail.js'
import { SessionInfo } from './SessionInfo.js'
import { SessionLog } from './SessionLog.js'
import { Settings, getSettingsCount, handleSettingsInput } from './Settings.js'
import { readMonitorState } from './state.js'
import { setMuteSignalIn, clearMuteSignalIn, hasMuteSignalIn, updateStatus } from '../runtime.js'
import type { MonitorState } from './types.js'

const POLL_INTERVAL_MS = 1500
const LOG_MAX_HEIGHT = 15

function emptyState(): MonitorState {
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

type ViewMode = 'main' | 'settings' | 'agent' | 'log' | 'input'

function sendToAgent(voiceSessionId: string, hookAgentId: string, _agentName: string, message: string, runDir: string | null): void {
  // Sanitize user input — strip quotes to prevent prompt injection
  const safeMessage = message.replace(/["'`\\]/g, '')
  const relayMsg = `[SILENT RELAY — do NOT speak, do NOT call speak(). Use SendMessage tool with to: '${hookAgentId}' and message: "${safeMessage}". Do NOT launch a new agent. Just call SendMessage and reply with text only.]`

  let outFd: number | undefined
  let stdio: any = 'ignore'
  if (runDir) {
    const sessDir = join(runDir, 'sessions')
    mkdirSync(sessDir, { recursive: true })
    outFd = openSync(join(sessDir, `${hookAgentId}.log`), 'a')
    stdio = ['ignore', outFd, outFd]
  }
  const proc = spawn('claude', ['--resume', voiceSessionId, '-p', relayMsg, '--permission-mode', 'bypassPermissions'], {
    detached: true,
    stdio,
  })
  proc.unref()
  // Close parent's copy of the fd — child process inherited it
  if (outFd !== undefined) closeSync(outFd)
}

export function App() {
  const [state, setState] = useState<MonitorState>(emptyState)
  const [viewMode, setViewMode] = useState<ViewMode>('main')
  const [settingsIdx, setSettingsIdx] = useState(0)
  const [agentIdx, setAgentIdx] = useState(-1)
  const [logScroll, setLogScroll] = useState(0)
  const [autoScroll, setAutoScroll] = useState(true)
  const [inputText, setInputText] = useState('')
  const [sendStatus, setSendStatus] = useState<string | null>(null)

  useEffect(() => {
    setState(readMonitorState())
    const interval = setInterval(() => {
      setState(prev => {
        const next = readMonitorState()
        if (autoScroll && next.logLines.length > prev.logLines.length) {
          setLogScroll(Math.max(0, next.logLines.length - LOG_MAX_HEIGHT))
        }
        return next
      })
    }, POLL_INTERVAL_MS)
    return () => clearInterval(interval)
  }, [autoScroll])

  // Clear send status after 3 seconds
  useEffect(() => {
    if (!sendStatus) return
    const timer = setTimeout(() => setSendStatus(null), 3000)
    return () => clearTimeout(timer)
  }, [sendStatus])

  useInput((input, key) => {
    // Input mode: capture text
    if (viewMode === 'input') {
      if (key.escape) {
        setViewMode('agent')
        setInputText('')
        return
      }
      if (key.return) {
        const agent = agentIdx >= 0 && agentIdx < state.agents.length ? state.agents[agentIdx] : null
        if (agent?.claudeSessionId && agent.hookAgentId && inputText.trim()) {
          sendToAgent(agent.claudeSessionId, agent.hookAgentId, agent.name, inputText.trim(), state.runDir)
          setSendStatus(`Sent to ${agent.name}`)
        }
        setInputText('')
        setViewMode('agent')
        return
      }
      if (key.backspace || key.delete) {
        setInputText(prev => prev.slice(0, -1))
        return
      }
      if (input && !key.ctrl && !key.meta) {
        setInputText(prev => prev + input)
      }
      return
    }

    // Toggle settings
    if (input === 's') {
      setViewMode(prev => prev === 'settings' ? 'main' : 'settings')
      return
    }

    // Toggle voice log viewer
    if (input === 'v' && state.connected) {
      if (viewMode === 'log') {
        setViewMode('main')
      } else {
        setViewMode('log')
        setAutoScroll(true)
        setLogScroll(Math.max(0, state.logLines.length - LOG_MAX_HEIGHT))
      }
      return
    }

    // Enter input mode for agent with session ID (running or finished)
    if (input === 'i' && viewMode === 'agent') {
      const agent = agentIdx >= 0 && agentIdx < state.agents.length ? state.agents[agentIdx] : null
      if (agent?.claudeSessionId) {
        setViewMode('input')
        setInputText('')
        return
      }
    }

    // Settings navigation
    if (viewMode === 'settings') {
      if (key.escape) {
        setViewMode('main')
        return
      }
      const count = getSettingsCount()
      if (key.upArrow) {
        setSettingsIdx(prev => (prev - 1 + count) % count)
      } else if (key.downArrow) {
        setSettingsIdx(prev => (prev + 1) % count)
      } else if (key.return || key.leftArrow || key.rightArrow) {
        const action = key.return ? 'return' : key.leftArrow ? 'left' : 'right'
        handleSettingsInput(action, settingsIdx)
        setState(readMonitorState())
      }
      return
    }

    // Log viewer scroll
    if (viewMode === 'log') {
      if (key.upArrow) {
        setAutoScroll(false)
        setLogScroll(prev => Math.max(0, prev - 1))
      } else if (key.downArrow) {
        setLogScroll(prev => {
          const next = Math.min(prev + 1, Math.max(0, state.logLines.length - LOG_MAX_HEIGHT))
          if (next >= state.logLines.length - LOG_MAX_HEIGHT) setAutoScroll(true)
          return next
        })
      } else if (key.escape) {
        setViewMode('main')
      }
      return
    }

    // Agent navigation (main mode)
    const agentCount = state.agents.length
    if (agentCount > 0) {
      if (key.upArrow) {
        setAgentIdx(prev => prev <= 0 ? agentCount - 1 : prev - 1)
        return
      } else if (key.downArrow) {
        setAgentIdx(prev => prev >= agentCount - 1 ? 0 : prev + 1)
        return
      } else if (key.return && agentIdx >= 0 && agentIdx < agentCount) {
        setViewMode(prev => prev === 'agent' ? 'main' : 'agent')
        return
      }
    }

    // Escape closes any pane
    if (key.escape) {
      setViewMode('main')
      return
    }

    // Mute toggle
    if (!state.runDir) return
    if (input === 'm') {
      if (hasMuteSignalIn(state.runDir)) {
        clearMuteSignalIn(state.runDir)
        updateStatus(state.runDir, { status: 'running' })
      } else {
        setMuteSignalIn(state.runDir)
        updateStatus(state.runDir, { status: 'muted' })
      }
      setState(readMonitorState())
    }
  })

  const selectedAgent = agentIdx >= 0 && agentIdx < state.agents.length ? state.agents[agentIdx] : null

  return (
    <Box flexDirection="column" padding={1}>
      <Text bold>claude-call monitor</Text>
      <Box marginTop={1} />
      <VoiceStatus connected={state.connected} status={state.status} />
      <AgentList agents={state.agents} selectedIndex={agentIdx} />
      <SessionInfo state={state} />
      {viewMode === 'settings' && <Settings selectedIndex={settingsIdx} />}
      {(viewMode === 'agent' || viewMode === 'input') && selectedAgent && <AgentDetail agent={selectedAgent} runDir={state.runDir} />}
      {viewMode === 'input' && (
        <Box marginTop={1}>
          <Text color="cyan">{'\u276f'} </Text>
          <Text>{inputText}</Text>
          <Text color="cyan">_</Text>
        </Box>
      )}
      {viewMode === 'log' && (
        <SessionLog lines={state.logLines} scrollOffset={logScroll} maxHeight={LOG_MAX_HEIGHT} />
      )}
      {sendStatus && (
        <Box marginTop={1}>
          <Text color="green">{'\u2714'} {sendStatus}</Text>
        </Box>
      )}
      {!state.connected && (
        <Box marginTop={1}>
          <Text dimColor>Waiting for call session...</Text>
        </Box>
      )}
      {viewMode === 'main' && (
        <Box marginTop={1}>
          <Text dimColor>
            {state.connected ? '[m] mute  [s] settings  [v] voice log' : '[s] settings'}
            {state.agents.length > 0 ? '  [\u2191\u2193] agents  [\u23CE] inspect' : ''}
          </Text>
        </Box>
      )}
    </Box>
  )
}
