#!/usr/bin/env node
// 2D の変形（src/effects/xform/、rotation / scale / anchor を video / image / text / color に効かせる）の試験。npm の依存はない。
//
//   node tests/m6-xform/run.mjs           エンジン（src/main.um）を一時フォルダに CPU 版でビルドして確かめる:
//                                         - 2D の行の rotation / scale / anchor に key-ignored を出さない
//                                         - anchor だけ（整数）は、同じだけ x / y をずらしたのと 1 バイトも違わない
//                                         - rotation=360 は回さないのと、正方形の rotation=90 は回さないのと同じ
//                                         - 回した絵は回さない絵と違う（変形が効いている）
//                                         wgpu-native があれば（UM_WGPU_HOME）GPU 版もビルドし、UM_GPU_THRESHOLD=1 で
//                                         同じ場面を描いて、CPU 版と BMP が 1 バイトも違わないことを確かめる
//   --keep                                 作業用のフォルダを残す
//   --no-gpu                               GPU 版を試さない
//
// 環境変数: UM_HOME（UnifiedMozaic の場所。既定はこのリポジトリの隣）、UM_WGPU_HOME（wgpu-native）
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const argv = process.argv.slice(2);
const KEEP = argv.includes('--keep');
const NO_GPU = argv.includes('--no-gpu');
const EXT = process.platform === 'win32' ? '.exe' : '';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mozcut-xform-'));

function umHome() {
  const cands = [process.env.UM_HOME, path.join(ROOT, '..', 'UnifiedMozaic'), path.join(ROOT, '..', '..', 'UnifiedMozaic')];
  for (const c of cands) {
    if (c && fs.existsSync(path.join(c, 'src', 'cli.ts'))) return c;
  }
  console.error('UnifiedMozaic が見つかりません（UM_HOME で場所を指定してください）');
  process.exit(2);
}

