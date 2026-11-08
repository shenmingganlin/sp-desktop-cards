import assert from "node:assert/strict";
import test from "node:test";
import { buildView, clock, dayDiff, duration, localDay, resolveToday } from "../src/main/model.js";
import { ids, NOW, sampleData, task, TODAY } from "./fixtures.js";

const MIN = 60_000;
const view = (patch = {}, opts = {}) => buildView({ ...sampleData(), ...patch }, opts);

test("格式化：计时与时长", () => {
  assert.equal(clock(0), "00:00");
  assert.equal(clock(65_000), "01:05");
  assert.equal(clock(3_903_000), "1:05:03");
  assert.equal(clock(-5), "00:00");
  assert.equal(duration(0), "0 分");
  assert.equal(duration(40 * MIN), "40 分");
  assert.equal(duration(120 * MIN), "2 小时");
  assert.equal(duration(135 * MIN), "2 小时 15 分");
});

test("日期：日界偏移与相差天数", () => {
  const lateNight = new Date(2026, 10, 3, 1, 30).getTime();
  assert.equal(localDay(lateNight, 0), "2026-11-03");
  assert.equal(localDay(lateNight, 4), "2026-11-02");
  assert.equal(dayDiff("2026-11-01", "2026-11-02"), -1);
  assert.equal(dayDiff("2026-03-30", "2026-03-28"), 2); // 跨夏令时也按日历日
});

test("今天是哪天：优先用只排了日期的今日任务", () => {
  const lateNight = new Date(2026, 10, 3, 1, 30).getTime();
  // SP 的日界是 4 点时，凌晨 1:30 的「今日」任务 dueDay 还是 11-02。
  assert.equal(resolveToday([task({ dueDay: "2026-11-02" })], lateNight, 0), "2026-11-02");
  // 带时间的任务不拿来推断
  assert.equal(resolveToday([task({ dueDay: "2026-11-09", dueWithTime: NOW })], lateNight, 4), "2026-11-02");
  assert.equal(resolveToday([], lateNight, 0), "2026-11-03");
});

test("今天是哪天：TODAY 标签挂在别的日期的任务上时，不跟着它跑", () => {
  const lateNight = new Date(2026, 10, 3, 1, 30).getTime();
  // 回归：以前直接拿第一条只有日期的今日任务定「今天」。TODAY 标签可以手动加，
  // 也可以把任务日期改到下周，那样整张卡片的逾期、规划起点、番茄跨天全按错的那天算。
  assert.equal(resolveToday([task({ dueDay: "2026-12-25" })], lateNight, 0), "2026-11-03");
  // 跟本机推算差一天以内的照旧采信（SP 的日界不是 0 点时凌晨就是这样）
  assert.equal(resolveToday([task({ dueDay: "2026-11-02" })], lateNight, 0), "2026-11-02");
  // 一堆任务里挑得出那条对得上的
  const list = [task({ dueDay: "2027-01-01" }), task({ dueDay: "2026-11-03" })];
  assert.equal(resolveToday(list, lateNight, 0), "2026-11-03");
});

test("今日列表：带时间的按时间排前，其余按 SP 今日视图顺序", () => {
  const v = view();
  assert.equal(v.today, TODAY);
  assert.deepEqual(ids(v.list), ["standup", "review", "report", "parent"]);
  assert.deepEqual(ids(v.done), ["finished"]);
});

test("逾期：今天已过点、前几天、截止日已过；逾期最久的排前", () => {
  const v = view();
  assert.deepEqual(ids(v.overdue), ["late", "deadline", "yday", "early"]);
  const reason = Object.fromEntries(v.overdue.map((o) => [o.id, o.overdueReason]));
  assert.equal(reason.early, "09:00 已过");
  assert.equal(reason.late, "2 天前");
  assert.equal(reason.yday, "昨天 16:30");
  assert.equal(reason.deadline, "截止 昨天");
  // 已过点的今日任务从今日列表里拿掉，不重复出现
  assert.ok(!ids(v.list).includes("early"));
  // 没排期和以后的任务都不出现
  for (const id of ["later", "unplanned"]) assert.ok(![...v.overdue, ...v.list].some((e) => e.id === id));
});

test("即将到点：提前量内的高亮，0 表示不高亮", () => {
  const v = view();
  const standup = v.list.find((e) => e.id === "standup");
  assert.equal(standup.upcomingInMin, 10);
  assert.equal(v.list.find((e) => e.id === "review").upcomingInMin, null);
  assert.equal(view({}, { upcomingMinutes: 5 }).list.find((e) => e.id === "standup").upcomingInMin, null);
  assert.equal(view({}, { upcomingMinutes: 0 }).list.find((e) => e.id === "standup").upcomingInMin, null);
});

test("父子任务：子任务挂在父任务下，父任务不能直接计时", () => {
  const parent = view().list.find((e) => e.id === "parent");
  assert.deepEqual(ids(parent.children), ["c1", "c2", "c3"]);
  assert.equal(parent.canTrack, false);
  assert.equal(parent.children[0].isDone, true);
  assert.equal(parent.children[0].canTrack, false);
  assert.equal(parent.children[1].canTrack, true);
});

test("子任务单独排在今日、父任务不在时：单列并带上父任务名", () => {
  const data = sampleData();
  const child = data.allTasks.find((t) => t.id === "c3");
  child.dueDay = TODAY;
  data.todayTasks = [child];
  const v = buildView({ ...data, tags: [] });
  assert.deepEqual(ids(v.list), ["c3"]);
  assert.equal(v.list[0].parentTitle, "整理发布");
});

