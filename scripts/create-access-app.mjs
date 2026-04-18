#!/usr/bin/env node
// create-access-app.mjs — idempotent creation/update of the *-dev.ippoan.org
// Cloudflare Access application with a single-email Allow policy.
//
// Required env:
//   CF_API_TOKEN   — token with Account > Access: Apps and Policies > Edit
//   CF_ACCOUNT_ID  — the Cloudflare account id
//   CF_ALLOW_EMAIL — the single email to allow through the wildcard app
// Optional env:
//   CF_APP_NAME    — default: "dev-proxy-wildcard"
//   CF_APP_DOMAIN  — default: "*-dev.ippoan.org"
//
// Idempotent: if an app with the same domain exists, update it instead of
// creating a duplicate. Returns 0 on success, writes the app id to stdout.

const {
  CF_API_TOKEN,
  CF_ACCOUNT_ID,
  CF_ALLOW_EMAIL,
  CF_APP_NAME = 'dev-proxy-wildcard',
  CF_APP_DOMAIN = '*-dev.ippoan.org',
} = process.env

for (const [k, v] of Object.entries({ CF_API_TOKEN, CF_ACCOUNT_ID, CF_ALLOW_EMAIL })) {
  if (!v) {
    console.error(`error: ${k} is required`)
    process.exit(1)
  }
}

const api = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/access`

async function cf(method, path, body) {
  const res = await fetch(`${api}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${CF_API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const json = await res.json()
  if (!json.success) {
    console.error(`CF API ${method} ${path} failed:`, JSON.stringify(json.errors))
    process.exit(1)
  }
  return json.result
}

const appBody = {
  name: CF_APP_NAME,
  domain: CF_APP_DOMAIN,
  type: 'self_hosted',
  session_duration: '24h',
  app_launcher_visible: false,
  allowed_idps: [],
  auto_redirect_to_identity: false,
}

const policyBody = {
  name: 'personal-only',
  decision: 'allow',
  include: [{ email: { email: CF_ALLOW_EMAIL } }],
  precedence: 1,
}

// 1. look up existing app by domain
const apps = await cf('GET', '/apps?per_page=1000')
const existing = apps.find((a) => a.domain === CF_APP_DOMAIN)

let appId
if (existing) {
  console.error(`updating existing app ${existing.id} (${existing.name})`)
  const updated = await cf('PUT', `/apps/${existing.id}`, appBody)
  appId = updated.id
} else {
  console.error(`creating app ${CF_APP_NAME} for ${CF_APP_DOMAIN}`)
  const created = await cf('POST', '/apps', appBody)
  appId = created.id
}

// 2. reconcile policies: ensure exactly one "personal-only" Allow policy
const policies = await cf('GET', `/apps/${appId}/policies`)
const myPolicy = policies.find((p) => p.name === policyBody.name)

if (myPolicy) {
  console.error(`updating policy ${myPolicy.id}`)
  await cf('PUT', `/apps/${appId}/policies/${myPolicy.id}`, policyBody)
} else {
  console.error(`creating policy ${policyBody.name}`)
  await cf('POST', `/apps/${appId}/policies`, policyBody)
}

// 3. delete stray policies (defense: prevent an accidentally-added Allow-All)
for (const p of policies) {
  if (p.name !== policyBody.name) {
    console.error(`deleting stray policy ${p.id} (${p.name})`)
    await cf('DELETE', `/apps/${appId}/policies/${p.id}`)
  }
}

console.log(appId)
