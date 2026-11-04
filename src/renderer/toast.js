// toast.js — 桌面上浮一下就走的小提示。内容由主进程推过来，自己定时消失。
// 窗口是透明且不接鼠标的（见主进程的 showToast），所以这里不用管点击。
"use strict";

(() => {
  const $ = (id) => document.getElementById(id);
  let timer = null;

  function show(payload) {
    const note = $("note");
    note.className = payload.on ? "on" : "off";
    $("text").textContent = payload.text || "";
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
