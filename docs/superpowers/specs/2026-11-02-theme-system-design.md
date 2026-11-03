# 皮肤系统与 Hana 联动设计

日期：2026-11-02（2026-11-03 实现并扩展）
状态：小窗 0.4.0、任务台 0.11.2 起已实现；2026-11-03 随小窗 0.4.0 与任务台 0.11.3/0.11.4 发布

## 2026-11-03 扩展

- 皮肤从 2 套扩到 12 套：深夜（小窗原来的深灰 + 玫红）+ Hana 的 11 套主题（暖纸、青夜、素白、草香、沉思、Absolutely、随时准备接住你、用户彻底怒了、新暖纸、青夜·高对比、珊瑚）。皮肤 id 与 Hana 主题 id 完全一致。
- 设置页只留一行「外观」入口；全部皮肤放进独立的 appearance 窗口，网格预览、点一下即时换，不再占设置空间。
- 任务台 0.11.2 起一比一映射：Hana 用哪套主题就写哪套 id；`auto` 用暖纸；认不出的退回新暖纸。旧名字 `hana` 仍被小窗认作新暖纸。

## 目标

1. SP 桌面卡片加两套皮肤：
   - **深夜**：现在的深灰底 + 玫红强调，升级后视觉零变化，作为默认。
   - **暖纸**：沿用 Hana「新暖纸」的纸本配色，连圆角、细边、标题字体一起换。
2. 小窗提供一个**通用的外部主题接口**，任何程序都能设置小窗皮肤。
3. Hana 联动交给「任务台」插件：插件读 Hana 当前主题，写小窗的外部主题文件。**小窗代码里不出现 Hana 字样。**

## 非目标

- 不做配色编辑器、不做任意自定义主题。
- 不改变卡片布局、字号体系、交互。
- 不让小窗直接读 Hana 的配置。

## 一、小窗皮肤层

### 新增文件

- `src/renderer/theme.css`：唯一的皮肤定义。`:root` 是深夜；`[data-theme="hana"]` 是暖纸。颜色、圆角、边框粗细、字体全在这里。
- `src/renderer/theme.js`：每个页面最先加载，从 URL 的 `?theme=` 读皮肤并写到 `<html data-theme>`，首帧就生效；暴露 `WTheme.apply(id)` 给运行中切换。
- `src/main/theme.js`：纯逻辑，皮肤列表、外部主题文件读取/监听、窗口背景色。可脱离 Electron 单测。

### Token

沿用现有变量名（`--bg`、`--bg-2`、`--line`、`--text`、`--dim`、`--accent` 等），补齐这次发现的角色：

- 表面：`--bg`、`--bg-2`、`--bg-row-hover`、`--bg-row-current`、`--bg-btn`、`--bg-btn-hover`、`--bg-attention`、`--bg-schedule`、`--bg-schedule-current`、`--bg-scroll`、`--bg-dashed`
- 文字：`--text`、`--dim`、`--mute`、`--faint`、`--ghost`
- 线：`--line`、`--line-2`、`--line-strong`
- 强调：`--accent`、`--accent-hover`、`--accent-ink`、`--accent-soft`
- 语义：`--focus`、`--break`、`--ok`、`--warn`、`--danger`
- 形状：`--radius-sm`、`--radius-md`、`--radius-lg`、`--hairline`、`--font-ui`、`--font-title`
- 阴影：`--shadow-popup`

五份 CSS（`card.css`、`cards.css`、`settings.css`、`tour.css`、`update.css`）删掉各自的 `:root`，所有硬编码色值改成 `var()`。

### 暖纸色值

