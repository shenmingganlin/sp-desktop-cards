// 看板与艾森豪威尔矩阵的数据整理：按 SP 20 默认看板的列规则把任务分到各列。
import assert from "node:assert/strict";
import test from "node:test";
import { BOARD_PRESETS, buildBoard, moveTaskToColumn, KANBAN_IN_PROGRESS, EM_URGENT, EM_IMPORTANT } from "../src/main/boards.js";
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

test("缺标签只挂提示，看板照样把任务分出来", () => {
  // 回归：早先缺标签时把整张卡换成「缺标签」，用户看到的是「SP 里有数据但卡片没有」。
  // SP 自己不是这么做的 —— 它在看板上方挂一条提示，看板照常渲染。
  const v = build({ allTasks: [task({ id: "a" }), task({ id: "b", isDone: true })], projects: [], tags: [] });
  assert.deepEqual(v.missingTags, [KANBAN_IN_PROGRESS]);
  assert.deepEqual(ids(v.columns[0].tasks), ["a"]);
  assert.deepEqual(ids(v.columns[2].tasks), ["b"]);
  assert.equal(v.counts.total, 2, "数据要照常出来");
});

test("缺的标签只影响包含它的那一列，排除它的列不受影响", () => {
  // 待办列是 excludedTagIds=[in-progress]：标签不存在 = 没有东西可排除，全部照列。
  // 进行中列是 includedTagIds=[in-progress]：标签不存在，这列确实永远空着，要说清楚。
  const v = build({ allTasks: [task({ id: "a" })], projects: [], tags: [] });
  assert.deepEqual(v.blankColumns, ["IN_PROGRESS"]);
  assert.ok(!v.blankColumns.includes("TODO"));
});

test("艾森豪威尔缺标签时四个象限都会空，提示要说明白", () => {
  const v = build({ allTasks: [task({ id: "a" })], projects: [], tags: [] }, "eisenhower");
  assert.deepEqual(v.missingTags, [EM_URGENT, EM_IMPORTANT]);
  // 除了「不紧急不重要」，另外三个象限都靠这两个标签
  assert.deepEqual(v.blankColumns, ["URGENT_AND_IMPORTANT", "NOT_URGENT_AND_IMPORTANT", "URGENT_AND_NOT_IMPORTANT"]);
  // 但列本身照画：任务掉进「不紧急不重要」是真话，不是 bug
  assert.deepEqual(ids(v.columns[3].tasks), ["a"]);
});

test("矩阵缺标签时，掉进「不紧急不重要」的格子要标成「未分类」", () => {
  // 回归：SP 里还没有 urgent/important 标签时，全部任务都满足「两个标签都没有」，
  // 于是齐刷刷掉进第四格。格名写着「不紧急不重要」——那是在替用户下判断，
  // 而他从来没标过任何一条。这一格这时其实是「还没分类」。
  const v = build({ allTasks: [task({ id: "a" }), task({ id: "b" })], projects: [], tags: [] }, "eisenhower");
  assert.equal(v.columns[3].title, "未分类", "缺标签时第四格不能叫「不紧急不重要」");
  assert.equal(v.columns[3].isUntaggedBucket, true);
  // 另外三格的标题不动：它们确实是空的，标题没骗人
  assert.equal(v.columns[0].title, "重要且紧急");
});

test("标签建好了但一条都没标过，第四格照样叫「未分类」", () => {
  // 真实踩到的情形：标签建出来了，可 48 条任务全没打过标。
  // 第四格照样装满全部任务，写「不紧急不重要」还是替用户下判断。
  const v = build(withTags([task({ id: "a" }), task({ id: "b" })]), "eisenhower");
  assert.deepEqual(v.missingTags, [], "标签是齐的");
  assert.equal(v.columns[3].title, "未分类");
  assert.equal(v.columns[3].isUntaggedBucket, true);
});

test("开始分类以后，第四格恢复 SP 的名字", () => {
  // 只要有一条任务带上 urgent 或 important，说明分类在起作用，
  // 剩下的没带标签的落进第四格就是 SP 自己的规则，照 SP 的名字叫。
  const v = build(withTags([
    task({ id: "a", tagIds: [EM_IMPORTANT] }),
    task({ id: "b" }),
  ]), "eisenhower");
  assert.equal(v.columns[1].title, "重要不紧急");
  assert.deepEqual(ids(v.columns[1].tasks), ["a"]);
  assert.equal(v.columns[3].title, "不紧急不重要");
  assert.equal(v.columns[3].isUntaggedBucket, false);
  assert.deepEqual(ids(v.columns[3].tasks), ["b"]);
});

test("矩阵只缺一个标签、但另一个在用，第四格还是「不紧急不重要」", () => {
  // 只缺 urgent：带 important 的任务仍能分出「重要不紧急」，分类在起作用。
  const v = build({
    allTasks: [task({ id: "a", tagIds: [EM_IMPORTANT] }), task({ id: "b" })],
    projects: [],
    tags: [{ id: EM_IMPORTANT, title: "important", taskIds: [] }],
  }, "eisenhower");
  assert.deepEqual(v.missingTags, [EM_URGENT]);
  assert.equal(v.columns[3].title, "不紧急不重要");
  assert.equal(v.columns[3].isUntaggedBucket, false);
});

