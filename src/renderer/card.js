// card.js — 所有卡片共用的部分：顶栏（拖动、折叠、菜单）、任务行、快速新建、提示条。
// 数据全由主进程整理好推过来，这里只管画和把点击转成操作。
// 任务标题来自用户数据，一律用 textContent 写入，不拼 HTML。
// 各卡片在 cards/*.js 里调用 W.define(type, { ... }) 注册自己，boot.js 最后启动。
"use strict";

const W = (() => {
  const $ = (id) => document.getElementById(id);
  const pad2 = (n) => String(n).padStart(2, "0");
  const TYPE = new URLSearchParams(location.search).get("card") || "today";
  const defs = {};

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function button(cls, text, title, onClick) {
    const b = el("button", cls, text);
    if (title) b.title = title;
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      onClick(e);
    });
    return b;
  }

  function clock(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return h ? `${h}:${pad2(m)}:${pad2(s)}` : `${pad2(m)}:${pad2(s)}`;
  }

  function duration(ms) {
    const minutes = Math.round(Math.max(0, ms) / 60000);
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    if (h && m) return `${h} 小时 ${m} 分`;
    if (h) return `${h} 小时`;
    return `${m} 分`;
  }

  /** 距这天 0 点的分钟数 → 「09:30」。一天从几点开始不是 0 时可能超过 24 点。 */
  const minuteLabel = (min) => `${pad2(Math.floor(min / 60) % 24)}:${pad2(min % 60)}`;

  const dayTitle = (label) => [label.rel, label.date, label.weekday].filter(Boolean).join(" ");

  let state = { view: null, error: null, settings: null };
  const pending = new Map(); // id → 乐观显示的 isDone，等 SP 确认
  let toastTimer = null;

  // 两次轮询之间按本机时钟往前推。主进程和页面在同一台机器上，直接用 snapshotAt。
  const sinceSnapshot = () => (state.snapshotAt ? Math.max(0, Date.now() - state.snapshotAt) : 0);

  function toast(message, undo) {
    const box = $("toast");
    box.replaceChildren(el("span", "", message));
    if (undo) {
      box.append(button("link", "撤销", "", () => {
        box.hidden = true;
        undo();
      }));
    }
    box.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (box.hidden = true), undo ? 5000 : 4000);
  }

  /** 发操作；失败时提示原因。 */
  async function act(name, payload) {
    const result = await window.widget.action(name, payload);
    if (result && result.ok === false && name !== "rendered") toast(`没成功：${result.message || "未知错误"}`);
    return result;
  }

  async function toggleDone(item, isDone) {
    pending.set(item.id, isDone);
    render();
    const result = await window.widget.action("setDone", { id: item.id, isDone });
    pending.delete(item.id);
    if (!result?.ok) toast(`没成功：${result?.message || "未知错误"}`);
    else if (isDone) toast(`已完成「${item.title}」`, () => toggleDone(item, false));
    render();
  }
  // ── 任务行：今日、规划、月历共用 ──
  function taskRow(item, { child = false } = {}) {
    const isDone = pending.has(item.id) ? pending.get(item.id) : item.isDone;
    const row = el("div", "row");
    if (child) row.classList.add("child");
    if (isDone) row.classList.add("done");
    if (item.isCurrent) row.classList.add("current");
    if (item.overdueReason) row.classList.add("overdue");
    if (item.upcomingInMin !== null && item.upcomingInMin !== undefined) row.classList.add("upcoming");
    if (pending.has(item.id)) row.classList.add("pending");

    const check = button("check", "", isDone ? "标记为未完成" : "标记为完成", () => toggleDone(item, !isDone));
    check.setAttribute("aria-pressed", String(isDone));
    row.append(check);

    const text = el("div", "text");
    if (item.parentTitle && !child) text.append(el("span", "parent", `${item.parentTitle} › `));
    text.append(el("span", "title", item.title));
    text.title = item.parentTitle ? `${item.parentTitle} › ${item.title}` : item.title;
    row.append(text);

    let meta = "";
    if (item.overdueReason) meta = item.overdueReason;
    else if (item.upcomingInMin !== null && item.upcomingInMin !== undefined) meta = item.upcomingInMin === 0 ? `${item.timeLabel} 到点` : `${item.upcomingInMin} 分钟后`;
    else if (item.timeLabel) meta = item.timeLabel;
    else if (item.subTotal) meta = `${item.subDone}/${item.subTotal}`;
    else if (!isDone && (item.left ?? item.estimate - item.spent) > 0) meta = duration(item.left ?? item.estimate - item.spent);
    if (meta) row.append(el("span", "meta", meta));

    if (item.canTrack || item.isCurrent) {
      row.append(button("play", item.isCurrent ? "❚❚" : "▶", item.isCurrent ? "停止计时" : "开始计时", () =>
        (item.isCurrent ? act("stop") : act("start", { id: item.id }))));
    }
    return row;
  }

  /** 重复任务还没生成的那天：只显示，不能勾选。SP 到那天会自动建出来。 */
  function repeatRow(p) {
    const row = el("div", "row repeat");
    row.title = "重复任务，到那天 SP 会自动创建";
    row.append(el("span", "mark", "↻"));
    row.append(el("div", "text", p.title));
    const meta = p.timeLabel || (p.estimate ? duration(p.estimate) : "");
    if (meta) row.append(el("span", "meta", meta));
    return row;
  }

  function deadlineRow(d) {
    const row = el("div", "row deadline");
    // ⚑ 在 Segoe UI 和雅黑里都没有字形，用感叹号
    row.append(el("span", "mark", "!"));
    const text = el("div", "text");
    if (d.parentTitle) text.append(el("span", "parent", `${d.parentTitle} › `));
    text.append(el("span", "title", d.title));
    row.append(text, el("span", "meta", d.timeLabel ? `${d.timeLabel} 截止` : "截止"));
    return row;
  }

  /** 一天的全部行：未完成、投影、截止，已完成按设置决定显示不显示。 */
  function dayRows(entry) {
    const frag = document.createDocumentFragment();
    const showDone = !!state.settings?.showDone;
    for (const it of entry.items) if (!it.isDone || showDone) frag.append(taskRow(it));
    for (const p of entry.projections) frag.append(repeatRow(p));
    for (const d of entry.deadlines) frag.append(deadlineRow(d));
    return frag;
  }

  function section(cls, label, extra) {
    const box = el("section", `group ${cls}`);
    const head = el("div", "group-head");
    head.append(el("span", "", label));
    if (extra) head.append(extra);
    box.append(head);
    return box;
  }
  // ── 快速新建 ──
  // 输入框打开时卡片照常刷新：重画会换掉输入框，所以输入的内容记在这里，换完再放回去。
  let adding = null; // { key, day, minute, value, fresh }

  function openAdd(key, day, minute = null) {
    if (adding && adding.key === key && adding.minute === minute) {
      adding = null;
    } else {
      adding = { key, day, minute, value: adding?.value || "", fresh: true };
      // 嵌入桌面时卡片平常收不到键盘输入，先让主进程放开
      act("focusInput");
    }
    render(true);
  }

  function addSlot(key) {
    if (!adding || adding.key !== key) return null;
    const box = el("div", "add");
    if (adding.minute !== null) box.append(el("span", "when", minuteLabel(adding.minute)));
    const input = el("input");
    input.dataset.add = "1";
    input.placeholder = "新任务，回车添加，Esc 关闭";
    input.maxLength = 500;
    input.value = adding.value;
    input.addEventListener("input", () => (adding.value = input.value));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        adding = null;
        render(true);
      } else if (e.key === "Enter" && !e.isComposing) {
        e.preventDefault();
        submitAdd(input);
      }
    });
    box.append(input);
    return box;
  }

  async function submitAdd(input) {
    const title = input.value.trim();
    if (!title || !adding) return;
    const { day, minute } = adding;
    input.disabled = true;
    const result = await act("createTask", { title, day, minute });
    input.disabled = false;
    if (result?.ok) {
      // 留着输入框，方便接着加下一条
      if (adding) adding.value = "";
      input.value = "";
      toast(`已添加「${result.data?.title || title}」`);
    }
    input.focus();
  }

  /** 刚打开、或重画前正在输入：把焦点放回新的输入框。 */
  function restoreAddFocus(wasFocused) {
    const input = document.querySelector("input[data-add]");
    if (!input || !(wasFocused || adding?.fresh)) return;
    adding.fresh = false;
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }
  // ── 画面 ──
  const isAdding = (key) => !!adding && adding.key === key;
  const addingMinute = () => adding?.minute ?? null;
  const isDone = (item) => (pending.has(item.id) ? pending.get(item.id) : !!item.isDone);
  const def = () => defs[TYPE] || {};

  // 「今日」卡片只拿到日期字符串，标题在这里算。和 calendar.js 的 dayLabel 一致。
  const WEEKDAY = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
  const REL = new Map([[-1, "昨天"], [0, "今天"], [1, "明天"], [2, "后天"]]);
  function labelOf(day, today = state.view?.today || day) {
    const midnight = (s) => {
      const [y, m, d] = s.split("-").map(Number);
      return new Date(y, m - 1, d);
    };
    const date = midnight(day);
    const diff = Math.round((date - midnight(today)) / 86400_000);
    return { rel: REL.get(diff) ?? null, date: `${date.getMonth() + 1}月${date.getDate()}日`, weekday: WEEKDAY[date.getDay()] };
  }

  const collapsed = () => !!state.collapsed;
  // 卡片能不能画内容：要 SP 数据的卡片没数据时显示连接状态
  const usable = () => !!state.view || def().needsView === false;

  function renderTools() {
    const box = $("tools");
    box.replaceChildren();
    if (collapsed() || !usable() || !def().tools) return;
    for (const t of def().tools(state)) {
      const b = button(`icon${t.wide ? " text" : ""}${t.on ? " on" : ""}`, t.text, t.title, t.click);
      box.append(b);
    }
  }

  function renderSub() {
    const sub = $("sub");
    let text = "";
    if (state.error && !(def().needsView === false && collapsed())) {
      text = state.view ? "连不上 SP，显示的是断开前的数据" : "未连接";
    } else if (usable() && def().sub) {
      text = def().sub(state, collapsed()) || "";
    } else if (!state.view) {
      text = "连接中…";
    }
    if (sub.textContent !== text) sub.textContent = text;
    sub.title = text;
    sub.classList.toggle("warn", !!state.error);
  }

  function renderBanner() {
    const banner = $("banner");
    const show = !!(state.error && state.view);
    banner.hidden = !show;
    if (show) banner.textContent = state.error.message;
  }

  // 不挡点击开着时，卡片上什么也点不动。不说明原因的话，用户只会以为程序卡死了；
  // 但整条横幅太重（每张卡都挂一条），所以只在顶栏留一个禁止符号 + 「不可点击」，
  // 内容压一档，让卡片自己读作背景板。怎么关由主进程那条提示说（带当前快捷键）。
  function renderClickThrough() {
    const s = state.settings || {};
    const on = !!s.clickThrough;
    document.body.classList.toggle("click-through", on);
    $("blocked-mark").title = on ? `不挡点击已开启，鼠标会穿过卡片${s.clickThroughKeyText ? `。按 ${s.clickThroughKeyText} 关掉` : ""}` : "";
  }
  function renderEmpty(body) {
    const box = el("div", "empty");
    box.append(el("p", "", state.error ? state.error.message : "正在连接 Super Productivity…"));
    if (state.error) box.append(button("btn", "重试", "", () => act("refresh")));
    body.append(box);
  }

  function renderFoot() {
    const foot = $("foot");
    const text = usable() && !collapsed() && def().foot ? def().foot(state) || "" : "";
    if (foot.textContent !== text) foot.textContent = text;
    foot.hidden = !text;
  }

  // 卡片按签名决定要不要重画：主进程每 2 秒推一次，内容没变就不动 DOM，滚动位置和悬停都不受影响。
  let signature = "";

  /** force：快速新建开关这类本地变化，签名里看不出来，直接重画。 */
  function render(force = false) {
    const d = def();
    document.body.classList.toggle("collapsed", collapsed());
    document.body.classList.toggle("locked", !!state.settings?.locked);
    document.body.classList.toggle("attention", !!state.attention && TYPE === "focus");
    $("collapse").textContent = collapsed() ? "▸" : "▾";
    $("title").textContent = d.title || "";
    renderTools();
    renderSub();
    renderBanner();
    renderClickThrough();

    const sig = JSON.stringify([
      usable() && d.sig ? d.sig(state) : null,
      !state.view, state.error?.message ?? null, [...pending],
      state.settings?.showDone, collapsed(), adding && [adding.key, adding.minute],
    ]);
    if (force || sig !== signature) {
      signature = sig;
      const body = $("body");
      const wasFocused = document.activeElement?.dataset?.add === "1";
      const scroll = body.scrollTop;
      body.replaceChildren();
      body.classList.toggle("stale", !!(state.error && state.view));
      if (usable()) d.render.call(d, body, state);
      else renderEmpty(body);
      body.scrollTop = scroll;
      // 折叠时 #body 不显示，滚动设不上，等展开再说
      if (usable() && !collapsed() && d.afterRender) d.afterRender(body, state);
      restoreAddFocus(wasFocused);
    }
    renderFoot();
  }

  /** 每秒一次：倒计时、现在线、底栏用时。 */
  function tick() {
    if (!state.settings) return;
    const d = def();
    if (usable() && !collapsed() && d.tick) d.tick.call(d, state);
    if (d.liveSub || state.ticking?.task) renderSub();
    renderFoot();
  }

  const setState = (next) => {
    state = next;
    if (window.WTheme) window.WTheme.apply(next.settings?.themeResolved);
  };
  const define = (type, spec) => (defs[type] = spec);
  // ── 顶栏 ──
  // 拖动交给主进程：它按鼠标位置挪整组吸附在一起的卡片（按住 Alt 只挪这一张），松手时保存位置。
  // 不用 -webkit-app-region: drag，那样右键和双击都会被系统吞掉，也没法整组一起动。
  const head = $("head");
  let dragging = false;

  function endDrag() {
    if (!dragging) return;
    dragging = false;
    window.widget.dragEnd();
  }

  // 番茄钟到点时卡片浮到最上面；在卡片上随便点一下就回原位（点的是按钮也照常生效）
  document.addEventListener("pointerdown", () => {
    if (document.body.classList.contains("attention")) act("ack");
  }, true);

  head.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || e.target.closest("button, input, select")) return;
    head.setPointerCapture(e.pointerId);
    dragging = true;
    window.widget.dragStart(e.altKey);
  });
  head.addEventListener("pointerup", endDrag);
  head.addEventListener("pointercancel", endDrag);
  head.addEventListener("lostpointercapture", endDrag);
  window.addEventListener("blur", endDrag);

  // ── 拉边改大小 ──
  // 系统自带的边框只有几个像素，缩放比例不是 100% 时还偏到窗口外面去，左右两边常常整条都抓不住。
  // 改成在页面里画八个把手：按住之后由主进程按光标位置算尺寸（和拖动一样每 16ms 一次），
  // 到别的卡片共线的边界或者屏幕边上的时候会吸一下，按住 Alt 不吸。
  let resizing = false;
  function endResize() {
    if (!resizing) return;
    resizing = false;
    window.widget.resizeEnd();
  }
  for (const edge of ["n", "s", "e", "w", "ne", "nw", "se", "sw"]) {
    const grip = document.createElement("div");
    grip.className = `hnd h-${edge}`;
    grip.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      grip.setPointerCapture(e.pointerId);
      resizing = true;
      window.widget.resizeStart(edge);
    });
    for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) grip.addEventListener(type, endResize);
    document.body.appendChild(grip);
  }
  window.addEventListener("blur", endResize);

  // 按下时顶栏捕获了指针，双击事件落在 #head 上，不在 #drag 上
  head.addEventListener("dblclick", (e) => {
    if (!e.target.closest("button, input, select")) act("toggleCollapsed");
  });
  $("collapse").addEventListener("click", () => act("toggleCollapsed"));
  // 点完就把焦点还回去：菜单关掉时焦点会落回这个按钮，Chromium 判成键盘焦点，
  // 给 ⋯ 画一圈 outline，看着像按钮一直按着没弹起来。Tab 进来的焦点不受影响。
  $("menu").addEventListener("click", (e) => {
    e.currentTarget.blur();
    act("menu");
  });
  head.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    e.target.closest("button")?.blur();
    act("menu");
  });

  return {
    TYPE, define, el, button, clock, duration, minuteLabel, dayTitle, labelOf,
    act, toggleDone, isDone, sinceSnapshot, taskRow, repeatRow, deadlineRow, dayRows, section, toast,
    openAdd, addSlot, isAdding, addingMinute, render, tick, setState,
  };
})();
