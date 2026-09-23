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
EXTENSION_ID='hiepbk.pdf-translate'

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

# GitHub returns the release as compact JSON on a single line, so a pipeline of
# line-oriented greps sees the whole document as one line and a positional
# `cut` picks an arbitrary field out of it. That is not a hypothetical: this
# script once downloaded the release's own API URL and handed the JSON to
# `code --install-extension`, which reported "not a zip file".
#
# `grep -o` matches within the line instead, so it works whether the JSON is
# pretty-printed or not, and jq is not needed — bare servers rarely have it.
url=$(curl -fsSL -H 'User-Agent: pdf-translate-installer' "$api" \
    | grep -o '"browser_download_url"[[:space:]]*:[[:space:]]*"[^"]*\.vsix"' \
    | head -n 1 \
    | sed 's/.*"\(https[^"]*\)"$/\1/')

case "$url" in
    https://*.vsix) ;;
    *) fail "could not find a .vsix in the newest release (got: ${url:-nothing})." ;;
esac

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

echo "Downloading $(basename "$url")..."
curl -fsSL "$url" -o "$tmp/extension.vsix"

# A VSIX is a zip. Checking the signature turns "the download was not what we
# expected" into one clear line here, rather than a stack trace out of VS Code's
# zip reader several steps later.
if [ "$(head -c 2 "$tmp/extension.vsix")" != "PK" ]; then
    fail "the download is not a VSIX. The release asset may be wrong, or a proxy returned an error page."
fi

echo "Installing into VS Code..."
"$CODE" --install-extension "$tmp/extension.vsix" --force

# `code --install-extension` has been seen to exit 0 after printing "Failed
# Installing Extensions", so its exit status is not enough to go on. Asking
# what is installed is.
if "$CODE" --list-extensions >"$tmp/installed" 2>/dev/null; then
    grep -qi "^${EXTENSION_ID}\$" "$tmp/installed" \
        || fail "VS Code reported no error, but ${EXTENSION_ID} is not installed. Look above for its own message."
fi

echo
echo "Installed. Reload VS Code to start using it:"
echo "  Ctrl+Shift+P -> Developer: Reload Window"
