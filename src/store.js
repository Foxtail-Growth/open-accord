// Local storage and the room log. One SQLite file per person; node:sqlite only.
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { newIdentity, signEntry, checkSignature, sha256, randomHex } from './crypto.js'
import { checkEntry } from './accord.js'

export const defaultHome = () => process.env.OPEN_ACCORD_HOME || join(homedir(), '.open-accord')

const MAX_PENDING = 1000 // entries waiting for a missing parent or a clock
const MAX_PENDING_PER_AUTHOR = 100
// Entries stamped further ahead than this are held until the clock catches up (see README, "Limits").
const MAX_SKEW_MS = 5 * 60_000

export class Store {
  constructor (home = defaultHome()) {
    mkdirSync(home, { recursive: true, mode: 0o700 })
    this.home = home
    this.db = new DatabaseSync(join(home, 'accord.db'))
    this.db.exec(`
      PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS rooms (id TEXT PRIMARY KEY, secret TEXT NOT NULL, join_token TEXT, created_at INTEGER);
      CREATE TABLE IF NOT EXISTS entries (n INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, room TEXT NOT NULL, author TEXT NOT NULL, seq INTEGER NOT NULL, json TEXT NOT NULL, UNIQUE (room, author, seq));
      CREATE TABLE IF NOT EXISTS blobs (hash TEXT PRIMARY KEY, data BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS grants (room TEXT NOT NULL, path TEXT NOT NULL, PRIMARY KEY (room, path));
      CREATE TABLE IF NOT EXISTS held (id INTEGER PRIMARY KEY AUTOINCREMENT, room TEXT NOT NULL, type TEXT NOT NULL, body TEXT NOT NULL, reason TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS kv (room TEXT NOT NULL, k TEXT NOT NULL, v TEXT, PRIMARY KEY (room, k));
    `)
    this.cache = new Map() // room -> Map(id -> entry)
    this.pending = new Map() // id -> entry waiting for parents
    this.future = new Map() // id -> entry stamped ahead of our clock
  }

  close () { this.db.close() }

  identity () {
    const file = join(this.home, 'identity.json')
    if (!existsSync(file)) {
      writeFileSync(file, JSON.stringify(newIdentity()), { mode: 0o600, flag: 'wx' })
      chmodSync(file, 0o600)
    }
    return JSON.parse(readFileSync(file, 'utf8'))
  }

  // ── rooms ──
  addRoom (id, secret, joinToken = null) {
    this.db.prepare('INSERT OR IGNORE INTO rooms (id, secret, join_token, created_at) VALUES (?, ?, ?, ?)').run(id, secret, joinToken, Date.now())
  }

  room (id) { return this.db.prepare('SELECT * FROM rooms WHERE id = ?').get(id) }
  rooms () { return this.db.prepare('SELECT * FROM rooms ORDER BY created_at').all() }
  findRoom (prefix) {
    const rows = this.db.prepare('SELECT id FROM rooms WHERE id LIKE ?').all(prefix + '%')
    if (rows.length !== 1) throw new Error(rows.length ? `room id ${prefix} is ambiguous` : `no room ${prefix}`)
    return rows[0].id
  }

  get (room, k) { return this.db.prepare('SELECT v FROM kv WHERE room = ? AND k = ?').get(room, k)?.v ?? null }
  set (room, k, v) { this.db.prepare('INSERT OR REPLACE INTO kv (room, k, v) VALUES (?, ?, ?)').run(room, k, v) }

  // ── entries ──
  // Cached per room, topped up from the database on every access so writes by another process show up.
  entryMap (room) {
    let c = this.cache.get(room)
    if (!c) this.cache.set(room, c = { map: new Map(), n: 0 })
    for (const r of this.db.prepare('SELECT n, json FROM entries WHERE room = ? AND n > ? ORDER BY n').all(room, c.n)) {
      const e = JSON.parse(r.json)
      c.map.set(e.id, e)
      c.n = r.n
    }
    return c.map
  }

  has (room, id) { return this.entryMap(room).has(id) }
  entries (room) { return order([...this.entryMap(room).values()]) }
  heads (room) {
    const m = this.entryMap(room)
    const referenced = new Set()
    for (const e of m.values()) for (const p of e.prev) referenced.add(p)
    return [...m.keys()].filter((id) => !referenced.has(id)).sort()
  }

