import { Box, Text } from 'ink'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { formatElapsed } from './AgentList.js'
import { LogEntry } from './SessionLog.js'
import { findAgentOutput, parseSessionTranscript } from './state.js'
import type { AgentEntry } from './types.js'

interface Props {
  agent: AgentEntry
  runDir: string | null
}

function formatTime(date: Date): string {
  return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
}

function readSessionLog(runDir: string | null, sessionId: string | undefined): string | null {
  if (!runDir || !sessionId) return null
  const logPath = join(runDir, 'sessions', `${sessionId}.log`)
  if (!existsSync(logPath)) return null
  try {
    const content = readFileSync(logPath, 'utf-8').trim()
    return content || null
  } catch { return null }
}

const TRANSCRIPT_TAIL = 12

export function AgentDetail({ agent, runDir }: Props) {
  const running = agent.status === 'running'
  const sessionLog = readSessionLog(runDir, agent.hookAgentId)

  // Read agent's output file from Claude's task system
  const transcriptPath = (agent.claudeSessionId && agent.hookAgentId) ? findAgentOutput(agent.claudeSessionId, agent.hookAgentId) : null
  const transcriptLines = transcriptPath ? parseSessionTranscript(transcriptPath) : []
  const visibleTranscript = transcriptLines.slice(-TRANSCRIPT_TAIL)

  return (
    <Box flexDirection="column" marginTop={1} borderStyle="single" borderColor="gray" paddingX={1}>
      <Box>
        <Text bold color="cyan">{agent.name}</Text>
        <Text> </Text>
        <Text color={running ? 'yellow' : 'green'}>{running ? 'running' : 'done'}</Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Box>
          <Text dimColor>  started:  </Text>
          <Text>{formatTime(agent.startedAt)}</Text>
        </Box>
        <Box>
          <Text dimColor>  elapsed:  </Text>
          <Text>{formatElapsed(agent.elapsedMs)}</Text>
        </Box>
        {agent.completedAt && (
          <Box>
            <Text dimColor>  finished: </Text>
            <Text>{formatTime(agent.completedAt)}</Text>
          </Box>
        )}
      </Box>
      {agent.summary && (
        <Box marginTop={1} flexDirection="column">
          <Text dimColor>  result:</Text>
          <Box marginLeft={2} marginTop={0}>
            <Text wrap="wrap">{agent.summary}</Text>
          </Box>
        </Box>
      )}
      {running && !agent.summary && (
        <Box marginTop={1}>
          <Text dimColor>  working...</Text>
        </Box>
      )}
      {agent.claudeSessionId && (
        <Box marginTop={1}>
          <Text dimColor>  session: </Text>
          <Text color="gray">{agent.claudeSessionId.slice(0, 8)}...</Text>
          <Text dimColor> [i] send message{running ? ' (queues until done)' : ''}</Text>
        </Box>
      )}
      {visibleTranscript.length > 0 && (
        <Box marginTop={1} flexDirection="column">
          <Box>
            <Text dimColor>  -- session log ({transcriptLines.length} entries) --</Text>
          </Box>
          <Box marginLeft={2} flexDirection="column">
            {visibleTranscript.map((line, i) => (
              <LogEntry key={i} line={line} />
            ))}
          </Box>
          {transcriptLines.length > TRANSCRIPT_TAIL && (
            <Text dimColor>  ({transcriptLines.length - TRANSCRIPT_TAIL} earlier entries hidden)</Text>
          )}
        </Box>
      )}
      {sessionLog && (
        <Box marginTop={1} flexDirection="column">
          <Text dimColor>  -- reply --</Text>
          <Box marginLeft={2}>
            <Text wrap="wrap">{sessionLog}</Text>
          </Box>
        </Box>
      )}
    </Box>
  )
}
