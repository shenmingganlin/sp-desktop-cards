// desktop.js — 「嵌入桌面」模式：卡片放在所有普通窗口下面，按 Win+D 显示桌面时仍然可见。
//
// 做法（原型在 Windows 11 26300 上验证过）：
//   1. 找到放桌面图标的窗口：24H2 起是 Progman，之前是包含 SHELLDLL_DefView 的 WorkerW（同 Rainmeter）。
//   2. 把卡片窗口的「所有者」设为它（GWLP_HWNDPARENT）。显示桌面时系统把桌面提到前面，被它拥有的窗口跟着上来。
//   3. 卡片设为不可激活：否则按 Win+D 后卡片会被激活成前台窗口，再按一次 Win+D 就还原不了别的窗口。
//      需要打字时（快速新建）由 cards.js 临时允许激活，失去焦点后再沉回最底层。
// 只在 Windows 上可用；其他系统 available 为 false，界面里不提供这个模式。

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
let api = null;

function load() {
  if (api !== null) return api;
  api = false;
  if (process.platform !== "win32") return api;
  try {
    const koffi = require("koffi");
    const u = koffi.load("user32.dll");
    const H = "uintptr_t";
    api = {
      GetShellWindow: u.func(`${H} GetShellWindow()`),
      FindWindowExW: u.func(`${H} FindWindowExW(${H} parent, ${H} after, str16 cls, str16 name)`),
      SetWindowLongPtrW: u.func(`intptr_t SetWindowLongPtrW(${H} h, int i, intptr_t v)`),
      GetWindow: u.func(`${H} GetWindow(${H} h, uint32_t cmd)`),
      SetWindowPos: u.func(`bool SetWindowPos(${H} h, intptr_t after, int x, int y, int cx, int cy, uint32_t f)`),
      GetAsyncKeyState: u.func("int16_t GetAsyncKeyState(int key)"),
      GetSystemMetrics: u.func("int GetSystemMetrics(int index)"),
    };
  } catch {
    api = false;
  }
  return api;
}

const GWLP_HWNDPARENT = -8;
const GW_OWNER = 4;
const HWND_BOTTOM = 1n;
const SWP_KEEP = 0x0001 | 0x0002 | 0x0010; // NOSIZE | NOMOVE | NOACTIVATE
const big = (v) => BigInt(v || 0);

export const available = () => !!load();

const hwndOf = (win) => {
  const buf = win.getNativeWindowHandle();
  return buf.length >= 8 ? buf.readBigUInt64LE(0) : BigInt(buf.readUInt32LE(0));
};

/** 放桌面图标的窗口；Explorer 没在运行时返回 0n。 */
function iconsHost() {
  const a = load();
  const shell = big(a.GetShellWindow());
  if (!shell) return 0n;
  if (a.FindWindowExW(shell, 0, "SHELLDLL_DefView", "")) return shell;
  let w = 0n;
  while ((w = big(a.FindWindowExW(0, w, "WorkerW", "")))) {
    if (a.FindWindowExW(w, 0, "SHELLDLL_DefView", "")) return w;
  }
  return shell;
}

/** 挂到桌面下面。返回是否成功；已经挂好时什么也不做（定时检查用，Explorer 重启后会重新挂）。 */
export function attach(win) {
  const a = load();
  if (!a || win.isDestroyed()) return false;
  const host = iconsHost();
  if (!host) return false;
  const h = hwndOf(win);
  if (big(a.GetWindow(h, GW_OWNER)) !== host) a.SetWindowLongPtrW(h, GWLP_HWNDPARENT, BigInt.asIntN(64, host));
  return big(a.GetWindow(h, GW_OWNER)) === host;
}

export function detach(win) {
  const a = load();
  if (!a || win.isDestroyed()) return;
  a.SetWindowLongPtrW(hwndOf(win), GWLP_HWNDPARENT, 0n);
}

/** 沉到最底层（仍在桌面之上）。 */
export function sink(win) {
  const a = load();
  if (!a || win.isDestroyed()) return;
  a.SetWindowPos(hwndOf(win), HWND_BOTTOM, 0, 0, 0, 0, SWP_KEEP);
}

/**
 * 鼠标主键现在是否按着；拿不到时返回 null。拖动卡片时用来兜底：
 * 页面偶尔收不到松开事件（比如松开时光标在别的窗口上），不能让卡片一直跟着光标走。
 */
export function primaryButtonDown() {
  const a = load();
  if (!a) return null;
  const swapped = a.GetSystemMetrics(23) !== 0; // SM_SWAPBUTTON：左右键互换
  return (a.GetAsyncKeyState(swapped ? 0x02 : 0x01) & 0x8000) !== 0;
}
