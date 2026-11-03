// theme.js — 每个页面最先跑：把 URL 里的 ?theme= 立刻写到 <html>，第一帧就是对的皮肤，不会先闪一下深色。
// 运行中换皮肤由主进程推状态，页面调用 WTheme.apply()。
"use strict";

(() => {
  const initial = new URLSearchParams(location.search).get("theme");
  if (initial) document.documentElement.dataset.theme = initial;
  window.WTheme = {
    apply(id) {
      if (!id) return;
      if (document.documentElement.dataset.theme !== id) document.documentElement.dataset.theme = id;
    },
  };
})();
