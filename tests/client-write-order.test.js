// 实际客户端的隔离回归：计时请求顺序与写入结果的不确定性。
// 每个客户端均注入内存 token/fetch，不读取本机配置，不连接真实 SP。
import assert from "node:assert/strict";
import test from "node:test";
import { importMain } from "./support/source.js";

const { createClient } = await importMain("sp-client.js");
const token = "fixture-only-token";
const settle = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
const reply = (data, status = 200) => new Response(JSON.stringify({ ok: true, data }), { status });
const rejection = (code, status = 400) => new Response(JSON.stringify({ ok: false, error: { code, message: "fixture rejection" } }), { status });
const clientWith = (fetchImpl, options = {}) => createClient({
  baseUrl: "http://sp.invalid", getToken: async () => token, fetchImpl, ...options,
});
const invoke = (client, [method, id]) => client[method](id);

for (const [label, operations, expected, active] of [
  ["A then B", [["start", "A"], ["start", "B"]], ["/tasks/A/start", "/tasks/B/start"], "B"],
  ["start then stop", [["start", "A"], ["stop"]], ["/tasks/A/start", "/task-control/stop"], null],
  ["stop then start", [["stop"], ["start", "B"]], ["/task-control/stop", "/tasks/B/start"], "B"],
]) {
  test(`tracking writes enter one FIFO before asynchronous token reads: ${label}`, async () => {
    const gate = deferred();
    let tokenReads = 0;
    let current = "initial";
    const calls = [];
    const client = clientWith(async (url) => {
      const pathname = new URL(url).pathname;
      calls.push(pathname);
      current = pathname === "/task-control/stop" ? null : decodeURIComponent(pathname.split("/")[2]);
      return reply({ currentTaskId: current });
    }, { getToken: () => ++tokenReads === 1 ? gate.promise : Promise.resolve(token) });
    const writes = operations.map((operation) => invoke(client, operation));
    await settle();
    const readsBeforeRelease = tokenReads;
    gate.resolve(token);
    await Promise.all(writes);
    assert.equal(readsBeforeRelease, 1, "a later intent must not overtake a pending token read");
    assert.deepEqual(calls, expected);
    assert.equal(current, active);
  });
}

test("tracking FIFO waits for the prior response, not merely its token", async () => {
  const gate = deferred();
  const calls = [];
  const client = clientWith(async (url) => {
    const pathname = new URL(url).pathname;
    calls.push(pathname);
    if (calls.length === 1) await gate.promise;
    return reply({ currentTaskId: pathname === "/task-control/stop" ? null : "A" });
  });
  const first = client.start("A");
  const second = client.stop();
  await settle();
  const beforeRelease = [...calls];
  gate.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(beforeRelease, ["/tasks/A/start"]);
  assert.deepEqual(calls, ["/tasks/A/start", "/task-control/stop"]);
});

for (const cause of ["refusal", "transport", "no-token"]) {
  test(`failed tracking intent releases the next explicit intent without replay: ${cause}`, async () => {
    const calls = [];
    let tokenReads = 0;
    const client = clientWith(async (url) => {
      const pathname = new URL(url).pathname;
      calls.push(pathname);
      if (pathname === "/tasks/A/start") {
        if (cause === "transport") throw new Error("fixture response lost");
        return rejection("TASK_NOT_FOUND", 404);
      }
      return reply({ currentTaskId: "B" });
    }, { getToken: async () => ++tokenReads === 1 && cause === "no-token" ? "" : token });
    const first = client.start("A").then(() => assert.fail("first write must reject"), (error) => error);
    const second = client.start("B");
    const error = await first;
    assert.equal(error.code, { refusal: "TASK_NOT_FOUND", transport: "SP_UNREACHABLE", "no-token": "SP_NO_TOKEN" }[cause]);
    assert.deepEqual(await second, { currentTaskId: "B" });
    assert.deepEqual(calls, cause === "no-token" ? ["/tasks/B/start"] : ["/tasks/A/start", "/tasks/B/start"]);
  });
}

