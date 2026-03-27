Start a voice call session and begin watching for events.

## Step 1: Start the call

```bash
claude-call call start
```

## Step 2: Start the event watcher

After the call starts successfully, launch a background agent to watch for events from the call session.

The agent should run this bash loop:

```bash
PROJECT_ROOT="$(pwd)"
SCRIPT="$HOME/.claude-call/app/scripts/process-events.sh"
while claude-call call status 2>&1 | grep -q "running"; do
  OUTPUT=$("$SCRIPT" "$PROJECT_ROOT" 2>/dev/null)
  if [ -n "$OUTPUT" ]; then
    echo "$OUTPUT"
  fi
  sleep 3
done
```

When the script outputs content (non-empty), the agent should display it to the user and then continue the loop.

Run this agent with `run_in_background: true`.

## Response

After starting the call, tell the user: "Voice call started. Watching for events."
