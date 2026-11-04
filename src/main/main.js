// main.js — 主进程：卡片窗口、托盘、设置窗口、番茄钟、和 SP 的通信。

import { app, BrowserWindow, dialog, globalShortcut, ipcMain, Menu, nativeImage, nativeTheme, Notification, powerMonitor, safeStorage, screen, shell, Tray } from "electron";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildBreakdown, DIMENSIONS } from "./breakdown.js";
import { addDays, addMonths, buildMonth, buildPlanner, buildSchedule } from "./calendar.js";
import { CARD_TITLE, createCards } from "./cards.js";
import * as desktop from "./desktop.js";
import { buildHeatmap } from "./heatmap.js";
import * as hotkey from "./hotkey.js";
import { buildList, listSources } from "./list.js";
import { buildView, isDay, localDay, resolveToday } from "./model.js";
import * as pomo from "./pomodoro.js";
import { createPoller } from "./poller.js";
import { taskFields } from "./quickadd.js";
import { CARD_TYPES, createSettingsStore, MODES } from "./settings.js";
import { createClient, DEFAULT_BASE_URL, HINTS } from "./sp-client.js";
import { buildStats } from "./stats.js";
import { buildTriage } from "./triage.js";
import * as theme from "./theme.js";
import { isValidToken, readSpToken } from "./token.js";
import * as updateCheck from "./update.js";
import { adoptUserData } from "./usermigrate.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const assets = path.join(here, "..", "..", "assets");
const renderer = path.join(here, "..", "renderer");
const preload = path.join(here, "preload.cjs");
const icon = path.join(assets, "icon.png");
const SMOKE = process.env.SPW_SMOKE_DIR || "";

// SPW_HOME 是自检用的：把「当前用户目录」整个指到临时目录，搬家逻辑照常走（只换目录，不换行为）
if (process.env.SPW_HOME) app.setPath("userData", path.join(process.env.SPW_HOME, "SP 桌面卡片"));
if (process.env.SPW_USER_DATA) app.setPath("userData", process.env.SPW_USER_DATA);

// 0.2.2 及以前叫「SP 今日小窗」，设置在同名目录里。第一次以新名字启动时搬过来，见 usermigrate.js。
// SPW_USER_DATA 是自检用的独立目录，旁边没有老目录，不用搬，也别去碰真正的设置。
if (!process.env.SPW_USER_DATA) adoptUserData(app.getPath("userData"));
if (!app.requestSingleInstanceLock()) app.exit(0);
// Windows 上不设这个，系统通知显示不出来
app.setAppUserModelId("io.github.shenmingganlin.sp-desktop-cards");

const MODE_LABEL = { top: "置顶", normal: "普通窗口", desktop: "嵌入桌面" };
const OK = { ok: true };

let settings;
let poller;
let cards;
let tray = null;
let settingsWin = null;
let appearanceWin = null;
let hotkeyWin = null;
let toastWin = null;
let toastTimer = null;
let toastPayload = null;
let hotkeyRegistered = ""; // 当前注册成功的 accelerator，空表示没注册上
let hotkeyNotice = ""; // 注册不上时的原因，显示在设置里
let raw = null; // SP 最近一次的原始数据
let lastError = null;
let autoToken = "";
let manualToken = ""; // 手填令牌的明文，只在内存里
let canEncrypt = false;
let pomoState;
let pomoTimer = null;
// 日程和月历翻到了哪天、哪个月。只在内存里，null 表示跟着今天走。
const ui = { scheduleDay: null, month: null, selected: null };

// ── 皮肤 ──
// 外部主题文件（theme.json）存在且合法时压过设置里手选的皮肤；小窗自己只读不写。
let externalTheme = null;
let themeStopWatcher = null;
const themeFile = () => path.join(app.getPath("userData"), theme.EXTERNAL_FILE);
const currentTheme = () => theme.resolveSkin(settings.get().theme, externalTheme);

/** 把当前皮肤应用到所有窗口：原生控件深浅、窗口底色、还开着的设置/教程/更新窗口。 */
function applyTheme() {
  if (!settings) return;
  const t = currentTheme();
  const color = theme.backgroundOf(t.theme);
  nativeTheme.themeSource = t.theme === "hana" ? "light" : "dark";
  cards?.setBackground(color);
  for (const win of [settingsWin, appearanceWin, hotkeyWin, tourWin, updateWin]) {
    if (!win || win.isDestroyed()) continue;
    win.setBackgroundColor(color);
    win.webContents.send("event", { type: "theme", theme: t.theme });
  }
}

// ── 不挡点击 ──
// 开关在设置里（clickThrough），切换有三个入口：全局快捷键、托盘菜单、卡片 ⋯ 菜单。
// 桌面模式下开了之后卡片就点不到了，所以后两个入口必须一直在，是主要退路。

