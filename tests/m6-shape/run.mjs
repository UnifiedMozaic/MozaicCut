#!/usr/bin/env node
// シェイプレイヤー（src/m6_shape/）のテスト。node tests/m6-shape/run.mjs で実行する（npm の依存なし）。
//
// 1. 一時フォルダに <tmp>/shape_test.um、<tmp>/m6_shape/*.um、<tmp>/text.um（色・時間の読み取りはコアと同じもの）を
//    写して、CPU 版をビルドする（UM の import は main のフォルダの中だけなので、src/ の外の試しの main からは写しで読む）。
// 2. shape_test check: 面積・端の画素・evenodd・線の端と角・トリム・破線・点線・グラデーション・読み取りの誤り。
// 3. 場面（showcase / placement / drawon / full / repeater）を BMP に描き、ハッシュを出す。キャンバスへ直接描いたものと、
//    層に描いてから重ねたもの（効果のあるクリップの経路）が f32 の値まで同じことも確かめる。
// 4. wgpu-native があれば（UM_WGPU_HOME。既定 C:\Users\mozuku\wgpu-native\v29.0.1.1）GPU 版もビルドし、
//    UM_GPU_THRESHOLD=1（すべての kernel を GPU）で同じ場面を描いて、CPU 版と 1 ビットも違わないことを確かめる
//    （f32 の値を 2^24 倍した整数のハッシュと、BMP のバイト列の両方）。
// 5. --bench なら 1920x1080 の 1 コマの時間を CPU / GPU で測る（使い回す = 形が止まっているコマ、
//    毎コマ作り直す = 形が動くコマ）。
//
// オプション: --bench（速さを測る）、--keep（作業用のフォルダを残す）、--out <dir>（BMP を書く場所。既定は作業用のフォルダ）、
//             --no-gpu（GPU 版を試さない）
// 環境変数: UM_HOME（UnifiedMozaic の場所。既定はこのリポジトリの隣か C:/Users/mozuku/UnifiedMozaic）
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const argv = process.argv.slice(2);
const BENCH = argv.includes('--bench');
const KEEP = argv.includes('--keep');
const NO_GPU = argv.includes('--no-gpu');
const outIdx = argv.indexOf('--out');
const EXT = process.platform === 'win32' ? '.exe' : '';

function findUm() {
  const cands = [process.env.UM_HOME, path.resolve(ROOT, '..', 'UnifiedMozaic'), path.resolve(ROOT, '..', '..', 'UnifiedMozaic'), 'C:/Users/mozuku/UnifiedMozaic'];
  for (const c of cands) {
    if (c && fs.existsSync(path.join(c, 'src', 'cli.ts'))) return c;
  }
  console.error('UnifiedMozaic が見つかりません（UM_HOME で場所を指定します）');
  process.exit(2);
}
const UM = findUm();
const CLI = path.join(UM, 'src', 'cli.ts');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mozcut-shape-'));
const OUT = outIdx >= 0 ? path.resolve(argv[outIdx + 1]) : TMP;
fs.mkdirSync(OUT, { recursive: true });

let passed = 0;
const failures = [];
function ok(name) {
  passed++;
  console.log(`  ok  ${name}`);
}
function ng(name, msg) {
  failures.push(name);
  console.log(`  NG  ${name}: ${msg}`);
}

// ---- 写してビルド ----
const stage = path.join(TMP, 'stage');
fs.mkdirSync(path.join(stage, 'm6_shape'), { recursive: true });
for (const f of fs.readdirSync(path.join(ROOT, 'src', 'm6_shape'))) {
  if (f.endsWith('.um')) fs.copyFileSync(path.join(ROOT, 'src', 'm6_shape', f), path.join(stage, 'm6_shape', f));
}
fs.copyFileSync(path.join(HERE, 'shape_test.um'), path.join(stage, 'shape_test.um'));
fs.copyFileSync(path.join(ROOT, 'src', 'text.um'), path.join(stage, 'text.um'));

