# dev-proxy

複数 frontend の dev server を port 3000 の Caddy reverse proxy で Host ヘッダ分岐する on-demand 起動機構。

- URL: `https://<name>-dev.ippoan.org`
- アクセス時に未起動なら `./up.sh <name>` を自動 spawn（`trigger-agent.mjs` 経由）
- 15 分間アクセスが無い project は `./down.sh` で自動停止

## 構成

- `Caddyfile` — :3000 bind、`projects/*.caddy` を import
- `projects/<name>.caddy` — `trigger-agent` が `projects.json` から自動生成
- `projects.json` — 各 host の実データ (`dir` / `port` / `cmd`)。gitignore
- `registry.json` — **source of truth**: name / port / repo / subdir の登録簿 (手動 PR 管理)
- `trigger-agent.mjs` — port 3099 の on-demand 起動 agent
- `waiting.html` — 「起動中」待機画面
- `up.sh` / `down.sh` / `up-all.sh` / `down-all.sh` / `status.sh`
- `systemd/*.service.in` — systemd unit テンプレート
- `scripts/install.sh` — unit のレンダリング + enable
- `scripts/validate-projects.mjs` — `projects.json` schema validate
- `scripts/validate-frontend.mjs` — frontend の `.ippoan-dev.yaml` を registry と照合 (CI 用)
- `scripts/create-access-app.mjs` / `verify-access-app.mjs` — Cloudflare Access wildcard app の作成・検証

## セットアップ

```bash
# Caddy と Node.js を先にインストール
# https://caddyserver.com/docs/install
# node >= 20

# 1. 設定
cp .env.example .env
# DEV_PROXY_ROOT / CADDY_BIN / NODE_BIN / PROJECTS_ROOT を埋める

# 2. systemd unit 生成と有効化
bash scripts/install.sh

# 3. projects.json を用意（Phase 3 完了後は自動同期）
cp projects.json.example projects.json
# 必要なエントリを追記

# 4. 動作確認
curl -H "Host: example-nuxt-dev.ippoan.org" http://127.0.0.1:3000/
```

## Cloudflare 連携

- Tunnel: 各 `<name>-dev.ippoan.org` を `http://localhost:3000` にルーティング（Dashboard or API）
- Access (Phase 2): wildcard `*-dev.ippoan.org` に Allow policy を 1 個作成（`scripts/create-access-app.mjs`、Phase 2 で追加予定）

## アイドル自動停止

`trigger-agent.mjs` が 1 分おきに `logs/access-<name>.log` mtime をチェック、閾値以上未更新なら `down.sh`。

- `IDLE_KILL_MS` (ms, default 900000) で閾値変更
- `REAPER_INTERVAL_MS` (default 60000) で確認間隔変更

## 新 frontend 追加手順

1. この repo に PR で `registry.json` に entry を追加（port を予約）:
   ```json
   { "name": "my-app", "port": 3050, "repo": "ippoan/my-app", "subdir": "" }
   ```
2. 対象 frontend repo に `.ippoan-dev.yaml` を追加（registry entry と一致必須）:
   ```yaml
   name: my-app
   port: 3050
   cmd: "PORT=$PORT HOST=0.0.0.0 npm run dev"
   ```
3. 以降の frontend PR は `ci / Dev Proxy Validate` で registry との一致が検証される
4. host 側: `projects.json` に `dir/port/cmd` を手動追加 + Cloudflare Tunnel Public Hostname を追加 → `./up.sh <name>`

yaml と registry が食い違ったまま merge されることは CI がブロックする。

## トラブル

- `caddy reload` 失敗 → `caddy validate --config Caddyfile --adapter caddyfile`
- 502 → `logs/<name>.log` + port 競合を `ss -tlnp` で確認
- systemd 再起動後 dev server が生き残る → `down.sh` で port 直 kill（pidfile は bash wrapper の pid なので）