/** 切换并保存。on 省略就取反。 */
function setClickThrough(on) {
  const next = typeof on === "boolean" ? on : !settings.get().clickThrough;
  saveSettings({ clickThrough: next });
  showToast(next ? "不挡点击已开启" : "不挡点击已关闭", next);
  return next;
}

/**
 * 桌面上浮一条小提示，过一会儿自己消失。
 * 窗口透明、不接鼠标、不抢焦点，所以就算正好压在别的东西上也不碍事。
 */
function showToast(text, on, ms = 1600) {
  if (SMOKE) return; // 自检时截图会被它挡住
  const payload = { text, on: !!on, ms, theme: currentTheme().theme };
  toastPayload = payload;
  const width = 360;
  const height = 64;
  // 光标在哪块屏就浮在哪块屏的底部中间
  const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  const bounds = {
    x: Math.round(area.x + (area.width - width) / 2),
    y: Math.round(area.y + area.height - height - 48),
    width,
    height,
  };
  if (!toastWin || toastWin.isDestroyed()) {
    toastWin = new BrowserWindow({
      ...bounds,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      show: false,
      focusable: false, // 不抢焦点：按快捷键时用户可能正在别的程序里打字
      hasShadow: false,
      alwaysOnTop: true,
      backgroundColor: "#00000000",
      title: "SP 桌面卡片 · 提示",
      webPreferences: { preload, contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false },
    });
    toastWin.setMenu(null);
    // 提示条自己也不挡点击
    toastWin.setIgnoreMouseEvents(true);
    toastWin.setAlwaysOnTop(true, "screen-saver");
    toastWin.webContents.on("will-navigate", (e) => e.preventDefault());
    toastWin.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    toastWin.once("ready-to-show", () => {
      if (!toastWin || toastWin.isDestroyed()) return;
      toastWin.showInactive();
      toastWin.webContents.send("event", { type: "toast", ...toastPayload });
    });
    toastWin.on("closed", () => (toastWin = null));
    toastWin.loadFile(path.join(renderer, "toast.html"), { query: { theme: currentTheme().theme } });
  } else {
    toastWin.setBounds(bounds);
    toastWin.webContents.send("event", { type: "toast", ...payload });
    toastWin.showInactive();
  }
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastPayload = null;
    if (toastWin && !toastWin.isDestroyed()) toastWin.hide();
  }, ms);
}

/**
 * 按设置注册全局快捷键。注册不上（被别的程序占了）返回 false，并把原因留在返回值里。
 * 每次改设置都要先注销旧的，否则旧组合会一直占着。
 */
function syncHotkey() {
  const accel = hotkey.acceleratorOf(settings.get().clickThroughKey);
  if (hotkeyRegistered === accel) return { ok: true, accelerator: accel };
  if (hotkeyRegistered) {
    globalShortcut.unregister(hotkeyRegistered);
    hotkeyRegistered = "";
  }
  if (!accel) return { ok: false, accelerator: "", message: "快捷键不完整。" };
  let ok = false;
  try {
    ok = globalShortcut.register(accel, () => setClickThrough());
  } catch {
    ok = false;
  }
  if (ok) hotkeyRegistered = accel;
  return { ok, accelerator: accel, message: ok ? "" : `${hotkey.keyText(settings.get().clickThroughKey)} 被别的程序占用了，换一个组合试试。` };
}

/**
 * 启动时注册不上（默认组合被别的程序占了）要说一声，不然用户按了没反应也不知道为什么。
 * 不弹模态框：只在设置窗口里标出来，加上托盘菜单里那一项照常能用。
 */
function announceHotkey() {
  const result = syncHotkey();
  if (!result.ok && result.message) {
    lastError = null; // 这不是 SP 的问题，别混进连接错误里
    hotkeyNotice = result.message;
  }
  return result;
}

