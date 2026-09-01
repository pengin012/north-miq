const DEFAULT_ORIGIN = "https://north.rip";
const DEFAULT_USER_AGENT = "north-miq-bot/0.1";
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_IMAGE_BYTES = 8 * 1024 * 1024;

class NorthApiError extends Error {
  constructor(message, { status = 0, code = "unknown", fields = null } = {}) {
    super(message);
    this.name = "NorthApiError";
    this.status = status;
    this.code = code;
    this.fields = fields;
  }
}

function validateTweetId(id) {
  const value = String(id ?? "");
  if (!/^\d+$/.test(value)) throw new NorthApiError("northのポストIDが不正です。", { code: "invalid_tweet_id" });
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

function responseHeader(response, name) {
  return response.headers?.get?.(name) ?? "";
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
  userAgent = DEFAULT_USER_AGENT,
} = {}) {
  if (typeof fetchImpl !== "function") throw new Error("fetchが利用できません。");

  const baseOrigin = normalizeOrigin(origin);
  const cookie = sessionCookie ? String(sessionCookie).trim() : "";

  async function request(path, {
    method = "GET",
    body,
    headers = {},
    auth = false,
  } = {}) {
    if (auth && !cookie) {
      throw new NorthApiError("northの認証セッションが設定されていません。", { code: "missing_session" });
    }

    const requestHeaders = {
      accept: "application/json",
      "user-agent": userAgent,
      ...headers,
    };
    let requestBody = body;
    if (cookie) requestHeaders.cookie = cookie;
    if (body !== undefined && body !== null && !isFormDataBody(body)) {
      requestHeaders["content-type"] ??= "application/json";
      requestBody = JSON.stringify(body);
    }

    let response;
    try {
      response = await fetchImpl(`${baseOrigin}${path}`, {
        method,
        headers: requestHeaders,
        body: requestBody,
        redirect: "error",
        signal: makeAbortSignal(timeoutMs),
      });
    } catch (error) {
      throw new NorthApiError(`northへの接続に失敗しました: ${error instanceof Error ? error.message : String(error)}`, {
        code: "network_error",
      });
    }

    const raw = await response.text();
    let parsed = null;
    try {
      parsed = raw ? JSON.parse(raw) : null;
    } catch {
      if (response.ok) {
        throw new NorthApiError(`northからJSONではない応答が返りました（HTTP ${response.status}）。`, {
          status: response.status,
          code: "bad_response",
        });
      }
    }

    if (!response.ok) {
      throw new NorthApiError(parsed?.message ?? `north API error（HTTP ${response.status}）`, {
        status: response.status,
        code: parsed?.error ?? "http_error",
        fields: parsed?.fields ?? null,
      });
    }

    return { body: parsed, response };
  }

  async function getTweet(id) {
    const tweetId = validateTweetId(id);
    return (await request(`/api/tweets/${tweetId}`)).body;
  }

  async function getMe() {
    return (await request("/api/auth/me", { auth: true })).body;
  }

  async function getNotifications({ tab = "mentions", cursor = null } = {}) {
    const query = new URLSearchParams({ tab });
    if (cursor) query.set("cursor", cursor);
    return (await request(`/api/notifications?${query.toString()}`, { auth: true })).body;
  }

  async function uploadMedia(pngBuffer, filename = "miq.png") {
    if (!Buffer.isBuffer(pngBuffer) || pngBuffer.length === 0) {
      throw new NorthApiError("アップロードする画像が空です。", { code: "invalid_media" });
    }
    if (pngBuffer.length > maxImageBytes) {
      throw new NorthApiError("生成画像が大きすぎます。", { code: "media_too_large" });
    }
    const form = new FormData();
    form.append("file", new Blob([pngBuffer], { type: "image/png" }), filename);
    return (await request("/api/media", { method: "POST", body: form, auth: true })).body;
  }

  async function createTweet(payload) {
    if (!payload || typeof payload !== "object") throw new Error("ポストpayloadが不正です。");
    return (await request("/api/tweets", { method: "POST", body: payload, auth: true })).body;
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

    let response;
    try {
      response = await fetchImpl(url, {
        headers: { accept: "image/*", "user-agent": userAgent },
        redirect: "error",
        signal: makeAbortSignal(timeoutMs),
      });
    } catch (error) {
      throw new NorthApiError(`アイコンの取得に失敗しました: ${error instanceof Error ? error.message : String(error)}`, {
        code: "avatar_network_error",
      });
    }
    if (!response.ok) throw new NorthApiError(`アイコンの取得に失敗しました（HTTP ${response.status}）。`, {
      status: response.status,
      code: "avatar_http_error",
    });

    const contentType = responseHeader(response, "content-type").split(";", 1)[0].trim().toLowerCase();
    if (!contentType.startsWith("image/")) {
      throw new NorthApiError("投稿者アイコンが画像として返されませんでした。", { code: "avatar_content_type" });
    }
    const contentLength = Number(responseHeader(response, "content-length"));
    if (Number.isFinite(contentLength) && contentLength > maxImageBytes) {
      throw new NorthApiError("投稿者アイコンが大きすぎます。", { code: "avatar_too_large" });
    }

    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length === 0 || bytes.length > maxImageBytes) {
      throw new NorthApiError("投稿者アイコンのサイズが不正です。", { code: "avatar_too_large" });
    }
    return bytes;
  }

  return {
    origin: baseOrigin,
    getMe,
    getTweet,
    getNotifications,
    uploadMedia,
    createTweet,
    fetchNorthImage,
  };
}

export {
  DEFAULT_ORIGIN,
  NorthApiError,
  createNorthClient,
  validateTweetId,
};
