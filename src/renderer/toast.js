// toast.js — 桌面上浮一下就走的小提示。内容由主进程推过来，自己定时消失。
// 窗口是透明且不接鼠标的（见主进程的 showToast），所以这里不用管点击。
"use strict";

(() => {
  const $ = (id) => document.getElementById(id);
  let timer = null;

  function show(payload) {
    const note = $("note");
    // 上一轮淡出留下的内联 opacity 必须清掉：不清的话，第二次以后整条提示都是透明的，
    // 窗口还在、内容看不见，看起来就像「提示只弹第一次」。
    note.style.opacity = "";
    note.style.transition = "";
    note.className = payload.on ? "on" : "off";
    // 淡入重放：class 来回变不会重启 CSS 动画，强制一次重排让它重新跑
    note.style.animation = "none";
    void note.offsetWidth;
    note.style.animation = "";
    $("text").textContent = payload.text || "";
    // 第二行是当前快捷键。穿透开着的时候卡片点不到，这是用户唯一能想起来怎么关的地方。
    const hint = $("hint");
    hint.textContent = payload.key ? `${payload.key} 切换` : "";
    hint.hidden = !payload.key;
    document.documentElement.dataset.theme = payload.theme || "dark";
    clearTimeout(timer);
    // 主进程按同样的时长关窗口，这里只是提前把自己淡掉，避免关的时候闪一下
    timer = setTimeout(() => {
      note.style.opacity = "0";
      note.style.transition = "opacity 0.12s ease-in";
    }, Math.max(0, (payload.ms || 1600) - 160));
  }

  window.widget.onEvent((e) => {
    if (e?.type === "toast") show(e);
  });

  // 页面刚起来时主进程可能已经把内容推过来了，问一次
  window.widget.action("toastReady");
})();
