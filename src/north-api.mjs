const DEFAULT_ORIGIN = "https://north.rip";
const DEFAULT_USER_AGENT = "north-fx-api/0.1 (+https://github.com/pengin012/north-fx-api)";
const DEFAULT_TIMEOUT_MS = 12_000;
const DEFAULT_MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_DELAY_MS = 500;
const DEFAULT_AVATAR_RETRIES = 3;
const DEFAULT_AVATAR_RETRY_DELAY_MS = 750;
const AVATAR_CACHE_TTL_MS = 15 * 60 * 1000;
const MAX_CACHED_AVATARS = 64;

class NorthApiError extends Error {
  constructor(message, {
    status = 0,
    code = "unknown",
    fields = null,
    path = null,
    causeCode = null,
    rateLimit = null,
    uncertainWrite = false,
  } = {}) {
    super(message);
    this.name = "NorthApiError";
    this.status = status;
    this.code = code;
    this.fields = fields;
    this.path = path;
    this.causeCode = causeCode;
    this.rateLimit = rateLimit;
    this.uncertainWrite = uncertainWrite;
  }
}

function validateTweetId(id) {
  const value = String(id ?? "");
  if (!/^\d{1,30}$/.test(value)) throw new NorthApiError("northのポストIDが不正です。", { code: "invalid_tweet_id" });
  return value;
}

function normalizeOrigin(origin) {
  const url = new URL(origin);
  if (url.protocol !== "https:") throw new Error("NORTH_ORIGINはhttpsで指定してください。");
  return url.origin;
}

function isFormDataBody(body) {
  return typeof FormData !== "undefined" && body instanceof FormData;
}

function header(response, name) {
  return response.headers?.get?.(name) ?? "";
}

function rateLimitFromResponse(response) {
  const parse = (name) => {
    const raw = header(response, name).trim();
    if (!raw) return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  };
  const limit = parse("x-ratelimit-limit");
  const remaining = parse("x-ratelimit-remaining");
  const reset = parse("x-ratelimit-reset");
  if ([limit, remaining, reset].every((value) => value === null)) return null;
  return {
    limit: Number.isFinite(limit) ? limit : null,
    remaining: Number.isFinite(remaining) ? remaining : null,
    reset: Number.isFinite(reset) ? reset : null,
  };
}

function isRetryableStatus(status) {
  return [408, 425, 429, 500, 502, 503, 504].includes(status);
}

function retryAfterMilliseconds(response, fallback) {
  const raw = header(response, "retry-after").trim();
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? Math.min(value * 1000, 5 * 60 * 1000) : fallback;
}

function sleep(milliseconds) {
  return milliseconds > 0 ? new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds)) : Promise.resolve();
}

async function readResponseBytes(response, maxBytes, path) {
  const contentLength = Number(header(response, "content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    await response.body?.cancel?.();
    throw new NorthApiError("northの応答が大きすぎます。", {
      status: response.status,
      code: "response_too_large",
      path,
    });
  }

  if (!response.body?.getReader) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > maxBytes) {
      throw new NorthApiError("northの応答が大きすぎます。", {
        status: response.status,
        code: "response_too_large",
        path,
      });
    }
    return bytes;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new NorthApiError("northの応答が大きすぎます。", {
          status: response.status,
          code: "response_too_large",
          path,
        });
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock?.();
  }
  return Buffer.concat(chunks, total);
}

async function readResponseText(response, maxBytes, path) {
  return (await readResponseBytes(response, maxBytes, path)).toString("utf8");
}

function makeAbortSignal(timeoutMs) {
  return typeof AbortSignal?.timeout === "function" ? AbortSignal.timeout(timeoutMs) : undefined;
}

