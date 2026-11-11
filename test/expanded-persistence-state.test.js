import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import * as pomo from "../src/main/pomodoro.js";
import * as theme from "../src/main/theme.js";
import { isValidToken } from "../src/main/token.js";
import { windowAlive } from "../src/main/win.js";
import { deferred, fakeClock, loadModule, mainSection, settingsFactory, tempDirectory } from "./expanded-persistence-harness.js";

const SYNTHETIC_TOKEN_A = "A".repeat(32), SYNTHETIC_TOKEN_B = "B".repeat(32);
const originalSettings = {
  version: 2, opacity: 0.42, mode: "normal", manualToken: "synthetic-encrypted-placeholder",
  cards: { today: { bounds: { x: 321, y: 123, width: 320, height: 380 } } },
};
function startupPomoSave(store) {
  const context = vm.createContext({ settings: store, pomoState: pomo.createState(), pomo });
  vm.runInContext(mainSection("function savePomo()", "function pomoTick()") + "\nsavePomo();", context);
}

// Removing the read-failure write guard destroys the pre-existing settings via normal savePomo.
for (const code of ["EACCES", "EIO"]) {
  test(`P01: transient ${code} cannot overwrite existing settings during startup/quit`, (t) => {
    const dir = tempDirectory(t), file = path.join(dir, "settings.json"), clock = fakeClock();
    const originalText = JSON.stringify(originalSettings);
    fs.writeFileSync(file, originalText);
    let reads = 0;
    const make = settingsFactory({ clock, fsImpl: { ...fs, readFileSync(file, ...args) {
      if (++reads === 1) throw Object.assign(new Error("synthetic read failure"), { code });
      return fs.readFileSync(file, ...args);
    } } });
    const store = make(dir);
    startupPomoSave(store);
    clock.tick(400);
    store.flush();
    assert.equal(fs.readFileSync(file, "utf8"), originalText, "an unread setting must not become a default-filled write");
    const reopened = settingsFactory()(dir).get();
    assert.equal(reopened.opacity, 0.42);
    assert.equal(reopened.manualToken, "synthetic-encrypted-placeholder");
    assert.equal(reopened.cards.today.bounds.x, 321);
  });
}

for (const initial of ["missing", "malformed-json"]) {
  test(`P01 control: ${initial} settings can still be saved`, (t) => {
    const dir = tempDirectory(t), file = path.join(dir, "settings.json"), clock = fakeClock();
    if (initial === "malformed-json") fs.writeFileSync(file, "{ broken synthetic json");
    const store = settingsFactory({ clock })(dir);
    store.update({ opacity: 0.61 });
    clock.tick(400);
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).opacity, 0.61);
  });
}

test("P01 control: migration readOnly remains readOnly even with readable settings", (t) => {
  const dir = tempDirectory(t), file = path.join(dir, "settings.json"), clock = fakeClock();
  fs.writeFileSync(file, JSON.stringify(originalSettings));
  const store = settingsFactory({ clock })(dir, { readOnly: true });
  store.update({ opacity: 0.8 });
  clock.tick(400);
  store.flush();
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).opacity, 0.42);
});

function tokenHarness(t, encryptStringAsync) {
  const dir = tempDirectory(t), store = settingsFactory()(dir);
  const settingsWin = { webContents: {}, isDestroyed: () => false, isVisible: () => true };
  let invoke, kicks = 0;
  const context = vm.createContext({
    safeStorage: { encryptStringAsync }, settings: store, isValidToken, Buffer, canEncrypt: true,
    manualToken: "", autoToken: "", process: { env: {} }, readSpToken: async () => "synthetic-auto-token",
    poller: { kick() { kicks++; } }, pushState() {}, OK: { ok: true }, windowAlive, settingsWin,
    updateWin: null, appearanceWin: null, hotkeyWin: null, tourWin: null, toast: null,
    cards: { typeOf: () => null }, cardActions: {}, appearanceActions: {}, hotkeyActions: {}, toastActions: {}, tourActions: {},
    ipcMain: { handle(_name, fn) { invoke = fn; } },
  });
  vm.runInContext(mainSection("async function loadManualToken", "const client =")
    + mainSection("const settingsActions =", "const appearanceActions =")
    + mainSection("const updateActions =", 'ipcMain.on("ready"'), context);
  return {
    store, context, file: path.join(dir, "settings.json"), get kicks() { return kicks; },
    call: (token) => invoke({ sender: settingsWin.webContents }, "setToken", { token }),
  };
}

// Without a per-call revision, delayed encryption resurrects a successfully cleared credential.
test("P02: a newer clear wins over an older delayed encrypted save through real IPC", async (t) => {
  const gate = deferred(), h = tokenHarness(t, () => gate.promise);
  const older = h.call(SYNTHETIC_TOKEN_A);
  assert.equal((await h.call("")).ok, true);
  gate.resolve(Buffer.from("synthetic-encrypted-A"));
  const result = await older;
  assert.equal(h.store.get().manualToken, "", "older completion cannot restore stored credentials");
  assert.equal(h.context.manualToken, "", "older completion cannot restore in-memory credentials");
  h.store.flush();
  assert.equal(JSON.parse(fs.readFileSync(h.file, "utf8")).manualToken, "");
  assert.equal(result.ok, false, "a discarded save must not report success");
  assert.equal(h.kicks, 1);
});

