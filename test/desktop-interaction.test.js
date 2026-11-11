// Assigned interaction regressions. All task, token, IPC and HTTP data are synthetic.
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { buildView } from "../src/main/model.js";
import { createClient } from "../src/main/sp-client.js";
import * as pomo from "../src/main/pomodoro.js";
import { createRenderer } from "./renderer-harness.js";
import { task } from "./fixtures.js";

const DAY = "2026-11-09";
const NEXT = "2026-11-10";
const NOW = new Date(2026, 10, 9, 12).getTime();
const settle = () => new Promise(setImmediate);
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function todayState(day = DAY, tasks = []) {
  const [y, m, d] = day.split("-").map(Number);
  return {
    settings: {}, collapsed: false,
    view: buildView({ todayTasks: tasks, allTasks: tasks, tags: [], now: new Date(y, m - 1, d, 12).getTime() }),
  };
}
function findNode(root, predicate) {
  if (predicate(root)) return root;
  for (const child of root.children || []) {
    const found = findNode(child, predicate);
    if (found) return found;
  }
  return null;
}
function buttonWithText(h, text) {
  const node = findNode(h.document.getElementById("body"), (n) => n.tag === "button" && n.textContent === text);
  assert.ok(node, `expected visible button ${text}`);
  return node;
}
function addHarness(response = async (payload) => ({ ok: true, data: { id: "synthetic-created", title: payload.title } })) {
  const created = [];
  const h = createRenderer("today", { action: async (name, payload) => {
    if (name !== "createTask") return { ok: true };
    created.push(structuredClone(payload));
    return response(payload);
  } });
  return { ...h, created };
}

// Removing the current-day body invalidation leaves yesterday's empty-state callback active.
test("R01 empty today card creates on the new day after rollover", async () => {
  const h = addHarness();
  h.update(todayState(DAY));
  h.update(todayState(NEXT));
  buttonWithText(h, "新建一个").emit("click");
  h.type(h.input(), "synthetic new day task");
  h.enter(h.input());
  await settle();
  assert.deepEqual(h.created, [{ title: "synthetic new day task", day: NEXT, minute: null }]);
});

// Keeping the opening date in submitAdd would schedule a retained today draft yesterday.
test("R01 retained today draft preserves text but submits on the current day", async () => {
  const h = addHarness();
  h.update(todayState(DAY));
  h.W.openAdd("today", DAY);
  h.type(h.input(), "synthetic retained draft");
  h.update(todayState(NEXT));
  assert.equal(h.input().value, "synthetic retained draft");
  h.enter(h.input());
  await settle();
  assert.deepEqual(h.created, [{ title: "synthetic retained draft", day: NEXT, minute: null }]);
});

test("R01 rollover keeps an in-flight draft locked and its old reply off the new draft", async () => {
  const gate = deferred();
  const h = addHarness(() => gate.promise);
  h.update(todayState(DAY));
  h.W.openAdd("today", DAY);
  h.type(h.input(), "synthetic submitted draft");
  h.enter(h.input());
  h.update(todayState(NEXT));
  assert.equal(h.input().disabled, true);
  assert.equal(h.input().value, "synthetic submitted draft");
  h.enter(h.input());
  assert.equal(h.created.length, 1, "date change must not replace the submitting lock");
  h.W.openAdd("today", NEXT); // Close the in-flight draft.
  h.W.openAdd("today", NEXT); // A distinct draft must outlive the old response.
  h.type(h.input(), "synthetic next draft");
  const newInput = h.input();
  gate.resolve({ ok: true, data: { id: "synthetic-created-old", title: "synthetic submitted draft" } });
  await settle();
  h.W.render(true);
  assert.equal(h.input().value, "synthetic next draft");
  assert.equal(h.input().disabled, false);
  assert.equal(h.created[0].day, DAY, "an already sent request retains its original day");
  assert.notEqual(h.input(), newInput, "the assertion also survives a real renderer redraw");
});

test("R01 unconfirmed create across rollover keeps the title guarded until verified, then retries on the new day", async () => {
  const gate = deferred();
  const h = addHarness((payload) => h.created.length === 1 ? gate.promise : { ok: true, data: { id: "synthetic-retried", title: payload.title } });
  h.update(todayState(DAY));
  h.W.openAdd("today", DAY);
  h.type(h.input(), "synthetic retry draft");
  h.enter(h.input());
  h.update(todayState(NEXT));
  gate.reject(new Error("synthetic IPC failure"));
  await settle();
  assert.equal(h.input().value, "synthetic retry draft");
  assert.equal(h.input().disabled, false);
  assert.equal(h.input().readOnly, true, "a lost IPC receipt does not prove that the first create failed");
  h.enter(h.input());
  h.W.render(true);
  h.enter(h.input());
  await settle();
  assert.equal(h.created.length, 1, "rollover and redraw must not turn an unknown result into a duplicate write");
  buttonWithText(h, "确认未创建").emit("click");
  assert.equal(h.created.length, 1, "verification unlocks without submitting");
  assert.equal(h.input().readOnly, false);
  h.enter(h.input());
  await settle();
  assert.equal(h.created.length, 2);
  assert.deepEqual(h.created[1], { title: "synthetic retry draft", day: NEXT, minute: null });
  assert.equal(h.input().value, "", "the new confirmed receipt clears the verified retry draft");
});

