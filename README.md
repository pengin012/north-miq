# north-fx-api

Unofficial FxTwitter-style compatibility API for [north.rip](https://north.rip/).

This project is a local-first gateway around north's web API. It is not affiliated with north.rip, X, FxTwitter, FxEmbed, Discord, or Make it a Quote. north's API is not documented as an official public developer API; use it only with permission and at a conservative request rate.

## What it provides

The gateway normalizes north responses into stable, FxTwitter v2-style JSON envelopes:

- `GET /2/status/:id`
- `GET /2/status/:id/thread`
- `GET /2/thread/:id` / `GET /2/conversation/:id`
- `GET /2/status/:id/replies`
- `GET /2/status/:id/quotes`
- `GET /2/status/:id/likes`
- `GET /2/status/:id/reposts` (and `retweets` alias)
- `GET /2/user/:handle` / `GET /2/profile/:handle`
- `GET /2/user/:handle/tweets` / `GET /2/profile/:handle/statuses`
- `GET /2/user/:handle/media` / `GET /2/profile/:handle/media`
- `GET /2/profile/:handle/followers`
- `GET /2/profile/:handle/following`
- `GET /2/search?q=...`
- `GET /2/trends`
- `GET /2/typeahead?q=...`
- `GET /2/timeline/public`
- `GET /2/notifications/mentions`
- `GET /2/notifications/unread-count`
- `GET /oembed?url=https://north.rip/<handle>/status/<id>`
- `GET /v1/events/mentions` (SSE, backed by conservative polling)

The existing MIQ worker remains available as `npm.cmd run miq`. Optional write support is exposed separately as `POST /v1/quotes` and is disabled unless explicitly enabled.

## Stability model

- GET requests use bounded retries for transient network and upstream errors.
- POST requests are never blindly retried because a lost response can mean the post was already created.
- In-flight identical GETs are coalesced and successful responses are briefly cached.
- The response body and avatar size are bounded, and avatar reads are coalesced too.
- Upstream concurrency and request spacing are limited.
- The cache and upstream wait queue have fixed maximum sizes.
- The mention event stream polls the cheap unread-count endpoint first and fetches the full mention page only when needed.
- It refreshes the full mention page at most every 30 seconds unless the unread count changes.
- MIQ rendering never downloads fonts during a request; it uses the local font cache or host fonts.
- The gateway binds to `127.0.0.1` by default. Set a gateway token before binding it to another interface.

## Run locally

```powershell
npm.cmd ci
npm.cmd run gateway
```

Public read endpoints work without a session. Mentions, SSE events, and writes require a session read from `NORTH_SESSION_COOKIE`, `NORTH_SESSION_COOKIE_FILE`, or the ignored default file `data/north-session.cookie`.

```powershell
curl.exe http://127.0.0.1:8787/health
curl.exe http://127.0.0.1:8787/2/status/2094605508622157083
curl.exe "http://127.0.0.1:8787/2/search?q=north"
curl.exe -N http://127.0.0.1:8787/v1/events/mentions
```

For write access, set both values locally and keep the gateway on loopback:

```powershell
$env:NORTH_GATEWAY_ALLOW_WRITES = "1"
$env:NORTH_GATEWAY_TOKEN = "use-a-local-secret"
npm.cmd run gateway
```

Do not commit session cookies, passwords, gateway tokens, browser profiles, generated images, or `.env` files.

## Development

```powershell
npm.cmd run check
npm.cmd test
npm.cmd audit --omit=dev
```

## License

MIT. See [LICENSE](LICENSE).
