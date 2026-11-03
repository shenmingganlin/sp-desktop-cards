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
      IsWindowVisible: u.func(`bool IsWindowVisible(${H} h)`),
      ShowWindow: u.func(`bool ShowWindow(${H} h, int cmd)`),
      GetForegroundWindow: u.func(`${H} GetForegroundWindow()`),
      GetTopWindow: u.func(`${H} GetTopWindow(${H} h)`),
    };
  } catch {
    api = false;
  }
  return api;
}

const GWLP_HWNDPARENT = -8;
const GW_OWNER = 4;
const GW_HWNDNEXT = 2;
const HWND_BOTTOM = 1n;
const SWP_KEEP = 0x0001 | 0x0002 | 0x0010; // NOSIZE | NOMOVE | NOACTIVATE
const SWP_SINK = SWP_KEEP | 0x0200; // + NOOWNERZORDER：卡片 owner 是桌面，少了它 HWND_BOTTOM 会被系统吞掉
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
// 用久了 Chromium 有时会把卡片里接鼠标的子窗口（Chrome_RenderWidgetHostHWND）藏起来（真机上见过，新开的卡片没有），
// 之后点击直接落在不可激活的顶层窗口上，按下那一下被系统连带丢掉，怎么点都没反应；右键是松开时弹菜单的，所以右键好使。
// 0.2.1 试过用 SetWindowSubclass 改 WM_MOUSEACTIVATE 的返回值：点是好了，但 koffi 的 JS 回调会在菜单这种模态消息循环里
// 被重入，主进程直接崩掉（0xC0000005 / 0xC0000409）。所以改成定时把被藏起来的子窗口显示出来：不挂消息回调，点照常送到页面，
// 卡片也照样不抢前台。
const SW_SHOWNOACTIVATE = 4;

/** 卡片里的子窗口被藏起来了就重新显示。调用方按需定时调用；窗口没显示时不动。 */
export function keepClickable(win) {
  const a = load();
  if (!a || win.isDestroyed() || !win.isVisible()) return false;
  const child = big(a.FindWindowExW(hwndOf(win), 0, "Chrome_RenderWidgetHostHWND", null));
  if (!child) return false;
  if (a.IsWindowVisible(child)) return true;
  a.ShowWindow(child, SW_SHOWNOACTIVATE);
  return true;
}

/** 这张卡片现在是不是真正的前台窗口。Electron 的 isFocused 有时会和 Windows 实际状态对不上。 */
export function isForeground(win) {
  const a = load();
  if (!a || win.isDestroyed()) return false;
  return big(a.GetForegroundWindow()) === hwndOf(win);
}

/** 沉到最底层（仍在桌面之上）。 */
export function sink(win) {
  const a = load();
  if (!a || win.isDestroyed()) return;
  a.SetWindowPos(hwndOf(win), HWND_BOTTOM, 0, 0, 0, 0, SWP_KEEP);
}

/**
 * 卡片是不是已经贴着桌面：从卡片往下（GW_HWNDNEXT）走到桌面窗口，中间只有自家的其他卡片。
 * others 是其他卡片窗口的句柄，多张卡片一起拼着的时候每张都在对方上面，不能只认「下一个就是桌面」。
 */
export function isAtDesktopLayer(win, others = []) {
  const a = load();
  if (!a || win.isDestroyed()) return false;
  const host = iconsHost();
  if (!host) return false;
  const own = new Set([hwndOf(win), ...others.filter((o) => o && !o.isDestroyed()).map((o) => hwndOf(o))]);
  let cur = big(a.GetWindow(hwndOf(win), GW_HWNDNEXT));
  let i = 0;
  while (cur && i < 64) {
    if (cur === host) return true;
    if (!own.has(cur)) return false;
    cur = big(a.GetWindow(cur, GW_HWNDNEXT));
    i += 1;
  }
  return false;
}

/**
 * 把被抬高过（打开菜单、临时打字）的卡片放回桌面层。
 * 0.5.1 以前这里是「先 hide、沉底、再 showInactive」：沉底确实稳，但每开关一次菜单卡片都会消失约 70ms，
 * 看起来就是闪一下；菜单开着超过 5 秒时兜底定时器再来一次，还会连闪两下。
 * 现在直接 SetWindowPos(HWND_BOTTOM) 沉底，不隐藏窗口，所以不会闪。沉底被系统吞掉（返回 false 或位置没变）时
 * 才退回到原来的隐藏重显示。
 */
export function restore(win, others = []) {
  const a = load();
  if (!a || win.isDestroyed() || !win.isVisible()) return;
  const h = hwndOf(win);
  a.SetWindowPos(h, HWND_BOTTOM, 0, 0, 0, 0, SWP_SINK);
  if (isAtDesktopLayer(win, others)) return;
  // 沉底没生效：退回「藏一下再显示」，至少把卡片从别的窗口上面弄走。
  win.hide();
  setTimeout(() => {
    if (!a || win.isDestroyed()) return;
    a.SetWindowPos(hwndOf(win), HWND_BOTTOM, 0, 0, 0, 0, SWP_SINK);
    win.showInactive();
  }, 60);
}

/** Alt 现在按着吗。拉边改大小时按住 Alt 不吸附。 */
export function altDown() {
  const a = load();
  if (!a) return false;
  return (a.GetAsyncKeyState(0x12) & 0x8000) !== 0; // VK_MENU
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
