#!/usr/bin/env node
// 書き出しのワークスペース（src/ws_export/、見本 src/ws_export_demo.um、tools/ws-export-runner.mjs）のテスト。
//   node tests/ws_export/run.mjs [-v] [--keep]
//
// demo/demo.mzc を一時フォルダに写し、見本を tools/ws-export-runner.mjs の下で動かして実際に書き出し、
// 出来たファイルを ffprobe で確かめる。見本の窓は SDL_VIDEO_DRIVER=offscreen（runner が付ける）で、画面には出さない。
// OS のダイアログは開かない（場所は --folder で渡す）。
//
// 場合ごとに別のフォルダ（別のキャッシュ）で走らせるので、場合どうしは同時に走らせる（合成の中間ファイル
// <cache>/out.y4m がぶつからない）。
//
// 素材: demo/media があればそれを写す。なければ MOZCUT_DEMO_MEDIA のフォルダ、それもなければ ffmpeg で作る
// （tools/demo-media.mjs と同じ中身）。
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT, TMP, VERBOSE, buildTool, Fail, eq, assert } from '../umtest.mjs';

const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const FFPROBE = process.env.FFPROBE || 'ffprobe';
const KEEP = process.argv.includes('--keep');

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
if (!process.env.UM_SDL3 && sdl3Home()) process.env.UM_SDL3 = sdl3Home();

// ---- 素材 ----

const MEDIA = path.join(TMP, 'media');
function makeMedia() {
  const from = [path.join(ROOT, 'demo', 'media'), process.env.MOZCUT_DEMO_MEDIA].filter(Boolean)
    .find((d) => ['clip_a.mp4', 'clip_b.mp4', 'logo.png', 'bgm.wav'].every((n) => fs.existsSync(path.join(d, n))));
  fs.mkdirSync(MEDIA, { recursive: true });
  if (from) {
    fs.cpSync(from, MEDIA, { recursive: true });
    return;
  }
  const jobs = [
    ['clip_a.mp4', ['-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
      '-t', '6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac']],
    ['clip_b.mp4', ['-f', 'lavfi', '-i', 'mandelbrot=size=960x540:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=660:sample_rate=44100',
      '-t', '6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac']],
    ['logo.png', ['-f', 'lavfi', '-i', "color=c=0x00000000:size=200x200,format=rgba,geq=r='255':g='180':b='40':a='if(lt(hypot(X-100,Y-100),90),255,0)'",
      '-frames:v', '1']],
    ['bgm.wav', ['-f', 'lavfi', '-i', 'sine=frequency=220:sample_rate=48000', '-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=48000',
      '-filter_complex', 'amix=inputs=2', '-t', '20']],
  ];
  for (const [name, args] of jobs) {
    const r = spawnSync(FFMPEG, ['-v', 'error', '-y', ...args, path.join(MEDIA, name)], { stdio: 'inherit' });
    if (r.status !== 0) {
      console.error(`素材 ${name} を作れません（ffmpeg）`);
      process.exit(1);
    }
  }
}

