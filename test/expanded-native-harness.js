// Synthetic native boundary only: no Electron, desktop hooks, SP, or settings files.
// Execute the complete cards manager plus the real main visibility/menu callbacks.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createPoller } from "../src/main/poller.js";
import { CARD_SIZE, CARD_TYPES, DEFAULTS, MODES } from "../src/main/settings.js";
import * as snap from "../src/main/snap.js";
import { backgroundOf } from "../src/main/theme.js";
import { windowAlive } from "../src/main/win.js";

const read = (file) => fs.readFileSync(new URL(`../src/main/${file}`, import.meta.url), "utf8");
const cardsSource = read("cards.js").replace(/^import .*;\r?\n/gm, "").replace(/^export /gm, "");
const mainSource = read("main.js");
function section(from, to) {
  const start = mainSource.indexOf(from);
  const end = mainSource.indexOf(to, start);
  assert.ok(start >= 0 && end > start, `Missing executable main section: ${from}`);
  return mainSource.slice(start, end);
}

class Clock {
  now = 0;
  nextId = 0;
  timers = new Map();
  add(fn, ms, repeat = false) {
    const id = ++this.nextId;
    this.timers.set(id, { fn, ms, at: this.now + ms, repeat });
    return id;
  }
  tick(ms) {
    const end = this.now + ms;
    for (let n = 0; n < 10000; n++) {
      let next;
      for (const pair of this.timers) {
        if (pair[1].at <= end && (!next || pair[1].at < next[1].at)) next = pair;
      }
      if (!next) { this.now = end; return; }
      const [id, timer] = next;
      this.now = timer.at;
      if (timer.repeat) timer.at += timer.ms;
      else this.timers.delete(id);
      timer.fn();
    }
    throw new Error("Synthetic clock did not settle");
  }
  globals() {
    const clock = this;
    return {
      Date: class extends Date { static now() { return clock.now; } },
      setInterval: (fn, ms) => this.add(fn, ms, true),
      clearInterval: (id) => this.timers.delete(id),
      setTimeout: (fn, ms) => this.add(fn, ms),
      clearTimeout: (id) => this.timers.delete(id),
    };
  }
}

function windows() {
  const all = [];
  return class BrowserWindow extends EventEmitter {
    constructor(options) {
      super();
      all.push(this);
      this.bounds = Object.fromEntries(["x", "y", "width", "height"].map((k) => [k, options[k]]));
      this.visible = options.show;
      this.dead = false;
      this.opacity = 1;
      this.minimum = [0, 0];
      this.maximum = [10000, 10000];
      this.webContents = Object.assign(new EventEmitter(), {
        setWindowOpenHandler() {}, isLoading: () => false, send() {}, sendInputEvent() {},
      });
    }
    static get all() { return all; }
    native() { if (this.dead) throw new Error("Object has been destroyed"); }
    isDestroyed() { return this.dead; }
    isVisible() { this.native(); return this.visible; }
    isFocused() { this.native(); return false; }
    setMenu() { this.native(); }
    getBounds() { this.native(); return { ...this.bounds }; }
    setBounds(bounds) {
      this.native();
      this.bounds = {
        ...bounds,
        width: Math.max(this.minimum[0], Math.min(this.maximum[0], bounds.width)),
        height: Math.max(this.minimum[1], Math.min(this.maximum[1], bounds.height)),
      };
    }
    setMinimumSize(w, h) { this.native(); this.minimum = [w, h]; }
    setMaximumSize(w, h) { this.native(); this.maximum = [w, h]; }
    setAlwaysOnTop() { this.native(); }
    setFocusable() { this.native(); }
    setIgnoreMouseEvents() { this.native(); }
    setOpacity(value) { this.native(); this.opacity = value; }
    getOpacity() { this.native(); return this.opacity; }
    showInactive() { this.native(); this.visible = true; }
    hide() { this.native(); this.visible = false; }
    loadFile() { this.native(); }
    destroy() {
      if (this.dead) return;
      this.dead = true;
      this.visible = false;
      this.emit("closed");
    }
  };
}

export const PRIMARY = { x: 0, y: 0, width: 1280, height: 720 };
export const POSITION = { x: 100, y: 100, width: 320, height: 380 };

