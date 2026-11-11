// Execute the actual card script and action boundary using an in-memory DOM/IPC.
// No Electron session, SP endpoint, token or production settings are used.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";

const cardSource = await fs.readFile(new URL("../src/renderer/card.js", import.meta.url), "utf8");
const mainSource = await fs.readFile(new URL("../src/main/main.js", import.meta.url), "utf8");
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
const drain = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

async function card(reply) {
  const calls = [];
  let document;
  class Node {
    constructor(tag = "div") {
      this.tagName = tag;
      this.children = [];
      this.listeners = {};
      this.dataset = {};
      this.attributes = {};
      this.value = "";
      this.scrollTop = 0;
      this.hidden = false;
      this.readOnly = false;
      this.disabled = false;
      this.classes = new Set();
      this.classList = {
        add: (name) => this.classes.add(name),
        contains: (name) => this.classes.has(name),
        toggle: (name, on = !this.classes.has(name)) => on ? this.classes.add(name) : this.classes.delete(name),
      };
    }
    set textContent(value) { this.text = String(value); this.children = []; }
    get textContent() { return (this.text || "") + this.children.map((child) => child.textContent).join(""); }
    append(...children) { this.children.push(...children); }
    appendChild(child) { this.append(child); }
    replaceChildren(...children) { this.children = children; this.text = ""; }
    setAttribute(key, value) { this.attributes[key] = String(value); }
    addEventListener(type, listener) { this.listeners[type] = listener; }
    focus() { document.activeElement = this; }
    setSelectionRange() {}
    blur() { document.activeElement = null; }
  }
  const ids = new Map(["head", "tools", "collapse", "title", "sub", "banner", "blocked-mark", "body", "foot", "menu", "toast"].map((id) => [id, new Node()]));
  const walk = (root) => [root, ...root.children.flatMap(walk)];
  document = {
    body: new Node("body"), activeElement: null,
    getElementById: (id) => ids.get(id),
    createElement: (tag) => new Node(tag), createDocumentFragment: () => new Node("fragment"),
    querySelector: () => walk(ids.get("body")).find((node) => node.dataset.add === "1") || null,
    addEventListener() {},
  };
  const window = {
    widget: {
      action: async (name, payload) => {
        calls.push({ name, payload });
        return name === "createTask" ? reply(payload) : { ok: true };
      },
    },
    addEventListener() {},
  };
  const context = vm.createContext({ document, window, URLSearchParams, location: { search: "?card=today" }, setTimeout: () => 1, clearTimeout() {} });
  new vm.Script(cardSource + "\n;globalThis.cardApi = W;").runInContext(context);
  const api = context.cardApi;
  const slots = new Set(["today"]);
  api.define("today", { render(body) {
    for (const key of slots) { const slot = api.addSlot(key); if (slot) body.append(slot); }
  } });
  const state = { view: { today: "2026-11-11" }, settings: {} };
  api.setState(state);
  api.openAdd("today", state.view.today);
  await drain();
  const input = () => document.querySelector("input[data-add]");
  const enter = async () => {
    input().listeners.keydown({ key: "Enter", isComposing: false, preventDefault() {} });
    await drain();
  };
  return {
    api, state, input, enter,
    openSlot(key, day, minute = null) { slots.add(key); api.openAdd(key, day, minute); },
    setTitle(title) { input().value = title; input().listeners.input(); },
    calls: () => calls.filter(({ name }) => name === "createTask"),
    text: () => ids.get("toast").textContent,
    buttons: () => walk(ids.get("body")).filter((node) => node.tagName === "button"),
  };
}

test("uncertain creation preserves the draft and blocks repeated Enter through repaint", async () => {
  const p = await card(async () => ({ ok: false, code: "SP_UNREACHABLE", outcomeUnknown: true, message: "连接断开" }));
  p.setTitle("提交后丢失响应");
  await p.enter();
  assert.equal(p.calls().length, 1);
  assert.equal(p.input().value, "提交后丢失响应");
  assert.equal(p.input().readOnly, true);
  assert.match(p.text(), /未确认|待核实/);
  assert.doesNotMatch(p.text(), /没成功/);
  p.api.setState(p.state); p.api.render(true);
  await p.enter(); await p.enter();
  assert.equal(p.calls().length, 1, "Repaint or repeated Enter cannot issue another create");
  const checked = p.buttons().find((button) => button.textContent === "确认未创建");
  assert.ok(checked, "The user has an explicit way to unlock after checking SP");
  checked.listeners.click({ stopPropagation() {} });
  await drain();
  assert.equal(p.calls().length, 1, "Acknowledging verification only unlocks; it does not resend");
  assert.equal(p.input().readOnly, false);
  await p.enter();
  assert.equal(p.calls().length, 2, "A later explicit Enter is a new submission");
});

