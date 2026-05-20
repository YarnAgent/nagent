#!/usr/bin/env bash
# nagent installer — installs the `nagent` CLI on macOS or Linux.
#
# Usage:
#     curl -fsSL https://raw.githubusercontent.com/YarnAgent/nagent/main/scripts/install.sh | bash
#
# Prerequisites: Node.js >= 22, tmux >= 3.0, npm.

set -euo pipefail

BLUE=$'\033[34m'
RED=$'\033[31m'
GREEN=$'\033[32m'
RESET=$'\033[0m'

info()  { printf '%s\n' "${BLUE}nagent-install:${RESET} $*"; }
ok()    { printf '%s\n' "${GREEN}nagent-install:${RESET} $*"; }
die()   { printf '%s\n' "${RED}nagent-install:${RESET} $*" >&2; exit 1; }

REPO="${NAGENT_INSTALL_REPO:-github:YarnAgent/nagent#main}"

case "$(uname -s)" in
  Darwin|Linux) ;;
  *) die "nagent supports macOS and Linux only (got $(uname -s))." ;;
esac

command -v node >/dev/null 2>&1 || die "Node.js >= 22 is required. Install from https://nodejs.org/ or use nvm."

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [ "${NODE_MAJOR}" -lt 22 ]; then
  die "Node >= 22 required (you have $(node -v))."
fi

command -v npm >/dev/null 2>&1 || die "npm is required and must be on PATH."

if ! command -v tmux >/dev/null 2>&1; then
  die "tmux >= 3.0 is required.

  macOS:  brew install tmux
  Debian/Ubuntu:  sudo apt-get install -y tmux
  Fedora/RHEL:    sudo dnf install -y tmux"
fi

TMUX_VERSION="$(tmux -V 2>/dev/null | awk '{print $2}' | sed 's/[^0-9.]//g')"
case "$TMUX_VERSION" in
  3.*|4.*|5.*) ;;
  *) die "tmux >= 3.0 required (you have ${TMUX_VERSION:-unknown})." ;;
esac

if ! command -v ssh >/dev/null 2>&1; then
  die "ssh client (OpenSSH) is required for v0.2 multi-node features."
fi

info "installing nagent from ${REPO} ..."
npm install -g "${REPO}"

NAGENT_BIN="$(command -v nagent || true)"
if [ -z "${NAGENT_BIN}" ]; then
  die "install completed but \`nagent\` is not on PATH. Check your npm global bin (\`npm config get prefix\`/bin)."
fi

ok "installed: ${NAGENT_BIN}"
ok "version: $(${NAGENT_BIN} --version)"

cat <<'EOF'

Next steps:

  1) Start the picker (auto-bootstraps identity + default net + daemon):
       nagent

  2) Or join an existing net with a token from another node:
       nagent join <token>

  3) Cross-node attach (after joining):
       nagent attach <peer>/<session>

See README for more.
EOF
