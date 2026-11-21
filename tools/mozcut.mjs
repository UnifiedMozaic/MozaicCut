#!/usr/bin/env node
// MozaicCut の実行役。編集の計算はすべて UnifiedMozaic のネイティブバイナリ（build/mozcut）が行い、
// このスクリプトは ffmpeg / ffprobe での素材の展開と書き出し、キャッシュの管理だけをする。
//
// 使い方は USAGE を見る。check / show / op / schema は、素材を調べてから（schema は調べずに）エンジンにそのまま渡す。
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { generate, mapDiagnostics } from './gen-plugins.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXT = process.platform === 'win32' ? '.exe' : '';
const EXE = path.join(ROOT, 'build', 'mozcut' + EXT);
const EDITOR_EXE = path.join(ROOT, 'build', 'mozcut-edit' + EXT);
const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const FFPROBE = process.env.FFPROBE || 'ffprobe';

const USAGE = `使い方: node tools/mozcut.mjs <コマンド> ...

  edit    <project.mzc>                         編集画面を開く（ウィンドウ。SDL3 が要る）
  render  <project.mzc> [-o out.mp4] [--from t] [--to t] [-j N]
                                                動画を書き出す（既定は project の output）
  preview <project.mzc> <time> [-o preview.png] 1 コマを画像に書く
  check   <project.mzc> [--json]                誤りを調べる（誤りなし 0、誤りあり 1）
  show    <project.mzc> [--width N]             タイムラインの図とクリップの一覧
  op      <project.mzc> <操作...> [--dry-run] [--json]
  op      <project.mzc> --file <ops.txt | -> [--dry-run] [--json]
                                                操作を適用して保存する。--file はファイル（- なら標準入力）の 1 行に 1 つ
  schema  [--json]                              キー・効果・操作・時刻と参照の書き方の一覧
  build                                         エンジンと編集画面を作り直す

op の書き方: node tools/mozcut.mjs schema`;

// --json のとき、mozcut.mjs が止まる誤りも {"ok":false,"error":...} を標準出力に書く（AI が読めるように）。
let JSON_OUT = false;

function die(msg, code = 1) {
  if (JSON_OUT) console.log(JSON.stringify({ ok: false, error: msg }));
  console.error(`mozcut: ${msg}`);
  process.exit(code);
}

function usageExit(msg) {
  if (JSON_OUT) console.log(JSON.stringify({ ok: false, error: msg || '使い方の誤りです' }));
  if (msg) console.error(`mozcut: ${msg}\n`);
  console.error(USAGE);
  process.exit(2);
}

function umHome() {
  const cands = [process.env.UM_HOME, path.join(ROOT, '..', 'UnifiedMozaic')].filter(Boolean);
  for (const c of cands) {
    if (fs.existsSync(path.join(c, 'src', 'cli.ts'))) return c;
  }
  die('UnifiedMozaic のコンパイラが見つかりません。環境変数 UM_HOME にその場所を設定してください');
}

// いちばん新しいソースの時刻（src/**/*.um と plugins/*.um）。
function newestSource() {
  let t = 0;
  const walk = (dir, deep) => {
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const f = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (deep) walk(f, deep);
      } else if (e.name.endsWith('.um')) {
        t = Math.max(t, fs.statSync(f).mtimeMs);
      }
    }
  };
  walk(path.join(ROOT, 'src'), true);
  walk(path.join(ROOT, 'plugins'), false);
  return t;
}

// プラグインの登録表（src/gen/）を作る。宣言の誤りは「plugins/x.um:3: 説明」の形で出して終わる。
function genPlugins() {
  try {
    generate(ROOT);
  } catch (e) {
    die(`プラグインの宣言に誤りがあります\n  ${mapDiagnostics(e.message)}\n  （書き方は docs/design/architecture.md の「効果プラグインの書き方」）`);
  }
}

// SDL3 の場所（UM_SDL3 がなければ、このリポジトリの隣とホームの SDL3-* を探す）。
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

