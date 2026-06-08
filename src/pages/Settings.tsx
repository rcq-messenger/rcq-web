// Settings — profile link, language picker, privacy navigation,
// sound on/off, sign out, burn account.
//
// Privacy is its own page (`/privacy`) — five tri-state pickers
// took up too much vertical space inline. Settings now just shows
// a nav-row that opens the dedicated surface.

import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Dropdown, type DropdownOption } from '../components/Dropdown'
import { LanguagePicker } from '../components/LanguagePicker'
import { Logo } from '../components/Logo'
import { MyQRCode } from '../components/MyQRCode'
import { Api } from '../lib/api'
import { useI18n } from '../lib/i18n-context'
import { useIdentity } from '../lib/identity-context'
import { isPresenceSoundEnabled, isSoundEnabled, setPresenceSoundEnabled, setSoundEnabled } from '../lib/sounds'
import { useTheme, type ThemePref } from '../lib/theme-context'

export function Settings() {
  const { identity, signOut } = useIdentity()
  const { t } = useI18n()
  const navigate = useNavigate()
  const [confirming, setConfirming] = useState(false)
  const [burnTyped, setBurnTyped] = useState('')
  const [burning, setBurning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [soundOn, setSoundOnState] = useState<boolean>(() => isSoundEnabled())
  const [presenceSoundOn, setPresenceSoundOnState] = useState<boolean>(() => isPresenceSoundEnabled())
  const { pref: themePref, setPref: setThemePref } = useTheme()

  if (!identity) {
    navigate('/', { replace: true })
    return null
  }

  async function burn() {
    setBurning(true)
    setError(null)
    try {
      await Api.burnAccount(identity!)
      signOut()
      navigate('/', { replace: true })
    } catch (e) {
      setError(e instanceof Error ? e.message : t('settings.danger.error'))
    } finally {
      setBurning(false)
    }
  }

  return (
    <div className="min-h-screen bg-surface-dim">
      <header className="sticky top-0 bg-surface border-b border-line z-10">
        <div className="max-w-2xl mx-auto px-4 h-14 flex items-center gap-3">
          <Link to="/contacts" className="text-fg-secondary hover:text-fg-primary px-2">
            ←
          </Link>
          <div className="font-semibold">{t('settings.title')}</div>
        </div>
      </header>

      <main className="max-w-2xl mx-auto px-4 py-6 space-y-6">
        <Link
          to="/profile"
          className="block bg-surface rounded-lg border border-line p-4 hover:bg-surface-dim transition-colors"
        >
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-xs font-semibold text-fg-secondary uppercase tracking-wide">
                {t('settings.section.profile')}
              </div>
              <div className="text-sm font-medium mt-0.5 truncate">
                {t('settings.profile.cta')}
              </div>
            </div>
            <span className="text-fg-dim">→</span>
          </div>
        </Link>

        <section className="bg-surface rounded-lg border border-line p-4 space-y-2">
          <div className="text-xs font-semibold text-fg-secondary uppercase tracking-wide">
            {t('settings.section.account')}
          </div>
          <div className="flex items-center justify-between text-sm">
            <span className="text-fg-secondary">{t('settings.field.uin')}</span>
            <span className="font-mono">{identity.uin}</span>
          </div>
        </section>

        <section className="bg-surface rounded-lg border border-line p-4 space-y-3">
          <div className="text-xs font-semibold text-fg-secondary uppercase tracking-wide">
            {t('settings.section.qr')}
          </div>
          <MyQRCode />
        </section>

        {/* Privacy — its own page now that there are five pickers.
            See pages/Privacy.tsx for the actual surface. */}
        <Link
          to="/privacy"
          className="block bg-surface rounded-lg border border-line p-4 hover:bg-surface-dim transition-colors"
        >
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-xs font-semibold text-fg-secondary uppercase tracking-wide">
                {t('settings.section.privacy')}
              </div>
              <div className="text-xs text-fg-dim mt-0.5 truncate">
                {t('settings.privacy.footer.short')}
              </div>
            </div>
            <span className="text-fg-dim">→</span>
          </div>
        </Link>

        <section className="bg-surface rounded-lg border border-line p-4 space-y-2">
          <div className="text-xs font-semibold text-fg-secondary uppercase tracking-wide">
            {t('settings.section.language')}
          </div>
          <LanguagePicker variant="row" />
          <p className="text-xs text-fg-dim">{t('settings.language.footer')}</p>
        </section>

        <section className="bg-surface rounded-lg border border-line p-4 space-y-3">
          <div className="text-xs font-semibold text-fg-secondary uppercase tracking-wide">
            {t('settings.section.theme')}
          </div>
          <Dropdown<ThemePref>
            value={themePref}
            options={(['light', 'dark', 'system'] as ThemePref[]).map<DropdownOption<ThemePref>>((opt) => ({
              value: opt,
              label: t(`settings.theme.${opt}`),
            }))}
            onChange={setThemePref}
            ariaLabel={t('settings.section.theme')}
            variant="row"
          />
          <p className="text-xs text-fg-dim">{t('settings.theme.footer')}</p>
        </section>

        <section className="bg-surface rounded-lg border border-line p-4 space-y-3">
          <div className="text-xs font-semibold text-fg-secondary uppercase tracking-wide">
            {t('settings.section.sound')}
          </div>
          <label className="flex items-center justify-between cursor-pointer">
            <span className="text-sm">{t('settings.sound.toggle')}</span>
            <input
              type="checkbox"
              checked={soundOn}
              onChange={(e) => {
                setSoundEnabled(e.target.checked)
                setSoundOnState(e.target.checked)
              }}
              className="w-5 h-5 accent-accent cursor-pointer"
            />
          </label>
          <p className="text-xs text-fg-dim">{t('settings.sound.footer')}</p>
          {/* Separate toggle for contact online/offline chimes, like iOS.
              Greyed out when the master switch is off. */}
          <label className={'flex items-center justify-between pt-1 ' + (soundOn ? 'cursor-pointer' : 'opacity-40 cursor-not-allowed')}>
            <span className="text-sm">{t('settings.sound.presence')}</span>
            <input
              type="checkbox"
              checked={presenceSoundOn}
              disabled={!soundOn}
              onChange={(e) => {
                setPresenceSoundEnabled(e.target.checked)
                setPresenceSoundOnState(e.target.checked)
              }}
              className="w-5 h-5 accent-accent cursor-pointer"
            />
          </label>
          <p className="text-xs text-fg-dim">{t('settings.sound.presence_footer')}</p>
        </section>

        <section className="bg-surface rounded-lg border border-line p-4 space-y-3">
          <div className="text-xs font-semibold text-fg-secondary uppercase tracking-wide">
            {t('settings.section.about')}
          </div>
          <div className="flex items-center gap-3">
            <Logo size={40} />
            <div className="min-w-0">
              <div className="font-semibold">{t('brand.name')}</div>
              <div className="text-xs text-fg-dim">{t('login.tagline')}</div>
            </div>
          </div>
          <p className="text-xs text-fg-secondary leading-relaxed">{t('settings.about.body')}</p>
          <a
            href="https://rcq.app"
            target="_blank"
            rel="noreferrer"
            className="inline-block text-xs font-medium text-accent hover:underline"
          >
            rcq.app
          </a>
        </section>

        <section className="bg-surface rounded-lg border border-line p-4 space-y-3">
          <div className="text-xs font-semibold text-fg-secondary uppercase tracking-wide">
            {t('settings.section.session')}
          </div>
          <button
            onClick={signOut}
            className="w-full h-10 rounded-md border border-line text-sm font-medium hover:bg-surface-dim transition-colors"
          >
            {t('settings.session.unlink')}
          </button>
          <p className="text-xs text-fg-dim">{t('settings.session.unlink_footer')}</p>
        </section>

        <section className="bg-surface rounded-lg border border-red-200 p-4 space-y-3">
          <div className="text-xs font-semibold text-red-600 uppercase tracking-wide">
            {t('settings.section.danger')}
          </div>
          <p className="text-xs text-fg-secondary">{t('settings.danger.body')}</p>
          {!confirming ? (
            <button
              onClick={() => setConfirming(true)}
              className="w-full h-10 rounded-md border border-red-300 text-sm font-medium text-red-600 hover:bg-red-50 transition-colors"
            >
              {t('settings.danger.cta')}
            </button>
          ) : (
            <div className="space-y-2">
              {/* Anti-fat-finger: must type the literal UIN before
                  the confirm button activates. iOS doesn't gate
                  burn this way (the destructive system dialog is
                  considered enough), but on web a misclick is
                  much easier — typing the UIN forces a deliberate
                  action. */}
              <p className="text-xs text-fg-secondary">
                {t('settings.danger.type_uin', { uin: identity.uin })}
              </p>
              <input
                type="text"
                value={burnTyped}
                onChange={(e) => setBurnTyped(e.target.value)}
                placeholder={String(identity.uin)}
                className="w-full h-10 px-3 rounded-md border border-red-300 bg-red-50/30 outline-none focus:border-red-500 focus:ring-1 focus:ring-red-500 text-sm font-mono text-center"
                autoFocus
              />
              <button
                onClick={() => void burn()}
                disabled={burning || burnTyped.trim() !== String(identity.uin)}
                className="w-full h-10 rounded-md bg-red-600 hover:bg-red-700 text-white text-sm font-semibold disabled:opacity-40 transition-colors"
              >
                {burning ? t('settings.danger.busy') : t('settings.danger.confirm')}
              </button>
              <button
                onClick={() => {
                  setConfirming(false)
                  setBurnTyped('')
                }}
                disabled={burning}
                className="w-full h-9 text-sm text-fg-secondary hover:text-fg-primary"
              >
                {t('common.cancel')}
              </button>
            </div>
          )}
          {error && (
            <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-md p-2">
              {error}
            </div>
          )}
        </section>
      </main>
    </div>
  )
}

