// model.js — 把 SP 原始数据整理成小窗要画的东西。全是纯函数，不碰网络和窗口。
//
// 输入来自三个接口：
//   GET /tasks?tagId=TODAY&includeDone=true  「今日」由 SP 自己判定（含一天从几点算起的偏移）
//   GET /tasks?includeDone=true              全部活动任务：找逾期、查父任务和子任务
//   GET /tags                                TODAY 标签的 taskIds 是 SP 今日视图的排序
// 外加 /task-control/current 和 /focus 两个小接口给当前计时。

export const pad2 = (n) => String(n).padStart(2, "0");

export const isTimestamp = (v) => typeof v === "number" && Number.isFinite(v) && v > 0;
export const isDay = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);

/** 本机时间对应的「工作日」：一天从 dayStartHour 点起算。 */
export function localDay(ms, dayStartHour = 0) {
  const d = new Date(ms - dayStartHour * 3600_000);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 两个 YYYY-MM-DD 相差几天（a - b）。 */
export function dayDiff(a, b) {
  const toUtc = (s) => {
    const [y, m, d] = s.split("-").map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((toUtc(a) - toUtc(b)) / 86400_000);
}

// ── 日期小工具 ──
// 规划、日程、月历、统计、热力图、时间去向都用同一套，别再各写一份：
// 各写一份时改一处漏一处，卡片之间的日期就会错开一天。
export const parseDay = (day) => day.split("-").map(Number);

export function dayStr(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/** YYYY-MM-DD 往后（n 为负往前）挪几天。 */
export function addDays(day, n) {
  const [y, m, d] = parseDay(day);
  return dayStr(new Date(y, m - 1, d + n));
}

/** YYYY-MM-DD 那天 0 点的毫秒数（本机时区）。 */
export function midnightOf(day) {
  const [y, m, d] = parseDay(day);
  return new Date(y, m - 1, d).getTime();
}

/**
 * SP 判定的「今天」是哪一天。SP 不在 REST 里直接给出这个值，
 * 所以先看今日任务里只排了日期的任务（它们的 dueDay 就是 SP 的今天），
 * 没有这样的任务时才用本机时间和设置里的日界推算。
 */
export function resolveToday(todayTasks, now, dayStartHour) {
  const guess = localDay(now, dayStartHour);
  for (const t of todayTasks) {
    if (isTimestamp(t.dueWithTime) || !isDay(t.dueDay)) continue;
    // 只采信「跟本机推算差不多」的那天：TODAY 标签可以挂在别的日期的任务上
    // （手动加标签、或者把日期改到了下周），直接拿第一条的 dueDay 当今天，
    // 逾期判断、规划/日程/月历的起点、番茄钟跨天清零就全错位了。
    if (Math.abs(dayDiff(t.dueDay, guess)) <= 1) return t.dueDay;
  }
  return guess;
}

export function hhmm(ms) {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** 计时显示：1:05:03 / 25:00 */
export function clock(ms) {
  const total = Math.max(0, Math.floor((ms || 0) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h ? `${h}:${pad2(m)}:${pad2(s)}` : `${pad2(m)}:${pad2(s)}`;
}

/** 统计显示：2 小时 15 分 / 40 分 / 0 分 */
export function duration(ms) {
  const minutes = Math.round(Math.max(0, ms || 0) / 60_000);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h && m) return `${h} 小时 ${m} 分`;
  if (h) return `${h} 小时`;
  return `${m} 分`;
}

/** 一个任务还剩多少（毫秒），按它自己的预估减已用。各处卡片共用同一份算法。 */
export const left = (t) => Math.max(0, (t.timeEstimate || 0) - (t.timeSpent || 0));

/** 任务为什么算逾期；不逾期返回 null。 */
function overdueReason(t, today, now) {
  if (isTimestamp(t.dueWithTime) && t.dueWithTime < now) {
    // 带时间的任务按本机日历日比较：「昨天 23:00」比按工作日界算更符合直觉。
    const diff = dayDiff(localDay(t.dueWithTime), localDay(now));
    return diff === 0 ? `${hhmm(t.dueWithTime)} 已过` : dayLabel(diff, hhmm(t.dueWithTime));
  }
  if (!isTimestamp(t.dueWithTime) && isDay(t.dueDay) && dayDiff(t.dueDay, today) < 0) {
    return dayLabel(dayDiff(t.dueDay, today));
  }
  if (isTimestamp(t.deadlineWithTime) && t.deadlineWithTime < now) {
    return `截止 ${hhmm(t.deadlineWithTime)} 已过`;
  }
  if (!isTimestamp(t.deadlineWithTime) && isDay(t.deadlineDay) && dayDiff(t.deadlineDay, today) < 0) {
    return `截止 ${dayLabel(dayDiff(t.deadlineDay, today))}`;
  }
  return null;
}

/** 排序用：从什么时候开始逾期的。只有日期的按那天 0 点算。 */
function overdueSince(t) {
  const dayStart = (s) => {
    const [y, m, d] = s.split("-").map(Number);
    return new Date(y, m - 1, d).getTime();
  };
  if (isTimestamp(t.dueWithTime)) return t.dueWithTime;
  if (isDay(t.dueDay)) return dayStart(t.dueDay);
  if (isTimestamp(t.deadlineWithTime)) return t.deadlineWithTime;
  if (isDay(t.deadlineDay)) return dayStart(t.deadlineDay);
  return 0;
}

function dayLabel(diff, time) {
  const day = diff === -1 ? "昨天" : `${-diff} 天前`;
  return time ? `${day} ${time}` : day;
}

/**
 * 主函数。raw = { todayTasks, allTasks, tags, current, focus, now }，
 * opts = { dayStartHour, upcomingMinutes }。
 */
export function buildView(raw, opts = {}) {
  const now = raw.now ?? Date.now();
  const dayStartHour = opts.dayStartHour ?? 0;
  const upcomingMs = (opts.upcomingMinutes ?? 15) * 60_000;
  const todayTasks = raw.todayTasks || [];
  const allTasks = raw.allTasks || [];
  const byId = new Map();
  for (const t of allTasks) byId.set(t.id, t);
  for (const t of todayTasks) if (!byId.has(t.id)) byId.set(t.id, t);

  const today = resolveToday(todayTasks, now, dayStartHour);
  const todayTag = (raw.tags || []).find((tag) => tag.id === "TODAY");
  const order = new Map((todayTag?.taskIds || []).map((id, i) => [id, i]));
  const currentId = raw.current?.id ?? null;

  const parentTitle = (t) => (t.parentId && byId.get(t.parentId)?.title) || null;
  const childrenOf = (t) => (t.subTaskIds || []).map((id) => byId.get(id)).filter(Boolean);

  const item = (t, extra = {}) => {
    const kids = childrenOf(t);
    return {
      id: t.id,
      title: t.title,
      parentTitle: parentTitle(t),
      isDone: !!t.isDone,
      isCurrent: t.id === currentId,
      timeLabel: isTimestamp(t.dueWithTime) && !extra.overdue ? hhmm(t.dueWithTime) : null,
      dueAt: isTimestamp(t.dueWithTime) ? t.dueWithTime : null,
      estimate: t.timeEstimate || 0,
      spent: t.timeSpent || 0,
      // SP 不让父任务直接计时（会转去第一个子任务），所以有子任务的不给开始按钮。
      canTrack: !t.isDone && kids.length === 0,
      upcomingInMin: null,
      overdueReason: null,
      children: [],
      ...extra,
    };
  };

  // 逾期：所有未完成的活动任务里找，今日列表里过了点的也算。
  const reasons = new Map();
  for (const t of allTasks) {
    if (t.isDone) continue;
    const reason = overdueReason(t, today, now);
    if (reason) reasons.set(t.id, reason);
  }
  const overdueIds = new Set(reasons.keys());
  // 父任务本身逾期时整组挂在父任务下，子任务不再单独列一遍。
  const overdueTop = [...reasons]
    .map(([id]) => byId.get(id))
    .filter((t) => !(t.parentId && overdueIds.has(t.parentId)))
    .map((t) => {
      const entry = item(t, { overdue: true, overdueReason: reasons.get(t.id) });
      entry.children = childrenOf(t).map((c) => item(c));
      entry.overdueSince = overdueSince(t);
      return entry;
    })
    // 逾期最久的排最前。
    .sort((a, b) => a.overdueSince - b.overdueSince);

  // 今日：去掉已经算进逾期的；父任务也在今日里的子任务挂到父任务下面。
  const todaySet = new Set(todayTasks.map((t) => t.id));
  const tops = [];
  for (const t of todayTasks) {
    if (overdueIds.has(t.id) || (t.parentId && overdueIds.has(t.parentId))) continue;
    if (t.parentId && todaySet.has(t.parentId)) continue;
    const entry = item(t);
    entry.children = childrenOf(t)
      .filter((c) => !overdueIds.has(c.id))
      .map((c) => item(c));
    tops.push(entry);
  }

  const rank = (e) => order.get(e.id) ?? Number.MAX_SAFE_INTEGER;
  const byPlan = (a, b) => {
    if (a.dueAt && b.dueAt) return a.dueAt - b.dueAt;
    if (a.dueAt) return -1;
    if (b.dueAt) return 1;
    return rank(a) - rank(b);
  };
  const undone = tops.filter((e) => !e.isDone).sort(byPlan);
  const done = tops.filter((e) => e.isDone).sort(byPlan);

  for (const e of undone) {
    if (e.dueAt && e.dueAt >= now && e.dueAt - now <= upcomingMs) {
      e.upcomingInMin = Math.max(0, Math.ceil((e.dueAt - now) / 60_000));
    }
  }

  // 统计：今天用时按叶子任务累加（父任务的数字已经包含子任务，加两遍会翻倍）。
  let spentToday = 0;
  for (const t of byId.values()) {
    if ((t.subTaskIds || []).length) continue;
    spentToday += t.timeSpentOnDay?.[today] || 0;
  }
  let remaining = 0;
  for (const e of [...undone, ...overdueTop]) {
    const t = byId.get(e.id);
    const kids = childrenOf(t);
    remaining += kids.length ? kids.filter((c) => !c.isDone).reduce((s, c) => s + left(c), 0) : left(t);
  }

  return {
    today,
    now,
    current: currentView(raw.current, byId),
    focus: focusView(raw.focus),
    overdue: overdueTop,
    list: undone,
    done,
    stats: {
      spentToday,
      doneCount: done.length,
      totalCount: done.length + undone.length + overdueTop.length,
      remaining,
    },
    wrapUp: wrapUpView({ undone, done }),
  };
}

/**
 * 收尾菜单要用的两样东西：没做完的、已完成的。
 *
 * 只给「结束这一天」那两项操作提供清单，不算任何统计——
 * 用时、完成数、预估剩余今日卡片底栏本来就有，再算一遍就是两份口径，
 * 迟早会漂（上一版就是这么把同一批数字摆了两处的）。
 *
 * 逾期的任务天然不在「排到明天」里：buildView 上面的分组已经把逾期项从 todayTasks
 * 里摘出去了（`undone` 只剩今日列表那批），逾期项单独在 overdueTop。
 * 这里不再过滤一遍——重复的过滤是死代码，看着像在防什么，其实永远不触发。
 */
function wrapUpView({ undone, done }) {
  const leftOver = undone.map((e) => ({ id: e.id, title: e.title, parentTitle: e.parentTitle }));
  // 归档哪些：就是卡片上「已完成」那一组，所见即所归。
  const doneIds = done.map((e) => e.id);
  return {
    leftOver,
    doneIds,
    isEmpty: leftOver.length === 0 && doneIds.length === 0,
  };
}

function currentView(task, byId) {
  if (!task) return null;
  const parent = task.parentId ? byId.get(task.parentId) : null;
  return {
    id: task.id,
    title: task.title,
    parentTitle: parent?.title || null,
    estimate: task.timeEstimate || 0,
    spent: task.timeSpent || 0,
  };
}

const MODE_LABEL = { Pomodoro: "番茄钟", Flowtime: "心流", Countdown: "倒计时" };

function focusView(focus) {
  const timer = focus?.timer;
  if (!timer || !timer.purpose) return null;
  const isBreak = timer.purpose === "break";
  return {
    mode: focus.mode,
    label: isBreak ? (timer.isLongBreak ? "长休息" : "休息") : (MODE_LABEL[focus.mode] || "专注"),
    cycle: focus.cycle || null,
    status: timer.status,
    isBreak,
    // 心流模式没有终点，只能正计时。
    countUp: focus.mode === "Flowtime" && !isBreak,
    elapsedMs: timer.elapsedMs || 0,
    remainingMs: timer.remainingMs || 0,
    isOvertime: !!timer.isOvertime,
  };
}
