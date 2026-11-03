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

export const HEADER_HEIGHT = 34;
export const CARD_TITLE = { focus: "专注", today: "今日", planner: "规划", schedule: "日程", month: "月历", stats: "统计" };
const MIN_SIZE = {
  focus: { width: 240, height: 96 },
  today: { width: 240, height: 160 },
  planner: { width: 240, height: 200 },
  schedule: { width: 240, height: 240 },
  month: { width: 260, height: 300 },
  stats: { width: 240, height: 220 },
};
const REATTACH_MS = 5000;
const RECREATE_MS = 1500;
const INPUT_CHECK_MS = 500;

/**
 * settings 是设置存储；page 是 card.html 的路径；onChange 在卡片显示/隐藏后调用（刷新托盘菜单）。
 */
export function createCards({ settings, preload, page, icon, onChange = () => {}, onGroupDrag = () => {}, themeId = () => "dark" }) {
  const wins = new Map(); // type → BrowserWindow
  const last = new Map(); // type → 上次已知的外框，用来算改大小前后的差
  const closing = new Set(); // 主动关掉的卡片，关掉后不要重建
  const attending = new Set(); // 番茄钟到点时临时浮到最上面的卡片
  const raised = new Set(); // 因为菜单/打字临时抬高过、还没放回桌面层的卡片
  let applying = 0; // 正在由这里改位置/大小，期间收到的 move/resize 事件不当作用户操作
  let drag = null;
  let hiddenAll = false;
  let quitting = false;
  let reattachTimer = null;
  let inputTimer = null;
  let topHeld = false; // 弹原生对话框时临时取消置顶，别让卡片挡住对话框

  const usable = (w) => w && !w.isDestroyed();
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

  function applyMode(type) {
    const w = wins.get(type);
    if (!usable(w)) return;
    const m = mode();
    const up = attending.has(type);
    w.setAlwaysOnTop((m === "top" && !topHeld) || up, "floating");
    if (m === "desktop") {
      // 不可激活：否则按 Win+D 后卡片成了前台窗口，再按一次就还原不了别的窗口
      w.setFocusable(false);
      // 挂在桌面下面时系统会把它压回去，置顶不住；浮上来期间先摘下来，回去时再挂上
      if (up) {
        desktop.detach(w);
      } else {
        desktop.attach(w);
        if (w.isVisible()) desktop.sink(w);
      }
    } else {
      desktop.detach(w);
      w.setFocusable(true);
    }
  }

  function syncTimer() {
    clearInterval(reattachTimer);
    reattachTimer = null;
    if (mode() !== "desktop") return;
    // Explorer 重启后桌面窗口换了，要重新挂上去
    reattachTimer = setInterval(() => {
      for (const [type, w] of alive()) {
        if (!w.isVisible() || attending.has(type)) continue;
        desktop.attach(w);
        // 菜单关掉的回调偶尔不触发，抬高过的卡片在这里兜底放回去。
        if (raised.has(type) && !desktop.isForeground(w)) {
          leaveRaised(type);
          continue;
        }
        if (!w.isFocused()) desktop.sink(w);
      }
    }, REATTACH_MS);
  }

  function syncInputTimer() {
    clearInterval(inputTimer);
    inputTimer = null;
    if (!desktop.available()) return;
    // 嵌入桌面时卡片不可激活，Chromium 一旦把接鼠标的子窗口藏起来，左键按下就会被系统连带丢掉。
    // 这里定时看一眼，藏了就显示回来（不挂消息回调，所以不会影响别的东西）。别的模式窗口能激活，不用管。
    inputTimer = setInterval(() => {
      if (mode() !== "desktop") return;
      for (const [, w] of alive()) desktop.keepClickable(w);
    }, INPUT_CHECK_MS);
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
    w.setOpacity(s.opacity);
    applyLimits(type);
    place(type, bounds);
    applyMode(type);

    w.webContents.on("will-navigate", (e) => e.preventDefault());
    w.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    w.on("move", () => onMoved(type, w));
    w.on("resize", () => onResized(type, w));
    w.on("blur", () => {
      // 嵌入桌面时为了打字/菜单临时允许激活过，失去焦点后沉回去
      if (mode() !== "desktop" || !usable(w)) return;
      w.setFocusable(false);
      if (attending.has(type)) return;
      if (raised.has(type)) leaveRaised(type);
      else desktop.sink(w);
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
      const intended = closing.delete(type);
      // 不是我们关的（比如嵌入桌面时 Explorer 重启，把挂在它下面的窗口一起销毁了）：过一会儿重建
      if (quitting || intended) return;
      setTimeout(() => {
        if (!quitting && !wins.has(type) && settings.get().cards[type].visible) create(type);
      }, RECREATE_MS);
    });
    w.once("ready-to-show", () => {
      if (hiddenAll || !usable(w)) return;
      w.showInactive();
      if (mode() === "desktop" && !attending.has(type)) desktop.sink(w);
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
      timer: setInterval(dragTick, 16),
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
    resizing = { type, edges: e, start: boundsOf(type), cursor: screen.getCursorScreenPoint(), timer: setInterval(resizeTick, 16) };
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
    if (visible && !usable(w)) {
      create(type);
    } else if (!visible && usable(w)) {
      remember(type);
      closing.add(type);
      w.destroy();
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
      w.showInactive();
      applyMode(type);
    }
    onChange();
  }

  function hideAll() {
    hiddenAll = true;
    dragEnd();
    attending.clear();
    // raised 不清：藏起来再显示时，抬高过的卡片还要靠它放回桌面层
    for (const [, w] of alive()) w.hide();
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
      w.setFocusable(true);
      raised.add(type);
    }
    w.focus();
  }

  /**
   * 把临时抬高过的卡片放回桌面层。0.5.1 起沉底不再隐藏窗口（见 desktop.restore），
   * 所以开关菜单时卡片不会闪；标志位保证只做一次。
   */
  function leaveRaised(type) {
    const w = wins.get(type);
    if (!usable(w) || mode() !== "desktop" || hiddenAll) {
      raised.delete(type);
      return;
    }
    // 卡片正藏着：留着标志，等它重新显示出来再放回桌面层
    if (!w.isVisible()) return;
    raised.delete(type);
    w.setFocusable(false);
    // 别的卡片可能就压在它下面，判断「回到桌面层了」时要认它们。
    const others = alive().filter(([t]) => t !== type).map(([, other]) => other);
    desktop.restore(w, others);
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

  /** 在卡片上弹出原生菜单。嵌入桌面时同样要临时允许激活，否则点别处菜单不会消失。 */
  function popup(type, menu) {
    const w = wins.get(type);
    if (!usable(w)) return;
    const desk = mode() === "desktop";
    if (desk) {
      w.setFocusable(true);
      raised.add(type);
      w.focus();
    }
    menu.popup({
      window: w,
      callback: () => {
        if (!desk) return;
        // 等菜单把焦点还完再收回去；太早改会被菜单关掉时的焦点恢复盖掉。
        setTimeout(() => leaveRaised(type), 150);
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
      for (const [type] of alive()) remember(type);
    },
    /** 改了显示模式后调用。 */
    applyMode() {
      for (const [type] of alive()) applyMode(type);
      syncTimer();
      // 切回嵌入桌面时，把之前抬高过的卡片一并放回去；切到别的模式就不用管了
      if (mode() === "desktop") for (const type of [...raised]) leaveRaised(type);
      else raised.clear();
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
      for (const [, w] of alive()) w.setOpacity(opacity);
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
      if (usable(w) && !w.webContents.isLoading()) w.webContents.send(channel, payload);
    },
  };
}
