#!/usr/bin/env node
// キーイングの効果（plugins/chromakey.um・lumakey.um・matteview.um）の試験。npm の依存はない。
//
//   node tests/m6-key/run.mjs                既知の値の試験と、ffmpeg で作った緑の背景の素材での試験（CPU）
//   node tests/m6-key/run.mjs --gpu          あわせて CPU と GPU（wgpu。UM_WGPU=1）で同じ結果（全部の f32 のビット）になるかを確かめる
//                                            （UM_WGPU_HOME か ../wgpu-native/<版> に wgpu-native が要る。UM_WGPU_HOME があれば自動で行う）
//   node tests/m6-key/run.mjs --bench        あわせて 1920x1080 の 1 コマの速さを測る（GPU の試験をするときは GPU も）
//   node tests/m6-key/run.mjs --shots <dir>  結果の画像（PNG）を書く
//   -v                                       通った試験の名前も出す。--keep で作業用のフォルダを残す
//
// UnifiedMozaic のコンパイラは UM_HOME か、このリポジトリの隣の UnifiedMozaic を使う。ffmpeg は PATH か環境変数 FFMPEG。
// import は main のフォルダの中だけなので、plugins の 3 つと key_test.um を一時フォルダに写してビルドする。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolvePluginsDir } from '../../tools/gen-plugins.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const PLUGINS_DIR = resolvePluginsDir(ROOT) || path.join(ROOT, 'plugins');
const EXT = process.platform === 'win32' ? '.exe' : '';
const PLUGINS = ['chromakey', 'lumakey', 'matteview'];
const W = 1920;
const H = 1080;

const argv = process.argv.slice(2);
const BENCH = argv.includes('--bench');
const VERBOSE = argv.includes('-v');
const KEEP = argv.includes('--keep');
const GPU = argv.includes('--gpu') || !!process.env.UM_WGPU_HOME;
const shotsAt = argv.indexOf('--shots');
const SHOTS = shotsAt >= 0 ? path.resolve(argv[shotsAt + 1] || 'key-shots') : null;
const FFMPEG = process.env.FFMPEG || 'ffmpeg';

function umHome() {
  const cands = [process.env.UM_HOME, path.join(ROOT, '..', 'UnifiedMozaic'), path.join(ROOT, '..', '..', 'UnifiedMozaic')].filter(Boolean);
  for (const c of cands) {
    if (fs.existsSync(path.join(c, 'src', 'cli.ts'))) return c;
  }
  console.error('UnifiedMozaic のコンパイラが見つかりません。環境変数 UM_HOME にその場所を設定してください');
  process.exit(2);
}

function wgpuHome() {
  if (process.env.UM_WGPU_HOME && fs.existsSync(process.env.UM_WGPU_HOME)) return process.env.UM_WGPU_HOME;
  for (const base of [path.join(ROOT, '..', 'wgpu-native'), path.join(ROOT, '..', '..', 'wgpu-native')]) {
    try {
      const vers = fs.readdirSync(base).filter((d) => fs.existsSync(path.join(base, d, 'include'))).sort();
      if (vers.length) return path.join(base, vers[vers.length - 1]);
    } catch { /* なし */ }
  }
  return null;
}

const UM = umHome();
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mozcut-key-'));
for (const p of PLUGINS) fs.copyFileSync(path.join(PLUGINS_DIR, `${p}.um`), path.join(TMP, `${p}.um`));
fs.copyFileSync(path.join(HERE, 'key_test.um'), path.join(TMP, 'key_test.um'));

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
function check(name, cond, msg = '') {
  if (cond) ok(name);
  else ng(name, msg);
}

function build(exe, env = {}) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [path.join(UM, 'src', 'cli.ts'), 'build', path.join(TMP, 'key_test.um'), '--target', 'host', '-o', exe],
    { encoding: 'utf8', env: { ...process.env, ...env }, maxBuffer: 1 << 26 });
  if (r.status !== 0) {
    console.error(`key_test.um をビルドできません:\n${r.stdout}${r.stderr}`);
    return false;
  }
  console.log(`  ${path.basename(exe)} をビルドしました（${((Date.now() - t0) / 1000).toFixed(1)} 秒）`);
  return true;
}

