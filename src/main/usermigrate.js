// usermigrate.js — 程序改过两次名，每次改名 userData 目录都跟着变，新目录是空的：
// 不搬的话老用户一升级，设置、卡片位置、令牌全丢。
//   0.2.2 及以前  %APPDATA%\SP 今日小窗
//   0.2.3        %APPDATA%\SP 妗岄潰鍗＄墖   ← 打包时中文被按 GBK 解了一遍，是这个乱码名
//   现在          %APPDATA%\SP 桌面卡片
// 首次启动时把老目录搬过来（改名而不是复制，老的卸载时一起删干净）。
// 单独放一个文件是为了能脱离 Electron 单测。

import fs from "node:fs";
import path from "node:path";

/** 更早的目录名，从旧到新。多个都在时用最新的那个。 */
export const LEGACY_DIRS = ["SP 今日小窗", "SP 妗岄潰鍗＄墖"];
/** 兼容老名字：调用方以前传单个字符串。 */
export const LEGACY_DIR = LEGACY_DIRS[0];

/**
 * dataDir 是新的 userData 目录。返回 "moved"（整个目录改名过来）、"copied"（跨盘或占用，逐个复制）、
 * "kept"（已经有自己的设置，或者老目录没有设置，什么也没做）。出错时返回 "failed"，不抛异常。
 */
export function adoptUserData(dataDir, { legacyName, legacyNames = LEGACY_DIRS } = {}) {
  try {
    // 两个旧目录可能同时在（改过两次名的用户机器上就是这样）。从新往旧找，
    // 找到第一个带设置的：越近的越接近用户最后的样子。
    const candidates = legacyName ? [legacyName] : [...legacyNames].reverse();
    const old = candidates
      .map((name) => path.join(path.dirname(dataDir), name))
      .find((dir) => dir.toLowerCase() !== dataDir.toLowerCase() && fs.existsSync(path.join(dir, "settings.json")));
    // 已经有自己的设置了（升级过一次），或者哪个旧目录都没留下设置：什么都不做
    if (fs.existsSync(path.join(dataDir, "settings.json"))) return "kept";
    if (!old) return "kept";
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
    // 复制时先抢设置文件：老版本多半还开着，Chromium 的缓存文件是锁着的，复制到一半就会失败。
    // 别的都能下次再补，设置丢了就补不回来了。
    fs.mkdirSync(dataDir, { recursive: true });
    fs.copyFileSync(path.join(old, "settings.json"), path.join(dataDir, "settings.json"));
    try {
      fs.cpSync(old, dataDir, { recursive: true, force: false, errorOnExist: false });
    } catch {
      // 缓存之类复制不动就算了，设置已经在
    }
    return "copied";
  } catch {
    return "failed";
  }
}
