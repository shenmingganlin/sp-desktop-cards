// 看板与艾森豪威尔矩阵的数据整理：按 SP 20 默认看板的列规则把任务分到各列。
import assert from "node:assert/strict";
import test from "node:test";
import { BOARD_PRESETS, buildBoard, KANBAN_IN_PROGRESS, EM_URGENT, EM_IMPORTANT } from "../src/main/boards.js";
import { NOW, TODAY, sampleData, task } from "./fixtures.js";

const MIN = 60_000;
const ids = (list) => list.map((e) => e.id);
const build = (raw, preset = "kanban", opts = {}) => buildBoard(raw, { preset, today: TODAY, now: NOW, ...opts });

// SP 的默认标签：看板第一次打开时 SP 自己建，id 是写死的
const boardTags = [
  { id: KANBAN_IN_PROGRESS, title: "in-progress", taskIds: [] },
  { id: EM_URGENT, title: "urgent", taskIds: [] },
  { id: EM_IMPORTANT, title: "important", taskIds: [] },
];
const withTags = (allTasks, projects = []) => ({ allTasks, projects, tags: boardTags });

test("看板：默认三列是待办 / 进行中 / 已完成，按 in-progress 标签分", () => {
  const v = build(withTags([
    task({ id: "todo", title: "还没动" }),
    task({ id: "doing", title: "在做的", tagIds: [KANBAN_IN_PROGRESS] }),
    task({ id: "done", title: "做完了", isDone: true }),
  ]));
  assert.deepEqual(v.columns.map((c) => c.id), ["TODO", "IN_PROGRESS", "DONE"]);
  assert.deepEqual(v.columns.map((c) => c.title), ["待办", "进行中", "已完成"]);
  assert.deepEqual(ids(v.columns[0].tasks), ["todo"]);
  assert.deepEqual(ids(v.columns[1].tasks), ["doing"]);
  assert.deepEqual(ids(v.columns[2].tasks), ["done"]);
});

test("看板：挂上进行中标签的任务不会同时留在待办里", () => {
  // SP 的待办列带 excludedTagIds=[in-progress]。少了这条，任务会同时出现在两列，
  // 用户看到同一件事在「待办」和「进行中」各有一份。
  const v = build(withTags([task({ id: "doing", tagIds: [KANBAN_IN_PROGRESS] })]));
  assert.deepEqual(ids(v.columns[0].tasks), []);
  assert.deepEqual(ids(v.columns[1].tasks), ["doing"]);
});

test("看板：做完了还挂着进行中标签，也只进已完成列", () => {
  const v = build(withTags([task({ id: "x", isDone: true, tagIds: [KANBAN_IN_PROGRESS] })]));
  assert.deepEqual(ids(v.columns[1].tasks), []);
  assert.deepEqual(ids(v.columns[2].tasks), ["x"]);
});

test("看板：积压区里的任务不进待办", () => {
  // 三列都是 backlogState=NoBacklog：积压区是「以后再说」，不该混进看板的流动列。
  const raw = withTags(
    [task({ id: "backlog", projectId: "w" }), task({ id: "live", projectId: "w" })],
    [{ id: "w", title: "工作", backlogTaskIds: ["backlog"] }],
  );
  const v = build(raw);
  assert.deepEqual(ids(v.columns[0].tasks), ["live"]);
  assert.ok(!v.columns.some((c) => c.tasks.some((t) => t.id === "backlog")));
});

test("艾森豪威尔矩阵：四个象限按两个标签的组合分，互不重叠也不漏", () => {
  const v = build(withTags([
    task({ id: "both", tagIds: [EM_URGENT, EM_IMPORTANT] }),
    task({ id: "important", tagIds: [EM_IMPORTANT] }),
    task({ id: "urgent", tagIds: [EM_URGENT] }),
    task({ id: "neither" }),
  ]), "eisenhower");
  assert.deepEqual(v.columns.map((c) => c.id), ["URGENT_AND_IMPORTANT", "NOT_URGENT_AND_IMPORTANT", "URGENT_AND_NOT_IMPORTANT", "NOT_URGENT_NOT_IMPORTANT"]);
  assert.deepEqual(v.columns.map((c) => c.title), ["重要且紧急", "重要不紧急", "紧急不重要", "不紧急不重要"]);
  assert.deepEqual(v.columns.map((c) => ids(c.tasks)), [["both"], ["important"], ["urgent"], ["neither"]]);
  // 每条任务正好在一个象限里
  assert.equal(v.columns.reduce((s, c) => s + c.tasks.length, 0), 4);
});

