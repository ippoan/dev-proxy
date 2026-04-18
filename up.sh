#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
name="${1:?usage: up.sh <project>}"

entry=$(jq -r --arg k "$name" '.[$k] // "null"' "$ROOT/projects.json")
if [ "$entry" = "null" ]; then
	echo "unknown project: $name" >&2
	echo "known projects:" >&2
	jq -r 'keys[]' "$ROOT/projects.json" >&2
	exit 1
fi

dir=$(echo "$entry" | jq -r '.dir')
port=$(echo "$entry" | jq -r '.port')
cmd=$(echo "$entry" | jq -r '.cmd')

pidfile="$ROOT/.pids/$name.pid"
logfile="$ROOT/logs/$name.log"

if [ -f "$pidfile" ] && kill -0 "$(cat "$pidfile")" 2>/dev/null; then
	echo "already running: $name (pid=$(cat "$pidfile"), port=$port)"
	exit 0
fi

if [ ! -d "$dir" ]; then
	echo "dir not found: $dir" >&2
	exit 1
fi

cd "$dir"
PORT=$port nohup bash -c "$cmd" >"$logfile" 2>&1 &
echo $! >"$pidfile"

cat >"$ROOT/projects/$name.caddy" <<EOF
http://$name.dev.ippoan.org:3000, http://$name-dev.ippoan.org:3000 {
	log {
		output file $ROOT/logs/access-$name.log {
			roll_size 10mb
			roll_keep 2
		}
		format json
	}
	# dev では HMR / 即時反映のため Cloudflare にキャッシュさせない
	header Cache-Control "no-store, no-cache, must-revalidate"
	header CDN-Cache-Control "no-store"
	reverse_proxy localhost:$port
	handle_errors {
		reverse_proxy localhost:3099 {
			header_up X-Project-Name $name
		}
	}
}
EOF

if curl -sf localhost:2019/config/ >/dev/null 2>&1; then
	caddy reload --config "$ROOT/Caddyfile" --adapter caddyfile 2>&1 || {
		echo "caddy reload failed; config file is updated but not applied" >&2
	}
fi

echo "up: $name → localhost:$port"
echo "  https://$name.dev.ippoan.org"
echo "  tail -f $logfile"
