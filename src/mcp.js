// MCP server for a delegate: newline-delimited JSON-RPC on stdio, forwarded to the running node.
// Hand-written; handles initialize, tools/list, tools/call, ping.
import { createInterface } from 'node:readline'
import { readApiFile } from './api.js'

export function runMcp (home, room) {
  const call = async (path, method = 'GET', body) => {
    const { port, token } = readApiFile(home, room)
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) })
    const json = await res.json()
    if (!res.ok) throw new Error(json.error || `node said ${res.status}`)
    return json
  }

  async function handle (msg) {
    switch (msg.method) {
      case 'initialize':
        return { protocolVersion: msg.params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'open-accord', version: '0.1.0' } }
      case 'ping': return {}
      case 'tools/list': return call('/tools')
      case 'tools/call': {
        try {
          const { result } = await call(`/tools/${msg.params.name}`, 'POST', msg.params.arguments || {})
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 1) }] }
        } catch (err) {
          return { content: [{ type: 'text', text: err.message }], isError: true }
        }
      }
    }
    throw Object.assign(new Error(`method not found: ${msg.method}`), { code: -32601 })
  }

  const out = (obj) => process.stdout.write(JSON.stringify(obj) + '\n')
  createInterface({ input: process.stdin }).on('line', async (line) => {
    let msg
    try { msg = JSON.parse(line) } catch { return out({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }) }
    if (msg.id === undefined) return // notifications need no reply
    try { out({ jsonrpc: '2.0', id: msg.id, result: await handle(msg) }) } catch (err) { out({ jsonrpc: '2.0', id: msg.id, error: { code: err.code || -32603, message: err.message } }) }
  })
}
