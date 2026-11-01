// desktop-check.mjs — 「嵌入桌面」模式的真机检查（只连假 SP）：
//   1. 普通窗口能盖住卡片；2. 按 Win+D 后卡片还在桌面上，再按一次别的窗口回来；
//   3. 子窗口被藏起来后左键照样点得动；4. 点「+」后用真键盘能打字新建；5. 点到别处后卡片又沉到最底下。
// 会真的按 Win+D、移动鼠标，运行时别碰电脑。用法：node scripts/desktop-check.mjs（检查安装包：设 SPW_EXE）

import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron } from "playwright-core";
import { startFakeSp } from "../test/fake-sp.js";
import { sampleData } from "../test/fixtures.js";

const require = createRequire(import.meta.url);
const koffi = require("koffi");
const u = koffi.load("user32.dll");
const POINT = koffi.struct("POINT", { x: "int", y: "int" });
const H = "uintptr_t";
const WindowFromPoint = u.func(`${H} WindowFromPoint(POINT pt)`);
const GetAncestor = u.func(`${H} GetAncestor(${H} h, uint32_t flags)`);
const GetForegroundWindow = u.func(`${H} GetForegroundWindow()`);
const SetCursorPos = u.func("bool SetCursorPos(int x, int y)");
const mouseEvent = u.func("void mouse_event(uint32_t f, uint32_t dx, uint32_t dy, uint32_t d, uintptr_t e)");
const keybdEvent = u.func("void keybd_event(uint8_t vk, uint8_t scan, uint32_t f, uintptr_t e)");
const EnumProc = koffi.proto("bool EnumProc(uintptr_t h, intptr_t l)");
const EnumWindows = u.func("bool EnumWindows(EnumProc *cb, intptr_t l)");
const IsWindowVisible = u.func(`bool IsWindowVisible(${H} h)`);
const IsIconic = u.func(`bool IsIconic(${H} h)`);
const FindWindowExW = u.func(`${H} FindWindowExW(${H} parent, ${H} after, str16 cls, str16 name)`);
const ShowWindow = u.func(`bool ShowWindow(${H} h, int cmd)`);
const SetForegroundWindow = u.func(`bool SetForegroundWindow(${H} h)`);
const GetClassNameW = u.func(`int GetClassNameW(${H} h, _Out_ uint16_t *buf, int n)`);
const GetWindowTextW = u.func(`int GetWindowTextW(${H} h, _Out_ uint16_t *buf, int n)`);
const describe = (h) => {
  const a = new Uint16Array(256);
  const b = new Uint16Array(256);
  const n = GetClassNameW(h, a, 256);
  const m = GetWindowTextW(h, b, 256);
  return `${String.fromCharCode(...a.slice(0, n))}「${String.fromCharCode(...b.slice(0, m))}」`;
};

/** 现在显示着（没最小化）的顶层窗口。检查结束时把被 Win+D 收起来的都还原，不留给用户收拾。 */
function shownWindows() {
  const list = [];
  const cb = koffi.register((h) => {
    if (IsWindowVisible(h) && !IsIconic(h)) list.push(h);
    return true;
  }, koffi.pointer(EnumProc));
  EnumWindows(cb, 0);
  koffi.unregister(cb);
  return list;
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, ".smoke", "desktop");
fs.rmSync(out, { recursive: true, force: true });
const userData = path.join(out, "user-data");
fs.mkdirSync(userData, { recursive: true });
fs.writeFileSync(path.join(userData, "settings.json"), JSON.stringify({
  version: 2,
  tourDone: true,
  mode: "desktop",
  cards: { today: { visible: true, bounds: { x: 600, y: 200, width: 320, height: 400 } } },
}));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const key = (vk) => {
  keybdEvent(vk, 0, 0, 0);
  keybdEvent(vk, 0, 2, 0);
};
const winD = async () => {
  keybdEvent(0x5b, 0, 0, 0);
  key(0x44);
  keybdEvent(0x5b, 0, 2, 0);
  await sleep(1200);
};
const click = async (x, y) => {
  SetCursorPos(Math.round(x), Math.round(y));
  await sleep(80);
  mouseEvent(2, 0, 0, 0, 0);
  mouseEvent(4, 0, 0, 0, 0);
  await sleep(300);
};
const rootAt = (x, y) => BigInt(GetAncestor(WindowFromPoint({ x: Math.round(x), y: Math.round(y) }), 2)); // GA_ROOT

