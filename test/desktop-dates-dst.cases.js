// 只能由 desktop-dates.test.js 在独立 TZ 子进程调用，不改变测试宿主的时区。
import assert from "node:assert/strict";
import test from "node:test";
import { buildPlanner, buildSchedule } from "../src/main/calendar.js";
import { localDay, resolveToday } from "../src/main/model.js";
import { taskFields } from "../src/main/quickadd.js";
import { task } from "./fixtures.js";
import { createRenderer } from "./renderer-harness.js";

const MIN = 60_000;
const settle = () => new Promise(setImmediate);
const rawFor = (now, allTasks = []) => ({ now, allTasks, todayTasks: [], tags: [], projects: [], repeatCfgs: [] });
const localAt = (day, hour, minute = 0) => {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, m - 1, d, hour, minute).getTime();
};
const stateFor = (view) => ({ settings: {}, collapsed: false, view });
const checkTz = () => {
  assert.equal(Intl.DateTimeFormat().resolvedOptions().timeZone, "America/New_York");
  assert.equal(new Date(2026, 2, 8, 14).getTimezoneOffset(), 240);
  assert.equal(new Date(2026, 10, 1, 14).getTimezoneOffset(), 300);
};

for (const day of ["2026-03-07", "2026-03-08", "2026-11-01", "2026-11-02"]) {
  // 把墙钟坐标改回经过分钟数，将使春秋切换日的 14:00 位置与新建回读失败。
  test(`R03: ${day} 14:00 两泳道的同水平空位新建仍是 14:00`, async () => {
    checkTz();
    const now = localAt(day, 12);
    const original = task({ id: "original", dueWithTime: localAt(day, 14), timeEstimate: 60 * MIN });
    const later = task({ id: "later", dueWithTime: localAt(day, 14, 15), timeEstimate: 60 * MIN });
    const raw = rawFor(now, [original, later]);
    const view = buildSchedule(raw, { day });
    const first = view.blocks.find((b) => b.id === "original");
    const second = view.blocks.find((b) => b.id === "later");
    assert.equal(first.lanes, 2);
    assert.equal(first.lane, 0);
    assert.equal(second.lane, 1);
    assert.ok(second.startMin > first.startMin, "14:00 水平处的第二泳道确实为空");
    const written = [];
    const h = createRenderer("schedule", { now: () => now, action: async (name, input) => {
      if (name === "createTask") written.push(taskFields(input));
      return { ok: true };
    } });
    h.update(stateFor(view));
    const line = h.document.querySelector(".timeline");
    line.getBoundingClientRect = () => ({ top: 0 });
    // 第一块在左泳道，点击右泳道同一水平空位，事件目标为时间轴而非任务块。
    line.emit("click", { target: line, clientX: 180, clientY: (first.startMin - view.rangeStart) * 0.8 + 1 });
    h.type(h.input(), "synthetic same-clock appointment");
    h.enter(h.input());
    await settle();
    assert.equal(written.length, 1);
    assert.equal(written[0].ok, true);
    assert.equal(written[0].fields.dueWithTime, localAt(day, 14), "绘图位置与点击保存必须使用同一墙钟分钟");
    assert.equal(first.startMin, 840);
    assert.equal(first.endMin, 900);
    const saved = task({ id: "created", ...written[0].fields });
    const again = buildSchedule({ ...raw, allTasks: [saved] }, { day });
    assert.equal(again.blocks[0].startMin, 840);
    assert.equal(again.blocks[0].timeLabel, "14:00");
  });

  // 仅修任务块而不修 tick/自动滚动时，这项仍会在 DST 日失败。
  test(`R03: ${day} 现在线和自动滚动与 14:00 墙钟坐标一致`, () => {
    checkTz();
    const now = localAt(day, 14);
    const h = createRenderer("schedule", { now: () => now });
    // DOM 边界只提供布局偏移，不复制业务坐标计算。
    Object.defineProperty(Object.getPrototypeOf(h.document.body), "offsetTop", { get: () => 0 });
    const view = buildSchedule(rawFor(now), { day });
    h.update(stateFor(view));
    const line = h.document.querySelector(".now-line");
    assert.equal(line.hidden, false);
    assert.equal(line.style.top, "288px", "14:00 距 08:00 六小时，每分钟 0.8px");
    assert.equal(h.document.getElementById("body").scrollTop, 240, "自动滚到现在之前一小时");
  });
}

// 秋季回拨时墙钟区间不单调；不能把正时长压成负高度或悄悄缩短一小时。
for (const [label, start, duration, startMinute, endLabel] of [
  ["backwards", "2026-11-01T01:50:00-04:00", 30, 110, "01:20"],
  ["shortened", "2026-11-01T00:50:00-04:00", 90, 50, "01:20"],
]) {
  test(`R03: 回拨跨段 ${label} 保留实际时长和真实结束钟点`, () => {
    checkTz();
    const now = Date.parse("2026-11-01T12:00:00-05:00");
    const item = task({ id: label, dueWithTime: Date.parse(start), timeEstimate: duration * MIN });
    const view = buildSchedule(rawFor(now, [item]), { day: "2026-11-01", startHour: 0, endHour: 4 });
    const block = view.blocks[0];
    assert.equal(block.startMin, startMinute);
    assert.equal(block.endMin - block.startMin, duration, "回拨区间用实际时长画正长度，不能负长或缩短");
    assert.equal(block.endLabel, endLabel, "结束钟点仍是回拨后的真实时间，不能伪造为02:20");
    const h = createRenderer("schedule", { now: () => now });
    h.update(stateFor(view));
    const node = h.document.querySelector(".block");
    assert.equal(node.style.height, `${duration * 0.8 - 2}px`);
    assert.ok(node.title.includes(endLabel));
    assert.match(node.title, /回拨/, "实际时长几何超出墙钟端点时必须解释回拨，而非暗示结束于坐标钟点");
  });
}