test("R01 a definite create rejection across rollover preserves an editable title and directly retries on the new day", async () => {
  const gate = deferred();
  const h = addHarness((payload) => h.created.length === 1 ? gate.promise : { ok: true, data: { id: "synthetic-corrected", title: payload.title } });
  h.update(todayState(DAY));
  h.W.openAdd("today", DAY);
  h.type(h.input(), "synthetic rejected draft");
  h.enter(h.input());
  h.update(todayState(NEXT));
  gate.resolve({ ok: false, code: "INVALID_INPUT", message: "synthetic definite rejection" });
  await settle();
  assert.equal(h.input().value, "synthetic rejected draft");
  assert.equal(h.input().disabled, false);
  assert.equal(h.input().readOnly, false, "a definite rejection needs no outcome verification");
  assert.match(h.document.getElementById("toast").textContent, /没成功/);
  h.enter(h.input());
  await settle();
  assert.equal(h.created.length, 2);
  assert.deepEqual(h.created[1], { title: "synthetic rejected draft", day: NEXT, minute: null });
  assert.equal(h.input().value, "");
});

function jsonResponse(data, status = 200) {
  return { ok: status < 400, status, text: async () => JSON.stringify(
    status < 400 ? { ok: true, data } : { ok: false, error: { code: "SYNTHETIC_FAILURE", message: "synthetic failure" } },
  ) };
}
function taskState() {
  return todayState(DAY, [task({ id: "synthetic-task", title: "synthetic task", dueDay: DAY })]);
}
function checkButton(h) { return h.document.querySelector(".check"); }
function taskRow(h) { return h.document.querySelector(".row"); }

// Serializing only fetch (after getToken), or serializing only one renderer, still loses this intent.
test("R06 same-client writes queue before token reads and preserve cross-card last intent", async () => {
  const tokens = [deferred(), deferred()];
  let reads = 0;
  let finalDone = false;
  const arrivals = [];
  const client = createClient({
    getToken: () => tokens[reads++].promise,
    fetchImpl: async (_url, options) => {
      finalDone = JSON.parse(options.body).isDone;
      arrivals.push(finalDone);
      return jsonResponse({ id: "synthetic-task", isDone: finalDone });
    },
  });
  const operations = [];
  const action = async (name, payload) => {
    assert.equal(name, "setDone");
    const operation = client.setDone(payload.id, payload.isDone);
    operations.push(operation);
    return { ok: true, data: await operation };
  };
  const firstCard = createRenderer("today", { action });
  const secondCard = createRenderer("today", { action });
  firstCard.update(taskState());
  // A second window can have a different cached snapshot of the same task.
  secondCard.update({
    ...todayState(DAY, [task({ id: "synthetic-task", title: "synthetic task", dueDay: DAY, isDone: true })]),
    settings: { showDone: true },
  });
  checkButton(firstCard).emit("click");
  checkButton(secondCard).emit("click");
  await settle();
  const readsWhileFirstBlocked = reads;
  tokens[1].resolve("S".repeat(32)); // A reverse token completion must not reorder writes.
  await settle();
  tokens[0].resolve("S".repeat(32));
  await Promise.all(operations);
  await settle();
  assert.equal(finalDone, false, "the last cancellation must be the final server state");
  assert.deepEqual(arrivals, [true, false]);
  assert.equal(readsWhileFirstBlocked, 1, "the next write must wait before getToken");
});

test("R06 same-task writes wait for the previous HTTP operation to finish", async () => {
  const gate = deferred();
  const arrivals = [];
  let finalDone = false;
  const client = createClient({
    getToken: async () => "S".repeat(32),
    fetchImpl: async (_url, options) => {
      const { isDone } = JSON.parse(options.body);
      if (isDone) await gate.promise;
      finalDone = isDone;
      arrivals.push(isDone);
      return jsonResponse({ isDone });
    },
  });
  const first = client.setDone("synthetic-task", true);
  const latest = client.setDone("synthetic-task", false);
  await settle();
  gate.resolve();
  await Promise.all([first, latest]);
  assert.equal(finalDone, false);
  assert.deepEqual(arrivals, [true, false]);
});

