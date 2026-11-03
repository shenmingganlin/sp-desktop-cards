// stats.js — 统计卡的数据：最近几天每天的专注时长和完成数。纯函数，不碰网络和窗口。
//
// 只用已经轮询到的 allTasks：
//   timeSpentOnDay 按月记着每天用了多久，doneOn 是完成时的毫秒时间戳（老版本可能是 YYYY-MM-DD）。
// 窗口以 SP 的「今天」为准往前推，最后一项就是今天。

import { isDay, isTimestamp, localDay, pad2 } from "./model.js";

/**
 * raw = { allTasks }；opts = { today, now, dayStartHour, days }。
 * 返回 { today, days: [{ day, spent, done, isToday }], todaySpent, todayDone, weekSpent, weekDone, peak, avg }。
 */
export function buildStats(raw, { today, now = Date.now(), dayStartHour = 0, days = 7 } = {}) {
  const list = raw?.allTasks || [];
  const [y, m, d] = String(today).split("-").map(Number);

  const dayList = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const date = new Date(y, m - 1, d - i);
    const day = `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
    dayList.push({ day, spent: 0, done: 0, isToday: i === 0 });
  }
  const byDay = new Map(dayList.map((slot) => [slot.day, slot]));

  // 用时只按叶子任务累加：父任务的 timeSpent 已经包含子任务，再加一遍会翻倍。
  for (const t of list) {
    if ((t.subTaskIds || []).length) continue;
    for (const [day, ms] of Object.entries(t.timeSpentOnDay || {})) {
      const slot = byDay.get(day);
      if (slot) slot.spent += ms;
    }
  }

  // 完成数只数顶层任务，子任务挂在父任务下面不再数一次。
  for (const t of list) {
    if (!t.isDone || t.parentId) continue;
    const day = isTimestamp(t.doneOn) ? localDay(t.doneOn, dayStartHour) : isDay(t.doneOn) ? t.doneOn : null;
    const slot = day && byDay.get(day);
    if (slot) slot.done += 1;
  }

  const todaySlot = dayList.at(-1);
  let weekSpent = 0;
  let weekDone = 0;
  let peak = 0;
  for (const slot of dayList) {
    weekSpent += slot.spent;
    weekDone += slot.done;
    if (slot.spent > peak) peak = slot.spent;
  }

  return {
    today: todaySlot.day,
    now,
    days: dayList,
    todaySpent: todaySlot.spent,
    todayDone: todaySlot.done,
    weekSpent,
    weekDone,
    peak,
    avg: weekSpent / dayList.length,
  };
}
