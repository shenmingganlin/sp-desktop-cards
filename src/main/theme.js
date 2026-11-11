// theme.js — 小窗的皮肤目录、外部主题文件、窗口背景色。纯逻辑，能脱离 Electron 单测。
//
// 「深夜」是小窗自己的深灰 + 玫红；其余皮肤来自 Hana 的主题，颜色、圆角、细边、
// 标题字体都跟 Hana 保持一致。设置里只放一个「外观」入口，全部皮肤在外观窗口里选。
//
// 外部主题接口：%APPDATA%\SP 桌面卡片\theme.json，内容 { "theme": "<皮肤 id>", "source": "任务台" }。
// 任何程序都能写；文件存在且合法时压过设置里手选的皮肤。小窗自己只读不写，也不认识 Hana。

import fs from "node:fs";

export const SKINS = [
  { id: "dark", name: "深夜", note: "深灰 + 玫红，原来的样子" },
  { id: "warm-paper", name: "暖纸", note: "Hana · 白天" },
  { id: "midnight", name: "青夜", note: "Hana · 夜间" },
  { id: "high-contrast", name: "素白", note: "Hana · 高对比" },
  { id: "grass-aroma", name: "草香", note: "Hana · Butter" },
  { id: "contemplation", name: "沉思", note: "Hana · Ming" },
  { id: "absolutely", name: "Absolutely", note: "Hana · 有一点点熟悉" },
  { id: "delve", name: "随时准备接住你", note: "Hana · 探究一下" },
  { id: "deep-think", name: "用户彻底怒了", note: "Hana · 小鲸鱼" },
  { id: "new-warm-paper", name: "新暖纸", note: "Hana · 纸本" },
  { id: "midnight-contrast", name: "青夜·高对比", note: "Hana · 清晰" },
  { id: "coral", name: "珊瑚", note: "Hana · 春日和纸" },
];

export const DEFAULT_SKIN = "dark";
export const SKIN_IDS = SKINS.map((s) => s.id);
export const EXTERNAL_FILE = "theme.json";
export const BACKGROUND = {
  dark: "#1f1f1f",
  "warm-paper": "#f8f4ed",
  midnight: "#3b4a54",
  "high-contrast": "#faf8f7",
  "grass-aroma": "#f5f8f3",
  contemplation: "#f3f5f7",
  absolutely: "#f4f3ee",
  delve: "#ffffff",
  "deep-think": "#fcfcfd",
  "new-warm-paper": "#f5efe4",
  "midnight-contrast": "#26343d",
  coral: "#fdf6ec",
};

export const isSkin = (id) => SKIN_IDS.includes(id);
/** 0.3.0 的外部文件里新暖纸叫 hana；现在统一叫 new-warm-paper。 */
export const normalizeSkin = (id) => (id === "hana" ? "new-warm-paper" : isSkin(id) ? id : null);

// 深底的三套，其余都是浅底。原生菜单、托盘菜单、系统对话框按这个选深浅，
// 不按「是不是 Hana」猜——判断要放在归一之后，不然浅色皮肤配的仍是深色菜单。
const DARK_SKINS = new Set(["dark", "midnight", "midnight-contrast"]);
export const isLightSkin = (id) => !DARK_SKINS.has(normalizeSkin(id) || DEFAULT_SKIN);
export const skinOf = (id) => SKINS.find((s) => s.id === normalizeSkin(id)) || SKINS[0];

// 读取失败保留异常，让 watcher 与“已读到无效内容”区分，下一轮仍能重试。
function readExternalFile(file) {
  const text = fs.readFileSync(file, "utf8");
  try {
    const data = JSON.parse(text);
    if (!data || typeof data !== "object") return null;
    const theme = normalizeSkin(data.theme);
    if (!theme) return null;
    const source = typeof data.source === "string" ? data.source.trim().slice(0, 40) : "";
    return { theme, source: source || "外部程序" };
  } catch {
    return null;
  }
}

/** 读外部主题文件；不存在、JSON 坏了、皮肤名不认识都当没有。 */
export function readExternal(file) {
  try {
    return readExternalFile(file);
  } catch {
    return null;
  }
}

/** 最终用哪套皮肤：外部文件优先，否则用手选的；手选值不认识时退回默认。 */
export function resolveSkin(manual, external) {
  const fromExternal = external && normalizeSkin(external.theme);
  if (fromExternal) return { theme: fromExternal, source: external.source || "外部程序" };
  return { theme: normalizeSkin(manual) || DEFAULT_SKIN, source: "" };
}

export const backgroundOf = (theme) => BACKGROUND[normalizeSkin(theme)] || BACKGROUND[DEFAULT_SKIN];

/**
 * 每 interval 毫秒看一眼文件的修改时间，变了才重读并回调。
 * 文件被删掉时回调 null。返回停止函数。
 */
export function watchExternal(file, onChange, { interval = 2000 } = {}) {
  let last = null;
  const tick = () => {
    let mtime = 0;
    try {
      mtime = fs.statSync(file).mtimeMs;
    } catch (error) {
      if (error?.code !== "ENOENT") return;
    }
    if (mtime === last) return;
    let value;
    try {
      value = mtime ? readExternalFile(file) : null;
    } catch {
      // stat 成功不代表能读：文件锁等短暂故障不提交 mtime，下次继续尝试。
      return;
    }
    last = mtime;
    onChange(value);
  };
  tick();
  const timer = setInterval(tick, interval);
  if (typeof timer.unref === "function") timer.unref();
  return () => clearInterval(timer);
}
