// 小窗自己的逻辑：快速新建、番茄钟、吸附拼接、设置迁移。都是纯函数。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import * as pomo from "../src/main/pomodoro.js";
import { INBOX, taskFields } from "../src/main/quickadd.js";
import { CARD_SIZE, DEFAULTS, GAP, migrate, sanitize } from "../src/main/settings.js";
import { defaultSpot, followResize, groupOf, isOnScreen, snapMove } from "../src/main/snap.js";
import { downloadFile, fetchLatest, isNewer, parseVersion, pickAssets } from "../src/main/update.js";

const MIN = 60_000;

test("快速新建：只有日期写 dueDay，带时间只写 dueWithTime，项目总是写明", () => {
  assert.deepEqual(taskFields({ title: "  买牛奶 ", day: "2026-11-03" }), {
    ok: true,
    fields: { title: "买牛奶", projectId: INBOX, tagIds: [], dueDay: "2026-11-03" },
  });
  const timed = taskFields({ title: "开会", day: "2026-11-03", minute: 14 * 60 + 30 }, { projectId: "work", projectIds: ["work"] });
  assert.equal(timed.fields.projectId, "work");
  assert.equal(timed.fields.dueWithTime, new Date(2026, 10, 3, 14, 30).getTime());
  assert.ok(!("dueDay" in timed.fields));
  // 一天从 4 点开始时，凌晨 1 点是 25*60 分
  assert.equal(taskFields({ title: "x", day: "2026-11-03", minute: 25 * 60 }).fields.dueWithTime, new Date(2026, 10, 4, 1, 0).getTime());
  // 选的项目已经没了：退回收件箱
  assert.equal(taskFields({ title: "x", day: "2026-11-03" }, { projectId: "gone", projectIds: ["work"] }).fields.projectId, INBOX);
});

test("快速新建：不合法的输入给出原因", () => {
  const msg = (input) => taskFields(input).message;
  assert.match(msg({ title: "  ", day: "2026-11-03" }), /标题不能为空/);
  assert.match(msg({ title: "x".repeat(501), day: "2026-11-03" }), /太长/);
  assert.match(msg({ title: "x", day: "11/03" }), /日期/);
  assert.match(msg({ title: "x", day: "2026-11-03", minute: 1.5 }), /时间/);
  assert.match(msg({ title: "x", day: "2026-11-03", minute: -1 }), /时间/);
  assert.match(msg({ title: "x", day: "2026-11-03", minute: 48 * 60 }), /时间/);
  assert.equal(taskFields(null).ok, false);
});

const cfg = { ...pomo.DEFAULT_POMODORO, longEvery: 2 };

test("番茄钟：专注 → 短休息 → 专注 → 长休息，按设置让 SP 计时", () => {
  let s = pomo.createState();
  let r = pomo.start(s, cfg, 0, "task-1");
  assert.deepEqual(r.effects, [{ type: "track", taskId: "task-1" }]);
  s = r.state;
  assert.equal(s.endsAt, 25 * MIN);
  assert.deepEqual(pomo.tick(s, cfg, 25 * MIN - 1).effects, [], "没到点什么都不做");

  r = pomo.tick(s, cfg, 25 * MIN);
  s = r.state;
  assert.equal(s.phase, "short");
  assert.equal(s.status, "ready");
  assert.equal(s.doneToday, 1);
  assert.deepEqual(r.effects.map((e) => e.type), ["untrack", "notify"]);

  r = pomo.resume(s, cfg, 30 * MIN);
  assert.deepEqual(r.effects, [], "休息时不计时");
  s = pomo.tick(r.state, cfg, 35 * MIN).state;
  assert.equal(s.phase, "work");
  s = pomo.resume(s, cfg, 36 * MIN).state;
  s = pomo.tick(s, cfg, 61 * MIN).state;
  assert.equal(s.phase, "long");
  assert.equal(s.doneToday, 2);
  assert.equal(s.streak, 0);
  assert.equal(s.remainingMs, 15 * MIN);
});

