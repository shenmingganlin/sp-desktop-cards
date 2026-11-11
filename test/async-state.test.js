// 操作等待期间的真实状态衔接：延迟 REST / IPC，执行主进程和卡片的实际代码。
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { buildView } from "../src/main/model.js";
import { createPoller } from "../src/main/poller.js";
import * as pomo from "../src/main/pomodoro.js";
import { createClient } from "../src/main/sp-client.js";
import { buildStats } from "../src/main/stats.js";
import { task } from "./fixtures.js";
import { createRenderer } from "./renderer-harness.js";
import { windowAlive } from "../src/main/win.js";

const main = fs.readFileSync(new URL("../src/main/main.js", import.meta.url), "utf8");
function mainSection(from, to) {
  const start = main.indexOf(from);
  const end = main.indexOf(to, start);
  assert.ok(start >= 0 && end > start, "应执行主进程中的实际代码区段");
  return main.slice(start, end);
}
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
// 所有被测 I/O 都是受控 Promise；跨过本轮微任务，不等待真实网络或计时器。
const settle = () => new Promise(setImmediate);
const cfg = { ...pomo.DEFAULT_POMODORO };

function pomoHarness(client) {
  const notices = [];
  const paused = pomo.pause(pomo.start(pomo.createState(), cfg, 1000, "a").state, cfg, 2000).state;
  const context = vm.createContext({
    pomo, pomoState: paused, pomoTimer: null, client,
    settings: { get: () => ({ pomodoro: cfg }), update() {} },
    poller: { kick() {} }, HINTS: {}, lastError: null,
    notify: (effect) => notices.push(effect), syncTrayTip() {}, pushState() {},
    setTimeout: () => 0, clearTimeout() {}, Date,
  });
  vm.runInContext(mainSection("// ── 番茄钟 ──", "// ── 阶段结束的提醒"), context);
  return {
    get state() { return context.pomoState; },
    get error() { return context.lastError; },
    notices,
    apply(result) { context.result = result; vm.runInContext("applyPomo(result)", context); },
  };
}

// 使用真实客户端的共享 FIFO 和 stopIfCurrent，仅替代 HTTP；缺少方法不能被
// runEffect 的正常错误清理吞掉后，留下「其他任务没被停止」的假通过。
function trackingClient({ initial = null, beforeStart = async () => {} } = {}) {
  let current = initial;
  const calls = [];
  const client = createClient({
    baseUrl: "http://synthetic.invalid", getToken: async () => "synthetic-only-token",
    fetchImpl: async (url) => {
      const pathname = new URL(url).pathname;
      calls.push(pathname);
      if (pathname === "/task-control/current") return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, data: current }) };
      if (pathname === "/task-control/stop") current = null;
      else {
        assert.match(pathname, /^\/tasks\/[^/]+\/start$/);
        const id = decodeURIComponent(pathname.split("/")[2]);
        await beforeStart(id);
        current = { id };
      }
      return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, data: { currentTaskId: current?.id ?? null } }) };
    },
  });
  return { client, calls, current: () => current };
}

for (const action of ["pause", "stop"]) {
  test(`番茄钟：开始请求晚到时，${action === "pause" ? "暂停" : "结束"}仍会停止关联任务`, async () => {
    // 丢掉计时副作用的串行顺序，就会先读到 null，随后晚到的开始请求留下计时。
    const gate = deferred();
    const tracking = trackingClient({ beforeStart: () => gate.promise });
    const h = pomoHarness(tracking.client);
    h.apply(pomo.resume(h.state, cfg, 3000));
    await settle();
    h.apply(action === "pause" ? pomo.pause(h.state, cfg, 3100) : pomo.stop(h.state, cfg));
    await settle();
    assert.deepEqual(tracking.calls, ["/tasks/a/start"], "条件读取和停止要等待先前的开始完成");
    gate.resolve();
    await settle();
    assert.equal(h.state.status, action === "pause" ? "paused" : "idle");
    assert.equal(tracking.current(), null, "旧的开始请求不能让 SP 一直计时");
    assert.deepEqual(tracking.calls, ["/tasks/a/start", "/task-control/current", "/task-control/stop"]);
    assert.equal(h.error, null, "不能因为测试替身缺失新客户端方法而跳过真正的停止");
  });
}

