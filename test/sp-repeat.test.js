// 用 SP v19.3.1 自己的测试（Jasmine 写法）核对 src/main/repeat.js 的移植。
// spec 文件原样放在 test/sp-spec/，这里把它们的 import 改指向 shim.js，
// 再提供 describe / it / expect / spyOn，交给 node:test 跑。

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "sp-spec");
const shimUrl = pathToFileURL(path.join(dir, "shim.js")).href;

// selectors 的 spec 覆盖了很多没移植的选择器，只跑和「某天有哪些重复」有关的那几组。
const SPECS = {
  "get-newest-possible-due-date.util.spec.ts": null,
  "task-repeat-cfg.selectors.spec.ts": [
    "selectTaskRepeatCfgsDueOnDay",
    "Issue #5806 - Weekly tasks with correct weekday show in planner",
    "isPaused filter for selectTaskRepeatCfgsForExactDay",
    "Timezone Edge Cases for selectTaskRepeatCfgsForExactDay",
  ],
};

// ── Jasmine 的一小部分 ──
const spies = [];
function spyOn(obj, name) {
  const original = obj[name];
  const spy = (...args) => {
    spy.calls.push(args);
  };
  spy.calls = [];
  spy.isSpy = true;
  obj[name] = spy;
  spies.push(() => (obj[name] = original));
  return spy;
}

function matchers(actual, negate) {
  const check = (pass, message) => assert.ok(negate ? !pass : pass, negate ? `not: ${message}` : message);
  const equal = (a, b) => {
    try {
      assert.deepStrictEqual(a, b);
      return true;
    } catch {
      return false;
    }
  };
  const show = (v) => (v instanceof Date ? v.toString() : JSON.stringify(v));
  return {
    toBe: (expected) => check(Object.is(actual, expected), `${show(actual)} toBe ${show(expected)}`),
    toEqual: (expected) => check(equal(actual, expected), `${show(actual)} toEqual ${show(expected)}`),
    toBeNull: () => check(actual === null, `${show(actual)} toBeNull`),
    toBeUndefined: () => check(actual === undefined, `${show(actual)} toBeUndefined`),
    toBeTruthy: () => check(!!actual, `${show(actual)} toBeTruthy`),
    toContain: (item) => check(actual.some((x) => equal(x, item)), `${show(actual)} toContain ${show(item)}`),
    toHaveBeenCalledTimes: (n) => check(actual.calls.length === n, `called ${actual.calls.length} times, expected ${n}`),
    toThrowError: () => {
      let threw = false;
      try {
        actual();
      } catch {
        threw = true;
      }
      check(threw, "toThrowError");
    },
  };
}
const expect = (actual) => Object.assign(matchers(actual, false), { not: matchers(actual, true) });

let allow = null;
let depth = 0;
const jasmineDescribe = (name, fn) => {
  if (depth === 0 && allow && !allow.includes(name)) return;
  describe(name, () => {
    depth += 1;
    try {
      fn();
    } finally {
      depth -= 1;
    }
  });
};

Object.assign(globalThis, { describe: jasmineDescribe, it, expect, spyOn, beforeEach, afterEach });
afterEach(() => {
  while (spies.length) spies.pop()();
});

// 改写 import 后放进临时目录（Node 24 可以直接跑去掉类型的 .ts）
const tmp = fs.mkdtempSync(path.join(dir, ".run-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

for (const [file, only] of Object.entries(SPECS)) {
  const source = fs.readFileSync(path.join(dir, file), "utf8");
  const rewritten = source.replace(/from\s+'\.{1,2}\/[^']+'/g, `from '${shimUrl}'`);
  const target = path.join(tmp, file);
  fs.writeFileSync(target, rewritten);
  allow = only;
  await import(pathToFileURL(target).href);
  allow = null;
}
