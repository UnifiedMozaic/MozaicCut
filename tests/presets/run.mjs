#!/usr/bin/env node
// 書き出しのプリセット（src/presets.um）のテスト。node tests/presets/run.mjs で流す（-v、--keep）。
// src/ を一時フォルダに写し、tests/presets/presets_test.um をその隣に置いてビルドして試す。npm の依存はない。
// 素材の情報は tests/cases/probe.txt（ffprobe の結果の代わり）を使う。
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildTool, run, runJson, put, test, done, eq, assert, PROBE } from '../umtest.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PT = buildTool('presets_test', path.join(HERE, 'presets_test.um'));

const IDS = ['youtube-1080p', 'youtube-4k', 'sns-vertical', 'web-light', 'prores-hq', 'audio-wav', 'audio-aac'];
const check = (mzc, id) => runJson(PT, ['check', put(mzc.name, mzc.text), PROBE, id]);
const codes = (ds) => ds.map((d) => `${d.code}:${d.severity}`);
function plan(mzc, id) {
  const out = run(PT, ['plan', put(mzc.name, mzc.text), PROBE, id]).trim().split(/\r?\n/);
  return { plan: JSON.parse(out[0]), args: out.slice(1) };
}
function argOf(args, key) {
  const k = args.indexOf(key);
  return k < 0 ? null : args[k + 1];
}

const H1080 = { name: 'h1080.mzc', text: 'project size=1920x1080 fps=30\nvideo "media/a.mp4" id=a\n' };
const V60 = { name: 'v60.mzc', text: 'project size=1080x1920 fps=60\nvideo "media/a.mp4" id=a\n' };
const H720_LONG_SILENT = { name: 'h720.mzc', text: 'project size=1280x720 fps=30\ncolor red id=a dur=200\n' };
const SQUARE = { name: 'sq.mzc', text: 'project size=1080x1080 fps=30000/1001\nvideo "media/a.mp4" id=a\n' };
const MUSIC = { name: 'music.mzc', text: 'project size=64x36\naudio "media/music.wav" id=m\n' };
const MUTED = { name: 'muted.mzc', text: 'project size=64x36\nvideo "media/a.mp4" id=a mute=1\n' };
const EMPTY = { name: 'empty.mzc', text: 'project size=1920x1080\n' };

// ---- 表 ----

test('表: 7 つのプリセットと、そのそれぞれの値', () => {
  const r = runJson(PT, ['list']);
  eq(r.presets.map((x) => x.id), IDS, '名前と順');
  const by = Object.fromEntries(r.presets.map((x) => [x.id, x]));
  eq([by['youtube-1080p'].video.width, by['youtube-1080p'].video.height, by['youtube-1080p'].video.kbps], [1920, 1080, 8000], 'YouTube 1080p');
  eq([by['youtube-4k'].video.width, by['youtube-4k'].video.kbps, by['youtube-4k'].video.kbpsHighFps], [3840, 45000, 68000], 'YouTube 4K');
  eq([by['sns-vertical'].video.width, by['sns-vertical'].video.height, by['sns-vertical'].maxDuration], [1080, 1920, 180], 'SNS 縦');
  eq([by['web-light'].video.rateControl, by['web-light'].video.crf, by['web-light'].video.maxKbps], ['crf', 26, 2500], 'Web 用');
  eq([by['prores-hq'].container, by['prores-hq'].video.codec, by['prores-hq'].video.profile, by['prores-hq'].video.width, by['prores-hq'].loudness],
    ['mov', 'prores', 'hq', 0, null], 'ProRes 422 HQ（大きさはプロジェクトのまま、音量は変えない）');
  eq([by['audio-wav'].video, by['audio-wav'].audio.codec, by['audio-wav'].container], [null, 'pcm_s24le', 'wav'], '音だけ WAV');
  eq([by['audio-aac'].video, by['audio-aac'].audio.codec, by['audio-aac'].container, by['audio-aac'].loudness.lufs], [null, 'aac', 'm4a', -16], '音だけ AAC');
  eq(by['youtube-1080p'].loudness, { lufs: -14, truePeak: -1 }, '配信用は -14 LUFS');
});

