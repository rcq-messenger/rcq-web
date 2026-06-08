// App-wide receive loop. Mounted once under WSProvider. On connect it ensures
// this account is provisioned as a libsignal device, drains the offline queue,
// and decrypts each envelope; live WS `message` pushes are decrypted too. Both
// feed the incoming-store, deduped by envelope id. Renders nothing.

import { useEffect } from 'react'
import { useIdentity } from './identity-context'
import { useWS } from './ws'
import { decryptIncoming, getDevice } from './signal-device'
import { addIncoming, addGroupIncoming, hydrateIncoming } from './incoming-store'

// Route a decrypted envelope to the 1:1 store or the group store by group_id.
function route(senderUIN: number, envelope: Parameters<typeof addIncoming>[1], groupId: unknown): void {
  if (typeof groupId === 'number') addGroupIncoming(groupId, senderUIN, envelope)
  else addIncoming(senderUIN, envelope)
}

export function MessageReceiver() {
  const { identity } = useIdentity()
  const { on, connected } = useWS()

  // Provision (publish our libsignal bundle so peers can reach us) + drain the
  // offline queue whenever we (re)connect.
  useEffect(() => {
    if (!identity || !connected) return
    let cancelled = false
    void (async () => {
      await hydrateIncoming(identity.uin) // restore persisted history first
      try {
        await getDevice(identity) // provision-once (publishes bundle)
      } catch {
        /* provisioning failed (e.g. linked account whose bundle is the phone's) — skip */
      }
      try {
        const res = await fetch(`${identity.apiBase}/messages/queue`, {
          headers: { Authorization: `Bearer ${identity.jwt}` },
        })
        if (!res.ok) return
        const rows = (await res.json()) as Array<{ envelope_type: string; payload: string; group_id: number | null }>
        for (const r of rows) {
          if (cancelled) return
          const got = await decryptIncoming(identity, r.payload)
          if (got) route(got.senderUIN, got.envelope, r.group_id)
        }
      } catch {
        /* network hiccup — next reconnect drains again (queue isn't acked here) */
      }
    })()
    return () => {
      cancelled = true
    }
  }, [identity, connected])

  // Live sealed messages pushed over the socket.
  useEffect(() => {
    if (!identity) return
    return on('message', (ev) => {
      const payload = ev.payload as string | undefined
      if (!payload) return
      void decryptIncoming(identity, payload).then((got) => {
        if (got) route(got.senderUIN, got.envelope, ev.group_id)
      })
    })
  }, [identity, on])

  return null
}
