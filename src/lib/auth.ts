// Web-session identity bootstrap. Two paths in:
//
//   1. **Link from iOS** — paste-in JSON blob from the LinkWebView
//      QR. Carries the existing iOS account's identity privs +
//      JWT, so the web becomes a clone of that UIN.
//
//   2. **Create new account** — generate fresh X25519 + Ed25519
//      keypairs locally, POST `/auth/register`, persist the result.
//      Backend mints a brand-new UIN. Account is web-native; no
//      iOS counterpart unless the user installs RCQ later (in which
//      case they install fresh — no backwards link from web to iOS).
//
// Storage caveat: localStorage is XSS-readable. Phase-1 prototype
// trade-off; phase-2 (libsignal-WASM) moves to non-extractable
// WebCrypto keys + IndexedDB.

import { x25519, ed25519 } from '@noble/curves/ed25519'
import { b64ToBytes, bytesToB64, type WebIdentity } from './crypto'

const STORAGE_KEY = 'rcq.web.identity.v1'
const LINK_TTL_SECONDS = 5 * 60

// -----------------------------------------------------------
// Linking-blob path
// -----------------------------------------------------------

export interface LinkBlob {
  uin: number
  jwt: string
  api_base: string
  identity_priv: string
  identity_pub: string
  signing_priv: string
  signing_pub: string
  iat: number
}

/// Typed errors so the caller can translate via i18n. Codes
/// double as the i18n key suffix: `auth.error.<code>`.
export class LinkBlobError extends Error {
  constructor(public code: 'invalid_json' | 'missing_field' | 'expired' | 'mismatch' | 'wrong_size') {
    super(code)
  }
}

export function parseLinkBlob(raw: string): LinkBlob {
  const trimmed = raw.trim()
  let obj: any
  try {
    obj = JSON.parse(trimmed)
  } catch {
    // Linking blobs may have been base64-wrapped for QR-density;
    // try one round of decoding before giving up.
    try {
      obj = JSON.parse(new TextDecoder().decode(b64ToBytes(trimmed)))
    } catch {
      throw new LinkBlobError('invalid_json')
    }
  }
  for (const k of [
    'uin', 'jwt', 'api_base',
    'identity_priv', 'identity_pub',
    'signing_priv', 'signing_pub', 'iat',
  ]) {
    if (obj[k] == null) throw new LinkBlobError('missing_field')
  }
  return obj as LinkBlob
}

export function adoptLinkBlob(blob: LinkBlob): WebIdentity {
  const now = Math.floor(Date.now() / 1000)
  if (now - blob.iat > LINK_TTL_SECONDS) throw new LinkBlobError('expired')

  const identityPriv = b64ToBytes(blob.identity_priv)
  const identityPub = b64ToBytes(blob.identity_pub)
  const signingPriv = b64ToBytes(blob.signing_priv)
  const signingPub = b64ToBytes(blob.signing_pub)

  if (
    identityPriv.length !== 32 ||
    identityPub.length !== 32 ||
    signingPriv.length !== 32 ||
    signingPub.length !== 32
  ) {
    throw new LinkBlobError('wrong_size')
  }

  // Cross-check: Ed25519 pub derivable from `signing_priv` (treated
  // as a seed) must match the shipped `signing_pub`. Catches
  // paste-mix accidents before we sign anything broken.
  const derivedPub = ed25519.getPublicKey(signingPriv)
  for (let i = 0; i < 32; i++) {
    if (derivedPub[i] !== signingPub[i]) throw new LinkBlobError('mismatch')
  }

  const identity: WebIdentity = {
    uin: blob.uin,
    jwt: blob.jwt,
    apiBase: blob.api_base.replace(/\/+$/, ''),
    identityPriv,
    identityPub,
    signingPriv,
    signingPub,
  }
  persist(identity)
  return identity
}

// -----------------------------------------------------------
// Create-account path
// -----------------------------------------------------------

/// Default API base for fresh accounts created from the web. Phase-1
/// is single-tenant — every install talks to api.rcq.app. A future
/// settings panel can override.
export const DEFAULT_API_BASE =
  (import.meta.env.VITE_API_BASE as string | undefined)?.replace(/\/+$/, '') || 'https://api.rcq.app'

/// Suggest a default nickname matching the iOS bootstrap heuristic
/// (`user-NNNN` with a 4-digit random suffix). The user can edit
/// before submitting.
export function suggestNickname(): string {
  return `user-${Math.floor(1000 + Math.random() * 9000)}`
}

interface RegisterResponse {
  uin: number
  token: string
}

