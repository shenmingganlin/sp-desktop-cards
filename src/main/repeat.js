// repeat.js — 算重复任务在哪天出现（规划表里的「投影」）。
//
// 移植自 Super Productivity v19.3.1（MIT，Copyright (c) 2018 Johannes Millan）：
//   src/app/features/task-repeat-cfg/store/get-newest-possible-due-date.util.ts
//   src/app/features/task-repeat-cfg/store/task-repeat-cfg.selectors.ts（selectTaskRepeatCfgsForExactDay）
//   以及它们用到的日期小工具。
// 函数名和逻辑与原文一一对应，test/sp-spec/ 里直接跑 SP 自己的测试来核对。

/** 原文用来报告无效配置；这里默认不输出，测试会替换它。 */
export const Log = { warn() {} };

const pad2 = (n) => String(n).padStart(2, "0");

// ── 日期小工具（src/app/util/） ──
export function getDbDateStr(date = new Date()) {
  const d = new Date(date);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export function dateStrToUtcDate(dateStr) {
  if (!dateStr) return new Date();
  const match = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(dateStr);
  if (!match) return new Date("Invalid Date");
  const year = +match[1];
  const month = +match[2];
  const day = +match[3];
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return new Date("Invalid Date");
  }
  return date;
}

export function isSameDay(date1, date2, offsetMs = 0) {
  const d1 = new Date((typeof date1 === "number" ? date1 : date1.getTime()) - offsetMs);
  const d2 = new Date((typeof date2 === "number" ? date2 : date2.getTime()) - offsetMs);
  if (Number.isNaN(d1.getTime()) || Number.isNaN(d2.getTime())) throw new Error("Invalid dates passed");
  return d1.getDate() === d2.getDate() && d1.getMonth() === d2.getMonth() && d1.getFullYear() === d2.getFullYear();
}

export function getDiffInDays(d1, d2) {
  const a = new Date(d1);
  const b = new Date(d2);
  a.setHours(0, 0, 0, 0);
  b.setHours(0, 0, 0, 0);
  // 用 round 吸收夏令时造成的 23/25 小时
  return Math.round((b.getTime() - a.getTime()) / 86400000);
}

export function getDiffInWeeks(d1, d2) {
  return Math.floor(getDiffInDays(d1, d2) / 7);
}

export function getDiffInMonth(d1, d2) {
  return (d2.getFullYear() - d1.getFullYear()) * 12 - d1.getMonth() + d2.getMonth();
}

export function isValidSplitTime(v) {
  if (!v || !v.split) return false;
  const split = v.split(":");
  return v.length <= 5 && split.length === 2 && !Number.isNaN(+split[0]) && !Number.isNaN(+split[1])
    && +split[0] >= 0 && +split[0] <= 24 && +split[1] >= 0 && +split[1] <= 59;
}

export function getDateTimeFromClockString(clockString, date) {
  if (!isValidSplitTime(clockString)) throw new Error("Invalid clock string");
  const [h, m] = clockString.split(":");
  const d = new Date(date);
  d.setSeconds(0, 0);
  d.setHours(+h);
  d.setMinutes(+m);
  return d.getTime();
}

// ── 重复配置的辅助函数（task-repeat-cfg/store/） ──
export const TASK_REPEAT_WEEKDAY_MAP = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

export function getEffectiveLastTaskCreationDay(cfg) {
  if (cfg.lastTaskCreationDay) return cfg.lastTaskCreationDay;
  if (cfg.lastTaskCreation) return getDbDateStr(cfg.lastTaskCreation);
  return undefined;
}

export function getEffectiveRepeatStartDate(cfg) {
  if (cfg.repeatFromCompletionDate && cfg.lastTaskCreationDay) return cfg.lastTaskCreationDay;
  return cfg.startDate || "1970-01-01";
}

export const isAfterRepeatUntilDay = (cfg, date) => !!cfg.repeatUntilDay && getDbDateStr(date) > cfg.repeatUntilDay;

export function capDateAtRepeatUntilDay(cfg, date) {
  if (!cfg.repeatUntilDay || !isAfterRepeatUntilDay(cfg, date)) return date;
  const endDay = dateStrToUtcDate(cfg.repeatUntilDay);
  endDay.setHours(12, 0, 0, 0);
  return endDay;
}

