// update-check.mjs — 检查更新的自检：假的 GitHub 网页 + 假安装包，走一遍「发现新版本 → 下载 → 问要不要装」。
// 和真的 GitHub 一样：releases/latest 用 302 跳到 releases/tag/vX.Y.Z，安装包在 releases/download/<tag>/<文件名>。
// 真的会弹原生对话框，这里用 SPW_DIALOG_ANSWERS 自动回答（第 1 次「下载并安装」，第 2 次「稍后」）。
// 启动后自动检查那条路见 update-dialog-check.mjs（要开原生对话框，单独一个实例跑更稳）。
// 用法：node scripts/update-check.mjs（检查安装包：设 SPW_EXE）

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { _electron } from "playwright-core";
import { startFakeSp } from "../test/fake-sp.js";
import { sampleData } from "../test/fixtures.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// 每次跑用独立目录：上一次的句柄没放干净时（Windows 会锁住 userData）不会卡住这一次
const out = path.join(root, ".smoke", `update-${process.pid}`);
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

// 找原生对话框（类名 #32770）用
const BP = "uintptr_t";
const user32 = createRequire(import.meta.url)("koffi").load("user32.dll");
const GetTopWindow = user32.func(`${BP} GetTopWindow(${BP} h)`);
const GetWindow = user32.func(`${BP} GetWindow(${BP} h, uint32_t cmd)`);
const GetClassNameW = user32.func("int GetClassNameW(uintptr_t h, str16 buf, int max)");
const GetWindowThreadProcessId = user32.func("uint32_t GetWindowThreadProcessId(uintptr_t h, _Out_ uint32_t *pid)");
const keybdEvent = user32.func("void keybd_event(uint8_t vk, uint8_t scan, uint32_t f, uintptr_t e)");
const GetForegroundWindow = user32.func(`${BP} GetForegroundWindow()`);
const SetForegroundWindow = user32.func("bool SetForegroundWindow(uintptr_t h)");
const GetWindowRect = user32.func("bool GetWindowRect(uintptr_t h, _Out_ int32_t *p)");
const topWindows = () => {
  const list = [];
  let cur = BigInt(GetTopWindow(0));
  for (let i = 0; cur && i < 4000; i += 1) { list.push(cur); cur = BigInt(GetWindow(cur, 2)); }
  return list;
};
const classOf = (h) => {
  const b = Buffer.alloc(96);
  GetClassNameW(h, b, 95);
  return b.toString("utf16le").replace(/\0.*$/, "");
};
const pidOf = (h) => { const b = Buffer.alloc(4); GetWindowThreadProcessId(h, b); return b.readUInt32LE(0); };
// 进程里还有别的 #32770 隐藏辅助窗口，真的消息框看尺寸认（宽 > 120）
const rectOf = (h) => { const b = Buffer.alloc(16); GetWindowRect(h, b); return b.readInt32LE(8) - b.readInt32LE(0); };
const dialogOf = (pid) => topWindows().find((h) => classOf(h) === "#32770" && pidOf(h) === pid && rectOf(h) > 120);

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
}

// 同步写再退出：这个脚本收尾时（Electron 关完、进程退出阶段）偶发段错误，
// 走管道的异步 stdout 会把已有输出整段丢掉，看起来就像「什么都没跑」。
fs.writeSync(1, `${results.join("\n")}\n`);
process.exit(results.some((r) => r.startsWith("✖")) ? 1 : 0);
