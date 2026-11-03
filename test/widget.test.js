// 小窗自己的逻辑：快速新建、番茄钟、吸附拼接、设置迁移。都是纯函数。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import * as pomo from "../src/main/pomodoro.js";
import { INBOX, taskFields } from "../src/main/quickadd.js";
import { CARD_SIZE, DEFAULTS, GAP, migrate, sanitize } from "../src/main/settings.js";
import { defaultSpot, followResize, groupOf, isOnScreen, resizeRect, snapMove } from "../src/main/snap.js";
import { backgroundOf, readExternal, resolveSkin, skinOf, SKINS } from "../src/main/theme.js";
import { artifactName, downloadFile, fetchLatest, isNewer, parseVersion, tagFromUrl } from "../src/main/update.js";
import { adoptUserData } from "../src/main/usermigrate.js";

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

test("拉边改大小：按光标挪边，夹住最小尺寸", () => {
  const min = { width: 240, height: 160 };
  const start = rect(0, 0, 300, 300);
  // 拉右边 +40
  assert.deepEqual(resizeRect(start, "e", 40, 0, min), { x: 0, y: 0, width: 340, height: 300 });
  // 拉左边 +40：位置跟着动，宽度变小
  assert.deepEqual(resizeRect(start, "w", 40, 0, min), { x: 40, y: 0, width: 260, height: 300 });
  // 拉右下角
  assert.deepEqual(resizeRect(start, "se", 40, 20, min), { x: 0, y: 0, width: 340, height: 320 });
  // 缩到比最小尺寸还小就停住
  assert.equal(resizeRect(start, "e", -1000, 0, min).width, 240);
  assert.equal(resizeRect(start, "w", 1000, 0, min).width, 240);
  assert.equal(resizeRect(start, "s", 0, -1000, min).height, 160);
  assert.equal(resizeRect(start, "n", 0, 1000, min).height, 160);
});

test("拉边改大小：边界共线、隔一个 GAP 相邻、屏幕边都会吸住，Alt 不吸", () => {
  const min = { width: 100, height: 100 };
  const start = rect(0, 0, 300, 300);
  // 下面拼着一张更宽的卡片（拼在下面 = 上边缘比 bottom+4 低），右边界还差 4 像素就共线：吸到它的右边缘 600
  const below = rect(0, 300 + GAP, 600, 300);
  assert.equal(resizeRect(start, "e", 296, 0, min, { others: [below] }).width, 600);
  // 右边有张卡片隔着 GAP：右边缘吸到「o.x - GAP」
  const right = rect(300 + 12 + GAP, 0, 300, 300);
  assert.equal(resizeRect(start, "e", 16, 0, min, { others: [right] }).width, right.x - GAP);
  // 同一列里下边共线：下面卡片的下边缘
  const below2 = rect(0, 300 + GAP, 300, 300);
  assert.equal(resizeRect(start, "s", 0, 296, min, { others: [below2] }).height, 300 + GAP + 300);
  // 按住 Alt：不吸，就是光标的位置
  assert.equal(resizeRect(start, "e", 296, 0, min, { others: [below], snap: false }).width, 596);
  // 屏幕右边
  const area = { x: 0, y: 0, width: 1920, height: 1040 };
  assert.equal(resizeRect(rect(1000, 0, 300, 300), "e", 613, 0, min, { workAreas: [area] }).width, 920);
  // 离得远的不吸
  assert.equal(resizeRect(start, "e", 260, 0, min, { others: [rect(800, 900)] }).width, 560);
  // 上下方向：下边吸到旁边卡片的底边（共线）
  const beside = rect(400, 0, 300, 420);
  assert.equal(resizeRect(start, "s", 0, 116, min, { others: [beside] }).height, 420);
  // 左边的卡片只参与左边界，拉右边时不吸它
  assert.equal(resizeRect(start, "e", 116, 0, min, { others: [rect(-320, 0, 300, 300)] }).width, 416);
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

test("检查更新：从跳转后的地址认出最新版本，按命名规则拼出安装包地址", async () => {
  assert.equal(tagFromUrl("https://github.com/o/r/releases/tag/v0.2.2"), "v0.2.2");
  assert.equal(tagFromUrl("https://github.com/o/r/releases/latest"), null);
  assert.equal(artifactName("0.2.2", "setup"), "sp-desktop-cards-0.2.2-setup.exe");
  assert.equal(artifactName("0.2.2", "zip"), "sp-desktop-cards-0.2.2-win-x64.zip");

  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url, method: opts.method || "GET" });
    if (opts.method === "HEAD") return new Response(null, { status: 200, headers: { "content-length": "121742191" } });
    return { ok: true, status: 200, url: "https://github.com/shenmingganlin/sp-desktop-cards/releases/tag/v0.2.2" };
  };
  const r = await fetchLatest({ fetchImpl, latestUrl: "https://github.com/o/r/releases/latest", base: "https://github.com/o/r/releases/download" });
  assert.equal(r.version, "0.2.2");
  assert.equal(r.tag, "v0.2.2");
  assert.equal(r.page, "https://github.com/shenmingganlin/sp-desktop-cards/releases/tag/v0.2.2");
  // 下载地址跟着跳过去的仓库走，不是写死的（旧仓库的指路牌也能用同一套逻辑）
  assert.equal(r.setup.url, "https://github.com/shenmingganlin/sp-desktop-cards/releases/download/v0.2.2/sp-desktop-cards-0.2.2-setup.exe");
  assert.equal(r.setup.size, 121742191);
  assert.ok(calls.some((c) => c.method === "HEAD"), "要用 HEAD 确认安装包在不在");
});

