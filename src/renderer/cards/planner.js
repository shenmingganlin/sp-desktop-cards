// planner.js — 规划卡片：从今天起几天，每天的任务、重复任务、截止日和剩余预估。每天都能快速新建。
"use strict";

(() => {
  W.define("planner", {
    title: "规划",
    sub(state, collapsed) {
      const v = state.view;
      if (!v) return "";
      if (!collapsed) return `${v.days.length} 天`;
      const undone = v.days.reduce((n, d) => n + d.items.filter((i) => !i.isDone).length + d.projections.length, 0);
      return `${v.days.length} 天 · ${undone} 项待办`;
    },
    sig: (state) => state.view?.days,
    render(body, state) {
      for (const d of state.view.days) {
        const box = W.el("section", `day${d.isToday ? " today" : ""}`);
        const head = W.el("div", "day-head");
        head.append(W.el("span", "rel", d.label.rel || d.label.weekday));
        head.append(W.el("span", "date", d.label.rel ? `${d.label.date} ${d.label.weekday}` : d.label.date));
        head.append(W.el("span", "left", d.remaining ? W.duration(d.remaining) : ""));
        const plus = W.button("icon", "+", `新建${d.label.rel || d.label.date}的任务`, () => W.openAdd(`day:${d.day}`, d.day));
        if (W.isAdding(`day:${d.day}`)) plus.classList.add("on");
        head.append(plus);
        box.append(head);
        const slot = W.addSlot(`day:${d.day}`);
        if (slot) box.append(slot);
        const rows = W.dayRows(d);
        if (rows.childNodes.length) box.append(rows);
        else if (!slot) box.append(W.el("div", "none", d.doneCount ? `完成了 ${d.doneCount} 项` : "没有安排"));
        body.append(box);
      }
    },
  });
})();
