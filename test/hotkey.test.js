import assert from "node:assert/strict";
import test from "node:test";
import { acceleratorOf, defaultKey, isKey, isModifier, keyText, normalizeKey, sameKey } from "../src/main/hotkey.js";
import { sanitize } from "../src/main/settings.js";

test("快捷键：修饰键顺序固定，字母大小写不敏感", () => {
  assert.deepEqual(normalizeKey({ mods: ["alt", "ctrl"], key: "x" }), { mods: ["ctrl", "alt"], key: "X" });
  assert.deepEqual(normalizeKey({ mods: ["shift", "win", "ctrl", "alt"], key: "F5" }), {
    mods: ["ctrl", "alt", "shift", "win"],
    key: "F5",
  });
  // 重复的修饰键只算一次
  assert.deepEqual(normalizeKey({ mods: ["ctrl", "ctrl"], key: "A" }), { mods: ["ctrl"], key: "A" });
});

test("快捷键：至少要一个修饰键和一个普通键", () => {
  assert.equal(normalizeKey(null), null);
  assert.equal(normalizeKey({}), null);
  // 只有修饰键：按下去会把所有 Ctrl 组合都吃掉
  assert.equal(normalizeKey({ mods: ["ctrl"], key: null }), null);
  assert.equal(normalizeKey({ mods: ["ctrl"] }), null);
  // 只有普通键：会把日常打字吃掉
  assert.equal(normalizeKey({ mods: [], key: "X" }), null);
  assert.equal(normalizeKey({ key: "X" }), null);
  // 不认识的键丢掉
  assert.equal(normalizeKey({ mods: ["ctrl"], key: "F13" }), null);
  assert.equal(normalizeKey({ mods: ["hyper"], key: "X" }), null);
  // 修饰键放错位置不算普通键
  assert.equal(normalizeKey({ mods: ["ctrl"], key: "ctrl" }), null);
});

test("快捷键：转成 Electron 的 accelerator", () => {
  assert.equal(acceleratorOf({ mods: ["ctrl", "alt"], key: "X" }), "Control+Alt+X");
  assert.equal(acceleratorOf({ mods: ["win", "shift"], key: "Space" }), "Shift+Super+Space");
  assert.equal(acceleratorOf({ mods: ["alt"], key: "F9" }), "Alt+F9");
  // 不合法给空串，调用方据此跳过注册
  assert.equal(acceleratorOf({ mods: [], key: "X" }), "");
  assert.equal(acceleratorOf(null), "");
});

test("快捷键：显示文本", () => {
  assert.equal(keyText({ mods: ["ctrl", "alt"], key: "X" }), "Ctrl + Alt + X");
  assert.equal(keyText({ mods: ["win"], key: "PageUp" }), "Win + PgUp");
  assert.equal(keyText(null), "");
});

test("快捷键：比较两个组合是不是同一个", () => {
  const a = { mods: ["ctrl", "alt"], key: "X" };
  assert.equal(sameKey(a, { mods: ["ctrl", "alt"], key: "X" }), true);
  assert.equal(sameKey(a, { mods: ["ctrl"], key: "X" }), false);
  assert.equal(sameKey(a, { mods: ["ctrl", "alt"], key: "Y" }), false);
  assert.equal(sameKey(a, null), false);
  assert.equal(sameKey(null, null), false);
});

test("快捷键：修饰键和普通键的判定", () => {
  for (const m of ["ctrl", "alt", "shift", "win"]) assert.equal(isModifier(m), true, m);
  assert.equal(isModifier("X"), false);
  assert.equal(isKey("X"), true);
  assert.equal(isKey("F12"), true);
  assert.equal(isKey("ctrl"), false);
  assert.equal(isKey("F13"), false);
});

test("设置：快捷键不合法时留着原来的，不会被冲掉", () => {
  const base = sanitize(null);
  assert.deepEqual(base.clickThroughKey, defaultKey(), "默认是 Ctrl + Alt + X");
  assert.equal(base.clickThrough, false, "不挡点击默认关");

  // 合法的存进去
  const s1 = sanitize({ clickThroughKey: { mods: ["alt", "ctrl"], key: "k" } }, base);
  assert.deepEqual(s1.clickThroughKey, { mods: ["ctrl", "alt"], key: "K" });

  // 不合法的（只有普通键 / 只有修饰键 / 乱写的）都留着原来的
  for (const bad of [{ mods: [], key: "X" }, { mods: ["ctrl"] }, { key: "X" }, "nope", null, { mods: ["ctrl"], key: "F13" }]) {
    assert.deepEqual(sanitize({ clickThroughKey: bad }, s1).clickThroughKey, s1.clickThroughKey, JSON.stringify(bad));
  }
});

test("设置：不挡点击开关只认布尔值", () => {
  assert.equal(sanitize({ clickThrough: true }).clickThrough, true);
  assert.equal(sanitize({ clickThrough: false }).clickThrough, false);
  assert.equal(sanitize({ clickThrough: "yes" }).clickThrough, false, "字符串不当真");
  assert.equal(sanitize({ clickThrough: 1 }).clickThrough, false);
});
