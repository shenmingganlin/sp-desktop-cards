// token.js — 自动读取 SP 的本地 REST API 令牌。
// SP 打开本地 REST API 后，会把令牌写到 userData 下的 local-rest-api-token（32 位字母数字）。
// 每次需要时都重读：SP 重新生成令牌后不用重启小窗。

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const TOKEN_PATTERN = /^[A-Za-z0-9]{32}$/;
// 不同安装方式下目录名不同，按常见程度排。
const DIR_NAMES = ["superProductivity", "Super Productivity", "super-productivity"];

export function candidatePaths(env = process.env, home = os.homedir()) {
  const roots = new Set();
  if (process.platform === "win32" || env.APPDATA) {
    if (env.APPDATA) roots.add(env.APPDATA);
    roots.add(path.join(home, "AppData", "Roaming"));
  }
  if (process.platform === "darwin") roots.add(path.join(home, "Library", "Application Support"));
  if (process.platform === "linux") roots.add(env.XDG_CONFIG_HOME || path.join(home, ".config"));
  const out = [];
  for (const root of roots) for (const name of DIR_NAMES) out.push(path.join(root, name, "local-rest-api-token"));
  return out;
}

export async function readSpToken(paths = candidatePaths()) {
  for (const p of paths) {
    try {
      const text = (await fs.readFile(p, "utf8")).trim();
      if (TOKEN_PATTERN.test(text)) return text;
    } catch {
      // 这个路径没有，试下一个
    }
  }
  return "";
}

export const isValidToken = (v) => typeof v === "string" && TOKEN_PATTERN.test(v.trim());