function run(exe, args, env = {}) {
  const r = spawnSync(exe, args, { encoding: 'utf8', env: { ...process.env, ...env }, maxBuffer: 1 << 26 });
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

// "time <名前> <ミリ秒> <値>" の最小を表にする。
function bench(title, res) {
  const best = new Map();
  for (const line of res.out.split(/\r?\n/)) {
    const m = /^time (.+) ([\d.]+) [-\d.e]+$/.exec(line);
    if (m) best.set(m[1], Math.min(best.get(m[1]) ?? Infinity, Number(m[2])));
  }
  console.log(`  ${title}`);
  for (const [k, v] of best) console.log(`    ${k.padEnd(34)} ${v.toFixed(2).padStart(8)} ms`);
  if (best.size === 0) console.log(`    （測れません）\n${res.err}`);
  return best;
}

// ---- 素材（ffmpeg） ----

// 緑の背景（照明のむら・ノイズ・影つき）の前に、肌・髪・しま模様の服の人形。縁は柔らかく、髪の毛は 70% の不透明さで背景と混ざる。
// 服と肌には緑のこぼれ（G に +18）を足してある。bg は重ねる先のグラデーション。luma は黒い背景の上の光（ルミナンスキー用）。
function makeMedia(dir) {
  const L = '(1-0.3*((X-960)*(X-960)+(Y-540)*(Y-540))/1440000)*(1-0.5*clip(1-hypot((X-1450)/300,(Y-930)/110),0,1))';
  const HEAD = 'lt(Y,480)';
  const STRIPE = 'lt(mod(X+Y,140),70)';
  const alpha = "255*max(max(clip((1-hypot((X-960)/360,(Y-800)/400))*36,0,1),clip((165-hypot(X-960,Y-330))/2.5,0,1)),0.7*gt(abs(sin(40*atan2(Y-330,X-960))),0.85)*between(hypot(X-960,Y-330),160,220)*lt(Y,300))";
  const gs = `[0:v]format=rgb24,geq=r='34*${L}':g='177*${L}':b='76*${L}',noise=alls=5:allf=u,format=rgba[bg];` +
    `[0:v]format=rgba,geq=r='if(${HEAD},if(lt(Y,250),90,230),if(${STRIPE},200,240))':g='18+if(${HEAD},if(lt(Y,250),60,170),if(${STRIPE},40,220))':` +
    `b='if(${HEAD},if(lt(Y,250),40,140),if(${STRIPE},50,230))':a='${alpha}'[fg];[bg][fg]overlay=format=auto,format=rgba`;
  const jobs = [
    ['gs.png', ['-f', 'lavfi', '-i', `color=c=black:s=${W}x${H}:d=1`, '-filter_complex', gs, '-frames:v', '1']],
    ['gs.rgba', ['-i', path.join(dir, 'gs.png'), '-pix_fmt', 'rgba', '-f', 'rawvideo']],
    ['bg.rgba', ['-f', 'lavfi', '-i', `gradients=s=${W}x${H}:c0=0x1d2b53:c1=0xff9a3c:x0=0:y0=0:x1=${W}:y1=${H}:d=1`, '-frames:v', '1', '-pix_fmt', 'rgba', '-f', 'rawvideo']],
    ['luma.rgba', ['-f', 'lavfi', '-i', `color=c=black:s=${W}x${H}:d=1`, '-vf',
      "format=rgb24,geq=r='255*clip(1.3-hypot(X-960,Y-540)/260,0,1)':g='190*clip(1.3-hypot(X-960,Y-540)/260,0,1)':b='80*clip(1.3-hypot(X-960,Y-540)/260,0,1)+40*lt(abs(Y-900),40)*X/1920',format=rgba",
      '-frames:v', '1', '-pix_fmt', 'rgba', '-f', 'rawvideo']],
  ];
  for (const [name, args] of jobs) {
    const r = spawnSync(FFMPEG, ['-v', 'error', '-y', ...args, path.join(dir, name)], { encoding: 'utf8' });
    if (r.error || r.status !== 0) return `${name} を作れません: ${r.error ? r.error.message : r.stderr}`;
  }
  return '';
}

// 掛け方の一覧: [名前, 素材, 重ねる先, 効果と引数...]。引数は "," 区切りで、空なら既定値。
const CASES = [
  ['ck_default', 'gs', 'bg', 'chromakey', ''],
  ['ck_nospill', 'gs', 'bg', 'chromakey', ',,0'],
  ['ck_edge', 'gs', 'bg', 'chromakey', ',,,1,1'],
  ['ck_grow', 'gs', 'bg', 'chromakey', ',,,-2,4'],
  ['ck_big', 'gs', 'bg', 'chromakey', ',,2,12,12'],
  ['ck_matte', 'gs', '-', 'chromakey', '', 'matteview', ''],
  ['ck_checker', 'gs', '-', 'chromakey', ',,,1,1', 'matteview', '2'],
  ['lk_default', 'luma', 'bg', 'lumakey', ''],
  ['lk_invert', 'luma', 'bg', 'lumakey', '0.5,0.2,1,1,2'],
  ['lk_big', 'luma', 'bg', 'lumakey', '0.2,0.1,0,-10,16'],
];

function applyCase(exe, dir, c, env = {}) {
  const [name, fg, bg, ...fx] = c;
  return run(exe, ['--apply', path.join(dir, `${fg}.rgba`), bg === '-' ? '-' : path.join(dir, `${bg}.rgba`), String(W), String(H), path.join(dir, name), ...fx], env);
}

function readLayer(file) {
  const b = fs.readFileSync(file);
  return new Float32Array(b.buffer, b.byteOffset, b.length / 4);
}
const px = (L, x, y) => [L[(y * W + x) * 4], L[(y * W + x) * 4 + 1], L[(y * W + x) * 4 + 2], L[(y * W + x) * 4 + 3]];
const alphaAt = (L, x, y) => L[(y * W + x) * 4 + 3];
function countAlpha(L, pred) {
  let n = 0;
  for (let i = 3; i < L.length; i += 4) if (pred(L[i])) n++;
  return n;
}

// 画像の中身の試験（CPU の結果）。
function imageChecks(dir) {
  const d = readLayer(path.join(dir, 'ck_default.f32'));
  const corners = [[20, 20], [1900, 20], [20, 1060], [1900, 1060], [300, 540], [1700, 300]].map(([x, y]) => alphaAt(d, x, y));
  check('画像: 緑の背景（四隅の暗い所も）は透明', corners.every((a) => a === 0), `アルファ ${corners.join(', ')}`);
  const inner = [[960, 800], [960, 380], [700, 800], [1200, 900], [960, 1070]].map(([x, y]) => alphaAt(d, x, y));
  check('画像: 人形の中は不透明', inner.every((a) => a === 1), `アルファ ${inner.join(', ')}`);
  const sh = alphaAt(d, 1450, 930);
  check('画像: 影は半透明で残る', sh > 0.1 && sh < 1, `アルファ ${sh}`);
  // 服の白（G に +18 のこぼれ: (240, 238, 230)）→ G が R を超えないので変わらない。肌（230, 188, 140）も変わらない。
  const [r, g, b] = px(d, 960, 400);
  check('画像: 肌の色はこぼれの除去で変わらない', Math.abs(r - 230 / 255) < 1e-6 && Math.abs(g - 188 / 255) < 1e-6 && Math.abs(b - 140 / 255) < 1e-6, `${r} ${g} ${b}`);
  // 縁: 背景との境目は、どこかで G > max(R, B) のまま残っていない（こぼれの除去）
  let worst = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] > 0.05) worst = Math.max(worst, d[i + 1] - Math.max(d[i], d[i + 2]));
  }
  check('画像: 残った所に緑のこぼれがない（G ≤ max(R, B)）', worst <= 1e-6, `G - max(R, B) の最大 ${worst}`);
  const nos = readLayer(path.join(dir, 'ck_nospill.f32'));
  let sameA = true;
  for (let i = 3; i < d.length; i += 4) if (d[i] !== nos[i]) { sameA = false; break; }
  check('画像: spill はアルファを変えない', sameA);
  const opq = countAlpha(d, (a) => a > 0.5);
  const edge = readLayer(path.join(dir, 'ck_edge.f32'));
  const grow = readLayer(path.join(dir, 'ck_grow.f32'));
  const opqE = countAlpha(edge, (a) => a > 0.5);
  const opqG = countAlpha(grow, (a) => a > 0.5);
  check('画像: shrink=1 で不透明な所が減り、shrink=-2 で増える', opqE < opq && opqG > opq, `既定 ${opq}、shrink=1 ${opqE}、shrink=-2 ${opqG}`);
  const semi = countAlpha(d, (a) => a > 0 && a < 1);
  const semiE = countAlpha(edge, (a) => a > 0 && a < 1);
  check('画像: feather で半透明の縁が増える', semiE > semi, `既定 ${semi}、feather=1 ${semiE}`);
  const m = readLayer(path.join(dir, 'ck_matte.f32'));
  let matteOk = true;
  for (let i = 0; i < d.length; i += 4) {
    if (m[i] !== d[i + 3] || m[i + 1] !== d[i + 3] || m[i + 3] !== 1) { matteOk = false; break; }
  }
  check('画像: matteview はキーのアルファを白黒で見せる', matteOk);
  const lk = readLayer(path.join(dir, 'lk_default.f32'));
  check('画像: lumakey で黒い背景は透明、光の中心は不透明', alphaAt(lk, 20, 20) === 0 && alphaAt(lk, 960, 540) === 1,
    `${alphaAt(lk, 20, 20)} ${alphaAt(lk, 960, 540)}`);
  const li = readLayer(path.join(dir, 'lk_invert.f32'));
  check('画像: lumakey の invert で明るい中心が透明、黒は不透明', alphaAt(li, 960, 540) === 0 && alphaAt(li, 20, 20) === 1,
    `${alphaAt(li, 960, 540)} ${alphaAt(li, 20, 20)}`);
}

