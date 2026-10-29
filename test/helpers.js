import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/store.js'

export const tmpStore = () => new Store(mkdtempSync(join(tmpdir(), 'oa-test-')))

// Two people in an open room, accord signed by both, entries copied between them by hand.
export function pair (accord = {}) {
  const a = tmpStore()
  const b = tmpStore()
  const room = a.openRoom({ topic: 't', cooldown_seconds: 0, ...accord })
  const copy = (from, to) => { for (const e of from.entries(room)) to.ingest(room, e) }
  const token = 'tok'
  const invite = sha256hex(token)
  a.append(room, 'invite', { token_hash: invite })
  b.addRoom(room, 'secret', token)
  copy(a, b)
  b.append(room, 'join', { token })
  copy(b, a)
  return { a, b, room, copy, sign () { a.append(room, 'sign', { accord_hash: accordHashOf(a, room) }); copy(a, b); b.append(room, 'sign', { accord_hash: accordHashOf(b, room) }); copy(b, a) } }
}

import { createHash } from 'node:crypto'
import { roomState } from '../src/accord.js'
const sha256hex = (s) => createHash('sha256').update(s).digest('hex')
const accordHashOf = (store, room) => roomState(store.entries(room)).accordHash
