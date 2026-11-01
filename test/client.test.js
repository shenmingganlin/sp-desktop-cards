import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createPoller } from "../src/main/poller.js";
import { createSettingsStore, sanitize } from "../src/main/settings.js";
import { createClient } from "../src/main/sp-client.js";
import { readSpToken } from "../src/main/token.js";
import { startFakeSp } from "./fake-sp.js";
import { sampleData } from "./fixtures.js";

async function withSp(fn, opts = {}) {
  const sp = await startFakeSp({ data: sampleData(), ...opts });
  try {
    await fn(sp, createClient({ baseUrl: sp.url, getToken: async () => sp.token, timeoutMs: 1000 }));
  } finally {
    await sp.close();
  }
}

test("客户端：读列表、勾选、开始和停止计时", () =>
  withSp(async (sp, client) => {
    assert.equal((await client.todayTasks()).length, 6);
    assert.equal(await client.current(), null);
    await client.start("report");
    assert.equal((await client.current()).id, "report");
    await client.setDone("report", true);
    assert.equal(sp.state.tasks.find((t) => t.id === "report").isDone, true);
    await client.stop();
    assert.equal(await client.current(), null);
    // Node 的 fetch 不带 Origin，SP 的防 CSRF 检查不会拦
    assert.ok(sp.state.calls.includes("PATCH /tasks/report"));
  }));

test("客户端：各种失败都翻译成能照着做的说明", async () => {
  await withSp(async (sp) => {
    const wrong = createClient({ baseUrl: sp.url, getToken: async () => "B".repeat(32) });
    await assert.rejects(wrong.current(), { code: "SP_UNAUTHORIZED" });
    const none = createClient({ baseUrl: sp.url, getToken: async () => "" });
    await assert.rejects(none.current(), { code: "SP_NO_TOKEN" });
  });
  await withSp(async (sp, client) => {
    sp.state.failNext = { status: 503, code: "API_DISABLED" };
    await assert.rejects(client.current(), { code: "SP_API_DISABLED" });
    sp.state.failNext = { status: 503, code: "APP_NOT_READY" };
    await assert.rejects(client.current(), { code: "SP_NOT_READY" });
    await assert.rejects(client.setDone("nope", true), { code: "TASK_NOT_FOUND" });
  });
  const closed = createClient({ baseUrl: "http://127.0.0.1:9", getToken: async () => "A".repeat(32) });
  await assert.rejects(closed.current(), { code: "SP_UNREACHABLE" });
  const slow = createClient({ baseUrl: "http://x", getToken: async () => "A".repeat(32), timeoutMs: 20, fetchImpl: (_u, { signal }) => new Promise((_r, reject) => signal.addEventListener("abort", () => reject(signal.reason))) });
  await assert.rejects(slow.current(), { code: "SP_TIMEOUT" });
});

test("轮询：首次完整刷新，之后只查当前任务，当前任务变了才重取列表", () =>
  withSp(async (sp, client) => {
    let clock = 1000;
    const views = [];
    const poller = createPoller({
      client,
      onData: (v) => views.push(v),
      onError: (e) => assert.fail(e.message),
      now: () => clock,
      setTimer: () => 0,
      clearTimer: () => {},
    });
    await poller.start();
    assert.equal(views.length, 1);
    assert.equal(views[0].snapshotAt, 1000);
    const listCalls = () => sp.state.calls.filter((c) => c.startsWith("GET /tasks")).length;
    assert.equal(listCalls(), 2);

    clock += 2000;
    // 当前任务没变、也没到慢轮询间隔：不重取列表
    sp.state.calls.length = 0;
    await pollOnce(poller);
    assert.equal(listCalls(), 0);

    sp.state.current = "review";
    await pollOnce(poller);
    assert.equal(listCalls(), 2);
    assert.equal(views.at(-1).current.id, "review");
    assert.equal(views.at(-1).ticking.task, true);

    clock += 15000;
    sp.state.calls.length = 0;
    await pollOnce(poller);
    assert.equal(listCalls(), 2, "超过慢轮询间隔后重取列表");
    poller.stop();
  }));

