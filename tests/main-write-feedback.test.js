// Actual main-process menu actions and client; only in-memory SP/IPC boundaries.
// These checks never start Electron or read a real token, settings or endpoint.
import assert from "node:assert/strict";
import vm from "node:vm";
import test from "node:test";
import { importMain, readMainSource } from "./support/source.js";

const { createClient, HINTS } = await importMain("sp-client.js");
const { addDays } = await importMain("calendar.js");
const mainSource = readMainSource("main.js");
const slice = (start, end) => {
  const at = mainSource.indexOf(start);
  const until = mainSource.indexOf(end, at);
  assert.ok(at >= 0 && until > at, `Actual main function not found: ${start}`);
  return mainSource.slice(at, until);
};
const actionSource = [
  slice("/** 换列的菜单动作。", "\nfunction wrapUpMenu("),
  slice("async function moveLeftOverToTomorrow(", "\n/**\n * 清单卡片"),
  slice("async function runTaskAction(", "\nfunction createTask("),
].join("\n");
const reply = (data) => new Response(JSON.stringify({ ok: true, data }));
const refusal = () => new Response(JSON.stringify({ ok: false,
  error: { code: "TASK_NOT_FOUND", message: "fixture known rejection" } }), { status: 404 });

function host({ outcomes = {}, noToken = false, invalidMove = false } = {}) {
  const calls = [];
  const committed = [];
  const messages = [];
  let kicks = 0;
  const tasks = Object.keys(outcomes).map((id) => ({ id, title: `任务-${id}`, tagIds: [], isDone: false }));
  const client = createClient({
    baseUrl: "http://sp.invalid", getToken: async () => noToken ? "" : "fixture-only-token",
    fetchImpl: async (url, options) => {
      const pathname = new URL(url).pathname;
      const id = decodeURIComponent(pathname.split("/")[2]);
      const call = { id, path: pathname, method: options.method,
        body: options.body ? JSON.parse(options.body) : undefined };
      if (options.method === "GET") {
        if (pathname === "/tags") return reply([{ id: "fixture-doing", title: "fixture-doing" }]);
        if (pathname === "/projects") return reply([{ id: "fixture-project", title: "Fixture", isEnableBacklog: false, backlogTaskIds: [] }]);
        return reply(tasks.find((task) => task.id === id));
      }
      calls.push(call);
      if (outcomes[id] === "rejected") return refusal();
      committed.push(call);
      if (outcomes[id] === "unknown") throw new Error("fixture committed write with response lost");
      return reply({ id, title: `任务-${id}` });
    },
  });
  const context = vm.createContext({
    client, HINTS, addDays, currentDay: () => "2026-11-11",
    raw: { allTasks: tasks },
    settings: { get: () => ({ boardPreset: "kanban" }) },
    BOARD_PRESETS: { kanban: { panels: [{ id: "doing", title: "进行中" }] } },
    boardColumnTitles: () => new Map([["doing", "进行中"]]),
    moveTaskToColumn() {
      if (invalidMove) throw new Error("fixture invalid target");
      return { tagIds: ["fixture-doing"] };
    },
    poller: { kick: () => { kicks++; } },
    toast: { show: (message) => messages.push(message) },
  });
  new vm.Script(actionSource + "\n;globalThis.actions = { moveTaskToColumnAction, moveLeftOverToTomorrow, archiveDone };").runInContext(context);
  return {
    calls, committed, messages, kicks: () => kicks,
    text: () => messages.map(({ text }) => text).join("\n"),
    run: (kind, ids = Object.keys(outcomes)) => kind === "board"
      ? context.actions.moveTaskToColumnAction(ids[0], "doing")
      : kind === "move"
        ? context.actions.moveLeftOverToTomorrow(ids.map((id) => ({ id, title: `任务-${id}` })))
        : context.actions.archiveDone(ids),
  };
}

for (const [kind, success, failed] of [
  ["board", /已移到「/, /没挪成/],
  ["move", /已把 1 项排到明天/, /1 项没排上/],
  ["archive", /已归档 1 项/, /1 项没归档/],
]) {
  test(`${kind}: a committed write with a lost response is unconfirmed, not reported as failed`, async () => {
    const h = host({ outcomes: { uncertain: "unknown" } });
    await h.run(kind);
    assert.equal(h.committed.length, 1, "The fake backend committed before losing its response");
    assert.equal(h.calls.length, 1, "An uncertain write must not be replayed");
    assert.match(h.text(), /结果待核实/);
    assert.match(h.text(), /先.*SP.*(?:检查|核实)/);
    assert.doesNotMatch(h.text(), failed);
    assert.doesNotMatch(h.text(), success);
    assert.equal(h.kicks(), 1);
  });

  test(`${kind}: a definite business rejection retains ordinary failure feedback`, async () => {
    const h = host({ outcomes: { refused: "rejected" } });
    await h.run(kind);
    assert.equal(h.committed.length, 0);
    assert.equal(h.calls.length, 1);
    assert.match(h.text(), failed);
    assert.doesNotMatch(h.text(), /待核实/);
    assert.equal(h.kicks(), 1);
  });

  test(`${kind}: confirmed success retains ordinary success feedback`, async () => {
    const h = host({ outcomes: { confirmed: "ok" } });
    await h.run(kind);
    assert.equal(h.committed.length, 1);
    assert.equal(h.calls.length, 1);
    assert.match(h.text(), success);
    assert.doesNotMatch(h.text(), /待核实|没挪成|没排上|没归档/);
    assert.equal(h.kicks(), 1);
    if (kind === "move") assert.deepEqual(h.calls[0].body, { dueDay: "2026-11-12", dueWithTime: null });
  });
}

for (const [kind, success, failed] of [
  ["move", /已把 2 项排到明天/, /1 项没排上：任务-refused/],
  ["archive", /已归档 2 项/, /1 项没归档/],
]) {
  test(`${kind}: a mixed batch distinguishes success, rejection and unknown without replay`, async () => {
    const h = host({ outcomes: { first: "ok", uncertainA: "unknown", refused: "rejected", uncertainB: "unknown", last: "ok" } });
    await h.run(kind);
    assert.deepEqual(h.calls.map(({ id }) => id), ["first", "uncertainA", "refused", "uncertainB", "last"]);
    assert.deepEqual(h.committed.map(({ id }) => id), ["first", "uncertainA", "uncertainB", "last"]);
    assert.match(h.text(), success);
    assert.match(h.text(), failed);
    assert.match(h.text(), /2 项.*结果待核实/);
    assert.match(h.text(), /先.*SP.*(?:检查|核实)/);
    assert.equal(h.messages.length, 1, "Summarize the batch once");
    assert.equal(h.kicks(), 1, "Refresh once after the batch, not once per item");
  });

  test(`${kind}: no token is a known failure before dispatch, not an unknown outcome`, async () => {
    const h = host({ outcomes: { first: "ok", second: "ok" }, noToken: true });
    await h.run(kind);
    assert.equal(h.calls.length, 0);
    assert.equal(h.committed.length, 0);
    assert.match(h.text(), kind === "move" ? /2 项没排上/ : /2 项没归档/);
    assert.doesNotMatch(h.text(), /待核实/);
    assert.equal(h.kicks(), 1);
  });
}

test("board: local move validation remains a known error without a PATCH or replay", async () => {
  const h = host({ outcomes: { invalid: "ok" }, invalidMove: true });
  await h.run("board");
  assert.equal(h.calls.length, 0);
  assert.equal(h.kicks(), 1);
  assert.match(h.text(), /fixture invalid target/);
  assert.doesNotMatch(h.text(), /待核实/);
});
