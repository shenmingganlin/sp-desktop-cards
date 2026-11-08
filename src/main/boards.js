// boards.js — 看板与艾森豪威尔矩阵的数据：按列规则把任务分到各列。纯函数，不碰网络和窗口。
//
// 列规则照抄 SP 20 自带的两个默认看板（app.asar 里的 DEFAULT_BOARDS）。
// SP 把看板配置存在自己的 boards.boardCfgs 里，REST 和插件 API 都没开放，
// 所以小窗读不到用户改过的列 —— 只能按 SP 出厂的那两个默认看板分。
// 这不是「猜」，是 SP 自己的定义；用户若在 SP 里改过列，两边会不一样，卡片上要说清楚。
//
// 标签 id 是 SP 写死的（第一次打开看板时它自己建这几个标签）：
//   KANBAN_IN_PROGRESS  in-progress
//   EM_URGENT           urgent
//   EM_IMPORTANT        important
// 少一个标签，对应的列就永远是空的 —— 要明确告诉用户，不能显示成「你没有重要的事」。

import { isDay, isTimestamp, left } from "./model.js";

export const KANBAN_IN_PROGRESS = "KANBAN_IN_PROGRESS";
export const EM_URGENT = "EM_URGENT";
export const EM_IMPORTANT = "EM_IMPORTANT";

/** SP 的任务完成状态筛选。 */
const DONE_ALL = "all";
const DONE_ONLY = "done";
const DONE_UN = "undone";

/**
 * 两个默认看板。字段名照 SP 的 BoardPanelCfg 简化：
 *   includedTagIds  必须全部带上的标签（空 = 不限制）
 *   excludedTagIds  一个都不能带的标签
 *   doneState       all / done / undone
 *   noBacklog       排除项目积压区里的任务
 *   parentsOnly     只看父任务
 */
export const BOARD_PRESETS = Object.freeze({
  kanban: {
    id: "KANBAN_DEFAULT",
    title: "看板",
    cols: 3,
    panels: [
      { id: "TODO", title: "待办", includedTagIds: [], excludedTagIds: [KANBAN_IN_PROGRESS], taskIds: [], doneState: DONE_UN, noBacklog: true, parentsOnly: false },
      { id: "IN_PROGRESS", title: "进行中", includedTagIds: [KANBAN_IN_PROGRESS], excludedTagIds: [], taskIds: [], doneState: DONE_UN, noBacklog: true, parentsOnly: false },
      { id: "DONE", title: "已完成", includedTagIds: [], excludedTagIds: [], taskIds: [], doneState: DONE_ONLY, noBacklog: true, parentsOnly: false },
    ],
  },
  eisenhower: {
    id: "EISENHOWER_MATRIX",
    title: "艾森豪威尔矩阵",
    cols: 2,
    panels: [
      { id: "URGENT_AND_IMPORTANT", title: "重要且紧急", includedTagIds: [EM_URGENT, EM_IMPORTANT], excludedTagIds: [], taskIds: [], doneState: DONE_ALL, noBacklog: false, parentsOnly: true },
      { id: "NOT_URGENT_AND_IMPORTANT", title: "重要不紧急", includedTagIds: [EM_IMPORTANT], excludedTagIds: [EM_URGENT], taskIds: [], doneState: DONE_ALL, noBacklog: false, parentsOnly: true },
      { id: "URGENT_AND_NOT_IMPORTANT", title: "紧急不重要", includedTagIds: [EM_URGENT], excludedTagIds: [EM_IMPORTANT], taskIds: [], doneState: DONE_ALL, noBacklog: false, parentsOnly: true },
      { id: "NOT_URGENT_NOT_IMPORTANT", title: "不紧急不重要", includedTagIds: [], excludedTagIds: [EM_URGENT, EM_IMPORTANT], taskIds: [], doneState: DONE_ALL, noBacklog: false, parentsOnly: true },
    ],
  },
});

export const BOARD_PRESET_IDS = Object.keys(BOARD_PRESETS);

/** 这个预设要用到哪些标签。缺了哪几个，卡片上要说明。 */
export function presetTags(presetId) {
  const preset = BOARD_PRESETS[presetId] || BOARD_PRESETS.kanban;
  const ids = new Set();
  for (const panel of preset.panels) {
    for (const id of [...panel.includedTagIds, ...panel.excludedTagIds]) ids.add(id);
  }
  return [...ids];
}

/** 标签 id → SP 里显示的名字，用来在卡片上说清楚缺的是哪个。 */
export const TAG_LABEL = { [KANBAN_IN_PROGRESS]: "in-progress", [EM_URGENT]: "urgent", [EM_IMPORTANT]: "important" };

/**
 * 把标签 id 解析成「实际在用的那个」：写死 ID 存在就用它，否则按名字找。
 * 分列和换列都要用同一套规则，不然卡片说「已经在进行中」，
 * 换列却摘不掉标签 —— 两边对不上。
 */
