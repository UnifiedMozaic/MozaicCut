#!/usr/bin/env node
// M6 の操作の画面（src/workspaces/motion/）の試し。npm の依存なし。
//
//   node tests/ws-motion/run.mjs [--out <フォルダ>]
//
// 見本（demos/ws_motion_demo.um）を作り、SDL_VIDEO_DRIVER=offscreen で窓を開かずに動かす（--frames N で終わる）。
// 決めたフレームにマウスとキーの入力を入れ、部品が返した操作（標準エラーの "op: ..."）と、書き換えた .mzc（--save）を
// 確かめる。見本の .mzc は demo/m6/ws_motion.mzc（書き換えない。保存は一時フォルダ）。--out を渡すと、各場面の BMP も書く。
// 座標は見本の既定の大きさ（1600x1080）の配置のもの。配置を変えたらここも直す。
// ビルドには UM_HOME（なければ隣・ホームの UnifiedMozaic）と、UM_SDL3 / UM_WASMTIME / UM_WGPU_HOME などが要る。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const EXT = process.platform === 'win32' ? '.exe' : '';
const args = process.argv.slice(2);
const outDir = args.includes('--out') ? path.resolve(args[args.indexOf('--out') + 1]) : '';

function umHome() {
  const cands = [process.env.UM_HOME, path.join(ROOT, '..', 'UnifiedMozaic'), path.join(os.homedir(), 'UnifiedMozaic')].filter(Boolean);
  for (const c of cands) if (fs.existsSync(path.join(c, 'src', 'cli.ts'))) return c;
  console.error('ws-motion: UnifiedMozaic のコンパイラが見つかりません。UM_HOME を設定してください');
  process.exit(2);
}

// 見本は一時フォルダに作る。build/ に作ると、UM のビルドが SDL3.dll・wasmtime.dll などを build/ に写し直すので、
// 同時に流れているほかのテスト（tests/all.mjs）が build/mozcut-edit などでその DLL を使っていると、写せずに
// 「clang failed」とだけ出て落ちる。
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-motion-'));
const exe = path.join(tmp, 'ws-motion-demo' + EXT);
{
  // 見本の import は src/ の一番上からの相対なので、src/ を一時フォルダに写し、見本をその一番上に置いてビルドする
  // （UM の import は main のフォルダの中だけ。本物の src/ は書き換えない）。
  const srcCopy = path.join(tmp, 'src');
  fs.cpSync(path.join(ROOT, 'src'), srcCopy, { recursive: true });
  const main = path.join(srcCopy, 'ws_motion_demo.um');
  fs.copyFileSync(path.join(ROOT, 'demos', 'ws_motion_demo.um'), main);
  const r = spawnSync(process.execPath, [path.join(umHome(), 'src', 'cli.ts'), 'build', main, '--target', 'host', '-o', exe],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 26 });
  if (r.status !== 0) {
    process.stdout.write(r.stdout || '');
    process.stderr.write(r.stderr || '');
    fs.rmSync(tmp, { recursive: true, force: true });
    console.error('ws-motion: demos/ws_motion_demo.um を作れません（UM_SDL3 / UM_WASMTIME / UM_WGPU_HOME を確かめる）');
    process.exit(1);
  }
}

let fails = 0;
let n = 0;

function run(name, opts) {
  const save = path.join(tmp, name + '.mzc');
  const a = ['--save', save, ...opts];
  if (outDir) {
    fs.mkdirSync(outDir, { recursive: true });
    a.push('--shot', path.join(outDir, name + '.bmp'));
  }
  const r = spawnSync(exe, a, {
    cwd: ROOT, encoding: 'utf8', timeout: 120000,
    env: { ...process.env, SDL_VIDEO_DRIVER: 'offscreen', SDL_AUDIO_DRIVER: 'dummy' },
  });
  if (r.status !== 0) {
    console.error(`ws-motion: ${name}: 終わり方が ${r.status}（${r.error ? r.error.message : ''}）\n${r.stderr}`);
    fails++;
    return { err: r.stderr || '', mzc: '' };
  }
  return { err: r.stderr || '', mzc: fs.existsSync(save) ? fs.readFileSync(save, 'utf8') : '' };
}

function line(mzc, head) {
  return mzc.split(/\r?\n/).find((l) => l.startsWith(head)) || '';
}

function check(name, cond, info) {
  n++;
  if (cond) {
    console.log(`ok   ${name}`);
  } else {
    fails++;
    console.log(`FAIL ${name}\n${info}`);
  }
}

