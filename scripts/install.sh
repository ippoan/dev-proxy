#!/usr/bin/env bash
# install.sh — render systemd units from templates and enable services.
# Usage: bash scripts/install.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$ROOT/.env"

if [ ! -f "$ENV_FILE" ]; then
	echo "error: $ENV_FILE not found. cp .env.example .env and edit it first." >&2
	exit 1
fi

set -a
# shellcheck source=/dev/null
. "$ENV_FILE"
set +a

: "${DEV_PROXY_ROOT:?DEV_PROXY_ROOT missing}"
: "${DOCKER_BIN:=/usr/bin/docker}"
: "${NODE_BIN:?NODE_BIN missing}"

if [ ! -x "$DOCKER_BIN" ]; then
	echo "error: DOCKER_BIN=$DOCKER_BIN not executable" >&2
	exit 1
fi
if ! "$DOCKER_BIN" compose version >/dev/null 2>&1; then
	echo "error: '$DOCKER_BIN compose' plugin not available" >&2
	exit 1
fi
if [ ! -x "$NODE_BIN" ]; then
	echo "error: NODE_BIN=$NODE_BIN not executable" >&2
	exit 1
fi

UNIT_DIR="$HOME/.config/systemd/user"
mkdir -p "$UNIT_DIR"

render() {
	local src="$1" dest="$2"
	sed \
		-e "s|@DEV_PROXY_ROOT@|$DEV_PROXY_ROOT|g" \
		-e "s|@DOCKER_BIN@|$DOCKER_BIN|g" \
		-e "s|@NODE_BIN@|$NODE_BIN|g" \
		"$src" > "$dest"
	echo "rendered: $dest"
}

render "$ROOT/systemd/dev-proxy.service.in"       "$UNIT_DIR/dev-proxy.service"
render "$ROOT/systemd/dev-proxy-agent.service.in" "$UNIT_DIR/dev-proxy-agent.service"

mkdir -p "$ROOT/.pids" "$ROOT/logs" "$ROOT/projects"

systemctl --user daemon-reload
systemctl --user enable dev-proxy.service dev-proxy-agent.service
systemctl --user restart dev-proxy.service dev-proxy-agent.service
systemctl --user status --no-pager dev-proxy.service dev-proxy-agent.service | head -20

echo ""
echo "done. listen check:"
ss -tlnp 2>/dev/null | grep -E ':(3000|3099)\b' || true
