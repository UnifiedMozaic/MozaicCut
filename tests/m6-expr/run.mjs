#!/usr/bin/env node
// エクスプレッション（src/m6_expr/）の試験。node tests/m6-expr/run.mjs で流す（npm の依存なし）。
//
// 1. src/expr_test.um をネイティブにビルドして実行する（字句・構文・型・評価・wiggle・random・loopOut・参照・
//    診断の code と列・.mzc の書き方・評価の順と輪・schema・画素の式の画像・速さ）。src/expr_testfix.um の項目
//    （lineedit.um での行の書き換え、座標、キーの時刻と値の表、種、loopIn の境目、position の順、px、% 0、sin の範囲）も含む。
// 2. 書いた画像（BMP）の画素を確かめ、schema の JSON が読めることを確かめる。
// 3. wgpu-native があれば（UM_WGPU_HOME か ~/wgpu-native/v29.0.1.1）、src/expr_gpu_test.um を UM_WGPU=1 で
//    ビルドし、画素の式の kernel が CPU と GPU で全画素一致することと、1080p の速さを確かめる。
//
// オプション: --keep（作業用のフォルダを残す）、--no-gpu（3 を飛ばす）、-v（出力を全部見せる）
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const argv = process.argv.slice(2);
const KEEP = argv.includes('--keep');
const NO_GPU = argv.includes('--no-gpu');
const VERBOSE = argv.includes('-v');
const EXE_EXT = process.platform === 'win32' ? '.exe' : '';

function umHome() {
  const cands = [process.env.UM_HOME, path.join(ROOT, '..', 'UnifiedMozaic'), path.join(ROOT, '..', '..', 'UnifiedMozaic'),
    path.join(os.homedir(), 'UnifiedMozaic')].filter(Boolean);
  for (const c of cands) {
    if (fs.existsSync(path.join(c, 'src', 'cli.ts'))) return c;
  }
  console.error('UnifiedMozaic のコンパイラが見つかりません。環境変数 UM_HOME にその場所を設定してください');
  process.exit(2);
}

function wgpuHome() {
  const cands = [process.env.UM_WGPU_HOME, path.join(os.homedir(), 'wgpu-native', 'v29.0.1.1')].filter(Boolean);
  for (const c of cands) {
    if (fs.existsSync(path.join(c, 'include', 'webgpu', 'webgpu.h')) || fs.existsSync(path.join(c, 'include', 'webgpu.h'))) return c;
  }
  return null;
}

const CLI = path.join(umHome(), 'src', 'cli.ts');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mozcut-m6-expr-'));
let passed = 0;
const failures = [];
const perf = [];

function ok(name) {
  passed++;
  console.log(`  ok   ${name}`);
}
function fail(name, why) {
  failures.push(name);
  console.log(`  FAIL ${name}: ${why}`);
}
function check(name, cond, why = '') {
  if (cond) ok(name);
  else fail(name, why);
}

function build(src, out, env = {}) {
  const r = spawnSync(process.execPath, [CLI, 'build', path.join(ROOT, src), '--target', 'host', '-o', out],
    { encoding: 'utf8', env: { ...process.env, ...env } });
  if (r.status !== 0) {
    console.log(r.stdout + r.stderr);
    return false;
  }
  return true;
}

