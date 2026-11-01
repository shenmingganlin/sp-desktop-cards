// widget.js — 小窗页面。数据全由主进程整理好推过来，这里只管画和把点击转成操作。
// 任务标题来自用户数据，一律用 textContent 写入，不拼 HTML。
"use strict";

const $ = (id) => document.getElementById(id);
const pad2 = (n) => String(n).padStart(2, "0");

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

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

let state = { view: null, error: null, settings: null };
let listSignature = "";
const pending = new Map(); // id → 乐观显示的 isDone，等 SP 确认
let toastTimer = null;

// 两次轮询之间按本机时钟往前推。主进程和页面在同一台机器上，直接用 snapshotAt。
const sinceSnapshot = () => (state.view ? Math.max(0, Date.now() - state.view.snapshotAt) : 0);

// ── 顶栏：当前计时 ──
function renderNow() {
  const v = state.view;
  const title = $("now-title");
  const sub = $("now-sub");
  const time = $("now-time");
  time.className = "drag";
  $("stop").hidden = !v?.current;

  if (!v) {
    title.textContent = state.error ? "未连接" : "连接中…";
    sub.textContent = "";
    time.textContent = "";
    return;
  }
  sub.classList.toggle("warn", !!state.error);
  if (state.error) {
    // 折叠时看不到下面的提示条，顶栏也要说清楚
    title.textContent = v.current ? v.current.title : "未连接";
    sub.textContent = "连不上 SP，显示的是断开前的数据";
    time.textContent = "";
    return;
  }
  const delta = sinceSnapshot();
  const cur = v.current;
  const focus = v.focus;
  title.textContent = cur ? cur.title : "没有在计时的任务";

  if (focus) {
    const running = v.ticking.focus;
    let ms;
    if (focus.countUp) ms = focus.elapsedMs + (running ? delta : 0);
    else ms = focus.remainingMs - (running ? delta : 0);
    const over = !focus.countUp && ms < 0;
    time.textContent = (over ? "+" : "") + clock(Math.abs(ms));
    time.classList.add(focus.isBreak ? "break" : "focus");
    if (over || focus.isOvertime) time.classList.add("over");
    const parts = [focus.label];
    if (focus.mode === "Pomodoro" && focus.cycle) parts.push(`第 ${focus.cycle} 轮`);
    if (focus.status === "paused") parts.push("已暂停");
    if (cur?.parentTitle) parts.push(cur.parentTitle);
    sub.textContent = parts.join(" · ");
    return;
  }
  if (cur) {
    const spent = cur.spent + (v.ticking.task ? delta : 0);
    if (cur.estimate) {
      const rest = cur.estimate - spent;
      time.textContent = (rest < 0 ? "+" : "") + clock(Math.abs(rest));
      if (rest < 0) time.classList.add("over");
      sub.textContent = [rest < 0 ? "超出预估" : "剩余", cur.parentTitle].filter(Boolean).join(" · ");
    } else {
      time.textContent = clock(spent);
      sub.textContent = ["已用", cur.parentTitle].filter(Boolean).join(" · ");
    }
    return;
  }
  time.textContent = "";
  const next = v.list.find((e) => e.dueAt && e.dueAt >= Date.now());
  sub.textContent = next ? `下一个：${next.timeLabel} ${next.title}` : "";
}

// ── 列表 ──
function itemRow(item, child) {
  const isDone = pending.has(item.id) ? pending.get(item.id) : item.isDone;
  const row = el("div", "row");
  if (child) row.classList.add("child");
  if (isDone) row.classList.add("done");
  if (item.isCurrent) row.classList.add("current");
  if (item.overdueReason) row.classList.add("overdue");
  if (item.upcomingInMin !== null) row.classList.add("upcoming");
  if (pending.has(item.id)) row.classList.add("pending");

  const check = el("button", "check");
  check.title = isDone ? "标记为未完成" : "标记为完成";
  check.setAttribute("aria-pressed", String(isDone));
  check.addEventListener("click", () => toggleDone(item, !isDone));
  row.append(check);

  const text = el("div", "text");
  if (item.parentTitle && !child) text.append(el("span", "parent", `${item.parentTitle} › `));
  text.append(el("span", "title", item.title));
  text.title = item.parentTitle ? `${item.parentTitle} › ${item.title}` : item.title;
  row.append(text);

  let meta = "";
  if (item.overdueReason) meta = item.overdueReason;
  else if (item.upcomingInMin !== null) meta = item.upcomingInMin === 0 ? `${item.timeLabel} 到点` : `${item.upcomingInMin} 分钟后`;
  else if (item.timeLabel) meta = item.timeLabel;
  else if (item.estimate && !isDone) meta = duration(Math.max(0, item.estimate - item.spent));
  if (meta) row.append(el("span", "meta", meta));

  if (item.canTrack || item.isCurrent) {
    const play = el("button", "play", item.isCurrent ? "❚❚" : "▶");
    play.title = item.isCurrent ? "停止计时" : "开始计时";
    play.addEventListener("click", () => (item.isCurrent ? act("stop") : act("start", { id: item.id })));
    row.append(play);
  }
  return row;
}

