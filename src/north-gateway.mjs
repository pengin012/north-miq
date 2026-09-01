import { createServer } from "node:http";
import { readFile, mkdir, writeFile, rename } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createNorthClient, NorthApiError } from "./north-api.mjs";
import {
  normalizeConversationResponse,
  normalizeError,
  normalizeSearchResponse,
  normalizeStatusList,
  normalizeStatusResponse,
  normalizeStatus,
  normalizeTrendsResponse,
  normalizeUserResponse,
  normalizeUserListResponse,
  normalizeTypeaheadResponse,
  normalizeNotificationList,
} from "./north-fx-compat.mjs";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8787;
const DEFAULT_POLL_MS = 5_000;
const DEFAULT_NOTIFICATION_REFRESH_MS = 30_000;
const DEFAULT_CACHE_TTL_MS = 15_000;
const DEFAULT_MAX_BODY_BYTES = 1 * 1024 * 1024;
const DEFAULT_CACHE_MAX_ENTRIES = 512;
const DEFAULT_UPSTREAM_MAX_QUEUE = 100;
const MAX_SEEN_NOTIFICATIONS = 1_000;

function json(res, status, body, headers = {}) {
  if (res.writableEnded || res.destroyed) return;
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...headers,
  });
  res.end(data);
}

function htmlEscape(value) {
  return String(value ?? "")
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&#39;");
}

function getPathId(pathname, pattern) {
  const match = pathname.match(pattern);
  return match?.[1] ?? null;
}

function parseInteger(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number(value ?? fallback);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

async function readJsonBody(req, maxBytes = DEFAULT_MAX_BODY_BYTES) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > maxBytes) throw new NorthApiError("リクエスト本文が大きすぎます。", { status: 413, code: "body_too_large" });
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new NorthApiError("JSON本文を解釈できません。", { status: 400, code: "invalid_json" });
  }
}

class TtlCache {
  #entries = new Map();

  constructor({ maxEntries = DEFAULT_CACHE_MAX_ENTRIES } = {}) {
    this.maxEntries = Number.isInteger(maxEntries) && maxEntries > 0 ? maxEntries : DEFAULT_CACHE_MAX_ENTRIES;
  }

  get(key) {
    const entry = this.#entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.#entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key, value, ttlMs) {
    this.#entries.delete(key);
    this.#entries.set(key, { value, expiresAt: Date.now() + ttlMs });
    while (this.#entries.size > this.maxEntries) this.#entries.delete(this.#entries.keys().next().value);
  }
}

class SingleFlight {
  #pending = new Map();

  run(key, task) {
    const existing = this.#pending.get(key);
    if (existing) return existing;
    const promise = Promise.resolve().then(task).finally(() => this.#pending.delete(key));
    this.#pending.set(key, promise);
    return promise;
  }
}

class UpstreamLimiter {
  #queue = [];
  #active = 0;
  #nextStartAt = 0;
  #pumpTimer = null;

  constructor({ concurrency = 2, minIntervalMs = 100, maxQueue = DEFAULT_UPSTREAM_MAX_QUEUE } = {}) {
    this.concurrency = Number.isInteger(concurrency) && concurrency > 0 ? concurrency : 2;
    this.minIntervalMs = Number.isFinite(minIntervalMs) && minIntervalMs >= 0 ? minIntervalMs : 100;
    this.maxQueue = Number.isInteger(maxQueue) && maxQueue > 0 ? maxQueue : DEFAULT_UPSTREAM_MAX_QUEUE;
  }

  run(task) {
    if (this.#queue.length >= this.maxQueue) {
      return Promise.reject(new NorthApiError("Gatewayの上流リクエストが混雑しています。", {
        status: 503,
        code: "gateway_overloaded",
      }));
    }
    return new Promise((resolveTask, rejectTask) => {
      this.#queue.push({ task, resolveTask, rejectTask });
      this.#pump();
    });
  }

