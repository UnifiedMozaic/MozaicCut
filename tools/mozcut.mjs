#!/usr/bin/env node
// MozaicCut の実行役。編集の計算はすべて UnifiedMozaic のネイティブバイナリ（build/mozcut）が行い、
// このスクリプトはビルドと、エンジンに FFmpeg の組み込みがないとき（予備の経路）の ffmpeg / ffprobe での素材の展開と
// 書き出し、キャッシュの管理だけをする。FFmpeg の組み込みがあれば（caps）、素材はエンジンがその場で展開する。
//
// 使い方は USAGE を見る。check / show / op / schema は、素材を調べてから（schema は調べずに）エンジンにそのまま渡す。
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { generate, mapDiagnostics, parsePlugin, coreKeyNames, pluginSource, buildPlugin, readManifest, describeManifest } from './gen-plugins.mjs';
import { ffmpegLibsFound, useFfmpegOff } from './ffmpeg-libs.mjs';
import { makePackage, makeMacApp } from './package.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXT = process.platform === 'win32' ? '.exe' : '';
const EXE = path.join(ROOT, 'build', 'mozcut' + EXT);
const EDITOR_EXE = path.join(ROOT, 'build', 'mozcut-edit' + EXT);
// 古い編集画面（src/editor.um）。edit --old で使う（プロジェクトなしの edit --old なら、そのスタート画面）
const EDITOR_OLD_EXE = path.join(ROOT, 'build', 'mozcut-edit-old' + EXT);
const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const FFPROBE = process.env.FFPROBE || 'ffprobe';

