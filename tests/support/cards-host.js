import { EventEmitter } from "node:events";
import vm from "node:vm";
import { Clock } from "./clock.js";
import { importMain, readMainSource } from "./source.js";

export async function cardsHost() {
  const clock = new Clock();
  const created = [];
  const data = {
    mode: "normal", opacity: 0.95, clickThrough: true,
    cards: { focus: { visible: true, bounds: { x: 100, y: 100, width: 320, height: 132 }, collapsed: false } },
  };
  const settings = {
    get: () => structuredClone(data),
    updateCard(type, patch) { Object.assign(data.cards[type], patch); },
  };

  class BrowserWindow extends EventEmitter {
    constructor(options) {
      super();
      this.bounds = { x: options.x, y: options.y, width: options.width, height: options.height };
      this.visible = false;
      this.opacity = 0;
      this.destroyed = false;
      this.webContents = new EventEmitter();
      this.webContents.setWindowOpenHandler = () => {};
      this.webContents.isLoading = () => false;
      this.webContents.send = () => {};
      created.push(this);
    }
    isDestroyed() { return this.destroyed; }
    isVisible() { return this.visible; }
    getBounds() { return { ...this.bounds }; }
    setBounds(bounds) { this.bounds = { ...bounds }; }
    setMenu() {}
    setOpacity(value) { this.opacity = value; }
    getOpacity() { return this.opacity; }
    setMinimumSize() {}
    setMaximumSize() {}
    setAlwaysOnTop() {}
    setFocusable() {}
    setIgnoreMouseEvents(value) { this.clickThrough = value; }
    loadFile() {}
    showInactive() { this.visible = true; }
    hide() { this.visible = false; }
    destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      this.visible = false;
      this.emit("closed");
    }
  }

  const screen = new EventEmitter();
  screen.getAllDisplays = () => [{ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }];
  screen.getPrimaryDisplay = () => screen.getAllDisplays()[0];
  const snap = await importMain("snap.js");
  const { windowAlive } = await importMain("win.js");
  const desktop = { available: () => false, detach() {}, primaryButtonDown: () => null, altDown: () => false };
  const sandbox = {
    BrowserWindow, screen, desktop,
    CARD_TYPES: ["focus"], CARD_SIZE: { focus: { width: 320, height: 132 } },
    ...snap, windowAlive, backgroundOf: () => "#000000",
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    setInterval: clock.setInterval, clearInterval: clock.clearInterval,
    Date: class extends Date { static now() { return clock.now; } },
  };
  // Only the host imports are replaced. The actual createCards implementation runs unchanged.
  const source = readMainSource("cards.js").replace(/^import .*;\r?$/gm, "").replaceAll("export ", "");
  vm.runInNewContext(`${source}\nthis.createCards = createCards;`, sandbox, { filename: "cards.js" });
  const cards = sandbox.createCards({ settings, page: "mock-card.html", preload: "mock-preload", icon: "mock-icon" });
  cards.start();
  const ready = (window) => window.emit("ready-to-show");
  const crash = (window, reason = "crashed") => window.webContents.emit("render-process-gone", {}, { reason, exitCode: 1 });
  return { cards, created, clock, data, ready, crash, screen, desktop };
}
