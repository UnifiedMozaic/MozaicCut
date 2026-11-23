#!/usr/bin/env node
// モーショントラッキング（src/effects/track/）のテスト。node tests/m6-track/run.mjs で実行する（npm の依存なし）。
//
// 1. src/ の .um を丸ごと（src/engine/text.um・src/effects/track/*.um を含む）と tests/m6-track/track_tool.um を一時フォルダに写してネイティブでビルドする
//    （UM の import は最初のファイルのフォルダの中しか読めないため、src/main.um から見たときと同じ並びに置く）。
// 2. ffmpeg で、動きの分かっている「動く模様」の映像を作る（模様は ffmpeg の noise + gblur + testsrc2）:
//      move   平行移動（4 倍の大きさで切り出す位置を動かし、1/4 に縮める。動きは 0.25 画素の刻みで分かっている）
//      sim    回転・拡大・平行移動（2 倍の大きさで perspective フィルタ、1/2 に縮める）
//      plane  平面の傾き（perspective で四隅を別々に動かす = 射影変換）
//      hide   move の途中の 5 コマで点を灰色の箱で隠す（見失うことと、見つけ直すこと）
//      shake  手ぶれ（小さな回転・拡大・平行移動がでたらめに揺れる）
//      slow   1 画素/コマの斜めのパン（左上へ。画面の外へ出る点・等速のパンの手ぶれ補正）
//      fast   20 画素/コマの横のパン（480x270。探す範囲より速い動き）
//      hd     1920x1080（速さを測る）
// 3. track_tool で追い、分かっている動きと比べる。手ぶれ補正は、補正した映像をもう一度追って、点が止まっていることを確かめる。
// 4. wgpu-native が見つかれば（UM_WGPU_HOME か ~/wgpu-native/<版>）、UM_WGPU=1 でもビルドし、
//    UM_GPU=0（CPU）と UM_GPU_THRESHOLD=1（kernel をすべて GPU）の結果（.trk・補正した Y4M・重ねた絵）がバイトまで同じことを確かめる。
//
// オプション:
//   --out <dir>   確かめるための絵（PNG）と .trk をここに残す（既定は一時フォルダの out/）
//   --keep        作業用のフォルダを消さずに残す
//   --no-gpu      GPU の比較を飛ばす
//   -v            詳しく出す
//
// UnifiedMozaic は環境変数 UM_HOME か、このリポジトリの隣（../UnifiedMozaic）から探す。ffmpeg は PATH か FFMPEG。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const argv = process.argv.slice(2);
const KEEP = argv.includes('--keep');
const VERBOSE = argv.includes('-v');
const NO_GPU = argv.includes('--no-gpu');
const outArg = argv.includes('--out') ? argv[argv.indexOf('--out') + 1] : undefined;
const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const EXT = process.platform === 'win32' ? '.exe' : '';

function umHome() {
  const cands = [process.env.UM_HOME, path.join(ROOT, '..', 'UnifiedMozaic'), path.join(os.homedir(), 'UnifiedMozaic')].filter(Boolean);
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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mozcut-track-'));
const OUT = outArg ? path.resolve(outArg) : path.join(TMP, 'out');
fs.mkdirSync(OUT, { recursive: true });
const VID = path.join(TMP, 'v');
fs.mkdirSync(VID);

let passed = 0;
const failures = [];
function cleanup() {
  if (!KEEP) fs.rmSync(TMP, { recursive: true, force: true });
}

class Fail extends Error {}
function check(cond, msg) {
  if (!cond) throw new Fail(msg);
}
function test(name, fn) {
  try {
    const note = fn();
    passed++;
    console.log(`  ok  ${name}${note ? `  (${note})` : ''}`);
  } catch (e) {
    const msg = e instanceof Fail ? e.message : (e.stack || String(e));
    failures.push({ name, msg });
    console.log(`  NG  ${name}`);
    for (const l of msg.split('\n')) console.log(`        ${l}`);
  }
}

function sh(cmd, args, env) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 1 << 28, env: { ...process.env, ...(env || {}) } });
  if (r.error) throw new Error(`${cmd} を起動できません: ${r.error.message}`);
  return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
}

// ---- ビルド ----

function build(dir, gpuHome) {
  fs.cpSync(path.join(ROOT, 'src'), dir, { recursive: true, filter: (f) => fs.statSync(f).isDirectory() || f.endsWith('.um') });
  fs.copyFileSync(path.join(HERE, 'track_tool.um'), path.join(dir, 'track_tool.um'));
  const exe = path.join(dir, 'track_tool' + EXT);
  const env = gpuHome ? { UM_WGPU: '1', UM_WGPU_HOME: gpuHome } : {};
  const r = sh(process.execPath, [path.join(umHome(), 'src', 'cli.ts'), 'build', path.join(dir, 'track_tool.um'), '--target', 'host', '-o', exe], env);
  if (r.code !== 0) {
    process.stdout.write(r.out);
    process.stderr.write(r.err);
    throw new Error('ビルドに失敗しました');
  }
  return exe;
}

let EXE;
let EXE_GPU;
// CPU だけのビルドは、wgpu なしのビルドで実行する（MozaicCut の既定のビルドと同じ）
const CPU_ENV = {};

function tool(args, env) {
  const r = sh(EXE, args, env || CPU_ENV);
  if (r.code !== 0) throw new Fail(`track_tool ${args.join(' ')} が終了コード ${r.code}:\n${r.out}${r.err}`);
  if (VERBOSE) process.stdout.write(r.out + r.err);
  return r;
}

// ---- 映像を作る ----

const W1 = 960;
const H1 = 540;
const NF = 60;

