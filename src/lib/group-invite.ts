// Group-invite deep links. iOS/Android share a group as either the
// custom scheme `rcq://group/<id>` (in-app tap) or the universal
// `https://rcq.app/g/<id>` (paste / browser / message body). When one
// of those lands in a chat as plain text we don't want to render it as
// a dead URL — we detect the group id and paint a join card instead
// (see GroupJoinCard + the /g/:id route).
//
// Mirrors the iOS parser in `ViewModels/AppState.swift` (handles the
// `rcq.app/g/<id>` and `rcq://group/<id>` shapes); we additionally
// accept `chat.rcq.app/g/<id>` so a link shared from the web client
// round-trips.

const PATTERNS: RegExp[] = [
  // https://rcq.app/g/123  ·  http://chat.rcq.app/g/123  ·  rcq.app/g/123
  /(?:https?:\/\/)?(?:www\.|chat\.)?rcq\.app\/g\/(\d+)/i,
  // rcq://group/123
  /rcq:\/\/group\/(\d+)/i,
]

/// If `text` is (or contains) a group-invite link, return the group
/// id; otherwise null. Trimmed first so a bubble that is just the link
/// matches cleanly; we also match a link embedded in surrounding text.
export function parseGroupInviteId(text: string): number | null {
  const trimmed = text.trim()
  for (const re of PATTERNS) {
    const m = trimmed.match(re)
    if (m) {
      const id = Number(m[1])
      if (Number.isFinite(id) && id > 0) return id
    }
  }
  return null
}
