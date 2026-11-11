// 执行真实的日程渲染和主进程视图分发，避免只修模型却漏接设置或写回日期。
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { buildSchedule } from "../src/main/calendar.js";
import { taskFields } from "../src/main/quickadd.js";
import { task } from "./fixtures.js";
import { createRenderer } from "./renderer-harness.js";

const NOW = new Date(2026, 10, 9, 12).getTime();
const DAY = "2026-11-09";
const NEXT = "2026-11-10";
const raw = { allTasks: [], todayTasks: [], tags: [], projects: [], repeatCfgs: [], now: NOW, listsAt: NOW };
const stateFor = (day) => ({ settings: {}, collapsed: false, view: buildSchedule(raw, { day }) });
const settle = () => new Promise(setImmediate);
function clickTime(h, view, minute = 14 * 60) {
  const line = h.document.querySelector(".timeline");
  line.getBoundingClientRect = () => ({ top: 0 });
  line.emit("click", { target: line, clientY: (minute - view.rangeStart) * 0.8 + 1 });
}

test("日程新建：翻天隐藏旧日期的草稿，返回原日仍保留标题", () => {
  const h = createRenderer("schedule", { now: () => NOW });
  const first = stateFor(DAY);
  h.update(first);
  clickTime(h, first.view);
  h.type(h.input(), "original draft");
  h.update(stateFor(NEXT));
  assert.equal(h.input(), null, "新日期下不能露出仍绑定旧日期的输入框");
  h.update(first);
  assert.equal(h.input().value, "original draft", "翻天不应丢掉用户已输入的草稿");
});

test("日程新建：翻天后点击相同钟点，新任务写入新日期", async () => {
  const written = [];
  const h = createRenderer("schedule", {
    now: () => NOW,
    action: async (name, input) => {
      if (name === "createTask") written.push(taskFields(input));
      return { ok: true };
    },
  });
  const first = stateFor(DAY);
  h.update(first);
  clickTime(h, first.view);
  h.type(h.input(), "old draft");
  const next = stateFor(NEXT);
  h.update(next);
  clickTime(h, next.view);
  assert.ok(h.input(), "同一钟点在不同日期不是同一个新建位置，不能误关输入框");
  h.type(h.input(), "new appointment");
  h.enter(h.input());
  await settle();
  assert.equal(written.length, 1);
  assert.equal(written[0].ok, true);
  assert.equal(written[0].fields.dueWithTime, new Date(2026, 10, 10, 14).getTime());
});

test("日程新建：凌晨的钟点跨日写入，仍保持逻辑日期绑定", async () => {
  const written = [];
  const h = createRenderer("schedule", {
    now: () => NOW,
    action: async (name, input) => {
      if (name === "createTask") written.push(taskFields(input));
      return { ok: true };
    },
  });
  const nightRaw = { ...raw, allTasks: [task({ id: "late", dueWithTime: new Date(2026, 10, 10, 1, 30).getTime(), timeEstimate: 1800000 })] };
  const first = { settings: {}, collapsed: false, view: buildSchedule(nightRaw, { day: DAY, dayStartHour: 4, endHour: 24 }) };
  h.update(first);
  clickTime(h, first.view, 25 * 60);
  h.type(h.input(), "late-night task");
  h.enter(h.input());
  await settle();
  assert.equal(written[0].fields.dueWithTime, new Date(2026, 10, 10, 1).getTime());
});

test("日程设置：主进程传递收起状态，切换后可见任务与布局一起更新", () => {
  // 若 main.js 漏传 showDone，模型单测可以过，真实卡片却仍会显示已完成任务。
  const tasks = [
    task({ id: "live", title: "visible appointment", dueWithTime: new Date(2026, 10, 9, 14).getTime(), timeEstimate: 1800000 }),
    task({ id: "done", title: "completed appointment", dueWithTime: new Date(2026, 10, 9, 14).getTime(), isDone: true, timeEstimate: 1800000 }),
    task({ id: "done-untimed", title: "completed untimed", dueDay: DAY, isDone: true }),
  ];
  const h = createRenderer("schedule", { now: () => NOW });
  const settings = { showDone: false, dayStartHour: 0, scheduleStartHour: 8, scheduleEndHour: 22 };
  const context = vm.createContext({
    raw: { ...raw, allTasks: tasks }, settings: { get: () => settings },
    ui: { scheduleDay: DAY }, currentDay: () => DAY, buildSchedule,
  });
  const main = fs.readFileSync(new URL("../src/main/main.js", import.meta.url), "utf8");
  const start = main.indexOf("// ── 各卡片的视图 ──");
  const end = main.indexOf("function pomoView()", start);
  assert.ok(start >= 0 && end > start);
  vm.runInContext(main.slice(start, end), context);
  const update = () => {
    const view = vm.runInContext('cardView("schedule")', context);
    h.update({ settings: { ...settings }, collapsed: true, view });
    return view;
  };
  const hidden = update();
  assert.equal(h.document.querySelector(".chip"), null);
  assert.doesNotMatch(h.document.getElementById("body").textContent, /completed/);
  assert.match(h.document.getElementById("sub").textContent, /1 项$/);
  assert.equal(hidden.blocks[0].lanes, 1);
  settings.showDone = true;
  update();
  assert.match(h.document.getElementById("body").textContent, /completed appointment/);
  assert.match(h.document.getElementById("body").textContent, /completed untimed/);
  assert.match(h.document.getElementById("sub").textContent, /3 项$/);
  settings.showDone = false;
  update();
  assert.doesNotMatch(h.document.getElementById("body").textContent, /completed/);
});
