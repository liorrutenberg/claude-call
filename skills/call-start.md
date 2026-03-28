Start a voice call session and begin watching for events.

## Step 1: Start the call

```bash
claude-call call start
```

## Step 2: Start the event watcher

After the call starts successfully, launch a background agent with `run_in_background: true`.

The agent's instructions:

> You are a watcher that polls for voice call events every 3 seconds.
>
> **Loop** (repeat until the call session stops):
>
> 1. Run: `claude-call call status 2>&1`
>    - If it does NOT contain "running", stop looping — the call ended.
> 2. Run: `$HOME/.claude-call/app/scripts/process-events.sh PROJECT_ROOT 2>/dev/null`
>    - Replace PROJECT_ROOT with: PROJECT_ROOT_VALUE
>    - If the output is non-empty, display it to the user exactly as-is.
> 3. Run: `sleep 3` (wait before next check)
>
> **Important**: Run each step as a SEPARATE Bash tool call. Do NOT combine them into a single long-running Bash command — you need to see the output of each call to decide what to do next.
>
> Keep looping until the call session is no longer running.

Replace `PROJECT_ROOT_VALUE` with the actual working directory when launching the agent.

## Response

After starting the call, tell the user: "Voice call started. Watching for events."
