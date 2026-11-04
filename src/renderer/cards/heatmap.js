// heatmap.js — 热力图卡片：一格一天，颜色越深那天干得越久。像 GitHub 的贡献图。
// 数据由主进程的 buildHeatmap 整理好；这里只画格子。
"use strict";

(() => {
  const WEEKDAY = ["一", "三", "五"]; // 只标这三行，格子太小，全标会挤
  const MONTHS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12"];
  const dayLabel = (day) => {
    const [, m, d] = day.split("-").map(Number);
    return `${m}月${d}日`;
  };

  W.define("heatmap", {
    title: "热力图",
    sub(state, collapsed) {
      const v = state.view;
      if (!v?.today) return "";
      if (collapsed) return `连续 ${v.streak} 天`;
      return `最近 ${v.weeks} 周 · 连续 ${v.streak} 天`;
    },
    sig: (state) => state.view && [state.view.days.map((d) => [d.level, d.done]), state.view.weeks],
    render(body, state) {
      const v = state.view;
      if (!v?.today) return;
      const box = W.el("div", "heat");
      // 左边一列星期几，右边是 13 列格子
      const labels = W.el("div", "heat-weekdays");
      for (const w of ["一", "二", "三", "四", "五", "六", "日"]) labels.append(W.el("span", "", WEEKDAY.includes(w) ? w : ""));
      box.append(labels);

      // 月份标签要跟格子对齐，所以放在同一个网格里：每列一个 div，里面是月份 + 7 个格子
      const grid = W.el("div", "heat-grid");
      let lastMonth = null;
      for (const week of v.cells) {
        const col = W.el("div", "heat-col");
        const first = week.find((d) => d.inRange) || week[0];
        const m = Number(first.day.slice(5, 7));
        const tag = W.el("span", "heat-month", m !== lastMonth ? MONTHS[m - 1] : "");
        lastMonth = m;
        col.append(tag);
        const cells = W.el("div", "heat-cells");
        for (const d of week) {
          const cell = W.el("i", `heat-cell lv${d.level}${d.isToday ? " today" : ""}${d.inRange ? "" : " out"}`);
          const parts = [dayLabel(d.day)];
          if (d.spent) parts.push(`用了 ${W.duration(d.spent)}`);
          if (d.done) parts.push(`完成 ${d.done} 项`);
          if (!d.spent && !d.done) parts.push(d.inRange ? "没有记录" : "");
          cell.title = parts.filter(Boolean).join(" · ");
          cells.append(cell);
        }
        col.append(cells);
        grid.append(col);
      }
      box.append(grid);
      body.append(box);

      const total = W.el("div", "heat-total");
      total.append(W.el("span", "", `${v.weeks} 周合计 ${W.duration(v.total)}`));
      total.append(W.el("span", "dim", `${v.active} 天有记录`));
      body.append(total);
    },
    foot(state) {
      const v = state.view;
      if (!v?.today) return "";
      return v.streak ? `连续 ${v.streak} 天有记录` : "今天还没开始，动一下就接上了";
    },
  });
})();
