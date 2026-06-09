// Thin REST client. Reuses the JWT from the active WebIdentity and
// targets `apiBase` (defaults to https://api.rcq.app via the linking
// QR or fresh registration). All paths mirror the FastAPI router
// prefixes documented in `backend/app/routers/*.py`.

import type { WebIdentity, PeerBundle } from './crypto'

export class ApiError extends Error {
  constructor(public status: number, public body: string) {
    super(`${status}: ${body}`)
  }
}

// A 401 on a Bearer-authed request means the JWT is dead — the device was
// unlinked/revoked on the phone, or the token expired. The session can't
// recover, so rather than surface a raw "401: device revoked" error with a
// Retry button, we hand off to a registered handler (the IdentityProvider)
// that drops the identity and routes back to login. Registered once at app
// start; null in tests / before mount.
let unauthorizedHandler: (() => void) | null = null
export function setUnauthorizedHandler(fn: (() => void) | null) {
  unauthorizedHandler = fn
}

async function request<T>(
  identity: WebIdentity,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${identity.jwt}`,
  }
  let payload: BodyInit | undefined
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json'
    payload = JSON.stringify(body)
  }
  const res = await fetch(`${identity.apiBase}${path}`, {
    method,
    headers,
    body: payload,
  })
  const text = await res.text()
  if (!res.ok) {
    if (res.status === 401) unauthorizedHandler?.()
    throw new ApiError(res.status, text)
  }
  if (!text) return undefined as T
  try {
    return JSON.parse(text) as T
  } catch {
    return text as unknown as T
  }
}

// -----------------------------------------------------------
// Domain shapes — mirror the FastAPI Pydantic models. We only
// pull the fields we use; extra fields from the server are ignored
// silently (forward-compatible if backend adds anything).
// -----------------------------------------------------------

export type UserStatus = 'online' | 'away' | 'dnd' | 'invisible' | 'offline'

export interface Contact {
  uin: number
  nickname: string
  status: UserStatus
  status_message?: string
  blocked: boolean
  identity_key: string
  signing_key: string
  signal_identity_key?: string | null
  gender?: string | null
}

export interface UserInfo {
  uin: number
  nickname: string
  identity_key: string
  signing_key: string
  status: UserStatus
  status_message?: string | null
  first_name?: string | null
  last_name?: string | null
  age?: number | null
  gender?: string | null
  city?: string | null
  country?: string | null
  about?: string | null
  interests?: string | null
  homepage?: string | null
  last_seen?: string | null
  last_seen_visibility?: string | null
  gender_visibility?: string | null
  group_invite_policy?: string | null
  trade_policy?: string | null
  call_policy?: string | null
}

export interface PendingRequest {
  id: number
  from_uin: number
  nickname: string
  state: 'pending' | 'accepted' | 'declined'
}

export interface GroupMember {
  uin: number
  nickname: string
  role: 'owner' | 'admin' | 'member'
  status: UserStatus
  identity_key: string
  signing_key: string
  signal_identity_key?: string | null
}

export interface RCQGroup {
  id: number
  name: string
  owner_uin: number
  avatar_seed: number
  created_at: string
  members: GroupMember[]
  // Owner-set display gate: hide the member roster from Group Info for
  // non-owners. Mirrors the iOS/backend `members_hidden`.
  members_hidden?: boolean
  // Custom group avatar (encrypted media). When set, clients fetch + decrypt
  // it; otherwise the avatar is generated from `avatar_seed`.
  avatar_media_id?: string | null
  avatar_media_key?: string | null
  // Owner/admin-set plaintext pinned announcement (NULL = none).
  pinned_text?: string | null
}

/// Live poll state from `/polls/{id}`. `voter_uins` is populated only for
/// non-anonymous polls (the backend strips it otherwise).
export interface PollTally {
  option_index: number
  count: number
  voter_uins: number[]
}
export interface PollOut {
  poll_id?: number
  creator_uin?: number
  closed_at?: string | null
  tallies: PollTally[]
  total_votes: number
  my_votes: number[]
}

/// Lightweight group info shown to a non-member who's about to join
/// (the join card / `/g/:id` page). Mirrors backend `GroupPreviewOut`
/// — name + member count + owner, no roster or history.
export interface GroupPreview {
  id: number
  name: string
  description?: string | null
  member_count: number
  is_closed: boolean
  owner_uin: number
  owner_nickname?: string | null
  avatar_media_id?: string | null
  avatar_media_key?: string | null
}

export interface ProfileUpdate {
  nickname?: string
  first_name?: string | null
  last_name?: string | null
  age?: number | null
  gender?: string | null
  city?: string | null
  country?: string | null
  about?: string | null
  homepage?: string | null
  status_message?: string | null
  last_seen_visibility?: string
  gender_visibility?: string
  group_invite_policy?: string
  trade_policy?: string
  call_policy?: string
}

// -----------------------------------------------------------

export const Api = {
  // Profile -------------------------------------------------

  myInfo(id: WebIdentity): Promise<UserInfo> {
    return request<UserInfo>(id, 'GET', `/users/${id.uin}/info`)
  },

  userInfo(id: WebIdentity, uin: number): Promise<UserInfo> {
    return request<UserInfo>(id, 'GET', `/users/${uin}/info`)
  },

  updateProfile(id: WebIdentity, patch: ProfileUpdate): Promise<UserInfo> {
    return request<UserInfo>(id, 'PUT', '/users/me', patch)
  },

  searchUsers(id: WebIdentity, q: string, limit = 20): Promise<UserInfo[]> {
    const qs = new URLSearchParams({ q, limit: String(limit) })
    return request<UserInfo[]>(id, 'GET', `/users/search?${qs}`)
  },

  // Contacts ------------------------------------------------

  contacts(id: WebIdentity): Promise<Contact[]> {
    return request<Contact[]>(id, 'GET', '/contacts')
  },

  pendingRequests(id: WebIdentity): Promise<PendingRequest[]> {
    return request<PendingRequest[]>(id, 'GET', '/contacts/pending')
  },

  sendContactRequest(id: WebIdentity, toUIN: number): Promise<unknown> {
    return request<unknown>(id, 'POST', '/contacts/request', { to_uin: toUIN })
  },

  respondToRequest(id: WebIdentity, requestId: number, accept: boolean): Promise<{ state: string }> {
    return request<{ state: string }>(id, 'POST', '/contacts/respond', {
      request_id: requestId,
      accept,
    })
  },

  removeContact(id: WebIdentity, uin: number): Promise<void> {
    return request<void>(id, 'DELETE', `/contacts/${uin}`)
  },

  blockContact(id: WebIdentity, uin: number, blocked: boolean): Promise<unknown> {
    return request<unknown>(id, 'POST', `/contacts/${uin}/block`, { blocked })
  },

  // Messages ------------------------------------------------

  sendSealed(id: WebIdentity, toUIN: number, payload: string, envelopeType: string = 'message'): Promise<void> {
    return request<void>(id, 'POST', '/messages/sealed', {
      to_uin: toUIN,
      envelope_type: envelopeType,
      payload,
    })
  },

  // Presence ------------------------------------------------

  setStatus(id: WebIdentity, status: UserStatus, statusMessage?: string | null): Promise<unknown> {
    return request<unknown>(id, 'POST', '/presence/status', {
      status,
      status_message: statusMessage ?? null,
    })
  },

  // Groups --------------------------------------------------

  groups(id: WebIdentity): Promise<RCQGroup[]> {
    return request<RCQGroup[]>(id, 'GET', '/groups')
  },

  groupInfo(id: WebIdentity, groupId: number): Promise<RCQGroup> {
    return request<RCQGroup>(id, 'GET', `/groups/${groupId}`)
  },

  // Live poll tallies (counts + my_votes + voter_uins for non-anonymous).
  loadPoll(id: WebIdentity, pollId: number): Promise<PollOut> {
    return request<PollOut>(id, 'GET', `/polls/${pollId}`)
  },

  // Toggle the caller's vote on an option; returns the refreshed tally.
  votePoll(id: WebIdentity, pollId: number, optionIndex: number): Promise<PollOut> {
    return request<PollOut>(id, 'POST', `/polls/${pollId}/vote`, { option_index: optionIndex })
  },

  createGroup(id: WebIdentity, name: string, memberUINs: number[]): Promise<RCQGroup> {
    return request<RCQGroup>(id, 'POST', '/groups', {
      name,
      member_uins: memberUINs,
    })
  },

  addGroupMember(id: WebIdentity, groupId: number, uin: number): Promise<RCQGroup> {
    return request<RCQGroup>(id, 'POST', `/groups/${groupId}/members`, { uin })
  },

  removeGroupMember(id: WebIdentity, groupId: number, uin: number): Promise<unknown> {
    return request<unknown>(id, 'DELETE', `/groups/${groupId}/members/${uin}`)
  },

  renameGroup(id: WebIdentity, groupId: number, name: string): Promise<RCQGroup> {
    return request<RCQGroup>(id, 'PATCH', `/groups/${groupId}`, { name })
  },

  deleteGroup(id: WebIdentity, groupId: number): Promise<unknown> {
    return request<unknown>(id, 'DELETE', `/groups/${groupId}`)
  },

  /// Non-member preview for a group-invite link — name, member count,
  /// owner, open/closed. Used by the in-chat join card + `/g/:id` page.
  groupPreview(id: WebIdentity, groupId: number): Promise<GroupPreview> {
    return request<GroupPreview>(id, 'GET', `/groups/${groupId}/preview`)
  },

  /// Self-join an open group. Idempotent — already-member returns the
  /// group; a closed group rejects a non-member with 403 {code:
  /// "group_closed"}, a blocked user with 403 {code: "blocked"}.
  joinGroup(id: WebIdentity, groupId: number): Promise<RCQGroup> {
    return request<RCQGroup>(id, 'POST', `/groups/${groupId}/join`)
  },

  /// Per-member fan-out send. The `payloads` list pairs each member
  /// with the ciphertext encrypted to their own identity key —
  /// server has no plaintext access (same envelope format as 1:1).
  sendGroupSealed(
    id: WebIdentity,
    groupId: number,
    payloads: Array<{ to_uin: number; payload: string }>,
  ): Promise<unknown> {
    return request<unknown>(id, 'POST', '/messages/group-sealed', {
      group_id: groupId,
      envelope_type: 'message',
      payloads,
    })
  },

  // Account -------------------------------------------------

  burnAccount(id: WebIdentity): Promise<void> {
    return request<void>(id, 'DELETE', '/auth/account')
  },
}

/// Convert a server `UserInfo` / `Contact` row to the `PeerBundle`
/// shape `crypto.encryptV1` expects.
export function peerBundleFrom(info: { uin: number; identity_key: string; signing_key: string }): PeerBundle {
  return {
    uin: info.uin,
    identityKey: info.identity_key,
    signingKey: info.signing_key,
  }
}