// 場合ごとのフォルダ: demo.mzc（edit で書き換えられる）と media/
function project(name, edit = (s) => s) {
  const dir = path.join(TMP, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.cpSync(MEDIA, path.join(dir, 'media'), { recursive: true });
  const mzc = path.join(dir, 'demo.mzc');
  fs.writeFileSync(mzc, edit(fs.readFileSync(path.join(ROOT, 'demo', 'demo.mzc'), 'utf8')));
  return { dir, mzc, cache: path.join(dir, 'demo.cache'), out: path.join(dir, 'out') };
}

// runner の下で見本を動かす。{ code, queue（最後の行の JSON）, stderr }
function runDemo(exe, p, args, env = {}) {
  return new Promise((resolve) => {
    const all = ['--cache', p.cache, '--project', p.mzc, '--', exe, '--project', p.mzc, '--cache', p.cache,
      '--folder', p.out, '--tokens', path.join(ROOT, 'docs', 'design', 'tokens.json'), '--until-done', '--timeout', '150', ...args];
    const c = spawn(process.execPath, [path.join(ROOT, 'tools', 'ws-export-runner.mjs'), ...all],
      { env: { ...process.env, SDL_VIDEO_DRIVER: 'offscreen', SDL_AUDIO_DRIVER: 'dummy', ...env } });
    let out = '';
    let err = '';
    c.stdout.on('data', (d) => { out += d; });
    c.stderr.on('data', (d) => { err += d; });
    c.on('close', (code) => {
      const last = out.trim().split(/\r?\n/).pop() ?? '';
      let queue = null;
      try { queue = JSON.parse(last); } catch { /* 下で失敗にする */ }
      resolve({ code, queue, stderr: err });
    });
  });
}

function probe(file) {
  const r = spawnSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,codec_name,width,height,r_frame_rate,sample_rate,channels',
    '-of', 'json', file], { encoding: 'utf8' });
  if (r.status !== 0) throw new Fail(`ffprobe が ${file} を読めません: ${r.stderr}`);
  const j = JSON.parse(r.stdout);
  const v = j.streams.find((s) => s.codec_type === 'video');
  const a = j.streams.find((s) => s.codec_type === 'audio');
  return { dur: Number(j.format.duration), v, a };
}

const near = (x, y, tol, msg) => assert(Math.abs(x - y) <= tol, `${msg}: ${x}（期待 ${y} ± ${tol}）`);

// ---- 場合 ----

const cases = [];
const it = (name, fn) => cases.push({ name, fn });

it('全体を Web 用（軽い）で書き出す: H.264 1280x720 30p + AAC 48 kHz ステレオ、10.5 秒', async (exe) => {
  const p = project('all');
  const r = await runDemo(exe, p, ['--preset', 'web-light', '--name', '全体', '--export-at', '3']);
  eq(r.code, 0, `終了コード\n${r.stderr}`);
  const j = r.queue.jobs[0];
  eq([r.queue.jobs.length, j.state, j.preset, j.totalFrames, j.doneFrames, j.attempts], [1, 'done', 'web-light', 315, 315, 1], '待ち行列');
  const out = path.join(p.out, '全体.mp4');
  assert(fs.existsSync(out), `${out} がない`);
  const m = probe(out);
  eq([m.v.codec_name, m.v.width, m.v.height, m.v.r_frame_rate], ['h264', 1280, 720, '30/1'], '映像');
  eq([m.a.codec_name, m.a.sample_rate, m.a.channels], ['aac', '48000', 2], '音');
  near(m.dur, 10.5, 0.05, '長さ');
  // 合成の中間ファイルは消す。ログに段階と終了が残る
  assert(!fs.existsSync(path.join(p.cache, 'out.y4m')), 'out.y4m が残っている');
  const log = fs.readFileSync(path.join(p.cache, 'wsx', 'job-1-1.log'), 'utf8');
  assert(/^phase=render$/m.test(log) && /^render_frame=315$/m.test(log) && /^phase=encode$/m.test(log) && /^exit=0$/m.test(log), log);
});

it('イン〜アウト（30〜89 コマ）を YouTube 1080p で: 1920x1080 に拡大、2 秒', async (exe) => {
  const p = project('inout');
  const r = await runDemo(exe, p, ['--preset', 'youtube-1080p', '--name', 'inout', '--in', '30', '--out', '89', '--range', 'inout', '--export-at', '3']);
  eq(r.code, 0, `終了コード\n${r.stderr}`);
  const j = r.queue.jobs[0];
  eq([j.state, j.from, j.totalFrames], ['done', 1, 60], '範囲');
  const m = probe(path.join(p.out, 'inout.mp4'));
  eq([m.v.width, m.v.height], [1920, 1080], '大きさ');
  near(m.dur, 2.0, 0.05, '長さ');
});

