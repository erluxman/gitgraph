#!/usr/bin/env bash
# gitGraph — VS Code extension installer.
#
# What this does:
#   1. installs Bun if missing
#   2. installs JS deps
#   3. packs the extension into a .vsix
#   4. installs the .vsix via the `code` CLI
#   5. prints what to do next
set -euo pipefail

REPO="$(cd "$(dirname "$0")" && pwd)"
VSIX="$REPO/packages/vscode/gitgraph-vscode-0.1.0.vsix"

cyan()  { printf "\033[36m%s\033[0m\n" "$*"; }
green() { printf "\033[32m%s\033[0m\n" "$*"; }
gray()  { printf "\033[90m%s\033[0m\n" "$*"; }
bold()  { printf "\033[1m%s\033[0m\n" "$*"; }

cyan "==> Checking Bun"
if ! command -v bun >/dev/null 2>&1; then
  cyan "    Bun not found. Installing via Homebrew…"
  if ! command -v brew >/dev/null 2>&1; then
    echo "Homebrew is required. Install from https://brew.sh and re-run." >&2
    exit 1
  fi
  brew install oven-sh/bun/bun
fi
gray "    bun $(bun --version)"

cyan "==> Checking VS Code CLI"
if ! command -v code >/dev/null 2>&1; then
  cat <<MSG >&2
Couldn't find the 'code' CLI.

If VS Code is installed, open it and run:
  Cmd+Shift+P  →  Shell Command: Install 'code' command in PATH

Then re-run this script.
MSG
  exit 1
fi
gray "    code $(code --version | head -1)"

cyan "==> Installing dependencies"
cd "$REPO"
BUN_INSTALL_CACHE_DIR="$REPO/.bun-cache" bun install >/dev/null

cyan "==> Packing extension"
bun run --cwd packages/vscode pack >/dev/null
gray "    Created $VSIX"

cyan "==> Installing into VS Code"
code --install-extension "$VSIX" --force

cat <<EOF

$(bold "Installed.")  The extension lives at:
  ~/.vscode/extensions/gitgraph.gitgraph-vscode-0.1.0/

$(bold "First use:")
  1. Open VS Code in any folder with TS / JS / Dart code
  2. Click the gitGraph icon (three circles + lines) in the
     activity bar on the left
  3. The sidebar opens and starts scanning the workspace
     against the auto-detected base branch (main / master /
     develop / upstream)
  4. $(bold "Cmd+Click") any node to jump to that file
  5. $(bold "Cmd+Shift+P") → 'gitGraph: Compare branches'
     to pick a different base branch

$(bold "If the icon doesn't appear:")
  Cmd+Shift+P → 'View: Show Dependency graph'  forces it open.

$(bold "To upgrade later:")
  rerun this script. It builds a fresh .vsix and reinstalls.

$(bold "To uninstall:")
  code --uninstall-extension gitgraph.gitgraph-vscode

EOF
green "Done."
