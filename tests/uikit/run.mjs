#!/usr/bin/env node
// uikit（src/ui/kit/）の試し。npm の依存なし。
//
//   node tests/uikit/run.mjs           src/uikit_test.um を作って実行し、すべて ok かを確かめる
//                                      （docs/design/tokens.json があれば、本物の tokens.json の読み取りも試す）
//   node tests/uikit/run.mjs --bench   見本（src/uikit_demo.um）も作り、1440x900・部品 300 個の画面の描く速さを測る
//                                      （ui.md 21.3 の目標: 全体の描き直し 4 ms、変わった所だけ 1 ms）
//   node tests/uikit/run.mjs --shot    見本を SDL_VIDEO_DRIVER=offscreen で動かし、build/uikit-shot.bmp に画面を書く
//
// UnifiedMozaic のコンパイラは UM_HOME か、このリポジトリの隣の UnifiedMozaic を使う。
// 見本はウィンドウ（SDL3）を使うので、UM_SDL3 か、隣・ホームの SDL3-* が要る。
// 試しの本体（uikit_test.um）はウィンドウを開かないが、いまの UM のビルドは SDL3 の場所を求めることがある。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const EXT = process.platform === 'win32' ? '.exe' : '';
const args = process.argv.slice(2);

function umHome() {
  const cands = [process.env.UM_HOME, path.join(ROOT, '..', 'UnifiedMozaic'), path.join(os.homedir(), 'UnifiedMozaic')]
    .filter(Boolean);
  for (const c of cands) if (fs.existsSync(path.join(c, 'src', 'cli.ts'))) return c;
  console.error('uikit: UnifiedMozaic のコンパイラが見つかりません。UM_HOME を設定してください');
  process.exit(2);
}

function sdl3Home() {
  if (process.env.UM_SDL3) return process.env.UM_SDL3;
  for (const dir of [path.join(ROOT, '..'), os.homedir()]) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const n of names.filter((n) => n.startsWith('SDL3-')).sort().reverse()) {
      if (fs.existsSync(path.join(dir, n, 'include', 'SDL3', 'SDL.h'))) return path.join(dir, n);
    }
  }
  return undefined;
}

function build(src, out) {
  const env = { ...process.env };
  const sdl = sdl3Home();
  if (sdl) env.UM_SDL3 = sdl;
  else console.log('uikit: SDL3 が見つかりません（UM_SDL3 も、隣・ホームの SDL3-* もない）。SDL3 なしでビルドを試します');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const r = spawnSync(process.execPath, [path.join(umHome(), 'src', 'cli.ts'), 'build', src, '--target', 'host', '-o', out],
    { cwd: ROOT, env, encoding: 'utf8', maxBuffer: 1 << 26 });
  if (r.status !== 0) {
    process.stdout.write(r.stdout || '');
    process.stderr.write(r.stderr || '');
    console.error(`uikit: ${src} を作れません`);
    if (!sdl) {
      console.error('uikit: SDL3 が見つからないことが原因かもしれません。uikit_test.um はウィンドウを使いませんが、'
        + 'いまの UM はウィンドウの組み込み（runtime/window.c）を一緒に結ぶため、ビルドに SDL3 の場所が要ることがあります。'
        + 'UM_SDL3 に SDL3 のフォルダ（include/SDL3/SDL.h がある所）を設定してください。');
    }
    process.exit(1);
  }
}

// 本物の tokens.json（このリポジトリか、隣の本体のリポジトリ MozaicCut の docs/design/）。
function tokensPath() {
  const cands = [path.join(ROOT, 'docs', 'design', 'tokens.json'), path.join(ROOT, '..', 'MozaicCut', 'docs', 'design', 'tokens.json'),
    path.join(ROOT, '..', '..', 'MozaicCut', 'docs', 'design', 'tokens.json')];
  for (const c of cands) if (fs.existsSync(c)) return c;
  return '';
}