test("父任务逾期时子任务不再单独列", () => {
  const data = sampleData();
  const parent = data.allTasks.find((t) => t.id === "parent");
  parent.dueDay = "2026-10-30";
  data.allTasks.find((t) => t.id === "c2").dueDay = "2026-10-31";
  data.todayTasks = data.todayTasks.filter((t) => t.id !== "parent");
  const v = buildView(data);
  const o = v.overdue.find((e) => e.id === "parent");
  assert.ok(o);
  assert.deepEqual(ids(o.children), ["c1", "c2", "c3"]);
  assert.ok(!v.overdue.some((e) => e.id === "c2"));
});

test("统计：今日用时只加叶子任务，完成数和预估剩余", () => {
  const s = view().stats;
  // report 20 + c1 10 + c2 5 + finished 30；父任务的数字不重复加
  assert.equal(s.spentToday, 65 * MIN);
  assert.equal(s.doneCount, 1);
  assert.equal(s.totalCount, 1 + 4 + 4);
  // standup 15 + review 60 + report 25 + parent(c2 10 + c3 30)
  assert.equal(s.remaining, 140 * MIN);
});

test("当前任务：标记在行上，带父任务名", () => {
  const data = sampleData();
  const c2 = data.allTasks.find((t) => t.id === "c2");
  const v = buildView({ ...data, current: c2 });
  assert.equal(v.current.title, "写更新说明");
  assert.equal(v.current.parentTitle, "整理发布");
  assert.equal(v.current.spent, 20 * MIN);
  const row = v.list.find((e) => e.id === "parent").children.find((c) => c.id === "c2");
  assert.equal(row.isCurrent, true);
});

test("番茄钟与心流：标签、正计时还是倒计时", () => {
  const pomodoro = view({
    focus: { mode: "Pomodoro", cycle: 2, isSessionDone: false, timer: { purpose: "work", status: "running", isOvertime: false, isLongBreak: false, elapsedMs: 5 * MIN, remainingMs: 20 * MIN, durationMs: 25 * MIN } },
  }).focus;
  assert.equal(pomodoro.label, "番茄钟");
  assert.equal(pomodoro.cycle, 2);
  assert.equal(pomodoro.countUp, false);
  assert.equal(pomodoro.remainingMs, 20 * MIN);

  const longBreak = view({ focus: { mode: "Pomodoro", cycle: 4, timer: { purpose: "break", status: "paused", isLongBreak: true, elapsedMs: 0, remainingMs: 15 * MIN } } }).focus;
  assert.equal(longBreak.label, "长休息");
  assert.equal(longBreak.isBreak, true);

  const flow = view({ focus: { mode: "Flowtime", cycle: 1, timer: { purpose: "work", status: "running", elapsedMs: 3 * MIN, remainingMs: 0 } } }).focus;
  assert.equal(flow.label, "心流");
  assert.equal(flow.countUp, true);

  assert.equal(view().focus, null);
});

test("空数据不报错", () => {
  const v = buildView({ todayTasks: [], allTasks: [], tags: [], current: null, focus: null, now: NOW });
  assert.deepEqual([v.overdue, v.list, v.done], [[], [], []]);
  assert.deepEqual(v.stats, { spentToday: 0, doneCount: 0, totalCount: 0, remaining: 0 });
});

// ── 「结束这一天」菜单要用的清单 ──
// 只提供两样东西：没做完的（排到明天）、已完成的（归档）。
// 不算统计——用时、完成数、预估剩余今日卡片底栏本来就有，再算一遍就是两份口径。

test("结束这一天：没做完的进「排到明天」，逾期的除外", () => {
  const v = view();
  assert.deepEqual(ids(v.wrapUp.leftOver), ["standup", "review", "report", "parent"]);
  // 逾期的不在里面：它们本来就欠着，卡片上半部分已经单独成组
  assert.ok(!v.wrapUp.leftOver.some((t) => t.id === "early"));
  // 做完的更不在
  assert.ok(!v.wrapUp.leftOver.some((t) => t.id === "finished"));
});

test("结束这一天：归档的就是卡片上「已完成」那一组，所见即所归", () => {
  const v = view();
  assert.deepEqual(v.wrapUp.doneIds, ids(v.done));
  // 今天没做完的不该被归档
  assert.ok(!v.wrapUp.doneIds.includes("standup"));
});

test("结束这一天：父任务和子任务都排了今天时，只排父任务一次", () => {
  // sampleData 里 c3 没排今天，这条路径测不到；手动把 c3 也排上今天
  const data = sampleData();
  data.allTasks.find((t) => t.id === "c3").dueDay = TODAY;
  data.todayTasks = [...data.todayTasks, data.allTasks.find((t) => t.id === "c3")];
  const v = buildView(data);
  const wrapIds = ids(v.wrapUp.leftOver);
  assert.ok(wrapIds.includes("parent"));
  assert.ok(!wrapIds.includes("c3"), "父任务已经代表了它，子任务不单独排");
});

test("结束这一天：今天什么都没排也没完成时，isEmpty 为真（不显示按钮）", () => {
  const v = buildView({ todayTasks: [], allTasks: [task({ id: "later", dueDay: "2026-12-01" })], tags: [], now: NOW });
  assert.equal(v.wrapUp.isEmpty, true);
  assert.deepEqual(v.wrapUp.leftOver, []);
  assert.deepEqual(v.wrapUp.doneIds, []);
  // 有没做完的就不算空
  const pending = buildView({ todayTasks: [task({ id: "x", dueDay: TODAY })], allTasks: [task({ id: "x", dueDay: TODAY })], tags: [], now: NOW });
  assert.equal(pending.wrapUp.isEmpty, false);
});
