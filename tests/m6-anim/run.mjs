#!/usr/bin/env node
// キーフレームとアニメーションの芯（src/effects/anim/）の試験。node tests/m6-anim/run.mjs で実行する（npm の依存なし）。
//
// 1. src/ を一時フォルダに写し、tests/m6-anim/anim_test.um を src/ の直下に置いてネイティブでビルドする
//    （UM の import は最初のファイルのフォルダの中しか読めないため）。
// 2. 補間（直線・ホールド・ベジェ・イーズ・cubic・自動ベジェ・空間のベジェ）の値を、JavaScript で別に書いた計算と比べる。
// 3. 診断（code と列）、キーの操作（key add / remove / move / set / ease / shift / clear）、グラフのデータ、再マップを確かめる。
// 4. kernel（評価・グラフエディタの絵・経路の絵・フレームブレンド）の結果を書き、ホストの評価との差を測る。
//    wgpu-native が見つかれば（環境変数 UM_WGPU_HOME か ~/wgpu-native/<版>）、UM_WGPU=1 でも作り、
//    CPU（UM_GPU=0）と GPU（UM_GPU_THRESHOLD=1）の結果がビットまで同じことを確かめる。見つからなければ飛ばす。
//
// オプション:
//   --out <フォルダ>  試験の絵（PNG）を書く場所（既定は一時フォルダの images/。--keep のときだけ残る）
//   --bench [回数]    1080p の 1 コマの速さを測って出す（CPU と、あれば GPU）
//   --keep            作業用のフォルダを消さずに残す
//   -v                通った試験も出す
//
// UnifiedMozaic は環境変数 UM_HOME か、このリポジトリの隣（../UnifiedMozaic）から探す。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const argv = process.argv.slice(2);
const KEEP = argv.includes('--keep');
const VERBOSE = argv.includes('-v');
const BENCH = argv.includes('--bench');
const benchArg = BENCH ? argv[argv.indexOf('--bench') + 1] : undefined;
const benchReps = benchArg && /^[0-9]+$/.test(benchArg) ? benchArg : '9';
const outArg = argv.includes('--out') ? argv[argv.indexOf('--out') + 1] : undefined;

function umHome() {
  const cands = [process.env.UM_HOME, path.join(ROOT, '..', 'UnifiedMozaic'), path.join(ROOT, '..', '..', 'UnifiedMozaic'), path.join(os.homedir(), 'UnifiedMozaic')].filter(Boolean);
  for (const c of cands) {
    if (fs.existsSync(path.join(c, 'src', 'cli.ts'))) return c;
  }
  console.error('UnifiedMozaic のコンパイラが見つかりません。環境変数 UM_HOME にその場所を設定してください');
  process.exit(2);
}

