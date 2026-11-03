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
const FindWindowExW = user32.func(`${BP} FindWindowExW(${BP} parent, ${BP} after, str16 cls, str16 name)`);
const SetForegroundWindow = user32.func("bool SetForegroundWindow(uintptr_t h)");
const SetCursorPos = user32.func("bool SetCursorPos(int x, int y)");
const mouseEvent = user32.func("void mouse_event(uint32_t f, uint32_t dx, uint32_t dy, uint32_t d, uintptr_t e)");
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

  // 开一个普通窗口（设置）当参照：卡片应该压在它下面
  await today.evaluate(() => window.widget.action("openSettings"));
  for (let i = 0; i < 60 && !app.windows().some((p) => p.url().includes("settings.html")); i += 1) await sleep(100);
  await sleep(600);

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
  const hwndOf = async (match) => BigInt(await app.evaluate(({ BrowserWindow }, m) => {
    const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes(m));
    if (!w) return "0";
    const b = w.getNativeWindowHandle();
    return String(b.length >= 8 ? b.readBigUInt64LE(0) : b.readUInt32LE(0));
  }, match));
  // a 在 Z 序里是不是压在 b 上面
  const above = (a, b) => {
    let cur = BigInt(GetTopWindow(0));
    let ia = -1;
    let ib = -1;
    for (let i = 0; cur && i < 8000 && (ia < 0 || ib < 0); i += 1) {
      if (cur === a) ia = i;
      if (cur === b) ib = i;
      cur = BigInt(GetWindow(cur, 2));
    }
    return ia >= 0 && ib >= 0 ? ia < ib : null;
  };
  // 卡片是不是贴着桌面：在桌面窗口上面，但在普通窗口（设置窗口）下面
  const atDesktopLayer = async () => {
    const h = await hwndOf("card=today");
    const shell = BigInt(GetShellWindow());
    const normal = await hwndOf("settings.html");
    return above(h, shell) === true && (normal ? above(h, normal) === false : true);
  };
  const esc = async () => {
    keybdEvent(VK_ESCAPE, 0, 0, 0);
    keybdEvent(VK_ESCAPE, 0, 2, 0);
  };
  // 真实鼠标点一下：点设置窗口（自家普通窗口，不会碰到别的程序）关菜单，和你平时点别处一样
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

  await check("点菜单时，其他卡片不跟着浮到普通窗口上面", async () => {
    const normal = await hwndOf("settings.html");
    assert.ok(normal, "需要设置窗口当参照");
    const others = [await hwndOf("card=focus"), await hwndOf("card=month")];
    for (const h of others) assert.equal(above(h, normal), false, "开菜单前其他卡片不该在设置窗口上面");
    await today.locator("#menu").click();
    await sleep(900);
    for (const h of others) assert.equal(above(h, normal), false, "开菜单时其他卡片被一起抬到设置窗口上面了");
    assert.equal(above(await hwndOf("card=today"), normal), true, "弹菜单的这张应该在设置窗口上面");
    await esc();
    await sleep(1600);
    for (const h of others) assert.equal(above(h, normal), false, "关菜单后其他卡片应该还在设置窗口下面");
    assert.equal(await atDesktopLayer(), true, "关菜单后这张卡片应该回到桌面层");
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

  await check("菜单：用鼠标点别处关掉，卡片不消失、不闪", async () => {
    await watch();
    await today.locator("#menu").click();
    await sleep(900);
    await clickAway();
    await sleep(1600);
    assert.deepEqual(await events(), [], "点别处关菜单的整个过程中不该 hide/show");
    assert.equal(await visible(), true, "卡片应该还在");
    assert.equal(await atDesktopLayer(), true, "点别处之后卡片应该还在桌面层");
  });

  await check("点桌面（Progman 变前台）之后，卡片不浮到普通窗口上面", async () => {
    const shell = BigInt(GetShellWindow());
    const defView = BigInt(FindWindowExW(shell, 0, "SHELLDLL_DefView", ""));
    // 先确认起点是在桌面层
    assert.equal(await atDesktopLayer(), true, "起点应该在桌面层");
    SetForegroundWindow(defView || shell);
    // 16ms 守卫应该几乎立刻沉回去；给 300ms 容错
    await sleep(300);
    assert.equal(await atDesktopLayer(), true, "点桌面之后卡片被抬到普通窗口上面了");
    // 再点回普通窗口，确认还能正常
    await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes("settings.html"));
      if (w) w.focus();
    });
    await sleep(300);
    assert.equal(await atDesktopLayer(), true, "点回普通窗口后卡片仍应在桌面层");
  });

  // 按一次 Win+D 显示桌面；桌面显示期间普通窗口被压在桌面上，只能再按一次 Win+D 还原
  const winD = async () => {
    keybdEvent(0x5b, 0, 0, 0); // Win
    await sleep(50);
    keybdEvent(0x44, 0, 0, 0); // D
    await sleep(50);
    keybdEvent(0x44, 0, 2, 0);
    await sleep(50);
    keybdEvent(0x5b, 0, 2, 0);
  };

  await check("Win+D 显示桌面：卡片留在桌面上、不消失", async () => {
    await watch();
    assert.equal(await atDesktopLayer(), true, "起点应该在桌面层");
    await winD();
    await sleep(1200);
    assert.equal(await visible(), true, "Win+D 之后卡片应该还在");
    // 此刻桌面在最前面，卡片跟着浮上来，压在普通窗口上面是正确的
    assert.deepEqual(await events(), [], "Win+D 期间不该 hide/show");
    await winD();
    await sleep(900);
    assert.equal(await visible(), true, "还原之后卡片应该还在");
    assert.equal(await atDesktopLayer(), true, "还原之后卡片应该回到桌面层");
    await sleep(3000);
    assert.equal(await atDesktopLayer(), true, "还原之后过几秒也要回到桌面层");
  });

  await check("Win+D 显示桌面时点菜单，其他卡片不消失", async () => {
    const shell = BigInt(GetShellWindow());
    const aboveShell = async (m) => above(await hwndOf(m), shell) === true;
    await winD();
    await sleep(1200);
    for (const m of ["card=focus", "card=today", "card=month"]) {
      assert.equal(await aboveShell(m), true, `${m} 在显示桌面时应该在桌面上面`);
    }
    await today.locator("#menu").click();
    await sleep(900);
    // 这时候 shell 在最上面，把别的卡片沉底 = 沉到壁纸后面，看起来就是它们消失了
    for (const m of ["card=focus", "card=month"]) {
      assert.equal(await aboveShell(m), true, `开菜单时 ${m} 被沉到壁纸后面了`);
    }
    assert.equal(await visible(), true, "卡片应该还在");
    await esc();
    await sleep(1200);
    for (const m of ["card=focus", "card=month"]) {
      assert.equal(await aboveShell(m), true, `关菜单后 ${m} 还在壁纸后面`);
    }
    await winD();
    await sleep(1000);
    assert.equal(await atDesktopLayer(), true, "还原桌面后卡片应该回到桌面层");
  });

  await check("菜单关掉后放 8 秒（5 秒兜底跑两轮），卡片仍贴着桌面", async () => {
    await watch();
    await today.locator("#menu").click();
    await sleep(900);
    await esc();
    await sleep(8000);
    assert.deepEqual(await events(), [], "这 8 秒里不该 hide/show");
    assert.equal(await visible(), true, "卡片应该还在");
    assert.equal(await atDesktopLayer(), true, "5 秒兜底不该把卡片抬到别的窗口上面");
  });

  await check("放 40 秒（8 轮 5 秒兜底），卡片始终不压到普通窗口上", async () => {
    const bad = [];
    for (let i = 0; i < 8; i += 1) {
      await sleep(5000);
      if (!(await atDesktopLayer())) bad.push(`第 ${i + 1} 轮`);
    }
    assert.deepEqual(bad, [], "这些轮次卡片跑到普通窗口上面了");
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
