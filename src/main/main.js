// main.js — 主进程：卡片窗口、托盘、设置窗口、番茄钟、和 SP 的通信。

import { app, BrowserWindow, ipcMain, Menu, nativeImage, nativeTheme, Notification, powerMonitor, safeStorage, shell, Tray } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { addDays, addMonths, buildMonth, buildPlanner, buildSchedule } from "./calendar.js";
import { CARD_TITLE, createCards } from "./cards.js";
import * as desktop from "./desktop.js";
import { buildView, isDay, localDay, resolveToday } from "./model.js";
import * as pomo from "./pomodoro.js";
import { createPoller } from "./poller.js";
import { taskFields } from "./quickadd.js";
import { CARD_TYPES, createSettingsStore, MODES } from "./settings.js";
import { createClient, DEFAULT_BASE_URL, HINTS } from "./sp-client.js";
import { isValidToken, readSpToken } from "./token.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const assets = path.join(here, "..", "..", "assets");
const renderer = path.join(here, "..", "renderer");
const preload = path.join(here, "preload.cjs");
const icon = path.join(assets, "icon.png");
const SMOKE = process.env.SPW_SMOKE_DIR || "";

if (process.env.SPW_USER_DATA) app.setPath("userData", process.env.SPW_USER_DATA);
if (!app.requestSingleInstanceLock()) app.exit(0);
// Windows 上不设这个，系统通知显示不出来
app.setAppUserModelId("io.github.shenmingganlin.sp-today-widget");

const MODE_LABEL = { top: "置顶", normal: "普通窗口", desktop: "嵌入桌面" };
const OK = { ok: true };

let settings;
let poller;
let cards;
let tray = null;
let settingsWin = null;
let raw = null; // SP 最近一次的原始数据
let lastError = null;
let autoToken = "";
let manualToken = ""; // 手填令牌的明文，只在内存里
let canEncrypt = false;
let pomoState;
let pomoTimer = null;
// 日程和月历翻到了哪天、哪个月。只在内存里，null 表示跟着今天走。
const ui = { scheduleDay: null, month: null, selected: null };

const currentDay = () => {
  const h = settings.get().dayStartHour;
  return raw ? resolveToday(raw.todayTasks || [], Date.now(), h) : localDay(Date.now(), h);
};
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
  return OK;
}

const client = createClient({ baseUrl: process.env.SPW_BASE_URL || DEFAULT_BASE_URL, getToken });

// ── 各卡片的视图 ──
// 规划、日程、月历只在列表换过、设置或翻页变了时重算；快轮询（2 秒）只换当前任务和番茄钟。
const memo = new Map();
function cached(type, key, build) {
  const hit = memo.get(type);
  if (hit && hit.key === key) return hit.view;
  const view = build();
  memo.set(type, { key, view });
  return view;
}

function cardView(type, todayView) {
  if (type === "focus" || type === "today") return todayView();
  const s = settings.get();
  const key = JSON.stringify([raw.listsAt, raw.current?.id ?? null, s.dayStartHour, currentDay(), s.showDone, type === "planner" && s.plannerDays,
    type === "schedule" && [ui.scheduleDay, s.scheduleStartHour, s.scheduleEndHour], type === "month" && [ui.month, ui.selected]]);
  if (type === "planner") return cached(type, key, () => buildPlanner(raw, { dayStartHour: s.dayStartHour, days: s.plannerDays }));
  if (type === "schedule") {
    return cached(type, key, () => buildSchedule(raw, {
      dayStartHour: s.dayStartHour, day: ui.scheduleDay, startHour: s.scheduleStartHour, endHour: s.scheduleEndHour,
    }));
  }
  return cached(type, key, () => buildMonth(raw, { dayStartHour: s.dayStartHour, month: ui.month, selected: ui.selected }));
}

function pomoView() {
  const s = settings.get();
  const state = pomo.rollDay(pomoState, currentDay());
  const task = state.taskId && raw ? (raw.allTasks || []).find((t) => t.id === state.taskId) : null;
  return { ...state, label: pomo.PHASE_LABEL[state.phase], taskTitle: task?.title ?? null, cfg: s.pomodoro };
}

function publicSettings() {
  const { manualToken: _hidden, ...rest } = settings.get();
  return { ...rest, tokenSource: tokenSource(), canEncrypt, desktopAvailable: desktop.available(), effectiveMode: cards?.effectiveMode() };
}

