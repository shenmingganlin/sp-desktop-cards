# SP 今日小窗

[Super Productivity](https://super-productivity.com/)（SP）的置顶桌面小窗。SP 自带的小组件只显示当前任务，这个小窗还能看到今天的安排：

- **当前计时**：任务名、剩余或已用时间；番茄钟、心流、倒计时进行中时显示阶段和倒计时。
- **逾期**：过了时间、过了日期或过了截止日还没完成的任务，红色置顶。
- **今日任务**：带具体时间的按时间排在前面，其余按 SP 今日视图的顺序；子任务缩进在父任务下面；快到点的任务变成橙色。
- **今日统计**：今天累计用时、完成数、预估剩余时间。

在小窗里可以勾选完成（可撤销）、开始和停止计时。其他操作点 ↗ 打开 SP 主窗口。小窗可以拖动、调大小、折叠成一行，关闭按钮会把它藏到托盘。

## 使用前提

1. SP 桌面版 19.3 或更新，并且正在运行。
2. 在 SP「设置 → 杂项」里打开**本地 REST API**。打开后 SP 会生成访问令牌，小窗会自动读取，不用复制粘贴。读不到时可以在小窗设置里手填，手填的令牌用系统加密保存。

小窗只连本机的 `127.0.0.1:3876`，不联网。

## 已知限制

- 目前只在 Windows 11 上测试过。令牌自动读取也查找 macOS 和 Linux 的数据目录，但还没有实测。
- 安装包没有代码签名，第一次运行时 Windows SmartScreen 会提示「未知发布者」，点「更多信息 → 仍要运行」。
- SP 的 REST API 不会推送变化，小窗每 2 秒查一次当前计时，每 15 秒查一次任务列表。在 SP 里改了任务，小窗最多 15 秒后更新。
- 日历事件（Google 日历、CalDAV 插件的数据）读不到，REST API 不提供。
- 番茄钟只能看，暂停/继续请在 SP 里操作。
- **启动后立刻退出、没有窗口**：Electron 45 启动时会检查安装目录的权限。如果目录的权限表里有某个应用沙盒（AppContainer）的专属条目，却没有「所有应用程序包」，就会拒绝启动。装过 Codex 等带沙盒的软件后，`%LOCALAPPDATA%\Programs` 和 `%TEMP%` 可能是这种状态。解决办法二选一：
  - 安装时换一个目录（例如 `D:\Apps\SP 今日小窗`），或用 zip 版解压到别的盘；
  - 给安装目录补上权限（把路径换成你的安装目录）：`icacls "安装目录" /grant *S-1-15-2-1:(OI)(CI)(RX)`

## 下载

- `sp-today-widget-<版本>-setup.exe`：安装版，可选安装目录，带开始菜单和桌面快捷方式。
- `sp-today-widget-<版本>-win-x64.zip`：免安装版，解压后运行 `SP-Today-Widget.exe`。

## 开发

```bash
npm install
npm start          # 运行
npm test           # 数据层、客户端、轮询、设置的单元测试
npm run smoke      # 用假 SP 启动真实窗口截图，输出到 .smoke/
npm run ui-check   # 用 Playwright 点一遍勾选、计时、折叠、设置、断线
npm run dist       # 打 Windows 安装包和 zip，输出到 dist/
```

代码结构：

- `src/main/model.js`：把 SP 数据整理成要显示的内容（纯函数）
- `src/main/sp-client.js`：REST 客户端。SP 会拒绝带网页 Origin 的请求，所以请求都由主进程发出
- `src/main/poller.js`：快慢两档轮询
- `src/main/main.js`：窗口、托盘、设置
- `src/renderer/`：小窗页面
- `test/fake-sp.js`：照 SP 19.3 行为写的假服务，测试和截图都用它

## 许可

MIT
