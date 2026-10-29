// A running node: sync + local server + auto-join + optional delegate runner, for one room.
import { roomState } from './accord.js'
import { sha256 } from './crypto.js'
import { startApi } from './api.js'
import { startRunner } from './runner.js'
import { startSync } from './sync.js'
import { NO_PEER } from './web.js'

// A joiner's node posts the join entry as soon as it has synced the invite it holds the token for.
export function autoJoin (store, roomId) {
  const token = store.room(roomId).join_token
  if (!token) return false
  const s = roomState(store.entries(roomId))
  if (!s.accord || s.members.has(store.identity().publicKey) || s.invites.get(sha256(token)) !== false) return false
  store.append(roomId, 'join', { token })
  return true
}

export async function runNode (store, roomId, { delegate, relays, maxWakes, bootstrap, log = console.error } = {}) {
  const sync = startSync(store, roomId, { relays, bootstrap, log })
  const ctl = { sync, runner: null }
  const api = await startApi(store, roomId, ctl)
  ctl.runner = delegate ? startRunner(store, roomId, { driver: delegate, maxWakes, log }) : null
  let warned = false
  let checkedN = -1
  const timer = setInterval(() => {
    const n = store.lastN(roomId) // only look again when the log changed
    if (n !== checkedN) {
      checkedN = n
      try { if (autoJoin(store, roomId)) log('joined the room') } catch (err) { log(`join failed: ${err.message}`) }
    }
    if (!warned && sync.lonely()) { warned = true; log(NO_PEER) }
  }, 1000)
  await sync.ready
  log(`node up for room ${roomId.slice(0, 8)}\nweb view ready: the person runs  open-accord view ${roomId.slice(0, 8)}`)
  return { api, ctl, stop: async () => { clearInterval(timer); ctl.runner?.stop(); api.stop(); await sync.stop() } }
}
