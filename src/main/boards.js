// boards.js — 看板与艾森豪威尔矩阵的数据：按列规则把任务分到各列。纯函数，不碰网络和窗口。
//
// 列规则照抄 SP 20 自带的两个默认看板（app.asar 里的 DEFAULT_BOARDS）。
// SP 把看板配置存在自己的 boards.boardCfgs 里，REST 和插件 API 都没开放，
// 所以小窗读不到用户改过的列 —— 只能按 SP 出厂的那两个默认看板分。
// 这不是「猜」，是 SP 自己的定义；用户若在 SP 里改过列，两边会不一样，卡片上要说清楚。
//
// 标签 id 是 SP 写死的（在看板缺标签提示中点击创建后建立）：
//   KANBAN_IN_PROGRESS  in-progress
//   EM_URGENT           urgent
//   EM_IMPORTANT        important
// 缺标签时禁止新添这个 ID；已有任务仍按自己的 tagIds 分列，不能改用同名标签。

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
      { id: "URGENT_AND_IMPORTANT", title: "重要且紧急", includedTagIds: [EM_IMPORTANT, EM_URGENT], excludedTagIds: [], taskIds: [], doneState: DONE_ALL, noBacklog: false, parentsOnly: true },
      { id: "NOT_URGENT_AND_IMPORTANT", title: "重要不紧急", includedTagIds: [EM_IMPORTANT], excludedTagIds: [EM_URGENT], taskIds: [], doneState: DONE_ALL, noBacklog: false, parentsOnly: true },
      { id: "URGENT_AND_NOT_IMPORTANT", title: "紧急不重要", includedTagIds: [EM_URGENT], excludedTagIds: [EM_IMPORTANT], taskIds: [], doneState: DONE_ALL, noBacklog: false, parentsOnly: true },
      { id: "NOT_URGENT_AND_NOT_IMPORTANT", title: "不紧急不重要", includedTagIds: [], excludedTagIds: [EM_IMPORTANT, EM_URGENT], taskIds: [], doneState: DONE_ALL, noBacklog: false, parentsOnly: true },
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