test("番茄钟：暂停不能误停用户切换到的其他任务", async () => {
  const tracking = trackingClient({ initial: { id: "other" } });
  const h = pomoHarness(tracking.client);
  h.apply({ state: h.state, effects: [{ type: "untrack", taskId: "a" }] });
  await settle();
  assert.equal(tracking.current()?.id, "other");
  assert.deepEqual(tracking.calls, ["/task-control/current"], "应真实检查关联任务，不发送无条件停止");
  assert.equal(h.error, null);
});

test("番茄钟：一次计时请求失败不堵塞后续操作", async () => {
  const tracking = trackingClient({ beforeStart: async (id) => { if (id === "a") throw new Error("synthetic failure"); } });
  const h = pomoHarness(tracking.client);
  h.apply(pomo.resume(h.state, cfg, 3000));
  await settle();
  h.apply(pomo.start(h.state, cfg, 4000, "b"));
  await settle();
  assert.equal(tracking.current()?.id, "b");
  assert.deepEqual(tracking.calls, ["/tasks/a/start", "/tasks/b/start"], "失败只释放队列，不重放旧意图");
});

test("番茄钟：到点提醒不等待缓慢的计时请求", async () => {
  const gate = deferred();
  const tracking = trackingClient({ beforeStart: () => gate.promise });
  const h = pomoHarness(tracking.client);
  h.apply(pomo.resume(h.state, cfg, 3000));
  await settle();
  h.apply({ state: h.state, effects: [{ type: "notify", title: "synthetic reminder" }] });
  assert.equal(h.notices[0]?.title, "synthetic reminder");
  gate.resolve();
  await settle();
});

const NOW = new Date(2026, 10, 9, 12).getTime();
const DAY = "2026-11-09";
function todayState(title = "existing") {
  const t = task({ id: "existing", title, dueDay: DAY });
  return { settings: {}, collapsed: false, view: buildView({ todayTasks: [t], allTasks: [t], tags: [], now: NOW }) };
}
function quickAddHarness(gate) {
  const created = [];
  const h = createRenderer("today", {
    action: async (name, payload) => {
      if (name !== "createTask") return { ok: true };
      created.push(structuredClone(payload));
      return created.length === 1 ? gate.promise : { ok: true, data: { id: "retried-task", title: payload.title } };
    },
  });
  h.update(todayState());
  h.W.openAdd("today", DAY);
  h.type(h.input(), "first task");
  h.enter(h.input());
  return { ...h, created };
}

test("快速新建：重画后仍锁定正在提交的草稿，不重复创建", async () => {
  const gate = deferred();
  const h = quickAddHarness(gate);
  h.update(todayState("changed elsewhere"));
  const input = h.input();
  assert.equal(input.disabled, true, "重建的输入框也应保持提交中");
  h.enter(input); // 即使重复事件到达，也不能再发一次写请求。
  assert.equal(h.created.length, 1);
  gate.resolve({ ok: true, data: { id: "first-task", title: "first task" } });
  await settle();
});

test("快速新建：旧请求返回不能清空后来打开的新草稿", async () => {
  const gate = deferred();
  const h = quickAddHarness(gate);
  h.W.openAdd("today", DAY); // 收起旧草稿
  h.W.openAdd("today", DAY); // 打开新的草稿
  h.type(h.input(), "next draft");
  gate.resolve({ ok: true, data: { id: "first-task", title: "first task" } });
  await settle();
  h.W.render(true);
  assert.equal(h.input().value, "next draft");
});

test("快速新建：重画后收到成功响应，清空并解锁当前输入框", async () => {
  const gate = deferred();
  const h = quickAddHarness(gate);
  h.update(todayState("changed elsewhere"));
  gate.resolve({ ok: true, data: { id: "first-task", title: "first task" } });
  await settle();
  assert.equal(h.input().value, "");
  assert.equal(h.input().disabled, false);
});

