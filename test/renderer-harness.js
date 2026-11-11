// Node 中执行真实渲染脚本；只替代 DOM 与 IPC，不复制卡片的业务逻辑。
import fs from "node:fs";
import vm from "node:vm";

export function createRenderer(type, { action = async () => ({ ok: true }), now = () => Date.now() } = {}) {
  const roots = new Map();
  const document = { activeElement: null, addEventListener() {} };
  class Element {
    constructor(tag = "div") {
      this.tag = tag;
      this.children = [];
      this.dataset = {};
      this.style = {};
      this.listeners = {};
      this.disabled = false;
      this.hidden = false;
      this.value = "";
      this.className = "";
      this.text = "";
      const classes = new Set();
      this.classList = {
        add: (...names) => names.forEach((name) => classes.add(name)),
        contains: (name) => classes.has(name),
        toggle(name, on = !classes.has(name)) { if (on) classes.add(name); else classes.delete(name); },
      };
    }
    get textContent() { return this.text + this.children.map((node) => node.textContent).join(""); }
    set textContent(value) { this.text = String(value); this.children = []; }
    append(...nodes) {
      for (const node of nodes) {
        if (node.tag === "#fragment") this.append(...node.children);
        else this.children.push(node);
      }
    }
    appendChild(node) { this.append(node); return node; }
    replaceChildren(...nodes) { this.text = ""; this.children = []; this.append(...nodes); }
    addEventListener(name, fn) { (this.listeners[name] ||= []).push(fn); }
    setAttribute() {}
    focus() { document.activeElement = this; }
    setSelectionRange() {}
    emit(name, event = {}) {
      for (const fn of this.listeners[name] || []) fn({ stopPropagation() {}, preventDefault() {}, ...event });
    }
    querySelector(selector) {
      const matches = (node) => selector === "input[data-add]"
        ? node.tag === "input" && node.dataset.add === "1"
        : selector.startsWith(".") && node.className.split(" ").includes(selector.slice(1));
      const find = (nodes) => {
        for (const node of nodes) {
          if (matches(node)) return node;
          const child = find(node.children);
          if (child) return child;
        }
        return null;
      };
      return find(this.children);
    }
  }
  document.createElement = (tag) => new Element(tag);
  document.createDocumentFragment = () => new Element("#fragment");
  document.getElementById = (id) => {
    if (!roots.has(id)) roots.set(id, new Element());
    return roots.get(id);
  };
  document.body = new Element("body");
  document.querySelector = (selector) => document.getElementById("body").querySelector(selector);
  const context = vm.createContext({
    document,
    window: { widget: { action }, addEventListener() {} },
    location: { search: `?card=${type}` },
    URLSearchParams,
    Date: class extends Date { static now() { return now(); } },
    setTimeout: () => 0,
    clearTimeout() {},
  });
  for (const file of ["card.js", `cards/${type}.js`]) {
    vm.runInContext(fs.readFileSync(new URL(`../src/renderer/${file}`, import.meta.url), "utf8"), context);
  }
  const W = vm.runInContext("W", context);
  return {
    W, document,
    input: () => document.querySelector("input[data-add]"),
    update(state) { W.setState(state); W.render(); },
    type(input, value) { input.value = value; input.emit("input"); },
    enter(input) { input.emit("keydown", { key: "Enter", isComposing: false }); },
  };
}
