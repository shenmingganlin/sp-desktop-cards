// breakdown.js — 时间去向卡片的数据：最近几天的时间按项目或标签分摊。纯函数。
//
// 一条任务可能同时挂多个标签，标签视角下它那段用时会在每个标签里各算一次，
// 所以标签视角的合计会大于实际总时长——页面上要把这件事说清楚，不能假装是对账。
//
// 用时只按叶子任务累加：父任务的 timeSpentOnDay 已经包含子任务，再加一遍会翻倍。

import { addDays, isDay } from "./model.js";

export const DIMENSIONS = ["tag", "project"];

/**
 * raw = { allTasks, projects, tags }，opts = { today, days = 7, by = "tag", top = 5 }。
 * 返回 { by, today, days, buckets: [{ id, title, ms, share }], other, total, counted, groups }。
 * groups 是参与分摊的组数（标签视角下用于说明「一条任务可能算进多个标签」）。
 */
export function buildBreakdown(raw, opts = {}) {
  const today = opts.today;
  const days = Math.max(1, Math.min(90, opts.days ?? 7));
  const by = opts.by === "project" ? "project" : "tag";
  const top = Math.max(1, opts.top ?? 5);
  const empty = { by, today: isDay(today) ? today : null, days, buckets: [], other: 0, total: 0, counted: 0, groups: 0 };
  if (!isDay(today)) return empty;

  const from = addDays(today, -(days - 1));
  const inWindow = (day) => day >= from && day <= today;

  // 收件箱在 SP 里叫 Inbox，卡片上一律显示中文，和设置页的项目下拉框一致
  const projectTitle = new Map((raw?.projects || []).map((p) => [p.id, p.title]));
  projectTitle.set("INBOX_PROJECT", "收件箱");
  const tagTitle = new Map((raw?.tags || []).map((t) => [t.id, t.title]));
  const sum = new Map();
  const groupsSeen = new Set();
  let counted = 0; // 窗口内的实际总时长，用来在底栏说明「标签视角重复计数」

  for (const t of raw?.allTasks || []) {
    if ((t.subTaskIds || []).length) continue;
    let ms = 0;
    for (const [day, v] of Object.entries(t.timeSpentOnDay || {})) if (inWindow(day)) ms += v || 0;
    if (!ms) continue;
    counted += ms;
    const keys = by === "tag" ? t.tagIds || [] : [t.projectId];
    const list = keys.length ? keys : ["__none__"];
    for (const key of list) {
      const name =
        key === "__none__"
          ? by === "tag"
            ? "没有标签"
            : "没有项目"
          : (by === "tag" ? tagTitle : projectTitle).get(key) || key;
      const cur = sum.get(key) || { id: key, title: name, ms: 0 };
      cur.ms += ms;
      sum.set(key, cur);
      groupsSeen.add(key);
    }
  }

  const all = [...sum.values()].sort((a, b) => b.ms - a.ms);
  const total = all.reduce((s, b) => s + b.ms, 0);
  const head = all.slice(0, top).map((b) => ({ ...b, share: total ? b.ms / total : 0 }));
  const other = all.slice(top).reduce((s, b) => s + b.ms, 0);
  return { by, today, days, from, buckets: head, other, total, counted, groups: groupsSeen.size };
}