test("番茄钟：暂停、跳过、结束、自动下一阶段、跨天清零", () => {
  let s = pomo.start(pomo.createState(), cfg, 0, "t").state;
  let r = pomo.pause(s, cfg, 10 * MIN);
  assert.equal(r.state.remainingMs, 15 * MIN);
  assert.deepEqual(r.effects, [{ type: "untrack", taskId: "t" }]);
  r = pomo.resume(r.state, cfg, 20 * MIN);
  assert.equal(r.state.endsAt, 35 * MIN);

  r = pomo.skip(r.state, cfg, 21 * MIN);
  assert.equal(r.state.phase, "short");
  assert.equal(r.state.doneToday, 0, "跳过的专注不计数");
  assert.deepEqual(pomo.stop(r.state, cfg).effects, [], "休息时结束不用停 SP");
  assert.equal(pomo.stop(r.state, cfg).state.status, "idle");

  const auto = { ...cfg, autoNext: true };
  s = pomo.start(pomo.createState(), auto, 0, null).state;
  r = pomo.tick(s, auto, 25 * MIN);
  assert.equal(r.state.status, "running");
  assert.deepEqual(r.effects.map((e) => e.type), ["notify"], "没关联任务时不碰 SP");

  const off = { ...cfg, linkTracking: false };
  assert.deepEqual(pomo.start(pomo.createState(), off, 0, "t").effects, []);

  const y = { ...pomo.createState({ day: "2026-11-01", doneToday: 5, streak: 1 }) };
  assert.equal(pomo.rollDay(y, "2026-11-02").doneToday, 0);
  assert.equal(pomo.rollDay(y, "2026-11-01"), y);
});
test("番茄钟：重启后接着走，关着时到点的直接进入下一阶段、不补发提醒", () => {
  const s = pomo.start(pomo.createState(), cfg, 0, "t").state;
  const saved = pomo.sessionOf(s);
  assert.equal(pomo.sessionOf(pomo.createState()), null, "没在走时不存");

  const fresh = pomo.createState({ day: "d", doneToday: 2, streak: 0 });
  const back = pomo.restore(fresh, saved, cfg, 10 * MIN);
  assert.equal(back.status, "running");
  assert.equal(back.endsAt, 25 * MIN);
  assert.equal(back.doneToday, 2, "今天的番茄数不被冲掉");

  const late = pomo.restore(fresh, saved, { ...cfg, autoNext: true }, 40 * MIN);
  assert.equal(late.phase, "short");
  assert.equal(late.status, "ready", "关着时到点的，开了也等你点开始");
  assert.equal(late.doneToday, 3);

  const paused = pomo.pause(s, cfg, 5 * MIN).state;
  assert.equal(pomo.restore(fresh, pomo.sessionOf(paused), cfg, 999 * MIN).remainingMs, 20 * MIN, "暂停的不受时间影响");
  assert.equal(pomo.restore(fresh, { phase: "work", status: "running", endsAt: "x", durationMs: 1 }, cfg, 0), fresh, "坏数据不恢复");
  assert.equal(pomo.restore(fresh, null, cfg, 0), fresh);
});

test("番茄钟：到点的提醒带上提示音种类", () => {
  const s = pomo.start(pomo.createState(), cfg, 0, null).state;
  const r = pomo.tick(s, cfg, 25 * MIN);
  assert.equal(r.effects.find((e) => e.type === "notify").sound, "work");
  const b = pomo.tick(pomo.resume(r.state, cfg, 25 * MIN).state, cfg, 30 * MIN);
  assert.equal(b.effects.find((e) => e.type === "notify").sound, "break");
});

// 拼在一起的一列：a 在上，b 在 a 下面，c 在 b 下面；d 拼在 a 右边；e 离得远
const H = 100;
const rect = (x, y, width = 300, height = H) => ({ x, y, width, height });
const layout = () => new Map([
  ["a", rect(0, 0)],
  ["b", rect(0, H + GAP)],
  ["c", rect(0, 2 * (H + GAP))],
  ["d", rect(300 + GAP, 0)],
  ["e", rect(1000, 600)],
]);

test("拼接：连通的整组一起拖，远的不算", () => {
  assert.deepEqual([...groupOf(layout(), "b")].sort(), ["a", "b", "c", "d"]);
  assert.deepEqual([...groupOf(layout(), "e")], ["e"]);
});

test("吸附：靠近别的卡片边缘时吸过去并对齐", () => {
  const others = [rect(0, 0)];
  // 在 a 右边差 4 像素、往下错开 3 像素：吸到间距 GAP，顶边对齐
  assert.deepEqual(snapMove(rect(310, 3), others, []), { dx: -4, dy: -3 });
  // 离得远：不动
  assert.deepEqual(snapMove(rect(400, 300), others, []), { dx: 0, dy: 0 });
  // 屏幕边缘也吸
  assert.deepEqual(snapMove(rect(1610, 500), [], [{ x: 0, y: 0, width: 1920, height: 1040 }]), { dx: 10, dy: 0 });
});

