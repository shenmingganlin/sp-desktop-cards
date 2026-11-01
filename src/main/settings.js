// settings.js — 小窗自己的设置，存在 userData/settings.json。
// 手填的令牌用 Electron safeStorage（Windows 下是 DPAPI）加密后再存，文件里不出现明文。
//
// 0.2.0 起每张卡片单独记位置（version: 2）。0.1.0 的单窗口设置读进来时自动迁移：
// 原窗口位置给「今日」，「专注」放在它上方拼好。

import fs from "node:fs";
import path from "node:path";
import { DEFAULT_POMODORO } from "./pomodoro.js";

export const CARD_TYPES = ["focus", "today", "planner", "schedule", "month"];
export const CARD_SIZE = {
  focus: { width: 320, height: 132 },
  today: { width: 320, height: 380 },
  planner: { width: 320, height: 460 },
  schedule: { width: 320, height: 520 },
  month: { width: 320, height: 420 },
};
export const MODES = ["top", "normal", "desktop"];
export const GAP = 6; // 拼在一起的卡片之间的间距

const DEFAULT_CARDS = Object.freeze({
  focus: { visible: true, bounds: null, collapsed: false },
  today: { visible: true, bounds: null, collapsed: false },
  planner: { visible: false, bounds: null, collapsed: false },
  schedule: { visible: false, bounds: null, collapsed: false },
  month: { visible: false, bounds: null, collapsed: false },
});

export const DEFAULTS = Object.freeze({
  version: 2,
  mode: "top", // top 置顶 / normal 普通窗口 / desktop 嵌入桌面
  locked: false,
  opacity: 0.95,
  openAtLogin: false,
  upcomingMinutes: 15,
  dayStartHour: 0,
  showDone: false,
  manualToken: "", // 加密后的 base64
  cards: DEFAULT_CARDS,
  plannerDays: 7,
  scheduleStartHour: 8,
  scheduleEndHour: 22,
  quickAddProjectId: "", // 空表示收件箱
  pomodoro: DEFAULT_POMODORO,
  pomodoroStats: { day: null, doneToday: 0, streak: 0 },
});

const clampNumber = (v, min, max, fallback) =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
const clampInt = (v, min, max, fallback) => Math.round(clampNumber(v, min, max, fallback));

function cleanBounds(b) {
  if (!b || !["x", "y", "width", "height"].every((k) => Number.isFinite(b[k]))) return null;
  return { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) };
}

/** 0.1.0 的设置（没有 version）转成新格式。 */
export function migrate(input) {
  if (!input || typeof input !== "object" || input.version >= 2) return input;
  const { bounds, collapsed, alwaysOnTop, ...rest } = input;
  const out = { ...rest, version: 2, mode: alwaysOnTop === false ? "normal" : "top", cards: {} };
  const old = cleanBounds(bounds);
  if (old) {
    const focusH = CARD_SIZE.focus.height;
    out.cards.focus = { visible: true, bounds: { x: old.x, y: old.y, width: old.width, height: focusH } };
    out.cards.today = {
      visible: true,
      collapsed: !!collapsed,
      bounds: { x: old.x, y: old.y + focusH + GAP, width: old.width, height: Math.max(200, old.height - focusH - GAP) },
    };
  }
  return out;
}

function cleanCards(input, base) {
  const out = {};
  for (const type of CARD_TYPES) {
    const b = base[type] || DEFAULT_CARDS[type];
    const c = input && typeof input === "object" ? input[type] : null;
    out[type] = { ...b };
    if (!c || typeof c !== "object") continue;
    if (typeof c.visible === "boolean") out[type].visible = c.visible;
    if (typeof c.collapsed === "boolean") out[type].collapsed = c.collapsed;
    if ("bounds" in c) out[type].bounds = cleanBounds(c.bounds);
  }
  return out;
}

function cleanPomodoro(input, base) {
  const p = { ...base };
  if (!input || typeof input !== "object") return p;
  p.workMin = clampInt(input.workMin, 1, 180, p.workMin);
  p.shortMin = clampInt(input.shortMin, 1, 60, p.shortMin);
  p.longMin = clampInt(input.longMin, 1, 120, p.longMin);
  p.longEvery = clampInt(input.longEvery, 1, 12, p.longEvery);
  if (typeof input.autoNext === "boolean") p.autoNext = input.autoNext;
  if (typeof input.linkTracking === "boolean") p.linkTracking = input.linkTracking;
  return p;
}

/**
 * 把读到的或前端传来的值收敛到合法范围，未知字段丢掉。
 * cards 和 pomodoro 按字段合并：只改一张卡片的位置不会冲掉其他卡片。
 */
export function sanitize(input, base = DEFAULTS) {
  const s = { ...base, cards: cleanCards(null, base.cards), pomodoro: { ...base.pomodoro } };
  if (!input || typeof input !== "object") return s;
  if (MODES.includes(input.mode)) s.mode = input.mode;
  for (const key of ["locked", "openAtLogin", "showDone"]) {
    if (typeof input[key] === "boolean") s[key] = input[key];
  }
  s.opacity = clampNumber(input.opacity, 0.3, 1, s.opacity);
  s.upcomingMinutes = clampInt(input.upcomingMinutes, 0, 240, s.upcomingMinutes);
  s.dayStartHour = clampInt(input.dayStartHour, 0, 23, s.dayStartHour);
  s.plannerDays = clampInt(input.plannerDays, 3, 14, s.plannerDays);
  s.scheduleStartHour = clampInt(input.scheduleStartHour, 0, 23, s.scheduleStartHour);
  s.scheduleEndHour = clampInt(input.scheduleEndHour, s.scheduleStartHour + 1, 24, Math.max(s.scheduleEndHour, s.scheduleStartHour + 1));
  if (typeof input.quickAddProjectId === "string" && input.quickAddProjectId.length < 200) s.quickAddProjectId = input.quickAddProjectId;
  if (typeof input.manualToken === "string") s.manualToken = input.manualToken;
  if (input.cards) s.cards = cleanCards(input.cards, s.cards);
  if (input.pomodoro) s.pomodoro = cleanPomodoro(input.pomodoro, s.pomodoro);
  const ps = input.pomodoroStats;
  if (ps && typeof ps === "object") {
    s.pomodoroStats = {
      day: typeof ps.day === "string" ? ps.day : null,
      doneToday: clampInt(ps.doneToday, 0, 999, 0),
      streak: clampInt(ps.streak, 0, 99, 0),
    };
  }
  return s;
}

export function createSettingsStore(dir) {
  const file = path.join(dir, "settings.json");
  let data = sanitize(null);
  try {
    data = sanitize(migrate(JSON.parse(fs.readFileSync(file, "utf8"))));
  } catch {
    // 第一次运行或文件损坏：用默认值
  }
  let timer = null;
  const flush = () => {
    clearTimeout(timer);
    timer = null;
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file);
  };
  const copy = () => structuredClone(data);
  return {
    get: copy,
    update(patch) {
      data = sanitize(patch, data);
      // 拖动窗口时会连续触发，合并成一次写盘。
      clearTimeout(timer);
      timer = setTimeout(flush, 400);
      return copy();
    },
    /** 改一张卡片：updateCard("today", { bounds }) */
    updateCard(type, patch) {
      return this.update({ cards: { [type]: patch } });
    },
    flush,
  };
}
