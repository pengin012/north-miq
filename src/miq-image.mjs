import { MiQ } from "makeitaquote";

const WIDTH = 1200;
const HEIGHT = 630;

function cleanText(value) {
  return String(value ?? "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu, "")
    .replace(/\r\n?/gu, "\n")
    .trim();
}

function normalizeHandle(value) {
  return cleanText(value).replace(/^@/u, "") || "unknown";
}

async function renderMiqPng({
  text,
  displayName,
  handle,
  avatarBuffer = null,
  sourceUrl = "",
}) {
  const username = normalizeHandle(handle);
  const name = cleanText(displayName) || username;
  const quoteText = cleanText(text) || "（本文なし）";
  const builder = new MiQ()
    .setTheme({ extends: "dark", avatar: { grayscale: false } })
    .setText(quoteText)
    .setUsername(username)
    .setDisplayName(name)
    .setAvatar(Buffer.isBuffer(avatarBuffer) ? avatarBuffer : null);
  const png = await builder.toBuffer("png");
  return {
    png,
    width: WIDTH,
    height: HEIGHT,
    sourceUrl,
  };
}

export {
  HEIGHT,
  WIDTH,
  cleanText,
  normalizeHandle,
  renderMiqPng,
};
