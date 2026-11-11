// Scoped persistence tests: real source, synthetic I/O boundaries, no Electron/SP process.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import * as hotkey from "../src/main/hotkey.js";
import * as pomo from "../src/main/pomodoro.js";
import * as theme from "../src/main/theme.js";

export const source = (name) => fs.readFileSync(new URL(`../src/main/${name}`, import.meta.url), "utf8");
export const main = source("main.js");
export function mainSection(from, to) {
  const start = main.indexOf(from), end = main.indexOf(to, start);
  assert.ok(start >= 0 && end > start, `Missing executable main section: ${from}`);
  return main.slice(start, end);
}
export function loadModule(name, bindings) {
  const context = vm.createContext(bindings);
  vm.runInContext(source(name).replace(/^import .*;\r?$/gm, "").replace(/^export /gm, ""), context, { filename: name });
  return context;
}
export function fakeClock() {
  let now = 0, next = 0;
  const timers = new Map();
  return {
    setTimeout(fn, ms) { const id = ++next; timers.set(id, { at: now + ms, fn }); return id; },
    clearTimeout(id) { timers.delete(id); },
    tick(ms) {
      now += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at <= now) { timers.delete(id); timer.fn(); }
      }
    },
    get pending() { return timers.size; },
  };
}
export function settingsFactory({ fsImpl = fs, clock = fakeClock() } = {}) {
  return loadModule("settings.js", {
    fs: fsImpl, path, structuredClone, defaultKey: hotkey.defaultKey, normalizeKey: hotkey.normalizeKey,
    DEFAULT_POMODORO: pomo.DEFAULT_POMODORO, normalizeSkin: theme.normalizeSkin,
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
  }).createSettingsStore;
}
export function tempDirectory(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "expanded-persistence-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
export const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
export const settle = () => new Promise(setImmediate);