  history (room, prev) {
    const m = this.entryMap(room)
    const seen = new Set()
    const stack = [...prev]
    while (stack.length) {
      const id = stack.pop()
      if (seen.has(id)) continue
      seen.add(id)
      stack.push(...m.get(id).prev)
    }
    return order([...seen].map((id) => m.get(id)))
  }

  // Check and store an entry from anywhere. Never throws on bad input.
  ingest (room, e) {
    const reason = this._shape(room, e)
    if (reason) return { status: 'rejected', reason }
    const m = this.entryMap(room)
    if (m.has(e.id)) return { status: 'known' }
    if (e.ts > Date.now() + MAX_SKEW_MS) {
      if (this.future.size < MAX_PENDING) this.future.set(e.id, { room, e })
      return { status: 'held', reason: 'timestamp is ahead of this clock' }
    }
    const missing = e.prev.filter((p) => !m.has(p))
    if (missing.length) {
      // Kept in memory only; the sync layer asks the peer for `missing`, and a reconnect re-sends the rest.
      const mine = [...this.pending.values()].filter((x) => x.e.author === e.author).length
      if (this.pending.has(e.id) || (this.pending.size < MAX_PENDING && mine < MAX_PENDING_PER_AUTHOR)) this.pending.set(e.id, { room, e })
      else return { status: 'dropped', reason: 'too many entries waiting for missing parents' }
      return { status: 'pending', missing }
    }
    const history = this.history(room, e.prev)
    const verdict = this._chain(m, history, e) || checkEntry(e, history)
    if (verdict) return { status: 'rejected', reason: verdict }
    try {
      this.db.prepare('INSERT INTO entries (id, room, author, seq, json) VALUES (?, ?, ?, ?, ?)').run(e.id, room, e.author, e.seq, JSON.stringify(e))
    } catch {
      // another process wrote at the same moment; look again
      return this.entryMap(room).has(e.id) ? { status: 'known' } : { status: 'rejected', reason: 'conflicting write, try again' }
    }
    this.entryMap(room)
    this.pending.delete(e.id)
    // Snapshot: re-ingesting may put an entry straight back (it can wait on several parents).
    for (const [id, p] of [...this.pending]) if (p.room === room && p.e.prev.includes(e.id)) { this.pending.delete(id); this.ingest(room, p.e) }
    return { status: 'accepted' }
  }

  // Retry entries that were stamped ahead of our clock. Held entries are delayed, never judged.
  releaseFuture () {
    for (const [id, f] of this.future) {
      if (f.e.ts <= Date.now() + MAX_SKEW_MS) { this.future.delete(id); this.ingest(f.room, f.e) }
    }
  }

  _shape (room, e) {
    if (!e || typeof e !== 'object' || e.v !== 1) return 'bad entry'
    if (!Array.isArray(e.prev) || !Number.isInteger(e.seq) || !Number.isInteger(e.ts) || typeof e.type !== 'string') return 'bad entry'
    if (e.prev.length > 100 || e.prev.some((p) => typeof p !== 'string') || e.seq < 0 || e.ts < 0) return 'bad entry'
    if (!e.body || typeof e.body !== 'object' || Array.isArray(e.body) || JSON.stringify(e).length > 100_000) return 'bad entry'
    if (!checkSignature(e)) return 'bad signature'
    if (e.type === 'open' ? e.room !== '' || e.id !== room : e.room !== room) return 'wrong room'
    return null
  }

  // Each author's entries form one chain: seq counts up and each entry has seen the author's previous one.
  _chain (m, history, e) {
    const mine = [...m.values()].filter((x) => x.author === e.author)
    if (mine.some((x) => x.seq === e.seq)) return 'author forked their own chain'
    if (e.seq !== mine.length) return 'author sequence gap'
    const last = mine.find((x) => x.seq === e.seq - 1)
    if (last && !history.some((h) => h.id === last.id)) return "entry has not seen the author's previous entry"
    if (last && e.ts < last.ts) return 'timestamp went backwards'
    return null
  }

  // Create, sign and store an entry by this person. Throws with the accord's reason if refused.
  append (room, type, body, via = 'person') {
    const id = this.identity()
    const m = this.entryMap(room)
    const mine = [...m.values()].filter((x) => x.author === id.publicKey)
    const lastTs = Math.max(0, ...mine.map((x) => x.ts))
    const unsigned = { v: 1, room: type === 'open' ? '' : room, type, author: id.publicKey, seq: mine.length, prev: this.heads(room), ts: Math.max(Date.now(), lastTs), via, body }
    const e = signEntry(unsigned, id)
    if (type === 'open') return e // caller ingests under the new room id
    const r = this.ingest(room, e)
    if (r.status !== 'accepted') throw new Error(r.reason || r.status)
    return e
  }

