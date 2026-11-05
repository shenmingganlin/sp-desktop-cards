// calendar.js — 规划、日程、月历三张卡片的数据整理。全是纯函数。
//
// SP 的规划表里，任务属于哪天由 dueWithTime（有具体时间）或 dueDay 决定。
// 重复任务还没生成实例的日子，用 repeat.js 照 SP 的规则算出「投影」，只算今天和以后：
// 过去漏掉的日子 SP 不会补建，显示出来反而误导。
// 日历事件（iCal/CalDAV）REST API 不提供，这里没有。

import { addDays, dayStr, hhmm, isDay, isTimestamp, left, localDay, midnightOf, pad2, parseDay, resolveToday } from "./model.js";
import { getRepeatDueWithTime, getTaskRepeatCfgsForExactDay, isValidSplitTime } from "./repeat.js";

const MIN = 60_000;
const WEEKDAY = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const REL = new Map([[-1, "昨天"], [0, "今天"], [1, "明天"], [2, "后天"]]);

// 日期小工具在 model.js：规划、日程、月历、统计、热力图用的是同一套。
// 这里再导出一遍 addDays，日历相关的东西从 calendar.js 拿得到，调用方不用记它住在哪。
export { addDays };

const diffDays = (a, b) => Math.round((midnightOf(a) - midnightOf(b)) / 86400_000);

/** 卡片上的日期标题：{ rel: "明天" | null, date: "11月3日", weekday: "周二" } */
export function dayLabel(day, today) {
  const [y, m, d] = parseDay(day);
  return { rel: REL.get(diffDays(day, today)) ?? null, date: `${m}月${d}日`, weekday: WEEKDAY[new Date(y, m - 1, d).getDay()] };
}

/** 公共部分：今天是哪天、按天分好的任务和截止日、有效的重复配置。 */
function context(raw, opts) {
  const dayStartHour = opts.dayStartHour ?? 0;
  const now = raw.now ?? Date.now();
  const byId = new Map();
  for (const t of raw.allTasks || []) byId.set(t.id, t);
  const byDay = new Map();
  const deadlines = new Map();
  const push = (map, day, t) => {
    if (!map.has(day)) map.set(day, []);
    map.get(day).push(t);
  };
  for (const t of byId.values()) {
    const due = isTimestamp(t.dueWithTime) ? localDay(t.dueWithTime, dayStartHour) : isDay(t.dueDay) ? t.dueDay : null;
    if (due) push(byDay, due, t);
    if (t.isDone) continue;
    const dl = isTimestamp(t.deadlineWithTime) ? localDay(t.deadlineWithTime, dayStartHour) : isDay(t.deadlineDay) ? t.deadlineDay : null;
    if (dl) push(deadlines, dl, t);
  }
  // GET /projects 只返回没归档的项目；归档项目的重复配置 SP 也不再生成（selectActiveTaskRepeatCfgs）。
  const projectIds = new Set((raw.projects || []).map((p) => p.id));
  const cfgs = (raw.repeatCfgs || []).filter((c) => !c.projectId || !projectIds.size || projectIds.has(c.projectId));
  const todayTag = (raw.tags || []).find((tag) => tag.id === "TODAY");
  return {
    dayStartHour,
    now,
    today: resolveToday(raw.todayTasks || [], now, dayStartHour),
    byId,
    byDay,
    deadlines,
    cfgs,
    currentId: raw.current?.id ?? null,
    todayOrder: new Map((todayTag?.taskIds || []).map((id, i) => [id, i])),
  };
}

function taskItem(ctx, t) {
  const kids = (t.subTaskIds || []).map((id) => ctx.byId.get(id)).filter(Boolean);
  const at = isTimestamp(t.dueWithTime) ? t.dueWithTime : null;
  return {
    id: t.id,
    kind: "task",
    title: t.title,
    parentTitle: (t.parentId && ctx.byId.get(t.parentId)?.title) || null,
    isDone: !!t.isDone,
    isCurrent: t.id === ctx.currentId,
    at,
    timeLabel: at ? hhmm(at) : null,
    estimate: t.timeEstimate || 0,
    spent: t.timeSpent || 0,
    // 有子任务时按子任务算剩余，父任务自己的数字已经包含了子任务
    left: t.isDone ? 0 : kids.length ? kids.filter((c) => !c.isDone).reduce((s, c) => s + left(c), 0) : left(t),
    canTrack: !t.isDone && kids.length === 0,
    subDone: kids.filter((c) => c.isDone).length,
    subTotal: kids.length,
    isRepeat: !!t.repeatCfgId,
  };
}