  #pump() {
    if (this.#active >= this.concurrency || this.#queue.length === 0) return;
    const delay = Math.max(0, this.#nextStartAt - Date.now());
    if (delay > 0) {
      if (!this.#pumpTimer) {
        this.#pumpTimer = setTimeout(() => {
          this.#pumpTimer = null;
          this.#pump();
        }, delay);
      }
      return;
    }
    const item = this.#queue.shift();
    this.#active += 1;
    this.#nextStartAt = Date.now() + this.minIntervalMs;
    Promise.resolve()
      .then(item.task)
      .then(item.resolveTask, item.rejectTask)
      .finally(() => {
        this.#active -= 1;
        this.#pump();
      });
    this.#pump();
  }
}

class MentionWatcher {
  constructor({ client, emit, stateFile, pollMs = DEFAULT_POLL_MS, notificationRefreshMs = DEFAULT_NOTIFICATION_REFRESH_MS, replayExisting = false }) {
    this.client = client;
    this.emit = emit;
    this.stateFile = stateFile;
    this.pollMs = pollMs;
    this.notificationRefreshMs = notificationRefreshMs;
    this.replayExisting = replayExisting;
    this.timer = null;
    this.running = false;
    this.initialized = false;
    this.seen = new Set();
    this.lastUnreadCount = null;
    this.lastFetchedAt = 0;
    this.failureCount = 0;
    this.nextPollAt = 0;
    this.lastErrorKey = null;
  }

