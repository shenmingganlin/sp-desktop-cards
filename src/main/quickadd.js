// quickadd.js — 把卡片上「快速新建」的输入整理成 POST /tasks 的请求体。纯函数。
//
// SP 新建任务时会按当前打开的视图补默认值：在某个项目里就进那个项目，在某个标签下就加那个标签，
// 在今日视图就排到今天。小窗不知道 SP 此刻停在哪个视图，所以项目和标签总是写明，
// 日期也总是写明：带时间的只写 dueWithTime，只有日期的只写 dueDay（SP 规划表就是这么存的）。
// 标题里的简写语法（#标签 +项目 @明天 15:00 10m）照常交给 SP 解析。

import { isDay } from "./model.js";

export const INBOX = "INBOX_PROJECT";
export const MAX_TITLE = 500;

/**
 * input = { title, day: "YYYY-MM-DD", minute }：minute 是距这天 0 点的分钟数（日程卡片点空档时有），
 *   一天从几点开始不是 0 时，凌晨的时刻会超过 24*60，所以不用「HH:MM」。
 * opts = { projectId, projectIds }：projectIds 是 SP 里现有的项目，设置里选的项目被删了就退回收件箱。
 * 返回 { ok: true, fields } 或 { ok: false, message }。
 */
export function taskFields(input, opts = {}) {
  const title = typeof input?.title === "string" ? input.title.trim() : "";
  if (!title) return { ok: false, message: "标题不能为空。" };
  if (title.length > MAX_TITLE) return { ok: false, message: `标题太长了（最多 ${MAX_TITLE} 字）。` };
  if (!isDay(input.day)) return { ok: false, message: "日期不对。" };
  const projectIds = opts.projectIds;
  const projectId = opts.projectId && (!projectIds || projectIds.includes(opts.projectId)) ? opts.projectId : INBOX;
  const fields = { title, projectId, tagIds: [] };
  if (input.minute !== undefined && input.minute !== null) {
    const minute = input.minute;
    if (!Number.isInteger(minute) || minute < 0 || minute >= 48 * 60) return { ok: false, message: "时间不对。" };
    const [y, mo, d] = input.day.split("-").map(Number);
    fields.dueWithTime = new Date(y, mo - 1, d, 0, minute).getTime();
  } else {
    fields.dueDay = input.day;
  }
  return { ok: true, fields };
}
