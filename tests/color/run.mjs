#!/usr/bin/env node
// 色の処理（src/effects/color/）の試験。npm の依存はない。
//
//   node tests/color/run.mjs            既知の値の試験と、.cube のファイルの読み取り（診断の JSON）
//   node tests/color/run.mjs --bench    あわせて 1080p の 1 コマの速さを測る（CPU。GPU の試験をするときは GPU も）
//   node tests/color/run.mjs --gpu      あわせて CPU と GPU（wgpu）で同じ結果になるかを確かめる
//                                       （UM_WGPU_HOME か ../wgpu-native/<版> に wgpu-native が要る）
//   node tests/color/run.mjs --shots <フォルダ>   スコープの画像（BMP）を書く
//   -v                                  通った試験の名前も出す
//
// UnifiedMozaic のコンパイラは UM_HOME か、このリポジトリの隣の UnifiedMozaic を使う。
// import は main のフォルダの中だけなので、src/effects/color/*.um と tests/color/*.um を一時フォルダに写してビルドする。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const SRC = path.join(ROOT, 'src', 'effects', 'color');
const EXT = process.platform === 'win32' ? '.exe' : '';

const argv = process.argv.slice(2);
const BENCH = argv.includes('--bench');
const VERBOSE = argv.includes('-v');
const KEEP = argv.includes('--keep');
let GPU = argv.includes('--gpu');
const shotsAt = argv.indexOf('--shots');
const SHOTS = shotsAt >= 0 ? path.resolve(argv[shotsAt + 1] || 'color-shots') : null;

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

const UM = umHome();
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mozcut-color-'));
for (const dir of [SRC, HERE]) {
  for (const f of fs.readdirSync(dir)) {
    if (f.endsWith('.um')) fs.copyFileSync(path.join(dir, f), path.join(TMP, f));
  }
}

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

function build(main, exe, env = {}) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [path.join(UM, 'src', 'cli.ts'), 'build', path.join(TMP, main), '--target', 'host', '-o', exe],
    { encoding: 'utf8', env: { ...process.env, ...env }, maxBuffer: 1 << 26 });
  if (r.status !== 0) {
    console.error(`${main} をビルドできません:\n${r.stdout}${r.stderr}`);
    return false;
  }
  console.log(`  ${main} をビルドしました（${((Date.now() - t0) / 1000).toFixed(1)} 秒）`);
  return true;
}

function run(exe, args) {
  const r = spawnSync(exe, args, { encoding: 'utf8', maxBuffer: 1 << 26 });
  if (r.error) return { code: -1, out: '', err: r.error.message };
  return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
}

// "ok 名前" / "NG 名前: 詳しく" / "summary p f" の出力を数える。
function collect(group, res) {
  let summary = null;
  for (const line of res.out.split(/\r?\n/)) {
    if (line.startsWith('ok ')) ok(`${group}: ${line.slice(3)}`);
    else if (line.startsWith('NG ')) {
      const body = line.slice(3);
      const k = body.indexOf(': ');
      ng(`${group}: ${k >= 0 ? body.slice(0, k) : body}`, k >= 0 ? body.slice(k + 2) : '');
    } else if (line.startsWith('summary ')) summary = line.split(' ').slice(1).map(Number);
  }
  if (!summary) ng(`${group}: 最後まで走らない`, `終了コード ${res.code}\n${res.err}${res.out.split('\n').slice(-5).join('\n')}`);
  return summary;
}

function bench(group, res) {
  const best = new Map();
  for (const line of res.out.split(/\r?\n/)) {
    const m = /^time (\S+) ([\d.]+)/.exec(line);
    if (m) best.set(m[1], Math.min(best.get(m[1]) ?? Infinity, Number(m[2])));
  }
  console.log(`  ${group}（1920×1080、vec4<f32>。数回のうちの最小）`);
  for (const [k, v] of best) console.log(`    ${k.padEnd(32)} ${v.toFixed(1).padStart(7)} ms`);
}