function projectionsFor(ctx, day, dayTasks) {
  if (day < ctx.today) return [];
  // 这天已经有真实实例的重复配置不再投影（SP #8220）
  const covered = new Set(dayTasks.map((t) => t.repeatCfgId).filter(Boolean));
  const midnight = midnightOf(day);
  const out = [];
  for (const cfg of ctx.cfgs) {
    if (covered.has(cfg.id)) continue;
    let hit = false;
    try {
      hit = getTaskRepeatCfgsForExactDay([cfg], midnight).length > 0;
    } catch {
      // 日期字段坏掉的配置跳过，不影响其他
    }
    if (!hit) continue;
    const at = isValidSplitTime(cfg.startTime) ? getRepeatDueWithTime(cfg.startTime, midnight, ctx.dayStartHour * 3600_000) : null;
    out.push({
      id: `repeat:${cfg.id}:${day}`,
      kind: "repeat",
      cfgId: cfg.id,
      title: cfg.title || "重复任务",
      at,
      timeLabel: at ? hhmm(at) : null,
      estimate: cfg.defaultEstimate || 0,
    });
  }
  return out.sort((a, b) => (a.at ?? Infinity) - (b.at ?? Infinity));
}

/** 某一天的全部内容，规划、日程、月历共用。 */
function dayEntry(ctx, day) {
  const tasks = ctx.byDay.get(day) || [];
  const ids = new Set(tasks.map((t) => t.id));
  // 父任务也在这天的，子任务不单列
  const tops = tasks.filter((t) => !(t.parentId && ids.has(t.parentId)));
  const rank = (e) => (day === ctx.today ? ctx.todayOrder.get(e.id) : undefined) ?? Number.MAX_SAFE_INTEGER;
  const byPlan = (a, b) => {
    if (a.at && b.at) return a.at - b.at;
    if (a.at) return -1;
    if (b.at) return 1;
    return rank(a) - rank(b);
  };
  const items = tops.map((t) => taskItem(ctx, t));
  const undone = items.filter((e) => !e.isDone).sort(byPlan);
  const done = items.filter((e) => e.isDone).sort(byPlan);
  const projections = projectionsFor(ctx, day, tasks);
  const deadlines = (ctx.deadlines.get(day) || []).map((t) => ({
    id: t.id,
    title: t.title,
    parentTitle: (t.parentId && ctx.byId.get(t.parentId)?.title) || null,
    timeLabel: isTimestamp(t.deadlineWithTime) ? hhmm(t.deadlineWithTime) : null,
  }));
  return {
    day,
    label: dayLabel(day, ctx.today),
    isToday: day === ctx.today,
    isPast: day < ctx.today,
    items: [...undone, ...done],
    projections,
    deadlines,
    remaining: undone.reduce((s, e) => s + e.left, 0) + projections.reduce((s, p) => s + p.estimate, 0),
    doneCount: done.length,
    totalCount: items.length + projections.length,
  };
}

/** 规划卡片：从今天起 days 天。 */
export function buildPlanner(raw, opts = {}) {
  const ctx = context(raw, opts);
  const days = Math.max(1, opts.days ?? 7);
  return { today: ctx.today, days: Array.from({ length: days }, (_, i) => dayEntry(ctx, addDays(ctx.today, i))) };
}

