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
      GetWindowLongPtrW: u.func(`intptr_t GetWindowLongPtrW(${H} h, int i)`),
    };
    const c = koffi.load("comctl32.dll");
    const Proc = koffi.proto(`intptr_t __stdcall SubclassProc(${H} h, uint32_t msg, uintptr_t w, intptr_t l, uintptr_t id, uintptr_t ref)`);
    api.SetWindowSubclass = c.func(`bool __stdcall SetWindowSubclass(${H} h, SubclassProc *proc, uintptr_t id, uintptr_t ref)`);
    api.RemoveWindowSubclass = c.func(`bool __stdcall RemoveWindowSubclass(${H} h, SubclassProc *proc, uintptr_t id)`);
    api.DefSubclassProc = c.func(`intptr_t __stdcall DefSubclassProc(${H} h, uint32_t msg, uintptr_t w, intptr_t l)`);
    api.subclassProc = koffi.register(subclassProc, koffi.pointer(Proc));
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

// ── 左键不被吞 ──
// 用久了 Chromium 有时会把卡片里的 Chrome_RenderWidgetHostHWND 子窗口藏起来（真机上见过，新开的卡片没有），之后点击直接落在顶层窗口上。
// 顶层窗口不可激活时，Chromium 对 WM_MOUSEACTIVATE 回 MA_NOACTIVATEANDEAT：按下那一下被系统丢掉，只剩松开。
// 左键凑不成 click，所以怎么点都没反应；右键菜单是松开时弹的，所以右键好使。
// 这里给卡片窗口挂一个子类过程，改回 MA_NOACTIVATE：照样不激活，但按下照常送给页面。只管这一条消息。
const WM_MOUSEACTIVATE = 0x0021;
const WM_NCDESTROY = 0x0082;
const MA_NOACTIVATE = 3;
const GWL_EXSTYLE = -20;
const WS_EX_NOACTIVATE = 0x08000000n;
const SUBCLASS_ID = 0x5350; // "SP"

function subclassProc(h, msg, w, l, id) {
  if (msg === WM_MOUSEACTIVATE && (big(api.GetWindowLongPtrW(h, GWL_EXSTYLE)) & WS_EX_NOACTIVATE)) return MA_NOACTIVATE;
  if (msg === WM_NCDESTROY) api.RemoveWindowSubclass(h, api.subclassProc, id);
  return api.DefSubclassProc(h, msg, w, l);
}

/** 让不可激活的卡片也能收到左键按下。每个窗口调一次，重复调用无害。 */
export function keepClicks(win) {
  const a = load();
  if (!a || win.isDestroyed()) return false;
  return a.SetWindowSubclass(hwndOf(win), a.subclassProc, SUBCLASS_ID, 0);
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