test("tracking FIFO does not block unrelated current reads", async () => {
  const gate = deferred();
  const calls = [];
  const client = clientWith(async (url) => {
    const pathname = new URL(url).pathname;
    calls.push(pathname);
    if (pathname === "/tasks/A/start") await gate.promise;
    return reply(pathname === "/task-control/current" ? null : { currentTaskId: "A" });
  });
  const start = client.start("A");
  await settle();
  assert.equal(await client.current(), null);
  gate.resolve();
  await start;
  assert.deepEqual(calls, ["/tasks/A/start", "/task-control/current"]);
});

test("existing per-task completion FIFO remains ordered before token reads", async () => {
  const gate = deferred();
  let tokenReads = 0;
  const values = [];
  const client = clientWith(async (_url, options) => {
    const body = JSON.parse(options.body);
    values.push(body.isDone);
    return reply({ id: "same-task", title: "fixture", ...body });
  }, { getToken: () => ++tokenReads === 1 ? gate.promise : Promise.resolve(token) });
  const first = client.setDone("same-task", true);
  const second = client.setDone("same-task", false);
  await settle();
  const readsBeforeRelease = tokenReads;
  gate.resolve(token);
  await Promise.all([first, second]);
  assert.equal(readsBeforeRelease, 1);
  assert.deepEqual(values, [true, false]);
});

test("conditional stop holds one FIFO unit across its current read and possible stop", async () => {
  const gate = deferred();
  const calls = [];
  let active = "A";
  const client = clientWith(async (url) => {
    const pathname = new URL(url).pathname;
    calls.push(pathname);
    if (pathname === "/task-control/current") {
      const captured = active;
      await gate.promise;
      return reply({ id: captured, title: "fixture" });
    }
    active = pathname === "/task-control/stop" ? null : "B";
    return reply({ currentTaskId: active });
  });
  assert.equal(typeof client.stopIfCurrent, "function");
  const conditional = client.stopIfCurrent("A");
  await settle();
  const manual = client.start("B");
  await settle();
  const beforeRelease = [...calls];
  gate.resolve();
  await Promise.all([conditional, manual]);
  assert.deepEqual(beforeRelease, ["/task-control/current"], "manual tracking cannot interleave the guarded read and stop");
  assert.deepEqual(calls, ["/task-control/current", "/task-control/stop", "/tasks/B/start"]);
  assert.equal(active, "B");
});

test("a prior manual start is observed by conditional stop, so the newer task is not stopped", async () => {
  const calls = [];
  let active = "A";
  const client = clientWith(async (url) => {
    const pathname = new URL(url).pathname;
    calls.push(pathname);
    if (pathname === "/task-control/current") return reply({ id: active, title: "fixture" });
    active = pathname === "/task-control/stop" ? null : "B";
    return reply({ currentTaskId: active });
  });
  assert.equal(typeof client.stopIfCurrent, "function");
  const manual = client.start("B");
  const conditional = client.stopIfCurrent("A");
  await Promise.all([manual, conditional]);
  assert.deepEqual(calls, ["/tasks/B/start", "/task-control/current"]);
  assert.equal(active, "B");
});

test("a failed conditional read never stops blindly and releases later explicit tracking", async () => {
  const calls = [];
  const client = clientWith(async (url) => {
    const pathname = new URL(url).pathname;
    calls.push(pathname);
    if (pathname === "/task-control/current") throw new Error("fixture current read lost");
    return reply({ currentTaskId: "B" });
  });
  assert.equal(typeof client.stopIfCurrent, "function");
  const conditional = client.stopIfCurrent("A").then(() => assert.fail("read must reject"), (error) => error);
  const manual = client.start("B");
  const error = await conditional;
  assert.equal(error.code, "SP_UNREACHABLE");
  assert.notEqual(error.outcomeUnknown, true, "only GET was dispatched");
  await manual;
  assert.deepEqual(calls, ["/task-control/current", "/tasks/B/start"]);
});