test("R03: 回拨区间按绘图占位分泳道，不与后续钟点块重叠", () => {
  checkTz();
  const now = Date.parse("2026-11-01T12:00:00-05:00");
  const view = buildSchedule(rawFor(now, [
    task({ id: "fold", dueWithTime: Date.parse("2026-11-01T01:50:00-04:00"), timeEstimate: 30 * MIN }),
    task({ id: "after", dueWithTime: Date.parse("2026-11-01T02:00:00-05:00"), timeEstimate: 30 * MIN }),
  ]), { day: "2026-11-01", startHour: 0, endHour: 4 });
  const fold = view.blocks.find((b) => b.id === "fold");
  const after = view.blocks.find((b) => b.id === "after");
  assert.equal(fold.lanes, 2);
  assert.notEqual(fold.lane, after.lane, "实际不同时段在墙钟轴上占位相交，不能画在同一泳道");
});

// 固定减四个实际小时会在春季把 04:30 归到昨天、秋季把 03:30 归到今天。
for (const [day, previous, beforeHour, beforeMinute] of [
  ["2026-03-08", "2026-03-07", 3, 30],
  ["2026-11-01", "2026-10-31", 3, 30],
]) {
  test(`R04: ${day} 按本地 04:00 日界归日`, () => {
    checkTz();
    assert.equal(localDay(localAt(day, beforeHour, beforeMinute), 4), previous);
    assert.equal(localDay(localAt(day, 3, 59) + 59_999, 4), previous);
    assert.equal(localDay(localAt(day, 4), 4), day);
    assert.equal(localDay(localAt(day, 4, 30), 4), day);
  });

  test(`R04: ${day} resolveToday 的六小时采信窗口从本地 04:00 开始`, () => {
    checkTz();
    const stale = [task({ dueDay: previous })];
    assert.equal(resolveToday(stale, localAt(day, 9, 59), 4), previous);
    assert.equal(resolveToday(stale, localAt(day, 10), 4), day);
    assert.equal(resolveToday(stale, localAt(day, 10, 30), 4), day);
  });
}

// 真实投影时间、新建字段和实例归日必须相同；不能只修 localDay 的孤立输出。
for (const [day, previous] of [
  ["2026-03-07", "2026-03-06"],
  ["2026-03-08", "2026-03-07"],
  ["2026-11-01", "2026-10-31"],
]) {
  test(`R04: ${day} 04:30 重复投影转实例不丢日`, async () => {
    checkTz();
    const now = localAt(day, 12);
    const cfg = {
      id: "synthetic-repeat", title: "synthetic repeat", repeatEvery: 1, repeatCycle: "DAILY",
      startDate: "2026-01-01", startTime: "04:30", lastTaskCreationDay: previous,
    };
    const raw = { ...rawFor(now), repeatCfgs: [cfg] };
    const opts = { day, dayStartHour: 4, startHour: 4 };
    const projection = buildPlanner(raw, { dayStartHour: 4, days: 1 }).days[0].projections[0];
    assert.equal(projection.at, localAt(day, 4, 30));
    const view = buildSchedule(raw, opts);
    const written = [];
    const h = createRenderer("schedule", { now: () => now, action: async (name, input) => {
      if (name === "createTask") written.push(taskFields(input));
      return { ok: true };
    } });
    h.update(stateFor(view));
    const line = h.document.querySelector(".timeline");
    line.getBoundingClientRect = () => ({ top: 0 });
    line.emit("click", { target: line, clientY: (270 - view.rangeStart) * 0.8 + 1 });
    h.type(h.input(), "synthetic repeat instance");
    h.enter(h.input());
    await settle();
    assert.equal(written.length, 1);
    assert.equal(written[0].ok, true);
    assert.equal(written[0].fields.dueWithTime, projection.at);
    const instance = task({ id: "instance", ...written[0].fields, repeatCfgId: cfg.id });
    const after = { ...raw, allTasks: [instance], repeatCfgs: [{ ...cfg, lastTaskCreationDay: day }] };
    const entry = buildPlanner(after, { dayStartHour: 4, days: 1 }).days[0];
    assert.equal(entry.day, day);
    assert.deepEqual(entry.items.map((item) => item.id), ["instance"]);
    assert.deepEqual(entry.projections, []);
    assert.deepEqual(buildSchedule(after, opts).blocks.map((block) => block.id), ["instance"]);
    assert.deepEqual(buildSchedule(after, { ...opts, day: previous }).blocks, []);
  });
}
