#!/usr/bin/env node
// 3D レイヤーとカメラ（src/effects/threed/）の試験。npm の依存はない。
//
//   node tests/m6-threed/run.mjs            CPU で単体の確かめと場面の画像。wgpu-native があれば GPU でも実行し、
//                                           CPU と GPU の画素（16 ビット）と検算の値がすべて同じことを確かめる
//   node tests/m6-threed/run.mjs --bench    1920x1080 の 1 コマの速さも測る（CPU・GPU・自動判断）
//   node tests/m6-threed/run.mjs --out <dir>  画像（ring / blur / dof / many / heavy の BMP）を書く場所（既定は一時フォルダ）
//
// UnifiedMozaic の場所は UM_HOME（既定は ../UnifiedMozaic）。GPU は UM_WGPU_HOME（wgpu-native を展開した場所）があれば使う。
// GPU の実行は UM_GPU_THRESHOLD=1（どの dispatch も GPU）、CPU の実行は UM_GPU=0。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = path.join(ROOT, 'src', 'effects', 'threed', 'threed_test.um');
const argv = process.argv.slice(2);
const BENCH = argv.includes('--bench');
const outAt = argv.indexOf('--out');
const OUT = outAt >= 0 ? path.resolve(argv[outAt + 1]) : fs.mkdtempSync(path.join(os.tmpdir(), 'mozcut-threed-'));
const EXE_NAME = 'threed_test' + (process.platform === 'win32' ? '.exe' : '');

function umHome() {
  const cands = [process.env.UM_HOME, path.join(ROOT, '..', 'UnifiedMozaic'), path.join(ROOT, '..', '..', 'UnifiedMozaic')];
  for (const c of cands) {
    if (c && fs.existsSync(path.join(c, 'src', 'cli.ts'))) return c;
  }
  console.error('UnifiedMozaic が見つかりません（UM_HOME で場所を指定してください）');
  process.exit(2);
}

let failures = 0;
function check(ok, msg) {
  console.log((ok ? 'ok ' : 'NG ') + msg);
  if (!ok) failures++;
}

function build(dir, gpu) {
  fs.mkdirSync(dir, { recursive: true });
  const exe = path.join(dir, EXE_NAME);
  const env = { ...process.env };
  if (gpu) env.UM_WGPU = '1';
  else delete env.UM_WGPU;
  const r = spawnSync(process.execPath, [path.join(umHome(), 'src', 'cli.ts'), 'build', SRC, '--target', 'host', '-o', exe], { env, encoding: 'utf8' });
  if (r.status !== 0) {
    console.error(r.stdout + r.stderr);
    check(false, `ビルド（${gpu ? 'wgpu' : 'CPU'}）`);
    return null;
  }
  return exe;
}

