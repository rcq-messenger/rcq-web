// 1:1 + group chat surface (send-only). The route shape encodes
// which thread is open:
//   /chat/<uin>      → 1:1 with a contact
//   /chat/g/<id>     → group with N members (per-member fan-out)
//
// Phase-1 doesn't render incoming messages — peer/group replies
// ride v=2 envelopes which need libsignal-WASM to decrypt. The
// outgoing log lives in component state; reloads wipe it.
//
// Outgoing log supports reactions, replies, and forwards on top of
// plain text. All three target rows IN THE OUTGOING LOG (we have no
// incoming yet). Forwards write into the target thread's storage
// so the forwarded message shows up there when the user navigates.

import { useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence } from 'framer-motion'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { EmoticonPicker } from '../components/EmoticonPicker'
import { EmoticonText } from '../components/EmoticonText'
import { ForwardModal, type ForwardTarget } from '../components/ForwardModal'
import { ReactionPicker } from '../components/ReactionPicker'
import { StatusIcon } from '../components/StatusIcon'
import { Api, peerBundleFrom, type Contact, type RCQGroup, type UserInfo } from '../lib/api'
import {
  useIncoming,
  useGroupIncoming,
  setActiveThread,
  applyReaction,
  reactionsForTarget,
  aggregateReactions,
  useReactionsVersion,
} from '../lib/incoming-store'
import { sendV2 } from '../lib/signal-device'
import {
  encryptV1,
  bytesToB64,
  newUUIDv4,
  type CarbonEnvelope,
  type Envelope,
  type ReactionEnvelope,
  type ReplyContext,
  type TextEnvelope,
} from '../lib/crypto'
import {
  type OutgoingRow,
  storageKey,
  loadPersisted,
  savePersisted,
  appendToThreadLog,
  setOutgoingSink,
} from '../lib/outgoing-store'
import { encryptGroupEnvelope } from '../lib/group-crypto'
import { parseGroupInviteId } from '../lib/group-invite'
import { GroupJoinCard } from '../components/GroupJoinCard'
import { GroupAvatar } from '../components/GroupAvatar'
import { DecryptedImage } from '../components/DecryptedImage'
import { uploadEncryptedImage } from '../lib/media'
import { emoticonAssetURL } from '../lib/emoticons'
import { useI18n } from '../lib/i18n-context'
import { useIdentity } from '../lib/identity-context'
import { playSound } from '../lib/sounds'

const REACTION_SUPPORTED_KINDS = new Set<Envelope['kind']>(['text', 'reaction', 'photo'])

/// Message kinds we mirror to the user's other devices via a carbon
/// (NOT reactions — those sync through their own self-echo).
const CARBON_KINDS = new Set<Envelope['kind']>(['text', 'photo'])

function buildSnippet(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  return collapsed.length > 60 ? collapsed.slice(0, 60) + '…' : collapsed
}