// エンジン（main.um、ウィンドウなし）か編集画面（editor.um、SDL3 をリンク）をビルドする。
function build(force = false, which = 'engine') {
  genPlugins();
  const exe = which === 'editor' ? EDITOR_EXE : EXE;
  if (!force && fs.existsSync(exe) && fs.statSync(exe).mtimeMs >= newestSource()) return;
  console.error(`mozcut: ${which === 'editor' ? '編集画面' : 'エンジン'}をビルドしています（UnifiedMozaic、ネイティブ）...`);
  fs.mkdirSync(path.dirname(exe), { recursive: true });
  const env = { ...process.env };
  if (which === 'editor') {
    const sdl = sdl3Home();
    if (sdl) env.UM_SDL3 = sdl;
  }
  const src = path.join(ROOT, 'src', which === 'editor' ? 'editor.um' : 'main.um');
  // コンパイラの診断がプラグインの写し（src/gen/fx/）を指したら、元の plugins/ に読み替えて出す
  const r = spawnSync(process.execPath, [path.join(umHome(), 'src', 'cli.ts'), 'build', src, '--target', 'host', '-o', exe],
    { stdio: ['ignore', 'pipe', 'pipe'], env, encoding: 'utf8', maxBuffer: 1 << 26 });
  if (r.stdout) process.stdout.write(mapDiagnostics(r.stdout));
  if (r.stderr) process.stderr.write(mapDiagnostics(r.stderr));
  if (r.error) die(`コンパイラを起動できません: ${r.error.message}`);
  if (r.status !== 0) die(which === 'editor' ? 'ビルドに失敗しました（編集画面には SDL3 が要ります。README を見るか、UM_SDL3 を設定してください）' : 'ビルドに失敗しました');
}

// エンジンを実行する。stdout を返し、stderr はそのまま流す。
// soft なら、失敗したときに終了せず例外にする（編集中はプロジェクトが一時的に壊れていてもよい）。
function engine(args, { capture = true, soft = false } = {}) {
  const r = spawnSync(EXE, args, { stdio: ['ignore', capture ? 'pipe' : 'inherit', soft ? 'pipe' : 'inherit'], encoding: 'utf8', maxBuffer: 1 << 26 });
  if (r.error) die(`${EXE} を起動できません: ${r.error.message}`);
  if (r.status !== 0) {
    if (soft) throw new Error(r.stderr || `エンジンが終了コード ${r.status} で終わりました`);
    process.exit(r.status ?? 1);
  }
  return r.stdout ?? '';
}

// エンジンにそのまま渡す（標準入出力もつなぐ）。終了コードもそのまま返して終わる。
function passthrough(args) {
  const r = spawnSync(EXE, args, { stdio: 'inherit' });
  if (r.error) die(`${EXE} を起動できません: ${r.error.message}`);
  process.exit(r.status ?? 1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 展開が済んだ一時ファイルで置き換える。編集画面が読んでいる最中だと Windows では失敗するので、少し待って繰り返す。
async function replaceFile(tmp, out) {
  for (let i = 0; ; i++) {
    try {
      fs.renameSync(tmp, out);
      return;
    } catch (e) {
      if (i >= 40) throw e;
      await sleep(25);
    }
  }
}

function run(cmd, args, label) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', (e) => reject(new Error(`${label}: ${cmd} を起動できません（${e.message}）。ffmpeg を入れるか、FFMPEG / FFPROBE を設定してください`)));
    p.on('close', (code) => code === 0 ? resolve() : reject(new Error(`${label}: ${cmd} が失敗しました（終了コード ${code}）\n${err.trim()}`)));
  });
}

async function pool(jobs, n) {
  let next = 0;
  const workers = Array.from({ length: Math.min(n, jobs.length) }, async () => {
    while (next < jobs.length) await jobs[next++]();
  });
  await Promise.all(workers);
}

function parseArgs(argv) {
  const pos = [];
  const opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-o' || a === '--out') opt.out = argv[++i];
    else if (a === '--from') opt.from = argv[++i];
    else if (a === '--to') opt.to = argv[++i];
    else if (a === '-j' || a === '--jobs') opt.jobs = Number(argv[++i]);
    else pos.push(a);
  }
  return { pos, opt };
}