for (const current of [null, {}, [], { id: "" }, { id: " " }]) {
  test(`conditional stop cannot infer a matching task from an empty or invalid current: ${JSON.stringify(current)}`, async () => {
    const calls = [];
    const client = clientWith(async (url) => { calls.push(new URL(url).pathname); return reply(current); });
    assert.equal(typeof client.stopIfCurrent, "function");
    if (current === null) assert.deepEqual(await client.stopIfCurrent("A"), { currentTaskId: null });
    else await assert.rejects(client.stopIfCurrent("A"), (error) => error.code === "SP_BAD_RESPONSE" && error.outcomeUnknown !== true);
    assert.deepEqual(calls, ["/task-control/current"]);
  });
}

test("an unknown conditional STOP outcome is not replayed before the next explicit start", async () => {
  const calls = [];
  let active = "A";
  const client = clientWith(async (url) => {
    const pathname = new URL(url).pathname;
    calls.push(pathname);
    if (pathname === "/task-control/current") return reply({ id: active, title: "fixture" });
    if (pathname === "/task-control/stop") {
      active = null;
      throw new Error("fixture STOP response lost after commit");
    }
    active = "B";
    return reply({ currentTaskId: active });
  });
  assert.equal(typeof client.stopIfCurrent, "function");
  const conditional = client.stopIfCurrent("A").then(() => assert.fail("STOP must reject"), (error) => error);
  const manual = client.start("B");
  const error = await conditional;
  assert.equal(error.code, "SP_UNREACHABLE");
  assert.equal(error.outcomeUnknown, true);
  await manual;
  assert.deepEqual(calls, ["/task-control/current", "/task-control/stop", "/tasks/B/start"]);
  assert.equal(active, "B");
});

for (const [method, pathname, body] of [
  ["POST", "/tasks", { title: "fixture" }],
  ["PATCH", "/tasks/fixture", { isDone: true }],
  ["PUT", "/tasks/fixture", { title: "fixture" }],
  ["DELETE", "/tasks/fixture", undefined],
]) {
  for (const [kind, fault, code] of [
    ["transport", () => new Error("fixture response lost after commit"), "SP_UNREACHABLE"],
    ["timeout", () => Object.assign(new Error("fixture timeout after dispatch"), { name: "TimeoutError" }), "SP_TIMEOUT"],
    ["abort", () => Object.assign(new Error("fixture abort after dispatch"), { name: "AbortError" }), "SP_TIMEOUT"],
  ]) {
    test(`${method} ${kind} after dispatch is an unknown write outcome and is never replayed`, async () => {
      let calls = 0;
      const client = clientWith(async () => { calls++; throw fault(); });
      await assert.rejects(client.request(method, pathname, body), (error) => error.code === code && error.outcomeUnknown === true);
      assert.equal(calls, 1);
    });
  }
}

test("failure to decode the received write body is an unknown outcome", async () => {
  let calls = 0;
  const client = clientWith(async () => {
    calls++;
    return { ok: true, status: 201, text: async () => { throw new Error("fixture body connection reset"); } };
  });
  await assert.rejects(client.createTask({ title: "fixture" }), (error) => error.code === "SP_UNREACHABLE" && error.outcomeUnknown === true);
  assert.equal(calls, 1);
});

for (const payload of ["<html>fixture proxy</html>", "null", "[]", "{}", '{"ok":true}', '{"ok":false}', '{"data":{"id":"invented"}}']) {
  test(`unrecognizable successful write envelope cannot claim a known result: ${payload}`, async () => {
    const client = clientWith(async () => new Response(payload, { status: 201 }));
    await assert.rejects(client.createTask({ title: "fixture" }), (error) => error.code === "SP_BAD_RESPONSE" && error.outcomeUnknown === true);
  });
}