function run(exe, args, env = {}) {
  const r = spawnSync(exe, args, { encoding: 'utf8', env: { ...process.env, ...env }, maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

// BMP（24 ビット、下から上）を読む。
function readBmp(file) {
  const b = fs.readFileSync(file);
  const off = b.readUInt32LE(10);
  const w = b.readInt32LE(18);
  const h = b.readInt32LE(22);
  const row = Math.floor((w * 3 + 3) / 4) * 4;
  return {
    w, h,
    px(x, y) {
      const i = off + (h - 1 - y) * row + x * 3;
      return [b[i + 2], b[i + 1], b[i]];
    },
  };
}

console.log('m6-expr: エクスプレッション');

// ---- 1. CPU の試験 ----
const testExe = path.join(TMP, 'expr_test' + EXE_EXT);
if (!build('src/expr_test.um', testExe)) {
  fail('build expr_test', 'ビルドできません');
} else {
  const r = run(testExe, [TMP]);
  const lines = r.out.split(/\r?\n/);
  if (VERBOSE) console.log(r.out);
  const fails = lines.filter((l) => l.startsWith('FAIL'));
  const done = lines.find((l) => l.startsWith('done '));
  check('expr_test の項目', r.status === 0 && fails.length === 0 && done, fails.join('\n') || `終了コード ${r.status}`);
  if (done) console.log(`       ${done}`);
  // 診断は日本語の文と直し方を持つ
  const diags = lines.filter((l) => l.startsWith('diag '));
  const noHint = diags.filter((l) => {
    const m = l.match(/ => (\S+) \d+:\d+ (.+?) \/ (.*?) \/ suggest=/);
    return !m || !m[2] || (!m[3] && m[1] !== 'expr-cycle');
  });
  check('診断に文と直し方がある', diags.length >= 40 && noHint.length === 0, `${diags.length} 件、直し方のないもの: ${noHint.join(' | ')}`);
  for (const l of lines.filter((x) => x.startsWith('perf ') || x.startsWith('info '))) perf.push(l.slice(5));

  // schema の JSON
  try {
    const js = JSON.parse(fs.readFileSync(path.join(TMP, 'expr_schema.json'), 'utf8'));
    const fnames = js.functions.map((f) => f.name).join(' ');
    check('schema の JSON', js.version === 1 && /wiggle/.test(fnames) && /loopOut/.test(fnames) && js.codes.length === 9 &&
      js.props.some((p) => p.name === 'position' && p.type === 'vec2'), JSON.stringify(js).slice(0, 200));
  } catch (e) {
    fail('schema の JSON', String(e));
  }
  const jsonLine = lines.find((l) => l.startsWith('json '));
  try {
    const pj = JSON.parse(jsonLine.slice(5));
    check('式の要約の JSON', pj.ok === true && pj.type === 'number' && Array.isArray(pj.refs), jsonLine);
  } catch (e) {
    fail('式の要約の JSON', String(e));
  }

  // 画素の式の画像（480x270）
  try {
    const g = readBmp(path.join(TMP, 'expr_gradient.bmp'));
    const tl = g.px(0, 0);
    const tr = g.px(479, 0);
    const bl = g.px(0, 269);
    check('gradient: 左は赤 0、右は赤 255、下は緑 255', g.w === 480 && g.h === 270 && tl[0] <= 1 && tr[0] >= 254 && bl[1] >= 254,
      `${tl} ${tr} ${bl}`);
    const v = readBmp(path.join(TMP, 'expr_vignette.bmp'));
    const c = v.px(240, 135);
    const corner = v.px(2, 2);
    check('vignette: 角はほぼ黒、真ん中は元のまま', corner[0] + corner[1] + corner[2] < 30 && c[0] + c[1] + c[2] > 150, `${corner} ${c}`);
    const gr = readBmp(path.join(TMP, 'expr_gray.bmp'));
    let grayOk = true;
    for (let y = 0; y < 270; y += 17) for (let x = 0; x < 480; x += 23) {
      const p = gr.px(x, y);
      if (p[0] !== p[1] || p[1] !== p[2]) grayOk = false;
    }
    check('gray: r = g = b', grayOk);
    const n = readBmp(path.join(TMP, 'expr_noise.bmp'));
    const seen = new Set();
    for (let y = 0; y < 270; y += 9) for (let x = 0; x < 480; x += 9) seen.add(n.px(x, y).join(','));
    check('noise: 模様がある', seen.size > 200, `${seen.size} 色`);
    const gn = readBmp(path.join(TMP, 'expr_grain.bmp'));
    let d = 0;
    for (let x = 1; x < 39; x++) d += Math.abs(gn.px(x, 5)[0] - gn.px(x - 1, 5)[0]);
    check('grain: 隣の画素で値が変わる', d > 100, `${d}`);
    const m = readBmp(path.join(TMP, 'expr_mask.bmp'));
    const dl = Math.abs(m.px(2, 2)[1] - m.px(2, 18)[1]);
    const dr = Math.abs(m.px(300, 2)[1] - m.px(300, 18)[1]);
    check('mask: 左半分は半透明（下の市松が透ける）、右半分は不透明', dl >= 10 && dr <= 2, `${dl} ${dr}`);
    const plot = readBmp(path.join(TMP, 'expr_plot.bmp'));
    let colored = 0;
    for (let x = 0; x < 800; x++) for (let y = 0; y < 300; y++) {
      const p = plot.px(x, y);
      if (!(p[0] === p[1] && p[1] === p[2])) colored++;
    }
    check('plot: 線が描かれている', colored > 4000, `${colored}`);
  } catch (e) {
    fail('画像', String(e));
  }
}

// ---- 描画につなぐ見本（expr_demo.um。center と負の x / y を解いた後の画素で式に渡す） ----
const demoExe = path.join(TMP, 'expr_demo' + EXE_EXT);
if (!build('src/expr_demo.um', demoExe)) {
  fail('build expr_demo', 'ビルドできません');
} else {
  const r = run(demoExe, [TMP]);
  if (VERBOSE) console.log(r.out);
  const frames = r.out.split(/\r?\n/).filter((l) => l.startsWith('frame '));
  const num = (l, k) => Number(l.match(new RegExp(`${k}=(\\S+)`))[1]);
  let good = r.status === 0 && frames.length === 6;
  if (good) {
    // ease で入ってきて 1 秒で止まる / dot は title に付いて動く / blink は pingpong / y は 140 の周りで揺れる
    good = num(frames[0], 'title.x') === -100 && num(frames[3], 'title.x') === 240 &&
      frames.every((l) => Math.abs(num(l, 'dot.x') - num(l, 'title.x') - 60 - 50 * Math.sin(num(l, 't') * 6)) < 1e-9) &&
      Math.abs(num(frames[1], 'blink.opacity') - 0.4) < 1e-9 && Math.abs(num(frames[4], 'blink.opacity') - 0.4) < 1e-9 &&
      frames.every((l) => Math.abs(num(l, 'title.y') - 140) <= 12 * 1.5);
  }
  check('見本: 式でクリップの値が決まり、参照と順が働く', good, r.out.slice(0, 600));
  // 座標は解いた後の画素: 負の x / y は右端・下端から、書かなければ center。式の value もその値で、結果はそのまま描く
  let coords = r.status === 0 && frames.length === 6;
  if (coords) {
    coords = frames.every((l) => num(l, 'corner.x') === 560 && num(l, 'corner.y') === 310 && num(l, 'mid.x') === 280 &&
      Math.abs(num(l, 'mid.y') - (160 + 30 * Math.sin(num(l, 't') * 4))) < 1e-9 &&
      num(l, 'tag.x') === 520 && num(l, 'tag.y') === num(l, 'mid.y'));
  }
  check('見本: center と負の x / y を解いた後の画素で式に渡す', coords, r.out.slice(0, 600));
  check('見本: 6 コマの画像', [0, 1, 2, 3, 4, 5].every((f) => fs.existsSync(path.join(TMP, `expr_demo_${f}.bmp`))));
}

// ---- 3. CPU と GPU ----
const wh = wgpuHome();
if (NO_GPU) {
  console.log('  skip GPU（--no-gpu）');
} else if (!wh) {
  console.log('  skip GPU（wgpu-native が見つかりません。UM_WGPU_HOME を設定すると試します）');
} else {
  const gpuDir = path.join(TMP, 'gpu');
  fs.mkdirSync(gpuDir);
  const gpuExe = path.join(gpuDir, 'expr_gpu_test' + EXE_EXT);
  if (!build('src/expr_gpu_test.um', gpuExe, { UM_WGPU: '1', UM_WGPU_HOME: wh })) {
    fail('build expr_gpu_test', 'UM_WGPU=1 でビルドできません');
  } else {
    const r = run(gpuExe, [gpuDir]);
    if (VERBOSE) console.log(r.out);
    const lines = r.out.split(/\r?\n/);
    for (const l of lines.filter((x) => x.startsWith('ok gpu') || x.startsWith('FAIL gpu'))) {
      check(l.replace(/^(ok|FAIL) /, '').split(':')[0], l.startsWith('ok'), l);
    }
    const done = lines.find((l) => l.startsWith('done gpu'));
    check('CPU と GPU の比較が最後まで動く', r.status === 0 && done, r.out.slice(-400));
    for (const l of lines.filter((x) => x.startsWith('perf '))) perf.push(l.slice(5));
  }
}

if (perf.length) {
  console.log('速さ:');
  for (const p of perf) console.log(`  ${p}`);
}
console.log(`${passed} 通過、${failures.length} 失敗`);
if (KEEP) console.log(`作業用のフォルダ: ${TMP}`);
else fs.rmSync(TMP, { recursive: true, force: true });
process.exit(failures.length ? 1 : 0);