// 素材を ffprobe で調べて cache/probe.txt に書く（長さを書かないクリップのため）。
function probe(projectPath, projectDir, cache, soft = false) {
  const out = engine(['sources', projectPath], { soft });
  const lines = [];
  for (const line of out.split('\n')) {
    const [tag, src] = line.replace(/\r$/, '').split('\t');
    if (tag !== 'src') continue;
    const file = path.resolve(projectDir, src);
    if (!fs.existsSync(file)) {
      // 見つからないことを probe.txt に書く（エンジンが missing-source として行の番号つきで出す）
      if (soft) {
        lines.push([src, 'missing', 0, 0, file].join('\t'));
        continue;
      }
      die(`素材が見つかりません: ${src}（${file} を探しました）`);
    }
    const r = spawnSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type', '-of', 'json', file], { encoding: 'utf8' });
    if (r.error) die(`${FFPROBE} を起動できません（${r.error.message}）。ffmpeg を入れるか、FFPROBE を設定してください`);
    if (r.status !== 0) {
      if (soft) continue;
      die(`ffprobe が ${src} を読めませんでした:\n${r.stderr}`);
    }
    const j = JSON.parse(r.stdout);
    const types = (j.streams || []).map((s) => s.codec_type);
    const dur = Number(j.format?.duration);
    lines.push([src, Number.isFinite(dur) ? dur : 'nan', types.includes('video') ? 1 : 0, types.includes('audio') ? 1 : 0].join('\t'));
  }
  const probeFile = path.join(cache, 'probe.txt');
  const text = lines.join('\n') + '\n';
  // 変わったときだけ書く（編集画面は中身の変化で読み直す）
  if (!fs.existsSync(probeFile) || fs.readFileSync(probeFile, 'utf8') !== text) fs.writeFileSync(probeFile, text);
}

// plan の 1 行から ffmpeg の引数を作る。
function decodeArgs(f, file) {
  switch (f[0]) {
    case 'video':
      return ['-y', '-v', 'error', '-ss', f[3], '-t', f[4], '-i', file, '-an', '-sn',
        '-vf', `fps=${f[5]},${f[6]}`, '-pix_fmt', 'yuv420p', '-f', 'yuv4mpegpipe', f[7]];
    case 'image':
      return ['-y', '-v', 'error', '-i', file, ...(f[3] !== '-' ? ['-vf', f[3]] : []),
        '-frames:v', '1', '-pix_fmt', 'rgba', '-c:v', 'pam', '-f', 'image2', '-update', '1', f[4]];
    case 'audio':
      return ['-y', '-v', 'error', '-ss', f[3], '-t', f[4], '-i', file, '-vn', '-sn',
        '-ac', '2', '-ar', f[5], '-f', 's16le', f[6]];
  }
  return null;
}

function cacheDir(projectPath) {
  return path.join(path.dirname(projectPath), path.basename(projectPath).replace(/\.[^.]+$/, '') + '.cache');
}

