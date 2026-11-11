// stats.js — 统计卡片：今天用了多久、完成几项、几个番茄，外加最近 7 天的用时柱状图。
// 数据由主进程的 buildStats 整理好；计时中时按本机时钟每秒补上正在走的那一段。
"use strict";

(() => {
  const WEEKDAY = "日一二三四五六";
  const weekdayOf = (day) => {
    const [y, m, d] = day.split("-").map(Number);
    return WEEKDAY[new Date(y, m - 1, d).getDay()];
  };
  const percent = (ms, peak) => (peak > 0 ? `${Math.min(100, (ms / peak) * 100)}%` : "0%");

  // 计时中时每秒要改的两个地方；每次重画后重新记。
  let live = null;

  W.define("stats", {
    title: "统计",
    sub(state, collapsed) {
      const v = state.view;
      if (!v) return "";
      if (collapsed) return `今天 ${W.duration(v.todaySpent)}`;
      return W.dayTitle(W.labelOf(v.today));
    },
    sig: (state) => state.view && [state.view.days, state.view.todaySpent, state.view.todayDone, state.view.weekDone, state.pomodoro?.doneToday],
    render(body, state) {
      const v = state.view;
      const extra = state.ticking?.task ? W.sinceListsSnapshot() : 0;
      const todayMs = v.todaySpent + extra;
      const pomo = state.pomodoro || {};

      const top = W.el("div", "stats-today");
      const big = W.el("div", "stats-big", W.duration(todayMs));
      const line = [`完成 ${v.todayDone} 项`, `番茄 ${pomo.doneToday || 0} 个`].join(" · ");
      top.append(big, W.el("div", "stats-line", line));
      body.append(top);

      const box = W.section("stats-week", "最近 7 天");
      if (!v.weekSpent && !v.weekDone) {
        box.append(W.el("div", "stats-empty", "这 7 天还没有记录。"));
        body.append(box);
        live = null;
        return;
      }

      const chart = W.el("div", "stats-chart");
      const peak = Math.max(v.peak, todayMs);
      let todayBar = null;
      for (const d of v.days) {
        const col = W.el("div", `stats-col${d.isToday ? " today" : ""}`);
        const area = W.el("div", "stats-area");
        const bar = W.el("i", `stats-bar${d.spent ? "" : " zero"}`);
        bar.style.height = percent(d.spent, peak);
        const label = W.labelOf(d.day, v.today);
        col.title = `${label.date} ${label.weekday} · ${W.duration(d.spent)} · 完成 ${d.done} 项`;
        area.append(bar);
        col.append(area, W.el("span", "stats-day", weekdayOf(d.day)));
        chart.append(col);
        if (d.isToday) todayBar = bar;
      }
      box.append(chart);
      body.append(box);

      body.append(W.el("div", "stats-total", `7 天 ${W.duration(v.weekSpent)} · 日均 ${W.duration(v.avg)} · 完成 ${v.weekDone} 项`));

      live = todayBar ? { big, bar: todayBar, base: v.todaySpent, peak: v.peak } : null;
    },
    tick(state) {
      if (!live) return;
      const ms = live.base + (state.ticking?.task ? W.sinceListsSnapshot() : 0);
      live.big.textContent = W.duration(ms);
      live.bar.style.height = percent(ms, Math.max(live.peak, ms));
    },
  });
})();
