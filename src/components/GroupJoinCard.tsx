// In-chat (and standalone) card for a group-invite link. Instead of a
// dead `https://rcq.app/g/<id>` URL in a bubble, we fetch the group
// preview and render name + member count + a Join/Open button that
// uses the in-app join flow (no round-trip to the landing page).
//
// Used by Chat.tsx (an invite link in a message → this card) and by
// the JoinGroup page (the /g/:id route — someone opening the link
// directly on chat.rcq.app).

import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Api, ApiError, type GroupPreview } from '../lib/api'
import { useIdentity } from '../lib/identity-context'
import { useI18n } from '../lib/i18n-context'
import { GroupAvatar } from './GroupAvatar'

// Per-account cache of "which groups am I in", so the card can show
// Open vs Join without a fetch per render. Populated lazily on first
// card mount; the membership-changed ws event in Contacts already
// refreshes the user's own group list elsewhere, so a stale entry here
// only ever mislabels the button (the join call itself is idempotent).
const _myGroupIds = new Map<number, Set<number>>()

async function loadMyGroupIds(identity: Parameters<typeof Api.groups>[0]): Promise<Set<number>> {
  const cached = _myGroupIds.get(identity.uin)
  if (cached) return cached
  const groups = await Api.groups(identity)
  const ids = new Set(groups.map((g) => g.id))
  _myGroupIds.set(identity.uin, ids)
  return ids
}

interface Props {
  groupId: number
}

export function GroupJoinCard({ groupId }: Props) {
  const { identity } = useIdentity()
  const { t } = useI18n()
  const navigate = useNavigate()

  const [preview, setPreview] = useState<GroupPreview | null>(null)
  const [isMember, setIsMember] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [joining, setJoining] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  useEffect(() => {
    if (!identity) return
    let alive = true
    setLoading(true)
    setLoadError(null)
    void (async () => {
      try {
        const [p, ids] = await Promise.all([
          Api.groupPreview(identity, groupId),
          loadMyGroupIds(identity).catch(() => new Set<number>()),
        ])
        if (!alive) return
        setPreview(p)
        setIsMember(ids.has(groupId))
      } catch (e) {
        if (!alive) return
        setLoadError(
          e instanceof ApiError && e.status === 404
            ? t('group_join.gone')
            : t('group_join.error.generic'),
        )
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity?.uin, groupId])

  function open() {
    navigate(`/chat/g/${groupId}`)
  }

  async function join() {
    if (!identity || joining) return
    setJoining(true)
    setActionError(null)
    try {
      await Api.joinGroup(identity, groupId)
      // Keep the membership cache in step so re-rendered cards / the
      // contacts list reflect the new group immediately.
      _myGroupIds.get(identity.uin)?.add(groupId)
      navigate(`/chat/g/${groupId}`)
    } catch (e) {
      let msg = t('group_join.error.generic')
      if (e instanceof ApiError) {
        const code = parseErrorCode(e.body)
        if (code === 'group_closed') msg = t('group_join.closed_hint')
        else if (code === 'blocked') msg = t('group_join.error.blocked')
      }
      setActionError(msg)
    } finally {
      setJoining(false)
    }
  }

  // ---- render -------------------------------------------------------

  if (loading) {
    return (
      <div className="w-64 max-w-full rounded-xl border border-line bg-surface px-4 py-3">
        <div className="text-xs text-fg-dim">{t('group_join.loading')}</div>
      </div>
    )
  }
  if (loadError || !preview) {
    return (
      <div className="w-64 max-w-full rounded-xl border border-line bg-surface px-4 py-3">
        <div className="text-xs text-fg-dim">{loadError ?? t('group_join.error.generic')}</div>
      </div>
    )
  }

  const closedToMe = preview.is_closed && !isMember

  return (
    <div className="w-64 max-w-full rounded-xl border border-line bg-surface p-3">
      <div className="flex items-center gap-3">
        <GroupAvatar size={40} mediaId={preview.avatar_media_id} mediaKey={preview.avatar_media_key} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{preview.name}</div>
          <div className="truncate text-[11px] text-fg-dim">
            {t('section.groups.members', { n: preview.member_count })}
            {preview.owner_nickname ? ` · ${t('group_join.owner', { name: preview.owner_nickname })}` : ''}
          </div>
        </div>
      </div>

      <div className="mt-3">
        {isMember ? (
          <button
            onClick={open}
            className="w-full rounded-full bg-surface-dim py-2 text-xs font-medium hover:bg-line transition-colors"
          >
            {t('group_join.open_button')}
          </button>
        ) : closedToMe ? (
          <button
            disabled
            className="w-full rounded-full bg-surface-dim py-2 text-xs font-medium text-fg-dim cursor-not-allowed"
          >
            {t('group_join.closed_button')}
          </button>
        ) : (
          <button
            onClick={() => void join()}
            disabled={joining}
            className="w-full rounded-full bg-accent py-2 text-xs font-medium text-white hover:bg-accent-dim transition-colors disabled:opacity-50"
          >
            {joining ? t('group_join.joining') : t('group_join.button')}
          </button>
        )}
      </div>

      {closedToMe && (
        <div className="mt-2 text-[10px] text-fg-dim">{t('group_join.closed_hint')}</div>
      )}
      {actionError && (
        <div className="mt-2 text-[10px] text-red-500">{actionError}</div>
      )}
    </div>
  )
}

/// Pull a `{detail:{code}}` (or `{detail:"code"}`) string out of an
/// error body without throwing on non-JSON.
function parseErrorCode(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { detail?: unknown }
    const d = parsed.detail
    if (typeof d === 'string') return d
    if (d && typeof d === 'object' && 'code' in d) {
      const code = (d as { code?: unknown }).code
      return typeof code === 'string' ? code : null
    }
  } catch {
    /* non-JSON body */
  }
  return null
}
