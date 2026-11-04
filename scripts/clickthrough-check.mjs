// clickthrough-check.mjs — 「不挡点击」的真机检查（只连假 SP）。
//
// 要验的是真的穿透：开了之后，鼠标落在卡片上，WindowFromPoint 应该返回卡片底下的窗口，
// 而不是卡片自己（也不是卡片里那个 Chrome_RenderWidgetHostHWND 子窗口）。
// 只在扩展样式层面看 WS_EX_TRANSPARENT 不够——桌面模式下 keepClickable 每 500ms
// 会把子窗口显示回来，得确认那样也照样穿透。
//
// 用法：node scripts/clickthrough-check.mjs（检查安装包：设 SPW_EXE）

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { _electron } from "playwright-core";
import { startFakeSp } from "../test/fake-sp.js";
import { sampleData } from "../test/fixtures.js";

const require = createRequire(import.meta.url);
const u = require("koffi").load("user32.dll");
const BP = "uintptr_t";
const POINT = require("koffi").struct("POINT", { x: "int32_t", y: "int32_t" });
const WindowFromPoint = u.func(`${BP} WindowFromPoint(POINT pt)`);
const GetWindowLongPtrW = u.func("intptr_t GetWindowLongPtrW(uintptr_t h, int i)");
const FindWindowExW = u.func(`${BP} FindWindowExW(${BP} parent, ${BP} after, str16 cls, str16 name)`);
const GetWindowRect = u.func("bool GetWindowRect(uintptr_t h, void *rect)");

const GWL_EXSTYLE = -20;
const WS_EX_TRANSPARENT = 0x20;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, ".smoke", "clickthrough");
fs.rmSync(out, { recursive: true, force: true });
const userData = path.join(out, "user-data");
fs.mkdirSync(userData, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = async (name, fn) => {
  try {
    await fn();
    results.push(`✔ ${name}`);
  } catch (error) {
    results.push(`✖ ${name}: ${error.message.split("\n")[0]}`);
  }
};

const sp = await startFakeSp({ data: sampleData(Date.now()) });

/** 起一个实例，只开「今日」一张卡片，方便定位。 */
async function launch(mode, clickThrough) {
  fs.writeFileSync(path.join(userData, "settings.json"), JSON.stringify({
    version: 2,
    tourDone: true,
    theme: "dark",
    mode,
    clickThrough,
    cards: { today: { visible: true, collapsed: false, bounds: { x: 300, y: 300, width: 320, height: 420 } } },
  }));
  const app = await _electron.launch({
    ...(process.env.SPW_EXE ? { executablePath: process.env.SPW_EXE, args: [] } : { args: [root] }),
    env: { ...process.env, SPW_USER_DATA: userData, SPW_BASE_URL: sp.url, SPW_TOKEN: sp.token },
  });
  let page = null;
  for (let i = 0; i < 100 && !page; i++) {
    page = app.windows().find((p) => p.url().includes("card=today")) || null;
    if (!page) await sleep(100);
  }
  assert.ok(page, "没等到今日卡片");
  await page.locator(".row").first().waitFor();
  await sleep(1200); // 让 keepClickable 跑过一轮
  return { app, page };
}

const hwndOf = (app) =>
  app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes("card=today"));
    if (!w) return 0;
    const b = w.getNativeWindowHandle();
    return Number(b.length >= 8 ? b.readBigUInt64LE(0) : BigInt(b.readUInt32LE(0)));
  });

/** 卡片正中间那一点，WindowFromPoint 命中谁。 */
function hitAt(hwnd) {
  const rect = Buffer.alloc(16);
  GetWindowRect(hwnd, rect);
  const cx = Math.round((rect.readInt32LE(0) + rect.readInt32LE(8)) / 2);
  const cy = Math.round((rect.readInt32LE(4) + rect.readInt32LE(12)) / 2);
  const hit = Number(WindowFromPoint({ x: cx, y: cy }));
  return { hit, cx, cy, exStyle: Number(GetWindowLongPtrW(hwnd, GWL_EXSTYLE)) };
}