function resolveTagIds(tags, wanted) {
  const list = (tags || []).filter((t) => t && typeof t.id === "string");
  const known = new Set(list.map((t) => t.id));
  const byTitle = new Map(list.map((t) => [String(t.title ?? "").toLowerCase(), t.id]));
  const resolved = new Map();
  for (const id of wanted) {
    if (known.has(id)) resolved.set(id, id);
    else {
      const byName = byTitle.get((TAG_LABEL[id] || "").toLowerCase());
      if (byName) resolved.set(id, byName);
    }
  }
  return resolved;
}

/**
 * 换列：算出把任务挪到某列之后应该写成什么样。
 * 只返回要 PATCH 的字段，调用方负责发请求。
 *
 * raw = { allTasks, tags }，move = { taskId, columnId, preset }。
 * 返回 { tagIds, isDone } —— isDone 只在需要改时才带上。
 *
 * 不认识的列、找不到的任务都抛错：静默不动比报错更糟，
 * 用户会以为拖动生效了。
 */
export function moveTaskToColumn(raw, { taskId, columnId, preset }) {
  const presetKey = BOARD_PRESETS[preset] ? preset : "kanban";
  const def = BOARD_PRESETS[presetKey];
  const panel = def.panels.find((p) => p.id === columnId);
  if (!panel) throw new Error(`未知的列：${columnId}`);
  const all = (raw?.allTasks || []).filter((t) => t && typeof t.id === "string");
  const target = all.find((t) => t.id === taskId);
  if (!target) throw new Error(`找不到任务：${taskId}`);

  const resolved = resolveTagIds(raw?.tags, presetTags(presetKey));
  const current = Array.isArray(target.tagIds) ? [...target.tagIds] : [];

  // 这个预设管的标签：先把它们全摘掉，再按目标列的规则加回来。
  // 只摘当前预设的，不动用户自己的标签（「英语」「习惯」这些）。
  const managed = new Set([...resolved.values()]);
  const next = current.filter((id) => !managed.has(id));

  // includedTagIds = 这一列要求全部带上的标签
  for (const wanted of panel.includedTagIds) {
    const actual = resolved.get(wanted);
    // 标签在 SP 里压根不存在时加不上 —— 直接报错，别假装换成功了
    if (actual === undefined) throw new Error(`SP 里还没有「${TAG_LABEL[wanted] || wanted}」标签，先在 SP 里建好才能挪到这一列。`);
    if (!next.includes(actual)) next.push(actual);
  }

  const patch = { tagIds: next };

  // 看板的「已完成」列是靠 isDone 分的；矩阵四格都是 doneState=all，
  // 那里的完成状态和列无关，拖动不能顺手把任务勾完成或取消完成。
  if (presetKey === "kanban" && panel.doneState !== DONE_ALL) {
    const shouldBeDone = panel.doneState === DONE_ONLY;
    if (target.isDone !== shouldBeDone) patch.isDone = shouldBeDone;
  }

  return patch;
}

/**
 * raw = { allTasks, projects, tags }，opts = { preset, today, now }。
 * 返回 { preset, title, cols, columns: [{ id, title, tasks }], missingTags, needsSetup, counts }。
 */
