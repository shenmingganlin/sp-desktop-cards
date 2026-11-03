// appearance.js — 外观窗口：列出所有皮肤，点一下就换；设置页只留一个入口，不占地方。
"use strict";

(() => {
  const $ = (id) => document.getElementById(id);
  const grid = $("grid");
  let skins = [];
  let current = null;
  let source = "";

  const apply = (id) => {
    if (window.WTheme) window.WTheme.apply(id);
  };

  function render() {
    grid.replaceChildren(
      ...skins.map((skin) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = skin.id === current ? "skin selected" : "skin";
        button.dataset.skin = skin.id;
        button.setAttribute("role", "listitem");
        button.setAttribute("aria-pressed", skin.id === current ? "true" : "false");

        const preview = document.createElement("div");
        preview.className = "preview";
        preview.dataset.theme = skin.id;
        preview.innerHTML = '<div class="p-head"></div><div class="p-row current"></div><div class="p-row"></div><div class="p-row short"></div>';

        const name = document.createElement("span");
        name.className = "skin-name";
        name.textContent = skin.name;
        const note = document.createElement("span");
        note.className = "skin-note";
        note.textContent = skin.note;

        button.append(preview, name, note);
        button.addEventListener("click", () => void choose(skin.id));
        return button;
      }),
    );
    const found = skins.find((skin) => skin.id === current);
    $("current").textContent = found ? `当前：${found.name}` : "";
    $("external").hidden = !source;
    $("external").textContent = source ? `皮肤正由「${source}」设置；在这里选会改掉手选的皮肤，但外部来源还会盖过它。` : "";
  }

  async function choose(id) {
    const result = await window.widget.action("setTheme", { id });
    if (!result?.ok) return;
    current = id;
    apply(id);
    render();
  }

  window.widget.onEvent((event) => {
    if (event?.type !== "theme" || !event.theme) return;
    current = event.theme;
    apply(current);
    render();
  });

  (async () => {
    const result = await window.widget.action("themeCatalog");
    if (!result?.ok) {
      $("current").textContent = "没能读到皮肤列表";
      return;
    }
    skins = result.data.skins;
    current = result.data.current;
    source = result.data.source || "";
    apply(current);
    render();
  })();

  $("done").addEventListener("click", () => window.widget.action("closeAppearance"));
})();
