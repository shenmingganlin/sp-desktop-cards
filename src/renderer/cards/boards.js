// boards.js — 看板卡片：把任务按列摊开，一眼看出积压在哪一列。
// 数据由主进程的 buildBoard 整理好；列规则照 SP 20 自带的默认看板。
"use strict";

(() => {
  /** 一行：和 card.js 的 taskRow 同一个样子，但没有勾选框 —— 看板上主要是看分布。 */
  function boardRow(item, column, columns) {
    const row = W.el("div", "row board-row");
    // 已完成要划掉标暗：重复任务每天生成一条同名任务，做完的不区分的话，
    // 一列看下去像「同一件事出现了七次」。
    if (item.isDone) row.classList.add("done");
    if (item.isCurrent) row.classList.add("current");
    if (item.overdue) row.classList.add("overdue");
    const text = W.el("div", "text");
    text.append(W.el("span", "title", item.title));
    text.title = item.projectTitle ? `${item.projectTitle} › ${item.title}` : item.title;
    row.append(text);

    // 一列只有卡片宽度的三分之一（460px 的卡片分三列，每列约 145px）。
    // 「重复 · 逾期」这种组合一放，标题就只剩「机器人…」，等于认不出来。
    // 所以：只留最要紧的一条，重复用单字符 ↻ 标在最前面。
    // 完整信息在悬停提示里，不缺。
    const bits = [];
    // 用 ↻ 而不是「重复」：两个汉字在 145px 的列里太贵了
    if (item.isRepeat) bits.push("↻");
    if (item.overdue) bits.push("逾期");
    // 时刻和剩余时长二选一：都有的话太挤，时刻更有信息量
    else if (item.dueAt) bits.push(W.minuteLabel(new Date(item.dueAt).getHours() * 60 + new Date(item.dueAt).getMinutes()));
    else if (item.subTotal) bits.push(`${item.subDone}/${item.subTotal}`);
    else if (!item.isDone && item.left > 0) bits.push(W.duration(item.left));
    if (bits.length) row.append(W.el("span", "meta", bits.join(" ")));
    // 悬停时给全：列里塞不下，但想知道的人应该能问到
    const full = [];
    if (item.isRepeat) full.push("重复任务（换列只改这一天）");
    if (item.overdue) full.push("逾期");
    if (item.subTotal) full.push(`子任务 ${item.subDone}/${item.subTotal}`);
    if (!item.isDone && item.left > 0) full.push(`剩余 ${W.duration(item.left)}`);
    if (full.length) {
      const meta = row.querySelector(".meta");
      if (meta) meta.title = full.join(" · ");
      else row.title = full.join(" · ");
    }
    if (item.canTrack) {
      row.append(W.button("play", item.isCurrent ? "❚❚" : "▶", item.isCurrent ? "停止计时" : "开始计时", () =>
        (item.isCurrent ? W.act("stop") : W.act("start", { id: item.id }))));
    }
    // 换列：看板不能只是只读的展示。按钮只在 hover 时露出来，
    // 平时不挤占标题的宽度（一列可能十几条）。
    const others = columns.filter((c) => c.id !== column.id);
    if (others.length) {
      // 重复任务的实例换列只改今天这一条，明天仍按模板生成 —— 提示里要说清
      const hint = item.isRepeat
        ? `移到其他列（现在在「${column.title}」）；这是重复任务的一天实例，只改这一天`
        : `移到其他列（现在在「${column.title}」）`;
      row.append(W.button("move", "⇄", hint, () =>
        W.act("moveMenu", { id: item.id, columnId: column.id })));
    }
    return row;
  }

  W.define("boards", {
    title: "看板",
    tools: (state) => {
      const v = state.view;
      if (!v) return [];
      const other = v.preset === "eisenhower" ? "kanban" : "eisenhower";
      const label = other === "kanban" ? "看板" : "矩阵";
      return [{ text: label, wide: true, title: `换成${label}`, click: () => W.act("setBoardPreset", { preset: other }) }];
    },
    sub(state, collapsed) {
      const v = state.view;
      if (!v) return "";
      if (collapsed) return `${v.counts.total} 项`;
      return v.title;
    },
    // missingTags 这些只影响提示条，但提示条也是卡片的一部分：
    // 漏了它们，SP 里补建标签后「还没有 XX 标签」会一直挂着，说反了事实。
    sig: (state) => state.view && [
      state.view.preset, state.view.columns, state.view.counts,
      state.view.missingTags, state.view.blankColumns,
    ],
    render(body, state) {
      const v = state.view;
      if (!v) return;
      // 提示条只在上面挂一条，看板照画：SP 自己也是这么处理的。
      // 整张卡换成提示，看起来就像「SP 里有数据但卡片没有」。
      const untaggedBucket = v.columns.find((c) => c.isUntaggedBucket);
      if (v.missingTags.length) {
        const note = W.el("div", "board-note");
        // 第四格这时叫「未分类」，里面的任务不是「判过不重要」，是根本没标过。
        // 不说这一句，用户会以为卡片替他判了轻重缓急。
        const untagged = untaggedBucket ? "「未分类」里的任务只是没打标签，不是判过轻重缓急了。" : "";
        note.append(W.el("span", "", `SP 里还没有 ${v.missingTagLabels.map((n) => `「${n}」`).join("、")} 标签，${
          v.blankColumns.length ? `「${v.columns.filter((c) => v.blankColumns.includes(c.id)).map((c) => c.title).join("」「")}」列会是空的。` : ""
        }${untagged}在 SP 里打开一次看板就会建好。`));
        body.append(note);
      } else if (untaggedBucket) {
        // 标签建好了，但一条任务都没打过标 —— 第四格照样是全部任务。
        // 这时只有「未分类」三个字不够，得告诉用户怎么让矩阵活起来。
        const note = W.el("div", "board-note");
        note.append(W.el("span", "", "还没有任务打过 urgent / important 标签，所以都堆在「未分类」里。给任务打上这两个标签，矩阵才会分开。"));
        body.append(note);
      }
      if (!v.counts.total) {
        const empty = W.el("div", "empty");
        empty.append(W.el("p", "", v.preset === "eisenhower" ? "还没有任务挂上 urgent / important 标签。" : "看板是空的。"));
        body.append(empty);
        return;
      }
      const grid = W.el("div", `board board-${v.cols}`);
      for (const col of v.columns) {
        const box = W.el("div", "board-col");
        const head = W.el("div", "board-col-head");
        head.append(W.el("span", "board-col-title", col.title));
        // 列头分开写「还剩几项 / 已完成几项」：只给一个总数时，一列 33 条已完成的
        // 看起来像 33 件待办，正是用户说「看着像重复」的那一幕。
        const count = col.doneCount
          ? `${col.undoneCount} · 完成 ${col.doneCount}`
          : String(col.count);
        head.append(W.el("span", "board-col-count", count));
        box.append(head);
        if (!col.count) box.append(W.el("div", "board-col-empty", "—"));
        for (const item of col.tasks) box.append(boardRow(item, col, v.columns));
        grid.append(box);
      }
      body.append(grid);
    },
    foot(state) {
      const v = state.view;
      if (!v?.counts.total) return "";
      const parts = [`${v.counts.total} 项`];
      if (v.counts.done) parts.push(`已完成 ${v.counts.done}`);
      if (v.counts.left) parts.push(`预估剩余 ${W.duration(v.counts.left)}`);
      return parts.join(" · ");
    },
  });
})();