test("轮询：出错时报告，恢复后完整刷新", () =>
  withSp(async (sp, client) => {
    const errors = [];
    const views = [];
    const poller = createPoller({
      client,
      onData: (v) => views.push(v),
      onError: (e) => errors.push(e.code),
      setTimer: () => 0,
      clearTimer: () => {},
    });
    await poller.start();
    sp.state.down = true;
    await poller.kick();
    assert.deepEqual(errors, ["SP_UNREACHABLE"]);
    sp.state.down = false;
    sp.state.calls.length = 0;
    await pollOnce(poller);
    assert.equal(views.length, 2);
    assert.ok(sp.state.calls.some((c) => c.startsWith("GET /tasks")));
    poller.stop();
  }));

test("轮询：取数据途中又要求刷新，只补一次", () =>
  withSp(async (sp, client) => {
    const views = [];
    const poller = createPoller({ client, onData: (v) => views.push(v), onError: () => {}, setTimer: () => 0, clearTimer: () => {} });
    const first = poller.start();
    poller.kick();
    poller.kick();
    await first;
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(views.length, 2);
    poller.stop();
  }));

test("令牌：从候选路径里读第一个合法的", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spw-"));
  const bad = path.join(dir, "bad");
  const good = path.join(dir, "good");
  fs.writeFileSync(bad, "not-a-token");
  fs.writeFileSync(good, `${"Z".repeat(32)}\n`);
  assert.equal(await readSpToken([path.join(dir, "missing"), bad, good]), "Z".repeat(32));
  assert.equal(await readSpToken([bad]), "");
});

test("设置：数值收敛到合法范围，未知字段丢掉，写盘可读回", () => {
  const s = sanitize({ opacity: 5, upcomingMinutes: -3, dayStartHour: 30.4, cards: { today: { bounds: { x: 1, y: 2, width: "w" } } }, evil: 1 });
  assert.equal(s.opacity, 1);
  assert.equal(s.upcomingMinutes, 0);
  assert.equal(s.dayStartHour, 23);
  assert.equal(s.cards.today.bounds, null);
  assert.ok(!("evil" in s));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spw-"));
  const store = createSettingsStore(dir);
  store.updateCard("today", { collapsed: true, bounds: { x: 10, y: 20, width: 300, height: 400 } });
  store.flush();
  const again = createSettingsStore(dir).get();
  assert.equal(again.cards.today.collapsed, true);
  assert.deepEqual(again.cards.today.bounds, { x: 10, y: 20, width: 300, height: 400 });
  assert.equal(again.cards.focus.bounds, null);
});

test("设置：读到 0.1.0 的文件时迁移后再用", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spw-"));
  fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ bounds: { x: 50, y: 60, width: 320, height: 470 }, alwaysOnTop: true }));
  const s = createSettingsStore(dir).get();
  assert.equal(s.version, 2);
  assert.equal(s.mode, "top");
  assert.deepEqual(s.cards.focus.bounds, { x: 50, y: 60, width: 320, height: 132 });
});

test("客户端：新建任务、删除任务、读项目和重复配置", () =>
  withSp(async (sp, client) => {
    const t = await client.createTask({ title: "新任务", projectId: "INBOX_PROJECT", tagIds: [], dueDay: "2026-11-03" });
    assert.equal(t.title, "新任务");
    assert.deepEqual(sp.state.bodies.at(-1), { method: "POST", path: "/tasks", body: { title: "新任务", projectId: "INBOX_PROJECT", tagIds: [], dueDay: "2026-11-03" } });
    await client.deleteTask(t.id);
    assert.ok(!sp.state.tasks.some((x) => x.id === t.id));
    assert.deepEqual((await client.projects()).map((p) => p.id), ["INBOX_PROJECT", "work"]);
    assert.equal((await client.repeatCfgs()).length, 3);
    // 老版本 SP 没有这个接口
    sp.state.failNext = { status: 404, code: "NOT_FOUND" };
    assert.deepEqual(await client.repeatCfgs(), []);
  }));

test("轮询：数据里带上项目、重复配置和列表时间", () =>
  withSp(async (_sp, client) => {
    let data = null;
    const poller = createPoller({ client, onData: (d) => (data = d), onError: (e) => assert.fail(e.message), now: () => 5000, setTimer: () => 0, clearTimer: () => {} });
    await poller.start();
    assert.equal(data.projects.length, 2);
    assert.equal(data.repeatCfgs.length, 3);
    assert.equal(data.listsAt, 5000);
    assert.deepEqual(data.ticking, { task: false, focus: false });
    poller.stop();
  }));

// 测试里定时器是空的，手动跑一轮普通轮询。
const pollOnce = (poller) => poller.poll();
