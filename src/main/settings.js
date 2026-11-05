// settings.js — 小窗自己的设置，存在 userData/settings.json。
// 手填的令牌用 Electron safeStorage（Windows 下是 DPAPI）加密后再存，文件里不出现明文。
//
// 0.2.0 起每张卡片单独记位置（version: 2）。0.1.0 的单窗口设置读进来时自动迁移：
// 原窗口位置给「今日」，「专注」放在它上方拼好。

import fs from "node:fs";
import path from "node:path";
import { defaultKey, normalizeKey } from "./hotkey.js";
import { DEFAULT_POMODORO } from "./pomodoro.js";
import { normalizeSkin } from "./theme.js";

export const CARD_TYPES = ["focus", "today", "planner", "schedule", "month", "stats", "list", "heatmap", "triage", "breakdown"];
export const CARD_SIZE = {
  focus: { width: 320, height: 132 },
  today: { width: 320, height: 380 },
  planner: { width: 320, height: 460 },
  schedule: { width: 320, height: 520 },
  month: { width: 320, height: 420 },
  stats: { width: 320, height: 300 },
  list: { width: 320, height: 420 },
  heatmap: { width: 340, height: 220 },
  triage: { width: 320, height: 400 },
  breakdown: { width: 320, height: 340 },
};
export const MODES = ["top", "normal", "desktop"];
export const GAP = 6; // 拼在一起的卡片之间的间距

const DEFAULT_CARDS = Object.freeze({
  focus: { visible: true, bounds: null, collapsed: false },
  today: { visible: true, bounds: null, collapsed: false },
  planner: { visible: false, bounds: null, collapsed: false },
  schedule: { visible: false, bounds: null, collapsed: false },
  month: { visible: false, bounds: null, collapsed: false },
  stats: { visible: false, bounds: null, collapsed: false },
  list: { visible: false, bounds: null, collapsed: false },
  heatmap: { visible: false, bounds: null, collapsed: false },
  triage: { visible: false, bounds: null, collapsed: false },
  breakdown: { visible: false, bounds: null, collapsed: false },
});

export const DEFAULTS = Object.freeze({
  version: 2,
  mode: "top", // top 置顶 / normal 普通窗口 / desktop 嵌入桌面
  theme: "dark", // dark 深夜 / hana 暖纸；外部主题文件可以临时覆盖
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
  pomodoroSession: null, // 打开「重启后接着走」时存进行中的番茄，读的时候由 pomodoro.restore 检查
  tourDone: false, // 看过使用教程
  altHints: 0, // 整组拖动时提示过几次「按住 Alt 只挪一张」
  autoUpdate: true, // 启动时顺手看看有没有新版本
  skipVersion: "", // 点过「跳过这个版本」的那个版本号
  lastUpdateCheck: 0, // 上次检查更新的时间戳，一天最多自动查一次
  listSource: { kind: "project", id: "" }, // 清单卡片看哪个项目/标签；id 为空表示用第一个
  breakdownBy: "tag", // 时间去向卡片按什么分摊：tag 标签 / project 项目
  heatmapWeeks: 13, // 热力图卡片显示几周
  clickThrough: false, // 不挡点击：鼠标落在卡片上时穿透到下面（默认关）
  clickThroughKey: defaultKey(), // 切换「不挡点击」的全局快捷键
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
  for (const key of ["autoNext", "linkTracking", "sound", "surface", "resume", "confirmStop"]) {
    if (typeof input[key] === "boolean") p[key] = input[key];
  }
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
  const pickedTheme = normalizeSkin(input.theme);
  if (pickedTheme) s.theme = pickedTheme;
  for (const key of ["locked", "openAtLogin", "showDone", "tourDone", "autoUpdate", "clickThrough"]) {
    if (typeof input[key] === "boolean") s[key] = input[key];
  }
  // 快捷键不合法就留着原来的：宁可不动，也别把用户设好的组合弄丢
  const combo = normalizeKey(input.clickThroughKey);
  if (combo) s.clickThroughKey = combo;
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
  s.altHints = clampInt(input.altHints, 0, 99, s.altHints);
  if (typeof input.skipVersion === "string" && input.skipVersion.length < 40) s.skipVersion = input.skipVersion;
  s.lastUpdateCheck = clampInt(input.lastUpdateCheck, 0, Number.MAX_SAFE_INTEGER, s.lastUpdateCheck);
  const ls = input.listSource;
  if (ls && typeof ls === "object" && ["project", "tag"].includes(ls.kind) && typeof ls.id === "string" && ls.id.length < 200) {
    s.listSource = { kind: ls.kind, id: ls.id };
  }
  if (input.breakdownBy === "tag" || input.breakdownBy === "project") s.breakdownBy = input.breakdownBy;
  s.heatmapWeeks = clampInt(input.heatmapWeeks, 4, 53, s.heatmapWeeks);
  if (input.pomodoroSession === null || (input.pomodoroSession && typeof input.pomodoroSession === "object")) {
    const { phase, status, endsAt, remainingMs, durationMs, taskId } = input.pomodoroSession || {};
    s.pomodoroSession = input.pomodoroSession && { phase, status, endsAt, remainingMs, durationMs, taskId };
  }
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
  // 写盘是同步 fs，磁盘满、目录只读、杀软锁住 .tmp 都会抛。
  // 这条路径由 setTimeout 触发，异常从定时器里逃出去就是主进程崩溃弹窗——
  // 和 cards.js 的 guard() 同一个道理：这一轮写不成就算了，下一次改设置再写，
  // 内存里的设置始终是对的。
  const flush = () => {
    clearTimeout(timer);
    timer = null;
    try {
      fs.mkdirSync(dir, { recursive: true });
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
      fs.renameSync(tmp, file);
    } catch {
      // 写不进去就算了，别把主进程一起带走
    }
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
