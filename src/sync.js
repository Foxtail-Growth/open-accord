// Sync one room over Hyperswarm. The room is a topic only its members know: sha256(roomId:secret).
// Frames are newline-delimited JSON:
//   have {ids}        what I hold; the peer answers with everything I lack, in batches
//   entries {list}    entries, parents first
//   want {ids}        entries I'm missing parents for
//   wantblobs {hashes} / blobs {list}   file contents, asked for once the entry that names them is stored
// A relay (opt-in, run by a member) is used only when a direct connection fails.
// New local entries are found by polling the database, so writes from another process get sent too.
import Hyperswarm from 'hyperswarm'
import { sha256 } from './crypto.js'

const MAX_LINE = 32 * 1024 * 1024
const BATCH_BYTES = 4 * 1024 * 1024 // an accord caps files at 8 MB, so a base64 file always fits a frame
const POLL_MS = 500
const MAX_WANT = 200

export const topicFor = (room) => Buffer.from(sha256(`${room.id}:${room.secret}`), 'hex')

export function startSync (store, roomId, { relays = [], bootstrap, log = () => {} } = {}) {
  const room = store.room(roomId)
  const swarm = new Hyperswarm({ bootstrap, ...(relays.length ? { relayThrough: relays.map((k) => Buffer.from(k, 'hex')) } : {}) })
  const conns = new Set()
  let lastN = 0
  let everConnected = false
  const startedAt = Date.now()

  const send = (c, frame) => { if (!c.conn.destroyed) c.conn.write(JSON.stringify(frame) + '\n') }
  const blobRefs = () => new Map([...store.entryMap(roomId).values()].filter((e) => e.type === 'blob').map((e) => [e.body.hash, e.body.size]))

  function sendEntries (c, list) {
    let batch = []
    let bytes = 0
    for (const e of list) {
      batch.push(e)
      bytes += JSON.stringify(e).length
      if (bytes > BATCH_BYTES) { send(c, { t: 'entries', list: batch }); batch = []; bytes = 0 }
    }
    if (batch.length) send(c, { t: 'entries', list: batch })
  }

  // Send a connection whatever it lacks from `entries` (default: the whole log).
  function push (c, entries = store.entries(roomId)) {
    if (!c.known) return
    const list = entries.filter((e) => !c.known.has(e.id))
    if (!list.length) return
    sendEntries(c, list)
    for (const e of list) c.known.add(e.id)
  }

  // Ask for file contents of stored blob entries whose bytes we lack.
  function wantBlobs (c) {
    const now = Date.now()
    const need = [...blobRefs().keys()].filter((h) => !store.hasBlob(h) && !(c.asked.get(h) > now - 10_000)).slice(0, MAX_WANT)
    if (!need.length) return
    for (const h of need) c.asked.set(h, now)
    send(c, { t: 'wantblobs', hashes: need })
  }

  function onFrame (c, f) {
    if (f.t === 'have') {
      if (f.room !== roomId || !Array.isArray(f.ids)) return c.conn.destroy()
      c.known = new Set(f.ids)
      push(c)
    } else if (f.t === 'entries' && Array.isArray(f.list)) {
      const missing = new Set()
      for (const e of f.list) {
        if (typeof e?.id === 'string') c.known?.add(e.id)
        const r = store.ingest(roomId, e)
        if (r.status === 'rejected') log(`rejected ${e?.type} from ${String(e?.author).slice(0, 8)}: ${r.reason}`)
        for (const p of r.missing || []) missing.add(p)
      }
      for (const id of [...missing]) if (store.has(roomId, id)) missing.delete(id)
      if (missing.size) send(c, { t: 'want', ids: [...missing].slice(0, MAX_WANT) })
      wantBlobs(c)
    } else if (f.t === 'want' && Array.isArray(f.ids)) {
      const m = store.entryMap(roomId)
      sendEntries(c, f.ids.slice(0, MAX_WANT).map((id) => m.get(id)).filter(Boolean))
    } else if (f.t === 'wantblobs' && Array.isArray(f.hashes)) {
      const refs = blobRefs()
      let frame = []
      let size = 0
      for (const hash of f.hashes.slice(0, MAX_WANT)) {
        const data = refs.has(hash) && store.blob(hash)
        if (!data) continue
        frame.push({ hash, data: data.toString('base64') })
        size += data.length
        if (size > BATCH_BYTES) { send(c, { t: 'blobs', list: frame }); frame = []; size = 0 }
      }
      if (frame.length) send(c, { t: 'blobs', list: frame })
    } else if (f.t === 'blobs' && Array.isArray(f.list)) {
      const refs = blobRefs()
      for (const { hash, data } of f.list) {
        const buf = Buffer.from(String(data), 'base64')
        if (refs.get(hash) === buf.length && sha256(buf) === hash) store.putBlob(buf)
      }
    }
  }

  // Frames are queued and handled one per tick: nothing awaits inside the stream's data handler.
  function drain (c) {
    if (c.draining) return
    c.draining = true
    const next = () => {
      const line = c.queue.shift()
      if (line === undefined) { c.draining = false; return }
      try { onFrame(c, JSON.parse(line)) } catch (err) { log(`bad frame: ${err.message}`) }
      setImmediate(next)
    }
    setImmediate(next)
  }

  swarm.on('connection', (conn) => {
    const c = { conn, known: null, asked: new Map(), buf: '', queue: [], draining: false }
    conns.add(c)
    everConnected = true
    log('peer connected')
    conn.setEncoding('utf8')
    conn.on('error', () => {})
    conn.on('close', () => { conns.delete(c); log('peer disconnected') })
    conn.on('data', (chunk) => {
      c.buf += chunk
      let i
      while ((i = c.buf.indexOf('\n')) >= 0) { c.queue.push(c.buf.slice(0, i)); c.buf = c.buf.slice(i + 1) }
      if (c.buf.length > MAX_LINE) return conn.destroy()
      drain(c)
    })
    send(c, { t: 'have', room: roomId, ids: [...store.entryMap(roomId).keys()] })
  })

  let tick = 0
  const timer = setInterval(() => {
    store.releaseFuture()
    const rows = store.newSince(roomId, lastN)
    if (rows.length) {
      lastN = rows.at(-1).n
      const fresh = rows.map((r) => r.e)
      for (const c of conns) push(c, fresh)
    }
    if (++tick % 10 === 0) for (const c of conns) wantBlobs(c) // retry blobs that didn't arrive
  }, POLL_MS)

  // Two nodes that start at the same moment can miss each other's announcement; look again until connected,
  // and now and then afterwards so a third member who arrives later is found too.
  const discovery = swarm.join(topicFor(room))
  let lastLook = Date.now()
  const looker = setInterval(() => {
    if (!conns.size || Date.now() - lastLook > 60_000) { lastLook = Date.now(); discovery.refresh().catch(() => {}) }
  }, 5000)
  return {
    swarm,
    peers: () => conns.size,
    // true once we've waited a minute and never reached anyone
    lonely: () => !everConnected && Date.now() - startedAt > 60_000,
    ready: discovery.flushed(),
    stop: async () => { clearInterval(timer); clearInterval(looker); await swarm.destroy() }
  }
}
