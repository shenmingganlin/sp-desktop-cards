// menu-check.mjs — 嵌入桌面模式下点卡片菜单的回归检查。
// 卡片在菜单打开/关闭时不能 hide/show（那会让卡片闪一下，菜单开久了还会整张消失）。
// 用法：node scripts/menu-check.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron } from "playwright-core";
import { startFakeSp } from "../test/fake-sp.js";
import { sampleData } from "../test/fixtures.js";

const require = createRequire(import.meta.url);
const user32 = require("koffi").load("user32.dll");
const keybdEvent = user32.func("void keybd_event(uint8_t vk, uint8_t scan, uint32_t f, uintptr_t e)");
const BP = "uintptr_t";
const GetTopWindow = user32.func(`${BP} GetTopWindow(${BP} h)`);
const GetWindow = user32.func(`${BP} GetWindow(${BP} h, uint32_t cmd)`);
const GetShellWindow = user32.func(`${BP} GetShellWindow()`);
const VK_ESCAPE = 0x1b;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, ".smoke", "menu");
fs.rmSync(out, { recursive: true, force: true });
const userData = path.join(out, "user-data");
fs.mkdirSync(userData, { recursive: true });
fs.writeFileSync(path.join(userData, "settings.json"), JSON.stringify({
  version: 2,
  tourDone: true,
  mode: "desktop",
  cards: { today: { visible: true, collapsed: false, bounds: { x: 120, y: 120, width: 320, height: 400 } } },
}));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sp = await startFakeSp({ data: sampleData(Date.now()) });
const app = await _electron.launch({
  args: [root],
  env: { ...process.env, SPW_USER_DATA: userData, SPW_BASE_URL: sp.url, SPW_TOKEN: sp.token },
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
  const cardOf = (p) => new URL(p.url()).searchParams.get("card");
  for (let i = 0; i < 100 && !app.windows().some((p) => cardOf(p) === "today"); i++) await sleep(100);
  const today = app.windows().find((p) => cardOf(p) === "today");
  await today.locator(".row").first().waitFor();
  await sleep(1200);

  // 记录卡片窗口的 hide/show，菜单开关期间不应该出现
  const watch = () => app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes("card=today"));
    globalThis.__evts = [];
    if (!globalThis.__hooked) {
      globalThis.__hooked = true;
      for (const e of ["hide", "show"]) w.on(e, () => globalThis.__evts.push(e));
    }
    return true;
  });
  const events = () => app.evaluate(() => globalThis.__evts);
  const visible = () => app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes("card=today"));
    return w.isVisible();
  });
  // 卡片是不是贴着桌面：从卡片往下走，中间只有自家卡片、然后是桌面窗口
  const atDesktopLayer = async () => {
    const h = BigInt(await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes("card=today"));
      const b = w.getNativeWindowHandle();
      return String(b.length >= 8 ? b.readBigUInt64LE(0) : b.readUInt32LE(0));
    }));
    const shell = BigInt(GetShellWindow());
    let cur = BigInt(GetWindow(h, 2));
    for (let i = 0; cur && i < 64; i += 1) {
      if (cur === shell) return true;
      cur = BigInt(GetWindow(cur, 2));
    }
    return false;
  };
  const esc = async () => {
    keybdEvent(VK_ESCAPE, 0, 0, 0);
    keybdEvent(VK_ESCAPE, 0, 2, 0);
  };

  await check("菜单：打开再关掉，卡片不隐藏、不闪", async () => {
    await watch();
    await today.locator("#menu").click();
    await sleep(900);
    await esc();
    await sleep(1600);
    assert.deepEqual(await events(), [], "菜单开关期间不该 hide/show");
    assert.equal(await visible(), true, "卡片应该还在");
    assert.equal(await atDesktopLayer(), true, "卡片应该回到桌面层，不压在别的窗口上面");
  });

  await check("菜单：开着不关放 6 秒，卡片也不消失", async () => {
    await watch();
    await today.locator("#menu").click();
    await sleep(6500);
    assert.deepEqual(await events(), [], "菜单开着的时候不该 hide/show");
    assert.equal(await visible(), true, "卡片应该还在");
    await esc();
    await sleep(1200);
    assert.deepEqual(await events(), [], "关掉菜单也不该 hide/show");
    assert.equal(await atDesktopLayer(), true, "5 秒兜底跑过之后也要回到桌面层");
  });

  await check("菜单关掉后卡片照常能点", async () => {
    const item = today.locator(".row", { has: today.locator(".title", { hasText: /^写周报$/ }) });
    await item.locator(".check").click();
    for (let i = 0; i < 40; i++) {
      if (sp.state.tasks.find((t) => t.id === "report")?.isDone) break;
      await sleep(100);
    }
    assert.equal(sp.state.tasks.find((t) => t.id === "report").isDone, true, "勾选应该发到 SP");
  });
} finally {
  await app.evaluate(({ app: a }) => a.exit(0)).catch(() => {});
  await sp.close();
}

console.log(results.join("\n"));
if (results.some((r) => r.startsWith("✖"))) process.exit(1);
