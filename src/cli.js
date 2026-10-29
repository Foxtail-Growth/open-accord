// Command line. Each command is a few lines over Store; `run` and `join` start the node.
import { parseArgs } from 'node:util'
import { closeSync, existsSync, openSync, readFileSync, readSync, realpathSync, unlinkSync, writeSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { join as pathJoin } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { roomState, normalizeAccord, describeAccord } from './accord.js'
import { randomHex, sha256 } from './crypto.js'
import { Store, defaultHome } from './store.js'
import { runNode } from './node.js'
import { runMcp } from './mcp.js'
import { apiFile, nodeInfo } from './api.js'
import { startRelay } from './relay.js'
import { checkPattern } from './lint.js'
import { CONFIRM } from './web.js'

const USAGE = `open-accord <command>
  open --topic T [--accord F]   start a room (F: accord rules as JSON); prints an invite to send
  invite <room>                 make another invite string
  join <invite> [--grant P..] [--brief F] [--delegate claude] [--detach]
                                accept an invite, sync, show the accord, and serve the room
  accord <room>                 show the rules, members and signatures
  sign <room>                   sign the accord (you type "${CONFIRM}" in your own terminal)
  grant <room> <path..>         let your delegate use files (never leaves this machine)
  brief <room> <file>           private brief for your delegate
  lint <room> [add|rm <text or /regex/>]   hold delegate posts that match, for your approval
  run <room> [--delegate claude] [--relay <key>] [--detach]   serve the room
  view <room>                   open the web view in your browser (--print: show the one-use link; for your own terminal)
  stop <room>                   stop a running node
  status | log <room> [--full]  rooms and their state | print the room's entries (--full: whole text)
  relay                         run a blind relay on this machine (prints its key)
  guide                         print SETUP.md, the instructions for a setup agent
  mcp --room <room>             MCP server for a delegate (stdio)`

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const REPO = 'Foxtail-Growth/open-accord'

// The message a person pastes to their counterpart's agent; pinned to this release's tag.
export const inviteMessage = (invite) => `Join this Open Accord room.
Setup instructions: https://github.com/${REPO}/blob/v${version}/SETUP.md
Run the tool with:   npx --yes github:${REPO}#v${version}
Invite:              ${invite}`

const short = (k) => k.slice(0, 8)
const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url')

// The person's own terminal, not stdin: a piped or backgrounded agent cannot answer for them.
function typed (prompt) {
  let fd
  try { fd = openSync('/dev/tty', 'r+') } catch { throw new Error('no terminal here. Run this yourself in a terminal, or click Sign in the web view.') }
  try {
    writeSync(fd, prompt)
    const buf = Buffer.alloc(1)
    let line = ''
    while (readSync(fd, buf, 0, 1, null) && buf[0] !== 10) line += String.fromCharCode(buf[0])
    return line.trim()
  } finally { closeSync(fd) }
}

// --detach: start the node in the background, wait for its first useful output, print it and return.
async function detach (store, id, marker) {
  if (await nodeInfo(store.home, id)) { console.log(`a node for this room is already running; open its web view with: open-accord view ${id.slice(0, 8)}`); return }
  const log = pathJoin(store.home, `node-${id.slice(0, 12)}.log`)
  const fd = openSync(log, 'w')
  const args = process.argv.slice(1).filter((a) => a !== '--detach')
  spawn(process.execPath, args, { detached: true, stdio: ['ignore', fd, fd], env: { ...process.env, OPEN_ACCORD_CHILD: '1' } }).unref()
  for (let i = 0; i < 110; i++) {
    await sleep(1000)
    const text = existsSync(log) ? readFileSync(log, 'utf8') : ''
    if (marker.test(text)) break
  }
  console.log(readFileSync(log, 'utf8').replace(/^\(node:\d+\) ExperimentalWarning.*\n|^\(Use `node --trace-warnings.*\n/gm, '').trim())
  console.log(`\n(node running in the background; log: ${log}; stop it with: open-accord stop ${id.slice(0, 8)})`)
}

async function serve (store, id, o) {
  const node = await runNode(store, id, { delegate: o.delegate, relays: o.relay || [], maxWakes: o['max-wakes'] && Number(o['max-wakes']) })
  const quit = async () => { await node.stop(); process.exit(0) }
  process.on('SIGINT', quit)
  process.on('SIGTERM', quit)
  return node
}

export async function main (argv) {
  const { values: o, positionals: [cmd, ...rest] } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { topic: { type: 'string' }, accord: { type: 'string' }, delegate: { type: 'string' }, relay: { type: 'string', multiple: true }, grant: { type: 'string', multiple: true }, brief: { type: 'string' }, room: { type: 'string' }, print: { type: 'boolean' }, detach: { type: 'boolean' }, full: { type: 'boolean' }, 'max-wakes': { type: 'string' }, home: { type: 'string' } }
  })
  const home = o.home || defaultHome()
  if (cmd === 'mcp') return runMcp(home, new Store(home).findRoom(o.room))
  if (!cmd || cmd === 'help') return console.log(USAGE)
  if (cmd === 'guide') return console.log(readFileSync(new URL('../SETUP.md', import.meta.url), 'utf8'))
  if (cmd === 'relay') {
    const r = await startRelay()
    console.log(`relay key: ${r.key}\nKeep this running. The other member starts their node with: --relay ${r.key}`)
    return
  }

  const store = new Store(home)
  const room = () => store.findRoom(rest[0] || '')
  try {
    switch (cmd) {
      case 'open': {
        const accord = normalizeAccord({ ...(o.accord ? JSON.parse(readFileSync(o.accord, 'utf8')) : {}), ...(o.topic ? { topic: o.topic } : {}) })
        const id = store.openRoom(accord)
        const token = randomHex(16)
        store.append(id, 'invite', { token_hash: sha256(token) })
        const invite = b64({ room: id, secret: store.room(id).secret, token })
        console.log(`room ${id}\ninvite ${invite}\n\nSend this to your counterpart (their agent does the rest):\n\n${inviteMessage(invite)}\n\nThen start your node: open-accord run ${short(id)} --delegate claude --detach. Read the accord and sign when you're ready: open-accord view ${short(id)}`)
        break
      }
      case 'invite': {
        const id = room()
        const token = randomHex(16)
        store.append(id, 'invite', { token_hash: sha256(token) })
        console.log(inviteMessage(b64({ room: id, secret: store.room(id).secret, token })))
        break
      }
      case 'join': {
        const inv = JSON.parse(Buffer.from(rest[0] || '', 'base64url').toString())
        if (!inv.room || !inv.secret || !inv.token) throw new Error('not an invite')
        store.identity()
        store.addRoom(inv.room, inv.secret, inv.token)
        for (const p of o.grant || []) store.grant(inv.room, realpathSync(p))
        if (o.brief) store.set(inv.room, 'brief', readFileSync(o.brief, 'utf8'))
        if (o.detach && !process.env.OPEN_ACCORD_CHILD) { await detach(store, inv.room, /NEEDS THE PERSON|Could not sync|error:/); break }
        console.log(`room ${inv.room}\nsyncing with the inviter (needs them to be running their node)...`)
        const node = await serve(store, inv.room, o)
        for (let i = 0; i < 90 && !roomState(store.entries(inv.room)).accord; i++) await sleep(1000)
        const s = roomState(store.entries(inv.room))
        if (!s.accord) console.log('Could not sync yet; still trying in the background. Is the inviter running their node?')
        else console.log(`\nThe accord:\n${describeAccord(s.accord).map((l) => '  - ' + l).join('\n')}\n`)
        console.log(`NEEDS THE PERSON: read the accord above, then sign. In the web view (the person runs: open-accord view ${short(inv.room)}) type "${CONFIRM}", or run in your own terminal: open-accord sign ${short(inv.room)}\nThe delegate does not start until you have signed and the other member has too.`)
        return
      }
      case 'accord': {
        const s = roomState(store.entries(room()))
        if (!s.accord) throw new Error('no accord yet: the room has not synced. Is your node running (open-accord run <room>) and the other member online?')
        console.log(describeAccord(s.accord).join('\n'))
        for (const m of s.members) console.log(`member ${short(m)}${m === store.identity().publicKey ? ' (you)' : ''}  ${s.signed.get(m) === s.accordHash ? 'signed' : 'NOT signed'}`)
        console.log(s.open ? 'room is open' : 'room is not open until every member (at least two) has signed')
        break
      }
      case 'sign': {
        const id = room()
        const s = roomState(store.entries(id))
        if (!s.accord) throw new Error('no accord yet: the room has not synced. Is your node running (open-accord run <room>) and the other member online?')
        console.log(`The accord for "${s.accord.topic}":\n${describeAccord(s.accord).map((l) => '  - ' + l).join('\n')}\n`)
        if (typed(`Type "${CONFIRM}" to sign: `) !== CONFIRM) throw new Error('not signed')
        store.append(id, 'sign', { accord_hash: s.accordHash })
        console.log('signed')
        break
      }
      case 'grant': {
        const id = room()
        for (const p of rest.slice(1)) { const real = realpathSync(p); store.grant(id, real); console.log(`granted ${real}`) }
        break
      }
      case 'brief': {
        store.set(room(), 'brief', readFileSync(rest[1], 'utf8'))
        console.log('brief saved (stays on this machine)')
        break
      }
      case 'lint': {
        const id = room()
        let list = JSON.parse(store.get(id, 'lint') || '[]')
        if (rest[1] === 'add') { checkPattern(rest[2]); list = [...list, rest[2]] }
        if (rest[1] === 'rm') list = list.filter((x) => x !== rest[2])
        store.set(id, 'lint', JSON.stringify(list))
        console.log(list.length ? list.join('\n') : '(no custom patterns; built-in key and token patterns always apply)')
        break
      }
      case 'run': {
        if (o.detach && !process.env.OPEN_ACCORD_CHILD) { await detach(store, room(), /web view ready|error:/); break }
        await serve(store, room(), o)
        return
      }
      case 'view': {
        const id = room()
        const info = await nodeInfo(home, id)
        if (!info) throw new Error(`no node is running for this room (start it: open-accord run ${short(id)})`)
        const r = await fetch(`http://127.0.0.1:${info.port}/launch`, { method: 'POST', headers: { authorization: `Bearer ${info.token}` }, body: JSON.stringify({ print: !!o.print }) })
        const j = await r.json()
        console.log(j.link || 'opening the web view in your browser')
        break
      }
      case 'stop': {
        const id = room()
        const info = await nodeInfo(home, id)
        if (info) { process.kill(info.pid, 'SIGTERM'); console.log('stopped') } else {
          for (const f of [apiFile(home, id), pathJoin(home, `lock-${id}`)]) { try { unlinkSync(f) } catch {} }
          console.log('no node was running (cleaned up leftovers)')
        }
        break
      }
      case 'status': {
        for (const r of store.rooms()) {
          const es = store.entries(r.id)
          const s = es.length ? roomState(es) : null
          let running = ''
          if (await nodeInfo(home, r.id)) running = '  node running'
          console.log(`${short(r.id)}  ${s?.accord?.topic || '(not synced yet)'}  entries ${es.length}  members ${s?.members.size ?? 0}  ${s?.closed ? 'closed' : s?.open ? 'open' : 'waiting for signatures'}${running}`)
        }
        break
      }
      case 'log': {
        const me = store.identity().publicKey
        for (const e of store.entries(room())) {
          const text = e.body.text ?? e.body.summary ?? e.body.name ?? (e.body.path ? `${e.body.path}:${e.body.start}-${e.body.end}` : '')
          console.log(`${new Date(e.ts).toISOString().slice(11, 19)} ${short(e.author)}${e.author === me ? '*' : ' '} ${e.via === 'delegate' ? 'D' : 'P'} ${e.type.padEnd(8)} ${String(text).replace(/\s+/g, ' ').slice(0, o.full ? Infinity : 200)}`)
        }
        break
      }
      default:
        console.log(USAGE)
        process.exitCode = 1
    }
  } catch (err) {
    console.error(`error: ${err.message}`)
    process.exitCode = 1
  }
  store.close()
}
