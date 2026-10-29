import test from 'node:test'
import assert from 'node:assert/strict'
import { canonical, newIdentity, signEntry, checkSignature } from '../src/crypto.js'
import { order } from '../src/store.js'
import { tmpStore } from './helpers.js'

test('canonical JSON sorts keys at every level', () => {
  assert.equal(canonical({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: undefined } }), '{"a":{"d":[2,{"y":2,"z":1}]},"b":1}')
})

test('signatures verify, and any change breaks them', () => {
  const id = newIdentity()
  const e = signEntry({ v: 1, author: id.publicKey, body: { text: 'hi' } }, id)
  assert.ok(checkSignature(e))
  assert.ok(!checkSignature({ ...e, body: { text: 'hI' } }))
  const other = newIdentity()
  assert.ok(!checkSignature({ ...e, author: other.publicKey }))
  assert.ok(!checkSignature({ ...e, id: 'f'.repeat(64) }))
})

test('order puts parents first and is the same for any input order', () => {
  const mk = (id, prev, ts) => ({ id, prev, ts })
  const es = [mk('d', ['b', 'c'], 4), mk('b', ['a'], 2), mk('c', ['a'], 2), mk('a', [], 1)]
  const want = ['a', 'b', 'c', 'd']
  assert.deepEqual(order(es).map((e) => e.id), want)
  assert.deepEqual(order([...es].reverse()).map((e) => e.id), want)
})

test('a room starts with an open entry that fixes its id; entries survive reopening the store', () => {
  const s = tmpStore()
  const room = s.openRoom({ topic: 'x' })
  assert.equal(s.entries(room)[0].id, room)
  const again = new s.constructor(s.home)
  assert.equal(again.entries(room).length, 1)
})

test('an entry waiting on two parents is accepted once both arrive (used to loop forever)', async () => {
  const { pair, tmpStore } = await import('./helpers.js')
  const { a, b, room, copy } = pair({ cooldown_seconds: 0 })
  const ma = a.append(room, 'message', { text: 'a' })
  const mb = b.append(room, 'message', { text: 'b' })
  copy(b, a)
  const mc = a.append(room, 'message', { text: 'c' })
  assert.equal(mc.prev.length, 2)
  const c = tmpStore()
  c.addRoom(room, 's')
  const rest = a.entries(room).filter((e) => ![ma.id, mb.id, mc.id].includes(e.id))
  for (const e of rest) c.ingest(room, e)
  const r = c.ingest(room, mc)
  assert.equal(r.status, 'pending')
  assert.deepEqual(r.missing.sort(), [ma.id, mb.id].sort())
  assert.equal(c.ingest(room, ma).status, 'accepted')
  assert.equal(c.ingest(room, mb).status, 'accepted')
  assert.equal(c.entries(room).length, a.entries(room).length)
})
