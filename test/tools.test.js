import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeTools, resolveGranted } from '../src/tools.js'
import { startApi } from '../src/api.js'
import { pair } from './helpers.js'
import { sha256 } from '../src/crypto.js'

function granted () {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'oa-grant-')))
  mkdirSync(join(dir, 'pub'))
  writeFileSync(join(dir, 'pub', 'a.js'), 'one\ntwo\nthree\n')
  writeFileSync(join(dir, 'pub', '.env'), 'SECRET=1\n')
  writeFileSync(join(dir, 'secret.txt'), 'nope')
  symlinkSync(join(dir, 'secret.txt'), join(dir, 'pub', 'link.txt'))
  return { dir, root: join(dir, 'pub') }
}

test('granted paths: inside works, outside, symlink escape and dotfiles are refused', () => {
  const { dir, root } = granted()
  assert.equal(resolveGranted([root], 'pub/a.js').shown, 'pub/a.js')
  assert.equal(resolveGranted([root], join(root, 'a.js')).shown, 'pub/a.js')
  assert.throws(() => resolveGranted([root], join(dir, 'secret.txt')), /not inside/)
  assert.throws(() => resolveGranted([root], '../secret.txt'), /not inside/)
  assert.throws(() => resolveGranted([root], 'pub/link.txt'), /not inside/)
  assert.throws(() => resolveGranted([root], 'pub/.env'), /dotfiles/)
})

test('post_excerpt reads and hashes the lines itself; the delegate cannot supply text', async () => {
  const { a, room, sign } = pair()
  sign()
  const { root } = granted()
  a.grant(room, root)
  const tools = makeTools(a, room)
  assert.deepEqual((await tools.list_grants.run()).files.map((f) => f.path), ['pub/a.js'])
  await tools.post_excerpt.run({ path: 'pub/a.js', start: 2, end: 3, text: 'FORGED' })
  const e = a.entries(room).at(-1)
  assert.equal(e.type, 'excerpt')
  assert.equal(e.via, 'delegate')
  assert.equal(e.body.text, 'two\nthree')
  assert.equal(e.body.sha256, sha256('two\nthree'))
  await assert.rejects(async () => tools.post_excerpt.run({ path: '/etc/passwd', start: 1, end: 1 }), /not inside/)
})

test('local API needs the token; tools list and call work', async () => {
  const { a, room, sign } = pair()
  sign()
  const api = await startApi(a, room)
  try {
    const base = `http://127.0.0.1:${api.port}`
    assert.equal((await fetch(base + '/tools')).status, 401)
    const auth = { authorization: `Bearer ${api.token}` }
    const list = await (await fetch(base + '/tools', { headers: auth })).json()
    assert.ok(list.tools.find((t) => t.name === 'wait_for_new'))
    const r = await (await fetch(base + '/tools/post_message', { method: 'POST', headers: auth, body: JSON.stringify({ text: 'hello' }) })).json()
    assert.equal(r.result.posted, 'message')
    const bad = await fetch(base + '/tools/post_message', { method: 'POST', headers: auth, body: JSON.stringify({ text: '' }) })
    assert.equal(bad.status, 400)
  } finally { api.stop() }
})
