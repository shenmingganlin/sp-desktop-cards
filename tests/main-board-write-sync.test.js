// Execute the actual main menu action, board helper and client against an in-memory SP.
// No Electron, production settings, token discovery or real HTTP is used.
import assert from "node:assert/strict";
import vm from "node:vm";
import test from "node:test";
import { importMain, readMainSource } from "./support/source.js";

const { createClient, HINTS } = await importMain("sp-client.js");
const { BOARD_PRESETS, moveTaskToColumn, KANBAN_IN_PROGRESS, EM_URGENT, EM_IMPORTANT } = await importMain("boards.js");
const mainSource = readMainSource("main.js");
const slice = (start, end) => {
  const at = mainSource.indexOf(start);
  const until = mainSource.indexOf(end, at);
  assert.ok(at >= 0 && until > at, `Actual main function not found: ${start}`);
  return mainSource.slice(at, until);
};
const actionSource = slice("/** 换列的菜单动作。", "\nfunction wrapUpMenu(") + "\n" +
  slice("async function runTaskAction(", "\nfunction createTask(");
const canonical = [KANBAN_IN_PROGRESS, EM_URGENT, EM_IMPORTANT].map((id) => ({ id, title: id }));
const makeTask = (id = "A", fields = {}) => ({ id, title: `任务-${id}`, tagIds: ["keep"], isDone: false, projectId: "project", ...fields });
const makeProject = (fields = {}) => ({ id: "project", title: "项目", isEnableBacklog: true, backlogTaskIds: [], ...fields });
const response = (data) => new Response(JSON.stringify({ ok: true, data }));
const refused = () => new Response(JSON.stringify({ ok: false, error: { code: "NOT_FOUND", message: "fixture refusal" } }), { status: 404 });
const settle = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };

function host({ tasks = [makeTask()], staleTasks, tags = canonical, staleTags = tags,
  projects = [makeProject()], staleProjects = [makeProject()], preset = "kanban", intercept } = {}) {
  const store = new Map(tasks.map((task) => [task.id, structuredClone(task)]));
  const raw = { allTasks: structuredClone(staleTasks ?? tasks), tags: structuredClone(staleTags), projects: structuredClone(staleProjects) };
  const calls = [];
  const messages = [];
  let kicks = 0;
  const settings = { boardPreset: preset };
  const client = createClient({
    baseUrl: "http://sp.invalid", getToken: async () => "fixture-only-token",
    fetchImpl: async (url, options) => {
      const pathname = new URL(url).pathname;
      const call = { path: pathname, method: options.method, body: options.body ? JSON.parse(options.body) : undefined };
      calls.push(call);
      const override = await intercept?.(call, { calls, store });
      if (override !== undefined) return override;
      if (options.method === "GET" && pathname === "/tags") return response(tags);
      if (options.method === "GET" && pathname === "/projects") return response(projects);
      const id = decodeURIComponent(pathname.split("/")[2]);
      if (!store.has(id)) return refused();
      if (options.method === "GET") return response(store.get(id));
      assert.equal(options.method, "PATCH");
      store.set(id, { ...store.get(id), ...call.body });
      return response(store.get(id));
    },
  });
  const context = vm.createContext({
    client, HINTS, BOARD_PRESETS, moveTaskToColumn, raw,
    settings: { get: () => settings },
    boardColumnTitles: () => new Map((BOARD_PRESETS[settings.boardPreset]?.panels ?? []).map((panel) => [panel.id, panel.title])),
    poller: { kick: () => { kicks++; } }, toast: { show: (message) => messages.push(message) },
  });
  new vm.Script(actionSource + "\n;globalThis.move = moveTaskToColumnAction;").runInContext(context);
  return { calls, store, messages, settings, raw, kicks: () => kicks,
    patches: () => calls.filter(({ method }) => method === "PATCH"),
    text: () => messages.map(({ text }) => text).join("\n"),
    move: (column, id = "A") => context.move(id, column) };
}

test("fresh task reads preserve unrelated labels added since the last poll", async () => {
  const h = host({ staleTasks: [makeTask()], tasks: [makeTask("A", { tagIds: ["keep", "external-new"] })] });
  await h.move("IN_PROGRESS");
  assert.deepEqual(h.store.get("A").tagIds, ["keep", "external-new", KANBAN_IN_PROGRESS]);
  assert.deepEqual(h.calls.filter(({ method }) => method === "GET").map(({ path }) => path).sort(), ["/projects", "/tags", "/tasks/A"]);
  assert.equal(h.patches().length, 1);
  assert.equal(h.kicks(), 1);
});

