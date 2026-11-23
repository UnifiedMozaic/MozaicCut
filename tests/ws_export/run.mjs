#!/usr/bin/env node
// 書き出しのワークスペース（src/workspaces/export/、見本 demos/ws_export_demo.um、tools/ws-export-runner.mjs）のテスト。
//   node tests/ws_export/run.mjs [-v] [--keep]
//
// demo/demo.mzc を一時フォルダに写し、見本を tools/ws-export-runner.mjs の下で動かして実際に書き出し、
// 出来たファイルを ffprobe で確かめる。見本の窓は SDL_VIDEO_DRIVER=offscreen（runner が付ける）で、画面には出さない。
// FFmpeg の組み込みがあれば、どのプリセット（MP4・ProRes・WAV・M4A）も見本が直接書く（ws_export/job.um。runner は見本を
// 起動するだけ）。runner が合成と ffmpeg を走らせる道は、環境変数 MOZCUT_EXPORT_RUNNER=1 を付けて確かめる。
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

// 映像のコマ数（数えて確かめる。長さの秒だけでは 1 コマのずれを見逃す）
function videoFrames(file) {
  const r = spawnSync(FFPROBE, ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames',
    '-of', 'csv=p=0', file], { encoding: 'utf8' });
  if (r.status !== 0) throw new Fail(`ffprobe が ${file} のコマを数えられません: ${r.stderr}`);
  return Number(r.stdout.trim());
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
  // FFmpeg の組み込みで直接書く: 合成の中間ファイルも、runner への依頼も作らない。一時の MP4 は写したあと空にする
  assert(!fs.existsSync(path.join(p.cache, 'out.y4m')), 'out.y4m がある');
  assert(!fs.existsSync(path.join(p.cache, 'wsx', 'job-1-1.json')), 'runner への依頼を置いている');
  eq(fs.statSync(path.join(p.cache, 'wsx', 'job-1-1.mp4')).size, 0, '一時の MP4 が空になっていない');
  // 終わったら知らせる（トースト。見本は標準エラー出力にも書く）
  assert(/全体\.mp4 を書き出しました · \d+:\d\d · [\d.]+ [KM]B/.test(r.stderr), `終わりの知らせがない\n${r.stderr}`);
});

it('イン〜アウト（30〜89 コマ）を YouTube 1080p で: 1920x1080 に拡大、2 秒', async (exe) => {
  const p = project('inout');
  const r = await runDemo(exe, p, ['--preset', 'youtube-1080p', '--name', 'inout', '--in', '30', '--out', '89', '--range', 'inout', '--export-at', '3']);
  eq(r.code, 0, `終了コード\n${r.stderr}`);
  const j = r.queue.jobs[0];
  eq([j.state, j.totalFrames], ['done', 60], '範囲');
  // 範囲の始まりは半コマ前の時刻で渡す（秒の丸めで 1 コマずれないように）
  near(j.from, 29.5 / 30, 0.000001, '範囲の始まり');
  const m = probe(path.join(p.out, 'inout.mp4'));
  eq([m.v.width, m.v.height], [1920, 1080], '大きさ');
  eq(videoFrames(path.join(p.out, 'inout.mp4')), 60, 'コマ数');
});

it('選んだクリップ（60〜149 コマ、終わりは含まない）: 89 コマ。境目の秒が丸めで 1 コマずれない', async (exe) => {
  const p = project('clips');
  const r = await runDemo(exe, p, ['--preset', 'web-light', '--name', 'sel', '--sel', '60-149', '--range', 'clips', '--export-at', '3']);
  eq(r.code, 0, `終了コード
${r.stderr}`);
  const j = r.queue.jobs[0];
  eq([j.state, j.totalFrames, j.doneFrames], ['done', 89, 89], '範囲');
  eq(videoFrames(path.join(p.out, 'sel.mp4')), 89, 'コマ数');
});

it('音だけ（AAC）: 映像なしの M4A を直接書く（runner への依頼は作らない）', async (exe) => {
  const p = project('audio');
  const r = await runDemo(exe, p, ['--preset', 'audio-aac', '--name', 'bgm', '--export-at', '3']);
  eq(r.code, 0, `終了コード\n${r.stderr}`);
  eq(r.queue.jobs[0].state, 'done', '完了');
  assert(!fs.existsSync(path.join(p.cache, 'wsx', 'job-1-1.json')), 'runner への依頼を置いている');
  const m = probe(path.join(p.out, 'bgm.m4a'));
  eq([m.v, m.a.codec_name, m.a.sample_rate, m.a.channels], [undefined, 'aac', '48000', 2], '音だけ');
  near(m.dur, 10.5, 0.1, '長さ');
});

