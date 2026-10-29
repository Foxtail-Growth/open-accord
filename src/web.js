// The person's side of the local API: state for the web view and the few things only a person does.
// Served under /v/ with the person token; delegates never get that token.
import { allDone, roomState, describeAccord } from './accord.js'

export const CONFIRM = 'I agree'
export const NO_PEER = 'No one has connected after a minute: the two networks could not reach each other directly. Try another network (a phone hotspot works), or have one member run `open-accord relay` and the other pass `--relay <key>`. An automatic tunnel fallback is planned.'
const IMAGES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']

export function webState (store, roomId, ctl) {
  const me = store.identity().publicKey
  const es = store.entries(roomId)
  const s = roomState(es)
  const name = (a) => (a === me ? 'you' : 'other-' + a.slice(0, 8))
  const body = (e) => (['open', 'amend', 'sign', 'join', 'invite'].includes(e.type) ? {} : e.type === 'blob' ? { ...e.body, have: store.hasBlob(e.body.hash) } : e.body)
  return {
    room: roomId,
    topic: s.accord?.topic,
    accord: s.accord && { rules: s.accord, words: describeAccord(s.accord) },
    members: [...s.members].map((m) => ({ name: name(m), signed: s.signed.get(m) === s.accordHash, done: s.done.has(m) })),
    signedByMe: s.signed.get(me) === s.accordHash,
    open: s.open,
    closed: s.closed,
    allDone: allDone(s),
    entries: es.filter((e) => e.type !== 'invite').map((e) => ({ id: e.id.slice(0, 12), from: name(e.author), mine: e.author === me, via: e.via, type: e.type, ts: e.ts, body: body(e) })),
    summaries: es.filter((e) => e.type === 'done').map((e) => ({ from: name(e.author), mine: e.author === me, summary: e.body.summary })),
    held: store.heldEntries(roomId).map((h) => ({ id: h.id, type: h.type, reason: h.reason, body: h.body })),
    grants: store.grants(roomId),
    delegate: ctl.runner ? ctl.runner.status() : null,
    peers: ctl.sync.peers(),
    lonely: ctl.sync.lonely() ? NO_PEER : null
  }
}

// Returns a JSON-able result, or throws an Error whose message is shown to the person.
export function webAction (store, roomId, ctl, action, arg) {
  const s = () => roomState(store.entries(roomId))
  switch (action) {
    case 'post':
      if (!arg.text || typeof arg.text !== 'string') throw new Error('nothing to post')
      store.append(roomId, 'message', { text: arg.text })
      return {}
    case 'sign':
      if (arg.confirm !== CONFIRM) throw new Error(`type "${CONFIRM}" to sign`)
      store.append(roomId, 'sign', { accord_hash: s().accordHash })
      return {}
    case 'pause': ctl.runner?.pause(); return {}
    case 'resume': ctl.runner?.resume(); return {}
    case 'close': store.append(roomId, 'close', {}); return {}
    case 'approve': {
      const h = store.takeHeld(roomId, Number(arg.id))
      if (!h) throw new Error('already handled')
      try { store.append(roomId, h.type, h.body, 'delegate') } catch (err) { store.hold(roomId, h.type, h.body, h.reason); throw err }
      return {}
    }
    case 'reject': {
      const h = store.takeHeld(roomId, Number(arg.id))
      if (h?.type === 'blob') store.dropBlob(h.body.hash)
      return {}
    }
  }
  throw new Error('unknown action')
}

// A shared blob, only if some entry in this room names it.
export function blobFor (store, roomId, hash) {
  const e = [...store.entryMap(roomId).values()].find((x) => x.type === 'blob' && x.body.hash === hash)
  const data = e && store.blob(hash)
  return data ? { data, mime: IMAGES.includes(e.body.mime) ? e.body.mime : 'application/octet-stream', name: e.body.name } : null
}
