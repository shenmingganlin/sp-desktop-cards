// finishday.js — 结束一天卡片的数据：今天的收尾账。纯函数，不碰网络和窗口。
//
// 四件事，正好是收工时想知道的：
//   做完了什么（按完成时间）
//   时间花在哪（按今天的用时）
//   还剩什么（计划了今天但没做完）
//   预估还剩多久（明天要接多少）
//
// 日界跟随「一天从几点开始」：SP 里凌晨做完的事算前一天，这里必须同一口径，
// 否则收尾账和 SP 自己的今日视图对不上。
//
// 用时只按叶子任务累加：父任务的 timeSpentOnDay 已经包含子任务，再加一遍会翻倍。
// 这和 model.js 的「今日已用」、breakdown.js 的时间去向是同一条规矩。

import { isDay, isTimestamp, left, localDay } from "./model.js";

/** SP 的逻辑日界：dayStartHour 之前算前一天。 */
const dayOf = (ms, dayStartHour) => localDay(ms, dayStartHour);

// doneOn 正常是毫秒时间戳，老版本存过 YYYY-MM-DD。和 stats.js、heatmap.js 一个口径：
// 时间戳按日界换算，日期串原样用。
const completionDay = (t, dayStartHour) =>
  isTimestamp(t.doneOn) ? localDay(t.doneOn, dayStartHour) : isDay(t.doneOn) ? t.doneOn : null;

/**
 * raw = { allTasks, projects, current }，opts = { today, now, dayStartHour }。
 * 返回 { day, done, worked, leftOver, stats, isEmpty }。
 */
export function buildFinishDay(raw, opts = {}) {
  const today = opts.today;
  const dayStartHour = opts.dayStartHour ?? 0;
  const now = opts.now ?? Date.now();
  const empty = {
    day: isDay(today) ? today : null,
    done: [],
    worked: [],
    leftOver: [],
    stats: { doneCount: 0, workedMs: 0, plannedCount: 0, leftCount: 0, leftEstimateMs: 0, ratio: null },
    isEmpty: true,
  };
  if (!isDay(today)) return empty;

  const all = (raw?.allTasks || []).filter((t) => t && typeof t.id === "string");
  const byId = new Map(all.map((t) => [t.id, t]));
  const currentId = raw?.current?.id ?? null;

  const projectTitle = new Map((raw?.projects || []).map((p) => [p.id, p.title]));
  // 收件箱在 SP 里叫 Inbox，卡片上一律显示中文
  projectTitle.set("INBOX_PROJECT", "收件箱");

  const row = (t, extra = {}) => {
    const kids = (t.subTaskIds || []).map((id) => byId.get(id)).filter(Boolean);
    return {
      id: t.id,
      title: typeof t.title === "string" ? t.title : "",
      projectTitle: projectTitle.get(t.projectId) || null,
      isDone: t.isDone === true,
      isCurrent: t.id === currentId,
      estimate: t.timeEstimate || 0,
      spent: t.timeSpent || 0,
      left: kids.length ? kids.filter((c) => !c.isDone).reduce((s, c) => s + left(c), 0) : left(t),
      // 有子任务的父任务不能直接计时，SP 会转去第一个子任务
      canTrack: !t.isDone && kids.length === 0,
      subDone: kids.filter((c) => c.isDone).length,
      subTotal: kids.length,
      ...extra,
    };
  };

  const plannedToday = (t) => {
    if (isTimestamp(t.dueWithTime)) return dayOf(t.dueWithTime, dayStartHour) === today;
    return t.dueDay === today;
  };

  // 今天做完的。doneOn 是完成时刻；没有这个字段的老数据按「今天」算不了，就不算。
  const done = all
    .filter((t) => t.isDone && completionDay(t, dayStartHour) === today)
    .sort((a, b) => (isTimestamp(a.doneOn) ? a.doneOn : 0) - (isTimestamp(b.doneOn) ? b.doneOn : 0))
    .map((t) => row(t, { doneAt: isTimestamp(t.doneOn) ? t.doneOn : null }));

  // 时间花在哪。只算叶子任务，父任务的数字已经含了子任务。
  const worked = [];
  let workedMs = 0;
  for (const t of all) {
    if ((t.subTaskIds || []).length) continue;
    const ms = t.timeSpentOnDay?.[today] || 0;
    if (ms <= 0) continue;
    workedMs += ms;
    worked.push(row(t, { ms }));
  }
  worked.sort((a, b) => b.ms - a.ms);

  // 计划了今天但没做完的，就是要接去明天的。
  // 父任务和子任务都排了今天时只接父任务一次，不然明天会出现两份。
  const leftRows = all.filter((t) => !t.isDone && plannedToday(t));
  const leftIds = new Set(leftRows.map((t) => t.id));
  const leftOver = leftRows
    .filter((t) => !(t.parentId && leftIds.has(t.parentId)))
    .map((t) => row(t));

  const plannedCount = all.filter(plannedToday).length;
  const doneToday = all.filter((t) => plannedToday(t) && t.isDone).length;
  // 预估剩余：只算没做完的。父任务的预估已经含子任务，不再加子任务那一份。
  const leftEstimateMs = leftOver.reduce((s, t) => s + t.left, 0);

  return {
    day: today,
    done,
    worked,
    leftOver,
    stats: {
      doneCount: done.length,
      workedMs,
      plannedCount,
      leftCount: leftOver.length,
      leftEstimateMs,
      // 没有计划时返回 null：算成 0% 会像「一件事都没做」，其实是没安排。
      ratio: plannedCount ? doneToday / plannedCount : null,
    },
    isEmpty: done.length === 0 && workedMs === 0 && plannedCount === 0,
  };
}