function ff(args) {
  const r = sh(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
  if (r.code !== 0) throw new Error(`ffmpeg が失敗しました: ${args.join(' ')}\n${r.err}`);
}

function makePattern() {
  const p = path.join(VID, 'pattern.png');
  ff(['-f', 'lavfi', '-i', 'color=c=gray:s=4800x2800,noise=alls=100:allf=u,gblur=sigma=10,eq=contrast=9',
    '-f', 'lavfi', '-i', 'testsrc2=s=4800x2800',
    '-filter_complex', '[0][1]blend=all_mode=overlay:all_opacity=0.6,format=rgb24', '-frames:v', '1', p]);
  // 2 倍の大きさの模様（sim / plane / shake 用）
  ff(['-i', p, '-vf', 'scale=2400:1400:flags=area,crop=1920:1080:240:160,format=rgb24', '-frames:v', '1', path.join(VID, 'pattern2x.png')]);
  return p;
}

// 平行移動: 1x での動き dx(n) = 1.25n + 6 sin(n/6)、dy(n) = 0.75n - 4 sin(n/9) を 0.25 画素に丸めたもの
const X0 = 400;
const Y0 = 300;
function moveQ(n) {
  return [Math.round(4 * (1.25 * n + 6 * Math.sin(n / 6))), Math.round(4 * (0.75 * n - 4 * Math.sin(n / 9)))];
}
function makeMove(name, extraVf) {
  const out = path.join(VID, `${name}.y4m`);
  // ffmpeg の round() は 0.5 を 0 から遠い方へ丸める（JavaScript の Math.round と負の数の .5 だけ違うが、この式では起きない）
  const vf = `format=rgb24,crop=3840:2160:x='${X0}+round(4*(1.25*n+6*sin(n/6)))':y='${Y0}+round(4*(0.75*n-4*sin(n/9)))',scale=${W1}:${H1}:flags=area,format=yuv420p${extraVf || ''}`;
  ff(['-loop', '1', '-framerate', '30', '-i', path.join(VID, 'pattern.png'), '-vf', vf, '-frames:v', String(NF), '-pix_fmt', 'yuv420p', '-strict', '-1', out]);
  return out;
}
function moveTruth(px, py, n) {
  const q0 = moveQ(0);
  const q = moveQ(n);
  return [px - (q[0] - q0[0]) / 4, py - (q[1] - q0[1]) / 4];
}

// 2x の画面での変換（四隅の行き先）を perspective（sense=destination）で掛けて、1/2 に縮める。
// corners(nExpr) は ffmpeg の式の文字列 8 個（x0 y0 x1 y1 x2 y2 x3 y3。左上・右上・左下・右下）。
// perspective の式の in（入力のコマの数）は最初のコマで 1 なので（ffmpeg 9.0 で白い点の重心を測って確かめた）、コマの番号は in-1 と書く。
function makePersp(name, cornersExpr) {
  const out = path.join(VID, `${name}.y4m`);
  const c = cornersExpr;
  const vf = `perspective=x0='${c[0]}':y0='${c[1]}':x1='${c[2]}':y1='${c[3]}':x2='${c[4]}':y2='${c[5]}':x3='${c[6]}':y3='${c[7]}':sense=destination:eval=frame,scale=${W1}:${H1}:flags=area,format=yuv420p`;
  ff(['-loop', '1', '-framerate', '30', '-i', path.join(VID, 'pattern2x.png'), '-vf', vf, '-frames:v', String(NF), '-pix_fmt', 'yuv420p', '-strict', '-1', out]);
  return out;
}

// 相似変換（2x の画面の中心のまわり）: 回転 a、拡大 s、平行移動 (tx, ty)
function simCornersExpr(aE, sE, txE, tyE) {
  const cs = [[0, 0], ['W', 0], [0, 'H'], ['W', 'H']];
  const out = [];
  for (const [cx, cy] of cs) {
    const dx = `(${cx}-W/2)`;
    const dy = `(${cy}-H/2)`;
    out.push(`W/2+(${sE})*(cos(${aE})*${dx}-sin(${aE})*${dy})+(${txE})`);
    out.push(`H/2+(${sE})*(sin(${aE})*${dx}+cos(${aE})*${dy})+(${tyE})`);
  }
  return out;
}

// JavaScript の行列（行の順の 9 個）
function mul(a, b) {
  const m = new Array(9).fill(0);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) m[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
  return m;
}
function apply(m, x, y) {
  const d = m[6] * x + m[7] * y + m[8];
  return [(m[0] * x + m[1] * y + m[2]) / d, (m[3] * x + m[4] * y + m[5]) / d];
}
function homography(src, dst) {
  const A = [];
  for (let k = 0; k < 4; k++) {
    const [x, y] = src[k];
    const [u, v] = dst[k];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
  }
  for (let c = 0; c < 8; c++) {
    let p = c;
    for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]];
    for (let r = 0; r < 8; r++) {
      if (r === c) continue;
      const f = A[r][c] / A[c][c];
      for (let k = c; k < 9; k++) A[r][k] -= f * A[c][k];
    }
  }
  const h = [];
  for (let k = 0; k < 8; k++) h.push(A[k][8] / A[k][k]);
  h.push(1);
  return h;
}
// 2x の画素の座標の変換を 1x に直す（1x の画素 i の中心は 2x の 2i+0.5）
const S2 = [2, 0, 0.5, 0, 2, 0.5, 0, 0, 1];
const S2i = [0.5, 0, -0.25, 0, 0.5, -0.25, 0, 0, 1];
function to1x(m2) {
  return mul(S2i, mul(m2, S2));
}
function simMat2x(a, s, tx, ty) {
  const W = 1920;
  const H = 1080;
  const c = Math.cos(a) * s;
  const n = Math.sin(a) * s;
  // p' = C + sR(p - C) + t
  return [c, -n, W / 2 - (c * W / 2 - n * H / 2) + tx, n, c, H / 2 - (n * W / 2 + c * H / 2) + ty, 0, 0, 1];
}

const SIM = { a: (n) => 0.006 * n, s: (n) => 1 + 0.004 * n, tx: (n) => 1.6 * n, ty: (n) => -0.8 * n };
function simTruth(n) {
  return to1x(simMat2x(SIM.a(n), SIM.s(n), SIM.tx(n), SIM.ty(n)));
}

// 平面: 四隅を別々に動かす（f = n/59）
const PL = [[80, 40], [-120, 90], [30, -60], [-50, -20]];
function planeCornersExpr() {
  const base = [['0', '0'], ['W', '0'], ['0', 'H'], ['W', 'H']];
  const out = [];
  for (let k = 0; k < 4; k++) {
    out.push(`${base[k][0]}+${PL[k][0]}*(in-1)/${NF - 1}`);
    out.push(`${base[k][1]}+${PL[k][1]}*(in-1)/${NF - 1}`);
  }
  return out;
}
function planeTruth(n) {
  const W = 1920;
  const H = 1080;
  const f = n / (NF - 1);
  const src = [[0, 0], [W, 0], [0, H], [W, H]];
  const dst = src.map(([x, y], k) => [x + PL[k][0] * f, y + PL[k][1] * f]);
  return to1x(homography(src, dst));
}

// 手ぶれ: 小さな回転・拡大・平行移動（2x の画素）
const SHAKE = {
  a: (n) => `(0.012*sin(1.7*${n})+0.008*sin(0.9*${n}+1))`,
  s: (n) => `(1+0.008*sin(1.1*${n}))`,
  tx: (n) => `(12*sin(2.3*${n})+8*sin(0.7*${n}))`,
  ty: (n) => `(10*sin(1.9*${n}+0.5)+6*sin(0.5*${n}))`,
};

