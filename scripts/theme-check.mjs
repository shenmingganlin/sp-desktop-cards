// theme-check.mjs — 皮肤自检（只连假 SP）：
//   1. 暖纸皮肤首帧生效；2. 设置里的「外观」打开皮肤窗口，12 套都在；
//   3. 选深夜，卡片不重载就变色；4. 外部 theme.json 能覆盖，删掉能回到手选。
// 用法：node scripts/theme-check.mjs（检查安装包：设 SPW_EXE）

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron } from "playwright-core";
import { startFakeSp } from "../test/fake-sp.js";
import { sampleData } from "../test/fixtures.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, ".smoke", "theme");
fs.rmSync(out, { recursive: true, force: true });
const userData = path.join(out, "user-data");
fs.mkdirSync(userData, { recursive: true });
fs.writeFileSync(path.join(userData, "settings.json"), JSON.stringify({
  version: 2,
  tourDone: true,
  theme: "warm-paper",
  mode: "top",
  cards: { today: { visible: true, bounds: { x: 200, y: 200, width: 320, height: 420 } } },
}));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sp = await startFakeSp({ data: sampleData(Date.now()) });
const app = await _electron.launch({
  ...(process.env.SPW_EXE ? { executablePath: process.env.SPW_EXE, args: [] } : { args: [root] }),
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
const waitFor = async (fn, ms = 5000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await fn()) return true;
    await sleep(100);
  }
  return !!(await fn());
};