const sp = await startFakeSp({ data: sampleData(Date.now()) });
// SPW_EXE 指向打包好的程序时检查打包产物（koffi 的原生模块有没有带上）
const app = await _electron.launch({ ...(process.env.SPW_EXE ? { executablePath: process.env.SPW_EXE, args: [] } : { args: [root] }), env: { ...process.env, SPW_USER_DATA: userData, SPW_BASE_URL: sp.url, SPW_TOKEN: sp.token } });
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
  // 没写 focus 的设置时「专注」默认也显示，按网址找「今日」
  let page = null;
  for (let i = 0; i < 100 && !page; i++) {
    page = app.windows().find((p) => p.url().includes("card=today")) || null;
    if (!page) await sleep(100);
  }
  await page.locator(".row").first().waitFor();
  const info = await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes("card=today"));
    const buf = w.getNativeWindowHandle();
    return { hwnd: (buf.length >= 8 ? buf.readBigUInt64LE(0) : BigInt(buf.readUInt32LE(0))).toString(), b: w.getBounds(), focusable: w.isFocusable() };
  });
  const card = BigInt(info.hwnd);
  const cx = info.b.x + info.b.width / 2;
  const cy = info.b.y + 200;
  const cover = () => app.evaluate(({ BrowserWindow }, b) => {
    const w = new BrowserWindow({ ...b, width: 500, height: 500, show: true, backgroundColor: "#335" });
    globalThis.__cover = w;
  }, { x: info.b.x - 50, y: info.b.y - 50 });
  const uncover = () => app.evaluate(() => globalThis.__cover?.destroy());

  await check("嵌入桌面时卡片不可激活", async () => assert.equal(info.focusable, false));

  await check("普通窗口能盖住卡片", async () => {
    await cover();
    await sleep(600);
    assert.notEqual(rootAt(cx, cy), card);
    await uncover();
    await sleep(400);
  });

  const userFg = BigInt(GetForegroundWindow());
  const shown = shownWindows();
  try {
    await cover();
    await app.evaluate(() => globalThis.__cover.focus());
    await sleep(600);
    await check("按 Win+D：卡片还在桌面上", async () => {
      await winD();
      assert.equal(rootAt(cx, cy), card, "卡片位置上应该是卡片自己");
      await page.screenshot({ path: path.join(out, "after-win-d.png") });
    });
    // 原型的问题是卡片成了前台窗口，再按 Win+D 别的窗口就回不来。这里看窗口是否回来、卡片没抢前台。
    // 回来后谁在最前由系统决定（有消息的 QQ 之类会抢），不要求一定是原来那个。
    await check("再按 Win+D：别的窗口回来，卡片又被盖住", async () => {
      await winD();
      const back = await app.evaluate(() => !globalThis.__cover.isMinimized() && globalThis.__cover.isVisible());
      assert.ok(back, "盖着卡片的窗口没还原");
      const now = BigInt(GetForegroundWindow());
      assert.notEqual(now, card, "卡片不该成为前台窗口");
      assert.notEqual(rootAt(cx, cy), card, `卡片应该又被盖住（前台：${describe(now)}）`);
    });

    // 用久了 Chromium 会把卡片里的子窗口藏起来，之后左键按下被系统吞掉，怎么点都没反应（0.2.0 的 bug）
    await check("子窗口藏起来后，显示桌面时左键照样点得动", async () => {
      await winD();
      const child = FindWindowExW(card, 0, "Chrome_RenderWidgetHostHWND", null);
      assert.ok(child, "没找到 Chrome_RenderWidgetHostHWND");
      ShowWindow(child, 0);
      await sleep(300);
      await page.evaluate(() => {
        window.__downs = 0;
        document.addEventListener("pointerdown", () => window.__downs++, true);
      });
      const r = await page.locator(".row .text").first().boundingBox();
      const x = info.b.x + r.x + r.width / 2;
      const y = info.b.y + r.y + r.height / 2;
      assert.equal(rootAt(x, y), card, "任务上面盖着别的窗口，不点");
      for (let i = 0; i < 3; i++) await click(x + i, y);
      assert.equal(await page.evaluate(() => window.__downs), 3, "左键按下没送到页面");
      ShowWindow(child, 4);
      await winD();
    });

    await check("显示桌面时点「+」，能用键盘打字新建", async () => {
      await winD();
      const r = await page.locator("#tools .icon", { hasText: "+" }).boundingBox();
      const x = info.b.x + r.x + r.width / 2;
      const y = info.b.y + r.y + r.height / 2;
      // 只在光标下面确实是卡片时才点，免得点到别的程序
      assert.equal(rootAt(x, y), card, "「+」上面盖着别的窗口，不点");
      await click(x, y);
      await page.locator("input[data-add]").waitFor({ timeout: 3000 });
      await sleep(300);
      // 只在卡片是前台窗口时才按键，免得打进别的程序
      assert.equal(BigInt(GetForegroundWindow()), card, "卡片没拿到键盘焦点");
      for (const vk of [0x31, 0x32, 0x33]) key(vk); // 数字不经过输入法
      key(0x0d);
      for (let i = 0; i < 40 && !sp.state.bodies.some((b) => b.body?.title === "123"); i++) await sleep(100);
      assert.ok(sp.state.bodies.some((b) => b.path === "/tasks" && b.body.title === "123"), "没收到 POST /tasks「123」");
      key(0x1b);
      await page.screenshot({ path: path.join(out, "typed.png") });
    });
  } finally {
    // 还原检查期间被收起来的窗口，前台窗口也还给用户
    await sleep(500);
    for (const h of shown) if (IsIconic(h)) ShowWindow(h, 4); // SW_SHOWNOACTIVATE
    await sleep(500);
    if (userFg) SetForegroundWindow(userFg);
    await sleep(500);
  }

  await check("用完后卡片又沉到最底下、不可激活", async () => {
    await app.evaluate(() => globalThis.__cover.focus());
    await sleep(600);
    assert.notEqual(rootAt(cx, cy), card, "卡片应该在盖着它的窗口下面");
    const focusable = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes("card=today")).isFocusable());
    assert.equal(focusable, false);
    await uncover();
  });
} finally {
  await app.evaluate(({ app: a }) => a.exit(0)).catch(() => {});
  await sp.close();
}
console.log(results.join("\n"));
if (results.some((r) => r.startsWith("✖"))) process.exit(1);