test("快速新建：重画后 IPC 回执丢失，先核实结果再显式重试", async () => {
  const gate = deferred();
  const h = quickAddHarness(gate);
  h.update(todayState("changed elsewhere"));
  gate.reject(new Error("synthetic IPC failure"));
  await settle();
  assert.equal(h.input().value, "first task");
  assert.equal(h.input().disabled, false);
  assert.equal(h.input().readOnly, true, "回执丢失可能已经创建，不能直接再次提交");
  assert.match(h.document.getElementById("toast").textContent, /未确认|待核实/);
  h.enter(h.input());
  h.W.render(true);
  h.enter(h.input());
  await settle();
  assert.equal(h.created.length, 1, "重复回车和重画不能重发未知结果的创建");
  const verify = h.document.querySelector(".add").querySelector(".link");
  assert.equal(verify?.textContent, "确认未创建");
  verify.emit("click");
  assert.equal(h.created.length, 1, "核实按钮只解锁，不自动重发");
  assert.equal(h.input().readOnly, false);
  h.enter(h.input());
  await settle();
  assert.equal(h.created.length, 2, "确认未创建后可明确再次提交");
  assert.equal(h.input().value, "", "有效成功回执仍能清空草稿");
});

test("用时：快轮询不倒退，完整刷新不重复补算，停止后不再增长", async (t) => {
  // 真实 poller → 主进程 pushState → 三张真实卡片，不能漏传列表快照的时间。
  let clock = NOW;
  let current = "a";
  let stoppedAt = null;
  const snapshotTask = () => task({
    id: "a", title: "synthetic timer", dueDay: DAY,
    timeSpent: 29000 + (stoppedAt ?? clock) - NOW,
    timeSpentOnDay: { [DAY]: 29000 + (stoppedAt ?? clock) - NOW },
  });
  const renderers = Object.fromEntries(["today", "focus", "stats"].map((type) => [type, createRenderer(type, { now: () => clock })]));
  const context = vm.createContext({
    raw: null, settingsWin: null, ui: {}, buildView, windowAlive,
    publicSettings: () => ({ cards: { today: {}, focus: {}, stats: {} }, dayStartHour: 0, upcomingMinutes: 15 }),
    pomoView: () => ({ status: "idle", doneToday: 0 }),
    listSources: () => ({ projects: [], tags: [] }),
    cards: {
      isAttending: () => false, types: () => ["today", "focus", "stats"],
      send: (type, _channel, state) => renderers[type].update(state),
    },
    lastError: null,
  });
  context.cardView = (type, todayView) => type === "stats"
    ? buildStats(context.raw, { today: DAY, now: clock })
    : todayView();
  vm.runInContext(mainSection("/** 把最新状态推给所有卡片和设置窗口。", "// ── 番茄钟 ──"), context);
  const poller = createPoller({
    client: {
      current: async () => current ? snapshotTask() : null,
      focus: async () => null,
      todayTasks: async () => [snapshotTask()], allTasks: async () => [snapshotTask()],
      tags: async () => [], projects: async () => [], repeatCfgs: async () => [],
    },
    onData: (raw) => { context.raw = raw; vm.runInContext("pushState()", context); },
    onError: (error) => { throw error; }, now: () => clock,
    setTimer: () => 0, clearTimer() {},
  });
  t.after(() => poller.stop());
  const foot = (type) => renderers[type].document.getElementById("foot").textContent;
  const tick = () => Object.values(renderers).forEach((h) => h.W.tick());
  await poller.start();
  clock += 1500;
  tick();
  assert.match(foot("today"), /今日已用 1 分/);
  clock = NOW + 2000;
  await poller.poll();
  tick();
  assert.match(foot("today"), /今日已用 1 分/, "快轮询不能把累计值退回 0 分");
  assert.match(foot("focus"), /已用 1 分/);
  assert.equal(renderers.stats.document.querySelector(".stats-big").textContent, "1 分");
  assert.equal(renderers.focus.document.querySelector(".focus-time").textContent, "00:31", "当前任务仍按快快照补秒数");
  clock = NOW + 5000;
  await poller.kick();
  assert.equal(renderers.today.W.sinceListsSnapshot(), 0, "列表刷新后从新快照起算，不能重复补上旧的一段");
  clock = NOW + 6000;
  current = null;
  stoppedAt = clock;
  await poller.poll();
  clock += 60000;
  tick();
  assert.match(foot("today"), /今日已用 1 分/);
  assert.equal(renderers.stats.document.querySelector(".stats-big").textContent, "1 分");
});
