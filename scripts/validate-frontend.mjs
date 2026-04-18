#!/usr/bin/env node
// validate-frontend.mjs — called from ci-workflows/dev-proxy-validate.yml in
// each frontend repo's PR CI. Validates the repo's .ippoan-dev.yaml against
// the dev-proxy registry and fails fast on port conflicts.
//
// Usage:
//   node validate-frontend.mjs <spec_file> <repo_name>
//
// Checks:
//   1. spec file exists and is valid YAML
//   2. spec.name matches the repo name (prevent accidental mismatch)
//   3. spec.port is in the free range and not taken by another repo
//   4. existing entry (if any) for this repo has matching port
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
// Avoids adding a dependency to a GitHub Actions reusable workflow.
function parseFlatYaml(text) {
  const out = {}
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/#.*$/, '').trimEnd()
    if (!line.trim()) continue
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/)
    if (!m) {
      throw new Error(`unexpected line: ${rawLine}`)
    }
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

const errors = []
const nameRe = /^[a-z0-9][a-z0-9_-]*$/
if (typeof spec.name !== 'string' || !nameRe.test(spec.name)) errors.push('name must match [a-z0-9][a-z0-9_-]*')
if (spec.name !== repoName) errors.push(`name=${spec.name} != repo=${repoName} (must match)`)
if (!Number.isInteger(spec.port) || spec.port < 1024 || spec.port > 65535) errors.push('port must be 1024-65535')
if (spec.cmd !== undefined && typeof spec.cmd !== 'string') errors.push('cmd must be string')
if (spec.subdir !== undefined && typeof spec.subdir !== 'string') errors.push('subdir must be string')

if (errors.length) {
  console.error(`✗ ${specFile}`)
  for (const e of errors) console.error(`  - ${e}`)
  process.exit(1)
}

// Fetch registry and check port collision.
const res = await fetch(REGISTRY_URL, { headers: { Accept: 'application/json' } })
if (!res.ok) {
  console.error(`✗ cannot fetch registry (${res.status}): ${REGISTRY_URL}`)
  process.exit(1)
}
const registry = await res.json()
const { frontends = [] } = registry

const conflicting = frontends.find((f) => f.port === spec.port && f.name !== spec.name)
if (conflicting) {
  const used = new Set(frontends.map((f) => f.port))
  const suggested = []
  for (let p = 3011; p <= 3099 && suggested.length < 3; p++) {
    if (!used.has(p) || p === spec.port) suggested.push(p)
  }
  console.error(`✗ port ${spec.port} already taken by ${conflicting.repo} (${conflicting.name})`)
  console.error(`  free ports near 3011-3099: ${suggested.join(', ')}`)
  process.exit(1)
}

const existing = frontends.find((f) => f.name === spec.name)
if (existing && existing.port !== spec.port) {
  console.error(`✗ ${spec.name} is registered with port=${existing.port}; PR declares port=${spec.port}.`)
  console.error(`  Either revert to ${existing.port} or change the registry entry first.`)
  process.exit(1)
}

console.log(`✓ ${spec.name} port=${spec.port}`)
