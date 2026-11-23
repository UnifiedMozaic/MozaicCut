#!/usr/bin/env node
// アイコンの集まりを作る。モックアップ（docs/design/mockups/*.html）の SVG の <symbol id="i-…"> を集め、
// 線の太さ・端・角・塗り・塗りの濃さを保ったまま、16×16 の座標の折れ線（曲線と円弧は細かい直線にする）にして
// src/gen/icons.um を書く（中身が変わったときだけ）。UM の側（src/ui/icons/draw.um）は、この形を
// 欲しい大きさ・倍率でアンチエイリアスつきの被覆率の画像にして描く。
//
//   node tools/gen-icons.mjs [--src <html か フォルダ>]... [--out src/gen/icons.um] [--order tools/icons-order.json] [--frozen]
//       --src を省くと docs/design/mockups（この作業ツリーに無ければ、git の主の作業ツリーの docs/design/mockups）。
//       正本はモックアップ（*.html）だけ。Claude Design の写し（*.dc.html）も渡せるが、形を比べるだけで、
//       違っていれば警告を出してモックアップの形を使う（写しにだけあるアイコンも使わない）。
//       モックアップどうしで同じ名前の形が違うときは止まる。
//
// 番号（ICN_*）は tools/icons-order.json の並びで決まり、作り直しても変わらない。デザインに新しいアイコンが
// 増えたら表の末尾に足して知らせる（--frozen なら足さずに止まる）。表にあってデザインに無いアイコンも知らせる
// （番号は空けたまま、形は空）。
//
// 別の実装との照合（Chromium の描画。tools/icons-browser-ref.mjs）と、読み取りの試験（tools/gen-icons.test.mjs）もある。
//
// 確かめ（ブラウザなしで、元の SVG を自前で細かくラスタライズした結果と、UM の描いた結果を比べる）:
//   node tools/gen-icons.mjs --ref ref.bmp --sizes 16,20,24 [--cols 12]
//       元の SVG から「見本の格子」を描く（黒地に白。画素の値 = 被覆率）。1 画素を 16×16 点で調べる
//   node tools/gen-icons.mjs --compare ref.bmp um.bmp [--diff diff.bmp]
//       2 枚の差（最大・平均・はっきり違う画素の数）を出し、左から 元 | UM | 差×4 の画像を書く
//
// 見本の格子の並び（src/icons_demo.um の --sheet と同じ）: 大きさ S ごとに、セル = S + 2·round(S/2)、
// cols 列で名前の順に並べ、大きさの順に縦に積む。アイコンの 16 の座標は S 画素の正方形に写す
// （画素 (i, j) の中心は座標 ((i+0.5)·16/S, (j+0.5)·16/S)）。
//
// 対応する SVG: path（M L H V C S Q T A Z、相対も）・line・rect（rx/ry）・circle・ellipse・polyline・polygon。
// 色は currentColor か none だけ（アイコンは 1 色で、塗りの濃さ fill-opacity・stroke-opacity は使える）。
// 線の端と角は round だけ（それ以外が来たら止まる。UM の側は「線 = 太さの円をなぞった形」で描くため）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GRID = 16;
// UM に渡す折れ線の細かさ（16 の座標で）。24px（倍率 1.5 の 16px）で 0.015px、48px で 0.03px のずれ
const TOL_OUT = 0.01;
// 確かめ用のラスタライズの細かさ
const TOL_REF = 0.001;

function die(msg) {
  console.error(`gen-icons: ${msg}`);
  process.exit(1);
}

function warn(msg) {
  console.warn(`gen-icons: 警告: ${msg}`);
}

// Claude Design の写し（*.dc.html）か。正本はモックアップ（docs/design/mockups/*.html）
export function isCopy(f) {
  return /\.dc\.html$/i.test(f);
}

function writeIfChanged(file, text) {
  let old = null;
  try {
    old = fs.readFileSync(file, 'utf8');
  } catch {
    old = null;
  }
  if (old === text) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return true;
}

// ---- HTML から集める ----

function parseAttrs(s) {
  const a = {};
  for (const m of s.matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)')/g)) {
    a[m[1]] = m[3] !== undefined ? m[3] : m[4];
  }
  return a;
}

// style="a:b;c:d" を属性に混ぜる（style が勝つ）
function withStyle(a) {
  const r = { ...a };
  if (a.style) {
    for (const part of a.style.split(';')) {
      const i = part.indexOf(':');
      if (i > 0) r[part.slice(0, i).trim()] = part.slice(i + 1).trim();
    }
  }
  return r;
}

// .ic { … } の線の既定値（無ければ設計書の値: 線 1.5、端と角は丸）
function icDefaults(html) {
  const d = { fill: 'none', stroke: 'currentColor', 'stroke-width': '1.5', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' };
  const m = html.match(/\.ic\s*\{([^}]*)\}/);
  if (m) {
    for (const part of m[1].split(';')) {
      const i = part.indexOf(':');
      if (i <= 0) continue;
      const k = part.slice(0, i).trim();
      if (k in d) d[k] = part.slice(i + 1).trim();
    }
  }
  return d;
}

