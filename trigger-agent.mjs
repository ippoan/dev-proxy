#!/usr/bin/env node
// dev-proxy trigger-agent
// Caddy の handle_errors で呼ばれ、未起動 dev server を up.sh で起動し待機画面を返す。
import http from 'node:http'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, statSync } from 'node:fs'
import path from 'node:path'

const PORT = 3099
const ROOT = path.dirname(new URL(import.meta.url).pathname)
const PROJECTS_JSON = path.join(ROOT, 'projects.json')
const WAITING_HTML_PATH = path.join(ROOT, 'waiting.html')
const UP_SH = path.join(ROOT, 'up.sh')
const DOWN_SH = path.join(ROOT, 'down.sh')
const PIDS_DIR = path.join(ROOT, '.pids')
const LOGS_DIR = path.join(ROOT, 'logs')
const IDLE_KILL_MS = parseInt(process.env.IDLE_KILL_MS || '900000', 10) // default 15 min
const REAPER_INTERVAL_MS = parseInt(process.env.REAPER_INTERVAL_MS || '60000', 10) // check every 1 min

function loadProjects() {
  return JSON.parse(readFileSync(PROJECTS_JSON, 'utf8'))
}

function isRunning(name) {
  const pidfile = path.join(PIDS_DIR, `${name}.pid`)
  if (!existsSync(pidfile)) return false
  try {
    const pid = parseInt(readFileSync(pidfile, 'utf8').trim(), 10)
    if (!pid) return false
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const spawning = new Set()

function startProject(name) {
  if (spawning.has(name)) {
    console.log(`[agent] already spawning ${name}, skipping`)
    return
  }
  spawning.add(name)
  console.log(`[agent] spawning up.sh ${name}`)
  const child = spawn(UP_SH, [name], {
    cwd: ROOT,
    detached: true,
    stdio: 'ignore',
  })
  child.unref()
  child.on('close', (code) => {
    console.log(`[agent] up.sh ${name} exited with ${code}`)
    spawning.delete(name)
  })
  child.on('error', (err) => {
    console.error(`[agent] up.sh ${name} spawn error:`, err.message)
    spawning.delete(name)
  })
}

function renderWaiting(project) {
  const tmpl = readFileSync(WAITING_HTML_PATH, 'utf8')
  return tmpl.replaceAll('{{PROJECT}}', project)
}

function resolveProjectFromHost(host) {
  if (!host) return null
  const base = host.toLowerCase().split(':')[0]
  const m = base.match(/^([a-z0-9_-]+)\.dev\.ippoan\.org$/)
  return m ? m[1] : null
}

const server = http.createServer((req, res) => {
  const headerName = req.headers['x-project-name']
  const hostHeader = req.headers['x-forwarded-host'] || req.headers.host
  const name = (Array.isArray(headerName) ? headerName[0] : headerName)
    || resolveProjectFromHost(hostHeader)

  if (!name) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('project name not resolved from X-Project-Name or Host')
    return
  }

  const projects = loadProjects()
  if (!projects[name]) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end(`unknown project: ${name}`)
    return
  }

  if (!isRunning(name)) {
    startProject(name)
  }

  const html = renderWaiting(name)
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  res.end(html)
})

function renderCaddyConfig(name, port) {
  return `http://${name}.dev.ippoan.org:3000, http://${name}-dev.ippoan.org:3000 {
\tlog {
\t\toutput file ${LOGS_DIR}/access-${name}.log {
\t\t\troll_size 10mb
\t\t\troll_keep 2
\t\t}
\t\tformat json
\t}
\t# dev では HMR / 即時反映のため Cloudflare にキャッシュさせない
\theader Cache-Control "no-store, no-cache, must-revalidate"
\theader CDN-Cache-Control "no-store"
\treverse_proxy localhost:${port}
\thandle_errors {
\t\treverse_proxy localhost:${PORT} {
\t\t\theader_up X-Project-Name ${name}
\t\t}
\t}
}
`
}

function ensureCaddyConfigs() {
  const projects = loadProjects()
  const caddyDir = path.join(ROOT, 'projects')
  if (!existsSync(caddyDir)) mkdirSync(caddyDir, { recursive: true })
  if (!existsSync(LOGS_DIR)) mkdirSync(LOGS_DIR, { recursive: true })
  let generated = 0
  let updated = 0
  for (const [name, info] of Object.entries(projects)) {
    const configPath = path.join(caddyDir, `${name}.caddy`)
    const expected = renderCaddyConfig(name, info.port)
    if (!existsSync(configPath)) {
      writeFileSync(configPath, expected)
      generated++
      continue
    }
    // 古いフォーマット (log ブロック未 / dash alias 未 / no-store ヘッダ未) の場合は上書き
    const current = readFileSync(configPath, 'utf8')
    if (
      !current.includes('log {')
      || !current.includes(`access-${name}.log`)
      || !current.includes(`${name}-dev.ippoan.org`)
      || !current.includes('no-store')
    ) {
      writeFileSync(configPath, expected)
      updated++
    }
  }
  return { generated, updated }
}

