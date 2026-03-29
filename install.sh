#!/bin/bash
set -euo pipefail

# claude-call installer
# Usage: curl -fsSL https://raw.githubusercontent.com/liorrutenberg/claude-call/main/install.sh | bash

REPO="https://github.com/liorrutenberg/claude-call.git"
INSTALL_DIR="$HOME/.claude-call/app"
BIN_DIR="/usr/local/bin"
BIN_NAME="claude-call"

info() { printf "\033[1m%s\033[0m\n" "$1"; }
ok()   { printf "\033[32m%s\033[0m\n" "$1"; }
err()  { printf "\033[31m%s\033[0m\n" "$1" >&2; exit 1; }

# ─── Preflight ────────────────────────────────────────────────

command -v node >/dev/null 2>&1 || err "Node.js is required. Install it first: https://nodejs.org"
command -v git  >/dev/null 2>&1 || err "git is required."

NODE_MAJOR=$(node -e 'console.log(process.versions.node.split(".")[0])')
[ "$NODE_MAJOR" -ge 18 ] 2>/dev/null || err "Node.js 18+ required (found v$(node -v))"

info "Installing claude-call..."
echo

# ─── Clone or update ─────────────────────────────────────────

if [ -d "$INSTALL_DIR/.git" ]; then
  info "Updating existing installation..."
  cd "$INSTALL_DIR"
  git pull --quiet
else
  info "Cloning repository..."
  rm -rf "$INSTALL_DIR"
  mkdir -p "$(dirname "$INSTALL_DIR")"
  git clone --quiet --depth 1 "$REPO" "$INSTALL_DIR"
  cd "$INSTALL_DIR"
fi

# ─── Install dependencies and build ─────────────────────────

info "Installing dependencies..."
npm install --silent 2>/dev/null

info "Building..."
npx tsc

# ─── Symlink binary ─────────────────────────────────────────

if [ -w "$BIN_DIR" ]; then
  ln -sf "$INSTALL_DIR/dist/cli.js" "$BIN_DIR/$BIN_NAME"
else
  info "Linking binary (requires sudo)..."
  sudo ln -sf "$INSTALL_DIR/dist/cli.js" "$BIN_DIR/$BIN_NAME"
fi
chmod +x "$INSTALL_DIR/dist/cli.js"

# ─── Make scripts executable ─────────────────────────────────

if [ -d "$INSTALL_DIR/scripts" ]; then
  chmod +x "$INSTALL_DIR/scripts/"*.sh 2>/dev/null || true
fi

# ─── Verify ──────────────────────────────────────────────────

echo
if command -v claude-call >/dev/null 2>&1; then
  ok "claude-call installed successfully!"
else
  ok "Installed to $INSTALL_DIR"
  echo "Add $BIN_DIR to your PATH if claude-call is not found."
fi

echo
echo "Next steps:"
echo
echo "  claude-call install    # once, global"
echo "  claude-call init       # per project"
echo