const USAGE = `使い方: node tools/mozcut.mjs <コマンド> ...

  edit    [<project.mzc>] [--old]               編集画面を開く（ウィンドウ。SDL3 が要る。省くとスタート画面）
                                                --old なら古い編集画面（src/editor.um）で開く
  render  <project.mzc> [-o out.mp4] [--from t] [--to t] [-j N]
                                                動画を書き出す（既定は project の output）
  preview <project.mzc> <time> [-o preview.png] 1 コマを画像に書く
  check   <project.mzc> [--json]                誤りを調べる（誤りなし 0、誤りあり 1）
  show    <project.mzc> [--width N]             タイムラインの図とクリップの一覧
  op      <project.mzc> <操作...> [--dry-run] [--json]
  op      <project.mzc> --file <ops.txt | -> [--dry-run] [--json]
                                                操作を適用して保存する。--file はファイル（- なら標準入力）の 1 行に 1 つ
  schema  [--json]                              キー・効果・操作・時刻と参照の書き方の一覧
  motion  <project.mzc> <追うクリップ> <x,y> --to <動かすクリップ> [--dry-run] [--json]
                                                映像の中の点（画面の画素）を追い、動かすクリップの位置のキーフレームにする
  build                                         エンジンと編集画面を作り直す
  package [-o <dir>]                            配布の形を作る。Windows は dist/MozaicCut/（MozaicCut.exe と DLL・tokens.json・
                                                アイコン・説明書・ライセンスの文書）、macOS は dist/MozaicCut.app。node なしで動く
  plugin build <名前 | file.um> [-o out.mzplug] 効果のプラグインを wasm（dist/<名前>.mzplug）にする
  plugin list [--json]                          組み込みの効果と、入れた .mzplug の一覧
  plugin install <file.mzplug>                  .mzplug を plugins-installed/ に入れる
  plugin uninstall <名前>                       入れた .mzplug を外す

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

// wgpu-native の場所（UM_WGPU_HOME がなければ、このリポジトリの隣とホームの wgpu-native/<版> を探し、mac では Homebrew の wgpu-native も見る）。
function wgpuHome() {
  if (process.env.UM_WGPU_HOME) return process.env.UM_WGPU_HOME;
  for (const dir of [path.join(ROOT, '..', 'wgpu-native'), path.join(os.homedir(), 'wgpu-native')]) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const n of names.sort().reverse()) {
      if (fs.existsSync(path.join(dir, n, 'include'))) return path.join(dir, n);
    }
  }
  // mac では Homebrew の wgpu-native も見る
  if (process.platform === 'darwin') {
    for (const d of ['/opt/homebrew/opt/wgpu-native', '/usr/local/opt/wgpu-native']) {
      // UM のコンパイラ（findWgpu）が要るファイルがそろうときだけ使う。足りないのに UM_WGPU_HOME を渡すと、CPU 版に戻らず止まる
      const need = ['include/webgpu/webgpu.h', 'include/webgpu/wgpu.h', 'lib/libwgpu_native.dylib'];
      if (need.every((f) => fs.existsSync(path.join(d, f)))) return d;
    }
  }
  return undefined;
}

// SDL3 の場所（UM_SDL3 がなければ、このリポジトリの隣とホームの SDL3-* を探し、mac では Homebrew の sdl3 も見る）。
function sdl3Home() {
  if (process.env.UM_SDL3) return process.env.UM_SDL3;
  for (const dir of [path.join(ROOT, '..'), os.homedir()]) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const n of names.filter((n) => n.startsWith('SDL3-')).sort().reverse()) {
      if (fs.existsSync(path.join(dir, n, 'include', 'SDL3', 'SDL.h'))) return path.join(dir, n);
    }
  }
  // mac では Homebrew の sdl3 も見る
  if (process.platform === 'darwin') {
    for (const d of ['/opt/homebrew/opt/sdl3', '/usr/local/opt/sdl3']) {
      const f = path.join(d, 'include', 'SDL3', 'SDL.h');
      if (fs.existsSync(f)) return d;
    }
  }
  return undefined;
}

// Windows の exe にアプリのアイコン（assets/icon/mozaiccut.ico）を埋め込むための、リンクに足す引数。
// llvm-rc でアイコンのリソース（build/mozaiccut.res）を作り、UM の --link-input で渡す。
// llvm-rc がなければ（環境変数 LLVM_RC でも指定できる）、アイコンなしでビルドする。Windows 以外では何もしない。
let iconArgs = null;
function iconLinkArgs() {
  if (iconArgs) return iconArgs;
  iconArgs = [];
  if (process.platform !== 'win32') return iconArgs;
  const ico = path.join(ROOT, 'assets', 'icon', 'mozaiccut.ico');
  const rc = [process.env.LLVM_RC, 'C:/Program Files/LLVM/bin/llvm-rc.exe'].filter(Boolean).find((f) => fs.existsSync(f));
  if (!rc || !fs.existsSync(ico)) {
    console.error('mozcut: llvm-rc が見つからないので、exe にアイコンを付けずにビルドします（LLVM を入れるか、LLVM_RC を設定してください）');
    return iconArgs;
  }
  const dir = path.join(ROOT, 'build');
  fs.mkdirSync(dir, { recursive: true });
  const rcFile = path.join(dir, 'mozaiccut.rc');
  const res = path.join(dir, 'mozaiccut.res');
  // 最初のアイコンが exe のアイコンになる。rc の文字列の中では \ を重ねる
  fs.writeFileSync(rcFile, `1 ICON "${ico.replace(/\\/g, '\\\\')}"\n`);
  const r = spawnSync(rc, ['-fo', res, rcFile], { encoding: 'utf8' });
  if (r.status !== 0 || !fs.existsSync(res)) {
    console.error(`mozcut: アイコンのリソースを作れなかったので、アイコンなしでビルドします\n${r.stdout ?? ''}${r.stderr ?? ''}`);
    return iconArgs;
  }
  iconArgs = ['--link-input', res];
  return iconArgs;
}

// Windows で、編集画面の exe をコンソールの窓なしで起動させるための、リンクに足す引数（エクスプローラーからダブルクリックしたとき、
// 黒い窓を出さない）。リンカへの指示（/SUBSYSTEM:WINDOWS と、入口を main のままにする /ENTRY:mainCRTStartup）だけを持つ
// COFF のオブジェクト（.drectve の節だけ）を build/gui-subsystem.obj に書き、UM の --link-input で渡す。
// 標準出力・標準エラー出力は、起動した側がつないだもの（パイプや mozcut.mjs の inherit）にそのまま出る。Windows 以外では何もしない。
function guiSubsystemLinkArgs() {
  if (process.platform !== 'win32') return [];
  const dir = path.join(ROOT, 'build');
  fs.mkdirSync(dir, { recursive: true });
  const obj = path.join(dir, 'gui-subsystem.obj');
  const directives = Buffer.from(' /SUBSYSTEM:WINDOWS /ENTRY:mainCRTStartup', 'latin1');
  // ファイルの見出し（20 バイト）・節の見出し（40 バイト）・指示の文字列・空の文字列表（大きさ 4 だけ）
  const head = Buffer.alloc(20);
  head.writeUInt16LE(process.arch === 'arm64' ? 0xaa64 : 0x8664, 0);
  head.writeUInt16LE(1, 2);
  head.writeUInt32LE(60 + directives.length, 8);
  const sec = Buffer.alloc(40);
  sec.write('.drectve', 0, 'latin1');
  sec.writeUInt32LE(directives.length, 16);
  sec.writeUInt32LE(60, 20);
  // IMAGE_SCN_LNK_INFO | IMAGE_SCN_LNK_REMOVE | IMAGE_SCN_ALIGN_1BYTES（リンカが読むだけで、exe には入らない）
  sec.writeUInt32LE(0x00100a00, 36);
  const strtab = Buffer.alloc(4);
  strtab.writeUInt32LE(4, 0);
  fs.writeFileSync(obj, Buffer.concat([head, sec, directives, strtab]));
  return ['--link-input', obj];
}

// エンジン（main.um、ウィンドウなし）か編集画面（edit2.um、SDL3 をリンク）か古い編集画面（editor.um）をビルドする。
// FFmpeg のライブラリ（UM_FFMPEG_HOME など）が見つかれば、素材をその場で展開する FFmpeg の組み込みを使う。
// 見つからなければ、src/ を build/src-noffmpeg-<engine か editor か editor-old>/ に写して ffmpeg.um を ffmpeg_off.um に差し替えてビルドする
// （本物の src/ は書き換えない。素材は ffmpeg のコマンドで展開したキャッシュから読む）。
// どちらでビルドしたかを build/ffmpeg-variant-<engine か editor か editor-old>.txt に書き、変わったら作り直す。
const BUILDS = {
  engine: { exe: EXE, src: 'main.um', name: 'エンジン' },
  editor: { exe: EDITOR_EXE, src: 'edit2.um', name: '編集画面' },
  'editor-old': { exe: EDITOR_OLD_EXE, src: 'editor.um', name: '古い編集画面' },
};
// コンパイラ（clang）は CPU を多く使うので、ビルドは低い優先度で動かす（子のプロセスもこの優先度を受け継ぐ）。
// 利用者の作業を重くしないため。MOZCUT_BUILD_PRIORITY=normal で普通の優先度に戻せる。
let buildPriorityLowered = false;
function lowerBuildPriority() {
  if (buildPriorityLowered || process.env.MOZCUT_BUILD_PRIORITY === 'normal') return;
  buildPriorityLowered = true;
  try {
    os.setPriority(process.pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
  } catch {
    // 変えられない環境ではそのまま
  }
}

function build(force = false, which = 'engine') {
  genPlugins();
  const b = BUILDS[which];
  const exe = b.exe;
  const variant = ffmpegLibsFound() ? 'ffmpeg' : 'cache';
  const variantFile = path.join(ROOT, 'build', `ffmpeg-variant-${which}.txt`);
  const sameVariant = fs.existsSync(variantFile) && fs.readFileSync(variantFile, 'utf8') === variant;
  if (!force && sameVariant && fs.existsSync(exe) && fs.statSync(exe).mtimeMs >= newestSource()) return;
  lowerBuildPriority();
  console.error(`mozcut: ${b.name}をビルドしています（UnifiedMozaic、ネイティブ${variant === 'ffmpeg' ? '、FFmpeg の組み込みあり' : '、FFmpeg のライブラリがないので展開したキャッシュで動かす版'}）...`);
  fs.mkdirSync(path.dirname(exe), { recursive: true });
  const env = { ...process.env };
  // 登録表（src/gen/plugins.um）が .mzplug の読み込み（src/wasmfx.um）を使うので、エンジンも編集画面も wasmtime をリンクする
  const wt = wasmtimeHome();
  if (wt) env.UM_WASMTIME = wt;
  if (which !== 'engine') {
    const sdl = sdl3Home();
    if (sdl) env.UM_SDL3 = sdl;
  }
  // 編集画面は GPU（wgpu-native）で描く。見つかれば UM_WGPU=1 でビルドする（なければ CPU だけの版になる）
  if (which === 'editor') {
    const wg = wgpuHome();
    if (wg) {
      env.UM_WGPU_HOME = wg;
      env.UM_WGPU = '1';
    }
  }
  let srcDir = path.join(ROOT, 'src');
  if (variant === 'cache') {
    const copy = path.join(ROOT, 'build', `src-noffmpeg-${which}`);
    fs.rmSync(copy, { recursive: true, force: true });
    fs.cpSync(srcDir, copy, { recursive: true });
    useFfmpegOff(copy);
    srcDir = copy;
  }
  const src = path.join(srcDir, b.src);
  // mac: Info.plist の LSMinimumSystemVersion（13.0）に合わせて、本体も macOS 13 向けに作る（決めないと、作った Mac の版になる）
  if (process.platform === 'darwin') env.MACOSX_DEPLOYMENT_TARGET ??= '13.0';
  // コンパイラの診断がプラグインの写し（src/gen/fx/）を指したら、元の plugins/ に読み替えて出す
  const r = spawnSync(process.execPath, [path.join(umHome(), 'src', 'cli.ts'), 'build', src, '--target', 'host', '-o', exe, ...iconLinkArgs(), ...(which === 'editor' ? guiSubsystemLinkArgs() : [])],
    { stdio: ['ignore', 'pipe', 'pipe'], env, encoding: 'utf8', maxBuffer: 1 << 26 });
  if (r.stdout) process.stdout.write(mapDiagnostics(r.stdout));
  if (r.stderr) process.stderr.write(mapDiagnostics(r.stderr));
  if (r.error) die(`コンパイラを起動できません: ${r.error.message}`);
  if (r.status !== 0) die(which !== 'engine' ? 'ビルドに失敗しました（編集画面には SDL3 が要ります。README を見るか、UM_SDL3 を設定してください）' : 'ビルドに失敗しました');
  fs.writeFileSync(variantFile, variant);
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

// エンジンが FFmpeg の組み込みを持つか（caps の ffmpeg の行）。持てば、素材の情報（probe.txt）は
// エンジンが自分で調べるので ffprobe を呼ばない。
let engineFfmpeg;
function engineHasFfmpeg() {
  if (engineFfmpeg === undefined) {
    const r = spawnSync(EXE, ['caps'], { encoding: 'utf8' });
    engineFfmpeg = !r.error && r.status === 0 && /^ffmpeg\t1\t/m.test(r.stdout || '');
  }
  return engineFfmpeg;
}

// FFmpeg の組み込みのあるエンジンでは、前の版（や予備の経路）が書いた probe.txt を消す。残っていると、エンジンは
// それを予備の情報とみなし、見つからない素材を missing-source ではなく「調べていない素材」として扱うため。
function dropProbeFile(cache) {
  fs.rmSync(path.join(cache, 'probe.txt'), { force: true });
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
    else if (a === '--old') opt.old = true;
    else pos.push(a);
  }
  return { pos, opt };
}

// 素材を ffprobe で調べて cache/probe.txt に書く（長さを書かないクリップのため）。
// FFmpeg の組み込みのないエンジンのときだけ使う（あればエンジンが自分で調べる）。
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
  if (engineHasFfmpeg()) dropProbeFile(cache);
  else probe(projectPath, projectDir, cache, soft);
  const plan = engine(['plan', projectPath, cache], { soft }).split('\n').map((l) => l.replace(/\r$/, '').split('\t'));
  const spans = new Map();
  for (const f of plan) if (f[0] === 'clip') spans.set(f[1], [Number(f[2]), Number(f[3])]);
  const jobs = [];
  let skipped = 0;
  // FFmpeg の組み込みのあるエンジンは素材をその場で展開するので、事前の展開はしない
  // ただし motion（opt.needCache）は展開した映像（Y4M）を直接読んで点を追うので、FFmpeg の組み込みがあっても展開する
  const predecode = !engineHasFfmpeg() || opt.needCache === true;
  for (const f of plan) {
    if (!predecode || !['video', 'image', 'audio'].includes(f[0])) continue;
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
    build(true, 'editor-old');
    return;
  }
  if (cmd === 'plugin') return pluginCommand(rest);
  if (cmd === 'package') return packageCommand(rest);
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
    // 調べられない素材は飛ばす（その誤りはエンジンが診断として出す）。FFmpeg の組み込みがあればエンジンが調べる
    try {
      if (engineHasFfmpeg()) dropProbeFile(cache);
      else probe(projectPath, path.dirname(projectPath), cache, true);
    } catch {
      // プロジェクトが読めないなどの誤りもエンジンが出す
    }
    passthrough([cmd, given, cache, ...rest.slice(1)]);
  }
  // motion: 素材を展開してから、点を追ってキーフレームを書く（エンジンの motion）
  if (cmd === 'motion') {
    JSON_OUT = rest.includes('--json');
    const given = rest[0];
    if (given === undefined || given.startsWith('--')) usageExit('motion にはプロジェクトのファイルを渡します');
    const projectPath = path.resolve(given);
    if (!fs.existsSync(projectPath)) die(`プロジェクトがありません: ${given}`);
    const { cache } = await prepare(projectPath, { needCache: true }, null);
    passthrough(['motion', projectPath, cache, ...rest.slice(1)]);
  }
  const { pos, opt } = parseArgs(rest);
  // edit だけ（プロジェクトなし）はスタート画面（古い編集画面には --home を絶対パスで渡す。デモと最近の一覧の基準）
  if (cmd === 'edit' && !pos[0]) return startScreen(opt);
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
  const [, y4m, pcm, rate, crf, preset, output] = enc;
  const out = path.resolve(opt.out ? process.cwd() : projectDir, opt.out || output);
  if (engineHasFfmpeg()) {
    // FFmpeg の組み込みで、エンジンが MP4 を直接書く（中間の Y4M / PCM も ffmpeg のコマンドも使わない）
    engine([...renderArgs, '--out', out], { capture: false });
    return;
  }
  engine(renderArgs, { capture: false });
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
  const exe = opt.old ? EDITOR_OLD_EXE : EDITOR_EXE;
  build(false, opt.old ? 'editor-old' : 'editor');
  const cache = cacheDir(projectPath);
  fs.mkdirSync(cache, { recursive: true });
  // 新しい編集画面の「出力」で頼んだ書き出しは、別のプロセスで走らせる（src/ws_export/job.um。UI はプロセスを起動できない）。
  // 依頼を待つ係を先に起動しておく（係は起動のときに前の依頼を消すので、編集画面より先に）。
  const runner = opt.old ? null : startExportRunner(cache);
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
  // 編集画面に「素材の展開はこちら（mozcut.mjs）が受け持つ」ことを --managed で知らせる。パスは絶対にする
  // （最近開いた一覧 mozcut-recent.txt に入るので、別のフォルダから起動しても開けるように）。
  // 新しい編集画面は --home を付けない（最近の一覧は、exe をダブルクリックしたときと同じ %APPDATA%/MozaicCut）。
  // 古い編集画面は --home（build/）が一覧とデモ（../demo/demo.mzc）の基準。
  const home = opt.old ? ['--home', path.dirname(exe)] : [];
  const ui = spawn(exe, [path.resolve(projectPath), path.resolve(cache), '--managed', ...home], { stdio: 'inherit' });
  fs.watchFile(projectPath, { interval: 300 }, () => { refresh(); });
  ui.on('exit', async (code) => {
    fs.unwatchFile(projectPath);
    if (runner) await stopExportRunner(runner, cache);
    process.exit(code ?? 0);
  });
}

// 書き出しの係（tools/ws-export-runner.mjs）を、依頼を待つだけの形で起動する。
function startExportRunner(cache) {
  const r = spawn(process.execPath, [path.join(ROOT, 'tools', 'ws-export-runner.mjs'), '--cache', path.resolve(cache)],
    { stdio: ['ignore', 'ignore', 'inherit'] });
  r.on('error', (e) => console.error(`mozcut: 書き出しの係を起動できません（${e.message}）。出力のワークスペースの書き出しは進みません`));
  return r;
}

// 編集画面が終わったら、走っている書き出しを止めて（止める印を置き、係が子のプロセスを止めて書きかけを消すのを
// 5 秒まで待つ）から係を終わらせる。
async function stopExportRunner(runner, cache) {
  const dir = path.join(cache, 'wsx');
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => /^job-\d+-\d+\.taken$/.test(n)); } catch { /* 依頼がなければ何もしない */ }
  // 係は依頼を 1 つずつ走らせるので、走っているとすれば最後に置かれた依頼（やり直しは番号が若くても後に置かれる）
  const at = (n) => fs.statSync(path.join(dir, n)).mtimeMs;
  names.sort((a, b) => at(a) - at(b));
  const stops = [];
  for (const n of names.slice(-1)) {
    // 終わった依頼（ログが exit= か render_failed= で終わっている）には印を置かない
    const log = path.join(dir, n.replace(/\.taken$/, '.log'));
    let text = '';
    try { text = fs.readFileSync(log, 'utf8'); } catch { /* まだログがない */ }
    if (/^(exit|render_failed)=/m.test(text)) continue;
    const stop = path.join(dir, n.replace(/\.taken$/, '.stop'));
    fs.writeFileSync(stop, '');
    stops.push(stop);
  }
  for (let i = 0; i < 50 && stops.some((s) => fs.existsSync(s)); i++) await new Promise((res) => setTimeout(res, 100));
  runner.kill();
}

// スタート画面（最近開いたプロジェクト・新しく作る）を開く。ここから開いたプロジェクトの素材は展開しない。
// 新しい編集画面（src/edit2/start.um）のもの。--old なら古い編集画面（src/editor.um。デモの行がある）のもの。
function startScreen(opt) {
  const which = opt.old ? 'editor-old' : 'editor';
  const exe = opt.old ? EDITOR_OLD_EXE : EDITOR_EXE;
  build(false, which);
  // 新しい編集画面は --home なし（最近の一覧は %APPDATA%/MozaicCut）。古い編集画面は build/ を基準にする
  const ui = spawn(exe, opt.old ? ['--home', path.dirname(exe)] : [], { stdio: 'inherit' });
  ui.on('exit', (code) => process.exit(code ?? 0));
}

// ---- package（配布の形。中身は tools/package.mjs） ----

function packageCommand(args) {
  let out = process.platform === 'darwin' ? path.join(ROOT, 'dist', 'MozaicCut.app') : path.join(ROOT, 'dist', 'MozaicCut');
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-o' || args[i] === '--out') out = path.resolve(args[++i] ?? '');
    else usageExit(`package に '${args[i]}' というオプションはありません`);
  }
  if (process.platform !== 'win32' && process.platform !== 'darwin') die('package は Windows と macOS だけです');
  // FFmpeg の組み込みがないと、素材を読むのも書き出すのも node と ffmpeg のコマンドに頼るので、配布の形にしない
  if (!ffmpegLibsFound()) die('FFmpeg のライブラリが見つかりません。配布の形には FFmpeg の組み込みが要ります（UM_FFMPEG_HOME に LGPL の共有ライブラリのビルドの場所を設定してください）');
  build(false, 'editor');
  const opts = {
    root: ROOT, build: path.join(ROOT, 'build'), editorExe: EDITOR_EXE, out,
    ffmpegHome: ffmpegHome(), sdl3Home: sdl3Home(), wasmtimeHome: wasmtimeHome(), wgpuHome: wgpuHome(),
  };
  // macOS は .app（otool・install_name_tool・codesign を使う。失敗したら理由を出して止まる）
  let r;
  try {
    r = process.platform === 'darwin' ? makeMacApp(opts) : makePackage(opts);
  } catch (e) {
    die(e.message);
  }
  for (const m of r.missing) console.error(`mozcut: 注意: ${m} が見つからないので、licenses/ に入れていません`);
  if (process.platform === 'darwin') {
    console.error(`mozcut: ${path.relative(process.cwd(), r.out) || r.out} に MozaicCut.app を作りました（dylib ${r.dylibs.length} 個: ${r.dylibs.join(', ')}。ad-hoc の署名、公証なし）`);
  } else {
    console.error(`mozcut: ${path.relative(process.cwd(), r.out) || r.out} に配布の形を作りました（MozaicCut.exe と DLL ${r.dlls.length} 個: ${r.dlls.join(', ')}）`);
  }
}

// ---- plugin（wasm の効果プラグイン .mzplug） ----

// 入れた .mzplug の置き場所と、その一覧（エンジンが読む。1 行に 1 つ、このフォルダからの場所）。
const PLUGINS_INSTALLED = path.join(ROOT, 'plugins-installed');
const PLUGIN_INDEX = path.join(PLUGINS_INSTALLED, 'index.txt');

// wasmtime の C API の場所（UM_WASMTIME がなければ、このリポジトリの隣とホームの wasmtime-*-c-api を探し、mac では Homebrew の wasmtime も見る）。
function wasmtimeHome() {
  if (process.env.UM_WASMTIME) return process.env.UM_WASMTIME;
  for (const dir of [path.join(ROOT, '..'), os.homedir()]) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const n of names.filter((n) => n.startsWith('wasmtime-')).sort().reverse()) {
      if (fs.existsSync(path.join(dir, n, 'include', 'wasmtime.h'))) return path.join(dir, n);
    }
  }
  // mac では Homebrew の wasmtime も見る
  if (process.platform === 'darwin') {
    for (const d of ['/opt/homebrew/opt/wasmtime', '/usr/local/opt/wasmtime']) {
      const f = path.join(d, 'include', 'wasmtime.h');
      if (fs.existsSync(f)) return d;
    }
  }
  return undefined;
}

// FFmpeg の場所（告知とライセンスの文書を集めるため）。UM_FFMPEG_HOME がなければ、mac では Homebrew の ffmpeg を見る。
function ffmpegHome() {
  if (process.env.UM_FFMPEG_HOME) return process.env.UM_FFMPEG_HOME;
  if (process.platform === 'darwin') {
    for (const d of ['/opt/homebrew/opt/ffmpeg', '/usr/local/opt/ffmpeg']) {
      const f = path.join(d, 'include', 'libavformat', 'avformat.h');
      if (fs.existsSync(f)) return d;
    }
  }
  return undefined;
}

// エンジンに渡す .mzplug の一覧のファイル（plugins-installed/index.txt）。ないときは null。
export function pluginIndexPath() {
  return fs.existsSync(PLUGIN_INDEX) ? PLUGIN_INDEX : null;
}

// plugins-installed/ の .mzplug を読み、宣言を並べる（読めないものは error つき）。
function installedPlugins() {
  let names = [];
  try {
    names = fs.readdirSync(PLUGINS_INSTALLED).filter((n) => n.endsWith('.mzplug')).sort();
  } catch {
    return [];
  }
  return names.map((n) => {
    const file = path.join(PLUGINS_INSTALLED, n);
    try {
      return { file, manifest: readManifest(fs.readFileSync(file)) };
    } catch (e) {
      return { file, error: e.message };
    }
  });
}

// plugins-installed/index.txt を書き直す（読めない包みも載せる。読めない理由はエンジンが bad-plugin の診断で出す）。
function writePluginIndex() {
  const files = installedPlugins().map((p) => path.basename(p.file));
  const text = `# MozaicCut が起動時に読み込む .mzplug（node tools/mozcut.mjs plugin install / uninstall が書く。1 行に 1 つ、このフォルダからの場所）\n${files.map((f) => f + '\n').join('')}`;
  fs.mkdirSync(PLUGINS_INSTALLED, { recursive: true });
  fs.writeFileSync(PLUGIN_INDEX, text);
}

