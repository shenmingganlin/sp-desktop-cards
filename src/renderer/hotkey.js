// hotkey.js — 快捷键录制窗口：画一个键盘，左键选、右键取消，确定时交给主进程试注册。
// 键位表由主进程推过来（和 hotkey.js 里的同一份），这里只管画和收集。
"use strict";

(() => {
  const $ = (id) => document.getElementById(id);
  const act = (name, payload) => window.widget.action(name, payload);

  let modifiers = []; // [{ id, label }]
  let keys = []; // [{ id, label }]
  let mods = []; // 选中的修饰键 id
  let key = null; // 选中的普通键 id
  let busy = false;
  let errorText = ""; // 注册失败的原因，render 时显示

  // 键盘的排布：功能键一行，字母三行，数字一行，最下面一排杂项。
  // 只影响显示，选中与否和键 id 无关。
  const LAYOUT = [
    ["F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11", "F12"],
    ["Q", "W", "E", "R", "T", "Y", "U", "I", "O", "P"],
    ["A", "S", "D", "F", "G", "H", "J", "K", "L"],
    ["Z", "X", "C", "V", "B", "N", "M"],
    ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"],
    ["Space", "Enter", "Tab", "Backspace", "Delete", "Insert"],
    ["Home", "End", "PageUp", "PageDown", "Up", "Down", "Left", "Right"],
  ];

  const labelOf = (id) => keys.find((k) => k.id === id)?.label || id;
  const modLabelOf = (id) => modifiers.find((m) => m.id === id)?.label || id;

  function comboText() {
    return [...mods.map(modLabelOf), key ? labelOf(key) : null].filter(Boolean).join(" + ");
  }

  function makeKey(id, label, extra) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = `key ${extra || ""}`;
    b.dataset.key = id;
    b.textContent = label;
    // 左键选、右键取消；右键不弹系统菜单
    b.addEventListener("click", () => pick(id));
    b.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      drop(id);
    });
    return b;
  }

  function pick(id) {
    if (busy) return;
    errorText = "";
    if (modifiers.some((m) => m.id === id)) {
      if (!mods.includes(id)) mods = [...mods, id];
    } else {
      // 普通键只能有一个：再点一个就换成它
      key = id;
    }
    render();
  }

  function drop(id) {
    if (busy) return;
    errorText = "";
    if (modifiers.some((m) => m.id === id)) mods = mods.filter((m) => m !== id);
    else if (key === id) key = null;
    render();
  }

  function render() {
    const kb = $("keyboard");
    kb.replaceChildren();

    // 修饰键单独一行，好点
    const modRow = document.createElement("div");
    modRow.className = "kb-row mods";
    for (const m of modifiers) {
      const b = makeKey(m.id, m.label, `mod${mods.includes(m.id) ? " on" : ""}`);
      modRow.append(b);
    }
    kb.append(modRow);

    for (const row of LAYOUT) {
      const line = document.createElement("div");
      line.className = "kb-row";
      for (const id of row) {
        // 键位表里没有的就不画（主进程那份是权威）
        if (!keys.some((k) => k.id === id)) continue;
        const cls = key === id ? "on" : key ? "dim" : "";
        line.append(makeKey(id, labelOf(id), cls));
      }
      if (line.childElementCount) kb.append(line);
    }

    const text = comboText();
    const box = $("combo");
    box.textContent = text || "还没选";
    box.classList.toggle("empty", !text);
    // 至少要有修饰键和一个普通键才能确定
    $("ok").disabled = busy || !mods.length || !key;
    const err = $("error");
    err.textContent = errorText;
    err.hidden = !errorText;
  }

  async function confirm() {
    if (busy) return;
    busy = true;
    render();
    const result = await act("setClickThroughKey", { mods, key });
    busy = false;
    if (result?.ok) {
      window.close();
      return;
    }
    // 被占用之类：留在窗口里说清楚，让用户换一个。
    // 先记下来再 render：render 会按 error 状态决定显不显示。
    errorText = result?.message || "没能注册这个组合，换一个试试。";
    render();
  }

  $("cancel").addEventListener("click", () => act("closeHotkey"));
  $("ok").addEventListener("click", () => void confirm());
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") act("closeHotkey");
  });

  // 顶栏拖动：和卡片一样交给主进程，用窗口外框算
  const head = $("head");
  head.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    head.setPointerCapture(e.pointerId);
    window.widget.dragStart(false);
  });
  for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) {
    head.addEventListener(type, () => window.widget.dragEnd());
  }

  window.widget.onEvent((e) => {
    if (e?.type === "theme" && window.WTheme) window.WTheme.apply(e.theme);
  });

  (async () => {
    const result = await act("hotkeyCatalog");
    if (!result?.ok) {
      $("error").textContent = "没能读到键位表";
      $("error").hidden = false;
      return;
    }
    modifiers = result.data.modifiers;
    keys = result.data.keys;
    const current = result.data.current;
    if (current) {
      mods = [...current.mods];
      key = current.key;
    }
    render();
  })();
})();