async function prepare(projectPath, opt, range, soft = false) {
  build();
  const projectDir = path.dirname(projectPath);
  const cache = cacheDir(projectPath);
  fs.mkdirSync(cache, { recursive: true });
  probe(projectPath, projectDir, cache, soft);
  const plan = engine(['plan', projectPath, cache], { soft }).split('\n').map((l) => l.replace(/\r$/, '').split('\t'));
  const spans = new Map();
  for (const f of plan) if (f[0] === 'clip') spans.set(f[1], [Number(f[2]), Number(f[3])]);
  const jobs = [];
  let skipped = 0;
  for (const f of plan) {
    if (!['video', 'image', 'audio'].includes(f[0])) continue;
    const span = spans.get(f[1]);
    if (range && span && (span[1] <= range[0] || span[0] > range[1])) continue;
    const file = path.resolve(projectDir, f[2]);
    if (!fs.existsSync(file)) continue;
    const args = decodeArgs(f, file);
    const out = args[args.length - 1];
    args[args.length - 1] = out + '.tmp';
    const st = fs.statSync(file);
    const key = JSON.stringify({ args, size: st.size, mtime: st.mtimeMs });
    const keyFile = out + '.key';
    if (fs.existsSync(out) && fs.existsSync(keyFile) && fs.readFileSync(keyFile, 'utf8') === key) {
      skipped++;
      continue;
    }
    jobs.push(async () => {
      if (fs.existsSync(keyFile)) fs.rmSync(keyFile);
      await run(FFMPEG, args, `${f[0]} ${f[2]} (clip #${f[1]})`);
      await replaceFile(out + '.tmp', out);
      // 展開した範囲の始まり。編集画面が、展開し直すまでのあいだ古い展開から正しいコマを読むのに使う
      if (f[0] === 'video') fs.writeFileSync(out + '.in', f[3]);
      fs.writeFileSync(keyFile, key);
    });
  }
  if (jobs.length) console.error(`mozcut: ffmpeg で素材を ${jobs.length} 件展開しています${skipped ? `（${skipped} 件は展開済み）` : ''}...`);
  await pool(jobs, opt.jobs || Math.max(1, Math.min(4, os.cpus().length >> 1)));
  return { cache, plan, projectDir };
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'build') {
    build(true);
    build(true, 'editor');
    return;
  }
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log(USAGE);
    return;
  }
  if (cmd === 'schema') {
    build();
    passthrough(['schema', ...rest]);
  }
  // check / show / op: 素材を調べてから、project と cache を添えて残りの引数をそのまま渡す
  if (cmd === 'check' || cmd === 'show' || cmd === 'op') {
    JSON_OUT = rest.includes('--json');
    const given = rest[0];
    if (given === undefined || given.startsWith('--')) usageExit(`${cmd} にはプロジェクトのファイルを渡します`);
    const projectPath = path.resolve(given);
    if (!fs.existsSync(projectPath)) die(`プロジェクトがありません: ${given}`);
    if (cmd === 'op') {
      // 操作の語（オプションと、--file の値を除く）がなければ使い方の誤り
      const words = [];
      for (let i = 1; i < rest.length; i++) {
        if (rest[i] === '--file') { words.push('--file'); i++; continue; }
        if (!rest[i].startsWith('--')) words.push(rest[i]);
      }
      if (words.length === 0) usageExit('操作がありません（例: node tools/mozcut.mjs op demo.mzc move pip 2。書き方は node tools/mozcut.mjs schema）');
    }
    build();
    const cache = cacheDir(projectPath);
    fs.mkdirSync(cache, { recursive: true });
    // 調べられない素材は飛ばす（その誤りはエンジンが診断として出す）
    try {
      probe(projectPath, path.dirname(projectPath), cache, true);
    } catch {
      // プロジェクトが読めないなどの誤りもエンジンが出す
    }
    passthrough([cmd, given, cache, ...rest.slice(1)]);
  }
  const { pos, opt } = parseArgs(rest);
  if (!cmd || !pos[0] || !['edit', 'render', 'preview'].includes(cmd)) {
    if (cmd && !['edit', 'render', 'preview'].includes(cmd)) usageExit(`'${cmd}' というコマンドはありません`);
    usageExit(cmd ? `${cmd} にはプロジェクトのファイルを渡します` : '');
  }
  const projectPath = path.resolve(pos[0]);
  if (!fs.existsSync(projectPath)) die(`プロジェクトがありません: ${pos[0]}`);

  if (cmd === 'edit') return edit(projectPath, opt);

  if (cmd === 'preview') {
    const t = pos[1];
    if (t === undefined) die('preview には時刻を渡します（例: 3.5、1:02）');
    const secs = t.split(':').reduce((a, x) => a * 60 + Number(x), 0);
    if (!Number.isFinite(secs) || secs < 0) die(`'${t}' は時刻として読めません（3.5 や 1:02.5 のように書きます）`, 2);
    const { cache, projectDir } = await prepare(projectPath, opt, [secs, secs]);
    const out = path.resolve(opt.out || path.join(projectDir, 'preview.png'));
    const bmp = out.toLowerCase().endsWith('.bmp') ? out : path.join(cache, 'preview.bmp');
    // エンジンの「中間の BMP を書きました」は見せず、最後の画像の場所だけを出す（警告はそのまま流す）
    const r = spawnSync(EXE, ['preview', projectPath, cache, t, bmp], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
    if (r.error) die(`${EXE} を起動できません: ${r.error.message}`);
    for (const l of (r.stderr || '').split(/\r?\n/)) {
      if (l && !/ を書きました（/.test(l)) console.error(l);
    }
    if (r.status !== 0) process.exit(r.status ?? 1);
    if (bmp !== out) await run(FFMPEG, ['-y', '-v', 'error', '-i', bmp, out], 'preview');
    console.error(`mozcut: ${path.relative(process.cwd(), out) || out} に書きました（${fmtSec(secs)}）`);
    return;
  }

  // render
  const parseT = (v, name) => {
    const x = String(v).split(':').reduce((a, y) => a * 60 + Number(y), 0);
    if (!Number.isFinite(x) || x < 0) die(`${name} の値 '${v}' は時刻として読めません（3.5 や 1:02.5 のように書きます）`, 2);
    return x;
  };
  const range = opt.from || opt.to ? [opt.from ? parseT(opt.from, '--from') : 0, opt.to ? parseT(opt.to, '--to') : Infinity] : null;
  if (range && range[0] >= range[1]) die(`範囲が空です（--from ${opt.from ?? 0} --to ${opt.to}）。--to は --from より後ろにします`, 2);
  const { cache, plan, projectDir } = await prepare(projectPath, opt, range);
  if (range) {
    const total = projectDuration(projectPath, cache);
    if (total !== null && range[0] >= total) die(`範囲が空です（--from ${opt.from} は全体の長さ ${fmtSec(total)} より後ろです）`, 2);
  }
  const enc = plan.find((f) => f[0] === 'encode');
  const renderArgs = ['render', projectPath, cache];
  if (opt.from || opt.to) renderArgs.push(opt.from ?? '0', ...(opt.to ? [opt.to] : []));
  engine(renderArgs, { capture: false });
  const [, y4m, pcm, rate, crf, preset, output] = enc;
  const out = path.resolve(opt.out ? process.cwd() : projectDir, opt.out || output);
  console.error(`mozcut: ${out} を書き出しています...`);
  await run(FFMPEG, ['-y', '-v', 'error', '-f', 'yuv4mpegpipe', '-i', y4m, '-f', 's16le', '-ar', rate, '-ac', '2', '-i', pcm,
    '-map', '0:v', '-map', '1:a',
    '-vf', 'setparams=range=tv:colorspace=bt709:color_primaries=bt709:color_trc=bt709',
    '-c:v', 'libx264', '-preset', preset, '-crf', crf, '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', out], 'encode');
  // 書き出しの中間ファイルは大きいので消す（素材の展開はキャッシュとして残す）
  fs.rmSync(y4m, { force: true });
  fs.rmSync(pcm, { force: true });
  console.error(`mozcut: ${out} に書き出しました`);
}