// 組み込みの効果（plugins/*.um の宣言）。
function builtinPlugins() {
  let names = [];
  try {
    names = fs.readdirSync(path.join(ROOT, 'plugins')).filter((n) => n.endsWith('.um')).sort();
  } catch {
    return [];
  }
  return names.map((n) => parsePlugin(`plugins/${n}`, fs.readFileSync(path.join(ROOT, 'plugins', n), 'utf8')));
}

function pluginJson(fx) {
  return {
    name: fx.name,
    doc: fx.doc,
    aliases: fx.aliases.map((a) => a.name),
    params: fx.params.map((p) => ({ name: p.name, default: p.def, min: p.min, max: p.max, doc: p.doc })),
    reach: fx.reach ? { param: fx.reach.param, factor: fx.reach.factor } : null,
    whole: !!fx.whole,
  };
}

function pluginUsage(msg) {
  usageExit(msg || 'plugin のあとに build / list / install / uninstall を書きます');
}

function pluginCommand(args) {
  JSON_OUT = args.includes('--json');
  const [sub, ...rest] = args.filter((a) => a !== '--json');
  if (sub === 'build') return pluginBuild(rest);
  if (sub === 'list') return pluginList();
  if (sub === 'install') return pluginInstall(rest);
  if (sub === 'uninstall' || sub === 'remove') return pluginUninstall(rest);
  pluginUsage(sub ? `'plugin ${sub}' というコマンドはありません（build / list / install / uninstall）` : '');
}

