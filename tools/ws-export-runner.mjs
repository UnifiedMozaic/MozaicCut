#!/usr/bin/env node
// 書き出しのワークスペース（src/ws_export/）の書き出しを、別のプロセスで走らせる係。
//
//   node tools/ws-export-runner.mjs --cache <dir> [--project <p.mzc>] [-- <見本や編集画面の exe> 引数...]
//
// - UI（UM）はプロセスを起動できないので、書き出しを始めるときは <cache>/wsx/job-<id>-<回>.json（rqEncodeTaskJson）を置く
//   （src/ws_export/job.um の wsxStartExport）。この係はそれを見つけて、次の順に走らせる:
//     1. 素材の展開（tools/mozcut.mjs の prepare と同じ: sources → ffprobe → plan → ffmpeg で Y4M / PAM / PCM）
//     2. 合成: build/mozcut render <p.mzc> <cache> <from> [<to>]（今の main.um の render）
//     3. 圧縮: ffmpeg（依頼の args。プリセットから presets.um が作ったもの。-progress pipe:1 つき）
//   進み具合は <cache>/wsx/job-<id>-<回>.log に 1 行ずつ足す（書き方は renderqueue.um の rqApplyLog）。
//   UI が <cache>/wsx/job-<id>-<回>.stop を置いたら、子のプロセスを止めて、書きかけの出力を消す。
// - -- のあとに exe を書くと、--project の素材を全体まで展開してから（プレビューの絵のため）それを起動し、
//   終わったらこの係も終わる（終了コードは exe のもの）。窓は SDL_VIDEO_DRIVER=offscreen・SDL_AUDIO_DRIVER=dummy で
//   起動する（利用者の画面に出さない。ほかの値を使うなら、環境変数を先に設定しておく）。
// - 依頼は 1 つずつ走らせる（合成が <cache>/out.y4m と out.pcm に書くため）。
//
// ※ MP4（H.264）のプリセットは、FFmpeg の組み込みがあれば見本・編集画面が自分で直接書く（src/ws_export/job.um、
//   src/encode.um）ので、この係には頼まない。この係が走らせるのは、ProRes・WAV・M4A と、FFmpeg の組み込みがない版の依頼。
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXT = process.platform === 'win32' ? '.exe' : '';
const ENGINE = process.env.MOZCUT_ENGINE ? path.resolve(process.env.MOZCUT_ENGINE) : path.join(ROOT, 'build', 'mozcut' + EXT);
const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const FFPROBE = process.env.FFPROBE || 'ffprobe';

function usage(msg) {
  if (msg) console.error(`ws-export-runner: ${msg}`);
  console.error('使い方: node tools/ws-export-runner.mjs --cache <dir> [--project <p.mzc>] [-- <exe> 引数...]');
  process.exit(2);
}

const argv = process.argv.slice(2);
const dd = argv.indexOf('--');
const own = dd >= 0 ? argv.slice(0, dd) : argv;
const child = dd >= 0 ? argv.slice(dd + 1) : [];
let CACHE = null;
let PROJECT = null;
for (let i = 0; i < own.length; i++) {
  if (own[i] === '--cache') CACHE = path.resolve(own[++i] ?? '');
  else if (own[i] === '--project') PROJECT = path.resolve(own[++i] ?? '');
  else usage(`'${own[i]}' というオプションはありません`);
}
if (!CACHE) usage('--cache を渡します');
const WSX = path.join(CACHE, 'wsx');

const say = (s) => console.error(`ws-export-runner: ${s}`);

// エンジン（build/mozcut）が古ければ作り直す（tools/mozcut.mjs の build に任せる。schema は素材を読まないので軽い）
function ensureEngine() {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'mozcut.mjs'), 'schema', '--json'], { stdio: ['ignore', 'ignore', 'inherit'] });
  if (r.status !== 0 || !fs.existsSync(ENGINE)) {
    say('エンジンをビルドできませんでした');
    process.exit(1);
  }
}

// ---- 素材の展開（tools/mozcut.mjs の probe / decodeArgs / prepare と同じ手順。FFmpeg の組み込みがない版の依頼と、見本のプレビューのため） ----

function engineOut(args) {
  const r = spawnSync(ENGINE, args, { encoding: 'utf8', maxBuffer: 1 << 26 });
  if (r.status !== 0) throw new Error((r.stderr || '').trim() || `エンジンが終了コード ${r.status} で終わりました`);
  return r.stdout;
}

function probe(projectPath, cache) {
  const dir = path.dirname(projectPath);
  const lines = [];
  for (const line of engineOut(['sources', projectPath]).split('\n')) {
    const [tag, src] = line.replace(/\r$/, '').split('\t');
    if (tag !== 'src') continue;
    const file = path.resolve(dir, src);
    if (!fs.existsSync(file)) {
      lines.push([src, 'missing', 0, 0, file].join('\t'));
      continue;
    }
    const r = spawnSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type', '-of', 'json', file], { encoding: 'utf8' });
    if (r.status !== 0) continue;
    const j = JSON.parse(r.stdout);
    const types = (j.streams || []).map((s) => s.codec_type);
    const dur = Number(j.format?.duration);
    lines.push([src, Number.isFinite(dur) ? dur : 'nan', types.includes('video') ? 1 : 0, types.includes('audio') ? 1 : 0].join('\t'));
  }
  const file = path.join(cache, 'probe.txt');
  const text = lines.join('\n') + '\n';
  if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== text) fs.writeFileSync(file, text);
}

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