test('表: 標準のプリセットはどれも検査を通る', () => {
  const r = runJson(PT, ['validate']);
  for (const id of IDS) eq(r[id], [], `${id} の検査`);
});

test('表: 人向けの 1 行の説明', () => {
  const lines = run(PT, ['text']).trim().split(/\r?\n/);
  eq(lines.length, IDS.length, '行の数');
  assert(lines[0].startsWith('YouTube 1080p（youtube-1080p） — mp4 / H.264 high 1920x1080 8 Mbps（31 コマ/秒以上は 12 Mbps）'), lines[0]);
  assert(!lines[2].includes('31 コマ/秒以上'), `30 コマ/秒までのものは高いコマの速さの値を出さない: ${lines[2]}`);
  assert(lines[4].includes('プロジェクトの大きさ'), lines[4]);
});

// ---- プロジェクトとの食い違い ----

test('食い違いなし: 横 1080p に YouTube 1080p', () => {
  eq(check(H1080, 'youtube-1080p'), [], '診断なし');
});

test('縦の素材に横のプリセット: preset-orientation（sns-vertical を勧める）', () => {
  const ds = check(V60, 'youtube-1080p');
  eq(codes(ds), ['preset-orientation:warning'], '診断');
  assert(ds[0].message.includes('縦の画面') && ds[0].message.includes('黒い帯'), ds[0].message);
  eq(ds[0].suggest, 'sns-vertical', '勧めるプリセット');
});

test('横の素材に縦のプリセット: preset-orientation、長すぎ、無音', () => {
  const ds = check(H720_LONG_SILENT, 'sns-vertical');
  eq(codes(ds), ['preset-no-audio:warning', 'preset-orientation:warning', 'preset-too-long:warning'], '診断');
  eq(ds[1].suggest, 'youtube-1080p', '勧めるプリセット');
});

test('コマの間引き: 60 コマ/秒の縦に SNS 縦（30 まで）', () => {
  const ds = check(V60, 'sns-vertical');
  eq(codes(ds), ['preset-fps:warning'], '診断');
  assert(ds[0].message.includes('60 コマ/秒') && ds[0].message.includes('30 コマ/秒'), ds[0].message);
});

test('拡大: 1080p を 4K で書き出す', () => {
  const ds = check(H1080, 'youtube-4k');
  eq(codes(ds), ['preset-upscale:warning'], '診断');
  eq(ds[0].suggest, 'youtube-1080p', '勧めるプリセット');
});

test('縦横比の違い: 正方形を 16:9 に', () => {
  const ds = check(SQUARE, 'youtube-1080p');
  eq(codes(ds), ['preset-aspect:warning'], '診断');
  assert(ds[0].message.includes('1:1') && ds[0].message.includes('16:9') && ds[0].message.includes('左右'), ds[0].message);
});

test('音だけのプリセットなのに音がない: error', () => {
  eq(codes(check(H720_LONG_SILENT, 'audio-wav')), ['preset-no-audio:error'], '色だけ');
  eq(codes(check(MUTED, 'audio-aac')), ['preset-no-audio:error'], 'mute した映像だけ');
  eq(check(MUSIC, 'audio-aac'), [], '音があれば通る');
});

test('書き出すものがない: preset-empty', () => {
  const ds = check(EMPTY, 'youtube-1080p');
  assert(codes(ds).includes('preset-empty:error'), JSON.stringify(ds));
});

test('知らないプリセット: preset-unknown（近い名前を勧める）', () => {
  const ds = check(H1080, 'youtube-1080');
  eq(codes(ds), ['preset-unknown:error'], '診断');
  eq(ds[0].suggest, 'youtube-1080p', '近い名前');
  for (const d of ds) assert(d.line === 0 && d.col === 0, 'ファイル全体の診断');
});

