#!/usr/bin/env bash
# Install code2spec on this machine: dependencies, build, and the global `code2spec` / `code2spec-mcp` commands.
# Re-run after `git pull` to update.
set -euo pipefail

cd "$(dirname "$0")/.."

need() { command -v "$1" >/dev/null 2>&1 || { echo "✖ $1 is not installed. $2" >&2; exit 1; }; }
need node "Install Node.js 24: https://nodejs.org"
need pnpm "Run: npm install -g pnpm"

node -e 'const [a,b]=process.versions.node.split(".").map(Number); if (a<22||(a===22&&b<5)) { console.error(`✖ Node ${process.versions.node} is too old; code2spec needs 22.5+ (24 recommended)`); process.exit(1) }'

echo "▸ Installing dependencies"
pnpm install

echo "▸ Building dashboard and engine"
pnpm build

# The global install runs with the user's own npm (not inside a pnpm script, where npm would
# target pnpm's private Node). Installing a packed tarball makes a real copy, which also works with Volta.
echo "▸ Installing the code2spec command"
mkdir -p .pack
version=$(node -p "require('./packages/engine/package.json').version")
(cd packages/engine && npm pack --silent --pack-destination ../../.pack >/dev/null)
npm install -g "./.pack/code2spec-engine-${version}.tgz"
hash -r 2>/dev/null || true

if command -v code2spec >/dev/null 2>&1; then
  echo "✔ Installed. Next: code2spec doctor"
else
  echo "! Installed, but 'code2spec' is not on your PATH. Add \"$(npm prefix -g)/bin\" to PATH, then open a new terminal." >&2
fi
