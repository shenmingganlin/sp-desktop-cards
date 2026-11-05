// hotkey-check.mjs — 「不挡点击」的整条链路（只连假 SP）。
//
// 验的不是 setIgnoreMouseEvents 本身（那是 clickthrough-check 的事），而是：
//   1. 全局快捷键真的注册上了，按下真的切换；
//   2. 切换后卡片真的穿透/恢复；
//   3. 桌面上真的浮了提示条，提示条自己不挡点击；
//   4. 设置窗口里的快捷键录制窗能打开、能选键、占用冲突会拒绝并保留原来的。
//
// 用法：node scripts/hotkey-check.mjs（检查安装包：设 SPW_EXE）

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
const GetWindowLongPtrW = u.func("intptr_t GetWindowLongPtrW(uintptr_t h, int i)");
const WS_EX_TRANSPARENT = 0x20;
const WS_EX_TOPMOST = 0x8;
const GWL_EXSTYLE = -20;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, ".smoke", "hotkey");
fs.rmSync(out, { recursive: true, force: true });
// 用测试专用的组合，不写默认的 Ctrl+Alt+J：全局快捷键是整个系统一个，
// 本机正跑着的日常实例会占着默认那个，检查就会因为环境而红（0.7.2 踩过）。
// 默认值本身由 test/hotkey.test.js 的 defaultKey() 单测守着。
const KEY = { mods: ["ctrl", "alt"], key: "F9" };
const ACCEL = "Control+Alt+F9";
const KEY_TEXT = "Ctrl + Alt + F9";

const userData = path.join(out, "user-data");
fs.mkdirSync(userData, { recursive: true });
fs.writeFileSync(path.join(userData, "settings.json"), JSON.stringify({
  version: 2,
  tourDone: true,
  theme: "dark",
  mode: "top",
  clickThrough: false,
  clickThroughKey: KEY,
  cards: { today: { visible: true, collapsed: false, bounds: { x: 300, y: 300, width: 320, height: 420 } } },
}));

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
const waitFor = async (fn, ms = 5000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await fn()) return true;
    await sleep(80);
  }
  return !!(await fn());
};

const sp = await startFakeSp({ data: sampleData(Date.now()) });
const app = await _electron.launch({
  ...(process.env.SPW_EXE ? { executablePath: process.env.SPW_EXE, args: [] } : { args: [root] }),
  env: { ...process.env, SPW_USER_DATA: userData, SPW_BASE_URL: sp.url, SPW_TOKEN: sp.token },
});

const cardHwnd = () =>
  app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes("card=today"));
    if (!w) return 0;
    const b = w.getNativeWindowHandle();
    return Number(b.length >= 8 ? b.readBigUInt64LE(0) : BigInt(b.readUInt32LE(0)));
  });
const through = async () => (Number(GetWindowLongPtrW(await cardHwnd(), GWL_EXSTYLE)) & WS_EX_TRANSPARENT) !== 0;
const readSetting = () => app.evaluate(({ app: a }) => {
  const f = `${a.getPath("userData")}/settings.json`;
  return JSON.parse(process.mainModule.require("node:fs").readFileSync(f, "utf8"));
});
/** settings.json 是合并 400ms 写的，读完要给它落盘的时间。 */
const setting = async () => {
  await sleep(600);
  return readSetting();
};

