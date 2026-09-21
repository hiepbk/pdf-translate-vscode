#!/bin/sh
# Installs (or updates) the extension from the newest GitHub Release.
#
# For Linux, macOS, and the SSH/WSL/container hosts where VS Code runs a remote
# server — Settings Sync never syncs extensions to or from a remote window, so
# each host needs its own install.
#
#   curl -fsSL https://raw.githubusercontent.com/hiepbk/pdf-translate-vscode/main/install.sh | sh
#
# Re-running it updates to the newest release, so the same command serves both.

set -eu

REPO='hiepbk/pdf-translate-vscode'

fail() {
    echo "error: $1" >&2
    exit 1
}

command -v curl >/dev/null 2>&1 || fail "curl is required but not installed."

# On a remote host the CLI is often only on PATH inside VS Code's own terminal.
CODE="${CODE_BIN:-code}"
command -v "$CODE" >/dev/null 2>&1 || fail "could not find the '$CODE' command. Run this from VS Code's integrated terminal, or set CODE_BIN to its path."

echo "Looking up the newest release of $REPO..."
api="https://api.github.com/repos/${REPO}/releases/latest"

# Pull the .vsix asset URL out of the release JSON without requiring jq, which
# is not installed on a lot of bare servers.
url=$(curl -fsSL -H 'User-Agent: pdf-translate-installer' "$api" \
    | grep '"browser_download_url"' \
    | grep '\.vsix"' \
    | head -n 1 \
    | cut -d'"' -f4)

[ -n "$url" ] || fail "the newest release has no .vsix attached to it."

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

echo "Downloading $(basename "$url")..."
curl -fsSL "$url" -o "$tmp/extension.vsix"

echo "Installing into VS Code..."
"$CODE" --install-extension "$tmp/extension.vsix" --force

echo
echo "Installed. Reload VS Code to start using it:"
echo "  Ctrl+Shift+P -> Developer: Reload Window"
