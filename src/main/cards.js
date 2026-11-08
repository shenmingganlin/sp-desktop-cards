// cards.js — 卡片窗口管理：每张卡片一个无边框窗口。负责摆放、拖动吸附、折叠联动、锁定和三种显示模式。
//
// 拖动不用系统的标题栏拖动（-webkit-app-region），因为要整组一起走、还要吸附：
// 页面在顶栏按下鼠标时通知这里，这里每 16ms 读一次光标位置挪窗口，松开时页面再通知一声。
// 位置一律用窗口外框，最小最大尺寸也按外框算。读写都经过 boundsOf / place，见下面「缩放误差」。

import { BrowserWindow, screen } from "electron";
import * as desktop from "./desktop.js";
import { CARD_SIZE, CARD_TYPES } from "./settings.js";
import { boundingBox, defaultSpot, followResize, groupOf, isOnScreen, resizeRect, snapMove } from "./snap.js";
import { backgroundOf } from "./theme.js";
import { windowAlive } from "./win.js";

export const HEADER_HEIGHT = 34;
export const CARD_TITLE = {
  focus: "专注", today: "今日", planner: "规划", schedule: "日程", month: "月历", stats: "统计",
  list: "清单", heatmap: "热力图", triage: "待整理", breakdown: "时间去向",
  finishday: "结束一天", boards: "看板",
};
const MIN_SIZE = {
  focus: { width: 240, height: 96 },
  today: { width: 240, height: 160 },
  planner: { width: 240, height: 200 },
  schedule: { width: 240, height: 240 },
  month: { width: 260, height: 300 },
  stats: { width: 240, height: 220 },
  list: { width: 240, height: 180 },
  heatmap: { width: 260, height: 160 },
  triage: { width: 240, height: 180 },
  breakdown: { width: 240, height: 200 },
  finishday: { width: 240, height: 200 },
  // 矩阵两列，再窄每格就放不下任务标题了
  boards: { width: 320, height: 200 },
};
const REATTACH_MS = 5000;
const RECREATE_MS = 1500;
const INPUT_CHECK_MS = 500;
const SETTLE_MS = 16; // 桌面层多久校一次；16ms 约一帧，点桌面把卡片带起来也看不出来
const FADE_MS = 140; // 显示/隐藏的淡入淡出时长

/**
 * settings 是设置存储；page 是 card.html 的路径；onChange 在卡片显示/隐藏后调用（刷新托盘菜单）。
 */