// ---- 試しの本体 ----
// 試しの本体は一時フォルダに作る。build/ に作ると、UM のビルドが SDL3.dll・wasmtime.dll を build/ に写し直すので、
// 同時に流れているほかのテストの build/mozcut などがその DLL を使っていると、写せずにビルドが落ちる（tests/all.mjs）
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mozcut-uikit-'));
process.on('exit', () => fs.rmSync(testDir, { recursive: true, force: true }));
const testExe = path.join(testDir, 'uikit-test' + EXT);
build(path.join('src', 'uikit_test.um'), testExe);
const tok = tokensPath();
const r = spawnSync(testExe, tok ? [tok] : [], { encoding: 'utf8', timeout: 120000 });
const lines = (r.stdout || '').trim().split(/\r?\n/);
const ng = lines.filter((l) => l.startsWith('NG '));
const summary = lines.length > 0 ? lines[lines.length - 1] : '';
let sum = null;
try { sum = JSON.parse(summary); } catch { /* 下で失敗にする */ }
for (const l of ng) console.log(l);
for (const l of lines.filter((l) => l.startsWith('info ') || l.startsWith('skip '))) console.log(`  ${l}`);
if (!sum || r.status !== 0 || ng.length > 0 || sum.ng !== 0) {
  console.log(`uikit: 失敗しました（${summary}）`);
  if (r.stderr) process.stderr.write(r.stderr);
  process.exit(1);
}
console.log(`uikit: ${sum.ok} 個の試しがすべて通りました`);

// ---- 速さ・画面 ----
if (args.includes('--bench') || args.includes('--shot')) {
  const demoExe = path.join(ROOT, 'build', 'uikit-demo' + EXT);
  build(path.join('src', 'uikit_demo.um'), demoExe);
  if (args.includes('--bench')) {
    const b = spawnSync(demoExe, ['--bench'], { encoding: 'utf8' });
    const j = JSON.parse(b.stdout.trim().split(/\r?\n/).pop());
    console.log(`uikit: ${j.size} 部品 ${j.widgets} 個（命令 ${j.cmds} 個）`);
    console.log(`  1 フレーム目（文字の画像を作る分を含む） ${j.firstMs} ms`);
    console.log(`  全体を描き直す                          ${j.fullMs} ms`);
    console.log(`  変わらないフレーム（部品を作るだけ）     ${j.idleMs} ms`);
    console.log(`  マウスを動かす（変わった所だけ）         ${j.hoverMs} ms（平均 ${j.hoverDirtyPx} 画素）`);
    // ui.md 21.3: UI の 1 コマの描画は 4 ms 以内。変わった所だけの描き直し・変わらないフレームは 1 ms 以内
    const bad = [];
    if (j.widgets < 300) bad.push(`部品が ${j.widgets} 個しかない`);
    if (j.fullMs > 4) bad.push(`全体の描き直しが ${j.fullMs} ms（目標 4 ms）`);
    if (j.hoverMs > 1) bad.push(`変わった所だけの描き直しが ${j.hoverMs} ms（目標 1 ms）`);
    if (j.idleMs > 1) bad.push(`変わらないフレームが ${j.idleMs} ms（目標 1 ms）`);
    if (bad.length > 0) {
      console.log(`uikit: 速さが足りません: ${bad.join('、')}`);
      process.exit(1);
    }
  }
  if (args.includes('--shot')) {
    const out = path.join(ROOT, 'build', 'uikit-shot.bmp');
    // ウィンドウは利用者の画面に出さない
    const s = spawnSync(demoExe, ['--frames', '5', '--shot', out], {
      encoding: 'utf8', env: { ...process.env, SDL_VIDEO_DRIVER: 'offscreen' }, timeout: 60000,
    });
    if (s.status !== 0 || !fs.existsSync(out)) {
      console.log('uikit: 見本の画面を書けませんでした');
      process.stderr.write(s.stderr || '');
      process.exit(1);
    }
    console.log(`uikit: 見本の画面を ${path.relative(ROOT, out)} に書きました`);
  }
}
