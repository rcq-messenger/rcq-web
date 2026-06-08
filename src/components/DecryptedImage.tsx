// Inline chat photo. Fetches the encrypted blob and AES-256-GCM
// decrypts it (lib/media.ts) into an object URL; renders a small
// rounded thumbnail that opens full-size in a new tab on click.
// Shows a skeleton while loading and a placeholder on failure so a
// photo never collapses into a broken-image icon.

import { useEffect, useState } from 'react'
import { useIdentity } from '../lib/identity-context'
import { loadEncryptedImage } from '../lib/media'
import { useI18n } from '../lib/i18n-context'

interface Props {
  mediaId: string
  mediaKey: string
}

export function DecryptedImage({ mediaId, mediaKey }: Props) {
  const { identity } = useIdentity()
  const { t } = useI18n()
  const [url, setUrl] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    setUrl(null)
    setFailed(false)
    if (!identity) return
    let alive = true
    void loadEncryptedImage(identity.apiBase, mediaId, mediaKey).then((u) => {
      if (!alive) return
      if (u) setUrl(u)
      else setFailed(true)
    })
    return () => {
      alive = false
    }
  }, [identity?.apiBase, mediaId, mediaKey])

  if (failed) {
    return (
      <div className="flex h-40 w-56 max-w-full items-center justify-center rounded-lg bg-surface-dim border border-line text-xs text-fg-dim">
        {t('chat.media.unavailable')}
      </div>
    )
  }
  if (!url) {
    return <div className="h-40 w-56 max-w-full animate-pulse rounded-lg bg-surface-dim border border-line" />
  }
  return (
    <button
      type="button"
      onClick={() => window.open(url, '_blank', 'noopener')}
      className="block overflow-hidden rounded-lg border border-line"
      title={t('chat.media.open')}
    >
      <img
        src={url}
        alt=""
        className="max-h-64 max-w-[16rem] w-auto object-cover"
        draggable={false}
      />
    </button>
  )
}