let passed = 0;
let failed = 0;
function check(ok, msg, detail = '') {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? 'ok ' : 'NG '} ${msg}${!ok && detail ? `\n    ${detail}` : ''}`);
}

function build(name, env) {
  const exe = path.join(TMP, name, 'mozcut' + EXT);
  fs.mkdirSync(path.dirname(exe), { recursive: true });
  const r = spawnSync(process.execPath, [path.join(umHome(), 'src', 'cli.ts'), 'build', path.join(ROOT, 'src', 'main.um'), '--target', 'host', '-o', exe],
    { encoding: 'utf8', env: { ...process.env, ...env }, maxBuffer: 1 << 26 });
  if (r.status !== 0) {
    console.error(`${r.stdout}${r.stderr}`);
    return null;
  }
  return exe;
}

function run(exe, args, env = {}) {
  return spawnSync(exe, args, { encoding: 'utf8', env: { ...process.env, ...env }, maxBuffer: 1 << 26 });
}

// 画像の素材（PAM、RGBA、ストレートアルファ。縁は半透明、所々透明。tests/run.mjs の golden と同じ模様）
function writePam(file, w, h) {
  const px = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      px[o] = (x * 30) % 256;
      px[o + 1] = (y * 40) % 256;
      px[o + 2] = 128 + ((x * y) % 100);
      px[o + 3] = (x + y) % 5 === 0 ? 0 : (x < 2 || y < 2 || x >= w - 2 || y >= h - 2) ? 128 : 255;
    }
  }
  fs.writeFileSync(file, Buffer.concat([Buffer.from(`P7\nWIDTH ${w}\nHEIGHT ${h}\nDEPTH 4\nMAXVAL 255\nTUPLTYPE RGB_ALPHA\nENDHDR\n`), px]));
}

// 場面の .mzc とキャッシュ（画像は plan が並べた場所に 24x16 の PAM を書く）を作る。
let seq = 0;
function scene(exe, body) {
  const dir = path.join(TMP, `s${++seq}`);
  const cache = path.join(dir, 'cache');
  fs.mkdirSync(cache, { recursive: true });
  fs.writeFileSync(path.join(cache, 'probe.txt'), 'media/logo.png\tnan\t1\t0\n');
  const file = path.join(dir, 'p.mzc');
  // 下地は 0 番のトラック。試すクリップは track=1 に置く（0 番に書くと下地の後ろに並ぶ）
  fs.writeFileSync(file, `project size=96x54 fps=30 bg=101018\ncolor 202040 dur=2\n${body}\n`);
  const r = run(exe, ['plan', file, cache]);
  if (r.status !== 0) throw new Error(`plan が失敗しました\n${r.stderr}`);
  for (const line of r.stdout.split(/\r?\n/)) {
    const f = line.split('\t');
    if (f[0] === 'image') writePam(f[4], 24, 16);
  }
  return { dir, file, cache };
}

function preview(exe, s, t, out, env = {}) {
  const r = run(exe, ['preview', s.file, s.cache, String(t), out], env);
  if (r.status !== 0) throw new Error(`preview が終了コード ${r.status} で終わりました\n${r.stderr}`);
  return fs.readFileSync(out);
}

function same(a, b) {
  return Buffer.compare(a, b) === 0;
}

const CPU = build('cpu', { UM_WGPU: '', UM_METAL: '' });
if (!CPU) {
  check(false, 'ビルド（CPU）');
  process.exit(1);
}
check(true, 'ビルド（CPU）');

// 1. 診断: 2D の行の rotation / scale / anchor に key-ignored を出さない
{
  const s = scene(CPU, 'color ff8000 track=1 dur=2 w=20 h=10 rotation=45 scale=2,1 anchor=4,2\nimage "media/logo.png" dur=2 rotation="0@0 90@1"');
  const r = run(CPU, ['check', s.file, s.cache, '--json']);
  check(r.status === 0 && !r.stdout.includes('key-ignored'), '2D の行の rotation / scale / anchor に key-ignored を出さない', r.stdout.slice(0, 400));
}

// 2. 値の決まった場合（1 バイトも違わない）
const pairs = [
  ['color の anchor=3,2 は x / y を 3, 2 ずらしたのと同じ',
    'color ff8000 track=1 dur=2 w=20 h=10 x=10 y=10 anchor=3,2 opacity=0.8', 'color ff8000 track=1 dur=2 w=20 h=10 x=7 y=8 opacity=0.8'],
  ['image の anchor=-5,4 は x / y を -5, 4 ずらしたのと同じ',
    'image "media/logo.png" track=1 dur=2 x=30 y=20 anchor=-5,4', 'image "media/logo.png" track=1 dur=2 x=35 y=16'],
  ['rotation=360 は回さないのと同じ',
    'image "media/logo.png" track=1 dur=2 x=30 y=20 rotation=360', 'image "media/logo.png" track=1 dur=2 x=30 y=20'],
  ['正方形の color の rotation=90 は回さないのと同じ',
    'color 00ff80 track=1 dur=2 w=20 h=20 x=40 y=10 rotation=90', 'color 00ff80 track=1 dur=2 w=20 h=20 x=40 y=10'],
];
for (const [name, a, b] of pairs) {
  try {
    const sa = scene(CPU, a);
    const sb = scene(CPU, b);
    check(same(preview(CPU, sa, 0.5, path.join(sa.dir, 'a.bmp')), preview(CPU, sb, 0.5, path.join(sb.dir, 'b.bmp'))), name);
  } catch (e) {
    check(false, name, e.message);
  }
}

// 3. 変形が効いている（回した・拡大した絵は、回さない絵と違う）
for (const [name, a, b] of [
  ['image の rotation=30 は回さない絵と違う', 'image "media/logo.png" track=1 dur=2 x=30 y=20 rotation=30', 'image "media/logo.png" track=1 dur=2 x=30 y=20'],
  ['color の scale=1.5 は拡大しない絵と違う', 'color ff8000 track=1 dur=2 w=20 h=10 x=10 y=10 scale=1.5', 'color ff8000 track=1 dur=2 w=20 h=10 x=10 y=10'],
]) {
  const sa = scene(CPU, a);
  const sb = scene(CPU, b);
  check(!same(preview(CPU, sa, 0.5, path.join(sa.dir, 'a.bmp')), preview(CPU, sb, 0.5, path.join(sb.dir, 'b.bmp'))), name);
}

// 4. GPU: CPU と同じ BMP
const SCENES = [
  ['回る・拡大する画像と色、基準点、縮めてぼかした板',
    'image "media/logo.png" track=1 dur=2 x=-8 y=6 rotation="-20@0 70@2" scale=1.5,1\n' +
    'color ff8000 track=2 dur=2 w=20 h=10 x=40 y=-6 rotation="0@0 180@2" anchor=-10,-5 opacity=0.8\n' +
    'color 00ff80 track=3 dur=2 w=30 h=30 x=-4 y=-4 rotation=10 scale=0.3 blur=2'],
  ['描画モード・マスク・左右反転', 'image "media/logo.png" track=1 dur=2 id=im x=30 y=10 w=48 rotation=30 scale=-1,1 blend=screen\n' +
    'mask ellipse to=im units=norm x=0.1 y=0.1 w=0.8 h=0.6 feather=0.1'],
];
const WGPU_HOME = process.env.UM_WGPU_HOME;
if (NO_GPU || !WGPU_HOME || !fs.existsSync(WGPU_HOME)) {
  console.log('-- GPU の比べは飛ばしました（UM_WGPU_HOME がありません）');
} else {
  const GPU = build('gpu', { UM_WGPU: '1' });
  check(!!GPU, 'ビルド（GPU）');
  if (GPU) {
    for (const [name, body] of SCENES) {
      const s = scene(CPU, body);
      const bad = [];
      for (const t of [0.25, 1.0, 1.75]) {
        const c = preview(CPU, s, t, path.join(s.dir, `c${t}.bmp`));
        const g = preview(GPU, s, t, path.join(s.dir, `g${t}.bmp`), { UM_GPU_THRESHOLD: '1', UM_WGPU_HOME: WGPU_HOME });
        if (!same(c, g)) bad.push(`${t} 秒`);
      }
      check(bad.length === 0, `GPU（UM_GPU_THRESHOLD=1）と CPU が同じ: ${name}`, `違う時刻: ${bad.join('、')}（${s.dir}）`);
    }
  }
}

console.log(`\n${passed} 件合格、${failed} 件不合格`);
if (!KEEP && failed === 0) fs.rmSync(TMP, { recursive: true, force: true });
else console.log(`作業用のフォルダ: ${TMP}`);
process.exit(failed ? 1 : 0);