test("R06 a failed write releases its queue without blocking other task IDs", async () => {
  const gate = deferred();
  const stored = new Map([["synthetic-a", false], ["synthetic-b", false]]);
  const client = createClient({
    getToken: async () => "S".repeat(32),
    fetchImpl: async (url, options) => {
      const id = decodeURIComponent(url.split("/").at(-1));
      const { isDone } = JSON.parse(options.body);
      if (id === "synthetic-a" && isDone) { await gate.promise; return jsonResponse(null, 500); }
      stored.set(id, isDone);
      return jsonResponse({ id, isDone });
    },
  });
  const first = client.setDone("synthetic-a", true);
  const failure = assert.rejects(first, { code: "SYNTHETIC_FAILURE" });
  const latest = client.setDone("synthetic-a", false);
  const other = client.setDone("synthetic-b", true);
  await settle();
  assert.equal(stored.get("synthetic-b"), true, "another task must not wait for the blocked task");
  gate.resolve();
  await Promise.all([failure, latest, other]);
  assert.equal(stored.get("synthetic-a"), false);
  await client.setDone("synthetic-a", true).catch(() => {}); // Settled failures must not poison future operations.
  await client.setDone("synthetic-a", false);
  assert.equal(stored.get("synthetic-a"), false);
});

test("R06 older replies do not remove the latest renderer pending intent or offer stale undo", async () => {
  const gates = [deferred(), deferred()];
  const sent = [];
  const h = createRenderer("today", { action: async (_name, payload) => {
    sent.push(structuredClone(payload));
    return gates[sent.length - 1].promise;
  } });
  h.update(taskState());
  checkButton(h).emit("click");
  assert.equal(taskRow(h).classList.contains("done"), true);
  checkButton(h).emit("click");
  assert.deepEqual(sent.map((p) => p.isDone), [true, false]);
  gates[0].resolve({ ok: true });
  await settle();
  assert.equal(taskRow(h).classList.contains("pending"), true, "the newer cancellation still has no reply");
  assert.equal(taskRow(h).classList.contains("done"), false);
  assert.doesNotMatch(h.document.getElementById("toast").textContent, /已完成|撤销/, "superseded success must not offer an undo");
  gates[1].resolve({ ok: true });
  await settle();
  assert.equal(taskRow(h).classList.contains("pending"), false);
  assert.equal(h.W.isDone(taskState().view.list[0]), false);
});

test("R06 reversed renderer replies keep the latest displayed intent", async () => {
  const gates = [deferred(), deferred()];
  let sent = 0;
  const h = createRenderer("today", { action: () => gates[sent++].promise });
  h.update(taskState());
  const item = taskState().view.list[0];
  const first = h.W.toggleDone(item, true);
  const latest = h.W.toggleDone(item, false);
  gates[1].resolve({ ok: true });
  await latest;
  gates[0].resolve({ ok: true });
  await first;
  assert.equal(h.W.isDone(item), false);
  assert.doesNotMatch(h.document.getElementById("toast").textContent, /已完成|撤销/);
});

test("R06 rejected IPC clears pending and allows a new completion attempt", async () => {
  let tries = 0;
  const h = createRenderer("today", { action: async () => {
    if (++tries === 1) throw new Error("synthetic IPC failure");
    return { ok: true };
  } });
  h.update(taskState());
  const item = taskState().view.list[0];
  await assert.doesNotReject(h.W.toggleDone(item, true));
  assert.equal(taskRow(h).classList.contains("pending"), false);
  assert.equal(h.W.isDone(item), false);
  assert.match(h.document.getElementById("toast").textContent, /synthetic IPC failure/);
  await h.W.toggleDone(item, true);
  assert.equal(tries, 2);
  assert.equal(taskRow(h).classList.contains("pending"), false);
});

test("R06 an older failed reply leaves the latest pending choice available", async () => {
  const gates = [deferred(), deferred()];
  let sent = 0;
  const h = createRenderer("today", { action: () => gates[sent++].promise });
  h.update(taskState());
  const item = taskState().view.list[0];
  const first = h.W.toggleDone(item, true);
  const latest = h.W.toggleDone(item, false);
  gates[0].resolve({ ok: false, message: "synthetic write failure" });
  await first;
  assert.equal(taskRow(h).classList.contains("pending"), true);
  assert.equal(h.W.isDone(item), false);
  gates[1].resolve({ ok: true });
  await latest;
  assert.equal(taskRow(h).classList.contains("pending"), false);
});

