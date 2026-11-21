#!/usr/bin/env node
// 画面の部品（src/ui_*/ と、テーマ・アイコン・キーの割り当て）の試し。npm の依存なし。
//
//   node tests/ui/run.mjs                 src/*_test.um を作って動かし、src/*_demo.um を作って 1 枚ずつ画面を撮る
//   node tests/ui/run.mjs timeline pool   名前（ファイル名の _test / _demo の前）で選ぶ
//   node tests/ui/run.mjs --no-demo       試しだけ（見本は作らない）
//   node tests/ui/run.mjs --shots <dir>   撮った画面（BMP）を書く所（既定は build/ui/shots）
//
// 名前を選ばないときは、はじめに名前の重なりを確かめる。UM の名前の空間は全ファイルで 1 つなので、
// src/ の下のライブラリ（export function main を持たない .um）を全部 1 つの仮の main に import して check する。
// 部品を別々に作るだけでは、編集画面にまとめたときに初めて出る error[duplicate] を見つけられないため。
//
// uikit そのものの試し（uikit_test.um / uikit_demo.um）は tests/uikit/run.mjs が受け持つので、ここでは扱わない。
// 見本はウィンドウ（SDL3）を使うが、必ず SDL_VIDEO_DRIVER=offscreen で動かし、利用者の画面には出さない。
// 見本は --frames 4 --shot <bmp> で動かし、終了コード 0 で、画面が 1 色だけでないことを確かめる。
// 見本が --tokens を読めるなら docs/design/tokens.json を渡す。
//
// UnifiedMozaic のコンパイラは UM_HOME か、このリポジトリの隣・ホームの UnifiedMozaic を使う。
// SDL3 は UM_SDL3 か、隣・ホームの SDL3-*。
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const EXT = process.platform === 'win32' ? '.exe' : '';
const argv = process.argv.slice(2);
const NO_DEMO = argv.includes('--no-demo');
const si = argv.indexOf('--shots');
const SHOTS = si >= 0 ? path.resolve(argv[si + 1]) : path.join(ROOT, 'build', 'ui', 'shots');
const picked = argv.filter((a, i) => !a.startsWith('-') && !(si >= 0 && i === si + 1));
const OUT = path.join(ROOT, 'build', 'ui');
const TOKENS = path.join(ROOT, 'docs', 'design', 'tokens.json');

function umHome() {
  const cands = [process.env.UM_HOME, path.join(ROOT, '..', 'UnifiedMozaic'), path.join(os.homedir(), 'UnifiedMozaic')]
    .filter(Boolean);
  for (const c of cands) if (fs.existsSync(path.join(c, 'src', 'cli.ts'))) return c;
  console.error('ui: UnifiedMozaic のコンパイラが見つかりません。UM_HOME を設定してください');
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

// 試しと見本を集める。uikit の分は tests/uikit が受け持つ。
function collect() {
  const names = fs.readdirSync(path.join(ROOT, 'src')).filter((n) => /_(test|demo)\.um$/.test(n) && !n.startsWith('uikit_'));
  const items = names.map((n) => {
    const m = /^(.*)_(test|demo)\.um$/.exec(n);
    return { file: n, name: m[1], kind: m[2] };
  }).filter((it) => picked.length === 0 || picked.some((p) => it.name === p || it.name.startsWith(p)));
  return items.filter((it) => !(NO_DEMO && it.kind === 'demo')).sort((a, b) => a.file.localeCompare(b.file));
}

const UM = umHome();
const SDL = sdl3Home();
const env = { ...process.env, SDL_VIDEO_DRIVER: 'offscreen', SDL_AUDIO_DRIVER: 'dummy' };
if (SDL) env.UM_SDL3 = SDL;

function buildOne(it) {
  const exe = path.join(OUT, it.file.replace(/\.um$/, '') + EXT);
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(UM, 'src', 'cli.ts'), 'build', path.join('src', it.file), '--target', 'host', '-o', exe],
      { cwd: ROOT, env });
    let log = '';
    p.stdout.on('data', (d) => { log += d; });
    p.stderr.on('data', (d) => { log += d; });
    p.on('close', (code) => resolve({ ok: code === 0, exe, log }));
  });
}

async function buildAll(items) {
  const res = new Map();
  let next = 0;
  const workers = Math.max(1, Math.min(4, os.cpus().length >> 1));
  await Promise.all(Array.from({ length: workers }, async () => {
    while (next < items.length) {
      const it = items[next++];
      res.set(it.file, await buildOne(it));
    }
  }));
  return res;
}

// BMP（24/32 ビット、下から上）の画素が 1 色だけでないか。読めなければ null。
function bmpColors(file) {
  const b = fs.readFileSync(file);
  if (b.length < 54 || b.toString('latin1', 0, 2) !== 'BM') return null;
  const off = b.readUInt32LE(10);
  const w = b.readInt32LE(18);
  const h = Math.abs(b.readInt32LE(22));
  const bpp = b.readUInt16LE(28);
  if (bpp !== 24 && bpp !== 32) return null;
  const stride = ((w * bpp / 8 + 3) & ~3);
  const seen = new Set();
  for (let y = 0; y < h; y += 7) {
    for (let x = 0; x < w; x += 5) {
      const i = off + y * stride + x * (bpp / 8);
      seen.add((b[i] << 16) | (b[i + 1] << 8) | b[i + 2]);
      if (seen.size > 16) return { w, h, colors: seen.size };
    }
  }
  return { w, h, colors: seen.size };
}

