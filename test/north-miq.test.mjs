import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NorthApiError } from "../src/north-api.mjs";
import { isActionableMention, notificationKey, parseArgs, replyPayload, retryDelayMilliseconds, runCycle } from "../src/north-miq.mjs";

test("only a mention with a parent post is actionable", () => {
  assert.equal(isActionableMention({
    id: "n1",
    kind: "MENTION",
    tweet: { id: "t1", inReplyToId: "parent", author: { handle: "requester" } },
  }), true);
  assert.equal(isActionableMention({
    id: "n2",
    kind: "MENTION",
    tweet: { id: "t2", inReplyToId: null, author: { handle: "requester" } },
  }), false);
  assert.equal(isActionableMention({
    id: "n3",
    kind: "REPLY",
    tweet: { id: "t3", inReplyToId: "parent", author: { handle: "requester" } },
  }), false);
  assert.equal(isActionableMention({
    id: "n4",
    kind: "MENTION",
    tweet: { id: "t4", inReplyToId: "parent", author: { handle: "miq" } },
  }, "miq"), false);
});

test("reply payload addresses the requester and attaches the MIQ", () => {
  assert.deepEqual(replyPayload({ id: "mention-1", author: { handle: "requester" } }, "media-1"), {
    text: "@requester",
    replyPolicy: "EVERYONE",
    mediaIds: ["media-1"],
    inReplyToId: "mention-1",
  });
});

test("notification keys are stable and CLI defaults to dry-run", () => {
  assert.equal(notificationKey({ id: "notification-1" }), "notification-1");
  const args = parseArgs(["--once", "--process-existing"]);
  assert.equal(args.once, true);
  assert.equal(args.post, false);
});

test("retry delay backs off but stays bounded for transient failures", () => {
  assert.equal(retryDelayMilliseconds(30, 1), 30_000);
  assert.equal(retryDelayMilliseconds(30, 2), 60_000);
  assert.equal(retryDelayMilliseconds(30, 99), 300_000);
});

test("runCycle marks a missing parent as seen so it is not retried", async () => {
  const directory = await mkdtemp(join(tmpdir(), "north-miq-state-test-"));
  const statePath = join(directory, "state.json");
  const notification = {
    id: "notification-gone-parent",
    kind: "MENTION",
    tweet: { id: "mention-gone-parent", inReplyToId: "parent-gone", author: { handle: "requester" } },
  };
  const state = { initialized: true, seen: [] };
  const args = { post: false, processExisting: false, statePath };
  const client = {
    getNotifications: async () => ({ items: [notification], nextCursor: null }),
    getTweet: async () => {
      throw new NorthApiError("ポストがありません", { status: 404, code: "tweet_not_found" });
    },
  };

  try {
    await runCycle(client, state, args, "miq");
    assert.deepEqual(state.seen, [notification.id]);
    const saved = JSON.parse(await readFile(statePath, "utf8"));
    assert.deepEqual(saved.seen, [notification.id]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