export function Chat() {
  const { identity } = useIdentity()
  const { t } = useI18n()
  const navigate = useNavigate()
  const params = useParams<{ uin?: string; groupId?: string }>()
  const isGroup = params.groupId != null
  const peerUIN = isGroup ? null : Number(params.uin)
  const groupId = isGroup ? Number(params.groupId) : null

  // Per-thread persistence key. Recomputed every render — cheap;
  // string formatting only.
  const persistKey = isGroup && groupId != null
    ? storageKey(true, groupId)
    : peerUIN != null
      ? storageKey(false, peerUIN)
      : null

  const [peer, setPeer] = useState<Contact | null>(null)
  const [group, setGroup] = useState<RCQGroup | null>(null)
  const [myInfo, setMyInfo] = useState<UserInfo | null>(null)
  const [input, setInput] = useState('')
  const [showPicker, setShowPicker] = useState(false)
  const [uploadingPhoto, setUploadingPhoto] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  // The scrolling message pane (<main>). We scroll this element directly to
  // its bottom rather than scrollIntoView-ing a zero-height anchor — the
  // anchor approach was landing short, leaving the newest messages tucked
  // behind the sticky composer when a thread opened (founder report).
  const scrollRef = useRef<HTMLDivElement>(null)
  // Lazy initial loader pulls the persisted log straight off
  // localStorage so the first paint already shows the user's
  // history. New rows append + write-through; failed-on-reload
  // rows surface with a red bang so the user can retry.
  const [outgoing, setOutgoing] = useState<OutgoingRow[]>(() =>
    persistKey ? loadPersisted(persistKey) : [],
  )
  const [error, setError] = useState<string | null>(null)
  const [actionsForRowId, setActionsForRowId] = useState<string | null>(null)
  const [reactionForRowId, setReactionForRowId] = useState<string | null>(null)
  const [forwardingRow, setForwardingRow] = useState<OutgoingRow | null>(null)
  const [replyTo, setReplyTo] = useState<ReplyContext | null>(null)
  const [transientNotice, setTransientNotice] = useState<string | null>(null)
  // Decrypted incoming messages, fed by the app-wide MessageReceiver (ws +
  // offline-queue → libsignal decrypt). 1:1 keyed by peer, group by group_id.
  const peerIncoming = useIncoming(isGroup ? null : peer?.uin ?? null)
  const groupIncoming = useGroupIncoming(isGroup ? group?.id ?? null : null)
  const incoming = isGroup ? groupIncoming : peerIncoming
  // Re-render this view whenever ANY reaction changes (received or our own
  // optimistic toggle); the per-row chips read the store directly.
  useReactionsVersion()

  const myNickname = useMemo<string>(
    () => myInfo?.nickname ?? t('chat.you'),
    [myInfo, t],
  )

  // When the user navigates between chats the component is reused
  // with new route params. Reload the outgoing log from the new
  // thread's storage key so the previous chat's bubbles don't
  // bleed in. Reset transient UI (action menu, reply mode) too.
  useEffect(() => {
    if (!persistKey) return
    setOutgoing(loadPersisted(persistKey))
    setActionsForRowId(null)
    setReactionForRowId(null)
    setReplyTo(null)
  }, [persistKey])

  // Persist on every change. Cheaper than a debounce here — the
  // thread's full log fits in a few KB even at the cap, and
  // localStorage writes are sync but not on the main render path
  // (effect runs after commit).
  useEffect(() => {
    if (!persistKey) return
    savePersisted(persistKey, outgoing)
  }, [persistKey, outgoing])

  useEffect(() => {
    if (!identity) return
    void (async () => {
      try {
        if (isGroup && groupId != null) {
          setGroup(await Api.groupInfo(identity, groupId))
        } else if (peerUIN != null) {
          const list = await Api.contacts(identity)
          const found = list.find((c) => c.uin === peerUIN)
          if (!found) {
            setError(t('chat.error.peer_not_in_contacts', { uin: peerUIN }))
            return
          }
          setPeer(found)
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : t('chat.error.peer_load_failed'))
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity, peerUIN, groupId, isGroup])

  // Pull own profile once for the nickname — used as authorName on
  // replies-to-self and as fwdName on forwards. Best-effort; if it
  // fails we fall back to a localised "you" label.
  useEffect(() => {
    if (!identity) return
    void Api.myInfo(identity).then(setMyInfo).catch(() => {})
  }, [identity])

  // Keep the newest message in view. On a THREAD switch jump instantly to
  // the bottom (no animated scroll through the whole history — that was the
  // jarring "reel everything down on open"); for a NEW message in the open
  // thread, smooth-scroll so it slides into view. We detect a thread switch
  // by comparing persistKey across renders.
  const lastThreadRef = useRef<string | null>(null)
  useEffect(() => {
    const switched = lastThreadRef.current !== persistKey
    lastThreadRef.current = persistKey
    const el = scrollRef.current
    if (!el) return
    const behavior: ScrollBehavior = switched ? 'auto' : 'smooth'
    // Defer past layout so late content (queued history, decrypted images)
    // is measured before we pin to the bottom — otherwise the jump lands
    // short and the last bubbles hide under the composer.
    requestAnimationFrame(() => el.scrollTo({ top: el.scrollHeight, behavior }))
  }, [outgoing.length, incoming.length, persistKey])

  // Mark this thread as the active one: clears its unread badge on open
  // and suppresses in-app toasts for messages that land while it's open.
  useEffect(() => {
    const key = isGroup && groupId != null ? `g:${groupId}` : peerUIN != null ? `p:${peerUIN}` : null
    setActiveThread(key)
    return () => setActiveThread(null)
  }, [isGroup, groupId, peerUIN])

  // Register a live sink so multi-device carbons (a message this user sent
  // from another device) for the OPEN thread appear instantly — merged into
  // state, deduped by id. Carbons for other threads go to localStorage.
  useEffect(() => {
    if (!persistKey) return
    setOutgoingSink(persistKey, (row) =>
      setOutgoing((rows) => (rows.some((r) => r.id === row.id) ? rows : [...rows, row])),
    )
    return () => setOutgoingSink(null, null)
  }, [persistKey])

  // Auto-clear the transient notice (forward toast) after a moment
  // so it doesn't linger on the screen.
  useEffect(() => {
    if (!transientNotice) return
    const handle = setTimeout(() => setTransientNotice(null), 2200)
    return () => clearTimeout(handle)
  }, [transientNotice])

  if (!identity) {
    navigate('/', { replace: true })
    return null
  }

  /// Encrypt + ship one envelope to the current thread. Used by text
  /// sends, retries, and reaction broadcasts — keeps the crypto path
  /// single-source so all three exercise the same fan-out logic.
  /// Returns true on success.
  async function shipEnvelopeToCurrentThread(envelope: Envelope): Promise<{ ok: true } | { ok: false; error: string }> {
    if (!identity) return { ok: false, error: 'no identity' }
    if (!REACTION_SUPPORTED_KINDS.has(envelope.kind)) {
      return { ok: false, error: `unsupported envelope kind: ${envelope.kind}` }
    }
    try {
      if (isGroup && group) {
        const { payloads, skipped } = encryptGroupEnvelope(envelope, identity, group.members)
        if (payloads.length === 0) {
          throw new Error(
            skipped.length > 0
              ? t('chat.error.group_no_valid_members')
              : t('chat.error.group_empty'),
          )
        }
        await Api.sendGroupSealed(identity, group.id, payloads)
      } else if (peer) {
        // Prefer v=2 (libsignal Double Ratchet): fan out one ciphertext per
        // device of the peer. If the peer has published NO libsignal bundle
        // (reached === 0 — e.g. a Stage-2-only account), fall back to the
        // v=1 ECIES envelope so the message still goes through.
        const reached = await sendV2(identity, peer.uin, envelope).catch(() => 0)
        if (reached === 0) {
          const wireB64 = encryptV1(envelope, identity, peerBundleFrom(peer))
          await Api.sendSealed(identity, peer.uin, wireB64)
        }
      } else {
        throw new Error('no target')
      }
      // Mirror this message to the user's other devices (best-effort).
      void sendMessageCarbon(envelope)
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : t('chat.error.send_failed') }
    }
  }

  /// Mirror a just-sent message to the user's OTHER devices: seal a `carbon`
  /// (the original envelope + its destination) to our own identity and deposit
  /// it to our own uin. The other device unwraps it and files the inner
  /// message as fromMe in the destination thread; the origin device dedups its
  /// own carbon by id. Reactions are excluded (they sync via their own
  /// self-echo). Best-effort — the message already went out.
  async function sendMessageCarbon(inner: Envelope) {
    if (!identity || !CARBON_KINDS.has(inner.kind)) return
    try {
      const carbon: CarbonEnvelope = {
        kind: 'carbon',
        to: isGroup ? null : peer?.uin ?? null,
        gid: isGroup ? group?.id ?? null : null,
        env: inner,
      }
      const selfBundle = peerBundleFrom({
        uin: identity.uin,
        identity_key: bytesToB64(identity.identityPub),
        signing_key: bytesToB64(identity.signingPub),
      })
      const wireB64 = encryptV1(carbon, identity, selfBundle)
      // Non-pushable type — syncs over WS / the per-device queue, never pushes
      // a "new message" alert to our own phone for a message we sent.
      await Api.sendSealed(identity, identity.uin, wireB64, 'carbon')
    } catch {
      /* best-effort multi-device echo; ignore */
    }
  }

  async function attemptSendRow(row: OutgoingRow) {
    const env: Envelope =
      row.kind === 'photo' && row.mediaId && row.mediaKey
        ? {
            kind: 'photo',
            id: row.id,
            mediaID: row.mediaId,
            mediaKey: row.mediaKey,
            ...(row.text ? { caption: row.text } : {}),
            ...(row.replyTo ? { reply: row.replyTo } : {}),
            ...(row.fwdName ? { fwdName: row.fwdName } : {}),
          }
        : {
            kind: 'text',
            id: row.id,
            text: row.text,
            ...(row.replyTo ? { reply: row.replyTo } : {}),
            ...(row.fwdName ? { fwdName: row.fwdName } : {}),
          }
    const res = await shipEnvelopeToCurrentThread(env)
    if (res.ok) {
      setOutgoing((rows) =>
        rows.map((r) => (r.id === row.id ? { ...r, state: 'sent', error: undefined } : r)),
      )
      playSound('message_sent')
    } else {
      setOutgoing((rows) =>
        rows.map((r) => (r.id === row.id ? { ...r, state: 'failed', error: res.error } : r)),
      )
    }
  }

  async function send() {
    if (!identity) return
    const trimmed = input.trim()
    if (!trimmed) return

    const msgId = newUUIDv4()
    const row: OutgoingRow = {
      id: msgId,
      text: trimmed,
      sentAt: Date.now(),
      state: 'sending',
      ...(replyTo ? { replyTo } : {}),
    }
    setOutgoing((rows) => [...rows, row])
    setInput('')
    setShowPicker(false)
    setReplyTo(null)
    await attemptSendRow(row)
  }

  /// Unblock the current peer (from the blocked-composer banner) so the
  /// user can message again. Optimistically clears the local blocked flag.
  async function unblockPeer() {
    if (!identity || !peer) return
    try {
      await Api.blockContact(identity, peer.uin, false)
      setPeer({ ...peer, blocked: false })
    } catch (e) {
      setTransientNotice(e instanceof Error ? e.message : t('chat.error.send_failed'))
    }
  }

  /// Pick → encrypt → upload → send a photo. The upload happens before
  /// the row appears so a failed upload doesn't leave a dangling bubble;
  /// once uploaded it goes through the same encrypt+fan-out send path as
  /// text (as a `photo` envelope). Caption support is a later add.
  async function sendPhoto(file: File) {
    if (!identity || uploadingPhoto) return
    setUploadingPhoto(true)
    try {
      const up = await uploadEncryptedImage(identity.apiBase, file)
      if (!up) {
        setTransientNotice(t('chat.error.upload_failed'))
        return
      }
      const row: OutgoingRow = {
        id: newUUIDv4(),
        text: '',
        sentAt: Date.now(),
        state: 'sending',
        kind: 'photo',
        mediaId: up.mediaId,
        mediaKey: up.keyB64,
        ...(replyTo ? { replyTo } : {}),
      }
      setOutgoing((rows) => [...rows, row])
      setReplyTo(null)
      await attemptSendRow(row)
    } finally {
      setUploadingPhoto(false)
    }
  }

  /// User-tapped retry on a failed row. Flip back to 'sending' so the
  /// UI updates immediately, then run the same encrypt+POST path. The
  /// row keeps its original `sentAt` and UUID — only the state and
  /// error fields churn.
  async function retry(msgId: string) {
    const row = outgoing.find((r) => r.id === msgId)
    if (!row) return
    setOutgoing((rows) =>
      rows.map((r) => (r.id === msgId ? { ...r, state: 'sending', error: undefined } : r)),
    )
    await attemptSendRow({ ...row, state: 'sending', error: undefined })
  }

  /// Drop a permanently-failed row from the log. Used when the user
  /// has decided the message will never go through (e.g., contact was
  /// removed) and doesn't want the red bang lingering.
  function dismiss(msgId: string) {
    setOutgoing((rows) => rows.filter((r) => r.id !== msgId))
  }

  /// Toggle a reaction asset on a row. Optimistic — apply locally
  /// first, then ship the envelope. On failure revert and surface a
  /// toast so the user knows it didn't go through. Tapping the same
  /// asset twice clears it.
  /// Toggle a reaction asset on ANY message (mine or the peer's), keyed
  /// by the target id in the shared reactions store. Optimistic — apply
  /// locally first, then ship the envelope; revert + surface a toast on
  /// failure. Tapping the same asset twice clears it.
  async function toggleReaction(targetId: string, asset: string | null) {
    if (!identity) return
    const myUin = identity.uin
    const current = reactionsForTarget(targetId)?.get(myUin) ?? null
    const next = current === asset ? null : asset
    applyReaction(targetId, myUin, next)
    setReactionForRowId(null)
    setActionsForRowId(null)
    const env: ReactionEnvelope = { kind: 'reaction', targetID: targetId, asset: next }
    const res = await shipEnvelopeToCurrentThread(env)
    if (!res.ok) {
      applyReaction(targetId, myUin, current)
      setTransientNotice(res.error)
      return
    }
    // Echo to your OWN other devices (linked phone / second browser): seal the
    // reaction to your own identity (v=1) and deposit to your own uin. The
    // receiver applies reactions by target id (global store), so it lands on the
    // same message there. Best-effort — the reaction itself already went out.
    void sendReactionSelfEcho(env)
  }

  /// Seal a reaction to the local user's own identity and deposit it to their
  /// own uin, so a reaction made here syncs to their other logged-in devices.
  async function sendReactionSelfEcho(env: ReactionEnvelope) {
    if (!identity) return
    try {
      const selfBundle = peerBundleFrom({
        uin: identity.uin,
        identity_key: bytesToB64(identity.identityPub),
        signing_key: bytesToB64(identity.signingPub),
      })
      const wireB64 = encryptV1(env, identity, selfBundle)
      await Api.sendSealed(identity, identity.uin, wireB64)
    } catch {
      /* best-effort multi-device echo; ignore */
    }
  }

  /// Enter reply mode for any message (mine or the peer's). The composer
  /// renders a quote-block above the textarea; the next send includes it
  /// as a `ReplyContext` so the recipient sees the quote rendered.
  function startReplyTo(id: string, text: string, authorName: string) {
    setReplyTo({ id, snippet: buildSnippet(text), authorName })
    setActionsForRowId(null)
  }
  function startReply(row: OutgoingRow) {
    startReplyTo(row.id, row.text, myNickname)
  }

  function cancelReply() {
    setReplyTo(null)
  }

  /// Forward a row to another thread. Builds a fresh OutgoingRow with
  /// the same text + `fwdName` set to my own nickname (the original
  /// author from the recipient's perspective), encrypts to the picked
  /// target, and writes the row into the *target* thread's storage
  /// so navigating there reveals it. We don't append it to the
  /// current thread's log.
  async function forwardTo(row: OutgoingRow, target: ForwardTarget) {
    if (!identity) return
    const newId = newUUIDv4()
    const fwdName = myNickname
    const env: TextEnvelope = { kind: 'text', id: newId, text: row.text, fwdName }
    try {
      if (target.kind === 'group') {
        const { payloads, skipped } = encryptGroupEnvelope(env, identity, target.group.members)
        if (payloads.length === 0) {
          throw new Error(
            skipped.length > 0
              ? t('chat.error.group_no_valid_members')
              : t('chat.error.group_empty'),
          )
        }
        await Api.sendGroupSealed(identity, target.id, payloads)
      } else {
        const wireB64 = encryptV1(env, identity, peerBundleFrom(target.contact))
        await Api.sendSealed(identity, target.uin, wireB64)
      }
      const newRow: OutgoingRow = {
        id: newId,
        text: row.text,
        sentAt: Date.now(),
        state: 'sent',
        fwdName,
      }
      const targetKey =
        target.kind === 'group'
          ? storageKey(true, target.id)
          : storageKey(false, target.uin)
      appendToThreadLog(targetKey, newRow)
      playSound('message_sent')
      setForwardingRow(null)
      setActionsForRowId(null)
      setTransientNotice(`${t('chat.forward.sent')}: ${target.name}`)
    } catch (e) {
      setTransientNotice(e instanceof Error ? e.message : t('chat.error.send_failed'))
    }
  }

  function toggleActions(rowId: string) {
    setActionsForRowId((prev) => (prev === rowId ? null : rowId))
    setReactionForRowId(null)
  }

  /// Reaction chips under a bubble — one per distinct asset with a count;
  /// the viewer's own asset is highlighted. Tapping a chip toggles it.
  /// `align` matches the bubble side. Reads the shared reactions store
  /// (the component already subscribes via useReactionsVersion()).
  function renderReactions(targetId: string, align: 'start' | 'end') {
    const chips = aggregateReactions(targetId, identity!.uin)
    if (chips.length === 0) return null
    return (
      <div className={`flex flex-wrap gap-1 ${align === 'end' ? 'justify-end' : 'justify-start'}`}>
        {chips.map((c) => (
          <button
            key={c.asset}
            onClick={() => void toggleReaction(targetId, c.asset)}
            className={`inline-flex items-center gap-0.5 rounded-full border px-1.5 py-0.5 transition-colors ${
              c.mine ? 'border-accent/60 bg-accent/15' : 'border-line bg-surface hover:bg-surface-dim'
            }`}
            title={c.asset}
          >
            <img src={emoticonAssetURL(c.asset)} alt={c.asset} className="h-4 w-4 select-none" draggable={false} />
            {c.count > 1 && <span className="font-mono text-[10px] text-fg-secondary">{c.count}</span>}
          </button>
        ))}
      </div>
    )
  }

  const headerName = isGroup
    ? group?.name ?? `#${groupId}`
    : peer?.nickname ?? `#${peerUIN}`
  const headerSub = isGroup
    ? group ? t('section.groups.members', { n: group.members.length }) : ''
    : String(peerUIN)
  const headerLink = isGroup
    ? group ? `/groups/${group.id}` : '#'
    : peer ? `/profile/${peer.uin}` : '#'

  return (
    <div className="h-[100dvh] flex flex-col bg-surface-dim overflow-hidden">
      <header className="flex-none bg-surface border-b border-line z-10">
        <div className="max-w-2xl mx-auto px-4 h-14 flex items-center gap-3">
          <Link to="/contacts" className="text-fg-secondary hover:text-fg-primary px-2">
            ←
          </Link>
          <Link
            to={headerLink}
            className="flex items-center gap-2 flex-1 min-w-0 hover:opacity-80"
          >
            {!isGroup && peer && <StatusIcon status={peer.status} size={20} />}
            {isGroup && (
              <GroupAvatar
                size={28}
                mediaId={group?.avatar_media_id}
                mediaKey={group?.avatar_media_key}
              />
            )}
            <div className="flex-1 min-w-0">
              <div className="font-medium truncate">{headerName}</div>
              <div className="font-mono text-xs text-fg-dim truncate">{headerSub}</div>
            </div>
          </Link>
        </div>
      </header>

      {transientNotice && (
        <div className="sticky top-14 z-10 mx-auto max-w-2xl w-full px-4 pt-2">
          <div className="rounded-md bg-ink-black/85 text-white text-xs px-3 py-2 text-center">
            {transientNotice}
          </div>
        </div>
      )}

      <main ref={scrollRef} className="flex-1 max-w-2xl w-full mx-auto px-4 py-4 overflow-y-auto no-scrollbar">
        {error && (
          <div className="bg-red-50 border border-red-200 rounded-md p-3 text-sm text-red-600 mb-4">
            {error}
          </div>
        )}


        <ul className="space-y-2">
          {[
            ...outgoing.map((row) => ({ at: row.sentAt, kind: 'out' as const, row })),
            ...incoming.map((m) => ({ at: m.at, kind: 'in' as const, msg: m })),
          ]
            .sort((a, b) => a.at - b.at)
            .map((item) => {
              if (item.kind === 'in') {
                const m = item.msg
                const senderName = isGroup
                  ? group?.members.find((mem) => mem.uin === m.from)?.nickname || `#${m.from}`
                  : null
                const inviteGroupId = parseGroupInviteId(m.text)
                const replyAuthor = senderName ?? peer?.nickname ?? `#${m.from}`
                const isPlainText = m.kind !== 'photo' && m.kind !== 'other' && inviteGroupId == null
                const showActions = actionsForRowId === m.id
                const showReactionPicker = reactionForRowId === m.id
                return (
                  <li key={`in-${m.id}`} className="flex justify-start">
                    <div className="max-w-[80%] flex flex-col items-start gap-1">
                      {senderName && (
                        <div className="font-mono text-[10px] text-fg-dim px-1">{senderName}</div>
                      )}
                      {m.replyTo && (
                        <div className="border-l-2 border-accent/60 pl-2 max-w-full">
                          <div className="font-mono text-[10px] text-fg-dim">{m.replyTo.authorName}</div>
                          <div className="text-[11px] text-fg-secondary truncate max-w-[16rem]">{m.replyTo.snippet}</div>
                        </div>
                      )}
                      {m.kind === 'photo' && m.mediaId && m.mediaKey ? (
                        <div className="flex flex-col items-start gap-1">
                          <DecryptedImage mediaId={m.mediaId} mediaKey={m.mediaKey} />
                          {m.text && (
                            <div className="rounded-lg px-3 py-2 text-sm bg-surface-dim border border-line">
                              <EmoticonText text={m.text} emoticonSize={18} />
                            </div>
                          )}
                        </div>
                      ) : m.kind === 'other' ? (
                        <MediaPlaceholder mediaKind={m.mediaKind} />
                      ) : inviteGroupId != null ? (
                        <GroupJoinCard groupId={inviteGroupId} />
                      ) : (
                        <button
                          onClick={() => toggleActions(m.id)}
                          className="rounded-lg px-3 py-2 text-sm text-left bg-surface-dim border border-line hover:bg-line/40 transition-colors"
                        >
                          <EmoticonText text={m.text} emoticonSize={18} />
                        </button>
                      )}
                      {renderReactions(m.id, 'start')}
                      <div className="text-[10px] font-mono text-fg-dim">
                        {new Date(m.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </div>
                      {isPlainText && showActions && (
                        <div className="flex items-center gap-1.5 rounded-lg border border-line bg-surface px-2 py-1 shadow-sm">
                          <ActionButton onClick={() => startReplyTo(m.id, m.text, replyAuthor)} label={t('chat.actions.reply')} icon="↩" />
                          <ActionButton
                            onClick={() => setReactionForRowId((id) => (id === m.id ? null : m.id))}
                            label={t('chat.actions.react')}
                            icon="☺"
                          />
                        </div>
                      )}
                      {showReactionPicker && (
                        <ReactionPicker
                          current={reactionsForTarget(m.id)?.get(identity!.uin) ?? null}
                          onPick={(asset) => void toggleReaction(m.id, asset)}
                        />
                      )}
                    </div>
                  </li>
                )
              }
              const row = item.row
              const outInviteGroupId = parseGroupInviteId(row.text)
              if (outInviteGroupId != null) {
                // A group-invite link I shared — show the join card
                // (not a raw URL bubble) with the delivery state below.
                return (
                  <li key={row.id} className="flex justify-end">
                    <div className="max-w-[80%] flex flex-col items-end gap-1">
                      <GroupJoinCard groupId={outInviteGroupId} />
                      <div className="flex items-center justify-end gap-1 text-[10px] font-mono text-fg-dim">
                        {new Date(row.sentAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        {row.state === 'sending' && <span>·{t('chat.delivery.sending')}</span>}
                        {row.state === 'sent' && <span className="text-accent">✓</span>}
                        {row.state === 'failed' && (
                          <>
                            <span className="text-red-500">·{t('chat.delivery.failed')}</span>
                            <button
                              onClick={() => void retry(row.id)}
                              className="ml-1 rounded px-1.5 py-0.5 text-red-600 hover:bg-red-100 transition-colors"
                            >
                              ↻ {t('chat.delivery.retry')}
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                  </li>
                )
              }
              if (row.kind === 'photo' && row.mediaId && row.mediaKey) {
                // A photo I sent — render the image bubble + delivery state.
                return (
                  <li key={row.id} className="flex justify-end">
                    <div className="max-w-[80%] flex flex-col items-end gap-1">
                      <DecryptedImage mediaId={row.mediaId} mediaKey={row.mediaKey} />
                      {row.text && (
                        <div className="rounded-lg px-3 py-2 text-sm bg-bubble-self">
                          <EmoticonText text={row.text} emoticonSize={18} />
                        </div>
                      )}
                      {renderReactions(row.id, 'end')}
                      <div className="flex items-center justify-end gap-1 text-[10px] font-mono text-fg-dim">
                        {new Date(row.sentAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        {row.state === 'sending' && <span>·{t('chat.delivery.sending')}</span>}
                        {row.state === 'sent' && <span className="text-accent">✓</span>}
                        {row.state === 'failed' && (
                          <>
                            <span className="text-red-500">·{t('chat.delivery.failed')}</span>
                            <button
                              onClick={() => void retry(row.id)}
                              className="ml-1 rounded px-1.5 py-0.5 text-red-600 hover:bg-red-100 transition-colors"
                            >
                              ↻ {t('chat.delivery.retry')}
                            </button>
                            <button
                              onClick={() => dismiss(row.id)}
                              className="rounded px-1.5 py-0.5 text-fg-dim hover:bg-line transition-colors"
                            >
                              × {t('chat.delivery.dismiss')}
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                  </li>
                )
              }
              if (row.kind === 'other') {
                // An in-app-only media (voice/video/file/location) the user
                // sent from another device, echoed here via a carbon.
                return (
                  <li key={row.id} className="flex justify-end">
                    <div className="max-w-[80%] flex flex-col items-end gap-1">
                      <MediaPlaceholder mediaKind={row.mediaKind} />
                      <div className="flex items-center justify-end gap-1 text-[10px] font-mono text-fg-dim">
                        {new Date(row.sentAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        <span className="text-accent">✓</span>
                      </div>
                    </div>
                  </li>
                )
              }
              const showActions = actionsForRowId === row.id
              const showReactionPicker = reactionForRowId === row.id
              return (
              <li key={row.id} className="flex justify-end">
                <div className="max-w-[80%] flex flex-col items-end gap-1">
                  {row.fwdName && (
                    <div className="font-mono text-[10px] uppercase tracking-wider text-fg-dim">
                      ↗ {t('chat.forwarded_label', { name: row.fwdName })}
                    </div>
                  )}
                  {row.replyTo && (
                    <div className="border-l-2 border-accent/60 pl-2 max-w-full">
                      <div className="font-mono text-[10px] text-fg-dim">{row.replyTo.authorName}</div>
                      <div className="text-[11px] text-fg-secondary truncate max-w-[16rem]">
                        {row.replyTo.snippet}
                      </div>
                    </div>
                  )}
                  <button
                    onClick={() => toggleActions(row.id)}
                    className={`rounded-lg px-3 py-2 text-sm text-left transition-colors ${
                      row.state === 'failed'
                        ? 'bg-red-50 border border-red-200'
                        : 'bg-bubble-self hover:bg-bubble-self/90'
                    }`}
                  >
                    <EmoticonText text={row.text} emoticonSize={18} />
                  </button>
                  {renderReactions(row.id, 'end')}
                  <div className="flex items-center justify-end gap-1 text-[10px] font-mono text-fg-dim">
                    {new Date(row.sentAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    {row.state === 'sending' && <span>·{t('chat.delivery.sending')}</span>}
                    {row.state === 'sent' && <span className="text-accent">✓</span>}
                    {row.state === 'failed' && (
                      <>
                        <span className="text-red-500">·{t('chat.delivery.failed')}</span>
                        <button
                          onClick={() => void retry(row.id)}
                          className="ml-1 rounded px-1.5 py-0.5 text-red-600 hover:bg-red-100 transition-colors"
                        >
                          ↻ {t('chat.delivery.retry')}
                        </button>
                        <button
                          onClick={() => dismiss(row.id)}
                          className="rounded px-1.5 py-0.5 text-fg-dim hover:bg-line transition-colors"
                        >
                          × {t('chat.delivery.dismiss')}
                        </button>
                      </>
                    )}
                  </div>
                  {row.state === 'failed' && row.error && (
                    <div className="text-right text-[10px] text-red-500/80 max-w-full break-words">
                      {row.error}
                    </div>
                  )}
                  {showActions && row.state === 'sent' && (
                    <div className="flex items-center gap-1.5 rounded-lg border border-line bg-surface px-2 py-1 shadow-sm">
                      <ActionButton onClick={() => startReply(row)} label={t('chat.actions.reply')} icon="↩" />
                      <ActionButton onClick={() => setForwardingRow(row)} label={t('chat.actions.forward')} icon="↗" />
                      <ActionButton
                        onClick={() => setReactionForRowId((id) => (id === row.id ? null : row.id))}
                        label={t('chat.actions.react')}
                        icon="☺"
                      />
                    </div>
                  )}
                  {showReactionPicker && (
                    <ReactionPicker
                      current={reactionsForTarget(row.id)?.get(identity!.uin) ?? null}
                      onPick={(asset) => void toggleReaction(row.id, asset)}
                    />
                  )}
                </div>
              </li>
            )
          })}
        </ul>
        {/* Scroll anchor — keeps the newest message in view. */}
        <div ref={bottomRef} />
      </main>

      {/* Composer: the bar has NO background (floats on the page); the
          input is a bordered round pill, side buttons are round, and the
          emoji panel is a floating overlay ABOVE the composer — it does
          not push the input down or the messages up. */}
      <div className="flex-none bg-surface-dim border-t border-line/60 pb-[env(safe-area-inset-bottom)]">
        <div className="relative max-w-lg mx-auto px-3 py-3">
          {/* Floating emoji panel — absolute, sits above the composer over
              the chat, independent of layout. */}
          <div className="absolute bottom-full inset-x-0 px-3 mb-2 z-10">
            <AnimatePresence>
              {showPicker && (
                <EmoticonPicker
                  key="picker"
                  onPick={(code) => setInput((prev) => prev + code)}
                />
              )}
            </AnimatePresence>
          </div>
          {!isGroup && peer?.blocked ? (
            <div className="flex items-center justify-center gap-3 rounded-2xl border border-line px-4 py-3 text-sm text-fg-secondary">
              <span>{t('chat.blocked.notice')}</span>
              <button
                onClick={() => void unblockPeer()}
                className="rounded-full bg-accent hover:bg-accent-dim text-white text-xs font-semibold px-3 py-1.5 transition-colors"
              >
                {t('chat.blocked.unblock')}
              </button>
            </div>
          ) : (
          <div className="space-y-2">
          {replyTo && (
            <div className="flex items-start gap-2 rounded-2xl border border-line bg-surface-dim px-3 py-2 text-xs">
              <div className="border-l-2 border-accent/60 pl-2 flex-1 min-w-0">
                <div className="font-mono text-[10px] text-fg-dim">
                  {t('chat.reply.replying_to', { name: replyTo.authorName })}
                </div>
                <div className="text-fg-secondary truncate">{replyTo.snippet}</div>
              </div>
              <button
                onClick={cancelReply}
                className="font-mono text-[10px] uppercase tracking-wider text-fg-dim hover:text-fg-primary"
              >
                × {t('chat.reply.cancel')}
              </button>
            </div>
          )}
          <div className="flex items-center gap-2">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0]
                e.target.value = '' // allow re-picking the same file
                if (file) void sendPhoto(file)
              }}
            />
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={(!peer && !group) || uploadingPhoto}
              className="h-10 w-10 rounded-full flex items-center justify-center flex-none bg-surface-dim hover:bg-line transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              title={t('chat.attach')}
              aria-label={t('chat.attach')}
            >
              {uploadingPhoto ? <span className="text-xs">…</span> : <AttachIcon />}
            </button>
            <button
              onClick={() => setShowPicker((v) => !v)}
              className={`h-10 w-10 rounded-full flex items-center justify-center flex-none transition-colors ${
                showPicker ? 'bg-accent/15 ring-1 ring-accent/40' : 'bg-surface-dim hover:bg-line'
              }`}
              title={t('chat.emoticons')}
              aria-label={t('chat.emoticons')}
            >
              <img
                src={emoticonAssetURL('smile')}
                alt=""
                width={22}
                height={22}
                draggable={false}
                className="select-none"
              />
            </button>
            <textarea
              rows={1}
              className="flex-1 resize-none rounded-full border border-line bg-transparent px-4 py-2.5 text-sm outline-none leading-tight placeholder:text-fg-dim focus:border-accent transition-colors"
              placeholder={
                isGroup && group
                  ? t('chat.placeholder.group', { name: group.name })
                  : peer
                    ? t('chat.placeholder', { nick: peer.nickname })
                    : t('chat.placeholder_loading')
              }
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  void send()
                }
              }}
              disabled={!peer && !group}
            />
            <button
              onClick={() => void send()}
              disabled={(!peer && !group) || !input.trim()}
              className="h-10 w-10 rounded-full bg-accent hover:bg-accent-dim text-white flex items-center justify-center flex-none disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              aria-label={t('chat.send')}
              title={t('chat.send')}
            >
              <SendIcon />
            </button>
          </div>
          </div>
          )}
        </div>
      </div>

      <ForwardModal
        visible={forwardingRow != null}
        onClose={() => setForwardingRow(null)}
        onPick={async (target) => {
          if (forwardingRow) await forwardTo(forwardingRow, target)
        }}
      />
    </div>
  )
}

function ActionButton({ onClick, label, icon }: { onClick: () => void; label: string; icon: string }) {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-1 rounded px-2 py-1 font-mono text-[10px] uppercase tracking-wider text-fg-secondary hover:bg-surface-dim hover:text-ink-black transition-colors"
    >
      <span>{icon}</span>
      <span>{label}</span>
    </button>
  )
}

function SendIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <line x1="12" y1="19" x2="12" y2="5" />
      <polyline points="5 12 12 5 19 12" />
    </svg>
  )
}

function AttachIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <circle cx="8.5" cy="8.5" r="1.5" />
      <polyline points="21 15 16 10 5 21" />
    </svg>
  )
}

/// Placeholder bubble for an incoming media kind the web can't render
/// yet (video/voice/file/location). Shows the kind + an "open in app"
/// hint rather than silently dropping the message.
function MediaPlaceholder({ mediaKind }: { mediaKind?: string }) {
  const { t } = useI18n()
  const icon =
    mediaKind === 'video' ? '🎬' :
    mediaKind === 'voice' ? '🎤' :
    mediaKind === 'location' ? '📍' : '📎'
  const label = mediaKind ? t(`chat.media.kind.${mediaKind}`) : t('chat.media.kind.file')
  return (
    <div className="rounded-lg px-3 py-2 bg-surface-dim border border-line">
      <div className="text-sm">{icon} {label}</div>
      <div className="text-[10px] text-fg-dim">{t('chat.media.in_app_only')}</div>
    </div>
  )
}
