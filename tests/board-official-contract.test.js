import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import vm from "node:vm";
import { importMain } from "./support/source.js";
import { official } from "./support/official-board-harness.js";

const { BOARD_PRESETS, buildBoard, moveTaskToColumn, EM_URGENT, EM_IMPORTANT, KANBAN_IN_PROGRESS } = await importMain("boards.js");
const canonical = official.tags.map(({ id, title }) => ({ id, title }));
const fixture = (tasks, tags = canonical, backlogTaskIds = []) => ({
  allTasks: tasks.map((task) => ({ title: task.id, tagIds: [], isDone: false, projectId: "project", ...task })),
  tags, projects: [{ id: "project", title: "Fixture", isEnableBacklog: true, backlogTaskIds }],
});
const officialBoard = (preset) => official.boards.find((board) => board.id === (preset === "kanban" ? "KANBAN_DEFAULT" : "EISENHOWER_MATRIX"));
const columns = (raw, preset) => buildBoard(raw, { preset }).columns.map((column) => ({ id: column.id, tasks: column.tasks.map((task) => task.id).sort() }));
const expectedColumns = (raw, preset) => officialBoard(preset).panels.map((panel) => ({
  id: panel.id, tasks: raw.allTasks.filter((task) => official.matches(panel, task, raw)).map((task) => task.id).sort(),
}));
const officialPatch = (raw, preset, task, panel) => official.changes(officialBoard(preset).panels.find((item) => item.id === panel), task, raw);
// Local application of a pre-PATCH pure-function result. Server completion
// bookkeeping is verified separately with the actual official reducer helper.
const apply = (raw, taskId, patch) => ({ ...raw, allTasks: raw.allTasks.map((task) => task.id === taskId ? { ...task, ...patch } : task) });

test("the retained official SP 20 source fixture is complete and identifies its archive", () => {
  assert.equal(official.version, "20.0.0");
  assert.equal(official.boards.length, 2);
  assert.deepEqual(canonical.map(({ id }) => id), [EM_URGENT, EM_IMPORTANT, KANBAN_IN_PROGRESS]);
});

for (const preset of ["kanban", "eisenhower"]) {
  test(`${preset} preset identifiers and rules mirror the installed official default`, () => {
    const ours = BOARD_PRESETS[preset];
    const upstream = officialBoard(preset);
    assert.equal(ours.id, upstream.id);
    assert.equal(ours.cols, upstream.cols);
    assert.deepEqual(ours.panels.map((panel) => ({
      id: panel.id, included: panel.includedTagIds, excluded: panel.excludedTagIds,
      done: panel.doneState, parentsOnly: panel.parentsOnly, noBacklog: panel.noBacklog,
    })), upstream.panels.map((panel) => ({
      id: panel.id, included: panel.includedTagIds, excluded: panel.excludedTagIds,
      done: panel.taskDoneState === 2 ? "done" : panel.taskDoneState === 3 ? "undone" : "all",
      parentsOnly: panel.isParentTasksOnly, noBacklog: panel.backlogState === 2,
    })));
  });

  for (const [label, tags] of [
    ["canonical tags", canonical],
    ["renamed canonical tags", canonical.map((tag) => ({ ...tag, title: `改名：${tag.title}` }))],
    ["unique same-name user tags", canonical.map((tag) => ({ ...tag, id: `user-${tag.id}` }))],
    ["duplicate same-name user tags", canonical.flatMap((tag) => [{ ...tag, id: `user1-${tag.id}` }, { ...tag, id: `user2-${tag.id}` }])],
    ["missing tag entities with existing canonical task ids", []],
  ]) {
    test(`${preset} membership matches official rules with ${label}`, () => {
      const allIds = [...new Set([...canonical.map((tag) => tag.id), ...tags.map((tag) => tag.id)])];
      const tasks = [{ id: "plain" }, ...allIds.map((id) => ({ id: `one-${id}`, tagIds: [id] })),
        { id: "both", tagIds: [EM_URGENT, EM_IMPORTANT] },
        { id: "completed", tagIds: [KANBAN_IN_PROGRESS, EM_URGENT], isDone: true },
        { id: "child", parentId: "both", tagIds: [EM_URGENT, EM_IMPORTANT] },
        { id: "backlog", tagIds: [KANBAN_IN_PROGRESS, EM_URGENT] },
        { id: "backlog-child", parentId: "backlog", tagIds: [KANBAN_IN_PROGRESS] }];
      const raw = fixture(tasks, tags, ["backlog"]);
      assert.deepEqual(columns(raw, preset), expectedColumns(raw, preset));
    });
  }

  for (const panel of officialBoard(preset).panels) {
    test(`${preset}/${panel.id} pre-PATCH task changes match official pure rules and the target column`, () => {
      const raw = fixture([{ id: "moving", tagIds: ["unrelated", "TODAY", EM_URGENT, KANBAN_IN_PROGRESS], isDone: true }], [...canonical, { id: "unrelated", title: "保留" }]);
      const task = raw.allTasks[0];
      const wanted = officialPatch(raw, preset, task, panel.id);
      assert.ok(wanted, "Official default panel accepts this move");
      const patch = moveTaskToColumn(raw, { taskId: task.id, preset, columnId: panel.id });
      assert.deepEqual(patch, wanted);
      const readBack = apply(raw, task.id, patch);
      assert.deepEqual(columns(readBack, preset), expectedColumns(readBack, preset));
      assert.equal(official.matches(panel, readBack.allTasks[0], readBack), true);
      assert.ok(readBack.allTasks[0].tagIds.includes("unrelated"));
      assert.ok(!readBack.allTasks[0].tagIds.includes("TODAY"), "Official move removes the virtual Today tag");
    });
  }
}

