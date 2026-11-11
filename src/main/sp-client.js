// sp-client.js — SP 本地 REST API 客户端（只在主进程里用）。
//
// SP 会拒绝带网页 Origin 的请求（防 CSRF），所以不能在渲染进程里 fetch，
// 必须由 Node 发出。响应格式统一为 { ok: true, data } 或 { ok: false, error: { code, message } }。

export const DEFAULT_BASE_URL = "http://127.0.0.1:3876";
const TIMEOUT_MS = 8000;

export class SpError extends Error {
  constructor(code, message, status = null) {
    super(message);
    this.name = "SpError";
    this.code = code;
    this.status = status;
  }
}

/** 错误码 → 用户能照着做的说明。 */
export const HINTS = {
  SP_UNREACHABLE: "连不上 Super Productivity。确认它正在运行，并在「设置 → 杂项」里打开了本地 REST API。",
  SP_UNAUTHORIZED: "访问令牌不对。SP 可能重新生成过令牌：小窗会自动重读，如果你手填过令牌，请到设置里更新或清空。",
  SP_API_DISABLED: "SP 的本地 REST API 是关着的。到 SP「设置 → 杂项」打开它。",
  SP_NOT_READY: "SP 还在加载数据，稍等一下。",
  SP_NO_TOKEN: "没找到访问令牌。在 SP「设置 → 杂项」打开本地 REST API 后会自动生成，小窗会自己读取；也可以在设置里手填。",
  SP_TIMEOUT: "SP 没有及时回应，可能正忙。",
  SP_BAD_RESPONSE: "SP 返回的数据看不懂。小窗可能和这个版本的 SP 不兼容。",
};

