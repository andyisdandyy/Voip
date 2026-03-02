#!/bin/bash
# VoIP Server updater — downloads the latest GitHub Release and swaps the binary.
#
# Usage:
#   ./update.sh              # update to latest
#   ./update.sh v1.2.0       # update to specific tag
#
# Prerequisites: curl, tar, jq  (apt install -y curl tar jq)

set -euo pipefail

REPO="andyisdandyy/Voip"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ASSET_NAME="VoipServer-linux-x64.tar.gz"
TAG="${1:-}"

# ── Resolve download URL ─────────────────────────────────
if [ -z "$TAG" ]; then
    echo "Fetching latest release..."
    API_URL="https://api.github.com/repos/${REPO}/releases/latest"
else
    echo "Fetching release ${TAG}..."
    API_URL="https://api.github.com/repos/${REPO}/releases/tags/${TAG}"
fi

RELEASE_JSON=$(curl -sL "$API_URL")
DOWNLOAD_URL=$(echo "$RELEASE_JSON" | jq -r ".assets[] | select(.name == \"${ASSET_NAME}\") | .browser_download_url")
RELEASE_TAG=$(echo "$RELEASE_JSON" | jq -r ".tag_name")

if [ -z "$DOWNLOAD_URL" ] || [ "$DOWNLOAD_URL" = "null" ]; then
    echo "ERROR: Could not find ${ASSET_NAME} in release ${TAG:-latest}"
    exit 1
fi

# ── Check current version ────────────────────────────────
VERSION_FILE="${SCRIPT_DIR}/.version"
if [ -f "$VERSION_FILE" ]; then
    CURRENT=$(cat "$VERSION_FILE")
    if [ "$CURRENT" = "$RELEASE_TAG" ]; then
        echo "Already on ${RELEASE_TAG} — nothing to do."
        exit 0
    fi
    echo "Updating ${CURRENT} → ${RELEASE_TAG}"
else
    echo "Installing ${RELEASE_TAG}"
fi

# ── Download and extract ─────────────────────────────────
TMP=$(mktemp -d)
echo "Downloading..."
curl -sL "$DOWNLOAD_URL" -o "${TMP}/${ASSET_NAME}"
tar xzf "${TMP}/${ASSET_NAME}" -C "$TMP"

# ── Swap binary ──────────────────────────────────────────
cp "${TMP}/VoipServer" "${SCRIPT_DIR}/VoipServer"
chmod +x "${SCRIPT_DIR}/VoipServer"
echo "$RELEASE_TAG" > "$VERSION_FILE"

rm -rf "$TMP"

echo ""
echo "✓ Updated to ${RELEASE_TAG}"
echo "  Restart the server to use the new version."
