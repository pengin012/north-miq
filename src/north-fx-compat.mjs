const STATUS_TYPE = "status";

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function absoluteUrl(origin, value) {
  if (!value) return null;
  try {
    const url = new URL(String(value), origin);
    return ["http:", "https:"].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

function timestampSeconds(value) {
  const timestamp = Date.parse(String(value ?? ""));
  return Number.isFinite(timestamp) ? Math.floor(timestamp / 1000) : null;
}

function normalizeUser(user, { origin }) {
  if (!user) return null;
  const handle = String(user.handle ?? "");
  return {
    id: user.id == null ? null : String(user.id),
    name: user.name ?? handle,
    screen_name: handle,
    username: handle,
    handle,
    description: user.bio ?? null,
    location: user.location ?? null,
    url: user.website ?? null,
    protected: Boolean(user.protected),
    verified: Boolean(user.verified),
    created_at: user.createdAt ?? null,
    created_timestamp: timestampSeconds(user.createdAt),
    followers_count: finiteNumber(user.followerCount),
    following_count: finiteNumber(user.followingCount),
    statuses_count: finiteNumber(user.tweetCount),
    avatar_url: absoluteUrl(origin, user.avatarUrl),
    profile_image_url: absoluteUrl(origin, user.avatarUrl),
    profile_image_url_https: absoluteUrl(origin, user.avatarUrl),
    profile_banner_url: absoluteUrl(origin, user.headerUrl),
  };
}

function fileFormat(value) {
  return String(value ?? "").split("?")[0].split(".").pop()?.toLowerCase() || null;
}

function normalizePhoto(media = {}, { origin }) {
  return {
    id: media.id == null ? null : String(media.id),
    type: String(media.kind ?? "PHOTO").toUpperCase() === "GIF" ? "gif" : "photo",
    format: fileFormat(media.url),
    url: absoluteUrl(origin, media.url),
    width: finiteNumber(media.width),
    height: finiteNumber(media.height),
    transcode_url: null,
    altText: media.altText ?? null,
    sensitive: Boolean(media.sensitive),
  };
}

function normalizeVideo(media = {}, { origin }) {
  return {
    id: media.id == null ? null : String(media.id),
    type: String(media.kind ?? "VIDEO").toUpperCase() === "GIF" ? "gif" : "video",
    format: fileFormat(media.url),
    url: absoluteUrl(origin, media.url),
    thumbnail_url: absoluteUrl(origin, media.thumbnailUrl),
    width: finiteNumber(media.width),
    height: finiteNumber(media.height),
    transcode_url: null,
    duration: media.durationMs == null ? null : finiteNumber(media.durationMs) / 1000,
    filesize: null,
    formats: [],
    publisher: null,
    sensitive: Boolean(media.sensitive),
  };
}

function normalizeMedia(mediaList, { origin }) {
  const media = Array.isArray(mediaList) ? mediaList : [];
  const photos = media.filter((item) => ["PHOTO", "GIF"].includes(String(item?.kind ?? "").toUpperCase())).map((item) => normalizePhoto(item, { origin }));
  const videos = media.filter((item) => String(item?.kind ?? "").toUpperCase() === "VIDEO").map((item) => normalizeVideo(item, { origin }));
  return {
    all: [...photos, ...videos],
    photos,
    videos,
    external: null,
    mosaic: null,
    broadcast: null,
  };
}

function normalizeReplyingTo(tweet) {
  if (!tweet?.inReplyToId) return null;
  return {
    status_id: String(tweet.inReplyToId),
    username: tweet.inReplyToHandle ?? null,
  };
}

function normalizeStatus(tweet, { origin, depth = 0 } = {}) {
  if (!tweet) return null;
  if (tweet.id == null || String(tweet.id) === "") return null;
  const author = normalizeUser(tweet.author, { origin });
  const handle = author?.screen_name || "unknown";
  const text = String(tweet.text ?? "");
  const media = normalizeMedia(tweet.media, { origin });
  const hasVideo = media.videos.length > 0;
  const hasImage = media.photos.length > 0;
  const nested = depth < 3;
  return {
    type: STATUS_TYPE,
    id: String(tweet.id),
    id_str: String(tweet.id),
    url: `${origin}/${encodeURIComponent(handle)}/status/${encodeURIComponent(String(tweet.id))}`,
    text,
    created_at: tweet.createdAt ?? null,
    created_timestamp: timestampSeconds(tweet.createdAt),
    likes: finiteNumber(tweet.likeCount),
    reposts: finiteNumber(tweet.retweetCount),
    retweets: finiteNumber(tweet.retweetCount),
    quotes: finiteNumber(tweet.quoteCount),
    replies: finiteNumber(tweet.replyCount),
    author,
    user: author,
    media,
    quote: nested ? normalizeStatus(tweet.quoted, { origin, depth: depth + 1 }) : null,
    quoted: nested ? normalizeStatus(tweet.quoted, { origin, depth: depth + 1 }) : null,
    retweet: nested ? normalizeStatus(tweet.retweetOf, { origin, depth: depth + 1 }) : null,
    replying_to: normalizeReplyingTo(tweet),
    possibly_sensitive: media.photos.some((item) => item.sensitive) || media.videos.some((item) => item.sensitive),
    raw_text: { text, display_text_range: [0, text.length], facets: [] },
    lang: null,
    translation: null,
    source: tweet.source ?? null,
    provider: "north",
    views: null,
    bookmarks: null,
    embed_card: hasVideo ? "player" : hasImage ? "summary_large_image" : "tweet",
    north: {
      conversationId: tweet.conversationId ?? null,
      replyPolicy: tweet.replyPolicy ?? null,
      editedAt: tweet.editedAt ?? null,
      editCount: finiteNumber(tweet.editCount),
      pinned: Boolean(tweet.pinned),
      liked: Boolean(tweet.liked),
      retweeted: Boolean(tweet.retweeted),
      bookmarked: Boolean(tweet.bookmarked),
      deleted: Boolean(tweet.deleted),
      unavailable: Boolean(tweet.unavailable),
    },
  };
}

function normalizeStatusResponse(tweet, { origin }) {
  const status = normalizeStatus(tweet, { origin });
  return { code: status ? 200 : 404, status, thread: null, author: status?.author ?? null };
}

function normalizeCursor(nextCursor) {
  if (nextCursor == null || nextCursor === "") return null;
  return { top: null, bottom: String(nextCursor) };
}

function normalizeStatusList(payload, { origin }) {
  const items = Array.isArray(payload?.items) ? payload.items : [];
  return {
    code: 200,
    results: items.map((item) => normalizeStatus(item, { origin })).filter(Boolean),
    cursor: normalizeCursor(payload?.nextCursor),
  };
}

function normalizeUserResponse(user, { origin }) {
  const normalized = normalizeUser(user, { origin });
  return { code: normalized ? 200 : 404, user: normalized };
}

function normalizeUserListResponse(payload, { origin }) {
  const items = Array.isArray(payload?.items) ? payload.items : Array.isArray(payload?.users) ? payload.users : [];
  return {
    code: 200,
    users: items.map((item) => normalizeUser(item, { origin })).filter(Boolean),
    cursor: normalizeCursor(payload?.nextCursor),
  };
}

function normalizeTypeaheadResponse(payload, { origin }) {
  return {
    code: 200,
    users: (Array.isArray(payload?.users) ? payload.users : []).map((user) => normalizeUser(user, { origin })).filter(Boolean),
    hashtags: Array.isArray(payload?.hashtags) ? payload.hashtags : [],
  };
}

function normalizeSearchResponse(payload, { origin }) {
  return {
    ...normalizeStatusList(payload, { origin }),
    users: (Array.isArray(payload?.users) ? payload.users : []).map((user) => normalizeUser(user, { origin })).filter(Boolean),
    hashtags: Array.isArray(payload?.hashtags) ? payload.hashtags : [],
  };
}

function normalizeConversationResponse(payload, { origin }) {
  const ancestors = Array.isArray(payload?.ancestors) ? payload.ancestors : [];
  const replies = Array.isArray(payload?.replies) ? payload.replies : [];
  const focal = payload?.tweet ?? null;
  const status = normalizeStatus(focal, { origin });
  return {
    code: 200,
    status,
    author: status?.author ?? null,
    thread: [...ancestors, focal, ...replies].map((item) => normalizeStatus(item, { origin })).filter(Boolean),
    ancestors: ancestors.map((item) => normalizeStatus(item, { origin })).filter(Boolean),
    replies: replies.map((item) => normalizeStatus(item, { origin })).filter(Boolean),
    reader_root_id: payload?.readerRootId == null ? null : String(payload.readerRootId),
    cursor: normalizeCursor(payload?.nextCursor),
  };
}

function normalizeNotification(notification, { origin }) {
  return {
    id: notification?.id == null ? null : String(notification.id),
    kind: notification?.kind ?? null,
    read: Boolean(notification?.read),
    created_at: notification?.createdAt ?? null,
    actors: (Array.isArray(notification?.actors) ? notification.actors : []).map((actor) => normalizeUser(actor, { origin })).filter(Boolean),
    status: normalizeStatus(notification?.tweet, { origin }),
    north: notification,
  };
}

function normalizeNotificationList(payload, { origin }) {
  return {
    code: 200,
    notifications: (Array.isArray(payload?.items) ? payload.items : []).map((item) => normalizeNotification(item, { origin })),
    cursor: normalizeCursor(payload?.nextCursor),
  };
}

function normalizeTrendsResponse(payload) {
  return {
    code: 200,
    trends: (Array.isArray(payload?.items) ? payload.items : []).map((item) => ({
      name: item.tag ?? "",
      query: item.isHashtag ? `#${item.tag}` : item.tag ?? "",
      tweet_volume: finiteNumber(item.count),
      is_hashtag: Boolean(item.isHashtag),
    })),
  };
}

function normalizeError(error) {
  const upstreamStatus = Number(error?.status);
  const status = Number.isInteger(upstreamStatus) && upstreamStatus >= 400 && upstreamStatus <= 599 ? upstreamStatus : 502;
  return {
    code: status,
    error: error?.code ?? "upstream_error",
    message: error?.message ?? "north APIへの接続に失敗しました。",
    path: error?.path ?? null,
    cause: error?.causeCode ?? null,
    rate_limit: error?.rateLimit ?? null,
  };
}

export {
  absoluteUrl,
  normalizeConversationResponse,
  normalizeError,
  normalizeNotification,
  normalizeNotificationList,
  normalizeSearchResponse,
  normalizeStatus,
  normalizeStatusList,
  normalizeStatusResponse,
  normalizeTrendsResponse,
  normalizeUser,
  normalizeUserListResponse,
  normalizeUserResponse,
  normalizeTypeaheadResponse,
};
