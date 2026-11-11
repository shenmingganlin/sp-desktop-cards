// desktop-dates 专项：真实模型 → 真实页面输入 → 新建字段 → 模型回读，全为合成数据。
import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildSchedule } from "../src/main/calendar.js";
import { buildView } from "../src/main/model.js";
import { taskFields } from "../src/main/quickadd.js";
import { sanitize } from "../src/main/settings.js";
import { task } from "./fixtures.js";
import { createRenderer } from "./renderer-harness.js";

const DAY = "2026-11-09";
const NOW = new Date(2026, 10, 9, 12).getTime();
const MIN = 60_000;
const rawFor = (allTasks = [], now = NOW) => ({ allTasks, todayTasks: [], tags: [], projects: [], repeatCfgs: [], now });
const stateFor = (view) => ({ settings: {}, collapsed: false, view });
const settle = () => new Promise(setImmediate);
function runDstCases(id) {
  const env = { ...process.env, TZ: "America/New_York" };
  // 不把外层 node:test 的 IPC 模式传给独立 runner，否则结果会成为二进制事件而非退出失败。
  delete env.NODE_TEST_CONTEXT;
  const child = spawnSync(process.execPath, ["--test", "--test-reporter=tap", "--test-name-pattern", id, fileURLToPath(new URL("./desktop-dates-dst.cases.js", import.meta.url))], {
    env, encoding: "utf8",
  });
  assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`);
  // 空的 name-pattern 子进程也会退出 0；必须证明本组场景实际运行，不能假绿。
  const count = Number(child.stdout.match(/^# tests (\d+)$/m)?.[1]);
  assert.equal(count, id === "R03" ? 11 : 7, `DST 场景未全部执行：${child.stdout}`);
}

test("R03: 独立 New York 子进程验证春秋 DST 绘图、空泳道点击与现在线", () => runDstCases("R03"));
test("R04: 独立 New York 子进程验证本地日界和重复投影转实例", () => runDstCases("R04"));
function clickMinute(h, view, minute) {
  const line = h.document.querySelector(".timeline");
  line.getBoundingClientRect = () => ({ top: 0 });
  line.emit("click", { target: line, clientY: (minute - view.rangeStart) * 0.8 + 1 });
}

// 如果日界之前的槽再次开放，这项会在点击或新建回读阶段失败。
test("R02: 04:00 日界不开放前日时间槽，新建后仍在所选逻辑日", async () => {
  const settings = sanitize({ dayStartHour: 4, scheduleStartHour: 0, scheduleEndHour: 22 });
  const opts = { day: DAY, dayStartHour: settings.dayStartHour, startHour: settings.scheduleStartHour, endHour: settings.scheduleEndHour };
  const view = buildSchedule(rawFor(), opts);
  assert.equal(view.rangeStart, 240, "02:00 不属于该逻辑日，时间轴应从 04:00 起开放");
  const written = [];
  const h = createRenderer("schedule", { now: () => NOW, action: async (name, input) => {
    if (name === "createTask") written.push(taskFields(input));
    return { ok: true };
  } });
  h.update(stateFor(view));
  clickMinute(h, view, view.rangeStart);
  h.type(h.input(), "synthetic boundary appointment");
  h.enter(h.input());
  await settle();
  assert.equal(written.length, 1);
  assert.equal(written[0].ok, true);
  assert.equal(written[0].fields.dueWithTime, new Date(2026, 10, 9, 4).getTime());
  const saved = task({ id: "created", ...written[0].fields });
  assert.deepEqual(buildSchedule(rawFor([saved]), opts).blocks.map((b) => b.id), ["created"]);
  assert.deepEqual(buildSchedule(rawFor([saved]), { ...opts, day: "2026-11-08" }).blocks, []);
});

test("R02: 保留次日 01:00 的 25:00 坐标与逻辑日期", async () => {
  const opts = { day: DAY, dayStartHour: 4, startHour: 0, endHour: 24 };
  const late = task({ id: "late", dueWithTime: new Date(2026, 10, 10, 1).getTime(), timeEstimate: 30 * MIN });
  const view = buildSchedule(rawFor([late]), opts);
  assert.equal(view.rangeStart, 240);
  assert.equal(view.blocks[0].startMin, 1500);
  const written = [];
  const h = createRenderer("schedule", { now: () => NOW, action: async (name, input) => {
    if (name === "createTask") written.push(taskFields(input));
    return { ok: true };
  } });
  h.update(stateFor(view));
  clickMinute(h, view, 1500);
  h.type(h.input(), "synthetic late appointment");
  h.enter(h.input());
  await settle();
  assert.equal(written[0].fields.dueWithTime, new Date(2026, 10, 10, 1).getTime());
  const saved = task({ id: "created", ...written[0].fields });
  assert.equal(buildSchedule(rawFor([saved]), opts).blocks[0].startMin, 1500);
});

// 子项一旦进入逾期顶层，统计不能又通过今日父项把同一叶子加一遍。
test("R05: 子任务从今日转入独立逾期组时，剩余仍是同一份 30 分钟", () => {
  const parent = task({ id: "parent", dueDay: DAY, subTaskIds: ["child"], timeEstimate: 30 * MIN });
  const child = task({ id: "child", parentId: "parent", dueWithTime: new Date(2026, 10, 9, 9).getTime(), timeEstimate: 30 * MIN });
  const raw = { ...rawFor([parent, child]), todayTasks: [parent, child] };
  const before = buildView({ ...raw, now: new Date(2026, 10, 9, 8).getTime() });
  assert.equal(before.stats.remaining, 30 * MIN);
  assert.deepEqual(before.overdue, []);
  assert.deepEqual(before.list[0].children.map((entry) => entry.id), ["child"]);
  const after = buildView(raw);
  assert.deepEqual(after.overdue.map((entry) => entry.id), ["child"]);
  assert.deepEqual(after.list.map((entry) => entry.id), ["parent"]);
  assert.deepEqual(after.list[0].children, []);
  assert.equal(after.stats.remaining, 30 * MIN, "逾期只是分组变化，不能把 30 分钟变成 1 小时");
  const h = createRenderer("today", { now: () => NOW });
  h.update(stateFor(after));
  assert.match(h.document.getElementById("foot").textContent, /预估剩余 30 分/);
});

test("R05: 独立逾期、普通和已完成子任务混合时，只累计未完成叶子一次", () => {
  const parent = task({ id: "parent", dueDay: DAY, subTaskIds: ["late", "open", "done"], timeEstimate: 85 * MIN, timeSpent: 30 * MIN });
  const children = [
    task({ id: "late", parentId: parent.id, dueWithTime: new Date(2026, 10, 9, 9).getTime(), timeEstimate: 40 * MIN, timeSpent: 10 * MIN }),
    task({ id: "open", parentId: parent.id, timeEstimate: 30 * MIN, timeSpent: 5 * MIN }),
    task({ id: "done", parentId: parent.id, isDone: true, timeEstimate: 15 * MIN, timeSpent: 15 * MIN }),
  ];
  const raw = { ...rawFor([parent, ...children]), todayTasks: [parent, children[0]] };
  assert.equal(buildView(raw).stats.remaining, 55 * MIN);
  // 父项也变为逾期时，不再单列子项；两种分组都必须保留其他未完成孩子的工时。
  const overdueParent = { ...parent, dueDay: "2026-11-08" };
  const grouped = buildView({ ...raw, allTasks: [overdueParent, ...children], todayTasks: [overdueParent, children[0]] });
  assert.deepEqual(grouped.overdue.map((entry) => entry.id), ["parent"]);
  assert.equal(grouped.stats.remaining, 55 * MIN);
});

// 固定的明日页面跨日后，只有 isToday 改变；丢掉此签名字段会留下旧 parts.view。
test("R08: 固定明日页面跨到今天后，现在线在普通更新和 tick 后出现", () => {
  const day = "2026-11-10";
  let now = new Date(2026, 10, 9, 23, 59).getTime();
  const h = createRenderer("schedule", { now: () => now });
  const before = buildSchedule(rawFor([], now), { day });
  assert.equal(before.isToday, false);
  h.update(stateFor(before));
  assert.equal(h.document.querySelector(".now-line").hidden, true);
  now = new Date(2026, 10, 10, 12).getTime();
  const after = buildSchedule(rawFor([], now), { day });
  assert.equal(after.isToday, true);
  assert.equal(after.day, before.day);
  assert.deepEqual(after.blocks, before.blocks);
  h.update(stateFor(after));
  h.W.tick();
  assert.equal(h.document.querySelector(".now-line").hidden, false);
  assert.equal(h.document.querySelector(".now-line").style.top, "192px");
  now = new Date(2026, 10, 10, 14).getTime();
  h.W.tick();
  assert.equal(h.document.querySelector(".now-line").style.top, "288px");
  now = new Date(2026, 10, 11, 12).getTime();
  h.update(stateFor(buildSchedule(rawFor([], now), { day })));
  h.W.tick();
  assert.equal(h.document.querySelector(".now-line").hidden, true, "固定日期变成昨天后不能残留现在线");
});