function group(items) {
  const frag = document.createDocumentFragment();
  for (const item of items) {
    frag.append(itemRow(item, false));
    for (const c of item.children) frag.append(itemRow(c, true));
  }
  return frag;
}

function section(cls, label, items, extra) {
  const box = el("section", `group ${cls}`);
  const head = el("div", "group-head");
  head.append(el("span", "", label));
  if (extra) head.append(extra);
  box.append(head);
  if (items) box.append(group(items));
  return box;
}

function renderLists() {
  const v = state.view;
  const lists = $("lists");
  const sig = JSON.stringify([v && [v.overdue, v.list, v.done], [...pending], state.settings?.showDone, !!state.error, !v]);
  if (sig === listSignature) return;
  listSignature = sig;
  lists.replaceChildren();
  lists.classList.toggle("stale", !!(state.error && v));

  if (!v) {
    const box = el("div", "empty");
    box.append(el("p", "", state.error ? state.error.message : "正在连接 Super Productivity…"));
    if (state.error) {
      const retry = el("button", "btn", "重试");
      retry.addEventListener("click", () => act("refresh"));
      box.append(retry);
    }
    lists.append(box);
    return;
  }

  if (v.overdue.length) lists.append(section("overdue", `逾期 ${v.overdue.length}`, v.overdue));
  if (v.list.length) lists.append(section("today", "今日", v.list));
  else if (!v.overdue.length && !v.done.length) {
    const empty = el("div", "empty");
    empty.append(el("p", "", "今天还没有安排任务。"));
    lists.append(empty);
  }
  if (v.done.length) {
    const showDone = !!state.settings?.showDone;
    const toggle = el("button", "link", showDone ? "收起" : "展开");
    toggle.addEventListener("click", () => act("saveSettings", { showDone: !showDone }));
    lists.append(section("done-group", `已完成 ${v.done.length}`, showDone ? v.done : null, toggle));
  }
}

function renderStats() {
  const v = state.view;
  const footer = $("stats");
  if (!v) {
    footer.textContent = "";
    return;
  }
  const s = v.stats;
  const spent = s.spentToday + (v.ticking.task ? sinceSnapshot() : 0);
  const parts = [`今日已用 ${duration(spent)}`, `完成 ${s.doneCount}/${s.totalCount}`];
  if (s.remaining) parts.push(`预估剩余 ${duration(s.remaining)}`);
  footer.textContent = parts.join(" · ");
}

function renderBanner() {
  const banner = $("banner");
  const show = !!(state.error && state.view);
  banner.hidden = !show;
  if (show) banner.textContent = state.error.message;
}

function render() {
  document.body.classList.toggle("collapsed", !!state.settings?.collapsed);
  $("collapse").textContent = state.settings?.collapsed ? "▸" : "▾";
  renderNow();
  renderBanner();
  renderLists();
  renderStats();
  renderSettings();
}

// ── 操作 ──
async function act(name, payload) {
  const result = await window.widget.action(name, payload);
  if (result && result.ok === false && ["start", "stop"].includes(name)) toast(`没成功：${result.message}`);
  return result;
}

async function toggleDone(item, isDone) {
  pending.set(item.id, isDone);
  render();
  const result = await window.widget.action("setDone", { id: item.id, isDone });
  pending.delete(item.id);
  if (!result?.ok) {
    toast(`没成功：${result?.message || "未知错误"}`);
  } else if (isDone) {
    toast(`已完成「${item.title}」`, () => toggleDone(item, false));
  }
  render();
}

function toast(message, undo) {
  const box = $("toast");
  box.replaceChildren(el("span", "", message));
  if (undo) {
    const btn = el("button", "link", "撤销");
    btn.addEventListener("click", () => {
      box.hidden = true;
      undo();
    });
    box.append(btn);
  }
  box.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (box.hidden = true), undo ? 5000 : 4000);
}