/** 改快捷键：先试注册，成了才存。失败了原来的组合不动。 */
function setClickThroughKey(payload) {
  const combo = hotkey.normalizeKey(payload);
  if (!combo) return { ok: false, message: "至少选一个修饰键和一个普通键。" };
  const beforeAccel = hotkeyRegistered;
  // 先注销旧的再试新的：不注销的话，试一个已经被自己占着的组合会误判成被占用
  if (hotkeyRegistered) {
    globalShortcut.unregister(hotkeyRegistered);
    hotkeyRegistered = "";
  }
  let ok = false;
  const accel = hotkey.acceleratorOf(combo);
  try {
    ok = globalShortcut.register(accel, () => setClickThrough());
  } catch {
    ok = false;
  }
  if (!ok) {
    // 回滚：把原来的组合重新注册回去
    if (beforeAccel) {
      try {
        if (globalShortcut.register(beforeAccel, () => setClickThrough())) hotkeyRegistered = beforeAccel;
      } catch {
        // 连原来的都注册不回去（比如被别的程序抢了），那就只能空着
      }
    }
    return { ok: false, message: `${hotkey.keyText(combo)} 被别的程序占用了，换一个组合试试。` };
  }
  hotkeyRegistered = accel;
  settings.update({ clickThroughKey: combo });
  rebuildTrayMenu();
  pushState();
  return OK;
}

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
    type === "schedule" && [ui.scheduleDay, s.scheduleStartHour, s.scheduleEndHour], type === "month" && [ui.month, ui.selected],
    type === "list" && s.listSource, type === "breakdown" && s.breakdownBy, type === "heatmap" && s.heatmapWeeks]);
  if (type === "planner") return cached(type, key, () => buildPlanner(raw, { dayStartHour: s.dayStartHour, days: s.plannerDays }));
  if (type === "schedule") {
    return cached(type, key, () => buildSchedule(raw, {
      dayStartHour: s.dayStartHour, day: ui.scheduleDay, startHour: s.scheduleStartHour, endHour: s.scheduleEndHour,
    }));
  }
  if (type === "stats") return cached(type, key, () => buildStats(raw, { today: currentDay(), now: raw.now, dayStartHour: s.dayStartHour }));
  if (type === "list") {
    return cached(type, key, () => buildList(raw, {
      kind: s.listSource.kind, id: s.listSource.id, showDone: s.showDone, dayStartHour: s.dayStartHour, now: raw.now,
    }));
  }
  if (type === "heatmap") {
    return cached(type, key, () => buildHeatmap(raw, { today: currentDay(), weeks: s.heatmapWeeks, dayStartHour: s.dayStartHour }));
  }
  if (type === "triage") {
    return cached(type, key, () => buildTriage(raw, { today: currentDay(), now: raw.now }));
  }
  if (type === "breakdown") {
    return cached(type, key, () => buildBreakdown(raw, { today: currentDay(), days: 7, by: s.breakdownBy }));
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
  const t = currentTheme();
  return {
    ...rest,
    themeResolved: t.theme,
    themeName: theme.skinOf(t.theme).name,
    themeSource: t.source,
    tokenSource: tokenSource(),
    canEncrypt,
    desktopAvailable: desktop.available(),
    effectiveMode: cards?.effectiveMode(),
    // 快捷键的显示文本在这里算好，设置窗口不重复一份键位表
    clickThroughKeyText: hotkey.keyText(settings.get().clickThroughKey),
    hotkeyActive: !!hotkeyRegistered,
    hotkeyNotice,
  };
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
    attention: cards.isAttending("focus"),
    snapshotAt: raw?.snapshotAt ?? null,
    ticking: raw?.ticking ?? null,
    // 清单卡片的切换器要用的候选项目/标签
    sources: raw ? listSources(raw) : { projects: [], tags: [] },
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
  savePomo();
  clearTimeout(pomoTimer);
  pomoTimer = state.status === "running" ? setTimeout(pomoTick, Math.max(0, state.endsAt - Date.now()) + 50) : null;
  for (const effect of effects) runEffect(effect);
  syncTrayTip();
  pushState();
}

/** 今天的番茄数总是存；进行中的番茄只在打开「重启后接着走」时存。 */
function savePomo() {
  const s = pomoState;
  settings.update({
    pomodoroStats: { day: s.day, doneToday: s.doneToday, streak: s.streak },
    pomodoroSession: settings.get().pomodoro.resume ? pomo.sessionOf(s) : null,
  });
}

function pomoTick() {
  applyPomo(pomo.tick(pomo.rollDay(pomoState, currentDay()), settings.get().pomodoro, Date.now()));
}

async function runEffect(effect) {
  try {
    if (effect.type === "notify") return notify(effect);
    if (effect.type === "track") await client.start(effect.taskId);
    // 只在 SP 还在计这个任务时才停：用户可能已经换了别的任务
    if (effect.type === "untrack" && (await client.current())?.id === effect.taskId) await client.stop();
    poller.kick();
  } catch (error) {
    lastError = { code: error.code || "ERROR", message: HINTS[error.code] || error.message };
    pushState();
  }
}

// ── 阶段结束的提醒 ──
// 系统通知在勿扰、专注助手打开时不弹也不响，所以另外三样不靠它：卡片页面自己放提示音，
// 「专注」卡片浮到所有窗口上面并闪一闪，通知一直留着直到点掉或开始下一阶段。
let toastNote = null;
let attentionTimer = null;

function notify({ title, body, sound }) {
  const cfg = settings.get().pomodoro;
  const rang = cfg.sound && chime(sound);
  if (cfg.surface) {
    attention(true);
    // 自动开始了下一阶段就不用等人点，过一会儿自己回去
    if (cfg.autoNext) attentionTimer = setTimeout(() => attention(false), 20_000);
  }
  if (SMOKE || !Notification.isSupported()) return;
  toastNote?.close();
  // 卡片已经响过了，通知就别再响一遍
  toastNote = new Notification({ title, body, icon, silent: rang, timeoutType: "never" });
  toastNote.on("click", () => {
    if (!cards.isShown()) cards.showAll();
    attention(true);
  });
  toastNote.show();
}

