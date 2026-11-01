// fixtures.js — 测试数据，字段形状照 SP 19.3 的 Task 模型。
// 时间都相对固定的「现在」：2026-11-02 周一 10:00（本机时区）。

export const NOW = new Date(2026, 10, 2, 10, 0, 0).getTime();
export const TODAY = "2026-11-02";
const MIN = 60_000;
const pad2 = (n) => String(n).padStart(2, "0");
const dayStr = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

let seq = 0;
export function task(fields) {
  seq += 1;
  return {
    id: fields.id || `t${seq}`,
    title: "任务",
    isDone: false,
    projectId: "INBOX_PROJECT",
    tagIds: [],
    parentId: undefined,
    subTaskIds: [],
    timeEstimate: 0,
    timeSpent: 0,
    timeSpentOnDay: {},
    created: 1_700_000_000_000 + seq,
    dueDay: undefined,
    dueWithTime: undefined,
    deadlineDay: undefined,
    deadlineWithTime: undefined,
    ...fields,
  };
}

/**
 * 一份覆盖各种情况的数据。base 是「现在」：单元测试用固定的 NOW，
 * 界面截图传真实时间，让逾期、即将到点按当下显示。
 */
export function sampleData(base = NOW) {
  const b = new Date(base);
  // 相对 base 的时刻：同一天的 h:m；dayOffset 是前后几天
  const at = (h, m = 0, dayOffset = 0) => new Date(b.getFullYear(), b.getMonth(), b.getDate() + dayOffset, h, m, 0).getTime();
  const rel = (minutes) => base + minutes * MIN;
  const day = (offset) => dayStr(new Date(b.getFullYear(), b.getMonth(), b.getDate() + offset));
  const TODAY = day(0);
  const tasks = [
    task({ id: "standup", title: "站会", dueDay: TODAY, dueWithTime: rel(10), timeEstimate: 15 * MIN }),
    task({ id: "review", title: "评审设计稿", dueDay: TODAY, dueWithTime: rel(240), timeEstimate: 60 * MIN }),
    task({ id: "early", title: "回复邮件", dueDay: TODAY, dueWithTime: rel(-60) }), // 今天已过点
    task({ id: "report", title: "写周报", dueDay: TODAY, timeEstimate: 45 * MIN, timeSpent: 20 * MIN, timeSpentOnDay: { [TODAY]: 20 * MIN } }),
    task({ id: "parent", title: "整理发布", dueDay: TODAY, subTaskIds: ["c1", "c2", "c3"], timeEstimate: 70 * MIN, timeSpent: 30 * MIN }),
    task({ id: "c1", title: "改版本号", parentId: "parent", isDone: true, timeEstimate: 10 * MIN, timeSpent: 10 * MIN, timeSpentOnDay: { [TODAY]: 10 * MIN } }),
    task({ id: "c2", title: "写更新说明", parentId: "parent", timeEstimate: 30 * MIN, timeSpent: 20 * MIN, timeSpentOnDay: { [TODAY]: 5 * MIN, [day(-1)]: 15 * MIN } }),
    task({ id: "c3", title: "打包", parentId: "parent", timeEstimate: 30 * MIN }),
    task({ id: "finished", title: "晨练", dueDay: TODAY, isDone: true, timeSpent: 30 * MIN, timeSpentOnDay: { [TODAY]: 30 * MIN } }),
    task({ id: "late", title: "交水电费", dueDay: day(-2) }), // 两天前
    task({ id: "yday", title: "给老王回电话", dueDay: day(-1), dueWithTime: at(16, 30, -1) }),
    task({ id: "deadline", title: "报销", deadlineDay: day(-1) }),
    task({ id: "later", title: "下周的事", dueDay: day(7) }),
    task({ id: "unplanned", title: "没排期的", timeEstimate: 99 * MIN }),
  ];
  // SP 的今日筛选只看 dueDay/dueWithTime；子任务没排期就不在里面。
  const todayTasks = tasks.filter((t) => t.dueDay === TODAY);
  return {
    allTasks: tasks,
    todayTasks,
    tags: [{ id: "TODAY", title: "Today", taskIds: ["report", "parent", "finished", "standup", "review", "early"] }],
    current: null,
    focus: { mode: "Countdown", cycle: 1, isSessionDone: false, timer: null },
    now: base,
  };
}

export const ids = (items) => items.map((i) => i.id);
