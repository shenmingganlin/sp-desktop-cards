// shim.js — 让 SP 原版的 .spec.ts 在 node:test 下跑起来。
// sp-repeat.test.js 把 spec 里的相对 import 全部改指向这里。
// 类型名（TaskRepeatCfg 等）去掉类型标注后仍然出现在 import 里，所以导出一个占位值。

import {
  dateStrToUtcDate,
  getDbDateStr,
  getNewestPossibleDueDate,
  getTaskRepeatCfgsForExactDay,
  Log,
} from "../../src/main/repeat.js";

export { dateStrToUtcDate, getDbDateStr, getNewestPossibleDueDate, Log };

// SP 的 DEFAULT_TASK_REPEAT_CFG（task-repeat-cfg.model.ts）
export const DEFAULT_TASK_REPEAT_CFG = {
  lastTaskCreation: Date.now(),
  lastTaskCreationDay: getDbDateStr(),
  title: null,
  defaultEstimate: undefined,
  projectId: null,
  startTime: undefined,
  startDate: undefined,
  repeatEvery: 1,
  remindAt: undefined,
  isPaused: false,
  quickSetting: "DAILY",
  repeatCycle: "WEEKLY",
  repeatFromCompletionDate: false,
  waitForCompletion: false,
  monday: true,
  tuesday: true,
  wednesday: true,
  thursday: true,
  friday: true,
  saturday: false,
  sunday: false,
  tagIds: [],
  order: 0,
  notes: undefined,
  shouldInheritSubtasks: false,
  disableAutoUpdateSubtasks: false,
  skipOverdue: false,
};

// 只用作枚举值，取到的是键名本身
export const TaskReminderOptionId = new Proxy({}, { get: (_t, key) => key });
export const TaskRepeatCfg = undefined;

const notPorted = (name) => ({
  projector() {
    throw new Error(`${name} 没有移植`);
  },
});

export const selectTaskRepeatCfgsForExactDay = {
  projector: (cfgs, { dayDate }) => getTaskRepeatCfgsForExactDay(cfgs, dayDate),
};
export const selectAllUnprocessedTaskRepeatCfgs = notPorted("selectAllUnprocessedTaskRepeatCfgs");
export const selectAllTaskRepeatCfgs = notPorted("selectAllTaskRepeatCfgs");
export const selectActiveTaskRepeatCfgs = notPorted("selectActiveTaskRepeatCfgs");
export const selectTaskRepeatCfgById = notPorted("selectTaskRepeatCfgById");
export const selectTaskRepeatCfgByIdAllowUndefined = notPorted("selectTaskRepeatCfgByIdAllowUndefined");
export const selectTaskRepeatCfgsWithStartTime = notPorted("selectTaskRepeatCfgsWithStartTime");
export const selectTaskRepeatCfgsWithAndWithoutStartTime = notPorted("selectTaskRepeatCfgsWithAndWithoutStartTime");
export const selectTaskRepeatCfgsSortedByTitleAndProject = notPorted("selectTaskRepeatCfgsSortedByTitleAndProject");