try {
  let page = null;
  for (let i = 0; i < 100 && !page; i++) {
    page = app.windows().find((p) => p.url().includes("card=today")) || null;
    if (!page) await sleep(100);
  }
  assert.ok(page, "没等到今日卡片");
  await page.locator(".row").first().waitFor();
  await sleep(1200);

  await check("启动时注册了快捷键，默认关着", async () => {
    const registered = await app.evaluate(({ globalShortcut }, a) => globalShortcut.isRegistered(a), ACCEL);
    assert.equal(registered, true, `${ACCEL} 没注册上`);
    assert.equal(await through(), false, "默认应该是关的");
  });

  // 走卡片页面的 IPC（toggleClickThrough）：和用户点 ⋯ 菜单、按快捷键落到的是同一个函数
  await check("切换后卡片穿透，再切回来恢复", async () => {
    await page.evaluate(() => window.widget.action("toggleClickThrough"));
    await waitFor(through);
    assert.equal(await through(), true, "开了却没穿透");
    assert.equal((await setting()).clickThrough, true, "状态没存下来");

    await page.evaluate(() => window.widget.action("toggleClickThrough"));
    await waitFor(async () => !(await through()));
    assert.equal(await through(), false, "关了还在穿透");
    assert.equal((await setting()).clickThrough, false);
  });

  await check("切换时桌面上浮了提示条，它自己不挡点击", async () => {
    await page.evaluate(() => window.widget.action("toggleClickThrough"));
    const shown = await waitFor(() => app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().some((w) => w.webContents.getURL().includes("toast.html") && w.isVisible())));
    assert.ok(shown, "提示条没出现");
    const info = await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes("toast.html"));
      const b = w.getNativeWindowHandle();
      return {
        hwnd: Number(b.length >= 8 ? b.readBigUInt64LE(0) : BigInt(b.readUInt32LE(0))),
        focusable: w.isFocusable(),
        top: w.isAlwaysOnTop(),
      };
    });
    assert.equal(info.focusable, false, "提示条会抢焦点");
    assert.equal(info.top, true, "提示条没置顶");
    assert.ok((Number(GetWindowLongPtrW(info.hwnd, GWL_EXSTYLE)) & WS_EX_TRANSPARENT) !== 0, "提示条自己挡点击");
    // 过一会儿自己藏起来
    const gone = await waitFor(() => app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes("toast.html"));
      return !w || !w.isVisible();
    }), 4000);
    assert.ok(gone, "提示条没自己消失");
    await page.evaluate(() => window.widget.action("toggleClickThrough"));
  });

  // 这条是回归：以前淡出时把 opacity: 0 写成内联样式又不清，第二次以后窗口在、内容透明，
  // 看起来就是「提示只弹第一次」。
  await check("连按几次，每次提示条都真的看得见，并带上当前快捷键", async () => {
    const toastPage = () => app.windows().find((p) => p.url().includes("toast.html"));
    const state = () => toastPage().evaluate(() => {
      const n = document.getElementById("note");
      return {
        opacity: Number(getComputedStyle(n).opacity),
        text: document.getElementById("text").textContent,
        hint: document.getElementById("hint").hidden ? "" : document.getElementById("hint").textContent,
      };
    });
    for (const round of [1, 2, 3]) {
      await page.evaluate(() => window.widget.action("toggleClickThrough"));
      await waitFor(async () => (await toastPage()) && (await state()).opacity > 0.9, 3000);
      const s = await state();
      assert.ok(s.opacity > 0.9, `第 ${round} 次提示条是透明的（opacity=${s.opacity}）`);
      assert.match(s.text, /不挡点击已(开启|关闭)/, `第 ${round} 次提示文案不对：${s.text}`);
      // 穿透开着时卡片点不到，提示条上必须能看见怎么关
      assert.equal(s.hint, `${KEY_TEXT} 切换`, `第 ${round} 次没显示快捷键：${s.hint}`);
      // 等它自己藏起来，模拟用户看到之后又按了一次
      await waitFor(() => app.evaluate(({ BrowserWindow }) => {
        const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes("toast.html"));
        return !w || !w.isVisible();
      }), 4000);
    }
  });

  await check("开着不挡点击时，卡片按「背景板」显示：顶栏禁止标志、内容压一档", async () => {
    await page.evaluate(() => window.widget.action("toggleClickThrough", { on: true }));
    await waitFor(() => page.evaluate(() => document.body.classList.contains("click-through")), 3000);
    const mark = page.locator("#blocked-mark");
    assert.equal(await mark.isVisible(), true, "顶栏没有禁止标志");
    assert.match(await mark.textContent(), /不可点击/, "标志旁边没写原因");
    // 不再挂整条横幅：一屏十几张卡就是十几条，太吵
    assert.equal(await page.locator("#blocked").count(), 0, "不该再有整条横幅");
    // 内容压一档，让卡片自己读作背景板
    const dim = await page.evaluate(() => Number(getComputedStyle(document.getElementById("body")).opacity));
    assert.ok(dim < 1, `内容没有压暗（opacity=${dim}）`);
    // 折叠后顶栏还在，标志也还在
    await page.evaluate(() => window.widget.action("toggleCollapsed"));
    await waitFor(() => page.evaluate(() => document.body.classList.contains("collapsed")), 3000);
    assert.equal(await mark.isVisible(), true, "折叠后顶栏该照样有标志");
    await page.evaluate(() => window.widget.action("toggleCollapsed"));
    await waitFor(() => page.evaluate(() => !document.body.classList.contains("collapsed")), 3000);
    // 关掉就收起来，内容也恢复
    await page.evaluate(() => window.widget.action("toggleClickThrough", { on: false }));
    await waitFor(() => page.evaluate(() => !document.body.classList.contains("click-through")), 3000);
    assert.equal(await mark.isVisible(), false, "关了还挂着标志");
    const full = await page.evaluate(() => Number(getComputedStyle(document.getElementById("body")).opacity));
    assert.equal(full, 1, `关了内容还是暗的（opacity=${full}）`);
  });

  // 录制窗
  await page.evaluate(() => window.widget.action("openSettings"));
  let settings = null;
  for (let i = 0; i < 60 && !settings; i++) {
    settings = app.windows().find((p) => p.url().includes("settings.html")) || null;
    if (!settings) await sleep(100);
  }
  await settings.locator("#hotkey-button").waitFor();
  await settings.locator("#hotkey-button").click();
  let recorder = null;
  for (let i = 0; i < 60 && !recorder; i++) {
    recorder = app.windows().find((p) => p.url().includes("hotkey.html")) || null;
    if (!recorder) await sleep(100);
  }
  await recorder.locator("#keyboard .key").first().waitFor();

  await check(`录制窗画出了键盘，当前组合显示为 ${KEY_TEXT}`, async () => {
    assert.equal(await recorder.locator("#combo").textContent(), KEY_TEXT);
    assert.equal(await recorder.locator('.key.on[data-key="ctrl"]').count(), 1, "Ctrl 没标成选中");
    assert.equal(await recorder.locator('.key.on[data-key="alt"]').count(), 1, "Alt 没标成选中");
    assert.equal(await recorder.locator('.key.on[data-key="F9"]').count(), 1, "F9 没标成选中");
    assert.equal(await recorder.locator("#ok").isDisabled(), false, "有完整组合时确定该可点");
  });

  await check("左键选键、右键取消，普通键只能有一个", async () => {
    // 右键取消 Alt，还剩 Ctrl + F9，仍然合法
    await recorder.locator('.key[data-key="alt"]').click({ button: "right" });
    assert.equal(await recorder.locator("#combo").textContent(), "Ctrl + F9");
    assert.equal(await recorder.locator("#ok").isDisabled(), false, "还有 Ctrl + F9，该可点");
    // 右键取消 Ctrl：只剩普通键，不合法
    await recorder.locator('.key[data-key="ctrl"]').click({ button: "right" });
    assert.equal(await recorder.locator("#ok").isDisabled(), true, "只剩普通键时确定该变灰");
    // 选一个修饰键回来
    await recorder.locator('.key[data-key="ctrl"]').click();
    // 再点一个普通键：应该换掉 F9，不是加第二个
    await recorder.locator('.key[data-key="K"]').click();
    assert.equal(await recorder.locator("#combo").textContent(), "Ctrl + K");
    assert.equal(await recorder.locator('.key.on[data-key="F9"]').count(), 0, "F9 没被换掉");
    assert.equal(await recorder.locator('.key.on[data-key="K"]').count(), 1);
  });

  await check("确定后快捷键真的换成新的，旧的注销", async () => {
    await recorder.locator("#ok").click();
    await waitFor(async () => !app.windows().some((p) => p.url().includes("hotkey.html")), 3000);
    const state = await app.evaluate(({ globalShortcut }, a) => ({
      old: globalShortcut.isRegistered(a),
      fresh: globalShortcut.isRegistered("Control+K"),
    }), ACCEL);
    assert.equal(state.fresh, true, "新的 Control+K 没注册上");
    assert.equal(state.old, false, `旧的 ${ACCEL} 还占着`);
    assert.deepEqual((await setting()).clickThroughKey, { mods: ["ctrl"], key: "K" });
  });

  await check("设置里显示的是新组合，换成功之后旧警告要消失", async () => {
    const text = await settings.locator("#hotkey-current").textContent();
    assert.equal(text, "Ctrl + K");
    // 回归：hotkeyNotice 以前只在启动时设、从不清理，换好了设置页还挂着「被占用」
    assert.equal(await settings.locator("#hotkey-current.warn").count(), 0, "换上能用的组合后仍标着警告");
  });

  await check("被别的程序占用的组合：拒绝并保留原来的", async () => {
    // 上一轮「确定」把录制窗关掉了，重新打开
    await settings.locator("#hotkey-button").click();
    for (let i = 0; i < 60 && !app.windows().some((p) => p.url().includes("hotkey.html")); i += 1) await sleep(100);
    const again = app.windows().find((p) => p.url().includes("hotkey.html"));
    await again.locator("#keyboard .key").first().waitFor();
    // 先自己占一个，模拟「别的程序」——注册成功才说明这个组合真的被占住了
    const took = await app.evaluate(({ globalShortcut }) => globalShortcut.register("Control+Alt+Q", () => {}));
    assert.equal(took, true, "Control+Alt+Q 本机也被占了，这条检查模拟不出冲突");
    const before = (await setting()).clickThroughKey;
    // 真的点「确定」：走 confirm()，错误提示才有机会显示出来
    await again.locator('.key[data-key="alt"]').click();
    await again.locator('.key[data-key="Q"]').click();
    assert.equal(await again.locator("#combo").textContent(), "Ctrl + Alt + Q");
    await again.locator("#ok").click();
    // 窗口应该留着，并把原因显示出来
    await waitFor(async () => (await again.locator("#error").isVisible()), 3000);
    assert.equal(await again.locator("#error").isVisible(), true, "没把原因显示在窗口里");
    assert.match(await again.locator("#error").textContent(), /占用/, "没说明原因");
    // 原来的还在，状态没被改
    assert.deepEqual((await setting()).clickThroughKey, before, "原来的组合被冲掉了");
    const still = await app.evaluate(({ globalShortcut }) => globalShortcut.isRegistered("Control+K"));
    assert.equal(still, true, "原来的组合没注册回去");
    await app.evaluate(({ globalShortcut }) => globalShortcut.unregister("Control+Alt+Q"));
    // 窗口留着说明没被接受：录错了还能接着改
    assert.ok(app.windows().some((p) => p.url().includes("hotkey.html")), "窗口被关掉了");
  });
} finally {
  await app.evaluate(({ app: a }) => a.exit(0)).catch(() => {});
  await sp.close();
}
console.log(results.join("\n"));
if (results.some((r) => r.startsWith("✖"))) process.exit(1);
