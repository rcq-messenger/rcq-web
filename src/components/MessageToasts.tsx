// In-app "push" toasts. Mounted once under the Router. Subscribes to the
// incoming-store's toast emitter and shows a transient banner (top-right)
// for each new message that arrives while you're NOT viewing that thread.
// Click → open the thread. Auto-dismisses. This is the web analogue of a
// native push: you see incoming messages in real time even from another
// screen. (The unread badge on the contact/group row is the persistent
// counterpart.)

import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { onToast, useTotalUnread, type Toast } from '../lib/incoming-store'
import { useIdentity } from '../lib/identity-context'
import { useI18n } from '../lib/i18n-context'
import { lookupContactName, lookupGroupName, lookupContactStatus } from '../pages/Contacts'
import { EmoticonText } from './EmoticonText'
import { StatusIcon } from './StatusIcon'

interface LiveToast extends Toast {
  key: number // unique per render instance (dedup of repeated envelope ids)
}

const AUTO_DISMISS_MS = 5000
const MAX_VISIBLE = 3

export function MessageToasts() {
  const navigate = useNavigate()
  const { identity } = useIdentity()
  const { t } = useI18n()
  const [toasts, setToasts] = useState<LiveToast[]>([])
  const totalUnread = useTotalUnread()

  // Native-like tab badge: prefix the document title with the unread
  // count so it's visible even when the tab is in the background.
  useEffect(() => {
    const base = 'RCQ Chat'
    document.title = totalUnread > 0 ? `(${totalUnread > 99 ? '99+' : totalUnread}) ${base}` : base
  }, [totalUnread])

  useEffect(() => {
    let seq = 0
    return onToast((toast) => {
      const lt: LiveToast = { ...toast, key: ++seq }
      setToasts((prev) => [...prev, lt].slice(-MAX_VISIBLE))
      setTimeout(() => {
        setToasts((prev) => prev.filter((x) => x.key !== lt.key))
      }, AUTO_DISMISS_MS)
    })
  }, [])

  if (!identity || toasts.length === 0) return null

  function dismiss(key: number) {
    setToasts((prev) => prev.filter((x) => x.key !== key))
  }

  function open(toast: LiveToast) {
    dismiss(toast.key)
    navigate(toast.groupId != null ? `/chat/g/${toast.groupId}` : `/chat/${toast.from}`)
  }

  return (
    <div className="fixed bottom-3 right-3 z-50 flex flex-col gap-2 w-72 max-w-[calc(100vw-1.5rem)]">
      {toasts.map((toast) => {
        const title =
          toast.groupId != null
            ? lookupGroupName(identity!.uin, toast.groupId) || t('toast.group')
            : lookupContactName(identity!.uin, toast.from) || `#${toast.from}`
        const sender =
          toast.groupId != null ? lookupContactName(identity!.uin, toast.from) || `#${toast.from}` : null
        const senderStatus = lookupContactStatus(identity!.uin, toast.from)
        const body =
          toast.kind === 'photo' ? t('toast.photo') : toast.kind === 'other' ? t('toast.attachment') : toast.text
        return (
          <button
            key={toast.key}
            onClick={() => open(toast)}
            className="text-left rounded-xl border border-line bg-surface shadow-lg px-3 py-2.5 hover:bg-surface-dim transition-colors"
          >
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  {toast.groupId == null && senderStatus && <StatusIcon status={senderStatus} size={12} />}
                  <div className="text-sm font-semibold truncate">{title}</div>
                </div>
                {sender && (
                  <div className="flex items-center gap-1 text-[10px] text-fg-dim truncate">
                    {senderStatus && <StatusIcon status={senderStatus} size={10} />}
                    <span className="truncate">{sender}</span>
                  </div>
                )}
                <div className="text-xs text-fg-secondary truncate">
                  {toast.kind === 'text' ? <EmoticonText text={body} emoticonSize={14} /> : body}
                </div>
              </div>
              <span
                role="button"
                tabIndex={-1}
                onClick={(e) => {
                  e.stopPropagation()
                  dismiss(toast.key)
                }}
                className="text-fg-dim hover:text-fg-primary text-xs px-1 -mr-1 flex-none"
                aria-label={t('common.close')}
              >
                ×
              </span>
            </div>
          </button>
        )
      })}
    </div>
  )
}
