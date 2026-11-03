// menu-check.mjs — 嵌入桌面模式下卡片层级的回归检查。
//
// 主线只有一条：桌面模式下一张卡片都不该跑到普通窗口上面去。
// 点菜单、点别处、连点两次、Win+D、别的程序把 Z 序搅乱，都不该让卡片动。
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
const BP = "uintptr_t";
const GetTopWindow = user32.func(`${BP} GetTopWindow(${BP} h)`);
const GetWindow = user32.func(`${BP} GetWindow(${BP} h, uint32_t cmd)`);
const GetShellWindow = user32.func(`${BP} GetShellWindow()`);
const FindWindowExW = user32.func(`${BP} FindWindowExW(${BP} parent, ${BP} after, str16 cls, str16 name)`);
const SetForegroundWindow = user32.func("bool SetForegroundWindow(uintptr_t h)");
const SetWindowPos = user32.func(`bool SetWindowPos(${BP} h, intptr_t after, int x, int y, int cx, int cy, uint32_t f)`);
const GetClassNameW = user32.func("int GetClassNameW(uintptr_t h, str16 buf, int max)");
const IsWindowVisible = user32.func("bool IsWindowVisible(uintptr_t h)");
const SetCursorPos = user32.func("bool SetCursorPos(int x, int y)");
const mouseEvent = user32.func("void mouse_event(uint32_t f, uint32_t dx, uint32_t dy, uint32_t d, uintptr_t e)");
const keybdEvent = user32.func("void keybd_event(uint8_t vk, uint8_t scan, uint32_t f, uintptr_t e)");
const VK_ESCAPE = 0x1b;
const SWP_TOP = 0x0001 | 0x0002 | 0x0010; // NOSIZE | NOMOVE | NOACTIVATE

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, ".smoke", "menu");
fs.rmSync(out, { recursive: true, force: true });
const userData = path.join(out, "user-data");
fs.mkdirSync(userData, { recursive: true });
fs.writeFileSync(path.join(userData, "settings.json"), JSON.stringify({
  version: 2,
  tourDone: true,
  mode: "desktop",
  cards: {
    focus: { visible: true, collapsed: false, bounds: { x: 120, y: 40, width: 320, height: 72 } },
    today: { visible: true, collapsed: false, bounds: { x: 120, y: 120, width: 320, height: 400 } },
    month: { visible: true, collapsed: false, bounds: { x: 460, y: 40, width: 320, height: 420 } },
  },
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
  await today.locator(".row").first().waitFor({ timeout: 20000 });
  await sleep(1200);

  // 开一个普通窗口（设置）当参照：卡片应该永远压在它下面
  await today.evaluate(() => window.widget.action("openSettings"));
  for (let i = 0; i < 60 && !app.windows().some((p) => p.url().includes("settings.html")); i += 1) await sleep(100);
  await sleep(600);

  const CARDS = ["card=focus", "card=today", "card=month"];

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
  const hwndOf = async (match) => BigInt(await app.evaluate(({ BrowserWindow }, m) => {
    const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes(m));
    if (!w) return "0";
    const b = w.getNativeWindowHandle();
    return String(b.length >= 8 ? b.readBigUInt64LE(0) : b.readUInt32LE(0));
  }, match));

  // 整条 Z 序，从最上面往下
  const order = () => {
    const list = [];
    let cur = BigInt(GetTopWindow(0));
    for (let i = 0; cur && i < 8000; i += 1) {
      list.push(cur);
      cur = BigInt(GetWindow(cur, 2));
    }
    return list;
  };
  const cls = (h) => {
    const buf = Buffer.alloc(96);
    GetClassNameW(h, buf, 95);
    return buf.toString("utf16le").replace(/\0.*$/, "");
  };
  // a 在 Z 序里是不是压在 b 上面
  const above = (a, b) => {
    const list = order();
    const ia = list.indexOf(a);
    const ib = list.indexOf(b);
    return ia >= 0 && ib >= 0 ? ia < ib : null;
  };
  // 这张卡片贴着桌面层吗：在桌面窗口上面，又在普通窗口（设置）下面
  const atLayer = async (match = "card=today") => {
    const h = await hwndOf(match);
    const shell = BigInt(GetShellWindow());
    const normal = await hwndOf("settings.html");
    if (!h) return false;
    return above(h, shell) === true && (normal ? above(h, normal) === false : true);
  };
  const allAtLayer = async () => {
    const bad = [];
    for (const m of CARDS) if (!(await atLayer(m))) bad.push(m);
    return bad;
  };
  // 设置窗口上面有没有「我们自家以外的 Electron 顶层窗口」——原生菜单就是这样一个窗口
  const menuWindows = async () => {
    const own = new Set([await hwndOf("settings.html")]);
    for (const m of CARDS) own.add(await hwndOf(m));
    const list = order();
    const normal = await hwndOf("settings.html");
    const cut = list.indexOf(normal);
    const found = [];
    for (let i = 0; i < cut; i += 1) {
      const h = list[i];
      if (own.has(h) || !IsWindowVisible(h)) continue;
      if (cls(h) === "Chrome_WidgetWin_1") found.push(h);
    }
    return found;
  };

  const esc = async () => {
    keybdEvent(VK_ESCAPE, 0, 0, 0);
    keybdEvent(VK_ESCAPE, 0, 2, 0);
    await sleep(400);
  };
  // 真实鼠标点一下设置窗口（自家普通窗口），和平时点别处一样
  const clickAway = async () => {
    const b = await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes("settings.html"));
      return w ? w.getBounds() : null;
    });
    const x = b ? b.x + 60 : 620;
    const y = b ? b.y + 160 : 700;
    SetCursorPos(x, y);
    await sleep(120);
    mouseEvent(0x0002, 0, 0, 0, 0);
    await sleep(60);
    mouseEvent(0x0004, 0, 0, 0, 0);
    await sleep(500);
  };
  // 按一次 Win+D 显示桌面；桌面显示期间普通窗口被压在桌面上，只能再按一次还原
  const winD = async () => {
    keybdEvent(0x5b, 0, 0, 0); // Win
    await sleep(50);
    keybdEvent(0x44, 0, 0, 0); // D
    await sleep(50);
    keybdEvent(0x44, 0, 2, 0);
    await sleep(50);
    keybdEvent(0x5b, 0, 2, 0);
  };

  await check("菜单：弹出来时三张卡片都不动，菜单自己浮在普通窗口上面", async () => {
    await watch();
    assert.deepEqual(await allAtLayer(), [], "起点有卡片不在桌面层");
    const before = await menuWindows();
    await today.locator("#menu").click();
    await sleep(900);
    const added = (await menuWindows()).filter((h) => !before.includes(h));
    assert.ok(added.length > 0, "菜单窗口没出现");
    assert.deepEqual(await allAtLayer(), [], "开菜单时卡片被抬到普通窗口上面了");
    assert.deepEqual(await events(), [], "开菜单时不该 hide/show");
    assert.equal(await visible(), true, "卡片应该还在");
    await esc();
    assert.deepEqual(await allAtLayer(), [], "关菜单后卡片没留在桌面层");
  });

  await check("菜单：开着不关放 6 秒，卡片也不动、不消失", async () => {
    await watch();
    const before = await menuWindows();
    await today.locator("#menu").click();
    await sleep(6500);
    assert.ok((await menuWindows()).some((h) => !before.includes(h)), "菜单窗口应该还开着");
    assert.deepEqual(await allAtLayer(), [], "菜单开着的时候卡片跑了");
    assert.deepEqual(await events(), [], "菜单开着的时候不该 hide/show");
    assert.equal(await visible(), true, "卡片应该还在");
    await esc();
    assert.deepEqual(await allAtLayer(), [], "关掉菜单后卡片没留在桌面层");
  });

  await check("菜单：用鼠标点别处关掉，卡片不动、不消失", async () => {
    await watch();
    await today.locator("#menu").click();
    await sleep(900);
    await clickAway();
    assert.deepEqual(await events(), [], "点别处关菜单的整个过程中不该 hide/show");
    assert.equal(await visible(), true, "卡片应该还在");
    assert.deepEqual(await allAtLayer(), [], "点别处之后卡片跑了");
  });

  await check("连点两次 ⋯：开关一遍再开关一遍，卡片始终不动", async () => {
    await watch();
    for (let round = 0; round < 2; round += 1) {
      await today.locator("#menu").click();
      await sleep(700);
      assert.deepEqual(await allAtLayer(), [], `第 ${round + 1} 次开菜单时卡片跑了`);
      await today.locator("#menu").click(); // 再点一次，菜单自己关掉
      await sleep(700);
      assert.deepEqual(await allAtLayer(), [], `第 ${round + 1} 次关菜单后卡片跑了`);
      assert.equal(await visible(), true, `第 ${round + 1} 次卡片不见了`);
    }
    assert.deepEqual(await events(), [], "连点过程中不该 hide/show");
    await esc();
  });

  await check("被别的程序抬到最上面之后，一秒内自己回到桌面层", async () => {
    assert.deepEqual(await allAtLayer(), [], "起点有卡片不在桌面层");
    const h = await hwndOf("card=today");
    SetWindowPos(h, 0n, 0, 0, 0, 0, SWP_TOP); // HWND_TOP：模拟外力把卡片顶到最上面
    await sleep(500);
    assert.deepEqual(await allAtLayer(), [], "卡片被顶上去之后没有自己回来");
  });

  await check("点桌面（Progman 变前台）之后，卡片不浮到普通窗口上面", async () => {
    const shell = BigInt(GetShellWindow());
    const defView = BigInt(FindWindowExW(shell, 0, "SHELLDLL_DefView", ""));
    assert.deepEqual(await allAtLayer(), [], "起点有卡片不在桌面层");
    SetForegroundWindow(defView || shell);
    await sleep(300);
    assert.deepEqual(await allAtLayer(), [], "点桌面之后卡片被抬到普通窗口上面了");
    await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes("settings.html"));
      if (w) w.focus();
    });
    await sleep(300);
    assert.deepEqual(await allAtLayer(), [], "点回普通窗口后卡片仍应在桌面层");
  });

  await check("Win+D 显示桌面：卡片留在桌面上、不消失", async () => {
    await watch();
    assert.deepEqual(await allAtLayer(), [], "起点有卡片不在桌面层");
    await winD();
    await sleep(1200);
    assert.equal(await visible(), true, "Win+D 之后卡片应该还在");
    assert.deepEqual(await events(), [], "Win+D 期间不该 hide/show");
    await winD();
    await sleep(900);
    assert.equal(await visible(), true, "还原之后卡片应该还在");
    assert.deepEqual(await allAtLayer(), [], "还原之后卡片应该回到桌面层");
    await sleep(3000);
    assert.deepEqual(await allAtLayer(), [], "还原之后过几秒也要在桌面层");
  });

  await check("Win+D 显示桌面时点菜单，其他卡片不消失", async () => {
    const shell = BigInt(GetShellWindow());
    const aboveShell = async (m) => above(await hwndOf(m), shell) === true;
    await winD();
    await sleep(1200);
    for (const m of CARDS) assert.equal(await aboveShell(m), true, `${m} 在显示桌面时应该在桌面上面`);
    await today.locator("#menu").click();
    await sleep(900);
    for (const m of CARDS) assert.equal(await aboveShell(m), true, `开菜单时 ${m} 被沉到壁纸后面了`);
    await esc();
    for (const m of CARDS) assert.equal(await aboveShell(m), true, `关菜单后 ${m} 还在壁纸后面`);
    await winD();
    await sleep(1000);
    assert.deepEqual(await allAtLayer(), [], "还原桌面后卡片应该回到桌面层");
  });

  await check("快速新建：真实键盘能打进去，用完 Win+D 仍然带着卡片", async () => {
    await winD();
    await sleep(1200);
    const plus = await today.locator("#tools .icon", { hasText: "+" }).boundingBox();
    const origin = await today.evaluate(() => ({ x: window.screenX, y: window.screenY }));
    SetCursorPos(Math.round(origin.x + plus.x + plus.width / 2), Math.round(origin.y + plus.y + plus.height / 2));
    await sleep(150);
    mouseEvent(0x0002, 0, 0, 0, 0);
    await sleep(70);
    mouseEvent(0x0004, 0, 0, 0, 0);
    await sleep(700);
    const input = today.locator("input[data-add]");
    await input.waitFor({ timeout: 5000 });
    for (const vk of [0x41, 0x42, 0x43]) { // a b c
      keybdEvent(vk, 0, 0, 0);
      await sleep(40);
      keybdEvent(vk, 0, 2, 0);
      await sleep(40);
    }
    await sleep(400);
    assert.equal(await input.inputValue(), "abc", "真实按键没进输入框");
    await input.press("Escape");
    await sleep(700);
    await winD();
    await sleep(900);
    assert.deepEqual(await allAtLayer(), [], "打完字之后卡片没回到桌面层");
    await winD();
    await sleep(1200);
    assert.equal(await visible(), true, "打完字之后再按 Win+D，卡片应该还在");
    await winD();
    await sleep(1000);
    assert.deepEqual(await allAtLayer(), [], "还原桌面后卡片应该回到桌面层");
  });

  await check("放 8 秒（Explorer 重挂跑过一轮），卡片仍在桌面层", async () => {
    await watch();
    await sleep(8000);
    assert.deepEqual(await events(), [], "这 8 秒里不该 hide/show");
    assert.equal(await visible(), true, "卡片应该还在");
    assert.deepEqual(await allAtLayer(), [], "这 8 秒里卡片跑了");
  });

  await check("放 40 秒，卡片始终不压到普通窗口上", async () => {
    const bad = [];
    for (let i = 0; i < 8; i += 1) {
      await sleep(5000);
      const where = await allAtLayer();
      if (where.length) bad.push(`第 ${i + 1} 轮 ${where.join(",")}`);
    }
    assert.deepEqual(bad, [], "这些轮次有卡片跑到普通窗口上面了");
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
