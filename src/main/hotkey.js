// hotkey.js — 「不挡点击」的全局快捷键：规范化、校验、转成 Electron 的 accelerator。
// 纯逻辑，不碰 Electron，能单测。
//
// 组合只支持「修饰键 + 一个普通键」：
//   Ctrl / Alt / Shift / Win 可以同时按几个，普通键只能有一个。
//   不支持录一串序列（像 Vim 那样），也不支持单独一个普通键——那样会把日常打字全吃掉。

/** 修饰键，按显示顺序排。 */
export const MODIFIERS = [
  { id: "ctrl", label: "Ctrl", accelerator: "Control" },
  { id: "alt", label: "Alt", accelerator: "Alt" },
  { id: "shift", label: "Shift", accelerator: "Shift" },
  { id: "win", label: "Win", accelerator: "Super" },
];

/**
 * 可以当主键的键：id → Electron accelerator 里的写法。
 * 只列常用键，不追求全覆盖——用户真要用别的键，加一行就行。
 */
export const KEYS = [
  { id: "F1", label: "F1" }, { id: "F2", label: "F2" }, { id: "F3", label: "F3" }, { id: "F4", label: "F4" },
  { id: "F5", label: "F5" }, { id: "F6", label: "F6" }, { id: "F7", label: "F7" }, { id: "F8", label: "F8" },
  { id: "F9", label: "F9" }, { id: "F10", label: "F10" }, { id: "F11", label: "F11" }, { id: "F12", label: "F12" },
  { id: "A", label: "A" }, { id: "B", label: "B" }, { id: "C", label: "C" }, { id: "D", label: "D" },
  { id: "E", label: "E" }, { id: "F", label: "F" }, { id: "G", label: "G" }, { id: "H", label: "H" },
  { id: "I", label: "I" }, { id: "J", label: "J" }, { id: "K", label: "K" }, { id: "L", label: "L" },
  { id: "M", label: "M" }, { id: "N", label: "N" }, { id: "O", label: "O" }, { id: "P", label: "P" },
  { id: "Q", label: "Q" }, { id: "R", label: "R" }, { id: "S", label: "S" }, { id: "T", label: "T" },
  { id: "U", label: "U" }, { id: "V", label: "V" }, { id: "W", label: "W" }, { id: "X", label: "X" },
  { id: "Y", label: "Y" }, { id: "Z", label: "Z" },
  { id: "0", label: "0" }, { id: "1", label: "1" }, { id: "2", label: "2" }, { id: "3", label: "3" },
  { id: "4", label: "4" }, { id: "5", label: "5" }, { id: "6", label: "6" }, { id: "7", label: "7" },
  { id: "8", label: "8" }, { id: "9", label: "9" },
  { id: "Space", label: "空格" }, { id: "Enter", label: "回车" }, { id: "Tab", label: "Tab" },
  { id: "Backspace", label: "退格" }, { id: "Delete", label: "Del" }, { id: "Insert", label: "Ins" },
  { id: "Home", label: "Home" }, { id: "End", label: "End" }, { id: "PageUp", label: "PgUp" },
  { id: "PageDown", label: "PgDn" },
  { id: "Up", label: "↑" }, { id: "Down", label: "↓" }, { id: "Left", label: "←" }, { id: "Right", label: "→" },
];

const MOD_IDS = new Set(MODIFIERS.map((m) => m.id));
const KEY_IDS = new Set(KEYS.map((k) => k.id));
// Ctrl+Alt+X 在不少机器上被别的程序占着（本机就被占了，实测注册不上），
// 默认换成 Ctrl+Alt+J。真注册不上时主进程会提示去设置里换一个。
const DEFAULT_KEY = { mods: ["ctrl", "alt"], key: "J" };

export const isModifier = (id) => MOD_IDS.has(id);
export const isKey = (id) => KEY_IDS.has(id);
export const keyLabel = (id) => KEYS.find((k) => k.id === id)?.label || id;
export const modLabel = (id) => MODIFIERS.find((m) => m.id === id)?.label || id;

/**
 * 收敛成一个干净的组合；不合法返回 null。
 * 修饰键按 MODIFIERS 的顺序排，大小写不敏感（x 和 X 都当 X）。
 */
export function normalizeKey(input) {
  if (!input || typeof input !== "object") return null;
  const mods = Array.isArray(input.mods) ? input.mods.filter((m) => MOD_IDS.has(m)) : [];
  const raw = typeof input.key === "string" ? input.key : "";
  // 大小写不敏感：小写字母也认
  const key = KEY_IDS.has(raw) ? raw : KEYS.find((k) => k.id.toLowerCase() === raw.toLowerCase())?.id;
  if (!key) return null;
  // 至少一个修饰键：单独一个普通键会把日常打字吃掉
  if (!mods.length) return null;
  const ordered = MODIFIERS.filter((m) => mods.includes(m.id)).map((m) => m.id);
  return { mods: ordered, key };
}

export const sameKey = (a, b) => !!a && !!b && a.key === b.key && a.mods.length === b.mods.length && a.mods.every((m, i) => m === b.mods[i]);

/** 「Ctrl + Alt + X」，给界面显示用。 */
export function keyText(combo) {
  if (!combo) return "";
  return [...combo.mods.map(modLabel), keyLabel(combo.key)].join(" + ");
}

/** 转成 Electron globalShortcut 认的写法：「Control+Alt+X」。 */
export function acceleratorOf(combo) {
  const c = normalizeKey(combo);
  if (!c) return "";
  const mods = MODIFIERS.filter((m) => c.mods.includes(m.id)).map((m) => m.accelerator);
  return [...mods, c.key].join("+");
}

/** 默认组合，设置里没填时用它。 */
export const defaultKey = () => ({ mods: [...DEFAULT_KEY.mods], key: DEFAULT_KEY.key });
