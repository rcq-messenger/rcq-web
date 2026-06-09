// Contact list — sectioned by role (Favorites / Groups / Online /
// Offline / Archive). Each section is collapsible; the user's
// preference persists in localStorage. Per-row trailing has two
// buttons: open chat + open the action menu (favorite / mute /
// archive / block / remove). Live presence + contact-graph deltas
// arrive via WS; favorites/archive/mute live entirely in
// localStorage on this device.

import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ContactActionsMenu } from '../components/ContactActionsMenu'
import { CreateGroupSheet } from '../components/CreateGroupSheet'
import { GroupAvatar } from '../components/GroupAvatar'
import { StatusIcon } from '../components/StatusIcon'
import { StatusPickerButton } from '../components/StatusPicker'
import { ThemeToggle } from '../components/ThemeToggle'
import {
  Api,
  type Contact,
  type PendingRequest,
  type RCQGroup,
  type UserInfo,
  type UserStatus,
} from '../lib/api'
import { usePeerUnread, useGroupUnread } from '../lib/incoming-store'
import { useI18n } from '../lib/i18n-context'
import { useIdentity } from '../lib/identity-context'
import {
  useArchive,
  useCollapsedSections,
  useFavorites,
  useMutedPeers,
} from '../lib/local-store'
import { isPresenceSoundEnabled, playSound } from '../lib/sounds'
import { useWS } from '../lib/ws'

// Module-level cache of the contact-list data, keyed by UIN. The route
// component remounts on every navigation back to /contacts; without this it
// re-showed a loading spinner + re-fetched 4 endpoints each time. With it, a
// return paints the last-known list INSTANTLY and refreshes silently in the
// background.
interface ContactsSnapshot {
  contacts: Contact[]
  groups: RCQGroup[]
  pending: PendingRequest[]
  me: UserInfo | null
}
const _contactsCache = new Map<number, ContactsSnapshot>()

/// Best-effort name lookups off the warm contacts cache — used by the
/// in-app message toasts so a "push" shows the sender/group name. Null
/// when the cache is cold or the id isn't known.
export function lookupContactName(viewerUin: number, uin: number): string | null {
  return _contactsCache.get(viewerUin)?.contacts.find((c) => c.uin === uin)?.nickname || null
}
/// Last-known presence of a contact off the warm cache — used by the
/// message toasts so a "push" shows the sender's status dot, not just
/// the nick. Null when the cache is cold or the id isn't known.
export function lookupContactStatus(viewerUin: number, uin: number): UserStatus | null {
  return _contactsCache.get(viewerUin)?.contacts.find((c) => c.uin === uin)?.status ?? null
}
export function lookupGroupName(viewerUin: number, id: number): string | null {
  return _contactsCache.get(viewerUin)?.groups.find((g) => g.id === id)?.name || null
}

