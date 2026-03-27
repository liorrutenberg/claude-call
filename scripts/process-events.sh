#!/usr/bin/env bash
#
# process-events.sh — Process one event pointer from the call session.
#
# Reads the first event from .claude-call/events.jsonl, extracts the referenced
# message from the session log (stdout.log), outputs formatted content,
# then removes the processed event line.
#
# Usage:
#   scripts/process-events.sh /path/to/project
#   PROJECT_ROOT=/path/to/project scripts/process-events.sh
#
# Exit codes:
#   0 — success (or no events to process)
#   1 — error
#
# Dependencies: jq

set -euo pipefail

PROJECT_ROOT="${1:-${PROJECT_ROOT:-}}"

if [[ -z "$PROJECT_ROOT" ]]; then
  echo "Usage: $0 <project-root>" >&2
  exit 1
fi

EVENTS_FILE="$PROJECT_ROOT/.claude-call/events.jsonl"

# No events file or empty — exit silently
if [[ ! -f "$EVENTS_FILE" ]]; then
  exit 0
fi

if [[ ! -s "$EVENTS_FILE" ]]; then
  exit 0
fi

# Read the first event line
FIRST_LINE=$(head -1 "$EVENTS_FILE")

if [[ -z "$FIRST_LINE" ]]; then
  exit 0
fi

# Extract fields from the event
UUID=$(echo "$FIRST_LINE" | jq -r '.uuid // empty')
LOG=$(echo "$FIRST_LINE" | jq -r '.log // empty')
TITLE=$(echo "$FIRST_LINE" | jq -r '.title // "Call Session Output"')

if [[ -z "$UUID" || -z "$LOG" ]]; then
  # Malformed event — remove it and exit
  sed -i '' '1d' "$EVENTS_FILE" 2>/dev/null || tail -n +2 "$EVENTS_FILE" > "$EVENTS_FILE.tmp" && mv "$EVENTS_FILE.tmp" "$EVENTS_FILE"
  exit 0
fi

# Check session log exists
if [[ ! -f "$LOG" ]]; then
  # Log file missing — remove event and exit
  sed -i '' '1d' "$EVENTS_FILE" 2>/dev/null || tail -n +2 "$EVENTS_FILE" > "$EVENTS_FILE.tmp" && mv "$EVENTS_FILE.tmp" "$EVENTS_FILE"
  exit 0
fi

# Find the message in the session log by UUID
# The log is JSONL with lines like: {"type":"assistant","message":{...},"uuid":"..."}
MESSAGE_LINE=$(grep "\"$UUID\"" "$LOG" | head -1)

if [[ -z "$MESSAGE_LINE" ]]; then
  # UUID not found in log — remove event and exit
  sed -i '' '1d' "$EVENTS_FILE" 2>/dev/null || tail -n +2 "$EVENTS_FILE" > "$EVENTS_FILE.tmp" && mv "$EVENTS_FILE.tmp" "$EVENTS_FILE"
  exit 0
fi

# Extract text content from the message
# .message.content is an array; we want text elements only (skip thinking blocks, tool_use)
CONTENT=$(echo "$MESSAGE_LINE" | jq -r '
  .message.content[]
  | select(.type == "text")
  | .text
' 2>/dev/null)

if [[ -z "$CONTENT" ]]; then
  # No text content found — remove event and exit
  sed -i '' '1d' "$EVENTS_FILE" 2>/dev/null || tail -n +2 "$EVENTS_FILE" > "$EVENTS_FILE.tmp" && mv "$EVENTS_FILE.tmp" "$EVENTS_FILE"
  exit 0
fi

# Output formatted content
echo "## $TITLE"
echo ""
echo "$CONTENT"

# Remove the processed event (first line) from events.jsonl
# Use portable approach: write remaining lines to temp file, then replace
tail -n +2 "$EVENTS_FILE" > "$EVENTS_FILE.tmp" && mv "$EVENTS_FILE.tmp" "$EVENTS_FILE"

exit 0
