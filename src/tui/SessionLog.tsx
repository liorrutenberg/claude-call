import { Box, Text } from 'ink'
import type { LogLine } from './types.js'

interface Props {
  lines: LogLine[]
  scrollOffset: number
  maxHeight: number
}

export function LogEntry({ line }: { line: LogLine }) {
  switch (line.type) {
    case 'tool':
      return (
        <Box>
          <Text color="yellow">{'\u2192'} </Text>
          <Text dimColor>{line.content}</Text>
        </Box>
      )
    case 'error':
      return (
        <Box>
          <Text color="red">{'\u2718'} {line.content}</Text>
        </Box>
      )
    case 'system':
      return (
        <Box>
          <Text color="gray">{line.content}</Text>
        </Box>
      )
    case 'text':
    default:
      return (
        <Box>
          <Text wrap="wrap">{line.content}</Text>
        </Box>
      )
  }
}

export function SessionLog({ lines, scrollOffset, maxHeight }: Props) {
  const visible = lines.slice(scrollOffset, scrollOffset + maxHeight)
  const atBottom = scrollOffset + maxHeight >= lines.length
  const totalLines = lines.length

  return (
    <Box flexDirection="column" marginTop={1} borderStyle="single" borderColor="gray" paddingX={1}>
      <Box>
        <Text bold color="cyan">Voice Session</Text>
        <Text dimColor> ({totalLines} lines)</Text>
        {!atBottom && <Text dimColor> [scroll: {scrollOffset + 1}-{Math.min(scrollOffset + maxHeight, totalLines)}/{totalLines}]</Text>}
      </Box>
      <Box marginTop={1} flexDirection="column">
        {visible.length === 0 ? (
          <Text dimColor>  (no output yet)</Text>
        ) : (
          visible.map((line, i) => (
            <LogEntry key={scrollOffset + i} line={line} />
          ))
        )}
      </Box>
      {!atBottom && (
        <Text dimColor>{'\u2193'} more below</Text>
      )}
    </Box>
  )
}
