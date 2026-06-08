// Status icon — same artwork as iOS, served from /statuses/. The
// PNG basenames match `Resources/Statuses/status_<state>.png` so
// keeping iOS and web aligned is a one-file copy.

import type { UserStatus } from '../lib/api'

interface Props {
  status: UserStatus | 'typing'
  size?: number
  className?: string
}

const SRC: Record<UserStatus | 'typing', string> = {
  online: '/statuses/status_online.png',
  away: '/statuses/status_away.png',
  dnd: '/statuses/status_dnd.png',
  invisible: '/statuses/status_invisible.png',
  offline: '/statuses/status_offline.png',
  typing: '/statuses/status_typing.png',
}

export function StatusIcon({ status, size = 16, className = '' }: Props) {
  return (
    <img
      src={SRC[status]}
      alt={status}
      width={size}
      height={size}
      className={`inline-block flex-none ${className}`}
      style={{ imageRendering: 'auto' }}
    />
  )
}
