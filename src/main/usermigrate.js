// usermigrate.js — 0.2.2 及以前程序叫「SP 今日小窗」，设置存在 %APPDATA%\SP 今日小窗。
// 0.2.3 改名后 userData 变成 %APPDATA%\SP 桌面卡片，新目录是空的：不搬的话老用户一升级，
// 设置、卡片位置、令牌全丢。首次启动时把老目录搬过来（改名而不是复制，老的卸载时一起删干净）。
// 单独放一个文件是为了能脱离 Electron 单测。

import fs from "node:fs";
import path from "node:path";

export const LEGACY_DIR = "SP 今日小窗";

/**
 * dataDir 是新的 userData 目录。返回 "moved"（整个目录改名过来）、"copied"（跨盘或占用，逐个复制）、
 * "kept"（已经有自己的设置，或者老目录没有设置，什么也没做）。出错时返回 "failed"，不抛异常。
 */
export function adoptUserData(dataDir, { legacyName = LEGACY_DIR } = {}) {
  try {
    const old = path.join(path.dirname(dataDir), legacyName);
    if (old.toLowerCase() === dataDir.toLowerCase()) return "kept";
    // 已经有自己的设置了（升级过一次），或者老版本没留下设置：什么都不做
    if (fs.existsSync(path.join(dataDir, "settings.json"))) return "kept";
    if (!fs.existsSync(path.join(old, "settings.json"))) return "kept";
    // 新目录可能已经被 Chromium 建好了，空的就删掉好改名
    if (fs.existsSync(dataDir) && fs.readdirSync(dataDir).length === 0) fs.rmdirSync(dataDir);
    if (!fs.existsSync(dataDir)) {
      // 同一块盘上直接改名最干净；跨盘、或者老的还开着（文件被占用）就退回逐个复制
      try {
        fs.renameSync(old, dataDir);
        return "moved";
      } catch {
        // 继续用复制
      }
    }
    fs.cpSync(old, dataDir, { recursive: true, force: false, errorOnExist: false });
    return "copied";
  } catch {
    return "failed";
  }
}
