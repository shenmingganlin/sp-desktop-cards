// main.js — 主进程：窗口、托盘、设置、和 SP 的通信。

import { app, BrowserWindow, ipcMain, Menu, nativeImage, powerMonitor, safeStorage, screen, shell, Tray } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient, DEFAULT_BASE_URL, HINTS } from "./sp-client.js";
import { createPoller } from "./poller.js";
import { createSettingsStore } from "./settings.js";
import { isValidToken, readSpToken } from "./token.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const assets = path.join(here, "..", "..", "assets");
const SMOKE = process.env.SPW_SMOKE_DIR || "";

if (process.env.SPW_USER_DATA) app.setPath("userData", process.env.SPW_USER_DATA);
if (!app.requestSingleInstanceLock()) app.exit(0);

const COLLAPSED_HEIGHT = 44;
const DEFAULT_SIZE = { width: 320, height: 420 };
const MIN_WIDTH = 240;

let win = null;
let tray = null;
let settings;
let poller;
let lastView = null;
let lastError = null;
let autoToken = "";
let manualToken = ""; // 手填令牌的明文，只在内存里
let canEncrypt = false;
let quitting = false;

// ── 令牌：手填的优先，否则读 SP 数据目录里的。401 时清掉缓存重读。 ──
async function loadManualToken() {
  canEncrypt = await safeStorage.isAsyncEncryptionAvailable();
  const enc = settings.get().manualToken;
  if (!enc || !canEncrypt) return;
  try {
    manualToken = (await safeStorage.decryptStringAsync(Buffer.from(enc, "base64"))).result;
  } catch {
    // 换了系统账户或密钥失效：当作没填
    manualToken = "";
  }
}

async function getToken() {
  if (process.env.SPW_TOKEN) return process.env.SPW_TOKEN;
  if (manualToken) return manualToken;
  if (!autoToken) autoToken = await readSpToken();
  return autoToken;
}

function tokenSource() {
  if (process.env.SPW_TOKEN) return "env";
  if (manualToken) return "manual";
  return autoToken ? "auto" : "none";
}

