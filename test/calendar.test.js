import assert from "node:assert/strict";
import test from "node:test";
import { addDays, addMonths, assignLanes, buildMonth, buildPlanner, buildSchedule, dayLabel } from "../src/main/calendar.js";
import { ids, NOW, sampleData, task, TODAY } from "./fixtures.js";

const MIN = 60_000;
const titles = (list) => list.map((x) => x.title);

test("日期：加减天数和月份、日期标题", () => {
  assert.equal(addDays("2026-10-31", 1), "2026-11-01");
  assert.equal(addDays("2026-03-01", -1), "2026-02-28");
  assert.equal(addMonths("2026-12", 1), "2027-01");
  assert.equal(addMonths("2026-01", -1), "2025-12");
  assert.deepEqual(dayLabel("2026-11-03", TODAY), { rel: "明天", date: "11月3日", weekday: "周二" });
  assert.deepEqual(dayLabel("2026-11-09", TODAY), { rel: null, date: "11月9日", weekday: "周一" });
  assert.equal(dayLabel("2026-11-01", TODAY).rel, "昨天");
});

test("规划：按天分组，重复任务只投影还没生成的那几天", () => {
  const p = buildPlanner(sampleData(), { days: 7 });
  assert.equal(p.today, TODAY);
  assert.equal(p.days.length, 7);
  const [mon, tue, wed] = p.days;
  assert.equal(mon.isToday, true);
  // 今天：周会昨天之后还没生成，要投影；读书今天已经生成过，不投影；归档项目的不出现
  assert.deepEqual(titles(mon.projections), ["周会"]);
  assert.equal(mon.projections[0].timeLabel, "14:00");
  assert.deepEqual(titles(tue.projections), ["读书"]);
  assert.deepEqual(titles(wed.projections), ["周会", "读书"]);
  assert.ok(!p.days.some((d) => d.projections.some((x) => x.title === "旧项目的日报")));
  // 明天：带时间的看牙医按 dueWithTime 归到明天
  assert.deepEqual(ids(tue.items), ["dentist"]);
  // 交房租的截止日在第 4 天
  assert.deepEqual(titles(p.days[3].deadlines), ["交房租"]);
  // 下周的事在第 8 天，7 天里看不到
  assert.ok(!p.days.some((d) => d.items.some((i) => i.id === "later")));
});

test("规划：今天的顺序、已完成放后面、剩余时间含投影", () => {
  const mon = buildPlanner(sampleData(), { days: 1 }).days[0];
  const order = ids(mon.items);
  // 有时间的按时间在前，其余按 SP 今日顺序，已完成的在最后
  assert.deepEqual(order.slice(0, 3), ["early", "standup", "review"]);
  assert.equal(order.at(-1), "finished");
  assert.equal(mon.doneCount, 1);
  // 子任务挂在父任务下，不单列
  assert.ok(!order.includes("c2"));
  const parent = mon.items.find((i) => i.id === "parent");
  assert.equal(parent.left, 10 * MIN + 30 * MIN); // c2 剩 10 分 + c3 剩 30 分
  assert.equal(parent.canTrack, false);
  const expected = 15 * MIN + 60 * MIN + 25 * MIN + parent.left + 60 * MIN; // 站会、评审、周报、整理发布、周会投影
  assert.equal(mon.remaining, expected);
});

test("规划：某天已经有重复任务的实例，就不再投影", () => {
  const data = sampleData();
  data.allTasks.push(task({ id: "real-weekly", title: "周会", repeatCfgId: "rc-weekly", dueDay: "2026-11-04" }));
  const wed = buildPlanner(data, { days: 3 }).days[2];
  assert.deepEqual(titles(wed.projections), ["读书"]);
  assert.ok(wed.items.some((i) => i.id === "real-weekly"));
});

