// poller.js — 定时向 SP 取原始数据。各卡片要的视图由 main.js 按需整理（model.js / calendar.js）。
//
// SP 的 REST API 不会主动推送，只能轮询，分快慢两档：
//   快（默认 2 秒）：当前计时任务和番茄钟，两个很小的请求。
//   慢（默认 15 秒）：今日任务、全部任务、标签、项目、重复配置。当前任务变了或刚做完操作时立即补一次。
// 两次轮询之间的秒数由渲染进程按本机时钟往前推，所以计时看起来是连续走的。

export function createPoller({
  client,
  onData,
  onError,
  fastMs = 2000,
  slowMs = 15000,
  idleFastMs = 10000,
  retryMs = 5000,
  now = () => Date.now(),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  let lists = null;
  let listsAt = 0;
  let lastCurrentId;
  let timer = null;
  let running = false;
  let inFlight = null;
  let pendingFull = false;
  let idle = false;
  let failing = false;

  async function refresh(full) {
    const [current, focus] = await Promise.all([client.current(), client.focus()]);
    const currentId = current?.id ?? null;
    const changed = currentId !== lastCurrentId;
    lastCurrentId = currentId;
    if (full || !lists || changed || now() - listsAt >= slowMs) {
      const [todayTasks, allTasks, tags, projects, repeatCfgs] = await Promise.all([
        client.todayTasks(),
        client.allTasks(),
        client.tags(),
        client.projects(),
        client.repeatCfgs(),
      ]);
      listsAt = now();
      // listsAt 让 main.js 知道列表换过了，规划、月历这些只在列表变了时重算
      lists = { todayTasks, allTasks, tags, projects, repeatCfgs, listsAt };
    }
    const at = now();
    return {
      ...lists,
      current,
      focus,
      now: at,
      snapshotAt: at,
      // 计时是否在走：有当前任务，或番茄钟在跑。渲染进程据此往前推秒数。
      ticking: { task: !!current, focus: focus?.timer?.status === "running" },
    };
  }

  function schedule(ms) {
    clearTimer(timer);
    if (running) timer = setTimer(() => run(false), ms);
  }

  async function run(full) {
    if (inFlight) {
      // 正在取数据时又要求刷新：等这次结束后再补一次完整刷新。
      pendingFull = pendingFull || full;
      return inFlight;
    }
    inFlight = (async () => {
      try {
        const data = await refresh(full || failing);
        failing = false;
        onData(data);
        schedule(idle ? idleFastMs : fastMs);
      } catch (error) {
        failing = true;
        onError(error);
        schedule(retryMs);
      } finally {
        inFlight = null;
      }
      if (pendingFull) {
        pendingFull = false;
        await run(true);
      }
    })();
    return inFlight;
  }

  return {
    start() {
      running = true;
      return run(true);
    },
    stop() {
      running = false;
      clearTimer(timer);
    },
    /** 操作完成、窗口重新显示、系统唤醒后调用：立即完整刷新。 */
    kick: () => run(true),
    /** 立即跑一轮普通轮询（测试用）。 */
    poll: () => run(false),
    /** 窗口隐藏或折叠时放慢。 */
    setIdle(value) {
      idle = !!value;
    },
  };
}