try {
  let page = null;
  for (let i = 0; i < 100 && !page; i++) {
    page = app.windows().find((p) => p.url().includes("card=today")) || null;
    if (!page) await sleep(100);
  }
  assert.ok(page, "没等到今日卡片");
  await page.locator(".row").first().waitFor();

  const style = () => page.evaluate(() => ({
    theme: document.documentElement.dataset.theme,
    bg: getComputedStyle(document.body).backgroundColor,
    titleFont: getComputedStyle(document.getElementById("title")).fontFamily,
    border: getComputedStyle(document.body).borderTopWidth,
  }));

  await check("暖纸皮肤首帧生效（米纸底、衬线标题）", async () => {
    const s = await style();
    assert.equal(s.theme, "warm-paper");
    assert.equal(s.bg, "rgb(248, 244, 237)");
    assert.match(s.titleFont, /Noto Serif/i);
    await page.screenshot({ path: path.join(out, "warm-paper.png") });
  });

  // 设置 → 外观：皮肤一多就单独开窗口
  await page.evaluate(() => window.widget.action("openSettings"));
  let settings = null;
  for (let i = 0; i < 60 && !settings; i++) {
    settings = app.windows().find((p) => p.url().includes("settings.html")) || null;
    if (!settings) await sleep(100);
  }
  await settings.locator("#appearance-button").waitFor();
  await settings.screenshot({ path: path.join(out, "settings.png") });
  await settings.locator("#appearance-button").click();

  let appearance = null;
  for (let i = 0; i < 60 && !appearance; i++) {
    appearance = app.windows().find((p) => p.url().includes("appearance.html")) || null;
    if (!appearance) await sleep(100);
  }
  await appearance.locator(".grid .skin").first().waitFor();

  await check("外观窗口列出全部 12 套皮肤", async () => {
    const count = await appearance.locator(".skin").count();
    assert.equal(count, 12);
    assert.equal(await appearance.locator('.skin[data-skin="new-warm-paper"]').count(), 1);
    assert.equal(await appearance.locator('.skin[data-skin="coral"]').count(), 1);
    await appearance.screenshot({ path: path.join(out, "appearance.png") });
  });

  // 每张预览卡靠自己的 data-theme 拿颜色。「深夜」以前只写在 :root 上，没有 [data-theme="dark"] 规则，
  // 于是它跟着当前皮肤一起变（当前是暖纸时，深夜那张预览也是米纸色）。
  const previewOf = (id) =>
    appearance.evaluate((skin) => {
      const el = document.querySelector(`.preview[data-theme="${skin}"]`);
      const cs = getComputedStyle(el);
      return { bg: cs.backgroundColor, color: cs.color, accent: cs.getPropertyValue("--accent").trim() };
    }, id);
  const DARK_PREVIEW = { bg: "rgb(31, 31, 31)", color: "rgb(232, 232, 232)", accent: "#ff4d8d" };

  await check("深夜那张预览显示的是深夜，不跟着当前皮肤变", async () => {
    assert.deepEqual(await previewOf("dark"), DARK_PREVIEW);
    await appearance.locator('.skin[data-skin="coral"]').click();
    await waitFor(async () => (await style()).theme === "coral");
    assert.deepEqual(await previewOf("dark"), DARK_PREVIEW, "选了珊瑚之后深夜预览跟着变了");
    assert.equal((await previewOf("coral")).bg, "rgb(253, 246, 236)", "珊瑚预览不是珊瑚的底色");
    await appearance.locator('.skin[data-skin="warm-paper"]').click();
    await waitFor(async () => (await style()).theme === "warm-paper");
    assert.deepEqual(await previewOf("dark"), DARK_PREVIEW, "选了暖纸之后深夜预览跟着变了");
    assert.equal((await previewOf("warm-paper")).bg, "rgb(248, 244, 237)", "暖纸预览不是暖纸的底色");
  });

  // 回归：main.js 以前用 t.theme === "hana" 决定原生菜单的深浅，可那个 id 早被归一成 new-warm-paper 了，
  // 于是所有浅色皮肤配的都是深色原生菜单（⋯ 菜单、托盘菜单、原生对话框）。
  await check("浅色皮肤配浅色原生菜单，深色皮肤配深色", async () => {
    const expected = (id) => (["dark", "midnight", "midnight-contrast"].includes(id) ? "dark" : "light");
    for (const id of ["warm-paper", "coral", "new-warm-paper", "dark", "midnight"]) {
      await appearance.locator(`.skin[data-skin="${id}"]`).click();
      await waitFor(async () => (await style()).theme === id);
      const got = await app.evaluate(({ nativeTheme }) => nativeTheme.themeSource);
      assert.equal(got, expected(id), `${id} 的原生菜单深浅不对`);
    }
    await appearance.locator('.skin[data-skin="warm-paper"]').click();
    await waitFor(async () => (await style()).theme === "warm-paper");
  });

  await check("外观里选深夜，卡片不重载就变色", async () => {
    const before = page.url();
    await appearance.locator('.skin[data-skin="dark"]').click();
    await waitFor(async () => (await style()).theme === "dark");
    const s = await style();
    assert.equal(s.theme, "dark");
    assert.equal(s.bg, "rgb(31, 31, 31)");
    assert.equal(page.url(), before, "页面被重载了");
    await page.screenshot({ path: path.join(out, "dark.png") });
  });

  await appearance.locator("#done").click();
  await waitFor(() => !app.windows().some((p) => p.url().includes("appearance.html")), 2000);

  const external = path.join(userData, "theme.json");
  await check("外部 theme.json 覆盖手选皮肤（青夜），设置页显示来源", async () => {
    fs.writeFileSync(external, JSON.stringify({ theme: "midnight", source: "任务台检查" }));
    await waitFor(async () => (await style()).theme === "midnight", 5000);
    const s = await style();
    assert.equal(s.theme, "midnight");
    assert.equal(s.bg, "rgb(59, 74, 84)");
    await waitFor(async () => (await settings.locator("#theme-external").textContent()).includes("任务台检查"), 3000);
    assert.match(await settings.locator("#theme-external").textContent(), /任务台检查/);
    await page.screenshot({ path: path.join(out, "midnight.png") });
  });

  await check("删掉 theme.json 回到手选的深夜", async () => {
    fs.rmSync(external, { force: true });
    await waitFor(async () => (await style()).theme === "dark", 5000);
    assert.equal((await style()).theme, "dark");
  });
} finally {
  await app.evaluate(({ app: a }) => a.exit(0)).catch(() => {});
  await sp.close();
}
console.log(results.join("\n"));
if (results.some((r) => r.startsWith("✖"))) process.exit(1);
