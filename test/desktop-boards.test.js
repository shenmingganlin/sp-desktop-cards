// Synthetic regressions for the desktop-boards audit group; no SP or Electron access.
import assert from "node:assert/strict";
import test from "node:test";
import { buildBoard, moveTaskToColumn, KANBAN_IN_PROGRESS, EM_URGENT, EM_IMPORTANT } from "../src/main/boards.js";
import { NOW, TODAY, task } from "./fixtures.js";
import { createRenderer } from "./renderer-harness.js";
import { official } from "../tests/support/official-board-harness.js";

const build = (raw, preset = "kanban") => buildBoard(raw, { preset, now: NOW, today: TODAY });
const state = (view) => ({ settings: { showDone: false }, collapsed: false, view });
const columnIds = (view) => view.columns.map((column) => column.tasks.map((row) => row.id));
const tag = (id, title) => ({ id, title, taskIds: [] });

function sameNameMatrix() {
  return {
    allTasks: [
      task({ id: "first", tagIds: ["urgent-1"] }),
      task({ id: "second", tagIds: ["urgent-2"] }),
      task({ id: "both", tagIds: ["urgent-1", "urgent-2", EM_IMPORTANT, "keep"] }),
    ],
    projects: [],
    tags: [tag("urgent-1", "urgent"), tag("urgent-2", "Urgent"), tag(EM_IMPORTANT, "important")],
  };
}

test("B01: duplicate ordinary names cannot replace the fixed system ID regardless of tag order", () => {
  const raw = sameNameMatrix();
  for (const tags of [raw.tags, [...raw.tags].reverse()]) {
    const view = build({ ...raw, tags }, "eisenhower");
    assert.deepEqual(columnIds(view), [[], ["both"], [], ["first", "second"]], "classification follows only canonical IDs; no task disappears because ordinary names collide");
    assert.deepEqual(view.missingTags, [EM_URGENT], "ordinary same-name tags do not establish the system tag");
    assert.deepEqual(view.sameNameTagLabels, ["urgent"]);
  }
});

test("B01: none, one, or all ordinary same-name tags leave default-board membership unchanged", () => {
  for (const preset of ["kanban", "eisenhower"]) {
    const title = preset === "kanban" ? "in-progress" : "urgent";
    const raw = {
      allTasks: [
        task({ id: "none", tagIds: [] }),
        task({ id: "both", tagIds: ["a", "b", EM_IMPORTANT] }),
        task({ id: "one", tagIds: ["a"] }),
      ], projects: [],
      tags: [tag("a", title), tag("b", title.toUpperCase()), tag(EM_IMPORTANT, "important")],
    };
    const expected = preset === "kanban" ? [["none", "both", "one"], [], []] : [[], ["both"], [], ["none", "one"]];
    for (const tags of [raw.tags, [...raw.tags].reverse()]) {
      const view = build({ ...raw, tags }, preset);
      assert.deepEqual(columnIds(view), expected, "ordinary tag selection cannot change the official default columns");
      assert.equal(view.counts.total, 3, "all tasks remain visible");
      if (preset === "eisenhower") assert.equal(view.columns[3].isUntaggedBucket, false, "definitely tagged tasks must prevent the unclassified-only label");
    }
  }
});

test("B01: missing system tags block only additions, while clearing matrix state preserves ordinary same-name tags", () => {
  const raw = sameNameMatrix();
  const before = structuredClone(raw);
  for (const tags of [raw.tags, [...raw.tags].reverse()]) {
    assert.throws(
      () => moveTaskToColumn({ ...raw, tags }, { taskId: "both", preset: "eisenhower", columnId: "URGENT_AND_IMPORTANT" }),
      /urgent.*系统标签/,
    );
    const patch = moveTaskToColumn({ ...raw, tags }, { taskId: "both", preset: "eisenhower", columnId: "NOT_URGENT_AND_NOT_IMPORTANT" });
    assert.deepEqual(patch, { tagIds: ["urgent-1", "urgent-2", "keep"] }, "only the managed importance ID is removed");
  }
  assert.deepEqual(raw, before, "patch computation and rejection must not mutate task or tag input");
});

test("B01: renamed fixed ID defines membership and moves despite multiple ordinary same-name tags", () => {
  const raw = sameNameMatrix();
  raw.tags.push(tag(EM_URGENT, "紧急"));
  raw.allTasks.push(task({ id: "official", tagIds: [EM_URGENT] }));
  raw.allTasks.find((item) => item.id === "both").tagIds.push(EM_URGENT);
  for (const tags of [raw.tags, [...raw.tags].reverse()]) {
    const view = build({ ...raw, tags }, "eisenhower");
    assert.deepEqual(columnIds(view), [["both"], [], ["official"], ["first", "second"]]);
    const patch = moveTaskToColumn({ ...raw, tags }, { taskId: "both", preset: "eisenhower", columnId: "NOT_URGENT_AND_NOT_IMPORTANT" });
    assert.deepEqual(patch.tagIds, ["urgent-1", "urgent-2", "keep"], "unmanaged aliases must be left intact");
  }
});

