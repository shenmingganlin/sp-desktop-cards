// today.js — 今日卡片：逾期、今日、已完成三组，和 SP 的今日视图一致。顶栏「+」快速新建到今天。
"use strict";

(() => {
  function rows(items) {
    const frag = document.createDocumentFragment();
    for (const item of items) {
      frag.append(W.taskRow(item));
      for (const c of item.children) frag.append(W.taskRow(c, { child: true }));
    }
    return frag;
  }

  W.define("today", {
    title: "今日",
    tools: (state) => (state.view ? [{ text: "+", title: "新建今天的任务", on: W.isAdding("today"), click: () => W.openAdd("today", state.view.today) }] : []),
    sub(state, collapsed) {
      const v = state.view;
      if (!v) return "";
      if (collapsed) return `完成 ${v.stats.doneCount}/${v.stats.totalCount}${v.overdue.length ? ` · 逾期 ${v.overdue.length}` : ""}`;
      return W.dayTitle(W.labelOf(v.today));
    },
    sig: (state) => state.view && [state.view.overdue, state.view.list, state.view.done],
    render(body, state) {
      const v = state.view;
      const slot = W.addSlot("today");
      if (slot) body.append(slot);
      if (v.overdue.length) {
        const box = W.section("overdue", `逾期 ${v.overdue.length}`);
        box.append(rows(v.overdue));
        body.append(box);
      }
      if (v.list.length) {
        const box = W.section("today", "今日");
        box.append(rows(v.list));
        body.append(box);
      } else if (!v.overdue.length && !v.done.length && !slot) {
        const empty = W.el("div", "empty");
        empty.append(W.el("p", "", "今天还没有安排任务。"));
        empty.append(W.button("btn", "新建一个", "", () => W.openAdd("today", v.today)));
        body.append(empty);
      }
      if (v.done.length) {
        const showDone = !!state.settings?.showDone;
        const toggle = W.button("link", showDone ? "收起" : "展开", "", () => W.act("setShowDone", { value: !showDone }));
        const box = W.section("done-group", `已完成 ${v.done.length}`, toggle);
        if (showDone) box.append(rows(v.done));
        body.append(box);
      }
    },
    foot(state) {
      const s = state.view.stats;
      const spent = s.spentToday + (state.ticking?.task ? W.sinceSnapshot() : 0);
      const parts = [`今日已用 ${W.duration(spent)}`, `完成 ${s.doneCount}/${s.totalCount}`];
      if (s.remaining) parts.push(`预估剩余 ${W.duration(s.remaining)}`);
      return parts.join(" · ");
    },
  });
})();
