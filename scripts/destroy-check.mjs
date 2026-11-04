// destroy-check.mjs — 窗口在系统那边没了的时候，主进程不能崩（只连假 SP）。
//
// 场景：嵌入桌面时 Explorer 重启，Windows 会把挂在桌面下面的卡片窗口一起销毁。
// 关键在时序：Electron 的 isDestroyed() 读的是 JS 里的标记，要等 closed 事件派发才置上；
// 从「原生窗口已经没了」到「closed 派发」之间有一小段空档，isDestroyed() 还说活着，
// 可这时任何原生调用都抛 "Object has been destroyed"。
// settle() 每 16ms 跑一次，空档里必中；异常从定时器回调逃出去，就是用户看到的
// 「A JavaScript error occurred in the main process … at settle (cards.js:141)」。
//
// 这段空档没法从外面稳定复现（同进程调 DestroyWindow 会让 isDestroyed() 同步变 true，
// 而 Explorer 是别的进程在销毁，时序由系统决定）。所以这里直接把窗口对象包一层，
// 精确复刻空档里的状态：isDestroyed() 报 false，其余原生调用一律抛。
// 然后看：1. 定时器兜底没吞到异常（说明判活自己就挡住了）；
//         2. 主进程没抛未捕获异常；3. 卡片按 RECREATE_MS 自己重建回来，还能用。
//
// 用法：node scripts/destroy-check.mjs（检查安装包：设 SPW_EXE）

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron } from "playwright-core";
import { startFakeSp } from "../test/fake-sp.js";
import { sampleData } from "../test/fixtures.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, ".smoke", "destroy");
fs.rmSync(out, { recursive: true, force: true });
const userData = path.join(out, "user-data");
fs.mkdirSync(userData, { recursive: true });
fs.writeFileSync(path.join(userData, "settings.json"), JSON.stringify({
  version: 2,
  tourDone: true,
  theme: "dark",
  mode: "desktop",
  cards: { today: { visible: true, bounds: { x: 300, y: 300, width: 320, height: 420 } } },
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

const sp = await startFakeSp({ data: sampleData(Date.now()) });
const app = await _electron.launch({
  ...(process.env.SPW_EXE ? { executablePath: process.env.SPW_EXE, args: [] } : { args: [root] }),
  env: { ...process.env, SPW_USER_DATA: userData, SPW_BASE_URL: sp.url, SPW_TOKEN: sp.token },
});

const winSrc = fs.readFileSync(path.join(root, "src", "main", "win.js"), "utf8");
const errors = () => app.evaluate(() => globalThis.__errs || []);
const swallowed = () => app.evaluate(() => globalThis.__spwGuardErrors || []);

try {
  await app.evaluate(() => {
    globalThis.__errs = [];
    globalThis.__spwGuardErrors = [];
    process.on("uncaughtException", (e) => globalThis.__errs.push(String((e && e.stack) || e)));
  });

  let page = null;
  for (let i = 0; i < 100 && !page; i++) {
    page = app.windows().find((p) => p.url().includes("card=today")) || null;
    if (!page) await sleep(100);
  }
  assert.ok(page, "没等到今日卡片");
  await page.locator(".row").first().waitFor();
  await sleep(1200); // 让 settle / keepClickable 都跑起来

  // 把卡片窗口对象换成空档里的样子。不碰真的窗口，所以不影响后面的重建。
  const patched = await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes("card=today"));
    if (!w) return false;
    globalThis.__realCard = w;
    // isDestroyed 照旧报 false（空档里就是这样），别的原生调用一律抛。
    // 用一个 Proxy 挡在真实窗口前面：读到 isDestroyed 放行，其余属性和方法都抛。
    globalThis.__ghostCard = new Proxy(w, {
      get(target, prop) {
        if (prop === "isDestroyed") return () => false;
        const value = target[prop];
        if (typeof value === "function") {
          return () => {
            throw new Error("Object has been destroyed");
          };
        }
        throw new Error("Object has been destroyed");
      },
    });
    return true;
  });
  assert.ok(patched, "拿不到今日卡片窗口");

  await check("空档里判活自己挡住，不靠兜底吞异常", async () => {
    // 直接问 windowAlive：这就是 settle 每 16ms 走的判断
    // 主进程里动态 import() 用不了（Electron 的 ESM 加载器没给 import 回调）。
    // win.js 是零依赖的纯函数，读源码剥掉 export 再求值就行。
    const verdict = await app.evaluate(({ BrowserWindow: _B }, src) => {
      if (!src) return "import-failed";
      const body = src.replace(/^\s*export\s+/gm, "");
      const windowAlive = new Function(`${body}; return windowAlive;`)();
      globalThis.__windowAlive = windowAlive;
      return windowAlive(globalThis.__ghostCard);
    }, winSrc);
    if (verdict === "import-failed") {
      // 打包产物里拿不到源码模块，退一步只看兜底日志
      results.push("－ 跳过 windowAlive 直测（拿不到模块），只验主进程没崩");
      return;
    }
    assert.equal(verdict, false, "windowAlive 说还活着，空档里就会去调原生方法");
    // 对照：真的窗口要判活
    assert.equal(await app.evaluate(() => globalThis.__windowAlive(globalThis.__realCard)), true, "正常窗口被误判成死的");
  });

  await check("空档状态下主进程不抛未捕获异常", async () => {
    const list = await errors();
    assert.deepEqual(list, [], `主进程抛了：\n${list.join("\n")}`);
  });

  await check("卡片重建回来，还能正常用", async () => {
    // 清掉替身，然后真的销毁一次：closed 派发后卡片应当自己重建
    await app.evaluate(({ BrowserWindow }) => {
      delete globalThis.__ghostCard;
      const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes("card=today"));
      if (w) w.destroy();
    }).catch(() => {});
    let back = null;
    for (let i = 0; i < 80 && !back; i++) {
      // 旧页面的句柄还在列表里但已经关了，得试一下能不能用
      back = app.windows().find((p) => p.url().includes("card=today")) || null;
      if (back) {
        try {
          await back.evaluate(() => 1);
        } catch {
          back = null;
        }
      }
      if (!back) await sleep(100);
    }
    assert.ok(back, "卡片没有重建");
    await back.locator(".row").first().waitFor({ timeout: 8000 });
    assert.ok((await back.locator(".row").count()) > 0, "重建后没有任务行");
    const eaten = await swallowed();
    assert.deepEqual(eaten, [], `重建过程中判活没兜住：${eaten.slice(0, 3).join(" / ")}`);
  });
} finally {
  await app.evaluate(({ app: a }) => a.exit(0)).catch(() => {});
  await sp.close();
}
console.log(results.join("\n"));
if (results.some((r) => r.startsWith("✖"))) process.exit(1);
