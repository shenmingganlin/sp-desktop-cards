// 结束一天：今天的收尾账。做了什么、时间花在哪、还剩什么、明天要接哪些。
import assert from "node:assert/strict";
import test from "node:test";
import { buildFinishDay } from "../src/main/finishday.js";
import { NOW, TODAY, sampleData, task } from "./fixtures.js";

const MIN = 60_000;
const HOUR = 3600_000;
const ids = (list) => list.map((e) => e.id);
const build = (raw, opts = {}) => buildFinishDay(raw, { today: TODAY, now: NOW, dayStartHour: 0, ...opts });

/** 某天的某个时刻。base 是 2026-11-02 10:00。 */
const at = (dayOffset, hour, minute = 0) => new Date(2026, 10, 2 + dayOffset, hour, minute, 0).getTime();

test("结束一天：今天做完的按完成时间列出，昨天做的不算", () => {
  const v = build({
    allTasks: [
      task({ id: "a", title: "写完报告", isDone: true, doneOn: at(0, 9) }),
      task({ id: "b", title: "开会", isDone: true, doneOn: at(0, 11) }),
      task({ id: "old", title: "昨天的事", isDone: true, doneOn: at(-1, 15) }),
    ],
  });
  assert.deepEqual(ids(v.done), ["a", "b"]);
  assert.equal(v.stats.doneCount, 2);
});

test("结束一天：完成时间按天界算，凌晨做完的算前一天", () => {
  // SP 的「一天从几点开始」不是 0 点时，凌晨 1 点做完的属于前一天。
  // 用自然日算会让收尾账和 SP 自己的今日视图对不上。
  const raw = {
    allTasks: [
      task({ id: "late", isDone: true, doneOn: at(0, 1) }),
      task({ id: "noon", isDone: true, doneOn: at(0, 12) }),
    ],
  };
  // 日界是 4 点：凌晨 1 点那条属于 11-01 的账，今天的账上只剩中午那条
  assert.deepEqual(ids(build(raw, { dayStartHour: 4 }).done), ["noon"]);
  assert.deepEqual(ids(build(raw, { dayStartHour: 4, today: "2026-11-01" }).done), ["late"]);
  // 日界是 0 点时两条都算今天
  assert.deepEqual(ids(build(raw).done), ["late", "noon"]);
});

test("结束一天：时间花在哪，按今天的用时从多到少", () => {
  const v = build({
    allTasks: [
      task({ id: "small", title: "回邮件", timeSpentOnDay: { [TODAY]: 10 * MIN } }),
      task({ id: "big", title: "写方案", timeSpentOnDay: { [TODAY]: 90 * MIN } }),
      task({ id: "yday", title: "昨天的活", timeSpentOnDay: { "2026-11-01": 60 * MIN } }),
    ],
  });
  assert.deepEqual(ids(v.worked), ["big", "small"]);
  assert.equal(v.worked[0].ms, 90 * MIN);
  assert.equal(v.stats.workedMs, 100 * MIN);
});

test("结束一天：父任务的用时已经包含子任务，不能加两遍", () => {
  const v = build({
    allTasks: [
      task({ id: "p", subTaskIds: ["c"], timeSpentOnDay: { [TODAY]: 30 * MIN } }),
      task({ id: "c", parentId: "p", timeSpentOnDay: { [TODAY]: 30 * MIN } }),
    ],
  });
  assert.equal(v.stats.workedMs, 30 * MIN);
  assert.deepEqual(ids(v.worked), ["c"]);
});

test("结束一天：计划了但没做完的，就是要接去明天的", () => {
  const raw = {
    allTasks: [
      task({ id: "planned-done", dueDay: TODAY, isDone: true, doneOn: at(0, 9) }),
      task({ id: "planned-open", dueDay: TODAY }),
      task({ id: "timed-open", dueWithTime: at(0, 15) }),
      task({ id: "other-day", dueDay: "2026-11-05" }),
    ],
  };
  const v = build(raw);
  assert.deepEqual(ids(v.leftOver), ["planned-open", "timed-open"]);
  assert.equal(v.stats.plannedCount, 3);
  assert.equal(v.stats.leftCount, 2);
  // 明天的事不在今天的账上
  assert.ok(!v.leftOver.some((t) => t.id === "other-day"));
});