function wgpuHome() {
  if (process.env.UM_WGPU_HOME && fs.existsSync(process.env.UM_WGPU_HOME)) return process.env.UM_WGPU_HOME;
  const base = path.join(os.homedir(), 'wgpu-native');
  if (!fs.existsSync(base)) return undefined;
  const vers = fs.readdirSync(base).filter((d) => fs.existsSync(path.join(base, d, 'include', 'webgpu', 'webgpu.h'))).sort();
  return vers.length ? path.join(base, vers[vers.length - 1]) : undefined;
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mozcut-anim-'));
const EXT = process.platform === 'win32' ? '.exe' : '';
const SRC = path.join(TMP, 'src');
const EXE = path.join(TMP, 'cpu', 'anim_test' + EXT);
const GEXE = path.join(TMP, 'gpu', 'anim_test' + EXT);
const OUT = outArg ? path.resolve(outArg) : path.join(TMP, 'images');

function cleanup() {
  if (!KEEP) fs.rmSync(TMP, { recursive: true, force: true });
}

function build(exe, env) {
  fs.mkdirSync(path.dirname(exe), { recursive: true });
  const r = spawnSync(process.execPath, [path.join(umHome(), 'src', 'cli.ts'), 'build', path.join(SRC, 'anim_test.um'), '--target', 'host', '-o', exe],
    { encoding: 'utf8', maxBuffer: 1 << 26, env: { ...process.env, ...env } });
  if (r.status !== 0) {
    process.stdout.write(r.stdout || '');
    process.stderr.write(r.stderr || '');
    console.error('ビルドに失敗しました');
    cleanup();
    process.exit(1);
  }
}

function run(args, exe = EXE, env = {}) {
  const r = spawnSync(exe, args, { encoding: 'utf8', maxBuffer: 1 << 26, env: { ...process.env, ...env } });
  if (r.status !== 0) {
    throw new Error(`anim_test ${args.join(' ')} が終了コード ${r.status} で終わりました\n${r.stdout}${r.stderr}`);
  }
  return r.stdout;
}

// ---- 試験の道具 ----
let passed = 0;
const failures = [];
function test(name, fn) {
  try {
    fn();
    passed++;
    if (VERBOSE) console.log(`  ok  ${name}`);
  } catch (e) {
    failures.push(`${name}: ${e.message}`);
    console.log(`  NG  ${name}: ${e.message}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
function near(a, b, tol, what) {
  assert(Math.abs(a - b) <= tol, `${what}: ${a} と ${b} の差が ${tol} を超えます`);
}

// eval の結果: [{t, v:[4], speed, vel:[2]}]
function evalTrack(type, text, dur, fps, times) {
  const out = run(['eval', type, text, String(dur), String(fps), times.join(',')]);
  const lines = out.trim().split(/\r?\n/);
  const err = lines.filter((l) => l.startsWith('ERR'));
  assert(err.length === 0, `誤り: ${err.join(' / ')}`);
  return lines.map((l) => {
    const p = l.split(' ').map(Number);
    return { t: p[0], v: p.slice(1, 5), speed: p[5], vel: p.slice(6, 8) };
  });
}

function diags(type, text, dur = 5, fps = 30) {
  const out = run(['diag', type, text, String(dur), String(fps)]).trim().split(/\r?\n/).filter(Boolean);
  return out.filter((l) => l !== 'OK').map((l) => {
    const [head, msg, hint] = l.split('|');
    const [code, severity, col, suggest] = head.split(' ');
    return { code, severity, col: Number(col), suggest: suggest || '', msg, hint };
  });
}

function op(name, type, cur, args, dur = 5, fps = 30) {
  return JSON.parse(run(['op', name, type, cur, String(dur), String(fps), ...args]));
}

// ---- JavaScript で別に書いた参照の計算（数の区間 1 つ） ----
// P0 = (t0, v0)、P1 = (t0 + fo·dt, v0 + so·fo·dt)、P2 = (t1 − fi·dt, v1 − si·fi·dt)、P3 = (t1, v1)
function bez(p0, p1, p2, p3, u) {
  const m = 1 - u;
  return m * m * m * p0 + 3 * m * m * u * p1 + 3 * m * u * u * p2 + u * u * u * p3;
}
function refSeg(t0, v0, t1, v1, so, fo, si, fi, t) {
  const dt = t1 - t0;
  const xs = [t0, t0 + fo * dt, t1 - fi * dt, t1];
  const ys = [v0, v0 + so * fo * dt, v1 - si * fi * dt, v1];
  let lo = 0, hi = 1;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (bez(...xs, mid) < t) lo = mid; else hi = mid;
  }
  return bez(...ys, (lo + hi) / 2);
}
// CSS の cubic-bezier(x1, y1, x2, y2) の進み具合
function refCss(x1, y1, x2, y2, x) {
  let lo = 0, hi = 1;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (bez(0, x1, x2, 1, mid) < x) lo = mid; else hi = mid;
  }
  return bez(0, y1, y2, 1, (lo + hi) / 2);
}

// ---- PNG（BMP を変換。zlib は Node の組み込み） ----
function crc32(buf) {
  let crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    let c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function bmpToPng(bmpPath, pngPath) {
  const b = fs.readFileSync(bmpPath);
  const off = b.readUInt32LE(10), w = b.readInt32LE(18), h = b.readInt32LE(22);
  const row = Math.floor((w * 3 + 3) / 4) * 4;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    const src = off + (h - 1 - y) * row;
    const dst = y * (w * 3 + 1);
    raw[dst] = 0;
    for (let x = 0; x < w; x++) {
      raw[dst + 1 + x * 3] = b[src + x * 3 + 2];
      raw[dst + 2 + x * 3] = b[src + x * 3 + 1];
      raw[dst + 3 + x * 3] = b[src + x * 3];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  fs.writeFileSync(pngPath, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0))]));
}

// ---- 準備 ----
fs.cpSync(path.join(ROOT, 'src'), SRC, { recursive: true });
fs.copyFileSync(path.join(HERE, 'anim_test.um'), path.join(SRC, 'anim_test.um'));
console.log('ビルド（CPU）...');
build(EXE, {});
const WGPU = wgpuHome();
if (WGPU) {
  console.log(`ビルド（UM_WGPU=1、${WGPU}）...`);
  build(GEXE, { UM_WGPU: '1', UM_WGPU_HOME: WGPU });
} else {
  console.log('wgpu-native が見つからないので、GPU の試験は飛ばします');
}

// ---- 補間 ----
console.log('補間');
test('直線: 中間の値と速さ', () => {
  const r = evalTrack('num', '0@0 100@2', 5, 30, [-1, 0, 0.5, 1, 2, 3]);
  near(r[0].v[0], 0, 1e-12, 'キーより前');
  near(r[2].v[0], 25, 1e-9, '0.5 秒');
  near(r[3].v[0], 50, 1e-9, '1 秒');
  near(r[5].v[0], 100, 1e-12, 'キーより後');
  near(r[3].speed, 50, 1e-9, '速さ');
  near(r[5].speed, 0, 0, 'キーより後の速さ');
});
test('ホールド: 次のキーまで値を保ち、次のキーで変わる', () => {
  const r = evalTrack('num', '10@0:hold 50@1 0@2', 5, 30, [0, 0.5, 0.999, 1, 1.5]);
  near(r[1].v[0], 10, 0, '0.5 秒');
  near(r[2].v[0], 10, 0, '0.999 秒');
  near(r[3].v[0], 50, 0, '1 秒');
  near(r[4].v[0], 25, 1e-9, '1.5 秒');
  near(r[1].speed, 0, 0, 'ホールドの速さ');
});
test('ease: 対称で、両端の速さが 0、JavaScript の参照と同じ', () => {
  const ts = [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1];
  const r = evalTrack('num', '0@0:ease 100@1:ease', 5, 30, ts);
  near(r[3].v[0], 50, 1e-9, '中央');
  near(r[2].v[0] + r[4].v[0], 100, 1e-9, '対称');
  for (let i = 0; i < ts.length; i++) {
    near(r[i].v[0], refSeg(0, 0, 1, 100, 0, 1 / 3, 0, 1 / 3, ts[i]), 1e-7, `t=${ts[i]}`);
  }
  near(r[0].speed, 0, 1e-6, '始まりの速さ');
  assert(Math.abs(r[6].speed) < 1e-6 || r[6].t >= 1, '終わりの速さ');
});
test('in=/out=: 速度と影響が JavaScript の参照と同じ（影響 80%、速度 200）', () => {
  const ts = [0.2, 0.7, 1.3, 1.9];
  const r = evalTrack('num', '0@0:out=200/80 300@2:in=0/20', 5, 30, ts);
  for (let i = 0; i < ts.length; i++) {
    near(r[i].v[0], refSeg(0, 0, 2, 300, 200, 0.8, 0, 0.2, ts[i]), 1e-7, `t=${ts[i]}`);
  }
  const s0 = evalTrack('num', '0@0:out=200/80 300@2:in=0/20', 5, 30, [1e-7])[0].speed;
  near(s0, 200, 1e-3, '始まりの速さ = 書いた速度');
});
test('片側が直線、片側がイーズ（AE と同じく直線の側は平均の速さ・影響 1/3）', () => {
  const ts = [0.3, 0.9, 1.4];
  const r = evalTrack('num', '0@0 120@1.5:easein', 5, 30, ts);
  for (let i = 0; i < ts.length; i++) {
    near(r[i].v[0], refSeg(0, 0, 1.5, 120, 80, 1 / 3, 0, 1 / 3, ts[i]), 1e-7, `t=${ts[i]}`);
  }
});
test('cubic=x1,y1,x2,y2 は CSS の cubic-bezier と同じ', () => {
  const ts = [0.1, 0.25, 0.5, 0.8];
  const r = evalTrack('num', '10@0:cubic=0.42,0,0.58,1 110@1', 5, 30, ts);
  for (let i = 0; i < ts.length; i++) {
    near(r[i].v[0], 10 + 100 * refCss(0.42, 0, 0.58, 1, ts[i]), 1e-7, `t=${ts[i]}`);
  }
  const r2 = evalTrack('num', '0@0:cubic=0.68,-0.6,0.32,1.6 1@1', 5, 30, [0.15, 0.85]);
  assert(r2[0].v[0] < 0 && r2[1].v[0] > 1, `行き過ぎ（back）が出ていません: ${r2[0].v[0]} ${r2[1].v[0]}`);
});
test('smooth（自動ベジェ）: キーの前後で速さがつながり、速さは前後の平均の傾き（3·min で抑える）', () => {
  const r = evalTrack('num', '0@0 100@1:smooth 150@3', 5, 30, [0.999999, 1.000001]);
  near(r[0].speed, r[1].speed, 1e-3, '1 秒の前後の速さ');
  // 平均の傾き (150 − 0) / 3 = 50。上限 3·min(100, 25) = 75 より小さいので 50
  near(r[1].speed, 50, 1e-3, '速さ = (次 − 前) / (時刻の差)');
  const ts = [0.2, 0.5, 0.8, 1.4, 2.2, 2.9];
  const v = evalTrack('num', '0@0 100@1:smooth 150@3', 5, 30, ts);
  for (let i = 0; i < ts.length; i++) {
    const want = ts[i] < 1 ? refSeg(0, 0, 1, 100, 100, 1 / 3, 50, 1 / 3, ts[i]) : refSeg(1, 100, 3, 150, 50, 1 / 3, 25, 1 / 3, ts[i]);
    near(v[i].v[0], want, 1e-7, `t=${ts[i]}`);
  }
  // 平均の傾きが上限を超える: 0@0 100@1:smooth 102@2（傾き 100 と 2。平均 51、上限 6）
  const c = evalTrack('num', '0@0 100@1:smooth 102@2', 5, 30, [1.000001]);
  near(c[0].speed, 6, 1e-3, '上限 3·min(|前の傾き|, |次の傾き|)');
});
test('smooth: 山と谷のキーでは速度 0 で、行き過ぎない（単調）', () => {
  const N = 201;
  const ts = Array.from({ length: N }, (_, i) => (2 * i) / (N - 1));
  const r = evalTrack('num', '0@0 100@1:smooth 50@2', 5, 30, ts);
  const mx = Math.max(...r.map((x) => x.v[0]));
  assert(mx <= 100 + 1e-9, `山のキー 100 を超えました: ${mx}`);
  const k = evalTrack('num', '0@0 100@1:smooth 50@2', 5, 30, [1.000001])[0];
  near(k.speed, 0, 1e-3, '山のキーの速さ');
  near(r[110].v[0], refSeg(1, 100, 2, 50, 0, 1 / 3, -50, 1 / 3, ts[110]), 1e-7, '1.1 秒（参照）');
  // 谷と、止まる区間の隣
  const lo = evalTrack('num', '50@0 0@1:smooth 80@2 80@3:smooth 10@4', 5, 30, ts.map((t) => t * 2));
  const mn = Math.min(...lo.map((x) => x.v[0]));
  assert(mn >= -1e-9, `谷のキー 0 を下回りました: ${mn}`);
  const hi = Math.max(...lo.map((x) => x.v[0]));
  assert(hi <= 80 + 1e-9, `止まる区間の値 80 を超えました: ${hi}`);
});
test('同じ値のキーのあいだでも速度で行き過ぎる（オーバーシュート）', () => {
  const r = evalTrack('num', '0@0:out=900/40 300@1:in=-600/60 300@2', 5, 30, [0.6, 1.5]);
  assert(r[0].v[0] > 300, `0.6 秒の値 ${r[0].v[0]} が 300 を超えていません`);
  near(r[1].v[0], 300, 1e-9, '1.5 秒');
});
test('時刻の書き方: end、end-0.5、コマ（f）、分:秒', () => {
  const a = evalTrack('num', '0@0 100@end', 4, 30, [2]);
  near(a[0].v[0], 50, 1e-9, 'end');
  const b = evalTrack('num', '0@0 100@end-1', 4, 30, [1.5]);
  near(b[0].v[0], 50, 1e-9, 'end-1');
  const c = evalTrack('num', '0@0 100@30f', 4, 30, [0.5]);
  near(c[0].v[0], 50, 1e-9, '30f');
  const d = evalTrack('num', '0@0 100@1:00', 90, 30, [30]);
  near(d[0].v[0], 50, 1e-9, '1:00');
  const e = evalTrack('num', '0@-1 100@1', 4, 30, [0]);
  near(e[0].v[0], 50, 1e-9, '負の時刻（クリップの前のキー）');
});
test('2 次元（直線の経路）と色と角度', () => {
  const r = evalTrack('vec2', '0,0@0 300,400@1', 5, 30, [0.5]);
  near(r[0].v[0], 150, 1e-9, 'x');
  near(r[0].v[1], 200, 1e-9, 'y');
  near(r[0].speed, 500, 1e-9, '経路に沿った速さ');
  near(r[0].vel[0], 300, 1e-9, '速度 x');
  const c = evalTrack('color', 'ff0000@0 0000ff80@1', 5, 30, [0.5]);
  near(c[0].v[0], 0.5, 1e-9, '赤');
  near(c[0].v[2], 0.5, 1e-9, '青');
  near(c[0].v[3], (1 + 128 / 255) / 2, 1e-9, 'アルファ');
  const g = evalTrack('angle', '0@0 720@2', 5, 30, [1, 1.5]);
  near(g[0].v[0], 360, 1e-9, '角度は回る（720 は 2 回転）');
  near(g[1].v[0], 540, 1e-9, '1.5 秒');
});
test('空間のベジェ（tout / tin）: 点が経路の上にあり、直線の時間なら一定の速さ', () => {
  // 経路: (0,0) → (600,0)、出の接線 (0,300)、入りの接線 (0,300)（S 字）
  const text = '0,0@0:tout=0,300 600,0@2:tin=0,300';
  const N = 41;
  const ts = Array.from({ length: N }, (_, i) => (2 * i) / (N - 1));
  const r = evalTrack('vec2', text, 5, 30, ts);
  // 経路の上か: 細かく刻んだ曲線の点までの距離
  const pts = [];
  for (let i = 0; i <= 4000; i++) {
    const u = i / 4000;
    pts.push([bez(0, 0, 600, 600, u), bez(0, 300, 300, 0, u)]);
  }
  let worst = 0;
  for (const s of r) {
    let best = Infinity;
    for (const p of pts) best = Math.min(best, Math.hypot(p[0] - s.v[0], p[1] - s.v[1]));
    worst = Math.max(worst, best);
  }
  assert(worst < 0.2, `経路から ${worst} 画素離れています`);
  // 一定の速さ（コマごとの移動量が同じ）
  const steps = [];
  for (let i = 1; i < N; i++) steps.push(Math.hypot(r[i].v[0] - r[i - 1].v[0], r[i].v[1] - r[i - 1].v[1]));
  const mx = Math.max(...steps), mn = Math.min(...steps);
  assert((mx - mn) / mx < 0.01, `移動量がそろっていません（${mn}〜${mx}）`);
  // 経路の長さ ÷ 2 秒 = 速さ
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  near(r[10].speed, L / 2, L * 1e-4, '速さ');
});
test('curve（自動の空間のベジェ）: 中のキーで経路が折れない', () => {
  const r = evalTrack('vec2', '0,0@0 300,300@1:curve 600,0@2', 5, 30, [0.999, 1.001]);
  const a1 = Math.atan2(r[0].vel[1], r[0].vel[0]);
  const a2 = Math.atan2(r[1].vel[1], r[1].vel[0]);
  near(a1, a2, 0.05, '向き（ラジアン）');
  const s = evalTrack('vec2', '0,0@0 300,300@1 600,0@2', 5, 30, [0.999, 1.001]);
  const b1 = Math.atan2(s[0].vel[1], s[0].vel[0]);
  const b2 = Math.atan2(s[1].vel[1], s[1].vel[0]);
  assert(Math.abs(b1 - b2) > 1, 'curve を付けないと折れるはず');
});

// ---- 診断 ----
console.log('診断');
test('anim-key-overlap（列はあとのキー）', () => {
  const d = diags('num', '0@0 5@1 7@30f');
  assert(d.length === 1 && d[0].code === 'anim-key-overlap' && d[0].col === 9, JSON.stringify(d));
});
test('anim-bad-value（型の誤り）と列', () => {
  const d = diags('num', '0@0 640,360@1');
  assert(d[0].code === 'anim-bad-value' && d[0].col === 5, JSON.stringify(d));
  assert(d[0].msg.includes('2 次元の値ですが'), d[0].msg);
  const e = diags('vec2', '0,0@0 red@1');
  assert(e[0].code === 'anim-bad-value' && e[0].col === 7, JSON.stringify(e));
  const f = diags('color', '00ff00@0 1.5@1');
  assert(f[0].code === 'anim-bad-value', JSON.stringify(f));
});
test('anim-bad-time / anim-syntax / anim-bad-interp（候補つき）', () => {
  const d = diags('num', '1@ 2@x 3 4@4:eas');
  const codes = d.map((x) => `${x.code}@${x.col}`);
  assert(codes.join(' ') === 'anim-bad-time@3 anim-bad-time@6 anim-syntax@8 anim-bad-interp@14', codes.join(' '));
  assert(d[3].suggest === 'ease', `suggest: ${d[3].suggest}`);
});
test('anim-bad-ease / anim-spatial-not-allowed / anim-bad-tangent', () => {
  assert(diags('num', '0@0:ease=0 1@1')[0].code === 'anim-bad-ease', 'ease=0');
  assert(diags('num', '0@0:in=5 1@1')[0].code === 'anim-bad-ease', 'in=5');
  assert(diags('num', '0@0:cubic=1.2,0,0.5,1 1@1')[0].code === 'anim-bad-ease', 'cubic の x1 が範囲外');
  assert(diags('num', '0@0:curve 1@1')[0].code === 'anim-spatial-not-allowed', 'curve');
  assert(diags('vec2', '0,0@0:tout=5 1,1@1')[0].code === 'anim-bad-tangent', 'tout=5');
  assert(diags('num', '0@0 1@1:in=hold')[0].code === 'anim-bad-interp', 'in=hold');
});
test('警告: anim-key-order と anim-key-outside（誤りには数えない）', () => {
  // 9@7 はクリップ（5 秒）のすぐ外で補間に使うので警告しない。その外の 1@8 だけを知らせる
  const d = diags('num', '5@2 0@0 9@7 1@8', 5);
  const codes = d.map((x) => `${x.code}/${x.severity}`).sort();
  assert(codes.join(' ') === 'anim-key-order/warning anim-key-outside/warning', codes.join(' '));
  const ok = run(['diag', 'num', '5@2 0@0 9@7 1@8', '5', '30']);
  const near = diags('num', '0@-1 5@2 9@7', 5);
  assert(near.length === 0, `すぐ外のキーは警告しない: ${near.map((x) => x.code).join(' ')}`);
  assert(ok.includes('OK'), '警告だけなら ok');
});
test('時刻を求められない: end（長さ不明）、コマ（fps 不明）', () => {
  const d = diags('num', '0@end-1 1@1', -1);
  assert(d.length === 1 && d[0].code === 'anim-bad-time', JSON.stringify(d));
  const e = diags('num', '0@0 1@45f', 5, 0);
  assert(e.length === 1 && e[0].code === 'anim-bad-time', JSON.stringify(e));
});

// ---- 書き戻し・説明・JSON・1 キー 1 行 ----
console.log('書き方');
test('書き戻すと書いたままの文字になる（行の差分が出ない）', () => {
  const text = '160,560@0:easeout 520,140@1:curve:ease=60 980,520@2:smooth 1500,200@3:tout=200,-120 1760,560@1:02.5f';
  const out = run(['info', 'vec2', text.replace('@1:02.5f', '@4'), '4', '30']).trim().split(/\r?\n/);
  assert(out[2] === text.replace('@1:02.5f', '@4'), out[2]);
  const j = JSON.parse(out[1]);
  assert(j.type === 'vec2' && j.keys.length === 5 && j.keys[1].path === 'curve' && j.keys[3].tout[0] === 200, out[1]);
  assert(out[0].includes('経路は曲線') && out[0].includes('自動ベジェ'), out[0]);
});

// ---- 操作 ----
console.log('操作');
test('key add: ふつうの値を 0 秒のキーにしてから足す', () => {
  const r = op('add', 'num', '100', ['2', '300', 'ease']);
  assert(r.ok && r.text === '100@0 300@2:ease' && !('kv' in r), JSON.stringify(r));
});
test('key add: 同じ時刻なら値を変え、ほかのキーの文字は変えない', () => {
  const r = op('add', 'num', '0@0 120@1.5:ease 300@3:hold', ['45f', '150']);
  assert(r.ok && r.text === '0@0 150@1.5:ease 300@3:hold', JSON.stringify(r));
  const s = op('add', 'num', '0@0 300@3', ['end-0.5', '50', 'easein']);
  assert(s.ok && s.text === '0@0 300@3 50@end-0.5:easein', JSON.stringify(s));
  const t = op('add', 'num', '0@0 300@3', ['1', '50']);
  assert(t.ok && t.text === '0@0 50@1 300@3', JSON.stringify(t));
});
test('key add: 値の型の誤りは断る', () => {
  const r = op('add', 'vec2', '0,0@0', ['1', '5']);
  assert(!r.ok && r.code === 'anim-bad-value', JSON.stringify(r));
});
test('key remove: #番号と時刻、最後の 1 つでふつうの値に戻る', () => {
  const r = op('remove', 'num', '0@0 120@1.5:ease 300@3', ['#1']);
  assert(r.ok && r.text === '0@0 300@3', JSON.stringify(r));
  const s = op('remove', 'num', '7@2', ['2']);
  assert(s.ok && !s.animated && s.text === '7', JSON.stringify(s));
  const t = op('remove', 'num', '0@0 1@1', ['0.5']);
  assert(!t.ok && t.code === 'anim-no-key' && t.hint.includes('#1=1 秒'), JSON.stringify(t));
  const u = op('remove', 'num', '5', ['0']);
  assert(!u.ok && u.code === 'anim-not-animated', JSON.stringify(u));
});
test('key move: 並べ替え、重なりは断る', () => {
  const r = op('move', 'num', '0@0 120@1.5:ease 300@3', ['1.5', '4']);
  assert(r.ok && r.text === '0@0 300@3 120@4:ease', JSON.stringify(r));
  const s = op('move', 'num', '0@0 120@1.5 300@3', ['1.5', '3']);
  assert(!s.ok && s.code === 'anim-key-overlap', JSON.stringify(s));
});
test('key set / key ease / key shift / key clear', () => {
  const a = op('set', 'vec2', '0,0@0 10,10@1', ['1', '640,360']);
  assert(a.ok && a.text === '0,0@0 640,360@1', JSON.stringify(a));
  const b = op('ease', 'num', '0@0 120@1.5:hold 300@3', ['*', 'ease=60']);
  assert(b.ok && b.text === '0@0:ease=60 120@1.5:ease=60 300@3:ease=60', JSON.stringify(b));
  const c = op('ease', 'vec2', '0,0@0 100,0@1:ease 100,100@2', ['1', 'curve']);
  assert(c.ok && c.text === '0,0@0 100,0@1:ease:curve 100,100@2', JSON.stringify(c));
  const d = op('ease', 'num', '0@0 1@1', ['1', 'in=0/75', 'out=200/33']);
  // 速度 0 の in は easein=75 と書き直す（同じ意味で短い形）
  assert(d.ok && d.text === '0@0 1@1:easein=75:out=200/33', JSON.stringify(d));
  const e = op('shift', 'num', '0@0 120@1.5 300@60f 1@end-0.5', ['0.25']);
  assert(e.ok && e.text === '0@0.25 120@1.75 300@67.5f 1@end-0.25', JSON.stringify(e));
  const f = op('clear', 'num', '0@0 120@1.5', ['0.75']);
  assert(f.ok && !f.animated && f.text === '60', JSON.stringify(f));
  const g = op('ease', 'num', '0@0 1@1', ['1', 'ease=0']);
  assert(!g.ok && g.code === 'anim-bad-ease', JSON.stringify(g));
});

// ---- 指摘の直し: 位置・split / trim・印の側・影響の和・誤りの残った列・効かない印・範囲・有限でない値 ----
console.log('位置・分割・範囲');
test('位置（x / y）: 左上からの画素。負の値も 0 をまたいでも連続、center は書けない', () => {
  const r = evalTrack('pos', '-400@0 100@1', 5, 30, [0, 0.79, 0.8, 0.81, 1]);
  near(r[0].v[0], -400, 0, '0 秒');
  near(r[2].v[0], 0, 1e-9, '0.8 秒で 0');
  near(r[3].v[0] - r[1].v[0], 10, 1e-9, '0 をまたいでも同じ速さ');
  const d = diags('pos', 'center@0 100@1');
  assert(d.length === 1 && d[0].code === 'anim-bad-value' && d[0].msg.includes('center'), JSON.stringify(d));
});
test('位置の key add: center や右端からの値は黙って捨てず、断るか画素に直す', () => {
  const a = op('add', 'pos', 'center', ['1.5', '120']);
  assert(!a.ok && a.code === 'anim-bad-value' && a.error.includes('center'), JSON.stringify(a));
  const b = op('add', 'pos', '-50', ['1', '100']);
  assert(!b.ok && b.code === 'anim-bad-value', JSON.stringify(b));
  const c = op('add', 'pos', 'center', ['0', '-400']);
  assert(c.ok && c.text === '-400@0', JSON.stringify(c));
  // 画面 1280、クリップの幅 200: center → 540、-50（右端から 50）→ 1030
  const e = op('addpos', 'pos', 'center', ['1', '100', '200', '1280']);
  assert(e.ok && e.text === '540@0 100@1', JSON.stringify(e));
  const f = op('addpos', 'pos', '-50', ['1', '100', '200', '1280']);
  assert(f.ok && f.text === '1030@0 100@1', JSON.stringify(f));
  // 負の位置で clear / 最後のキーの remove をしても、右端からの意味にならない（キー 1 つで残す）
  const g = op('clear', 'pos', '-400@0 100@1', ['0']);
  assert(g.ok && g.animated && g.text === '-400@0', JSON.stringify(g));
  const h = op('remove', 'pos', '-400@0', ['0']);
  assert(h.ok && h.animated && h.text === '-400@0', JSON.stringify(h));
  const k = op('clear', 'pos', '-400@0 100@1', ['1']);
  assert(k.ok && !k.animated && k.text === '100', JSON.stringify(k));
});

function rebase(type, cur, cut, oldDur, newDur, side, fps = 30) {
  return JSON.parse(run(['rebase', type, cur, String(cut), String(oldDur), String(newDur), side, String(fps)]));
}
// split の前後で、タイムラインの同じ時刻の値が同じか（固定した速度・接線は 4 桁の小数で書くので、その分だけの差を許す）
const SPLIT_TOL = 1e-4;
function checkSplit(type, text, dur, at, fps = 30) {
  const head = rebase(type, text, 0, dur, at, 'head', fps);
  const tail = rebase(type, text, at, dur, dur - at, 'tail', fps);
  assert(head.ok && tail.ok, JSON.stringify([head, tail]));
  const N = 61;
  const tsH = Array.from({ length: N }, (_, i) => (at * i) / (N - 1));
  const tsT = Array.from({ length: N }, (_, i) => ((dur - at) * i) / (N - 1));
  const o1 = evalTrack(type, text, dur, fps, tsH);
  const h = evalTrack(type, head.text, at, fps, tsH);
  const o2 = evalTrack(type, text, dur, fps, tsT.map((t) => t + at));
  const t = evalTrack(type, tail.text, dur - at, fps, tsT);
  for (let i = 0; i < N; i++) {
    for (let c = 0; c < 4; c++) {
      near(h[i].v[c], o1[i].v[c], SPLIT_TOL, `前半 t=${tsH[i]} 成分 ${c}（${head.text}）`);
      near(t[i].v[c], o2[i].v[c], SPLIT_TOL, `後ろ半分 t=${tsT[i]} 成分 ${c}（${tail.text}）`);
    }
  }
  return [head.text, tail.text];
}
test('split: end からのキーは後ろ半分でそのまま、前半では始まりからに直し、見え方が変わらない', () => {
  const [h, t] = checkSplit('num', '0@0 1@0.5 1@end-0.5 0@end', 5, 2);
  assert(h === '0@0 1@0.5 1@4.5', `前半: ${h}`);
  assert(t === '1@-1.5 1@end-0.5 0@end', `後ろ半分: ${t}`);
  // 指摘の例: 後ろ半分（1 秒で分けた）でも end からのキーは動かない
  const r = rebase('num', '1@end-0.5 0@end', 1, 5, 4, 'tail');
  assert(r.ok && r.text === '1@end-0.5 0@end', JSON.stringify(r));
});
test('split: smooth・ease・hold・コマ・2 次元の curve でも、分けた前後の値が同じ', () => {
  checkSplit('num', '0@0 100@1:smooth 50@2:smooth 80@75f:ease 20@4:hold 60@end-0.25 0@end', 5, 2.3);
  checkSplit('num', '0@0 100@1:smooth 50@2:smooth 80@75f:ease 20@4:hold 60@end-0.25 0@end', 5, 0.4);
  checkSplit('vec2', '0,0@0 300,300@1:curve 600,0@2:curve:smooth 900,300@3:curve 1200,0@4', 4, 1.7);
  checkSplit('vec2', '0,0@0 300,300@1:curve 600,0@2:curve:smooth 900,300@3:curve 1200,0@4', 4, 2.0);
  checkSplit('color', 'ff0000@0 00ff00@1:ease 0000ff@end', 3, 1.25);
  const r = rebase('num', '0@0 100@60f 5@90f', 1, 3, 2, 'tail');
  assert(r.ok && r.text === '0@-1 100@30f 5@60f', JSON.stringify(r));
});
test('trim start / trim end: 外に出たキーは補間に要る 1 つだけ残す', () => {
  const a = rebase('num', '0@0 10@1 20@2 30@3 40@4', 2.5, 5, 2.5, 'tail');
  assert(a.ok && a.text === '20@-0.5 30@0.5 40@1.5', JSON.stringify(a));
  const b = rebase('num', '0@0 10@1 20@2 30@3 40@4', 0, 5, 1.5, 'head');
  assert(b.ok && b.text === '0@0 10@1 20@2', JSON.stringify(b));
});
test('key ease: 印が触る側だけを置き換える（hold で入り側のイーズを残す）', () => {
  const a = op('ease', 'num', '0@0 50@1:ease 0@2', ['#1', 'hold']);
  assert(a.ok && a.text === '0@0 50@1:easein:hold 0@2', JSON.stringify(a));
  const b = op('ease', 'num', '0@0 50@1:easeout=60 0@2', ['1', 'easein']);
  assert(b.ok && b.text === '0@0 50@1:easein:easeout=60 0@2', JSON.stringify(b));
  const c = op('ease', 'num', '0@0 50@1:in=0/50:cubic=0.4,0,0.6,1 0@2', ['1', 'out=0/80']);
  assert(c.ok && c.text === '0@0 50@1:easein=50:easeout=80 0@2', JSON.stringify(c));
  const e = op('ease', 'num', '0@0 50@1:hold 0@2', ['1', 'ease']);
  assert(e.ok && e.text === '0@0 50@1:ease 0@2', JSON.stringify(e));
});
test('影響の和が 100% を超えたら同じ比で縮める（速さが跳ねない）', () => {
  const N = 101;
  const ts = Array.from({ length: N }, (_, i) => i / (N - 1));
  const r = evalTrack('num', '0@0:out=0/90 100@1:in=0/90', 5, 30, ts);
  for (let i = 0; i < N; i += 10) near(r[i].v[0], refSeg(0, 0, 1, 100, 0, 0.5, 0, 0.5, ts[i]), 1e-7, `t=${ts[i]}`);
  const mx = Math.max(...r.map((x) => x.speed));
  assert(mx <= 200 + 1e-6, `速さの最大 ${mx} が 200（平均の 2 倍）を超えます`);
});
test('誤りの残った列は補わず、最初のキーの値を返す', () => {
  const out = run(['eval', 'num', '7@0 5@1 9@30f', '5', '30', '0,0.5,2']).trim().split(/\r?\n/).filter((l) => !l.startsWith('ERR'));
  for (const l of out) near(Number(l.split(' ')[1]), 7, 0, l);
});
test('効かない印は anim-tag-unused（警告）', () => {
  const d = diags('num', '0@0:easein 1@1:hold');
  assert(d.length === 2 && d.every((x) => x.code === 'anim-tag-unused' && x.severity === 'warning'), JSON.stringify(d));
  assert(d[0].col === 1 && d[1].col === 12, JSON.stringify(d));
  const e = diags('vec2', '0,0@0:curve 1,1@1 2,0@2:curve');
  assert(e.length === 2 && e[0].msg.includes('curve'), JSON.stringify(e));
  assert(diags('num', '0@0:ease 1@1:ease').length === 0, 'ease は両側なので警告しない');
  assert(diags('num', '0@0:cubic=0.4,0,0.6,1 1@1:cubic=0.4,0,0.6,1')[0].code === 'anim-tag-unused', '最後のキーの cubic');
  assert(diags('num', '5@1:ease')[0].code === 'anim-tag-unused', 'キーが 1 つ');
});
test('キーの値の範囲（out-of-range）と、アニメーションできるキーの許可の表', () => {
  const out = run(['range', 'num', '0@0 1.5@1 1@2', '0', '1']).trim().split(/\r?\n/);
  assert(out[0].startsWith('out-of-range error 5|'), out[0]);
  assert(out.length === 3 && out[1] === 'allow 11 0', out.join(' / '));
  const ok = run(['range', 'num', '0@0:out=900/50 1@1', '0', '1']).trim().split(/\r?\n/);
  assert(ok.length === 2, '補間で外に出るのは誤りにしない（描くときに丸める）');
  // 許可の表の全部のキーに型がある。types: x=位置(4)、src と dur はアニメーションできない(-1)、opacity=数(0)、pos=2 次元(1)
  assert(ok[0] === 'allow 11 0', ok[0]);
  assert(ok[1] === 'types 4 -1 -1 0 1', ok[1]);
});
test('有限でない値・時刻・速度・接線は誤り', () => {
  assert(diags('num', '1e400@0 1@1')[0].code === 'anim-bad-value', '値');
  assert(diags('num', '0@1e400 1@1')[0].code === 'anim-bad-time', '時刻');
  assert(diags('num', '0@1e300 1@1')[0].code === 'anim-bad-time', '大きすぎる時刻');
  assert(diags('num', '0@0:out=1e400/50 1@1')[0].code === 'anim-bad-ease', '速度');
  assert(diags('vec2', '0,0@0:tout=1e400,0 1,1@1')[0].code === 'anim-bad-tangent', '接線');
  assert(diags('num', '0@0:cubic=0.4,1e400,0.6,1 1@1')[0].code === 'anim-bad-ease', 'cubic');
});

// ---- グラフ・取っ手・再マップ ----
console.log('グラフと再マップ');
test('グラフのデータ（JSON）と取っ手 → 速度・影響の往復', () => {
  const g = JSON.parse(run(['graph', 'num', '0@0:out=200/50 300@2:in=40/25', '0', '2', '21']).trim());
  assert(g.type === 'number' && g.samples.length === 21 && g.keys.length === 2, '形');
  near(g.keys[0].out.speed, 200, 1e-9, '出の速度');
  near(g.keys[0].out.influence, 50, 1e-9, '出の影響');
  near(g.keys[1].in.speed, 40, 1e-9, '入りの速度');
  near(g.keys[1].in.influence, 25, 1e-9, '入りの影響');
  const [ht, hv] = g.keys[0].handleOut;
  const back = run(['handle', '1', '0', '0', String(ht), String(hv), '2']).trim().split(' ').map(Number);
  near(back[0], 200, 1e-6, '取っ手から速度');
  near(back[1], 50, 1e-6, '取っ手から影響');
  const [it, iv] = g.keys[1].handleIn;
  const back2 = run(['handle', '0', '2', '300', String(it), String(iv), '2']).trim().split(' ').map(Number);
  near(back2[0], 40, 1e-6, '入りの取っ手から速度');
  near(back2[1], 25, 1e-6, '入りの取っ手から影響');
});
test('時刻の再マップ: 静止・逆再生・フレームブレンドの組・素材の外の診断', () => {
  const lines = run(['remap', '0@0 2@1:ease 2@3 0@4', '4', '30', '10']).trim().split(/\r?\n/);
  assert(!lines.some((l) => l.startsWith('D ')), '診断がないこと');
  const rows = lines.filter((l) => !l.startsWith('D ') && l.includes(' ')).map((l) => l.split(' ').map(Number));
  near(rows[2][1], 2, 1e-12, '1 秒で素材の 2 秒');
  near(rows[4][2], 0, 1e-12, '静止の速さ 0');
  assert(rows[7][2] < 0, '逆再生の速さは負');
  const half = rows.find((r) => r[0] === 3.5);
  assert(half[3] === 30 && half[4] === 30, `3.5 秒は素材の 30 コマ: ${half}`);
  const mid = rows[1];
  assert(mid[4] === mid[3] + 1 && mid[5] > 0 && mid[5] < 1, `0.5 秒はコマのあいだ: ${mid}`);
  assert(lines[lines.length - 1] === '1.5@0 9.5@end', lines[lines.length - 1]);
  const bad = run(['remap', '0@0 12@4', '4', '30', '10']);
  assert(bad.includes('D anim-remap-range 11'), bad);
});

// ---- kernel ----
console.log('kernel');
test('評価の kernel（f32）とホストの評価（f64）の差', () => {
  const cases = [
    ['vec2', '160,560@0:easeout 520,140@1:curve:ease=60 980,520@2:smooth 1500,200@3:tout=200,-120 1760,560@4:easein', '4', 0.1],
    ['vec2', '0,0@0:tout=0,300 600,0@2:tin=0,300', '2', 0.1],
    ['num', '0@0 120@1.5:ease 300@3:hold 80@4:in=0/80 220@5', '5', 1e-3],
    ['num', '0@0:out=900/40 300@1:in=-600/60 300@2', '2', 1e-3],
    ['color', 'ff3030@0 30d050@1:ease 3060ffff@2 ffffff00@3', '3', 1e-5],
    ['num', '5@1', '2', 0],
  ];
  for (const [ty, text, dur, tol] of cases) {
    const [d] = run(['kcmp', ty, text, dur, '30', '20001']).trim().split(' ').map(Number);
    assert(d <= tol, `${ty} ${text}: 差 ${d} が ${tol} を超えます`);
    if (VERBOSE) console.log(`      ${ty}: 差の最大 ${d}`);
  }
});

const NAMES = ['graph_x', 'graph_color', 'graph_overshoot', 'graph_pos', 'path', 'path_view', 'sample_pos', 'blend', 'blend2'];
fs.mkdirSync(OUT, { recursive: true });
const cpuDir = path.join(TMP, 'dump-cpu');
fs.mkdirSync(cpuDir);
test('kernel の絵を書く（PNG）', () => {
  run(['dump', cpuDir]);
  for (const f of fs.readdirSync(cpuDir).filter((x) => x.endsWith('.bmp'))) {
    bmpToPng(path.join(cpuDir, f), path.join(OUT, f.replace(/\.bmp$/, '.png')));
  }
  // 絵が空でないこと（曲線の色の画素がある）
  const raw = new Uint32Array(fs.readFileSync(path.join(cpuDir, 'graph_x.raw')).buffer.slice(0));
  let red = 0;
  for (const c of raw) if (((c >> 16) & 255) > 200 && ((c >> 8) & 255) < 140) red++;
  assert(red > 500, `値の曲線の画素が少なすぎます（${red}）`);
});
test('経路の絵: 表示の倍率とずらし（view）でキーの四角がずれない', () => {
  // 最初のキー (160, 560) は、倍率 0.5、ずらし (40, 20) で絵の (120, 300) に来る
  const raw = new Uint32Array(fs.readFileSync(path.join(cpuDir, 'path_view.raw')).buffer.slice(0));
  const at = (x, y) => raw[y * 1000 + x] >>> 0;
  assert(at(120, 300) === 0xfffacc47, `(120,300) がキーの色でありません: ${at(120, 300).toString(16)}`);
  // 最後のキー (1760, 560) → (920, 300)
  assert(at(920, 300) === 0xfffacc47, `(920,300) がキーの色でありません: ${at(920, 300).toString(16)}`);
  // 等倍の位置（160, 560）は絵の外なので、(160, 300) はキーの色でない
  assert(at(160, 300) !== 0xfffacc47, '等倍の位置に描いています');
});
if (WGPU) {
  test('CPU（UM_GPU=0）と GPU（UM_GPU_THRESHOLD=1）でビットまで同じ', () => {
    const c = path.join(TMP, 'dump-wgpu-cpu');
    const g = path.join(TMP, 'dump-wgpu-gpu');
    fs.mkdirSync(c);
    fs.mkdirSync(g);
    run(['dump', c], GEXE, { UM_GPU: '0' });
    const r = spawnSync(GEXE, ['dump', g], { encoding: 'utf8', maxBuffer: 1 << 26, env: { ...process.env, UM_GPU_THRESHOLD: '1', UM_GPU_TRACE: '1' } });
    assert(r.status === 0, r.stderr);
    assert(/dispatch/.test(r.stderr), 'GPU で dispatch していません');
    for (const n of NAMES) {
      const a = fs.readFileSync(path.join(c, n + '.raw'));
      const b = fs.readFileSync(path.join(g, n + '.raw'));
      const p = fs.readFileSync(path.join(cpuDir, n + '.raw'));
      assert(a.equals(b), `${n}: CPU と GPU で違います`);
      assert(a.equals(p), `${n}: UM_WGPU=1 の CPU と、ふつうのビルドで違います`);
    }
  });
}

if (BENCH) {
  console.log(`速さ（1080p、${benchReps} 回の中央の値、ミリ秒）`);
  const show = (label, out) => console.log(`  ${label}: ${out.trim().split(/\r?\n/).join('  ')}`);
  show('CPU          ', run(['bench', benchReps]));
  if (WGPU) {
    show('GPU（強制）  ', run(['bench', benchReps], GEXE, { UM_GPU_THRESHOLD: '1' }));
    show('自動         ', run(['bench', benchReps], GEXE, {}));
  }
}

console.log(`\n${passed} 件 通過、${failures.length} 件 失敗`);
console.log(`絵: ${OUT}${outArg || KEEP ? '' : '（--keep か --out で残す）'}`);
if (KEEP) console.log(`作業用のフォルダ: ${TMP}`);
cleanup();
process.exit(failures.length ? 1 : 0);
