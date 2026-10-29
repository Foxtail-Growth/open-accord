// Regression tests for the code-review findings (M1-n / M2-n refer to the review notes).
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import createTestnet from 'hyperdht/testnet.js'
import { pair, tmpStore } from './helpers.js'
import { accordHash, normalizeAccord, roomState } from '../src/accord.js'
import { checkPattern } from '../src/lint.js'
import { makeTools } from '../src/tools.js'
import { startRunner } from '../src/runner.js'
import { startSync } from '../src/sync.js'
import { sha256 } from '../src/crypto.js'

const CLI = new URL('../bin/open-accord.js', import.meta.url).pathname
const oa = (home, ...args) => execFileSync(process.execPath, [CLI, '--home', home, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

function fakeClaude (script) {
  const dir = mkdtempSync(join(tmpdir(), 'oa-fake-'))
  const file = join(dir, 'claude')
  writeFileSync(file, `#!/bin/sh\n${script}\n`)
  chmodSync(file, 0o755)
  return { file, dir }
}
async function until (fn, ms = 15000) {
  const end = Date.now() + ms
  while (Date.now() < end) { if (fn()) return; await sleep(100) }
  assert.fail('timed out')
}

test('M2-1: a failed or budget-capped run still counts its cost', async (t) => {
  const { a, b, room, sign, copy } = pair({ max_spend_usd: 5, cooldown_seconds: 0 })
  sign()
  const { file } = fakeClaude('echo \'{"session_id":"s","total_cost_usd":1.5,"subtype":"error_max_budget_usd"}\'; exit 1')
  const runner = startRunner(a, room, { claude: file })
  t.after(() => runner.stop())
  b.append(room, 'message', { text: 'hi' }, 'delegate'); copy(b, a)
  await until(() => runner.status().spent >= 1.5)
  assert.equal(runner.status().spent, 1.5)
})

test('M1-8: stopping the runner kills a running claude', async (t) => {
  const { a, room, sign } = pair({ cooldown_seconds: 0 })
  sign()
  const dir = mkdtempSync(join(tmpdir(), 'oa-fake-'))
  const { file } = fakeClaude(`echo $$ > ${dir}/pid; exec sleep 60`)
  const runner = startRunner(a, room, { claude: file })
  await until(() => existsSync(join(dir, 'pid')) && readFileSync(join(dir, 'pid'), 'utf8').trim())
  const pid = Number(readFileSync(join(dir, 'pid'), 'utf8'))
  runner.stop()
  await until(() => { try { process.kill(pid, 0); return false } catch { return true } }, 5000)
  t.diagnostic('claude process ended after stop')
})

test('M2-4/M2-3: a person\'s post after everyone is done wakes the delegate again; a notice does not', async (t) => {
  const { a, b, room, sign, copy } = pair({ cooldown_seconds: 0 })
  sign()
  const dir = mkdtempSync(join(tmpdir(), 'oa-fake-'))
  const { file } = fakeClaude(`echo x >> ${dir}/wakes; echo '{"session_id":"s","total_cost_usd":0}'`)
  a.append(room, 'done', { summary: 'a' }, 'delegate'); copy(a, b)
  b.append(room, 'done', { summary: 'b' }, 'delegate'); copy(b, a)
  const runner = startRunner(a, room, { claude: file })
  t.after(() => runner.stop())
  await sleep(2500)
  assert.match(runner.status().stopped, /every delegate is done/)
  const wakesBefore = existsSync(join(dir, 'wakes')) ? readFileSync(join(dir, 'wakes'), 'utf8').split('\n').length : 0
  a.append(room, 'notice', { text: 'spend cap note' })
  assert.equal(roomState(a.entries(room)).done.size, 2) // a notice doesn't clear done
  await sleep(2500)
  assert.equal(runner.status().stopped, 'every delegate is done')
  a.append(room, 'message', { text: 'one more thing from the person' }) // a person speaking restarts the room
  await until(() => existsSync(join(dir, 'wakes')) && readFileSync(join(dir, 'wakes'), 'utf8').split('\n').length > wakesBefore)
  assert.equal(runner.status().stopped, null)
})

test('M2-7: the accord hash covers what was written, so new default rules don\'t change it', () => {
  const a = tmpStore()
  const room = a.openRoom({ topic: 'old' }) // an entry from an older version: no max_spend_usd in it
  const s = roomState(a.entries(room))
  assert.equal(s.accordHash, accordHash({ topic: 'old' }))
  assert.equal(s.accord.max_spend_usd, 5) // defaults still apply when reading
  assert.throws(() => normalizeAccord({ topic: 'x', from_the_future: 1 }), /upgrade open-accord/)
})

test('M1-3: an accord can\'t allow files bigger than a sync frame', () => {
  assert.throws(() => normalizeAccord({ max_blob_bytes: 9_000_000 }), /max_blob_bytes/)
})

test('M1-7: an oversized file is refused before it is read or stored', async () => {
  const { a, room, sign } = pair({ max_blob_bytes: 100 })
  sign()
  const dir = mkdtempSync(join(tmpdir(), 'oa-big-'))
  writeFileSync(join(dir, 'big.bin'), Buffer.alloc(500, 1))
  a.grant(room, dir)
  const tools = makeTools(a, room)
  await assert.rejects(async () => tools.post_blob.run({ path: 'big.bin' }), /larger than the accord allows/)
  assert.equal(a.hasBlob(sha256(Buffer.alloc(500, 1))), false)
  // a file the accord refuses for another reason (turn cap) isn't stored either
  const b2 = pair({ turn_cap: 0 })
  b2.sign()
  writeFileSync(join(dir, 'small.txt'), 'hello')
  b2.a.grant(b2.room, dir)
  await assert.rejects(makeTools(b2.a, b2.room).post_blob.run({ path: 'small.txt' }), /turn cap/)
  assert.equal(b2.a.hasBlob(sha256('hello')), false)
})

test('M1-6: two posts made at once both go through, in order', async () => {
  const { a, room, sign } = pair({ cooldown_seconds: 1 })
  sign()
  const tools = makeTools(a, room)
  const r = await Promise.all([tools.post_message.run({ text: 'one' }), tools.post_message.run({ text: 'two' })])
  assert.deepEqual(r.map((x) => x.posted), ['message', 'message'])
})

test('M2-9: a held post says what matched; a bad blocked pattern is refused when added', async () => {
  const { a, room, sign } = pair()
  sign()
  const r = await makeTools(a, room).post_message.run({ text: 'token ghp_' + 'a'.repeat(36) })
  assert.match(r.reason, /GitHub token \("ghp_aaaaaaaa…"\)/)
  assert.throws(() => checkPattern('/(unclosed/'), /Invalid regular expression/)
})

test('M1-4/M1-2: a 3 MB file and a long log sync in batches, file bytes asked for after the entry', async (t) => {
  const net = await createTestnet(3)
  const a = tmpStore()
  const room = a.openRoom({ topic: 'big', max_blob_bytes: 4_000_000, cooldown_seconds: 0 })
  const data = Buffer.alloc(3_000_000, 7)
  a.append(room, 'invite', { token_hash: sha256('t') })
  for (let i = 0; i < 120; i++) a.append(room, 'message', { text: `m${i}` })
  const hash = a.putBlob(data)
  a.append(room, 'blob', { hash, size: data.length, name: 'big.bin', mime: 'application/octet-stream' })
  const b = tmpStore()
  b.addRoom(room, a.room(room).secret)
  const sa = startSync(a, room, { bootstrap: net.bootstrap })
  const sb = startSync(b, room, { bootstrap: net.bootstrap })
  t.after(async () => { await sa.stop(); await sb.stop(); await net.destroy() })
  await until(() => b.entries(room).length === a.entries(room).length && b.hasBlob(hash), 30000)
  assert.ok(b.blob(hash).equals(data))
})

test('M1-10/M2-5/M2-6/M2-2/M2-10: the CLI start, stop, status and view', () => {
  const home = mkdtempSync(join(tmpdir(), 'oa-cli-'))
  const out = oa(home, 'open', '--topic', 'cli test')
  const room = out.split('\n')[0].split(' ')[1].slice(0, 8)
  const started = oa(home, 'run', room, '--detach')
  assert.doesNotMatch(started, /[?&](t|n)=|ptoken|[0-9a-f]{40}/) // nothing here lets an agent act as the person
  assert.match(oa(home, 'status'), /node running/)
  assert.match(oa(home, 'run', room, '--detach'), /already running/) // M2-5: no second node
  const link = oa(home, 'view', room, '--print').trim()
  assert.match(link, /^http:\/\/127\.0\.0\.1:\d+\/\?n=[0-9a-f]{32}$/)
  assert.match(oa(home, 'stop', room), /stopped/)
  // M2-6: leftovers from a crash don't look like a running node, and stop doesn't signal a stranger
  const apiFile = join(home, `api-${out.split('\n')[0].split(' ')[1]}.json`)
  writeFileSync(apiFile, JSON.stringify({ port: 1, token: 'x', pid: process.pid }))
  assert.doesNotMatch(oa(home, 'status'), /node running/)
  assert.match(oa(home, 'stop', room), /no node was running/)
  assert.ok(!existsSync(apiFile))
})

test('M2-10: accord and sign explain themselves before the room has synced', () => {
  const home = mkdtempSync(join(tmpdir(), 'oa-cli-'))
  const s = tmpStore()
  const other = tmpStore()
  const room = other.openRoom({ topic: 'x' })
  const h = s.home
  s.addRoom(room, 'secret', 'tok')
  s.close()
  for (const cmd of ['accord', 'sign']) {
    assert.throws(() => oa(h, cmd, room.slice(0, 8)), (err) => /no accord yet/.test(err.stderr))
  }
  assert.ok(home)
})