function createNorthClient({
  origin = DEFAULT_ORIGIN,
  sessionCookie = null,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxImageBytes = DEFAULT_MAX_IMAGE_BYTES,
  maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
  maxRetries = DEFAULT_MAX_RETRIES,
  retryDelayMs = DEFAULT_RETRY_DELAY_MS,
  avatarRetries = DEFAULT_AVATAR_RETRIES,
  avatarRetryDelayMs = DEFAULT_AVATAR_RETRY_DELAY_MS,
  closeConnections = true,
  userAgent = DEFAULT_USER_AGENT,
} = {}) {
  if (typeof fetchImpl !== "function") throw new Error("fetchが利用できません。");

  const baseOrigin = normalizeOrigin(origin);
  const cookie = sessionCookie ? String(sessionCookie).trim() : "";
  const retries = Number.isInteger(maxRetries) && maxRetries >= 0 ? maxRetries : DEFAULT_MAX_RETRIES;
  const retryDelay = Number.isFinite(retryDelayMs) && retryDelayMs >= 0 ? retryDelayMs : DEFAULT_RETRY_DELAY_MS;
  const avatarRetryCount = Number.isInteger(avatarRetries) && avatarRetries >= 0 ? avatarRetries : DEFAULT_AVATAR_RETRIES;
  const avatarRetryDelay = Number.isFinite(avatarRetryDelayMs) && avatarRetryDelayMs >= 0 ? avatarRetryDelayMs : DEFAULT_AVATAR_RETRY_DELAY_MS;
  const avatarCache = new Map();
  const avatarPending = new Map();

  async function request(path, {
    method = "GET",
    body,
    headers = {},
    auth = false,
    retryable = method === "GET" || method === "HEAD",
  } = {}) {
    if (auth && !cookie) {
      throw new NorthApiError("northの認証セッションが設定されていません。", { code: "missing_session", path });
    }

    const requestHeaders = {
      accept: "application/json",
      "user-agent": userAgent,
      ...headers,
    };
    if (closeConnections) requestHeaders.connection = "close";
    if (cookie) requestHeaders.cookie = cookie;

    let requestBody = body;
    if (body !== undefined && body !== null && !isFormDataBody(body)) {
      requestHeaders["content-type"] ??= "application/json";
      requestBody = JSON.stringify(body);
    }

    const canRetry = retryable && (method === "GET" || method === "HEAD");
    let response;
    let attempt = 0;
    while (true) {
      try {
        response = await fetchImpl(`${baseOrigin}${path}`, {
          method,
          headers: requestHeaders,
          body: requestBody,
          redirect: "error",
          signal: makeAbortSignal(timeoutMs),
        });
      } catch (error) {
        if (canRetry && attempt < retries) {
          attempt += 1;
          await sleep(retryDelay * attempt);
          continue;
        }
        const causeCode = error?.cause?.code ?? error?.code ?? null;
        const uncertainWrite = !canRetry && method !== "GET" && method !== "HEAD";
        throw new NorthApiError(
          uncertainWrite
            ? `northへの書き込み結果を確認できませんでした: ${error instanceof Error ? error.message : String(error)}`
            : `northへの接続に失敗しました: ${error instanceof Error ? error.message : String(error)}`,
          { code: uncertainWrite ? "write_uncertain" : "network_error", path, causeCode, uncertainWrite },
        );
      }

      if (!canRetry || !isRetryableStatus(response.status) || attempt >= retries) break;
      attempt += 1;
      await sleep(retryAfterMilliseconds(response, retryDelay * attempt));
    }

    const rateLimit = rateLimitFromResponse(response);
    const raw = await readResponseText(response, maxResponseBytes, path);
    let parsed = null;
    try {
      parsed = raw ? JSON.parse(raw) : null;
    } catch {
      if (response.ok) {
        throw new NorthApiError(`northからJSONではない応答が返りました（HTTP ${response.status}）。`, {
          status: response.status,
          code: "bad_response",
          path,
          rateLimit,
        });
      }
    }

    if (!response.ok) {
      const uncertainWrite = !canRetry && method !== "GET" && method !== "HEAD" && isRetryableStatus(response.status);
      throw new NorthApiError(parsed?.message ?? `north API error（HTTP ${response.status}）`, {
        status: response.status,
        code: uncertainWrite ? "write_uncertain" : parsed?.error ?? "http_error",
        fields: parsed?.fields ?? null,
        path,
        rateLimit,
        uncertainWrite,
      });
    }

    return { body: parsed, response, rateLimit };
  }

  async function getHealth() {
    return (await request("/api/health")).body;
  }

  async function getMe() {
    return (await request("/api/auth/me", { auth: true })).body;
  }

  async function getTweet(id) {
    return (await request(`/api/tweets/${validateTweetId(id)}`)).body;
  }

  async function getNotifications({ tab = "mentions", cursor = null } = {}) {
    const query = new URLSearchParams({ tab });
    if (cursor) query.set("cursor", cursor);
    return (await request(`/api/notifications?${query.toString()}`, { auth: true })).body;
  }

  async function getUnreadCount() {
    return (await request("/api/notifications/unread-count", { auth: true })).body;
  }

  async function getPublicTimeline({ cursor = null } = {}) {
    return (await request(`/api/timeline/public${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`)).body;
  }

  async function search(query, { tab = "all", cursor = null } = {}) {
    const params = new URLSearchParams({ q: String(query ?? ""), tab });
    if (cursor) params.set("cursor", cursor);
    return (await request(`/api/search?${params.toString()}`)).body;
  }

  async function suggest(query) {
    return (await request(`/api/search/suggest?q=${encodeURIComponent(String(query ?? ""))}`)).body;
  }

  async function getTrends() {
    return (await request("/api/trends")).body;
  }

  async function getUser(handle) {
    return (await request(`/api/users/${encodeURIComponent(String(handle ?? ""))}`)).body;
  }

  async function getUserTweets(handle, { tab = "posts", cursor = null } = {}) {
    const params = new URLSearchParams({ tab });
    if (cursor) params.set("cursor", cursor);
    return (await request(`/api/users/${encodeURIComponent(String(handle ?? ""))}/tweets?${params.toString()}`)).body;
  }

  async function getUserFollowers(handle, { cursor = null } = {}) {
    return (await request(`/api/users/${encodeURIComponent(String(handle ?? ""))}/followers${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`)).body;
  }

  async function getUserFollowing(handle, { cursor = null } = {}) {
    return (await request(`/api/users/${encodeURIComponent(String(handle ?? ""))}/following${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`)).body;
  }

  async function getConversation(id, { cursor = null } = {}) {
    const tweetId = validateTweetId(id);
    return (await request(`/api/tweets/${tweetId}/conversation${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`)).body;
  }

  async function getReplies(id, { cursor = null } = {}) {
    const tweetId = validateTweetId(id);
    return (await request(`/api/tweets/${tweetId}/replies${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`)).body;
  }

  async function getLikes(id, { cursor = null } = {}) {
    const tweetId = validateTweetId(id);
    return (await request(`/api/tweets/${tweetId}/likes${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`)).body;
  }

  async function getRetweets(id, { cursor = null } = {}) {
    const tweetId = validateTweetId(id);
    return (await request(`/api/tweets/${tweetId}/retweets${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`)).body;
  }

  async function getQuotes(id, { cursor = null } = {}) {
    const tweetId = validateTweetId(id);
    return (await request(`/api/tweets/${tweetId}/retweets/with_comments${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`)).body;
  }

  async function getMedia(id) {
    return (await request(`/api/media/${encodeURIComponent(String(id ?? ""))}`)).body;
  }

  async function uploadMedia(pngBuffer, filename = "upload.png") {
    if (!Buffer.isBuffer(pngBuffer) || pngBuffer.length === 0) {
      throw new NorthApiError("アップロードする画像が空です。", { code: "invalid_media", path: "/api/media" });
    }
    if (pngBuffer.length > maxImageBytes) {
      throw new NorthApiError("生成画像が大きすぎます。", { code: "media_too_large", path: "/api/media" });
    }
    const form = new FormData();
    form.append("file", new Blob([pngBuffer], { type: "image/png" }), filename);
    return (await request("/api/media", { method: "POST", body: form, auth: true })).body;
  }

  async function createTweet(payload) {
    if (!payload || typeof payload !== "object") throw new Error("ポストpayloadが不正です。");
    return (await request("/api/tweets", { method: "POST", body: payload, auth: true, retryable: false })).body;
  }

  async function createReply({ text, inReplyToId, mediaIds = [], replyPolicy = "EVERYONE" }) {
    return createTweet({ text, inReplyToId: validateTweetId(inReplyToId), mediaIds, replyPolicy });
  }

  async function createQuote({ text, quotedId, mediaIds = [], replyPolicy = "EVERYONE", inReplyToId = null }) {
    const payload = { text, quotedId: validateTweetId(quotedId), mediaIds, replyPolicy };
    if (inReplyToId) payload.inReplyToId = validateTweetId(inReplyToId);
    return createTweet(payload);
  }

  async function likeTweet(id) {
    return (await request(`/api/tweets/${validateTweetId(id)}/like`, { method: "POST", auth: true, retryable: false })).body;
  }

  async function unlikeTweet(id) {
    return (await request(`/api/tweets/${validateTweetId(id)}/like`, { method: "DELETE", auth: true, retryable: false })).body;
  }

  async function retweet(id) {
    return (await request(`/api/tweets/${validateTweetId(id)}/retweet`, { method: "POST", auth: true, retryable: false })).body;
  }

  async function unretweet(id) {
    return (await request(`/api/tweets/${validateTweetId(id)}/retweet`, { method: "DELETE", auth: true, retryable: false })).body;
  }

  async function bookmark(id) {
    return (await request(`/api/tweets/${validateTweetId(id)}/bookmark`, { method: "POST", auth: true, retryable: false })).body;
  }

  async function unbookmark(id) {
    return (await request(`/api/tweets/${validateTweetId(id)}/bookmark`, { method: "DELETE", auth: true, retryable: false })).body;
  }

  async function follow(handle) {
    return (await request(`/api/users/${encodeURIComponent(String(handle ?? ""))}/follow`, { method: "POST", auth: true, retryable: false })).body;
  }

  async function unfollow(handle) {
    return (await request(`/api/users/${encodeURIComponent(String(handle ?? ""))}/follow`, { method: "DELETE", auth: true, retryable: false })).body;
  }

  async function fetchNorthImage(imageUrl) {
    let url;
    try {
      url = new URL(String(imageUrl ?? ""), baseOrigin);
    } catch {
      throw new NorthApiError("アイコンURLを解釈できません。", { code: "invalid_avatar_url" });
    }
    if (url.protocol !== "https:" || url.origin !== baseOrigin) {
      throw new NorthApiError("north内のアイコンだけを読み込めます。", { code: "external_avatar_url" });
    }

    const cacheKey = url.toString();
    const cached = avatarCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return Buffer.from(cached.bytes);
    if (cached) avatarCache.delete(cacheKey);

    const pending = avatarPending.get(cacheKey);
    if (pending) return Buffer.from(await pending);

    const load = (async () => {
      let response;
      let attempt = 0;
      while (true) {
        const requestUrl = new URL(url);
        if (attempt > 0) requestUrl.searchParams.set("north_fx_avatar_retry", String(attempt));
        try {
          response = await fetchImpl(requestUrl, {
            headers: { accept: "image/*", "user-agent": userAgent },
            redirect: "error",
            signal: makeAbortSignal(timeoutMs),
          });
        } catch (error) {
          if (attempt < avatarRetryCount) {
            attempt += 1;
            await sleep(avatarRetryDelay * attempt);
            continue;
          }
          throw new NorthApiError(`アイコンの取得に失敗しました: ${error instanceof Error ? error.message : String(error)}`, {
            code: "avatar_network_error",
            path: url.pathname,
            causeCode: error?.cause?.code ?? error?.code ?? null,
          });
        }
        if (!(response.status === 404 || isRetryableStatus(response.status)) || attempt >= avatarRetryCount) break;
        await response.body?.cancel?.();
        attempt += 1;
        await sleep(retryAfterMilliseconds(response, avatarRetryDelay * attempt));
      }

      if (!response.ok) throw new NorthApiError(`アイコンの取得に失敗しました（HTTP ${response.status}）。`, {
        status: response.status,
        code: response.status === 404 ? "avatar_not_found" : "avatar_http_error",
        path: url.pathname,
      });

      const contentType = header(response, "content-type").split(";", 1)[0].trim().toLowerCase();
      if (!contentType.startsWith("image/")) throw new NorthApiError("投稿者アイコンが画像として返されませんでした。", {
        code: "avatar_content_type",
        path: url.pathname,
      });
      const contentLength = Number(header(response, "content-length"));
      if (Number.isFinite(contentLength) && contentLength > maxImageBytes) throw new NorthApiError("投稿者アイコンが大きすぎます。", {
        code: "avatar_too_large",
        path: url.pathname,
      });

      const bytes = await readResponseBytes(response, maxImageBytes, url.pathname);
      if (bytes.length === 0 || bytes.length > maxImageBytes) throw new NorthApiError("投稿者アイコンのサイズが不正です。", {
        code: "avatar_too_large",
        path: url.pathname,
      });
      avatarCache.set(cacheKey, { bytes: Buffer.from(bytes), expiresAt: Date.now() + AVATAR_CACHE_TTL_MS });
      while (avatarCache.size > MAX_CACHED_AVATARS) avatarCache.delete(avatarCache.keys().next().value);
      return bytes;
    })();
    avatarPending.set(cacheKey, load);
    try {
      return Buffer.from(await load);
    } finally {
      if (avatarPending.get(cacheKey) === load) avatarPending.delete(cacheKey);
    }
  }

  return {
    origin: baseOrigin,
    hasSession: Boolean(cookie),
    getHealth,
    getMe,
    getTweet,
    getNotifications,
    getUnreadCount,
    getPublicTimeline,
    search,
    suggest,
    getTrends,
    getUser,
    getUserTweets,
    getUserFollowers,
    getUserFollowing,
    getConversation,
    getReplies,
    getLikes,
    getRetweets,
    getQuotes,
    getMedia,
    uploadMedia,
    createTweet,
    createReply,
    createQuote,
    likeTweet,
    unlikeTweet,
    retweet,
    unretweet,
    bookmark,
    unbookmark,
    follow,
    unfollow,
    fetchNorthImage,
  };
}

export {
  DEFAULT_ORIGIN,
  NorthApiError,
  createNorthClient,
  validateTweetId,
};
