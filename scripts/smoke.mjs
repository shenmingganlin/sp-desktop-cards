// smoke.mjs — 用假 SP 启动真正的小窗，每张卡片截一张图后退出。用来看界面、发布前自检。
// 用法：node scripts/smoke.mjs [输出目录]   默认 .smoke/
// 每个场景一个子目录：<卡片>.png、layout.json（各卡片的位置），all 场景另有 settings.png。

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

// 卡片排成几列，「专注」拼在「今日」上方
const card = (x, y, width, height) => ({ visible: true, collapsed: false, bounds: { x, y, width, height } });
const ALL = {
  version: 2,
  cards: {
    focus: card(40, 40, 320, 132),
    today: card(40, 178, 320, 400),
    planner: card(366, 40, 320, 538),
    schedule: card(692, 40, 320, 538),
    month: card(1018, 40, 320, 470),
    list: card(1344, 40, 320, 420),
    heatmap: card(1670, 40, 340, 220),
    triage: card(1670, 266, 320, 400),
    breakdown: card(1344, 470, 320, 340),
    finishday: card(40, 584, 320, 440),
    boards: card(366, 584, 460, 420),
  },
};

async function run(name, { mutate, settings = ALL, extraEnv = {}, expect }) {
  const data = sampleData(Date.now());
  // 看板/矩阵要用的三个默认标签是 SP 第一次打开看板时才建的；假 SP 里补上，让卡片走到分列那条路
  data.tags = [...data.tags,
    { id: "KANBAN_IN_PROGRESS", title: "in-progress", taskIds: ["standup"] },
    { id: "EM_URGENT", title: "urgent", taskIds: [] },
    { id: "EM_IMPORTANT", title: "important", taskIds: [] }];
  data.allTasks = data.allTasks.map((t) => (t.id === "standup" ? { ...t, tagIds: ["KANBAN_IN_PROGRESS"] } : t.id === "review" ? { ...t, tagIds: [...t.tagIds, "EM_URGENT", "EM_IMPORTANT"] } : t));
  mutate?.(data);
  const sp = await startFakeSp({ data });
  const dir = path.join(out, name);
  const userData = path.join(dir, "user-data");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(path.join(userData, "settings.json"), JSON.stringify(settings));
  const env = { ...process.env, SPW_SMOKE_DIR: dir, SPW_USER_DATA: userData, SPW_BASE_URL: sp.url, SPW_TOKEN: sp.token, ...extraEnv };
  // SPW_EXE 指向打包好的程序时检查打包产物，否则用开发版 electron 跑源码。
  const child = process.env.SPW_EXE
    ? spawn(process.env.SPW_EXE, [], { env, stdio: "inherit" })
    : spawn(electron, [root], { env, stdio: "inherit" });
  const code = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill();
      resolve("timeout");
    }, 40000);
    child.on("exit", (c) => {
      clearTimeout(timer);
      resolve(c);
    });
  });
  await sp.close();
  const shots = fs.readdirSync(dir).filter((f) => f.endsWith(".png")).sort();
  const missing = expect.filter((f) => !shots.includes(f));
  console.log(name, "exit", code, shots.join(", "), missing.length ? `缺少 ${missing.join(", ")}` : "");
  return { ok: code === 0 && !missing.length };
}

const PNG = (...types) => types.map((t) => `${t}.png`);
const results = [];
results.push(await run("all", {
  mutate: (d) => (d.current = d.allTasks.find((t) => t.id === "c2")),
  extraEnv: { SPW_SMOKE_SETTINGS: "1" },
  expect: [...PNG("focus", "today", "planner", "schedule", "month", "list", "heatmap", "triage", "breakdown", "finishday", "boards"), "settings.png"],
}));
// 0.1.0 的设置：迁移后只有「专注」和「今日」
results.push(await run("migrate", {
  settings: { bounds: { x: 100, y: 100, width: 320, height: 470 }, opacity: 0.95 },
  expect: PNG("focus", "today"),
}));
// 矩阵：同一份数据切到四象限
results.push(await run("boards-matrix", {
  settings: { version: 2, boardPreset: "eisenhower", cards: { boards: ALL.cards.boards } },
  expect: PNG("boards"),
}));
results.push(await run("sp-focus", {
  mutate: (d) => {
    d.current = d.allTasks.find((t) => t.id === "report");
    d.focus = { mode: "Pomodoro", cycle: 2, isSessionDone: false, timer: { purpose: "work", status: "running", isOvertime: false, isLongBreak: false, elapsedMs: 7 * 60_000, remainingMs: 18 * 60_000 + 12_000, durationMs: 25 * 60_000 } };
  },
  expect: PNG("focus", "today"),
  settings: { version: 2, cards: { focus: ALL.cards.focus, today: ALL.cards.today } },
}));
results.push(await run("empty", {
  mutate: (d) => {
    d.allTasks = [];
    d.todayTasks = [];
    d.repeatCfgs = [];
  },
  expect: PNG("focus", "today", "planner", "schedule", "month", "list", "heatmap", "triage", "breakdown", "finishday", "boards"),
}));

// 改名搬家：老目录（SP 今日小窗）和新目录（SP 桌面卡片）并排放在临时目录里，
// 用 SPW_HOME 把用户目录指到这里，启动后看设置有没有从老目录搬过来（走的是真实启动路径）。
{
  const dir = path.join(out, "adopt");
  fs.rmSync(dir, { recursive: true, force: true });
  const legacy = path.join(dir, "SP 今日小窗");
  const now = path.join(dir, "SP 桌面卡片");
  fs.mkdirSync(legacy, { recursive: true });
  fs.writeFileSync(path.join(legacy, "settings.json"), JSON.stringify({ version: 2, tourDone: true, mode: "normal", opacity: 0.66, cards: { today: { visible: true, bounds: { x: 200, y: 150, width: 320, height: 400 } } } }));
  // 新目录已经被 Chromium 建出来（空的）：实际升级时经常是这样
  fs.mkdirSync(now, { recursive: true });
  const data = sampleData(Date.now());
  const sp = await startFakeSp({ data });
  const env = { ...process.env, SPW_SMOKE_DIR: dir, SPW_HOME: dir, SPW_BASE_URL: sp.url, SPW_TOKEN: sp.token };
  const child = spawn(electron, [root], { env, stdio: "inherit" });
  const code = await new Promise((resolve) => {
    const timer = setTimeout(() => { child.kill(); resolve("timeout"); }, 40000);
    child.on("exit", (c) => { clearTimeout(timer); resolve(c); });
  });
  await sp.close();
  let ok = code === 0;
  try {
    const s = JSON.parse(fs.readFileSync(path.join(now, "settings.json"), "utf8"));
    if (s.opacity !== 0.66) throw new Error(`透明度没搬过来：${s.opacity}`);
    if (fs.existsSync(legacy)) throw new Error("老目录没搬走");
  } catch (error) {
    ok = false;
    console.log("adopt 失败：", error.message);
  }
  console.log("adopt", "exit", code, ok ? "设置从老目录搬过来了" : "没搬过来");
  results.push({ ok });
}

if (results.some((r) => !r.ok)) process.exit(1);
