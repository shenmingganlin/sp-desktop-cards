// preload.cjs — 给页面开的唯一一扇门：收状态、发操作。页面拿不到 Node 和 ipcRenderer 本身。
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("widget", {
  onState(callback) {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on("state", listener);
    ipcRenderer.send("ready");
    return () => ipcRenderer.removeListener("state", listener);
  },
  action: (name, payload) => ipcRenderer.invoke("action", String(name), payload ?? {}),
});
