// tools/gen-icons.mjs の SVG の読み取りの試験（円弧・相対の書き方・S/T の制御点の反転・rect の rx・番号の表）。
//   node --test tools/gen-icons.test.mjs
// 期待する点は手で計算した値（読み取りの実装とは別に求めたもの）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToSubs, rectSubs, buildIcon, resolveOrder } from './gen-icons.mjs';

const TOL = 0.001;

function pts(d) {
  return pathToSubs(d, TOL);
}

// 折れ線から点 (x, y) までの最短距離
function distTo(sub, x, y) {
  let best = Infinity;
  const p = sub.pts;
  const m = sub.closed ? p.length : p.length - 1;
  for (let i = 0; i < m; i++) {
    const a = p[i];
    const b = p[(i + 1) % p.length];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const l = dx * dx + dy * dy;
    let t = l > 0 ? ((x - a[0]) * dx + (y - a[1]) * dy) / l : 0;
    t = Math.max(0, Math.min(1, t));
    best = Math.min(best, Math.hypot(a[0] + dx * t - x, a[1] + dy * t - y));
  }
  if (p.length === 1) best = Math.hypot(p[0][0] - x, p[0][1] - y);
  return best;
}

function near(a, b, eps = 1e-9) {
  assert.ok(Math.abs(a - b) <= eps, `${a} と ${b} が違う`);
}

test('相対の l / h / v と z', () => {
  const s = pts('M1 1l2 0v2h-2z');
  assert.equal(s.length, 1);
  assert.equal(s[0].closed, true);
  assert.deepEqual(s[0].pts, [[1, 1], [3, 1], [3, 3], [1, 3]]);
});

test('m の後の暗黙の l と、z の後の相対の m は閉じた点から', () => {
  const s = pts('m2 2 2 0 0 2zm1 1h1');
  assert.equal(s.length, 2);
  assert.deepEqual(s[0].pts, [[2, 2], [4, 2], [4, 4]]);
  assert.deepEqual(s[1].pts, [[3, 3], [4, 3]]);
});

test('点だけの部分（M8 10.8v.1 のような点）', () => {
  const s = pts('M8 10.8v.1');
  assert.deepEqual(s[0].pts, [[8, 10.8], [8, 10.9]]);
});

test('円弧: 旗が数と続けて書かれる（a6 6 0 016 6）。小さい弧・時計回り', () => {
  // (2, 8) から (8, 14) への半径 6 の弧。sweep=1（画面で時計回り）で小さい弧なら、中心は (2, 14)
  const s = pts('M2 8a6 6 0 016 6')[0];
  const last = s.pts[s.pts.length - 1];
  near(last[0], 8, 1e-9);
  near(last[1], 14, 1e-9);
  for (const p of s.pts) near(Math.hypot(p[0] - 2, p[1] - 14), 6, 1e-6);
  // 弧の中ほど（角度 −45°）を通る
  assert.ok(distTo(s, 2 + 6 * Math.SQRT1_2, 14 - 6 * Math.SQRT1_2) < 0.002);
});

test('円弧: 大きい弧・反時計回り（A6 6 0 1 0）', () => {
  // 同じ端点で large=1 sweep=0 → 中心 (2, 14) で 270° 回る（角度 −90° → −360°）。(−4, 14) を通る
  const s = pts('M2 8A6 6 0 1 0 8 14')[0];
  for (const p of s.pts) near(Math.hypot(p[0] - 2, p[1] - 14), 6, 1e-6);
  assert.ok(distTo(s, -4, 14) < 0.002);
  assert.ok(distTo(s, 2, 20) < 0.002);
});

test('円弧: 半径が足りないときは広げる（半円）', () => {
  const s = pts('M0 8A1 1 0 0 1 16 8')[0];
  // sweep=1 で (0,8)→(16,8) は上（y が小さい側）を通る
  assert.ok(distTo(s, 8, 0) < 0.002);
});

