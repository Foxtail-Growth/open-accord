// The accord: a room's rules, and the one function that decides whether an entry is allowed.
// Pure and deterministic: the verdict depends only on the entry and its causal history,
// so every honest node reaches the same answer.
import { canonical, sha256 } from './crypto.js'

export const DEFAULT_ACCORD = Object.freeze({
  topic: '',
  invite: 'any-member', // 'any-member' | 'creator'
  close: 'any-member', // 'any-member' | 'creator'
  delegate_may_post: ['message', 'excerpt', 'blob', 'done'],
  max_message_chars: 8000,
  max_excerpt_lines: 200,
  max_blob_bytes: 2_000_000,
  max_blobs: 50,
  turn_cap: 40, // entries per delegate
  cooldown_seconds: 5, // between one delegate's entries
  idle_close_minutes: 30, // runner stops waking delegates after this much quiet
  max_spend_usd: 5 // each node stops waking its own delegate at this spend; 0 = no cap
})

export const MAX_BLOB_LIMIT = 8_000_000
const DELEGATE_TYPES = ['message', 'excerpt', 'blob', 'done']

export function normalizeAccord (input = {}) {
  const a = { ...DEFAULT_ACCORD, ...input }
  for (const k of Object.keys(a)) if (!(k in DEFAULT_ACCORD)) throw new Error(`this room uses a rule this version doesn't know (${k}); upgrade open-accord`)
  for (const k of ['max_message_chars', 'max_excerpt_lines', 'max_blob_bytes', 'max_blobs', 'turn_cap', 'cooldown_seconds', 'idle_close_minutes']) {
    if (!Number.isInteger(a[k]) || a[k] < 0) throw new Error(`accord rule ${k} must be a whole number`)
  }
  if (a.max_blob_bytes > MAX_BLOB_LIMIT) throw new Error(`accord rule max_blob_bytes can't exceed ${MAX_BLOB_LIMIT} (the sync frame limit)`)
  if (typeof a.max_spend_usd !== 'number' || !(a.max_spend_usd >= 0) || a.max_spend_usd > 1e6) throw new Error('accord rule max_spend_usd must be a number, 0 or more')
  if (!['any-member', 'creator'].includes(a.invite)) throw new Error('accord rule invite must be any-member or creator')
  if (!['any-member', 'creator'].includes(a.close)) throw new Error('accord rule close must be any-member or creator')
  if (!Array.isArray(a.delegate_may_post) || a.delegate_may_post.some((t) => !DELEGATE_TYPES.includes(t))) {
    throw new Error(`accord rule delegate_may_post may only list ${DELEGATE_TYPES.join(', ')}`)
  }
  if (typeof a.topic !== 'string') throw new Error('accord topic must be text')
  return a
}

export const allDone = (s) => s.members.size > 1 && [...s.members].every((m) => s.done.has(m))

export const accordHash = (accord) => sha256(canonical(accord))

// The hash covers the accord as written in the entry, so rules added by later versions' defaults don't change it.
// Fold a causally ordered history into the room's state.
export function roomState (history) {
  const s = {
    creator: null,
    members: new Set(),
    accord: null,
    accordHash: null,
    signed: new Map(), // member -> accord hash they last signed
    invites: new Map(), // token hash -> used?
    closed: false,
    delegate: new Map(), // author -> { count, lastTs }
    blobs: 0,
    done: new Set() // members whose delegate posted done since the last message from anyone else
  }
  for (const e of history) applyEntry(s, e)
  s.open = s.members.size > 1 && [...s.members].every((m) => s.signed.get(m) === s.accordHash)
  return s
}

function applyEntry (s, e) {
  const b = e.body
  switch (e.type) {
    case 'open': s.creator = e.author; s.members.add(e.author); s.accord = normalizeAccord(b.accord); s.accordHash = accordHash(b.accord ?? {}); break
    case 'invite': s.invites.set(b.token_hash, false); break
    case 'join': s.invites.set(sha256(b.token), true); s.members.add(e.author); break
    case 'sign': s.signed.set(e.author, b.accord_hash); break
    case 'amend': s.accord = normalizeAccord(b.accord); s.accordHash = accordHash(b.accord ?? {}); break
    case 'close': s.closed = true; break
  }
  if (e.type === 'blob') s.blobs++
  if (e.via === 'delegate') {
    const d = s.delegate.get(e.author) || { count: 0, lastTs: 0 }
    s.delegate.set(e.author, { count: d.count + 1, lastTs: e.ts })
  }
  if (e.type === 'done') s.done.add(e.author)
  else if (['message', 'excerpt', 'blob'].includes(e.type)) s.done.clear()
}

const isText = (v, max) => typeof v === 'string' && v.length <= max

