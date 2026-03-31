#!/usr/bin/env bash
# SubagentStart hook — registers new subagents in sessions.jsonl
# Gated by CLAUDE_CALL_RUN_DIR: exits immediately if not in a voice call session.
#
# Reads JSON from stdin with: session_id, agent_id, agent_type
# Appends to $CLAUDE_CALL_RUN_DIR/sessions.jsonl

set -euo pipefail

# Only run during voice call sessions
[[ -z "${CLAUDE_CALL_RUN_DIR:-}" ]] && exit 0

# Read JSON from stdin
INPUT=$(cat)

# Extract fields
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')
AGENT_ID=$(echo "$INPUT" | jq -r '.agent_id // empty')
AGENT_TYPE=$(echo "$INPUT" | jq -r '.agent_type // empty')

# Need at least session_id
[[ -z "$SESSION_ID" ]] && exit 0

TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)

# Append to sessions.jsonl
jq -nc \
  --arg session_id "$SESSION_ID" \
  --arg agent_id "$AGENT_ID" \
  --arg agent_type "$AGENT_TYPE" \
  --arg ts "$TS" \
  '{session_id: $session_id, agent_id: $agent_id, agent_type: $agent_type, ts: $ts}' \
  >> "${CLAUDE_CALL_RUN_DIR}/sessions.jsonl"
