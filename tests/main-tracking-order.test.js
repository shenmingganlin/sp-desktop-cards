// Actual main-process effect dispatch plus the actual client, with in-memory SP/clock boundaries.
import assert from "node:assert/strict";
import vm from "node:vm";
import test from "node:test";
import { importMain, readMainSource } from "./support/source.js";

const { createClient } = await importMain("sp-client.js");
const mainSource = readMainSource("main.js");
const slice = (start, end) => {
  const at = mainSource.indexOf(start);
  const until = mainSource.indexOf(end, at);
  assert.ok(at >= 0 && until > at, `Actual main function not found: ${start}`);
  return mainSource.slice(at, until);
};
const effectSource = slice("function applyPomo(", "\n/** 今天的番茄数") + "\n" +
  slice("async function runEffect(", "\n// ── 阶段结束");
const settle = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
const response = (data) => new Response(JSON.stringify({ ok: true, data }));

function host({ gate, failFirst = false, notify = () => {} } = {}) {
  const calls = [];
  let current = null;
  const client = createClient({
    baseUrl: "http://sp.invalid", getToken: async () => "fixture-only-token",
    fetchImpl: async (url) => {
      const pathname = new URL(url).pathname;
      calls.push(pathname);
      if (pathname === "/tasks/A/start" && gate) {
        await gate.promise;
        if (failFirst) throw new Error("fixture A response lost");
      }
      if (pathname === "/task-control/current") return response(current ? { id: current, title: "fixture" } : null);
      current = pathname === "/task-control/stop" ? null : decodeURIComponent(pathname.split("/")[2]);
      return response({ currentTaskId: current });
    },
  });
  const context = vm.createContext({
    client, notify, HINTS: {}, poller: { kick() {} },
    savePomo() {}, syncTrayTip() {}, pushState() {}, clearTimeout() {}, setTimeout() {}, Date,
  });
  new vm.Script(`let pomoState, pomoTimer, lastError;\n${effectSource}\nthis.apply = applyPomo;`).runInContext(context);
  return {
    client, calls, current: () => current,
    effects: (...effects) => context.apply({ state: { status: "idle" }, effects }),
  };
}

test("pending pomodoro A, then pomodoro C, then manual B preserves the global intent order", async () => {
  const gate = deferred();
  const h = host({ gate });
  h.effects({ type: "track", taskId: "A" });
  await settle();
  h.effects({ type: "track", taskId: "C" });
  const manual = h.client.start("B");
  await settle();
  const beforeRelease = [...h.calls];
  gate.resolve();
  await manual; await settle();
  assert.deepEqual(beforeRelease, ["/tasks/A/start"]);
  assert.deepEqual(h.calls, ["/tasks/A/start", "/tasks/C/start", "/tasks/B/start"]);
  assert.equal(h.current(), "B", "An older pomodoro intent cannot overwrite the latest manual task");
});

test("a failed pending pomodoro effect releases later intents in order without replay", async () => {
  const gate = deferred();
  const h = host({ gate, failFirst: true });
  h.effects({ type: "track", taskId: "A" });
  await settle();
  h.effects({ type: "track", taskId: "C" });
  const manual = h.client.start("B");
  gate.resolve();
  await manual; await settle();
  assert.deepEqual(h.calls, ["/tasks/A/start", "/tasks/C/start", "/tasks/B/start"]);
  assert.equal(h.current(), "B");
});

test("a pending notification never blocks tracking effects or a later manual intent", async () => {
  const note = deferred();
  let notifications = 0;
  const h = host({ notify: () => { notifications++; return note.promise; } });
  h.effects({ type: "notify", title: "fixture" }, { type: "track", taskId: "A" });
  await settle();
  await h.client.start("B");
  const beforeNotificationCompletes = [...h.calls];
  note.resolve(); await settle();
  assert.equal(notifications, 1);
  assert.deepEqual(beforeNotificationCompletes, ["/tasks/A/start", "/tasks/B/start"]);
  assert.equal(h.current(), "B");
});

test("pomodoro conditional untrack enters the client queue before a later manual start", async () => {
  const gate = deferred();
  const h = host({ gate });
  h.effects({ type: "track", taskId: "A" });
  await settle();
  h.effects({ type: "untrack", taskId: "A" });
  const manual = h.client.start("B");
  gate.resolve();
  await manual; await settle();
  assert.deepEqual(h.calls, ["/tasks/A/start", "/task-control/current", "/task-control/stop", "/tasks/B/start"]);
  assert.equal(h.current(), "B");
});