test('勧めるプリセット', () => {
  eq(run(PT, ['suggest', put(V60.name, V60.text), PROBE]).trim(), 'sns-vertical', '縦');
  eq(run(PT, ['suggest', put(H1080.name, H1080.text), PROBE]).trim(), 'youtube-1080p', '横');
  const uhd = { name: 'uhd.mzc', text: 'project size=3840x2160\ncolor red id=a dur=1\n' };
  eq(run(PT, ['suggest', put(uhd.name, uhd.text), PROBE]).trim(), 'youtube-4k', '4K');
});

// ---- 書き出す値と ffmpeg の引数 ----

test('値: 縦 60 コマ/秒を YouTube 1080p に（帯、高いコマの速さのビットレート、キーフレーム）', () => {
  const { plan: p, args } = plan(V60, 'youtube-1080p');
  eq([p.width, p.height, p.contentW, p.contentH, p.fps, p.fpsLimited], [1920, 1080, 608, 1080, '60/1', false], '大きさとコマの速さ');
  eq([p.videoKbps, p.maxKbps, p.bufKbps, p.keyint], [12000, 18000, 36000, 30], 'ビットレートとキーフレーム');
  eq(argOf(args, '-c:v'), 'libx264', '符号器');
  eq(argOf(args, '-b:v'), '12000k', 'ビットレート');
  assert(argOf(args, '-vf').startsWith('scale=608:1080:flags=lanczos,pad=1920:1080:'), argOf(args, '-vf'));
  eq(argOf(args, '-af'), 'loudnorm=I=-14:TP=-1:LRA=11', 'ラウドネス');
  eq(argOf(args, '-movflags'), '+faststart', 'faststart');
  eq(args[args.length - 1], 'out.mp4', '出力');
});

test('値: SNS 縦はコマの速さを 30 に落とす', () => {
  const { plan: p, args } = plan(V60, 'sns-vertical');
  eq([p.fps, p.fpsLimited, p.videoKbps, p.maxKbps, p.keyint], ['30/1', true, 10000, 15000, 30], '値');
  assert(argOf(args, '-vf').startsWith('fps=30/1,setparams='), argOf(args, '-vf'));
});

test('値: ProRes はプロジェクトのまま、PCM 24 ビット、ラウドネスなし', () => {
  const { plan: p, args } = plan(SQUARE, 'prores-hq');
  eq([p.width, p.height, p.fps, p.fpsLimited], [1080, 1080, '30000/1001', false], '大きさとコマの速さ');
  eq([argOf(args, '-c:v'), argOf(args, '-profile:v'), argOf(args, '-pix_fmt'), argOf(args, '-c:a')],
    ['prores_ks', '3', 'yuv422p10le', 'pcm_s24le'], '符号器');
  eq(argOf(args, '-af'), null, '音量は変えない');
  eq(args[args.length - 1], 'out.mov', '出力');
});

test('値: Web 用は crf と上限', () => {
  const { args } = plan(H1080, 'web-light');
  eq([argOf(args, '-crf'), argOf(args, '-maxrate'), argOf(args, '-bufsize'), argOf(args, '-profile:v')], ['26', '2500k', '5000k', 'main'], '値');
  eq(argOf(args, '-b:v'), null, 'crf のときは平均ビットレートを書かない');
});

test('値: 音だけは映像の入力を使わない', () => {
  const { plan: p, args } = plan(MUSIC, 'audio-aac');
  eq(p.hasVideo, false, '映像なし');
  assert(!args.includes('in.y4m') && !args.includes('-c:v'), args.join(' '));
  eq([argOf(args, '-map'), argOf(args, '-c:a'), argOf(args, '-b:a')], ['0:a', 'aac', '256k'], '音');
  const wav = plan(MUSIC, 'audio-wav').args;
  eq([argOf(wav, '-c:a'), wav[wav.length - 1]], ['pcm_s24le', 'out.wav'], 'WAV');
  eq(argOf(wav, '-movflags'), null, 'WAV に faststart は付けない');
});

done('presets');