test("折叠和改大小：下面拼着的卡片连锁跟着挪，旁边的不动", () => {
  const before = rect(0, 0);
  const moves = followResize(layout(), "a", before, { ...before, height: 34 });
  assert.deepEqual(Object.fromEntries(moves), { b: { dx: 0, dy: -66 }, c: { dx: 0, dy: -66 } });
  // 拉宽 a：右边的 d 跟着往右
  assert.deepEqual(Object.fromEntries(followResize(layout(), "a", before, { ...before, width: 340 })), { d: { dx: 40, dy: 0 } });
  // 从上边拉高 b：上面的 a 和 d 往上（d 拼在 a 右边，不在 b 上方，所以只有 a）
  const b = rect(0, H + GAP);
  assert.deepEqual(Object.fromEntries(followResize(layout(), "b", b, { ...b, y: b.y - 20, height: H + 20 })), { a: { dx: 0, dy: -20 } });
});

test("位置：拔掉显示器后找回来，新卡片沿右边往下排", () => {
  const area = { x: 0, y: 0, width: 1920, height: 1040 };
  assert.equal(isOnScreen(rect(5000, 100), [area]), false);
  assert.equal(isOnScreen(rect(100, 100), [area]), true);
  const first = defaultSpot(CARD_SIZE.today, [], area);
  assert.deepEqual(first, { x: 1580, y: 20, ...CARD_SIZE.today });
  assert.equal(defaultSpot(CARD_SIZE.focus, [first], area).y, 20 + CARD_SIZE.today.height + GAP);
});

test("设置：0.1.0 的单窗口设置迁移成卡片，「专注」拼在「今日」上方", () => {
  const old = { bounds: { x: 100, y: 100, width: 320, height: 470 }, collapsed: true, alwaysOnTop: false, opacity: 0.8, showDone: true };
  const s = sanitize(migrate(old));
  assert.equal(s.version, 2);
  assert.equal(s.mode, "normal");
  assert.equal(s.opacity, 0.8);
  assert.equal(s.showDone, true);
  assert.deepEqual(s.cards.focus, { visible: true, collapsed: false, bounds: { x: 100, y: 100, width: 320, height: 132 } });
  assert.deepEqual(s.cards.today, { visible: true, collapsed: true, bounds: { x: 100, y: 238, width: 320, height: 332 } });
  assert.equal(s.cards.planner.visible, false);
  assert.ok(!("bounds" in s) && !("collapsed" in s) && !("alwaysOnTop" in s));
  // 置顶是默认；没存过位置的只换格式
  assert.equal(sanitize(migrate({})).mode, "top");
  assert.equal(sanitize(migrate({})).cards.today.bounds, null);
  // 已经是新格式的不动
  const v2 = { ...DEFAULTS, mode: "desktop" };
  assert.equal(migrate(v2), v2);
});

test("设置：合并一张卡片、番茄钟按字段收敛", () => {
  const base = sanitize(null);
  const s = sanitize({ cards: { month: { visible: true } }, pomodoro: { workMin: 999, autoNext: true, evil: 1 } }, base);
  assert.equal(s.cards.month.visible, true);
  assert.equal(s.cards.today.visible, true, "没提到的卡片保持原样");
  assert.equal(s.pomodoro.workMin, 180);
  assert.equal(s.pomodoro.shortMin, 5);
  assert.equal(s.pomodoro.autoNext, true);
  assert.ok(!("evil" in s.pomodoro));
  assert.equal(sanitize({ mode: "floating" }).mode, "top");
  assert.equal(sanitize({ scheduleStartHour: 20, scheduleEndHour: 10 }).scheduleEndHour, 21);
  assert.equal(sanitize({ plannerDays: 100 }).plannerDays, 14);
  const d = sanitize(null).pomodoro;
  assert.deepEqual([d.sound, d.surface, d.resume, d.confirmStop], [true, true, false, false], "提示音和浮到最前默认开，另外两项默认关");
  assert.equal(sanitize({ pomodoro: { resume: "yes" } }).pomodoro.resume, false);
  assert.equal(sanitize({ tourDone: true }).tourDone, true);
  assert.equal(sanitize({}).tourDone, false, "旧版升级上来也看一次教程");
  assert.equal(sanitize({ altHints: 1e9 }).altHints, 99);
  const kept = sanitize({ pomodoroSession: { phase: "work", status: "running", endsAt: 1, durationMs: 2, taskId: "t", evil: 1 } });
  assert.ok(!("evil" in kept.pomodoroSession));
  assert.equal(sanitize({ pomodoroSession: null }, kept).pomodoroSession, null);
});

