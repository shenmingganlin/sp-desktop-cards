// fake-sp.js — 假的 SP 本地 REST 服务，行为照 SP 19.3：Bearer 鉴权、拒绝网页 Origin、
// { ok, data } 包装、今日筛选只看 dueDay/dueWithTime。给集成测试和界面截图用。

import http from "node:http";

const pad2 = (n) => String(n).padStart(2, "0");
const localDay = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
};

export function startFakeSp({ token = "A".repeat(32), data, port = 0, host = "127.0.0.1" } = {}) {
  const state = {
    tasks: structuredClone(data.allTasks),
    todayIds: new Set(data.todayTasks.map((t) => t.id)),
    tags: structuredClone(data.tags),
    projects: structuredClone(data.projects || [{ id: "INBOX_PROJECT", title: "Inbox" }]),
    repeatCfgs: structuredClone(data.repeatCfgs || []),
    current: data.current ? data.current.id : null,
    focus: structuredClone(data.focus),
    calls: [],
    bodies: [], // 写操作收到的请求体
    archived: [], // 归档过的任务 id
    failNext: null, // { status, code } 让下一个请求失败
    down: false,
    seq: 0,
  };
  const find = (id) => state.tasks.find((t) => t.id === id);
  const send = (res, status, body) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const ok = (res, d, status = 200) => send(res, status, { ok: true, data: d });
  const fail = (res, status, code, message = code) => send(res, status, { ok: false, error: { code, message } });
  // SP 的今日判定：dueWithTime 优先，否则看 dueDay。「今天」按测试数据的 now 算，单元测试不受真实日期影响。
  const today = localDay(data.now ?? Date.now());
  const isToday = (t) => (t.dueWithTime ? localDay(t.dueWithTime) === today : t.dueDay === today);

  const server = http.createServer(async (req, res) => {
    if (state.down) return req.socket.destroy();
    const url = new URL(req.url, "http://x");
    state.calls.push(`${req.method} ${url.pathname}${url.search}`);
    if (req.headers.origin && req.headers.origin !== "null") return fail(res, 403, "FORBIDDEN");
    if (req.headers.authorization !== `Bearer ${token}`) return fail(res, 401, "UNAUTHORIZED");
    // failNext.match（如 "PATCH /tasks"）：只让这类请求失败，免得被后台轮询先用掉
    if (state.failNext && (!state.failNext.match || `${req.method} ${url.pathname}`.startsWith(state.failNext.match))) {
      const f = state.failNext;
      state.failNext = null;
      return fail(res, f.status, f.code);
    }
    let body = {};
    if (req.method !== "GET") {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      body = raw ? JSON.parse(raw) : {};
      state.bodies.push({ method: req.method, path: url.pathname, body });
    }
    const p = url.pathname;
    const parts = p.split("/").filter(Boolean);

    if (req.method === "GET" && p === "/task-control/current") return ok(res, state.current ? find(state.current) : null);
    if (req.method === "GET" && p === "/focus") return ok(res, state.focus);
    if (req.method === "GET" && p === "/tags") return ok(res, state.tags);
    if (req.method === "GET" && p === "/projects") return ok(res, state.projects);
    if (req.method === "GET" && p === "/task-repeat-cfgs") return ok(res, state.repeatCfgs);
    if (req.method === "POST" && p === "/task-control/stop") {
      state.current = null;
      return ok(res, { currentTaskId: null });
    }
    if (req.method === "GET" && p === "/tasks") {
      let list = state.tasks;
      if (url.searchParams.get("tagId") === "TODAY") list = list.filter((t) => state.todayIds.has(t.id) || isToday(t));
      if (url.searchParams.get("includeDone") !== "true") list = list.filter((t) => !t.isDone);
      return ok(res, list);
    }
    if (req.method === "POST" && p === "/tasks") {
      if (typeof body.title !== "string" || !body.title.trim()) return fail(res, 400, "INVALID_INPUT");
      state.seq += 1;
      const t = {
        id: `new${state.seq}`,
        title: body.title.trim(),
        isDone: false,
        projectId: body.projectId || "INBOX_PROJECT",
        tagIds: body.tagIds || [],
        subTaskIds: [],
        timeEstimate: 0,
        timeSpent: 0,
        timeSpentOnDay: {},
        created: Date.now(),
        dueDay: body.dueDay,
        dueWithTime: body.dueWithTime,
      };
      state.tasks.push(t);
      return ok(res, t, 201);
    }
    if (parts[0] === "tasks" && parts[1]) {
      const t = find(decodeURIComponent(parts[1]));
      if (!t) return fail(res, 404, "TASK_NOT_FOUND");
      if (req.method === "PATCH" && parts.length === 2) {
        if (typeof body.isDone === "boolean") t.isDone = body.isDone;
        if (t.isDone && state.current === t.id) state.current = null;
        // SP 20 的 REST 白名单里有 tagIds（实测 200，读回来就是新的一组）
        if (Array.isArray(body.tagIds)) t.tagIds = [...body.tagIds];
        // SP 19.x 支持改排期字段，null 表示清空
        if ("dueDay" in body) t.dueDay = body.dueDay;
        if ("dueWithTime" in body) t.dueWithTime = body.dueWithTime;
        return ok(res, t);
      }
      if (req.method === "DELETE" && parts.length === 2) {
        state.tasks = state.tasks.filter((x) => x.id !== t.id && x.parentId !== t.id);
        state.todayIds.delete(t.id);
        if (state.current === t.id) state.current = null;
        return ok(res, { deleted: true, id: t.id });
      }
      if (req.method === "POST" && parts[2] === "start") {
        state.current = t.id;
        return ok(res, { currentTaskId: t.id });
      }
      // 归档：照 SP 的规则——连子任务一起搬走，子任务不能单独归档
      if (req.method === "POST" && parts[2] === "archive") {
        if (t.parentId) return fail(res, 400, "INVALID_INPUT", "Cannot archive a subtask on its own; archive its parent task, which takes its subtasks with it");
        const ids = new Set([t.id, ...(t.subTaskIds || [])]);
        state.tasks = state.tasks.filter((x) => !ids.has(x.id));
        state.todayIds = new Set([...state.todayIds].filter((x) => !ids.has(x)));
        if (ids.has(state.current)) state.current = null;
        state.archived.push(...[...ids]);
        return ok(res, { id: t.id, archived: true });
      }
    }
    return fail(res, 404, "NOT_FOUND");
  });

  return new Promise((resolve) => {
    server.listen(port, host, () => {
      const { port: actual } = server.address();
      resolve({
        url: `http://${host}:${actual}`,
        token,
        state,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}
