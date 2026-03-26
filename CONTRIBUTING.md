# Contributing to claude-call

Thanks for your interest in contributing.

## Development Setup

```bash
git clone https://github.com/liorrutenberg/claude-call.git
cd claude-call
npm install
npm run build
```

Prerequisites: Node.js 18+, sox (`brew install sox`), whisper-cli (`brew install whisper-cpp`).

Run `claude-call check` to verify your setup.

## Building

```bash
npm run build       # TypeScript → dist/
npm run typecheck   # Type checking only (no emit)
npm run dev         # Watch mode
```

## Code Style

- TypeScript with strict mode
- ESM modules (no CommonJS)
- No dead code, no TODOs in committed code
- Error handling at system boundaries, graceful degradation for optional features
- Keep dependencies minimal

## Architecture

See [docs/architecture.md](docs/architecture.md) for how the system works.

Key files:
- `src/channel.ts` — MCP channel server and voice loop
- `src/voice/` — Audio processing modules (VAD, STT, TTS, recording)
- `src/setup/` — Dependency checking and model downloading
- `src/cli.ts` — CLI entry point

## Pull Requests

- One focused change per PR
- TypeScript must compile cleanly (`npm run typecheck`)
- Test with `claude-call check` and a live voice session if possible
- Describe what changed and why

## License

By contributing, you agree that your contributions will be licensed under the Apache-2.0 license.