// ---- .trk を読む（JavaScript。結果を確かめる） ----

function readTrk(file) {
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l && !l.startsWith('#'));
  const head = lines[0];
  if (!head.startsWith('motion version=2 ')) throw new Fail(`.trk の設定の行が motion version=2 で始まらない: ${head}`);
  const frames = [];
  for (const l of lines.slice(1)) {
    const pts = [];
    for (const t of l.split(' ').slice(1)) {
      const v = t.split('=')[1].split(',');
      pts.push({ x: +v[0], y: +v[1], c: +v[2], s: v[3] });
    }
    frames.push(pts);
  }
  return { head, frames };
}

function errStats(tr, truthFn) {
  let max = 0;
  let sum = 0;
  let cnt = 0;
  tr.frames.forEach((pts, n) => {
    pts.forEach((p, k) => {
      const [tx, ty] = truthFn(n, k);
      const e = Math.hypot(p.x - tx, p.y - ty);
      max = Math.max(max, e);
      sum += e;
      cnt++;
    });
  });
  return { max, mean: sum / cnt };
}

function toPng(bmp, png) {
  ff(['-i', bmp, png]);
}

// ---- テスト ----

function main() {
  const t0 = Date.now();
  console.log('ビルド（CPU）...');
  EXE = build(path.join(TMP, 'cpu'));
  const gh = NO_GPU ? undefined : wgpuHome();
  if (gh) {
    console.log(`ビルド（UM_WGPU=1、${gh}）...`);
    try {
      EXE_GPU = build(path.join(TMP, 'gpu'), gh);
      // DLL を実行ファイルの隣に写す（UM のビルドが写すが、念のため）
    } catch (e) {
      console.log(`  GPU のビルドに失敗したので、GPU の比較を飛ばします: ${e.message}`);
    }
  } else {
    console.log('wgpu-native が見つからないので、GPU の比較を飛ばします');
  }
  console.log('映像を作る（ffmpeg）...');
  makePattern();
  const move = makeMove('move');
  const sim = makePersp('sim', simCornersExpr('0.006*(in-1)', '1+0.004*(in-1)', '1.6*(in-1)', '-0.8*(in-1)'));
  const plane = makePersp('plane', planeCornersExpr());
  // 隠す: 20〜24 コマ目に、点 (300, 200) の通り道を、探す範囲ごと灰色の箱で隠す
  const hide = makeMove('hide', `,drawbox=x=170:y=100:w=200:h=170:color=gray:t=fill:enable='between(n,20,24)'`);
  const shake = makePersp('shake', simCornersExpr(SHAKE.a('(in-1)'), SHAKE.s('(in-1)'), SHAKE.tx('(in-1)'), SHAKE.ty('(in-1)')));
  // slow: 中身が 1 画素/コマで左上へ動く（4 倍の大きさで切り出す位置を右下へ 4 画素ずつ）
  const slow = path.join(VID, 'slow.y4m');
  ff(['-loop', '1', '-framerate', '30', '-i', path.join(VID, 'pattern.png'), '-vf',
    `format=rgb24,crop=3840:2160:x='${X0}+4*n':y='${Y0}+4*n',scale=${W1}:${H1}:flags=area,format=yuv420p`, '-frames:v', String(NF), '-pix_fmt', 'yuv420p', '-strict', '-1', slow]);
  // fast: 中身が 20 画素/コマで左へ動く（480x270、30 コマ）
  const fast = path.join(VID, 'fast.y4m');
  ff(['-loop', '1', '-framerate', '30', '-i', path.join(VID, 'pattern.png'), '-vf',
    `format=rgb24,crop=1920:1080:x='${X0}+80*n':y='${Y0}',scale=480:270:flags=area,format=yuv420p`, '-frames:v', '30', '-pix_fmt', 'yuv420p', '-strict', '-1', fast]);
  const hd = path.join(VID, 'hd.y4m');
  ff(['-loop', '1', '-framerate', '30', '-i', path.join(VID, 'pattern.png'), '-vf',
    `scale=2400:1400:flags=area,format=rgb24,crop=1920:1080:x='100+3*n':y='80+2*n',format=yuv420p`, '-frames:v', '20', '-pix_fmt', 'yuv420p', '-strict', '-1', hd]);
  console.log(`  （${((Date.now() - t0) / 1000).toFixed(1)} 秒）`);

  console.log('テスト:');

  test('三角関数・対数・射影変換・相似変換の値', () => {
    const r = tool(['math']).out.split('\n');
    const nums = (l) => l.split(' ').slice(1).filter((s) => /^-?[0-9.e+-]+$/.test(s)).map(Number);
    const at = nums(r[0]);
    const exp = [Math.atan2(1, 1), Math.atan2(-2, -1), Math.atan2(0.5, -3), Math.atan2(-1, 0)];
    at.forEach((v, i) => check(Math.abs(v - exp[i]) < 1e-13, `atan2 ${v} != ${exp[i]}`));
    const sc = nums(r[1]);
    const se = [Math.sin(0.5), Math.sin(3), Math.sin(-10), Math.cos(0.5), Math.cos(3), Math.cos(-10)];
    sc.forEach((v, i) => check(Math.abs(v - se[i]) < 1e-13, `sin/cos ${v} != ${se[i]}`));
    const le = nums(r[2]);
    const lx = [Math.log(2), Math.log(0.37), Math.log(1234.5), Math.exp(1), Math.exp(-2.5), Math.exp(0.01)];
    le.forEach((v, i) => check(Math.abs(v - lx[i]) < 1e-12 * Math.max(1, Math.abs(lx[i])), `ln/exp ${v} != ${lx[i]}`));
    const hm = /cornerErr=(\S+) invErr=(\S+)/.exec(r[3]);
    check(r[3].includes('ok=true') && +hm[1] < 1e-9 && +hm[2] < 1e-12, r[3]);
    const sm = /scale=(\S+) angle=(\S+) tx=(\S+) ty=(\S+)/.exec(r[4]);
    check(Math.abs(+sm[1] - 1.25) < 1e-12 && Math.abs(+sm[2] - 0.3) < 1e-12 && Math.abs(+sm[3] - 17) < 1e-9 && Math.abs(+sm[4] + 4) < 1e-9, r[4]);
  });

  const movePts = [[300, 200], [620, 140], [480, 400]];
  const ptsArg = (pts) => pts.map((p) => p.join(',')).join(';');
  const trk = (name) => path.join(OUT, `${name}.trk`);

  test('平行移動（3 点、0.25 画素の刻みの既知の動き）を追える', () => {
    const r = tool(['track', move, trk('move'), '--points', ptsArg(movePts)]);
    const tr = readTrk(trk('move'));
    check(tr.frames.length === NF, `コマの数 ${tr.frames.length}`);
    const st = errStats(tr, (n, k) => moveTruth(movePts[k][0], movePts[k][1], n));
    const minC = Math.min(...tr.frames.flat().map((p) => p.c));
    check(st.max < 0.1, `最大の誤差 ${st.max.toFixed(4)} 画素（0.1 未満のはず）`);
    check(minC > 0.9, `信頼度の最低 ${minC}`);
    check(r.out.includes('点 3 個を 60 コマ追いました'), r.out);
    return `誤差 平均 ${st.mean.toFixed(4)} / 最大 ${st.max.toFixed(4)} 画素、信頼度の最低 ${minC}`;
  });

  test('模様を毎コマ取り直す（adapt=1）・取り直さない（adapt=0）でも追える', () => {
    const notes = [];
    for (const adapt of ['1', '0']) {
      tool(['track', move, trk(`move_a${adapt}`), '--points', ptsArg(movePts), '--adapt', adapt]);
      const st = errStats(readTrk(trk(`move_a${adapt}`)), (n, k) => moveTruth(movePts[k][0], movePts[k][1], n));
      // 毎コマ取り直すと、1 コマごとの小さな誤差（0.01 画素ほど）が積み重なる（既定の adapt=0.9 では取り直さない）
      const lim = adapt === '1' ? 0.6 : 0.12;
      check(st.max < lim, `adapt=${adapt} の最大の誤差 ${st.max.toFixed(4)}（${lim} 未満のはず）`);
      notes.push(`adapt=${adapt}: 最大 ${st.max.toFixed(4)}`);
    }
    return notes.join('、');
  });

  test('予測なし（--no-predict）でも、探す範囲の中の動きは追える', () => {
    tool(['track', move, trk('move_np'), '--points', ptsArg(movePts), '--no-predict', '--search', '12']);
    const st = errStats(readTrk(trk('move_np')), (n, k) => moveTruth(movePts[k][0], movePts[k][1], n));
    check(st.max < 0.12, `最大の誤差 ${st.max.toFixed(4)}`);
    return `最大 ${st.max.toFixed(4)}`;
  });

  const simPts = [[330, 250], [640, 300]];
  test('2 点で位置・拡大・回転（20 度・1.24 倍まで）を追える', () => {
    const r = tool(['track', sim, trk('sim'), '--points', ptsArg(simPts), '--json']);
    const j = JSON.parse(r.out);
    check(j.mode === 'similarity', j.mode);
    const tr = readTrk(trk('sim'));
    const st = errStats(tr, (n, k) => apply(simTruth(n), simPts[k][0], simPts[k][1]));
    check(st.max < 0.35, `点の最大の誤差 ${st.max.toFixed(4)} 画素`);
    let maxA = 0;
    let maxS = 0;
    j.track.forEach((f, n) => {
      maxA = Math.max(maxA, Math.abs(f.angle - SIM.a(n) * 180 / Math.PI));
      maxS = Math.max(maxS, Math.abs(f.scale - SIM.s(n)));
    });
    check(maxA < 0.08, `回転の最大の誤差 ${maxA} 度`);
    check(maxS < 0.001, `拡大の最大の誤差 ${maxS}`);
    // dx / dy は付ける点（点の重心）の動き。行列の m2 / m5（左上の行き先）とは違う
    const [ax, ay] = j.attach;
    check(Math.abs(ax - 485) < 1e-9 && Math.abs(ay - 275) < 1e-9, `付ける点 ${j.attach}`);
    let maxD = 0;
    j.track.forEach((f, n) => {
      const [tx, ty] = apply(simTruth(n), ax, ay);
      maxD = Math.max(maxD, Math.hypot(f.dx - (tx - ax), f.dy - (ty - ay)));
    });
    check(maxD < 0.2, `付ける点の動きの最大の誤差 ${maxD}`);
    const lastM = j.track[NF - 1];
    check(Math.abs(lastM.matrix[2] - lastM.dx) > 5, `m2 と dx が同じ（${lastM.matrix[2]}、${lastM.dx}）`);
    const last = j.track[NF - 1];
    return `点の誤差 最大 ${st.max.toFixed(3)} 画素、回転 ${last.angle}° / 正 ${(SIM.a(NF - 1) * 180 / Math.PI).toFixed(4)}°（最大の誤差 ${maxA.toFixed(4)}°）、拡大 ${last.scale} / 正 ${SIM.s(NF - 1).toFixed(4)}、取り直し ${j.summary.regrabs} 回`;
  });

  const planePts = [[200, 150], [760, 130], [220, 420], [740, 400]];
  test('4 点で平面（射影変換）を追える', () => {
    const r = tool(['track', plane, trk('plane'), '--points', ptsArg(planePts), '--json']);
    const j = JSON.parse(r.out);
    check(j.mode === 'perspective', j.mode);
    const tr = readTrk(trk('plane'));
    const st = errStats(tr, (n, k) => apply(planeTruth(n), planePts[k][0], planePts[k][1]));
    check(st.max < 0.35, `点の最大の誤差 ${st.max.toFixed(4)}`);
    // 追った射影変換で、点の外の位置（格子）も正しく写るか
    let maxG = 0;
    j.track.forEach((f, n) => {
      const t = planeTruth(n);
      for (const gx of [100, 480, 860]) {
        for (const gy of [60, 270, 480]) {
          const a = apply(f.matrix, gx, gy);
          const b = apply(t, gx, gy);
          maxG = Math.max(maxG, Math.hypot(a[0] - b[0], a[1] - b[1]));
        }
      }
    });
    check(maxG < 0.8, `格子の点の最大の誤差 ${maxG}`);
    return `追った点の誤差 最大 ${st.max.toFixed(3)} 画素、射影変換で写した格子 9 点の誤差 最大 ${maxG.toFixed(3)} 画素`;
  });

  test('隠れたコマを「見失った」とし、出てきたら見つけ直す', () => {
    const r = tool(['track', hide, trk('hide'), '--points', ptsArg(movePts), '--json']);
    const j = JSON.parse(r.out);
    const lost = j.summary.lost.filter((l) => l.point === 'p0');
    check(lost.length >= 1 && lost[0].from >= 20 && lost[lost.length - 1].to <= 25, `見失った範囲 ${JSON.stringify(j.summary.lost)}`);
    check(j.summary.lost.every((l) => l.point === 'p0'), `ほかの点も見失った: ${JSON.stringify(j.summary.lost)}`);
    const tr = readTrk(trk('hide'));
    let maxAfter = 0;
    for (let n = 26; n < NF; n++) {
      const [tx, ty] = moveTruth(movePts[0][0], movePts[0][1], n);
      maxAfter = Math.max(maxAfter, Math.hypot(tr.frames[n][0].x - tx, tr.frames[n][0].y - ty));
    }
    check(maxAfter < 0.15, `出てきた後の誤差 ${maxAfter}`);
    const human = tool(['track', hide, trk('hide2'), '--points', ptsArg(movePts)]).out;
    check(human.includes('警告[motion-lost]: 見失ったコマがあります') && human.includes('p0 の 20〜'), human);
    return `見失った: ${lost.map((l) => `${l.from}〜${l.to}`).join(', ')} コマ目、後の誤差 最大 ${maxAfter.toFixed(3)} 画素`;
  });

  const shakePts = [[300, 220], [660, 320]];
  test('手ぶれ補正: 補正した映像の点が止まる・平均の絵がくっきりする', () => {
    tool(['track', shake, trk('shake'), '--points', ptsArg(shakePts)]);
    const stab = path.join(VID, 'stab.y4m');
    tool(['stabilize', shake, trk('shake'), stab]);
    const tagOf = (f) => / (C\S+)/.exec(fs.readFileSync(f).subarray(0, 120).toString('latin1').split('\n')[0])[1];
    check(tagOf(stab) === tagOf(shake), `C タグが入力（${tagOf(shake)}）と違う: ${tagOf(stab)}`);
    // 補正した映像を別の点で追う（端の黒い所を避ける）
    const chkPts = [[420, 160], [540, 380], [250, 330]];
    tool(['track', stab, trk('stab_check'), '--points', ptsArg(chkPts)]);
    const tr = readTrk(trk('stab_check'));
    const st = errStats(tr, (n, k) => chkPts[k]);
    const raw = errStats(readTrk(trk('shake')), (n, k) => shakePts[k]);
    check(st.max < 0.3, `補正した後の点の動き 最大 ${st.max.toFixed(4)} 画素（補正の前は ${raw.max.toFixed(2)}）`);
    // なめらかにする版（smooth=8）も書けること
    const stab8 = path.join(VID, 'stab8.y4m');
    tool(['stabilize', shake, trk('shake'), stab8, '--smooth', '8', '--clamp']);
    tool(['track', stab8, trk('stab8_check'), '--points', ptsArg(chkPts)]);
    const st8 = errStats(readTrk(trk('stab8_check')), (n, k) => chkPts[k]);
    // smooth=8 はゆっくりした動きを残す。残った動きがなめらか（コマごとの加速が小さい）ことを、補正の前と比べる
    const jitter = (tr) => {
      let m = 0;
      for (let n = 1; n + 1 < tr.frames.length; n++) {
        tr.frames[n].forEach((p, k) => {
          const a = tr.frames[n - 1][k];
          const b = tr.frames[n + 1][k];
          m = Math.max(m, Math.hypot(a.x - 2 * p.x + b.x, a.y - 2 * p.y + b.y));
        });
      }
      return m;
    };
    const j0 = jitter(readTrk(trk('shake')));
    const j8 = jitter(readTrk(trk('stab8_check')));
    check(st8.max < 10 && j8 < j0 * 0.25, `smooth=8 の点の動き 最大 ${st8.max}、加速の最大 ${j8}（補正の前 ${j0}）`);
    const m0 = /sharpness (\S+)/.exec(tool(['mean', shake, path.join(OUT, 'shake_mean.bmp')]).out)[1];
    const m1 = /sharpness (\S+)/.exec(tool(['mean', stab, path.join(OUT, 'stab_mean.bmp')]).out)[1];
    check(+m1 > +m0 * 1.5, `平均の絵のくっきりさ 補正前 ${m0} / 後 ${m1}`);
    toPng(path.join(OUT, 'shake_mean.bmp'), path.join(OUT, 'shake_mean.png'));
    toPng(path.join(OUT, 'stab_mean.bmp'), path.join(OUT, 'stab_mean.png'));
    ff(['-i', stab, '-vf', 'select=eq(n\\,37)', '-frames:v', '1', path.join(OUT, 'stab_f37.png')]);
    ff(['-i', shake, '-vf', 'select=eq(n\\,37)', '-frames:v', '1', path.join(OUT, 'shake_f37.png')]);
    return `点の動き 補正前 最大 ${raw.max.toFixed(2)} → 補正後 ${st.max.toFixed(3)} 画素（smooth=8 は ${st8.max.toFixed(2)}、コマごとの加速の最大 ${j0.toFixed(2)} → ${j8.toFixed(3)}）、平均の絵のくっきりさ ${m0} → ${m1}`;
  });

  test('追跡を別の層に当てる（follow）: 層の四隅が追跡の変換どおりに動く', () => {
    const notes = [];
    for (const [name, pts, truth, kf, box] of [
      ['move', movePts, (n) => { const d = moveTruth(0, 0, n); return [1, 0, d[0], 0, 1, d[1], 0, 0, 1]; }, 45, '250,160,100,80'],
      ['sim', simPts, (n) => simTruth(n), 50, '400,200,160,120'],
      ['plane', planePts, (n) => planeTruth(n), 59, '330,180,300,180'],
    ]) {
      const bmp = path.join(OUT, `follow_${name}.bmp`);
      const r = tool(['follow', VID + `/${name}.y4m`, trk(name), String(kf), bmp, '--box', box]);
      const c = /corners (\S+) (\S+) (\S+) (\S+)/.exec(r.out).slice(1).map(Number);
      const [bx, by, bw, bh] = box.split(',').map(Number);
      const t = truth(kf);
      const a = apply(t, bx, by);
      const b = apply(t, bx + bw - 1, by + bh - 1);
      const e = Math.max(Math.hypot(c[0] - a[0], c[1] - a[1]), Math.hypot(c[2] - b[0], c[3] - b[1]));
      check(e < 0.6, `${name}: 四隅の誤差 ${e}`);
      toPng(bmp, path.join(OUT, `follow_${name}.png`));
      notes.push(`${name} ${e.toFixed(3)}`);
    }
    // cornerpin: 層の外の縁の四隅が、コマ kf の追った 4 点（正しい動きで写した点）に貼られる
    for (const kf of [0, 30, 59]) {
      const bmp = path.join(OUT, `follow_pin${kf}.bmp`);
      const r = tool(['follow', plane, trk('plane'), String(kf), bmp, '--box', '0,0,320,200', '--mode', 'cornerpin']);
      const c = /pin (\S+) (\S+) (\S+) (\S+) (\S+) (\S+) (\S+) (\S+)/.exec(r.out).slice(1).map(Number);
      let e = 0;
      planePts.forEach(([x, y], k) => {
        const [tx, ty] = apply(planeTruth(kf), x, y);
        e = Math.max(e, Math.hypot(c[k * 2] - tx, c[k * 2 + 1] - ty));
      });
      check(e < 0.3, `cornerpin ${kf} コマ目: 四隅と 4 点の誤差 ${e}`);
      if (kf === 59) toPng(bmp, path.join(OUT, 'follow_pin.png'));
      notes.push(`cornerpin ${kf} コマ目 ${e.toFixed(3)}`);
    }
    tool(['marks', move, trk('move'), '30', path.join(OUT, 'marks_move.bmp')]);
    toPng(path.join(OUT, 'marks_move.bmp'), path.join(OUT, 'marks_move.png'));
    tool(['marks', VID + '/hide.y4m', trk('hide'), '22', path.join(OUT, 'marks_hide.bmp')]);
    toPng(path.join(OUT, 'marks_hide.bmp'), path.join(OUT, 'marks_hide.png'));
    return `四隅の誤差（画素）: ${notes.join('、')}`;
  });

  test('.trk を読み直すと同じ結果（JSON）になる・壊れた .trk は行を指して断る', () => {
    const j1 = JSON.parse(tool(['track', plane, trk('plane_rt'), '--points', ptsArg(planePts), '--json']).out);
    const j2 = JSON.parse(tool(['parse', trk('plane_rt')]).out);
    check(JSON.stringify(j1.track.map((f) => f.p)) === JSON.stringify(j2.track.map((f) => f.p)), '点の値が違う');
    for (let n = 0; n < NF; n++) {
      check(Math.abs(j1.track[n].scale - j2.track[n].scale) < 2e-4 && Math.abs(j1.track[n].angle - j2.track[n].angle) < 2e-3, `コマ ${n} の変換が違う`);
    }
    const bad = path.join(TMP, 'bad.trk');
    const lines = fs.readFileSync(trk('plane_rt'), 'utf8').split('\n');
    lines[5] = lines[5].replace('p2=', 'q2=');
    fs.writeFileSync(bad, lines.join('\n'));
    const r = sh(EXE, ['parse', bad]);
    check(r.code === 1, `終了コード ${r.code}`);
    const e = JSON.parse(r.out);
    check(e.ok === false && e.line === 6 && e.error.includes("'q2'"), r.out);
    // 読み取りの穴: 名前・状態・無限大・2 つ目の設定の行・名前の数
    const good = fs.readFileSync(trk('plane_rt'), 'utf8').split('\n');
    const cases = [
      ['names=f,q', (l) => { l[1] = l[1].replace('names=p0,p1,p2,p3', 'names=f,q,r,s'); }, 2, "'f'"],
      ['名前の数', (l) => { l[1] = l[1].replace('names=p0,p1,p2,p3', 'names=p0,p1,p2'); }, 2, '名前の数'],
      ['知らない状態', (l) => { l[4] = l[4].replace(/,ok( |$)/, ',weird$1'); }, 5, "'weird'"],
      ['無限大', (l) => { l[4] = l[4].replace(/p1=[^,]+,/, 'p1=1e400,'); }, 5, '有限'],
      ['2 つ目の設定の行', (l) => { l.splice(6, 0, l[1].replace('names=p0,p1,p2,p3', 'names=a,b,c,d')); }, 7, '2 つ'],
      ['古い形式', (l) => { l[1] = l[1].replace('motion version=2', 'track version=1'); }, 2, '古い形式'],
    ];
    const notes = [];
    for (const [what, edit, line, needle] of cases) {
      const l = good.slice();
      edit(l);
      fs.writeFileSync(bad, l.join('\n'));
      const rr = sh(EXE, ['parse', bad]);
      const ee = JSON.parse(rr.out);
      check(rr.code === 1 && ee.line === line && ee.error.includes(needle), `${what}: ${rr.out}`);
      notes.push(`${what} → ${ee.line} 行目`);
    }
    return `壊れた行: ${e.line} 行目「${e.error}」。${notes.join('、')}`;
  });

  test('画面の外へ出る点は out にして止め、ほかの点と変換を壊さない', () => {
    const pts = [[2, 2], [957, 537], [480, 270]];
    const r = tool(['track', slow, trk('slow'), '--points', ptsArg(pts), '--json']);
    const j = JSON.parse(r.out);
    const tr = readTrk(trk('slow'));
    const outAt = tr.frames.findIndex((f) => f[0].s === 'out');
    check(outAt >= 1 && outAt <= 4, `p0 が out になったコマ ${outAt}`);
    check(tr.frames.slice(outAt).every((f) => f[0].s === 'out' && f[0].x === tr.frames[outAt][0].x), 'out の後に p0 が動いた');
    let e2 = 0;
    let e1 = 0;
    tr.frames.forEach((f, n) => {
      e2 = Math.max(e2, Math.hypot(f[2].x - (480 - n), f[2].y - (270 - n)));
      if (n >= 5) e1 = Math.max(e1, Math.hypot(f[1].x - (957 - n), f[1].y - (537 - n)));
    });
    check(e2 < 0.05, `p2 の誤差 ${e2}`);
    check(e1 < 0.5, `p1 の誤差 ${e1}`);
    check(j.summary.regrabs < 10, `取り直し ${j.summary.regrabs} 回`);
    // 変換（相似）は p1 と p2 で求め、p2 の動きを正しく写す
    let ex = 0;
    let es = 0;
    let ea = 0;
    j.track.forEach((f, n) => {
      const [x, y] = apply(f.matrix, 480, 270);
      ex = Math.max(ex, Math.hypot(x - (480 - n), y - (270 - n)));
      es = Math.max(es, Math.abs(f.scale - 1));
      ea = Math.max(ea, Math.abs(f.angle));
    });
    // p1 は画面の端の近く（模様の一部が外）なので 0.3 画素ほどずれ、回転が 0.03 度ほどずれる
    check(ex < 0.3 && es < 0.002 && ea < 0.1, `変換で写した p2 の誤差 ${ex}、拡大のずれ ${es}、回転のずれ ${ea} 度`);
    check(j.summary.out.length === 1 && j.summary.out[0].point === 'p0', JSON.stringify(j.summary.out));
    check(JSON.stringify(j.summary.nearEdge) === '["p0","p1"]', JSON.stringify(j.summary.nearEdge));
    const human = tool(['track', slow, trk('slow2'), '--points', ptsArg(pts)]).out;
    check(human.includes('警告[motion-out]') && human.includes('警告[motion-near-edge]'), human);
    // follow（相似）も暴走しない
    const fr = tool(['follow', slow, trk('slow'), '45', path.join(OUT, 'follow_slow.bmp'), '--box', '400,220,120,90']);
    const c = /corners (\S+) (\S+)/.exec(fr.out).slice(1).map(Number);
    check(Math.hypot(c[0] - 355, c[1] - 175) < 0.5, `follow の左上 ${c}`);
    return `p0 は ${outAt} コマ目から out、p2 の誤差 最大 ${e2.toFixed(3)}、p1（端の近く）${e1.toFixed(3)} 画素、変換で写した p2 ${ex.toFixed(3)} 画素、取り直し ${j.summary.regrabs} 回`;
  });

  test('探す範囲より速い動き: 範囲を広げて探し直す・追い始めから見失ったら別の文', () => {
    const pts = [[150, 100], [300, 180]];
    const r = tool(['track', fast, trk('fast'), '--points', ptsArg(pts), '--search', '12', '--json']);
    const j = JSON.parse(r.out);
    const tr = readTrk(trk('fast'));
    check(j.summary.lostFrames === 0, `見失った: ${JSON.stringify(j.summary.lost)}`);
    check(tr.frames[1][0].s === 'edge', `1 コマ目の状態 ${tr.frames[1][0].s}`);
    let e = 0;
    tr.frames.forEach((f, n) => f.forEach((p, k) => {
      if (p.s !== 'out') e = Math.max(e, Math.hypot(p.x - (pts[k][0] - 20 * n), p.y - pts[k][1]));
    }));
    check(e < 0.1, `誤差 ${e}`);
    const human = tool(['track', fast, trk('fast_h'), '--points', ptsArg(pts), '--search', '12']).out;
    check(human.includes('警告[motion-edge]') && !human.includes('motion-lost'), human);
    // search=2（広げても 8 画素まで）では追えない。追い始めから見失ったことと、search のヒントを出す
    const h2 = tool(['track', fast, trk('fast2'), '--points', ptsArg(pts), '--search', '2']).out;
    check(h2.includes('追い始めた次のコマから見失いました') && h2.includes('search'), h2);
    return `search=12 で 20 画素/コマ: 誤差 最大 ${e.toFixed(3)} 画素、1 コマ目は edge`;
  });

  test('手ぶれ補正の smooth: 等速のパンでは補正が 0（端のコマもずれない）', () => {
    tool(['track', slow, trk('slow_in'), '--points', '300,200;700,400']);
    const notes = [];
    for (const sm of ['8', '30']) {
      const r = tool(['smoothcheck', trk('slow_in'), '--smooth', sm]).out;
      const m = /maxShift=(\S+) firstShift=(\S+)/.exec(r);
      check(+m[1] < 0.05, `smooth=${sm}: 四隅のずれ 最大 ${m[1]} 画素`);
      notes.push(`smooth=${sm}: ${(+m[1]).toFixed(4)}`);
    }
    return `四隅のずれの最大（画素）: ${notes.join('、')}`;
  });

  test('mozcut motion の流れ: 素材の座標・motion.at・展開の in・描くコマ・追い直しの判断', () => {
    // move.y4m を、1920x1080 の素材を 1/2 に縮めて、素材の 0.5 秒から展開したものとみなす。motion.at=1.0（展開の 15 コマ目）
    const srcPts = movePts.map(([x, y]) => [2 * x + 0.5, 2 * y + 0.5]);
    const r = tool(['motion', move, trk('motion'), '--points', ptsArg(srcPts), '--srcsize', '1920x1080', '--in', '0.5', '--at', '1']);
    const j = JSON.parse(r.out);
    check(j.at === 1 && j.in === 0.5 && j.frames === NF - 15 && j.srcWidth === 1920, `at ${j.at} in ${j.in} frames ${j.frames}`);
    let e = 0;
    j.track.forEach((f, n) => f.p.forEach((p, k) => {
      const a = moveTruth(movePts[k][0], movePts[k][1], 15 + n);
      const b = moveTruth(movePts[k][0], movePts[k][1], 15);
      e = Math.max(e, Math.hypot(p[0] - (movePts[k][0] + a[0] - b[0]), p[1] - (movePts[k][1] + a[1] - b[1])));
    }));
    check(e < 0.1, `誤差 ${e}`);
    const st = /stale0=\[(.*?)\] stale1=\[(.*?)\] stale2=\[(.*?)\] first=(\d+)/.exec(r.err);
    check(st[1] === '' && st[2].includes('motion=') && st[3].includes('大きさ') && st[4] === '15', r.err);
    // 描くコマ: lt=0.6、クリップの in=1.0、展開の in=0.5 → 展開のコマ 33 → 追跡の f=18。展開を 0.8 から作り直しても同じ
    const f1 = /frame (\S+)/.exec(tool(['frame', trk('motion'), '0.6', '1', '0.5']).out)[1];
    const f2 = /frame (\S+)/.exec(tool(['frame', trk('motion'), '0.6', '1', '0.8']).out)[1];
    check(+f1 === 18 && +f2 === 18, `描くコマ ${f1} / ${f2}`);
    // 画面の外の点・点の数の誤り
    const bad1 = sh(EXE, ['motion', move, trk('x'), '--points', '1930,10', '--srcsize', '1920x1080']);
    check(bad1.code === 1 && bad1.err.includes('素材（1920x1080）の外'), bad1.err);
    const bad2 = sh(EXE, ['motion', move, trk('x'), '--points', '10;20', '--srcsize', '1920x1080']);
    check(bad2.code === 1 && bad2.err.includes('x,y の形'), bad2.err);
    return `素材の座標から追った誤差 最大 ${e.toFixed(3)} 画素、描くコマ ${f1}`;
  });

  test('重い設定: feature / search の上限と motion-slow', () => {
    const r = tool(['track', move, trk('big'), '--points', '480,270', '--feature', '64', '--search', '256', '--to', '2', '--json']);
    const j = JSON.parse(r.out);
    check(j.options.feature === 48 && j.options.search === 96, JSON.stringify(j.options));
    const lines = fs.readFileSync(trk('plane_rt'), 'utf8').split('\n');
    lines[1] = lines[1].replace('feature=15', 'feature=48').replace('search=32', 'search=96');
    fs.writeFileSync(path.join(TMP, 'slow_cfg.trk'), lines.join('\n'));
    const s = tool(['parse', path.join(TMP, 'slow_cfg.trk'), '--summary']).out;
    check(s.includes('警告[motion-slow]'), s);
    const s2 = tool(['parse', trk('plane_rt'), '--summary']).out;
    check(!s2.includes('motion-slow'), s2);
    return `上限 feature ${j.options.feature}、search ${j.options.search}`;
  });

  test('使い方の誤り: 画面の外の点・17 個の点', () => {
    const r1 = sh(EXE, ['track', move, trk('x'), '--points', '2000,10']);
    check(r1.code === 1 && r1.err.includes('画面（960x540）の外'), r1.err);
    const many = Array.from({ length: 17 }, (_, i) => `${100 + i * 10},100`).join(';');
    const r2 = sh(EXE, ['track', move, trk('x'), '--points', many]);
    check(r2.code === 2, `終了コード ${r2.code}`);
  });

  if (EXE_GPU) {
    test('CPU と GPU（wgpu）で同じ結果（.trk・補正した Y4M・重ねた絵がバイトまで同じ）', () => {
      const cpu = { UM_GPU: '0' };
      const gpu = { UM_GPU_THRESHOLD: '1' };
      const g = (args, env) => {
        const r = sh(EXE_GPU, args, env);
        if (r.code !== 0) throw new Fail(`GPU 版 ${args.join(' ')} が終了コード ${r.code}:\n${r.out}${r.err}`);
        return r;
      };
      const same = (a, b, what) => {
        const x = fs.readFileSync(a);
        const y = fs.readFileSync(b);
        check(x.equals(y), `${what} が違う（${a} / ${b}）`);
      };
      const cases = [
        ['move', move, movePts, []], ['sim', sim, simPts, []], ['plane', plane, planePts, []], ['hide', hide, movePts, []],
        ['slow', slow, [[2, 2], [957, 537], [480, 270]], []], ['fast', fast, [[150, 100], [300, 180]], ['--search', '12']],
      ];
      for (const [name, v, pts, extra] of cases) {
        g(['track', v, path.join(TMP, `${name}_c.trk`), '--points', ptsArg(pts), ...extra], cpu);
        const tr = g(['track', v, path.join(TMP, `${name}_g.trk`), '--points', ptsArg(pts), ...extra], { ...gpu, UM_GPU_TRACE: '1' });
        same(path.join(TMP, `${name}_c.trk`), path.join(TMP, `${name}_g.trk`), `${name} の .trk`);
        check(/gpu|GPU|dispatch/.test(tr.err), `GPU を使った跡がない: ${tr.err.slice(0, 400)}`);
        // CPU だけのビルドとも同じ
        same(path.join(TMP, `${name}_c.trk`), trk(name), `${name} の .trk（CPU だけのビルドと）`);
      }
      g(['stabilize', shake, trk('shake'), path.join(TMP, 'stab_c.y4m')], cpu);
      g(['stabilize', shake, trk('shake'), path.join(TMP, 'stab_g.y4m')], gpu);
      same(path.join(TMP, 'stab_c.y4m'), path.join(TMP, 'stab_g.y4m'), '補正した Y4M');
      g(['follow', plane, trk('plane'), '40.5', path.join(TMP, 'fol_c.bmp'), '--box', '330,180,300,180'], cpu);
      g(['follow', plane, trk('plane'), '40.5', path.join(TMP, 'fol_g.bmp'), '--box', '330,180,300,180'], gpu);
      same(path.join(TMP, 'fol_c.bmp'), path.join(TMP, 'fol_g.bmp'), '重ねた絵');
      g(['follow', plane, trk('plane'), '40', path.join(TMP, 'pin_c.bmp'), '--box', '0,0,320,200', '--mode', 'cornerpin'], cpu);
      g(['follow', plane, trk('plane'), '40', path.join(TMP, 'pin_g.bmp'), '--box', '0,0,320,200', '--mode', 'cornerpin'], gpu);
      same(path.join(TMP, 'pin_c.bmp'), path.join(TMP, 'pin_g.bmp'), 'cornerpin で重ねた絵');
      return '追跡 6 本・手ぶれ補正 60 コマ・層の重ね（follow と cornerpin）';
    });
  }

  test('速さ（1920x1080、1 コマ）', () => {
    const lines = [];
    const run = (exe, env, label, pts, extra) => {
      const r = sh(exe, ['bench', hd, '--points', pts, '--frames', '20', ...(extra || [])], env);
      if (r.code !== 0) throw new Fail(`bench が失敗: ${r.out}${r.err}`);
      const m = /read=(\S+)ms track=(\S+)ms warpYuv=(\S+)ms compositeWarp=(\S+)ms/.exec(r.out);
      const last = /last=(\S+),(\S+) conf=(\S+)/.exec(r.out);
      lines.push(`${label}: 読み込み ${m[1]} ms、追跡 ${m[2]} ms、手ぶれ補正の写し ${m[3]} ms、層の写しと重ね ${m[4]} ms（点 p0 の最後 ${last[1]},${last[2]} 信頼度 ${last[3]}）`);
      // 動きは (3, 2) 画素/コマ。19 コマ後の位置
      check(Math.abs(+last[1] - (600 - 57)) < 0.05 && Math.abs(+last[2] - (500 - 38)) < 0.05, `${label}: 追った位置 ${last[1]},${last[2]}`);
    };
    const p1 = '600,500';
    const p4 = '600,500;1300,400;500,800;1400,850';
    run(EXE, {}, 'CPU 1 点（feature 15、search 32）', p1);
    run(EXE, {}, 'CPU 4 点', p4);
    run(EXE, {}, 'CPU 4 点（feature 31、search 64）', p4, ['--feature', '31', '--search', '64']);
    if (EXE_GPU) {
      run(EXE_GPU, { UM_GPU_THRESHOLD: '1' }, 'GPU 1 点', p1);
      run(EXE_GPU, { UM_GPU_THRESHOLD: '1' }, 'GPU 4 点', p4);
      run(EXE_GPU, { UM_GPU_THRESHOLD: '1' }, 'GPU 4 点（feature 31、search 64）', p4, ['--feature', '31', '--search', '64']);
    }
    for (const l of lines) console.log(`        ${l}`);
  });

  console.log(`\n${passed} 個 ok、${failures.length} 個 NG（${((Date.now() - t0) / 1000).toFixed(1)} 秒）`);
  console.log(`絵と .trk: ${OUT}`);
  if (KEEP) console.log(`作業用のフォルダ: ${TMP}`);
}

try {
  main();
} catch (e) {
  console.error(e.stack || String(e));
  failures.push({ name: 'main', msg: String(e) });
}
cleanup();
process.exit(failures.length ? 1 : 0);