// src/ の下のライブラリを全部 import する仮の main を src/ に書いて check する（import は main のフォルダの中だけなので）。
// 各ファイルから export した名前を 1 つだけ取り込めば、そのファイル全体の名前が 1 つの空間に入る。
// NAMES_SKIP は、アプリに入らず試験の main だけが読むファイル。わざと組み込みと同じ名前を持つので除く:
//   fxs/wasmref.um  例のエフェクトを UM 本体でコンパイルした形（fxs/test_wasm.um だけが読む）。組み込みのエフェクト
//                   （gen/fx/vignette.um など。gen/plugins.um がアプリに入れる）と同じ vignetteKernel・fx_vignette を持つ
const NAMES_SKIP = ['fxs/wasmref.um'];
function namesCheck() {
  const srcDir = path.join(ROOT, 'src');
  const files = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (NAMES_SKIP.includes(path.relative(srcDir, p).split(path.sep).join('/'))) continue;
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.um')) files.push(p);
    }
  })(srcDir);
  const tmp = path.join(srcDir, `zz_ui_names_check_${process.pid}.um`);
  const lines = ['// tests/ui/run.mjs が名前の重なりを確かめるために書く仮の main。終われば消す。'];
  let n = 0;
  for (const f of files.sort()) {
    if (f === tmp) continue;
    const s = fs.readFileSync(f, 'utf8');
    if (/^export function main\(/m.test(s)) continue;
    const m = /^export (?:kernel )?(?:function|const|struct|enum|class|interface) ([A-Za-z_0-9]+)/m.exec(s);
    if (!m) continue;
    const rel = path.relative(srcDir, f).split(path.sep).join('/');
    lines.push(`import { ${m[1]} } from "./${rel}";`);
    n++;
  }
  lines.push('export function main(): i32 {', '  return 0;', '}', '');
  fs.writeFileSync(tmp, lines.join('\n'));
  try {
    const r = spawnSync(process.execPath, [path.join(UM, 'src', 'cli.ts'), 'check', tmp, '--target', 'host'],
      { cwd: ROOT, env, encoding: 'utf8' });
    return { ok: r.status === 0, n, log: `${r.stdout || ''}${r.stderr || ''}` };
  } finally {
    try { fs.rmSync(tmp); } catch { /* なくてよい */ }
  }
}

const items = collect();
let namesFail = null;
if (picked.length === 0) {
  const nc = namesCheck();
  if (nc.ok) {
    console.log(`ok  名前の重なり: src/ のライブラリ ${nc.n} 個を 1 つの main に import して check が通りました`);
  } else {
    namesFail = '名前の重なり';
    console.log(`NG  名前の重なり（src/ のライブラリ ${nc.n} 個を 1 つの main に import すると check が通りません）\n` +
      nc.log.trim().split(/\r?\n/).filter((l) => !l.startsWith('  hint')).slice(0, 12).join('\n'));
  }
}
if (items.length === 0) {
  console.log('ui: 試す部品がありません');
  process.exit(namesFail ? 1 : 0);
}
fs.mkdirSync(OUT, { recursive: true });
if (!NO_DEMO) fs.mkdirSync(SHOTS, { recursive: true });

const t0 = Date.now();
const built = await buildAll(items);
const fails = namesFail ? [namesFail] : [];
let ok = picked.length === 0 && !namesFail ? 1 : 0;
for (const it of items) {
  const b = built.get(it.file);
  if (!b.ok) {
    fails.push(`${it.file} を作れません`);
    console.log(`NG  ${it.file}（作れません）\n${b.log.trim().split(/\r?\n/).slice(0, 12).join('\n')}`);
    continue;
  }
  if (it.kind === 'test') {
    const a = it.name === 'pool' ? ['--tokens', TOKENS] : [];
    const r = spawnSync(b.exe, a, { cwd: ROOT, env, encoding: 'utf8', timeout: 120000 });
    const tail = `${r.stdout || ''}${r.stderr || ''}`.trim().split(/\r?\n/).slice(-1)[0] || '';
    if (r.status !== 0) {
      fails.push(`${it.file}（終了コード ${r.status}）`);
      console.log(`NG  ${it.file}（終了コード ${r.status}）\n${(r.stdout || '') + (r.stderr || '')}`);
    } else {
      ok++;
      console.log(`ok  ${it.file}: ${tail}`);
    }
    continue;
  }
  // 見本: 画面を 1 枚撮る
  const src = fs.readFileSync(path.join(ROOT, 'src', it.file), 'utf8');
  const shot = path.join(SHOTS, `${it.name}.bmp`);
  try { fs.rmSync(shot); } catch { /* なくてよい */ }
  const a = ['--frames', '4', '--shot', shot];
  if (src.includes('"--tokens"')) a.push('--tokens', TOKENS);
  const r = spawnSync(b.exe, a, { cwd: ROOT, env, encoding: 'utf8', timeout: 120000 });
  const c = fs.existsSync(shot) ? bmpColors(shot) : null;
  if (r.status !== 0 || !c || c.colors < 2) {
    const why = r.status !== 0 ? `終了コード ${r.status}` : !c ? '画面を書けません' : '画面が 1 色だけです';
    fails.push(`${it.file}（${why}）`);
    console.log(`NG  ${it.file}（${why}）\n${(r.stderr || '').trim().split(/\r?\n/).slice(-8).join('\n')}`);
  } else {
    ok++;
    console.log(`ok  ${it.file}: ${c.w}x${c.h} の画面を ${path.relative(ROOT, shot)} に書きました`);
  }
}
const sec = ((Date.now() - t0) / 1000).toFixed(1);
if (fails.length > 0) {
  console.log(`ui: ${ok} 件合格、${fails.length} 件不合格（${sec} 秒）: ${fails.join(', ')}`);
  process.exit(1);
}
console.log(`ui: ${ok} 件すべて合格（${sec} 秒）`);