test("日程：带时间的画成块，重叠的并排，没时间的放上面", () => {
  const s = buildSchedule(sampleData(), { startHour: 8, endHour: 22 });
  assert.equal(s.day, TODAY);
  const byId = Object.fromEntries(s.blocks.map((b) => [b.id, b]));
  assert.equal(byId.standup.startMin, 10 * 60 + 10);
  assert.equal(byId.standup.endMin, 10 * 60 + 25);
  // 回复邮件没有预估：按 30 分画，标出来
  assert.equal(byId.early.noEstimate, true);
  assert.equal(byId.early.endMin - byId.early.startMin, 30);
  // 评审 14:00–15:00 和周会投影 14:00–15:00 重叠，分两列
  const weekly = s.blocks.find((b) => b.kind === "repeat");
  assert.equal(weekly.startMin, 14 * 60);
  assert.equal(byId.review.lanes, 2);
  assert.notEqual(byId.review.lane, weekly.lane);
  assert.deepEqual(ids(s.untimed).sort(), ["finished", "parent", "report"]);
  assert.equal(s.rangeStart, 8 * 60);
  assert.equal(s.rangeEnd, 22 * 60);
});

test("日程：翻到别的天；块超出设置的时间范围时范围自动放大", () => {
  const data = sampleData();
  const tue = buildSchedule(data, { day: "2026-11-03", startHour: 16, endHour: 18 });
  assert.equal(tue.isToday, false);
  assert.deepEqual(ids(tue.blocks), ["dentist"]);
  assert.equal(tue.rangeStart, 15 * 60);
  assert.deepEqual(titles(tue.untimed), ["读书"]);
  assert.equal(buildSchedule(data, { day: "bad" }).day, TODAY);
});

test("日程：并排分列", () => {
  const laid = assignLanes([
    { id: "a", start: 0, end: 60 },
    { id: "b", start: 30, end: 90 },
    { id: "c", start: 60, end: 120 },
    { id: "d", start: 200, end: 220 },
  ]);
  const by = Object.fromEntries(laid.map((b) => [b.id, b]));
  assert.deepEqual([by.a.lane, by.b.lane, by.c.lane], [0, 1, 0]);
  assert.equal(by.a.lanes, 2);
  assert.equal(by.d.lanes, 1);
});

test("月历：周一开头 6 行，圆点、截止日、选中的天", () => {
  const m = buildMonth(sampleData());
  assert.equal(m.month, "2026-11");
  assert.equal(m.title, "2026年11月");
  assert.equal(m.cells.length, 42);
  // 2026-11-01 是周日，前面补 6 天十月
  assert.equal(m.cells[0].day, "2026-10-26");
  assert.equal(m.cells[6].day, "2026-11-01");
  assert.equal(m.cells[0].inMonth, false);
  const cell = (day) => m.cells.find((c) => c.day === day);
  assert.equal(cell(TODAY).isToday, true);
  assert.equal(cell(TODAY).isSelected, true);
  assert.equal(cell("2026-11-05").hasDeadline, true);
  assert.equal(cell("2026-11-03").undone, 2); // 看牙医 + 读书投影
  assert.equal(cell("2026-10-31").undone, 1); // 交水电费（两天前，没有投影）
  assert.equal(m.selected.day, TODAY);

  const dec = buildMonth(sampleData(), { month: "2026-12", selected: "2026-12-02" });
  assert.equal(dec.month, "2026-12");
  assert.equal(dec.selected.day, "2026-12-02");
  assert.deepEqual(titles(dec.selected.projections), ["周会", "读书"]);
});

test("一天从 4 点开始：凌晨还算前一天", () => {
  // 今日列表为空时按本机时钟和日界算
  const data = { ...sampleData(), todayTasks: [], now: new Date(2026, 10, 3, 1, 30).getTime() };
  assert.ok(data.now > NOW);
  assert.equal(buildPlanner(data, { dayStartHour: 4, days: 1 }).today, TODAY);
  assert.equal(buildPlanner(data, { dayStartHour: 0, days: 1 }).today, "2026-11-03");
});
