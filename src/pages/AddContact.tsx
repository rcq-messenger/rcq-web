// Find users + send contact request. Hits `/users/search` with a
// debounced query — backend matches against nickname / first / last
// / city / country / interests / UIN (numeric). Sending fires
// `/contacts/request`; the WS push to the recipient is the
// backend's job.

import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Api, type UserInfo } from '../lib/api'
import { useI18n } from '../lib/i18n-context'
import { useIdentity } from '../lib/identity-context'

export function AddContact() {
  const { identity } = useIdentity()
  const { t } = useI18n()
  const navigate = useNavigate()
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<UserInfo[]>([])
  const [searching, setSearching] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /// Recipient UINs we've already requested in this session — drives
  /// the "Requested" pill in place of the Add button so a double-tap
  /// doesn't re-send.
  const [requested, setRequested] = useState<Set<number>>(new Set())

  if (!identity) {
    navigate('/', { replace: true })
    return null
  }

  // Debounced search — fires 300ms after the user stops typing.
  useEffect(() => {
    if (!query.trim()) {
      setResults([])
      return
    }
    const handle = setTimeout(async () => {
      setSearching(true)
      setError(null)
      try {
        const list = await Api.searchUsers(identity!, query.trim())
        setResults(list)
      } catch (e) {
        setError(e instanceof Error ? e.message : t('add.error'))
      } finally {
        setSearching(false)
      }
    }, 300)
    return () => clearTimeout(handle)
  }, [query, identity, t])

  async function add(u: UserInfo) {
    try {
      await Api.sendContactRequest(identity!, u.uin)
      setRequested((s) => new Set(s).add(u.uin))
    } catch (e) {
      setError(e instanceof Error ? e.message : t('add.error'))
    }
  }

  return (
    <div className="min-h-screen bg-surface-dim">
      <header className="sticky top-0 bg-surface border-b border-line z-10">
        <div className="max-w-2xl mx-auto px-4 h-14 flex items-center gap-3">
          <Link to="/contacts" className="text-fg-secondary hover:text-fg-primary px-2">
            ←
          </Link>
          <div className="font-semibold">{t('add.title')}</div>
        </div>
      </header>

      <main className="max-w-2xl mx-auto px-4 py-4 space-y-4">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('add.placeholder')}
          className="w-full h-11 px-3 rounded-md border border-line bg-surface outline-none focus:border-accent focus:ring-1 focus:ring-accent text-sm"
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
        />

        {error && (
          <div className="bg-red-50 border border-red-200 rounded-md p-3 text-sm text-red-600">
            {error}
          </div>
        )}

        {!query.trim() && (
          <div className="text-center text-sm text-fg-secondary py-12">
            {t('add.hint')}
          </div>
        )}

        {searching && (
          <div className="text-center text-sm text-fg-secondary py-4">
            {t('contacts.loading')}
          </div>
        )}

        {!searching && query.trim() && results.length === 0 && !error && (
          <div className="text-center text-sm text-fg-secondary py-12">
            {t('add.no_match')}
          </div>
        )}

        <ul className="bg-surface rounded-lg border border-line divide-y divide-line">
          {results.map((u) => (
            <li key={u.uin} className="p-4 flex items-center gap-3">
              <div className="flex-1 min-w-0">
                <div className="font-medium truncate">{u.nickname || `#${u.uin}`}</div>
                <div className="font-mono text-xs text-fg-dim">{u.uin}</div>
                {u.city && (
                  <div className="text-xs text-fg-dim truncate">{u.city}{u.country ? `, ${u.country}` : ''}</div>
                )}
              </div>
              {requested.has(u.uin) ? (
                <span className="text-xs text-fg-dim px-3 py-1.5">{t('add.requested')}</span>
              ) : (
                <button
                  onClick={() => void add(u)}
                  className="px-3 h-9 rounded-md bg-accent hover:bg-accent-dim text-white text-sm font-semibold transition-colors"
                >
                  {t('add.cta')}
                </button>
              )}
            </li>
          ))}
        </ul>
      </main>
    </div>
  )
}
