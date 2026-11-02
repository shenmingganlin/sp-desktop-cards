// update.js — 检查更新：去 GitHub 看最新 Release，比版本号，挑安装包，下载到本地。
// 只做纯粹的取数和文件活儿，弹窗和窗口由 main.js 负责，方便单测。
//
// 不用 api.github.com：没登录的接口每个 IP 每小时只有 60 次，共享出口（代理、校园网、运营商 NAT）
// 经常很早就用光，回的是 403「API rate limit exceeded」，用户看到的却只是「连不上」。
// 改成看网页：/releases/latest 会 302 到 /releases/tag/vX.Y.Z，网页没有这个限流。
// 安装包的地址是我们自己的命名规则，按 tag 拼出来，再用 HEAD 确认在不在、多大。

import fs from "node:fs";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

export const REPO = "shenmingganlin/sp-desktop-cards";
// 老用户还在读旧仓库（0.2.2 及以前查的是这里）：那边停更，只留一个升级指路牌。
// 新版查不到新仓库时就回头问它，拿到「去新仓库」的版本号也提示升级，升上来之后就只认新仓库了。
export const LEGACY_REPO = "shenmingganlin/sp-today-widget";
const RELEASES = `https://github.com/${REPO}/releases`;
export const LATEST_URL = `${RELEASES}/latest`;
export const legacyLatestUrl = () => `https://github.com/${LEGACY_REPO}/releases/latest`;
export const DOWNLOAD_BASE = `${RELEASES}/download`;
export const CHECK_TIMEOUT_MS = 10_000;
const DOWNLOAD_TIMEOUT_MS = 30 * 60_000;
const UA = "sp-desktop-cards";

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
export const artifactName = (version, kind) => `sp-desktop-cards-${version}-${kind === "setup" ? "setup.exe" : "win-x64.zip"}`;

/** 从跳转后的地址里抠出 tag：.../releases/tag/v0.2.2 → v0.2.2 */
export function tagFromUrl(url) {
  const m = /\/(?:releases\/)?tag\/([^/?#]+)/.exec(String(url ?? ""));
  return m ? decodeURIComponent(m[1]) : null;
}

/**
 * 文件在不在、多大。404/410 返回 null（这次发布就是没有这个文件），
 * 其他失败返回 0（不知道，先去下载，真下不到再说）。
 */
async function headSize(url, fetchImpl) {
  try {
    const res = await fetchImpl(url, {
      method: "HEAD",
      redirect: "follow",
      headers: { "user-agent": UA },
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    });
    if (!res) return 0;
    if (res.status === 404 || res.status === 410) return null;
    if (!res.ok) return 0;
    return Number(res.headers.get("content-length")) || 0;
  } catch {
    return 0;
  }
}

/**
 * 查最新 Release。成功返回 { version, tag, page, setup, zip }，setup/zip 是 { name, url, size } 或 null。
 * 失败不抛异常，返回 { error: "network" | "timeout" | "http" | "none" | "format", status? }，由调用方决定怎么说。
 * 三个地址参数都是给测试用的，正常不用传。
 */
export async function fetchLatest({ fetchImpl = fetch, latestUrl = LATEST_URL, base = DOWNLOAD_BASE, probe = true } = {}) {
  let res;
  try {
    res = await fetchImpl(latestUrl, {
      redirect: "follow",
      headers: { "user-agent": UA, accept: "text/html" },
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    });
  } catch (error) {
    return { error: error?.name === "TimeoutError" ? "timeout" : "network" };
  }
  if (!res) return { error: "network" };
  if (!res.ok) return { error: res.status === 404 ? "none" : "http", status: res.status };
  // 跟完跳转后地址是 .../releases/tag/vX.Y.Z；没跳转说明对端不是 GitHub 的网页
  const tag = tagFromUrl(res.url);
  const parts = parseVersion(tag);
  if (!parts) return { error: "format" };
  const version = parts.join(".");
  const page = `${RELEASES}/tag/${encodeURIComponent(tag)}`;
  // 下载地址从跳转到的那个页面推出来：指向新仓库就是新仓库，指向旧仓库就是旧仓库（升级指路牌）
  const origin = /^(https:\/\/github\.com\/[^/]+\/[^/]+)\//.exec(String(res.url ?? ""));
  const dl = origin ? `${origin[1]}/releases/download` : base;
  const make = (kind) => {
    const name = artifactName(version, kind);
    return { name, url: `${dl}/${encodeURIComponent(tag)}/${name}`, size: 0 };
  };
  const setup = make("setup");
  const zip = make("zip");
  if (probe) {
    for (const a of [setup, zip]) {
      const size = await headSize(a.url, fetchImpl);
      if (size === null) a.missing = true;
      else a.size = size;
    }
  }
  return { version, tag, page, setup: setup.missing ? null : setup, zip: zip.missing ? null : zip };
}

/**
 * 下载到 dir/name，边下边报进度（0~1）。下完才改名成正式文件名，半路失败不会留下坏包。
 * 返回文件路径。
 */
export async function downloadFile(url, dir, name, { onProgress = () => {}, fetchImpl = fetch, signal } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  const part = `${file}.part`;
  const res = await fetchImpl(url, { redirect: "follow", signal: signal || AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
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