test("B01: even a unique case-insensitive ordinary name does not replace a system tag in reads or moves", () => {
  const raw = {
    allTasks: [task({ id: "single", tagIds: ["urgent-1", "keep"] })], projects: [],
    tags: [tag("urgent-1", "Urgent"), tag(EM_IMPORTANT, "important")],
  };
  const view = build(raw, "eisenhower");
  assert.deepEqual(view.missingTags, [EM_URGENT]);
  assert.deepEqual(columnIds(view), [[], [], [], ["single"]]);
  const patch = moveTaskToColumn(raw, { taskId: "single", preset: "eisenhower", columnId: "NOT_URGENT_AND_IMPORTANT" });
  assert.deepEqual(patch.tagIds, ["urgent-1", "keep", EM_IMPORTANT], "unrelated ordinary tags survive an allowed move");
  assert.throws(() => moveTaskToColumn(raw, { taskId: "single", preset: "eisenhower", columnId: "URGENT_AND_IMPORTANT" }), /系统标签/);
});

test("B01: same-name guidance refreshes without changing visible tasks or counts", () => {
  const h = createRenderer("boards", { now: () => NOW });
  const raw = { allTasks: [task({ id: "done", isDone: true })], projects: [], tags: [] };
  const before = build(raw);
  h.update(state(before));
  assert.doesNotMatch(h.document.querySelector(".board-note").textContent, /同名普通标签/);
  const sameNames = build({ ...raw, tags: [tag("ip-1", "in-progress"), tag("ip-2", "In-Progress")] });
  assert.deepEqual(sameNames.columns, before.columns);
  assert.deepEqual(sameNames.counts, before.counts);
  h.update(state(sameNames));
  const note = h.document.querySelector(".board-note");
  assert.ok(note, "the real renderer must identify the missing system identity");
  assert.match(note.textContent, /同名普通标签/);
  assert.match(note.textContent, /ID 不同/);
  assert.match(note.textContent, /in-progress/i);
  h.update(state(build(raw)));
  assert.doesNotMatch(h.document.querySelector(".board-note").textContent, /同名普通标签/, "removing ordinary tags clears only the same-name warning");
  h.update(state(build({ ...raw, tags: [tag(KANBAN_IN_PROGRESS, "处理中")] })));
  assert.equal(h.document.querySelector(".board-note"), null, "creating the actual system tag clears setup guidance");
});

test("B02: Done only requests isDone regardless of missing or ordinary same-name tag entities", () => {
  for (const tags of [
    [tag(KANBAN_IN_PROGRESS, "in-progress")],
    [tag("custom-ip", "in-progress")],
    [],
    [tag("ip-1", "in-progress"), tag("ip-2", "In-Progress")],
  ]) {
    const raw = { allTasks: [task({ id: "doing", tagIds: [KANBAN_IN_PROGRESS, "custom-ip", "ip-1", "ip-2", "keep"] })], projects: [], tags };
    const before = structuredClone(raw);
    assert.deepEqual(moveTaskToColumn(raw, { taskId: "doing", preset: "kanban", columnId: "DONE" }), { isDone: true });
    assert.deepEqual(raw, before, "patch computation must not mutate task tags");
  }
});

test("B02: SP completion cleanup removes progress, and reopening returns to TODO without losing ordinary tags", () => {
  const doing = task({ id: "doing", tagIds: [KANBAN_IN_PROGRESS, "keep"] });
  const raw = { allTasks: [doing], projects: [], tags: [tag(KANBAN_IN_PROGRESS, "in-progress")] };
  const patch = moveTaskToColumn(raw, { taskId: "doing", preset: "kanban", columnId: "DONE" });
  assert.deepEqual(patch, { isDone: true }, "the client leaves completion bookkeeping to SP");
  const completed = { ...doing, ...official.completionUpdate(doing, patch).changes };
  assert.deepEqual(completed.tagIds, ["keep"], "the actual SP completion helper removes only the progress tag");
  assert.deepEqual(columnIds(build({ ...raw, allTasks: [completed] })), [[], [], ["doing"]]);
  const reopened = { ...completed, ...official.completionUpdate(completed, { isDone: false }).changes };
  assert.deepEqual(reopened.tagIds, ["keep"]);
  assert.deepEqual(columnIds(build({ ...raw, allTasks: [reopened] })), [["doing"], [], []]);
});

test("B02: moving an already-completed task to Done produces no patch fields", () => {
  const raw = {
    allTasks: [task({ id: "done", isDone: true, tagIds: [KANBAN_IN_PROGRESS, "keep"] })], projects: [],
    tags: [tag(KANBAN_IN_PROGRESS, "in-progress")],
  };
  assert.deepEqual(moveTaskToColumn(raw, { taskId: "done", preset: "kanban", columnId: "DONE" }), {});
});