export function nativeHarness(patches = { today: { visible: true, bounds: POSITION } }, options = {}) {
  const clock = new Clock();
  const BrowserWindow = windows();
  const screen = new EventEmitter();
  let areas = options.areas || [PRIMARY];
  let cursor = { x: 0, y: 0 };
  screen.getAllDisplays = () => areas.map((workArea) => ({ workArea }));
  screen.getPrimaryDisplay = () => ({ workArea: areas[0] });
  screen.getCursorScreenPoint = () => cursor;
  const data = structuredClone(DEFAULTS);
  data.mode = "normal";
  for (const type of CARD_TYPES) data.cards[type] = { ...data.cards[type], visible: false, ...patches[type] };
  const settings = {
    get: () => structuredClone(data),
    updateCard: (type, patch) => { Object.assign(data.cards[type], structuredClone(patch)); },
    update: (patch) => Object.assign(data, structuredClone(patch)),
  };
  const desktop = {
    available: () => false, detach() {}, attach() {}, toDesktopLayer() {}, atDesktopLayer: () => true,
    keepClickable() {}, primaryButtonDown: () => null, altDown: () => false,
  };
  const context = vm.createContext({
    ...snap, CARD_SIZE, CARD_TYPES, windowAlive, backgroundOf, BrowserWindow, screen, desktop, ...clock.globals(),
  });
  vm.runInContext(`${cardsSource}\nglobalThis.makeCards = createCards; globalThis.cardTitles = CARD_TITLE;`, context);
  const changes = [];
  let main;
  const cards = context.makeCards({
    settings, preload: "", page: "synthetic-card.html", icon: "",
    onChange() { changes.push(cards.isShown()); main.visibilityChanged(); },
  });
  const schedules = [];
  const client = Object.fromEntries(["current", "focus", "todayTasks", "allTasks", "tags", "projects", "repeatCfgs"]
    .map((key) => [key, async () => ["current", "focus"].includes(key) ? null : []]));
  const poller = createPoller({
    client, now: () => clock.now,
    onData: (raw) => main.handlers.onData(raw), onError: (error) => { throw error; },
    setTimer(fn, ms) { const timer = { fn, ms }; schedules.push(timer); return timer; },
    clearTimer() {},
  });
  class Tray extends EventEmitter {
    setContextMenu(menu) { this.menu = menu; }
    setToolTip() {}
  }
  main = vm.createContext({
    cards, settings, poller, tray: null, Tray, Menu: { buildFromTemplate: (items) => items },
    path, assets: "synthetic-assets", nativeImage: { createFromPath: () => ({}) },
    CARD_TYPES, CARD_TITLE: context.cardTitles, MODES, MODE_LABEL: {}, desktop,
    hotkey: { acceleratorOf: () => null }, app: { quit() {} },
    openSp() {}, openSettings() {}, openTour() {}, checkUpdate() {}, saveSettings() {}, setClickThrough() {},
    publicSettings: () => settings.get(), pomoView: () => ({ status: "idle" }),
    raw: null, lastError: null, ui: {}, settingsWin: null, windowAlive,
    listSources: () => ({ projects: [], tags: [] }), cardView: () => ({}), buildView: () => ({}),
    OK: { ok: true }, HINTS: {}, autoToken: "", ipcMain: new EventEmitter(),
  });
  // The manager invokes the actual main callback; tests never manually repair idle/menu state.
  vm.runInContext(
    section("function sharedMenu()", "function cardMenu(type)") +
    section("function rebuildTrayMenu()", "function openSp()") +
    section("function pushState()", "// ── 番茄钟") +
    section("const settingsActions =", "const appearanceActions =") +
    `const hooks = {${section("    onChange() {", "    onGroupDrag(type)")}};\n` +
    `globalThis.handlers = {${section("    onData(data) {", "  });\n  cards = createCards")}};\n` +
    section('ipcMain.on("ready",', 'ipcMain.on("drag-start",') +
    "globalThis.visibilityChanged = hooks.onChange; globalThis.actions = settingsActions; globalThis.startTray = createTray;",
    main,
  );
  return {
    cards, settings, data, clock, screen, changes, poller, schedules,
    setAreas(value) { areas = value; },
    setCursor(value) { cursor = value; },
    ready() {
      for (const w of BrowserWindow.all) {
        if (!w.dead && !w.readied) { w.readied = true; w.emit("ready-to-show"); }
      }
    },
    start() { cards.start(); main.startTray(); this.ready(); clock.tick(160); },
    set(type, visible) { return main.actions.setCardVisible({ type, visible }); },
    trayClick() { main.tray.emit("click"); },
    check(type, checked) {
      const index = CARD_TYPES.indexOf(type);
      main.tray.menu[2].submenu[index].click({ checked });
    },
    label: () => main.tray.menu[0].label,
    rendererReady: () => main.ipcMain.emit("ready"),
    stop() { cards.quit(); poller.stop(); clock.timers.clear(); },
  };
}

export function intersection(r, area) {
  return Math.max(0, Math.min(r.x + r.width, area.x + area.width) - Math.max(r.x, area.x)) *
    Math.max(0, Math.min(r.y + r.height, area.y + area.height) - Math.max(r.y, area.y));
}
