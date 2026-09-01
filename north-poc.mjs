#!/usr/bin/env node

const ORIGIN = "https://north.rip";
const USER_AGENT = "north-miQ-poc/0.1 (dry-run by default)";
const REQUEST_TIMEOUT_MS = 15_000;

function usage() {
  return `Usage:
  node north-poc.mjs <north-status-url> --text "引用コメント"

Options:
  --post             実際に引用投稿する（既定はドライラン）
  --confirm-public   --post と併用した場合のみ公開投稿を許可
  --help             このヘルプを表示

For --post, set NORTH_SESSION_COOKIE in the local environment.
The value is never printed or stored by this script.`;
}

function die(message) {
  console.error(`[north-poc] ${message}`);
  process.exitCode = 1;
}

function parseArgs(argv) {
  const args = {
    statusUrl: null,
    text: null,
    post: false,
    confirmPublic: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      args.help = true;
      continue;
    }
    if (arg === "--post") {
      args.post = true;
      continue;
    }
    if (arg === "--confirm-public") {
      args.confirmPublic = true;
      continue;
    }
    if (arg === "--text") {
      args.text = argv[index + 1] ?? null;
      index += 1;
      continue;
    }
    if (arg.startsWith("--")) {
      throw new Error(`不明なオプションです: ${arg}`);
    }
    if (args.statusUrl === null) {
      args.statusUrl = arg;
      continue;
    }
    throw new Error(`余分な引数です: ${arg}`);
  }

  return args;
}

function parseStatusUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("northのポストURLとして解釈できません。");
  }

  if (url.protocol !== "https:" || !["north.rip", "www.north.rip"].includes(url.hostname)) {
    throw new Error("https://north.rip のポストURLだけを指定してください。");
  }

  const match = url.pathname.match(/^\/([A-Za-z0-9_]{1,15})\/status\/(\d+)\/?$/);
  if (!match) {
    throw new Error("URL形式は https://north.rip/<handle>/status/<id> です。");
  }

  return { handle: match[1], id: match[2] };
}

async function requestJson(path, options = {}) {
  const response = await fetch(`${ORIGIN}${path}`, {
    ...options,
    headers: {
      accept: "application/json",
      "user-agent": USER_AGENT,
      ...options.headers,
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  const raw = await response.text();
  let body = null;
  try {
    body = raw ? JSON.parse(raw) : null;
  } catch {
    if (response.ok) {
      throw new Error(`northからJSONではない応答が返りました（HTTP ${response.status}）。`);
    }
  }

  if (!response.ok) {
    const code = body?.error ?? "unknown";
    const message = body?.message ?? `HTTP ${response.status}`;
    throw new Error(`${code}: ${message}`);
  }

  return { body, response };
}

function buildQuotePayload(text, quotedId) {
  return {
    text,
    replyPolicy: "EVERYONE",
    mediaIds: [],
    quotedId,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }
  if (!args.statusUrl) {
    throw new Error(`ポストURLが必要です。\n\n${usage()}`);
  }
  if (!args.text || !args.text.trim()) {
    throw new Error("--text で引用コメントを指定してください。");
  }
  if (args.post && !args.confirmPublic) {
    throw new Error("公開投稿を実行するには --post --confirm-public を併用してください。");
  }

  const target = parseStatusUrl(args.statusUrl);
  const { body: tweet } = await requestJson(`/api/tweets/${tweetId(target.id)}`);
  if (!tweet || tweet.unavailable || tweet.deleted) {
    throw new Error("対象ポストは引用できない状態です。");
  }

  const payload = buildQuotePayload(args.text.trim(), tweet.id);
  const preview = {
    mode: args.post ? "post" : "dry-run",
    target: {
      id: tweet.id,
      url: `${ORIGIN}/${tweet.author?.handle ?? target.handle}/status/${tweet.id}`,
      author: tweet.author?.handle ?? target.handle,
      createdAt: tweet.createdAt ?? null,
      sourceTextLength: typeof tweet.text === "string" ? [...tweet.text].length : null,
      mediaCount: Array.isArray(tweet.media) ? tweet.media.length : 0,
    },
    request: {
      method: "POST",
      path: "/api/tweets",
      body: payload,
    },
  };

  if (!args.post) {
    console.log(JSON.stringify(preview, null, 2));
    console.log("[north-poc] ドライラン完了。投稿リクエストは送信していません。");
    return;
  }

  const sessionCookie = process.env.NORTH_SESSION_COOKIE;
  if (!sessionCookie) {
    throw new Error("--post にはローカル環境変数 NORTH_SESSION_COOKIE が必要です。Cookie値をチャットへ貼らないでください。");
  }

  const { body: created } = await requestJson("/api/tweets", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: sessionCookie,
    },
    body: JSON.stringify(payload),
  });

  console.log(JSON.stringify({
    mode: "posted",
    created: {
      id: created?.id ?? null,
      url: created?.id && created?.author?.handle
        ? `${ORIGIN}/${created.author.handle}/status/${created.id}`
        : null,
    },
  }, null, 2));
}

function tweetId(id) {
  if (!/^\d+$/.test(id)) {
    throw new Error("ポストIDが不正です。");
  }
  return id;
}

try {
  await main();
} catch (error) {
  die(error instanceof Error ? error.message : String(error));
}
