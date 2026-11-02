// settings.js — 设置窗口。每个控件用 data-key 对应一项设置，改了马上保存。
// 主进程每次推状态都会同步回来，正在操作的控件不覆盖，免得把输入冲掉。
"use strict";

(() => {
  const $ = (id) => document.getElementById(id);
  const INBOX = "INBOX_PROJECT";
  const TOKEN_TEXT = {
    auto: "已自动读取 SP 的令牌。",
    manual: "正在使用手填的令牌。",
    env: "正在使用环境变量里的令牌。",
    none: "还没找到令牌。确认 SP 已打开，并在 SP 设置里启用了 REST API。",
  };

  let state = null;
  let toastTimer = null;
  let projectSig = "";

  const act = (name, payload) => window.widget.action(name, payload);

  function toast(message) {
    const box = $("toast");
    box.textContent = message;
    box.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (box.hidden = true), 4000);
  }

  const getPath = (obj, key) => key.split(".").reduce((o, k) => (o == null ? o : o[k]), obj);

  /** 「pomodoro.workMin」→ { pomodoro: { workMin } }。设置那边按字段合并，不会冲掉同组其他项。 */
  function patchOf(key, value) {
    const [head, sub] = key.split(".");
    return sub ? { [head]: { [sub]: value } } : { [head]: value };
  }

  function readValue(input) {
    const kind = input.dataset.kind;
    if (input.type === "checkbox") return input.checked;
    if (kind === "bool") return input.value === "true";
    if (kind === "pct") return Number(input.value) / 100;
    if (kind === "int") {
      const n = Number(input.value);
      return input.value === "" || !Number.isFinite(n) ? null : Math.round(n);
    }
    return input.value;
  }

  function writeValue(input, value) {
    if (input.type === "checkbox") input.checked = !!value;
    else if (input.dataset.kind === "bool") input.value = String(!!value);
    else if (input.dataset.kind === "pct") input.value = String(Math.round(value * 100));
    else input.value = value ?? "";
  }

  for (const input of document.querySelectorAll("[data-key]")) {
    const save = async () => {
      const value = readValue(input);
      if (value === null) return;
      const result = await act("saveSettings", patchOf(input.dataset.key, value));
      if (result?.ok === false) toast(`没保存成功：${result.message || "未知错误"}`);
    };
    // 滑块拖动时就生效；其他控件改完（失焦或回车）再存
    input.addEventListener(input.type === "range" ? "input" : "change", save);
  }

  for (const input of document.querySelectorAll("[data-card]")) {
    input.addEventListener("change", () => act("setCardVisible", { type: input.dataset.card, visible: input.checked }));
  }

  $("reset-layout").addEventListener("click", () => act("resetLayout"));
  $("chime-test").addEventListener("click", (e) => {
    e.preventDefault(); // 按钮在 label 里，别顺带切换旁边的勾选框
    Chime.play("work").catch(() => {});
  });
  $("tour").addEventListener("click", () => act("openTour"));
  $("check-update").addEventListener("click", () => act("checkUpdate"));
  $("refresh").addEventListener("click", () => act("refresh"));
  $("token-save").addEventListener("click", async () => {
    const input = $("token");
    const result = await act("setToken", { token: input.value });
    input.value = "";
    toast(result?.ok ? "令牌已保存。" : result?.message || "没保存成功");
  });
  $("token").addEventListener("keydown", (e) => {
    if (e.key === "Enter") $("token-save").click();
  });
  /** 项目下拉框：收件箱放第一个。只在项目列表变了时重建。 */
  function syncProjects(projects, selected) {
    const list = (projects || []).filter((p) => p.id !== INBOX);
    const sig = JSON.stringify([list, selected]);
    if (sig === projectSig) return;
    projectSig = sig;
    const select = $("project");
    const options = [new Option("收件箱", "")];
    for (const p of list) options.push(new Option(p.title || p.id, p.id));
    // 选的项目被删或归档了：显示出来但标明，保存时主进程会退回收件箱
    if (selected && selected !== INBOX && !list.some((p) => p.id === selected)) {
      options.push(new Option(projects ? "（已不存在，会放进收件箱）" : "（连上 SP 后显示）", selected));
    }
    select.replaceChildren(...options);
    select.value = selected === INBOX ? "" : selected || "";
  }

  function render() {
    const s = state.settings;
    if (!s) return;
    for (const input of document.querySelectorAll("[data-key]")) {
      if (document.activeElement === input) continue;
      if (input.dataset.key === "quickAddProjectId") continue;
      writeValue(input, getPath(s, input.dataset.key));
    }
    $("opacity-out").textContent = `${Math.round(s.opacity * 100)}%`;
    const desktopOption = document.querySelector('[data-key="mode"] option[value="desktop"]');
    desktopOption.disabled = !s.desktopAvailable;
    $("mode-hint").textContent = s.desktopAvailable
      ? "嵌入桌面：卡片贴在桌面图标那一层，按 Win+D 也不会被收起，其他窗口会盖住它。"
      : "这台电脑上用不了嵌入桌面。";
    for (const input of document.querySelectorAll("[data-card]")) input.checked = !!s.cards[input.dataset.card]?.visible;
    if (document.activeElement !== $("project")) syncProjects(state.projects, s.quickAddProjectId);

    const conn = $("conn");
    conn.className = state.error ? "warn" : state.snapshotAt ? "ok" : "";
    conn.textContent = state.error ? `没连上：${state.error.message}` : state.snapshotAt ? "已连接 Super Productivity。" : "正在连接…";
    $("token-state").textContent = TOKEN_TEXT[s.tokenSource] || "";
  }

  window.widget.onState((next) => {
    state = next;
    render();
  });
})();
