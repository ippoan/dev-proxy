#!/usr/bin/env node
// validate projects.json schema.
// Usage: node scripts/validate-projects.mjs <path-to-projects.json>
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'

const [, , target] = process.argv
const file = target || path.join(process.cwd(), 'projects.json')
if (!existsSync(file)) {
  console.error(`error: ${file} not found`)
  process.exit(1)
}

const raw = readFileSync(file, 'utf8')
let data
try {
  data = JSON.parse(raw)
} catch (e) {
  console.error(`error: invalid JSON: ${e.message}`)
  process.exit(1)
}

const errors = []
const seenPorts = new Map()
const nameRe = /^[a-z0-9][a-z0-9_-]*$/

for (const [name, info] of Object.entries(data)) {
  if (!nameRe.test(name)) errors.push(`${name}: invalid name (allowed: [a-z0-9][a-z0-9_-]*)`)
  if (!info || typeof info !== 'object') { errors.push(`${name}: entry not object`); continue }
  if (typeof info.dir !== 'string' || !info.dir.startsWith('/')) errors.push(`${name}: dir must be absolute path`)
  if (!Number.isInteger(info.port) || info.port < 1024 || info.port > 65535) errors.push(`${name}: port must be 1024-65535`)
  if (typeof info.cmd !== 'string' || info.cmd.length === 0) errors.push(`${name}: cmd required`)
  if (info.port && seenPorts.has(info.port)) {
    errors.push(`${name}: port ${info.port} conflicts with ${seenPorts.get(info.port)}`)
  } else if (info.port) {
    seenPorts.set(info.port, name)
  }
}

if (errors.length) {
  console.error(`✗ ${file}`)
  for (const e of errors) console.error(`  - ${e}`)
  process.exit(1)
}
console.log(`✓ ${file} (${Object.keys(data).length} entries)`)
