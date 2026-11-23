// 部品ごとのテスト（tests/<部品名>/run.mjs）が使う小さな道具。npm の依存はない。
//
// - buildTool(name, testUm): src/ を一時フォルダに写し、試し用の .um をその隣に置いて、UM のコンパイラでビルドする。
//   UM の import は main のフォルダの中だけなので、試し用の .um は src/ の写しの中に置く（本物の src/ は書き換えない）。
// - run(exe, args): 試し用のプログラムを実行し、標準出力を返す（落ちたら失敗にする）。
// - test(name, fn) / done(): テストを数えて、最後に結果を出す（落ちたものがあれば終了コード 1）。
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ffmpegLibsFound, useFfmpegOff } from '../tools/ffmpeg-libs.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PROBE = path.join(ROOT, 'tests', 'cases', 'probe.txt');
const EXT = process.platform === 'win32' ? '.exe' : '';
const KEEP = process.argv.includes('--keep');
export const VERBOSE = process.argv.includes('-v');

export const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mozcut-part-'));

// 登録表（src/gen/plugins.um）が .mzplug の読み込み（wasmtime）を使うので、どの試しのビルドにも wasmtime の場所が要る。
// tools/mozcut.mjs と同じく、UM_WASMTIME がなければ、このリポジトリの隣とホームの wasmtime-*-c-api を探す。
export function wasmtimeHome() {
  if (process.env.UM_WASMTIME) return process.env.UM_WASMTIME;
  for (const dir of [path.join(ROOT, '..'), os.homedir()]) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const n of names.filter((n) => n.startsWith('wasmtime-')).sort().reverse()) {
      if (fs.existsSync(path.join(dir, n, 'include', 'wasmtime.h'))) return path.join(dir, n);
    }
  }
  return undefined;
}
if (!process.env.UM_WASMTIME && wasmtimeHome()) process.env.UM_WASMTIME = wasmtimeHome();

function umHome() {
  const cands = [
    process.env.UM_HOME,
    path.join(ROOT, '..', 'UnifiedMozaic'),
    path.join(ROOT, '..', '..', 'UnifiedMozaic'),
    path.join(os.homedir(), 'UnifiedMozaic'),
  ].filter(Boolean);
  for (const c of cands) {
    if (fs.existsSync(path.join(c, 'src', 'cli.ts'))) return c;
  }
  console.error('UnifiedMozaic のコンパイラが見つかりません。環境変数 UM_HOME にその場所を設定してください');
  process.exit(2);
}

// 試しのビルドの最適化の段。既定は本番と同じ -O2（色や音の試しには速さを測るものがあり、-O0 では時間の上限を超える）。
// 速さを測らない試しを急いで流すときは MOZCUT_TEST_OPT=0 にする（ビルドが約半分の時間になる）。
const TEST_OPT = process.env.MOZCUT_TEST_OPT ?? '2';

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) walk(f, out);
    else out.push(f);
  }
  return out;
}

// ビルドの使い回しの鍵: src/ の全部の .um、試しの .um、コンパイラ（UM の src/ の .ts の更新時刻）、最適化の段、
// リンクするライブラリの場所。どれかが変われば、別の鍵になってビルドし直す。
function buildKey(testUm, um, extras = [], env = {}) {
  const h = crypto.createHash('sha256');
  const srcDir = path.join(ROOT, 'src');
  for (const f of walk(srcDir).filter((f) => f.endsWith('.um')).sort()) {
    h.update(path.relative(srcDir, f)).update('\0').update(fs.readFileSync(f));
  }
  h.update('\0test\0').update(path.basename(testUm)).update(fs.readFileSync(testUm));
  for (const f of extras) h.update('\0extra\0').update(path.basename(f)).update(fs.readFileSync(f));
  for (const k of Object.keys(env).sort()) h.update(`\0env ${k}=${env[k]}`);
  for (const f of walk(path.join(um, 'src')).filter((f) => f.endsWith('.ts')).sort()) {
    h.update(f).update(String(fs.statSync(f).mtimeMs));
  }
  h.update(`\0O${TEST_OPT}`);
  for (const k of ['UM_WASMTIME', 'UM_SDL3', 'UM_WGPU', 'UM_WGPU_HOME', 'UM_FFMPEG_HOME']) h.update(`\0${k}=${process.env[k] ?? ''}`);
  return h.digest('hex').slice(0, 20);
}