test("same-name user tags do not satisfy official matrix tags or get written by a matrix move", () => {
  const raw = fixture([{ id: "task", tagIds: ["user-urgent", "user-important"] }], [
    { id: "user-urgent", title: "urgent" }, { id: "user-important", title: "important" },
  ]);
  const view = buildBoard(raw, { preset: "eisenhower" });
  assert.deepEqual(view.missingTags, [EM_IMPORTANT, EM_URGENT]);
  const panel = officialBoard("eisenhower").panels[0];
  assert.equal(official.changes(panel, raw.allTasks[0], raw), null);
  assert.throws(() => moveTaskToColumn(raw, { taskId: "task", preset: "eisenhower", columnId: panel.id }), /标签/);
});

test("a move needing no tag addition is allowed even when the canonical tag entity is missing", () => {
  const raw = fixture([{ id: "task", tagIds: [EM_URGENT, EM_IMPORTANT] }], []);
  const panel = officialBoard("eisenhower").panels[0];
  const wanted = official.changes(panel, raw.allTasks[0], raw);
  assert.deepEqual(wanted, {});
  assert.deepEqual(moveTaskToColumn(raw, { taskId: "task", preset: "eisenhower", columnId: panel.id }), wanted);
});

test("parent-only matrix columns reject child moves just as the official rule does", () => {
  const raw = fixture([{ id: "parent" }, { id: "child", parentId: "parent" }]);
  const panel = officialBoard("eisenhower").panels[0];
  assert.equal(official.changes(panel, raw.allTasks[1], raw), null);
  assert.throws(() => moveTaskToColumn(raw, { taskId: "child", preset: "eisenhower", columnId: panel.id }), /子任务|父任务/);
});

test("kanban refuses to report a move it cannot satisfy without a backlog operation", () => {
  const raw = fixture([{ id: "backlog" }], canonical, ["backlog"]);
  const panel = officialBoard("kanban").panels[1];
  assert.equal(official.changes(panel, raw.allTasks[0], raw).backlog, "moveOut");
  assert.throws(() => moveTaskToColumn(raw, { taskId: "backlog", preset: "kanban", columnId: panel.id }), /积压/);
});

test("matrix leaves completion unchanged; kanban pre-PATCH pure rules only request completion", () => {
  const raw = fixture([{ id: "task", tagIds: [KANBAN_IN_PROGRESS], isDone: false }]);
  const done = officialBoard("kanban").panels[2];
  const patch = moveTaskToColumn(raw, { taskId: "task", preset: "kanban", columnId: done.id });
  assert.deepEqual(patch, official.changes(done, raw.allTasks[0], raw));
  assert.deepEqual(patch, { isDone: true });
  const matrix = officialBoard("eisenhower").panels[2];
  const completeRaw = apply(raw, "task", patch);
  const matrixPatch = moveTaskToColumn(completeRaw, { taskId: "task", preset: "eisenhower", columnId: matrix.id });
  assert.equal(Object.hasOwn(matrixPatch, "isDone"), false);
  assert.deepEqual(matrixPatch, official.changes(matrix, completeRaw.allTasks[0], completeRaw));
});

