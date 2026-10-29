import test from 'node:test'
import assert from 'node:assert/strict'
import { pair, tmpStore } from './helpers.js'
import { roomState } from '../src/accord.js'
import { sha256, signEntry } from '../src/crypto.js'

const refused = (fn, re) => assert.throws(fn, re)

test('delegates cannot post until every member has signed', () => {
  const { a, b, room, sign } = pair()
  refused(() => a.append(room, 'message', { text: 'hi' }, 'delegate'), /not open/)
  a.append(room, 'sign', { accord_hash: roomState(a.entries(room)).accordHash })
  refused(() => a.append(room, 'message', { text: 'hi' }, 'delegate'), /not open/)
  a.append(room, 'message', { text: 'a person can talk' }, 'person')
  sign()
  a.append(room, 'message', { text: 'hi' }, 'delegate')
  assert.ok(b)
})

test('a room with only its creator in it is not open', () => {
  const { a } = pair()
  const solo = a.openRoom({ topic: 'solo' })
  a.append(solo, 'sign', { accord_hash: roomState(a.entries(solo)).accordHash })
  refused(() => a.append(solo, 'message', { text: 'x' }, 'delegate'), /not open/)
})

test('signing a different accord is refused; an amendment needs fresh signatures', () => {
  const { a, room, sign } = pair()
  refused(() => a.append(room, 'sign', { accord_hash: 'a'.repeat(64) }), /different accord/)
  sign()
  a.append(room, 'amend', { accord: { topic: 't', cooldown_seconds: 0, turn_cap: 3 } })
  assert.equal(roomState(a.entries(room)).open, false)
  refused(() => a.append(room, 'message', { text: 'x' }, 'delegate'), /not open/)
})

test('turn cap stops a delegate', () => {
  const { a, room, sign } = pair({ turn_cap: 2 })
  sign()
  a.append(room, 'message', { text: '1' }, 'delegate')
  a.append(room, 'message', { text: '2' }, 'delegate')
  refused(() => a.append(room, 'message', { text: '3' }, 'delegate'), /turn cap/)
  a.append(room, 'message', { text: 'people are not capped' }, 'person')
})

test('cooldown refuses fast delegate posts', () => {
  const { a, room, sign } = pair({ cooldown_seconds: 60 })
  sign()
  a.append(room, 'message', { text: '1' }, 'delegate')
  refused(() => a.append(room, 'message', { text: '2' }, 'delegate'), /cooldown/)
})

test('invites: unknown, reused and non-member entries are refused', () => {
  const { a, b, room, copy } = pair()
  const c = tmpStore()
  c.addRoom(room, 's', 'tok')
  copy(a, c); copy(b, c)
  refused(() => c.append(room, 'join', { token: 'tok' }), /unknown or already used/)
  refused(() => c.append(room, 'join', { token: 'nope' }), /unknown or already used/)
  refused(() => c.append(room, 'message', { text: 'hi' }), /not a member/)
})

test('a bad invite entry is refused', () => {
  const { a, room } = pair()
  refused(() => a.append(room, 'invite', { token_hash: 'short' }), /bad invite/)
})

test('an author who forks their own chain is rejected', () => {
  const { a, b, room, sign, copy } = pair()
  sign()
  const id = a.identity()
  const mine = a.entries(room).filter((e) => e.author === id.publicKey)
  const last = mine.at(-1)
  const fork = signEntry({ v: 1, room, type: 'message', author: id.publicKey, seq: last.seq, prev: last.prev, ts: last.ts + 1, via: 'person', body: { text: 'fork' } }, id)
  assert.equal(b.ingest(room, fork).status, 'rejected')
  const gap = signEntry({ v: 1, room, type: 'message', author: id.publicKey, seq: last.seq + 5, prev: [last.id], ts: last.ts + 1, via: 'person', body: { text: 'gap' } }, id)
  assert.match(b.ingest(room, gap).reason, /gap/)
  copy(a, b)
})

test('an entry may skip over the author\'s previous entry if it points at something that saw it', () => {
  const { a, b, room, sign, copy } = pair()
  sign()
  a.append(room, 'message', { text: 'a1' })
  copy(a, b)
  b.append(room, 'message', { text: 'b1' }) // points at a1
  copy(b, a)
  const e = a.append(room, 'message', { text: 'a2' }) // heads is only b1
  assert.ok(!e.prev.includes(a.entries(room).find((x) => x.body.text === 'a1').id))
})

test('rejected entries and anything built on them never get in; tampered entries fail', () => {
  const { a, b, room, sign, copy } = pair()
  sign()
  const e = a.append(room, 'message', { text: 'ok' })
  const evil = { ...e, body: { text: 'changed' } }
  assert.equal(b.ingest(room, evil).reason, 'bad signature')
  const id = a.identity()
  const big = signEntry({ v: 1, room, type: 'message', author: id.publicKey, seq: 99, prev: [e.id], ts: e.ts + 1, via: 'delegate', body: { text: 'x'.repeat(9000) } }, id)
  copy(a, b)
  assert.match(b.ingest(room, big).reason, /gap|too long/)
})

test('excerpts must carry the hash of their text', () => {
  const { a, room, sign } = pair()
  sign()
  const body = { path: 'x.js', start: 1, end: 2, text: 'a\nb' }
  refused(() => a.append(room, 'excerpt', { ...body, sha256: 'a'.repeat(64) }, 'delegate'), /hash does not match/)
  a.append(room, 'excerpt', { ...body, sha256: sha256(body.text) }, 'delegate')
})

test('done from every member pauses the room; a new message clears it', () => {
  const { a, b, room, sign, copy } = pair()
  sign()
  a.append(room, 'done', { summary: 'a' }, 'delegate'); copy(a, b)
  b.append(room, 'done', { summary: 'b' }, 'delegate'); copy(b, a)
  assert.equal(roomState(a.entries(room)).done.size, 2)
  a.append(room, 'message', { text: 'wait' }, 'delegate')
  assert.equal(roomState(a.entries(room)).done.size, 0)
})