/// Mint a fresh account: generate keypairs, POST /auth/register,
/// adopt the returned UIN+JWT into a `WebIdentity`. Throws on
/// validation or network failure; caller surfaces via `auth.error.*`.
export async function createNewAccount(nickname: string, apiBase: string = DEFAULT_API_BASE): Promise<WebIdentity> {
  const trimmedNick = nickname.trim()
  if (!trimmedNick) throw new Error('Nickname is required.')

  // Long-term identity (X25519 ECDH) + signing (Ed25519) keypairs.
  // `randomPrivateKey()` is the audited noble-libs entry point —
  // pulls from `crypto.getRandomValues` under the hood.
  const identityPriv = x25519.utils.randomPrivateKey()
  const identityPub = x25519.getPublicKey(identityPriv)
  const signingPriv = ed25519.utils.randomPrivateKey()
  const signingPub = ed25519.getPublicKey(signingPriv)

  const apiBaseTrimmed = apiBase.replace(/\/+$/, '')
  const res = await fetch(`${apiBaseTrimmed}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      nickname: trimmedNick,
      identity_key: bytesToB64(identityPub),
      signing_key: bytesToB64(signingPub),
    }),
  })
  const text = await res.text()
  if (!res.ok) {
    throw new Error(text || `HTTP ${res.status}`)
  }
  const out = JSON.parse(text) as RegisterResponse

  const identity: WebIdentity = {
    uin: out.uin,
    jwt: out.token,
    apiBase: apiBaseTrimmed,
    identityPriv,
    identityPub,
    signingPriv,
    signingPub,
  }
  persist(identity)
  return identity
}

// -----------------------------------------------------------
// Persistence
// -----------------------------------------------------------

interface StoredIdentity {
  uin: number
  jwt: string
  apiBase: string
  identityPriv: string
  identityPub: string
  signingPriv: string
  signingPub: string
}

function persist(id: WebIdentity) {
  const stored: StoredIdentity = {
    uin: id.uin,
    jwt: id.jwt,
    apiBase: id.apiBase,
    identityPriv: bytesToB64(id.identityPriv),
    identityPub: bytesToB64(id.identityPub),
    signingPriv: bytesToB64(id.signingPriv),
    signingPub: bytesToB64(id.signingPub),
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(stored))
}

export function loadStoredIdentity(): WebIdentity | null {
  const raw = localStorage.getItem(STORAGE_KEY)
  if (!raw) return null
  try {
    const stored = JSON.parse(raw) as StoredIdentity
    return {
      uin: stored.uin,
      jwt: stored.jwt,
      apiBase: stored.apiBase,
      identityPriv: b64ToBytes(stored.identityPriv),
      identityPub: b64ToBytes(stored.identityPub),
      signingPriv: b64ToBytes(stored.signingPriv),
      signingPub: b64ToBytes(stored.signingPub),
    }
  } catch {
    return null
  }
}

export function clearIdentity() {
  localStorage.removeItem(STORAGE_KEY)
}

/// Adopt a server-confirmed UIN migration (UIN-market purchase): the
/// account keeps its X25519/Ed25519 keypairs but gets a NEW uin + a fresh
/// JWT. Persist the updated identity. The caller should HARD-reload after
/// this so every in-memory cache (ws socket on the old jwt, the libsignal
/// device keyed by the old uin, incoming store) is rebuilt — the next
/// provision republishes a clean bundle under the new uin (the server
/// reset libsignal material on migrate, so peers re-handshake anyway).
export function adoptMigratedUin(current: WebIdentity, newUin: number, newToken: string): WebIdentity {
  const next: WebIdentity = { ...current, uin: newUin, jwt: newToken }
  persist(next)
  return next
}

/// Device-level prefs that should SURVIVE a sign-out (they're not
/// account data — they're how this browser is set up).
const PRESERVED_KEYS = new Set<string>([
  'rcq.web.chat.theme',
  'rcq.web.language',
  'rcq.web.sounds.enabled',
])

/// Wipe ALL account-scoped local data so a fresh account never inherits
/// the previous one's messages/contacts/keys. Removes the identity,
/// every per-thread outgoing log (`rcq.web.outgoing.*`), favorites/
/// archive/muted/collapsed, and the privacy pref — but keeps the
/// device prefs above. IndexedDB (device keys + decrypted history) is
/// cleared by the caller via `idbClearAll()`. This fixes the bug where
/// a new account saw the old account's group messages.
export function wipeLocalAccountData() {
  const toRemove: string[] = []
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i)
    if (!k) continue
    if (PRESERVED_KEYS.has(k)) continue
    // Everything else under our namespaces is account data.
    if (k.startsWith('rcq.web.') || k.startsWith('rcq.privacy.')) toRemove.push(k)
  }
  for (const k of toRemove) localStorage.removeItem(k)
}
