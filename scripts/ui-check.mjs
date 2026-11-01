// ui-check.mjs — 用 Playwright 驱动真实的卡片窗口点一遍，对着假 SP 检查操作是否真的发出去了。
// 用法：node scripts/ui-check.mjs   截图写到 .smoke/ui/
// 只连假 SP（SPW_BASE_URL），不会碰真实数据。

import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron } from "playwright-core";
import { startFakeSp } from "../test/fake-sp.js";
import { sampleData } from "../test/fixtures.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, ".smoke", "ui");
fs.rmSync(out, { recursive: true, force: true });
const userData = path.join(out, "user-data");
fs.mkdirSync(userData, { recursive: true });
const card = (x, y, width, height) => ({ visible: true, collapsed: false, bounds: { x, y, width, height } });
fs.writeFileSync(path.join(userData, "settings.json"), JSON.stringify({
  version: 2,
  cards: {
    focus: card(40, 40, 320, 132),
    today: card(40, 178, 320, 400),
    planner: card(366, 40, 320, 538),
    schedule: card(692, 40, 320, 538),
    month: card(1018, 40, 320, 470),
  },
}));

const pad2 = (n) => String(n).padStart(2, "0");
const dayStr = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const now = new Date();
const TODAY = dayStr(now);
const TOMORROW = dayStr(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1));

const sp = await startFakeSp({ data: sampleData(now.getTime()) });
const app = await _electron.launch({
  args: [root],
  env: { ...process.env, SPW_USER_DATA: userData, SPW_BASE_URL: sp.url, SPW_TOKEN: sp.token },
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, what, tries = 60) => {
  for (let i = 0; i < tries; i++) {
    if (await fn()) return;
    await sleep(100);
  }
  assert.fail(`等不到：${what}`);
};
const cardOf = (p) => new URL(p.url()).searchParams.get("card");
const pages = {};
await until(() => app.windows().filter((p) => cardOf(p)).length === 5, "五张卡片");
for (const p of app.windows()) if (cardOf(p)) pages[cardOf(p)] = p;
const { focus, today, planner, schedule, month } = pages;

const shot = (page, name) => page.screenshot({ path: path.join(out, `${name}.png`) });
const row = (page, title) => page.locator(".row", { has: page.locator(".title", { hasText: new RegExp(`^${title}$`) }) });
const task = (id) => sp.state.tasks.find((t) => t.id === id);
const posts = () => sp.state.bodies.filter((b) => b.method === "POST" && b.path === "/tasks").map((b) => b.body);
const bounds = (type) => app.evaluate(({ BrowserWindow }, t) => {
  const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes(`card=${t}`));
  return w ? w.getBounds() : null;
}, type);
const near = (a, b) => Math.abs(a - b) <= 3;