// SP 默认看板严格按标签 ID 匹配。改名不改身份，同名普通标签不能替代系统标签。
const existingTagIds = (tags) => new Set((tags || []).filter((tag) => tag && typeof tag.id === "string").map((tag) => tag.id));

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
  if (panel.parentsOnly && target.parentId) throw new Error("矩阵只显示父任务，不能把子任务移入这一格。请在 SP 中操作父任务。");
  if (panel.noBacklog && (raw?.projects || []).some((project) => (project?.backlogTaskIds || []).includes(target.parentId || target.id))) {
    throw new Error("这个任务仍在项目积压区，请先在 SP 中移出积压区，再换看板列。");
  }

  const known = existingTagIds(raw?.tags);
  const current = Array.isArray(target.tagIds) ? [...target.tagIds] : [];

  // 与官方 getTagIdsToMatch 一样，TODAY 是由日期决定的虚拟标签，不写回 task.tagIds。
  const excluded = new Set(panel.excludedTagIds);
  const next = current.filter((id) => id !== "TODAY" && !excluded.has(id));

  // includedTagIds = 这一列要求全部带上的标签
  for (const wanted of panel.includedTagIds) {
    if (next.includes(wanted)) continue;
    // 官方只拒绝本次新增不存在的标签；原任务已有该 ID 时，无需重复创建或写入。
    if (!known.has(wanted)) throw new Error(`SP 里还没有看板所需的「${TAG_LABEL[wanted] || wanted}」系统标签，请在 SP 对应看板的缺失标签提示中创建；同名普通标签不能替代。`);
    next.push(wanted);
  }

  const patch = next.length !== current.length || next.some((id, index) => id !== current[index]) ? { tagIds: next } : {};

  // 看板的「已完成」列是靠 isDone 分的；矩阵四格都是 doneState=all，
  // 那里的完成状态和列无关，拖动不能顺手把任务勾完成或取消完成。
  if (presetKey === "kanban" && panel.doneState !== DONE_ALL) {
    if (panel.doneState === DONE_ONLY && !target.isDone) patch.isDone = true;
    if (panel.doneState === DONE_UN && target.isDone) patch.isDone = false;
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

  const known = existingTagIds(raw?.tags);
  const missingTags = presetTags(presetKey).filter((id) => !known.has(id));
  const sameNameTagLabels = missingTags.filter((id) => (raw?.tags || []).some((tag) =>
    typeof tag?.title === "string" && tag.title.toLowerCase() === TAG_LABEL[id]?.toLowerCase()))
    .map((id) => TAG_LABEL[id] || id);

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

  const matches = (panel, t) => {
    if (panel.doneState === DONE_ONLY && !t.isDone) return false;
    if (panel.doneState === DONE_UN && t.isDone) return false;
    if (panel.parentsOnly && t.parentId) return false;
    // SP 的子任务继承父任务的积压状态，backlogTaskIds 只列父任务。
    if (panel.noBacklog && backlogIds.has(t.parentId || t.id)) return false;
    const tags = t.tagIds || [];
    // includedTagIds 是「全都要带上」（矩阵第一格要同时有紧急和重要两个标签）；
    // excludedTagIds 是「一个都不能带」。
    for (const id of panel.includedTagIds) if (!tags.includes(id)) return false;
    for (const id of panel.excludedTagIds) if (tags.includes(id)) return false;
    return true;
  };

  // 矩阵的第四格是「两个标签都没有」。当一条任务都没带过这两个标签时，
  // 全部任务都满足这个条件，齐刷刷掉进去，格名却写着「不紧急不重要」——
  // 那是在替用户下判断，而他根本没标过任何一条。这时它其实是「还没分类」。
  // 判断看的是「有没有人真打过标」，不是「标签存不存在」：标签建好了却一条没标，
  // 第四格同样是全量任务，名字一样在骗人。
  const matrixTags = [EM_URGENT, EM_IMPORTANT];
  // 固定 ID 标签可以改名；指导用户打标时也要用同一实体现在的名称。
  const matrixTagLabels = presetKey === "eisenhower" ? [EM_URGENT, EM_IMPORTANT].map((id) => {
    const tag = (raw?.tags || []).find((t) => t?.id === id);
    return typeof tag?.title === "string" && tag.title.trim() ? tag.title : TAG_LABEL[id];
  }) : [];
  // 矩阵只看父任务（parentsOnly），所以判断也得看「板上看得见的那批」。
  // 只看全部任务的话，一条打过 urgent 的子任务会让第四格恢复叫「不紧急不重要」，
  // 可矩阵里根本没显示它——用户看到的全是没分类的父任务。
  const matrixVisible = all.filter((t) => !t.parentId);
  const untaggedBucket = presetKey === "eisenhower" &&
    !matrixVisible.some((t) => (t.tagIds || []).some((id) => matrixTags.includes(id)));

  const columns = preset.panels.map((panel) => {
    const tasks = all.filter((t) => matches(panel, t)).map(row);
    // 已完成的沉底：重复任务每天生成一条同名任务，做完的全堆在上面时，
    // 一列看下去像「同一件事出现了七次」。做完的排最后，一眼就知道那些是历史。
    // 没做完的之间：逾期的最急，其次按计划时刻，都没有的按 SP 里的顺序。
    tasks.sort((a, b) => (a.isDone - b.isDone) || (b.overdue - a.overdue) || (a.dueAt ?? Infinity) - (b.dueAt ?? Infinity) || rankOf.get(a.id) - rankOf.get(b.id));
    const undone = tasks.filter((t) => !t.isDone).length;
    const bucket = untaggedBucket && panel.id === "NOT_URGENT_AND_NOT_IMPORTANT";
    return {
      id: panel.id,
      title: bucket ? "未分类" : panel.title,
      isUntaggedBucket: bucket,
      tasks, count: tasks.length, undoneCount: undone, doneCount: tasks.length - undone,
    };
  });

  // 底栏「预估剩余」：一条任务的工时只能算一次。
  // 父任务行的 left 已经是它未完成子任务的合计，子任务又各占一行时再加一遍就是双份。
  // 所以按「祖先优先」去重：一行的祖先也在板上时，只算祖先。
  // 这和今日卡片的 effort 口径是同一套（见 model.js 的 effortRows）。
  // 不能简单地跳过带子任务的行——矩阵只显示父任务，那样会算成 0。
  // 只有「未完成、且自己在板上」的祖先才会吞掉子任务的工时：
  // 已完成的父任务已经不算工时了，不能让它把还没做完的子任务也挡掉。
  const undoneIds = new Set(columns.flatMap((c) => c.tasks.filter((r) => !r.isDone).map((r) => r.id)));
  const leftTotal = columns
    .flatMap((c) => c.tasks)
    .filter((r) => !r.isDone)
    .filter((r) => {
      // 只往上找父任务：父任务不在板上时，子任务照自己的工时算。
      // 不往下查子任务——矩阵里父任务的行本来就代表整组。
      const seen = new Set([r.id]);
      let parentId = byId.get(r.id)?.parentId;
      while (typeof parentId === "string" && parentId && !seen.has(parentId)) {
        if (undoneIds.has(parentId)) return false;
        seen.add(parentId);
        parentId = byId.get(parentId)?.parentId;
      }
      return true;
    })
    .reduce((n, r) => n + r.left, 0);

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
    sameNameTagLabels,
    matrixTagLabels,
    // 卡片上要显示「缺哪个标签」，用 SP 里的名字，不是内部 id
    missingTagLabels: missingTags.map((id) => TAG_LABEL[id] || id),
    // 当前为空且缺少所需标签的列；已有任务仍可能携带该 ID，不把整个列判成不可用。
    blankColumns: preset.panels
      .filter((p, index) => columns[index].count === 0 && p.includedTagIds.some((id) => missingTags.includes(id)))
      .map((p) => p.id),
    counts: {
      total: columns.reduce((s, c) => s + c.count, 0),
      done: columns.reduce((s, c) => s + c.tasks.filter((t) => t.isDone).length, 0),
      // 用 row.left，不是 left(row)：left() 读的是 timeEstimate/timeSpent，
      // 行对象上只有 estimate/spent，那样求和永远是 0，底栏的「预估剩余」从不显示。
      // 父子去重见上面的 leftTotal。
      left: leftTotal,
    },
  };
}
