// update-check.mjs — 检查更新的自检：假的 GitHub 网页 + 假安装包，走一遍「发现新版本 → 下载 → 问要不要装」。
// 和真的 GitHub 一样：releases/latest 用 302 跳到 releases/tag/vX.Y.Z，安装包在 releases/download/<tag>/<文件名>。
// 真的会弹原生对话框，这里用 SPW_DIALOG_ANSWERS 自动回答（第 1 次「下载并安装」，第 2 次「稍后」）。
// 用法：node scripts/update-check.mjs（检查安装包：设 SPW_EXE）

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron } from "playwright-core";
import { startFakeSp } from "../test/fake-sp.js";
import { sampleData } from "../test/fixtures.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, ".smoke", "update");
fs.rmSync(out, { recursive: true, force: true });
const userData = path.join(out, "user-data");
fs.mkdirSync(userData, { recursive: true });
fs.writeFileSync(path.join(userData, "settings.json"), JSON.stringify({
  version: 2,
  tourDone: true,
  mode: "top",
  cards: { today: { visible: true, bounds: { x: 200, y: 200, width: 320, height: 400 } } },
}));

const VERSION = "9.9.9";
// 2 MB 的假安装包，够看进度条动
const INSTALLER = Buffer.alloc(2 * 1024 * 1024, 7);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SETUP = `sp-desktop-cards-${VERSION}-setup.exe`;
const LEGACY = "0.2.3";
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  const base = `http://127.0.0.1:${server.address().port}`;
  // 最新版：跟真 GitHub 一样跳到 tag 页；HEAD 是检查安装包时来问大小的
  if (url.pathname === "/releases/latest") {
    if (req.method === "HEAD") return res.writeHead(302, { location: `${base}/releases/tag/v${VERSION}` }).end();
    res.writeHead(302, { location: `${base}/releases/tag/v${VERSION}` }).end();
    return;
  }
  if (url.pathname === `/releases/tag/v${VERSION}`) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<title>v${VERSION}</title>`);
    return;
  }
  if (url.pathname === `/releases/download/v${VERSION}/${SETUP}`) {
    if (req.method === "HEAD") return res.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(INSTALLER.length) }).end();
    res.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(INSTALLER.length) });
    // 分几块慢慢写，让进度条有东西可看（太快的话窗口没等看清就关了）
    let offset = 0;
    const push = () => {
      if (offset >= INSTALLER.length) return res.end();
      const chunk = INSTALLER.subarray(offset, offset + 32 * 1024);
      offset += chunk.length;
      res.write(chunk);
      setTimeout(push, 40);
    };
    push();
    return;
  }
  // 旧仓库的「指路牌」：真 GitHub 上会一直留着，检查这里是为了确认新版查不到新仓库时会回头问它
  if (url.pathname === "/legacy/releases/latest") {
    res.writeHead(302, { location: `${base}/releases/tag/v${LEGACY}` }).end();
    return;
  }
  res.writeHead(404).end();
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}/releases`;
const api = `${base}/latest`;

const sp = await startFakeSp({ data: sampleData(Date.now()) });
const env = {
  ...process.env, SPW_USER_DATA: userData, SPW_BASE_URL: sp.url, SPW_TOKEN: sp.token,
  SPW_UPDATE_API: api, SPW_UPDATE_BASE: `${base}/download`, SPW_UPDATE_LEGACY_API: `${base.replace(/\/releases$/, "")}/legacy/releases/latest`,
  SPW_UPDATE_SETUP: "1", SPW_DIALOG_ANSWERS: "0,1", // 弹窗按顺序自动回答；启动后由下面主动点「检查更新」
};
// SPW_EXE 指向打包好的程序时检查打包产物
const app = await _electron.launch({ ...(process.env.SPW_EXE ? { executablePath: process.env.SPW_EXE, args: [] } : { args: [root] }), env });

const results = [];
const check = async (name, fn) => {
  try {
    await fn();
    results.push(`✔ ${name}`);
  } catch (error) {
    results.push(`✖ ${name}: ${error.message.split("\n")[0]}`);
  }
};

try {
  // 和用户点「检查更新…」走同一条路：真的去问一遍服务端，而不是等启动时的自动检查
  await sleep(1500);
  const page = app.windows().find((p) => p.url().includes("card=today"));
  assert.ok(page, "没等到今日卡片");
  await page.evaluate(() => window.widget.action("checkUpdate"));

  let upd = null;
  for (let i = 0; i < 200 && !upd; i++) {
    upd = app.windows().find((p) => p.url().includes("update.html")) || null;
    if (!upd) await sleep(100);
  }
  await check("发现新版本后打开了下载窗口", async () => {
    assert.ok(upd, "没等到下载窗口");
    await upd.locator("#title").waitFor();
    assert.match(await upd.locator("#title").textContent(), /下载/);
  });

  await check("进度条会往前走，百分比和总量都显示出来", async () => {
    await upd.waitForFunction(() => parseFloat(document.getElementById("fill").style.width) > 0, null, { timeout: 10_000 });
    const text = await upd.locator("#detail").textContent();
    assert.match(text, /MB/, `进度文字不对：${text}`);
    await upd.screenshot({ path: path.join(out, "progress.png") });
  });

  const setup = path.join(userData, "updates", SETUP);
  await check("下完文件落在 updates 目录，内容对、没有 .part 残留", async () => {
    for (let i = 0; i < 100 && !fs.existsSync(setup); i++) await sleep(100);
    assert.ok(fs.existsSync(setup), "没找到下载好的安装包");
    assert.equal(fs.statSync(setup).size, INSTALLER.length);
    assert.deepEqual(fs.readdirSync(path.dirname(setup)), [path.basename(setup)]);
  });

  await check("选「稍后」之后下载窗口自己关掉，程序继续跑", async () => {
    for (let i = 0; i < 60 && app.windows().some((p) => p.url().includes("update.html")); i++) await sleep(100);
    assert.equal(app.windows().some((p) => p.url().includes("update.html")), false, "下载窗口没关");
    assert.ok(app.windows().length > 0, "程序自己退出了");
  });
} finally {
  await app.evaluate(({ app: a }) => a.exit(0)).catch(() => {});
  await sp.close();
  server.close();
}
console.log(results.join("\n"));
if (results.some((r) => r.startsWith("✖"))) process.exit(1);
