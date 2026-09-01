import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NorthApiError } from "../src/north-api.mjs";
import { processNotification } from "../src/north-miq.mjs";

test("a mention is converted into an image reply without calling north in dry-run", async () => {
  const previewDirectory = await mkdtemp(join(tmpdir(), "north-miq-test-"));
  const previousPreviewDirectory = process.env.NORTH_MIQ_PREVIEW_DIR;
  process.env.NORTH_MIQ_PREVIEW_DIR = previewDirectory;
  const calls = [];
  const parent = {
    id: "parent-1",
    text: "親ポストの本文",
    author: { id: "author-1", handle: "writer", name: "投稿者", avatarUrl: "/media/avatar.png" },
    media: [],
    deleted: false,
    unavailable: false,
  };
  const notification = {
    id: "notification-1",
    kind: "MENTION",
    tweet: { id: "mention-1", inReplyToId: parent.id, author: { handle: "requester" } },
  };
  const client = {
    origin: "https://north.rip",
    getTweet: async (id) => {
      calls.push(["getTweet", id]);
      return parent;
    },
    fetchNorthImage: async (url) => {
      calls.push(["fetchNorthImage", url]);
      return null;
    },
    uploadMedia: async () => {
      calls.push(["uploadMedia"]);
      return { id: "media-1" };
    },
    createTweet: async () => {
      calls.push(["createTweet"]);
      return { id: "created-1" };
    },
  };

  try {
    const result = await processNotification(client, notification, { post: false });
    assert.equal(result.status, "dry-run");
    assert.equal(result.parentId, parent.id);
    assert.equal(result.parentAuthor, "writer");
    assert.deepEqual(calls, [
      ["getTweet", parent.id],
      ["fetchNorthImage", "/media/avatar.png"],
    ]);
  } finally {
    if (previousPreviewDirectory === undefined) delete process.env.NORTH_MIQ_PREVIEW_DIR;
    else process.env.NORTH_MIQ_PREVIEW_DIR = previousPreviewDirectory;
    await rm(previewDirectory, { recursive: true, force: true });
  }
});

test("a missing north avatar falls back without logging an icon error", async () => {
  const previewDirectory = await mkdtemp(join(tmpdir(), "north-miq-test-"));
  const previousPreviewDirectory = process.env.NORTH_MIQ_PREVIEW_DIR;
  process.env.NORTH_MIQ_PREVIEW_DIR = previewDirectory;
  const parent = {
    id: "parent-missing-avatar",
    text: "本文",
    author: { handle: "writer", name: "投稿者", avatarUrl: "/media/missing.png" },
    media: [],
    deleted: false,
    unavailable: false,
  };
  const notification = {
    id: "notification-missing-avatar",
    kind: "MENTION",
    tweet: { id: "mention-missing-avatar", inReplyToId: parent.id, author: { handle: "requester" } },
  };
  const client = {
    origin: "https://north.rip",
    getTweet: async () => parent,
    fetchNorthImage: async () => {
      throw new NorthApiError("not found", { status: 404, code: "avatar_http_error" });
    },
  };

  try {
    const result = await processNotification(client, notification, { post: false });
    assert.equal(result.status, "dry-run");
    assert.equal(result.avatarStatus, "not_found");
  } finally {
    if (previousPreviewDirectory === undefined) delete process.env.NORTH_MIQ_PREVIEW_DIR;
    else process.env.NORTH_MIQ_PREVIEW_DIR = previousPreviewDirectory;
    await rm(previewDirectory, { recursive: true, force: true });
  }
});

test("a live-mode mention uploads the MIQ and replies to the mention", async () => {
  const previewDirectory = await mkdtemp(join(tmpdir(), "north-miq-test-"));
  const previousPreviewDirectory = process.env.NORTH_MIQ_PREVIEW_DIR;
  process.env.NORTH_MIQ_PREVIEW_DIR = previewDirectory;
  const calls = [];
  const parent = {
    id: "parent-2",
    text: "本文",
    author: { handle: "writer", name: "投稿者", avatarUrl: null },
    media: [],
    deleted: false,
    unavailable: false,
  };
  const notification = {
    id: "notification-2",
    kind: "MENTION",
    tweet: { id: "mention-2", inReplyToId: parent.id, author: { handle: "requester" } },
  };
  const client = {
    origin: "https://north.rip",
    getTweet: async () => parent,
    fetchNorthImage: async () => null,
    uploadMedia: async (png, filename) => {
      calls.push(["uploadMedia", png.length > 0, filename]);
      return { id: "media-2" };
    },
    createTweet: async (payload) => {
      calls.push(["createTweet", payload]);
      return { id: "created-2" };
    },
  };

  try {
    const result = await processNotification(client, notification, { post: true });
    assert.equal(result.status, "posted");
    assert.equal(result.createdId, "created-2");
    assert.deepEqual(calls[0], ["uploadMedia", true, "miq-parent-2.png"]);
    assert.deepEqual(calls[1], ["createTweet", {
      text: "@requester",
      replyPolicy: "EVERYONE",
      mediaIds: ["media-2"],
      inReplyToId: "mention-2",
    }]);
  } finally {
    if (previousPreviewDirectory === undefined) delete process.env.NORTH_MIQ_PREVIEW_DIR;
    else process.env.NORTH_MIQ_PREVIEW_DIR = previousPreviewDirectory;
    await rm(previewDirectory, { recursive: true, force: true });
  }
});
