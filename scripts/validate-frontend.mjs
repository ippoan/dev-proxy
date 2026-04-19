#!/usr/bin/env node
// validate-frontend.mjs — called from ci-workflows/frontend-ci.yml's embedded
// "Dev Proxy Validate" job in each frontend repo's PR CI. Enforces that the
// repo's .ippoan-dev.yaml declaration matches a pre-registered entry in
// ippoan/dev-proxy/registry.json.
//
// Model: registry.json is the *source of truth* (hand-curated). Each frontend
// repo's yaml is a local declaration that must mirror its registry entry.
//
// Usage:
//   node validate-frontend.mjs <spec_file> <repo_name>
import { readFileSync } from 'node:fs'

const REGISTRY_URL = 'https://raw.githubusercontent.com/ippoan/dev-proxy/main/registry.json'

const [, , specFile, repoName] = process.argv
if (!specFile || !repoName) {
  console.error('usage: validate-frontend.mjs <spec_file> <repo_name>')
  process.exit(2)
}

let specText
try {
  specText = readFileSync(specFile, 'utf8')
} catch (e) {
  console.error(`✗ cannot read ${specFile}: ${e.message}`)
  process.exit(1)
}

// Minimal YAML parser (sufficient for flat key: value spec).
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

let spec
try {
  spec = parseFlatYaml(specText)
} catch (e) {
  console.error(`✗ ${specFile}: ${e.message}`)
  process.exit(1)
}

// 1. Static checks on the yaml itself (before touching the registry).
const nameRe = /^[a-z0-9][a-z0-9_-]*$/
const staticErrors = []
if (typeof spec.name !== 'string' || !nameRe.test(spec.name)) staticErrors.push('name must match [a-z0-9][a-z0-9_-]*')
if (spec.name !== repoName) staticErrors.push(`name=${spec.name} != repo=${repoName} (must match GitHub repo name)`)
if (!Number.isInteger(spec.port) || spec.port < 1024 || spec.port > 65535) staticErrors.push('port must be 1024-65535')
if (spec.cmd !== undefined && typeof spec.cmd !== 'string') staticErrors.push('cmd must be string')
if (spec.subdir !== undefined && typeof spec.subdir !== 'string') staticErrors.push('subdir must be string')
if (staticErrors.length) {
  console.error(`✗ ${specFile}`)
  for (const e of staticErrors) console.error(`  - ${e}`)
  process.exit(1)
}

// 2. Fetch registry and enforce registration + exact match.
const res = await fetch(REGISTRY_URL, { headers: { Accept: 'application/json' } })
if (!res.ok) {
  console.error(`✗ cannot fetch registry (${res.status}): ${REGISTRY_URL}`)
  process.exit(1)
}
const registry = await res.json()
const { frontends = [] } = registry

// Helper: treat undefined subdir same as empty string.
const normSubdir = (v) => (typeof v === 'string' ? v : '')

// Entry is identified by repo (owner/name). This makes entries portable across
// forks while preserving 1:1 mapping.
const ownerRepo = process.env.GITHUB_REPOSITORY /* "ippoan/<name>" in CI */
  || `ippoan/${repoName}`
const entry = frontends.find((f) => f.repo === ownerRepo)

if (!entry) {
  const used = new Set(frontends.map((f) => f.port))
  const suggested = []
  for (let p = 3011; p <= 3099 && suggested.length < 5; p++) {
    if (!used.has(p)) suggested.push(p)
  }
  console.error(`✗ ${ownerRepo} is not registered in ippoan/dev-proxy/registry.json`)
  console.error('')
  console.error('  Open a PR against ippoan/dev-proxy first to add:')
  console.error('')
  console.error('    {')
  console.error(`      "name":   "${spec.name}",`)
  console.error(`      "port":   ${spec.port},`)
  console.error(`      "repo":   "${ownerRepo}",`)
  console.error(`      "subdir": "${normSubdir(spec.subdir)}"`)
  console.error('    }')
  console.error('')
  console.error(`  Free ports (3011-3099): ${suggested.join(', ') || 'all taken'}`)
  process.exit(1)
}

const mismatches = []
if (entry.name !== spec.name) mismatches.push(`name: registry=${entry.name} vs yaml=${spec.name}`)
if (entry.port !== spec.port) mismatches.push(`port: registry=${entry.port} vs yaml=${spec.port}`)
if (normSubdir(entry.subdir) !== normSubdir(spec.subdir)) {
  mismatches.push(`subdir: registry=${JSON.stringify(normSubdir(entry.subdir))} vs yaml=${JSON.stringify(normSubdir(spec.subdir))}`)
}
if (mismatches.length) {
  console.error(`✗ ${ownerRepo} yaml does not match registry entry:`)
  for (const m of mismatches) console.error(`  - ${m}`)
  console.error('')
  console.error('  Either fix .ippoan-dev.yaml in this repo, or update the')
  console.error('  entry in ippoan/dev-proxy/registry.json.')
  process.exit(1)
}

console.log(`✓ ${ownerRepo} name=${spec.name} port=${spec.port} subdir=${JSON.stringify(normSubdir(spec.subdir))}`)
