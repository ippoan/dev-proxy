#!/usr/bin/env node
// sync.mjs — regenerate registry.json from the current state of each frontend
// repo's .ippoan-dev.yaml. Intended to run in the dev-proxy sync.yml workflow
// on a schedule (and on repository_dispatch from frontend repos after merge).
//
// Additionally writes Phase 3 side effects when --apply is passed:
//   * --apply=projects: (host-local) write projects.json from registry + env
//   * --apply=auth-worker: emit a proposed wrangler.toml ALLOWED_REDIRECT_ORIGINS
//     append list so a PR can be opened against ippoan/auth-worker
//   * --apply=tunnel: push ingress entries to Cloudflare Tunnel via API
//
// Scope for the initial commit: only the read side (aggregate → stdout).
// The --apply modes are incremental and safe to add later; they are feature-
// flagged so sync.yml can adopt them one at a time.
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'

// Parse CLI args. Supports `--key=value`, `--key value`, and bare `--flag`.
const argv = {}
{
  const raw = process.argv.slice(2)
  for (let i = 0; i < raw.length; i++) {
    const a = raw[i]
    if (!a.startsWith('--')) continue
    const eq = a.indexOf('=')
    if (eq !== -1) {
      argv[a.slice(2, eq)] = a.slice(eq + 1)
    } else {
      const next = raw[i + 1]
      if (next !== undefined && !next.startsWith('--')) {
        argv[a.slice(2)] = next
        i++
      } else {
        argv[a.slice(2)] = true
      }
    }
  }
}

const GH_TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN
const ORG = argv.org || 'ippoan'
const OUT = argv.out || 'registry.json'

async function ghApi(endpoint) {
  const res = await fetch(`https://api.github.com${endpoint}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      ...(GH_TOKEN ? { Authorization: `Bearer ${GH_TOKEN}` } : {}),
    },
  })
  if (!res.ok) throw new Error(`GET ${endpoint} ${res.status}`)
  return res.json()
}

async function fetchRaw(repo, branch, pathInRepo) {
  const url = `https://raw.githubusercontent.com/${repo}/${branch}/${pathInRepo}`
  const res = await fetch(url)
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`GET ${url} ${res.status}`)
  return res.text()
}

function parseFlatYaml(text) {
  const out = {}
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/#.*$/, '').trimEnd()
    if (!line.trim()) continue
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/)
    if (!m) throw new Error(`unexpected line: ${rawLine}`)
    const [, key, valRaw] = m
    let val = valRaw.trim()
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1).replace(/\\"/g, '"')
    else if (val.startsWith("'") && val.endsWith("'")) val = val.slice(1, -1)
    else if (/^-?\d+$/.test(val)) val = Number(val)
    else if (val === 'true') val = true
    else if (val === 'false') val = false
    out[key] = val
  }
  return out
}

// 1. enumerate org repos
const repos = []
for (let page = 1; page < 20; page++) {
  const batch = await ghApi(`/orgs/${ORG}/repos?per_page=100&page=${page}`)
  if (!batch.length) break
  repos.push(...batch)
}

// 2. load existing registry so we can carry over entries for repos that
// haven't adopted .ippoan-dev.yaml yet. Only yaml-bearing repos are
// overwritten; repos that disappear from the org are dropped naturally
// because they don't appear in `repos` below.
const outPath = path.resolve(process.cwd(), OUT)
let existingByRepo = new Map()
if (existsSync(outPath)) {
  try {
    const prev = JSON.parse(readFileSync(outPath, 'utf8'))
    existingByRepo = new Map((prev.frontends || []).map((f) => [f.repo, f]))
  } catch {
    // first run or corrupt — proceed as if no prior state
  }
}

// 3. fetch each repo's .ippoan-dev.yaml (404 = not yet onboarded).
const frontends = []
for (const r of repos) {
  if (r.archived || r.disabled) continue
  const yaml = await fetchRaw(r.full_name, r.default_branch, '.ippoan-dev.yaml')
  if (yaml) {
    let spec
    try { spec = parseFlatYaml(yaml) } catch (e) {
      console.error(`skip ${r.full_name}: yaml parse error: ${e.message}`)
      continue
    }
    if (!spec.name || !spec.port) {
      console.error(`skip ${r.full_name}: missing name or port`)
      continue
    }
    frontends.push({
      name: String(spec.name),
      port: Number(spec.port),
      repo: r.full_name,
      subdir: spec.subdir ? String(spec.subdir) : '',
      ...(spec.cmd ? { cmd: String(spec.cmd) } : {}),
    })
  } else if (existingByRepo.has(r.full_name)) {
    // yaml not yet added — preserve the pre-seeded registry entry so the
    // reserved port is still recognised for conflict detection.
    frontends.push(existingByRepo.get(r.full_name))
  }
}

// Carry over any remaining existing entries that weren't seen in the loop
// (e.g. ohishi-exp / yhonda-ohishi-pub-dev repos, forks, archived repos).
// Ports reserved via manual bootstrap stay reserved until explicitly removed.
const seenRepos = new Set(frontends.map((f) => f.repo))
for (const [repoName, entry] of existingByRepo) {
  if (!seenRepos.has(repoName)) frontends.push(entry)
}

frontends.sort((a, b) => a.port - b.port)

// 4. detect conflicts (shouldn't happen if validate-frontend did its job)
const byPort = new Map()
const conflicts = []
for (const f of frontends) {
  if (byPort.has(f.port)) conflicts.push([byPort.get(f.port), f])
  byPort.set(f.port, f)
}
if (conflicts.length) {
  console.error('✗ port conflicts detected:')
  for (const [a, b] of conflicts) console.error(`  - ${a.repo} (${a.port}) vs ${b.repo} (${b.port})`)
  process.exit(1)
}

// 5. write registry.json
const payload = {
  $schema: './schema/registry.schema.json',
  description: 'Auto-generated by scripts/sync.mjs. Source: each ippoan repo .ippoan-dev.yaml (with carry-over for unadopted entries).',
  generated_at: new Date().toISOString(),
  frontends,
}

if (argv.dry || argv['dry-run']) {
  process.stdout.write(JSON.stringify(payload, null, 2) + '\n')
} else {
  writeFileSync(outPath, JSON.stringify(payload, null, 2) + '\n')
  console.error(`✓ wrote ${OUT} (${frontends.length} frontends)`)
}

// --apply modes deferred to a follow-up commit:
//   --apply=projects   — local projects.json (needs PROJECTS_ROOT env)
//   --apply=auth-worker — emit ALLOWED_REDIRECT_ORIGINS delta for a PR
//   --apply=tunnel     — push ingress to CF Tunnel API
if (argv.apply) {
  console.error(`note: --apply=${argv.apply} not yet implemented in this commit.`)
  process.exit(2)
}
