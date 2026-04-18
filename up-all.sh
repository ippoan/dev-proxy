#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"

jq -r 'keys[]' "$ROOT/projects.json" | while read -r name; do
	"$ROOT/up.sh" "$name" || echo "failed: $name"
done