/** 某月第 n 个星期几（n = -1 表示最后一个），取中午避开夏令时。 */
export function getNthWeekdayOfMonth(year, month, weekday, n) {
  if (n === -1) {
    const result = new Date(year, month + 1, 0);
    result.setDate(result.getDate() - ((result.getDay() - weekday + 7) % 7));
    result.setHours(12, 0, 0, 0);
    return result;
  }
  const offset = (weekday - new Date(year, month, 1).getDay() + 7) % 7;
  const result = new Date(year, month, 1 + offset + (n - 1) * 7);
  result.setHours(12, 0, 0, 0);
  return result;
}

export function hasNthWeekdayAnchor(cfg) {
  const w = cfg.monthlyWeekOfMonth;
  const d = cfg.monthlyWeekday;
  return Number.isInteger(w) && (w === -1 || (w >= 1 && w <= 4)) && Number.isInteger(d) && d >= 0 && d <= 6;
}

export function findMonthlyNthWeekdayOccurrence(cfg, fromDate, { direction, maxMonths, accept }) {
  const cursor = new Date(fromDate);
  cursor.setDate(1);
  for (let i = 0; i < maxMonths; i++) {
    const candidate = getNthWeekdayOfMonth(cursor.getFullYear(), cursor.getMonth(), cfg.monthlyWeekday, cfg.monthlyWeekOfMonth);
    if (accept(candidate, cursor)) return candidate;
    cursor.setMonth(cursor.getMonth() + direction);
  }
  return null;
}

/**
 * 重复时刻落在哪个时间点。早于「下一天开始时间」的钟点算这一天的深夜，
 * 落到下一个日历日（SP #3378）。
 */
export function getRepeatDueWithTime(startTime, logicalDay, startOfNextDayDiffMs) {
  const [h, m] = startTime.split(":");
  const day = new Date(logicalDay);
  if ((Number(h) * 60 + Number(m)) * 60000 < startOfNextDayDiffMs) day.setDate(day.getDate() + 1);
  return getDateTimeFromClockString(startTime, day);
}

