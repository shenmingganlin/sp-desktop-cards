import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { buildBreakdown } from "../src/main/breakdown.js";
import { buildHeatmap } from "../src/main/heatmap.js";
import { createSettingsStore } from "../src/main/settings.js";
import * as theme from "../src/main/theme.js";
import * as snap from "../src/main/snap.js";
import { task } from "./fixtures.js";
import { createRenderer } from "./renderer-harness.js";
import { windowAlive } from "../src/main/win.js";

const MIN = 60_000;
const DAY = "2026-11-09";
const NEXT = "2026-11-10";
const NOW = new Date(2026, 10, 9, 12).getTime();
const settle = () => new Promise(setImmediate);
const mainSource = fs.readFileSync(new URL("../src/main/main.js", import.meta.url), "utf8");
const sourceBetween = (source, from, to) => {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start);
  assert.ok(start >= 0 && end > start, `找不到源码区段：${from}`);
  return source.slice(start, end);
};

const viewState = (view) => ({ settings: { showDone: false }, collapsed: false, view });
const heatRaw = (ms) => ({ allTasks: [task({ id: "heat", timeSpentOnDay: { [DAY]: ms } })] });

test("回归：热力图用时变化时，合计和悬停提示一起刷新", () => {
  const h = createRenderer("heatmap", { now: () => NOW });
  h.update(viewState(buildHeatmap(heatRaw(60 * MIN), { today: DAY, weeks: 4 })));
  h.update(viewState(buildHeatmap(heatRaw(90 * MIN), { today: DAY, weeks: 4 })));
  assert.match(h.document.querySelector(".heat-total").textContent, /1 小时 30 分/);
  assert.match(h.document.querySelector(".today").title, /1 小时 30 分/);
});

test("回归：热力图跨日时，今天标记跟着移动", () => {
  const h = createRenderer("heatmap", { now: () => NOW });
  const bothDays = { allTasks: [task({ id: "heat", timeSpentOnDay: { [DAY]: 60 * MIN, [NEXT]: 60 * MIN } })] };
  h.update(viewState(buildHeatmap(bothDays, { today: DAY, weeks: 4 })));
  h.update(viewState(buildHeatmap(bothDays, { today: NEXT, weeks: 4 })));
  assert.match(h.document.querySelector(".today").title, /11月10日/);
});

test("回归：时间去向实际用时变化时，重复计数说明一起刷新", () => {
  const tags = [{ id: "x", title: "X" }, { id: "y", title: "Y" }];
  const before = buildBreakdown({
    tags,
    allTasks: [task({ id: "a", tagIds: ["x", "y"], timeSpentOnDay: { [DAY]: 60 * MIN } })],
  }, { today: DAY, by: "tag" });
  const after = buildBreakdown({
    tags,
    allTasks: [
      task({ id: "a", tagIds: ["x"], timeSpentOnDay: { [DAY]: 30 * MIN } }),
      task({ id: "b", tagIds: ["y"], timeSpentOnDay: { [DAY]: 30 * MIN } }),
      task({ id: "c", tagIds: ["x", "y"], timeSpentOnDay: { [DAY]: 30 * MIN } }),
    ],
  }, { today: DAY, by: "tag" });
  const h = createRenderer("breakdown", { now: () => NOW });
  h.update(viewState(before));
  h.update(viewState(after));
  assert.match(h.document.querySelector(".bd-note").textContent, /实际 1 小时 30 分/);
  assert.match(h.document.getElementById("foot").textContent, /7 天共 1 小时 30 分/);
});

class SimpleElement {
  constructor(tag = "div") {
    this.tag = tag;
    this.children = [];
    this.style = {};
    this.hidden = false;
    this.value = "";
    this.textContent = "";
    this.className = "";
    this.dataset = {};
    this.listeners = {};
  }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  addEventListener(name, fn) { this.listeners[name] = fn; }
  setAttribute() {}
  focus() {}
}

function settingsPageHarness() {
  const ids = [
    "toast", "appearance-button", "hotkey-button", "reset-layout", "chime-test", "tour", "check-update", "refresh",
    "token-save", "token", "project", "theme-current", "theme-external", "opacity-out", "hotkey-current", "mode-hint",
    "conn", "token-state",
  ];
  const nodes = new Map(ids.map((id) => [id, new SimpleElement(id === "token" ? "input" : "div")]));
  let stateHandler = null;
  const context = vm.createContext({
    document: {
      activeElement: null,
      getElementById: (id) => nodes.get(id),
      querySelectorAll: () => [],
      querySelector: () => null,
    },
    window: {
      widget: {
        action: async (name) => name === "setToken" ? Promise.reject(new Error("加密失败")) : { ok: true },
        onState: (fn) => { stateHandler = fn; },
      },
    },
    Chime: { play: async () => {} },
    setTimeout: () => 1,
    clearTimeout() {},
  });
  vm.runInContext(fs.readFileSync(new URL("../src/renderer/settings.js", import.meta.url), "utf8"), context);
  return { nodes, stateHandler };
}