test("moving out of a tagged column removes only its canonical tag from the fresh task", async () => {
  const h = host({ staleTasks: [makeTask("A", { tagIds: ["keep", KANBAN_IN_PROGRESS] })],
    tasks: [makeTask("A", { tagIds: ["keep", "external-new", KANBAN_IN_PROGRESS] })] });
  await h.move("TODO");
  assert.deepEqual(h.store.get("A").tagIds, ["keep", "external-new"]);
});

test("fresh completion state is used instead of the old poll snapshot", async () => {
  const h = host({ staleTasks: [makeTask()], tasks: [makeTask("A", { isDone: true })] });
  await h.move("TODO");
  assert.equal(h.store.get("A").isDone, false);
  assert.equal(h.patches()[0].body.isDone, false);
});

test("fresh tag entities are consulted rather than a stale missing-label snapshot", async () => {
  const h = host({ staleTags: [] });
  await h.move("IN_PROGRESS");
  assert.deepEqual(h.store.get("A").tagIds, ["keep", KANBAN_IN_PROGRESS]);
});

test("fresh backlog context rejects an unsupported move without a PATCH", async () => {
  const h = host({ projects: [makeProject({ backlogTaskIds: ["A"] })] });
  await h.move("IN_PROGRESS");
  assert.equal(h.patches().length, 0);
  assert.match(h.text(), /积压/);
  assert.equal(h.kicks(), 1);
});

test("fresh child identity rejects a parent-only matrix move without a PATCH", async () => {
  const h = host({ preset: "eisenhower", staleTasks: [makeTask()], tasks: [makeTask("A", { parentId: "parent" })] });
  await h.move("URGENT_AND_IMPORTANT");
  assert.equal(h.patches().length, 0);
  assert.match(h.text(), /子任务|父任务/);
});

test("a no-change board intent sends no write", async () => {
  const h = host();
  await h.move("TODO");
  assert.equal(h.patches().length, 0);
  assert.match(h.text(), /已在|当前.*列/);
  assert.equal(h.kicks(), 1);
});

test("existing canonical tags can be a no-op even if their tag entities are temporarily absent", async () => {
  const h = host({ preset: "eisenhower", tags: [], tasks: [makeTask("A", { tagIds: [EM_URGENT, EM_IMPORTANT] })] });
  await h.move("URGENT_AND_IMPORTANT");
  assert.equal(h.patches().length, 0);
  assert.doesNotMatch(h.text(), /没挪成/);
  assert.match(h.text(), /已在|当前.*列/);
});

test("same-task board intents serialize before their fresh reads and derive each patch from its predecessor", async () => {
  const gate = deferred();
  let reads = 0;
  const h = host({ preset: "eisenhower", intercept: async (call) => {
    if (call.method === "GET" && call.path === "/tasks/A" && ++reads === 1) await gate.promise;
  } });
  const first = h.move("URGENT_AND_IMPORTANT");
  await settle();
  const second = h.move("NOT_URGENT_AND_IMPORTANT");
  await settle();
  const before = { reads, patches: h.patches().length };
  gate.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(before, { reads: 1, patches: 0 });
  assert.equal(reads, 2);
  assert.deepEqual(h.patches().map(({ body }) => [...body.tagIds].sort()),
    [["keep", EM_URGENT, EM_IMPORTANT].sort(), ["keep", EM_IMPORTANT].sort()]);
  assert.deepEqual(h.store.get("A").tagIds, ["keep", EM_IMPORTANT]);
});

test("a slow board move for one task does not block another task", async () => {
  const gate = deferred();
  const h = host({ tasks: [makeTask("A"), makeTask("B")], intercept: async (call) => {
    if (call.method === "GET" && call.path === "/tasks/A") await gate.promise;
  } });
  const first = h.move("IN_PROGRESS", "A");
  await settle();
  const other = h.move("IN_PROGRESS", "B");
  await settle();
  const before = h.patches().map(({ path }) => path);
  gate.resolve();
  await Promise.all([first, other]);
  assert.deepEqual(before, ["/tasks/B"]);
});

test("queued moves keep the preset captured when each intent was received", async () => {
  const gate = deferred();
  let reads = 0;
  const h = host({ preset: "eisenhower", tasks: [makeTask("A", { isDone: true })], intercept: async (call) => {
    if (call.method === "GET" && call.path === "/tasks/A" && ++reads === 1) await gate.promise;
  } });
  const first = h.move("URGENT_AND_IMPORTANT");
  await settle();
  const second = h.move("NOT_URGENT_AND_IMPORTANT");
  h.settings.boardPreset = "kanban";
  gate.resolve();
  await Promise.all([first, second]);
  assert.equal(h.patches().length, 2);
  assert.equal(h.store.get("A").isDone, true);
  assert.deepEqual(h.store.get("A").tagIds, ["keep", EM_IMPORTANT]);
  assert.match(h.text(), /已移到「重要不紧急」/);
});

