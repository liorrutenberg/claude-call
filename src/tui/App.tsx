import { useState, useEffect } from 'react'
import { Box, Text, useInput } from 'ink'
import { VoiceStatus } from './VoiceStatus.js'
import { AgentList } from './AgentList.js'
import { SessionInfo } from './SessionInfo.js'
import { readMonitorState } from './state.js'
import { setMuteSignalIn, clearMuteSignalIn, hasMuteSignalIn, updateStatus } from '../runtime.js'
import type { MonitorState } from './types.js'

const POLL_INTERVAL_MS = 1500

function emptyState(): MonitorState {
  return {
    connected: false,
    runDir: null,
    status: null,
    agents: [],
    uptimeMs: 0,
    agentCounts: { total: 0, active: 0 },
  }
}

export function App() {
  const [state, setState] = useState<MonitorState>(emptyState)

  useEffect(() => {
    // Initial read
    setState(readMonitorState())

    // Poll for updates
    const interval = setInterval(() => {
      setState(readMonitorState())
    }, POLL_INTERVAL_MS)

    return () => clearInterval(interval)
  }, [])

  useInput((input) => {
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

  return (
    <Box flexDirection="column" padding={1}>
      <Text bold>claude-call monitor</Text>
      <Box marginTop={1} />
      <VoiceStatus connected={state.connected} status={state.status} />
      <AgentList agents={state.agents} />
      <SessionInfo state={state} />
      {!state.connected && (
        <Box marginTop={1}>
          <Text dimColor>Waiting for call session...</Text>
        </Box>
      )}
      {state.connected && (
        <Box marginTop={1}>
          <Text dimColor>[m] mute/unmute</Text>
        </Box>
      )}
    </Box>
  )
}
