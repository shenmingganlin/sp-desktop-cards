// desktop.js — 「嵌入桌面」模式：卡片贴着桌面图标那一层，按 Win+D 显示桌面时跟着上来。
//
// 做法（原型在 Windows 11 26300 上验证过）：
//   1. 找到放桌面图标的窗口：24H2 起是 Progman，之前是包含 SHELLDLL_DefView 的 WorkerW（同 Rainmeter）。
//   2. 把卡片窗口的「所有者」设为它（GWLP_HWNDPARENT）。显示桌面时系统把桌面提到前面，被它拥有的窗口跟着上来。
//   3. 卡片设为不可激活：否则按 Win+D 后卡片会被激活成前台窗口，再按一次就还原不了别的窗口。
//
// 这个文件只提供两个「怎么放」的原语，不判断「什么时候放」——那是 cards.js 的 settle() 的事：
//   attach / detach     卡片跟不跟随桌面（跟随桌面 = 能被 Win+D 带上来）
//   toDesktopLayer      把卡片摆到桌面层该在的 Z 序位置
//   atDesktopLayer      它现在在不在那儿
// 之所以只留这两个：卡片的 owner 是桌面，Windows 把「桌面 + 所有卡片」当成一个 Z 序组，
// 任何一次 SetWindowPos 都是改组内顺序而不是动一张卡。把判断收敛到一个地方，才不会互相打架。

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
    };
  } catch {
    api = false;
  }
  return api;
}

const GWLP_HWNDPARENT = -8;
const GW_OWNER = 4;
const GW_HWNDNEXT = 2;
const GW_HWNDPREV = 3;
const HWND_TOP = 0;
const SWP_KEEP = 0x0001 | 0x0002 | 0x0010; // NOSIZE | NOMOVE | NOACTIVATE
// + NOOWNERZORDER：卡片 owner 是桌面，少了它 SetWindowPos 会被系统吞掉（静默不动）。
const SWP_SINK = SWP_KEEP | 0x0200;
const big = (v) => BigInt(v || 0);

export const available = () => !!load();

const hwndOf = (win) => {
  const buf = win.getNativeWindowHandle();
  return buf.length >= 8 ? buf.readBigUInt64LE(0) : BigInt(buf.readUInt32LE(0));
};

// 桌面窗口句柄缓存：settle() 每 16ms 问一次，每次现查要发好几次 FindWindowExW。
// Explorer 重启后句柄会变，靠 TTL 兜住（attach() 也会刷新）。
let hostCache = 0n;
let hostAt = 0;
const HOST_TTL = 1000;

/** 放桌面图标的窗口；Explorer 没在运行时返回 0n。 */
function iconsHost() {
  const a = load();
  if (!a) return 0n;
  const now = Date.now();
  if (hostCache && now - hostAt < HOST_TTL) return hostCache;
  const shell = big(a.GetShellWindow());
  if (!shell) return 0n;
  let host = shell;
  if (!a.FindWindowExW(shell, 0, "SHELLDLL_DefView", "")) {
    let w = 0n;
    while ((w = big(a.FindWindowExW(0, w, "WorkerW", "")))) {
      if (a.FindWindowExW(w, 0, "SHELLDLL_DefView", "")) {
        host = w;
        break;
      }
    }
  }
  hostCache = host;
  hostAt = now;
  return host;
}

/** 挂到桌面下面。返回是否挂好了；已经挂好时什么也不做（Explorer 重启后定时调一次即可重新挂）。 */
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

/**
 * 把卡片摆到桌面层该在的位置：紧贴在桌面窗口正上方。
 * shell 平时在 Z 序最底下，插到它上方 = 在所有普通窗口下面；
 * 按 Win+D 把 shell 抬起来时同样插到它上方，卡片就跟着上来了——两种情形同一条规则，不用特判。
 * 已经贴着就不动：每帧重设会打断这块区域的重绘。
 */
export function toDesktopLayer(win) {
  const a = load();
  if (!a || win.isDestroyed()) return;
  const shell = big(a.GetShellWindow());
  if (!shell) return;
  const h = hwndOf(win);
  const above = big(a.GetWindow(shell, GW_HWNDPREV)); // shell 正上方那个窗口
  if (above === h) return;
  a.SetWindowPos(h, above ? BigInt.asIntN(64, above) : BigInt(HWND_TOP), 0, 0, 0, 0, SWP_SINK);
}

/**
 * 卡片是不是已经贴着桌面：从卡片往下（GW_HWNDNEXT）走到桌面窗口，中间只有自家的其他卡片。
 * others 是其他卡片窗口，几张拼在一起时每张都在对方上面，不能只认「下一个就是桌面」。
 */
export function atDesktopLayer(win, others = []) {
  const a = load();
  if (!a || win.isDestroyed()) return false;
  const host = iconsHost();
  if (!host) return false;
  const own = new Set([hwndOf(win)]);
  for (const o of others) if (o && !o.isDestroyed()) own.add(hwndOf(o));
  let cur = big(a.GetWindow(hwndOf(win), GW_HWNDNEXT));
  for (let i = 0; cur && i < 64; i += 1) {
    if (cur === host) return true;
    if (!own.has(cur)) return false;
    cur = big(a.GetWindow(cur, GW_HWNDNEXT));
  }
  return false;
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