$("collapse").addEventListener("click", () => act("toggleCollapsed"));
$("stop").addEventListener("click", () => act("stop"));
$("open-sp").addEventListener("click", () => act("openSp"));
$("hide").addEventListener("click", () => act("hide"));
$("bar").addEventListener("dblclick", (e) => {
  if (e.target.closest(".drag")) act("toggleCollapsed");
});
$("toggle-settings").addEventListener("click", () => {
  $("settings").hidden = !$("settings").hidden;
  renderSettings();
  if (state.settings?.collapsed && !$("settings").hidden) act("toggleCollapsed");
});

// ── 设置面板 ──
// 面板只在第一次打开时建一次，之后只同步数值，避免轮询把正在输入的内容冲掉。
const TOKEN_TEXT = {
  auto: "已自动读取 SP 的令牌。",
  manual: "正在使用手填的令牌。",
  env: "正在使用环境变量里的令牌。",
  none: "还没找到令牌。",
};

function field(label, input, hint) {
  const row = el("label", "field");
  row.append(el("span", "field-label", label), input);
  if (hint) row.append(el("span", "hint", hint));
  return row;
}

function buildSettings() {
  const box = $("settings");
  box.replaceChildren();
  const save = (patch) => act("saveSettings", patch);

  const opacity = el("input");
  Object.assign(opacity, { type: "range", min: "30", max: "100", step: "5", id: "set-opacity" });
  opacity.addEventListener("input", () => save({ opacity: Number(opacity.value) / 100 }));

  const onTop = el("input");
  Object.assign(onTop, { type: "checkbox", id: "set-ontop" });
  onTop.addEventListener("change", () => save({ alwaysOnTop: onTop.checked }));

  const login = el("input");
  Object.assign(login, { type: "checkbox", id: "set-login" });
  login.addEventListener("change", () => save({ openAtLogin: login.checked }));

  const upcoming = el("input");
  Object.assign(upcoming, { type: "number", min: "0", max: "240", id: "set-upcoming" });
  upcoming.addEventListener("change", () => save({ upcomingMinutes: Number(upcoming.value) }));

  const dayStart = el("input");
  Object.assign(dayStart, { type: "number", min: "0", max: "23", id: "set-daystart" });
  dayStart.addEventListener("change", () => save({ dayStartHour: Number(dayStart.value) }));

  const tokenInput = el("input");
  Object.assign(tokenInput, { type: "password", placeholder: "32 位令牌，留空表示自动读取", id: "set-token", autocomplete: "off" });
  const tokenSave = el("button", "btn", "保存令牌");
  const tokenState = el("span", "hint", "");
  tokenState.id = "set-token-state";
  tokenSave.addEventListener("click", async () => {
    const result = await act("setToken", { token: tokenInput.value });
    tokenInput.value = "";
    if (!result?.ok) toast(result?.message || "没保存成功");
  });
  const tokenRow = el("div", "token-row");
  tokenRow.append(tokenInput, tokenSave);

  const close = el("button", "btn", "完成");
  close.addEventListener("click", () => (box.hidden = true));

  box.append(
    el("h2", "", "设置"),
    field("不透明度", opacity),
    field("始终置顶", onTop),
    field("开机启动", login, "只对安装版生效。"),
    field("提前几分钟高亮", upcoming, "带具体时间的任务，开始前这么多分钟变成橙色。0 表示不高亮。"),
    field("一天从几点开始", dayStart, "和 SP「下一天的开始时间」保持一致，用来统计今日用时。"),
    el("div", "field-label", "访问令牌"),
    tokenRow,
    tokenState,
    close,
  );
  box.dataset.built = "1";
}

function renderSettings() {
  const box = $("settings");
  const s = state.settings;
  if (!s || box.hidden) return;
  if (!box.dataset.built) buildSettings();
  const sync = (id, prop, value) => {
    const input = $(id);
    if (document.activeElement !== input) input[prop] = value;
  };
  sync("set-opacity", "value", String(Math.round(s.opacity * 100)));
  sync("set-ontop", "checked", s.alwaysOnTop);
  sync("set-login", "checked", s.openAtLogin);
  sync("set-upcoming", "value", String(s.upcomingMinutes));
  sync("set-daystart", "value", String(s.dayStartHour));
  $("set-token-state").textContent = TOKEN_TEXT[s.tokenSource] || "";
}

// 首次画出数据、以及每次折叠状态变化后告诉主进程一声（自检截图要等这个）。
let renderedKey = null;
window.widget.onState((next) => {
  state = next;
  render();
  const key = next.view ? String(!!next.settings?.collapsed) : null;
  if (key !== null && key !== renderedKey) {
    renderedKey = key;
    requestAnimationFrame(() => requestAnimationFrame(() => act("rendered")));
  }
});
setInterval(() => {
  renderNow();
  renderStats();
}, 1000);
