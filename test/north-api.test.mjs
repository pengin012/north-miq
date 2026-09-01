import test from "node:test";
import assert from "node:assert/strict";
import { createNorthClient, NorthApiError } from "../src/north-api.mjs";

function response(status, body, headers = {}) {
  return new Response(body === null ? "" : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

test("notification polling uses the mentions tab and session cookie", async () => {
  let seenUrl = "";
  let seenHeaders;
  const client = createNorthClient({
    origin: "https://north.rip",
    sessionCookie: "fixture_cookie=ok",
    fetchImpl: async (url, options) => {
      seenUrl = String(url);
      seenHeaders = options.headers;
      return response(200, { items: [], nextCursor: null });
    },
  });
  await client.getNotifications({ tab: "mentions" });
  assert.equal(seenUrl, "https://north.rip/api/notifications?tab=mentions");
  assert.equal(seenHeaders.cookie, "fixture_cookie=ok");
});

test("getMe uses the authenticated session", async () => {
  let seenPath = "";
  const client = createNorthClient({
    sessionCookie: "fixture_cookie=ok",
    fetchImpl: async (url) => {
      seenPath = new URL(url).pathname;
      return response(200, { user: { handle: "miq" } });
    },
  });
  const me = await client.getMe();
  assert.equal(seenPath, "/api/auth/me");
  assert.equal(me.user.handle, "miq");
});

test("createTweet requires a session", async () => {
  const client = createNorthClient({ fetchImpl: async () => response(200, {}) });
  await assert.rejects(
    client.createTweet({ text: "x", replyPolicy: "EVERYONE", mediaIds: [] }),
    (error) => error instanceof NorthApiError && error.code === "missing_session",
  );
});

test("avatar fetch rejects non-north origins", async () => {
  const client = createNorthClient({ fetchImpl: async () => response(200, {}) });
  await assert.rejects(
    client.fetchNorthImage("https://example.com/avatar.png"),
    (error) => error instanceof NorthApiError && error.code === "external_avatar_url",
  );
});