  openRoom (accord) {
    const e = this.append(null, 'open', { accord })
    const secret = randomHex(32) // topic secret; only invitees learn it
    this.addRoom(e.id, secret)
    const r = this.ingest(e.id, e)
    if (r.status !== 'accepted') throw new Error(r.reason)
    return e.id
  }

  lastN (room) { return this.db.prepare('SELECT MAX(n) AS n FROM entries WHERE room = ?').get(room).n ?? 0 }

  // Would the accord allow this entry from us right now? Returns the reason, or null. Stores nothing.
  check (room, type, body, via) {
    const m = this.entryMap(room)
    const me = this.identity().publicKey
    const mine = [...m.values()].filter((x) => x.author === me)
    const e = { v: 1, room, type, author: me, seq: mine.length, prev: this.heads(room), ts: Date.now(), via, body }
    return checkEntry(e, this.history(room, e.prev))
  }

  newSince (room, n) {
    return this.db.prepare('SELECT n, json FROM entries WHERE room = ? AND n > ? ORDER BY n').all(room, n).map((r) => ({ n: r.n, e: JSON.parse(r.json) }))
  }

  // ── blobs ──
  putBlob (data) {
    const hash = sha256(data)
    this.db.prepare('INSERT OR IGNORE INTO blobs (hash, data) VALUES (?, ?)').run(hash, data)
    return hash
  }

  // Forget stored bytes nothing in the log refers to (a discarded held post).
  dropBlob (hash) {
    for (const rows of this.db.prepare('SELECT room FROM rooms').all()) if ([...this.entryMap(rows.room).values()].some((e) => e.type === 'blob' && e.body.hash === hash)) return
    this.db.prepare('DELETE FROM blobs WHERE hash = ?').run(hash)
  }

  blob (hash) {
    const row = this.db.prepare('SELECT data FROM blobs WHERE hash = ?').get(hash)
    return row ? Buffer.from(row.data) : null
  }
  hasBlob (hash) { return !!this.db.prepare('SELECT 1 FROM blobs WHERE hash = ?').get(hash) }

  // ── entries held for the person's approval (outbound lint) ──
  hold (room, type, body, reason) {
    return Number(this.db.prepare('INSERT INTO held (room, type, body, reason, at) VALUES (?, ?, ?, ?, ?)').run(room, type, JSON.stringify(body), reason, Date.now()).lastInsertRowid)
  }

  heldEntries (room) { return this.db.prepare('SELECT * FROM held WHERE room = ? ORDER BY id').all(room).map((r) => ({ ...r, body: JSON.parse(r.body) })) }

  takeHeld (room, id) {
    const r = this.heldEntries(room).find((h) => h.id === id)
    if (r) this.db.prepare('DELETE FROM held WHERE id = ?').run(id)
    return r
  }

  // ── grants (never leave this machine) ──
  grant (room, path) { this.db.prepare('INSERT OR IGNORE INTO grants (room, path) VALUES (?, ?)').run(room, path) }
  grants (room) { return this.db.prepare('SELECT path FROM grants WHERE room = ?').all(room).map((r) => r.path) }
}

// Deterministic causal order: parents first, ties broken by timestamp then id.
export function order (entries) {
  const byId = new Map(entries.map((e) => [e.id, e]))
  const waiting = new Map()
  const children = new Map()
  for (const e of entries) {
    const parents = e.prev.filter((p) => byId.has(p))
    waiting.set(e.id, parents.length)
    for (const p of parents) children.set(p, [...(children.get(p) || []), e.id])
  }
  const cmp = (a, b) => a.ts - b.ts || (a.id < b.id ? -1 : 1)
  const ready = entries.filter((e) => waiting.get(e.id) === 0).sort(cmp)
  const out = []
  while (ready.length) {
    const e = ready.shift()
    out.push(e)
    for (const c of children.get(e.id) || []) {
      waiting.set(c, waiting.get(c) - 1)
      if (waiting.get(c) === 0) { ready.push(byId.get(c)); ready.sort(cmp) }
    }
  }
  return out
}
