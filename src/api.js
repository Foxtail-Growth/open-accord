// The node's local server: plain HTTP on 127.0.0.1.
//   /tools/*   delegate tools (delegate token; the MCP proxy in mcp.js sits in front of this)
//   /ping, /launch   used by the CLI with the same token: liveness, and "open my web view in my browser"
//   /, /v/*    web view and person actions: a cookie only the browser holds, never printed or written to disk
import http from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { spawn } from 'node:child_process'
import { closeSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { randomHex } from './crypto.js'
import { makeTools } from './tools.js'
import { blobFor, webAction, webState } from './web.js'

export const apiFile = (home, room) => join(home, `api-${room}.json`)
const lockFile = (home, room) => join(home, `lock-${room}`)

export function readApiFile (home, room) {
  try { return JSON.parse(readFileSync(apiFile(home, room), 'utf8')) } catch { throw new Error(`no running node for room ${room.slice(0, 8)} (start it with: open-accord run ${room.slice(0, 8)})`) }
}

const same = (a, b) => { const x = Buffer.from(String(a)); const y = Buffer.from(String(b)); return x.length === y.length && timingSafeEqual(x, y) }
const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }
const PAGE = readFileSync(new URL('../web/index.html', import.meta.url))

// The api file of a node that is really running (it answers with its own token), else null.
// A leftover file from a crash, or a pid some other program now has, doesn't count.
export async function nodeInfo (home, room) {
  let info
  try { info = readApiFile(home, room) } catch { return null }
  try {
    const r = await fetch(`http://127.0.0.1:${info.port}/ping`, { headers: { authorization: `Bearer ${info.token}` }, signal: AbortSignal.timeout(1500) })
    return r.ok ? info : null
  } catch { return null }
}

// One node per room: a second would double the spend and fight over the same identity.
async function takeLock (home, room) {
  const file = lockFile(home, room)
  for (let tries = 0; tries < 2; tries++) {
    try {
      const fd = openSync(file, 'wx')
      writeSync(fd, String(process.pid))
      closeSync(fd)
      return
    } catch (err) {
      if (err.code !== 'EEXIST') throw err
      const pid = Number(readFileSync(file, 'utf8'))
      const young = Date.now() - statSync(file).mtimeMs < 10_000
      if (alive(pid) && (young || await nodeInfo(home, room))) throw new Error(`a node for this room is already running (pid ${pid}); stop it first with: open-accord stop ${room.slice(0, 8)}`)
      unlinkSync(file)
    }
  }
  throw new Error('could not take the room lock')
}

export async function startApi (store, roomId, ctl) {
  await takeLock(store.home, roomId)
  const tools = makeTools(store, roomId)
  const token = randomHex(24)
  const ptoken = randomHex(24) // lives only in this process and the person's browser
  const nonces = new Map() // one-use, 60-second codes that turn a link into the browser's cookie
  const reply = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)) }
  const bearer = (req) => (req.headers.authorization || '').replace(/^Bearer /, '')
  const cookie = (req) => /(?:^|; )oa=([0-9a-f]+)/.exec(req.headers.cookie || '')?.[1] ?? ''

  async function readJson (req) {
    let body = ''
    for await (const chunk of req) { body += chunk; if (body.length > 1_000_000) throw new Error('request too large') }
    return body ? JSON.parse(body) : {}
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x')
      if (req.headers.host !== `127.0.0.1:${server.address().port}`) return reply(res, 400, { error: 'bad host' })
      if (req.method === 'GET' && url.pathname === '/') {
        const nonce = url.searchParams.get('n')
        if (nonce && nonces.get(nonce) > Date.now()) {
          nonces.delete(nonce)
          res.writeHead(302, { location: '/', 'set-cookie': `oa=${ptoken}; HttpOnly; SameSite=Strict; Path=/` })
          return res.end()
        }
        if (!same(cookie(req), ptoken)) return reply(res, 401, { error: 'run `open-accord view <room>` to open the web view' })
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'referrer-policy': 'no-referrer', 'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src blob:; connect-src 'self'" })
        return res.end(PAGE)
      }
      if (url.pathname === '/ping' || url.pathname === '/launch' || url.pathname.startsWith('/tools')) {
        if (!same(bearer(req), token)) return reply(res, 401, { error: 'unauthorized' })
        if (url.pathname === '/ping') return reply(res, 200, { ok: true })
        if (url.pathname === '/launch' && req.method === 'POST') {
          const nonce = randomHex(16)
          nonces.set(nonce, Date.now() + 60_000)
          const link = `http://127.0.0.1:${server.address().port}/?n=${nonce}`
          if ((await readJson(req)).print) return reply(res, 200, { link }) // for the person's own terminal
          const opener = process.platform === 'darwin' ? 'open' : 'xdg-open'
          const child = spawn(opener, [link], { detached: true, stdio: 'ignore' })
          child.on('error', () => {})
          child.unref()
          return reply(res, 200, { opened: true })
        }
        if (req.method === 'GET' && url.pathname === '/tools') return reply(res, 200, { tools: Object.entries(tools).map(([name, t]) => ({ name, description: t.description, inputSchema: t.inputSchema })) })
        const tool = req.method === 'POST' && tools[url.pathname.slice('/tools/'.length)]
        if (!tool) return reply(res, 404, { error: 'not found' })
        return reply(res, 200, { result: await tool.run(await readJson(req)) })
      }
      if (url.pathname.startsWith('/v/')) {
        // the custom header can't be sent by another website without our consent, so this also stops cross-site posts
        if (!same(cookie(req), ptoken) || req.headers['x-oa'] !== '1') return reply(res, 401, { error: 'unauthorized' })
        const [, , what, arg] = url.pathname.split('/')
        if (req.method === 'GET' && what === 'state') return reply(res, 200, webState(store, roomId, ctl))
        if (req.method === 'GET' && what === 'blob') {
          const b = blobFor(store, roomId, arg)
          if (!b) return reply(res, 404, { error: 'not here yet' })
          res.writeHead(200, { 'content-type': b.mime, 'x-content-type-options': 'nosniff', 'content-security-policy': 'sandbox' })
          return res.end(b.data)
        }
        if (req.method === 'POST') return reply(res, 200, { result: webAction(store, roomId, ctl, what, await readJson(req)) })
      }
      reply(res, 404, { error: 'not found' })
    } catch (err) {
      reply(res, 400, { error: err.message })
    }
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const file = apiFile(store.home, roomId)
  writeFileSync(file, JSON.stringify({ port, token, pid: process.pid }), { mode: 0o600 })
  return {
    port,
    token,
    // for tests and the person's own terminal only; never printed by run/join
    launchLink: () => { const n = randomHex(16); nonces.set(n, Date.now() + 60_000); return `http://127.0.0.1:${port}/?n=${n}` },
    stop: () => { for (const f of [file, lockFile(store.home, roomId)]) { try { unlinkSync(f) } catch {} } server.close() }
  }
}
