import test from 'node:test'
import assert from 'node:assert/strict'
import createTestnet from 'hyperdht/testnet.js'
import { setTimeout as sleep } from 'node:timers/promises'
import { startSync } from '../src/sync.js'
import { roomState } from '../src/accord.js'
import { autoJoin } from '../src/node.js'
import { sha256 } from '../src/crypto.js'
import { tmpStore } from './helpers.js'

async function until (fn, ms = 15000) {
  const end = Date.now() + ms
  while (Date.now() < end) { if (fn()) return; await sleep(100) }
  assert.fail('timed out')
}

test('two nodes join, sign, talk and share a blob over hyperswarm', async (t) => {
  const net = await createTestnet(3)
  const a = tmpStore()
  const b = tmpStore()
  const room = a.openRoom({ topic: 'sync', cooldown_seconds: 0 })
  const secret = a.room(room).secret
  const token = 'join-token'
  a.append(room, 'invite', { token_hash: sha256(token) })
  a.append(room, 'sign', { accord_hash: roomState(a.entries(room)).accordHash })
  b.addRoom(room, secret, token)

  const sa = startSync(a, room, { bootstrap: net.bootstrap })
  const sb = startSync(b, room, { bootstrap: net.bootstrap })
  t.after(async () => { await sa.stop(); await sb.stop(); await net.destroy() })
  await Promise.all([sa.ready, sb.ready])

  await until(() => b.entries(room).length === 3)
  assert.ok(autoJoin(b, room))
  b.append(room, 'sign', { accord_hash: roomState(b.entries(room)).accordHash })
  await until(() => roomState(a.entries(room)).open)

  const data = Buffer.from('hello blob')
  b.append(room, 'message', { text: 'from b' }, 'delegate')
  const hash = b.putBlob(data)
  b.append(room, 'blob', { hash, size: data.length, name: 'x.txt', mime: 'text/plain' }, 'delegate')
  a.append(room, 'message', { text: 'from a' }, 'delegate')
  await until(() => a.hasBlob(hash) && b.entries(room).length === a.entries(room).length && a.entries(room).length >= 8).catch((err) => {
    console.log('a', a.entries(room).map((e) => e.type), 'b', b.entries(room).map((e) => e.type), a.hasBlob(hash))
    throw err
  })
  assert.deepEqual(a.entries(room).map((e) => e.id), b.entries(room).map((e) => e.id))
  assert.equal(a.blob(hash).toString(), 'hello blob')
})

test('a node that was offline gets everything in one go when it connects', async (t) => {
  const net = await createTestnet(3)
  const a = tmpStore()
  const room = a.openRoom({ topic: 'late' })
  for (let i = 0; i < 30; i++) a.append(room, 'message', { text: `m${i}` })
  const b = tmpStore()
  b.addRoom(room, a.room(room).secret)
  const sa = startSync(a, room, { bootstrap: net.bootstrap })
  const sb = startSync(b, room, { bootstrap: net.bootstrap })
  t.after(async () => { await sa.stop(); await sb.stop(); await net.destroy() })
  await until(() => b.entries(room).length === 31)
})

test('a peer in a different room cannot push entries into this one', async () => {
  const a = tmpStore()
  const room = a.openRoom({ topic: 'one' })
  const other = tmpStore()
  const room2 = other.openRoom({ topic: 'two' })
  const e = other.entries(room2)[0]
  assert.equal(a.ingest(room, e).status, 'rejected')
})
