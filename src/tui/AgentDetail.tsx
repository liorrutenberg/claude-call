import { Box, Text } from 'ink'
import { formatElapsed } from './AgentList.js'
import type { AgentEntry } from './types.js'

interface Props {
  agent: AgentEntry
}

function formatTime(date: Date): string {
  return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
}

export function AgentDetail({ agent }: Props) {
  const running = agent.status === 'running'

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
      {agent.claudeSessionId && !running && (
        <Box marginTop={1}>
          <Text dimColor>  session: </Text>
          <Text color="gray">{agent.claudeSessionId.slice(0, 8)}...</Text>
          <Text dimColor> [i] send message</Text>
        </Box>
      )}
    </Box>
  )
}