// testUm: 試し・デモの main（src/ の外にある）。src/ の写しの一番上に置いてビルドする（中の import は src/ の一番上からの相対）。
// extras: main と一緒に写しの一番上に置く .um（main が読む試し用の部品）。env: ビルドに足す環境変数（UM_WGPU など）。
export function buildTool(name, testUm, { extras = [], env = {} } = {}) {
  const um = umHome();
  // 中身が同じなら、前にビルドしたもの（OS の一時フォルダ）を使い回す
  const cacheDir = path.join(os.tmpdir(), 'mozcut-build-cache', `${name}-${buildKey(testUm, um, extras, env)}`);
  const cached = path.join(cacheDir, name + EXT);
  if (fs.existsSync(cached) && !process.env.MOZCUT_NO_BUILD_CACHE) return cached;
  const dir = path.join(TMP, 'src');
  if (!fs.existsSync(dir)) {
    fs.cpSync(path.join(ROOT, 'src'), dir, { recursive: true });
    // FFmpeg のライブラリがなければ、エンジンと同じく ffmpeg.um を ffmpeg_off.um に差し替える（tools/ffmpeg-libs.mjs）
    if (!ffmpegLibsFound()) useFfmpegOff(dir);
  }
  const main = path.join(dir, path.basename(testUm));
  fs.copyFileSync(testUm, main);
  for (const f of extras) fs.copyFileSync(f, path.join(dir, path.basename(f)));
  const work = `${cacheDir}.tmp-${process.pid}`;
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(work, { recursive: true });
  const exe = path.join(work, name + EXT);
  const r = spawnSync(process.execPath, [path.join(um, 'src', 'cli.ts'), 'build', main, '--target', 'host', `-O${TEST_OPT}`, '-o', exe],
    { encoding: 'utf8', env: { ...process.env, ...env } });
  if (r.status !== 0) {
    console.error(`ビルドに失敗しました: ${testUm}\n${r.stdout}${r.stderr}`);
    fs.rmSync(work, { recursive: true, force: true });
    cleanup();
    process.exit(1);
  }
  // 出来上がったフォルダを一度に置く（同時に流れているほかのテストが、作りかけを使わないように）
  try {
    fs.renameSync(work, cacheDir);
  } catch {
    fs.rmSync(work, { recursive: true, force: true }); // ほかのテストが先に置いた
  }
  return cached;
}

export class Fail extends Error {}
export function fail(msg) {
  throw new Fail(msg);
}
export function assert(cond, msg) {
  if (!cond) fail(msg);
}
export function eq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) fail(`${msg}\n    期待: ${e}\n    実際: ${a}`);
}

export function run(exe, args, opts = {}) {
  const r = spawnSync(exe, args, { encoding: 'utf8', cwd: TMP, ...opts });
  if (r.status !== 0) fail(`${path.basename(exe)} ${args.join(' ')} が終了コード ${r.status} で終わりました\n${r.stderr}`);
  return r.stdout;
}

export function runJson(exe, args) {
  const out = run(exe, args);
  try {
    return JSON.parse(out);
  } catch {
    fail(`JSON として読めません: ${out.slice(0, 400)}`);
  }
}

// 一時フォルダにファイルを書く（文字列なら UTF-8、Buffer ならそのまま）。書いた場所を返す。
export function put(name, data) {
  const f = path.join(TMP, name);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, data);
  return f;
}

let passed = 0;
const failures = [];
export function test(name, fn) {
  try {
    fn();
    passed++;
    if (VERBOSE) console.log(`  ok  ${name}`);
  } catch (e) {
    failures.push(name);
    console.log(`  NG  ${name}\n    ${e instanceof Fail ? e.message : e.stack}`);
  }
}

function cleanup() {
  if (KEEP) {
    console.log(`作業用のフォルダ: ${TMP}`);
  } else {
    fs.rmSync(TMP, { recursive: true, force: true });
  }
}

export function done(group) {
  cleanup();
  console.log(`${group}: ${passed} 件通過、${failures.length} 件失敗`);
  process.exit(failures.length ? 1 : 0);
}