test("B03: a backlog parent's todo, in-progress, and completed children stay out of all NoBacklog columns", () => {
  const raw = {
    allTasks: [
      task({ id: "parent", projectId: "project", subTaskIds: ["backlog-todo", "backlog-doing", "backlog-done"] }),
      task({ id: "backlog-todo", projectId: "project", parentId: "parent" }),
      task({ id: "backlog-doing", projectId: "project", parentId: "parent", tagIds: [KANBAN_IN_PROGRESS] }),
      task({ id: "backlog-done", projectId: "project", parentId: "parent", isDone: true }),
      task({ id: "live-todo", projectId: "project" }),
      task({ id: "live-doing", projectId: "project", tagIds: [KANBAN_IN_PROGRESS] }),
      task({ id: "live-done", projectId: "project", isDone: true }),
    ],
    projects: [{ id: "project", title: "Synthetic project", backlogTaskIds: ["parent"] }],
    tags: [tag(KANBAN_IN_PROGRESS, "in-progress"), tag(EM_URGENT, "urgent"), tag(EM_IMPORTANT, "important")],
  };
  const view = build(raw);
  assert.deepEqual(columnIds(view), [["live-todo"], ["live-doing"], ["live-done"]]);
  assert.equal(view.counts.total, 3);
  const matrixIds = columnIds(build(raw, "eisenhower")).flat();
  assert.deepEqual(matrixIds, ["parent", "live-todo", "live-doing", "live-done"], "matrix has no NoBacklog restriction and still shows only parents");
});

test("B03: backlog lookup uses parentId when present, otherwise the task's own ID", () => {
  const raw = {
    allTasks: [
      task({ id: "live-parent", subTaskIds: ["live-child"] }),
      task({ id: "live-child", parentId: "live-parent" }),
      task({ id: "backlog-root" }),
    ],
    projects: [{ id: "project", title: "Synthetic project", backlogTaskIds: ["live-child", "backlog-root"] }],
    tags: [tag(KANBAN_IN_PROGRESS, "in-progress")],
  };
  assert.deepEqual(columnIds(build(raw)), [["live-parent", "live-child"], [], []]);
});

test("B05: unclassified matrix guidance names the actual renamed fixed-ID tags, not unrelated English aliases", () => {
  const raw = {
    allTasks: [task({ id: "unclassified" })], projects: [],
    tags: [tag(EM_URGENT, "紧急事项"), tag(EM_IMPORTANT, "重要事项"), tag("other-u", "urgent"), tag("other-i", "important")],
  };
  const h = createRenderer("boards", { now: () => NOW });
  h.update(state(build(raw, "eisenhower")));
  const note = h.document.querySelector(".board-note");
  assert.ok(note, "unclassified tasks still need actionable classification guidance");
  for (const name of ["紧急事项", "重要事项"]) assert.ok(note.textContent.includes(name), `guidance must identify the existing tag ${name}`);
  const tagged = { ...raw, allTasks: [task({ id: "classified", tagIds: [EM_URGENT, EM_IMPORTANT] })] };
  assert.deepEqual(columnIds(build(tagged, "eisenhower")), [["classified"], [], [], []], "display names must not change fixed-ID matching");
});

test("B05: changing only tag names refreshes the matrix guidance without changing task classification", () => {
  const raw = {
    allTasks: [task({ id: "unclassified" })], projects: [],
    tags: [tag(EM_URGENT, "urgent"), tag(EM_IMPORTANT, "important")],
  };
  const h = createRenderer("boards", { now: () => NOW });
  const before = build(raw, "eisenhower");
  h.update(state(before));
  const after = build({ ...raw, tags: [tag(EM_URGENT, "先处理"), tag(EM_IMPORTANT, "高价值")] }, "eisenhower");
  assert.deepEqual(after.columns, before.columns, "only tag titles changed; tasks and column counts did not");
  h.update(state(after));
  const text = h.document.querySelector(".board-note").textContent;
  for (const name of ["先处理", "高价值"]) assert.ok(text.includes(name), `the refreshed guidance must use ${name}`);
});

test("B05: empty matrix messages also use the actual fixed-ID tag names", () => {
  const raw = { allTasks: [], projects: [], tags: [tag(EM_URGENT, "需尽快"), tag(EM_IMPORTANT, "很重要")] };
  const h = createRenderer("boards", { now: () => NOW });
  h.update(state(build(raw, "eisenhower")));
  const empty = h.document.querySelector(".empty");
  assert.ok(empty, "no tasks still renders the empty state");
  for (const name of ["需尽快", "很重要"]) assert.ok(empty.textContent.includes(name), `empty guidance must refer to ${name}`);
});
