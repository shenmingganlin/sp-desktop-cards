// focus.js — 专注卡片：当前在计时的任务和番茄钟。
// 番茄钟是小窗自己的（SP 的 REST API 只能读它的专注模式，不能控制）。
// SP 自己的专注模式在跑时，这里只显示它的状态，控制要回 SP 里。
"use strict";

(() => {
  const BTN = {
    start: { text: "▶ 专注", title: "开始一个番茄。SP 正在给某个任务计时的话，番茄钟和它一起走。", action: "pomoStart" },
    pause: { text: "❚❚", title: "暂停", action: "pomoPause" },
    resume: { text: "▶", title: "继续", action: "pomoResume" },
    next: { text: "▶ 开始", title: "开始下一阶段", action: "pomoResume" },
    skip: { text: "»", title: "跳过这一阶段", action: "pomoSkip" },
    stop: { text: "■", title: "结束番茄钟", action: "pomoStop" },
    untrack: { text: "■", title: "停止 SP 计时", action: "stop" },
  };

  /** 现在该显示什么。每秒算一次。 */
  function model(state, now = Date.now()) {
    const p = state.pomodoro;
    const v = state.view;
    const cur = v?.current || null;
    const sp = v?.focus || null;
    const delta = W.sinceSnapshot();

    if (p && p.status !== "idle") {
      const ms = Math.max(0, p.status === "running" ? p.endsAt - now : p.remainingMs);
      const status = p.status === "paused" ? "已暂停" : p.status === "ready" ? "等你开始" : null;
      return {
        kind: "pomo",
        time: W.clock(ms),
        cls: p.phase === "work" ? "work" : "break",
        phase: [p.label, p.phase === "work" ? `今天第 ${p.doneToday + 1} 个` : null, status].filter(Boolean).join(" · "),
        task: p.taskTitle || cur?.title || null,
        progress: p.durationMs ? 1 - ms / p.durationMs : null,
        buttons: [p.status === "running" ? "pause" : p.status === "paused" ? "resume" : "next", "skip", "stop"],
      };
    }
    if (sp) {
      const running = !!state.ticking?.focus;
      const ms = sp.countUp ? sp.elapsedMs + (running ? delta : 0) : sp.remainingMs - (running ? delta : 0);
      const over = !sp.countUp && ms < 0;
      return {
        kind: "sp",
        time: (over ? "+" : "") + W.clock(Math.abs(ms)),
        cls: `${sp.isBreak ? "break" : "work"}${over || sp.isOvertime ? " over" : ""}`,
        phase: [`SP ${sp.label}`, sp.mode === "Pomodoro" && sp.cycle ? `第 ${sp.cycle} 轮` : null, sp.status === "paused" ? "已暂停" : "在 SP 里控制"].filter(Boolean).join(" · "),
        task: cur?.title || null,
        progress: null,
        buttons: cur ? ["untrack"] : [],
      };
    }
    if (cur) {
      const spent = cur.spent + (state.ticking?.task ? delta : 0);
      const rest = cur.estimate ? cur.estimate - spent : null;
      return {
        kind: "track",
        time: rest === null ? W.clock(spent) : (rest < 0 ? "+" : "") + W.clock(Math.abs(rest)),
        cls: rest !== null && rest < 0 ? "work over" : "work",
        phase: [rest === null ? "已用" : rest < 0 ? "超出预估" : "剩余", cur.parentTitle].filter(Boolean).join(" · "),
        task: cur.title,
        progress: cur.estimate ? Math.min(1, spent / cur.estimate) : null,
        buttons: ["start", "untrack"],
      };
    }
    const next = (v?.list || []).find((e) => e.dueAt && e.dueAt >= now);
    return {
      kind: "idle",
      time: W.clock((p?.cfg?.workMin || 25) * 60_000),
      cls: "idle",
      phase: next ? `下一个：${next.timeLabel} ${next.title}` : "",
      task: null,
      progress: null,
      buttons: ["start"],
    };
  }

  let parts = null;

  W.define("focus", {
    title: "专注",
    needsView: false, // 连不上 SP 时番茄钟照样能用
    liveSub: true,
    sub(state, collapsed) {
      if (!collapsed) return "";
      const m = model(state);
      return m.kind === "idle" ? "没有在计时" : `${m.time} · ${m.task || m.phase}`;
    },
    sig(state) {
      const m = model(state);
      return [m.kind, m.buttons, state.pomodoro?.phase, m.progress === null];
    },
    render(body, state) {
      const m = model(state);
      const task = W.el("div", "focus-task");
      const main = W.el("div", "focus-main");
      const time = W.el("div", "focus-time");
      const phase = W.el("div", "focus-phase");
      const btns = W.el("div", "focus-btns");
      for (const key of m.buttons) {
        const b = BTN[key];
        btns.append(W.button(key === "start" || key === "next" ? "btn primary" : "btn", b.text, b.title, () => W.act(b.action)));
      }
      main.append(time, phase, btns);
      const bar = W.el("div", "bar");
      const fill = W.el("div");
      bar.append(fill);
      bar.hidden = m.progress === null;
      body.append(task, main, bar);
      parts = { task, time, phase, bar, fill };
      this.tick(state);
    },
    tick(state) {
      if (!parts) return;
      const m = model(state);
      if (parts.time.textContent !== m.time) parts.time.textContent = m.time;
      parts.time.className = `focus-time ${m.cls}`;
      parts.phase.textContent = m.phase;
      parts.phase.title = m.phase;
      parts.task.replaceChildren(m.task ? W.el("span", "", m.task) : W.el("span", "hint", state.view || !state.error ? "没有在计时的任务" : "没连上 SP，番茄钟照常能用"));
      parts.task.title = m.task || "";
      parts.bar.classList.toggle("break", m.cls.startsWith("break"));
      if (m.progress !== null) parts.fill.style.width = `${Math.round(Math.max(0, Math.min(1, m.progress)) * 100)}%`;
    },
    foot(state) {
      const out = [`今天 ${state.pomodoro?.doneToday ?? 0} 个番茄`];
      const v = state.view;
      if (v) out.push(`已用 ${W.duration(v.stats.spentToday + (state.ticking?.task ? W.sinceSnapshot() : 0))}`);
      return out.join(" · ");
    },
  });
})();