export function collect(files) {
  const icons = new Map(); // id -> { viewBox, elems: [{tag, attrs}], src, key, raw }（正本 = モックアップの形）
  const copied = []; // 写し（*.dc.html）の形: { id, key, src }
  let defaults = null;
  // 正本が 1 つも無いときだけ、写しを正本として扱う
  const hasPrimary = files.some((f) => !isCopy(f));
  for (const f of files) {
    const copy = hasPrimary && isCopy(f);
    const html = fs.readFileSync(f, 'utf8');
    if (!copy && !defaults && /\.ic\s*\{/.test(html)) defaults = icDefaults(html);
    for (const m of html.matchAll(/<symbol\b([^>]*)>([\s\S]*?)<\/symbol>/g)) {
      const sa = parseAttrs(m[1]);
      if (!sa.id || !sa.id.startsWith('i-')) continue;
      const elems = [];
      for (const e of m[2].matchAll(/<(path|line|rect|circle|ellipse|polyline|polygon)\b([^>]*?)\/?>/g)) {
        elems.push({ tag: e[1], attrs: withStyle(parseAttrs(e[2])) });
      }
      for (const e of m[2].matchAll(/<([a-zA-Z]+)\b/g)) {
        if (!/^(path|line|rect|circle|ellipse|polyline|polygon)$/.test(e[1])) die(`${sa.id}（${f}）: <${e[1]}> は未対応`);
      }
      const key = JSON.stringify([sa.viewBox || '', elems]);
      if (copy) {
        copied.push({ id: sa.id, key, src: f });
        continue;
      }
      const prev = icons.get(sa.id);
      if (prev && prev.key !== key) die(`${sa.id} の絵が ${prev.src} と ${f} で違う`);
      if (!prev) icons.set(sa.id, { viewBox: sa.viewBox || `0 0 ${GRID} ${GRID}`, elems, src: f, key, raw: m[0] });
    }
  }
  // 写しを正本と比べる（違えば警告。形は正本のもの）
  const diffs = new Map(); // id -> 写しのファイル名の並び
  const only = new Map();
  for (const c of copied) {
    const p = icons.get(c.id);
    const m = !p ? only : p.key !== c.key ? diffs : null;
    if (!m) continue;
    if (!m.has(c.id)) m.set(c.id, []);
    m.get(c.id).push(path.basename(c.src));
  }
  const warnings = [];
  for (const [id, fl] of diffs) warnings.push(`${id} の形が正本（${path.basename(icons.get(id).src)} ほか）と写し（${fl.join(', ')}）で違う。正本の形を使います`);
  for (const [id, fl] of only) warnings.push(`${id} は写し（${fl.join(', ')}）にだけあり、正本に無いので使いません`);
  for (const w of warnings) warn(w);
  return { icons, defaults: defaults || icDefaults(''), warnings };
}

// ---- 形を折れ線にする ----

function num(s, what) {
  const v = parseFloat(s);
  if (!Number.isFinite(v)) die(`数でない値 ${what}="${s}"`);
  return v;
}

function tokenizePath(d) {
  const out = [];
  const re = /([MmLlHhVvCcSsQqTtAaZz])|([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)/g;
  let m;
  while ((m = re.exec(d))) {
    if (m[1]) out.push(m[1]);
    else out.push(m[2]);
  }
  return out;
}

// 円弧の旗（0 か 1）は数と続けて書かれることがある（"a1 1 0 011 1"）ので、1 文字ずつ取る
function splitArcFlags(d) {
  return d.replace(/([Aa])([^MmLlHhVvCcSsQqTtAaZz]*)/g, (all, cmd, body) => {
    const nums = [];
    const re = /[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g;
    let i = 0;
    let pos = 0;
    const s = body;
    let res = [];
    while (pos < s.length) {
      const c = s[pos];
      if (c === ' ' || c === ',' || c === '\n' || c === '\t' || c === '\r') {
        pos++;
        continue;
      }
      const k = i % 7;
      if (k === 3 || k === 4) {
        res.push(c);
        pos++;
        i++;
        continue;
      }
      re.lastIndex = pos;
      const m = re.exec(s);
      if (!m || m.index !== pos) die(`円弧の書き方が読めない: ${all}`);
      res.push(m[0]);
      pos += m[0].length;
      i++;
    }
    void nums;
    return cmd + ' ' + res.join(' ') + ' ';
  });
}

function flattenCubic(out, p0, p1, p2, p3, tol) {
  const ddx = Math.max(Math.abs(p0[0] - 2 * p1[0] + p2[0]), Math.abs(p1[0] - 2 * p2[0] + p3[0]));
  const ddy = Math.max(Math.abs(p0[1] - 2 * p1[1] + p2[1]), Math.abs(p1[1] - 2 * p2[1] + p3[1]));
  const dd = Math.hypot(ddx, ddy);
  const n = Math.max(1, Math.ceil(Math.sqrt((0.75 * dd) / tol)));
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    const u = 1 - t;
    out.push([
      u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
      u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1],
    ]);
  }
}

function flattenQuad(out, p0, p1, p2, tol) {
  const dd = Math.hypot(p0[0] - 2 * p1[0] + p2[0], p0[1] - 2 * p1[1] + p2[1]);
  const n = Math.max(1, Math.ceil(Math.sqrt((0.25 * dd) / tol)));
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    const u = 1 - t;
    out.push([u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0], u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1]]);
  }
}

