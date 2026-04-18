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

# shellcheck disable=SC1090
set -a; source "$ENV_FILE"; set +a

: "${DEV_PROXY_ROOT:?DEV_PROXY_ROOT missing}"
: "${CADDY_BIN:?CADDY_BIN missing}"
: "${NODE_BIN:?NODE_BIN missing}"

if [ ! -x "$CADDY_BIN" ]; then
	echo "error: CADDY_BIN=$CADDY_BIN not executable" >&2
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
		-e "s|@CADDY_BIN@|$CADDY_BIN|g" \
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