/** 提示音由一张卡片的页面放，优先「专注」。卡片全隐藏时窗口还在，照样能响。 */
function chime(kind) {
  const type = cards.types().includes("focus") ? "focus" : cards.types()[0];
  if (type) cards.send(type, "event", { type: "chime", kind });
  return !!type;
}

function attention(on) {
  clearTimeout(attentionTimer);
  attentionTimer = null;
  const was = cards.isAttending("focus");
  if (cards.attend("focus", on) !== was) pushState();
}

/** 用户对番茄钟有了操作：提醒都收起来。 */
function dismissReminders() {
  attention(false);
  toastNote?.close();
  toastNote = null;
}

/** 番茄钟操作：先收起到点提醒，再走状态机。 */
const pomoAction = (fn) => (payload) => {
  dismissReminders();
  applyPomo(fn(payload, settings.get().pomodoro, Date.now()));
  return OK;
};

const pomoActions = {
  pomoStart: pomoAction(({ taskId }, cfg, now) => {
    // 没指定任务时用 SP 当前在计时的任务
    const id = isId(taskId) ? taskId : raw?.current?.id ?? null;
    return pomo.start(pomo.rollDay(pomoState, currentDay()), cfg, now, id);
  }),
  pomoPause: pomoAction((_p, cfg, now) => pomo.pause(pomoState, cfg, now)),
  pomoResume: pomoAction((_p, cfg, now) => pomo.resume(pomoState, cfg, now)),
  pomoSkip: pomoAction((_p, cfg, now) => pomo.skip(pomoState, cfg, now)),
  pomoStop: pomoAction((_p, cfg) => pomo.stop(pomoState, cfg)),
  // 浮上来的卡片被点了一下：回到原来的位置
  ack: () => (attention(false), OK),
};

// ── 托盘提示：番茄钟在走时显示剩余时间，卡片被盖住也能看 ──
let trayTimer = null;

function trayTip() {
  const p = pomoState;
  if (p.status === "idle") return "SP 桌面卡片";
  const ms = Math.max(0, p.status === "running" ? p.endsAt - Date.now() : p.remainingMs);
  const sec = Math.ceil(ms / 1000);
  const clock = `${String(Math.floor(sec / 60)).padStart(2, "0")}:${String(sec % 60).padStart(2, "0")}`;
  const label = pomo.PHASE_LABEL[p.phase];
  if (p.status === "ready") return `SP 桌面卡片 · ${label}就绪，等你开始`;
  return `SP 桌面卡片 · ${label} ${clock}${p.status === "paused" ? "（已暂停）" : ""}`;
}

function syncTrayTip() {
  if (!tray) return;
  tray.setToolTip(trayTip());
  const ticking = pomoState.status === "running";
  if (ticking && !trayTimer) trayTimer = setInterval(() => tray?.setToolTip(trayTip()), 1000);
  if (!ticking && trayTimer) {
    clearInterval(trayTimer);
    trayTimer = null;
  }
}

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
    // 桌面模式下开了穿透就点不到卡片了，托盘和快捷键是主要退路，所以这里必须一直有
    { label: "不挡点击", type: "checkbox", checked: s.clickThrough, accelerator: hotkey.acceleratorOf(s.clickThroughKey) || undefined, click: (i) => setClickThrough(i.checked) },
    { label: "重新排列", click: () => cards.resetLayout() },
    { type: "separator" },
    { label: "打开 Super Productivity", click: openSp },
    { label: "设置…", click: openSettings },
    { label: "使用教程", click: openTour },
    { label: "检查更新…", click: () => void checkUpdate({ manual: true }) },
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

/**
 * 清单卡片的来源切换菜单：项目和标签分两段，当前那个打勾。
 * 用原生菜单，和卡片自己的 ⋯ 菜单一样不抢激活。
 */
function listMenu() {
  const s = settings.get();
  const { projects, tags } = raw ? listSources(raw) : { projects: [], tags: [] };
  const pick = (source) => () => saveSettings({ listSource: { kind: source.kind, id: source.id } });
  const section = (label, list) => (list.length ? [{ label, enabled: false }, ...list.map((src) => ({
    label: src.title,
    type: "radio",
    checked: s.listSource.kind === src.kind && s.listSource.id === src.id,
    click: pick(src),
  }))] : []);
  const items = [...section("项目", projects), ...(projects.length && tags.length ? [{ type: "separator" }] : []), ...section("标签", tags)];
  return Menu.buildFromTemplate(items.length ? items : [{ label: "连上 SP 后显示项目和标签", enabled: false }]);
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
  tray.setToolTip("SP 桌面卡片");
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
    backgroundColor: theme.backgroundOf(currentTheme().theme),
    title: "SP 桌面卡片 · 设置",
    icon,
    webPreferences: { preload, contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false },
  });
  settingsWin.setMenu(null);
  settingsWin.webContents.on("will-navigate", (e) => e.preventDefault());
  settingsWin.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  settingsWin.once("ready-to-show", () => settingsWin.show());
  settingsWin.on("closed", () => (settingsWin = null));
  settingsWin.loadFile(path.join(renderer, "settings.html"), { query: { theme: currentTheme().theme } });
}

