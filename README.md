# north-fx-api

[![CI](https://github.com/pengin012/north-fx-api/actions/workflows/ci.yml/badge.svg)](https://github.com/pengin012/north-fx-api/actions/workflows/ci.yml)

`north-fx-api` is an unofficial, local-first compatibility gateway that exposes selected [north.rip](https://north.rip/) data in an FxTwitter-style API shape.

It is independent software. It is not affiliated with north.rip, X/Twitter, FxTwitter, FxEmbed, Discord, or Make it a Quote. north's web API is not documented here as an official developer API; use this project only with permission, at a conservative rate, and subject to north's rules.

## 概要

このプロジェクトは、northのWeb APIを直接多数の利用者へ公開するためのスクレイパーではありません。ローカルGatewayを1つ起動し、northへの通信をそこで制御して、読み取りクライアントには安定した互換レスポンスを返します。

```text
client applications
        |
        v
local north-fx-api Gateway
  cache / single-flight / queue limit / retry
        |
        v
    north.rip
```

The repository also contains the existing MIQ worker. When `NORTH_MIQ_GATEWAY_URL` is set in the MIQ process, notification and parent-post reads use this Gateway; media upload and posting remain explicit direct north operations.

## Features

- FxTwitter-style v2 response envelopes for statuses, profiles, timelines, search, trends, typeahead, conversations, quotes, reposts, and profile relationships.
- Legacy-friendly aliases such as `/2/profile/:handle`, `/2/thread/:id`, `/2/conversation/:id`, `/2/status/:id/reposts`, and `/:handle/status/:id`.
- Local Server-Sent Events endpoint for mentions: `/v1/events/mentions`.
- MIQ image generation using the Make it a Quote renderer with local/offline font resolution.
- Public reads without a session; notifications, mention events, uploads, and writes require a north session.
- Conservative upstream behavior: bounded GET retries, no blind POST retries, request coalescing, bounded cache, bounded queue, and fixed upstream concurrency.
- Loopback binding by default. An access token is required before binding to a non-loopback address.
- Write support is disabled by default and is isolated behind `POST /v1/quotes`.

## API routes

All successful JSON responses include a numeric `code` field. Cursor-bearing responses use the FxTwitter-style shape `{ "top": null, "bottom": "..." }`.

| Route | Purpose | Session |
| --- | --- | --- |
| `GET /2/status/:id` | Fetch one status | No |
| `GET /2/status/:id/thread` | Status plus conversation data | No |
| `GET /2/thread/:id` | FxTwitter-compatible thread alias | No |
| `GET /2/conversation/:id` | Conversation alias | No |
| `GET /2/status/:id/replies` | List replies | No |
| `GET /2/status/:id/quotes` | List quote posts | No |
| `GET /2/status/:id/reposts` | List reposters | No |
| `GET /2/status/:id/retweets` | Reposts compatibility alias | No |
| `GET /2/status/:id/likes` | List likers | No |
| `GET /2/profile/:handle` | Profile; `/2/user/:handle` is an alias | No |
| `GET /2/profile/:handle/statuses` | Profile statuses | No |
| `GET /2/profile/:handle/media` | Profile media | No |
| `GET /2/profile/:handle/followers` | Followers | No |
| `GET /2/profile/:handle/following` | Following | No |
| `GET /2/search?q=...` | Search statuses and suggestions | No |
| `GET /2/trends` | Current trends | No |
| `GET /2/typeahead?q=...` | User/hashtag suggestions | No |
| `GET /2/timeline/public` | Public timeline | No |
| `GET /2/notifications/mentions` | Mention notifications | Yes |
| `GET /2/notifications/unread-count` | Unread mention count | Yes |
| `GET /oembed?url=...` | Small oEmbed response for a north status | No |
| `GET /v1/events/mentions` | Local SSE mention stream | Yes |

Equivalent `/v2/...` aliases are available for the main `/2/...` routes. The Gateway does not invent data for source features that north does not expose.

## Requirements

- Node.js 22 or newer
- A north account only for private notifications, mention events, uploads, or writes
- A local session cookie file or `NORTH_SESSION_COOKIE`

## Quick start

Install and start the Gateway:

```powershell
git clone https://github.com/pengin012/north-fx-api.git
cd north-fx-api
npm.cmd ci
npm.cmd run gateway
```

Public reads can be tested without a session. Keep URLs plain when using `curl.exe`; do not paste Markdown link syntax into the terminal.

```powershell
curl.exe -sS "http://127.0.0.1:8787/health"
curl.exe -sS "http://127.0.0.1:8787/2/status/2094605508622157083"
curl.exe -sS "http://127.0.0.1:8787/2/search?q=north"
```

The mention stream intentionally stays open:

```powershell
curl.exe -N "http://127.0.0.1:8787/v1/events/mentions"
```

Press `Ctrl+C` to stop the `curl.exe` stream. Press `Ctrl+C` in the Gateway terminal when the Gateway itself should stop.

## Session setup

The Gateway reads a session from one of these locations, in order:

1. `NORTH_SESSION_COOKIE`
2. `NORTH_SESSION_COOKIE_FILE`
3. `data/north-session.cookie`

For the browser-assisted helper:

```powershell
npm.cmd run session:setup
```

This opens a separate persistent Chrome profile. Complete the login and any Turnstile challenge manually. If Cloudflare blocks the helper, do not repeatedly retry it. Use a normal logged-in browser and save only the value after the `Cookie:` header to a local ignored file. Never paste a cookie into an issue, chat, terminal transcript, screenshot, or commit.

PowerShell example using an existing local cookie file:

```powershell
$env:NORTH_SESSION_COOKIE_FILE = "C:\path\to\north-session.cookie"
npm.cmd run gateway
```

Command Prompt (`cmd.exe`) equivalent:

```cmd
set "NORTH_SESSION_COOKIE_FILE=C:\path\to\north-session.cookie"
npm.cmd run gateway
```

The repository does not read another browser profile automatically.

## MIQ integration

The MIQ bot can use the separate Gateway for reads while preserving the existing explicit posting boundary.

Terminal A — Gateway:

```powershell
cd "C:\path\to\north-fx-api"
$env:NORTH_SESSION_COOKIE_FILE = "C:\path\to\north-session.cookie"
npm.cmd run gateway
```

Terminal B — MIQ worker:

```powershell
cd "C:\path\to\north-MIQ"
$env:NORTH_SESSION_COOKIE_FILE = "C:\path\to\north-session.cookie"
$env:NORTH_MIQ_GATEWAY_URL = "http://127.0.0.1:8787"
npm.cmd run miq -- --once
```

`--once` is a dry run unless `--post --confirm-public` are both supplied. With Gateway integration enabled:

- notification and parent-status reads use the Gateway;
- the parent avatar is still fetched directly from north;
- MIQ rendering remains local;
- upload and post operations remain direct north writes;
- stopping the Gateway is treated as a retryable read failure by the continuous MIQ worker.

If the Gateway has `NORTH_GATEWAY_TOKEN`, set the same value in MIQ as `NORTH_MIQ_GATEWAY_TOKEN`.

## Stability model

The default settings are intentionally conservative:

- GET requests retry only transient network/HTTP failures, with a bounded retry count.
- POST/DELETE requests are never blindly retried because a lost response may follow a successful write.
- Identical in-flight reads are coalesced and successful reads are cached briefly.
- Avatar bytes are validated, bounded, retried for transient availability, coalesced, and cached.
- JSON responses are capped at 16 MiB; avatar and generated-image data are capped at 8 MiB.
- Upstream concurrency defaults to 2 with a 100 ms start interval and a bounded queue.
- Mention polling checks the cheap unread-count endpoint first. The full mention page is refreshed when the count changes or at most every 30 seconds.
- SSE clients receive keepalives and are closed cleanly during Gateway shutdown.
- MIQ rendering disables network font downloads during requests and uses the local cache or host fonts.

The upstream north service may still be slow or unavailable. Stability here means the local process remains bounded, returns classified errors, and recovers from transient reads; it does not guarantee that north responds immediately.

## Configuration

Copy `.env.example` values into the environment as needed. This project does not load `.env` automatically, so secrets do not need to exist in the repository.

| Variable | Default | Description |
| --- | --- | --- |
| `NORTH_ORIGIN` | `https://north.rip` | HTTPS upstream origin |
| `NORTH_SESSION_COOKIE` | unset | Inline session cookie; keep it local |
| `NORTH_SESSION_COOKIE_FILE` | `data/north-session.cookie` | Session cookie file |
| `NORTH_GATEWAY_HOST` | `127.0.0.1` | Bind address |
| `NORTH_GATEWAY_PORT` | `8787` | Local HTTP port |
| `NORTH_GATEWAY_POLL_MS` | `5000` | SSE watcher poll interval |
| `NORTH_GATEWAY_NOTIFICATION_REFRESH_MS` | `30000` | Full mention refresh interval |
| `NORTH_GATEWAY_CACHE_MAX_ENTRIES` | `512` | Maximum cached Gateway responses |
| `NORTH_GATEWAY_UPSTREAM_MAX_QUEUE` | `100` | Maximum queued upstream reads |
| `NORTH_GATEWAY_STATE_FILE` | `data/north-gateway-state.json` | Seen-mention state |
| `NORTH_GATEWAY_REPLAY_EXISTING` | `0` | Replay existing mentions on first watcher start |
| `NORTH_GATEWAY_TOKEN` | unset | Required for non-loopback deployments |
| `NORTH_GATEWAY_ALLOW_WRITES` | `0` | Explicitly enable `POST /v1/quotes` |

Do not bind the Gateway to a public interface without a token and an independent network access policy. The Gateway is designed for local use.

## Limitations and responsible use

- north's web API may change without notice and may reject automated traffic.
- No upstream WebSocket/EventSource endpoint was available for this integration. The local SSE stream is backed by conservative polling.
- This is not a complete X/Twitter API or a promise of full FxTwitter compatibility.
- Media URLs point to north; this project does not silently proxy arbitrary external media.
- The write route is deliberately opt-in and is not enabled by default.
- Respect account privacy, deleted/unavailable posts, rate limits, terms, and operator permission.

## Development

```powershell
npm.cmd ci
npm.cmd run check
npm.cmd test
npm.cmd audit --omit=dev
```

Tests use deterministic fixtures and do not require a north session. Live checks should use reads only unless a write test is explicitly intended and separately approved.

Before a public push, inspect the exact tracked set:

```powershell
git status --short --ignored
git ls-files
git diff --check
```

Never commit `.env` files, cookies, browser profiles, storage state, generated private data, or copied request headers.

## License

MIT. See [LICENSE](LICENSE).

## Security

See [SECURITY.md](SECURITY.md). Please report security issues privately and do not include credentials or session material in an issue.
