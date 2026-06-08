// Encrypted media fetch + decrypt for the web client. Mirrors iOS
// `MediaService` byte-for-byte:
//   - The server stores opaque blobs (`GET /media/{id}`, no auth).
//   - Each blob is AES-256-GCM sealed with a per-blob key. iOS uses
//     CryptoKit `AES.GCM.seal(...).combined`, whose wire layout is
//     nonce(12) || ciphertext || tag(16). The key is base64 of the
//     raw 32 bytes (the `avatar_media_key` / per-message media key).
//
// We decrypt via the browser's native WebCrypto (`crypto.subtle`):
// AES-GCM `decrypt` takes the 12-byte nonce as `iv` and expects the
// data as ciphertext WITH the 16-byte tag appended — which is exactly
// `combined` minus the leading nonce. No AAD (iOS seals without AAD).

import { b64ToBytes, bytesToB64 } from './crypto'

// Cache the decrypted object URL per (mediaId, key) so repeated
// renders (Contacts row + Chat header + GroupInfo) don't re-fetch,
// re-decrypt, or leak a new object URL each time. Object URLs live for
// the page lifetime — fine for the handful of group avatars in view.
const _urlCache = new Map<string, Promise<string | null>>()

function cacheKey(mediaId: string, keyB64: string): string {
  return `${mediaId}:${keyB64}`
}

/// Sniff an image MIME from the leading magic bytes so the object URL
/// carries the right type for `<img>`. iOS uploads avatars as JPEG,
/// but be tolerant of PNG/GIF/WebP too.
function sniffImageType(bytes: Uint8Array): string {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png'
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'image/gif'
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) return 'image/webp'
  return 'image/jpeg'
}

async function fetchAndDecrypt(apiBase: string, mediaId: string, keyB64: string): Promise<string | null> {
  try {
    const keyBytes = b64ToBytes(keyB64)
    if (keyBytes.length !== 32) return null
    // Fresh ArrayBuffer so it's an unambiguous BufferSource for WebCrypto.
    const keyAb = new ArrayBuffer(32)
    new Uint8Array(keyAb).set(keyBytes)
    const res = await fetch(`${apiBase}/media/${mediaId}`)
    if (!res.ok) return null
    const combinedBuf = await res.arrayBuffer()
    // nonce(12) || ciphertext || tag(16) — need at least nonce + tag.
    if (combinedBuf.byteLength < 12 + 16) return null
    // Slice into plain ArrayBuffers (valid BufferSource without fighting
    // the Uint8Array<ArrayBufferLike> generic in newer TS DOM libs).
    const iv = combinedBuf.slice(0, 12)
    const data = combinedBuf.slice(12) // ciphertext || tag
    const key = await crypto.subtle.importKey('raw', keyAb, { name: 'AES-GCM' }, false, ['decrypt'])
    const plainBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, data)
    const plain = new Uint8Array(plainBuf)
    const blob = new Blob([plain], { type: sniffImageType(plain) })
    return URL.createObjectURL(blob)
  } catch {
    return null
  }
}

// -----------------------------------------------------------
// Upload (send side) — mirrors iOS MediaService.uploadImage:
// downscale to a sane max side + JPEG, AES-256-GCM seal in the
// CryptoKit `combined` layout (nonce(12)‖ct‖tag(16)), POST to
// /media/upload. Returns the media id + base64 key for the envelope.
// -----------------------------------------------------------

export interface UploadResult {
  mediaId: string
  keyB64: string
}

/// Downscale an image File to <= maxSide px, re-encoded as JPEG, to keep
/// blobs small (iOS uses 1200/0.8; we use 1600/0.85). Falls back to the
/// original bytes if the canvas path fails (e.g. exotic format).
async function compressImage(file: File, maxSide = 1600, quality = 0.85): Promise<Blob> {
  try {
    const bitmap = await createImageBitmap(file)
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height))
    const w = Math.max(1, Math.round(bitmap.width * scale))
    const h = Math.max(1, Math.round(bitmap.height * scale))
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) return file
    ctx.drawImage(bitmap, 0, 0, w, h)
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality))
    return blob ?? file
  } catch {
    return file
  }
}

/// Encrypt + upload an image File. GIFs are uploaded as-is (no canvas
/// re-encode, which would kill the animation). Returns null on failure.
export async function uploadEncryptedImage(apiBase: string, file: File): Promise<UploadResult | null> {
  try {
    const isGif = file.type === 'image/gif'
    const source: Blob = isGif ? file : await compressImage(file)
    const plaintext = await source.arrayBuffer()

    // Fresh 256-bit key + 96-bit nonce.
    const keyAb = new ArrayBuffer(32)
    const keyView = new Uint8Array(keyAb)
    crypto.getRandomValues(keyView)
    const nonceAb = new ArrayBuffer(12)
    const nonce = new Uint8Array(nonceAb)
    crypto.getRandomValues(nonce)

    const key = await crypto.subtle.importKey('raw', keyAb, { name: 'AES-GCM' }, false, ['encrypt'])
    const ctBuf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonceAb }, key, plaintext)
    const ct = new Uint8Array(ctBuf) // ciphertext || tag(16)

    // CryptoKit `.combined` = nonce(12) || ciphertext || tag(16).
    const combined = new Uint8Array(12 + ct.length)
    combined.set(nonce, 0)
    combined.set(ct, 12)

    const form = new FormData()
    form.append('blob', new Blob([combined], { type: 'application/octet-stream' }), 'photo.bin')
    const res = await fetch(`${apiBase}/media/upload`, { method: 'POST', body: form })
    if (!res.ok) return null
    const out = (await res.json()) as { media_id: string; size: number }
    return { mediaId: out.media_id, keyB64: bytesToB64(keyView) }
  } catch {
    return null
  }
}

/// Fetch + decrypt an encrypted image, returning an object URL (cached)
/// or null on any failure. Safe to call repeatedly with the same args.
export function loadEncryptedImage(
  apiBase: string,
  mediaId: string,
  keyB64: string,
): Promise<string | null> {
  const k = cacheKey(mediaId, keyB64)
  const hit = _urlCache.get(k)
  if (hit) return hit
  const p = fetchAndDecrypt(apiBase, mediaId, keyB64)
  _urlCache.set(k, p)
  // If the decrypt fails, drop the rejected/null promise so a later
  // attempt (e.g. after reconnect) can retry instead of caching null.
  void p.then((url) => {
    if (url === null) _urlCache.delete(k)
  })
  return p
}