// ── 外观：皮肤一多，就不塞进设置页了，单独一个窗口 ──
function openAppearance() {
  if (appearanceWin && !appearanceWin.isDestroyed()) {
    appearanceWin.show();
    appearanceWin.focus();
    return;
  }
  appearanceWin = new BrowserWindow({
    width: 640,
    height: 560,
    minWidth: 460,
    minHeight: 380,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: theme.backgroundOf(currentTheme().theme),
    title: "SP 桌面卡片 · 外观",
    icon,
    webPreferences: { preload, contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false },
  });
  appearanceWin.setMenu(null);
  appearanceWin.webContents.on("will-navigate", (e) => e.preventDefault());
  appearanceWin.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  appearanceWin.once("ready-to-show", () => appearanceWin.show());
  appearanceWin.on("closed", () => (appearanceWin = null));
  appearanceWin.loadFile(path.join(renderer, "appearance.html"), { query: { theme: currentTheme().theme } });
}

// ── 快捷键录制：做成卡片样子的一个小窗，点键盘选组合 ──
function openHotkey() {
  if (hotkeyWin && !hotkeyWin.isDestroyed()) {
    hotkeyWin.show();
    hotkeyWin.focus();
    return;
  }
  hotkeyWin = new BrowserWindow({
    width: 460,
    height: 420,
    minWidth: 380,
    minHeight: 340,
    frame: false,
    resizable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    backgroundColor: theme.backgroundOf(currentTheme().theme),
    title: "SP 桌面卡片 · 快捷键",
    icon,
    webPreferences: { preload, contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false },
  });
  hotkeyWin.setMenu(null);
  hotkeyWin.webContents.on("will-navigate", (e) => e.preventDefault());
  hotkeyWin.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  hotkeyWin.once("ready-to-show", () => hotkeyWin?.show());
  hotkeyWin.on("closed", () => (hotkeyWin = null));
  hotkeyWin.loadFile(path.join(renderer, "hotkey.html"), { query: { theme: currentTheme().theme } });
}

// ── 使用教程：第一次启动（含从旧版升级）时弹一次，之后从菜单打开 ──
let tourWin = null;

function openTour() {
  if (tourWin && !tourWin.isDestroyed()) {
    tourWin.show();
    tourWin.focus();
    return;
  }
  tourWin = new BrowserWindow({
    width: 460,
    height: 440,
    resizable: false,
    minimizable: false,
    maximizable: false,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: theme.backgroundOf(currentTheme().theme),
    title: "SP 桌面卡片 · 使用教程",
    icon,
    webPreferences: { preload, contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false },
  });
  tourWin.setMenu(null);
  tourWin.webContents.on("will-navigate", (e) => e.preventDefault());
  tourWin.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  tourWin.once("ready-to-show", () => tourWin.show());
  // 看完或直接关掉都算看过，不再自动弹
  tourWin.on("closed", () => {
    tourWin = null;
    if (!settings.get().tourDone) settings.update({ tourDone: true });
  });
  tourWin.loadFile(path.join(renderer, "tour.html"), { query: { theme: currentTheme().theme } });
}

// ── 检查更新：查 GitHub 上最新的 Release，问一声再下载，装完自己回来 ──
let updateWin = null;
let updateBusy = false; // 正在查或正在下，别重复来
let downloadAbort = null;

const updatesDir = () => path.join(app.getPath("userData"), "updates");

/** 是不是用安装包装的：免安装版旁边没有卸载程序。 */
function installedBySetup() {
  try {
    // 名字改过：老的安装版旁边是 Uninstall SP-Today-Widget.exe
    const dir = path.dirname(app.getPath("exe"));
    return ["Uninstall SP-Desktop-Cards.exe", "Uninstall SP-Today-Widget.exe"].some((f) => fs.existsSync(path.join(dir, f)));
  } catch {
    return false;
  }
}

function askBox({ message, detail, buttons, cancelId = 1 }) {
  // 自检用：SPW_DIALOG_ANSWERS="0,1" 按顺序自动选按钮，省得人去点原生弹窗
  const auto = process.env.SPW_DIALOG_ANSWERS;
  if (auto) {
    const [next, ...rest] = auto.split(",");
    process.env.SPW_DIALOG_ANSWERS = rest.join(",");
    return Promise.resolve(Number(next) || 0);
  }
  // 卡片在「置顶」模式时比对话框高，先让它们落下来，问完再回去
  cards?.holdTop(true);
  return dialog
    .showMessageBox({ type: "info", title: "SP 桌面卡片", message, detail, buttons, cancelId, defaultId: 0, noLink: true })
    .then((r) => r.response, () => cancelId)
    .finally(() => cards?.holdTop(false));
}