// 2 つの f32 の層が全部のビットで同じか。
function compareLayers(a, b) {
  const x = fs.readFileSync(a);
  const y = fs.readFileSync(b);
  if (x.length !== y.length) return `長さが違う（${x.length} と ${y.length}）`;
  if (x.equals(y)) return '';
  const fx = new Float32Array(x.buffer, x.byteOffset, x.length / 4);
  const fy = new Float32Array(y.buffer, y.byteOffset, y.length / 4);
  let diff = 0;
  let worst = 0;
  for (let i = 0; i < fx.length; i++) {
    if (!Object.is(fx[i], fy[i])) {
      diff++;
      worst = Math.max(worst, Math.abs(fx[i] - fy[i]));
    }
  }
  return `${diff} 個の値が違う（最大の差 ${worst}）`;
}

function writeShots(dir) {
  fs.mkdirSync(SHOTS, { recursive: true });
  const list = [['gs.png', 'source.png']];
  for (const c of CASES) list.push([`${c[0]}.bmp`, `${c[0]}.png`]);
  for (const [from, to] of list) {
    const r = spawnSync(FFMPEG, ['-v', 'error', '-y', '-i', path.join(dir, from), path.join(SHOTS, to)], { encoding: 'utf8' });
    if (r.status !== 0) console.log(`  ${to} を書けません: ${r.stderr}`);
  }
  // 縁を 4 倍に拡大したもの（右の肩と髪の毛）
  for (const [name, crop] of [['ck_default', '200:150:1220:700'], ['ck_edge', '200:150:1220:700'], ['ck_default', '240:180:840:70']]) {
    const out = `${name}_zoom_${crop.split(':').slice(2).join('_')}.png`;
    spawnSync(FFMPEG, ['-v', 'error', '-y', '-i', path.join(dir, `${name}.bmp`), '-vf', `crop=${crop},scale=iw*4:ih*4:flags=neighbor`, path.join(SHOTS, out)]);
  }
  console.log(`  結果の画像: ${SHOTS}`);
}

