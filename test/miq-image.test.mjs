import test from "node:test";
import assert from "node:assert/strict";
import { cleanText, normalizeHandle, renderMiqPng } from "../src/miq-image.mjs";

test("MIQ input is normalized without changing ordinary Japanese text", () => {
  assert.equal(cleanText("\u0000本文\r\nテスト"), "本文\nテスト");
  assert.equal(normalizeHandle("@writer"), "writer");
});

test("renderMiqPng uses the classic Make it a Quote renderer", async () => {
  const result = await renderMiqPng({
    text: "PoC引用テスト",
    displayName: "テスト投稿者",
    handle: "writer",
    sourceUrl: "https://north.rip/writer/status/1",
  });
  assert.ok(Buffer.isBuffer(result.png));
  assert.equal(result.width, 1200);
  assert.equal(result.height, 630);
  assert.deepEqual([...result.png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
});