console.log('色の処理（src/effects/color/）');
const exe = path.join(TMP, 'color_test' + EXT);
if (!build('color_test.um', exe)) ng('cpu: ビルド', 'color_test.um をビルドできません');
else {
  collect('cpu', run(exe, []));

  // .cube のファイルを読む（診断の JSON と文）
  const cube = (name, text, expect) => {
    const f = path.join(TMP, name);
    fs.writeFileSync(f, text);
    const r = run(exe, ['--cube', f]);
    const lines = r.out.split(/\r?\n/);
    let info = null;
    let diags = null;
    try {
      info = JSON.parse(lines[0]);
      diags = JSON.parse(lines[1]);
    } catch (e) {
      ng(`cube: ${name}`, `JSON として読めません: ${e.message}\n${r.out}${r.err}`);
      return;
    }
    const msg = expect(info, diags, lines.slice(2).join('\n'), r.code);
    if (msg) ng(`cube: ${name}`, `${msg}\n${r.out}`);
    else ok(`cube: ${name}`);
  };
  let ident = 'TITLE "id"\nLUT_3D_SIZE 3\n';
  for (let b = 0; b < 3; b++) for (let g = 0; g < 3; g++) for (let r = 0; r < 3; r++) ident += `${r / 2} ${g / 2} ${b / 2}\n`;
  cube('identity.cube', ident, (i, d, _t, code) =>
    (i.ok && i.size3d === 3 && i.title === 'id' && d.length === 0 && code === 0) ? '' : '恒等の LUT が読めない');
  cube('broken.cube', 'LUT_3D_SIZE 2\nDOMAN_MIN 0 0 0\n0 0 0\n1 0 0\n0 1 zero\n', (i, d, text, code) => {
    if (i.ok || code === 0) return '壊れたファイルなのに ok';
    const want = [['cube-unknown-keyword', 2, 1, 'warning'], ['cube-bad-number', 5, 5, 'error'], ['cube-count', 5, 0, 'error']];
    for (const [c, l, col, sev] of want) {
      if (!d.some((x) => x.code === c && x.line === l && x.col === col && x.severity === sev)) return `${c}（${l} 行 ${col} 列）がない`;
    }
    const unk = d.find((x) => x.code === 'cube-unknown-keyword');
    if (unk.suggest !== 'DOMAIN_MIN') return `候補が DOMAIN_MIN でない: ${unk.suggest}`;
    if (!text.includes('broken.cube:5:5: エラー[cube-bad-number]')) return '診断の文の形が違う';
    return '';
  });
  {
    const r = run(exe, ['--cube', path.join(TMP, 'no-such-file.cube')]);
    const d = JSON.parse(r.out.split(/\r?\n/)[1] || '[]');
    if (r.code !== 0 && d.length === 1 && d[0].code === 'cube-unreadable') ok('cube: 読めないファイル');
    else ng('cube: 読めないファイル', r.out);
  }

  if (BENCH) bench('CPU の速さ', run(exe, ['--bench']));
  if (SHOTS) {
    fs.mkdirSync(SHOTS, { recursive: true });
    const r = run(exe, ['--shots', SHOTS]);
    console.log(r.code === 0 ? `  スコープの画像: ${SHOTS}` : `  スコープの画像を書けません: ${r.err}`);
  }
}

if (GPU || process.env.UM_WGPU_HOME) {
  const wh = wgpuHome();
  if (!wh) {
    console.log('  GPU の試験は飛ばします（wgpu-native が見つかりません。UM_WGPU_HOME を設定してください）');
  } else {
    const gexe = path.join(TMP, 'color_gpu' + EXT);
    if (build('color_gpu.um', gexe, { UM_WGPU: '1', UM_WGPU_HOME: wh })) {
      collect('gpu', run(gexe, []));
      if (BENCH) {
        bench('GPU の速さ（結果を CPU で読むまで。Buffer の写しを含む）', run(gexe, ['--bench']));
        bench('GPU のスコープの数える kernel（続けて 6 回。scope0 はばらばらの画素、scope1 はなめらかな画）', run(gexe, ['--bench-scopes']));
      }
    } else {
      ng('gpu: ビルド', 'color_gpu.um をビルドできません');
    }
  }
}

if (!KEEP) fs.rmSync(TMP, { recursive: true, force: true });
else console.log(`  作業用のフォルダ: ${TMP}`);
console.log(failures.length === 0 ? `ぜんぶ通りました（${passed} 件）` : `${failures.length} 件が落ちました（通ったのは ${passed} 件）`);
process.exit(failures.length === 0 ? 0 : 1);
