// heatmap.js — 热力图卡片的数据：最近若干周每天用了多久、完成几项。纯函数。
//
// 和统计卡用的是同一份原料（allTasks 里的 timeSpentOnDay 和 doneOn），区别是时间跨度：
// 统计卡看 7 天，这里看一个季度左右，一格一天，一眼看出「哪段时间真的在干活」。
//
// 网格按周排，周一在最上面、周日最下。第一列可能只有几天属于窗口内，用 inRange 标出来，
// 页面据此把格子画淡——不然会以为那几天是「没干活」而不是「不在范围里」。

import { isDay, isTimestamp, localDay, pad2 } from "./model.js";

const DAY = 86400_000;

const parseDay = (day) => day.split("-").map(Number);
const dayStr = (date) => `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
const addDays = (day, n) => {
  const [y, m, d] = parseDay(day);
  return dayStr(new Date(y, m - 1, d + n));
};
const diffDays = (a, b) => {
  const toUtc = (s) => {
    const [y, m, d] = parseDay(s);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((toUtc(a) - toUtc(b)) / DAY);
};
/** 0 = 周一 … 6 = 周日 */
const mondayIndex = (day) => {
  const [y, m, d] = parseDay(day);
  return (new Date(y, m - 1, d).getDay() + 6) % 7;
};

/**
 * raw = { allTasks }，opts = { today, weeks = 13, dayStartHour = 0 }。
 * 返回 { today, weeks, days: [{ day, spent, done, level, inRange, isToday }], cells（按周分组）, total, active, streak, peak }。
 * level 是 0~4 的档位，页面按档位上色。
 */
export function buildHeatmap(raw, opts = {}) {
  const today = opts.today;
  const weeks = Math.max(1, Math.min(53, opts.weeks ?? 13));
  const dayStartHour = opts.dayStartHour ?? 0;
  if (!isDay(today)) return { today: null, weeks: 0, days: [], cells: [], total: 0, active: 0, streak: 0, peak: 0 };

  // 窗口的最后一天是本周周日，往前数 weeks 个整周；这样每列都是完整的周一到周日
  const end = addDays(today, 6 - mondayIndex(today));
  const start = addDays(end, -(weeks * 7 - 1));

  const spent = new Map();
  const done = new Map();
  for (const t of raw?.allTasks || []) {
    // 用时只按叶子任务累加：父任务的数字已经包含子任务，再加一遍会翻倍
    if (!(t.subTaskIds || []).length) {
      for (const [day, ms] of Object.entries(t.timeSpentOnDay || {})) {
        if (!spent.has(day)) spent.set(day, 0);
        spent.set(day, spent.get(day) + (ms || 0));
      }
    }
    if (!t.isDone || t.parentId) continue;
    const day = isTimestamp(t.doneOn) ? localDay(t.doneOn, dayStartHour) : isDay(t.doneOn) ? t.doneOn : null;
    if (day) done.set(day, (done.get(day) || 0) + 1);
  }

  const days = [];
  for (let i = 0; i < weeks * 7; i += 1) {
    const day = addDays(start, i);
    const isToday = day === today;
    days.push({
      day,
      spent: spent.get(day) || 0,
      done: done.get(day) || 0,
      inRange: day <= today,
      isToday,
    });
  }

  let peak = 0;
  let total = 0;
  let active = 0;
  for (const d of days) {
    if (!d.inRange) continue;
    total += d.spent;
    if (d.spent > 0 || d.done > 0) active += 1;
    if (d.spent > peak) peak = d.spent;
  }
  for (const d of days) d.level = levelOf(d, peak, opts.steps);

  // 连续天数：从今天往前数，连着有记录的天数。今天还没干活不算断（一天才刚开始）。
  // 网格排到本周周日，今天之后的那几格要跳过，不能当断点。
  let streak = 0;
  for (let i = days.length - 1; i >= 0; i -= 1) {
    const d = days[i];
    if (!d.inRange) continue;
    const has = d.spent > 0 || d.done > 0;
    if (has) streak += 1;
    else if (d.isToday) continue;
    else break;
  }

  const cells = [];
  for (let w = 0; w < weeks; w += 1) cells.push(days.slice(w * 7, w * 7 + 7));

  return { today, weeks, days, cells, total, active, streak, peak };
}

/** 相对本周峰值分 4 档，有记录但很少的也至少是 1 档。 */
function levelOf(d, peak, steps) {
  if (!d.inRange) return 0;
  if (!d.spent && !d.done) return 0;
  if (!peak || !d.spent) return 1;
  const bounds = Array.isArray(steps) && steps.length === 3 ? steps : [0.25, 0.5, 0.75];
  const r = d.spent / peak;
  if (r <= bounds[0]) return 1;
  if (r <= bounds[1]) return 2;
  if (r <= bounds[2]) return 3;
  return 4;
}