function run(exe, outDir, extraEnv, bench) {
  fs.mkdirSync(outDir, { recursive: true });
  const env = { ...process.env, ...extraEnv };
  const args = bench ? [outDir, 'bench'] : [outDir];
  const r = spawnSync(exe, args, { env, encoding: 'utf8', timeout: 600000 });
  return { status: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

function sums(text) {
  const m = {};
  for (const line of text.split(/\r?\n/)) {
    const g = /^sum (\S+) (\S+)/.exec(line);
    if (g) m[g[1]] = g[2];
  }
  return m;
}

function cmpRaw(a, b) {
  const x = fs.readFileSync(a);
  const y = fs.readFileSync(b);
  if (x.length !== y.length) return { diff: -1, max: 0 };
  let diff = 0;
  let max = 0;
  for (let i = 0; i < x.length; i += 2) {
    const d = Math.abs(x.readUInt16LE(i) - y.readUInt16LE(i));
    if (d) {
      diff++;
      if (d > max) max = d;
    }
  }
  return { diff, max };
}

// BMP の中央の画素が背景（試験の場面の空の色）だけでないこと（何か描かれていること）
function bmpHasContent(file) {
  const b = fs.readFileSync(file);
  const off = b.readUInt32LE(10);
  const w = b.readInt32LE(18);
  const h = b.readInt32LE(22);
  const row = Math.floor((w * 3 + 3) / 4) * 4;
  let bright = 0;
  for (let y = 0; y < h; y += 4) {
    for (let x = 0; x < w; x += 4) {
      const k = off + y * row + x * 3;
      if (b[k] + b[k + 1] + b[k + 2] > 450) bright++;
    }
  }
  return bright > 100;
}

const SCENES = ['ring', 'blur', 'dof', 'many', 'heavy'];

// ---- CPU ----
const cpuExe = build(path.join(OUT, 'bin-cpu'), false);
let cpuSums = null;
if (cpuExe) {
  const r = run(cpuExe, path.join(OUT, 'cpu'), {}, false);
  process.stdout.write(r.out.split(/\r?\n/).filter((l) => l.startsWith('NG') || l.startsWith('sum')).map((l) => '  ' + l + '\n').join(''));
  check(r.status === 0, `CPU の単体の確かめ（${(r.out.match(/^ok /gm) || []).length} 件）`);
  cpuSums = sums(r.out);
  for (const s of SCENES) {
    const f = path.join(OUT, 'cpu', s + '.bmp');
    check(fs.existsSync(f) && bmpHasContent(f), `場面 ${s} の画像（${f}）`);
  }
}

// ---- GPU（wgpu） ----
const hasWgpu = !!process.env.UM_WGPU_HOME && fs.existsSync(process.env.UM_WGPU_HOME);
let gpuExe = null;
if (!hasWgpu) {
  console.log('-- UM_WGPU_HOME がないので、GPU の試験は飛ばします');
} else {
  gpuExe = build(path.join(OUT, 'bin-gpu'), true);
  if (gpuExe) {
    // 同じバイナリの CPU（UM_GPU=0）と GPU（UM_GPU_THRESHOLD=1）
    const rc = run(gpuExe, path.join(OUT, 'gpu-cpu'), { UM_GPU: '0' }, false);
    const rg = run(gpuExe, path.join(OUT, 'gpu'), { UM_GPU_THRESHOLD: '1', UM_GPU_TRACE: '1' }, false);
    check(rc.status === 0, 'wgpu のビルドを CPU で実行');
    check(rg.status === 0, 'wgpu のビルドを GPU で実行');
    check(/^wgpu: .*\(/m.test(rg.out) && /dispatch/.test(rg.out), 'GPU で kernel を実行した（UM_GPU_TRACE）');
    const sc = sums(rc.out);
    const sg = sums(rg.out);
    for (const s of SCENES) {
      check(sc[s] !== undefined && sc[s] === sg[s] && (!cpuSums || cpuSums[s] === sg[s]), `場面 ${s} の検算の値が CPU と GPU で同じ（${sg[s]}）`);
      const c = cmpRaw(path.join(OUT, 'gpu-cpu', s + '.raw16'), path.join(OUT, 'gpu', s + '.raw16'));
      check(c.diff === 0, `場面 ${s} の画素が CPU と GPU で同じ（違う値 ${c.diff} 個）`);
    }
  }
}

// ---- 速さ ----
if (BENCH) {
  const exe = gpuExe || cpuExe;
  if (exe) {
    const modes = gpuExe
      ? [['CPU（UM_GPU=0）', { UM_GPU: '0' }], ['GPU（UM_GPU_THRESHOLD=1）', { UM_GPU_THRESHOLD: '1' }], ['自動判断', {}]]
      : [['CPU', {}]];
    for (const [name, env] of modes) {
      const r = run(exe, path.join(OUT, 'bench'), env, true);
      console.log(`-- ${name}`);
      process.stdout.write(r.out.split(/\r?\n/).filter((l) => l.startsWith('bench')).map((l) => '  ' + l.slice(6) + '\n').join(''));
      check(r.status === 0, `速さの計測（${name}）`);
    }
  }
}

console.log(`画像: ${path.join(OUT, gpuExe ? 'gpu' : 'cpu')}`);
if (failures > 0) {
  console.log(`失敗 ${failures} 件`);
  process.exit(1);
}
console.log('すべて通りました');