console.log('キーイング（plugins/chromakey.um・lumakey.um・matteview.um）');

// 宣言（@effect / @param など）を、このリポジトリの生成器（tools/gen-plugins.mjs の parsePlugin と、効果の名前のぶつかりを含む
// 登録表の生成）で読めるか。読めなければエンジンのビルドが止まるので、飛ばさずに落とす。
{
  let gen = null;
  try {
    gen = await import(new URL(`file:///${path.join(ROOT, 'tools', 'gen-plugins.mjs').replace(/\\/g, '/')}`).href);
  } catch (e) {
    ng('宣言: tools/gen-plugins.mjs を読む', e.message);
  }
  if (gen) {
    const parsed = [];
    for (const p of PLUGINS) {
      const rel = `plugins/${p}.um`;
      try {
        const fx = gen.parsePlugin(rel, fs.readFileSync(path.join(ROOT, rel), 'utf8'));
        parsed.push(fx);
        check(`宣言: ${p}（引数 ${fx.params.length} 個）を生成器が読める`, fx.name === p && fx.params.length >= 1, JSON.stringify(fx.params.map((q) => q.name)));
      } catch (e) {
        ng(`宣言: ${p} を生成器が読める`, e.message);
      }
    }
    // 既定値が key_test.um の ktDefaults と同じか（試験が古い既定で通らないように）
    const want = { chromakey: [0.3, 0.5, 1, 0, 0, 0.1, 0.7, 0.3], lumakey: [0.1, 0.1, 0, 0, 0], matteview: [1, 16] };
    for (const fx of parsed) {
      const got = fx.params.map((q) => q.def);
      check(`宣言: ${fx.name} の既定値が試験と同じ`, JSON.stringify(got) === JSON.stringify(want[fx.name]), `宣言 ${JSON.stringify(got)}、試験 ${JSON.stringify(want[fx.name])}`);
    }
    // 登録表の生成（ほかのプラグインと合わせて。コアのキーとのぶつかりも）。書き出しはしない
    if (typeof gen.render === 'function' && parsed.length === PLUGINS.length) {
      try {
        const all = fs.readdirSync(PLUGINS_DIR).filter((f) => f.endsWith('.um')).sort()
          .map((f) => gen.parsePlugin(`plugins/${f}`, fs.readFileSync(path.join(PLUGINS_DIR, f), 'utf8')));
        const reserved = typeof gen.coreKeyNames === 'function' ? gen.coreKeyNames(ROOT) : new Set();
        const clash = all.flatMap((fx) => [fx.name, ...fx.aliases.map((x) => x.name)]).filter((n) => reserved.has(n));
        const text = gen.render(all);
        check('宣言: 全部のプラグインで登録表を作れる（コアのキーとぶつからない）', clash.length === 0 && PLUGINS.every((p) => text.includes(`fx_${p}`)), clash.join(', '));
      } catch (e) {
        ng('宣言: 全部のプラグインで登録表を作れる', e.message);
      }
    }
  }
}