// SVG の円弧（端点の形）を中心の形にして折れ線にする（SVG 1.1 の F.6.5）
function flattenArc(out, p0, rx, ry, phiDeg, large, sweep, p1, tol) {
  if (p0[0] === p1[0] && p0[1] === p1[1]) return;
  rx = Math.abs(rx);
  ry = Math.abs(ry);
  if (rx === 0 || ry === 0) {
    out.push([p1[0], p1[1]]);
    return;
  }
  const phi = (phiDeg * Math.PI) / 180;
  const cs = Math.cos(phi);
  const sn = Math.sin(phi);
  const dx = (p0[0] - p1[0]) / 2;
  const dy = (p0[1] - p1[1]) / 2;
  const x1 = cs * dx + sn * dy;
  const y1 = -sn * dx + cs * dy;
  const lam = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
  if (lam > 1) {
    rx *= Math.sqrt(lam);
    ry *= Math.sqrt(lam);
  }
  const num_ = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1;
  const den = rx * rx * y1 * y1 + ry * ry * x1 * x1;
  let co = Math.sqrt(Math.max(0, num_ / den));
  if (large === sweep) co = -co;
  const cxp = (co * rx * y1) / ry;
  const cyp = (-co * ry * x1) / rx;
  const cx = cs * cxp - sn * cyp + (p0[0] + p1[0]) / 2;
  const cy = sn * cxp + cs * cyp + (p0[1] + p1[1]) / 2;
  const ang = (ux, uy, vx, vy) => {
    const a = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
    return a;
  };
  const t1 = ang(1, 0, (x1 - cxp) / rx, (y1 - cyp) / ry);
  let dt = ang((x1 - cxp) / rx, (y1 - cyp) / ry, (-x1 - cxp) / rx, (-y1 - cyp) / ry);
  if (!sweep && dt > 0) dt -= 2 * Math.PI;
  if (sweep && dt < 0) dt += 2 * Math.PI;
  const r = Math.max(rx, ry);
  const step = 2 * Math.acos(Math.max(-1, Math.min(1, 1 - tol / r)));
  const n = Math.max(2, Math.ceil(Math.abs(dt) / step));
  for (let i = 1; i <= n; i++) {
    const t = t1 + (dt * i) / n;
    if (i === n) {
      out.push([p1[0], p1[1]]);
    } else {
      const ex = rx * Math.cos(t);
      const ey = ry * Math.sin(t);
      out.push([cs * ex - sn * ey + cx, sn * ex + cs * ey + cy]);
    }
  }
}

export function pathToSubs(d, tol) {
  const toks = tokenizePath(splitArcFlags(d));
  const subs = [];
  let cur = null;
  let p = [0, 0];
  let start = [0, 0];
  let lastC = null; // 直前の 3 次の第 2 制御点（S 用）
  let lastQ = null; // 直前の 2 次の制御点（T 用）
  let cmd = '';
  let i = 0;
  const take = () => {
    if (i >= toks.length || /[A-Za-z]/.test(toks[i])) die(`path の数が足りない: ${d}`);
    return parseFloat(toks[i++]);
  };
  const begin = (q) => {
    cur = { pts: [[q[0], q[1]]], closed: false };
    subs.push(cur);
  };
  while (i < toks.length) {
    if (/[A-Za-z]/.test(toks[i])) cmd = toks[i++];
    else if (!cmd) die(`path が命令で始まらない: ${d}`);
    const rel = cmd === cmd.toLowerCase();
    const C = cmd.toUpperCase();
    const ox = rel ? p[0] : 0;
    const oy = rel ? p[1] : 0;
    if (C === 'Z') {
      if (cur) {
        cur.closed = true;
        p = [start[0], start[1]];
        cur = null;
      }
      lastC = lastQ = null;
      continue;
    }
    if (C === 'M') {
      const q = [ox + take(), oy + take()];
      begin(q);
      p = q;
      start = q;
      cmd = rel ? 'l' : 'L';
      lastC = lastQ = null;
      continue;
    }
    if (!cur) begin(p);
    if (C === 'L') {
      p = [ox + take(), oy + take()];
      cur.pts.push(p);
      lastC = lastQ = null;
    } else if (C === 'H') {
      p = [ox + take(), p[1]];
      cur.pts.push(p);
      lastC = lastQ = null;
    } else if (C === 'V') {
      p = [p[0], oy + take()];
      cur.pts.push(p);
      lastC = lastQ = null;
    } else if (C === 'C' || C === 'S') {
      let c1;
      if (C === 'C') c1 = [ox + take(), oy + take()];
      else c1 = lastC ? [2 * p[0] - lastC[0], 2 * p[1] - lastC[1]] : [p[0], p[1]];
      const c2 = [ox + take(), oy + take()];
      const e = [ox + take(), oy + take()];
      flattenCubic(cur.pts, p, c1, c2, e, tol);
      lastC = c2;
      lastQ = null;
      p = e;
    } else if (C === 'Q' || C === 'T') {
      let c1;
      if (C === 'Q') c1 = [ox + take(), oy + take()];
      else c1 = lastQ ? [2 * p[0] - lastQ[0], 2 * p[1] - lastQ[1]] : [p[0], p[1]];
      const e = [ox + take(), oy + take()];
      flattenQuad(cur.pts, p, c1, e, tol);
      lastQ = c1;
      lastC = null;
      p = e;
    } else if (C === 'A') {
      const rx = take();
      const ry = take();
      const rot = take();
      const large = take() !== 0;
      const sweep = take() !== 0;
      const e = [ox + take(), oy + take()];
      flattenArc(cur.pts, p, rx, ry, rot, large, sweep, e, tol);
      lastC = lastQ = null;
      p = e;
    } else {
      die(`path の命令 ${cmd} は未対応`);
    }
  }
  return subs;
}

