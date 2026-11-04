// 清单卡的数据整理：某个项目/标签下的任务，排序和父子归并。
import assert from "node:assert/strict";
import test from "node:test";
import { buildList, listSources, resolveSource } from "../src/main/list.js";
import { NOW, TODAY, sampleData, task } from "./fixtures.js";

const MIN = 60_000;
const dayStr = (offset) => {
  const b = new Date(NOW);
  const d = new Date(b.getFullYear(), b.getMonth(), b.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

const build = (raw, opts = {}) => buildList(raw, { today: TODAY, now: NOW, ...opts });

test("清单：项目来源列出这个项目的全部任务", () => {
  const v = build(sampleData(NOW), { kind: "project", id: "INBOX_PROJECT" });
  assert.equal(v.source.id, "INBOX_PROJECT");
  assert.ok(v.undone.length > 0);
  // 任务全在收件箱（fixtures 默认），所以未完成数应等于全部未完成顶层任务
  const raw = sampleData(NOW);
  const expect = raw.allTasks.filter((t) => !t.isDone && !t.parentId).length;
  assert.equal(v.undone.length, expect);
});

test("清单：标签来源按 tagIds 过滤", () => {
  const raw = {
    allTasks: [
      task({ id: "a", title: "甲", tagIds: ["work"] }),
      task({ id: "b", title: "乙", tagIds: ["home"] }),
      task({ id: "c", title: "丙", tagIds: [] }),
    ],
    tags: [{ id: "work", title: "工作" }, { id: "home", title: "家里" }],
  };
  const v = build(raw, { kind: "tag", id: "work" });
  assert.equal(v.source.title, "工作");
  assert.deepEqual(v.undone.map((e) => e.id), ["a"]);
});

test("清单：父任务和子任务都在清单里时，子任务只挂在父任务下面", () => {
  const raw = {
    allTasks: [
      task({ id: "p", title: "父", subTaskIds: ["c1", "c2"] }),
      task({ id: "c1", title: "子一", parentId: "p", isDone: true }),
      task({ id: "c2", title: "子二", parentId: "p" }),
    ],
    projects: [{ id: "INBOX_PROJECT", title: "收件箱" }],
  };
  const v = build(raw, { kind: "project", id: "INBOX_PROJECT" });
  assert.equal(v.undone.length, 1);
  assert.equal(v.undone[0].id, "p");
  assert.deepEqual(v.undone[0].children.map((c) => c.id), ["c1", "c2"]);
  assert.equal(v.undone[0].subDone, 1);
  assert.equal(v.undone[0].subTotal, 2);
  // 有子任务的父任务不给开始按钮
  assert.equal(v.undone[0].canTrack, false);
});

test("清单：子任务单独属于这个清单、父任务不属于时，子任务自己列出来", () => {
  const raw = {
    allTasks: [
      task({ id: "p", title: "父", projectId: "other", subTaskIds: ["c1"] }),
      task({ id: "c1", title: "子", parentId: "p", projectId: "work" }),
    ],
    projects: [{ id: "work", title: "工作" }, { id: "other", title: "别的" }],
  };
  const v = build(raw, { kind: "project", id: "work" });
  assert.deepEqual(v.undone.map((e) => e.id), ["c1"]);
  assert.equal(v.undone[0].parentTitle, "父");
});

test("清单：排序——带时间的按时间，其次按日期，最后按 SP 里的顺序", () => {
  const raw = {
    allTasks: [
      task({ id: "later", title: "晚些", projectId: "w", dueDay: dayStr(3) }),
      task({ id: "soon", title: "早点", projectId: "w", dueDay: dayStr(1) }),
      task({ id: "free2", title: "没日期二", projectId: "w" }),
      task({ id: "timed", title: "有钟点", projectId: "w", dueWithTime: NOW + 2 * 3600_000 }),
      task({ id: "free1", title: "没日期一", projectId: "w" }),
    ],
    projects: [{ id: "w", title: "工作" }],
  };
  const v = build(raw, { kind: "project", id: "w" });
  assert.deepEqual(v.undone.map((e) => e.id), ["timed", "soon", "later", "free2", "free1"]);
});

test("清单：showDone 关掉时 done 为空但计数还在", () => {
  const raw = {
    allTasks: [task({ id: "a", projectId: "w" }), task({ id: "b", projectId: "w", isDone: true })],
    projects: [{ id: "w", title: "工作" }],
  };
  const off = build(raw, { kind: "project", id: "w" });
  assert.deepEqual(off.done, []);
  assert.deepEqual(off.counts, { undone: 1, done: 1 });
  const on = build(raw, { kind: "project", id: "w", showDone: true });
  assert.deepEqual(on.done.map((e) => e.id), ["b"]);
});

test("清单：剩余时间按子任务算，不用父任务自己的数字", () => {
  const raw = {
    allTasks: [
      task({ id: "p", projectId: "w", subTaskIds: ["c1", "c2"], timeEstimate: 100 * MIN, timeSpent: 90 * MIN }),
      task({ id: "c1", parentId: "p", isDone: true, timeEstimate: 50 * MIN }),
      task({ id: "c2", parentId: "p", timeEstimate: 50 * MIN }),
    ],
    projects: [{ id: "w", title: "工作" }],
  };
  const v = build(raw, { kind: "project", id: "w" });
  assert.equal(v.stats.remaining, 50 * MIN);
});

test("清单：选中的来源没了，退回第一个可选项", () => {
  const raw = { allTasks: [], projects: [{ id: "w", title: "工作" }], tags: [{ id: "t", title: "标签" }] };
  assert.equal(resolveSource(raw, { kind: "project", id: "gone" }).id, "w");
  assert.equal(resolveSource(raw, { kind: "tag", id: "gone" }).id, "t");
  // 项目全没了才用标签
  assert.equal(resolveSource({ projects: [], tags: [{ id: "t", title: "标签" }] }, { kind: "project", id: "w" }).id, "t");
  // 什么都没有
  assert.equal(resolveSource({ projects: [], tags: [] }, { kind: "project", id: "w" }), null);
  const v = build({ allTasks: [], projects: [], tags: [] }, { kind: "project", id: "w" });
  assert.equal(v.source, null);
  assert.deepEqual(v.undone, []);
});

test("清单：TODAY 标签不算可选项（今日卡片已经覆盖了）", () => {
  const { tags } = listSources({ tags: [{ id: "TODAY", title: "Today" }, { id: "work", title: "工作" }] });
  assert.deepEqual(tags.map((t) => t.id), ["work"]);
});

test("清单：过期只认带钟点的，只写日期的算逾期归今日卡管", () => {
  const raw = {
    allTasks: [
      task({ id: "past", projectId: "w", dueWithTime: NOW - 3600_000 }),
      task({ id: "dayonly", projectId: "w", dueDay: dayStr(-2) }),
      task({ id: "done", projectId: "w", dueWithTime: NOW - 3600_000, isDone: true }),
    ],
    projects: [{ id: "w", title: "工作" }],
  };
  const v = build(raw, { kind: "project", id: "w" });
  const byId = new Map(v.undone.map((e) => [e.id, e]));
  assert.equal(byId.get("past").overdue, true);
  assert.equal(byId.get("dayonly").overdue, false);
  assert.equal(byId.get("done"), undefined); // 已完成的不在 undone 里
});

test("清单：空数据不炸", () => {
  for (const raw of [null, {}, { allTasks: [] }]) {
    const v = build(raw, { kind: "project", id: "x" });
    assert.equal(v.undone.length, 0);
    assert.equal(v.stats.remaining, 0);
  }
});
