import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createNorthClient, NorthApiError } from "./north-api.mjs";
import { renderMiqPng } from "./miq-image.mjs";

const BOT_HANDLE = process.env.NORTH_BOT_HANDLE ?? "make_it_a_quote";
const DEFAULT_INTERVAL_SECONDS = 30;
const MAX_NOTIFICATION_PAGES = 5;
const MAX_SEEN_IDS = 500;

function usage() {
  return `Usage:
  node src/north-miq.mjs --once --process-existing
  node src/north-miq.mjs --once --process-existing --post --confirm-public
  node src/north-miq.mjs --interval 30 --post --confirm-public

Options:
  --once              1回だけ確認して終了
  --process-existing  初回起動時に既存のメンションも処理対象にする
  --post              MIQ画像をnorthへ投稿する（既定はドライラン）
  --confirm-public    --postと併用した場合のみ公開投稿を許可
  --interval <sec>    監視間隔（既定: ${DEFAULT_INTERVAL_SECONDS}秒）
  --state <path>      状態ファイル（既定: data/north-miq-state.json）
  --help              このヘルプを表示

Authentication:
  NORTH_SESSION_COOKIE または NORTH_SESSION_COOKIE_FILE をローカルで設定してください。
  Cookieはログに出力・保存しません。Chromeのログイン状態は自動取得しません。`;
}

function parseArgs(argv) {
  const args = {
    once: false,
    processExisting: false,
    post: false,
    confirmPublic: false,
    intervalSeconds: DEFAULT_INTERVAL_SECONDS,
    statePath: process.env.NORTH_MIQ_STATE_FILE ?? "data/north-miq-state.json",
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg === "--once") args.once = true;
    else if (arg === "--process-existing") args.processExisting = true;
    else if (arg === "--post") args.post = true;
    else if (arg === "--confirm-public") args.confirmPublic = true;
    else if (arg === "--interval") args.intervalSeconds = Number(argv[++index]);
    else if (arg === "--state") args.statePath = argv[++index] ?? args.statePath;
    else throw new Error(`不明なオプションです: ${arg}`);
  }
  if (!Number.isFinite(args.intervalSeconds) || args.intervalSeconds < 15) {
    throw new Error("--intervalは15秒以上で指定してください。");
  }
  if (args.post && !args.confirmPublic) {
    throw new Error("公開投稿には --post --confirm-public の両方が必要です。");
  }
  if (!args.once && !args.post) {
    // Continuous dry-run is useful for observing the account without posting.
  }
  return args;
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