const exe = path.join(TMP, 'key_test' + EXT);
const haveCpu = build(exe);
let media = false;
if (haveCpu) {
  collect('cpu', run(exe, []));
  const err = makeMedia(TMP);
  if (err) {
    console.log(`  画像の試験は飛ばします（ffmpeg: ${err}）`);
  } else {
    media = true;
    for (const c of CASES) {
      const r = applyCase(exe, TMP, c);
      if (r.code !== 0) ng(`画像: ${c[0]} を掛ける`, `${r.out}${r.err}`);
    }
    imageChecks(TMP);
    if (SHOTS) writeShots(TMP);
  }
  if (BENCH && media) bench('CPU の速さ（1920x1080、1 コマ。5 回のうちの最小。「置いたまま」は CPU では同じ）', run(exe, ['--bench', path.join(TMP, 'gs.rgba'), String(W), String(H)]));
} else {
  ng('cpu: ビルド', 'key_test.um をビルドできません');
}

if (GPU) {
  const wh = wgpuHome();
  if (!wh) {
    console.log('  GPU の試験は飛ばします（wgpu-native が見つかりません。UM_WGPU_HOME を設定してください）');
  } else {
    const gexe = path.join(TMP, 'key_gpu' + EXT);
    if (build(gexe, { UM_WGPU: '1', UM_WGPU_HOME: wh })) {
      // UM_GPU_THRESHOLD=1: 自動の振り分けをやめ、どの dispatch も GPU で実行する
      const genv = { UM_GPU_THRESHOLD: '1' };
      collect('gpu', run(gexe, [], genv));
      if (media) {
        const gdir = path.join(TMP, 'gpu');
        fs.mkdirSync(gdir, { recursive: true });
        for (const f of ['gs.rgba', 'bg.rgba', 'luma.rgba']) fs.copyFileSync(path.join(TMP, f), path.join(gdir, f));
        for (const c of CASES) {
          const r = applyCase(gexe, gdir, c, { ...genv, UM_GPU_TRACE: '1' });
          if (r.code !== 0) {
            ng(`gpu: ${c[0]}`, `${r.out}${r.err}`);
            continue;
          }
          const onGpu = /wgpu: dispatch/.test(r.err);
          const diff = compareLayers(path.join(TMP, `${c[0]}.f32`), path.join(gdir, `${c[0]}.f32`));
          check(`gpu: ${c[0]} が CPU と全部のビットで同じ`, onGpu && diff === '', onGpu ? diff : 'GPU で実行されていません（UM_GPU_TRACE に dispatch がない）');
        }
        if (BENCH) bench('GPU の速さ（1920x1080、1 コマ。ふつうは層を CPU から送り、結果を CPU で読むまで。「置いたまま」は層を GPU に置いたままの計算だけ）', run(gexe, ['--bench', path.join(TMP, 'gs.rgba'), String(W), String(H)], genv));
      }
    } else {
      ng('gpu: ビルド', 'UM_WGPU=1 でビルドできません');
    }
  }
}

if (!KEEP) fs.rmSync(TMP, { recursive: true, force: true });
else console.log(`  作業用のフォルダ: ${TMP}`);
console.log(failures.length === 0 ? `ぜんぶ通りました（${passed} 件）` : `${failures.length} 件が落ちました（通ったのは ${passed} 件）`);
process.exit(failures.length === 0 ? 0 : 1);
