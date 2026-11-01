// preload.cjs — 给页面开的唯一一扇门：收状态、发操作。页面拿不到 Node 和 ipcRenderer 本身。
// 卡片和设置窗口共用。主进程按发消息的窗口判断能做哪些操作。
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("widget", {
  // 主进程的一次性通知：提示音、提示条
  onEvent(callback) {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("event", listener);
    return () => ipcRenderer.removeListener("event", listener);
  },
  onState(callback) {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on("state", listener);
    ipcRenderer.send("ready");
    return () => ipcRenderer.removeListener("state", listener);
  },
  action: (name, payload) => ipcRenderer.invoke("action", String(name), payload ?? {}),
  // 拖动要快，不等回复
  dragStart: (alone) => ipcRenderer.send("drag-start", !!alone),
  dragEnd: () => ipcRenderer.send("drag-end"),
});
