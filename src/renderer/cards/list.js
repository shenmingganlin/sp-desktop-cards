// list.js — 清单卡片：某个项目或标签下的任务。顶栏按钮切换看哪个。
// 数据由主进程的 buildList 整理好；这里只管画和把点击转成操作。
"use strict";

(() => {
  function rows(items) {
    const frag = document.createDocumentFragment();
    for (const item of items) {
      const row = W.taskRow(item);
      if (item.overdue) row.classList.add("overdue");
      frag.append(row);
      for (const c of item.children) frag.append(W.taskRow(c, { child: true }));
    }
    return frag;
  }

  W.define("list", {
    title: "清单",
    tools(state) {
      if (!state.view?.source) return [];
      return [{ text: state.view.source.title, wide: true, title: "换一个项目或标签", click: () => W.act("listMenu") }];
    },
    sub(state, collapsed) {
      const v = state.view;
      if (!v?.source) return "";
      const kind = v.source.kind === "tag" ? "标签" : "项目";
      if (collapsed) return `${kind} · 还剩 ${v.counts.undone} 项`;
      return `${kind} · 未完成 ${v.counts.undone}${v.counts.done ? ` · 已完成 ${v.counts.done}` : ""}`;
    },
    sig: (state) => state.view && [state.view.source, state.view.undone, state.view.done, state.view.counts],
    render(body, state) {
      const v = state.view;
      if (!v?.source) {
        const empty = W.el("div", "empty");
        empty.append(W.el("p", "", "SP 里还没有项目或标签。"));
        body.append(empty);
        return;
      }
      if (v.undone.length) body.append(rows(v.undone));
      else {
        const empty = W.el("div", "empty");
        empty.append(W.el("p", "", `「${v.source.title}」没有未完成的任务。`));
        body.append(empty);
      }
      if (v.counts.done) {
        const showDone = !!state.settings?.showDone;
        const toggle = W.button("link", showDone ? "收起" : "展开", "", () => W.act("setShowDone", { value: !showDone }));
        const box = W.section("done-group", `已完成 ${v.counts.done}`, toggle);
        if (showDone) box.append(rows(v.done));
        body.append(box);
      }
    },
    foot(state) {
      const v = state.view;
      if (!v?.source) return "";
      const parts = [`未完成 ${v.counts.undone}`];
      if (v.stats.remaining) parts.push(`预估剩余 ${W.duration(v.stats.remaining)}`);
      return parts.join(" · ");
    },
  });
})();