const results = [];
const check = async (name, fn) => {
  try {
    await fn();
    if (process.env.SPW_TRACE) console.log(name, JSON.stringify(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => w.webContents.getURL().includes("card=")).map((w) => [new URL(w.webContents.getURL()).searchParams.get("card"), w.getBounds()]))));
    results.push(`✔ ${name}`);
  } catch (error) {
    results.push(`✖ ${name}: ${error.message.split("\n")[0]}`);
    for (const [t, p] of Object.entries(pages)) await shot(p, `fail-${results.length}-${t}`).catch(() => {});
  }
};
try {
  await today.locator(".row").first().waitFor();
  for (const [t, p] of Object.entries(pages)) await shot(p, `start-${t}`);

  await check("今日：勾选完成，SP 里变成已完成，出现撤销；撤销后恢复", async () => {
    await row(today, "写周报").locator(".check").click();
    await until(() => task("report").isDone, "report.isDone");
    await today.locator("#toast", { hasText: "已完成「写周报」" }).waitFor();
    await today.locator("#toast .link", { hasText: "撤销" }).click();
    await until(() => !task("report").isDone, "report 恢复");
  });

  await check("开始计时：SP 当前任务切过去，专注卡片和行高亮跟着变", async () => {
    await row(today, "站会").hover();
    await row(today, "站会").locator(".play").click();
    await until(() => sp.state.current === "standup", "current = standup");
    await focus.locator(".focus-task", { hasText: "站会" }).waitFor();
    await until(async () => (await row(today, "站会").getAttribute("class")).includes("current"), "行高亮");
    assert.equal(await row(today, "整理发布").locator(".play").count(), 0, "父任务不该有开始按钮");
  });

  await check("专注卡片：停止 SP 计时", async () => {
    await focus.locator(".focus-btns .btn[title='停止 SP 计时']").click();
    await until(() => sp.state.current === null, "current = null");
    await focus.locator(".focus-task", { hasText: "没有在计时的任务" }).waitFor();
  });

  await check("番茄钟：开始时让 SP 给当前任务计时，暂停时停，结束时停", async () => {
    await row(today, "写周报").hover();
    await row(today, "写周报").locator(".play").click();
    await until(() => sp.state.current === "report", "current = report");
    await focus.locator(".focus-btns .btn.primary").click();
    await focus.locator(".focus-phase", { hasText: "专注" }).waitFor();
    await shot(focus, "pomodoro");
    await focus.locator(".focus-btns .btn[title='暂停']").click();
    await until(() => sp.state.current === null, "暂停后 SP 停止计时");
    await focus.locator(".focus-phase", { hasText: "已暂停" }).waitFor();
    await focus.locator(".focus-btns .btn[title='继续']").click();
    await until(() => sp.state.current === "report", "继续后 SP 接着计时");
    await focus.locator(".focus-btns .btn[title='结束番茄钟']").click();
    await until(() => sp.state.current === null, "结束后 SP 停止计时");
  });

  await check("勾选失败：界面撤回并提示原因", async () => {
    sp.state.failNext = { status: 500, code: "BOOM", match: "PATCH /tasks" };
    await row(today, "站会").locator(".check").click();
    await today.locator("#toast", { hasText: "没成功" }).waitFor();
    assert.equal(task("standup").isDone, false);
    await until(async () => !(await row(today, "站会").getAttribute("class")).includes("done"), "撤回勾选");
  });

  await check("今日：顶栏 + 快速新建到今天，输入框留着接着加", async () => {
    await today.locator("#tools .icon", { hasText: "+" }).click();
    const input = today.locator("input[data-add]");
    await input.waitFor();
    await until(() => today.evaluate(() => document.activeElement?.dataset?.add === "1"), "输入框获得焦点");
    await input.fill("小窗新建一");
    await input.press("Enter");
    await until(() => posts().some((b) => b.title === "小窗新建一"), "POST /tasks");
    const body = posts().find((b) => b.title === "小窗新建一");
    assert.deepEqual(body, { title: "小窗新建一", projectId: "INBOX_PROJECT", tagIds: [], dueDay: TODAY });
    await today.locator("#toast", { hasText: "已添加" }).waitFor();
    await row(today, "小窗新建一").waitFor();
    assert.equal(await input.inputValue(), "");
    await shot(today, "quick-add");
    await input.press("Escape");
    await input.waitFor({ state: "detached" });
    // 提示条 4 秒后自己消失（卡片窗口不在前台时计时器也不能停）
    await today.locator("#toast").waitFor({ state: "hidden", timeout: 7000 });
  });

  await check("规划：在明天那栏新建", async () => {
    const tomorrow = planner.locator(".day").nth(1);
    await tomorrow.hover();
    await tomorrow.locator(".day-head .icon").click();
    const input = planner.locator("input[data-add]");
    await input.fill("明天的事");
    await input.press("Enter");
    await until(() => posts().some((b) => b.title === "明天的事"), "POST");
    assert.equal(posts().find((b) => b.title === "明天的事").dueDay, TOMORROW);
    await row(planner, "明天的事").waitFor();
    await input.press("Escape");
  });

  await check("规划：重复任务投影和截止日显示出来", async () => {
    await planner.locator(".row.repeat", { hasText: "读书" }).first().waitFor();
    await planner.locator(".row.deadline", { hasText: "交房租" }).waitFor();
  });
  await check("日程：点时间轴空白处在那个时间新建，只带 dueWithTime", async () => {
    // 合成一次点击：16:00 那条线下面一点。时间轴可能滚过，按元素位置算
    await schedule.evaluate(() => {
      const line = document.querySelector(".timeline");
      const hour = [...line.querySelectorAll(".hour")].find((h) => h.textContent === "16:00");
      hour.scrollIntoView({ block: "center" });
      const r = hour.getBoundingClientRect();
      line.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: r.left + 100, clientY: r.top + 5 }));
    });
    const input = schedule.locator("input[data-add]");
    await schedule.locator(".add .when", { hasText: "16:00" }).waitFor();
    await input.fill("下午的会");
    await input.press("Enter");
    await until(() => posts().some((b) => b.title === "下午的会"), "POST");
    const body = posts().find((b) => b.title === "下午的会");
    assert.equal(body.dueWithTime, new Date(now.getFullYear(), now.getMonth(), now.getDate(), 16, 0).getTime());
    assert.ok(!("dueDay" in body));
    await schedule.locator(".block", { hasText: "下午的会" }).waitFor();
    await shot(schedule, "schedule-add");
    await input.press("Escape");
  });

  await check("日程：翻到明天再回到今天", async () => {
    await schedule.locator("#tools .icon[title='后一天']").click();
    await schedule.locator("#sub", { hasText: "明天" }).waitFor();
    await schedule.locator(".block", { hasText: "看牙医" }).waitFor();
    await schedule.locator("#tools .icon", { hasText: "今天" }).click();
    await schedule.locator("#sub", { hasText: "今天" }).waitFor();
  });

  await check("月历：点一天看那天的内容，在那天新建", async () => {
    await month.locator(`.cell[title^='${TOMORROW}']`).click();
    await month.locator(".month-day .rel", { hasText: "明天" }).waitFor();
    await month.locator(".month-day .row", { hasText: "看牙医" }).waitFor();
    await month.locator(".month-day .day-head .icon").click();
    const input = month.locator("input[data-add]");
    await input.fill("月历里加的");
    await input.press("Enter");
    await until(() => posts().some((b) => b.title === "月历里加的"), "POST");
    assert.equal(posts().find((b) => b.title === "月历里加的").dueDay, TOMORROW);
    await input.press("Escape");
    await shot(month, "month-selected");
    await month.locator("#tools .icon", { hasText: "今天" }).click();
    await month.locator(".month-day .rel", { hasText: "今天" }).waitFor();
  });

  await check("折叠：收成一行，下面拼着的卡片跟上来；展开后回原位，来回不漂", async () => {
    const f0 = await bounds("focus");
    const t0 = await bounds("today");
    for (let i = 0; i < 2; i++) {
      await focus.locator("#collapse").click();
      await until(async () => near((await bounds("focus")).height, 34), "专注收成一行");
      await until(async () => near((await bounds("today")).y, f0.y + 34 + 6), "今日跟着上移");
      if (i === 0) {
        await focus.locator("#sub", { hasText: "没有在计时" }).waitFor();
        await shot(focus, "collapsed");
      }
      await focus.locator("#drag").dblclick();
      await until(async () => near((await bounds("focus")).height, f0.height), "专注展开");
      await until(async () => near((await bounds("today")).y, t0.y), "今日回到原位");
    }
    const t1 = await bounds("today");
    assert.ok(near(t1.y, t0.y) && near(t1.height, t0.height), `今日从 ${JSON.stringify(t0)} 漂到 ${JSON.stringify(t1)}`);
  });

  await check("断线：卡片保留旧数据并提示，恢复后自动消失", async () => {
    sp.state.down = true;
    await today.locator("#banner", { hasText: "连不上" }).waitFor({ timeout: 10000 });
    await today.locator("#sub.warn").waitFor();
    await planner.locator("#body.stale").waitFor();
    await shot(today, "disconnected");
    sp.state.down = false;
    await today.locator("#banner").waitFor({ state: "hidden", timeout: 10000 });
    await until(async () => !(await today.locator("#sub").getAttribute("class"))?.includes("warn"), "警告消失");
  });
  // ── 设置窗口 ──
  await focus.evaluate(() => window.widget.action("openSettings"));
  await until(() => app.windows().some((p) => p.url().endsWith("settings.html")), "设置窗口");
  const settingsPage = app.windows().find((p) => p.url().endsWith("settings.html"));
  await settingsPage.locator("#conn.ok").waitFor();
  await shot(settingsPage, "settings");
  const saved = () => JSON.parse(fs.readFileSync(path.join(userData, "settings.json"), "utf8"));

  await check("设置：改规划天数，卡片跟着变并写盘", async () => {
    await settingsPage.locator("[data-key='plannerDays']").fill("3");
    await settingsPage.locator("[data-key='plannerDays']").press("Enter");
    await until(async () => (await planner.locator(".day").count()) === 3, "规划只剩 3 天");
    await until(() => saved().plannerDays === 3, "写盘");
  });

  await check("设置：选项目后，新建的任务进那个项目", async () => {
    await settingsPage.locator("#project").selectOption("work");
    await until(() => saved().quickAddProjectId === "work", "写盘");
    await today.locator("#tools .icon", { hasText: "+" }).click();
    await today.locator("input[data-add]").fill("进工作项目");
    await today.locator("input[data-add]").press("Enter");
    await until(() => posts().some((b) => b.title === "进工作项目"), "POST");
    assert.equal(posts().find((b) => b.title === "进工作项目").projectId, "work");
    await today.locator("input[data-add]").press("Escape");
    await settingsPage.locator("#project").selectOption("");
  });

  await check("设置：关掉月历卡片再打开", async () => {
    await settingsPage.locator("[data-card='month']").uncheck();
    await until(() => !app.windows().some((p) => cardOf(p) === "month"), "月历窗口关掉");
    await until(() => saved().cards.month.visible === false, "写盘");
    await settingsPage.locator("[data-card='month']").check();
    await until(() => app.windows().some((p) => cardOf(p) === "month"), "月历窗口回来");
    pages.month = app.windows().find((p) => cardOf(p) === "month");
    await pages.month.locator(".cell").first().waitFor();
    const b = await bounds("month");
    assert.ok(near(b.x, 1018) && near(b.y, 40), `月历回到原位，实际 ${JSON.stringify(b)}`);
  });

  await check("设置：显示方式改成普通窗口再改回置顶", async () => {
    const onTop = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => w.webContents.getURL().includes("card=")).map((w) => w.isAlwaysOnTop()));
    assert.ok((await onTop()).every(Boolean));
    await settingsPage.locator("[data-key='mode']").selectOption("normal");
    await until(async () => (await onTop()).every((v) => !v), "都不置顶");
    await settingsPage.locator("[data-key='mode']").selectOption("top");
    await until(async () => (await onTop()).every(Boolean), "都置顶");
  });

  await check("设置：令牌格式不对时拒绝保存", async () => {
    await settingsPage.locator("#token").fill("short");
    await settingsPage.locator("#token-save").click();
    await settingsPage.locator("#toast", { hasText: "32 位" }).waitFor();
  });
  // ── 拖动：要真的按下鼠标（主进程会查物理按键状态），用 user32 发系统级鼠标事件 ──
  const require = createRequire(import.meta.url);
  const u = require("koffi").load("user32.dll");
  const SetCursorPos = u.func("bool SetCursorPos(int x, int y)");
  const mouseEvent = u.func("void mouse_event(uint32_t f, uint32_t dx, uint32_t dy, uint32_t d, uintptr_t e)");
  const keybdEvent = u.func("void keybd_event(uint8_t vk, uint8_t scan, uint32_t f, uintptr_t e)");
  const cursor = () => app.evaluate(({ screen }) => screen.getCursorScreenPoint());
  const ALT = 0x12;
  async function drag(type, dx, dy, { alt = false } = {}) {
    const b = await bounds(type);
    const x = b.x + 60;
    const y = b.y + 16;
    SetCursorPos(x, y);
    await sleep(80);
    if (alt) keybdEvent(ALT, 0, 0, 0);
    mouseEvent(0x0002, 0, 0, 0, 0); // 左键按下
    await sleep(120);
    for (let i = 1; i <= 10; i++) {
      SetCursorPos(Math.round(x + (dx * i) / 10), Math.round(y + (dy * i) / 10));
      await sleep(30);
    }
    await sleep(100);
    mouseEvent(0x0004, 0, 0, 0, 0); // 左键松开
    if (alt) keybdEvent(ALT, 0, 0x0002, 0);
    await sleep(400);
  }
  const all = async () => Object.fromEntries(await Promise.all(["focus", "today", "planner", "schedule", "month"].map(async (t) => [t, await bounds(t)])));
  const moved = (a, b, dx, dy) => near(b.x - a.x, dx) && near(b.y - a.y, dy);

  SetCursorPos(500, 700);
  await sleep(100);
  const p = await cursor();
  const calibrated = near(p.x, 500) && near(p.y, 700);
  if (!calibrated) results.push(`✖ 拖动：系统缩放下光标坐标对不上（设 500,700 读到 ${p.x},${p.y}），跳过拖动检查`);

  if (calibrated) {
    await check("拖动：拼在一起的五张卡片整组一起走", async () => {
      const before = await all();
      await drag("focus", 30, 40);
      const after = await all();
      for (const t of Object.keys(before)) assert.ok(moved(before[t], after[t], 30, 40), `${t} 应该跟着挪 30,40：${JSON.stringify(before[t])} → ${JSON.stringify(after[t])}`);
      await until(() => near(saved().cards.month.bounds.x, after.month.x), "位置写盘");
    });

    await check("拖动：按住 Alt 只拖一张；拖回去时吸附拼好", async () => {
      const before = await all();
      await drag("month", 60, 220, { alt: true });
      const after = await all();
      assert.ok(moved(before.month, after.month, 60, 220), `月历应该单独挪：${JSON.stringify(after.month)}`);
      assert.ok(moved(before.schedule, after.schedule, 0, 0), "日程不该动");
      // 拖回到离原位差几像素的地方，靠吸附对齐
      await drag("month", -64, -216, { alt: true });
      const back = await bounds("month");
      assert.ok(near(back.x, before.month.x) && near(back.y, before.month.y), `应吸附回 ${before.month.x},${before.month.y}，实际 ${back.x},${back.y}`);
    });

    await check("改大小：拖专注的下边拉高，下面的今日跟着往下", async () => {
      const f = await bounds("focus");
      const t = await bounds("today");
      const x = f.x + 150;
      const y = f.y + f.height + 1; // 无边框窗口的缩放边从边线往外几个像素，正好落在卡片间的空隙里
      SetCursorPos(x, y);
      await sleep(100);
      mouseEvent(0x0002, 0, 0, 0, 0);
      for (let i = 1; i <= 8; i++) {
        SetCursorPos(x, y + i * 5);
        await sleep(40);
      }
      mouseEvent(0x0004, 0, 0, 0, 0);
      await sleep(400);
      const f2 = await bounds("focus");
      const t2 = await bounds("today");
      assert.ok(f2.height > f.height + 20, `专注没被拉高：${f.height} → ${f2.height}`);
      assert.ok(near(t2.y - t.y, f2.height - f.height), `今日应下移 ${f2.height - f.height}，实际 ${t2.y - t.y}`);
      assert.ok(near(t2.height, t.height), "今日高度不变");
    });

    await check("锁定：锁定后拖不动", async () => {
      await settingsPage.locator("[data-key='locked']").check();
      await until(() => saved().locked === true, "写盘");
      const before = await bounds("today");
      await drag("today", 50, 50);
      assert.ok(moved(before, await bounds("today"), 0, 0), "锁定后不该动");
      await settingsPage.locator("[data-key='locked']").uncheck();
    });
  }
} finally {
  await app.evaluate(({ app: a }) => a.exit(0)).catch(() => {});
  await sp.close();
}

console.log(results.join("\n"));
if (results.some((r) => r.startsWith("✖"))) process.exit(1);
