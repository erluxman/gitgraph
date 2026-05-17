#!/usr/bin/env bash
# gitGraph — Chrome extension installer.
#
# What this does:
#   1. installs Bun if missing
#   2. installs JS deps
#   3. builds the Chrome extension bundles
#   4. copies the output to a stable home outside the repo
#   5. prints click-by-click instructions for loading it in Chrome
set -euo pipefail

REPO="$(cd "$(dirname "$0")" && pwd)"
DIST="$REPO/packages/chrome/dist"
HOME_DIR="${GITGRAPH_CHROME_HOME:-$HOME/.local/share/gitgraph-chrome}"

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

cyan "==> Installing dependencies"
cd "$REPO"
# ~/.bun is sometimes root-owned; route Bun's cache to the project to
# avoid an AccessDenied loop.
BUN_INSTALL_CACHE_DIR="$REPO/.bun-cache" bun install >/dev/null

cyan "==> Building Chrome extension"
bun run --cwd packages/chrome build >/dev/null

cyan "==> Copying to stable install location"
mkdir -p "$HOME_DIR"
# Wipe contents but keep the dir (avoid changing inode if Chrome already loaded it).
rm -rf "$HOME_DIR"/*
cp -R "$DIST"/. "$HOME_DIR"/
green "    Installed to $HOME_DIR"

cat <<EOF

$(bold "Next steps — load it into Chrome (one time only):")

  1. Open  $(bold "chrome://extensions/")
  2. Toggle  $(bold "Developer mode")  in the top-right corner
  3. Click  $(bold "Load unpacked")
  4. Pick  $(bold "$HOME_DIR")
  5. (Optional) Pin the extension via the puzzle-piece icon

$(bold "To upgrade later:")
  rerun this script. Then click the circular reload icon on the
  gitGraph card in chrome://extensions/.

$(bold "First use:")
  - Click the gitGraph icon → Settings → paste a GitHub Personal
    Access Token if you need private repos or higher rate limits.
  - Open any GitHub PR → a floating gitGraph button appears
    bottom-right. Click it.
  - On a non-PR repo page, use the popup's Compare Branches
    section to pick base + (optional) compare branch.

EOF
green "Done."