/** 重叠的块分到并排的几列：lane 是第几列，lanes 是这一簇一共几列。 */
export function assignLanes(blocks) {
  const sorted = [...blocks].sort((a, b) => a.start - b.start || b.end - a.end);
  let cluster = [];
  let laneEnds = [];
  let clusterEnd = -Infinity;
  const flush = () => {
    for (const b of cluster) b.lanes = laneEnds.length;
    cluster = [];
    laneEnds = [];
  };
  for (const b of sorted) {
    if (b.start >= clusterEnd) flush();
    let lane = laneEnds.findIndex((end) => end <= b.start);
    if (lane < 0) {
      lane = laneEnds.length;
      laneEnds.push(b.end);
    } else {
      laneEnds[lane] = b.end;
    }
    b.lane = lane;
    cluster.push(b);
    clusterEnd = Math.max(clusterEnd, b.end);
  }
  flush();
  return sorted;
}

/**
 * 日程卡片：某天的时间轴。块的位置用「距这天 0 点的分钟数」表示，
 * 一天从几点开始不是 0 时，凌晨的任务可能超过 24*60。
 * SP 会把没定时间的任务自动排进空档，这里不做，它们放在「未定时」里。
 */
export function buildSchedule(raw, opts = {}) {
  const ctx = context(raw, opts);
  const day = opts.day && isDay(opts.day) ? opts.day : ctx.today;
  const entry = dayEntry(ctx, day);
  const midnight = midnightOf(day);
  const toMin = (ms) => Math.round((ms - midnight) / MIN);
  const blocks = [];
  for (const it of entry.items) {
    if (!it.at) continue;
    let dur = it.isDone ? it.estimate || it.spent : it.left || it.estimate;
    const noEstimate = !dur;
    dur = Math.max(15 * MIN, dur || 30 * MIN);
    blocks.push({ ...it, start: it.at, end: it.at + dur, noEstimate });
  }
  for (const p of entry.projections) {
    if (!p.at) continue;
    blocks.push({ ...p, start: p.at, end: p.at + Math.max(15 * MIN, p.estimate || 30 * MIN), noEstimate: !p.estimate });
  }
  const laid = assignLanes(blocks).map((b) => ({ ...b, startMin: toMin(b.start), endMin: toMin(b.end), endLabel: hhmm(b.end) }));

  const maxMin = 24 * 60 + ctx.dayStartHour * 60;
  let rangeStart = (opts.startHour ?? 8) * 60;
  let rangeEnd = (opts.endHour ?? 22) * 60;
  for (const b of laid) {
    rangeStart = Math.min(rangeStart, Math.floor(b.startMin / 60) * 60);
    rangeEnd = Math.max(rangeEnd, Math.ceil(b.endMin / 60) * 60);
  }
  return {
    ...entry,
    midnight,
    rangeStart: Math.max(0, rangeStart),
    rangeEnd: Math.min(maxMin, Math.max(rangeEnd, rangeStart + 60)),
    blocks: laid,
    untimed: [...entry.items.filter((e) => !e.at), ...entry.projections.filter((p) => !p.at)],
  };
}

/** 月历卡片：周一开头的 6 行网格，加上选中那天的内容。 */
export function buildMonth(raw, opts = {}) {
  const ctx = context(raw, opts);
  const month = /^\d{4}-\d{2}$/.test(opts.month || "") ? opts.month : ctx.today.slice(0, 7);
  const [y, m] = month.split("-").map(Number);
  const lead = (new Date(y, m - 1, 1).getDay() + 6) % 7;
  const first = dayStr(new Date(y, m - 1, 1 - lead));
  const selected = opts.selected && isDay(opts.selected) ? opts.selected : ctx.today;
  const cells = Array.from({ length: 42 }, (_, i) => {
    const day = addDays(first, i);
    const e = dayEntry(ctx, day);
    return {
      day,
      date: Number(day.slice(8)),
      inMonth: day.slice(0, 7) === month,
      isToday: day === ctx.today,
      isPast: day < ctx.today,
      isSelected: day === selected,
      undone: e.items.filter((it) => !it.isDone).length + e.projections.length,
      done: e.doneCount,
      hasDeadline: e.deadlines.length > 0,
    };
  });
  return { month, title: `${y}年${m}月`, today: ctx.today, cells, selected: dayEntry(ctx, selected) };
}

/** 月份加减：「2026-11」+1 → 「2026-12」 */
export function addMonths(month, n) {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(y, m - 1 + n, 1);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
}