function runQuiet(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', (e) => reject(new Error(`${cmd} を起動できません（${e.message}）`)));
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} が失敗しました（終了コード ${code}）: ${err.trim().split(/\r?\n/).pop() ?? ''}`))));
  });
}

// range: [from, to]（秒。to が Infinity なら最後まで）。その範囲にかかるクリップだけ展開する。済んだものは飛ばす。
async function prepare(projectPath, cache, range) {
  fs.mkdirSync(cache, { recursive: true });
  probe(projectPath, cache);
  const plan = engineOut(['plan', projectPath, cache]).split('\n').map((l) => l.replace(/\r$/, '').split('\t'));
  const spans = new Map();
  for (const f of plan) if (f[0] === 'clip') spans.set(f[1], [Number(f[2]), Number(f[3])]);
  const jobs = [];
  for (const f of plan) {
    if (!['video', 'image', 'audio'].includes(f[0])) continue;
    const span = spans.get(f[1]);
    if (span && (span[1] <= range[0] || span[0] > range[1])) continue;
    const file = path.resolve(path.dirname(projectPath), f[2]);
    if (!fs.existsSync(file)) continue;
    const args = decodeArgs(f, file);
    const out = args[args.length - 1];
    args[args.length - 1] = out + '.tmp';
    const st = fs.statSync(file);
    const key = JSON.stringify({ args, size: st.size, mtime: st.mtimeMs });
    const keyFile = out + '.key';
    if (fs.existsSync(out) && fs.existsSync(keyFile) && fs.readFileSync(keyFile, 'utf8') === key) continue;
    jobs.push(async () => {
      if (fs.existsSync(keyFile)) fs.rmSync(keyFile);
      await runQuiet(FFMPEG, args);
      fs.renameSync(out + '.tmp', out);
      if (f[0] === 'video') fs.writeFileSync(out + '.in', f[3]);
      fs.writeFileSync(keyFile, key);
    });
  }
  let next = 0;
  const n = Math.max(1, Math.min(4, os.cpus().length >> 1));
  await Promise.all(Array.from({ length: Math.min(n, jobs.length) }, async () => {
    while (next < jobs.length) await jobs[next++]();
  }));
}

// ---- 依頼を 1 つ走らせる ----

const oneLine = (s) => String(s).replace(/[\r\n]+/g, ' ').trim();

async function runJob(base) {
  const taken = base + '.taken';
  fs.renameSync(base + '.json', taken);
  const task = JSON.parse(fs.readFileSync(taken, 'utf8'));
  const logFile = base + '.log';
  const stopFile = base + '.stop';
  fs.writeFileSync(logFile, '');
  const log = (line) => fs.appendFileSync(logFile, oneLine(line) + '\n');
  const cache = path.dirname(task.y4m);
  let current = null;
  let stopped = false;
  // 圧縮（ffmpeg）を始めたか。始める前に取り消したなら、出力の場所にある前のファイルには触れない
  let encoding = false;
  const watch = setInterval(() => {
    if (!stopped && fs.existsSync(stopFile)) {
      stopped = true;
      if (current) current.kill();
    }
  }, 100);
  const finish = () => {
    clearInterval(watch);
    fs.rmSync(task.y4m, { force: true });
    fs.rmSync(task.pcm, { force: true });
    if (stopped) {
      // 取り消し: 書きかけの出力を消す（UI は取り消しの状態のまま。exit= は書かない）。
      // 合成の途中で取り消したなら、ffmpeg はまだ出力を開いていないので、同じ名前の前のファイルは残す。
      if (encoding) fs.rmSync(task.output, { force: true });
      fs.rmSync(stopFile, { force: true });
      say(`#${task.jobId} を取り消しました`);
    }
  };
  log('phase=render');
  say(`#${task.jobId} ${task.output} を書き出します`);
  try {
    await prepare(task.project, cache, [task.from ?? 0, task.to ?? Infinity]);
  } catch (e) {
    log(`render_failed=素材を展開できません（${e.message}）`);
    finish();
    return;
  }
  if (stopped) return finish();
  // 合成（main.um の render）。進み具合は stderr の「映像 n/m コマ」
  const rargs = ['render', task.project, cache, String(task.from ?? 0)];
  if (task.to !== null && task.to !== undefined) rargs.push(String(task.to));
  const renderOk = await new Promise((resolve) => {
    const p = spawn(ENGINE, rargs, { stdio: ['ignore', 'ignore', 'pipe'] });
    current = p;
    let tail = '';
    let buf = '';
    p.stderr.setEncoding('utf8');
    p.stderr.on('data', (d) => {
      buf += d;
      let k;
      while ((k = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, k).replace(/\r$/, '');
        buf = buf.slice(k + 1);
        const m = /映像 (\d+)\/(\d+)/.exec(line);
        if (m) log(`render_frame=${m[1]}`);
        else if (line.trim()) tail = line;
      }
    });
    p.on('error', (e) => { log(`render_failed=${ENGINE} を起動できません（${e.message}）`); resolve(false); });
    p.on('close', (code) => {
      current = null;
      if (code !== 0 && !stopped) log(`render_failed=合成が終了コード ${code} で止まりました${tail ? `（${tail}）` : ''}`);
      resolve(code === 0);
    });
  });
  if (!renderOk || stopped) return finish();
  // 圧縮（プリセットの ffmpeg の引数。-progress pipe:1 の行をそのままログへ）
  log('phase=encode');
  encoding = true;
  fs.mkdirSync(path.dirname(path.resolve(task.output)), { recursive: true });
  let tail = '';
  const code = await new Promise((resolve) => {
    const p = spawn(FFMPEG, task.args, { stdio: ['ignore', 'pipe', 'pipe'] });
    current = p;
    let out = '';
    p.stdout.setEncoding('utf8');
    p.stdout.on('data', (d) => {
      out += d;
      let k;
      while ((k = out.indexOf('\n')) >= 0) {
        const line = out.slice(0, k).replace(/\r$/, '');
        out = out.slice(k + 1);
        if (/^(out_time_us|out_time_ms|frame|progress)=/.test(line)) log(line);
      }
    });
    p.stderr.setEncoding('utf8');
    p.stderr.on('data', (d) => {
      const ls = String(d).split(/\r?\n/).filter((l) => l.trim());
      if (ls.length) tail = ls[ls.length - 1];
    });
    p.on('error', (e) => { tail = `${FFMPEG} を起動できません（${e.message}）`; resolve(1); });
    p.on('close', (c) => { current = null; resolve(c ?? 1); });
  });
  if (!stopped) {
    if (tail) log(`stderr=${tail}`);
    log(`exit=${code}`);
    say(`#${task.jobId} ${code === 0 ? 'が終わりました' : `が失敗しました（終了コード ${code}）`}`);
  }
  finish();
}