test("艾森豪威尔矩阵：按 SP 的默认看板只看父任务，子任务不单列", () => {
  const v = build(withTags([
    task({ id: "p", tagIds: [EM_IMPORTANT], subTaskIds: ["c"] }),
    task({ id: "c", parentId: "p", tagIds: [EM_URGENT] }),
  ]), "eisenhower");
  assert.deepEqual(ids(v.columns[1].tasks), ["p"]);
  assert.deepEqual(ids(v.columns[2].tasks), []);
});

test("缺标签时说清楚缺哪几个，不静默显示成空板", () => {
  // 这两个标签是 SP 第一次打开看板时才建的。没有它们，整个矩阵会掉进「不紧急不重要」，
  // 看起来像「我没有任何重要的事」——比报错更容易误导。
  const v = build({ allTasks: [task({ id: "a" })], projects: [], tags: [] }, "eisenhower");
  assert.deepEqual(v.missingTags, [EM_URGENT, EM_IMPORTANT]);
  assert.equal(v.needsSetup, true);
  // 看板也一样：没有 in-progress 标签，进行中列永远是空的
  assert.deepEqual(build({ allTasks: [], projects: [], tags: [] }).missingTags, [KANBAN_IN_PROGRESS]);
});

test("标签都在时不报缺标签", () => {
  const v = build(withTags([task({ id: "a" })]), "eisenhower");
  assert.deepEqual(v.missingTags, []);
  assert.equal(v.needsSetup, false);
});

test("列内排序：逾期的在前，然后按计划时刻，最后按 SP 里的顺序", () => {
  const v = build(withTags([
    task({ id: "plain" }),
    task({ id: "later", dueWithTime: NOW + 3600_000 }),
    task({ id: "soon", dueWithTime: NOW + 60_000 }),
    task({ id: "overdue", dueWithTime: NOW - 60_000 }),
  ]));
  assert.deepEqual(ids(v.columns[0].tasks), ["overdue", "soon", "later", "plain"]);
});

test("每个任务带上卡片要用的字段，且带出项目名", () => {
  const raw = withTags([task({ id: "a", projectId: "w", timeEstimate: 30 * MIN, timeSpent: 10 * MIN })], [{ id: "w", title: "工作" }]);
  const row = build(raw).columns[0].tasks[0];
  assert.equal(row.projectTitle, "工作");
  assert.equal(row.estimate, 30 * MIN);
  assert.equal(row.spent, 10 * MIN);
  assert.equal(row.left, 20 * MIN);
  assert.equal(row.canTrack, true);
  assert.equal(row.isCurrent, false);
});

test("未知的预设名退回看板，不抛异常", () => {
  const v = build(withTags([task({ id: "a" })]), "nope");
  assert.equal(v.preset, "kanban");
  assert.deepEqual(v.columns.map((c) => c.id), ["TODO", "IN_PROGRESS", "DONE"]);
});

test("空数据不炸", () => {
  for (const raw of [null, {}, { allTasks: [] }]) {
    const v = build(raw);
    assert.equal(v.columns.length, 3);
    assert.ok(v.columns.every((c) => Array.isArray(c.tasks)));
    assert.equal(v.counts.total, 0);
  }
});

test("两个预设的列定义和 SP 20 的默认看板一致", () => {
  assert.equal(BOARD_PRESETS.kanban.cols, 3);
  assert.equal(BOARD_PRESETS.eisenhower.cols, 2);
  assert.equal(BOARD_PRESETS.eisenhower.panels.length, 4);
  // 默认看板都不带显式成员（taskIds），全靠标签和状态规则
  for (const preset of Object.values(BOARD_PRESETS)) {
    for (const panel of preset.panels) assert.deepEqual(panel.taskIds, []);
  }
});

test("看板列不设「只看父任务」，子任务自己占一行；矩阵只看父任务", () => {
  // 两个预设在这点上不一样：SP 的看板面板 isParentTasksOnly=false，矩阵是 true。
  // 写反了矩阵会变成一板子的子任务，看板则会把拆解步骤全藏起来。
  const raw = { ...sampleData(NOW), tags: [...sampleData(NOW).tags, ...boardTags] };
  const kanban = new Set(build(raw).columns.flatMap((c) => c.tasks.map((t) => t.id)));
  assert.ok(kanban.has("parent"));
  assert.ok(kanban.has("c1"), "看板里子任务自己占一行");

  const matrix = new Set(build(raw, "eisenhower").columns.flatMap((c) => c.tasks.map((t) => t.id)));
  assert.ok(matrix.has("parent"));
  assert.ok(!matrix.has("c1"), "矩阵只看父任务");
});