it('音だけ（AAC）: 映像なしの M4A', async (exe) => {
  const p = project('audio');
  const r = await runDemo(exe, p, ['--preset', 'audio-aac', '--name', 'bgm', '--export-at', '3']);
  eq(r.code, 0, `終了コード\n${r.stderr}`);
  eq(r.queue.jobs[0].state, 'done', '完了');
  const m = probe(path.join(p.out, 'bgm.m4a'));
  eq([m.v, m.a.codec_name], [undefined, 'aac'], '音だけ');
  near(m.dur, 10.5, 0.1, '長さ');
});

it('取り消し: 進み具合が 10% を超えたら取り消す。書きかけの出力は消える', async (exe) => {
  const p = project('cancel');
  const r = await runDemo(exe, p, ['--preset', 'youtube-1080p', '--name', 'cancel', '--export-at', '3', '--cancel-when', '0.1']);
  eq(r.code, 0, `終了コード\n${r.stderr}`);
  eq(r.queue.jobs[0].state, 'canceled', '取り消し');
  // runner が書きかけを消すのを少し待つ
  for (let i = 0; i < 50 && fs.existsSync(path.join(p.out, 'cancel.mp4')); i++) await new Promise((res) => setTimeout(res, 100));
  assert(!fs.existsSync(path.join(p.out, 'cancel.mp4')), '書きかけの出力が残っている');
});

it('素材がない: 確認にエラーが出て、書き出しを始めない', async (exe) => {
  const p = project('missing', (s) => s.replace('media/clip_b.mp4', 'media/nosuch.mp4'));
  const r = await runDemo(exe, p, ['--preset', 'web-light', '--export-at', '3', '--frames', '8']);
  eq(r.code, 0, `終了コード\n${r.stderr}`);
  eq(r.queue.jobs, [], '仕事は足さない');
  assert(r.stderr.includes('書き出しの前の確認にエラーが 1 件あります'), r.stderr);
});

it('合成の前に失敗する（ffmpeg が起動できない）: 失敗の理由が待ち行列に載る', async (exe) => {
  const p = project('fail');
  const r = await runDemo(exe, p, ['--preset', 'web-light', '--export-at', '3'], { FFMPEG: path.join(TMP, 'no-such-ffmpeg') });
  eq(r.code, 0, `終了コード\n${r.stderr}`);
  const j = r.queue.jobs[0];
  eq([j.state, j.error && j.error.code], ['failed', 'render-failed'], '失敗');
  assert(j.error.msg.includes('素材を展開できません'), j.error.msg);
});

// ---- 流す ----

makeMedia();
const exe = buildTool('ws_export_demo', path.join(ROOT, 'src', 'ws_export_demo.um'));
// エンジン（build/mozcut）を先に 1 回だけ作っておく（runner がそれぞれ作ろうとしてぶつからないように）
spawnSync(process.execPath, [path.join(ROOT, 'tools', 'mozcut.mjs'), 'schema', '--json'], { stdio: ['ignore', 'ignore', 'inherit'] });
const t0 = Date.now();
const results = await Promise.all(cases.map(async (c) => {
  try {
    await c.fn(exe);
    return { name: c.name, ok: true };
  } catch (e) {
    return { name: c.name, ok: false, msg: e instanceof Fail ? e.message : e.stack };
  }
}));
let ng = 0;
for (const r of results) {
  if (r.ok) {
    if (VERBOSE) console.log(`  ok  ${r.name}`);
  } else {
    ng++;
    console.log(`  NG  ${r.name}\n    ${r.msg}`);
  }
}
if (KEEP) console.log(`作業用のフォルダ: ${TMP}`);
else fs.rmSync(TMP, { recursive: true, force: true });
console.log(`ws_export: ${results.length - ng} 件通過、${ng} 件失敗（${((Date.now() - t0) / 1000).toFixed(1)} 秒）`);
process.exit(ng ? 1 : 0);