/** 把最新状态推给所有卡片和设置窗口。卡片按签名决定要不要重画，推多了不费事。 */
function pushState() {
  if (!cards) return;
  const s = publicSettings();
  let today;
  const todayView = () => (today ??= buildView(raw, { dayStartHour: s.dayStartHour, upcomingMinutes: s.upcomingMinutes }));
  const common = {
    error: lastError,
    settings: s,
    pomodoro: pomoView(),
    snapshotAt: raw?.snapshotAt ?? null,
    ticking: raw?.ticking ?? null,
  };
  for (const type of cards.types()) {
    const view = raw ? cardView(type, todayView) : null;
    cards.send(type, "state", { ...common, card: type, view, collapsed: s.cards[type].collapsed, nav: { ...ui } });
  }
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.webContents.send("state", { ...common, card: null, projects: (raw?.projects || []).map((p) => ({ id: p.id, title: p.title })) });
  }
}

// ── 番茄钟 ──
// 状态机在 pomodoro.js；这里负责定时、执行副作用（让 SP 计时、发通知）、保存今天的番茄数。
function applyPomo({ state, effects }) {
  pomoState = state;
  settings.update({ pomodoroStats: { day: state.day, doneToday: state.doneToday, streak: state.streak } });
  clearTimeout(pomoTimer);
  pomoTimer = state.status === "running" ? setTimeout(pomoTick, Math.max(0, state.endsAt - Date.now()) + 50) : null;
  for (const effect of effects) runEffect(effect);
  pushState();
}

function pomoTick() {
  applyPomo(pomo.tick(pomo.rollDay(pomoState, currentDay()), settings.get().pomodoro, Date.now()));
}

async function runEffect(effect) {
  try {
    if (effect.type === "notify") return notify(effect.title, effect.body);
    if (effect.type === "track") await client.start(effect.taskId);
    // 只在 SP 还在计这个任务时才停：用户可能已经换了别的任务
    if (effect.type === "untrack" && (await client.current())?.id === effect.taskId) await client.stop();
    poller.kick();
  } catch (error) {
    lastError = { code: error.code || "ERROR", message: HINTS[error.code] || error.message };
    pushState();
  }
}

function notify(title, body) {
  if (SMOKE || !Notification.isSupported()) return;
  new Notification({ title, body, icon, silent: false }).show();
}

const pomoActions = {
  pomoStart: ({ taskId }) => {
    // 没指定任务时用 SP 当前在计时的任务
    const id = isId(taskId) ? taskId : raw?.current?.id ?? null;
    applyPomo(pomo.start(pomo.rollDay(pomoState, currentDay()), settings.get().pomodoro, Date.now(), id));
    return OK;
  },
  pomoPause: () => (applyPomo(pomo.pause(pomoState, settings.get().pomodoro, Date.now())), OK),
  pomoResume: () => (applyPomo(pomo.resume(pomoState, settings.get().pomodoro, Date.now())), OK),
  pomoSkip: () => (applyPomo(pomo.skip(pomoState, settings.get().pomodoro, Date.now())), OK),
  pomoStop: () => (applyPomo(pomo.stop(pomoState, settings.get().pomodoro)), OK),
};

// ── 菜单 ──
function sharedMenu() {
  const s = settings.get();
  const modes = MODES.filter((m) => m !== "desktop" || desktop.available());
  return [
    {
      label: "卡片",
      submenu: CARD_TYPES.map((t) => ({ label: CARD_TITLE[t], type: "checkbox", checked: s.cards[t].visible, click: (i) => cards.setVisible(t, i.checked) })),
    },
    {
      label: "显示方式",
      submenu: modes.map((m) => ({ label: MODE_LABEL[m], type: "radio", checked: cards.effectiveMode() === m, click: () => saveSettings({ mode: m }) })),
    },
    { label: "锁定位置", type: "checkbox", checked: s.locked, click: (i) => saveSettings({ locked: i.checked }) },
    { label: "重新排列", click: () => cards.resetLayout() },
    { type: "separator" },
    { label: "打开 Super Productivity", click: openSp },
    { label: "设置…", click: openSettings },
  ];
}

function cardMenu(type) {
  return Menu.buildFromTemplate([
    ...sharedMenu(),
    { type: "separator" },
    { label: `隐藏「${CARD_TITLE[type]}」`, click: () => cards.setVisible(type, false) },
    { label: "退出", click: () => app.quit() },
  ]);
}

