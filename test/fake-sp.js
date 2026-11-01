// fake-sp.js — 假的 SP 本地 REST 服务，行为照 SP 19.3：Bearer 鉴权、拒绝网页 Origin、
// { ok, data } 包装、今日筛选只看 dueDay/dueWithTime。给集成测试和界面截图用。

import http from "node:http";

export function startFakeSp({ token = "A".repeat(32), data, port = 0, host = "127.0.0.1" } = {}) {
  const state = {
    tasks: structuredClone(data.allTasks),
    todayIds: new Set(data.todayTasks.map((t) => t.id)),
    tags: structuredClone(data.tags),
    current: data.current ? data.current.id : null,
    focus: structuredClone(data.focus),
    calls: [],
    failNext: null, // { status, code } 让下一个请求失败
    down: false,
  };
  const find = (id) => state.tasks.find((t) => t.id === id);
  const send = (res, status, body) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const ok = (res, d, status = 200) => send(res, status, { ok: true, data: d });
  const fail = (res, status, code, message = code) => send(res, status, { ok: false, error: { code, message } });

  const server = http.createServer(async (req, res) => {
    if (state.down) return req.socket.destroy();
    const url = new URL(req.url, "http://x");
    state.calls.push(`${req.method} ${url.pathname}${url.search}`);
    if (req.headers.origin && req.headers.origin !== "null") return fail(res, 403, "FORBIDDEN");
    if (req.headers.authorization !== `Bearer ${token}`) return fail(res, 401, "UNAUTHORIZED");
    if (state.failNext) {
      const f = state.failNext;
      state.failNext = null;
      return fail(res, f.status, f.code);
    }
    let body = {};
    if (req.method !== "GET") {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      body = raw ? JSON.parse(raw) : {};
    }
    const p = url.pathname;
    const parts = p.split("/").filter(Boolean);

    if (req.method === "GET" && p === "/task-control/current") return ok(res, state.current ? find(state.current) : null);
    if (req.method === "GET" && p === "/focus") return ok(res, state.focus);
    if (req.method === "GET" && p === "/tags") return ok(res, state.tags);
    if (req.method === "POST" && p === "/task-control/stop") {
      state.current = null;
      return ok(res, { currentTaskId: null });
    }
    if (req.method === "GET" && p === "/tasks") {
      let list = state.tasks;
      if (url.searchParams.get("tagId") === "TODAY") list = list.filter((t) => state.todayIds.has(t.id));
      if (url.searchParams.get("includeDone") !== "true") list = list.filter((t) => !t.isDone);
      return ok(res, list);
    }
    if (parts[0] === "tasks" && parts[1]) {
      const t = find(decodeURIComponent(parts[1]));
      if (!t) return fail(res, 404, "TASK_NOT_FOUND");
      if (req.method === "PATCH" && parts.length === 2) {
        if (typeof body.isDone === "boolean") t.isDone = body.isDone;
        if (t.isDone && state.current === t.id) state.current = null;
        return ok(res, t);
      }
      if (req.method === "POST" && parts[2] === "start") {
        state.current = t.id;
        return ok(res, { currentTaskId: t.id });
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
