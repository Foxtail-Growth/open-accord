// Reference delegate runner. Wakes a headless Claude Code when something new arrives, with no tools
// except this room's MCP server, in an empty folder. Nobody nudges it turn by turn.
import { execFile } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { allDone, roomState } from './accord.js'

const run = promisify(execFile)
const CLI = fileURLToPath(new URL('../bin/open-accord.js', import.meta.url))

const START = 'You are a delegate in an Open Accord room, sent by your person. Call read_briefing first and follow it, then read_accord, list_grants and read_new. Do the work through the room tools. When you have nothing left to do this turn, stop with one short line.'
const WAKE = 'New entries have arrived in the room. Call read_new, then respond with the room tools if a reply helps. If your side has said all it needs to, call post_done with a summary. When done for this turn, stop with one short line.'

export function startRunner (store, roomId, { driver = 'claude', maxWakes = 30, claude = 'claude', log = () => {} } = {}) {
  if (driver !== 'claude') throw new Error(`unknown delegate driver: ${driver}`)
  const me = store.identity().publicKey
  const cwd = join(store.home, `delegate-${roomId.slice(0, 12)}`)
  mkdirSync(cwd, { recursive: true })
  const mcp = JSON.stringify({ mcpServers: { accord: { command: process.execPath, args: [CLI, 'mcp', '--room', roomId], env: { OPEN_ACCORD_HOME: store.home } } } })
  let child = null
  let busy = false
  let reason = null // why we're not waking right now; recomputed every tick, so new activity resumes things
  let wakes = 0
  let wokeN = 0
  let nextTry = 0
  let cache = { n: -1, s: null }
  let seenN = store.lastN(roomId)
  let lastActivity = Date.now() // local receive time, not author-claimed timestamps

  const spent = () => Number(store.get(roomId, 'spent') || 0)
  const paused = () => store.get(roomId, 'paused') === '1'
  const state = (n) => { if (cache.n !== n) cache = { n, s: roomState(store.entries(roomId)) }; return cache.s }

  // A run that was capped, failed or timed out still printed what it cost; count it.
  function account (out) {
    if (out.session_id) store.set(roomId, 'claude_session', out.session_id)
    store.set(roomId, 'spent', String(spent() + (out.total_cost_usd || 0)))
  }

  async function wake (cap) {
    busy = true
    wokeN = store.lastN(roomId)
    const session = store.get(roomId, 'claude_session')
    const args = ['-p', session ? WAKE : START, '--output-format', 'json', '--strict-mcp-config', '--mcp-config', mcp, '--tools', '', '--allowedTools', 'mcp__accord', '--setting-sources', 'project']
    if (session) args.push('--resume', session)
    if (cap) args.push('--max-budget-usd', Math.max(0.01, cap - spent()).toFixed(2))
    wakes++
    log(`waking delegate (wake ${wakes})`)
    const p = run(claude, args, { cwd, timeout: 15 * 60_000, maxBuffer: 50 * 1024 * 1024 })
    child = p.child
    try {
      const out = JSON.parse((await p).stdout)
      account(out)
      log(`delegate turn done: ${out.num_turns} turns, $${(out.total_cost_usd || 0).toFixed(3)}${out.is_error ? ' (error)' : ''} ${String(out.result || '').slice(0, 120).replace(/\s+/g, ' ')}`)
    } catch (err) {
      try { account(JSON.parse(err.stdout)) } catch {}
      nextTry = Date.now() + 30_000
      log(`delegate run failed: ${String(err.stderr || err.message).slice(0, 300)}`)
    }
    child = null
    busy = false
  }

  function check () {
    if (busy) return
    const n = store.lastN(roomId)
    if (n !== seenN) { seenN = n; lastActivity = Date.now() }
    const s = state(n)
    if (!s.open || paused()) return
    const a = s.accord
    const capped = a.max_spend_usd && spent() >= a.max_spend_usd
    const why = s.closed ? 'room closed'
      : allDone(s) ? 'every delegate is done'
        : (s.delegate.get(me)?.count ?? 0) >= a.turn_cap ? 'turn cap reached'
          : capped ? 'spend cap reached'
            : wakes >= maxWakes ? 'wake cap reached'
              : Date.now() - lastActivity > a.idle_close_minutes * 60_000 ? 'idle too long' : null
    if (why !== reason) { reason = why; if (why) log(`delegate stopped: ${why}`) }
    if (why) {
      if (capped && !store.get(roomId, 'spend_notice')) {
        store.set(roomId, 'spend_notice', '1')
        try { store.append(roomId, 'notice', { text: `This delegate stopped: its spend cap of $${a.max_spend_usd} was reached.` }) } catch {}
      }
      return
    }
    if (Date.now() < nextTry) return
    // Setup entries, notices, and the other side's done (once ours is posted) need no answer.
    const quiet = ['open', 'invite', 'join', 'sign', 'notice', ...(s.done.has(me) ? ['done'] : [])]
    // Your own person-posts count: they're how a person talks to their delegate (and restarts a finished room).
    const fresh = store.newSince(roomId, Math.max(wokeN, Number(store.get(roomId, 'cursor') || 0))).some(({ e }) => !quiet.includes(e.type) && (e.author !== me || e.via === 'person'))
    if (!store.get(roomId, 'claude_session') || fresh) wake(a.max_spend_usd)
  }

  const timer = setInterval(check, 1000)
  return {
    status: () => ({ stopped: reason, paused: paused(), busy, wakes, spent: spent() }),
    pause: () => store.set(roomId, 'paused', '1'),
    resume: () => { store.set(roomId, 'paused', '0'); wakes = 0; reason = null },
    stop: () => { clearInterval(timer); child?.kill() }
  }
}
