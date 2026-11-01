// pomodoro.js — 小窗自带的番茄钟。SP 的 REST API 只能读它自己的专注模式，不能控制，所以单独做一个。
//
// 纯状态机：每个操作返回 { state, effects }，时钟由调用方传入。effects 由 main.js 执行：
//   { type: "track", taskId }    让 SP 开始给这个任务计时
//   { type: "untrack", taskId }  SP 当前还在计这个任务时停掉
//   { type: "notify", title, body, sound }  一个阶段结束：发通知、响提示音（sound 是 work / break，表示刚结束的是哪种）
//
// status：idle 没开始；running 在走；paused 暂停；ready 上一阶段结束，等用户点开始下一阶段。
// phase：work 专注；short 短休息；long 长休息。

export const DEFAULT_POMODORO = Object.freeze({
  workMin: 25,
  shortMin: 5,
  longMin: 15,
  longEvery: 4, // 每几个专注后长休息
  autoNext: false, // 一个阶段结束后自动开始下一个
  linkTracking: true, // 专注时让 SP 计时，休息时停
  sound: true, // 阶段结束时响提示音
  surface: true, // 阶段结束时「专注」卡片浮到所有窗口上面，点一下或开始下一阶段后回去
  resume: false, // 退出或重启小窗后接着走
  confirmStop: false, // 点 ■ 结束时再确认一次
});

/** 存下来、重启后能接着走的部分。 */
export const sessionOf = (s) => (s.status === "idle" ? null : {
  phase: s.phase, status: s.status, endsAt: s.endsAt, remainingMs: s.remainingMs, durationMs: s.durationMs, taskId: s.taskId,
});

/**
 * 重启后接着上次的番茄。关着的时候到点了：按到点处理（计数、进入下一阶段），但不补发通知，
 * 也不重新让 SP 计时（关着的这段时间 SP 不一定还在计）。
 */
export function restore(s, saved, cfg, now) {
  if (!saved || !["running", "paused", "ready"].includes(saved.status) || !["work", "short", "long"].includes(saved.phase)) return s;
  const n = (v) => typeof v === "number" && Number.isFinite(v);
  if (!(saved.status === "running" ? n(saved.endsAt) : n(saved.remainingMs)) || !n(saved.durationMs)) return s;
  const r = { ...s, ...saved, taskId: typeof saved.taskId === "string" ? saved.taskId : null };
  if (r.status !== "running") return r;
  if (now < r.endsAt) return r;
  const { state } = tick(r, { ...cfg, autoNext: false, linkTracking: false }, now);
  return state;
}

export const PHASE_LABEL = { work: "专注", short: "短休息", long: "长休息" };

export function createState(stats = {}) {
  return {
    phase: "work",
    status: "idle",
    endsAt: null, // running 时有值
    remainingMs: null, // paused / ready 时有值
    durationMs: null,
    taskId: null,
    day: stats.day ?? null,
    doneToday: stats.doneToday ?? 0,
    streak: stats.streak ?? 0, // 距上次长休息完成了几个
  };
}

const durationOf = (phase, cfg) => (phase === "work" ? cfg.workMin : phase === "long" ? cfg.longMin : cfg.shortMin) * 60_000;
const track = (s, cfg) => (cfg.linkTracking && s.taskId && s.phase === "work" ? [{ type: "track", taskId: s.taskId }] : []);
const untrack = (s, cfg) => (cfg.linkTracking && s.taskId && s.phase === "work" ? [{ type: "untrack", taskId: s.taskId }] : []);

function begin(s, phase, cfg, now) {
  const durationMs = durationOf(phase, cfg);
  return { ...s, phase, status: "running", durationMs, endsAt: now + durationMs, remainingMs: null };
}

/** 跨天后今天的番茄数清零。 */
export function rollDay(s, today) {
  return s.day === today ? s : { ...s, day: today, doneToday: 0, streak: 0 };
}

/** 开始一个专注。taskId 为 null 时只计时，不碰 SP。 */
export function start(s, cfg, now, taskId = null) {
  const state = begin({ ...s, taskId }, "work", cfg, now);
  return { state, effects: track(state, cfg) };
}

export function pause(s, cfg, now) {
  if (s.status !== "running") return { state: s, effects: [] };
  const state = { ...s, status: "paused", remainingMs: Math.max(0, s.endsAt - now), endsAt: null };
  return { state, effects: untrack(s, cfg) };
}

/** 暂停后继续，或开始已经就绪的下一阶段。 */
export function resume(s, cfg, now) {
  if (s.status !== "paused" && s.status !== "ready") return { state: s, effects: [] };
  const state = { ...s, status: "running", endsAt: now + s.remainingMs, remainingMs: null };
  return { state, effects: track(state, cfg) };
}

export function stop(s, cfg) {
  const effects = s.status === "running" ? untrack(s, cfg) : [];
  return {
    state: { ...s, phase: "work", status: "idle", endsAt: null, remainingMs: null, durationMs: null, taskId: null },
    effects,
  };
}

/** 跳过当前阶段，马上开始下一阶段。跳过的专注不计数。 */
export function skip(s, cfg, now) {
  if (s.status === "idle") return { state: s, effects: [] };
  const effects = s.status === "running" ? untrack(s, cfg) : [];
  const state = begin(s, s.phase === "work" ? "short" : "work", cfg, now);
  return { state, effects: [...effects, ...track(state, cfg)] };
}

/** 每秒调用一次。到点时进入下一阶段并通知。 */
export function tick(s, cfg, now) {
  if (s.status !== "running" || now < s.endsAt) return { state: s, effects: [] };
  const effects = untrack(s, cfg);
  let next;
  let base = s;
  let notify;
  if (s.phase === "work") {
    const streak = s.streak + 1;
    const isLong = streak >= cfg.longEvery;
    next = isLong ? "long" : "short";
    base = { ...s, doneToday: s.doneToday + 1, streak: isLong ? 0 : streak };
    const min = isLong ? cfg.longMin : cfg.shortMin;
    notify = { title: "专注完成", body: `今天第 ${base.doneToday} 个番茄。${cfg.autoNext ? "开始" : "可以"}${PHASE_LABEL[next]} ${min} 分钟。`, sound: "work" };
  } else {
    next = "work";
    notify = { title: "休息结束", body: cfg.autoNext ? "开始下一个专注。" : "准备好了就开始下一个专注。", sound: "break" };
  }
  effects.push({ type: "notify", ...notify });
  if (cfg.autoNext) {
    const state = begin(base, next, cfg, now);
    return { state, effects: [...effects, ...track(state, cfg)] };
  }
  const durationMs = durationOf(next, cfg);
  return { state: { ...base, phase: next, status: "ready", endsAt: null, remainingMs: durationMs, durationMs }, effects };
}