// plugin build <名前 | file.um> [-o out.mzplug]
function pluginBuild(args) {
  let out;
  const pos = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-o' || args[i] === '--out') out = args[++i];
    else if (args[i].startsWith('-')) pluginUsage(`plugin build に '${args[i]}' というオプションはありません`);
    else pos.push(args[i]);
  }
  if (pos.length !== 1 || (out !== undefined && !out)) pluginUsage('plugin build にはプラグインの名前か .um のファイルを 1 つ渡します（例: plugin build vignette）');
  let src;
  try {
    src = pluginSource(ROOT, pos[0]);
  } catch (e) {
    die(e.message, 2);
  }
  if (!fs.existsSync(src)) die(`${path.relative(process.cwd(), src) || src} がありません（plugins/<名前>.um か、.um のファイルを渡します）`);
  const t0 = Date.now();
  let r;
  try {
    r = buildPlugin(ROOT, src, { umCli: path.join(umHome(), 'src', 'cli.ts'), outPath: out ? path.resolve(out) : undefined, spawnSync });
  } catch (e) {
    die(e.compile ? e.message : `プラグインの宣言に誤りがあります\n  ${e.message}\n  （書き方は docs/design/architecture.md の「効果プラグインの書き方」）`);
  }
  const ms = Date.now() - t0;
  if (JSON_OUT) {
    console.log(JSON.stringify({ ok: true, name: r.name, out: r.out, bytes: r.bytes.length, manifest: r.manifest }));
  } else {
    console.error(`mozcut: ${path.relative(process.cwd(), r.out) || r.out} を作りました（効果 ${r.name}、${r.bytes.length} バイト、${ms} ms）`);
    const reserved = new Set([...builtinPlugins().flatMap((f) => [f.name, ...f.aliases.map((a) => a.name)]), ...coreKeyNames(ROOT)]);
    const clash = [r.name, ...r.manifest.aliases].filter((n) => reserved.has(n));
    if (clash.length) console.error(`mozcut: 注意: ${clash.map((n) => `'${n}'`).join('、')} は組み込みの効果かコアのキーと同じ名前なので、入れても読み込まれません（試しに比べる用）`);
  }
}

