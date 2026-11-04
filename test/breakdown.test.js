// 时间去向卡的数据整理：按项目或标签分摊最近几天的时间。
import assert from "node:assert/strict";
import test from "node:test";
import { buildBreakdown } from "../src/main/breakdown.js";
import { NOW, TODAY, sampleData, task } from "./fixtures.js";

const MIN = 60_000;
const dayStr = (offset) => {
  const b = new Date(NOW);
  const d = new Date(b.getFullYear(), b.getMonth(), b.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

const build = (raw, opts = {}) => buildBreakdown(raw, { today: TODAY, now: NOW, ...opts });

test("时间去向：按标签分摊，从大到小", () => {
  const raw = {
    allTasks: [
      task({ id: "a", tagIds: ["work"], timeSpentOnDay: { [TODAY]: 60 * MIN } }),
      task({ id: "b", tagIds: ["home"], timeSpentOnDay: { [TODAY]: 30 * MIN } }),
    ],
    tags: [{ id: "work", title: "工作" }, { id: "home", title: "家里" }],
  };
  const v = build(raw, { by: "tag" });
  assert.deepEqual(v.buckets.map((b) => b.title), ["工作", "家里"]);
  assert.equal(v.buckets[0].ms, 60 * MIN);
  assert.equal(v.buckets[0].share, 60 / 90);
  assert.equal(v.total, 90 * MIN);
});

test("时间去向：按项目分摊，收件箱显示中文名", () => {
  const raw = {
    allTasks: [
      task({ id: "a", projectId: "INBOX_PROJECT", timeSpentOnDay: { [TODAY]: 20 * MIN } }),
      task({ id: "b", projectId: "work", timeSpentOnDay: { [TODAY]: 40 * MIN } }),
    ],
    projects: [{ id: "work", title: "学业" }],
  };
  const v = build(raw, { by: "project" });
  assert.deepEqual(v.buckets.map((b) => b.title), ["学业", "收件箱"]);
});

test("时间去向：一条任务挂多个标签时每个标签各算一次，counted 记实际总时长", () => {
  const raw = {
    allTasks: [task({ id: "a", tagIds: ["x", "y"], timeSpentOnDay: { [TODAY]: 60 * MIN } })],
    tags: [{ id: "x", title: "X" }, { id: "y", title: "Y" }],
  };
  const v = build(raw, { by: "tag" });
  assert.equal(v.buckets.length, 2);
  assert.equal(v.total, 120 * MIN); // 分摊后合计翻倍
  assert.equal(v.counted, 60 * MIN); // 实际只有 60 分钟
  assert.equal(v.groups, 2);
});

test("时间去向：没有标签的任务算「没有标签」", () => {
  const raw = { allTasks: [task({ id: "a", tagIds: [], timeSpentOnDay: { [TODAY]: 30 * MIN } })], tags: [] };
  const v = build(raw, { by: "tag" });
  assert.deepEqual(v.buckets.map((b) => b.title), ["没有标签"]);
});

test("时间去向：只算窗口内的天数", () => {
  const raw = {
    allTasks: [
      task({ id: "a", tagIds: ["w"], timeSpentOnDay: { [TODAY]: 10 * MIN, [dayStr(-6)]: 20 * MIN, [dayStr(-7)]: 99 * MIN } }),
    ],
    tags: [{ id: "w", title: "工作" }],
  };
  const v = build(raw, { by: "tag", days: 7 });
  assert.equal(v.buckets[0].ms, 30 * MIN);
  assert.equal(v.from, dayStr(-6));
});

test("时间去向：前 top 名之外合成「其他」", () => {
  const allTasks = Array.from({ length: 8 }, (_, i) =>
    task({ id: `t${i}`, tagIds: [`t${i}`], timeSpentOnDay: { [TODAY]: (8 - i) * MIN } }),
  );
  const tags = allTasks.map((t, i) => ({ id: `t${i}`, title: `标签${i}` }));
  const v = build({ allTasks, tags }, { by: "tag", top: 5 });
  assert.equal(v.buckets.length, 5);
  assert.equal(v.buckets[0].title, "标签0");
  // 6、7、8 分钟被挤到「其他」（各自是 (8-i) 分钟，i=5,6,7 → 3、2、1）
  assert.equal(v.other, 3 * MIN + 2 * MIN + 1 * MIN);
});

test("时间去向：用时只按叶子任务累加", () => {
  const raw = {
    allTasks: [
      task({ id: "p", tagIds: ["w"], subTaskIds: ["c"], timeSpentOnDay: { [TODAY]: 90 * MIN } }),
      task({ id: "c", parentId: "p", tagIds: ["w"], timeSpentOnDay: { [TODAY]: 90 * MIN } }),
    ],
    tags: [{ id: "w", title: "工作" }],
  };
  assert.equal(build(raw, { by: "tag" }).buckets[0].ms, 90 * MIN);
});

test("时间去向：share 加起来是 1（含其他时不到 1）", () => {
  const raw = {
    allTasks: [
      task({ id: "a", tagIds: ["x"], timeSpentOnDay: { [TODAY]: 75 * MIN } }),
      task({ id: "b", tagIds: ["y"], timeSpentOnDay: { [TODAY]: 25 * MIN } }),
    ],
    tags: [{ id: "x", title: "X" }, { id: "y", title: "Y" }],
  };
  const v = build(raw, { by: "tag" });
  const sum = v.buckets.reduce((s, b) => s + b.share, 0) + (v.other ? v.other / v.total : 0);
  assert.ok(Math.abs(sum - 1) < 1e-9);
});

test("时间去向：by 只认 tag 和 project，别的值当 tag", () => {
  assert.equal(build({ allTasks: [] }, { by: "nonsense" }).by, "tag");
  assert.equal(build({ allTasks: [] }, { by: "project" }).by, "project");
});

test("时间去向：today 不合法时返回空结构", () => {
  const v = build({ allTasks: [] }, { today: "" });
  assert.equal(v.buckets.length, 0);
  assert.equal(v.total, 0);
});

test("时间去向：空数据不炸", () => {
  for (const raw of [null, {}, { allTasks: [] }]) {
    const v = build(raw);
    assert.deepEqual(v.buckets, []);
    assert.equal(v.other, 0);
    assert.equal(v.total, 0);
  }
});

test("时间去向：样例数据能算出结果", () => {
  const v = build(sampleData(NOW), { by: "project", days: 7 });
  assert.ok(v.total > 0);
  assert.equal(v.counted, v.total); // 项目视角不重复计数
});
