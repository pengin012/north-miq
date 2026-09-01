import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { chromium } from "playwright";

const ORIGIN = process.env.NORTH_ORIGIN ?? "https://north.rip";
const EXPECTED_HANDLE = (process.env.NORTH_BOT_HANDLE ?? "miq").replace(/^@/u, "");
const PROFILE_DIR = resolve(process.env.NORTH_BROWSER_PROFILE_DIR ?? "data/north-browser-profile");
const SESSION_FILE = resolve(process.env.NORTH_SESSION_COOKIE_FILE ?? "data/north-session.cookie");
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(`Usage:
  npm.cmd run session:setup

Opens a separate Chrome profile for the north Bot account, waits for a manual
login, and stores the session locally in data/north-session.cookie.`);
  process.exit(0);
}

function sleep(milliseconds) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

function getLoggedInHandle(me) {
  return me?.user?.handle ?? me?.handle ?? null;
}

const context = await chromium.launchPersistentContext(PROFILE_DIR, {
  channel: "chrome",
  headless: false,
});

try {
  const page = context.pages()[0] ?? await context.newPage();
  await page.goto(`${ORIGIN}/login`, { waitUntil: "domcontentloaded" });
  console.log("northのログイン画面を開きました。");
  console.log(`Bot用アカウント @${EXPECTED_HANDLE} で手動ログインしてください。Turnstileもこの画面で完了してください。`);

  const deadline = Date.now() + LOGIN_TIMEOUT_MS;
  let me = null;
  while (Date.now() < deadline) {
    try {
      const response = await context.request.get(`${ORIGIN}/api/auth/me`, {
        headers: { accept: "application/json" },
      });
      if (response.status() === 200) {
        me = await response.json();
        const handle = getLoggedInHandle(me);
        if (handle === EXPECTED_HANDLE) break;
        if (handle) throw new Error(`ログイン中のアカウントが @${handle} です。@${EXPECTED_HANDLE} でログインしてください。`);
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("ログイン中のアカウント")) throw error;
    }
    await sleep(1000);
  }

  if (!me || getLoggedInHandle(me) !== EXPECTED_HANDLE) {
    throw new Error("ログインを確認できませんでした（10分でタイムアウト）。");
  }

  const cookies = await context.cookies(ORIGIN);
  const cookieHeader = cookies.map(({ name, value }) => `${name}=${value}`).join("; ");
  if (!cookieHeader) throw new Error("northのログインCookieを取得できませんでした。");
  await mkdir(dirname(SESSION_FILE), { recursive: true });
  await writeFile(SESSION_FILE, `${cookieHeader}\n`, { encoding: "utf8", mode: 0o600 });
  console.log(`@${EXPECTED_HANDLE} のログインを確認しました。ローカルセッションを保存しました: ${SESSION_FILE}`);
  console.log("Cookieの値は表示していません。以後は npm.cmd run miq -- --once でドライランできます。");
} finally {
  await context.close();
}
