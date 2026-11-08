// today.js — 今日卡片：逾期、今日、已完成三组，和 SP 的今日视图一致。顶栏「+」快速新建到今天。
// 收工时底部多一条「收尾账」：还剩哪几项没做完，每项能一键排到明天。
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

  // 收尾账默认收起成一行：大部分时候看今日卡片是为了看今天要做什么，
  // 不是看今天还剩什么。想看逐项、想把没做完的排到明天，点一下展开。
  let wrapOpen = false;

  function wrapUpBox(v) {
    const w = v.wrapUp;
    const box = W.el("section", "group wrap-up");
    const head = W.el("div", "group-head");
    const ratio = w.ratio === null ? "" : ` · 计划完成 ${Math.round(w.ratio * 100)}%`;
    const left = w.leftOver.length ? ` · 还剩 ${w.leftOver.length} 项` : "";
    const toggle = W.button("link", wrapOpen ? "收起" : "收尾", wrapOpen ? "收起收尾账" : "看看今天还剩什么", () => {
      wrapOpen = !wrapOpen;
      W.render(true);
    });
    head.append(W.el("span", "", `收尾 · 完成 ${w.doneCount} · 用了 ${W.duration(w.spentMs)}${ratio}${left}`), toggle);
    box.append(head);

    if (!wrapOpen) return box;
    if (!w.leftOver.length) {
      box.append(W.el("div", "none", "今天排的都做完了。"));
      return box;
    }
    const all = W.button("link", "全部排到明天", "", async () => {
      all.disabled = true;
      for (const item of w.leftOver) await W.act("scheduleTomorrow", { id: item.id });
      all.disabled = false;
      W.toast(`把 ${w.leftOver.length} 项排到明天了`);
    });
    box.append(all);
    for (const item of w.leftOver) {
      const row = W.el("div", "row wrap-row");
      const text = W.el("div", "text");
      if (item.parentTitle) text.append(W.el("span", "parent", `${item.parentTitle} › `));
      text.append(W.el("span", "title", item.title));
      text.title = item.parentTitle ? `${item.parentTitle} › ${item.title}` : item.title;
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
        row.append(W.button("play", "▶", "开始计时", () => W.act("start", { id: item.id })));
      }
      box.append(row);
    }
    return box;
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
    // 收尾账变了也要重画：不把它放进签名，排完一项卡片不会更新
    sig: (state) => state.view && [state.view.overdue, state.view.list, state.view.done, state.view.wrapUp],
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
      // 今天什么都没发生时不硬凑一条「收尾 · 完成 0」
      if (v.wrapUp && !v.wrapUp.isEmpty) body.append(wrapUpBox(v));
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
