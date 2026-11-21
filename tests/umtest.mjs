// 部品ごとのテスト（tests/<部品名>/run.mjs）が使う小さな道具。npm の依存はない。
//
// - buildTool(name, testUm): src/ を一時フォルダに写し、試し用の .um をその隣に置いて、UM のコンパイラでビルドする。
//   UM の import は main のフォルダの中だけなので、試し用の .um は src/ の写しの中に置く（本物の src/ は書き換えない）。
// - run(exe, args): 試し用のプログラムを実行し、標準出力を返す（落ちたら失敗にする）。
// - test(name, fn) / done(): テストを数えて、最後に結果を出す（落ちたものがあれば終了コード 1）。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PROBE = path.join(ROOT, 'tests', 'cases', 'probe.txt');
const EXT = process.platform === 'win32' ? '.exe' : '';
const KEEP = process.argv.includes('--keep');
export const VERBOSE = process.argv.includes('-v');

export const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mozcut-part-'));

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

export function buildTool(name, testUm) {
  const dir = path.join(TMP, 'src');
  if (!fs.existsSync(dir)) fs.cpSync(path.join(ROOT, 'src'), dir, { recursive: true });
  const main = path.join(dir, path.basename(testUm));
  fs.copyFileSync(testUm, main);
  const exe = path.join(TMP, name + EXT);
  const r = spawnSync(process.execPath, [path.join(umHome(), 'src', 'cli.ts'), 'build', main, '--target', 'host', '-o', exe],
    { encoding: 'utf8' });
  if (r.status !== 0) {
    console.error(`ビルドに失敗しました: ${testUm}\n${r.stdout}${r.stderr}`);
    cleanup();
    process.exit(1);
  }
  return exe;
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
