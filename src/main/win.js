// win.js — 判断一个 BrowserWindow 还能不能用。纯逻辑，能脱离 Electron 单测。
//
// 为什么要单独一个函数：isDestroyed() 读的是 JS 里的标记，要等 closed 事件派发才置上。
// 窗口被系统原生销毁（嵌入桌面时 Explorer 重启，会把挂在桌面下面的卡片窗口一起销毁）
// 到 closed 派发之间有一小段空档：isDestroyed() 还是 false，可这时任何原生调用都会抛
// "Object has been destroyed"。settle() 每 16ms 跑一次，空档里必中，异常从定时器回调里
// 逃出来就是一个「A JavaScript error occurred in the main process」弹窗。
//
// 所以判活不能只信 isDestroyed()，得真调一下原生方法：抛了就说明窗口已经没了。

/**
 * 窗口还能用吗。win 为空、已被 JS 销毁、或原生窗口已经没了都返回 false。
 * 只用 isVisible() 探一下，代价很低（settle 本来就每帧调一次）。
 */
export function windowAlive(win) {
  if (!win || typeof win.isDestroyed !== "function") return false;
  if (win.isDestroyed()) return false;
  try {
    win.isVisible();
    return true;
  } catch {
    return false;
  }
}
