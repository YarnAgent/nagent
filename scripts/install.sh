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

# Install spec. We intentionally use the plain codeload tarball URL rather
# than `github:YarnAgent/nagent#<ref>`. With the `github:` shorthand, npm/pacote
# leaves `lib/node_modules/nagent` as a dangling symlink into its
# `_cacache/tmp/git-clone*` dir (which is wiped post-install) — so npm reports
# success but `nagent --version` is "command not found". The codeload URL
# avoids that path and materializes the package correctly.
NAGENT_INSTALL_REF="${NAGENT_INSTALL_REF:-main}"
REPO="${NAGENT_INSTALL_REPO:-https://codeload.github.com/YarnAgent/nagent/tar.gz/${NAGENT_INSTALL_REF}}"

case "$(uname -s)" in
  Darwin|Linux) ;;
  *) die "nagent supports macOS and Linux only (got $(uname -s))." ;;
esac

# `curl ... | bash` does not source ~/.zshrc, so users with Node managed by
# nvm/fnm/mise see only the system PATH — often a stale Node. Source the
# common managers if present so the prereq check sees the user's real toolchain.
if [ -z "${NVM_DIR:-}" ] && [ -s "${HOME}/.nvm/nvm.sh" ]; then
  export NVM_DIR="${HOME}/.nvm"
  # shellcheck disable=SC1091
  \. "${NVM_DIR}/nvm.sh" >/dev/null 2>&1 || true
fi
if [ -s "${HOME}/.local/share/fnm/fnm" ] && command -v fnm >/dev/null 2>&1; then
  eval "$(fnm env --use-on-cd 2>/dev/null || true)"
fi
if [ -d "${HOME}/.local/share/mise" ] && command -v mise >/dev/null 2>&1; then
  eval "$(mise env -s sh 2>/dev/null || true)"
fi

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

# Locate the installed binary. `command -v` only sees PATH; we also probe
# `npm config get prefix` directly so we can report a helpful message when
# the install succeeded but the prefix isn't on the caller's shell PATH
# (common in curl-piped installs on a fresh nvm setup).
NPM_PREFIX="$(npm config get prefix 2>/dev/null || true)"
NAGENT_BIN=""
if command -v nagent >/dev/null 2>&1; then
  NAGENT_BIN="$(command -v nagent)"
elif [ -n "${NPM_PREFIX}" ] && [ -x "${NPM_PREFIX}/bin/nagent" ]; then
  NAGENT_BIN="${NPM_PREFIX}/bin/nagent"
fi

if [ -z "${NAGENT_BIN}" ]; then
  die "install completed but the bin can't be located.

  npm config get prefix → ${NPM_PREFIX:-<empty>}
  Expected at:           ${NPM_PREFIX}/bin/nagent (not present or not executable)

  Try \`npm root -g\` to confirm where node_modules landed."
fi

ok "installed: ${NAGENT_BIN}"
ok "version: $(${NAGENT_BIN} --version)"

# Detect a likely-missing PATH entry and print actionable hints.
case ":${PATH}:" in
  *":${NPM_PREFIX}/bin:"*)
    PATH_OK=1
    ;;
  *)
    PATH_OK=0
    ;;
esac

if [ "${PATH_OK}" = "0" ]; then
  PROFILE_HINT="~/.zshrc (zsh) or ~/.bashrc (bash)"
  cat <<EOF

${BLUE}Note:${RESET} ${NPM_PREFIX}/bin is not on your shell PATH right now.
You can either:

  • Run nagent by full path:
       ${NAGENT_BIN} --version

  • Open a NEW terminal window — npm-via-nvm usually fixes itself there.

  • Add this line to ${PROFILE_HINT} and restart your shell:
       export PATH="${NPM_PREFIX}/bin:\$PATH"

EOF
fi

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
