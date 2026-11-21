#!/usr/bin/env node
// テキストアニメーター（src/m6_textanim/）の試し。npm の依存はない。
//
//   node tests/m6-textanim/run.mjs [--out <フォルダ>] [--frames N] [--no-gpu] [--png]
//
// 1. src/textanim_test.um を CPU 版（--target host）でビルドして動かし、CHECK の行がすべて ok であること。
// 2. wgpu-native があれば GPU 版（UM_WGPU=1）もビルドし、UM_GPU_THRESHOLD=65536（大きい dispatch は GPU）で動かして、
//    書いた BMP が CPU 版と許容差（1 色 1/255）の中にあること。1 バイトも違わないか（HASH の行と BMP）も数えて出す。
//    WGSL では f32 の割り算と sqrt の丸めや FMA へのまとめ方が GPU ごとに違ってよいので、合否は許容差で決める
//    （RTX 5060 Ti の Vulkan / DX12 では 1 バイトも違わなかった）。
// 3. TIME の行（1080p の 1 コマのミリ秒）を並べて出す。
//
// UnifiedMozaic の場所: 環境変数 UM_HOME、なければこのリポジトリの隣・その上の隣・ホームフォルダの UnifiedMozaic。
// wgpu-native の場所: 環境変数 UM_WGPU_HOME、なければ ~/wgpu-native/v29.0.1.1。
// 結果の画像（BMP。--png なら PNG も）は --out のフォルダ（既定は一時フォルダの mozcut-m6-textanim）の cpu/ と gpu/ に残す。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const EXT = process.platform === 'win32' ? '.exe' : '';
const argv = process.argv.slice(2);
const opt = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : def;
};
const OUT = path.resolve(opt('--out', path.join(os.tmpdir(), 'mozcut-m6-textanim')));
const FRAMES = opt('--frames', '30');
const NO_GPU = argv.includes('--no-gpu');
const PNG = argv.includes('--png');

function findUm() {
  const cands = [
    process.env.UM_HOME,
    path.join(ROOT, '..', 'UnifiedMozaic'),
    path.join(ROOT, '..', '..', 'UnifiedMozaic'),
    path.join(os.homedir(), 'UnifiedMozaic'),
  ].filter(Boolean);
  for (const c of cands) {
    if (fs.existsSync(path.join(c, 'src', 'cli.ts'))) {
      return c;
    }
  }
  console.error(`UnifiedMozaic が見つかりません（探した場所: ${cands.join(', ')}）。環境変数 UM_HOME で指定してください`);
  process.exit(2);
}

function findWgpu() {
  const cands = [process.env.UM_WGPU_HOME, path.join(os.homedir(), 'wgpu-native', 'v29.0.1.1')].filter(Boolean);
  for (const c of cands) {
    if (fs.existsSync(path.join(c, 'include'))) {
      return c;
    }
  }
  return null;
}

const UM = findUm();
const CLI = path.join(UM, 'src', 'cli.ts');

function build(outExe, env) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [CLI, 'build', path.join(ROOT, 'src', 'textanim_test.um'), '--target', 'host', '-o', outExe], {
    cwd: ROOT, env: { ...process.env, ...env }, encoding: 'utf8',
  });
  if (r.status !== 0) {
    console.error(r.stdout + r.stderr);
    console.error(`ビルドに失敗しました: ${outExe}`);
    process.exit(1);
  }
  return Date.now() - t0;
}

function run(exe, dir, env) {
  fs.mkdirSync(dir, { recursive: true });
  const r = spawnSync(exe, [dir, FRAMES], { env: { ...process.env, ...env }, encoding: 'utf8', maxBuffer: 64 << 20 });
  if (r.status !== 0) {
    console.error(r.stdout + r.stderr);
    console.error(`実行に失敗しました: ${exe}（終了コード ${r.status}）`);
    process.exit(1);
  }
  const lines = r.stdout.split(/\r?\n/);
  const checks = [];
  const hashes = new Map();
  const times = new Map();
  for (const l of lines) {
    let m;
    if ((m = /^CHECK (\S+) (ok|ng) ?(.*)$/.exec(l))) {
      checks.push({ name: m[1], ok: m[2] === 'ok', msg: m[3] });
    } else if ((m = /^HASH (\S+) (\S+)$/.exec(l))) {
      hashes.set(m[1], m[2]);
    } else if ((m = /^TIME (\S+) (\S+)$/.exec(l))) {
      times.set(m[1], Number(m[2]));
    }
  }
  return { checks, hashes, times, stdout: r.stdout };
}

// ---- BMP → PNG（見るため） ----
function readBmp(p) {
  const b = fs.readFileSync(p);
  const off = b.readUInt32LE(10);
  const w = b.readInt32LE(18);
  let h = b.readInt32LE(22);
  const bp = b.readUInt16LE(28) / 8;
  const flip = h > 0;
  h = Math.abs(h);
  const stride = Math.ceil((w * bp) / 4) * 4;
  const px = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    const sy = flip ? h - 1 - y : y;
    for (let x = 0; x < w; x++) {
      const s = off + sy * stride + x * bp;
      px[(y * w + x) * 3] = b[s + 2];
      px[(y * w + x) * 3 + 1] = b[s + 1];
      px[(y * w + x) * 3 + 2] = b[s];
    }
  }
  return { w, h, px };
}