function rebuildTrayMenu() {
  if (!tray) return;
  const shown = cards.isShown();
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: shown ? "隐藏全部卡片" : "显示全部卡片", click: () => (shown ? cards.hideAll() : cards.showAll()) },
    { type: "separator" },
    ...sharedMenu(),
    { label: "开机启动", type: "checkbox", checked: settings.get().openAtLogin, click: (i) => saveSettings({ openAtLogin: i.checked }) },
    { type: "separator" },
    { label: "退出", click: () => app.quit() },
  ]));
}

function createTray() {
  tray = new Tray(nativeImage.createFromPath(path.join(assets, "tray.png")));
  tray.setToolTip("SP 今日小窗");
  tray.on("click", () => (cards.isShown() ? cards.hideAll() : cards.showAll()));
  rebuildTrayMenu();
}

function openSp() {
  // SP 注册了 superproductivity:// 协议，today 会把主窗口调到前台并切到今日视图。
  shell.openExternal("superproductivity://today").catch(() => {});
}

function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.show();
    settingsWin.focus();
    return;
  }
  settingsWin = new BrowserWindow({
    width: 440,
    height: 660,
    minWidth: 360,
    minHeight: 400,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: "#1f1f1f",
    title: "SP 今日小窗 · 设置",
    icon,
    webPreferences: { preload, contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false },
  });
  settingsWin.setMenu(null);
  settingsWin.webContents.on("will-navigate", (e) => e.preventDefault());
  settingsWin.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  settingsWin.once("ready-to-show", () => settingsWin.show());
  settingsWin.on("closed", () => (settingsWin = null));
  settingsWin.loadFile(path.join(renderer, "settings.html"));
}

// ── 设置 ──
function saveSettings(patch) {
  const before = settings.get();
  const s = settings.update(patch);
  if (s.mode !== before.mode) cards.applyMode();
  if (s.locked !== before.locked) cards.setLocked(s.locked);
  if (s.opacity !== before.opacity) cards.setOpacity(s.opacity);
  if (s.openAtLogin !== before.openAtLogin && app.isPackaged) app.setLoginItemSettings({ openAtLogin: s.openAtLogin });
  rebuildTrayMenu();
  pushState();
}

// ── 页面发来的操作。只认白名单里的名字，参数逐个检查。 ──
const isId = (v) => typeof v === "string" && v.length > 0 && v.length < 200;
// 设置窗口能改的字段；卡片位置、令牌、番茄统计走各自的通道
const EDITABLE = ["mode", "locked", "opacity", "openAtLogin", "upcomingMinutes", "dayStartHour", "showDone", "plannerDays",
  "scheduleStartHour", "scheduleEndHour", "quickAddProjectId", "pomodoro"];
const pick = (obj, keys) => Object.fromEntries(keys.filter((k) => Object.hasOwn(obj, k)).map((k) => [k, obj[k]]));

async function runTaskAction(fn) {
  try {
    const data = await fn();
    return { ok: true, data };
  } catch (error) {
    return { ok: false, code: error.code || "ERROR", message: HINTS[error.code] || error.message };
  } finally {
    poller.kick();
  }
}

function createTask(input) {
  const s = settings.get();
  const projectIds = raw?.projects?.length ? raw.projects.map((p) => p.id) : null;
  const result = taskFields(input, { projectId: s.quickAddProjectId, projectIds });
  if (!result.ok) return result;
  return runTaskAction(async () => {
    const t = await client.createTask(result.fields);
    return { id: t?.id, title: t?.title ?? result.fields.title };
  });
}

/** 日程翻天、月历翻月：offset 是 -1/1，0 回到今天。 */
function navigate(key, offset) {
  if (key === "schedule") ui.scheduleDay = offset ? addDays(ui.scheduleDay || currentDay(), offset) : null;
  if (key === "month") {
    ui.month = offset ? addMonths(ui.month || currentDay().slice(0, 7), offset) : null;
    if (!offset) ui.selected = null;
  }
  pushState();
  return OK;
}

const cardActions = {
  setDone: ({ id, isDone }) => (isId(id) && typeof isDone === "boolean" ? runTaskAction(() => client.setDone(id, isDone)) : null),
  start: ({ id }) => (isId(id) ? runTaskAction(() => client.start(id)) : null),
  stop: () => runTaskAction(() => client.stop()),
  createTask: (payload) => createTask(payload),
  refresh: () => (poller.kick(), OK),
  openSp: () => (openSp(), OK),
  openSettings: () => (openSettings(), OK),
  menu: (_p, type) => (cards.popup(type, cardMenu(type)), OK),
  toggleCollapsed: (_p, type) => (cards.setCollapsed(type, !settings.get().cards[type].collapsed), pushState(), OK),
  hide: (_p, type) => (cards.setVisible(type, false), OK),
  focusInput: (_p, type) => (cards.requestFocus(type), OK),
  setShowDone: ({ value }) => (typeof value === "boolean" ? (saveSettings({ showDone: value }), OK) : null),
  navigate: ({ key, offset }) => (["schedule", "month"].includes(key) && [-1, 0, 1].includes(offset) ? navigate(key, offset) : null),
  selectDay: ({ day }) => {
    if (!isDay(day)) return null;
    ui.selected = day;
    ui.month = day.slice(0, 7);
    pushState();
    return OK;
  },
  rendered: (_p, type) => (SMOKE && smokeStep(type), OK),
  ...pomoActions,
};