export function createClient({ baseUrl = DEFAULT_BASE_URL, getToken, fetchImpl = fetch, timeoutMs = TIMEOUT_MS }) {
  const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

  async function request(method, path, body) {
    const token = await getToken();
    if (!token) throw new SpError("SP_NO_TOKEN", HINTS.SP_NO_TOKEN);
    const headers = { Authorization: `Bearer ${token}`, Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const writing = /^(POST|PATCH|PUT|DELETE)$/i.test(method);
    // 令牌、序列化和超时参数在交给网络之前检查；这些失败不会有已提交的写入。
    const options = {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    };
    const unknown = (error) => {
      if (writing) error.outcomeUnknown = true;
      return error;
    };
    const networkError = (error, status = null) => unknown(new SpError(
      error?.name === "TimeoutError" || error?.name === "AbortError" ? "SP_TIMEOUT" : "SP_UNREACHABLE",
      error?.name === "TimeoutError" || error?.name === "AbortError" ? HINTS.SP_TIMEOUT : HINTS.SP_UNREACHABLE,
      status,
    ));

    let response;
    try {
      response = await fetchImpl(baseUrl + path, options);
    } catch (error) {
      throw networkError(error);
    }
    // 401 已明确拒绝执行，不依赖错误正文能否读完。
    if (response.status === 401) throw new SpError("SP_UNAUTHORIZED", HINTS.SP_UNAUTHORIZED, 401);
    let text;
    try {
      text = await response.text();
    } catch (error) {
      throw networkError(error, response.status);
    }

    let payload = null;
    try {
      payload = JSON.parse(text);
    } catch {
      // 非 JSON 时按状态码处理
    }
    const rejected = isRecord(payload) && payload.ok === false && isRecord(payload.error) &&
      typeof payload.error.code === "string" && payload.error.code.trim().length > 0;
    if (rejected) {
      const code = payload.error.code;
      if (response.status === 503 && code === "API_DISABLED") throw new SpError("SP_API_DISABLED", HINTS.SP_API_DISABLED, 503);
      if (response.status === 503 && code === "APP_NOT_READY") throw new SpError("SP_NOT_READY", HINTS.SP_NOT_READY, 503);
      const error = new SpError(code, typeof payload.error.message === "string" && payload.error.message || `SP 返回 ${response.status}`, response.status);
      // 明确业务拒绝保留原错误；通用 5xx 即使有正文也不能证明提交已回滚。
      throw response.status >= 500 ? unknown(error) : error;
    }
    if (!response.ok) {
      const error = new SpError(`SP_HTTP_${response.status}`, `SP 返回 ${response.status}`, response.status);
      // 无有效业务拒绝的 5xx 可能出现在提交之后；普通 4xx 仍按 HTTP 拒绝处理。
      throw response.status >= 400 && response.status < 500 ? error : unknown(error);
    }
    if (!isRecord(payload) || payload.ok !== true || !Object.hasOwn(payload, "data")) {
      throw unknown(new SpError("SP_BAD_RESPONSE", HINTS.SP_BAD_RESPONSE, response.status));
    }
    if (/^POST$/i.test(method) && path === "/tasks" &&
        (!isRecord(payload.data) || typeof payload.data.id !== "string" || !payload.data.id.trim() || typeof payload.data.title !== "string")) {
      throw unknown(new SpError("SP_BAD_RESPONSE", HINTS.SP_BAD_RESPONSE, response.status));
    }
    return payload.data;
  }

  const list = async (path) => {
    const data = await request("GET", path);
    // 先拒绝坏条目，避免它覆盖最后一份可用快照后把所有卡片的视图构建一起带倒。
    if (!Array.isArray(data) || data.some((item) => !item || typeof item !== "object" || Array.isArray(item))) {
      throw new SpError("SP_BAD_RESPONSE", HINTS.SP_BAD_RESPONSE);
    }
    return data;
  };
  const id = (v) => encodeURIComponent(v);
  const doneWrites = new Map();
  let trackingWrites = Promise.resolve();

  // 跨卡片按任务串行，必须在异步读取令牌之前排队，失败也不能堵住下一次意图。
  function setDone(taskId, isDone) {
    const write = (doneWrites.get(taskId) || Promise.resolve()).catch(() => {}).then(() =>
      request("PATCH", `/tasks/${id(taskId)}`, { isDone }));
    doneWrites.set(taskId, write);
    const release = () => { if (doneWrites.get(taskId) === write) doneWrites.delete(taskId); };
    write.then(release, release);
    return write;
  }

  // SP 全局只有一个当前计时任务。开始/停止跨卡片、番茄钟共用同一 FIFO，
  // 在 request 异步读取令牌之前排队；失败只释放下一次明确操作，不重放旧请求。
  function queueTracking(work) {
    const write = trackingWrites.then(work);
    trackingWrites = write.catch(() => {});
    return write;
  }

  const track = (path) => queueTracking(() => request("POST", path));

  function stopIfCurrent(taskId) {
    return queueTracking(async () => {
      const current = await request("GET", "/task-control/current");
      if (current !== null && (!isRecord(current) || typeof current.id !== "string" || !current.id.trim())) {
        throw new SpError("SP_BAD_RESPONSE", HINTS.SP_BAD_RESPONSE);
      }
      if (!current || current.id !== taskId) return { currentTaskId: current?.id ?? null };
      // 检查和停止占同一个本机队列单元，不让后来的 start 插在中间。
      // SP 自己或其他客户端仍可能改计时状态；此 API 不提供跨进程原子比较后停止。
      return request("POST", "/task-control/stop");
    });
  }

  return {
    request,
    current: () => request("GET", "/task-control/current"),
    focus: () => request("GET", "/focus"),
    todayTasks: () => list("/tasks?tagId=TODAY&includeDone=true"),
    allTasks: () => list("/tasks?includeDone=true"),
    tags: () => list("/tags"),
    projects: () => list("/projects"),
    // 老版本 SP 没有这个接口：当作没有重复配置，不影响其他卡片
    repeatCfgs: () => list("/task-repeat-cfgs").catch((error) => {
      if (error.status === 404) return [];
      throw error;
    }),
    /** fields 只放 SP 允许写的字段；标题里的简写语法（#标签 +项目 @时间）由 SP 解析。 */
    createTask: (fields) => request("POST", "/tasks", fields),
    deleteTask: (taskId) => request("DELETE", `/tasks/${id(taskId)}`),
    setDone,
    /** 归档：SP 会连子任务一起搬走。子任务不能单独归档，SP 回 400。 */
    archiveTask: (taskId) => request("POST", `/tasks/${id(taskId)}/archive`),
    /** 改任务的任意字段（排到今天、清掉钟点等）。SP 19.x 实测支持 dueDay / dueWithTime，清空传 null。 */
    patchTask: (taskId, fields) => request("PATCH", `/tasks/${id(taskId)}`, fields),
    start: (taskId) => track(`/tasks/${id(taskId)}/start`),
    stop: () => track("/task-control/stop"),
    stopIfCurrent,
  };
}
