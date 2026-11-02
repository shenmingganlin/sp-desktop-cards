// tour.js — 使用教程。几页文字配一张用 CSS 画的示意图，不放截图（界面改了截图就过时）。
// 内容和 README「摆放」一节一致，改了这里记得对一下那边。
"use strict";

(() => {
  const $ = (id) => document.getElementById(id);
  const act = (name, payload) => window.widget.action(name, payload);

  // pic：示意图的样式名，见 tour.css
  const STEPS = [
    {
      title: "欢迎使用 SP 桌面卡片",
      pic: "cards",
      lines: [
        "每个功能一张卡片：专注、今日、规划、日程、月历。",
        "想看哪张开哪张：顶栏 ⋯ →「卡片」，或托盘图标右键。",
        "要先打开 Super Productivity，并在它的「设置 → 杂项」里启用本地 REST API。",
      ],
    },
    {
      title: "拖动和拼接",
      pic: "snap",
      lines: [
        "按住顶栏拖动。靠近别的卡片会吸过去拼在一起，之后整组一起走。",
        "按住 <b>Alt</b> 再拖，只挪这一张，可以把它从一组里拆出来。",
        "拖卡片边缘改大小，旁边拼着的会跟着让开。双击顶栏折叠成一行。",
      ],
    },
    {
      title: "三种显示方式",
      pic: "modes",
      lines: [
        "<b>置顶</b>：浮在所有窗口上面。",
        "<b>普通窗口</b>：和其他窗口一样，会被盖住。",
        "<b>嵌入桌面</b>：贴在桌面图标那一层，按 Win+D 显示桌面时卡片还在。",
        "在 ⋯ 菜单或设置里切换；「锁定位置」防止误拖。",
      ],
    },
    {
      title: "番茄钟",
      pic: "pomo",
      lines: [
        "在「专注」卡片点 ▶ 专注开始一个番茄。SP 正在给某个任务计时的话，番茄钟和它一起走，休息时停下。",
        "到点时响提示音、发通知，卡片浮到最前面闪一闪，点一下就回去。",
        "托盘图标上悬停能看到剩余时间。时长、提示方式都在设置里改。",
      ],
    },
    {
      title: "管理任务",
      pic: "tasks",
      lines: [
        "点圆圈勾选完成（几秒内可撤销），鼠标移到任务上点 ▶ 开始计时。",
        "顶栏「+」新建今天的任务；规划每天都有「+」；日程点空白处在那个时间新建。",
        "可以用 SP 的简写，比如 #标签、+项目，由 SP 解析。",
        "出新版本时 ⋯ →「检查更新」会问你要不要装，装完程序自己回来，不用去 GitHub 下载。",
      ],
    },
  ];

  let index = 0;

  function el(tag, cls, html) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    // 只放上面写死的文案，没有用户数据
    if (html) node.innerHTML = html;
    return node;
  }

  function render() {
    const s = STEPS[index];
    const box = $("step");
    const pic = el("div", `pic ${s.pic}`);
    for (let i = 0; i < 6; i++) pic.append(el("i"));
    const list = el("ul");
    for (const line of s.lines) list.append(el("li", "", line));
    box.replaceChildren(el("h1", "", s.title), pic, list);
    $("dots").replaceChildren(...STEPS.map((_, i) => el("span", i === index ? "on" : "")));
    $("prev").hidden = index === 0;
    $("next").textContent = index === STEPS.length - 1 ? "开始使用" : "下一步";
  }

  $("prev").addEventListener("click", () => {
    index = Math.max(0, index - 1);
    render();
  });
  $("next").addEventListener("click", () => {
    if (index === STEPS.length - 1) return act("close");
    index += 1;
    render();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "ArrowRight" || e.key === "Enter") $("next").click();
    else if (e.key === "ArrowLeft" && index > 0) $("prev").click();
    else if (e.key === "Escape") act("close");
  });

  render();
})();