function ellipseSub(cx, cy, rx, ry, tol) {
  const r = Math.max(rx, ry);
  const step = 2 * Math.acos(Math.max(-1, Math.min(1, 1 - tol / r)));
  const n = Math.max(8, Math.ceil((2 * Math.PI) / step));
  const pts = [];
  for (let i = 0; i < n; i++) {
    const t = (2 * Math.PI * i) / n;
    pts.push([cx + rx * Math.cos(t), cy + ry * Math.sin(t)]);
  }
  return { pts, closed: true };
}

export function rectSubs(a, tol) {
  const x = num(a.x || '0', 'x');
  const y = num(a.y || '0', 'y');
  const w = num(a.width, 'width');
  const h = num(a.height, 'height');
  let rx = a.rx !== undefined ? num(a.rx, 'rx') : a.ry !== undefined ? num(a.ry, 'ry') : 0;
  let ry = a.ry !== undefined ? num(a.ry, 'ry') : rx;
  rx = Math.min(rx, w / 2);
  ry = Math.min(ry, h / 2);
  if (rx <= 0 || ry <= 0) {
    return [{ pts: [[x, y], [x + w, y], [x + w, y + h], [x, y + h]], closed: true }];
  }
  const d = `M${x + rx} ${y}H${x + w - rx}A${rx} ${ry} 0 0 1 ${x + w} ${y + ry}V${y + h - ry}A${rx} ${ry} 0 0 1 ${x + w - rx} ${y + h}` +
    `H${x + rx}A${rx} ${ry} 0 0 1 ${x} ${y + h - ry}V${y + ry}A${rx} ${ry} 0 0 1 ${x + rx} ${y}Z`;
  return pathToSubs(d, tol);
}

function pointsList(s) {
  const v = (s || '').trim().split(/[\s,]+/).filter((t) => t.length > 0).map((t) => num(t, 'points'));
  const pts = [];
  for (let i = 0; i + 1 < v.length; i += 2) pts.push([v[i], v[i + 1]]);
  return pts;
}

function paintOn(v, id) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  if (s === 'none') return false;
  if (s === 'currentColor' || s === 'currentcolor') return true;
  die(`${id}: 色 "${s}" は未対応（currentColor か none だけ）`);
}

