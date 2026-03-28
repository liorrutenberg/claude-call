Start a voice call session and verify the display channel.

## Step 1: Start the call

```bash
claude-call call start
```

## Step 2: Verify display channel

```bash
curl -s http://localhost:9847/health
```

If the health check fails, warn the user: "Display channel not reachable. Voice call is active but output won't appear here. Restart Claude with --dangerously-load-development-channels server:call-display"

## Response

After starting the call, tell the user: "Voice call started."