// ── 核心：从 today 往回找最近一个「应当出现、但还没生成实例」的日子 ──
export function getNewestPossibleDueDate(taskRepeatCfg, todayIn) {
  if (!Number.isInteger(taskRepeatCfg.repeatEvery) || taskRepeatCfg.repeatEvery < 1) {
    Log.warn(`Invalid repeatEvery value "${taskRepeatCfg.repeatEvery}" for TaskRepeatCfg "${taskRepeatCfg.id}"`);
    return null;
  }
  // 过了结束日期就从结束日期往回看
  const today = capDateAtRepeatUntilDay(taskRepeatCfg, todayIn);
  const checkDate = new Date(today);
  const startDateDate = dateStrToUtcDate(getEffectiveRepeatStartDate(taskRepeatCfg));
  const lastTaskCreation = dateStrToUtcDate(getEffectiveLastTaskCreationDay(taskRepeatCfg) || "1970-01-01");
  // 一律取中午，夏令时切换不会影响中午
  checkDate.setHours(12, 0, 0, 0);
  lastTaskCreation.setHours(12, 0, 0, 0);
  startDateDate.setHours(12, 0, 0, 0);
  if (startDateDate > checkDate) return null;

  switch (taskRepeatCfg.repeatCycle) {
    case "DAILY": {
      for (let i = 0; i < taskRepeatCfg.repeatEvery + 1; i++) {
        const diffInDays = getDiffInDays(startDateDate, checkDate);
        if (checkDate <= lastTaskCreation || diffInDays < 0) break;
        if (diffInDays % taskRepeatCfg.repeatEvery === 0) return checkDate;
        checkDate.setDate(checkDate.getDate() - 1);
      }
      return null;
    }

    case "WEEKLY": {
      for (let i = 0; i < taskRepeatCfg.repeatEvery * 7 + 1; i++) {
        const diffInWeeks = getDiffInWeeks(startDateDate, checkDate);
        if (checkDate <= lastTaskCreation || diffInWeeks < 0) break;
        const dayKey = TASK_REPEAT_WEEKDAY_MAP[checkDate.getDay()];
        if (diffInWeeks % taskRepeatCfg.repeatEvery === 0 && dayKey && taskRepeatCfg[dayKey] === true) return checkDate;
        checkDate.setDate(checkDate.getDate() - 1);
      }
      return null;
    }

    case "MONTHLY": {
      const nrOfMonthsToCheck = taskRepeatCfg.repeatEvery;
      if (hasNthWeekdayAnchor(taskRepeatCfg)) {
        return findMonthlyNthWeekdayOccurrence(taskRepeatCfg, checkDate, {
          direction: -1,
          maxMonths: nrOfMonthsToCheck + 1,
          accept: (candidate, cursor) => {
            const diffInMonth = getDiffInMonth(startDateDate, cursor);
            return candidate <= checkDate && candidate > lastTaskCreation && diffInMonth >= 0
              && diffInMonth % taskRepeatCfg.repeatEvery === 0;
          },
        });
      }
      // monthlyLastDay 取 31，下面的 setDateSafely 会收到当月最后一天
      const dayOfMonthRepeat = taskRepeatCfg.monthlyLastDay ? 31 : startDateDate.getDate();
      const setDateSafely = (date, day) => {
        date.setDate(1);
        date.setDate(Math.min(day, new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate()));
      };
      const lastDayOfCurrentMonth = new Date(checkDate.getFullYear(), checkDate.getMonth() + 1, 0).getDate();
      if (today.getDate() < Math.min(dayOfMonthRepeat, lastDayOfCurrentMonth)) {
        // 本月的那天还没到，看上个月。先退到 1 号再改月份，避免 3 月 30 日变成「2 月 30 日」溢出回 3 月（SP #10091）。
        checkDate.setDate(1);
        checkDate.setMonth(checkDate.getMonth() - 1);
      }
      setDateSafely(checkDate, dayOfMonthRepeat);
      for (let i = 0; i < nrOfMonthsToCheck; i++) {
        const diffInMonth = getDiffInMonth(startDateDate, checkDate);
        if (checkDate <= lastTaskCreation || diffInMonth < 0) break;
        if (diffInMonth % taskRepeatCfg.repeatEvery === 0) return checkDate;
        checkDate.setDate(1);
        checkDate.setMonth(checkDate.getMonth() - 1);
        setDateSafely(checkDate, dayOfMonthRepeat);
      }
      return null;
    }

    case "YEARLY": {
      const dayOfMonthRepeat = startDateDate.getDate();
      const monthOfMonthRepeat = startDateDate.getMonth();
      const todayAtNoon = new Date(checkDate);
      const setYearlyDate = (date) => {
        date.setDate(1);
        date.setMonth(monthOfMonthRepeat);
        date.setDate(Math.min(dayOfMonthRepeat, new Date(date.getFullYear(), monthOfMonthRepeat + 1, 0).getDate()));
      };
      setYearlyDate(checkDate);
      if (checkDate > todayAtNoon) {
        checkDate.setFullYear(checkDate.getFullYear() - 1);
        setYearlyDate(checkDate);
      }
      for (let i = 0; i < taskRepeatCfg.repeatEvery; i++) {
        const diffInYears = checkDate.getFullYear() - startDateDate.getFullYear();
        if (checkDate <= lastTaskCreation || diffInYears < 0) break;
        if (diffInYears % taskRepeatCfg.repeatEvery === 0) return checkDate;
        checkDate.setFullYear(checkDate.getFullYear() - 1);
        setYearlyDate(checkDate);
      }
      return null;
    }

    default:
      return null;
  }
}

/** selectTaskRepeatCfgsForExactDay 的投影函数：哪些重复配置恰好落在 dayDate 这天。 */
export function getTaskRepeatCfgsForExactDay(taskRepeatCfgs, dayDate) {
  const dateToCheckDate = new Date(dayDate);
  const dateStr = getDbDateStr(dayDate);
  return (taskRepeatCfgs || []).filter((cfg) => {
    if (cfg.isPaused) return false;
    const effectiveLastDay = getEffectiveLastTaskCreationDay(cfg);
    // 当天或更晚的实例已经生成过（含从工作视图提前生成的）
    if (effectiveLastDay && effectiveLastDay >= dateStr) return false;
    if (cfg.deletedInstanceDates?.includes(dateStr)) return false;
    const rd = getNewestPossibleDueDate(cfg, dateToCheckDate);
    return !!rd && isSameDay(rd, dateToCheckDate);
  });
}
