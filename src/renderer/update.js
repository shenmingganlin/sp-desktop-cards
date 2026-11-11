// update.js — 下载更新的小窗口。进度由主进程推过来，取消和关闭也是发给主进程处理。
"use strict";

(() => {
  const $ = (id) => document.getElementById(id);
  const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;

  window.widget.onEvent((e) => {
    if (!e || typeof e.type !== "string") return;
    if (e.type === "theme") {
      if (window.WTheme) window.WTheme.apply(e.theme);
      return;
    }
    if (e.type === "start") {
      $("title").textContent = "正在下载更新";
      $("detail").textContent = "连上 GitHub 拿安装包…";
      $("fill").style.width = "0%";
      $("cancel").hidden = false;
      $("close").hidden = true;
    } else if (e.type === "progress") {
      const percent = Math.max(0, Math.min(1, Number(e.percent) || 0));
      $("fill").style.width = `${Math.round(percent * 100)}%`;
      const pct = `${Math.round(percent * 100)}%`;
      $("detail").textContent = e.total ? `${pct} · ${mb(e.got)} / ${mb(e.total)}` : `${pct} · ${mb(e.got)} 已下载`;
    } else if (e.type === "done") {
      $("fill").style.width = "100%";
      $("title").textContent = "下载完成";
      $("detail").textContent = "已经下好了。要不要现在安装？装的时候小窗会先关掉。";
      $("cancel").hidden = true;
    } else if (e.type === "failed") {
      $("title").textContent = "下载失败";
      $("detail").textContent = typeof e.message === "string" ? e.message : "没能下载更新，稍后再试。";
      $("cancel").hidden = true;
      $("close").hidden = false;
    }
  });

  $("cancel").addEventListener("click", () => window.widget.action("cancel"));
  $("close").addEventListener("click", () => window.widget.action("close"));
  // 页面可能在下载开始后才就绪，请主进程补发最近一次状态。
  void window.widget.action("updateReady");
})();