// 1 つのアイコンを要素の並びにする: [{ fill, stroke, rule, subs }]（fill = 塗りの濃さ 0..1、stroke = 線の太さ）
export function buildIcon(id, ic, defaults, tol) {
  const vb = ic.viewBox.trim().split(/[\s,]+/).map((t) => num(t, 'viewBox'));
  if (vb[0] !== 0 || vb[1] !== 0 || vb[2] !== GRID || vb[3] !== GRID) die(`${id}: viewBox は 0 0 16 16 だけ（${ic.viewBox}）`);
  const elems = [];
  for (const e of ic.elems) {
    const a = e.attrs;
    const get = (k) => (a[k] !== undefined ? a[k] : defaults[k]);
    const fillOn = paintOn(get('fill'), id);
    const strokeOn = paintOn(get('stroke'), id);
    const op = a.opacity !== undefined ? num(a.opacity, 'opacity') : 1;
    const fop = (a['fill-opacity'] !== undefined ? num(a['fill-opacity'], 'fill-opacity') : 1) * op;
    const sop = (a['stroke-opacity'] !== undefined ? num(a['stroke-opacity'], 'stroke-opacity') : 1) * op;
    const sw = num(get('stroke-width'), 'stroke-width');
    if (strokeOn) {
      if (get('stroke-linecap') !== 'round') die(`${id}: stroke-linecap="${get('stroke-linecap')}" は未対応（round だけ）`);
      if (get('stroke-linejoin') !== 'round') die(`${id}: stroke-linejoin="${get('stroke-linejoin')}" は未対応（round だけ）`);
      if (a['stroke-dasharray'] !== undefined && a['stroke-dasharray'] !== 'none') die(`${id}: stroke-dasharray は未対応`);
    }
    let subs;
    if (e.tag === 'path') subs = pathToSubs(a.d || '', tol);
    else if (e.tag === 'line') subs = [{ pts: [[num(a.x1 || '0', 'x1'), num(a.y1 || '0', 'y1')], [num(a.x2 || '0', 'x2'), num(a.y2 || '0', 'y2')]], closed: false }];
    else if (e.tag === 'rect') subs = rectSubs(a, tol);
    else if (e.tag === 'circle') subs = [ellipseSub(num(a.cx || '0', 'cx'), num(a.cy || '0', 'cy'), num(a.r, 'r'), num(a.r, 'r'), tol)];
    else if (e.tag === 'ellipse') subs = [ellipseSub(num(a.cx || '0', 'cx'), num(a.cy || '0', 'cy'), num(a.rx, 'rx'), num(a.ry, 'ry'), tol)];
    else if (e.tag === 'polyline') subs = [{ pts: pointsList(a.points), closed: false }];
    else if (e.tag === 'polygon') subs = [{ pts: pointsList(a.points), closed: true }];
    // 閉じた形の最後の点が最初の点と同じなら落とす
    for (const s of subs) {
      if (s.closed && s.pts.length > 2) {
        const f = s.pts[0];
        const l = s.pts[s.pts.length - 1];
        if (Math.abs(f[0] - l[0]) < 1e-9 && Math.abs(f[1] - l[1]) < 1e-9) s.pts.pop();
      }
    }
    const rule = (get('fill-rule') || 'nonzero') === 'evenodd' ? 1 : 0;
    elems.push({ fill: fillOn ? fop : 0, stroke: strokeOn ? sw : 0, sop: strokeOn ? sop : 0, rule, subs });
  }
  return elems;
}

// ---- 確かめ用のラスタライズ（元の SVG の形を 1 画素 16×16 点で調べる）----

function distSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const l = dx * dx + dy * dy;
  let t = l > 0 ? ((px - ax) * dx + (py - ay) * dy) / l : 0;
  t = Math.max(0, Math.min(1, t));
  const ex = ax + dx * t - px;
  const ey = ay + dy * t - py;
  return Math.sqrt(ex * ex + ey * ey);
}

function sampleIcon(elems, x, y) {
  let A = 0;
  for (const e of elems) {
    let s = 0;
    let f = 0;
    if (e.stroke > 0) {
      const hw = e.stroke / 2;
      outer: for (const sub of e.subs) {
        const n = sub.pts.length;
        const m = sub.closed ? n : n - 1;
        if (n === 1) {
          if (Math.hypot(x - sub.pts[0][0], y - sub.pts[0][1]) <= hw) {
            s = 1;
            break;
          }
        }
        for (let i = 0; i < m; i++) {
          const a = sub.pts[i];
          const b = sub.pts[(i + 1) % n];
          if (distSeg(x, y, a[0], a[1], b[0], b[1]) <= hw) {
            s = 1;
            break outer;
          }
        }
      }
    }
    if (e.fill > 0) {
      let wn = 0;
      let cross = 0;
      for (const sub of e.subs) {
        const n = sub.pts.length;
        for (let i = 0; i < n; i++) {
          const a = sub.pts[i];
          const b = sub.pts[(i + 1) % n];
          if (a[1] <= y) {
            if (b[1] > y && (b[0] - a[0]) * (y - a[1]) - (x - a[0]) * (b[1] - a[1]) > 0) {
              wn++;
              cross++;
            }
          } else if (b[1] <= y && (b[0] - a[0]) * (y - a[1]) - (x - a[0]) * (b[1] - a[1]) < 0) {
            wn--;
            cross++;
          }
        }
      }
      const inside = e.rule === 1 ? cross % 2 === 1 : wn !== 0;
      if (inside) f = e.fill;
    }
    const a = s * e.sop + f * (1 - s * e.sop);
    A = A + a * (1 - A);
  }
  return A;
}

function rasterRef(elems, S) {
  const N = 16;
  const out = new Float64Array(S * S);
  const k = GRID / S;
  for (let j = 0; j < S; j++) {
    for (let i = 0; i < S; i++) {
      let acc = 0;
      for (let sy = 0; sy < N; sy++) {
        for (let sx = 0; sx < N; sx++) {
          acc += sampleIcon(elems, (i + (sx + 0.5) / N) * k, (j + (sy + 0.5) / N) * k);
        }
      }
      out[j * S + i] = acc / (N * N);
    }
  }
  return out;
}

