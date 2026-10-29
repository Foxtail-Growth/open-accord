// Outbound lint: runs on your own node before your delegate's entry is signed.
// A hit holds the entry for your approval; it is a backstop, the real wall is what you granted.

const BUILTIN = [
  ['an Anthropic API key', /sk-ant-[A-Za-z0-9_-]{20,}/],
  ['an API key (sk-...)', /\bsk-[A-Za-z0-9]{32,}/],
  ['a GitHub token', /\b(?:ghp|gho|ghs|ghu|ghr)_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}/],
  ['an AWS access key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['a Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ['a Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['a private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['a JWT', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ['a bearer token', /\bBearer\s+[A-Za-z0-9._~+/-]{30,}/],
  ['a secret assignment', /\b(?:api[_-]?key|secret|token|password|passwd)\b["']?\s*[:=]\s*["']?[A-Za-z0-9_\-/+=]{16,}/i]
]

// Custom entries: plain text (case-insensitive) or /regex/flags.
function matcher (entry) {
  const m = /^\/(.+)\/([a-z]*)$/.exec(entry)
  if (m) return new RegExp(m[1], m[2])
  return new RegExp(entry.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
}

// Throws if the pattern can't be used, so a typo is caught when it is added, not ignored later.
export const checkPattern = (entry) => { if (!entry || !matcher(entry)) throw new Error('empty pattern') }

export function textsOf (body) {
  return Object.values(body).filter((v) => typeof v === 'string')
}

// Returns a one-line reason, or null if nothing matched.
export function lintTexts (texts, custom = []) {
  const snip = (m) => `"${m[0].slice(0, 12)}…"`
  for (const text of texts) {
    for (const [name, re] of BUILTIN) { const m = re.exec(text); if (m) return `looks like ${name} (${snip(m)})` }
    for (const c of custom) { const m = matcher(c).exec(text); if (m) return `matches your blocked pattern ${c} (${snip(m)})` }
  }
  return null
}

export const customPatterns = (store, room) => JSON.parse(store.get(room, 'lint') || '[]')
