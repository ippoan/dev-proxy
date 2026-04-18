#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
name="${1:?usage: down.sh <project>}"

port=$(jq -r --arg k "$name" '.[$k].port // empty' "$ROOT/projects.json")

# port に listen しているプロセスを全部 kill
# (up.sh 由来の pidfile は bash wrapper のもので実 dev プロセスを取り逃がすため)
if [ -n "$port" ]; then
	pids=$(lsof -ti ":$port" 2>/dev/null || true)
	if [ -n "$pids" ]; then
		# 念のため子プロセスも含め、プロセスツリー全体を止める
		for pid in $pids; do
			pkill -TERM -P "$pid" 2>/dev/null || true
			kill -TERM "$pid" 2>/dev/null || true
		done
		sleep 0.5
		# 残っていれば KILL
		pids=$(lsof -ti ":$port" 2>/dev/null || true)
		if [ -n "$pids" ]; then
			for pid in $pids; do
				kill -KILL "$pid" 2>/dev/null || true
			done
		fi
	fi
fi

rm -f "$ROOT/.pids/$name.pid"

# NOTE: projects/$name.caddy は残す
# 残しておくことで次回アクセス時に handle_errors → trigger-agent で
# 自動起動が走る。完全にルートを消したい場合は手動で rm すること。

echo "down: $name"
