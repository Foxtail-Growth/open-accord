// Identity, canonical encoding, signing. Node built-ins only.
import { createHash, createPublicKey, generateKeyPairSync, sign, verify, randomBytes } from 'node:crypto'

// Stable JSON: object keys sorted at every level, so every node hashes the same bytes.
export function canonical (value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort()
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}'
}

export const sha256 = (data) => createHash('sha256').update(data).digest('hex')
export const randomHex = (n = 32) => randomBytes(n).toString('hex')

export function newIdentity () {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  return {
    publicKey: Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url').toString('hex'),
    privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' })
  }
}

const keyCache = new Map()
function publicKeyObject (hex) {
  let k = keyCache.get(hex)
  if (!k) {
    k = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(hex, 'hex').toString('base64url') }, format: 'jwk' })
    keyCache.set(hex, k)
  }
  return k
}

// An entry is signed over its canonical form without `sig`; its id is the hash of the signed form.
export function signEntry (unsigned, identity) {
  const sig = sign(null, Buffer.from(canonical(unsigned)), identity.privateKeyPem).toString('hex')
  const entry = { ...unsigned, sig }
  return { ...entry, id: sha256(canonical(entry)) }
}

export function checkSignature (entry) {
  const { id, sig, ...unsigned } = entry
  if (typeof sig !== 'string' || !/^[0-9a-f]{64}$/.test(unsigned.author || '')) return false
  if (sha256(canonical({ ...unsigned, sig })) !== id) return false
  try {
    return verify(null, Buffer.from(canonical(unsigned)), publicKeyObject(unsigned.author), Buffer.from(sig, 'hex'))
  } catch {
    return false
  }
}
