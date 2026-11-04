// 待整理卡的数据整理：三堆按顺序判定，一条任务只进第一堆。
import assert from "node:assert/strict";
import test from "node:test";
import { buildTriage, INBOX } from "../src/main/triage.js";
import { NOW, TODAY, sampleData, task } from "./fixtures.js";

const MIN = 60_000;
const build = (raw, opts = {}) => buildTriage(raw, { today: TODAY, now: NOW, ...opts });
const ids = (list) => list.map((e) => e.id);

test("待整理：收件箱、没排期、没收尾三堆各归各的", () => {
  const raw = {
    allTasks: [
      task({ id: "inbox1", projectId: INBOX }),
      task({ id: "noschedule", projectId: "work" }),
      task({ id: "scheduled", projectId: "work", dueDay: TODAY }),
      task({ id: "finish", projectId: "work", dueDay: TODAY, subTaskIds: ["k"] }),
      task({ id: "k", parentId: "finish", isDone: true }),
    ],
    projects: [{ id: INBOX, title: "Inbox" }, { id: "work", title: "工作" }],
  };
  const v = build(raw);
  assert.deepEqual(ids(v.inbox), ["inbox1"]);
  assert.deepEqual(ids(v.unscheduled), ["noschedule"]);
  assert.deepEqual(ids(v.unfinished), ["finish"]);
  assert.deepEqual(v.counts, { inbox: 1, unscheduled: 1, unfinished: 1 });
  // scheduled 排过期了，不在任何一堆里
  assert.ok(![v.inbox, v.unscheduled, v.unfinished].flat().some((e) => e.id === "scheduled"));
});

test("待整理：收件箱里没排期的只算收件箱，不重复进没排期", () => {
  const v = build({ allTasks: [task({ id: "a", projectId: INBOX })], projects: [] });
  assert.deepEqual(ids(v.inbox), ["a"]);
  assert.deepEqual(ids(v.unscheduled), []);
});

test("待整理：排过期的（有截止日或截止时间）哪堆都不进", () => {
  const raw = {
    allTasks: [
      task({ id: "day", projectId: "w", dueDay: TODAY }),
      task({ id: "time", projectId: "w", dueWithTime: NOW + 3600_000 }),
      task({ id: "inboxDay", projectId: INBOX, dueDay: TODAY }),
      task({ id: "none", projectId: "w" }),
    ],
    projects: [{ id: "w", title: "工作" }],
  };
  const v = build(raw);
  // 排过期的已经由今日/规划卡管了；这里只留真正散着的，免得「排到今天」按了没反应
  assert.deepEqual(ids(v.unscheduled), ["none"]);
  assert.deepEqual(ids(v.inbox), []);
  assert.deepEqual(v.counts, { inbox: 0, unscheduled: 1, unfinished: 0 });
});

test("待整理：子任务没做完的父任务不算没收尾", () => {
  const raw = {
    allTasks: [
      task({ id: "p", projectId: "w", dueDay: TODAY, subTaskIds: ["c1", "c2"] }),
      task({ id: "c1", parentId: "p", isDone: true }),
      task({ id: "c2", parentId: "p" }),
    ],
    projects: [{ id: "w", title: "工作" }],
  };
  const v = build(raw);
  assert.deepEqual(ids(v.unfinished), []);
});

test("待整理：已完成的任务和子任务都不进任何一堆", () => {
  const raw = {
    allTasks: [
      task({ id: "done", projectId: INBOX, isDone: true }),
      task({ id: "p", projectId: "w", subTaskIds: ["k"], isDone: true }),
      task({ id: "k", parentId: "p", isDone: true }),
    ],
    projects: [],
  };
  const v = build(raw);
  assert.deepEqual(v.counts, { inbox: 0, unscheduled: 0, unfinished: 0 });
});

test("待整理：没收尾优先于其他两堆（子任务全做完的父任务即使没排期也归没收尾）", () => {
  const raw = {
    allTasks: [
      task({ id: "p", projectId: INBOX, subTaskIds: ["k"] }),
      task({ id: "k", parentId: "p", isDone: true }),
    ],
    projects: [],
  };
  const v = build(raw);
  assert.deepEqual(ids(v.unfinished), ["p"]);
  assert.deepEqual(ids(v.inbox), []);
});

test("待整理：项目名带出来，收件箱显示中文名", () => {
  const raw = {
    allTasks: [task({ id: "a", projectId: INBOX }), task({ id: "b", projectId: "work" })],
    projects: [{ id: INBOX, title: "Inbox" }, { id: "work", title: "学业" }],
  };
  const v = build(raw);
  assert.equal(v.inbox[0].projectTitle, "收件箱");
  assert.equal(v.unscheduled[0].projectTitle, "学业");
});

test("待整理：有预估的排前面", () => {
  const raw = {
    allTasks: [
      task({ id: "noest", projectId: INBOX }),
      task({ id: "est", projectId: INBOX, timeEstimate: 30 * MIN }),
    ],
    projects: [],
  };
  assert.deepEqual(ids(build(raw).inbox), ["est", "noest"]);
});

test("待整理：有子任务的父任务不能直接计时", () => {
  const raw = {
    allTasks: [
      task({ id: "p", projectId: "w", subTaskIds: ["k"], timeEstimate: 100 * MIN, timeSpent: 90 * MIN }),
      task({ id: "k", parentId: "p", isDone: true }),
    ],
    projects: [{ id: "w", title: "工作" }],
  };
  const v = build(raw);
  assert.equal(v.unfinished[0].canTrack, false);
  // 子任务全做完了，剩余是 0
  assert.equal(v.unfinished[0].left, 0);
});

test("待整理：limit 截断列表但计数是完整的", () => {
  const allTasks = Array.from({ length: 10 }, (_, i) => task({ id: `t${i}`, projectId: INBOX }));
  const v = build({ allTasks, projects: [] }, { limit: 3 });
  assert.equal(v.inbox.length, 3);
  assert.equal(v.counts.inbox, 10);
});

test("待整理：空数据不炸", () => {
  for (const raw of [null, {}, { allTasks: [] }]) {
    const v = build(raw);
    assert.deepEqual(v.counts, { inbox: 0, unscheduled: 0, unfinished: 0 });
    assert.equal(v.stats.total, 0);
  }
});