function crc32(buf) {
  let r = 0xffffffff;
  for (const x of buf) {
    r ^= x;
    for (let k = 0; k < 8; k++) {
      r = r & 1 ? 0xedb88320 ^ (r >>> 1) : r >>> 1;
    }
  }
  return (r ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4);
  c.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, c]);
}

function bmpToPng(src, dst) {
  const { w, h, px } = readBmp(src);
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    px.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3);
  }
  const ih = Buffer.alloc(13);
  ih.writeUInt32BE(w, 0);
  ih.writeUInt32BE(h, 4);
  ih[8] = 8;
  ih[9] = 2;
  fs.writeFileSync(dst, Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', ih), pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]));
}

// ---- 本体 ----
let failed = 0;
fs.mkdirSync(OUT, { recursive: true });
console.log(`UnifiedMozaic: ${UM}`);
console.log(`出力: ${OUT}`);

const cpuExe = path.join(OUT, 'textanim_cpu' + EXT);
console.log(`CPU 版をビルド（${build(cpuExe, { UM_WGPU: '' })} ms）`);
const cpu = run(cpuExe, path.join(OUT, 'cpu'), {});
for (const c of cpu.checks) {
  console.log(`  ${c.ok ? 'ok' : '不合格'}  ${c.name}  ${c.msg}`);
  if (!c.ok) {
    failed++;
  }
}
if (cpu.checks.length < 50) {
  console.log(`  不合格  確かめた数が少なすぎます（${cpu.checks.length}）`);
  failed++;
}

let gpu = null;
const wgpu = NO_GPU ? null : findWgpu();
if (wgpu) {
  const gpuExe = path.join(OUT, 'gpu', 'textanim_gpu' + EXT);
  fs.mkdirSync(path.dirname(gpuExe), { recursive: true });
  console.log(`GPU 版（wgpu）をビルド（${build(gpuExe, { UM_WGPU: '1', UM_WGPU_HOME: wgpu })} ms）`);
  gpu = run(gpuExe, path.join(OUT, 'gpu'), { UM_GPU_THRESHOLD: '65536' });
  for (const c of gpu.checks) {
    if (!c.ok) {
      console.log(`  不合格（GPU）  ${c.name}  ${c.msg}`);
      failed++;
    }
  }
  // ハッシュ（1 バイトも違わないか。数えて出すだけ）
  let same = 0;
  let diffHash = 0;
  for (const [k, v] of cpu.hashes) {
    if (gpu.hashes.get(k) !== v) {
      console.log(`  注意  CPU と GPU でハッシュが違います: ${k}（CPU ${v} / GPU ${gpu.hashes.get(k)}）。合否は BMP の許容差で決めます`);
      diffHash++;
    } else {
      same++;
    }
  }
  // BMP: 1 バイトも違わない / 許容差（1/255）の中 / 外（不合格）
  let exact = 0;
  let within = 0;
  for (const f of fs.readdirSync(path.join(OUT, 'cpu')).filter((f) => f.endsWith('.bmp'))) {
    const a = fs.readFileSync(path.join(OUT, 'cpu', f));
    const g = path.join(OUT, 'gpu', f);
    if (!fs.existsSync(g)) {
      console.log(`  不合格  GPU 版の BMP がありません: ${f}`);
      failed++;
      continue;
    }
    const b = fs.readFileSync(g);
    if (a.equals(b)) {
      exact++;
      continue;
    }
    let maxD = a.length === b.length ? 0 : 255;
    let nDiff = 0;
    if (a.length === b.length) {
      for (let i = 54; i < a.length; i++) {
        const d = Math.abs(a[i] - b[i]);
        if (d > 0) {
          nDiff++;
        }
        maxD = Math.max(maxD, d);
      }
    }
    if (maxD <= 1) {
      within++;
      console.log(`  注意  ${f}: CPU と GPU で ${nDiff} バイトが 1/255 違う（許容差の中）`);
    } else {
      console.log(`  不合格  CPU と GPU で BMP が違います: ${f}（最大 ${maxD}/255、${nDiff} バイト）`);
      failed++;
    }
  }
  console.log(`  ok  CPU と GPU: ハッシュ ${same} 個と BMP ${exact} 枚が 1 バイトも違わない（ハッシュの違い ${diffHash} 個、許容差の中の BMP ${within} 枚）`);
} else {
  console.log(NO_GPU ? 'GPU 版は飛ばしました（--no-gpu）' : 'wgpu-native が見つからないので、GPU 版は飛ばしました（UM_WGPU_HOME で指定）');
}

console.log('1080p の 1 コマ（ミリ秒）:');
for (const [k, v] of cpu.times) {
  const g = gpu ? gpu.times.get(k) : undefined;
  console.log(`  ${k.padEnd(28)} CPU ${v.toFixed(2).padStart(7)}${g !== undefined ? `   GPU ${g.toFixed(2).padStart(7)}` : ''}`);
}

if (PNG) {
  for (const d of ['cpu', 'gpu']) {
    const dir = path.join(OUT, d);
    if (!fs.existsSync(dir)) {
      continue;
    }
    for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.bmp'))) {
      bmpToPng(path.join(dir, f), path.join(dir, f.replace(/\.bmp$/, '.png')));
    }
  }
  console.log(`PNG を書きました: ${path.join(OUT, 'cpu')}`);
}

if (failed > 0) {
  console.log(`不合格 ${failed} 件`);
  process.exit(1);
}
console.log('すべて合格');