function build(out, env) {
  const r = spawnSync(process.execPath, [CLI, 'build', path.join(stage, 'shape_test.um'), '--target', 'host', '-o', out], {
    env: { ...process.env, ...env }, encoding: 'utf8',
  });
  if (r.status !== 0) {
    console.error(r.stdout + r.stderr);
    return false;
  }
  return true;
}
function run(exe, args, env = {}) {
  const r = spawnSync(exe, args, { env: { ...process.env, ...env }, encoding: 'utf8', maxBuffer: 64 << 20 });
  return { status: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

console.log('ビルド（CPU）');
const cpuExe = path.join(TMP, 'shape_cpu' + EXT);
if (!build(cpuExe, { UM_WGPU: '', UM_METAL: '' })) {
  ng('build-cpu', 'ビルドできません');
  finish();
}
ok('build-cpu');

console.log('確かめ（check）');
{
  const r = run(cpuExe, ['check']);
  const last = r.out.trim().split('\n').pop();
  if (r.status === 0) ok(`check: ${last}`);
  else ng('check', '\n' + r.out);
}

// 名前、時刻、描き方（'' はできるときキャンバスへ直接、'--layer' はいつも層に塗ってから重ねる）
const SCENES = [
  ['showcase', '1', ''], ['placement', '1', ''], ['drawon', '0', ''], ['full', '1', ''], ['repeater', '1', ''], ['ring1000', '1', ''],
  ['showcase', '1', '--layer'], ['placement', '1', '--layer'], ['drawon', '0', '--layer'], ['repeater', '1', '--layer'],
];
const cpuHash = {};
console.log('場面（CPU）');
for (const [s, t, mode] of SCENES) {
  const key = s + (mode ? '-layer' : '');
  const bmp = path.join(OUT, `shape-${key}-cpu.bmp`);
  const r = run(cpuExe, ['scene', s, bmp, t, ...(mode ? [mode] : [])]);
  const m = /scene \S+: bmp (\d+) exact (\d+)/.exec(r.out);
  if (r.status === 0 && m && fs.existsSync(bmp)) {
    cpuHash[key] = { bmp: m[1], exact: m[2], file: bmp };
    ok(`scene ${key}（${bmp}）`);
  } else {
    ng(`scene ${key}`, r.out);
  }
}

// 直接と層の経路は同じ値
for (const s of ['showcase', 'placement', 'drawon', 'repeater']) {
  const a = cpuHash[s];
  const b = cpuHash[s + '-layer'];
  if (!a || !b) continue;
  if (a.exact === b.exact) ok(`直接 = 層: ${s}（f32 の値も同じ）`);
  else ng(`直接 = 層: ${s}`, `${a.exact} / ${b.exact}`);
}

// ---- GPU ----
const WGPU_HOME = process.env.UM_WGPU_HOME || 'C:\\Users\\mozuku\\wgpu-native\\v29.0.1.1';
const gpuExe = path.join(TMP, 'shape_gpu' + EXT);
let haveGpu = false;
if (!NO_GPU && fs.existsSync(WGPU_HOME)) {
  console.log('ビルド（GPU: wgpu）');
  if (build(gpuExe, { UM_WGPU: '1', UM_WGPU_HOME: WGPU_HOME })) {
    haveGpu = true;
    ok('build-gpu');
  } else {
    ng('build-gpu', 'ビルドできません');
  }
} else {
  console.log('wgpu-native がないので GPU の試しは飛ばします');
}
if (haveGpu) {
  console.log('場面（GPU、UM_GPU_THRESHOLD=1）と CPU との比べ');
  for (const [s, t, mode] of SCENES) {
    const key = s + (mode ? '-layer' : '');
    const bmp = path.join(OUT, `shape-${key}-gpu.bmp`);
    const r = run(gpuExe, ['scene', s, bmp, t, ...(mode ? [mode] : [])], { UM_GPU_THRESHOLD: '1', UM_WGPU_HOME: WGPU_HOME });
    const m = /scene \S+: bmp (\d+) exact (\d+)/.exec(r.out);
    if (r.status !== 0 || !m) {
      ng(`gpu scene ${key}`, r.out);
      continue;
    }
    const c = cpuHash[key];
    if (!c) continue;
    const same = fs.readFileSync(bmp).equals(fs.readFileSync(c.file));
    if (m[2] === c.exact && same) ok(`gpu = cpu: ${key}（f32 の値も BMP も同じ）`);
    else ng(`gpu = cpu: ${key}`, `exact ${m[2]} / ${c.exact}、BMP ${same ? '同じ' : '違う'}`);
  }
  // check も GPU で（面積の値が同じこと）
  const r = run(gpuExe, ['check'], { UM_GPU_THRESHOLD: '1', UM_WGPU_HOME: WGPU_HOME });
  if (r.status === 0) ok('check（GPU）');
  else ng('check（GPU）', r.out);
}

// ---- 速さ ----
if (BENCH) {
  console.log('速さ（1920x1080、1 コマ）');
  const benches = [['simple', 60], ['showcase', 20], ['full', 20], ['repeater', 20], ['ring200', 20], ['ring1000', 10], ['dots', 5], ['stars', 5]];
  for (const [s, n] of benches) {
    for (const mode of [[], ['--nocache'], ['--layer', '--nocache']]) {
      const r = run(cpuExe, ['bench', s, String(n), ...mode]);
      console.log(`  CPU ${r.out.trim()}`);
      if (haveGpu) {
        const g = run(gpuExe, ['bench', s, String(n), ...mode], { UM_GPU_THRESHOLD: '1', UM_WGPU_HOME: WGPU_HOME });
        console.log(`  GPU ${g.out.trim()}`);
      }
    }
  }
}

finish();

function finish() {
  console.log(`\n合格 ${passed} 個、不合格 ${failures.length} 個${failures.length ? '（' + failures.join(', ') + '）' : ''}`);
  if (!KEEP && outIdx < 0) fs.rmSync(TMP, { recursive: true, force: true });
  else console.log(`作業用のフォルダ: ${TMP}`);
  process.exit(failures.length ? 1 : 0);
}