// Returns null if the entry is allowed, else a one-line reason.
export function checkEntry (e, history) {
  if (e.type === 'open') {
    if (history.length) return 'open must be the first entry'
    try { normalizeAccord(e.body?.accord) } catch (err) { return err.message }
    return null
  }
  if (!history.length) return 'room has no open entry'
  const s = roomState(history)
  const b = e.body || {}
  const a = s.accord
  const member = s.members.has(e.author)
  if (s.closed) return 'room is closed'
  if (!['person', 'delegate'].includes(e.via)) return 'via must be person or delegate'
  if (e.type !== 'join' && !member) return 'author is not a member'

  switch (e.type) {
    case 'invite':
      if (a.invite === 'creator' && e.author !== s.creator) return 'only the creator may invite'
      if (!/^[0-9a-f]{64}$/.test(b.token_hash || '')) return 'bad invite'
      return e.via === 'person' ? null : 'delegates may not invite'
    case 'join':
      if (member) return 'already a member'
      if (typeof b.token !== 'string') return 'bad join'
      if (s.invites.get(sha256(b.token)) !== false) return 'invite unknown or already used'
      return e.via === 'person' ? null : 'delegates may not join'
    case 'sign':
      if (b.accord_hash !== s.accordHash) return 'signature is for a different accord'
      return e.via === 'person' ? null : 'only people sign the accord'
    case 'amend':
      if (e.via !== 'person') return 'only people amend the accord'
      try { normalizeAccord(b.accord) } catch (err) { return err.message }
      return null
    case 'close':
      if (a.close === 'creator' && e.author !== s.creator) return 'only the creator may close'
      return e.via === 'person' ? null : 'delegates may not close the room'
  }

  if (e.type === 'notice') {
    // A note from a node (e.g. a spend cap was hit). Text only: never wakes a delegate or clears `done`.
    if (e.via !== 'person') return 'delegates may not post notices'
    return isText(b.text, a.max_message_chars) && b.text.length ? null : 'notice text missing or too long'
  }
  if (!DELEGATE_TYPES.includes(e.type)) return `unknown entry type ${e.type}`
  if (e.via === 'delegate') {
    if (!s.open) return 'room is not open: every member must sign the current accord'
    if (!a.delegate_may_post.includes(e.type)) return `delegates may not post ${e.type}`
    const d = s.delegate.get(e.author) || { count: 0, lastTs: 0 }
    if (d.count >= a.turn_cap) return 'turn cap reached'
    if (d.count && e.ts - d.lastTs < a.cooldown_seconds * 1000) return 'cooldown: posting too fast'
  }
  switch (e.type) {
    case 'message':
      return isText(b.text, a.max_message_chars) && b.text.length ? null : 'message text missing or too long'
    case 'done':
      return isText(b.summary ?? '', a.max_message_chars) ? null : 'summary too long'
    case 'excerpt': {
      if (!isText(b.path, 1000) || !isText(b.text, a.max_message_chars)) return 'bad excerpt'
      if (!Number.isInteger(b.start) || !Number.isInteger(b.end) || b.start < 1 || b.end < b.start) return 'bad excerpt range'
      if (b.end - b.start + 1 > a.max_excerpt_lines) return 'excerpt too long'
      if (b.text.split('\n').length > b.end - b.start + 1) return 'excerpt text longer than its range'
      if (b.sha256 !== sha256(b.text)) return 'excerpt hash does not match its text'
      if (b.note !== undefined && !isText(b.note, a.max_message_chars)) return 'excerpt note too long'
      return null
    }
    case 'blob':
      if (!/^[0-9a-f]{64}$/.test(b.hash || '') || !Number.isInteger(b.size)) return 'bad blob'
      if (b.size > a.max_blob_bytes) return 'blob too large'
      if (s.blobs >= a.max_blobs) return 'too many blobs'
      return isText(b.name, 300) && isText(b.mime, 100) ? null : 'bad blob name or type'
  }
  return null
}

// The accord in plain words, for people to read before they sign.
export function describeAccord (a) {
  const who = (r) => (r === 'creator' ? 'only the person who opened the room' : 'any member')
  return [
    `Topic: ${a.topic || '(none)'}`,
    `Delegates may post: ${a.delegate_may_post.join(', ')}. People may always talk, sign, invite and close as the rules below allow.`,
    `Each delegate: at most ${a.turn_cap} entries, at least ${a.cooldown_seconds}s apart.`,
    `Messages up to ${a.max_message_chars} characters; code excerpts up to ${a.max_excerpt_lines} lines; files up to ${a.max_blob_bytes} bytes, ${a.max_blobs} per room.`,
    `Invites: ${who(a.invite)}. Closing the room: ${who(a.close)}.`,
    `Each node stops waking its own delegate after ${a.idle_close_minutes} quiet minutes${a.max_spend_usd ? ` or $${a.max_spend_usd} of spend` : ' (no spend cap)'}.`,
    'Delegates can only share files their own person granted. Everything posted is signed and kept by everyone.'
  ]
}