export function sheetLayout(count, sizes, cols) {
  let W = 0;
  let H = 0;
  const blocks = [];
  for (const S of sizes) {
    const pad = Math.round(S / 2);
    const cell = S + 2 * pad;
    const rows = Math.ceil(count / cols);
    blocks.push({ S, pad, cell, y: H });
    W = Math.max(W, cell * cols);
    H += cell * rows;
  }
  return { W, H, blocks };
}

function writeBmp(file, W, H, rgb) {
  const buf = Buffer.alloc(54 + W * H * 4);
  buf.write('BM', 0);
  buf.writeUInt32LE(54 + W * H * 4, 2);
  buf.writeUInt32LE(54, 10);
  buf.writeUInt32LE(40, 14);
  buf.writeInt32LE(W, 18);
  buf.writeInt32LE(-H, 22);
  buf.writeUInt16LE(1, 26);
  buf.writeUInt16LE(32, 28);
  buf.writeUInt32LE(W * H * 4, 34);
  for (let i = 0; i < W * H; i++) {
    const p = rgb[i];
    buf[54 + i * 4] = p & 255;
    buf[54 + i * 4 + 1] = (p >> 8) & 255;
    buf[54 + i * 4 + 2] = (p >> 16) & 255;
    buf[54 + i * 4 + 3] = 255;
  }
  fs.writeFileSync(file, buf);
}

function readBmp(file) {
  const b = fs.readFileSync(file);
  if (b.toString('latin1', 0, 2) !== 'BM') die(`${file} は BMP でない`);
  const off = b.readUInt32LE(10);
  const W = b.readInt32LE(18);
  const h0 = b.readInt32LE(22);
  const bpp = b.readUInt16LE(28);
  const H = Math.abs(h0);
  const stride = Math.ceil((W * bpp) / 32) * 4;
  const gray = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    const sy = h0 < 0 ? y : H - 1 - y;
    for (let x = 0; x < W; x++) {
      const o = off + sy * stride + (x * bpp) / 8;
      // 緑の値（黒地に白なので どれでも同じ）
      gray[y * W + x] = b[o + 1];
    }
  }
  return { W, H, gray };
}

// ---- UM を書く ----

function constName(id) {
  return 'ICN_' + id.slice(2).toUpperCase().replace(/[^A-Z0-9]/g, '_');
}

function fmt(v) {
  let s = (Math.round(v * 10000) / 10000).toString();
  if (!/[.e]/.test(s)) s += '.0';
  return s;
}

function emit(list, srcNames) {
  const L = [];
  const live = list.filter((x) => x.elems);
  L.push('// 自動生成されるアイコンの形（tools/gen-icons.mjs が docs/design/mockups/*.html の <symbol id="i-…"> から作る）。手で書き換えない。');
  L.push('// 描くのは src/ui/icons/draw.um（icnDraw / icnDrawBuf）。名前は SVG の id から "i-" を除いたもの（icnId("play")）。');
  L.push('// 番号は tools/icons-order.json の並び（作り直しても変わらない。新しいアイコンは末尾に足される）。');
  L.push('// 描く場所では ICN_* の定数を使う（icnId は文字列を比べるので、起動時や設定の読み込みのときだけ使う）。');
  L.push(`// 元: ${srcNames.join(', ')}`);
  L.push(`// アイコン（${live.length} 個${live.length !== list.length ? `、番号は ${list.length} まで` : ''}）: ${list.map((x) => x.id.slice(2)).join(' ')}`);
  const gone = list.filter((x) => !x.elems);
  if (gone.length > 0) L.push(`// デザインから消えたアイコン（番号は空けたまま、形は空）: ${gone.map((x) => x.id.slice(2)).join(' ')}`);
  L.push('//');
  L.push('// icnGeom(id) の並び（座標は 16×16 の格子。曲線と円弧は細かい直線にしてある）:');
  L.push('//   [要素の数, 要素…]  要素 = [塗りの濃さ(0 = 塗らない), 線の太さ(0 = 線なし), 線の濃さ, 塗りの規則(0 nonzero / 1 evenodd), 部分の数, 部分…]');
  L.push('//   部分 = [閉じているか(0/1), 点の数, x0, y0, x1, y1, …]   線の端と角はすべて丸（round）');
  L.push('');
  L.push(`export const ICN_COUNT: i32 = ${list.length};`);
  L.push('export const ICN_NONE: i32 = -1;');
  list.forEach((x, i) => L.push(`export const ${constName(x.id)}: i32 = ${i};${x.elems ? '' : ' // デザインから消えた（形は空）'}`));
  L.push('');
  L.push('// 番号から名前（"i-" なし）。範囲の外なら ""。');
  L.push('export function icnName(id: i32): string {');
  L.push('  switch (id) {');
  list.forEach((x, i) => L.push(`    case ${i}: return "${x.id.slice(2)}";`));
  L.push('  }');
  L.push('  return "";');
  L.push('}');
  L.push('');
  L.push('// 名前から番号（"play" でも "i-play" でもよい）。見つからなければ ICN_NONE。');
  L.push('export function icnId(name: string): i32 {');
  L.push('  let n = name.clone();');
  L.push('  if (name.length > 2 && name[0] == 105 && name[1] == 45) {');
  L.push('    let b = new Array<u8>(name.length - 2);');
  L.push('    for (let i: usize = 2; i < name.length; i++) {');
  L.push('      b[i - 2] = name[i];');
  L.push('    }');
  L.push('    n = stringFromBytes(b);');
  L.push('  }');
  L.push('  switch (n) {');
  list.forEach((x, i) => L.push(`    case "${x.id.slice(2)}": return ${i};`));
  L.push('  }');
  L.push('  return ICN_NONE;');
  L.push('}');
  L.push('');
  L.push('// 形の並び（上の説明の形）。範囲の外なら空。');
  L.push('export function icnGeom(id: i32): f32[] {');
  L.push('  switch (id) {');
  list.forEach((x, i) => {
    if (!x.elems) return;
    const d = [x.elems.length];
    for (const e of x.elems) {
      d.push(e.fill, e.stroke, e.sop, e.rule, e.subs.length);
      for (const s of e.subs) {
        d.push(s.closed ? 1 : 0, s.pts.length);
        for (const p of s.pts) d.push(p[0], p[1]);
      }
    }
    const parts = d.map(fmt);
    const lines = [];
    for (let k = 0; k < parts.length; k += 16) lines.push('        ' + parts.slice(k, k + 16).join(', ') + ',');
    L.push(`    case ${i}: { // ${x.id.slice(2)}`);
    L.push('      const d: f32[] = [');
    L.push(...lines);
    L.push('      ];');
    L.push('      return d;');
    L.push('    }');
  });
  L.push('  }');
  L.push('  const e: f32[] = [];');
  L.push('  return e;');
  L.push('}');
  L.push('');
  return L.join('\n');
}