// 1. タイムラインのクリップの上のキーをドラッグ（box の x の 2 秒のキー → 2.5 秒）
{
  const r = run('kf-drag', ['--frames', '10', '--t', '1', '--move', '797,830@2', '--down', '797,830@3', '--move', '850,830@4', '--move', '974,830@5', '--up', '974,830@6']);
  check('キーの印のドラッグで key move', r.err.includes('op: key move box x #1 2.5 → ok'), r.err);
  check('キーの印のドラッグの .mzc', line(r.mzc, 'color 3c78ff').includes('x="80@0 520@2.5:ease 900@4"'), line(r.mzc, 'color 3c78ff'));
}
// 2. Esc でドラッグをやめる（何も当てない）
{
  const r = run('kf-esc', ['--frames', '10', '--t', '1', '--move', '797,830@2', '--down', '797,830@3', '--move', '900,830@4', '--key', 'esc@5', '--up', '900,830@6']);
  check('Esc でドラッグをやめる', !r.err.includes('op: ') && line(r.mzc, 'color 3c78ff').includes('520@2:ease'), r.err);
}
// 3. インスペクタの ◇ で y にキーを打つ
{
  const r = run('keynav-add', ['--frames', '6', '--t', '1', '--click', '1572,144@2']);
  check('◇ で key add', r.err.includes('op: key add box y 1 420 → ok'), r.err);
  check('◇ の .mzc', line(r.mzc, 'color 3c78ff').includes('y="420@0 420@1"'), line(r.mzc, 'color 3c78ff'));
}
// 4. ◀ で前のキー（0 秒）へ、▶ で次のキー（1 秒）へ戻り、そこで ◆ を押して消す（opacity の 1 秒のキー）
{
  const r = run('keynav-prev-next-remove', ['--frames', '10', '--t', '0.5', '--click', '1524,172@2', '--click', '1572,172@4', '--click', '1548,172@7']);
  check('◀ ▶ のあと ◆ で key remove', r.err.includes('op: key remove box opacity #1 → ok'), r.err);
  check('◆ で消した .mzc', /opacity=("0\.3@0"|0\.3)/.test(line(r.mzc, 'color 3c78ff')), line(r.mzc, 'color 3c78ff'));
}
// 5. ギズモの回転の取っ手（star の rotation のキーフレームに 1 秒のキーを打つ）
{
  const r = run('gizmo-rotate', ['--frames', '10', '--t', '1', '--select', 'star', '--move', '817,184@2', '--down', '817,184@3', '--move', '825,200@4', '--move', '830,249@5', '--up', '830,249@7']);
  const m = r.err.match(/op: key add star rotation 1 ([0-9.]+) → ok/);
  check('回転の取っ手で key add rotation', m && Math.abs(parseFloat(m[1]) - 101.62) < 1, r.err);
}
// 6. ギズモの枠のドラッグ（star の pos。キーフレームがないので set）
{
  const r = run('gizmo-move', ['--frames', '10', '--t', '1', '--select', 'star', '--move', '720,250@2', '--down', '720,250@3', '--move', '760,260@4', '--move', '789,271@5', '--up', '789,271@7']);
  check('枠のドラッグで set pos', /op: set star pos=[0-9.]+,[0-9.]+ → ok/.test(r.err), r.err);
}
// 7. シェイプのパスの頂点（付いた制御点も動く）
{
  const r = run('path-point', ['--frames', '9', '--t', '1', '--select', 'wave', '--move', '387,163@2', '--down', '387,163@3', '--move', '387,180@4', '--move', '387,203@5', '--up', '387,203@6']);
  check('パスの頂点で set d', line(r.mzc, 'shape path').includes('d="M 0 0 C 60 -90 140 148.12 200 58.12 L 320 -40"'), r.err);
}
// 8. マスクのパスの点（set @行）
{
  const r = run('mask-point', ['--frames', '9', '--t', '1', '--select', 'card', '--move', '677,115@2', '--down', '677,115@3', '--move', '690,125@4', '--move', '700,140@5', '--up', '700,140@6']);
  check('マスクの点で set @16 d', line(r.mzc, 'mask path').includes('d="M 20 20 L 333.42 76.32 L 270 160 L 40 150 Z"'), r.err);
}
// 9. グラフエディタ: キーを選び、出側の取っ手を上へ、そのあと「自動」を押す
{
  const r = run('graph', ['--frames', '12', '--t', '1', '--click', '820,981@2', '--move', '1071,981@4', '--down', '1071,981@5', '--move', '1071,960@6', '--move', '1071,940@7', '--up', '1071,940@9', '--click', '401,898@11']);
  check('取っ手で key ease out=', /op: key ease box x #1 out=[0-9.]+\/33\.33 → ok/.test(r.err), r.err);
  check('補間のボタンで key ease smooth', r.err.includes('op: key ease box x #1 smooth → ok') && line(r.mzc, 'color 3c78ff').includes('520@2:smooth'), r.err);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`ws-motion: ${n - fails} / ${n} ok`);
process.exit(fails > 0 ? 1 : 0);
