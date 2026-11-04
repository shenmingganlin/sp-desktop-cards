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
  async function request(method, path, body) {
    const token = await getToken();
    if (!token) throw new SpError("SP_NO_TOKEN", HINTS.SP_NO_TOKEN);
    const headers = { Authorization: `Bearer ${token}`, Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";

    let response;
    let text;
    try {
      response = await fetchImpl(baseUrl + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      text = await response.text();
    } catch (error) {
      if (error?.name === "TimeoutError" || error?.name === "AbortError") {
        throw new SpError("SP_TIMEOUT", HINTS.SP_TIMEOUT);
      }
      throw new SpError("SP_UNREACHABLE", HINTS.SP_UNREACHABLE);
    }

    let payload = null;
    try {
      payload = JSON.parse(text);
    } catch {
      // 非 JSON 时按状态码处理
    }
    const code = payload?.error?.code;
    if (response.status === 401) throw new SpError("SP_UNAUTHORIZED", HINTS.SP_UNAUTHORIZED, 401);
    if (response.status === 503 && code === "API_DISABLED") throw new SpError("SP_API_DISABLED", HINTS.SP_API_DISABLED, 503);
    if (response.status === 503 && code === "APP_NOT_READY") throw new SpError("SP_NOT_READY", HINTS.SP_NOT_READY, 503);
    if (!response.ok || payload?.ok === false) {
      throw new SpError(code || `SP_HTTP_${response.status}`, payload?.error?.message || `SP 返回 ${response.status}`, response.status);
    }
    if (payload?.ok !== true || !("data" in payload)) {
      throw new SpError("SP_BAD_RESPONSE", HINTS.SP_BAD_RESPONSE, response.status);
    }
    return payload.data;
  }

  const list = async (path) => {
    const data = await request("GET", path);
    if (!Array.isArray(data)) throw new SpError("SP_BAD_RESPONSE", HINTS.SP_BAD_RESPONSE);
    return data;
  };
  const id = (v) => encodeURIComponent(v);

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
    setDone: (taskId, isDone) => request("PATCH", `/tasks/${id(taskId)}`, { isDone }),
    /** 改任务的任意字段（排到今天、清掉钟点等）。SP 19.x 实测支持 dueDay / dueWithTime，清空传 null。 */
    patchTask: (taskId, fields) => request("PATCH", `/tasks/${id(taskId)}`, fields),
    start: (taskId) => request("POST", `/tasks/${id(taskId)}/start`),
    stop: () => request("POST", "/task-control/stop"),
  };
}