// ---- main ----

// --src を省いたときのモックアップの場所。この作業ツリーに無ければ（m2-uikit の系統など）、git の主の作業ツリーを見る
export function defaultSrc() {
  const local = path.join(ROOT, 'docs/design/mockups');
  if (fs.existsSync(local)) return local;
  try {
    const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
    const main = path.join(path.dirname(common), 'docs/design/mockups');
    if (fs.existsSync(main)) {
      console.log(`gen-icons: この作業ツリーに docs/design/mockups が無いので ${main} を使います`);
      return main;
    }
  } catch {
    // git が無い
  }
  return local;
}

export function listHtml(srcs) {
  const files = [];
  for (const s of srcs) {
    if (!fs.existsSync(s)) die(`${s} がない（--src でモックアップの場所を渡す）`);
    if (fs.statSync(s).isDirectory()) {
      for (const f of fs.readdirSync(s).sort()) if (f.endsWith('.html')) files.push(path.join(s, f));
    } else files.push(s);
  }
  return files;
}

// 番号の表を読み、デザインのアイコンと合わせる。戻り値の order は名前（"i-" なし）の並び = 番号の順
export function resolveOrder(orderDoc, icons) {
  const order = [...(orderDoc.order || [])];
  const seen = new Set();
  for (const n of order) {
    if (seen.has(n)) die(`番号の表に ${n} が 2 回ある`);
    seen.add(n);
  }
  const added = [];
  for (const id of icons.keys()) {
    const n = id.slice(2);
    if (!seen.has(n)) {
      order.push(n);
      seen.add(n);
      added.push(n);
    }
  }
  const missing = order.filter((n) => !icons.has('i-' + n));
  return { order, added, missing };
}

export const ORDER_FILE = path.join(ROOT, 'tools/icons-order.json');

export function readOrder(file) {
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  warn(`番号の表 ${file} が無いので、見つけた順で作ります`);
  return { order: [] };
}

