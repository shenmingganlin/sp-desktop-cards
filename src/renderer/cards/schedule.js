// schedule.js — 日程卡片：某一天的时间轴。有具体时间的任务按时间和预估画成块，没定时间的放在上面。
// 点时间轴的空白处，在那个时间新建任务。
"use strict";

(() => {
  const PX = 0.8; // 每分钟多少像素：一小时 48px
  let parts = null;
  let scrolledFor = null; // 已经自动滚到「现在」的那天，之后保留用户自己滚到的位置

  const y = (view, min) => (min - view.rangeStart) * PX;
  // 和任务块、时间轴标签、新建槽一样用墙钟分钟，不用 DST 日实际经过的分钟。
  function wallMinute(view, ms) {
    const d = new Date(ms);
    const [year, month, day] = view.day.split("-").map(Number);
    const days = (Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) - Date.UTC(year, month - 1, day)) / 86400_000;
    return days * 1440 + d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60;
  }

  function block(view, b) {
    const isDone = W.isDone(b);
    const node = W.el("div", `block${b.kind === "repeat" ? " repeat" : ""}${b.isCurrent ? " current" : ""}${isDone ? " done" : ""}${b.noEstimate ? " guess" : ""}`);
    node.style.top = `${y(view, b.startMin)}px`;
    node.style.height = `${Math.max(16, (b.endMin - b.startMin) * PX - 2)}px`;
    node.style.left = `${(b.lane * 100) / b.lanes}%`;
    node.style.width = `calc(${100 / b.lanes}% - 2px)`;
    const range = `${b.timeLabel}–${b.endLabel}${b.clockRollback ? `（时钟回拨，按实际 ${W.duration(b.end - b.start)} 占位）` : ""}${b.noEstimate ? "（没有预估）" : ""}`;
    node.title = `${b.title}\n${range}${b.kind === "repeat" ? "\n重复任务，到那天 SP 会自动创建" : ""}`;
    if (b.kind === "task") {
      const check = W.button("check", "", isDone ? "标记为未完成" : "标记为完成", () => W.toggleDone(b, !isDone));
      node.append(check);
    }
    const text = W.el("div", "text");
    text.append(W.el("span", "title", b.title));
    if ((b.endMin - b.startMin) * PX >= 30) text.append(W.el("span", "meta", range));
    node.append(text);
    node.addEventListener("click", (e) => e.stopPropagation());
    return node;
  }

  function chip(item) {
    const isDone = item.kind === "task" && W.isDone(item);
    const c = W.el("span", `chip${item.kind === "repeat" ? " repeat" : ""}${isDone ? " done" : ""}`, item.title);
    c.title = item.kind === "repeat" ? `${item.title}（重复任务）` : item.title;
    return c;
  }

  W.define("schedule", {
    title: "日程",
    tools(state) {
      const v = state.view;
      if (!v) return [];
      const out = [{ text: "‹", title: "前一天", click: () => W.act("navigate", { key: "schedule", offset: -1 }) }];
      if (!v.isToday) out.push({ text: "今天", title: "回到今天", wide: true, click: () => W.act("navigate", { key: "schedule", offset: 0 }) });
      out.push({ text: "›", title: "后一天", click: () => W.act("navigate", { key: "schedule", offset: 1 }) });
      return out;
    },
    sub(state, collapsed) {
      const v = state.view;
      if (!v) return "";
      const title = W.dayTitle(v.label);
      return collapsed ? `${title} · ${v.blocks.length + v.untimed.length} 项` : title;
    },
    sig: (state) => state.view && [state.view.day, state.view.isToday, state.view.blocks, state.view.untimed, state.view.rangeStart, state.view.rangeEnd],
    render(body, state) {
      const v = state.view;
      if (v.untimed.length) {
        const chips = W.el("div", "chips");
        chips.title = "没定具体时间的任务";
        for (const it of v.untimed) chips.append(chip(it));
        body.append(chips);
      }
      const line = W.el("div", "timeline");
      line.style.height = `${(v.rangeEnd - v.rangeStart) * PX + 8}px`;
      line.style.marginTop = "10px";
      for (let m = Math.ceil(v.rangeStart / 60) * 60; m <= v.rangeEnd; m += 60) {
        const h = W.el("div", "hour");
        h.style.top = `${y(v, m)}px`;
        h.append(W.el("span", "", W.minuteLabel(m)));
        line.append(h);
      }
      for (const b of v.blocks) line.append(block(v, b));
      const now = W.el("div", "now-line");
      line.append(now);
      // 草稿跟具体日期绑定；翻天后不能继续显示仍会写入旧日期的输入框。
      const slot = W.addSlot(`slot:${v.day}`);
      if (slot) {
        slot.style.top = `${y(v, W.addingMinute())}px`;
        line.append(slot);
      }
      line.addEventListener("click", (e) => {
        if (e.target !== line && !e.target.classList.contains("hour")) return;
        const offset = e.clientY - line.getBoundingClientRect().top;
        const minute = Math.floor((v.rangeStart + offset / PX) / 15) * 15;
        W.openAdd(`slot:${v.day}`, v.day, Math.max(v.rangeStart, Math.min(v.rangeEnd - 15, minute)));
      });
      line.title = "点空白处在这个时间新建任务";
      body.append(line);
      parts = { line, now, view: v };
      this.tick(state);
    },
    afterRender(body, state) {
      const v = state.view;
      if (!v || scrolledFor === v.day) return;
      scrolledFor = v.day;
      const nowMin = wallMinute(v, Date.now());
      const target = v.isToday ? nowMin - 60 : (v.blocks[0]?.startMin ?? v.rangeStart) - 30;
      body.scrollTop = Math.max(0, parts.line.offsetTop + y(v, target));
    },
    tick() {
      if (!parts) return;
      const v = parts.view;
      const nowMin = wallMinute(v, Date.now());
      const show = v.isToday && nowMin >= v.rangeStart && nowMin <= v.rangeEnd;
      parts.now.hidden = !show;
      if (show) parts.now.style.top = `${y(v, nowMin)}px`;
    },
  });
})();