// plugin list
function pluginList() {
  const builtin = builtinPlugins();
  const installed = installedPlugins();
  if (JSON_OUT) {
    console.log(JSON.stringify({
      ok: true,
      builtin: builtin.map((fx) => ({ ...pluginJson(fx), source: fx.file })),
      installed: installed.map((p) => (p.error
        ? { file: p.file, ok: false, error: p.error }
        : { file: p.file, ok: true, name: p.manifest.name, doc: p.manifest.doc, aliases: p.manifest.aliases || [], params: p.manifest.params, reach: p.manifest.reach ?? null, whole: !!p.manifest.whole })),
      index: pluginIndexPath(),
    }));
    return;
  }
  console.log(`組み込みの効果（${builtin.length} 個、plugins/*.um）:`);
  for (const fx of builtin) {
    const al = fx.aliases.length ? `（別名 ${fx.aliases.map((a) => a.name).join(' ')}）` : '';
    console.log(`  ${fx.name}${al}  ${fx.doc}`);
  }
  console.log('');
  if (installed.length === 0) {
    console.log('入れた .mzplug はありません（node tools/mozcut.mjs plugin install <file.mzplug>）');
    return;
  }
  console.log(`入れた .mzplug（${installed.length} 個、${path.relative(process.cwd(), PLUGINS_INSTALLED) || PLUGINS_INSTALLED}）:`);
  for (const p of installed) {
    if (p.error) console.log(`  ${path.basename(p.file)}  読めません: ${p.error}`);
    else console.log(`  ${describeManifest(p.manifest).replace(/\n/g, '\n  ')}`);
  }
}

