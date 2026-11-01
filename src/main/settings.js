// settings.js — 小窗自己的设置，存在 userData/settings.json。
// 手填的令牌用 Electron safeStorage（Windows 下是 DPAPI）加密后再存，文件里不出现明文。

import fs from "node:fs";
import path from "node:path";

export const DEFAULTS = Object.freeze({
  bounds: null, // { x, y, width, height }，展开状态下的位置和大小
  collapsed: false,
  opacity: 0.95,
  alwaysOnTop: true,
  openAtLogin: false,
  upcomingMinutes: 15,
  dayStartHour: 0,
  showDone: false,
  manualToken: "", // 加密后的 base64
});

const clampNumber = (v, min, max, fallback) =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;

/** 把读到的或前端传来的值收敛到合法范围，未知字段丢掉。 */
export function sanitize(input, base = DEFAULTS) {
  const s = { ...base };
  if (!input || typeof input !== "object") return s;
  const b = input.bounds;
  if (b && ["x", "y", "width", "height"].every((k) => Number.isFinite(b[k]))) {
    s.bounds = { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) };
  }
  if (typeof input.collapsed === "boolean") s.collapsed = input.collapsed;
  if (typeof input.alwaysOnTop === "boolean") s.alwaysOnTop = input.alwaysOnTop;
  if (typeof input.openAtLogin === "boolean") s.openAtLogin = input.openAtLogin;
  if (typeof input.showDone === "boolean") s.showDone = input.showDone;
  s.opacity = clampNumber(input.opacity, 0.3, 1, s.opacity);
  s.upcomingMinutes = Math.round(clampNumber(input.upcomingMinutes, 0, 240, s.upcomingMinutes));
  s.dayStartHour = Math.round(clampNumber(input.dayStartHour, 0, 23, s.dayStartHour));
  if (typeof input.manualToken === "string") s.manualToken = input.manualToken;
  return s;
}

export function createSettingsStore(dir) {
  const file = path.join(dir, "settings.json");
  let data = { ...DEFAULTS };
  try {
    data = sanitize(JSON.parse(fs.readFileSync(file, "utf8")));
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
  return {
    get: () => ({ ...data }),
    update(patch) {
      data = sanitize({ ...data, ...patch }, data);
      // 拖动窗口时会连续触发，合并成一次写盘。
      clearTimeout(timer);
      timer = setTimeout(flush, 400);
      return { ...data };
    },
    flush,
  };
}