test("检查更新：限流、404、没网、地址不对都说得出是什么原因", async () => {
  // 没发布过版本：releases/latest 回 404
  assert.equal((await fetchLatest({ fetchImpl: async () => ({ ok: false, status: 404, url: "x" }) })).error, "none");
  // 被限流或者被墙：带上状态码，好让提示能分开说
  const http = await fetchLatest({ fetchImpl: async () => ({ ok: false, status: 403, url: "x" }) });
  assert.equal(http.error, "http");
  assert.equal(http.status, 403);
  // 没网 / 超时
  assert.equal((await fetchLatest({ fetchImpl: async () => { throw new Error("offline"); } })).error, "network");
  const slow = () => { const e = new Error("t"); e.name = "TimeoutError"; throw e; };
  assert.equal((await fetchLatest({ fetchImpl: async () => slow() })).error, "timeout");
  // 跟完跳转不是 tag 页（网络里被塞了别的东西）
  assert.equal((await fetchLatest({ fetchImpl: async () => ({ ok: true, status: 200, url: "https://example.com/" }) })).error, "format");
  // 安装包还没传上去：HEAD 404，这一项给 null，界面就走「打开下载页」
  const r = await fetchLatest({
    fetchImpl: async (_u, opts = {}) => (opts.method === "HEAD" ? { ok: false, status: 404 } : { ok: true, status: 200, url: "https://github.com/o/r/releases/tag/v1.0.0" }),
  });
  assert.equal(r.setup, null);
  assert.equal(r.zip, null);
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

test("改名搬家：老目录的设置第一次启动时整个搬过来，第二次不再搬", () => {
  const roam = fs.mkdtempSync(path.join(os.tmpdir(), "spw-home-"));
  const old = path.join(roam, "SP 今日小窗");
  const now = path.join(roam, "SP 桌面卡片");
  fs.mkdirSync(old);
  fs.writeFileSync(path.join(old, "settings.json"), '{"opacity":0.5}');
  fs.writeFileSync(path.join(old, "other.txt"), "x");
  assert.equal(adoptUserData(now), "moved");
  assert.equal(JSON.parse(fs.readFileSync(path.join(now, "settings.json"), "utf8")).opacity, 0.5);
  assert.equal(fs.readFileSync(path.join(now, "other.txt"), "utf8"), "x", "不是只搬 settings.json");
  assert.equal(fs.existsSync(old), false, "搬走后老目录不该留着，否则会被再搬一次");
  // 第二次：新目录已经有设置，老目录也没了 —— 什么也不做
  assert.equal(adoptUserData(now), "kept");
  fs.rmSync(roam, { recursive: true, force: true });
});

test("改名搬家：新目录已经有设置就不动，老版本没有设置也不动", () => {
  const roam = fs.mkdtempSync(path.join(os.tmpdir(), "spw-home-"));
  const old = path.join(roam, "SP 今日小窗");
  const now = path.join(roam, "SP 桌面卡片");
  // 情况一：两边都有设置 —— 以新的为准
  fs.mkdirSync(old);
  fs.mkdirSync(now);
  fs.writeFileSync(path.join(old, "settings.json"), '{"opacity":0.1}');
  fs.writeFileSync(path.join(now, "settings.json"), '{"opacity":0.9}');
  assert.equal(adoptUserData(now), "kept");
  assert.equal(JSON.parse(fs.readFileSync(path.join(now, "settings.json"), "utf8")).opacity, 0.9);
  // 情况二：老目录没有设置（从来没用过）
  fs.rmSync(now, { recursive: true, force: true });
  fs.rmSync(path.join(old, "settings.json"));
  assert.equal(adoptUserData(now), "kept");
  assert.equal(fs.existsSync(now), false);
  fs.rmSync(roam, { recursive: true, force: true });
});

test("改名搬家：新目录已经被 Chromium 建好（空目录）也能搬", () => {
  const roam = fs.mkdtempSync(path.join(os.tmpdir(), "spw-home-"));
  fs.mkdirSync(path.join(roam, "SP 今日小窗"));
  fs.writeFileSync(path.join(roam, "SP 今日小窗", "settings.json"), '{"opacity":0.3}');
  fs.mkdirSync(path.join(roam, "SP 桌面卡片"));
  assert.equal(adoptUserData(path.join(roam, "SP 桌面卡片")), "moved");
  assert.equal(JSON.parse(fs.readFileSync(path.join(roam, "SP 桌面卡片", "settings.json"), "utf8")).opacity, 0.3);
  fs.rmSync(roam, { recursive: true, force: true });
});

test("改名搬家：老版本还开着、缓存复制不动时，设置也要先到手", () => {
  const roam = fs.mkdtempSync(path.join(os.tmpdir(), "spw-home-"));
  const old = path.join(roam, "SP 今日小窗");
  const now = path.join(roam, "SP 桌面卡片");
  fs.mkdirSync(old);
  fs.mkdirSync(now);
  fs.writeFileSync(path.join(old, "settings.json"), '{"opacity":0.4}');
  fs.writeFileSync(path.join(now, "lock"), ""); // 新目录已经有东西，rename 走不通
  const result = adoptUserData(now);
  assert.ok(result === "copied" || result === "moved", result);
  const s = JSON.parse(fs.readFileSync(path.join(now, "settings.json"), "utf8"));
  assert.equal(s.opacity, 0.4, "设置没搬过来");
  fs.rmSync(roam, { recursive: true, force: true });
});

test("皮肤：外部主题文件合法时覆盖手选，坏了/删了就退回", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spw-theme-"));
  const file = path.join(dir, "theme.json");
  try {
    assert.equal(readExternal(file), null); // 文件不存在
    fs.writeFileSync(file, "{oops");
    assert.equal(readExternal(file), null); // JSON 坏了
    fs.writeFileSync(file, JSON.stringify({ theme: "pink" }));
    assert.equal(readExternal(file), null); // 皮肤名不认识
    fs.writeFileSync(file, JSON.stringify({ theme: "hana", source: " 任务台 " }));
    // 0.3.0 的旧名字 hana 现在叫 new-warm-paper
    assert.deepEqual(readExternal(file), { theme: "new-warm-paper", source: "任务台" });
    fs.writeFileSync(file, JSON.stringify({ theme: "midnight", source: "任务台" }));
    assert.deepEqual(readExternal(file), { theme: "midnight", source: "任务台" });

    assert.deepEqual(resolveSkin("hana", null), { theme: "new-warm-paper", source: "" });
    assert.deepEqual(resolveSkin("dark", { theme: "midnight", source: "任务台" }), { theme: "midnight", source: "任务台" });
    assert.deepEqual(resolveSkin("pink", null), { theme: "dark", source: "" });
    assert.equal(backgroundOf("hana"), "#f5efe4");
    assert.equal(backgroundOf("midnight"), "#3b4a54");
    assert.equal(backgroundOf("dark"), "#1f1f1f");
    assert.equal(SKINS.length, 12);
    assert.equal(skinOf("coral").name, "珊瑚");
    assert.equal(skinOf("hana").id, "new-warm-paper");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("设置：皮肤只收认识的 id，旧名字 hana 归一成新暖纸", () => {
  assert.equal(sanitize({ theme: "hana" }).theme, "new-warm-paper");
  assert.equal(sanitize({ theme: "coral" }).theme, "coral");
  assert.equal(sanitize({ theme: "pink" }).theme, DEFAULTS.theme);
  assert.equal(DEFAULTS.theme, "dark");
});