// plugin install <file.mzplug> [--force]
function pluginInstall(args) {
  const force = args.includes('--force');
  const pos = args.filter((a) => a !== '--force');
  if (pos.length !== 1) pluginUsage('plugin install には .mzplug のファイルを 1 つ渡します');
  const file = path.resolve(pos[0]);
  let bytes;
  try {
    bytes = fs.readFileSync(file);
  } catch {
    die(`${pos[0]} を読めません`);
  }
  let m;
  try {
    m = readManifest(bytes);
  } catch (e) {
    die(`${pos[0]} は MozaicCut のプラグインとして読めません: ${e.message}（node tools/mozcut.mjs plugin build で作ったものを渡します）`);
  }
  // 組み込みの効果・コアのキー・ほかの入れた包みと名前がぶつかるなら入れない（読み込むときに飛ばされるため）
  const builtin = builtinPlugins();
  const core = coreKeyNames(ROOT);
  const names = [m.name, ...(m.aliases || [])];
  for (const n of names) {
    const b = builtin.find((fx) => fx.name === n || fx.aliases.some((a) => a.name === n));
    if (b) die(`'${n}' は組み込みの効果 '${b.name}'（${b.file}）とぶつかるので入れられません。効果の名前・別名を変えて作り直してください`);
    if (core.has(n)) die(`'${n}' はコアのキーなので、効果の名前・別名に使えません。変えて作り直してください`);
  }
  const target = path.join(PLUGINS_INSTALLED, `${m.name}.mzplug`);
  for (const p of installedPlugins()) {
    if (p.error || path.resolve(p.file) === path.resolve(target)) continue;
    const other = [p.manifest.name, ...(p.manifest.aliases || [])];
    const hit = names.find((n) => other.includes(n));
    if (hit) die(`'${hit}' は入れてある ${path.basename(p.file)}（効果 '${p.manifest.name}'）とぶつかるので入れられません`);
  }
  const replaced = fs.existsSync(target);
  if (replaced && !force && Buffer.compare(fs.readFileSync(target), bytes) !== 0) {
    die(`${path.basename(target)} はもう入っています。置き換えるなら --force を付けます`);
  }
  fs.mkdirSync(PLUGINS_INSTALLED, { recursive: true });
  if (path.resolve(file) !== path.resolve(target)) fs.copyFileSync(file, target);
  writePluginIndex();
  if (JSON_OUT) console.log(JSON.stringify({ ok: true, name: m.name, file: target, replaced }));
  else console.error(`mozcut: 効果 '${m.name}' を ${path.relative(process.cwd(), target) || target} に${replaced ? '置き換えました' : '入れました'}（エンジンの描画が .mzplug を読むのは、まだこれから。いまは plugin list で確かめられます）`);
}

// plugin uninstall <名前>
function pluginUninstall(args) {
  if (args.length !== 1) pluginUsage('plugin uninstall には効果の名前を 1 つ渡します');
  const name = args[0].replace(/\.mzplug$/, '');
  const p = installedPlugins().find((x) => path.basename(x.file, '.mzplug') === name || (!x.error && x.manifest.name === name));
  if (!p) die(`'${name}' という .mzplug は入っていません（node tools/mozcut.mjs plugin list で一覧）`);
  fs.rmSync(p.file);
  writePluginIndex();
  if (JSON_OUT) console.log(JSON.stringify({ ok: true, name, file: p.file }));
  else console.error(`mozcut: ${path.relative(process.cwd(), p.file) || p.file} を外しました`);
}

main().catch((e) => die(e.message));
