import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import createTestnet from 'hyperdht/testnet.js'
import Hyperswarm from 'hyperswarm'
import { pair, tmpStore } from './helpers.js'
import { lintTexts } from '../src/lint.js'
import { makeTools } from '../src/tools.js'
import { apiFile, nodeInfo, startApi } from '../src/api.js'
import { webAction } from '../src/web.js'
import { startRunner } from '../src/runner.js'
import { startRelay } from '../src/relay.js'
import { startSync } from '../src/sync.js'
import { roomState, normalizeAccord } from '../src/accord.js'
import { signEntry } from '../src/crypto.js'

test('lint: built-in key patterns and custom patterns', () => {
  assert.match(lintTexts(['key sk-ant-api03-abcdefghijklmnopqrstuvwxyz']), /Anthropic/)
  assert.match(lintTexts(['ghp_' + 'a'.repeat(36)]), /GitHub/)
  assert.match(lintTexts(['AKIAABCDEFGHIJKLMNOP']), /AWS/)
  assert.match(lintTexts(['password = "hunter2hunter2hunter2"']), /secret assignment/)
  assert.equal(lintTexts(['plain talk about sync.js and tokens in general']), null)
  assert.match(lintTexts(['Acme Corp pricing'], ['acme corp']), /blocked pattern/)
  assert.match(lintTexts(['order 12345'], ['/order \\d+/']), /blocked pattern/)
})

test('a lint hit holds the delegate post until the person approves it', async () => {
  const { a, room, sign } = pair()
  sign()
  const tools = makeTools(a, room)
  const r = await tools.post_message.run({ text: 'here is the key sk-ant-api03-abcdefghijklmnopqrstuvwxyz' })
  assert.ok(r.held)
  assert.ok(!a.entries(room).some((e) => e.type === 'message'))
  const [h] = a.heldEntries(room)
  webAction(a, room, {}, 'approve', { id: h.id })
  assert.equal(a.entries(room).at(-1).body.text.slice(0, 12), 'here is the ')
  assert.equal(a.heldEntries(room).length, 0)
  await tools.post_message.run({ text: 'ok' }).catch(() => {})
  a.set(room, 'lint', JSON.stringify(['project falcon']))
  assert.ok((await tools.post_message.run({ text: 'about Project Falcon' })).held)
})

test('web view: person access is a one-use link then a cookie; delegates never get it', async () => {
  const { a, room } = pair()
  const ctl = { runner: null, sync: { peers: () => 1, lonely: () => false } }
  const api = await startApi(a, room, ctl)
  try {
    const base = `http://127.0.0.1:${api.port}`
    assert.equal((await fetch(base + '/')).status, 401)
    const first = await fetch(api.launchLink(), { redirect: 'manual' })
    assert.equal(first.status, 302)
    const link = api.launchLink()
    const cookie = (await fetch(link, { redirect: 'manual' })).headers.get('set-cookie').split(';')[0]
    assert.equal((await fetch(link, { redirect: 'manual' })).status, 401) // a link works once
    assert.ok(!readFileSync(apiFile(a.home, room), 'utf8').includes(cookie.split('=')[1])) // never on disk
    assert.match(await (await fetch(base + '/', { headers: { cookie } })).text(), /Open Accord/)
    const v = (p, extra = {}, init = {}) => fetch(base + p, { ...init, headers: { cookie, 'x-oa': '1', ...extra } })
    assert.equal((await fetch(base + '/v/state', { headers: { cookie } })).status, 401) // no custom header: cross-site request
    assert.equal((await v('/v/state', { cookie: '' }, {})).status, 401)
    assert.equal((await v('/v/state', { cookie: '', authorization: `Bearer ${api.token}` })).status, 401) // delegate token can't do person things
    assert.equal((await fetch(base + '/tools', { headers: { cookie } })).status, 401) // cookie isn't for tools
    assert.equal((await (await v('/v/state')).json()).signedByMe, false)
    const post = (action, body) => v(`/v/${action}`, {}, { method: 'POST', body: JSON.stringify(body) })
    assert.equal((await post('sign', { confirm: 'yes' })).status, 400)
    assert.equal((await post('sign', { confirm: 'I agree' })).status, 200)
    assert.equal((await (await v('/v/state')).json()).signedByMe, true)
    // the delegate's own door has no way to sign, amend or close
    const tools = await (await fetch(base + '/tools', { headers: { authorization: `Bearer ${api.token}` } })).json()
    assert.ok(!tools.tools.some((t) => /sign|close|amend|approve/.test(t.name)))
    // and the delegate token can't be turned into a person token: /launch only opens the person's own browser
    const printed = await (await fetch(base + '/launch', { method: 'POST', headers: { authorization: `Bearer ${api.token}` }, body: '{"print":true}' })).json()
    assert.match(printed.link, /\?n=[0-9a-f]{32}$/)
  } finally { api.stop() }
})

