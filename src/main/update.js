// update.js — 检查更新：去 GitHub 看最新 Release，比版本号，挑安装包，下载到本地。
// 只做纯粹的取数和文件活儿，弹窗和窗口由 main.js 负责，方便单测。

import fs from "node:fs";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

export const REPO = "shenmingganlin/sp-today-widget";
export const DEFAULT_API = `https://api.github.com/repos/${REPO}/releases/latest`;
export const CHECK_TIMEOUT_MS = 10_000;
const DOWNLOAD_TIMEOUT_MS = 30 * 60_000;

/** "v0.2.10" → [0, 2, 10]；认不出来返回 null。 */
export function parseVersion(text) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(text ?? "").trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** latest 是否比 current 新。有一点认不出来就当没更新。 */
export function isNewer(latest, current) {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

/** 安装包和免安装包的文件名。改 npm 的 artifactName 时这里要一起改。 */
export const artifactName = (version, kind) => `sp-today-widget-${version}-${kind === "setup" ? "setup.exe" : "win-x64.zip"}`;

/** 从 Release 里按文件名找资源；找不到的给 null。 */
export function pickAssets(release, version) {
  const assets = Array.isArray(release?.assets) ? release.assets : [];
  const find = (kind) => {
    const name = artifactName(version, kind);
    const hit = assets.find((a) => a && a.name === name && typeof a.browser_download_url === "string");
    return hit ? { name, url: hit.browser_download_url, size: Number(hit.size) || 0 } : null;
  };
  return { setup: find("setup"), zip: find("zip") };
}

/**
 * 查最新 Release。没网、被限流、格式不对都返回 null，不抛异常。
 * api 可换（测试用假服务）。
 */
export async function fetchLatest({ fetchImpl = fetch, api = DEFAULT_API } = {}) {
  let res;
  try {
    res = await fetchImpl(api, {
      headers: { accept: "application/vnd.github+json", "user-agent": "sp-today-widget" },
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    });
  } catch {
    return null;
  }
  if (!res || !res.ok) return null;
  let release;
  try {
    release = await res.json();
  } catch {
    return null;
  }
  const parts = parseVersion(release?.tag_name);
  if (!parts || release?.draft || release?.prerelease) return null;
  const version = parts.join(".");
  return {
    version,
    tag: String(release.tag_name),
    page: typeof release.html_url === "string" ? release.html_url : "",
    ...pickAssets(release, version),
  };
}

/**
 * 下载到 dir/name，边下边报进度（0~1）。下完才改名成正式文件名，半路失败不会留下坏包。
 * 返回文件路径。
 */
export async function downloadFile(url, dir, name, { onProgress = () => {}, fetchImpl = fetch, signal } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  const part = `${file}.part`;
  const res = await fetchImpl(url, { signal: signal || AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!res.ok || !res.body) throw new Error(`下载失败：HTTP ${res.status}`);
  const total = Number(res.headers.get("content-length")) || 0;
  let got = 0;
  const counter = new Transform({
    transform(chunk, _enc, done) {
      got += chunk.length;
      onProgress(total ? Math.min(1, got / total) : 0, got, total);
      done(null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(res.body), counter, fs.createWriteStream(part));
    const size = fs.statSync(part).size;
    if (total && size !== total) throw new Error(`下载的文件不完整（${size}/${total} 字节）`);
    if (!size) throw new Error("下载的文件是空的");
    fs.rmSync(file, { force: true });
    fs.renameSync(part, file);
  } catch (error) {
    fs.rmSync(part, { force: true });
    throw error;
  }
  return file;
}