function isPortListening(port) {
  return new Promise((resolve) => {
    const socket = new net.Socket()
    socket.setTimeout(500)
    socket.once('connect', () => { socket.destroy(); resolve(true) })
    socket.once('timeout', () => { socket.destroy(); resolve(false) })
    socket.once('error', () => { resolve(false) })
    socket.connect(port, '127.0.0.1')
  })
}

function accessLogMtime(name) {
  const logPath = path.join(LOGS_DIR, `access-${name}.log`)
  if (!existsSync(logPath)) return null
  try {
    return statSync(logPath).mtimeMs
  } catch {
    return null
  }
}

function pidfileMtime(name) {
  const pidfile = path.join(PIDS_DIR, `${name}.pid`)
  if (!existsSync(pidfile)) return null
  try {
    return statSync(pidfile).mtimeMs
  } catch {
    return null
  }
}

function killProject(name) {
  console.log(`[reaper] killing idle project: ${name}`)
  const child = spawn(DOWN_SH, [name], {
    cwd: ROOT,
    stdio: 'inherit',
  })
  child.on('error', (err) => {
    console.error(`[reaper] down.sh ${name} error:`, err.message)
  })
}

async function reapIdle() {
  let projects
  try {
    projects = loadProjects()
  } catch {
    return
  }
  const now = Date.now()
  for (const [name, info] of Object.entries(projects)) {
    // port 使用中か確認 (dev 起動中)
    const listening = await isPortListening(info.port)
    if (!listening) continue
    // lastTouch = max(アクセスログ mtime, pidfile mtime)
    // 両方見る理由:
    //   - 起動直後は access log が古いままなので pidfile mtime を見ないと誤殺される
    //   - アクセスがあれば access log mtime が更新されるので生きてると判定できる
    const lastAccess = accessLogMtime(name)
    const lastPid = pidfileMtime(name)
    const candidates = [lastAccess, lastPid].filter(v => v != null)
    if (candidates.length === 0) continue
    const lastTouch = Math.max(...candidates)
    const idleMs = now - lastTouch
    if (idleMs > IDLE_KILL_MS) {
      console.log(`[reaper] ${name} idle ${Math.round(idleMs / 60000)} min > ${Math.round(IDLE_KILL_MS / 60000)} min → stop`)
      killProject(name)
    }
  }
}

const CADDY_BIN = process.env.CADDY_BIN
  || (existsSync('/home/yhonda/.local/bin/caddy') ? '/home/yhonda/.local/bin/caddy' : 'caddy')

function reloadCaddy() {
  const child = spawn(CADDY_BIN, ['reload', '--config', path.join(ROOT, 'Caddyfile'), '--adapter', 'caddyfile'], {
    stdio: 'ignore',
  })
  child.on('error', (err) => {
    console.error(`[agent] caddy reload failed:`, err.message)
  })
}

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[agent] listening on localhost:${PORT}`)
  try {
    const projects = loadProjects()
    console.log(`[agent] known projects: ${Object.keys(projects).join(', ')}`)
    const { generated, updated } = ensureCaddyConfigs()
    if (generated > 0 || updated > 0) {
      console.log(`[agent] caddy configs: generated ${generated}, updated ${updated} → reload`)
      reloadCaddy()
    }
  } catch (e) {
    console.error(`[agent] bootstrap error:`, e.message)
  }
  if (!existsSync(WAITING_HTML_PATH)) {
    console.error(`[agent] warning: waiting.html not found at ${WAITING_HTML_PATH}`)
  }
  const files = existsSync(ROOT) ? readdirSync(ROOT).filter(f => f.endsWith('.sh')).join(', ') : ''
  console.log(`[agent] scripts: ${files}`)
  console.log(`[agent] reaper: idle kill after ${Math.round(IDLE_KILL_MS / 60000)} min (check every ${Math.round(REAPER_INTERVAL_MS / 1000)} s)`)
  // 最初の 1 分後から開始 (起動直後は無視)
  setTimeout(() => {
    reapIdle().catch(e => console.error('[reaper] error:', e.message))
    setInterval(() => {
      reapIdle().catch(e => console.error('[reaper] error:', e.message))
    }, REAPER_INTERVAL_MS)
  }, REAPER_INTERVAL_MS)
})