test('S は直前の C の第 2 制御点を反転する', () => {
  // 2 つ目の曲線は (4,0) (4,-4) (8,-4) (8,0)。t=0.5 で (6, -3)
  const s = pts('M0 0C0 4 4 4 4 0S8 -4 8 0')[0];
  assert.ok(distTo(s, 6, -3) < 0.002);
  // 1 つ目は t=0.5 で (2, 3)
  assert.ok(distTo(s, 2, 3) < 0.002);
});

test('相対の s / t', () => {
  const s = pts('M0 0c0 4 4 4 4 0s4 -4 4 0')[0];
  assert.ok(distTo(s, 6, -3) < 0.002);
  const q = pts('M0 0q2 4 4 0t4 0')[0];
  // 2 つ目は (4,0) (6,-4) (8,0)。t=0.5 で (6, -2)
  assert.ok(distTo(q, 6, -2) < 0.002);
  assert.ok(distTo(q, 2, 2) < 0.002);
});

test('T は直前の Q の制御点を反転し、Q の後でなければ現在の点', () => {
  const q = pts('M0 0Q2 4 4 0T8 0')[0];
  assert.ok(distTo(q, 6, -2) < 0.002);
  const l = pts('M0 0L4 0T8 0')[0];
  // 直線になる
  for (const p of l.pts) near(p[1], 0, 1e-9);
});

test('rect の rx（角は 1/4 の円）と rx を大きさの半分に抑える', () => {
  const s = rectSubs({ x: '2', y: '2', width: '12', height: '8', rx: '2' }, TOL)[0];
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of s.pts) {
    x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]);
  }
  near(x0, 2, 1e-9); near(y0, 2, 1e-9); near(x1, 14, 1e-9); near(y1, 10, 1e-9);
  // 左上の角は中心 (4, 4) の半径 2 の円の上
  assert.ok(distTo(s, 4 - 2 * Math.SQRT1_2, 4 - 2 * Math.SQRT1_2) < 0.002);
  assert.ok(distTo(s, 2, 2) > 0.5);
  // ry だけでも rx と同じに
  const t = rectSubs({ x: '0', y: '0', width: '4', height: '4', ry: '9' }, TOL)[0];
  assert.ok(distTo(t, 2, 0) < 0.002);
  assert.ok(distTo(t, 2 - 2 * Math.SQRT1_2, 2 - 2 * Math.SQRT1_2) < 0.002);
});

test('buildIcon: 既定の線と、要素ごとの塗り・stroke=none・fill-rule', () => {
  const defaults = { fill: 'none', stroke: 'currentColor', 'stroke-width': '1.5', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' };
  const ic = {
    viewBox: '0 0 16 16',
    elems: [
      { tag: 'circle', attrs: { cx: '8', cy: '8', r: '6' } },
      { tag: 'path', attrs: { d: 'M5 5h6v6H5z', fill: 'currentColor', stroke: 'none', 'fill-rule': 'evenodd', 'fill-opacity': '.5' } },
    ],
  };
  const e = buildIcon('i-t', ic, defaults, TOL);
  assert.equal(e.length, 2);
  assert.equal(e[0].stroke, 1.5);
  assert.equal(e[0].fill, 0);
  assert.equal(e[1].stroke, 0);
  assert.equal(e[1].fill, 0.5);
  assert.equal(e[1].rule, 1);
  for (const p of e[0].subs[0].pts) near(Math.hypot(p[0] - 8, p[1] - 8), 6, 1e-9);
});

test('番号の表: 既存の番号は変えず、新しいものは末尾、消えたものは知らせる', () => {
  const icons = new Map([['i-b', {}], ['i-new', {}], ['i-a', {}]]);
  const r = resolveOrder({ order: ['a', 'gone', 'b'] }, icons);
  assert.deepEqual(r.order, ['a', 'gone', 'b', 'new']);
  assert.deepEqual(r.added, ['new']);
  assert.deepEqual(r.missing, ['gone']);
});