| 角色 | 值 |
|---|---|
| 纸面 `--bg` | `#F5EFE4` |
| 卡面 / 输入 `--bg-2` | `#FBF7EE` |
| 深一层（按钮/侧条） | `#EFE8DB` |
| 浓墨 `--text` | `#2A2622` |
| 二级 `--dim` | `#4A433C` |
| 弱化 `--mute` | `#6B6158` |
| 细线 `--line` | `#D8CFBE` |
| 强调 `--accent` | `#537D96` |
| 按下 `--accent-hover` | `#3F6179` |
| 强调底色 `--accent-soft` | `rgba(83,125,150,.08)` |
| 成功 `--ok` | `#4A6B4A` |
| 危险 `--danger` | `#8B2C1F` |
| 警告 `--warn` | `#947046` |
| 圆角 | 2 / 3 / 4 px |
| 边框 | 0.5px |
| 标题字体 | `"Noto Serif SC","Source Han Serif SC","STSong",serif` |
| 正文 | 系统无衬线（不变） |

深夜皮肤保持 0.2.3 的全部数值：`#1f1f1f`、`#2a2a2a`、`#e8e8e8`、`#ff4d8d`、4–8px 圆角、1px 边、系统无衬线。

### 主进程

- `settings.js` 新增 `theme: "dark"`，合法值只收 `dark` / `hana`。
- `main.js` 启动时算一次 `themeResolved`；设置变化时重算；把 `themeResolved` 和 `themeSource`（`manual` 或外部来源名）放进推给页面的状态。
- 卡片、设置、教程、更新窗口创建时 `loadFile` 带上 `query.theme`；窗口 `backgroundColor` 用皮肤背景色，运行中切换时 `setBackgroundColor`。
- 渲染层 `setState` 时调用 `WTheme.apply(themeResolved)`，不重载页面。

### 外部主题接口

- 文件：`%APPDATA%\SP 桌面卡片\theme.json`
- 内容：`{ "theme": "dark" | "hana", "source": "任务台" }`
- 优先级：文件存在且合法 → 用文件里的皮肤；文件缺失/损坏/未知值 → 回到设置里手选的皮肤。
- 监听：每 2 秒看一次修改时间，变了才重读；读取失败保留上一次成功值。
- 小窗只读不写。设置页在外部来源生效时显示一行「皮肤正由「<source>」设置」，不提供开关。
- 安全：`source` 只用于显示，转义后用 textContent 写入。

## 二、任务台插件（Hana 侧）

- 检测小窗：`%APPDATA%\SP 桌面卡片\settings.json` 存在才认为装了。
- 插件设置新增布尔项 `followDesktopTheme`，默认 false；设置页加「桌面卡片」区，显示 Hana 当前主题、映射到的皮肤、小窗是否检测到。
- 打开时：
  1. 读 `%USERPROFILE%\.hanako\user\preferences.json` 的 `appearance.theme`。
  2. 映射：`midnight`、`midnight-contrast` → `dark`；其余亮色和 `auto` → `hana`。
  3. 原子写入小窗的 `theme.json`（临时文件 + rename）。
  4. 每 5 秒看一次 preferences.json 的修改时间，变了重读重写。
- 关闭时删除 `theme.json`。
- 小窗没装时：不写文件，设置页提示「没找到 SP 桌面卡片」。
- Hana 配置读不到/坏了：保留上一次写入的值，不删文件。

## 三、测试

- 单测：皮肤映射、`resolveSkin`、外部文件解析（缺失/坏 JSON/未知值）、设置收口、插件映射函数。
- 小窗自检 `scripts/theme-check.mjs`：
  1. 以暖纸启动，断言 `data-theme`、背景色 `rgb(245, 239, 228)`、标题字体含 Noto Serif。
  2. 设置页点回深夜，卡片不重载就变色。
  3. 写临时 `theme.json`，小窗 3 秒内切到对应皮肤；删掉文件恢复手选。
  4. 两套皮肤各截一张图。
- 插件自检：临时目录模拟 preferences 和 theme.json，验证开关、映射、原子写、关闭删除。
- 联调：真机 Hana 换主题，小窗 5 秒内跟随。
- 现有 174 项单测、smoke、update-check、desktop-check、resize-check 全过（desktop-check 需要解锁的桌面）。

## 四、发布

- 版本 0.3.0，包含 0.2.4 的「嵌入桌面突然置顶」修复。
- 用户验收满意后一起发布；发布前单独确认版本号和 Release。