test("a definite rejection keeps the draft editable for a corrected retry", async () => {
  const p = await card(async () => ({ ok: false, code: "SP_NO_TOKEN", message: "未发送" }));
  p.setTitle("没有发出的任务"); await p.enter();
  assert.equal(p.input().value, "没有发出的任务");
  assert.equal(p.input().readOnly, false);
  assert.match(p.text(), /没成功/);
  await p.enter();
  assert.equal(p.calls().length, 2);
});

test("a confirmed creation clears the title and shows success", async () => {
  const p = await card(async () => ({ ok: true, data: { id: "created", title: "已确认" } }));
  p.setTitle("已确认"); await p.enter();
  assert.equal(p.input().value, "");
  assert.match(p.text(), /已添加/);
  await p.enter();
  assert.equal(p.calls().length, 1);
});

test("a repaint during a pending create cannot unlock the draft", async () => {
  const result = deferred();
  const p = await card(() => result.promise);
  p.setTitle("等待中的任务"); await p.enter();
  p.api.render(true);
  assert.equal(p.input().disabled, true);
  await p.enter();
  assert.equal(p.calls().length, 1);
  result.resolve({ ok: true, data: { id: "created", title: "等待中的任务" } });
  await drain();
  assert.equal(p.input().value, "");
});

for (const [label, key, day, minute] of [
  ["another day", "day:2026-11-12", "2026-11-12", null],
  ["another time slot", "slot:2026-11-11", "2026-11-11", 600],
]) {
  test(`an uncertain draft cannot be cloned into ${label} without verification`, async () => {
    const p = await card(async () => ({ ok: false, outcomeUnknown: true }));
    const initialKey = minute === null ? "today" : key;
    if (minute !== null) p.openSlot(key, day, 540);
    p.setTitle("待核实的任务"); await p.enter();
    p.openSlot(key, day, minute);
    assert.equal(p.api.isAdding(initialKey), true, "Keep the original guarded draft visible");
    if (minute !== null) assert.equal(p.api.addingMinute(), 540);
    assert.equal(p.input().value, "待核实的任务");
    assert.equal(p.input().readOnly, true);
    await p.enter();
    assert.equal(p.calls().length, 1);
  });

  test(`an in-flight draft cannot be cloned into ${label} before its response`, async () => {
    const result = deferred();
    const p = await card(() => result.promise);
    const initialKey = minute === null ? "today" : key;
    if (minute !== null) p.openSlot(key, day, 540);
    p.setTitle("提交中的任务"); await p.enter();
    p.openSlot(key, day, minute);
    assert.equal(p.api.isAdding(initialKey), true);
    if (minute !== null) assert.equal(p.api.addingMinute(), 540);
    assert.equal(p.input().disabled, true);
    await p.enter();
    assert.equal(p.calls().length, 1);
    result.resolve({ ok: true, data: { id: "created", title: "提交中的任务" } });
    await drain();
    assert.equal(p.input().value, "", "The original response still settles its own draft");
    assert.equal(p.input().disabled, false);
  });
}

test("ordinary editable text still follows a day change", async () => {
  const p = await card(async () => ({ ok: true, data: { id: "created", title: "可移动的草稿" } }));
  p.setTitle("可移动的草稿");
  p.openSlot("day:2026-11-12", "2026-11-12");
  assert.equal(p.api.isAdding("day:2026-11-12"), true);
  assert.equal(p.input().value, "可移动的草稿");
  await p.enter();
  assert.equal(p.calls().length, 1);
  assert.equal(p.calls()[0].payload.day, "2026-11-12");
});

test("a definitely rejected draft can still move to another day for an explicit retry", async () => {
  const p = await card(async () => ({ ok: false, code: "INVALID_INPUT", message: "明确拒绝" }));
  p.setTitle("可以修正重试"); await p.enter();
  p.openSlot("day:2026-11-12", "2026-11-12");
  assert.equal(p.input().value, "可以修正重试");
  assert.equal(p.input().readOnly, false);
  await p.enter();
  assert.equal(p.calls().length, 2);
  assert.equal(p.calls()[1].payload.day, "2026-11-12");
});