test("a failed read releases the next explicit same-task intent without a write or replay for the failed one", async () => {
  let reads = 0;
  const h = host({ intercept: (call) => call.method === "GET" && call.path === "/tasks/A" && ++reads === 1 ? refused() : undefined });
  await Promise.all([h.move("IN_PROGRESS"), h.move("IN_PROGRESS")]);
  assert.equal(reads, 2);
  assert.equal(h.patches().length, 1);
  assert.match(h.messages[0].text, /没挪成/);
  assert.doesNotMatch(h.messages[0].text, /待核实/);
});

test("an unknown PATCH is not replayed; the next explicit move reads its committed result", async () => {
  let writes = 0;
  const h = host({ preset: "eisenhower", intercept: (call, { store }) => {
    if (call.method === "PATCH" && ++writes === 1) {
      store.set("A", { ...store.get("A"), ...call.body });
      throw new Error("fixture committed PATCH response lost");
    }
  } });
  await Promise.all([h.move("URGENT_AND_NOT_IMPORTANT"), h.move("URGENT_AND_IMPORTANT")]);
  assert.equal(h.patches().length, 2);
  assert.match(h.messages[0].text, /结果待核实/);
  assert.doesNotMatch(h.messages[0].text, /没挪成/);
  assert.deepEqual(h.patches()[1].body.tagIds, ["keep", EM_URGENT, EM_IMPORTANT]);
});

for (const [label, value] of [
  ["null", null], ["array", []], ["wrong task", makeTask("B")],
  ["missing tagIds", { ...makeTask(), tagIds: undefined }], ["non-array tagIds", makeTask("A", { tagIds: "keep" })],
  ["invalid tag ID", makeTask("A", { tagIds: [null] })], ["blank tag ID", makeTask("A", { tagIds: [" "] })],
  ["invalid done flag", makeTask("A", { isDone: "false" })], ["invalid parent", makeTask("A", { parentId: {} })],
]) {
  test(`invalid fresh task data (${label}) cannot result in a PATCH`, async () => {
    const h = host({ intercept: (call) => call.method === "GET" && call.path === "/tasks/A" ? response(value) : undefined });
    await h.move("IN_PROGRESS");
    assert.equal(h.patches().length, 0);
    assert.match(h.text(), /没挪成|数据|回执/);
    assert.doesNotMatch(h.text(), /待核实/);
  });
}

for (const [path, label, value] of [
  ["/tags", "non-list tags", null], ["/tags", "invalid tag record", [null]],
  ["/tags", "invalid tag id", [{ id: 1, title: "bad" }]],
  ["/projects", "non-list projects", {}], ["/projects", "missing backlog IDs", [{ id: "project", title: "bad", isEnableBacklog: true }]],
  ["/projects", "invalid backlog IDs", [makeProject({ backlogTaskIds: [42] })]],
  ["/projects", "invalid backlog flag", [makeProject({ isEnableBacklog: "false" })]],
]) {
  test(`invalid fresh board context (${label}) cannot result in a PATCH`, async () => {
    const h = host({ intercept: (call) => call.method === "GET" && call.path === path ? response(value) : undefined });
    await h.move("IN_PROGRESS");
    assert.equal(h.patches().length, 0);
    assert.doesNotMatch(h.text(), /待核实/);
  });
}

for (const path of ["/tags", "/projects"]) {
  test(`failure to read ${path} cannot result in a PATCH`, async () => {
    const h = host({ intercept: (call) => { if (call.method === "GET" && call.path === path) throw new Error("fixture read lost"); } });
    await h.move("IN_PROGRESS");
    assert.equal(h.patches().length, 0);
    assert.match(h.text(), /没挪成/);
    assert.doesNotMatch(h.text(), /待核实/);
  });
}

test("task IDs are URL-encoded for fresh reads and writes", async () => {
  const id = "task/with ?#空格";
  const h = host({ tasks: [makeTask(id)] });
  await h.move("IN_PROGRESS", id);
  assert.ok(h.calls.some((call) => call.method === "GET" && call.path === `/tasks/${encodeURIComponent(id)}`));
  assert.equal(h.patches().length, 1);
  assert.deepEqual(h.store.get(id).tagIds, ["keep", KANBAN_IN_PROGRESS]);
});