// ── 发给渲染进程的状态 ──
function publicSettings() {
  const { manualToken: _hidden, ...rest } = settings.get();
  return { ...rest, tokenSource: tokenSource(), canEncrypt };
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function pushState() {
  send("state", { view: lastView, error: lastError, settings: publicSettings() });
}

// ── 窗口 ──
function visibleBounds(saved) {
  const area = screen.getPrimaryDisplay().workArea;
  const fallback = { ...DEFAULT_SIZE, x: area.x + area.width - DEFAULT_SIZE.width - 20, y: area.y + 20 };
  if (!saved) return fallback;
  // 显示器拔掉或分辨率变了以后，保存的位置可能已经在屏幕外。
  const onScreen = screen.getAllDisplays().some(({ workArea: a }) =>
    saved.x < a.x + a.width - 40 && saved.x + saved.width > a.x + 40 && saved.y >= a.y - 10 && saved.y < a.y + a.height - 40);
  return onScreen ? saved : { ...fallback, width: saved.width, height: saved.height };
}

// 一律用内容区尺寸：高分屏下无边框窗口的 getBounds 会比内容区大 1~2 像素，
// 存的时候用外框、恢复时又当内容区，窗口会每次启动长一点。
function applyCollapsed(collapsed) {
  const b = win.getContentBounds();
  // 最小/最大尺寸按外框算，要补上外框比内容区多出的那点。
  const extra = win.getBounds().height - b.height;
  if (collapsed) {
    win.setMinimumSize(MIN_WIDTH, COLLAPSED_HEIGHT + extra);
    win.setMaximumSize(10000, COLLAPSED_HEIGHT + extra);
    win.setContentBounds({ ...b, height: COLLAPSED_HEIGHT });
  } else {
    const height = settings.get().bounds?.height || DEFAULT_SIZE.height;
    win.setMaximumSize(10000, 10000);
    win.setMinimumSize(MIN_WIDTH, 160 + extra);
    win.setContentBounds({ ...b, height: Math.max(160, height) });
  }
  poller?.setIdle(collapsed || !win.isVisible());
}

function saveBounds() {
  if (!win || win.isDestroyed()) return;
  const b = win.getContentBounds();
  const s = settings.get();
  // 折叠时只记位置和宽度，展开高度保持原值。
  const height = s.collapsed ? s.bounds?.height || DEFAULT_SIZE.height : b.height;
  settings.update({ bounds: { ...b, height } });
}

function createWindow() {
  const s = settings.get();
  const bounds = visibleBounds(s.bounds);
  win = new BrowserWindow({
    ...bounds,
    useContentSize: true,
    frame: false,
    resizable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: s.alwaysOnTop,
    show: false,
    backgroundColor: "#1f1f1f",
    title: "SP 今日小窗",
    icon: path.join(assets, "icon.png"),
    webPreferences: {
      preload: path.join(here, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  if (s.alwaysOnTop) win.setAlwaysOnTop(true, "floating");
  win.setOpacity(s.opacity);
  win.setMenu(null);
  applyCollapsed(s.collapsed);

  win.webContents.on("will-navigate", (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.on("move", saveBounds);
  win.on("resize", saveBounds);
  win.on("close", (e) => {
    // 关闭按钮只是藏到托盘；退出走托盘菜单。
    if (!quitting) {
      e.preventDefault();
      hideWindow();
    }
  });
  win.once("ready-to-show", () => {
    if (!SMOKE) win.showInactive();
  });
  win.loadFile(path.join(here, "..", "renderer", "index.html"));
}

function showWindow() {
  if (!win) return;
  win.showInactive();
  poller.setIdle(settings.get().collapsed);
  poller.kick();
  rebuildTrayMenu();
}

function hideWindow() {
  if (!win) return;
  win.hide();
  poller.setIdle(true);
  rebuildTrayMenu();
}

// ── 托盘 ──
function rebuildTrayMenu() {
  if (!tray) return;
  const s = settings.get();
  const visible = !!win?.isVisible();
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: visible ? "隐藏小窗" : "显示小窗", click: () => (visible ? hideWindow() : showWindow()) },
    { label: "打开 Super Productivity", click: openSp },
    { type: "separator" },
    { label: "置顶", type: "checkbox", checked: s.alwaysOnTop, click: (i) => saveSettings({ alwaysOnTop: i.checked }) },
    { label: "开机启动", type: "checkbox", checked: s.openAtLogin, click: (i) => saveSettings({ openAtLogin: i.checked }) },
    { type: "separator" },
    { label: "退出", click: () => { quitting = true; app.quit(); } },
  ]));
}

function createTray() {
  tray = new Tray(nativeImage.createFromPath(path.join(assets, "tray.png")));
  tray.setToolTip("SP 今日小窗");
  tray.on("click", () => (win?.isVisible() ? hideWindow() : showWindow()));
  rebuildTrayMenu();
}

function openSp() {
  // SP 注册了 superproductivity:// 协议，today 会把主窗口调到前台并切到今日视图。
  shell.openExternal("superproductivity://today").catch(() => {});
}

// ── 设置 ──
function saveSettings(patch) {
  const before = settings.get();
  const s = settings.update(patch);
  if (win) {
    if (s.alwaysOnTop !== before.alwaysOnTop) win.setAlwaysOnTop(s.alwaysOnTop, "floating");
    if (s.opacity !== before.opacity) win.setOpacity(s.opacity);
    if (s.collapsed !== before.collapsed) applyCollapsed(s.collapsed);
  }
  if (s.openAtLogin !== before.openAtLogin && app.isPackaged) {
    app.setLoginItemSettings({ openAtLogin: s.openAtLogin });
  }
  if (s.dayStartHour !== before.dayStartHour || s.upcomingMinutes !== before.upcomingMinutes) poller.kick();
  rebuildTrayMenu();
  pushState();
}

async function setManualToken(value) {
  const token = typeof value === "string" ? value.trim() : "";
  if (token && !isValidToken(token)) return { ok: false, message: "令牌应为 32 位字母和数字。" };
  if (token && !canEncrypt) return { ok: false, message: "系统不支持加密保存，无法记住手填的令牌。" };
  const enc = token ? (await safeStorage.encryptStringAsync(token)).toString("base64") : "";
  settings.update({ manualToken: enc });
  manualToken = token;
  autoToken = "";
  poller.kick();
  pushState();
  return { ok: true };
}

// ── 渲染进程发来的操作。只认白名单里的名字，参数逐个检查。 ──
const isId = (v) => typeof v === "string" && v.length > 0 && v.length < 200;

async function runTaskAction(fn) {
  try {
    await fn();
    return { ok: true };
  } catch (error) {
    return { ok: false, code: error.code || "ERROR", message: error.message };
  } finally {
    poller.kick();
  }
}

const actions = {
  setDone: ({ id, isDone }) => (isId(id) && typeof isDone === "boolean" ? runTaskAction(() => client.setDone(id, isDone)) : null),
  start: ({ id }) => (isId(id) ? runTaskAction(() => client.start(id)) : null),
  stop: () => runTaskAction(() => client.stop()),
  refresh: () => { poller.kick(); return { ok: true }; },
  openSp: () => { openSp(); return { ok: true }; },
  hide: () => { hideWindow(); return { ok: true }; },
  toggleCollapsed: () => { saveSettings({ collapsed: !settings.get().collapsed }); return { ok: true }; },
  saveSettings: (patch) => {
    if (!patch || typeof patch !== "object") return null;
    const { manualToken: _ignored, bounds: _b, ...rest } = patch;
    saveSettings(rest);
    return { ok: true };
  },
  setToken: ({ token }) => setManualToken(token),
  rendered: () => { if (SMOKE) smokeStep(); return { ok: true }; },
};

ipcMain.handle("action", async (event, name, payload) => {
  if (!win || event.sender !== win.webContents) return { ok: false, message: "未知来源" };
  const fn = Object.hasOwn(actions, name) ? actions[name] : null;
  const result = fn ? await fn(payload ?? {}) : null;
  return result ?? { ok: false, message: "参数不对" };
});

ipcMain.on("ready", (event) => {
  if (win && event.sender === win.webContents) pushState();
});

// ── 自检截图：SPW_SMOKE_DIR 设了就截图后退出，给测试和发布前检查用。 ──
let smokeShots = 0;
let smokeBusy = false;
async function smokeStep() {
  if (smokeBusy || !lastView) return;
  smokeBusy = true;
  const fs = await import("node:fs");
  await new Promise((r) => setTimeout(r, 300));
  const name = settings.get().collapsed ? "collapsed" : "expanded";
  fs.writeFileSync(path.join(SMOKE, `${name}.png`), (await win.webContents.capturePage()).toPNG());
  smokeShots += 1;
  if (smokeShots === 1 && process.env.SPW_SMOKE_COLLAPSE) {
    saveSettings({ collapsed: true });
    smokeBusy = false;
    return;
  }
  settings.flush();
  quitting = true;
  app.quit();
}

// ── 启动 ──
const client = createClient({
  baseUrl: process.env.SPW_BASE_URL || DEFAULT_BASE_URL,
  getToken,
});

app.on("second-instance", () => showWindow());
app.on("before-quit", () => {
  quitting = true;
  settings?.flush();
});
app.on("window-all-closed", () => {});

app.whenReady().then(async () => {
  settings = createSettingsStore(app.getPath("userData"));
  await loadManualToken();
  poller = createPoller({
    client,
    getOptions: () => settings.get(),
    onView(view) {
      lastView = view;
      lastError = null;
      pushState();
    },
    onError(error) {
      if (error.code === "SP_UNAUTHORIZED") autoToken = "";
      lastError = { code: error.code || "ERROR", message: HINTS[error.code] || error.message };
      pushState();
    },
  });
  createWindow();
  if (!SMOKE) createTray();
  else win.showInactive();
  powerMonitor.on("resume", () => poller.kick());
  powerMonitor.on("unlock-screen", () => poller.kick());
  poller.start();
});
