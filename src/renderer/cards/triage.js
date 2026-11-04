// triage.js — 待整理卡片：收件箱、没排期、没收尾三堆，每条只出现在第一堆。
// 每行能直接开始计时，也能「排到今天」（PATCH dueDay）。数据由主进程的 buildTriage 整理好。
"use strict";

(() => {
  /** 一行：标题 + 项目 + 预估 + 两个按钮。和 card.js 的 taskRow 不一样，这里不需要勾选框。 */
  function triageRow(item) {
    const row = W.el("div", "row triage-row");
    if (item.isCurrent) row.classList.add("current");
    const text = W.el("div", "text");
    text.append(W.el("span", "title", item.title));
    text.title = item.title;
    row.append(text);

    const meta = [];
    if (item.subTotal) meta.push(`${item.subDone}/${item.subTotal}`);
    else if (item.left > 0) meta.push(W.duration(item.left));
    if (item.projectTitle) meta.push(item.projectTitle);
    if (meta.length) row.append(W.el("span", "meta", meta.join(" · ")));

    // 每堆给的动作不一样，但都要能让这一条真的离开这堆：
    // 收件箱/没排期 → 排到今天（有了日期就不再算散着）；没收尾 → 直接勾完成
    if (item.group === "unfinished") {
      const fin = W.button("link", "完成", "子任务都做完了，把父任务也勾掉", async () => {
        fin.disabled = true;
        const r = await W.act("setDone", { id: item.id, isDone: true });
        if (r?.ok) W.toast(`已完成「${item.title}」`);
        fin.disabled = false;
      });
      row.append(fin);
    } else {
      const put = W.button("link", "排到今天", "把它排进今天的计划", async () => {
        put.disabled = true;
        const r = await W.act("scheduleToday", { id: item.id });
        if (r?.ok) W.toast(`「${item.title}」排到今天了`);
        put.disabled = false;
      });
      row.append(put);
    }
    if (item.canTrack) {
      row.append(W.button("play", item.isCurrent ? "❚❚" : "▶", item.isCurrent ? "停止计时" : "开始计时", () =>
        (item.isCurrent ? W.act("stop") : W.act("start", { id: item.id }))));
    }
    return row;
  }

  function group(body, cls, label, items, extra) {
    const box = W.section(cls, label, extra);
    for (const item of items) box.append(triageRow(item));
    body.append(box);
  }

  W.define("triage", {
    title: "待整理",
    sub(state, collapsed) {
      const v = state.view;
      if (!v) return "";
      const { inbox, unscheduled, unfinished } = v.counts;
      if (collapsed) return `${v.stats.total} 项待整理`;
      return `收件箱 ${inbox} · 没排期 ${unscheduled} · 没收尾 ${unfinished}`;
    },
    sig: (state) => state.view && [state.view.inbox, state.view.unscheduled, state.view.unfinished, state.view.counts],
    render(body, state) {
      const v = state.view;
      if (!v) return;
      if (!v.stats.total) {
        const empty = W.el("div", "empty");
        empty.append(W.el("p", "", "都整理好了，没有散着的任务。"));
        body.append(empty);
        return;
      }
      const cap = (n, list) => (n > list.length ? `共 ${n} 项，显示前 ${list.length} 项` : null);
      if (v.inbox.length) group(body, "triage-inbox", `收件箱 ${v.counts.inbox}`, v.inbox, cap(v.counts.inbox, v.inbox));
      if (v.unscheduled.length) group(body, "triage-unscheduled", `没排期 ${v.counts.unscheduled}`, v.unscheduled, cap(v.counts.unscheduled, v.unscheduled));
      if (v.unfinished.length) group(body, "triage-unfinished", `没收尾 ${v.counts.unfinished}`, v.unfinished, cap(v.counts.unfinished, v.unfinished));
    },
    foot(state) {
      const v = state.view;
      if (!v?.stats.total) return "";
      const parts = [`${v.stats.total} 项待整理`];
      if (v.stats.left) parts.push(`预估剩余 ${W.duration(v.stats.left)}`);
      return parts.join(" · ");
    },
  });
})();
