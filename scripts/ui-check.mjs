// ui-check.mjs — 用 Playwright 驱动真实的小窗窗口点一遍，对着假 SP 检查操作是否真的发出去了。
// 用法：node scripts/ui-check.mjs   截图写到 .smoke/ui/

import assert from "node:assert/strict";
import fs from "node:fs";
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
fs.writeFileSync(path.join(userData, "settings.json"), JSON.stringify({ bounds: { x: 100, y: 100, width: 320, height: 470 } }));

const sp = await startFakeSp({ data: sampleData(Date.now()) });
const app = await _electron.launch({
  args: [root],
  env: { ...process.env, SPW_USER_DATA: userData, SPW_BASE_URL: sp.url, SPW_TOKEN: sp.token },
});
const page = await app.firstWindow();
const shot = (name) => page.screenshot({ path: path.join(out, `${name}.png`) });
const row = (title) => page.locator(".row", { has: page.locator(".title", { hasText: new RegExp(`^${title}$`) }) });
const task = (id) => sp.state.tasks.find((t) => t.id === id);
const until = async (fn, what) => {
  for (let i = 0; i < 50; i++) {
    if (await fn()) return;
    await page.waitForTimeout(100);
  }
  assert.fail(`等不到：${what}`);
};
const results = [];
const check = async (name, fn) => {
  try {
    await fn();
    results.push(`✔ ${name}`);
  } catch (error) {
    results.push(`✖ ${name}: ${error.message}`);
    await shot(`fail-${results.length}`);
  }
};

try {
  await page.locator(".row").first().waitFor();

  await check("勾选完成：SP 里任务变成已完成，出现撤销提示", async () => {
    await row("写周报").locator(".check").click();
    await until(() => task("report").isDone, "report.isDone");
    await page.locator("#toast", { hasText: "已完成「写周报」" }).waitFor();
    await shot("toast-undo");
  });

  await check("撤销：SP 里任务恢复未完成", async () => {
    await page.locator("#toast .link", { hasText: "撤销" }).click();
    await until(() => !task("report").isDone, "report 恢复");
    await row("写周报").locator(".check").waitFor();
  });

  await check("开始计时：悬停出现开始按钮，点击后 SP 当前任务切过去，顶栏更新", async () => {
    await row("站会").hover();
    await row("站会").locator(".play").click();
    await until(() => sp.state.current === "standup", "current = standup");
    await page.locator("#now-title", { hasText: "站会" }).waitFor();
    await until(async () => (await row("站会").getAttribute("class")).includes("current"), "行高亮");
  });

  await check("父任务没有开始按钮", async () => {
    assert.equal(await row("整理发布").locator(".play").count(), 0);
  });

  await check("停止计时：顶栏按钮停掉 SP 计时", async () => {
    await page.locator("#stop").click();
    await until(() => sp.state.current === null, "current = null");
    await page.locator("#now-title", { hasText: "没有在计时的任务" }).waitFor();
    await shot("stopped");
  });

  await check("勾选失败：界面撤回并提示原因", async () => {
    sp.state.failNext = { status: 500, code: "BOOM" };
    await row("评审设计稿").locator(".check").click();
    await page.locator("#toast", { hasText: "没成功" }).waitFor();
    assert.equal(task("review").isDone, false);
    await until(async () => !(await row("评审设计稿").getAttribute("class")).includes("done"), "撤回勾选");
  });

  await check("展开已完成", async () => {
    await page.locator(".done-group .link").click();
    await row("晨练").waitFor();
  });

  await check("设置面板：打开、改提前量后高亮跟着变", async () => {
    await page.locator("#toggle-settings").click();
    await page.locator("#settings h2").waitFor();
    await shot("settings");
    await page.locator("#set-upcoming").fill("5");
    await page.locator("#set-upcoming").press("Enter");
    await until(async () => !(await row("站会").getAttribute("class")).includes("upcoming"), "站会不再高亮");
    await until(() => JSON.parse(fs.readFileSync(path.join(userData, "settings.json"), "utf8")).upcomingMinutes === 5, "写盘");
    await page.locator("#settings .btn", { hasText: "完成" }).click();
  });

  await check("令牌：格式不对时拒绝保存", async () => {
    await page.locator("#toggle-settings").click();
    await page.locator("#set-token").fill("short");
    await page.locator("#settings .btn", { hasText: "保存令牌" }).click();
    await page.locator("#toast", { hasText: "32 位" }).waitFor();
    await page.locator("#settings .btn", { hasText: "完成" }).click();
  });

  // 高分屏下系统会把窗口尺寸取整到物理像素，所以只要求接近，不要求逐像素相等。
  const height = async () => (await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getContentBounds())).height;
  const near = (a, b) => Math.abs(a - b) <= 3;

  await check("折叠与展开：收成一行，展开后恢复，来回几次高度不漂", async () => {
    const tall = await height();
    for (let i = 0; i < 2; i++) {
      await page.locator("#collapse").click();
      await until(async () => near(await height(), 44), "收成一行");
      if (i === 0) await shot("collapsed");
      await page.locator("#collapse").click();
      await until(async () => near(await height(), tall), "恢复高度");
    }
    assert.ok(near(await height(), tall), `展开高度从 ${tall} 漂到 ${await height()}`);
  });

  await check("断线：保留旧数据并提示，恢复后自动消失", async () => {
    sp.state.down = true;
    await page.locator("#banner", { hasText: "连不上" }).waitFor({ timeout: 10000 });
    await page.locator("#now-sub.warn").waitFor();
    await shot("disconnected");
    sp.state.down = false;
    await page.locator("#banner").waitFor({ state: "hidden", timeout: 10000 });
  });

  await check("折叠时断线：顶栏直接说明", async () => {
    await page.locator("#collapse").click();
    await until(async () => near(await height(), 44), "收成一行");
    sp.state.down = true;
    await page.locator("#now-sub.warn", { hasText: "连不上" }).waitFor({ timeout: 10000 });
    await shot("collapsed-disconnected");
    sp.state.down = false;
    await until(async () => !(await page.locator("#now-sub").getAttribute("class"))?.includes("warn"), "恢复后警告消失");
    await page.locator("#collapse").click();
  });
} finally {
  await app.evaluate(({ app: a }) => a.exit(0)).catch(() => {});
  await sp.close();
}

console.log(results.join("\n"));
if (results.some((r) => r.startsWith("✖"))) process.exit(1);