const transparentBit = (hwnd) => (Number(GetWindowLongPtrW(hwnd, GWL_EXSTYLE)) & WS_EX_TRANSPARENT) !== 0;

const setIgnore = (app, on) =>
  app.evaluate(({ BrowserWindow }, flag) => {
    const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes("card=today"));
    w.setIgnoreMouseEvents(flag);
  }, on);

/**
 * 跑一轮：开/关穿透，看命中结果。
 * 命中判定只在置顶模式做——嵌入桌面时卡片在桌面层，被别的窗口盖着本来就点不到，
 * 那儿的 WindowFromPoint 返回的是盖在上面的窗口，验不了穿透。桌面模式只验扩展样式位。
 */
async function runMode(mode) {
  const hitTestable = mode === "top";
  const { app } = await launch(mode, false);
  try {
    const hwnd = await hwndOf(app);
    const child = () => Number(FindWindowExW(hwnd, 0, "Chrome_RenderWidgetHostHWND", null));
    /** 鼠标是不是落在卡片（含它的子窗口）上。 */
    const landsOnCard = () => {
      const r = hitAt(hwnd);
      return r.hit === hwnd || r.hit === child();
    };

    await check(`[${mode}] 没开穿透时，卡片不带 WS_EX_TRANSPARENT`, async () => {
      assert.equal(transparentBit(hwnd), false, "没开却带了 WS_EX_TRANSPARENT");
    });
    if (hitTestable) {
      await check(`[${mode}] 没开穿透时，点卡片落在卡片上`, async () => {
        const r = hitAt(hwnd);
        assert.ok(landsOnCard(), `点在 (${r.cx},${r.cy}) 命中的是 ${r.hit}，不是卡片 ${hwnd}/${child()}`);
      });
    }

    await setIgnore(app, true);
    await sleep(600);
    await check(`[${mode}] 开了穿透后带上 WS_EX_TRANSPARENT`, async () => {
      assert.equal(transparentBit(hwnd), true, "没带上 WS_EX_TRANSPARENT");
    });
    if (hitTestable) {
      await check(`[${mode}] 开了穿透后，点卡片穿透到下面`, async () => {
        assert.equal(landsOnCard(), false, "还是命中卡片或它的子窗口，等于没穿透");
      });
    }
    // 再等一轮 keepClickable：它会把子窗口显示回来，得确认那样也照样穿透
    await sleep(1000);
    await check(`[${mode}] 等 keepClickable 跑过一轮，穿透还在`, async () => {
      assert.equal(transparentBit(hwnd), true, "WS_EX_TRANSPARENT 被弄掉了");
      if (hitTestable) assert.equal(landsOnCard(), false, "命中卡片或它的子窗口");
    });

    await setIgnore(app, false);
    await sleep(400);
    await check(`[${mode}] 关掉穿透后，样式位还回去`, async () => {
      assert.equal(transparentBit(hwnd), false);
      if (hitTestable) assert.ok(landsOnCard(), "没落回卡片上");
    });
  } finally {
    await app.evaluate(({ app: a }) => a.exit(0)).catch(() => {});
    await sleep(600);
  }
}

try {
  // 置顶和嵌入桌面两种模式都要过。普通窗口本来就在别的窗口下面，不存在挡的问题。
  await runMode("top");
  await runMode("desktop");

  // 启动时就是开着的：窗口一建出来就该带上穿透
  const { app } = await launch("top", true);
  try {
    const hwnd = await hwndOf(app);
    await check("[启动即开启] 一启动就带着穿透，不用再点一次", async () => {
      assert.equal(transparentBit(hwnd), true, "启动时没带上 WS_EX_TRANSPARENT");
      const r = hitAt(hwnd);
      const child = Number(FindWindowExW(hwnd, 0, "Chrome_RenderWidgetHostHWND", null));
      assert.notEqual(r.hit, hwnd);
      assert.notEqual(r.hit, child);
    });
  } finally {
    await app.evaluate(({ app: a }) => a.exit(0)).catch(() => {});
  }
} finally {
  await sp.close();
}
console.log(results.join("\n"));
if (results.some((r) => r.startsWith("✖"))) process.exit(1);
