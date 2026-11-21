#!/usr/bin/env node
// 色のワークスペース（src/ws_color/）と描画の色の調整（src/gradelayer.um）の試験。npm の依存はない。
//
//   node tests/ws_color/run.mjs        CPU のビルドで試す（パネルの値 ⇔ .mzc の操作、層への調整、モニターの絵、
//                                      スコープの数と絵が cpu.dispatch と自動の dispatch で同じこと）
//   node tests/ws_color/run.mjs --gpu  あわせて UM_WGPU=1 でビルドし、スコープの数と絵が CPU と GPU で同じことを確かめる
//                                      （UM_WGPU_HOME か ../wgpu-native/<版> に wgpu-native が要る）
//   -v                                 通った試験の名前も出す
//
// UnifiedMozaic のコンパイラは UM_HOME か、このリポジトリの隣の UnifiedMozaic を使う。
// import は main のフォルダの中だけなので、src/ を一時フォルダに写し、その一番上に wsc_test.um を置いてビルドする。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const EXT = process.platform === 'win32' ? '.exe' : '';
const argv = process.argv.slice(2);
const VERBOSE = argv.includes('-v');
const GPU = argv.includes('--gpu');

function umHome() {
  const cands = [process.env.UM_HOME, path.join(ROOT, '..', 'UnifiedMozaic')].filter(Boolean);
  for (const c of cands) {
    if (fs.existsSync(path.join(c, 'src', 'cli.ts'))) return c;
  }
  console.error('UnifiedMozaic のコンパイラが見つかりません。環境変数 UM_HOME にその場所を設定してください');
  process.exit(2);
}

function wgpuHome() {
  if (process.env.UM_WGPU_HOME && fs.existsSync(process.env.UM_WGPU_HOME)) return process.env.UM_WGPU_HOME;
  const base = path.join(ROOT, '..', 'wgpu-native');
  try {
    const vers = fs.readdirSync(base).filter((d) => fs.existsSync(path.join(base, d, 'include'))).sort();
    if (vers.length) return path.join(base, vers[vers.length - 1]);
  } catch { /* なし */ }
  return null;
}

function copyTree(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const a = path.join(from, e.name);
    const b = path.join(to, e.name);
    if (e.isDirectory()) copyTree(a, b);
    else if (e.name.endsWith('.um')) fs.copyFileSync(a, b);
  }
}

const UM = umHome();
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mozcut-wsc-'));
const SRC = path.join(TMP, 'src');
copyTree(path.join(ROOT, 'src'), SRC);
fs.copyFileSync(path.join(HERE, 'wsc_test.um'), path.join(SRC, 'wsc_test.um'));

let passed = 0;
const failures = [];
function ok(name) {
  passed++;
  if (VERBOSE) console.log(`  ok  ${name}`);
}
function ng(name, msg) {
  failures.push(name);
  console.log(`  NG  ${name}`);
  for (const l of String(msg).split('\n')) console.log(`        ${l}`);
}

function build(exe, env = {}) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [path.join(UM, 'src', 'cli.ts'), 'build', path.join(SRC, 'wsc_test.um'), '--target', 'host', '-o', exe],
    { encoding: 'utf8', env: { ...process.env, ...env }, maxBuffer: 1 << 26 });
  if (r.status !== 0) {
    console.error(`wsc_test.um をビルドできません:\n${r.stdout}${r.stderr}`);
    return false;
  }
  console.log(`  wsc_test.um をビルドしました（${((Date.now() - t0) / 1000).toFixed(1)} 秒${env.UM_WGPU ? '、UM_WGPU=1' : ''}）`);
  return true;
}

function collect(group, exe) {
  const r = spawnSync(exe, [], { encoding: 'utf8', maxBuffer: 1 << 26 });
  const out = r.stdout ?? '';
  let summary = null;
  for (const line of out.split(/\r?\n/)) {
    if (line.startsWith('ok ')) ok(`${group}: ${line.slice(3)}`);
    else if (line.startsWith('NG ')) {
      const body = line.slice(3);
      const k = body.indexOf(': ');
      ng(`${group}: ${k >= 0 ? body.slice(0, k) : body}`, k >= 0 ? body.slice(k + 2) : '');
    } else if (line.startsWith('info ')) console.log(`  ${group}: ${line.slice(5)}`);
    else if (line.startsWith('summary ')) summary = line;
  }
  if (!summary) ng(`${group}: 最後まで走らない`, `終了コード ${r.status}\n${r.stderr ?? ''}${out.split('\n').slice(-5).join('\n')}`);
}

console.log('色のワークスペース（src/ws_color/）');
const exe = path.join(TMP, 'wsc_test' + EXT);
if (build(exe)) collect('cpu', exe);
else ng('cpu: ビルド', 'wsc_test.um をビルドできません');

if (GPU) {
  const wh = wgpuHome();
  if (!wh) {
    console.log('  GPU の試験は飛ばします（wgpu-native が見つかりません。UM_WGPU_HOME を設定してください）');
  } else {
    const gexe = path.join(TMP, 'wsc_test_gpu' + EXT);
    if (build(gexe, { UM_WGPU: '1', UM_WGPU_HOME: wh })) collect('gpu', gexe);
    else ng('gpu: ビルド', 'UM_WGPU=1 で wsc_test.um をビルドできません');
  }
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${passed} 件合格、${failures.length} 件不合格`);
process.exit(failures.length ? 1 : 0);
