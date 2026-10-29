// A blind relay a member can run on their own machine for the rare network pair that can't connect directly.
// It forwards encrypted bytes between peers and cannot read or change anything.
// (hyperdht and blind-relay come with hyperswarm; they are not extra dependencies.)
import DHT from 'hyperdht'
import { Server } from 'blind-relay'

export async function startRelay ({ bootstrap } = {}) {
  const dht = new DHT({ bootstrap })
  const relay = new Server({ createStream: (opts) => dht.createRawStream({ ...opts, framed: true }) })
  const server = dht.createServer((socket) => {
    const session = relay.accept(socket, { id: socket.remotePublicKey })
    session.on('error', () => {})
    socket.on('error', () => {})
  })
  await server.listen()
  return { key: Buffer.from(server.publicKey).toString('hex'), stats: relay.stats, stop: async () => { await server.close(); await dht.destroy() } }
}
