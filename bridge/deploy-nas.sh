#!/bin/bash
# Install or update the Signal Glass bridge on the Synology NAS (Docker).
# Needs key-based SSH to the NAS.
#
#   bridge/deploy-nas.sh             deploy or update, then print the admin page address
#   bridge/deploy-nas.sh restart     restart both containers (after linking Signal, if it asks)
#   bridge/deploy-nas.sh logs        last lines of both logs
#   bridge/deploy-nas.sh remove      stop and remove both containers (data stays in $DIR)
#   NAS=user@host RELAY_URL=https://… bridge/deploy-nas.sh
#
# Two containers on a private Docker network:
#   signalglass-api      bbernhard/signal-cli-rest-api, the Signal client. No published port.
#   signalglass-bridge   stock node image with bridge/ mounted read-only. Admin page on $PORT, LAN only.
# The Signal keys live in $DIR/signal-cli, the stored messages in $DIR/data. Both stay on the NAS.
set -euo pipefail
cd "$(dirname "$0")/.."
NAS="${NAS:-admin@192.168.1.48}"
DIR="${DIR:-/volume1/docker/signalglass}"
PORT="${PORT:-8790}"
NODE_IMAGE="node:22-alpine"
SIGNAL_IMAGE="bbernhard/signal-cli-rest-api:latest"
NAS_IP="${NAS#*@}"
SSH="ssh -o BatchMode=yes -o ConnectTimeout=8 $NAS"
D="/usr/local/bin/docker"

case "${1:-deploy}" in
  restart) $SSH "$D restart signalglass-api signalglass-bridge"; exit 0 ;;
  logs)    $SSH "$D logs --tail 30 signalglass-api 2>&1; echo; $D logs --tail 30 signalglass-bridge 2>&1 | sed 's/k=[a-f0-9]*/k=…/'"; exit 0 ;;
  remove)  $SSH "$D rm -f signalglass-api signalglass-bridge; $D network rm signalglass 2>/dev/null || true"; exit 0 ;;
  deploy)  ;;
  *) echo "unknown command: $1"; exit 1 ;;
esac

# The relay address is the same one the glasses app uses.
RELAY_URL="${RELAY_URL:-$(sed -n "s/.*: '\(https:[^']*\)'.*/\1/p" site/config.js | head -1)}"
[ -n "$RELAY_URL" ] || { echo "No relay address. Deploy the Worker first (README.md, step 1) or pass RELAY_URL=…"; exit 1; }

echo "→ copying bridge to $NAS:$DIR"
$SSH "mkdir -p '$DIR/app' '$DIR/data' '$DIR/signal-cli' && chmod 700 '$DIR/data' '$DIR/signal-cli'"
COPYFILE_DISABLE=1 tar --no-xattrs -czf - -C bridge bridge.js admin.html | $SSH "tar -xzf - -C '$DIR/app'"

echo "→ starting containers"
$SSH "$D network inspect signalglass >/dev/null 2>&1 || $D network create signalglass >/dev/null
  $D rm -f signalglass-api signalglass-bridge >/dev/null 2>&1
  $D run -d --name signalglass-api --restart unless-stopped --network signalglass --memory 400m \
    -v '$DIR/signal-cli':/home/.local/share/signal-cli \
    -e MODE=json-rpc-native -e JSON_RPC_IGNORE_ATTACHMENTS=true -e JSON_RPC_IGNORE_STORIES=true \
    -e JSON_RPC_IGNORE_AVATARS=true -e JSON_RPC_IGNORE_STICKERS=true \
    $SIGNAL_IMAGE >/dev/null
  $D run -d --name signalglass-bridge --restart unless-stopped --network signalglass --memory 128m \
    -p $PORT:8790 -v '$DIR/app':/app:ro -v '$DIR/data':/data -v /etc/localtime:/etc/localtime:ro \
    -e SIGNAL_API=http://signalglass-api:8080 -e RELAY_URL='$RELAY_URL' -e DATA_DIR=/data \
    $NODE_IMAGE node /app/bridge.js >/dev/null"

echo "→ waiting for the bridge"
KEY=""
for _ in $(seq 1 30); do
  KEY="$($SSH "$D logs signalglass-bridge 2>&1" | sed -n 's/.*admin page on port.*k=\([a-f0-9]*\).*/\1/p' | tail -1)"
  [ -n "$KEY" ] && break
  sleep 2
done
[ -n "$KEY" ] || { echo "bridge did not come up; see: bridge/deploy-nas.sh logs"; exit 1; }

# The address holds the admin key, so it goes to a private file, not to the terminal.
LINK_FILE="$HOME/Library/Application Support/SignalGlass/admin-link.txt"
mkdir -p "$(dirname "$LINK_FILE")"
(umask 077; echo "http://$NAS_IP:$PORT/?k=$KEY" > "$LINK_FILE")
echo "✓ bridge is running. Admin page address saved to:"
echo "  $LINK_FILE"
echo "  Open it with:  open \"\$(cat '$LINK_FILE')\""