export function buildBoard(raw, opts = {}) {
  const presetKey = BOARD_PRESETS[opts.preset] ? opts.preset : "kanban";
  const preset = BOARD_PRESETS[presetKey];
  const all = (raw?.allTasks || []).filter((t) => t && typeof t.id === "string");
  const byId = new Map(all.map((t) => [t.id, t]));
  const now = opts.now ?? Date.now();
  const currentId = raw?.current?.id ?? null;

  const projectTitle = new Map((raw?.projects || []).map((p) => [p.id, p.title]));
  // 收件箱在 SP 里叫 Inbox，卡片上一律显示中文，和设置页的项目下拉框一致
  projectTitle.set("INBOX_PROJECT", "收件箱");
  const backlogIds = new Set();
  for (const project of raw?.projects || []) {
    for (const id of project?.backlogTaskIds || []) backlogIds.add(id);
  }

  // SP 打开看板时会用写死的 ID 建这三个标签，但用户也可能自己在 SP 里或
  // 通过插件 API 建同名标签 —— 那样的 ID 是随机的。只认写死 ID 的话，
  // 卡片会说「没有 in-progress 标签」并把列留空，而用户明明建了。
  // 所以：写死 ID 在就用写死 ID；不在就按名字找，找到哪个用哪个。
  const resolved = resolveTagIds(raw?.tags, presetTags(presetKey));
  const missingTags = presetTags(presetKey).filter((id) => !resolved.has(id));

  const rankOf = new Map(all.map((t, i) => [t.id, i]));
  const row = (t) => {
    const kids = (t.subTaskIds || []).map((id) => byId.get(id)).filter(Boolean);
    return {
      id: t.id,
      title: typeof t.title === "string" ? t.title : "",
      projectTitle: projectTitle.get(t.projectId) || null,
      isDone: t.isDone === true,
      isCurrent: t.id === currentId,
      dueAt: isTimestamp(t.dueWithTime) ? t.dueWithTime : null,
      dueDay: isDay(t.dueDay) ? t.dueDay : null,
      overdue: !t.isDone && isTimestamp(t.dueWithTime) && t.dueWithTime < now,
      estimate: t.timeEstimate || 0,
      spent: t.timeSpent || 0,
      left: kids.length ? kids.filter((c) => !c.isDone).reduce((s, c) => s + left(c), 0) : left(t),
      // 有子任务的父任务不能直接计时，SP 会转去第一个子任务
      canTrack: !t.isDone && kids.length === 0,
      // 重复任务的实例：换列只改这一条，明天的新实例仍按模板生成回原列。
      // 不标出来的话，用户会以为「拖进进行中」生效了，第二天发现白做。
      isRepeat: !!t.repeatCfgId,
      subDone: kids.filter((c) => c.isDone).length,
      subTotal: kids.length,
    };
  };

  // 写死 ID 换成人身上实际带着的那个 ID（见上面 resolved）
  const has = (tags, id) => {
    const actual = resolved.get(id);
    return actual !== undefined && tags.includes(actual);
  };

  const matches = (panel, t) => {
    if (panel.doneState === DONE_ONLY && !t.isDone) return false;
    if (panel.doneState === DONE_UN && t.isDone) return false;
    if (panel.parentsOnly && t.parentId) return false;
    if (panel.noBacklog && backlogIds.has(t.id)) return false;
    const tags = t.tagIds || [];
    // includedTagIds 是「全都要带上」（矩阵第一格要同时有紧急和重要两个标签）；
    // excludedTagIds 是「一个都不能带」。
    for (const id of panel.includedTagIds) if (!has(tags, id)) return false;
    for (const id of panel.excludedTagIds) if (has(tags, id)) return false;
    return true;
  };

  // 矩阵的第四格是「两个标签都没有」。当一条任务都没带过这两个标签时，
  // 全部任务都满足这个条件，齐刷刷掉进去，格名却写着「不紧急不重要」——
  // 那是在替用户下判断，而他根本没标过任何一条。这时它其实是「还没分类」。
  // 判断看的是「有没有人真打过标」，不是「标签存不存在」：标签建好了却一条没标，
  // 第四格同样是全量任务，名字一样在骗人。
  const matrixTags = [EM_URGENT, EM_IMPORTANT].map((id) => resolved.get(id)).filter((id) => id !== undefined);
  const untaggedBucket = presetKey === "eisenhower" &&
    !all.some((t) => (t.tagIds || []).some((id) => matrixTags.includes(id)));

  const columns = preset.panels.map((panel) => {
    const tasks = all.filter((t) => matches(panel, t)).map(row);
    // 已完成的沉底：重复任务每天生成一条同名任务，做完的全堆在上面时，
    // 一列看下去像「同一件事出现了七次」。做完的排最后，一眼就知道那些是历史。
    // 没做完的之间：逾期的最急，其次按计划时刻，都没有的按 SP 里的顺序。
    tasks.sort((a, b) => (a.isDone - b.isDone) || (b.overdue - a.overdue) || (a.dueAt ?? Infinity) - (b.dueAt ?? Infinity) || rankOf.get(a.id) - rankOf.get(b.id));
    const undone = tasks.filter((t) => !t.isDone).length;
    const bucket = untaggedBucket && panel.id === "NOT_URGENT_NOT_IMPORTANT";
    return {
      id: panel.id,
      title: bucket ? "未分类" : panel.title,
      isUntaggedBucket: bucket,
      tasks, count: tasks.length, undoneCount: undone, doneCount: tasks.length - undone,
    };
  });

  // 缺标签只是提示，不是错误：SP 自己的看板照样画出来，只在上面挂一条提示。
  // 排除了一个不存在的标签 = 没有东西可排除，待办列照样列出全部任务；
  // 要求一个不存在的标签 = 那一列确实空着，但那也是真话。
  // 早先这里把整张卡换成「缺标签」，看起来像「我的看板没数据」，比实际严重得多。
  return {
    preset: presetKey,
    title: preset.title,
    cols: preset.cols,
    columns,
    missingTags,
    // 卡片上要显示「缺哪个标签」，用 SP 里的名字，不是内部 id
    missingTagLabels: missingTags.map((id) => TAG_LABEL[id] || id),
    // 有标签缺失时，哪几列会因为缺标签而永远空着（excludedTagIds 那几列不受影响）
    blankColumns: preset.panels
      .filter((p) => p.includedTagIds.some((id) => missingTags.includes(id)))
      .map((p) => p.id),
    counts: {
      total: columns.reduce((s, c) => s + c.count, 0),
      done: columns.reduce((s, c) => s + c.tasks.filter((t) => t.isDone).length, 0),
      // 用 row.left，不是 left(row)：left() 读的是 timeEstimate/timeSpent，
      // 行对象上只有 estimate/spent，那样求和永远是 0，底栏的「预估剩余」从不显示。
      left: columns.reduce((s, c) => s + c.tasks.filter((t) => !t.isDone).reduce((n, t) => n + t.left, 0), 0),
    },
  };
}
