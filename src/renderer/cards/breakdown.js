// breakdown.js — 时间去向卡片：最近 7 天的时间按标签或项目分摊，横条从大到小。
// 数据由主进程的 buildBreakdown 整理好。
"use strict";

(() => {
  const pct = (v) => `${Math.round(v * 100)}%`;

  W.define("breakdown", {
    title: "时间去向",
    tools: (state) => {
      const v = state.view;
      if (!v) return [];
      const other = v.by === "tag" ? "project" : "tag";
      return [{ text: v.by === "tag" ? "按标签" : "按项目", wide: true, title: `换成${other === "tag" ? "按标签" : "按项目"}看`, click: () => W.act("setBreakdownBy", { by: other }) }];
    },
    sub(state, collapsed) {
      const v = state.view;
      if (!v) return "";
      if (collapsed) return `7 天 ${W.duration(v.counted)}`;
      return `最近 7 天 · 按${v.by === "tag" ? "标签" : "项目"}`;
    },
    sig: (state) => state.view && [state.view.by, state.view.buckets, state.view.other, state.view.total],
    render(body, state) {
      const v = state.view;
      if (!v) return;
      if (!v.total) {
        const empty = W.el("div", "empty");
        empty.append(W.el("p", "", "最近 7 天还没有记录时间。"));
        body.append(empty);
        return;
      }
      const box = W.el("div", "bd");
      const list = [...v.buckets];
      if (v.other > 0) list.push({ id: "__other__", title: "其他", ms: v.other, share: v.other / v.total, other: true });
      for (const b of list) {
        const row = W.el("div", `bd-row${b.other ? " other" : ""}`);
        const head = W.el("div", "bd-head");
        head.append(W.el("span", "bd-title", b.title));
        head.append(W.el("span", "bd-ms", W.duration(b.ms)));
        const track = W.el("div", "bd-track");
        const fill = W.el("i", "bd-fill");
        fill.style.width = pct(b.share);
        track.append(fill);
        row.append(head, track);
        row.title = `${b.title} · ${W.duration(b.ms)} · ${pct(b.share)}`;
        box.append(row);
      }
      body.append(box);

      // 标签视角下一条任务可能算进多个标签，合计会比实际多，得说清楚
      if (v.by === "tag" && v.total > v.counted) {
        const note = W.el("div", "bd-note", `一条任务挂多个标签时每个标签各算一次，合计比实际多（实际 ${W.duration(v.counted)}）。`);
        body.append(note);
      }
    },
    foot(state) {
      const v = state.view;
      if (!v?.total) return "";
      return `7 天共 ${W.duration(v.counted)} · ${v.groups} 个${v.by === "tag" ? "标签" : "项目"}`;
    },
  });
})();