test('only one node can run a room; a stale lock or api file is not a running node', async () => {
  const { a, room } = pair()
  const ctl = { runner: null, sync: { peers: () => 1, lonely: () => false } }
  const api = await startApi(a, room, ctl)
  await assert.rejects(startApi(a, room, ctl), /already running/)
  assert.ok(await nodeInfo(a.home, room))
  api.stop()
  assert.equal(await nodeInfo(a.home, room), null)
  // a crash leaves files behind, with a pid some other program might now own
  writeFileSync(apiFile(a.home, room), JSON.stringify({ port: 1, token: 'x', pid: process.pid }))
  assert.equal(await nodeInfo(a.home, room), null)
  const again = await startApi(a, room, ctl)
  again.stop()
})

test('an entry stamped far in the future is held, not accepted, until the clock catches up', () => {
  const { a, b, room, sign } = pair({ cooldown_seconds: 0 })
  sign()
  const id = a.identity()
  const last = a.entries(room).filter((e) => e.author === id.publicKey).at(-1)
  const e = signEntry({ v: 1, room, type: 'message', author: id.publicKey, seq: last.seq + 1, prev: a.heads(room), ts: Date.now() + 3600_000, via: 'person', body: { text: 'from the future' } }, id)
  for (const x of a.entries(room)) b.ingest(room, x)
  assert.equal(b.ingest(room, e).status, 'held')
  assert.ok(!b.has(room, e.id))
})

test('accord: max_spend_usd must be a number', () => {
  assert.equal(normalizeAccord({}).max_spend_usd, 5)
  assert.throws(() => normalizeAccord({ max_spend_usd: 'lots' }), /max_spend_usd/)
  assert.throws(() => normalizeAccord({ max_spend_usd: -1 }), /max_spend_usd/)
})

test('runner stops waking at the spend cap and says so in the room', async (t) => {
  const { a, b, room, sign, copy } = pair({ max_spend_usd: 5, cooldown_seconds: 0 })
  sign()
  const dir = mkdtempSync(join(tmpdir(), 'oa-fake-'))
  const fake = join(dir, 'claude')
  writeFileSync(fake, '#!/bin/sh\necho \'{"session_id":"s1","total_cost_usd":3,"num_turns":1,"result":"ok"}\'\n')
  chmodSync(fake, 0o755)
  const runner = startRunner(a, room, { claude: fake })
  t.after(() => runner.stop())
  for (let i = 0; i < 4; i++) {
    b.append(room, 'message', { text: `hi ${i}` }, 'delegate'); copy(b, a)
    await sleep(2200)
  }
  assert.equal(runner.status().wakes, 2) // $3 + $3 >= $5, then no more
  assert.match(runner.status().stopped, /spend cap/)
  assert.ok(a.entries(room).some((e) => e.type === 'notice' && /spend cap/.test(e.body.text)))
})

test('a member-run blind relay carries a connection; the swarm only uses it as a fallback', async (t) => {
  const net = await createTestnet(3)
  const relay = await startRelay({ bootstrap: net.bootstrap })
  const topic = Buffer.alloc(32, 9)
  const key = Buffer.from(relay.key, 'hex')
  const s1 = new Hyperswarm({ bootstrap: net.bootstrap, relayThrough: () => key })
  const s2 = new Hyperswarm({ bootstrap: net.bootstrap, relayThrough: () => key })
  const got = new Promise((resolve) => s2.on('connection', resolve))
  s1.on('connection', () => {})
  t.after(async () => { await s1.destroy(); await s2.destroy(); await relay.stop(); await net.destroy() })
  s1.join(topic, { client: false, server: true }); await s1.flush()
  s2.join(topic, { client: true, server: false })
  await got
  await sleep(500)
  assert.ok(relay.stats.pairings.matched >= 1) // paired through the relay (it may then upgrade to a direct path)

  const a = tmpStore()
  const room = a.openRoom({ topic: 'x' })
  const sync = startSync(a, room, { bootstrap: net.bootstrap, relays: [relay.key] })
  t.after(() => sync.stop())
  assert.equal(sync.swarm.relayThrough(false, sync.swarm), null)
  assert.deepEqual(sync.swarm.relayThrough(true, sync.swarm), [key])
})
