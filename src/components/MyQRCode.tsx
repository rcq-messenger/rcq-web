// "My code" QR. Encodes the universal add-link https://rcq.app/u/<uin>,
// which the iOS/Android apps (and any generic QR scanner) resolve to an
// add-contact action for this UIN. Rendered in Settings so someone can
// scan the web user's code from their phone to add them.

import { useEffect, useState } from 'react'
import QRCode from 'qrcode'
import { useIdentity } from '../lib/identity-context'
import { useI18n } from '../lib/i18n-context'

export function MyQRCode() {
  const { identity } = useIdentity()
  const { t } = useI18n()
  const [dataUrl, setDataUrl] = useState<string | null>(null)

  useEffect(() => {
    if (!identity) return
    let alive = true
    const link = `https://rcq.app/u/${identity.uin}`
    void QRCode.toDataURL(link, { width: 320, margin: 1, errorCorrectionLevel: 'M' })
      .then((url) => {
        if (alive) setDataUrl(url)
      })
      .catch(() => {
        if (alive) setDataUrl(null)
      })
    return () => {
      alive = false
    }
  }, [identity?.uin])

  if (!identity) return null

  return (
    <div className="flex flex-col items-center gap-3">
      <div className="bg-white p-3 rounded-xl">
        {dataUrl ? (
          <img src={dataUrl} alt="QR" width={176} height={176} className="block" draggable={false} />
        ) : (
          <div className="w-44 h-44 animate-pulse bg-gray-200 rounded" />
        )}
      </div>
      <div className="font-mono text-sm">{identity.uin}</div>
      <p className="text-xs text-fg-dim text-center max-w-xs">{t('settings.qr.hint')}</p>
    </div>
  )
}