it('音だけ（WAV）: PCM 24 ビット 48 kHz ステレオを直接書く', async (exe) => {
  const p = project('wav');
  const r = await runDemo(exe, p, ['--preset', 'audio-wav', '--name', 'master', '--export-at', '3']);
  eq(r.code, 0, `終了コード\n${r.stderr}`);
  eq(r.queue.jobs[0].state, 'done', `完了\n${r.stderr}`);
  assert(!fs.existsSync(path.join(p.cache, 'wsx', 'job-1-1.json')), 'runner への依頼を置いている');
  const m = probe(path.join(p.out, 'master.wav'));
  eq([m.v, m.a.codec_name, m.a.sample_rate, m.a.channels], [undefined, 'pcm_s24le', '48000', 2], 'WAV');
  near(m.dur, 10.5, 0.05, '長さ');
});

it('ProRes 422 HQ: MOV（prores、10 ビット 4:2:2、PCM 24 ビット）を直接書く。コマ数も合う', async (exe) => {
  const p = project('prores');
  const r = await runDemo(exe, p, ['--preset', 'prores-hq', '--name', 'master', '--in', '0', '--out', '59', '--range', 'inout', '--export-at', '3']);
  eq(r.code, 0, `終了コード\n${r.stderr}`);
  eq(r.queue.jobs[0].state, 'done', `完了\n${r.stderr}`);
  const out = path.join(p.out, 'master.mov');
  const s = spawnSync(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,profile,pix_fmt,width,height', '-of', 'json', out], { encoding: 'utf8' });
  const v = JSON.parse(s.stdout).streams[0];
  eq([v.codec_name, v.pix_fmt, v.width, v.height], ['prores', 'yuv422p10le', 1280, 720], 'ProRes');
  assert(/HQ/i.test(v.profile ?? ''), `プロファイルが ${v.profile} です`);
  const m = probe(out);
  eq([m.a.codec_name, m.a.sample_rate], ['pcm_s24le', '48000'], '音');
  eq(videoFrames(out), 60, 'コマ数');
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

it('合成の途中で取り消す: 同じ名前の前のファイルは消さない', async (exe) => {
  const p = project('cancel-keep');
  fs.mkdirSync(p.out, { recursive: true });
  const prev = path.join(p.out, 'keep.mp4');
  fs.writeFileSync(prev, '前に書き出したファイル');
  // renderShare は 0.5 なので、進み具合 0.1 は合成の途中
  const r = await runDemo(exe, p, ['--preset', 'web-light', '--name', 'keep', '--export-at', '3', '--cancel-when', '0.1']);
  eq(r.code, 0, `終了コード
${r.stderr}`);
  eq(r.queue.jobs[0].state, 'canceled', '取り消し');
  // 直接書く書き出しは一時のファイルに書くので、出力の場所の前のファイルには触らない
  eq(fs.existsSync(prev) && fs.readFileSync(prev, 'utf8'), '前に書き出したファイル', '前のファイル');
});

it('開いた後に .mzc を書き換える（30p → 25p）: 書き出しは書き換えた中身で、コマ数・フレームレートも合う', async (exe) => {
  const p = project('reload');
  const swapped = path.join(p.dir, 'swapped.mzc');
  fs.writeFileSync(swapped, fs.readFileSync(p.mzc, 'utf8').replace('fps=30', 'fps=25'));
  const r = await runDemo(exe, p, ['--preset', 'web-light', '--name', 'reload', '--swap-mzc', swapped, '--swap-at', '3', '--export-at', '3']);
  eq(r.code, 0, `終了コード
${r.stderr}`);
  const j = r.queue.jobs[0];
  // 10.5 秒 × 25 = 262.5 → 263 コマ（30p のままなら 315）
  eq([j.state, j.totalFrames, j.doneFrames], ['done', 263, 263], '待ち行列');
  const out = path.join(p.out, 'reload.mp4');
  const m = probe(out);
  eq(m.v.r_frame_rate, '25/1', 'フレームレート');
  eq(videoFrames(out), 263, 'コマ数');
});

it('素材がない: 確認にエラーが出て、書き出しを始めない', async (exe) => {
  const p = project('missing', (s) => s.replace('media/clip_b.mp4', 'media/nosuch.mp4'));
  const r = await runDemo(exe, p, ['--preset', 'web-light', '--export-at', '3', '--frames', '8']);
  eq(r.code, 0, `終了コード\n${r.stderr}`);
  eq(r.queue.jobs, [], '仕事は足さない');
  assert(r.stderr.includes('書き出しの前の確認にエラーが 1 件あります'), r.stderr);
});

it('runner の道（MOZCUT_EXPORT_RUNNER=1、音だけの AAC）で、合成の前に失敗する（ffmpeg が起動できない）: 失敗の理由が待ち行列に載る', async (exe) => {
  const p = project('fail');
  const r = await runDemo(exe, p, ['--preset', 'audio-aac', '--export-at', '3'], { FFMPEG: path.join(TMP, 'no-such-ffmpeg'), MOZCUT_EXPORT_RUNNER: '1' });
  eq(r.code, 0, `終了コード\n${r.stderr}`);
  const j = r.queue.jobs[0];
  eq([j.state, j.error && j.error.code], ['failed', 'render-failed'], '失敗');
  assert(j.error.msg.includes('素材を展開できません'), j.error.msg);
  assert(r.stderr.includes('demo.m4a を書き出せませんでした（'), `失敗の知らせがない\n${r.stderr}`);
});

it('runner の道で、runner が動いていない（exe だけで起動した）: 依頼を置かずに失敗し、理由を知らせる', async (exe) => {
  const p = project('no-runner');
  const r = await new Promise((resolve) => {
    const c = spawn(exe, ['--project', p.mzc, '--cache', p.cache, '--folder', p.out, '--tokens', path.join(ROOT, 'docs', 'design', 'tokens.json'),
      '--until-done', '--timeout', '60', '--preset', 'audio-aac', '--export-at', '3'],
    { env: { ...process.env, SDL_VIDEO_DRIVER: 'offscreen', SDL_AUDIO_DRIVER: 'dummy', MOZCUT_EXPORT_RUNNER: '1' } });
    let out = '';
    let err = '';
    c.stdout.on('data', (d) => { out += d; });
    c.stderr.on('data', (d) => { err += d; });
    c.on('close', (code) => {
      let queue = null;
      try { queue = JSON.parse(out.trim().split(/\r?\n/).pop() ?? ''); } catch { /* 下で失敗にする */ }
      resolve({ code, queue, stderr: err });
    });
  });
  eq(r.code, 0, `終了コード\n${r.stderr}`);
  const j = r.queue.jobs[0];
  eq([j.state, j.error && j.error.code], ['failed', 'start-failed'], '失敗');
  assert(j.error.msg.includes('だけでは書き出せません'), j.error.msg);
  assert(!fs.existsSync(path.join(p.cache, 'wsx', 'job-1-1.json')), '依頼を置いている');
});

it('直接の書き出しで出力の場所に書けない: 失敗の理由が待ち行列に載り、知らせる', async (exe) => {
  const p = project('fail-direct');
  // 出力の場所に同じ名前のフォルダがあると、書き終えたものを写せない
  fs.mkdirSync(path.join(p.out, 'demo.mp4'), { recursive: true });
  const r = await runDemo(exe, p, ['--preset', 'web-light', '--export-at', '3']);
  eq(r.code, 0, `終了コード\n${r.stderr}`);
  const j = r.queue.jobs[0];
  eq([j.state, j.error && j.error.code], ['failed', 'encode-failed'], '失敗');
  assert(j.error.msg.includes('に書けません'), j.error.msg);
  assert(r.stderr.includes('demo.mp4 を書き出せませんでした（'), `失敗の知らせがない\n${r.stderr}`);
});

// ---- 編集画面（src/editor.um）の「出力」のワークスペース（src/editor/ws_export.um） ----
//
// MP4 のプリセットは、編集画面が FFmpeg の組み込みで直接書く（--frames のあいだに書き終える）。
// 座標は 1440×900: 上の帯の［書き出す…］(1375, 20)、出力の範囲の「選んだクリップ」(873, 386)、［書き出す］(1210, 500)、
// カット編集の札 (748, 20)、状態の帯は y 880〜896。

const edit2Cases = [];
const it2 = (name, fn) => edit2Cases.push({ name, fn });

function runEdit2(exe, p, args) {
  return new Promise((resolve) => {
    const c = spawn(exe, [p.mzc, p.cache, '--home', path.join(ROOT, 'build'), ...args],
      { env: { ...process.env, SDL_VIDEO_DRIVER: 'offscreen', SDL_AUDIO_DRIVER: 'dummy' } });
    let err = '';
    c.stderr.on('data', (d) => { err += d; });
    c.on('close', (code) => resolve({ code, stderr: err }));
  });
}

// 状態の帯（y 880〜896、x 300〜1150）で pred に合う画素を数える
function statusPixels(bmp, pred) {
  const b = fs.readFileSync(bmp);
  const w = b.readInt32LE(18);
  let n = 0;
  for (let y = 880; y <= 896; y++) {
    for (let x = 300; x <= 1150; x++) {
      if (pred(b.readUInt32LE(54 + (y * w + x) * 4) & 0xffffff)) n++;
    }
  }
  return n;
}
const ACCENT = 0x4c8dff;
const isRed = (c) => (c >> 16) > 0xc0 && ((c >> 8) & 0xff) < 0x90 && (c & 0xff) < 0x90;

it2('［書き出す…］で出力を開き、選んだクリップ（clip_a、60〜179 コマ）を直接書き出す。走っている間は状態の帯に進み具合の棒', async (exe) => {
  const p = project('e2-run');
  const clicks = ['--select', 'clip_a', '--click', '1375,20@2', '--click', '873,386@5', '--click', '1210,500@8', '--click', '722,20@12'];
  // 走っている途中（書き出しを押してすぐ）: カット編集に戻しても、状態の帯に進み具合の棒（アクセントの色）が出る
  const mid = project('e2-run-mid');
  const midShot = path.join(mid.dir, 'mid.bmp');
  const r0 = await runEdit2(exe, mid, ['--frames', '14', ...clicks, '--shot', midShot]);
  eq(r0.code, 0, `終了コード\n${r0.stderr}`);
  const bar = statusPixels(midShot, (c) => c === ACCENT);
  assert(bar > 0 && bar < 256, `走っている途中の進み具合の棒の画素が ${bar} です`);
  // 書き終える: 120 コマの MP4 が .mzc のフォルダに出来、棒は消える
  const shot = path.join(p.dir, 'run.bmp');
  const r = await runEdit2(exe, p, ['--frames', '400', ...clicks, '--shot', shot]);
  eq(r.code, 0, `終了コード\n${r.stderr}`);
  const out = path.join(p.dir, 'demo.mp4');
  assert(fs.existsSync(out), `${out} がない`);
  eq(videoFrames(out), 120, 'コマ数');
  const m = probe(out);
  near(m.dur, 4, 0.05, '長さ');
  eq(m.a && m.a.codec_name, 'aac', '音');
  eq(statusPixels(shot, (c) => c === ACCENT), 0, '終わったのに進み具合の棒が残っている');
  eq(statusPixels(shot, isRed), 0, '成功なのに赤い文字がある');
});

it2('書き出しに失敗したら（書き出す一時のファイルを作れない）、誤りの色の 1 文を状態の帯に出す', async (exe) => {
  const failed = project('e2-failed');
  // 一時のファイル（<cache>/wsx/job-1-1.mp4）の場所にフォルダがあると、書き手を作れずにすぐ失敗する
  // （終わりの 1 文は 8 秒しか出ないので、すぐ失敗する形にして、知らせ（トースト）が消えたあとのそのあいだに画面を撮る）
  fs.mkdirSync(path.join(failed.cache, 'wsx', 'job-1-1.mp4'), { recursive: true });
  const ngShot = path.join(failed.dir, 'end.bmp');
  const b = await runEdit2(exe, failed, ['--frames', '400', '--click', '1375,20@2', '--click', '1210,500@6', '--shot', ngShot]);
  eq(b.code, 0, `終了コード\n${b.stderr}`);
  eq(statusPixels(ngShot, (c) => c === ACCENT), 0, '失敗したのに進み具合の棒が残っている');
  assert(statusPixels(ngShot, isRed) > 30, '失敗の 1 文が誤りの色で出ていない');
});

// ---- 流す ----

makeMedia();
const exe = buildTool('ws_export_demo', path.join(ROOT, 'demos', 'ws_export_demo.um'));
const edit2Exe = buildTool('mozcut-edit', path.join(ROOT, 'src', 'editor.um'));
for (const c of edit2Cases) cases.push({ name: `編集画面/${c.name}`, fn: () => c.fn(edit2Exe) });
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