export function createCards({ settings, preload, page, icon, onChange = () => {}, onGroupDrag = () => {}, themeId = () => "dark" }) {
  const wins = new Map(); // type → BrowserWindow
  const last = new Map(); // type → 上次已知的外框，用来算改大小前后的差
  const closing = new Set(); // 主动关掉的卡片，关掉后不要重建
  const attending = new Set(); // 番茄钟到点时临时浮到最上面的卡片
  const typing = new Set(); // 正在其中打字的卡片（快速新建）；桌面模式下唯一允许激活的情形
  let applying = 0; // 正在由这里改位置/大小，期间收到的 move/resize 事件不当作用户操作
  let drag = null;
  let hiddenAll = false;
  let quitting = false;
  let reattachTimer = null;
  let inputTimer = null;
  let settleTimer = null;
  let topHeld = false; // 弹原生对话框时临时取消置顶，别让卡片挡住对话框

  // 判活走 windowAlive：只看 isDestroyed() 会在「原生窗口已被系统销毁、closed 还没派发」
  // 的那一小段空档里说还能用，随后任何原生调用都抛 "Object has been destroyed"。
  // settle() 每 16ms 一次，空档必中，异常从定时器回调逃出来就是主进程崩溃弹窗。
  // 嵌入桌面时 Explorer 重启会把挂在桌面下面的卡片窗口连带销毁，正是这条路径。
  const usable = (w) => windowAlive(w);
  const alive = () => [...wins].filter(([, w]) => usable(w));
  const workAreas = () => screen.getAllDisplays().map((d) => d.workArea);
  /** 可见卡片的外框，exclude 除外。 */
  const rects = (exclude) => new Map(alive().filter(([t, w]) => t !== exclude && w.isVisible()).map(([t]) => [t, boundsOf(t)]));
  const mode = () => {
    const m = settings.get().mode;
    return m === "desktop" && !desktop.available() ? "normal" : m;
  };

  function quietly(fn) {
    applying += 1;
    try {
      fn();
    } finally {
      applying -= 1;
    }
  }

  // ── 缩放误差 ──
  // 系统缩放不是 100% 时（比如 150%），无边框窗口 getBounds 报的尺寸比 setBounds 设的多一两个像素，
  // setPosition 也会顺带改尺寸。拿报出来的值存下来再设回去，卡片就一次比一次大，拼好的卡片也会错开。
  // 所以记下每张卡片「报的」减「设的」，读的时候扣掉；摆位置一律用 place，带上设的尺寸。
  const skew = new Map(); // type → { x, y, w, h }
  const ZERO = { x: 0, y: 0, w: 0, h: 0 };
  const MAX_SKEW = 4; // 再大就不是取整误差了（比如被最小尺寸卡住），不当误差处理

  function boundsOf(type) {
    const b = wins.get(type).getBounds();
    const k = skew.get(type) || ZERO;
    return { x: b.x - k.x, y: b.y - k.y, width: b.width - k.w, height: b.height - k.h };
  }

  function place(type, r) {
    const w = wins.get(type);
    const target = { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
    quietly(() => w.setBounds(target));
    const b = w.getBounds();
    const k = { x: b.x - target.x, y: b.y - target.y, w: b.width - target.width, h: b.height - target.height };
    skew.set(type, Object.values(k).every((v) => Math.abs(v) <= MAX_SKEW) ? k : ZERO);
    last.set(type, target);
  }

  /** 记下卡片位置。折叠时只记位置和宽度，展开高度保持原值。 */
  function remember(type) {
    const w = wins.get(type);
    if (!usable(w)) return;
    const b = boundsOf(type);
    const c = settings.get().cards[type];
    const height = c.collapsed ? c.bounds?.height ?? CARD_SIZE[type].height : b.height;
    settings.updateCard(type, { bounds: { ...b, height } });
  }

  function shiftBy(moves, persist = true) {
    for (const [t, { dx, dy }] of moves) {
      if (!usable(wins.get(t))) continue;
      const b = boundsOf(t);
      place(t, { ...b, x: b.x + dx, y: b.y + dy });
      if (persist) remember(t);
    }
  }

  function applyLimits(type) {
    const w = wins.get(type);
    const min = MIN_SIZE[type];
    quietly(() => {
      if (settings.get().cards[type].collapsed) {
        w.setMinimumSize(min.width, HEADER_HEIGHT);
        w.setMaximumSize(10000, HEADER_HEIGHT);
      } else {
        w.setMaximumSize(10000, 10000);
        w.setMinimumSize(min.width, min.height);
      }
    });
  }

  /**
   * 桌面模式下，卡片该待的位置只有一个：紧贴桌面窗口上方。
   * 这里是唯一决定这件事的地方——点桌面、Win+D、输入法抢前台、别的程序把栈搅乱、
   * 菜单开关、显示隐藏，全部收敛到这一个判断，没有第二条路径去改 Z 序。
   * 只修不在位置上的：已经在的地方不动，免得每帧重设打断这块区域的重绘。
   */
  function settle() {
    if (mode() !== "desktop" || hiddenAll) return;
    const list = alive();
    const windows = list.map(([, w]) => w);
    for (const [type, w] of list) {
      // 番茄钟浮起来的、正在打字的，本来就要在普通窗口上面，不管
      if (!w.isVisible() || attending.has(type) || typing.has(type)) continue;
      if (!desktop.atDesktopLayer(w, windows)) desktop.toDesktopLayer(w);
    }
  }

  function applyMode(type) {
    const w = wins.get(type);
    if (!usable(w)) return;
    const m = mode();
    // 番茄钟浮起来时要摘掉桌面 owner：owner 是桌面，系统会把它压回桌面那一层。
    // 打字不摘——摘了就得等失焦才挂回来，中途按 Win+D 卡片就不跟着走了。
    const lifted = attending.has(type);
    w.setAlwaysOnTop((m === "top" && !topHeld) || (m === "desktop" && attending.has(type)), "floating");
    if (m === "desktop") {
      // 不可激活：否则按 Win+D 后卡片成了前台窗口，再按一次就还原不了别的窗口。
      // 菜单不需要激活卡片（菜单自己是顶层窗口），只有打字要，由 requestFocus 单独放开。
      w.setFocusable(typing.has(type));
      if (lifted) desktop.detach(w);
      else desktop.attach(w);
    } else {
      desktop.detach(w);
      w.setFocusable(true);
    }
    settle();
  }

  /**
   * 定时器回调的兜底。这些回调每秒要跑几十次，窗口随时可能在系统那边消失；
   * 异常从定时器里逃出去，Electron 就弹「A JavaScript error occurred in the main process」。
   * 窗口消失是正常情况（Explorer 重启就会），不该惊动用户，下一轮自然就恢复了。
   */
  function guard(fn) {
    return () => {
      try {
        fn();
      } catch (error) {
        // 这一轮跳过，下一轮重来。记一笔，destroy-check 靠它确认这条路径真的被测到了：
        // 光看「没崩」不够，兜底的 guard 本身就能把异常吞掉，那样测不出判活有没有修好。
        const log = globalThis.__spwGuardErrors;
        if (Array.isArray(log)) log.push(String(error && error.message));
      }
    };
  }

  // ── 淡入淡出 ──
  // 卡片直接弹出来太生硬，显示和隐藏都走一小段不透明度动画。
  // 窗口本来就是分层的（设置里的不透明度默认 0.95），setOpacity 不动 owner，也不影响桌面层的 Z 序。
  const fades = new Map(); // type → 定时器

  /**
   * 停掉正在跑的补间。runDone 为真时先把它的收尾回调跑掉——
   * 淡出通常挂着一个「关掉这张卡」的回调，被新的补间顶掉时不能把这件事一起丢了。
   */
  function stopFade(type, runDone = false) {
    const fade = fades.get(type);
    if (!fade) return;
    clearInterval(fade.timer);
    fades.delete(type);
    if (runDone) fade.done?.();
  }

  /** 把卡片的不透明度渐变到 to（0~1）。走完了才调 done。 */
  function fadeTo(type, to, done) {
    stopFade(type);
    const w = wins.get(type);
    if (!usable(w)) return;
    const target = Math.max(0, Math.min(1, to));
    const from = w.getOpacity();
    if (Math.abs(target - from) < 0.02) {
      w.setOpacity(target);
      done?.();
      return;
    }
    const started = Date.now();
    const fade = { done, timer: null };
    fade.timer = setInterval(guard(() => {
      const win = wins.get(type);
      if (!usable(win)) return stopFade(type);
      const k = Math.min(1, (Date.now() - started) / FADE_MS);
      win.setOpacity(from + (target - from) * (1 - (1 - k) ** 3)); // 收尾慢一点，比线性自然
      if (k < 1) return;
      stopFade(type);
      done?.();
    }), 16);
    fades.set(type, fade);
  }

  /**
   * 原生菜单关掉之后，渲染进程就不再收到鼠标消息了（嵌入桌面时必现）：
   * 打开菜单那一刻鼠标停在哪儿，那点 hover 就一直亮着——用户看到的就是「⋯ 点完一直高亮」。
   * 补一条合成的鼠标移动，把它移出窗口，让页面自己把 hover 清掉。
   */
  function clearHover(w) {
    if (!usable(w)) return;
    try {
      w.webContents.sendInputEvent({ type: "mouseMove", x: -5, y: -5 });
    } catch {
      // 窗口正在消失，这一下丢了没关系
    }
  }

  function syncTimer() {
    clearInterval(reattachTimer);
    reattachTimer = null;
    clearInterval(settleTimer);
    settleTimer = null;
    if (mode() !== "desktop") return;
    // Explorer 重启后桌面窗口会换，得重新挂上去；顺便校一次位置。
    reattachTimer = setInterval(guard(() => {
      for (const [type, w] of alive()) {
        if (!w.isVisible() || attending.has(type)) continue;
        desktop.attach(w);
      }
      // 打字状态靠 blur 释放，blur 偶尔不触发，这里兜一下
      for (const type of [...typing]) {
        const w = wins.get(type);
        if (usable(w) && w.isFocused()) continue;
        typing.delete(type);
        if (usable(w)) w.setFocusable(false);
      }
      settle();
    }), REATTACH_MS);
    settleTimer = setInterval(guard(settle), SETTLE_MS);
  }

  function syncInputTimer() {
    clearInterval(inputTimer);
    inputTimer = null;
    if (!desktop.available()) return;
    // 嵌入桌面时卡片不可激活，Chromium 一旦把接鼠标的子窗口藏起来，左键按下就会被系统连带丢掉。
    // 这里定时看一眼，藏了就显示回来（不挂消息回调，所以不会影响别的东西）。别的模式窗口能激活，不用管。
    inputTimer = setInterval(guard(() => {
      if (mode() !== "desktop") return;
      for (const [, w] of alive()) desktop.keepClickable(w);
    }), INPUT_CHECK_MS);
  }

  function initialBounds(type) {
    const c = settings.get().cards[type];
    let b = c.bounds && isOnScreen(c.bounds, workAreas()) ? c.bounds : null;
    if (!b) {
      const size = c.bounds ? { width: c.bounds.width, height: c.bounds.height } : CARD_SIZE[type];
      b = defaultSpot(size, [...rects(type).values()], screen.getPrimaryDisplay().workArea);
      settings.updateCard(type, { bounds: b });
    }
    return c.collapsed ? { ...b, height: HEADER_HEIGHT } : b;
  }

  function create(type) {
    const s = settings.get();
    const bounds = initialBounds(type);
    const w = new BrowserWindow({
      ...bounds,
      frame: false,
      // 大小由页面上的把手自己拉（见 resizeStart），系统的边框在缩放比例不对时根本抓不住
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      show: false,
      backgroundColor: backgroundOf(themeId()),
      title: `SP 桌面卡片 · ${CARD_TITLE[type]}`,
      icon,
      // 卡片常年不在前台，嵌入桌面时还被别的窗口盖着；不关节流的话倒计时和提示条的计时器会停。
      // 番茄钟的提示音由卡片页面放，没点过页面也要能响。
      webPreferences: {
        preload, contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false, backgroundThrottling: false,
        autoplayPolicy: "no-user-gesture-required",
      },
    });
    wins.set(type, w);
    w.setMenu(null);
    // 从透明开始，显示的时候再淡进来（见 ready-to-show）
    w.setOpacity(0);
    applyLimits(type);
    place(type, bounds);
    applyMode(type);
    // 不挡点击：只加 WS_EX_TRANSPARENT，不动 owner，也不动 WS_EX_NOACTIVATE，
    // 所以桌面层的 Z 序逻辑和「不可激活」都不受影响（0.7.1 实测）。
    w.setIgnoreMouseEvents(s.clickThrough);

    w.webContents.on("will-navigate", (e) => e.preventDefault());
    w.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    w.on("move", () => onMoved(type, w));
    w.on("resize", () => onResized(type, w));
    w.on("blur", () => {
      // 桌面模式下卡片本来就不该被激活，只有快速新建打字时会；失焦就把可激活还回去。
      if (mode() !== "desktop" || !usable(w) || !typing.has(type)) return;
      typing.delete(type);
      applyMode(type);
    });
    w.on("close", (e) => {
      // Alt+F4 只是隐藏这张卡片
      if (quitting || closing.has(type)) return;
      e.preventDefault();
      setVisible(type, false);
    });
    w.on("closed", () => {
      if (wins.get(type) === w) wins.delete(type);
      last.delete(type);
      attending.delete(type);
      typing.delete(type);
      const intended = closing.delete(type);
      // 不是我们关的（比如嵌入桌面时 Explorer 重启，把挂在它下面的窗口一起销毁了）：过一会儿重建
      if (quitting || intended) return;
      setTimeout(() => {
        if (!quitting && !wins.has(type) && settings.get().cards[type].visible) create(type);
      }, RECREATE_MS);
    });
    w.once("ready-to-show", () => {
      if (hiddenAll || !usable(w)) return;
      w.setOpacity(0); // 隐藏期间设的不透明度不一定会落下去，露面前再钉一次
      w.showInactive();
      settle();
      fadeTo(type, settings.get().opacity);
    });
    w.loadFile(page, { query: { card: type, theme: themeId() } });
    return w;
  }

  function onMoved(type, w) {
    if (applying || drag?.start.has(type) || !usable(w)) return;
    last.set(type, boundsOf(type));
    remember(type);
  }

  // 用户拖边缘改大小：拼在四周的卡片跟着让开或靠拢
  function onResized(type, w) {
    if (!usable(w)) return;
    const after = boundsOf(type);
    const before = last.get(type);
    last.set(type, after);
    if (applying || drag || !before) return;
    if (before.width === after.width && before.height === after.height) return;
    shiftBy(followResize(rects(type), type, before, after));
    remember(type);
  }

  // ── 拖动 ──
  function dragStart(type, alone) {
    if (drag || settings.get().locked || !usable(wins.get(type))) return;
    const all = rects();
    if (!all.has(type)) return;
    const ids = alone ? new Set([type]) : groupOf(all, type);
    const start = new Map([...ids].map((t) => [t, all.get(t)]));
    drag = {
      type,
      start,
      others: [...all].filter(([t]) => !ids.has(t)).map(([, r]) => r),
      box: boundingBox([...start.values()]),
      cursor: screen.getCursorScreenPoint(),
      moved: false,
      timer: setInterval(guard(dragTick), 16),
    };
  }

  function dragTick() {
    if (!drag) return;
    // 兜底：页面没收到松开事件时也要停下
    if (desktop.primaryButtonDown() === false) return dragEnd();
    const p = screen.getCursorScreenPoint();
    let dx = p.x - drag.cursor.x;
    let dy = p.y - drag.cursor.y;
    if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 3) return;
    drag.moved = true;
    const snap = snapMove({ ...drag.box, x: drag.box.x + dx, y: drag.box.y + dy }, drag.others, workAreas());
    dx += snap.dx;
    dy += snap.dy;
    for (const [t, r] of drag.start) if (usable(wins.get(t))) place(t, { ...r, x: r.x + dx, y: r.y + dy });
  }

  function dragEnd() {
    if (!drag) return;
    clearInterval(drag.timer);
    const { start, moved, type } = drag;
    drag = null;
    if (moved) for (const t of start.keys()) remember(t);
    if (moved && start.size > 1) onGroupDrag(type);
  }

  // ── 拉边改大小 ──
  // 不用系统自带的边框：缩放比例不是 100% 时它只有几个像素、还偏到窗口外面去，左右两边常常整条抓不到。
  // 改成页面自己画八个把手（card.js 的 .hnd），按住之后和拖动一样，这里每 16ms 读一次光标算尺寸。
  // 正在动的那条边会吸到别的卡片共线的边或隔一个 GAP 相邻的位置，按住 Alt 不吸。
  let resizing = null;

  function resizeStart(type, edges) {
    if (resizing || drag || settings.get().locked) return;
    const w = wins.get(type);
    if (!usable(w) || !w.isVisible()) return;
    let e = String(edges ?? "").replace(/[^nsew]/g, "");
    if (settings.get().cards[type].collapsed) e = e.replace(/[ns]/g, ""); // 折叠时只有一条顶栏高，上下不给拉
    if (!e) return;
    resizing = { type, edges: e, start: boundsOf(type), cursor: screen.getCursorScreenPoint(), timer: setInterval(guard(resizeTick), 16) };
  }

  function resizeTick() {
    if (!resizing) return;
    if (desktop.primaryButtonDown() === false) return resizeEnd(); // 页面没收到松开事件时兜底
    const p = screen.getCursorScreenPoint();
    const before = last.get(resizing.type) || resizing.start;
    const others = [...rects(resizing.type)];
    const next = resizeRect(resizing.start, resizing.edges, p.x - resizing.cursor.x, p.y - resizing.cursor.y, MIN_SIZE[resizing.type], {
      others: others.map(([, r]) => r),
      workAreas: workAreas(),
      snap: !desktop.altDown(),
    });
    if (before.x === next.x && before.y === next.y && before.width === next.width && before.height === next.height) return;
    place(resizing.type, next);
    // 拼在这条边上的卡片跟着让开或靠拢（一起挪，别每帧写设置）
    shiftBy(followResize(new Map(others), resizing.type, before, next), false);
  }

  function resizeEnd() {
    if (!resizing) return;
    clearInterval(resizing.timer);
    resizing = null;
    for (const [type] of alive()) remember(type);
  }

  // ── 折叠 ──
  function setCollapsed(type, collapsed) {
    const w = wins.get(type);
    const c = settings.get().cards[type];
    if (!usable(w) || c.collapsed === collapsed) return;
    if (!c.collapsed) remember(type); // 先记下展开时的高度
    const before = boundsOf(type);
    const others = rects(type);
    settings.updateCard(type, { collapsed });
    const height = collapsed ? HEADER_HEIGHT : settings.get().cards[type].bounds?.height ?? CARD_SIZE[type].height;
    applyLimits(type);
    place(type, { ...before, height });
    const after = last.get(type);
    shiftBy(followResize(others, type, before, after));
  }

  // ── 显示和隐藏 ──
  function setVisible(type, visible) {
    settings.updateCard(type, { visible });
    const w = wins.get(type);
    if (visible && hiddenAll) {
      showAll(); // 全部藏起来时打开一张：其他的也一起回来
      return;
    }
    if (visible) {
      closing.delete(type); // 淡出到一半又打开：取消掉原来的销毁
      if (!usable(w)) create(type);
      else fadeTo(type, settings.get().opacity);
    } else if (usable(w)) {
      remember(type);
      closing.add(type);
      fadeTo(type, 0, () => usable(w) && w.destroy());
    }
    onChange();
  }

  function showAll() {
    hiddenAll = false;
    const cards = settings.get().cards;
    if (!CARD_TYPES.some((t) => cards[t].visible)) settings.updateCard("today", { visible: true });
    for (const type of CARD_TYPES) {
      if (!settings.get().cards[type].visible) continue;
      const w = wins.get(type);
      if (!usable(w)) {
        create(type);
        continue;
      }
      if (!w.isVisible()) w.setOpacity(0); // 从藏着的状态回来才淡入；本来就露着的不闪
      w.showInactive();
      applyMode(type);
      // 隐藏再显示会把扩展样式重置掉，穿透状态要重新设一遍
      w.setIgnoreMouseEvents(!!settings.get().clickThrough);
      fadeTo(type, settings.get().opacity);
    }
    onChange();
  }

  function hideAll() {
    hiddenAll = true;
    dragEnd();
    attending.clear();
    typing.clear();
    for (const [type, w] of alive()) fadeTo(type, 0, () => usable(w) && w.hide());
    onChange();
  }

  /** 放回默认位置：沿主显示器右边排成一列。 */
  function resetLayout() {
    const area = screen.getPrimaryDisplay().workArea;
    const placed = [];
    for (const type of CARD_TYPES) {
      const w = wins.get(type);
      if (!usable(w)) continue;
      const collapsed = settings.get().cards[type].collapsed;
      const full = CARD_SIZE[type];
      const b = defaultSpot({ width: full.width, height: collapsed ? HEADER_HEIGHT : full.height }, placed, area);
      placed.push(b);
      place(type, b);
      settings.updateCard(type, { bounds: { ...b, height: full.height } });
    }
  }

  // 拔掉显示器或改分辨率后，跑到屏幕外的卡片挪回来
  function rescue() {
    const areas = workAreas();
    for (const [type, w] of alive()) {
      const b = boundsOf(type);
      if (isOnScreen(b, areas)) continue;
      const spot = defaultSpot({ width: b.width, height: b.height }, [...rects(type).values()], screen.getPrimaryDisplay().workArea);
      place(type, spot);
      remember(type);
    }
  }

  /**
   * 需要打字时调用（快速新建）。嵌入桌面时卡片平常不可激活，收不到键盘输入，这里临时放开；
   * 失去焦点后 blur 里再沉回去。用户刚点过这个窗口，系统允许它把自己调到前台。
   */
  function requestFocus(type) {
    const w = wins.get(type);
    if (!usable(w)) return;
    if (mode() === "desktop") {
      typing.add(type);
      applyMode(type);
    }
    w.focus();
  }

  /**
   * 番茄钟到点时让卡片浮到所有窗口上面（不抢焦点），on 为 false 时回到原来的显示方式。
   * 卡片没开或全部隐藏着时不做什么：靠提示音和系统通知。返回卡片是否真的浮上来了。
   */
  function attend(type, on) {
    const w = wins.get(type);
    if (on === attending.has(type)) return on;
    if (on && (hiddenAll || !usable(w) || !w.isVisible())) return false;
    if (on) attending.add(type);
    else attending.delete(type);
    if (!usable(w)) return false;
    applyMode(type);
    if (on) w.moveTop();
    return on;
  }

  /**
   * 在卡片上弹出原生菜单。嵌入桌面时也不用激活卡片：
   * 菜单自己是一个顶层窗口，会浮在普通窗口上面，卡片本身留在桌面层不动。
   */
  function popup(type, menu) {
    const w = wins.get(type);
    if (!usable(w)) return;
    menu.popup({
      window: w,
      callback: () => {
        // 菜单关掉后页面收不到鼠标消息了，停在 ⋯ 上的 hover 会一直亮着
        clearHover(w);
        settle();
      },
    });
  }

  return {
    start() {
      for (const type of CARD_TYPES) if (settings.get().cards[type].visible) create(type);
      syncTimer();
      syncInputTimer();
      screen.on("display-removed", rescue);
      screen.on("display-metrics-changed", rescue);
    },
    quit() {
      quitting = true;
      dragEnd();
      resizeEnd();
      clearInterval(reattachTimer);
      clearInterval(inputTimer);
      clearInterval(settleTimer);
      // 窗口马上就要一起关了，补间直接停掉，不必再补 hide / destroy
      for (const type of [...fades.keys()]) stopFade(type);
      for (const [type] of alive()) remember(type);
    },
    /** 改了显示模式后调用。 */
    applyMode() {
      // 离开桌面模式时，打字的临时状态作废（卡片本来就能激活了）
      if (mode() !== "desktop") typing.clear();
      for (const [type] of alive()) applyMode(type);
      syncTimer();
    },
    effectiveMode: mode,
    setLocked(locked) {
      if (locked) {
        dragEnd();
        resizeEnd();
      }
      // 窗口一直是 resizable: false，锁定时由页面把把手藏起来（它从设置里看到 locked）
    },
    /** 弹原生对话框时临时让卡片别置顶（对话框没有置顶，被卡片挡住就点不到了）。 */
    holdTop(on) {
      topHeld = !!on;
      for (const [type] of alive()) applyMode(type);
    },
    setOpacity(opacity) {
      // 设置里改不透明度：正在淡入淡出的让位，直接落到新值。
      // 淡出到一半被打断时，它挂着的「隐藏 / 销毁」得先执行——
      // 不然卡片会停在半透明状态继续露着，设置里却已经写着不显示。
      for (const [type, w] of alive()) {
        stopFade(type, true);
        if (usable(w)) w.setOpacity(opacity);
      }
    },
    /**
     * 不挡点击：鼠标落在卡片上时穿透到下面去。
     * 三种显示方式都生效——置顶时点到下面的程序，嵌入桌面时点到桌面图标和壁纸。
     * 普通窗口本来就在别的窗口下面，开了也看不出差别，但状态照样保存。
     */
    setClickThrough(on) {
      for (const [, w] of alive()) {
        w.setIgnoreMouseEvents(!!on);
        // 一开穿透，页面就再也收不到鼠标消息，当时停在哪儿的 hover 会一直亮着
        if (on) clearHover(w);
      }
    },
    /** 换皮肤时同步窗口底色，免得改大小的过程中露出旧颜色。 */
    setBackground(color) {
      for (const [, w] of alive()) w.setBackgroundColor(color);
    },
    setVisible,
    setCollapsed,
    showAll,
    hideAll,
    isShown: () => !hiddenAll && alive().some(([, w]) => w.isVisible()),
    resetLayout,
    dragStart,
    dragEnd,
    resizeStart,
    resizeEnd,
    requestFocus,
    popup,
    attend,
    isAttending: (type) => attending.has(type),
    /** 哪张卡片的页面发来的消息；不是卡片返回 null。 */
    typeOf(webContents) {
      for (const [type, w] of alive()) if (w.webContents === webContents) return type;
      return null;
    },
    types: () => alive().map(([type]) => type),
    window: (type) => (usable(wins.get(type)) ? wins.get(type) : null),
    /** 卡片位置（扣掉缩放误差，和设置里存的一致）。 */
    bounds: (type) => (usable(wins.get(type)) ? boundsOf(type) : null),
    send(type, channel, payload) {
      const w = wins.get(type);
      if (!usable(w)) return;
      // webContents 也可能跟着原生窗口一起没了，这里同样要兜住
      try {
        if (!w.webContents.isLoading()) w.webContents.send(channel, payload);
      } catch {
        // 窗口正在消失，这一帧的状态丢了没关系，重建后会再推一次
      }
    },
  };
}
