// 热力图卡的数据整理：按周排的网格、档位、连续天数。
import assert from "node:assert/strict";
import test from "node:test";
import { buildHeatmap } from "../src/main/heatmap.js";
import { NOW, TODAY, sampleData, task } from "./fixtures.js";

const MIN = 60_000;
const dayStr = (offset) => {
  const b = new Date(NOW);
  const d = new Date(b.getFullYear(), b.getMonth(), b.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

const build = (raw, opts = {}) => buildHeatmap(raw, { today: TODAY, now: NOW, ...opts });

test("热力图：默认 13 周，每列 7 天，最后一列包含今天", () => {
  const v = build(sampleData(NOW));
  assert.equal(v.weeks, 13);
  assert.equal(v.days.length, 91);
  assert.equal(v.cells.length, 13);
  assert.ok(v.cells.every((c) => c.length === 7));
  const flat = v.cells.flat();
  assert.equal(flat.at(-1).day >= TODAY, true);
  assert.equal(flat.find((d) => d.isToday).day, TODAY);
});

test("热力图：窗口从周一开始，第一列不满时标成不在范围", () => {
  const v = build(sampleData(NOW));
  const first = v.days[0];
  const [y, m, d] = first.day.split("-").map(Number);
  assert.equal(new Date(y, m - 1, d).getDay(), 1); // 周一
  const last = v.days.at(-1);
  const [ly, lm, ld] = last.day.split("-").map(Number);
  assert.equal(new Date(ly, lm - 1, ld).getDay(), 0); // 周日
  // 今天之后的日子不在范围里
  assert.ok(v.days.filter((x) => !x.inRange).every((x) => x.day > TODAY));
});

test("热力图：用时只按叶子任务累加", () => {
  const raw = {
    allTasks: [
      task({ id: "p", subTaskIds: ["c"], timeSpentOnDay: { [TODAY]: 90 * MIN } }),
      task({ id: "c", parentId: "p", timeSpentOnDay: { [TODAY]: 90 * MIN } }),
      task({ id: "a", timeSpentOnDay: { [TODAY]: 30 * MIN } }),
    ],
  };
  const v = build(raw);
  const today = v.days.find((d) => d.isToday);
  assert.equal(today.spent, 120 * MIN);
});

test("热力图：完成数按 doneOn 落到那天，子任务不重复计", () => {
  const raw = {
    allTasks: [
      task({ id: "a", isDone: true, doneOn: NOW }),
      task({ id: "p", isDone: true, doneOn: NOW, subTaskIds: ["k"] }),
      task({ id: "k", parentId: "p", isDone: true, doneOn: NOW }),
    ],
  };
  const v = build(raw);
  assert.equal(v.days.find((d) => d.isToday).done, 2);
});

test("热力图：doneOn 是日期字符串也认得", () => {
  const v = build({ allTasks: [task({ id: "a", isDone: true, doneOn: dayStr(-1) })] });
  assert.equal(v.days.find((d) => d.day === dayStr(-1)).done, 1);
});

test("热力图：档位按本周峰值分四档，有记录的最少一档", () => {
  const raw = {
    allTasks: [
      task({ id: "a", timeSpentOnDay: { [TODAY]: 100 * MIN } }),
      task({ id: "b", timeSpentOnDay: { [dayStr(-1)]: 10 * MIN } }),
      task({ id: "c", timeSpentOnDay: { [dayStr(-2)]: 50 * MIN } }),
    ],
  };
  const v = build(raw);
  const at = (day) => v.days.find((d) => d.day === day);
  assert.equal(v.peak, 100 * MIN);
  assert.equal(at(TODAY).level, 4); // 100%
  assert.equal(at(dayStr(-2)).level, 2); // 50%
  assert.equal(at(dayStr(-1)).level, 1); // 10%
  assert.equal(at(dayStr(-3)).level, 0); // 没记录
});

test("热力图：只有完成数没有用时，也算有记录", () => {
  const v = build({ allTasks: [task({ id: "a", isDone: true, doneOn: NOW })] });
  const today = v.days.find((d) => d.isToday);
  assert.equal(today.spent, 0);
  assert.equal(today.level, 1);
  assert.equal(v.active, 1);
});

test("热力图：连续天数从今天往前数，今天还没干活不算断", () => {
  const raw = {
    allTasks: [
      task({ id: "a", timeSpentOnDay: { [dayStr(-1)]: 10 * MIN } }),
      task({ id: "b", timeSpentOnDay: { [dayStr(-2)]: 10 * MIN } }),
      task({ id: "c", timeSpentOnDay: { [dayStr(-4)]: 10 * MIN } }), // -3 断了
    ],
  };
  const v = build(raw);
  assert.equal(v.streak, 2);
});

test("热力图：今天干了活，连续天数从今天算起", () => {
  const raw = {
    allTasks: [
      task({ id: "a", timeSpentOnDay: { [TODAY]: 10 * MIN } }),
      task({ id: "b", timeSpentOnDay: { [dayStr(-1)]: 10 * MIN } }),
    ],
  };
  assert.equal(build(raw).streak, 2);
});

test("热力图：中间断一天就停", () => {
  const raw = {
    allTasks: [
      task({ id: "a", timeSpentOnDay: { [TODAY]: 10 * MIN } }),
      task({ id: "b", timeSpentOnDay: { [dayStr(-2)]: 10 * MIN } }),
    ],
  };
  assert.equal(build(raw).streak, 1);
});

test("热力图：合计和活跃天数只算窗口内", () => {
  const raw = {
    allTasks: [
      task({ id: "a", timeSpentOnDay: { [TODAY]: 30 * MIN, [dayStr(-100)]: 99 * MIN } }),
      task({ id: "b", timeSpentOnDay: { [dayStr(-2)]: 20 * MIN } }),
    ],
  };
  const v = build(raw);
  assert.equal(v.total, 50 * MIN);
  assert.equal(v.active, 2);
});

test("热力图：weeks 参数决定宽度，夹在 1~53", () => {
  assert.equal(build(sampleData(NOW), { weeks: 4 }).days.length, 28);
  assert.equal(build(sampleData(NOW), { weeks: 0 }).weeks, 1);
  assert.equal(build(sampleData(NOW), { weeks: 999 }).weeks, 53);
});

test("热力图：today 不合法时返回空结构", () => {
  const v = build(sampleData(NOW), { today: "" });
  assert.equal(v.days.length, 0);
  assert.equal(v.total, 0);
});

test("热力图：空数据不炸", () => {
  for (const raw of [null, {}, { allTasks: [] }]) {
    const v = build(raw);
    assert.equal(v.total, 0);
    assert.equal(v.active, 0);
    assert.equal(v.streak, 0);
    assert.equal(v.peak, 0);
  }
});
