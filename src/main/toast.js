// toast.js — 桌面上浮一下就走的小提示（比如「不挡点击已开启」）。
// 窗口本身留在内存里不关：每次提示都重开一个窗口要重新加载页面，第一眼会闪。
// 它透明、不接鼠标、不抢焦点，所以正好压在别的东西上也不碍事。

import { BrowserWindow, screen } from "electron";
import { windowAlive } from "./win.js";

const WIDTH = 360;
const HEIGHT = 76; // 两行：主文案 + 当前快捷键
const GAP = 48; // 离屏幕工作区底部留一点

/**
 * preload 是预加载脚本；page 是 toast.html；themeId 返回当前皮肤 id。
 * 返回的 show 只要给文案，位置、皮肤、时机都在这儿管。
 */
export function createToast({ preload, page, themeId = () => "dark" }) {
  let win = null;
  let timer = null;
  let payload = null;

  function send(target, data) {
    try {
      target.webContents.send("event", { type: "toast", ...data });
    } catch {
      // 页面正在换或者窗口正在消失，下一次提示会补上
    }
  }

  function bounds() {
    // 光标在哪块屏就浮在哪块屏的底部中间
    const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    return {
      x: Math.round(area.x + (area.width - WIDTH) / 2),
      y: Math.round(area.y + area.height - HEIGHT - GAP),
      width: WIDTH,
      height: HEIGHT,
    };
  }

  function create(at) {
    const w = new BrowserWindow({
      ...at,
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
    w.setMenu(null);
    w.setIgnoreMouseEvents(true); // 提示条自己也不挡点击
    w.setAlwaysOnTop(true, "screen-saver");
    w.webContents.on("will-navigate", (e) => e.preventDefault());
    w.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    w.once("ready-to-show", () => {
      if (!windowAlive(w)) return;
      w.showInactive();
      if (payload) send(w, payload);
    });
    w.on("closed", () => {
      if (win === w) win = null;
    });
    w.loadFile(page, { query: { theme: themeId() } });
    return w;
  }

  return {
    /** 浮一条提示。data: { text, on, key, ms, theme }。 */
    show(data) {
      const ms = data.ms ?? 1600;
      payload = { ...data, ms, theme: data.theme || themeId() };
      const at = bounds();
      if (!windowAlive(win)) {
        win = create(at);
      } else {
        win.setBounds(at);
        send(win, payload);
        win.showInactive();
      }
      clearTimeout(timer);
      timer = setTimeout(() => {
        payload = null;
        if (windowAlive(win)) win.hide();
      }, ms);
    },
    /** 页面起来晚了、错过推送时自己来问一次。 */
    ready() {
      if (payload && windowAlive(win)) send(win, payload);
    },
    window: () => win,
    close() {
      clearTimeout(timer);
      payload = null;
    },
  };
}
