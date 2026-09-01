import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MentionWatcher, UpstreamLimiter, createGateway } from "../src/north-gateway.mjs";

const sampleTweet = {
  id: "1234567890123456789",
  text: "hello north",
  createdAt: "2026-09-01T00:00:00.000Z",
  author: { id: "user-1", handle: "writer", name: "Writer", avatarUrl: "/media/avatar.png" },
  media: [],
  likeCount: 2,
  retweetCount: 3,
  replyCount: 4,
  quoteCount: 5,
  inReplyToId: null,
  quoted: null,
  retweetOf: null,
};

async function openGateway(overrides = {}) {
  const calls = new Map();
  const client = {
    origin: "https://north.rip",
    hasSession: true,
    getHealth: async () => ({ ok: true, service: "north-api", version: "test" }),
    getMe: async () => ({ user: { handle: "miq" } }),
    getUnreadCount: async () => ({ count: 0 }),
    getNotifications: async () => ({ items: [], nextCursor: null }),
    getTweet: async (id) => {
      calls.set(`tweet:${id}`, (calls.get(`tweet:${id}`) ?? 0) + 1);
      return { ...sampleTweet, id };
    },
    getConversation: async (id) => ({ ancestors: [], tweet: { ...sampleTweet, id }, replies: [], nextCursor: null }),
    getReplies: async (id) => ({ items: [{ ...sampleTweet, id: `${id}1` }], nextCursor: null }),
    getQuotes: async () => ({ items: [], nextCursor: null }),
    getLikes: async () => ({ items: [{ id: "user-2", handle: "liker", name: "Liker" }], nextCursor: null }),
    getRetweets: async () => ({ items: [{ id: "user-3", handle: "reposter", name: "Reposter" }], nextCursor: null }),
    search: async () => ({ items: [{ ...sampleTweet }], nextCursor: "next" }),
    suggest: async () => ({ users: [{ id: "user-4", handle: "suggested", name: "Suggested" }], hashtags: ["north"] }),
    getTrends: async () => ({ items: [{ tag: "north", count: 3, isHashtag: true }] }),
    getUser: async (handle) => ({ ...sampleTweet.author, handle }),
    getUserTweets: async () => ({ items: [{ ...sampleTweet }], nextCursor: null }),
    getUserFollowers: async () => ({ items: [{ id: "user-5", handle: "follower", name: "Follower" }], nextCursor: null }),
    getUserFollowing: async () => ({ items: [{ id: "user-6", handle: "following", name: "Following" }], nextCursor: null }),
    uploadMedia: async () => ({ id: "media-1" }),
    createQuote: async () => ({ ...sampleTweet, id: "created-1" }),
    ...overrides.client,
  };
  const gateway = createGateway({ client, token: overrides.token ?? null, allowWrites: overrides.allowWrites ?? false });
  await new Promise((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  const address = gateway.server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return { gateway, baseUrl, calls };
}

async function closeGateway(gateway) {
  gateway.stop();
  await new Promise((resolve) => gateway.server.close(resolve));
}

test("gateway exposes FxTwitter-style status and user responses", async () => {
  const { gateway, baseUrl } = await openGateway();
  try {
    const statusResponse = await fetch(`${baseUrl}/2/status/1234567890123456789`);
    const status = await statusResponse.json();
    assert.equal(statusResponse.status, 200);
    assert.equal(status.code, 200);
    assert.equal(status.status.type, "status");
    assert.equal(status.status.author.screen_name, "writer");

    const userResponse = await fetch(`${baseUrl}/2/user/writer`);
    const user = await userResponse.json();
    assert.equal(userResponse.status, 200);
    assert.equal(user.user.username, "writer");
  } finally {
    await closeGateway(gateway);
  }
});

test("public reads work without a north session", async () => {
  const { gateway, baseUrl } = await openGateway({ client: { hasSession: false } });
  try {
    const healthResponse = await fetch(`${baseUrl}/health`);
    const health = await healthResponse.json();
    assert.equal(healthResponse.status, 200);
    assert.equal(health.auth, false);
    assert.equal(health.events.mentions, false);

    const statusResponse = await fetch(`${baseUrl}/2/status/1234567890123456789`);
    assert.equal(statusResponse.status, 200);
    const mentionsResponse = await fetch(`${baseUrl}/2/notifications/mentions`);
    assert.equal(mentionsResponse.status, 401);
  } finally {
    await closeGateway(gateway);
  }
});

test("gateway exposes list, search, typeahead, trends, and oEmbed routes", async () => {
  const { gateway, baseUrl } = await openGateway();
  try {
    const routes = [
      ["/2/status/1234567890123456789/replies", "results"],
      ["/writer/status/1234567890123456789", "status"],
      ["/2/status/1234567890123456789/reposts", "users"],
      ["/2/status/1234567890123456789/conversation", "thread"],
      ["/2/thread/1234567890123456789", "thread"],
      ["/2/profile/writer", "user"],
      ["/2/profile/writer/statuses", "results"],
      ["/2/profile/writer/media", "results"],
      ["/2/profile/writer/followers", "users"],
      ["/2/profile/writer/following", "users"],
      ["/2/status/1234567890123456789/likes", "users"],
      ["/2/search?q=north", "results"],
      ["/2/typeahead?q=n", "users"],
      ["/2/trends", "trends"],
      ["/oembed?url=https%3A%2F%2Fnorth.rip%2Fwriter%2Fstatus%2F1234567890123456789", "html"],
    ];
    for (const [path, key] of routes) {
      const response = await fetch(`${baseUrl}${path}`);
      const body = await response.json();
      assert.equal(response.status, 200, path);
      assert.ok(Object.hasOwn(body, key), `${path} should contain ${key}`);
    }
  } finally {
    await closeGateway(gateway);
  }
});

test("gateway coalesces identical status reads", async () => {
  const { gateway, baseUrl, calls } = await openGateway();
  try {
    const responses = await Promise.all([
      fetch(`${baseUrl}/2/status/1234567890123456789`),
      fetch(`${baseUrl}/2/status/1234567890123456789`),
      fetch(`${baseUrl}/2/status/1234567890123456789`),
    ]);
    assert.deepEqual(responses.map((response) => response.status), [200, 200, 200]);
    assert.equal(calls.get("tweet:1234567890123456789"), 1);
  } finally {
    await closeGateway(gateway);
  }
});

test("gateway token protects routes when configured", async () => {
  const { gateway, baseUrl } = await openGateway({ token: "local-test-token" });
  try {
    const denied = await fetch(`${baseUrl}/2/status/1234567890123456789`);
    assert.equal(denied.status, 401);
    const allowed = await fetch(`${baseUrl}/2/status/1234567890123456789`, { headers: { authorization: "Bearer local-test-token" } });
    assert.equal(allowed.status, 200);
  } finally {
    await closeGateway(gateway);
  }
});

test("gateway keeps write routes disabled by default", async () => {
  const { gateway, baseUrl } = await openGateway();
  try {
    const response = await fetch(`${baseUrl}/v1/quotes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "x", quotedId: sampleTweet.id }),
    });
    const body = await response.json();
    assert.equal(response.status, 403);
    assert.equal(body.error, "writes_disabled");
  } finally {
    await closeGateway(gateway);
  }
});

test("mention watcher avoids refetching the full page while unread count is unchanged", async () => {
  const directory = await mkdtemp(join(tmpdir(), "north-gateway-state-test-"));
  let unreadCalls = 0;
  let notificationCalls = 0;
  const events = [];
  const watcher = new MentionWatcher({
    stateFile: join(directory, "state.json"),
    pollMs: 5_000,
    notificationRefreshMs: 30_000,
    client: {
      getUnreadCount: async () => {
        unreadCalls += 1;
        return { count: 1 };
      },
      getNotifications: async () => {
        notificationCalls += 1;
        return { items: [{ id: "notification-1" }], nextCursor: null };
      },
    },
    emit: async (notification) => events.push(notification.id),
  });
  try {
    await watcher.poll();
    await watcher.poll();
    assert.equal(unreadCalls, 2);
    assert.equal(notificationCalls, 1);
    assert.deepEqual(events, []);
  } finally {
    watcher.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("mention SSE emits a normalized event from a replayable notification", async () => {
  const directory = await mkdtemp(join(tmpdir(), "north-gateway-sse-test-"));
  const notification = {
    id: "notification-sse-1",
    kind: "MENTION",
    createdAt: "2026-09-01T00:00:00.000Z",
    actors: [sampleTweet.author],
    tweet: { ...sampleTweet, id: "mention-sse-1", inReplyToId: "parent-sse-1" },
  };
  const client = {
    origin: "https://north.rip",
    hasSession: true,
    getUnreadCount: async () => ({ count: 1 }),
    getNotifications: async () => ({ items: [notification], nextCursor: null }),
  };
  const gateway = createGateway({
    client,
    replayExisting: true,
    stateFile: join(directory, "state.json"),
    pollMs: 60_000,
  });
  await new Promise((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  const address = gateway.server.address();
  const controller = new AbortController();
  let reader;
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/events/mentions`, { signal: controller.signal });
    assert.equal(response.status, 200);
    reader = response.body.getReader();
    const decoder = new TextDecoder();
    let stream = "";
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline && !stream.includes("event: mention")) {
      const result = await Promise.race([
        reader.read(),
        new Promise((resolve) => setTimeout(() => resolve({ done: true, value: undefined }), 250)),
      ]);
      if (result.done) break;
      stream += decoder.decode(result.value, { stream: true });
    }
    assert.match(stream, /event: ready/u);
    assert.match(stream, /event: mention/u);
    assert.match(stream, /notification-sse-1/u);
  } finally {
    controller.abort();
    await reader?.cancel().catch(() => undefined);
    await closeGateway(gateway);
    await rm(directory, { recursive: true, force: true });
  }
});

test("upstream limiter rejects excess queued work instead of growing without bound", async () => {
  let release;
  const blocker = new Promise((resolve) => { release = resolve; });
  const limiter = new UpstreamLimiter({ concurrency: 1, minIntervalMs: 0, maxQueue: 1 });
  const first = limiter.run(async () => {
    await blocker;
    return "first";
  });
  const second = limiter.run(async () => "second");
  await assert.rejects(
    limiter.run(async () => "third"),
    (error) => error.code === "gateway_overloaded" && error.status === 503,
  );
  release();
  assert.equal(await first, "first");
  assert.equal(await second, "second");
});
