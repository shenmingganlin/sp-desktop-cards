// snap.js — 卡片吸附和拼接的几何计算。全是纯函数，矩形都是 { x, y, width, height }（窗口外框，屏幕坐标）。
//
// 拼接不另存状态，全靠位置判断：两张卡片相隔约 GAP、并且在另一个方向上有重叠，就算拼在一起。
// 拖动一张卡片时，和它连通的整组一起走；按住 Alt 只拖这一张。

import { GAP } from "./settings.js";

export const SNAP = 12; // 离边缘多近就吸过去
const TOUCH = 3; // 判断「拼在一起」的容差：高分屏取整会差一两个像素
const MIN_OVERLAP = 20;

const right = (r) => r.x + r.width;
const bottom = (r) => r.y + r.height;
const overlap = (a1, a2, b1, b2) => Math.min(a2, b2) - Math.max(a1, b1);

/** b 是否拼在 a 的下方 / 右侧 / 上方 / 左侧。 */
export const isBelow = (a, b) => Math.abs(b.y - bottom(a) - GAP) <= TOUCH && overlap(a.x, right(a), b.x, right(b)) >= MIN_OVERLAP;
export const isRightOf = (a, b) => Math.abs(b.x - right(a) - GAP) <= TOUCH && overlap(a.y, bottom(a), b.y, bottom(b)) >= MIN_OVERLAP;
export const touches = (a, b) => isBelow(a, b) || isBelow(b, a) || isRightOf(a, b) || isRightOf(b, a);

/** 和 id 连通的所有卡片（含自己）。rects 是 Map<id, rect>。 */
export function groupOf(rects, id) {
  const seen = new Set([id]);
  const queue = [id];
  while (queue.length) {
    const cur = rects.get(queue.shift());
    for (const [other, r] of rects) {
      if (!seen.has(other) && touches(cur, r)) {
        seen.add(other);
        queue.push(other);
      }
    }
  }
  return seen;
}

export function boundingBox(rects) {
  const xs = rects.map((r) => r.x);
  const ys = rects.map((r) => r.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...rects.map(right)) - x, height: Math.max(...rects.map(bottom)) - y };
}

/**
 * 被拖动的整组（外接矩形 box）离谁近就吸过去，返回修正后的 { dx, dy }。
 * 吸附目标：其他卡片的四边（隔 GAP 拼接，或者边缘对齐）和显示器工作区的四边。
 * 横竖两个方向各自取最近的一个。
 */
export function snapMove(box, others, workAreas) {
  let best = { x: null, y: null };
  const consider = (axis, delta) => {
    if (Math.abs(delta) <= SNAP && (best[axis] === null || Math.abs(delta) < Math.abs(best[axis]))) best[axis] = delta;
  };
  for (const o of others) {
    const vertical = overlap(box.y, bottom(box), o.y, bottom(o)) > -SNAP;
    const horizontal = overlap(box.x, right(box), o.x, right(o)) > -SNAP;
    if (vertical) {
      consider("x", right(o) + GAP - box.x); // 拼在 o 右边
      consider("x", o.x - GAP - right(box)); // 拼在 o 左边
    }
    if (horizontal) {
      consider("y", bottom(o) + GAP - box.y); // 拼在 o 下面
      consider("y", o.y - GAP - bottom(box)); // 拼在 o 上面
    }
    // 上下拼时左右边缘对齐，左右拼时上下边缘对齐
    if (horizontal && (Math.abs(box.y - bottom(o) - GAP) <= SNAP || Math.abs(o.y - bottom(box) - GAP) <= SNAP)) {
      consider("x", o.x - box.x);
      consider("x", right(o) - right(box));
    }
    if (vertical && (Math.abs(box.x - right(o) - GAP) <= SNAP || Math.abs(o.x - right(box) - GAP) <= SNAP)) {
      consider("y", o.y - box.y);
      consider("y", bottom(o) - bottom(box));
    }
  }
  for (const a of workAreas) {
    if (overlap(box.x, right(box), a.x, right(a)) <= 0 || overlap(box.y, bottom(box), a.y, bottom(a)) <= 0) continue;
    consider("x", a.x - box.x);
    consider("x", right(a) - right(box));
    consider("y", a.y - box.y);
    consider("y", bottom(a) - bottom(box));
  }
  return { dx: best.x ?? 0, dy: best.y ?? 0 };
}

/**
 * 一张卡片从 before 变成 after（折叠、展开、改大小）后，拼在它四周的卡片要跟着挪多少。
 * 下边变了，下方的卡片跟着上下挪；上边变了，上方的卡片跟着挪；左右同理。
 * 返回 Map<id, { dx, dy }>。连锁传递：下方卡片的下方也一起挪。rects 是变化前的位置。
 */
export function followResize(rects, id, before, after) {
  const moves = new Map();
  const push = (test, axis, delta) => {
    if (!delta) return;
    const queue = [before];
    const seen = new Set([id]);
    while (queue.length) {
      const cur = queue.shift();
      for (const [other, r] of rects) {
        if (seen.has(other) || !test(cur, r)) continue;
        seen.add(other);
        const m = moves.get(other) || { dx: 0, dy: 0 };
        m[axis] += delta;
        moves.set(other, m);
        queue.push(r);
      }
    }
  };
  push(isBelow, "dy", bottom(after) - bottom(before));
  push((a, b) => isBelow(b, a), "dy", after.y - before.y);
  push(isRightOf, "dx", right(after) - right(before));
  push((a, b) => isRightOf(b, a), "dx", after.x - before.x);
  return moves;
}

/** 保存的位置还在某个显示器上吗（拔掉显示器、改分辨率后可能跑到屏幕外）。 */
export function isOnScreen(r, workAreas) {
  return workAreas.some((a) => r.x < right(a) - 40 && right(r) > a.x + 40 && r.y >= a.y - 10 && r.y < bottom(a) - 30);
}

/**
 * 没有保存位置的卡片放哪：沿主显示器右边从上往下排，接在已有卡片下面；放不下就往左开一列。
 * placed 是已经放好的卡片。
 */
export function defaultSpot(size, placed, area) {
  const margin = 20;
  let x = right(area) - size.width - margin;
  for (let col = 0; col < 4; col++) {
    const inCol = placed.filter((r) => overlap(r.x, right(r), x, x + size.width) > 0);
    const y = inCol.length ? Math.max(...inCol.map(bottom)) + GAP : area.y + margin;
    if (y + size.height <= bottom(area) - margin || col === 3) return { x, y: Math.min(y, bottom(area) - size.height), ...size };
    x -= size.width + GAP;
  }
  return { x, y: area.y + margin, ...size };
}
