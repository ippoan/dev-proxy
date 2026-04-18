#!/usr/bin/env node
// verify-access-app.mjs — enforce check for the dev-proxy CF Access application.
// Fails (non-zero exit) if the wildcard app is missing, has no active policy,
// or if the Allow policy does not include the expected email.
//
// Required env:
//   CF_API_TOKEN, CF_ACCOUNT_ID, CF_ALLOW_EMAIL
// Optional env:
//   CF_APP_DOMAIN (default: "*-dev.ippoan.org")
//
// Intended to be called from a scheduled CI workflow so that accidental
// Dashboard deletion/weakening of the policy surfaces as an actionable alert.

const {
  CF_API_TOKEN,
  CF_ACCOUNT_ID,
  CF_ALLOW_EMAIL,
  CF_APP_DOMAIN = '*-dev.ippoan.org',
} = process.env

for (const [k, v] of Object.entries({ CF_API_TOKEN, CF_ACCOUNT_ID, CF_ALLOW_EMAIL })) {
  if (!v) { console.error(`error: ${k} is required`); process.exit(2) }
}

const api = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/access`

async function cf(path) {
  const res = await fetch(`${api}${path}`, {
    headers: { Authorization: `Bearer ${CF_API_TOKEN}` },
  })
  const json = await res.json()
  if (!json.success) {
    console.error(`CF API GET ${path} failed:`, JSON.stringify(json.errors))
    process.exit(2)
  }
  return json.result
}

const errors = []

const apps = await cf('/apps?per_page=1000')
const app = apps.find((a) => a.domain === CF_APP_DOMAIN)
if (!app) {
  console.error(`✗ no Access application with domain=${CF_APP_DOMAIN}`)
  process.exit(1)
}

if (app.type !== 'self_hosted') errors.push(`type=${app.type} (expected self_hosted)`)

const policies = await cf(`/apps/${app.id}/policies`)
const allowPolicies = policies.filter((p) => p.decision === 'allow')
if (allowPolicies.length === 0) errors.push('no Allow policy')

const coversExpected = allowPolicies.some((p) =>
  (p.include || []).some((r) => r.email && r.email.email === CF_ALLOW_EMAIL),
)
if (!coversExpected) errors.push(`no Allow policy includes email=${CF_ALLOW_EMAIL}`)

// Catch catastrophic weakening: any Allow policy that accepts "everyone" / open IP / etc.
for (const p of allowPolicies) {
  for (const rule of p.include || []) {
    if (rule.everyone !== undefined) errors.push(`policy "${p.name}" includes everyone`)
    if (rule.ip && rule.ip.ip === '0.0.0.0/0') errors.push(`policy "${p.name}" includes 0.0.0.0/0`)
  }
}

if (errors.length) {
  console.error(`✗ ${CF_APP_DOMAIN} (app id=${app.id})`)
  for (const e of errors) console.error(`  - ${e}`)
  process.exit(1)
}

console.log(`✓ ${CF_APP_DOMAIN} (app id=${app.id}, ${allowPolicies.length} allow policy)`)