function sendUpdate(payload) {
  if (updateWin && !updateWin.isDestroyed()) updateWin.webContents.send("event", payload);
}

function closeUpdateWindow() {
  if (updateWin && !updateWin.isDestroyed()) updateWin.close();
}

function openUpdateWindow(version) {
  if (updateWin && !updateWin.isDestroyed()) {
    updateWin.focus();
    return;
  }
  updateWin = new BrowserWindow({
    width: 400,
    height: 190,
    resizable: false,
    minimizable: false,
    maximizable: false,
    alwaysOnTop: true,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: theme.backgroundOf(currentTheme().theme),
    title: `SP 桌面卡片 · 下载 ${version}`,
    icon,
    webPreferences: { preload, contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false },
  });
  updateWin.setMenu(null);
  updateWin.webContents.on("will-navigate", (e) => e.preventDefault());
  updateWin.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  updateWin.once("ready-to-show", () => updateWin?.show());
  updateWin.on("closed", () => (updateWin = null));
  updateWin.loadFile(path.join(renderer, "update.html"), { query: { theme: currentTheme().theme } });
}

/** 装新版：先退出，再让命令行等安装包跑完，然后把新的程序打开。 */
function installUpdate(file) {
  app.once("will-quit", () => {
    // cmd /s 会把整串首尾的引号剥掉，所以整条命令外面再包一层引号
    const cmd = `""${file}" /S && start "" "${process.execPath}""`;
    try {
      spawn("cmd.exe", ["/d", "/s", "/c", cmd], { detached: true, stdio: "ignore", windowsVerbatimArguments: true }).unref();
    } catch {
      // 起不来就只能让用户自己去点安装包
    }
  });
  app.quit();
}

async function downloadUpdate(latest) {
  const name = updateCheck.artifactName(latest.version, "setup");
  openUpdateWindow(latest.version);
  downloadAbort = new AbortController();
  try {
    const file = await updateCheck.downloadFile(latest.setup.url, updatesDir(), name, {
      signal: downloadAbort.signal,
      onProgress: (percent, got, total) => sendUpdate({ type: "progress", percent, got, total }),
    });
    sendUpdate({ type: "done" });
    const answer = await askBox({
      message: `下载完成：${latest.version}`,
      detail: "现在安装吗？装的时候程序会关掉，装好之后会自己回来。",
      buttons: ["立即安装", "稍后"],
    });
    if (answer === 0) {
      installUpdate(file);
      return;
    }
    closeUpdateWindow();
  } catch (error) {
    const aborted = error?.name === "AbortError";
    sendUpdate({ type: "failed", message: aborted ? "已取消下载。" : error?.message || "下载失败" });
  } finally {
    downloadAbort = null;
  }
}

/**
 * 看看有没有新版本。manual 是自己点的，查不到、已是最新都会说一声（自动检查时安静）。
 * 一天最多自动查一次，点过「跳过这个版本」的版本不再提醒。
 */
// 查不到时说什么。网络类的错误值得再试一次：GitHub 在国内时好时坏。
const CHECK_FAIL = {
  network: ["连不上 GitHub", "检查一下网络；开着代理的话看看代理还在不在，过一会儿再试。"],
  timeout: ["GitHub 没有响应", "网络有点慢，过一会儿再试。"],
  http: ["GitHub 那边出错了", "过一会儿再试。一直这样就去 Release 页手动看看。"],
  none: ["GitHub 上还没有发布版本", ""],
  format: ["没看懂 GitHub 的返回", "可能是网络里插了东西，过一会儿再试。"],
};

async function latestRelease() {
  const opts = { latestUrl: process.env.SPW_UPDATE_API || undefined, base: process.env.SPW_UPDATE_BASE || undefined };
  let r = await updateCheck.fetchLatest(opts);
  // 新仓库查不到（改名初期、或者网络抖一下）就回头问旧仓库的指路牌，老用户不至于断了升级的路
  const bad = (x) => x?.error === "network" || x?.error === "timeout";
  if (bad(r)) r = await updateCheck.fetchLatest(opts);
  if (!r || r.error) {
    // 旧仓库里的安装包还是旧文件名，只能给下载页，不能在这里直接下
    const legacyUrl = process.env.SPW_UPDATE_LEGACY_API || updateCheck.legacyLatestUrl();
    const legacy = await updateCheck.fetchLatest({ ...opts, latestUrl: legacyUrl });
    if (legacy && !legacy.error && updateCheck.isNewer(legacy.version, app.getVersion())) return { ...legacy, legacy: true };
  }
  return r;
}