test("标签都在时不报缺标签，也没有空列提示", () => {
  const v = build(withTags([task({ id: "a" })]), "eisenhower");
  assert.deepEqual(v.missingTags, []);
  assert.deepEqual(v.blankColumns, []);
});

test("标签 ID 不是 SP 写死的那种时，按名字认出来", () => {
  // 用户可能从 SP 界面或插件 API 建同名标签，ID 就是随机的。
  // 只按写死 ID 匹配的话，看板会显示「没有 in-progress 标签」并把列留空，
  // 而用户明明建了 —— 这正是「SP 里有数据但卡片没有」的另一种形态。
  const v = build({
    allTasks: [
      task({ id: "todo" }),
      task({ id: "doing", tagIds: ["random-id-1"] }),
      task({ id: "done", isDone: true }),
    ],
    projects: [],
    tags: [{ id: "random-id-1", title: "in-progress", taskIds: [] }],
  });
  assert.deepEqual(v.missingTags, [], "名字对上了就不算缺");
  assert.deepEqual(ids(v.columns[0].tasks), ["todo"]);
  assert.deepEqual(ids(v.columns[1].tasks), ["doing"], "进行中列要真的分出来");
  assert.deepEqual(ids(v.columns[2].tasks), ["done"]);
});

test("名字按大小写不敏感匹配，SP 里叫 In-Progress 也认", () => {
  const v = build({
    allTasks: [task({ id: "doing", tagIds: ["x"] })],
    projects: [],
    tags: [{ id: "x", title: "In-Progress", taskIds: [] }],
  });
  assert.deepEqual(v.missingTags, []);
  assert.deepEqual(ids(v.columns[1].tasks), ["doing"]);
});

