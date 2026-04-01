#!/bin/bash
# Rendezvous Server updater -- downloads the latest GitHub Release and swaps the binary.
#
# Usage:
#   ./update.sh                  # update to latest
#   ./update.sh relay-v1.2.0    # update to specific tag
#
# For private repos, set GITHUB_TOKEN:
#   export GITHUB_TOKEN=ghp_xxxx
#   ./update.sh
#
# Prerequisites: curl, tar, jq  (apt install -y curl tar jq)

set -euo pipefail

REPO="andyisdandyy/Voip"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ASSET_NAME="RendezvousServer-linux-x64.tar.gz"
TAG="${1:-}"

# -- Build auth header if token is set ---------------------
AUTH_HEADER=""
if [ -n "${GITHUB_TOKEN:-}" ]; then
    AUTH_HEADER="Authorization: token ${GITHUB_TOKEN}"
fi

curl_gh() {
    if [ -n "$AUTH_HEADER" ]; then
        curl -sL -H "$AUTH_HEADER" "$@"
    else
        curl -sL "$@"
    fi
}

# -- Resolve download URL ----------------------------------
if [ -z "$TAG" ]; then
    echo "Fetching latest rendezvous release..."
    # Filter to relay-v* tags only -- skip VoipServer (v*) and client (client-v*) releases
    RELEASE_JSON=$(curl_gh "https://api.github.com/repos/${REPO}/releases" \
        | jq '[.[] | select(.tag_name | startswith("relay-v"))] | first')
else
    echo "Fetching release ${TAG}..."
    RELEASE_JSON=$(curl_gh "https://api.github.com/repos/${REPO}/releases/tags/${TAG}")
fi

# Check for API errors
API_MESSAGE=$(echo "$RELEASE_JSON" | jq -r ".message // empty")
if [ -n "$API_MESSAGE" ]; then
    echo "ERROR: GitHub API returned: ${API_MESSAGE}"
    if echo "$API_MESSAGE" | grep -qi "not found"; then
        echo ""
        echo "  Possible causes:"
        echo "  - No relay-v* releases exist yet (push a tag: git tag relay-v1.0.0 && git push origin relay-v1.0.0)"
        echo "  - The repo is private -- set GITHUB_TOKEN first:"
        echo "    export GITHUB_TOKEN=ghp_your_token_here"
    fi
    exit 1
fi

if [ "$RELEASE_JSON" = "null" ]; then
    echo "ERROR: No relay-v* releases found."
    echo "  Push to master to trigger an automatic build."
    exit 1
fi

DOWNLOAD_URL=$(echo "$RELEASE_JSON" | jq -r ".assets[]? | select(.name == \"${ASSET_NAME}\") | .browser_download_url")
RELEASE_TAG=$(echo "$RELEASE_JSON" | jq -r ".tag_name")

if [ -z "$DOWNLOAD_URL" ] || [ "$DOWNLOAD_URL" = "null" ]; then
    echo "ERROR: Release ${RELEASE_TAG:-${TAG:-latest}} exists but has no '${ASSET_NAME}' asset."
    echo "  The GitHub Actions build may still be running. Check:"
    echo "  https://github.com/${REPO}/actions"
    exit 1
fi

# -- Check current version ---------------------------------
VERSION_FILE="${SCRIPT_DIR}/.version"
if [ -f "$VERSION_FILE" ]; then
    CURRENT=$(cat "$VERSION_FILE")
    if [ "$CURRENT" = "$RELEASE_TAG" ]; then
        echo "Already on ${RELEASE_TAG} -- nothing to do."
        exit 0
    fi
    echo "Updating ${CURRENT} -> ${RELEASE_TAG}"
else
    echo "Installing ${RELEASE_TAG}"
fi

# -- Download and extract ----------------------------------
TMP=$(mktemp -d)
echo "Downloading..."
curl_gh -H "Accept: application/octet-stream" "$DOWNLOAD_URL" -o "${TMP}/${ASSET_NAME}"
tar xzf "${TMP}/${ASSET_NAME}" -C "$TMP"

# -- Swap binary -------------------------------------------
cp "${TMP}/RendezvousServer" "${SCRIPT_DIR}/RendezvousServer"
chmod +x "${SCRIPT_DIR}/RendezvousServer"
echo "$RELEASE_TAG" > "$VERSION_FILE"

rm -rf "$TMP"

echo ""
echo "Done. Updated to ${RELEASE_TAG}"
echo "  Restart the rendezvous server to use the new version."