test("检查更新：版本号比较", () => {
  assert.deepEqual(parseVersion("v0.2.10"), [0, 2, 10]);
  assert.deepEqual(parseVersion("0.2.1"), [0, 2, 1]);
  assert.equal(parseVersion("latest"), null);
  assert.equal(parseVersion(undefined), null);
  assert.equal(isNewer("0.2.10", "0.2.9"), true, "按数字比，不是按字符串");
  assert.equal(isNewer("v0.3.0", "0.2.99"), true);
  assert.equal(isNewer("0.2.1", "0.2.1"), false);
  assert.equal(isNewer("0.2.0", "0.2.1"), false);
  assert.equal(isNewer("nightly", "0.2.1"), false, "认不出来就当没更新");
});

test("检查更新：从 Release 里挑安装包", () => {
  const assets = [
    { name: "sp-today-widget-0.2.2-setup.exe", browser_download_url: "https://x/setup", size: 10 },
    { name: "sp-today-widget-0.2.2-win-x64.zip", browser_download_url: "https://x/zip", size: 20 },
    { name: "sp-today-widget-0.2.1-setup.exe", browser_download_url: "https://x/old" },
  ];
  const picked = pickAssets({ assets }, "0.2.2");
  assert.equal(picked.setup.url, "https://x/setup");
  assert.equal(picked.zip.size, 20);
  assert.equal(pickAssets({ assets }, "0.2.3").setup, null);
  assert.equal(pickAssets({}, "0.2.2").zip, null);
});

test("检查更新：最新版本、404、没网都给出可用的结果", async () => {
  const release = {
    tag_name: "v0.2.2",
    html_url: "https://github.com/x/releases/tag/v0.2.2",
    assets: [{ name: "sp-today-widget-0.2.2-setup.exe", browser_download_url: "https://x/setup", size: 5 }],
  };
  const ok = await fetchLatest({ fetchImpl: async () => ({ ok: true, json: async () => release }) });
  assert.equal(ok.version, "0.2.2");
  assert.equal(ok.setup.url, "https://x/setup");
  assert.equal(ok.page, release.html_url);
  assert.equal(await fetchLatest({ fetchImpl: async () => ({ ok: false, status: 404 }) }), null);
  assert.equal(await fetchLatest({ fetchImpl: async () => { throw new Error("offline"); } }), null);
  assert.equal(await fetchLatest({ fetchImpl: async () => ({ ok: true, json: async () => { throw new Error("bad json"); } }) }), null);
  assert.equal(await fetchLatest({ fetchImpl: async () => ({ ok: true, json: async () => ({ tag_name: "nope" }) }) }), null);
  // 预发布和草稿不提示
  assert.equal(await fetchLatest({ fetchImpl: async () => ({ ok: true, json: async () => ({ ...release, prerelease: true }) }) }), null);
});

test("检查更新：下载报进度，下完才改名，半路失败不留文件", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spw-update-"));
  const body = "0123456789";
  const response = () => new Response(body, { headers: { "content-length": String(body.length) } });
  const seen = [];
  const file = await downloadFile("https://x/setup.exe", dir, "a.exe", { fetchImpl: async () => response(), onProgress: (p) => seen.push(p) });
  assert.equal(fs.readFileSync(file, "utf8"), body);
  assert.equal(seen.at(-1), 1, "最后报 100%");
  assert.deepEqual(fs.readdirSync(dir), ["a.exe"], "不留 .part");
  // 长度对不上：报错并清理
  const bad = await downloadFile("https://x/b", dir, "b.exe", {
    fetchImpl: async () => new Response(body, { headers: { "content-length": "999" } }),
  }).then(() => "没报错", (e) => e.message);
  assert.match(bad, /不完整/);
  assert.deepEqual(fs.readdirSync(dir).sort(), ["a.exe"]);
  // HTTP 错误
  const err = await downloadFile("https://x/c", dir, "c.exe", { fetchImpl: async () => ({ ok: false, status: 500 }) }).then(() => "没报错", (e) => e.message);
  assert.match(err, /500/);
  assert.ok(fs.existsSync(file));
  fs.rmSync(dir, { recursive: true, force: true });
});
