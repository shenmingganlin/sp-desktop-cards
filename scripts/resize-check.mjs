// resize-check.mjs — 「拉边改大小」的真机检查：
//   1. 八条边的把手都能拉动（0.2.2 左右两边常常拉不动）；2. 拉到别的卡片共线的边界会吸住；
//   3. 按住 Alt 不吸；4. 拉到屏幕边上会吸；5. 拉的时候拼在边上的卡片跟着让开。
// 会真的动鼠标，运行时别碰电脑。用法：node scripts/resize-check.mjs

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
const SetCursorPos = u.func("bool SetCursorPos(int x, int y)");
const mouseEvent = u.func("void mouse_event(uint32_t f, uint32_t dx, uint32_t dy, uint32_t d, uintptr_t e)");
const keybdEvent = u.func("void keybd_event(uint8_t vk, uint8_t scan, uint32_t f, uintptr_t e)");
const VK_MENU = 0x12;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, ".smoke", "resize");
fs.rmSync(out, { recursive: true, force: true });
const userData = path.join(out, "user-data");
fs.mkdirSync(userData, { recursive: true });
// 今日在左上，规划拼在它正下方、更宽（下边缘和今日右边缘共线时最容易看出吸没吸）
const BLANK = {
  today: { x: 400, y: 200, width: 320, height: 300 },
  planner: { x: 400, y: 506, width: 600, height: 300 },
};
fs.writeFileSync(path.join(userData, "settings.json"), JSON.stringify({ version: 2, tourDone: true, mode: "normal", cards: { today: { visible: true, bounds: BLANK.today }, planner: { visible: true, bounds: BLANK.planner } } }));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function drag(x0, y0, dx, dy, { alt = false } = {}) {
  if (alt) keybdEvent(VK_MENU, 0, 0, 0);
  SetCursorPos(Math.round(x0), Math.round(y0));
  await sleep(150);
  mouseEvent(2, 0, 0, 0, 0);
  await sleep(100);
  for (let i = 1; i <= 12; i++) {
    SetCursorPos(Math.round(x0 + (dx * i) / 12), Math.round(y0 + (dy * i) / 12));
    await sleep(30);
  }
  await sleep(150);
  mouseEvent(4, 0, 0, 0, 0);
  await sleep(350);
  if (alt) keybdEvent(VK_MENU, 0, 2, 0);
}

const sp = await startFakeSp({ data: sampleData(Date.now()) });
const app = await _electron.launch({ args: [root], env: { ...process.env, SPW_USER_DATA: userData, SPW_BASE_URL: sp.url, SPW_TOKEN: sp.token } });
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
  for (let i = 0; i < 100 && app.windows().length < 2; i++) await sleep(100);
  await sleep(1000);
  // 位置从设置文件读：窗口自己报的尺寸带着缩放取整的一两个像素，存下来的才是真正生效的逻辑位置
  const stored = async () => {
    await sleep(700); // 等存盘（合并 400ms）
    const s = JSON.parse(fs.readFileSync(path.join(userData, "settings.json"), "utf8"));
    return { today: s.cards.today.bounds, planner: s.cards.planner.bounds };
  };
  // 直接改窗口大小会触发跟着挪的逻辑，所以摆回原位后以读回来的值为准
  const reset = async () => {
    await app.evaluate(({ BrowserWindow }, box) => {
      for (const t of ["today", "planner"]) BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes(`card=${t}`))?.setBounds(box[t]);
    }, BLANK);
    await sleep(500);
    await app.evaluate(({ BrowserWindow }, box) => {
      for (const t of ["today", "planner"]) BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes(`card=${t}`))?.setBounds(box[t]);
    }, BLANK);
    await sleep(500);
    return stored();
  };

  await check("四个方向、右下角都拉得动（0.2.2 左右两边常常拉不动）", async () => {
    const b = await reset();
    const t = b.today;
    await drag(t.x + t.width - 2, t.y + Math.round(t.height / 2), 80, 0);
    assert.ok((await stored()).today.width > t.width + 50, "右边拉不动");

    const b2 = await reset();
    await drag(b2.today.x + 2, b2.today.y + Math.round(b2.today.height / 2), -80, 0);
    const after = (await stored()).today;
    assert.ok(after.x < b2.today.x - 50 && after.width > b2.today.width + 50, `左边拉不动：x=${after.x} w=${after.width}`);

    const b3 = await reset();
    await drag(b3.today.x + Math.round(b3.today.width / 2), b3.today.y + b3.today.height - 2, 0, 60);
    assert.ok((await stored()).today.height > b3.today.height + 40, "下边拉不动");

    const b4 = await reset();
    await drag(b4.today.x + b4.today.width - 2, b4.today.y + b4.today.height - 2, 40, 40);
    const corner = (await stored()).today;
    assert.ok(corner.width > b4.today.width + 20 && corner.height > b4.today.height + 20, "右下角拉不动");
  });

  await check("拉到和下面的卡片共线时会吸住", async () => {
    const b = await reset();
    const target = b.planner.x + b.planner.width; // 规划的下边缘在 1000
    const from = b.today.x + b.today.width;
    await drag(from - 2, b.today.y + Math.round(b.today.height / 2), target - from - 5, 0);
    const now = (await stored()).today;
    assert.equal(now.x + now.width, target, `没吸到共线：右边缘 ${now.x + now.width}，应为 ${target}`);
    await app.windows()[0].screenshot({ path: path.join(out, "snapped.png") }).catch(() => {});
  });

  await check("按住 Alt 拉就不吸", async () => {
    const b = await reset();
    const target = b.planner.x + b.planner.width;
    const from = b.today.x + b.today.width;
    await drag(from - 2, b.today.y + Math.round(b.today.height / 2), target - from - 5, 0, { alt: true });
    const now = (await stored()).today;
    assert.equal(now.x + now.width, target - 5, `Alt 还是吸了：右边缘 ${now.x + now.width}`);
  });

  await check("拉到屏幕边上会吸住", async () => {
    const area = await app.evaluate(({ screen }) => screen.getPrimaryDisplay().workArea);
    const right = area.x + area.width;
    const b = await reset();
    const t = b.today;
    await drag(t.x + t.width - 2, t.y + Math.round(t.height / 2), right - (t.x + t.width) - 6, 0);
    const now = (await stored()).today;
    assert.equal(now.x + now.width, right, `没吸到屏幕右边：${now.x + now.width}，应为 ${right}`);
  });

  await check("拉的时候拼在下面的卡片跟着让开", async () => {
    const b = await reset();
    const t = b.today;
    await drag(t.x + Math.round(t.width / 2), t.y + t.height - 2, 0, 60);
    const now = await stored();
    const grew = now.today.height - t.height;
    assert.ok(grew > 40, `今日没变高：${now.today.height}`);
    assert.equal(now.planner.y, b.planner.y + grew, "下面的卡片没跟着挪");
  });
} finally {
  await app.evaluate(({ app: a }) => a.exit(0)).catch(() => {});
  await sp.close();
}
console.log(results.join("\n"));
if (results.some((r) => r.startsWith("✖"))) process.exit(1);