  async load() {
    try {
      const state = JSON.parse(await readFile(this.stateFile, "utf8"));
      this.initialized = state?.initialized === true;
      this.seen = new Set(Array.isArray(state?.seen) ? state.seen.slice(-MAX_SEEN_NOTIFICATIONS) : []);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  async save() {
    const absolutePath = resolve(this.stateFile);
    await mkdir(dirname(absolutePath), { recursive: true });
    const temporaryPath = `${absolutePath}.${process.pid}.tmp`;
    await writeFile(temporaryPath, JSON.stringify({ initialized: this.initialized, seen: [...this.seen].slice(-MAX_SEEN_NOTIFICATIONS) }, null, 2));
    await rename(temporaryPath, absolutePath);
  }

  async poll() {
    if (this.running || Date.now() < this.nextPollAt) return false;
    this.running = true;
    try {
      const unread = await this.client.getUnreadCount();
      const unreadCount = Number(unread?.count ?? 0);
      const shouldFetch = this.lastUnreadCount === null
        || unreadCount !== this.lastUnreadCount
        || Date.now() - this.lastFetchedAt >= this.notificationRefreshMs;
      this.lastUnreadCount = unreadCount;
      if (!shouldFetch) {
        this.markSuccess();
        return true;
      }

      const payload = await this.client.getNotifications({ tab: "mentions" });
      this.lastFetchedAt = Date.now();
      const notifications = Array.isArray(payload?.items) ? payload.items : [];
      if (!this.initialized && !this.replayExisting) {
        notifications.forEach((notification) => this.seen.add(String(notification.id)));
        this.initialized = true;
        await this.save();
        this.markSuccess();
        return true;
      }

      for (const notification of [...notifications].reverse()) {
        const id = String(notification?.id ?? "");
        if (!id || this.seen.has(id)) continue;
        this.seen.add(id);
        await this.emit(notification);
      }
      this.initialized = true;
      await this.save();
      this.markSuccess();
      return true;
    } finally {
      this.running = false;
    }
  }

  markSuccess() {
    this.failureCount = 0;
    this.nextPollAt = 0;
    this.lastErrorKey = null;
  }

  noteFailure(error) {
    this.failureCount += 1;
    const delay = Math.min(this.pollMs * (2 ** Math.min(this.failureCount - 1, 6)), 5 * 60 * 1000);
    this.nextPollAt = Date.now() + delay;
    const key = `${error?.code ?? "unknown"}:${error?.status ?? 0}:${error?.message ?? String(error)}`;
    if (key !== this.lastErrorKey) {
      console.error(`[north-gateway] mention poll failed; retrying in ${Math.ceil(delay / 1000)}s: ${error instanceof Error ? error.message : String(error)}`);
      this.lastErrorKey = key;
    }
  }

  async start() {
    if (this.timer) return;
    await this.load();
    await this.poll();
    this.timer = setInterval(() => {
      this.poll().catch((error) => this.noteFailure(error));
    }, this.pollMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

function createGateway({
  client,
  origin = client.origin,
  token = null,
  allowWrites = false,
  sessionAvailable = client.hasSession === true,
  host = DEFAULT_HOST,
  cacheTtlMs = DEFAULT_CACHE_TTL_MS,
  cacheMaxEntries = DEFAULT_CACHE_MAX_ENTRIES,
  upstreamConcurrency = 2,
  upstreamMinIntervalMs = 100,
  upstreamMaxQueue = DEFAULT_UPSTREAM_MAX_QUEUE,
  pollMs = DEFAULT_POLL_MS,
  notificationRefreshMs = DEFAULT_NOTIFICATION_REFRESH_MS,
  stateFile = "data/north-gateway-state.json",
  replayExisting = false,
} = {}) {
  if (!client) throw new Error("client is required");
  const cache = new TtlCache({ maxEntries: cacheMaxEntries });
  const singleFlight = new SingleFlight();
  const limiter = new UpstreamLimiter({ concurrency: upstreamConcurrency, minIntervalMs: upstreamMinIntervalMs, maxQueue: upstreamMaxQueue });
  const sseClients = new Set();
  let heartbeatTimer = null;

  async function upstream(key, task, ttlMs = cacheTtlMs) {
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
    return singleFlight.run(key, async () => {
      const again = cache.get(key);
      if (again !== undefined) return again;
      const value = await limiter.run(task);
      if (ttlMs > 0) cache.set(key, value, ttlMs);
      return value;
    });
  }

  function isAuthorized(req) {
    if (!token) return true;
    return req.headers.authorization === `Bearer ${token}`;
  }

  function writeSse(event, data) {
    const payload = JSON.stringify(data);
    for (const res of sseClients) {
      try {
        if (res.writableEnded) {
          sseClients.delete(res);
          continue;
        }
        res.write(`event: ${event}\ndata: ${payload}\n\n`);
      } catch {
        sseClients.delete(res);
      }
    }
  }

  function startHeartbeat() {
    if (heartbeatTimer) return;
    heartbeatTimer = setInterval(() => {
      for (const res of sseClients) {
        try {
          if (res.writableEnded) sseClients.delete(res);
          else res.write(": keepalive\n\n");
        } catch {
          sseClients.delete(res);
        }
      }
    }, 25_000);
  }

  function stopHeartbeat() {
    if (!heartbeatTimer) return;
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }

  const watcher = new MentionWatcher({
    client,
    stateFile,
    pollMs,
    notificationRefreshMs,
    replayExisting,
    emit: async (notification) => writeSse("mention", normalizeNotificationList({ items: [notification] }, { origin }).notifications[0]),
  });

  async function handle(req, res) {
    const requestUrl = new URL(req.url ?? "/", `http://${host}`);
    const { pathname, searchParams } = requestUrl;
    if (!isAuthorized(req)) {
      json(res, 401, { code: 401, error: "unauthorized", message: "Gateway tokenが必要です。" });
      return;
    }

    if (req.method === "GET" && pathname === "/health") {
      try {
        const upstreamHealth = await upstream("health", () => client.getHealth(), 5_000);
        json(res, 200, { code: 200, service: "north-fx-api", origin, host, upstream: upstreamHealth, auth: sessionAvailable, events: { mentions: sessionAvailable, pollMs } });
      } catch (error) {
        json(res, normalizeError(error).code, normalizeError(error));
      }
      return;
    }

    if (req.method === "GET" && pathname === "/v1/events/mentions") {
      if (!sessionAvailable) {
        json(res, 401, { code: 401, error: "missing_session", message: "メンションイベントにはnorthセッションが必要です。" });
        return;
      }
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      res.write("retry: 5000\nevent: ready\ndata: {\"provider\":\"north\"}\n\n");
      sseClients.add(res);
      startHeartbeat();
      req.on("close", () => {
        sseClients.delete(res);
        if (sseClients.size === 0) {
          watcher.stop();
          stopHeartbeat();
        }
      });
      try {
        await watcher.start();
      } catch (error) {
        const normalized = normalizeError(error);
        if (!res.writableEnded && !res.destroyed) res.write(`event: error\ndata: ${JSON.stringify(normalized)}\n\n`);
        sseClients.delete(res);
        if (!res.writableEnded && !res.destroyed) res.end();
        if (sseClients.size === 0) {
          watcher.stop();
          stopHeartbeat();
        }
        return;
      }
      if (sseClients.size === 0) watcher.stop();
      return;
    }

    const statusId = getPathId(pathname, /^\/(?:2\/|v2\/)?status\/(\d+)$/u)
      ?? getPathId(pathname, /^\/i\/status\/(\d+)$/u)
      ?? getPathId(pathname, /^\/[^/]+\/status\/(\d+)$/u);
    if (req.method === "GET" && statusId) {
      try {
        const tweet = await upstream(`tweet:${statusId}`, () => client.getTweet(statusId), 15_000);
        json(res, 200, normalizeStatusResponse(tweet, { origin }));
      } catch (error) {
        const normalized = normalizeError(error);
        json(res, normalized.code, normalized);
      }
      return;
    }

    const threadId = getPathId(pathname, /^\/(?:2\/|v2\/)?status\/(\d+)\/(?:thread|conversation)$/u)
      ?? getPathId(pathname, /^\/(?:2\/|v2\/)?(?:thread|conversation)\/(\d+)$/u);
    if (req.method === "GET" && threadId) {
      try {
        const payload = await upstream(`conversation:${threadId}:${searchParams.get("cursor") ?? ""}`, () => client.getConversation(threadId, { cursor: searchParams.get("cursor") }), 5_000);
        json(res, 200, normalizeConversationResponse(payload, { origin }));
      } catch (error) {
        const normalized = normalizeError(error);
        json(res, normalized.code, normalized);
      }
      return;
    }

    const listMatch = pathname.match(/^\/(?:2\/|v2\/)?status\/(\d+)\/(replies|quotes|likes|retweets|reposts)$/u);
    if (req.method === "GET" && listMatch) {
      const [, id, kind] = listMatch;
      try {
        const cursor = searchParams.get("cursor");
        let payload;
        if (kind === "replies") payload = await upstream(`replies:${id}:${cursor ?? ""}`, () => client.getReplies(id, { cursor }), 5_000);
        else if (kind === "quotes") payload = await upstream(`quotes:${id}:${cursor ?? ""}`, () => client.getQuotes(id, { cursor }), 5_000);
        else if (kind === "likes") payload = await upstream(`likes:${id}:${cursor ?? ""}`, () => client.getLikes(id, { cursor }), 5_000);
        else payload = await upstream(`retweets:${id}:${cursor ?? ""}`, () => client.getRetweets(id, { cursor }), 5_000);
        json(res, 200, kind === "likes" || kind === "retweets"
          ? normalizeUserListResponse(payload, { origin })
          : kind === "reposts" ? normalizeUserListResponse(payload, { origin }) : kind === "quotes" ? normalizeSearchResponse(payload, { origin }) : normalizeStatusList(payload, { origin }));
      } catch (error) {
        const normalized = normalizeError(error);
        json(res, normalized.code, normalized);
      }
      return;
    }

    if (req.method === "GET" && ["/2/timeline/public", "/v2/timeline/public"].includes(pathname)) {
      try {
        const cursor = searchParams.get("cursor");
        const payload = await upstream(`timeline:${cursor ?? ""}`, () => client.getPublicTimeline({ cursor }), 5_000);
        json(res, 200, normalizeStatusList(payload, { origin }));
      } catch (error) {
        const normalized = normalizeError(error);
        json(res, normalized.code, normalized);
      }
      return;
    }

    if (req.method === "GET" && ["/2/search", "/v2/search"].includes(pathname)) {
      const query = searchParams.get("q") ?? "";
      if (!query.trim()) {
        json(res, 400, { code: 400, error: "missing_query", message: "qが必要です。" });
        return;
      }
      try {
      const tab = searchParams.get("tab") ?? searchParams.get("feed") ?? "all";
        const cursor = searchParams.get("cursor");
        const payload = await upstream(`search:${query}:${tab}:${cursor ?? ""}`, () => client.search(query, { tab, cursor }), 5_000);
        json(res, 200, normalizeSearchResponse(payload, { origin }));
      } catch (error) {
        const normalized = normalizeError(error);
        json(res, normalized.code, normalized);
      }
      return;
    }

    if (req.method === "GET" && ["/2/trends", "/v2/trends"].includes(pathname)) {
      try {
        const payload = await upstream("trends", () => client.getTrends(), 60_000);
        json(res, 200, normalizeTrendsResponse(payload));
      } catch (error) {
        const normalized = normalizeError(error);
        json(res, normalized.code, normalized);
      }
      return;
    }

    if (req.method === "GET" && ["/2/typeahead", "/v2/typeahead"].includes(pathname)) {
      const query = searchParams.get("q") ?? "";
      if (!query.trim()) {
        json(res, 400, { code: 400, error: "missing_query", message: "qが必要です。" });
        return;
      }
      try {
        const payload = await upstream(`suggest:${query}`, () => client.suggest(query), 10_000);
        json(res, 200, normalizeTypeaheadResponse(payload, { origin }));
      } catch (error) {
        const normalized = normalizeError(error);
        json(res, normalized.code, normalized);
      }
      return;
    }

    const userMatch = pathname.match(/^\/(?:2|v2)\/(?:user|profile)\/([^/]+)$/u);
    if (req.method === "GET" && userMatch) {
      const handle = decodeURIComponent(userMatch[1]);
      try {
        const user = await upstream(`user:${handle}`, () => client.getUser(handle), 60_000);
        json(res, 200, normalizeUserResponse(user, { origin }));
      } catch (error) {
        const normalized = normalizeError(error);
        json(res, normalized.code, normalized);
      }
      return;
    }

    const userRelationMatch = pathname.match(/^\/(?:2|v2)\/profile\/([^/]+)\/(followers|following)$/u);
    if (req.method === "GET" && userRelationMatch) {
      const handle = decodeURIComponent(userRelationMatch[1]);
      const relation = userRelationMatch[2];
      try {
        const cursor = searchParams.get("cursor");
        const payload = relation === "followers"
          ? await upstream(`followers:${handle}:${cursor ?? ""}`, () => client.getUserFollowers(handle, { cursor }), 15_000)
          : await upstream(`following:${handle}:${cursor ?? ""}`, () => client.getUserFollowing(handle, { cursor }), 15_000);
        json(res, 200, normalizeUserListResponse(payload, { origin }));
      } catch (error) {
        const normalized = normalizeError(error);
        json(res, normalized.code, normalized);
      }
      return;
    }

    const userTweetsMatch = pathname.match(/^\/(?:2|v2)\/(?:user|profile)\/([^/]+)\/(tweets|statuses|media)$/u);
    if (req.method === "GET" && userTweetsMatch) {
      const handle = decodeURIComponent(userTweetsMatch[1]);
      const tab = userTweetsMatch[2] === "media" ? "media" : searchParams.get("tab") ?? "posts";
      const cursor = searchParams.get("cursor");
      try {
        const payload = await upstream(`user-tweets:${handle}:${tab}:${cursor ?? ""}`, () => client.getUserTweets(handle, { tab, cursor }), 5_000);
        json(res, 200, normalizeStatusList(payload, { origin }));
      } catch (error) {
        const normalized = normalizeError(error);
        json(res, normalized.code, normalized);
      }
      return;
    }

    if (req.method === "GET" && ["/2/notifications/mentions", "/v2/notifications/mentions"].includes(pathname)) {
      if (!sessionAvailable) {
        json(res, 401, { code: 401, error: "missing_session", message: "メンション取得にはnorthセッションが必要です。" });
        return;
      }
      try {
        const cursor = searchParams.get("cursor");
        const payload = await upstream(`mentions:${cursor ?? ""}`, () => client.getNotifications({ tab: "mentions", cursor }), 2_000);
        json(res, 200, normalizeNotificationList(payload, { origin }));
      } catch (error) {
        const normalized = normalizeError(error);
        json(res, normalized.code, normalized);
      }
      return;
    }

    if (req.method === "GET" && ["/2/notifications/unread-count", "/v2/notifications/unread-count"].includes(pathname)) {
      if (!sessionAvailable) {
        json(res, 401, { code: 401, error: "missing_session", message: "通知件数の取得にはnorthセッションが必要です。" });
        return;
      }
      try {
        const payload = await upstream("unread-count", () => client.getUnreadCount(), 1_000);
        const count = Number(payload?.count ?? 0);
        json(res, 200, { code: 200, count: Number.isFinite(count) && count >= 0 ? count : 0 });
      } catch (error) {
        const normalized = normalizeError(error);
        json(res, normalized.code, normalized);
      }
      return;
    }

    if (req.method === "GET" && pathname === "/oembed") {
      const sourceUrl = searchParams.get("url");
      const match = sourceUrl?.match(/^https:\/\/north\.rip\/[^/]+\/status\/(\d+)\/?$/u);
      if (!match) {
        json(res, 400, { code: 400, error: "invalid_url", message: "northのstatus URLが必要です。" });
        return;
      }
      try {
        const tweet = await upstream(`tweet:${match[1]}`, () => client.getTweet(match[1]), 15_000);
        const status = normalizeStatus(tweet, { origin });
        const text = htmlEscape(status?.text ?? "");
        const authorName = htmlEscape(status?.author?.name ?? "north");
        json(res, 200, {
          version: "1.0",
          type: "rich",
          provider_name: "north",
          provider_url: origin,
          author_name: status?.author?.name ?? "north",
          author_url: status?.author?.screen_name ? `${origin}/${status.author.screen_name}` : null,
          url: sourceUrl,
          html: `<blockquote class="north-status"><p>${text}</p><cite>— ${authorName}</cite></blockquote>`,
        });
      } catch (error) {
        const normalized = normalizeError(error);
        json(res, normalized.code, normalized);
      }
      return;
    }

    if (req.method === "POST" && pathname === "/v1/quotes") {
      if (!allowWrites) {
        json(res, 403, { code: 403, error: "writes_disabled", message: "Gatewayの書き込み機能は無効です。" });
        return;
      }
      if (!sessionAvailable) {
        json(res, 401, { code: 401, error: "missing_session", message: "書き込みにはnorthセッションが必要です。" });
        return;
      }
      try {
        const body = await readJsonBody(req);
        const created = await limiter.run(() => client.createQuote(body));
        json(res, 201, { code: 201, status: normalizeStatus(created, { origin }) });
      } catch (error) {
        const normalized = normalizeError(error);
        json(res, normalized.code, normalized);
      }
      return;
    }

    json(res, 404, { code: 404, error: "not_found", message: "Gateway endpointがありません。" });
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((error) => {
      const normalized = normalizeError(error);
      json(res, normalized.code, normalized);
    });
  });

  return {
    server,
    watcher,
    stop: () => {
      watcher.stop();
      stopHeartbeat();
      for (const res of sseClients) res.end();
      sseClients.clear();
      // SSE uses keep-alive connections. Close any remaining idle sockets so
      // graceful shutdown does not wait forever for a client-side timeout.
      server.closeAllConnections?.();
    },
  };
}

async function readSessionCookie() {
  const inline = process.env.NORTH_SESSION_COOKIE?.trim();
  if (inline) return inline;
  const path = process.env.NORTH_SESSION_COOKIE_FILE?.trim() ?? "data/north-session.cookie";
  try {
    return (await readFile(resolve(path), "utf8")).trim() || null;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function main() {
  const host = process.env.NORTH_GATEWAY_HOST ?? DEFAULT_HOST;
  const port = parseInteger(process.env.NORTH_GATEWAY_PORT, DEFAULT_PORT, { min: 1, max: 65_535 });
  const pollMs = parseInteger(process.env.NORTH_GATEWAY_POLL_MS, DEFAULT_POLL_MS, { min: 2_000, max: 300_000 });
  const notificationRefreshMs = parseInteger(process.env.NORTH_GATEWAY_NOTIFICATION_REFRESH_MS, DEFAULT_NOTIFICATION_REFRESH_MS, { min: 5_000, max: 600_000 });
  const cacheMaxEntries = parseInteger(process.env.NORTH_GATEWAY_CACHE_MAX_ENTRIES, DEFAULT_CACHE_MAX_ENTRIES, { min: 1, max: 10_000 });
  const upstreamMaxQueue = parseInteger(process.env.NORTH_GATEWAY_UPSTREAM_MAX_QUEUE, DEFAULT_UPSTREAM_MAX_QUEUE, { min: 1, max: 10_000 });
  const token = process.env.NORTH_GATEWAY_TOKEN?.trim() || null;
  const loopbackHosts = new Set(["127.0.0.1", "localhost", "::1"]);
  if (!loopbackHosts.has(host) && !token) throw new Error("外部bindにはNORTH_GATEWAY_TOKENが必要です。");
  const sessionCookie = await readSessionCookie();
  const gateway = createGateway({
    client: createNorthClient({ sessionCookie }),
    sessionAvailable: Boolean(sessionCookie),
    token,
    allowWrites: process.env.NORTH_GATEWAY_ALLOW_WRITES === "1",
    cacheMaxEntries,
    upstreamMaxQueue,
    host,
    pollMs,
    notificationRefreshMs,
    stateFile: process.env.NORTH_GATEWAY_STATE_FILE ?? "data/north-gateway-state.json",
    replayExisting: process.env.NORTH_GATEWAY_REPLAY_EXISTING === "1",
  });
  gateway.server.listen(port, host, () => {
    console.log(`[north-gateway] listening on http://${host}:${port}`);
  });
  const shutdown = () => {
    gateway.stop();
    gateway.server.close(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[north-gateway] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}

export {
  MentionWatcher,
  TtlCache,
  UpstreamLimiter,
  createGateway,
  htmlEscape,
  normalizeError,
  parseInteger,
};