export function Contacts() {
  const { identity } = useIdentity()
  const { t } = useI18n()
  const ws = useWS()
  const navigate = useNavigate()

  const [contacts, setContacts] = useState<Contact[]>([])
  const [groups, setGroups] = useState<RCQGroup[]>([])
  const [pending, setPending] = useState<PendingRequest[]>([])
  const [me, setMe] = useState<UserInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [showCreateGroup, setShowCreateGroup] = useState(false)

  const favorites = useFavorites()
  const archive = useArchive()
  const muted = useMutedPeers()
  const collapsed = useCollapsedSections()

  async function refresh(background = false) {
    if (!identity) return
    setError(null)
    if (!background) setLoading(true)
    try {
      const [list, pendingList, myInfo, groupList] = await Promise.all([
        Api.contacts(identity),
        Api.pendingRequests(identity),
        Api.myInfo(identity),
        Api.groups(identity),
      ])
      setContacts(list)
      setPending(pendingList)
      setMe(myInfo)
      setGroups(groupList)
      _contactsCache.set(identity.uin, { contacts: list, groups: groupList, pending: pendingList, me: myInfo })
    } catch (e) {
      // On a background refresh keep the cached view; only surface errors on a cold load.
      if (!background) setError(e instanceof Error ? e.message : t('contacts.error'))
    } finally {
      if (!background) setLoading(false)
    }
  }

  useEffect(() => {
    if (!identity) return
    const cached = _contactsCache.get(identity.uin)
    if (cached) {
      // Instant paint from cache, then refresh silently.
      setContacts(cached.contacts)
      setGroups(cached.groups)
      setPending(cached.pending)
      setMe(cached.me)
      setLoading(false)
      void refresh(true)
    } else {
      void refresh()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity?.uin])

  useEffect(() => {
    const offPresence = ws.on('presence', (ev) => {
      const u = ev.uin as number | undefined
      const s = ev.status as UserStatus | undefined
      if (typeof u !== 'number' || typeof s !== 'string') return
      setContacts((prev) => {
        const before = prev.find((c) => c.uin === u)
        if (before && !muted.has(u) && isPresenceSoundEnabled()) {
          // Treat away/dnd as "around" so an offline→away transition still
          // chimes like a come-online (matches the section bucketing).
          const around = (st: UserStatus) => st === 'online' || st === 'away' || st === 'dnd'
          const wasAround = around(before.status)
          const isAround = around(s)
          if (!wasAround && isAround) playSound('contact_online')
          else if (wasAround && !isAround) playSound('contact_offline')
        }
        return prev.map((c) =>
          c.uin === u
            ? { ...c, status: s, status_message: (ev.status_message as string | undefined) ?? c.status_message }
            : c,
        )
      })
    })
    const offResponse = ws.on('contact_response', () => void refresh(true))
    const offRequest = ws.on('contact_request', () => {
      if (!identity) return
      Api.pendingRequests(identity).then(setPending).catch(() => {})
    })
    return () => {
      offPresence()
      offResponse()
      offRequest()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity?.uin, muted])

  // Reflect our OWN status as online once the socket is up. The backend
  // heals a default "offline" → "online" in `_on_connect`, but a fresh
  // login fetches /myInfo BEFORE that connect runs, so the picker showed
  // the stale offline state until a reload. Flip it locally on connect
  // (only when it's the unset "offline" default — a user-chosen
  // away/dnd/invisible is left alone). Also keep the cache in step.
  useEffect(() => {
    if (!ws.connected || !identity) return
    setMe((prev) => {
      if (!prev || prev.status !== 'offline') return prev
      const updated = { ...prev, status: 'online' as UserStatus }
      const cached = _contactsCache.get(identity.uin)
      if (cached) _contactsCache.set(identity.uin, { ...cached, me: updated })
      return updated
    })
    // If the user added their OWN UIN as a contact, that row never gets a
    // presence event (you don't watch yourself) so it sat at offline. Heal
    // it to online on connect, mirroring the server's own heal.
    setContacts((prev) =>
      prev.some((c) => c.uin === identity.uin && c.status !== 'online')
        ? prev.map((c) => (c.uin === identity.uin ? { ...c, status: 'online' as UserStatus } : c))
        : prev,
    )
  }, [ws.connected, identity?.uin])

  if (!identity) {
    navigate('/', { replace: true })
    return null
  }

  // Bucket contacts. A contact lives in exactly one bucket at a
  // time; archive wins over favorite which wins over status. iOS
  // does the same — sees the user's most-recent intent.
  const archived: Contact[] = []
  const fav: Contact[] = []
  const online: Contact[] = []
  const offline: Contact[] = []
  // Any "present" status counts as around → online section. Previously
  // only 'online' did, so away/dnd users wrongly fell into Offline.
  // (invisible already reports as offline from the server.)
  const isAround = (s: UserStatus) => s === 'online' || s === 'away' || s === 'dnd'
  for (const c of contacts) {
    if (archive.has(c.uin)) archived.push(c)
    else if (favorites.has(c.uin)) fav.push(c)
    else if (isAround(c.status)) online.push(c)
    else offline.push(c)
  }
  const sortByNick = (a: Contact, b: Contact) => a.nickname.localeCompare(b.nickname)
  fav.sort(sortByNick)
  online.sort(sortByNick)
  offline.sort(sortByNick)
  archived.sort(sortByNick)

  return (
    <div className="min-h-screen bg-surface-dim">
      <header className="sticky top-0 bg-surface border-b border-line z-10">
        <div className="max-w-2xl mx-auto px-3 h-14 flex items-center gap-2">
          {me && (
            <>
              <StatusPickerButton
                current={me.status}
                onChange={(s) => setMe({ ...me, status: s })}
              />
              <Link
                to="/profile"
                className="flex flex-col leading-tight min-w-0 hover:opacity-80 transition-opacity"
              >
                <span className="font-semibold text-sm truncate">
                  {me.nickname || `#${me.uin}`}
                </span>
                <span className="font-mono text-[10px] text-fg-dim">#{me.uin}</span>
              </Link>
            </>
          )}
          <div className="ml-auto flex items-center gap-0.5">
            <Link
              to="/add"
              className="text-fg-secondary hover:text-fg-primary p-2 rounded-md hover:bg-surface-dim"
              title={t('contacts.add')}
              aria-label={t('contacts.add')}
            >
              <PlusIcon />
            </Link>
            <Link
              to="/pending"
              className="relative text-fg-secondary hover:text-fg-primary p-2 rounded-md hover:bg-surface-dim"
              title={t('pending.title')}
              aria-label={t('pending.title')}
            >
              <BellIcon />
              {pending.length > 0 && (
                <span className="absolute top-0.5 right-0.5 min-w-[16px] h-[16px] px-1 rounded-full bg-red-500 text-white text-[10px] font-bold flex items-center justify-center">
                  {pending.length}
                </span>
              )}
            </Link>
            <ThemeToggle className="text-fg-secondary hover:text-fg-primary p-2 rounded-md hover:bg-surface-dim transition-colors" />
            <Link
              to="/settings"
              className="text-fg-secondary hover:text-fg-primary p-2 rounded-md hover:bg-surface-dim"
              title={t('contacts.settings')}
              aria-label={t('contacts.settings')}
            >
              <CogIcon />
            </Link>
          </div>
        </div>
      </header>

      <main className="max-w-2xl mx-auto px-4 py-4 space-y-4">
        {loading && contacts.length === 0 && (
          <div className="text-center text-sm text-fg-secondary py-12">{t('contacts.loading')}</div>
        )}

        {error && (
          <div className="bg-red-50 border border-red-200 rounded-md p-3 text-sm text-red-600 mb-4">
            {error}
            <button onClick={() => void refresh()} className="ml-3 underline">{t('common.retry')}</button>
          </div>
        )}

        {!loading && contacts.length === 0 && !error && (
          <div className="text-center text-sm text-fg-secondary py-12 space-y-2">
            <div>{t('contacts.empty')}</div>
            <Link
              to="/add"
              className="inline-block mt-3 px-4 h-10 leading-10 rounded-md bg-accent hover:bg-accent-dim text-white text-sm font-semibold transition-colors"
            >
              {t('contacts.add')}
            </Link>
          </div>
        )}

        {fav.length > 0 && (
          <Section
            id="fav"
            title={t('section.favorites')}
            count={fav.length}
            collapsed={collapsed}
          >
            {fav.map((c) => (
              <ContactRow
                key={c.uin}
                contact={c}
                muted={muted.has(c.uin)}
                favorite
                onChanged={refresh}
              />
            ))}
          </Section>
        )}

        <Section
          id="groups"
          title={t('section.groups')}
          count={groups.length}
          collapsed={collapsed}
          rightAction={
            <button
              onClick={() => setShowCreateGroup(true)}
              className="text-xs text-accent hover:text-accent-dim font-semibold px-2 py-1"
            >
              {t('section.groups.create')}
            </button>
          }
        >
          {groups.length === 0 ? (
            <li className="px-4 py-3 text-xs text-fg-dim">{t('section.groups.empty')}</li>
          ) : (
            groups.map((g) => <GroupRow key={g.id} group={g} />)
          )}
        </Section>

        {online.length > 0 && (
          <Section
            id="online"
            title={t('section.online')}
            count={online.length}
            collapsed={collapsed}
          >
            {online.map((c) => (
              <ContactRow
                key={c.uin}
                contact={c}
                muted={muted.has(c.uin)}
                onChanged={refresh}
              />
            ))}
          </Section>
        )}

        {offline.length > 0 && (
          <Section
            id="offline"
            title={t('section.offline')}
            count={offline.length}
            collapsed={collapsed}
          >
            {offline.map((c) => (
              <ContactRow
                key={c.uin}
                contact={c}
                muted={muted.has(c.uin)}
                onChanged={refresh}
              />
            ))}
          </Section>
        )}

        {archived.length > 0 && (
          <Section
            id="archive"
            title={t('section.archive')}
            count={archived.length}
            collapsed={collapsed}
            collapsedByDefault
          >
            {archived.map((c) => (
              <ContactRow
                key={c.uin}
                contact={c}
                muted={muted.has(c.uin)}
                archived
                onChanged={refresh}
              />
            ))}
          </Section>
        )}
      </main>

      {showCreateGroup && (
        <CreateGroupSheet
          contacts={contacts}
          onClose={() => setShowCreateGroup(false)}
          onCreated={() => {
            setShowCreateGroup(false)
            void refresh()
          }}
        />
      )}
    </div>
  )
}

// -----------------------------------------------------------
// Section wrapper with collapsible header
// -----------------------------------------------------------

function Section({
  id,
  title,
  count,
  children,
  collapsed,
  collapsedByDefault,
  rightAction,
}: {
  id: string
  title: string
  count: number
  children: React.ReactNode
  collapsed: { has: (id: string) => boolean; toggle: (id: string) => void }
  collapsedByDefault?: boolean
  rightAction?: React.ReactNode
}) {
  // The collapsed-set tracks user-toggled state; for sections that
  // start collapsed (Archive), we invert: the absence of the id
  // in the set means "use default" → render collapsed.
  const userToggled = collapsed.has(id)
  const isCollapsed = collapsedByDefault ? !userToggled : userToggled

  return (
    <section>
      <div className="flex items-center justify-between mb-1.5 px-2">
        <button
          onClick={() => collapsed.toggle(id)}
          className="flex items-center gap-1.5 text-xs font-bold text-fg-secondary uppercase tracking-wider hover:text-fg-primary"
        >
          <span className="text-fg-dim">{isCollapsed ? '▸' : '▾'}</span>
          {title}
          <span className="text-fg-dim font-mono">·{count}</span>
        </button>
        {rightAction}
      </div>
      {/* NOT overflow-hidden — that clipped the absolutely-positioned contact
          action menu (the three-dots dropdown). Instead round the full-row
          hover targets (the row links) at the section edges so the hover bg
          doesn't poke past the rounded corners. */}
      {!isCollapsed && (
        <ul className="bg-surface rounded-lg border border-line divide-y divide-line [&_li:first-child_a]:rounded-t-lg [&_li:last-child_a]:rounded-b-lg">
          {children}
        </ul>
      )}
    </section>
  )
}

// -----------------------------------------------------------
// Contact row — status icon + name + status message + chat /
// "more" trailing buttons. Action menu pops up under the more
// button on tap.
// -----------------------------------------------------------

function ContactRow({
  contact,
  muted,
  favorite,
  archived,
  onChanged,
}: {
  contact: Contact
  muted: boolean
  favorite?: boolean
  archived?: boolean
  onChanged: () => void
}) {
  const { t } = useI18n()
  const [menuOpen, setMenuOpen] = useState(false)
  const unread = usePeerUnread(contact.uin)
  return (
    <li className="relative">
      <div className={'flex items-center gap-3 px-4 py-3 ' + (archived ? 'opacity-60' : '')}>
        {/* Tapping the card opens the CHAT (the primary action). The
            profile is a dedicated button below. */}
        <Link
          to={`/chat/${contact.uin}`}
          className="flex items-center gap-3 flex-1 min-w-0"
          aria-label={t('contacts.open_chat')}
        >
          <StatusIcon status={contact.status} size={20} />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5">
              <span className={'truncate ' + (unread > 0 ? 'font-bold' : 'font-medium')}>
                {contact.nickname || `#${contact.uin}`}
              </span>
              <GenderIcon gender={contact.gender} />
              {favorite && <span className="text-yellow-500 text-xs flex-none">★</span>}
              {muted && <span className="text-fg-dim text-xs flex-none">🔕</span>}
              {contact.blocked && <BlockedIcon />}
            </div>
            <div className="flex items-center gap-1.5 text-xs text-fg-dim min-w-0">
              <span className="font-mono flex-none">#{contact.uin}</span>
              {contact.status_message && (
                <span className="truncate">· {contact.status_message}</span>
              )}
            </div>
          </div>
        </Link>
        {unread > 0 && <UnreadBadge n={unread} />}
        <Link
          to={`/profile/${contact.uin}`}
          className="text-fg-secondary hover:text-accent p-2 rounded-md hover:bg-surface"
          title={t('contacts.open_profile')}
          aria-label={t('contacts.open_profile')}
        >
          <PersonIcon />
        </Link>
        <button
          onClick={() => setMenuOpen((v) => !v)}
          className="text-fg-secondary hover:text-fg-primary p-2 rounded-md hover:bg-surface"
          aria-label={t('contacts.more')}
          title={t('contacts.more')}
        >
          <MoreIcon />
        </button>
      </div>
      {menuOpen && (
        <ContactActionsMenu
          contact={contact}
          onClose={() => setMenuOpen(false)}
          onChanged={onChanged}
        />
      )}
    </li>
  )
}

function GroupRow({ group }: { group: RCQGroup }) {
  const { t } = useI18n()
  const unread = useGroupUnread(group.id)
  return (
    <li>
      <Link
        to={`/chat/g/${group.id}`}
        className="flex items-center gap-3 px-4 py-3 hover:bg-surface-dim transition-colors"
      >
        <GroupAvatar size={28} mediaId={group.avatar_media_id} mediaKey={group.avatar_media_key} />
        <div className="flex-1 min-w-0">
          <div className={'truncate ' + (unread > 0 ? 'font-bold' : 'font-medium')}>{group.name}</div>
          <div className="text-xs text-fg-dim">
            {t('section.groups.members', { n: group.members.length })}
          </div>
        </div>
        {unread > 0 && <UnreadBadge n={unread} />}
        <Link
          to={`/groups/${group.id}`}
          onClick={(e) => e.stopPropagation()}
          className="text-fg-secondary hover:text-fg-primary px-2"
          title={t('contacts.more')}
        >
          <MoreIcon />
        </Link>
      </Link>
    </li>
  )
}

// SVG icons -------------------------------------------------------

function PlusIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M10 4v12M4 10h12" />
    </svg>
  )
}

function BellIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 8a5 5 0 1 1 10 0v3l1.5 2.5h-13L5 11V8z" />
      <path d="M8 16a2 2 0 0 0 4 0" />
    </svg>
  )
}
function CogIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9.6 3.5a2 2 0 0 1 4.8 0l.2.7a8 8 0 0 1 1.4.6l.7-.3a2 2 0 0 1 2.7 2.7l-.3.7a8 8 0 0 1 .6 1.4l.7.2a2 2 0 0 1 0 4.8l-.7.2a8 8 0 0 1-.6 1.4l.3.7a2 2 0 0 1-2.7 2.7l-.7-.3a8 8 0 0 1-1.4.6l-.2.7a2 2 0 0 1-4.8 0l-.2-.7a8 8 0 0 1-1.4-.6l-.7.3a2 2 0 0 1-2.7-2.7l.3-.7a8 8 0 0 1-.6-1.4l-.7-.2a2 2 0 0 1 0-4.8l.7-.2a8 8 0 0 1 .6-1.4l-.3-.7a2 2 0 0 1 2.7-2.7l.7.3a8 8 0 0 1 1.4-.6l.2-.7z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  )
}
function PersonIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="8" r="3.5" />
      <path d="M5 20c0-3.3 3.1-5.5 7-5.5s7 2.2 7 5.5" />
    </svg>
  )
}
/// Gender glyph next to a contact's name (iOS/Android parity). Male = blue ♂,
/// female = pink ♀; anything else renders nothing.
function GenderIcon({ gender }: { gender?: string | null }) {
  const g = (gender || '').toLowerCase()
  if (g === 'm' || g === 'male') return <span className="text-xs flex-none" style={{ color: '#4A90D9' }}>♂</span>
  if (g === 'f' || g === 'female') return <span className="text-xs flex-none" style={{ color: '#D96BA6' }}>♀</span>
  return null
}
/// Blocked marker — a red crossed circle (⊘), replaces the old "BLOCKED"
/// text tag.
function BlockedIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      className="text-red-500 flex-none"
      aria-label="blocked"
    >
      <circle cx="12" cy="12" r="9" />
      <line x1="5.6" y1="5.6" x2="18.4" y2="18.4" />
    </svg>
  )
}
/// Unread-count pill, accent-filled. Caps the display at 99+.
function UnreadBadge({ n }: { n: number }) {
  return (
    <span className="flex-none min-w-[20px] h-5 px-1.5 rounded-full bg-accent text-white text-[11px] font-bold flex items-center justify-center">
      {n > 99 ? '99+' : n}
    </span>
  )
}
function MoreIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor">
      <circle cx="4" cy="10" r="1.5" />
      <circle cx="10" cy="10" r="1.5" />
      <circle cx="16" cy="10" r="1.5" />
    </svg>
  )
}
