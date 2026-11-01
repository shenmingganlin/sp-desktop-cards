// month.js — 月历卡片：一个月的网格，圆点表示那天有待办，下面列出选中那天的内容。
"use strict";

(() => {
  const WEEK = ["一", "二", "三", "四", "五", "六", "日"];

  function cell(c) {
    const node = W.el("button", `cell${c.inMonth ? "" : " out"}${c.isToday ? " today" : ""}${c.isPast ? " past" : ""}${c.isSelected ? " selected" : ""}`);
    node.append(W.el("span", "num", String(c.date)));
    const dots = W.el("div", "dots");
    for (let i = 0; i < Math.min(3, c.undone); i++) dots.append(W.el("i"));
    if (!c.undone && c.done) dots.append(W.el("i", "done"));
    if (c.hasDeadline) dots.append(W.el("i", "deadline"));
    node.append(dots);
    const bits = [c.undone && `${c.undone} 项待办`, c.done && `${c.done} 项已完成`, c.hasDeadline && "有截止日"].filter(Boolean);
    node.title = `${c.day}${bits.length ? `\n${bits.join("，")}` : ""}`;
    node.addEventListener("click", () => W.act("selectDay", { day: c.day }));
    return node;
  }

  W.define("month", {
    title: "月历",
    tools(state) {
      const v = state.view;
      if (!v) return [];
      const out = [{ text: "‹", title: "上个月", click: () => W.act("navigate", { key: "month", offset: -1 }) }];
      if (v.month !== v.today.slice(0, 7) || v.selected.day !== v.today) {
        out.push({ text: "今天", title: "回到今天", wide: true, click: () => W.act("navigate", { key: "month", offset: 0 }) });
      }
      out.push({ text: "›", title: "下个月", click: () => W.act("navigate", { key: "month", offset: 1 }) });
      return out;
    },
    sub: (state) => state.view?.title || "",
    sig: (state) => state.view && [state.view.month, state.view.cells, state.view.selected],
    render(body, state) {
      const v = state.view;
      const head = W.el("div", "weekdays");
      for (const w of WEEK) head.append(W.el("span", "", w));
      const grid = W.el("div", "grid");
      for (const c of v.cells) grid.append(cell(c));
      body.append(head, grid);

      const d = v.selected;
      const box = W.el("section", `day month-day${d.isToday ? " today" : ""}`);
      const dh = W.el("div", "day-head");
      dh.append(W.el("span", "rel", d.label.rel || d.label.weekday));
      dh.append(W.el("span", "date", d.label.rel ? `${d.label.date} ${d.label.weekday}` : d.label.date));
      dh.append(W.el("span", "left", d.remaining ? W.duration(d.remaining) : ""));
      const plus = W.button(`icon${W.isAdding(`day:${d.day}`) ? " on" : ""}`, "+", `新建${d.label.rel || d.label.date}的任务`, () => W.openAdd(`day:${d.day}`, d.day));
      dh.append(plus);
      box.append(dh);
      const slot = W.addSlot(`day:${d.day}`);
      if (slot) box.append(slot);
      const rows = W.dayRows(d);
      if (rows.childNodes.length) box.append(rows);
      else if (!slot) box.append(W.el("div", "none", d.doneCount ? `完成了 ${d.doneCount} 项` : "没有安排"));
      body.append(box);
    },
  });
})();