async function checkUpdate({ manual = false } = {}) {
  if (updateBusy) return;
  updateBusy = true;
  try {
    const latest = await latestRelease();
    settings.update({ lastUpdateCheck: Date.now() });
    const current = app.getVersion();
    if (latest?.error || !latest) {
      if (manual) {
        const [message, detail] = CHECK_FAIL[latest?.error] || CHECK_FAIL.network;
        await askBox({ message, detail: latest?.status ? `${detail}\n\n（HTTP ${latest.status}）`.trim() : detail, buttons: ["好"], cancelId: 0 });
      }
      return;
    }
    if (!updateCheck.isNewer(latest.version, current)) {
      if (manual) await askBox({ message: `已经是最新的 ${current}`, detail: "", buttons: ["好"], cancelId: 0 });
      return;
    }
    if (!manual && settings.get().skipVersion === latest.version) return;
    // SPW_UPDATE_SETUP=1 是自检用的：开发版旁边没有卸载程序，也当安装版走一遍下载流程
    // 旧仓库的指路版本只给下载页：那边还是旧文件名，装完程序名字也换回来了
    const setup = !latest.legacy && (installedBySetup() || process.env.SPW_UPDATE_SETUP === "1") ? latest.setup : null;
    const buttons = setup ? ["下载并安装", "稍后", "跳过这个版本"] : ["打开下载页", "稍后", "跳过这个版本"];
    const detail = setup
      ? `当前 ${current}。下载完直接安装，设置和卡片位置都保留。`
      : latest.legacy
        ? `当前 ${current}。程序改名成「SP 桌面卡片」了，去下载页装这一版换过来，设置和卡片位置都保留。`
        : `当前 ${current}。免安装版请在下载页里解压替换。`;
    const answer = await askBox({ message: `发现新版本 ${latest.version}`, detail, buttons });
    if (answer === 1) return;
    if (answer === 2) {
      settings.update({ skipVersion: latest.version });
      return;
    }
    if (!setup) {
      shell.openExternal(latest.page || `https://github.com/${latest.legacy ? updateCheck.LEGACY_REPO : updateCheck.REPO}/releases/latest`).catch(() => {});
      return;
    }
    await downloadUpdate(latest);
  } finally {
    updateBusy = false;
  }
}

// ── 设置 ──
function saveSettings(patch) {
  const before = settings.get();
  const s = settings.update(patch);
  if (s.theme !== before.theme) applyTheme();
  if (s.mode !== before.mode) cards.applyMode();
  if (s.locked !== before.locked) cards.setLocked(s.locked);
  if (s.clickThrough !== before.clickThrough) cards.setClickThrough(s.clickThrough);
  if (s.opacity !== before.opacity) cards.setOpacity(s.opacity);
  if (s.openAtLogin !== before.openAtLogin && app.isPackaged) app.setLoginItemSettings({ openAtLogin: s.openAtLogin });
  if (s.pomodoro.resume !== before.pomodoro.resume) savePomo();
  if (!s.pomodoro.surface) attention(false);
  rebuildTrayMenu();
  pushState();
}

// ── 页面发来的操作。只认白名单里的名字，参数逐个检查。 ──
const isId = (v) => typeof v === "string" && v.length > 0 && v.length < 200;
// 设置窗口能改的字段；卡片位置、令牌、番茄统计走各自的通道
const EDITABLE = ["mode", "theme", "locked", "opacity", "openAtLogin", "upcomingMinutes", "dayStartHour", "showDone", "plannerDays",
  "scheduleStartHour", "scheduleEndHour", "quickAddProjectId", "pomodoro", "autoUpdate", "breakdownBy", "heatmapWeeks", "listSource",
  "clickThrough"];
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
  // 卡片 ⋯ 菜单里的「不挡点击」和托盘里的是同一项。注意：开了之后这张卡片就点不到了，
  // 关回去要走托盘或快捷键——所以托盘和快捷键这两个入口不能少。
  toggleClickThrough: () => (setClickThrough(), OK),
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
  // 清单卡片：弹出项目/标签切换菜单
  listMenu: (_p, type) => (cards.popup(type, listMenu()), OK),
  // 时间去向卡片：标签/项目之间切换
  setBreakdownBy: ({ by }) => (DIMENSIONS.includes(by) ? (saveSettings({ breakdownBy: by }), OK) : null),
  // 待整理卡片：把任务排到今天。dueWithTime 要一起清掉，不然 SP 里还按原来的钟点算。
  scheduleToday: ({ id }) => (isId(id) ? runTaskAction(() => client.patchTask(id, { dueDay: currentDay(), dueWithTime: null })) : null),
  ...pomoActions,
};

const settingsActions = {
  saveSettings: (patch) => (patch && typeof patch === "object" ? (saveSettings(pick(patch, EDITABLE)), OK) : null),
  setCardVisible: ({ type, visible }) => (CARD_TYPES.includes(type) && typeof visible === "boolean" ? (cards.setVisible(type, visible), pushState(), OK) : null),
  resetLayout: () => (cards.resetLayout(), OK),
  openTour: () => (openTour(), OK),
  openAppearance: () => (openAppearance(), OK),
  openHotkey: () => (openHotkey(), OK),
  checkUpdate: () => (void checkUpdate({ manual: true }), OK),
  setToken: ({ token }) => setManualToken(token),
  refresh: () => (poller.kick(), OK),
};

