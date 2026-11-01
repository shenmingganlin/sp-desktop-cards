// smoke.mjs — 用假 SP 启动真正的小窗，截图后退出。用来看界面、发布前自检。
// 用法：node scripts/smoke.mjs [输出目录]   默认 .smoke/
// 截图：expanded.png（展开）、collapsed.png（折叠），另有 focus-expanded.png（番茄钟进行中）。

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import electron from "electron";
import { startFakeSp } from "../test/fake-sp.js";
import { sampleData } from "../test/fixtures.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.resolve(process.argv[2] || path.join(root, ".smoke"));
fs.mkdirSync(out, { recursive: true });

async function run(name, mutate, { collapse = false } = {}) {
  const data = sampleData(Date.now());
  mutate?.(data);
  const sp = await startFakeSp({ data });
  const dir = path.join(out, name);
  const userData = path.join(dir, "user-data");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(path.join(userData, "settings.json"), JSON.stringify({ bounds: { x: 100, y: 100, width: 320, height: 470 } }));
  const env = { ...process.env, SPW_SMOKE_DIR: dir, SPW_USER_DATA: userData, SPW_BASE_URL: sp.url, SPW_TOKEN: sp.token };
  if (collapse) env.SPW_SMOKE_COLLAPSE = "1";
  // SPW_EXE 指向打包好的程序时检查打包产物，否则用开发版 electron 跑源码。
  const child = process.env.SPW_EXE
    ? spawn(process.env.SPW_EXE, [], { env, stdio: "inherit" })
    : spawn(electron, [root], { env, stdio: "inherit" });
  const code = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill();
      resolve("timeout");
    }, 30000);
    child.on("exit", (c) => {
      clearTimeout(timer);
      resolve(c);
    });
  });
  await sp.close();
  const shots = fs.readdirSync(dir).filter((f) => f.endsWith(".png"));
  console.log(name, "exit", code, shots.join(", "));
  return { code, shots };
}

const results = [];
results.push(await run("basic", (d) => {
  d.current = d.allTasks.find((t) => t.id === "c2");
}, { collapse: true }));
results.push(await run("focus", (d) => {
  d.current = d.allTasks.find((t) => t.id === "report");
  d.focus = { mode: "Pomodoro", cycle: 2, isSessionDone: false, timer: { purpose: "work", status: "running", isOvertime: false, isLongBreak: false, elapsedMs: 7 * 60_000, remainingMs: 18 * 60_000 + 12_000, durationMs: 25 * 60_000 } };
}));
results.push(await run("empty", (d) => {
  d.allTasks = [];
  d.todayTasks = [];
}));

if (results.some((r) => r.code !== 0 || !r.shots.length)) process.exit(1);
