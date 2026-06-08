// Entry point. Web is its own account model: a visitor creates a
// fresh in-browser account (its own UIN + keys). The old "Link from
// iOS" blob-paste flow was removed — it predated recovery phrases,
// only ever worked for iOS, and depended on an iOS QR screen that's
// disabled. Proper phone<->web linking (web as a secondary device) is
// a separate future feature; until then web is a standalone account.

import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import QRCode from 'qrcode'
import { LanguagePicker } from '../components/LanguagePicker'
import { ThemeToggle } from '../components/ThemeToggle'
import { Logo } from '../components/Logo'
import {
  DEFAULT_API_BASE,
  adoptLinkBlob,
  createNewAccount,
  parseLinkBlob,
  suggestNickname,
} from '../lib/auth'
import { defaultHome } from '../lib/routing'
import { bytesToB64, newLinkEphemeral, openLinkSeal, type WebIdentity } from '../lib/crypto'
import { useI18n } from '../lib/i18n-context'
import { useIdentity } from '../lib/identity-context'

export function Login() {
  const { setIdentity } = useIdentity()
  const navigate = useNavigate()
  const { t } = useI18n()

  return (
    <div className="relative min-h-screen flex items-center justify-center bg-surface-dim px-4 py-6">
      {/* Floated out of flow so the form stays vertically CENTERED on
          mobile (the picker used to take a row at the top and push the
          content down). */}
      <div className="absolute top-4 right-4 z-10 flex items-center gap-1.5">
        <ThemeToggle />
        <LanguagePicker />
      </div>

      <div className="w-full flex items-center justify-center">
        <div className="w-full max-w-sm space-y-8">
          <header className="flex flex-col items-center gap-3 text-center">
            {/* Always-spinning brand mark (linear 30s), matches iOS. */}
            <Logo size={64} spin />
            <div className="text-2xl font-bold tracking-tight">{t('brand.name')}</div>
            <p className="text-fg-dim text-sm">{t('login.tagline')}</p>
          </header>

          <ModeSwitch
            onDone={(id) => {
              setIdentity(id)
              navigate(defaultHome(), { replace: true })
            }}
          />
        </div>
      </div>
    </div>
  )
}

// -----------------------------------------------------------
// Mode switch: create a fresh web account, or link an existing phone account
// by scanning a QR (web becomes a secondary device of that identity).
// -----------------------------------------------------------

function ModeSwitch({ onDone }: { onDone: (id: WebIdentity) => void }) {
  const { t } = useI18n()
  const [mode, setMode] = useState<'create' | 'link'>('create')
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-1 p-1 rounded-lg bg-surface-dim border border-line text-sm font-medium">
        <button
          onClick={() => setMode('create')}
          className={`h-9 rounded-md transition-colors ${mode === 'create' ? 'bg-accent text-white' : 'text-fg-secondary hover:text-fg'}`}
        >
          {t('login.mode.create')}
        </button>
        <button
          onClick={() => setMode('link')}
          className={`h-9 rounded-md transition-colors ${mode === 'link' ? 'bg-accent text-white' : 'text-fg-secondary hover:text-fg'}`}
        >
          {t('login.mode.link')}
        </button>
      </div>
      {mode === 'create' ? <CreatePane onDone={onDone} /> : <LinkPane onDone={onDone} />}
    </div>
  )
}

// -----------------------------------------------------------
// Connect-a-phone: show a QR; the phone (Settings → Connect to web) scans it,
// seals its account into the one-time relay, the web opens it here and logs in
// as the same identity. Strings are English for now — i18n keys come with the
// mobile side + the Linked Devices screen.
// -----------------------------------------------------------