async function loadState(statePath) {
  try {
    const parsed = JSON.parse(await readFile(statePath, "utf8"));
    return {
      initialized: parsed?.initialized === true,
      seen: Array.isArray(parsed?.seen) ? parsed.seen.filter((id) => typeof id === "string").slice(-MAX_SEEN_IDS) : [],
    };
  } catch (error) {
    if (error?.code === "ENOENT") return { initialized: false, seen: [] };
    throw new Error(`状態ファイルを読み込めません: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function saveState(statePath, state) {
  const absolutePath = resolve(statePath);
  await mkdir(dirname(absolutePath), { recursive: true });
  const temporaryPath = `${absolutePath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, JSON.stringify({
    initialized: state.initialized === true,
    seen: state.seen.slice(-MAX_SEEN_IDS),
  }, null, 2), "utf8");
  await rename(temporaryPath, absolutePath);
}

function notificationKey(notification) {
  return String(notification?.id ?? `${notification?.kind ?? "unknown"}:${notification?.tweet?.id ?? "unknown"}`);
}

function isActionableMention(notification) {
  const tweet = notification?.tweet;
  return notification?.kind === "MENTION"
    && Boolean(tweet?.id)
    && Boolean(tweet?.inReplyToId)
    && tweet?.author?.handle !== BOT_HANDLE;
}

function parentSourceUrl(client, parent) {
  return `${client.origin}/${parent.author?.handle ?? "unknown"}/status/${parent.id}`;
}

function replyPayload(mentionTweet, mediaId) {
  const requester = String(mentionTweet?.author?.handle ?? "").replace(/^@/u, "");
  const text = /^[A-Za-z0-9_]{1,15}$/u.test(requester) ? `@${requester}` : "MIQ";
  return {
    text,
    replyPolicy: "EVERYONE",
    mediaIds: [mediaId],
    inReplyToId: mentionTweet.id,
  };
}

async function fetchRecentNotifications(client) {
  const items = [];
  let cursor = null;
  for (let page = 0; page < MAX_NOTIFICATION_PAGES; page += 1) {
    const response = await client.getNotifications({ tab: "mentions", cursor });
    if (Array.isArray(response?.items)) items.push(...response.items);
    if (!response?.nextCursor || !Array.isArray(response?.items) || response.items.length === 0) break;
    cursor = response.nextCursor;
  }
  return items;
}

async function writePreview(png, parentId) {
  const directory = resolve(process.env.NORTH_MIQ_PREVIEW_DIR ?? "data/miq-previews");
  await mkdir(directory, { recursive: true });
  const path = resolve(directory, `miq-${parentId}.png`);
  await writeFile(path, png);
  return path;
}

async function processNotification(client, notification, args) {
  const mentionTweet = notification.tweet;
  if (!isActionableMention(notification)) {
    return { status: "skipped", reason: "メンションへの返信元ポストがありません" };
  }

  const parent = await client.getTweet(mentionTweet.inReplyToId);
  if (!parent || parent.deleted || parent.unavailable) {
    return { status: "skipped", reason: "親ポストが削除済みまたは表示不可です" };
  }

  let avatarBuffer = null;
  if (parent.author?.avatarUrl) {
    try {
      avatarBuffer = await client.fetchNorthImage(parent.author.avatarUrl);
    } catch (error) {
      console.warn(`[north-miq] アイコン取得をスキップ: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const sourceUrl = parentSourceUrl(client, parent);
  const rendered = await renderMiqPng({
    text: parent.text ?? "",
    displayName: parent.author?.name ?? parent.author?.handle ?? "unknown",
    handle: parent.author?.handle ?? "unknown",
    avatarBuffer,
    sourceUrl,
  });
  const previewPath = await writePreview(rendered.png, parent.id);

  if (!args.post) {
    return {
      status: "dry-run",
      mentionId: mentionTweet.id,
      parentId: parent.id,
      parentAuthor: parent.author?.handle ?? null,
      previewPath,
      mediaCount: Array.isArray(parent.media) ? parent.media.length : 0,
    };
  }

  const media = await client.uploadMedia(rendered.png, `miq-${parent.id}.png`);
  if (!media?.id) throw new Error("northがアップロード画像IDを返しませんでした。");
  const created = await client.createTweet(replyPayload(mentionTweet, media.id));
  return {
    status: "posted",
    mentionId: mentionTweet.id,
    parentId: parent.id,
    parentAuthor: parent.author?.handle ?? null,
    createdId: created?.id ?? null,
    previewPath,
  };
}

async function runCycle(client, state, args) {
  const notifications = await fetchRecentNotifications(client);
  if (!state.initialized && !args.processExisting) {
    state.seen = notifications.map(notificationKey).slice(-MAX_SEEN_IDS);
    state.initialized = true;
    await saveState(args.statePath, state);
    console.log(`[north-miq] 初回基準点を保存しました（${notifications.length}件）。投稿は行っていません。`);
    return;
  }

  const seen = new Set(state.seen);
  const pending = [...notifications].reverse().filter((notification) => !seen.has(notificationKey(notification)));
  if (pending.length === 0) {
    console.log("[north-miq] 新しいメンションはありません。");
    state.initialized = true;
    await saveState(args.statePath, state);
    return;
  }

  for (const notification of pending) {
    const key = notificationKey(notification);
    try {
      const result = await processNotification(client, notification, args);
      console.log(`[north-miq] ${JSON.stringify(result)}`);
      state.initialized = true;
      if (args.post) {
        state.seen.push(key);
        state.seen = state.seen.slice(-MAX_SEEN_IDS);
      }
      await saveState(args.statePath, state);
    } catch (error) {
      console.error(`[north-miq] 通知 ${key} の処理に失敗しました: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

function sleep(milliseconds) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }
  const sessionCookie = await readSessionCookie();
  if (!sessionCookie) {
    throw new NorthApiError("NORTH_SESSION_COOKIE または NORTH_SESSION_COOKIE_FILE が必要です。Chromeのログイン状態は自動取得しません。", {
      code: "missing_session",
    });
  }
  const client = createNorthClient({ sessionCookie });
  const state = await loadState(args.statePath);

  do {
    await runCycle(client, state, args);
    if (args.once) break;
    await sleep(args.intervalSeconds * 1000);
  } while (true);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    console.error(`[north-miq] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

export {
  fetchRecentNotifications,
  isActionableMention,
  loadState,
  notificationKey,
  parseArgs,
  processNotification,
  replyPayload,
  saveState,
};