// ---- 依頼を見張る ----

let busy = false;
let exiting = false;
function scan() {
  if (busy || exiting) return;
  let names = [];
  try { names = fs.readdirSync(WSX); } catch { return; }
  const reqs = names.filter((n) => /^job-\d+-\d+\.json$/.test(n)).sort((a, b) => {
    const [, ai, aa] = /^job-(\d+)-(\d+)/.exec(a).map(Number);
    const [, bi, ba] = /^job-(\d+)-(\d+)/.exec(b).map(Number);
    return ai - bi || aa - ba;
  });
  if (!reqs.length) return;
  const base = path.join(WSX, reqs[0].replace(/\.json$/, ''));
  // 書きかけの依頼（UI が writeFile している最中）は、JSON として読めるまで待つ
  try { JSON.parse(fs.readFileSync(base + '.json', 'utf8')); } catch { return; }
  busy = true;
  runJob(base).catch((e) => {
    // 係の中の誤りでも、UI が待ち続けないよう失敗として知らせる
    say(`依頼 ${path.basename(base)} を走らせられません: ${e.message}`);
    try { fs.appendFileSync(base + '.log', `render_failed=${oneLine(`書き出しの係が止まりました（${e.message}）`)}
`); } catch { /* 書けなければ諦める */ }
  }).finally(() => { busy = false; });
}

async function main() {
  ensureEngine();
  // 前の回の依頼・ログが残っていれば消す（仕事の番号は起動ごとに 1 から）
  fs.rmSync(WSX, { recursive: true, force: true });
  fs.mkdirSync(WSX, { recursive: true });
  if (PROJECT) {
    say('素材を展開しています（プレビューの絵のため）...');
    try {
      await prepare(PROJECT, CACHE, [0, Infinity]);
    } catch (e) {
      say(`素材を展開できません: ${e.message}`);
    }
  }
  const timer = setInterval(scan, 100);
  if (!child.length) {
    say(`${WSX} の依頼を待っています（Ctrl+C で終わる）`);
    return;
  }
  const env = { ...process.env };
  if (!env.SDL_VIDEO_DRIVER) env.SDL_VIDEO_DRIVER = 'offscreen';
  if (!env.SDL_AUDIO_DRIVER) env.SDL_AUDIO_DRIVER = 'dummy';
  const ui = spawn(child[0], child.slice(1), { stdio: ['ignore', 'inherit', 'inherit'], env });
  ui.on('exit', async (code) => {
    exiting = true;
    clearInterval(timer);
    // 走っている仕事があれば止める（止める印を置き、終わるのを待つ）
    while (busy) {
      for (const n of fs.readdirSync(WSX).filter((x) => x.endsWith('.taken'))) {
        fs.writeFileSync(path.join(WSX, n.replace(/\.taken$/, '.stop')), '');
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    process.exit(code ?? 1);
  });
}

main().catch((e) => {
  say(e.message);
  process.exit(1);
});