function LinkPane({ onDone }: { onDone: (id: WebIdentity) => void }) {
  const { t } = useI18n()
  const [qr, setQr] = useState<string | null>(null)
  const [state, setState] = useState<'waiting' | 'expired' | 'error'>('waiting')
  const [gen, setGen] = useState(0) // bump → fresh token + QR

  useEffect(() => {
    let cancelled = false
    setQr(null)
    setState('waiting')
    const eph = newLinkEphemeral()
    const tokenBytes = new Uint8Array(32)
    crypto.getRandomValues(tokenBytes)
    const token = Array.from(tokenBytes, (b) => b.toString(16).padStart(2, '0')).join('')
    // The phone parses this: a one-time relay token + the web's ephemeral
    // X25519 pubkey to seal the account to.
    const payload = `rcq://link?t=${token}&k=${encodeURIComponent(bytesToB64(eph.pub))}`
    void QRCode.toDataURL(payload, { width: 240, margin: 1, errorCorrectionLevel: 'M' }).then((u) => {
      if (!cancelled) setQr(u)
    })

    const deadline = Date.now() + 110_000 // a hair under the relay's 120s TTL
    async function poll() {
      if (cancelled) return
      if (Date.now() > deadline) {
        if (!cancelled) setState('expired')
        return
      }
      let res: Response
      try {
        res = await fetch(`${DEFAULT_API_BASE}/link/${token}`)
      } catch {
        // Network blip — keep polling.
        setTimeout(poll, 2000)
        return
      }
      if (res.ok) {
        try {
          const { blob } = await res.json()
          const plain = openLinkSeal(blob, eph.priv, eph.pub)
          const id = adoptLinkBlob(parseLinkBlob(new TextDecoder().decode(plain)))
          if (!cancelled) onDone(id)
        } catch {
          // A malformed / wrong-key deposit landed in our slot.
          if (!cancelled) setState('error')
        }
        return
      }
      // 404 = nothing deposited yet; keep waiting.
      setTimeout(poll, 2000)
    }
    const h = setTimeout(poll, 2000)
    return () => {
      cancelled = true
      clearTimeout(h)
    }
  }, [gen]) // re-run (fresh token + QR) when the user taps refresh

  return (
    <div className="space-y-4 text-center">
      <p className="text-sm text-fg-secondary">{t('login.link.scan_body')}</p>
      <div className="flex items-center justify-center">
        <div className="relative flex items-center justify-center">
          {/* Calm green sonar waves rippling out from behind the QR while we
              wait for the phone. Three rings on a slow 2.7s loop, staggered. */}
          {qr && state === 'waiting' && (
            <>
              <span className="rcq-wave absolute inset-0 m-auto w-[224px] h-[224px] rounded-2xl bg-accent/25" />
              <span className="rcq-wave absolute inset-0 m-auto w-[224px] h-[224px] rounded-2xl bg-accent/25" style={{ animationDelay: '0.9s' }} />
              <span className="rcq-wave absolute inset-0 m-auto w-[224px] h-[224px] rounded-2xl bg-accent/25" style={{ animationDelay: '1.8s' }} />
            </>
          )}
          <div className="relative rounded-xl bg-white p-3 w-[252px] h-[252px] flex items-center justify-center shadow-lg shadow-accent/10">
            {qr ? (
              <img src={qr} alt="Link QR" width={228} height={228} />
            ) : (
              <Spinner />
            )}
          </div>
        </div>
      </div>
      {/* Honest, jargon-free note about the multi-device → simpler-encryption
          trade-off (convenience vs max security), not an alarm. */}
      <p className="text-xs text-fg-dim leading-relaxed">{t('login.link.security_note')}</p>
      {state === 'waiting' && (
        <p className="text-xs text-fg-dim">{t('login.link.waiting')}</p>
      )}
      {(state === 'expired' || state === 'error') && (
        <div className="flex flex-col items-center gap-2">
          <p className="text-sm text-fg-secondary">
            {t(state === 'expired' ? 'login.link.expired' : 'login.link.error')}
          </p>
          <button
            onClick={() => setGen((g) => g + 1)}
            className="h-9 px-5 rounded-md bg-accent hover:bg-accent-dim text-white text-sm font-semibold transition-colors"
          >
            {t('login.link.refresh')}
          </button>
        </div>
      )}
    </div>
  )
}

// -----------------------------------------------------------
// Create-account
// -----------------------------------------------------------

function CreatePane({ onDone }: { onDone: (id: WebIdentity) => void }) {
  const { t } = useI18n()
  const [nickname, setNickname] = useState(() => suggestNickname())
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit() {
    setError(null)
    setBusy(true)
    try {
      const id = await createNewAccount(nickname)
      onDone(id)
    } catch (e) {
      const detail = e instanceof Error ? e.message : 'unknown'
      setError(t('auth.error.register_failed', { detail }))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-fg-secondary">{t('login.create.body')}</p>

      <div className="space-y-1">
        <label className="text-xs font-semibold text-fg-secondary uppercase tracking-wide">
          {t('login.create.nickname')}
        </label>
        <input
          type="text"
          value={nickname}
          onChange={(e) => setNickname(e.target.value)}
          maxLength={64}
          className="w-full h-10 px-3 rounded-md border border-line bg-surface-dim outline-none focus:border-accent focus:ring-1 focus:ring-accent text-sm"
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
        />
        <p className="text-xs text-fg-dim">{t('login.create.nickname_hint')}</p>
      </div>

      {error && (
        <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-md p-2">
          {error}
        </div>
      )}

      <button
        onClick={submit}
        disabled={busy || !nickname.trim()}
        className="w-full h-11 rounded-md bg-accent hover:bg-accent-dim text-white font-semibold disabled:opacity-60 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2"
      >
        {busy && <Spinner />}
        {busy ? t('login.create.busy') : t('login.create.cta')}
      </button>

      <p className="text-xs text-fg-dim text-center leading-relaxed">{t('login.create.note')}</p>
    </div>
  )
}

function Spinner() {
  return (
    <svg className="animate-spin h-4 w-4 text-white" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-90" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
    </svg>
  )
}
