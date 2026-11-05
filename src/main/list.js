// list.js — 清单卡片的数据：某个项目或某个标签下的全部任务。纯函数，不碰网络和窗口。
//
// 和「今日」的区别：今日是 SP 自己判定的一天的安排，这里是「这个项目/标签还剩什么」。
// 有截止日的排前面（越早越前），没截止日的按 SP 里的顺序；子任务挂在父任务下面。
// 父任务和子任务都在这个清单里时，子任务不单列，只出现在父任务下面。

import { hhmm, isDay, isTimestamp, left } from "./model.js";

/** 从 SP 的 project / tag 对象里取清单卡要的那几个字段。 */
export const sourceOf = (kind, item) => (item ? { kind, id: item.id, title: item.title || (kind === "tag" ? "标签" : "项目") } : null);

/**
 * 可选的清单来源。项目在前、标签在后，TODAY 标签（SP 的今日视图）不算——
 * 那张卡已经有「今日」了，重复一遍没意义。
 */
export function listSources(raw) {
  const projects = (raw?.projects || []).map((p) => sourceOf("project", p));
  const tags = (raw?.tags || []).filter((t) => t.id !== "TODAY").map((t) => sourceOf("tag", t));
  return { projects, tags };
}

/**
 * 选了的东西还在不在；不在就退回第一个可选项（项目全归档、标签被删都会碰到）。
 * 先在同一类里找替补，这一类空了才换到另一类。
 */
export function resolveSource(raw, choice) {
  const { projects, tags } = listSources(raw);
  const isTag = choice?.kind === "tag";
  const pool = isTag ? tags : projects;
  const hit = pool.find((s) => s.id === choice?.id);
  return hit || pool[0] || (isTag ? projects : tags)[0] || null;
}

/**
 * raw = { allTasks, projects, tags }，opts = { kind, id, showDone, dayStartHour, now }。
 * 返回 { source, undone, done, counts, stats }；选中的来源不存在时 source 为 null，列表为空。
 */
export function buildList(raw, opts = {}) {
  const all = raw?.allTasks || [];
  const byId = new Map(all.map((t) => [t.id, t]));
  const source = resolveSource(raw, { kind: opts.kind, id: opts.id });
  const now = opts.now ?? Date.now();
  const empty = { source: null, undone: [], done: [], counts: { undone: 0, done: 0 }, stats: { remaining: 0, estimate: 0 } };
  if (!source) return empty;

  const inSource = (t) => (source.kind === "tag" ? (t.tagIds || []).includes(source.id) : t.projectId === source.id);
  const members = all.filter(inSource);
  const ids = new Set(members.map((t) => t.id));

  const item = (t, extra = {}) => {
    const kids = (t.subTaskIds || []).map((id) => byId.get(id)).filter(Boolean);
    return {
      id: t.id,
      title: t.title,
      parentTitle: (t.parentId && byId.get(t.parentId)?.title) || null,
      isDone: !!t.isDone,
      isCurrent: t.id === (raw.current?.id ?? null),
      timeLabel: isTimestamp(t.dueWithTime) ? hhmm(t.dueWithTime) : null,
      dueDay: isDay(t.dueDay) ? t.dueDay : null,
      dueAt: isTimestamp(t.dueWithTime) ? t.dueWithTime : null,
      estimate: t.timeEstimate || 0,
      spent: t.timeSpent || 0,
      // 和今日卡片一致：有子任务的父任务不给开始按钮，SP 会转去第一个子任务
      canTrack: !t.isDone && kids.length === 0,
      subDone: kids.filter((c) => c.isDone).length,
      subTotal: kids.length,
      children: [],
      ...extra,
    };
  };

  // 父任务也在这个清单里时，子任务不单列
  const tops = members.filter((t) => !(t.parentId && ids.has(t.parentId)));
  const rankOf = (t) => all.indexOf(t);
  const byPlan = (a, b) => {
    if (a.dueAt && b.dueAt) return a.dueAt - b.dueAt;
    if (a.dueAt) return -1;
    if (b.dueAt) return 1;
    if (a.dueDay && b.dueDay) return a.dueDay < b.dueDay ? -1 : a.dueDay > b.dueDay ? 1 : 0;
    if (a.dueDay) return -1;
    if (b.dueDay) return 1;
    return rankOf(a) - rankOf(b);
  };

  // 子任务不看来源：父任务在这个清单里，它的拆解步骤就该跟着显示，
  // 不然按标签看时父任务看起来是空的（「今日」卡片也是这么处理的）。
  const entries = tops.map((t) => {
    const e = item(t, { overdue: isOverdue(t, now) });
    e.children = (t.subTaskIds || [])
      .map((id) => byId.get(id))
      .filter(Boolean)
      .map((c) => item(c, { overdue: isOverdue(c, now) }));
    return e;
  });

  const undone = entries.filter((e) => !e.isDone).sort(byPlan);
  const done = entries.filter((e) => e.isDone).sort(byPlan);
  const remaining = undone.reduce(
    (s, e) => s + (e.subTotal ? e.children.filter((c) => !c.isDone).reduce((n, c) => n + left(byId.get(c.id)), 0) : left(byId.get(e.id))),
    0,
  );
  const estimate = [...undone, ...done].reduce((s, e) => s + e.estimate, 0);

  return {
    source,
    undone,
    done: opts.showDone ? done : [],
    counts: { undone: undone.length, done: done.length },
    stats: { remaining, estimate },
  };
}

function isOverdue(t, now) {
  if (t.isDone) return false;
  if (isTimestamp(t.dueWithTime)) return t.dueWithTime < now;
  return false;
}
