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

// ── 拉边改大小 ──

/**
 * 拉边改大小之后卡片应该多大。start 是按下鼠标时的外框，dx/dy 是光标从按下到现在的位移，
 * edges 是要动的边（"n" "s" "e" "w"，角上是两个字母），min 是最小尺寸。
 * snap 为真时，正在动的那条边会吸到：别的卡片同一条边（边界共线）、隔一个 GAP 相邻的位置，
 * 以及显示器工作区的边。按住 Alt 传 snap=false 就不吸。
 */
export function resizeRect(start, edges, dx, dy, min, { others = [], workAreas = [], snap = true } = {}) {
  const e = String(edges ?? "");
  let left = start.x;
  let top = start.y;
  let right = start.x + start.width;
  let bottom = start.y + start.height;
  // 先按光标挪动正在拖的那几条边，再夹住最小尺寸（另一条边不动，所以夹的时候往被拖的方向退）
  if (e.includes("w")) left = Math.min(left + dx, right - min.width);
  else if (e.includes("e")) right = Math.max(right + dx, left + min.width);
  if (e.includes("n")) top = Math.min(top + dy, bottom - min.height);
  else if (e.includes("s")) bottom = Math.max(bottom + dy, top + min.height);

  if (snap) {
    const has = (k) => e.includes(k);
    const xs = []; // 竖直边的候选横坐标
    const ys = []; // 水平边的候选纵坐标
    for (const o of others) {
      const oRight = o.x + o.width;
      const oBottom = o.y + o.height;
      const sideBySide = overlap(top, bottom, o.y, oBottom) > -SNAP; // 竖向挨着：左右并排
      const stacked = overlap(left, right, o.x, oRight) > -SNAP; // 横向挨着：上下同一列
      // 吸到「隔一个 GAP 挨着」的位置
      if (sideBySide) {
        if (has("e")) xs.push(o.x - GAP);
        if (has("w")) xs.push(oRight + GAP);
      }
      if (stacked) {
        if (has("s")) ys.push(o.y - GAP);
        if (has("n")) ys.push(oBottom + GAP);
      }
      // 边界共线：同一列里右边对右边、左边对左边；同一行里下边对下边、上边对上边
      if (overlap(left, right, o.x, oRight) > 0) {
        if (has("e")) xs.push(oRight);
        if (has("w")) xs.push(o.x);
      }
      if (overlap(top, bottom, o.y, oBottom) > 0) {
        if (has("s")) ys.push(oBottom);
        if (has("n")) ys.push(o.y);
      }
    }
    for (const a of workAreas) {
      const aRight = a.x + a.width;
      const aBottom = a.y + a.height;
      const inX = overlap(left, right, a.x, aRight) > 0;
      const inY = overlap(top, bottom, a.y, aBottom) > 0;
      if (inX && has("e")) xs.push(aRight);
      if (inX && has("w")) xs.push(a.x);
      if (inY && has("s")) ys.push(aBottom);
      if (inY && has("n")) ys.push(a.y);
    }
    const near = (v, list) => {
      let best = null;
      for (const c of list) {
        const d = c - v;
        if (Math.abs(d) <= SNAP && (best === null || Math.abs(d) < Math.abs(best))) best = d;
      }
      return best;
    };
    if (has("e")) right += near(right, xs) ?? 0;
    if (has("w")) left += near(left, xs) ?? 0;
    if (has("s")) bottom += near(bottom, ys) ?? 0;
    if (has("n")) top += near(top, ys) ?? 0;
    // 吸过去有可能小过最小尺寸，再夹一次
    if (has("e") || has("w")) {
      if (min.width - (right - left) > 0) {
        if (has("w")) left = right - min.width;
        else right = left + min.width;
      }
    }
    if (has("n") || has("s")) {
      if (min.height - (bottom - top) > 0) {
        if (has("n")) top = bottom - min.height;
        else bottom = top + min.height;
      }
    }
  }
  return { x: Math.round(left), y: Math.round(top), width: Math.round(right - left), height: Math.round(bottom - top) };
}

/** 保存的位置还在某个显示器上吗（拔掉显示器、改分辨率后可能跑到屏幕外）。 */
export function isOnScreen(r, workAreas) {  return workAreas.some((a) => r.x < right(a) - 40 && right(r) > a.x + 40 && r.y >= a.y - 10 && r.y < bottom(a) - 30);
}

/**
 * 没有保存位置的卡片放哪：沿主显示器右边从上往下排，接在已有卡片下面；放不下就往左开一列。
 * placed 是已经放好的卡片。
 */
export function defaultSpot(size, placed, area) {
  const margin = 20;
  // 超大卡片宁可让内容超出右边 / 下边，也不能把可拖动的顶栏放到屏幕外。
  const fallback = {
    x: Math.max(area.x, right(area) - size.width - margin),
    y: Math.max(area.y, Math.min(area.y + margin, bottom(area) - size.height)),
    ...size,
  };
  let x = fallback.x;
  for (let col = 0; col < 4; col++) {
    // 另一块显示器可能与本列同 x，但不占本工作区；跨屏卡片的可见部分仍算占位。
    const inCol = placed.filter((r) => overlap(r.y, bottom(r), area.y, bottom(area)) > 0 && overlap(r.x, right(r), x, x + size.width) > 0);
    const y = inCol.length ? Math.max(...inCol.map(bottom)) + GAP : fallback.y;
    if (y + size.height <= bottom(area) - margin) return { x, y, ...size };
    const nextX = x - size.width - GAP;
    if (nextX < area.x) break;
    x = nextX;
  }
  // 没有能完整容纳的列时允许重叠，保住顶栏，别继续向左试到整个窗口消失。
  return fallback;
}
