import { Box, Text } from 'ink'
import type { AgentEntry } from './types.js'

interface Props {
  agents: AgentEntry[]
  selectedIndex: number
}

export function formatElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${minutes % 60}m`
}

function AgentRow({ agent, selected }: { agent: AgentEntry; selected: boolean }) {
  const statusIcon = agent.status === 'running' ? '*' : '+'
  const statusColor = agent.status === 'running' ? 'yellow' : 'green'
  const elapsed = formatElapsed(agent.elapsedMs)
  const prefix = selected ? '>' : ' '

  return (
    <Box>
      <Text color={selected ? 'cyan' : undefined} bold={selected}>{prefix} </Text>
      <Text color={statusColor}>{statusIcon} </Text>
      <Text color={selected ? 'cyan' : undefined} bold={selected}>{agent.name.padEnd(20)}</Text>
      <Text color={statusColor}>{agent.status.padEnd(10)}</Text>
      <Text dimColor>{elapsed}</Text>
    </Box>
  )
}

export function AgentList({ agents, selectedIndex }: Props) {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text dimColor>-- AGENTS --</Text>
      {agents.length === 0 ? (
        <Text color="gray">  (none)</Text>
      ) : (
        agents.slice(0, 10).map((agent, i) => (
          <AgentRow key={`${agent.name}-${i}`} agent={agent} selected={i === selectedIndex} />
        ))
      )}
      {agents.length > 10 && (
        <Text dimColor>  ... and {agents.length - 10} more</Text>
      )}
    </Box>
  )
}
