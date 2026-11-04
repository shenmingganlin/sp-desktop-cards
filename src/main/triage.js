// triage.js — 待整理卡片的数据：散在各处、还没归位的东西，分成三堆。纯函数。
//
// 三堆按顺序判定，每条任务只进第一堆命中的那一堆，不会同时出现在两处：
//   没收尾：有子任务、子任务全做完了，自己还没勾
//   收件箱：项目是收件箱、没排期、还没做
//   没排期：别的项目、没排期、还没做
// 「没排期」= 既没有截止日也没有截止时间。排过期的不进来——它们已经在今日/规划卡上了，
// 而每堆给的那个操作（排到今天 / 完成）都要能让这一条真的离开这堆，否则按了没反应。
//
// 「排到今天」需要 PATCH dueDay，SP 的 REST API 支持（2026-11 实测，清空也支持）。

import { isDay, isTimestamp } from "./model.js";

const left = (t) => Math.max(0, (t.timeEstimate || 0) - (t.timeSpent || 0));
export const INBOX = "INBOX_PROJECT";

/**
 * raw = { allTasks, projects }，opts = { today, now, limit }。
 * 返回 { inbox, unscheduled, unfinished, counts, stats }。
 */
export function buildTriage(raw, opts = {}) {
  const all = raw?.allTasks || [];
  const byId = new Map(all.map((t) => [t.id, t]));
  const projectTitle = new Map((raw?.projects || []).map((p) => [p.id, p.title]));
  const limit = opts.limit ?? 40;

  const item = (t, group) => {
    const kids = (t.subTaskIds || []).map((id) => byId.get(id)).filter(Boolean);
    return {
      id: t.id,
      group,
      title: t.title,
      // 收件箱在 SP 里叫 Inbox，卡片上一律显示中文，和设置页的项目下拉框一致
      projectTitle: t.projectId === INBOX ? "收件箱" : projectTitle.get(t.projectId) || null,
      isCurrent: t.id === (raw.current?.id ?? null),
      estimate: t.timeEstimate || 0,
      spent: t.timeSpent || 0,
      left: kids.length ? kids.filter((c) => !c.isDone).reduce((s, c) => s + left(c), 0) : left(t),
      subDone: kids.filter((c) => c.isDone).length,
      subTotal: kids.length,
      // 有子任务的父任务不能直接计时，SP 会转去第一个子任务
      canTrack: kids.length === 0,
      hasDeadline: isTimestamp(t.deadlineWithTime) || isDay(t.deadlineDay),
    };
  };

  const inbox = [];
  const unscheduled = [];
  const unfinished = [];
  for (const t of all) {
    if (t.isDone) continue;
    // 子任务跟着父任务走，不单独整理
    if (t.parentId) continue;
    const kids = (t.subTaskIds || []).map((id) => byId.get(id)).filter(Boolean);
    const scheduled = isTimestamp(t.dueWithTime) || isDay(t.dueDay);
    if (kids.length && kids.every((c) => c.isDone)) {
      unfinished.push(item(t, "unfinished"));
    } else if (scheduled) {
      continue; // 排过期了的不算「散着的」
    } else if (t.projectId === INBOX) {
      inbox.push(item(t, "inbox"));
    } else {
      unscheduled.push(item(t, "unscheduled"));
    }
  }

  // 每堆内部：先有预估的（知道要花多久，好挑），再按 SP 里的顺序
  const order = (a, b) => (b.estimate > 0) - (a.estimate > 0) || all.findIndex((t) => t.id === a.id) - all.findIndex((t) => t.id === b.id);
  inbox.sort(order);
  unscheduled.sort(order);
  unfinished.sort(order);

  const cap = (list) => list.slice(0, limit);
  return {
    inbox: cap(inbox),
    unscheduled: cap(unscheduled),
    unfinished: cap(unfinished),
    counts: { inbox: inbox.length, unscheduled: unscheduled.length, unfinished: unfinished.length },
    stats: {
      total: inbox.length + unscheduled.length + unfinished.length,
      left: [...inbox, ...unscheduled, ...unfinished].reduce((s, e) => s + e.left, 0),
    },
  };
}
