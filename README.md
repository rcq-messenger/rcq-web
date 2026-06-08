# RCQ Web

The **RCQ web chat client** — the browser app your users open to chat against
an RCQ server. Same end-to-end encryption as the iOS and Android clients
(libsignal v=2 in the browser, v=1 sealed-sender fallback), 1:1 + groups,
photos/GIFs, offline persistence (IndexedDB), realtime over WebSocket.

This is the open-source counterpart to `chat.rcq.app`, meant for **self-hosters**
running [`rcq-server-ref`](https://github.com/rcq-messenger/rcq-server-ref): point
it at your own server and host it for your users. It is the chat client only —
no admin panel (that's built into the server at `/admin/console`) and no UIN
market (that's an `rcq.app`-only commercial surface).

## Point it at your server

The only thing you need to configure is the backend URL. Set it at build time:

```sh
echo 'VITE_API_BASE=https://your-rcq-server.example' > .env.local
```

(Defaults to `https://api.rcq.app` if unset — see `.env.example`.) The same URL
is used for the REST API and, derived from it, the `wss://…/ws` socket.

## Build & run

Requires Node 18+.

```sh
npm install
npm run dev        # local dev server (Vite)
npm run build      # production build → dist/
npm run preview    # serve the production build locally
```

Deploy the contents of `dist/` behind any static web server (nginx, Caddy,
Cloudflare Pages, …) on the same origin policy you want. No server-side runtime
is needed — it's a static SPA that talks to your RCQ backend over HTTPS/WSS.

## How sign-in works

Accounts are created on the mobile apps (or any RCQ client). To use an account
on the web, log in with its **24-word recovery phrase** on the login screen, or
scan the web's QR with a phone via Settings → *Connect to web*. The web holds
the same identity; messages decrypt locally and never leave the device in clear.

> ⚠️ Web + phone share one identity. RCQ isn't built for heavy simultaneous
> multi-device use on a single account (the v=2 ratchet can desync); linked
> devices fall back to v=1 for reliability.

## License

[AGPL-3.0](LICENSE), same as the rest of RCQ. If you run a modified version as a
network service, you must offer your users its source.
