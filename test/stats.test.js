// 统计卡的数据整理：7 天用时、完成数、今日概览。全是纯函数。
import assert from "node:assert/strict";
import test from "node:test";
import { buildStats } from "../src/main/stats.js";
import { NOW, TODAY, sampleData, task } from "./fixtures.js";

const MIN = 60_000;
const dayStr = (offset, base = NOW) => {
  const b = new Date(base);
  const d = new Date(b.getFullYear(), b.getMonth(), b.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

const empty = () => buildStats({ allTasks: [] }, { today: TODAY, now: NOW });

test("统计：没有任务时仍然给出 7 天，数字都是 0", () => {
  const v = empty();
  assert.equal(v.days.length, 7);
  assert.deepEqual(v.days.map((d) => d.day), [-6, -5, -4, -3, -2, -1, 0].map((o) => dayStr(o)));
  assert.ok(v.days.every((d) => d.spent === 0 && d.done === 0));
  assert.equal(v.days.at(-1).isToday, true);
  assert.equal(v.todaySpent, 0);
  assert.equal(v.todayDone, 0);
  assert.equal(v.weekSpent, 0);
  assert.equal(v.weekDone, 0);
  assert.equal(v.peak, 0);
  assert.equal(v.avg, 0);
});

test("统计：用时只按叶子任务累加，父任务不重复计", () => {
  const v = buildStats(sampleData(NOW), { today: TODAY, now: NOW });
  // 今天：写周报 20 + 改版本号 10 + 写更新说明 5 + 晨练 30 = 65 分钟；父任务「整理发布」不再加一遍
  assert.equal(v.todaySpent, 65 * MIN);
  assert.equal(v.days.at(-1).spent, 65 * MIN);
  // 昨天：写更新说明 15 分钟
  assert.equal(v.days.at(-2).spent, 15 * MIN);
  assert.equal(v.weekSpent, 80 * MIN);
  assert.equal(v.peak, 65 * MIN);
  assert.equal(v.avg, (80 * MIN) / 7);
});

test("统计：完成数按 doneOn 落到那天，子任务不重复计", () => {
  const v = buildStats(
    {
      allTasks: [
        task({ id: "a", isDone: true, doneOn: NOW }),
        task({ id: "p", isDone: true, doneOn: NOW, subTaskIds: ["k"] }),
        task({ id: "k", parentId: "p", isDone: true, doneOn: NOW }),
        task({ id: "old", isDone: true, doneOn: NOW - 2 * 86400_000 }),
        task({ id: "nodate", isDone: true }),
      ],
    },
    { today: TODAY, now: NOW },
  );
  assert.equal(v.todayDone, 2); // a 和 p；k 挂在 p 下面，不再数一次
  assert.equal(v.days.at(-3).done, 1); // 两天前的 old
  assert.equal(v.weekDone, 3);
  assert.equal(v.days.at(-2).done, 0);
});

test("统计：doneOn 是日期字符串也认得", () => {
  const v = buildStats({ allTasks: [task({ id: "a", isDone: true, doneOn: dayStr(-1) })] }, { today: TODAY, now: NOW });
  assert.equal(v.todayDone, 0);
  assert.equal(v.days.at(-2).done, 1);
});

test("统计：日界按 dayStartHour 算，凌晨算前一天", () => {
  const at1am = new Date(2026, 10, 2, 1, 0, 0).getTime();
  const raw = { allTasks: [task({ id: "a", isDone: true, doneOn: at1am })] };
  assert.equal(buildStats(raw, { today: TODAY, now: NOW }).days.at(-1).done, 1);
  assert.equal(buildStats(raw, { today: TODAY, now: NOW, dayStartHour: 4 }).days.at(-2).done, 1);
});

test("统计：窗口外的用时和完成数不算进 7 天合计", () => {
  const v = buildStats(
    {
      allTasks: [
        task({ id: "a", timeSpentOnDay: { [dayStr(-10)]: 90 * MIN, [dayStr(-6)]: 30 * MIN } }),
        task({ id: "b", isDone: true, doneOn: NOW - 10 * 86400_000 }),
      ],
    },
    { today: TODAY, now: NOW },
  );
  assert.equal(v.weekSpent, 30 * MIN);
  assert.equal(v.weekDone, 0);
});

test("统计：days 参数决定窗口长度", () => {
  const v = buildStats(sampleData(NOW), { today: TODAY, now: NOW, days: 3 });
  assert.equal(v.days.length, 3);
  assert.equal(v.days.at(-1).day, TODAY);
  assert.equal(v.weekSpent, 80 * MIN);
});