for (const data of [null, [], "created", {}, { title: "fixture" }, { id: "" }, { id: " " }, { id: 7 }, { id: "created" }, { id: "created", title: 7 }]) {
  test(`create requires a valid returned task identity and title: ${JSON.stringify(data)}`, async () => {
    const client = clientWith(async () => reply(data, 201));
    await assert.rejects(client.createTask({ title: "fixture" }), (error) => error.code === "SP_BAD_RESPONSE" && error.outcomeUnknown === true);
  });
}

test("valid created tasks retain the exact server data", async () => {
  const data = { id: "created", title: "fixture server title", isDone: false, extra: { keep: true } };
  const client = clientWith(async () => reply(data, 201));
  assert.deepEqual(await client.createTask({ title: "fixture" }), data);
});

for (const [status, code, translated] of [
  [400, "INVALID_INPUT", "INVALID_INPUT"],
  [404, "TASK_NOT_FOUND", "TASK_NOT_FOUND"],
  [409, "CONFLICT", "CONFLICT"],
  [200, "REJECTED", "REJECTED"],
  [503, "API_DISABLED", "SP_API_DISABLED"],
  [503, "APP_NOT_READY", "SP_NOT_READY"],
]) {
  test(`an explicit valid API refusal stays a known failure: ${status} ${code}`, async () => {
    const client = clientWith(async () => rejection(code, status));
    await assert.rejects(client.createTask({ title: "fixture" }), (error) => error.code === translated && error.outcomeUnknown !== true);
  });
}

test("HTTP authentication refusal remains known even without a decodable body", async () => {
  const client = clientWith(async () => ({ status: 401, ok: false, text: async () => { throw new Error("fixture unreadable body"); } }));
  await assert.rejects(client.createTask({ title: "fixture" }), (error) => error.code === "SP_UNAUTHORIZED" && error.outcomeUnknown !== true);
});

test("an unstructured server failure after a write is not proof of rejection", async () => {
  const client = clientWith(async () => new Response("fixture internal error", { status: 500 }));
  await assert.rejects(client.createTask({ title: "fixture" }), (error) => error.code === "SP_HTTP_500" && error.outcomeUnknown === true);
});

test("a structured internal server failure is not proof that its write was rolled back", async () => {
  const client = clientWith(async () => rejection("INTERNAL_ERROR", 500));
  await assert.rejects(client.createTask({ title: "fixture" }), (error) => error.code === "INTERNAL_ERROR" && error.outcomeUnknown === true);
});

test("GET failures never carry unknown-write semantics", async () => {
  for (const fetchImpl of [
    async () => { throw new Error("fixture read lost"); },
    async () => { throw Object.assign(new Error("fixture read timeout"), { name: "TimeoutError" }); },
    async () => new Response("fixture invalid JSON", { status: 200 }),
    async () => new Response("fixture server failure", { status: 500 }),
  ]) {
    await assert.rejects(clientWith(fetchImpl).current(), (error) => error.outcomeUnknown !== true);
  }
});

test("missing tokens reject before dispatch without an unknown outcome", async () => {
  let calls = 0;
  const client = clientWith(async () => { calls++; return reply({}); }, { getToken: async () => "" });
  await assert.rejects(client.createTask({ title: "fixture" }), (error) => error.code === "SP_NO_TOKEN" && error.outcomeUnknown !== true);
  assert.equal(calls, 0);
});

test("token and serialization errors before dispatch are not unknown writes", async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return reply({}); };
  await assert.rejects(clientWith(fetchImpl, { getToken: async () => { throw new Error("fixture token read failed"); } }).createTask({ title: "fixture" }), (error) => error.outcomeUnknown !== true);
  const fields = { title: "fixture" };
  fields.circular = fields;
  await assert.rejects(clientWith(fetchImpl).createTask(fields), (error) => error.outcomeUnknown !== true);
  assert.equal(calls, 0);
});