function focusHarness({ confirmStop = false, paused = false } = {}) {
  let cfg = { ...pomo.DEFAULT_POMODORO, confirmStop };
  let session = pomo.start(pomo.createState(), cfg, NOW).state;
  if (paused) session = pomo.pause(session, cfg, NOW).state;
  const h = createRenderer("focus", { now: () => NOW, action: async (name) => {
    assert.equal(name, "pomoStop");
    session = pomo.stop(session, cfg).state;
    return { ok: true };
  } });
  const update = () => h.update({
    settings: { pomodoro: cfg }, view: null,
    pomodoro: { ...session, cfg, label: "专注", taskTitle: null },
  });
  update();
  return {
    ...h,
    get status() { return session.status; },
    setConfirm(value) { cfg = { ...cfg, confirmStop: value }; update(); h.W.tick(); },
    stopButton: () => h.document.querySelector(".focus-btns").children.at(-1),
  };
}

// Omitting confirmStop from the render signature leaves the old one-click-stop closure active.
for (const paused of [false, true]) {
  test(`R07 enabling stop confirmation while ${paused ? "paused" : "running"} protects the current session`, async () => {
    const h = focusHarness({ paused });
    h.setConfirm(true);
    h.stopButton().emit("click");
    await settle();
    assert.equal(h.status, paused ? "paused" : "running", "the first click must not end the current session");
    assert.match(h.stopButton().textContent, /确认/);
  });
}

test("R07 disabling stop confirmation lets the next click stop the session", async () => {
  const h = focusHarness({ confirmStop: true });
  h.setConfirm(false);
  h.stopButton().emit("click");
  await settle();
  assert.equal(h.status, "idle", "the updated setting must allow a one-click stop");
});

// Only DOM/event dispatch and IPC are replaced; the entire real settings page script runs.
function tokenPage(response) {
  const nodes = new Map();
  const submitted = [];
  function node(id) {
    if (!nodes.has(id)) nodes.set(id, {
      value: "", textContent: "", hidden: false, listeners: {},
      addEventListener(name, listener) { (this.listeners[name] ||= []).push(listener); },
      emit(name, event = {}) { return Promise.all((this.listeners[name] || []).map((fn) => fn(event))); },
      click() { return this.emit("click"); },
    });
    return nodes.get(id);
  }
  const context = vm.createContext({
    document: { getElementById: node, querySelectorAll: () => [] },
    window: { widget: {
      onState() {},
      action(name, payload) {
        assert.equal(name, "setToken");
        submitted.push(structuredClone(payload));
        return response(payload);
      },
    } },
    setTimeout: () => 1, clearTimeout() {},
  });
  vm.runInContext(fs.readFileSync(new URL("../src/renderer/settings.js", import.meta.url), "utf8"), context);
  return {
    submitted,
    get value() { return node("token").value; },
    type(value) { node("token").value = value; return node("token").emit("input"); },
    save: () => node("token-save").click(),
    enter: () => node("token").emit("keydown", { key: "Enter" }),
  };
}

// An old successful response must only clear the draft version that was actually submitted.
test("P04 a successful token save leaves a different unsubmitted draft intact", async () => {
  const gate = deferred();
  const h = tokenPage(() => gate.promise);
  await h.type("A".repeat(32));
  const saving = h.save();
  await h.type("B".repeat(32));
  gate.resolve({ ok: true });
  await saving;
  assert.deepEqual(h.submitted, [{ token: "A".repeat(32) }]);
  assert.equal(h.value, "B".repeat(32));
});

test("P04 editing back to the submitted text still makes a new draft version", async () => {
  const gate = deferred();
  const h = tokenPage(() => gate.promise);
  await h.type("A".repeat(32));
  const saving = h.save();
  await h.type("");
  await h.type("A".repeat(32));
  gate.resolve({ ok: true });
  await saving;
  assert.equal(h.value, "A".repeat(32), "text equality does not mean the user has not edited the draft");
  assert.equal(h.submitted.length, 1);
});

test("P04 a successful unchanged token draft clears after keyboard submission", async () => {
  const gate = deferred();
  const h = tokenPage(() => gate.promise);
  await h.type("A".repeat(32));
  await h.enter();
  assert.deepEqual(h.submitted, [{ token: "A".repeat(32) }]);
  gate.resolve({ ok: true });
  await settle();
  assert.equal(h.value, "");
});

for (const rejected of [false, true]) {
  test(`P04 a ${rejected ? "rejected IPC" : "failed save"} keeps the editable token draft for retry`, async () => {
    const gate = deferred();
    const h = tokenPage(() => gate.promise);
    await h.type("A".repeat(32));
    const saving = h.save();
    await h.type("B".repeat(32));
    if (rejected) gate.reject(new Error("synthetic save failure"));
    else gate.resolve({ ok: false, message: "synthetic save failure" });
    await saving;
    assert.equal(h.value, "B".repeat(32));
  });
}