// 秒を m:ss.mmm にする（show / check と同じ表記）。
function fmtSec(t) {
  const ms = Math.round(t * 1000);
  const m = Math.floor(ms / 60000);
  const sec = (ms % 60000) / 1000;
  return `${m}:${sec.toFixed(3).padStart(6, '0')}`;
}

// プロジェクトの全体の長さ（秒）。読めなければ null。
function projectDuration(projectPath, cache) {
  const r = spawnSync(EXE, ['check', projectPath, cache, '--json'], { encoding: 'utf8', maxBuffer: 1 << 26 });
  try {
    return JSON.parse(r.stdout).project.duration;
  } catch {
    return null;
  }
}

// 編集画面を開き、プロジェクトファイルが変わるたびに素材を展開し直す（画面は自分で読み直す）。
async function edit(projectPath, opt) {
  build();
  build(false, 'editor');
  const cache = cacheDir(projectPath);
  fs.mkdirSync(cache, { recursive: true });
  let busy = false;
  let again = false;
  const refresh = async () => {
    if (busy) {
      again = true;
      return;
    }
    busy = true;
    do {
      again = false;
      try {
        await prepare(projectPath, opt, null, true);
      } catch (e) {
        // 書きかけのプロジェクトの誤りは編集画面が表示するので、ここでは ffmpeg の失敗だけを知らせる
        if (!/\.mzc(:\d+)*: (エラー|警告)\[/.test(e.message)) console.error(`mozcut: ${e.message.trim()}`);
      }
    } while (again);
    busy = false;
  };
  await refresh();
  const ui = spawn(EDITOR_EXE, [projectPath, cache], { stdio: 'inherit' });
  fs.watchFile(projectPath, { interval: 300 }, () => { refresh(); });
  ui.on('exit', (code) => {
    fs.unwatchFile(projectPath);
    process.exit(code ?? 0);
  });
}

main().catch((e) => die(e.message));