const settingsActions = {
  saveSettings: (patch) => (patch && typeof patch === "object" ? (saveSettings(pick(patch, EDITABLE)), OK) : null),
  setCardVisible: ({ type, visible }) => (CARD_TYPES.includes(type) && typeof visible === "boolean" ? (cards.setVisible(type, visible), pushState(), OK) : null),
  resetLayout: () => (cards.resetLayout(), OK),
  setToken: ({ token }) => setManualToken(token),
  refresh: () => (poller.kick(), OK),
};

ipcMain.handle("action", async (event, name, payload) => {
  const type = cards?.typeOf(event.sender);
  const fromSettings = settingsWin && !settingsWin.isDestroyed() && event.sender === settingsWin.webContents;
  const table = type ? cardActions : fromSettings ? settingsActions : null;
  if (!table) return { ok: false, message: "未知来源" };
  const fn = Object.hasOwn(table, name) ? table[name] : null;
  const result = fn ? await fn(payload && typeof payload === "object" ? payload : {}, type) : null;
  return result ?? { ok: false, message: "参数不对" };
});

ipcMain.on("ready", () => pushState());
ipcMain.on("drag-start", (event, alone) => {
  const type = cards?.typeOf(event.sender);
  if (type) cards.dragStart(type, !!alone);
});
ipcMain.on("drag-end", (event) => {
  if (cards?.typeOf(event.sender)) cards.dragEnd();
});

// ── 自检截图：SPW_SMOKE_DIR 设了就等所有卡片画好，逐张截图后退出，给测试和发布前检查用。 ──
const smokeRendered = new Set();
let smokeDone = false;
async function smokeStep(type) {
  smokeRendered.add(type);
  if (smokeDone || !raw || !cards.types().every((t) => smokeRendered.has(t))) return;
  const fs = await import("node:fs");
  await new Promise((r) => setTimeout(r, 600));
  if (smokeDone) return;
  smokeDone = true;
  const layout = {};
  for (const type of cards.types()) {
    const w = cards.window(type);
    layout[type] = cards.bounds(type);
    fs.writeFileSync(path.join(SMOKE, `${type}.png`), (await w.webContents.capturePage()).toPNG());
  }
  fs.writeFileSync(path.join(SMOKE, "layout.json"), JSON.stringify(layout, null, 2));
  if (process.env.SPW_SMOKE_SETTINGS) {
    openSettings();
    await new Promise((r) => setTimeout(r, 1500));
    fs.writeFileSync(path.join(SMOKE, "settings.png"), (await settingsWin.webContents.capturePage()).toPNG());
  }
  settings.flush();
  app.quit();
}

// ── 启动 ──
app.on("second-instance", () => cards?.showAll());
app.on("before-quit", () => {
  cards?.quit();
  settings?.flush();
});
app.on("window-all-closed", () => {});

app.whenReady().then(async () => {
  nativeTheme.themeSource = "dark";
  settings = createSettingsStore(app.getPath("userData"));
  await loadManualToken();
  pomoState = pomo.createState(settings.get().pomodoroStats);
  poller = createPoller({
    client,
    onData(data) {
      raw = data;
      lastError = null;
      pushState();
    },
    onError(error) {
      if (error.code === "SP_UNAUTHORIZED") autoToken = "";
      lastError = { code: error.code || "ERROR", message: HINTS[error.code] || error.message };
      pushState();
    },
  });
  cards = createCards({
    settings,
    preload,
    page: path.join(renderer, "card.html"),
    icon,
    onChange() {
      poller.setIdle(!cards.isShown());
      rebuildTrayMenu();
    },
  });
  cards.start();
  if (!SMOKE) createTray();
  powerMonitor.on("resume", () => {
    poller.kick();
    if (pomoState.status === "running") pomoTick();
  });
  powerMonitor.on("unlock-screen", () => poller.kick());
  poller.start();
});