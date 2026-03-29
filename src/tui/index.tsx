#!/usr/bin/env node
/**
 * Entry point for claude-call monitor TUI.
 */

import { render } from 'ink'
import { App } from './App.js'

const { waitUntilExit } = render(<App />)

waitUntilExit().catch(() => {
  // Graceful exit
})
