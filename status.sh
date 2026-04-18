#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"

if curl -sf localhost:2019/config/ >/dev/null 2>&1; then
	echo "caddy:   RUNNING (admin :2019, public :3000)"
else
	echo "caddy:   DOWN"
fi
echo ""

printf "%-20s %-6s %-20s %s\n" "PROJECT" "PORT" "STATE" "URL"
printf "%-20s %-6s %-20s %s\n" "-------" "----" "-----" "---"

jq -r 'to_entries[] | "\(.key)\t\(.value.port)"' "$ROOT/projects.json" |
	while IFS=$'\t' read -r name port; do
		pidfile="$ROOT/.pids/$name.pid"
		state="DOWN"
		if [ -f "$pidfile" ] && kill -0 "$(cat "$pidfile")" 2>/dev/null; then
			state="UP (pid=$(cat "$pidfile"))"
		fi
		printf "%-20s %-6s %-20s https://%s-dev.ippoan.org\n" "$name" "$port" "$state" "$name"
	done
