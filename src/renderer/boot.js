// boot.js — 最后加载：接上主进程推来的状态，每秒走一次时钟。
"use strict";

(() => {
  // 首次画出内容、以及每次折叠状态变化后告诉主进程一声（自检截图要等这个）
  let renderedKey = null;

  window.widget.onState((next) => {
    W.setState(next);
    W.render();
    const ready = !!next.view || next.card === "focus";
    const key = ready ? String(!!next.collapsed) : null;
    if (key !== null && key !== renderedKey) {
      renderedKey = key;
      requestAnimationFrame(() => requestAnimationFrame(() => W.act("rendered")));
    }
  });

  setInterval(W.tick, 1000);
})();