function main() {
  const argv = process.argv.slice(2);
  const srcs = [];
  let out = path.join(ROOT, 'src/gen/icons.um');
  let orderFile = ORDER_FILE;
  let frozen = false;
  let ref = null;
  let sizes = [16, 20, 24];
  let cols = 12;
  let compare = null;
  let diff = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--src') srcs.push(argv[++i]);
    else if (a === '--out') out = argv[++i];
    else if (a === '--order') orderFile = argv[++i];
    else if (a === '--frozen') frozen = true;
    else if (a === '--ref') ref = argv[++i];
    else if (a === '--sizes') sizes = argv[++i].split(',').map((s) => parseInt(s, 10));
    else if (a === '--cols') cols = parseInt(argv[++i], 10);
    else if (a === '--compare') compare = [argv[++i], argv[++i]];
    else if (a === '--diff') diff = argv[++i];
    else die(`知らない引数 ${a}`);
  }
  if (compare) return runCompare(compare[0], compare[1], diff);
  if (srcs.length === 0) srcs.push(defaultSrc());
  const files = listHtml(srcs);
  const { icons, defaults } = collect(files);
  if (icons.size === 0) die('アイコン（<symbol id="i-…">）が見つからない');
  // 並びは番号の表（tools/icons-order.json）の順。新しいアイコンは末尾に足す
  const orderDoc = readOrder(orderFile);
  const { order, added, missing } = resolveOrder(orderDoc, icons);
  if (added.length > 0) {
    if (frozen) die(`番号の表に無いアイコンがある: ${added.join(' ')}（--frozen なので止めます）`);
    warn(`新しいアイコン ${added.map((n) => `${n}（${order.indexOf(n)}）`).join(' ')} を番号の表の末尾に足しました`);
    if (!ref) writeIfChanged(orderFile, JSON.stringify({ ...orderDoc, order }, null, 2) + '\n');
  }
  if (missing.length > 0) warn(`番号の表にあってデザインに無いアイコン: ${missing.join(' ')}（番号は空けたまま、形は空にします）`);
  const list = [];
  for (const n of order) {
    const id = 'i-' + n;
    const ic = icons.get(id);
    list.push({ id, out: ic ? buildIcon(id, ic, defaults, TOL_OUT) : null, fine: ic && ref ? buildIcon(id, ic, defaults, TOL_REF) : null });
  }
  if (ref) {
    const lay = sheetLayout(list.length, sizes, cols);
    const rgb = new Uint32Array(lay.W * lay.H);
    for (const b of lay.blocks) {
      list.forEach((x, n) => {
        if (!x.fine) return;
        const cov = rasterRef(x.fine, b.S);
        const ox = (n % cols) * b.cell + b.pad;
        const oy = b.y + Math.floor(n / cols) * b.cell + b.pad;
        for (let j = 0; j < b.S; j++) {
          for (let i = 0; i < b.S; i++) {
            const v = Math.round(cov[j * b.S + i] * 255);
            rgb[(oy + j) * lay.W + ox + i] = (v << 16) | (v << 8) | v;
          }
        }
      });
    }
    writeBmp(ref, lay.W, lay.H, rgb);
    console.log(`gen-icons: ${list.length} 個 × 大きさ ${sizes.join('/')} の見本を ${ref} に書きました（${lay.W}×${lay.H}）`);
    return;
  }
  const rel = files.filter((f) => !isCopy(f) || files.every(isCopy)).map((f) => path.relative(ROOT, f).replace(/\\/g, '/'));
  const srcNames = rel.some((f) => f.startsWith('..')) ? [...new Set(rel.map((f) => path.basename(f)))] : [...new Set(rel.map((f) => path.dirname(f) + '/*.html'))];
  const text = emit(list.map((x) => ({ id: x.id, elems: x.out })), srcNames);
  const changed = writeIfChanged(out, text);
  console.log(`gen-icons: ${list.length - missing.length} 個のアイコン（番号 0..${list.length - 1}）→ ${path.relative(ROOT, out)}${changed ? '' : '（変わらず）'}`);
}

function runCompare(fa, fb, diffFile) {
  const a = readBmp(fa);
  const b = readBmp(fb);
  if (a.W !== b.W || a.H !== b.H) die(`大きさが違う: ${a.W}×${a.H} と ${b.W}×${b.H}`);
  let max = 0;
  let sum = 0;
  let big = 0;
  let ink = 0;
  const n = a.W * a.H;
  for (let i = 0; i < n; i++) {
    const d = Math.abs(a.gray[i] - b.gray[i]);
    max = Math.max(max, d);
    sum += d;
    if (d > 32) big++;
    if (a.gray[i] > 0 || b.gray[i] > 0) ink++;
  }
  console.log(`比べた: ${a.W}×${a.H}、線のある画素 ${ink}、差の最大 ${max}/255、平均（線のある画素で）${(sum / Math.max(ink, 1)).toFixed(2)}/255、32 を超える差 ${big} 画素`);
  if (diffFile) {
    const W = a.W * 3;
    const rgb = new Uint32Array(W * a.H);
    for (let y = 0; y < a.H; y++) {
      for (let x = 0; x < a.W; x++) {
        const i = y * a.W + x;
        const va = a.gray[i];
        const vb = b.gray[i];
        const d = Math.min(255, Math.abs(va - vb) * 4);
        rgb[y * W + x] = (va << 16) | (va << 8) | va;
        rgb[y * W + a.W + x] = (vb << 16) | (vb << 8) | vb;
        // 差: UM が濃い所は赤、薄い所は青
        rgb[y * W + 2 * a.W + x] = vb >= va ? d << 16 : d;
      }
    }
    writeBmp(diffFile, W, a.H, rgb);
  }
  if (big > 0) process.exitCode = 2;
}

export { writeBmp, readBmp };

// 直接起動したときだけ動く（試験や照合の道具から import できるように）
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