test("P02: the newer saved token wins when encryption completes in reverse order", async (t) => {
  const a = deferred(), b = deferred();
  const h = tokenHarness(t, (token) => token === SYNTHETIC_TOKEN_A ? a.promise : b.promise);
  const first = h.call(SYNTHETIC_TOKEN_A), second = h.call(SYNTHETIC_TOKEN_B);
  b.resolve(Buffer.from("synthetic-encrypted-B"));
  assert.equal((await second).ok, true);
  a.resolve(Buffer.from("synthetic-encrypted-A"));
  const result = await first;
  assert.equal(await h.context.getToken(), SYNTHETIC_TOKEN_B);
  assert.equal(h.store.get().manualToken, Buffer.from("synthetic-encrypted-B").toString("base64"));
  assert.equal(result.ok, false);
});

test("P02: a newer encryption failure does not allow an older request to commit", async (t) => {
  const a = deferred(), b = deferred();
  const h = tokenHarness(t, (token) => token === SYNTHETIC_TOKEN_A ? a.promise : b.promise);
  const first = h.call(SYNTHETIC_TOKEN_A), second = h.call(SYNTHETIC_TOKEN_B);
  b.reject(new Error("synthetic encryption unavailable"));
  assert.equal((await second).ok, false);
  a.resolve(Buffer.from("synthetic-encrypted-A"));
  assert.equal((await first).ok, false);
  assert.equal(h.store.get().manualToken, "");
  assert.equal(h.context.manualToken, "");
});

test("P02 control: encryption rejection preserves an existing credential and returns failure", async (t) => {
  const h = tokenHarness(t, async () => { throw new Error("synthetic encryption unavailable"); });
  h.store.update({ manualToken: "synthetic-existing-encrypted" });
  h.context.manualToken = SYNTHETIC_TOKEN_A;
  const result = await h.call(SYNTHETIC_TOKEN_B);
  assert.equal(result.ok, false);
  assert.equal(h.store.get().manualToken, "synthetic-existing-encrypted");
  assert.equal(await h.context.getToken(), SYNTHETIC_TOKEN_A);
  assert.equal(h.kicks, 0);
});

class SyntheticWindow extends EventEmitter {
  constructor() {
    super();
    this.webContents = new EventEmitter();
    this.webContents.setWindowOpenHandler = () => {};
  }
  isDestroyed() { return false; }
  isVisible() { return true; }
  setMenu() {}
  loadFile() {}
  show() {}
  focus() {}
}

// A flush in before-quit alone runs before the tutorial's real closed handler updates tourDone.
test("P05: quitting immediately after tutorial closed persists tourDone without the debounce", (t) => {
  const dir = tempDirectory(t), clock = fakeClock(), store = settingsFactory({ clock })(dir);
  store.flush();
  const app = new EventEmitter();
  const context = vm.createContext({
    settings: store, app, BrowserWindow: SyntheticWindow, windowAlive, path, theme,
    currentTheme: () => ({ theme: "dark" }), icon: "synthetic", preload: "synthetic", renderer: "synthetic",
    cards: { quit() {} }, themeStopWatcher: null, globalShortcut: { unregisterAll() {} }, toast: null,
  });
  vm.runInContext(mainSection("let tourWin =", "// ── 检查更新")
    + mainSection('app.on("before-quit"', "app.whenReady()")
    + "\nopenTour(); globalThis.tutorial = tourWin;", context);
  app.emit("before-quit");
  context.tutorial.emit("closed");
  assert.equal(store.get().tourDone, true);
  app.emit("will-quit"); // No clock.tick: the process is allowed to exit immediately here.
  assert.equal(settingsFactory()(dir).get().tourDone, true, "the next launch must not reopen the tutorial");
  assert.equal(clock.pending, 0);
});

function themeHarness(fsImpl) {
  let tick;
  const context = loadModule("theme.js", {
    fs: fsImpl, setInterval(fn) { tick = fn; return { unref() {} }; }, clearInterval() {},
  });
  return { context, tick: () => tick() };
}

// Committing mtime before a read succeeds prevents same-mtime recovery from a temporary lock.
test("P06: watcher retries a temporarily unreadable theme at the same mtime", () => {
  let reads = 0;
  const h = themeHarness({
    statSync: () => ({ mtimeMs: 42 }),
    readFileSync() {
      if (++reads === 2) throw Object.assign(new Error("synthetic file lock"), { code: "EACCES" });
      return JSON.stringify({ theme: "midnight", source: "synthetic" });
    },
  });
  let current = h.context.readExternal("synthetic"); // Match main's successful initial read.
  assert.equal(current.theme, "midnight");
  h.context.watchExternal("synthetic", (value) => { current = value; });
  h.tick(); // Same mtime, but the file is readable now.
  assert.equal(h.context.resolveSkin("dark", current).theme, "midnight");
  const recoveredReads = reads;
  h.tick();
  assert.equal(reads, recoveredReads, "a successful read still enables mtime caching");
});

test("P06 control: deletion and an invalid skin still fall back to manual theme", () => {
  let exists = true, mtime = 5, value = { theme: "midnight", source: "synthetic" }, current;
  const h = themeHarness({
    statSync() { if (!exists) throw Object.assign(new Error("missing"), { code: "ENOENT" }); return { mtimeMs: mtime }; },
    readFileSync: () => JSON.stringify(value),
  });
  h.context.watchExternal("synthetic", (result) => { current = result; });
  assert.equal(current.theme, "midnight");
  exists = false;
  h.tick();
  assert.equal(current, null);
  exists = true; mtime++; value = { theme: "unknown-synthetic-skin" };
  h.tick();
  assert.equal(current, null);
  assert.equal(h.context.resolveSkin("dark", current).theme, "dark");
});
