// finishday.js — 结束一天卡片：今天的收尾账。做完了什么、时间花在哪、还剩什么、明天要接哪些。
// 数据由主进程的 buildFinishDay 整理好。
//
// 和 SP 自己的「结束一天」不一样：SP 那个会真的把做完的任务移进归档并写日志。
// 这张卡只算账，不动任何数据 —— 归档要走 SP 界面，卡片上说明白。
"use strict";

(() => {
  function doneRow(item) {
    const row = W.el("div", "row fd-row done");
    row.append(W.el("span", "mark", "✓"));
    const text = W.el("div", "text");
    text.append(W.el("span", "title", item.title));
    text.title = item.projectTitle ? `${item.projectTitle} › ${item.title}` : item.title;
    row.append(text);
    if (item.projectTitle) row.append(W.el("span", "meta", item.projectTitle));
    return row;
  }

  function workedRow(item) {
    const row = W.el("div", "row fd-row worked");
    if (item.isCurrent) row.classList.add("current");
    const text = W.el("div", "text");
    text.append(W.el("span", "title", item.title));
    text.title = item.title;
    row.append(text);
    row.append(W.el("span", "meta", W.duration(item.ms)));
    return row;
  }

  /** 没做完的：给一个「排到明天」，让这张卡能真的把今天收掉。 */
  function leftRow(item) {
    const row = W.el("div", "row fd-row left");
    if (item.isCurrent) row.classList.add("current");
    const text = W.el("div", "text");
    text.append(W.el("span", "title", item.title));
    text.title = item.projectTitle ? `${item.projectTitle} › ${item.title}` : item.title;
    row.append(text);
    if (item.left > 0) row.append(W.el("span", "meta", W.duration(item.left)));
    const put = W.button("link", "明天", "排到明天", async () => {
      put.disabled = true;
      const r = await W.act("scheduleTomorrow", { id: item.id });
      if (r?.ok) W.toast(`「${item.title}」排到明天了`);
      put.disabled = false;
    });
    row.append(put);
    if (item.canTrack) {
      row.append(W.button("play", item.isCurrent ? "❚❚" : "▶", item.isCurrent ? "停止计时" : "开始计时", () =>
        (item.isCurrent ? W.act("stop") : W.act("start", { id: item.id }))));
    }
    return row;
  }

  W.define("finishday", {
    title: "结束一天",
    sub(state, collapsed) {
      const v = state.view;
      if (!v) return "";
      const s = v.stats;
      if (collapsed) return `完成 ${s.doneCount} · 用了 ${W.duration(s.workedMs)}`;
      if (v.isEmpty) return "今天还没有记录";
      const ratio = s.ratio === null ? "" : ` · 计划完成 ${Math.round(s.ratio * 100)}%`;
      return `完成 ${s.doneCount} · 用了 ${W.duration(s.workedMs)}${ratio}`;
    },
    sig: (state) => state.view && [state.view.done, state.view.worked, state.view.leftOver, state.view.stats],
    render(body, state) {
      const v = state.view;
      if (!v) return;
      if (v.isEmpty) {
        const empty = W.el("div", "empty");
        empty.append(W.el("p", "", "今天还没有记录：没排期，也没有用时和完成。"));
        body.append(empty);
        return;
      }

      if (v.done.length) {
        const box = W.section("fd-done", `做完 ${v.done.length}`);
        for (const item of v.done) box.append(doneRow(item));
        body.append(box);
      }

      if (v.worked.length) {
        const box = W.section("fd-worked", `时间花在哪 ${W.duration(v.stats.workedMs)}`);
        for (const item of v.worked) box.append(workedRow(item));
        body.append(box);
      }

      if (v.leftOver.length) {
        const extra = W.el("span", "", "明天");
        const box = W.section("fd-left", `还没做完 ${v.leftOver.length}`, extra);
        for (const item of v.leftOver) box.append(leftRow(item));
        body.append(box);
      } else if (v.stats.plannedCount) {
        const box = W.section("fd-left", "还没做完");
        box.append(W.el("div", "none", "今天排的活都做完了。"));
        body.append(box);
      }
    },
    foot(state) {
      const v = state.view;
      if (!v || v.isEmpty) return "";
      const s = v.stats;
      const parts = [`做完 ${s.doneCount}`, `用了 ${W.duration(s.workedMs)}`];
      if (s.leftCount) parts.push(`剩 ${s.leftCount} 项`);
      if (s.leftEstimateMs) parts.push(`预估剩余 ${W.duration(s.leftEstimateMs)}`);
      return parts.join(" · ");
    },
  });
})();