test("official completion cleanup removes the progress tag, preserves ordinary tags and matches DONE", () => {
  const raw = fixture([{ id: "task", tagIds: [KANBAN_IN_PROGRESS, "ordinary"], isDone: false }], [...canonical, { id: "ordinary", title: "Keep" }]);
  const task = raw.allTasks[0];
  const patch = moveTaskToColumn(raw, { taskId: task.id, preset: "kanban", columnId: "DONE" });
  assert.deepEqual(patch, { isDone: true });
  const cleaned = official.completionUpdate(task, patch);
  assert.deepEqual(cleaned, { id: task.id, changes: { isDone: true, tagIds: ["ordinary"] } });
  const readBack = apply(raw, task.id, cleaned.changes);
  assert.deepEqual(columns(readBack, "kanban"), expectedColumns(readBack, "kanban"));
  assert.equal(official.matches(officialBoard("kanban").panels[2], readBack.allTasks[0], readBack), true);
});

test("official undo completion does not restore the progress tag and returns the task to TODO", () => {
  const raw = fixture([{ id: "task", tagIds: [KANBAN_IN_PROGRESS, "ordinary"], isDone: false }], [...canonical, { id: "ordinary", title: "Keep" }]);
  const task = raw.allTasks[0];
  const completed = official.completionUpdate(task, { isDone: true });
  const completeRaw = apply(raw, task.id, completed.changes);
  const undone = official.completionUpdate(completeRaw.allTasks[0], { isDone: false });
  assert.deepEqual(undone, { id: task.id, changes: { isDone: false } });
  const readBack = apply(completeRaw, task.id, undone.changes);
  assert.deepEqual(readBack.allTasks[0].tagIds, ["ordinary"]);
  assert.deepEqual(columns(readBack, "kanban"), expectedColumns(readBack, "kanban"));
  assert.equal(official.matches(officialBoard("kanban").panels[0], readBack.allTasks[0], readBack), true);
  assert.equal(official.matches(officialBoard("kanban").panels[1], readBack.allTasks[0], readBack), false);
});

function renderNotes(view) {
  let definition;
  const el = (_tag, _className, text = "") => ({ text, children: [], append(...nodes) { this.children.push(...nodes); } });
  const context = vm.createContext({ W: { define: (_type, value) => { definition = value; }, el } });
  const source = fs.readFileSync(new URL("../src/renderer/cards/boards.js", import.meta.url), "utf8");
  new vm.Script(source).runInContext(context);
  const body = el("body");
  definition.render(body, { view });
  const text = (node) => node.text + node.children.map(text).join("");
  return text(body);
}

test("the real renderer explains why ordinary same-name tags cannot replace default system tags", () => {
  const raw = fixture([], canonical.map((tag) => ({ ...tag, id: `user-${tag.id}` })));
  const text = renderNotes(buildBoard(raw, { preset: "eisenhower" }));
  assert.match(text, /系统标签尚未创建/);
  assert.match(text, /同名普通标签/);
  assert.match(text, /ID 不同/);
  assert.match(text, /不会合并或迁移/);
  assert.doesNotMatch(text, /无法确定看板使用哪一个|分类不确定的任务暂不显示/);
});

test("the real renderer uses renamed canonical labels for matrix guidance", () => {
  const raw = fixture([], canonical.map((tag) => ({ ...tag, title: `改名：${tag.title}` })));
  const text = renderNotes(buildBoard(raw, { preset: "eisenhower" }));
  assert.match(text, /改名：urgent/);
  assert.match(text, /改名：important/);
  assert.doesNotMatch(text, /系统标签尚未创建/);
});

test("the real renderer labels its scope as SP default rules", () => {
  let definition;
  const context = vm.createContext({ W: { define: (_type, value) => { definition = value; } } });
  new vm.Script(fs.readFileSync(new URL("../src/renderer/cards/boards.js", import.meta.url), "utf8")).runInContext(context);
  const view = buildBoard(fixture([]), { preset: "eisenhower" });
  assert.match(definition.sub({ view }, false), /SP 默认规则/);
  assert.equal(definition.sub({ view }, true), "0 项");
});