const appearanceActions = {
  themeCatalog: () => ({ ok: true, data: { skins: theme.SKINS, current: currentTheme().theme, source: currentTheme().source } }),
  setTheme: ({ id }) => (theme.isSkin(id) ? (saveSettings({ theme: id }), OK) : null),
  closeAppearance: () => (appearanceWin?.close(), OK),
};

const hotkeyActions = {
  hotkeyCatalog: () => ({
    ok: true,
    data: { modifiers: hotkey.MODIFIERS, keys: hotkey.KEYS, current: settings.get().clickThroughKey },
  }),
  setClickThroughKey: (payload) => setClickThroughKey(payload),
  closeHotkey: () => (hotkeyWin?.close(), OK),
};

const toastActions = {
  // 页面起来晚了、错过第一条推送时自己来问一次
  toastReady: () => (toastPayload ? toastWin?.webContents.send("event", { type: "toast", ...toastPayload }) : null) || OK,
};

const tourActions = {
  close: () => (tourWin?.close(), OK),
};

const updateActions = {
  cancel: () => (downloadAbort?.abort(), OK),
  close: () => (closeUpdateWindow(), OK),
};

const from = (win, sender) => win && !win.isDestroyed() && sender === win.webContents;

ipcMain.handle("action", async (event, name, payload) => {
  const type = cards?.typeOf(event.sender);
  const table = type
    ? cardActions
    : from(settingsWin, event.sender)
      ? settingsActions
      : from(appearanceWin, event.sender)
        ? appearanceActions
        : from(hotkeyWin, event.sender)
          ? hotkeyActions
          : from(toastWin, event.sender)
            ? toastActions
            : from(tourWin, event.sender)
          ? tourActions
          : from(updateWin, event.sender)
            ? updateActions
            : null;
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
ipcMain.on("resize-start", (event, edges) => {
  const type = cards?.typeOf(event.sender);
  if (type) cards.resizeStart(type, edges);
});
ipcMain.on("resize-end", (event) => {
  if (cards?.typeOf(event.sender)) cards.resizeEnd();
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
  themeStopWatcher?.();
  globalShortcut.unregisterAll();
  clearTimeout(toastTimer);
});
app.on("window-all-closed", () => {});

app.whenReady().then(async () => {
  settings = createSettingsStore(app.getPath("userData"));
  // 外部主题文件先读一次，卡片窗口创建时就要用对皮肤
  externalTheme = theme.readExternal(themeFile());
  await loadManualToken();
  const initial = settings.get();
  pomoState = pomo.createState(initial.pomodoroStats);
  if (initial.pomodoro.resume) pomoState = pomo.restore(pomoState, initial.pomodoroSession, initial.pomodoro, Date.now());
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
    themeId: () => currentTheme().theme,
    onChange() {
      poller.setIdle(!cards.isShown());
      rebuildTrayMenu();
    },
    onGroupDrag(type) {
      // 前几次整组拖动时提醒一下，之后不再说
      const n = settings.get().altHints;
      if (n >= 3) return;
      settings.update({ altHints: n + 1 });
      cards.send(type, "event", { type: "toast", message: "拼在一起的卡片会一起走。按住 Alt 拖，只挪这一张。" });
    },
  });
  cards.start();
  applyTheme();
  // 不挡点击：按存下来的状态设一次，再注册全局快捷键
  cards.setClickThrough(initial.clickThrough);
  announceHotkey();
  // 每 2 秒看一眼外部主题文件；文件变了就换皮肤，删掉就回到手选的
  themeStopWatcher = theme.watchExternal(themeFile(), (value) => {
    externalTheme = value;
    applyTheme();
    pushState();
  });
  if (!SMOKE) createTray();
  // 接着上次的番茄：重新挂上定时器和托盘提示
  applyPomo({ state: pomoState, effects: [] });
  if (!SMOKE && !initial.tourDone) setTimeout(openTour, 1200);
  // 一天最多自动查一次更新；刚装好、刚看过教程的时候先别插进来。
  // 自检时指向假接口（SPW_UPDATE_API），开发版也查，而且早点查。
  const fakeApi = !!process.env.SPW_UPDATE_API;
  if ((app.isPackaged || fakeApi) && initial.autoUpdate && Date.now() - initial.lastUpdateCheck > 24 * 3600_000) {
    setTimeout(() => {
      if (!tourWin && !settingsWin) void checkUpdate();
    }, fakeApi ? 1500 : 20_000);
  }
  powerMonitor.on("resume", () => {
    poller.kick();
    if (pomoState.status === "running") pomoTick();
  });
  powerMonitor.on("unlock-screen", () => poller.kick());
  poller.start();
});