test("写死 ID 存在时优先用它，不受同名标签干扰", () => {
  // SP 里可能同时有一个 ID 正确的 in-progress 和一个用户手建的随机 ID 同名标签。
  // 以写死 ID 为准，避免把两个标签的任务混在一起。
  const v = build({
    allTasks: [
      task({ id: "official", tagIds: [KANBAN_IN_PROGRESS] }),
      task({ id: "stray", tagIds: ["random"] }),
    ],
    projects: [],
    tags: [
      { id: KANBAN_IN_PROGRESS, title: "in-progress", taskIds: [] },
      { id: "random", title: "in-progress", taskIds: [] },
    ],
  });
  assert.deepEqual(v.missingTags, []);
  assert.deepEqual(ids(v.columns[1].tasks), ["official"]);
  assert.deepEqual(ids(v.columns[0].tasks), ["stray"], "同名但不是那个 ID 的，按没打标签处理");
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

test("底栏的「预估剩余」要真的算出来，不能永远 0", () => {
  // 回归：counts.left 对 row 调 left()，但 row 上只有 estimate/spent，
  // 没有 timeEstimate/timeSpent，left() 读到 undefined 得 0。
  // 结果底栏的「预估剩余 X」从来不显示 —— 看起来像「这些任务都没估时」。
  const v = build(withTags([
    task({ id: "a", timeEstimate: 30 * MIN, timeSpent: 10 * MIN }),
    task({ id: "b", timeEstimate: 60 * MIN }),
    task({ id: "done", isDone: true, timeEstimate: 99 * MIN }),
  ]));
  assert.equal(v.counts.left, 80 * MIN, "20 + 60，已完成的不算");
});

test("重复任务的实例要在行上标出来，换列才知道只改了今天这一条", () => {
  // SP 的重复任务每天生成一个新实例，实例有自己的 tagIds，模板另存一份。
  // 看板换列只 PATCH 实例 —— 明天的新实例还回原列。
  // 不在行上标出来，用户会以为「拖进进行中」这件事生效了，第二天发现白做。
  const v = build(withTags([
    task({ id: "once", title: "一次性" }),
    task({ id: "daily", title: "每天", repeatCfgId: "cfg1" }),
  ]));
  const rows = v.columns.flatMap((c) => c.tasks);
  const daily = rows.find((r) => r.id === "daily");
  const once = rows.find((r) => r.id === "once");
  assert.equal(daily.isRepeat, true);
  assert.equal(once.isRepeat, false);
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

// ── 换列：看板不能只是只读的展示 ──

test("看板换列：待办 → 进行中，加上 in-progress 标签", () => {
  const raw = withTags([task({ id: "a", tagIds: ["keep-me"] })]);
  const next = moveTaskToColumn(raw, { taskId: "a", columnId: "IN_PROGRESS", preset: "kanban" });
  assert.deepEqual(next.tagIds, ["keep-me", KANBAN_IN_PROGRESS], "别的标签不能丢");
});

test("看板换列：进行中 → 待办，摘掉 in-progress，别的标签留着", () => {
  const raw = withTags([task({ id: "a", tagIds: ["keep-me", KANBAN_IN_PROGRESS] })]);
  const next = moveTaskToColumn(raw, { taskId: "a", columnId: "TODO", preset: "kanban" });
  assert.deepEqual(next.tagIds, ["keep-me"]);
});

test("看板换列：已经在目标列时不重复加标签", () => {
  const raw = withTags([task({ id: "a", tagIds: [KANBAN_IN_PROGRESS] })]);
  const next = moveTaskToColumn(raw, { taskId: "a", columnId: "IN_PROGRESS", preset: "kanban" });
  assert.deepEqual(next.tagIds, [KANBAN_IN_PROGRESS], "不能变成两个一样的标签");
});

test("看板换列：已完成列靠 isDone，不靠标签", () => {
  const raw = withTags([task({ id: "a", tagIds: ["keep-me"] })]);
  const next = moveTaskToColumn(raw, { taskId: "a", columnId: "DONE", preset: "kanban" });
  assert.deepEqual(next.tagIds, ["keep-me"], "标签原样");
  assert.equal(next.isDone, true);
});

test("看板换列：从已完成拖回待办，要取消完成", () => {
  const raw = withTags([task({ id: "a", isDone: true, tagIds: [KANBAN_IN_PROGRESS] })]);
  const next = moveTaskToColumn(raw, { taskId: "a", columnId: "TODO", preset: "kanban" });
  assert.equal(next.isDone, false);
  assert.deepEqual(next.tagIds, [], "in-progress 也要摘掉");
});

test("矩阵换列：四个格子按两个标签的组合来", () => {
  const raw = withTags([task({ id: "a" })]);
  const set = (columnId) => moveTaskToColumn(raw, { taskId: "a", columnId, preset: "eisenhower" }).tagIds.sort();
  assert.deepEqual(set("URGENT_AND_IMPORTANT"), [EM_IMPORTANT, EM_URGENT].sort());
  assert.deepEqual(set("NOT_URGENT_AND_IMPORTANT"), [EM_IMPORTANT]);
  assert.deepEqual(set("URGENT_AND_NOT_IMPORTANT"), [EM_URGENT]);
  assert.deepEqual(set("NOT_URGENT_NOT_IMPORTANT"), [], "两个标签都摘掉");
});

test("矩阵换列：从「重要且紧急」挪到「重要不紧急」，摘掉 urgent 留着 important", () => {
  const raw = withTags([task({ id: "a", tagIds: [EM_URGENT, EM_IMPORTANT] })]);
  const next = moveTaskToColumn(raw, { taskId: "a", columnId: "NOT_URGENT_AND_IMPORTANT", preset: "eisenhower" });
  assert.deepEqual(next.tagIds, [EM_IMPORTANT]);
});

test("换列时标签按名字解析，不只认写死 ID", () => {
  // 和分列同一套道理：用户手建的 in-progress（ID 随机）也要认。
  const raw = { allTasks: [task({ id: "a", tagIds: ["random-ip"] })], projects: [], tags: [{ id: "random-ip", title: "in-progress", taskIds: [] }] };
  const next = moveTaskToColumn(raw, { taskId: "a", columnId: "TODO", preset: "kanban" });
  assert.deepEqual(next.tagIds, [], "摘掉的是那个真实存在的同名标签");
});

test("换列：不认识的列 / 找不到的任务都明确报错，不静默改坏", () => {
  const raw = withTags([task({ id: "a" })]);
  assert.throws(() => moveTaskToColumn(raw, { taskId: "a", columnId: "NOPE", preset: "kanban" }), /列/);
  assert.throws(() => moveTaskToColumn(raw, { taskId: "zzz", columnId: "TODO", preset: "kanban" }), /任务/);
});

test("换列：矩阵里拖动已完成的任务，不悄悄把它变成未完成", () => {
  // 矩阵四格都是 doneState=all，已完成的任务也在里面。
  // 挪个格子顺手取消完成，等于用户只想分类却把活干回去了。
  // 返回的 patch 里根本不该出现 isDone —— 出现就意味着要动完成状态。
  const raw = withTags([task({ id: "a", isDone: true, tagIds: [EM_URGENT] })]);
  const next = moveTaskToColumn(raw, { taskId: "a", columnId: "NOT_URGENT_AND_IMPORTANT", preset: "eisenhower" });
  assert.ok(!("isDone" in next), "完成状态不该进 patch");
  assert.deepEqual(next.tagIds, [EM_IMPORTANT]);
});

test("换列：看板里完成状态没变时不写 isDone，省掉一次无意义的改", () => {
  const raw = withTags([task({ id: "a", isDone: false })]);
  const next = moveTaskToColumn(raw, { taskId: "a", columnId: "TODO", preset: "kanban" });
  assert.ok(!("isDone" in next));
});