test("explicitly closing an uncertain draft still permits a separate new draft", async () => {
  const p = await card(async () => ({ ok: false, outcomeUnknown: true }));
  p.setTitle("旧草稿待核实"); await p.enter();
  p.api.openAdd("today", p.state.view.today);
  assert.equal(p.input(), null);
  p.openSlot("day:2026-11-12", "2026-11-12");
  assert.equal(p.input().value, "");
  assert.equal(p.input().readOnly, false);
  assert.equal(p.calls().length, 1);
});

for (const [label, reply] of [
  ["rejected IPC", async () => { throw new Error("IPC response lost"); }],
  ["missing IPC result", async () => undefined],
  ["invalid success result", async () => ({ ok: true, data: null })],
]) {
  test(`a create with ${label} remains unconfirmed rather than inviting a duplicate`, async () => {
    const p = await card(reply);
    p.setTitle("不确定的任务"); await p.enter(); await p.enter();
    assert.equal(p.calls().length, 1);
    assert.equal(p.input().readOnly, true);
    assert.equal(p.input().value, "不确定的任务");
    assert.match(p.text(), /未确认|待核实/);
  });
}

test("an old result cannot erase or lock another draft opened while waiting", async () => {
  const result = deferred();
  const p = await card(() => result.promise);
  p.setTitle("旧草稿"); await p.enter();
  p.api.openAdd("today", p.state.view.today); // close old draft
  p.api.openAdd("today", p.state.view.today); // open a distinct draft
  p.setTitle("另一条明确的新草稿");
  result.resolve({ ok: false, outcomeUnknown: true, message: "旧提交待核实" });
  await drain();
  assert.equal(p.input().value, "另一条明确的新草稿");
  assert.equal(p.input().readOnly, false);
});

test("the actual main action boundary preserves uncertainty and refreshes without replay", async () => {
  const start = mainSource.indexOf("async function runTaskAction(fn)");
  const end = mainSource.indexOf("\nfunction createTask", start);
  assert.ok(start >= 0 && end > start);
  let refreshes = 0;
  const context = vm.createContext({ HINTS: { SP_TIMEOUT: "超时" }, poller: { kick: () => { refreshes++; } } });
  new vm.Script(mainSource.slice(start, end) + "\n;globalThis.run = runTaskAction;").runInContext(context);
  let attempts = 0;
  const reply = await context.run(async () => { attempts++; throw Object.assign(new Error("已提交但响应丢失"), { code: "SP_TIMEOUT", outcomeUnknown: true }); });
  assert.equal(reply.ok, false);
  assert.equal(reply.outcomeUnknown, true);
  assert.equal(reply.code, "SP_TIMEOUT");
  assert.equal(attempts, 1);
  assert.equal(refreshes, 1);
  const refused = await context.run(async () => { throw Object.assign(new Error("未发送"), { code: "SP_NO_TOKEN" }); });
  assert.equal(refused.outcomeUnknown, undefined);
  const success = await context.run(async () => ({ id: "created" }));
  assert.equal(success.ok, true);
  assert.equal(success.data.id, "created");
});

test("pomodoro untrack delegates its condition and stop into the shared client queue", async () => {
  const start = mainSource.indexOf("async function runEffect(effect)");
  const end = mainSource.indexOf("\n// ── 阶段", start);
  assert.ok(start >= 0 && end > start);
  const checked = [];
  let refreshes = 0;
  const context = vm.createContext({
    client: {
      stopIfCurrent: async (id) => { checked.push(id); },
      current: async () => assert.fail("The condition cannot run outside the tracking FIFO"),
      stop: async () => assert.fail("An unconditional stop could stop a new manual task"),
    },
    poller: { kick: () => { refreshes++; } },
    HINTS: {}, lastError: null, pushState() {},
  });
  new vm.Script(mainSource.slice(start, end) + "\n;globalThis.run = runEffect;").runInContext(context);
  await context.run({ type: "untrack", taskId: "old-pomodoro-task" });
  assert.deepEqual(checked, ["old-pomodoro-task"]);
  assert.equal(refreshes, 1);
});