test("回归：手填令牌加密失败时，设置页提示且保留输入", async () => {
  const h = settingsPageHarness();
  const input = h.nodes.get("token");
  input.value = "A".repeat(32);
  await h.nodes.get("token-save").listeners.click();
  assert.match(h.nodes.get("toast").textContent, /没保存成功|加密/);
  assert.equal(input.value, "A".repeat(32));
});

test("回归：主进程手填令牌加密失败返回可显示的错误", async () => {
  const context = vm.createContext({
    safeStorage: { encryptStringAsync: async () => { throw new Error("DPAPI unavailable"); } },
    settings: { get: () => ({ manualToken: "" }), update: () => assert.fail("失败时不应写设置") },
    isValidToken: () => true,
    poller: { kick: () => assert.fail("失败时不应刷新") },
    pushState: () => assert.fail("失败时不应推状态") ,
    canEncrypt: true,
    manualToken: "",
    autoToken: "",
  });
  vm.runInContext(sourceBetween(mainSource, "async function setManualToken", "const client =") + "\nglobalThis.call = setManualToken;", context);
  const result = await vm.runInContext('call("A".repeat(32))', context);
  assert.equal(result.ok, false);
  assert.match(result.message, /加密/);
});

function appearanceHarness() {
  const nodes = new Map(["grid", "current", "external", "done"].map((id) => [id, new SimpleElement(id)]));
  let eventHandler = null;
  const context = vm.createContext({
    document: {
      getElementById: (id) => nodes.get(id),
      createElement: (tag) => new SimpleElement(tag),
    },
    window: {
      WTheme: { apply() {} },
      widget: {
        action: async (name) => name === "themeCatalog"
          ? { ok: true, data: { skins: theme.SKINS, current: "new-warm-paper", source: "任务台" } }
          : { ok: true },
        onEvent: (fn) => { eventHandler = fn; },
      },
    },
  });
  vm.runInContext(fs.readFileSync(new URL("../src/renderer/appearance.js", import.meta.url), "utf8"), context);
  return { nodes, event: (value) => eventHandler(value) };
}

test("回归：外部主题覆盖时，外观选择不能暂时显示手选主题", async () => {
  const h = appearanceHarness();
  await settle();
  const dark = h.nodes.get("grid").children.find((button) => button.dataset.skin === "dark");
  await dark.listeners.click();
  assert.match(h.nodes.get("current").textContent, /暖纸/);
  h.event({ type: "theme", theme: "new-warm-paper", source: "" });
  assert.equal(h.nodes.get("external").hidden, true);
});

test("回归：辅助窗口原生销毁空档不会让主题更新抛错", () => {
  const dead = {
    isDestroyed: () => false,
    isVisible: () => { throw new Error("Object has been destroyed"); },
    setBackgroundColor: () => assert.fail("销毁窗口不应继续调用原生方法"),
    webContents: { send: () => assert.fail("销毁窗口不应继续发送") },
  };
  const context = vm.createContext({
    settings: { get: () => ({ theme: "dark" }) },
    theme: { resolveSkin: () => ({ theme: "dark" }), backgroundOf: () => "#000", isLightSkin: () => false, skinOf: () => ({ name: "深夜" }) },
    nativeTheme: {},
    cards: { setBackground() {} },
    settingsWin: dead,
    appearanceWin: null,
    hotkeyWin: null,
    tourWin: null,
    updateWin: dead,
    currentTheme: () => ({ theme: "dark" }),
    windowAlive,
  });
  vm.runInContext(sourceBetween(mainSource, "function applyTheme()", "// ── 不挡点击") , context);
  assert.doesNotThrow(() => vm.runInContext("applyTheme()", context));
});

test("回归：下载窗口重试时恢复可取消的进行中界面", () => {
  const nodes = new Map(["title", "detail", "fill", "cancel", "close"].map((id) => [id, new SimpleElement(id)]));
  let eventHandler = null;
  const context = vm.createContext({
    document: { getElementById: (id) => nodes.get(id) },
    window: { widget: { onEvent: (fn) => { eventHandler = fn; }, action: async () => ({ ok: true }) } },
  });
  vm.runInContext(fs.readFileSync(new URL("../src/renderer/update.js", import.meta.url), "utf8"), context);
  eventHandler({ type: "failed", message: "第一次失败" });
  eventHandler({ type: "start", version: "9.9.9" });
  assert.equal(nodes.get("title").textContent, "正在下载更新");
  assert.equal(nodes.get("cancel").hidden, false);
  assert.equal(nodes.get("close").hidden, true);
  assert.equal(nodes.get("fill").style.width, "0%");
});

