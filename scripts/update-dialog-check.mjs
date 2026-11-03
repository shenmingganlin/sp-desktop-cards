// update-dialog-check.mjs — 「启动后自动检查更新」这条路的自检。
// 手动点「检查更新…」走通不代表自动那条没问题：触发条件、延时、和教程/设置窗口的互斥都在另一段代码里。
// 这里不点任何按钮，只等它自己弹；重点验两件事——真的弹了，而且弹到了最前面（否则用户根本看不见）。
// 用法：node scripts/update-dialog-check.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { _electron } from "playwright-core";
import { startFakeSp } from "../test/fake-sp.js";
import { sampleData } from "../test/fixtures.js";

const require = createRequire(import.meta.url);
const user32 = require("koffi").load("user32.dll");
const BP = "uintptr_t";
const GetWindowRect = user32.func("bool GetWindowRect(uintptr_t h, _Out_ int32_t *p)");
const GetWindowThreadProcessId = user32.func(`uint32_t GetWindowThreadProcessId(uintptr_t h, _Out_ uint32_t *pid)`);
const GetForegroundWindow = user32.func(`${BP} GetForegroundWindow()`);
const PostMessageW = user32.func("bool PostMessageW(uintptr_t h, uint32_t msg, uintptr_t w, intptr_t l)");

const FindWindowExW = user32.func(`${BP} FindWindowExW(${BP} parent, ${BP} after, str16 cls, str16 name)`);
// 只找对话框类：整条 Z 序动辄几千个窗口，每次都走一遍又多又慢
const dialogs = () => {
  const list = [];
  let h = 0n;
  for (let i = 0; i < 200; i += 1) {
    h = BigInt(FindWindowExW(0n, h, "#32770", null));
    if (!h) break;
    list.push(h);
  }
  return list;
};
const classOf = (h) => {
  const b = Buffer.alloc(96);
  GetClassNameW(h, b, 95);
  return b.toString("utf16le").replace(/\0.*$/, "");
};
const pidOf = (h) => { const b = Buffer.alloc(4); GetWindowThreadProcessId(h, b); return b.readUInt32LE(0); };
const widthOf = (h) => { const b = Buffer.alloc(16); GetWindowRect(h, b); return b.readInt32LE(8) - b.readInt32LE(0); };
// 进程里还有别的 #32770 隐藏辅助窗口（31x54 那种），真的消息框看尺寸认
const dialogOf = (pid) => dialogs().find((h) => pidOf(h) === pid && widthOf(h) > 120);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// 每次跑用独立目录：上一次的句柄没放干净时 Windows 会锁住 userData
const out = path.join(root, ".smoke", `update-dialog-${process.pid}`);
fs.rmSync(out, { recursive: true, force: true });
const userData = path.join(out, "user-data");
fs.mkdirSync(userData, { recursive: true });
fs.writeFileSync(path.join(userData, "settings.json"), JSON.stringify({
  version: 2,
  tourDone: true, // 不弹新手引导，否则自动检查会被让路
  mode: "top",
  autoUpdate: true,
  lastUpdateCheck: 0, // 从没查过 → 启动后就该查
  cards: { today: { visible: true, collapsed: false, bounds: { x: 120, y: 120, width: 320, height: 400 } } },
}));

const VERSION = "9.9.9"; // 一定比当前版本新
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  const base = `http://127.0.0.1:${server.address().port}`;
  if (url.pathname === "/releases/latest") return res.writeHead(302, { location: `${base}/releases/tag/v${VERSION}` }).end();
  if (url.pathname === `/releases/tag/v${VERSION}`) return res.writeHead(200, { "content-type": "text/html" }).end("<title>v</title>");
  res.writeHead(404).end();
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}/releases`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sp = await startFakeSp({ data: sampleData(Date.now()) });
// 故意不给 SPW_DIALOG_ANSWERS：要看见真的原生对话框
const app = await _electron.launch({
  args: [root],
  env: {
    ...process.env,
    SPW_USER_DATA: userData,
    SPW_BASE_URL: sp.url,
    SPW_TOKEN: sp.token,
    SPW_UPDATE_API: `${base}/latest`,
    SPW_UPDATE_BASE: `${base}/download`,
  },
});

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
  const pid = await app.evaluate(() => process.pid);
  let found = null;

  await check("启动后不点任何按钮，自己弹出更新对话框", async () => {
    for (let i = 0; i < 120 && !found; i += 1) {
      await sleep(100);
      found = dialogOf(pid);
    }
    assert.ok(found, "等了 12 秒也没等到更新对话框");
  });

  await check("对话框弹在最前面（否则用户看不见）", async () => {
    assert.ok(found, "对话框没弹出来");
    // 窗口刚创建时前台还没切过去，给它一秒
    let fg = BigInt(GetForegroundWindow());
    for (let i = 0; i < 20 && fg !== found; i += 1) {
      await sleep(50);
      fg = BigInt(GetForegroundWindow());
    }
    assert.equal(fg, found, "对话框弹出来了但没到前台");
  });

  await check("关掉对话框之后程序继续跑，并记下检查时间", async () => {
    PostMessageW(found, 0x0010, 0n, 0n); // WM_CLOSE，等价于点「稍后」
    await sleep(900);
    assert.equal(dialogOf(pid), undefined, "对话框没关掉");
    assert.ok(app.windows().length > 0, "程序自己退出了");
    const saved = JSON.parse(fs.readFileSync(path.join(userData, "settings.json"), "utf8"));
    assert.ok(saved.lastUpdateCheck > 0, "没记下检查时间，下次启动还会再查");
  });
} finally {
  // 先把结果同步写出去：收尾（关 Electron）阶段偶发段错误，走管道的异步 stdout 会把输出整段吞掉，
  // 看起来就像「什么都没跑」。
  fs.writeSync(1, `${results.join("\n")}\n`);
  await app.evaluate(({ app: a }) => a.exit(0)).catch(() => {});
  await sp.close();
  server.close();
}
process.exit(results.some((r) => r.startsWith("✖")) ? 1 : 0);