test("结束一天：父任务和子任务都排了今天时，只接父任务一次", () => {
  // 两条都接的话，明天会出现父任务和它的子任务各一份，看起来像重复了。
  const v = build({
    allTasks: [
      task({ id: "p", dueDay: TODAY, subTaskIds: ["c"] }),
      task({ id: "c", parentId: "p", dueDay: TODAY }),
    ],
  });
  assert.deepEqual(ids(v.leftOver), ["p"]);
});

test("结束一天：预估还剩多少只算没做完的，且不重复加父子", () => {
  const v = build({
    allTasks: [
      task({ id: "p", dueDay: TODAY, subTaskIds: ["c1", "c2"], timeEstimate: 100 * MIN, timeSpent: 40 * MIN }),
      task({ id: "c1", parentId: "p", timeEstimate: 50 * MIN, timeSpent: 40 * MIN }),
      task({ id: "c2", parentId: "p", timeEstimate: 50 * MIN }),
      task({ id: "done", dueDay: TODAY, isDone: true, timeEstimate: 30 * MIN, timeSpent: 30 * MIN }),
    ],
  });
  // p 的预估已经含子任务：剩 60 分钟，不再把 c2 的 50 分钟加一遍
  assert.equal(v.stats.leftEstimateMs, 60 * MIN);
});

test("结束一天：完成率按「计划里做完了几项」算，没有计划时不算成 0%", () => {
  const none = build({ allTasks: [] });
  assert.equal(none.stats.plannedCount, 0);
  assert.equal(none.stats.ratio, null);
  const half = build({ allTasks: [task({ id: "a", dueDay: TODAY, isDone: true, doneOn: at(0, 9) }), task({ id: "b", dueDay: TODAY })] });
  assert.equal(half.stats.ratio, 0.5);
});

test("结束一天：今天什么都没发生时不硬凑一段总结", () => {
  const v = build({ allTasks: [task({ id: "a", dueDay: "2026-11-20" })] });
  assert.equal(v.stats.doneCount, 0);
  assert.equal(v.stats.workedMs, 0);
  assert.equal(v.isEmpty, true);
});

test("结束一天：有任意一项活动就不算空", () => {
  for (const raw of [
    { allTasks: [task({ id: "a", isDone: true, doneOn: at(0, 9) })] },
    { allTasks: [task({ id: "b", timeSpentOnDay: { [TODAY]: MIN } })] },
    { allTasks: [task({ id: "c", dueDay: TODAY })] },
  ]) assert.equal(build(raw).isEmpty, false);
});

test("结束一天：项目名带出来，收件箱显示中文", () => {
  const v = build({
    allTasks: [task({ id: "a", projectId: "w", isDone: true, doneOn: at(0, 9) }), task({ id: "b", projectId: "INBOX_PROJECT", isDone: true, doneOn: at(0, 10) })],
    projects: [{ id: "w", title: "工作" }, { id: "INBOX_PROJECT", title: "Inbox" }],
  });
  assert.equal(v.done[0].projectTitle, "工作");
  assert.equal(v.done[1].projectTitle, "收件箱");
});

test("结束一天：父任务不能直接计时，行上不给开始按钮", () => {
  const v = build({
    allTasks: [
      task({ id: "p", dueDay: TODAY, subTaskIds: ["c"] }),
      task({ id: "c", parentId: "p", isDone: true }),
    ],
  });
  assert.equal(v.leftOver[0].canTrack, false);
});

test("结束一天：空数据不炸", () => {
  for (const raw of [null, {}, { allTasks: [] }]) {
    const v = build(raw);
    assert.deepEqual(v.done, []);
    assert.deepEqual(v.worked, []);
    assert.deepEqual(v.leftOver, []);
    assert.equal(v.stats.doneCount, 0);
  }
});

test("结束一天：真实样例数据能算出今天的账", () => {
  const v = build(sampleData(NOW));
  // 样例里 finished 今天做完、晨练用了 30 分钟
  assert.ok(v.done.some((t) => t.id === "finished"));
  assert.ok(v.worked.some((t) => t.id === "finished"));
  assert.ok(v.stats.workedMs >= 30 * MIN);
  // 今天排了但没做完的都在待接清单里
  assert.ok(v.leftOver.some((t) => t.id === "report"));
  assert.ok(!v.leftOver.some((t) => t.id === "finished"));
});