test("回归：更新窗口页面晚到时，失败事件先缓存而不是丢失", () => {
  const dead = { isDestroyed: () => false, isVisible: () => { throw new Error("Object has been destroyed"); }, webContents: { send() {} } };
  const context = vm.createContext({ updateWin: dead, windowAlive });
  const start = mainSource.indexOf("let updateEvent");
  const end = mainSource.indexOf("function closeUpdateWindow", start);
  assert.ok(start >= 0 && end > start, "主进程应有更新事件缓存");
  vm.runInContext(mainSource.slice(start, end), context);
  assert.doesNotThrow(() => vm.runInContext('sendUpdate({ type: "failed", message: "网络错误" })', context));
  const event = vm.runInContext("updateEvent", context);
  assert.equal(event.type, "failed");
  assert.equal(event.message, "网络错误");
});

test("回归：迁移失败时设置存储保持只读，下一次启动仍可重试", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spw-readonly-settings-"));
  try {
    const store = createSettingsStore(dir, { readOnly: true });
    store.update({ opacity: 0.4 });
    store.flush();
    assert.equal(fs.existsSync(path.join(dir, "settings.json")), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("回归：隐藏最后一张卡片后，状态回调能看到已无可见卡片", () => {
  const cardsSource = fs.readFileSync(new URL("../src/main/cards.js", import.meta.url), "utf8")
    .replace(/^import .*;\r?\n/gm, "")
    .replace(/^export /gm, "");
  const settings = {
    data: {
      mode: "normal",
      locked: false,
      clickThrough: false,
      cards: { today: { visible: true, collapsed: false, bounds: null } },
    },
    get() { return structuredClone(this.data); },
    updateCard(type, patch) { this.data.cards[type] = { ...this.data.cards[type], ...patch }; },
    update() {},
  };
  const timers = new Map();
  let nextTimer = 0;
  let now = 0;
  const context = vm.createContext({
    settings,
    CARD_TYPES: ["today"],
    CARD_SIZE: { today: { width: 320, height: 380 } },
    HEADER_HEIGHT: 34,
    GAP: 6,
    screen: { getAllDisplays: () => [{ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }], getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }), on() {} },
    desktop: { available: () => false, detach() {}, attach() {}, toDesktopLayer() {}, atDesktopLayer: () => false, keepClickable() {}, primaryButtonDown: () => null, altDown: () => false },
    windowAlive,
    backgroundOf: () => "#000",
    ...snap,
    BrowserWindow: class {
      constructor(bounds) { this.bounds = { ...bounds }; this.visible = false; this.dead = false; this.opacity = 1; this.listeners = {}; this.webContents = { on() {}, setWindowOpenHandler() {}, isLoading: () => false, send() {} }; }
      on(name, fn) { (this.listeners[name] ||= []).push(fn); }
      once(name, fn) { this.listeners[name] = [fn]; }
      emit(name, value = {}) { for (const fn of this.listeners[name] || []) fn(value); }
      isDestroyed() { return this.dead; }
      isVisible() { return this.visible; }
      isFocused() { return false; }
      setMenu() {}
      setBounds(b) { this.bounds = { ...b }; }
      getBounds() { return { ...this.bounds }; }
      setMinimumSize() {}
      setMaximumSize() {}
      setAlwaysOnTop() {}
      setFocusable() {}
      setIgnoreMouseEvents() {}
      setBackgroundColor() {}
      setOpacity(value) { this.opacity = value; }
      getOpacity() { return this.opacity; }
      showInactive() { this.visible = true; }
      hide() { this.visible = false; }
      loadFile() {}
      destroy() { this.dead = true; this.visible = false; this.emit("closed"); }
    },
    Date: class extends Date { static now() { return now; } },
    setInterval(fn) { const id = ++nextTimer; timers.set(id, fn); return id; },
    clearInterval(id) { timers.delete(id); },
    setTimeout() { return 0; },
    clearTimeout() {},
  });
  vm.runInContext(cardsSource + "\nglobalThis.makeCards = createCards;", context);
  const states = [];
  const cards = context.makeCards({ settings, preload: "", page: "", icon: "", onChange: () => states.push(cards.isShown()) });
  cards.start();
  const win = cards.window("today");
  win.emit("ready-to-show");
  cards.setVisible("today", false);
  now = 1000;
  for (const fn of [...timers.values()]) fn();
  assert.equal(states.at(-1), false);
  cards.quit();
});
