#!/usr/bin/env node
// 解析の部品（src/analyze/）のテスト。node tests/analyze/run.mjs で流す。npm の依存はない。
//
// 試験用の入口 src/azmain.um を build/mozcut-analyze にビルドし（古ければ）、次を確かめる:
//   video    node で作った Y4M（場面の切り替え・黒いコマ・止まったコマ）で、切れ目と区間の時刻が合うこと
//   audio    node で作った PCM（音と無音、しきい値より小さい雑音）で、無音の区間の時刻が合うこと
//   words    whisper.cpp の JSON と、segments 形式の JSON を読み、単語と話している区間が合うこと
//   subs     字幕の区切り・行の折り返し・SRT の中身
//   suggest  .mzc とキャッシュから操作の提案を作り、op の書き方の文字列が合うこと。
//            さらにエンジン（build/mozcut）で op --dry-run を通し、すべての提案が適用できること
//   errors   読めないファイルは終了コード 1、使い方の誤りは 2（--json では {"ok":false}）
//   ffmpeg   ffmpeg があれば、lavfi で作った映像・音でも時刻が合うこと（なければ飛ばす）
//   gpu      UM_WGPU_HOME があれば、UM_WGPU=1 でビルドしたもの（kernel を wgpu で実行）が CPU と同じ JSON を出すこと
//
// オプション: --keep（作業用のフォルダを残す）、-v（落ちたときに出力を全部出す）、--no-engine（op の確かめを飛ばす）
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const EXT = process.platform === 'win32' ? '.exe' : '';
const AZ = path.join(ROOT, 'build', 'mozcut-analyze' + EXT);
const MOZCUT_MJS = path.join(ROOT, 'tools', 'mozcut.mjs');
const argv = process.argv.slice(2);
const KEEP = argv.includes('--keep');
const VERBOSE = argv.includes('-v');
const NO_ENGINE = argv.includes('--no-engine');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mozcut-analyze-'));

let passed = 0;
let skipped = 0;
const failures = [];
class Fail extends Error {}
function fail(msg) { throw new Fail(msg); }
function assert(cond, msg) { if (!cond) fail(msg); }
function near(a, b, tol, what) {
  assert(typeof a === 'number' && Math.abs(a - b) <= tol, `${what}: ${a} は ${b}（±${tol}）のはずです`);
}
function test(name, fn) {
  try {
    const r = fn();
    if (r === 'skip') { skipped++; console.log(`  --  ${name}（飛ばしました）`); return; }
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    const msg = e instanceof Fail ? e.message : (e.stack || String(e));
    failures.push({ name, msg });
    console.log(`  NG  ${name}`);
    for (const l of msg.split('\n')) console.log(`        ${l}`);
  }
}
function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 1 << 26, ...opts });
  if (r.error) fail(`${cmd} を起動できません: ${r.error.message}`);
  return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
}
function az(args) { return run(AZ, args, { cwd: TMP }); }
function azJson(args, wantCode = 0) {
  const r = az([...args, '--json']);
  let j;
  try {
    j = JSON.parse(r.out);
  } catch {
    fail(`JSON として読めません（終了コード ${r.code}）:\n${r.out}\n${r.err}`);
  }
  if (r.code !== wantCode) fail(`終了コード ${r.code}（${wantCode} のはず）:\n${VERBOSE ? r.out : r.out.slice(0, 600)}\n${r.err}`);
  return j;
}

// ---- UM のコンパイラを探してビルドする ----

function umHome() {
  const cands = [process.env.UM_HOME, path.resolve(ROOT, '..', 'UnifiedMozaic'), path.join(os.homedir(), 'UnifiedMozaic')];
  for (const c of cands) {
    if (c && fs.existsSync(path.join(c, 'src', 'cli.ts'))) return c;
  }
  return null;
}
function newestSource() {
  let t = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (p.endsWith('.um')) t = Math.max(t, fs.statSync(p).mtimeMs);
    }
  };
  walk(path.join(ROOT, 'src'));
  return t;
}
function buildAz() {
  if (fs.existsSync(AZ) && fs.statSync(AZ).mtimeMs >= newestSource()) return;
  const um = umHome();
  if (!um) {
    console.error('UnifiedMozaic が見つかりません（UM_HOME を設定してください）');
    process.exit(1);
  }
  console.log('解析の部品をビルドしています（src/azmain.um）...');
  fs.mkdirSync(path.dirname(AZ), { recursive: true });
  const r = spawnSync(process.execPath, [path.join(um, 'src', 'cli.ts'), 'build', path.join(ROOT, 'src', 'azmain.um'), '--target', 'host', '-o', AZ],
    { stdio: 'inherit' });
  if (r.status !== 0) {
    console.error('ビルドに失敗しました');
    process.exit(1);
  }
}

// ---- 素材を node で作る ----

// Y4M（4:2:0）。frameFn(k) が {y(x,yy), u, v} を返す。
function writeY4m(file, w, h, fps, frames, frameFn) {
  const head = Buffer.from(`YUV4MPEG2 W${w} H${h} F${fps}:1 Ip A1:1 C420jpeg\n`);
  const fsz = w * h * 3 / 2;
  const out = Buffer.alloc(head.length + frames * (6 + fsz));
  head.copy(out, 0);
  let o = head.length;
  for (let k = 0; k < frames; k++) {
    out.write('FRAME\n', o);
    o += 6;
    const f = frameFn(k);
    for (let yy = 0; yy < h; yy++) for (let x = 0; x < w; x++) out[o++] = clamp(f.y(x, yy));
    for (let yy = 0; yy < h / 2; yy++) for (let x = 0; x < w / 2; x++) out[o++] = clamp(f.u);
    for (let yy = 0; yy < h / 2; yy++) for (let x = 0; x < w / 2; x++) out[o++] = clamp(f.v);
  }
  fs.writeFileSync(file, out);
}
function clamp(v) { return Math.max(0, Math.min(255, Math.round(v))); }

// 場面: 0〜1 秒 動く縞（明るい・赤っぽい）、1〜2 秒 動く市松（暗め・青っぽい）、2〜2.5 秒 黒、
// 2.5〜4 秒 止まった灰色、4〜5 秒 動く斜めの縞（緑っぽい）。30 fps、64x48。
function sceneFrame(k) {
  const t = k / 30;
  if (t < 1) return { y: (x, yy) => 150 + 60 * Math.sin((x + 2 * k) / 4), u: 100, v: 190 };
  if (t < 2) return { y: (x, yy) => ((((x + k) >> 3) + (yy >> 3)) & 1) ? 110 : 40, u: 190, v: 110 };
  if (t < 2.5) return { y: () => 16, u: 128, v: 128 };
  if (t < 4) return { y: (x, yy) => 128 + ((x * 7 + yy * 3) % 5), u: 128, v: 128 };
  return { y: (x, yy) => 100 + 70 * Math.sin((x + yy + 3 * k) / 5), u: 70, v: 70 };
}

// 灰色の背景の上を、小さな模様の四角（size 画素）が speed 画素/秒で横に動く（中身の模様も動く）。
// 画面の一部だけが動く映像（話す人のアップ、小さな被写体）は「止まったコマ」ではない。
function movingObjectFrame(w, h, size, speed) {
  return (k) => {
    const x0 = 20 + speed * k / 30;
    const y0 = (h - size) / 2;
    return {
      y: (x, yy) => {
        if (x >= x0 && x < x0 + size && yy >= y0 && yy < y0 + size) {
          return ((((x - x0 + k) >> 2) + ((yy - y0) >> 2)) & 1) ? 210 : 40;
        }
        return 110;
      },
      u: 128, v: 128,
    };
  };
}

// s16le ステレオ 48 kHz。segs: [[秒, 'tone'|'soft'|'quiet'|'noise']]（soft は振幅 0.03、約 -33.5 dB）
function writePcm(file, rate, segs) {
  const total = segs.reduce((s, [d]) => s + Math.round(d * rate), 0);
  const buf = Buffer.alloc(total * 4);
  let n = 0;
  let seed = 1;
  for (const [d, kind] of segs) {
    const cnt = Math.round(d * rate);
    for (let i = 0; i < cnt; i++, n++) {
      let v = 0;
      if (kind === 'tone') v = 0.3 * Math.sin(2 * Math.PI * 440 * n / rate);
      else if (kind === 'soft') v = 0.03 * Math.sin(2 * Math.PI * 440 * n / rate);
      else if (kind === 'noise') {
        // -60 dB 程度の雑音（-40 dB のしきい値より小さい）
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        v = ((seed / 0x7fffffff) * 2 - 1) * 0.0015;
      }
      const s = Math.round(v * 32767);
      buf.writeInt16LE(s, n * 4);
      buf.writeInt16LE(s, n * 4 + 2);
    }
  }
  fs.writeFileSync(file, buf);
}

// ---- テスト ----

buildAz();
console.log(`解析: ${path.relative(ROOT, AZ)}（作業用のフォルダ ${TMP}）`);

const Y4M = path.join(TMP, 'scenes.y4m');
writeY4m(Y4M, 64, 48, 30, 150, sceneFrame);
const PCM = path.join(TMP, 'voice.pcm');
// 音 1.2 秒、無音 0.8 秒、音 1.0 秒、小さい雑音 1.5 秒、音 0.5 秒 = 5 秒
writePcm(PCM, 48000, [[1.2, 'tone'], [0.8, 'quiet'], [1.0, 'tone'], [1.5, 'noise'], [0.5, 'tone']]);

console.log('video');
test('シーンの切れ目（1 秒・2 秒・2.5 秒・4 秒）', () => {
  const j = azJson(['video', Y4M]);
  assert(j.ok, '解析に失敗しました');
  assert(j.frames === 150 && j.width === 64 && j.height === 48 && j.fps === '30/1', `大きさ・コマの数が違います: ${JSON.stringify([j.width, j.height, j.fps, j.frames])}`);
  const ts = j.scenes.map((c) => c.time);
  const want = [1, 2, 2.5, 4];
  assert(ts.length === want.length, `切れ目は ${want.join(', ')} 秒のはずです（${ts.join(', ')}）`);
  want.forEach((t, i) => near(ts[i], t, 1 / 30 + 1e-6, `${i + 1} 番目の切れ目`));
});
test('黒いコマ（2〜2.5 秒）と止まったコマ（2.5〜4 秒）', () => {
  const j = azJson(['video', Y4M]);
  assert(j.black.length === 1, `黒い区間は 1 つのはずです: ${JSON.stringify(j.black)}`);
  near(j.black[0].start, 2, 0.04, '黒の始まり');
  near(j.black[0].end, 2.5, 0.04, '黒の終わり');
  assert(j.freeze.length === 1, `止まった区間は 1 つのはずです: ${JSON.stringify(j.freeze)}`);
  near(j.freeze[0].start, 2.5, 0.04, '止まりの始まり');
  near(j.freeze[0].end, 4, 0.04, '止まりの終わり');
});
test('しきい値と最短の間隔（--min-gap 0.6 なら 2 秒と 2.5 秒の強い方だけ）', () => {
  const j = azJson(['video', Y4M, '--min-gap', '0.6']);
  const ts = j.scenes.map((c) => c.time);
  assert(ts.length === 3, `切れ目は 3 つのはずです（${ts.join(', ')}）`);
  const k = azJson(['video', Y4M, '--scene-threshold', '5', '--luma-threshold', '5']);
  assert(k.scenes.length === 0, `しきい値が大きければ切れ目はないはずです（${k.scenes.length}）`);
});
test('--frames でコマごとの特徴、文の出力', () => {
  const j = azJson(['video', Y4M, '--frames']);
  assert(Array.isArray(j.frameFeatures) && j.frameFeatures.length === 150, `コマごとの特徴がありません: ${Object.keys(j).join(',')}`);
  near(j.frameFeatures[70].dark, 1, 1e-9, '黒いコマの暗い画素の割合');
  const r = az(['video', Y4M]);
  assert(r.code === 0 && r.out.includes('シーンの切れ目 4 か所') && r.out.includes('黒いコマ'), `文の出力が違います:\n${r.out}`);
});
test('<file>.in があれば素材の秒（base）を出す', () => {
  const y2 = path.join(TMP, 'clip.y4m');
  fs.copyFileSync(Y4M, y2);
  fs.writeFileSync(y2 + '.in', '12.5');
  const j = azJson(['video', y2]);
  near(j.base, 12.5, 1e-9, 'base');
});
test('画面の一部だけが動く映像（小さな被写体）は止まったコマにしない', () => {
  // 640x360 の灰色の背景の上を、60x60 の模様が 20 画素/秒で動く 4 秒（差の平均は小さいが、ブロックの差の最大は大きい）
  const y = path.join(TMP, 'small-move.y4m');
  writeY4m(y, 640, 360, 30, 120, movingObjectFrame(640, 360, 60, 20));
  const j = azJson(['video', y, '--frames']);
  assert(j.freeze.length === 0, `止まったコマはないはずです: ${JSON.stringify(j.freeze)}`);
  const f = j.frameFeatures[60];
  assert(f.luma < 0.002 && f.moved >= 0.012, `差の平均（${f.luma}）は小さく、ブロックの差の最大（${f.moved}）は大きいはずです`);
  // 動きを止めれば止まったコマになる
  const z = path.join(TMP, 'small-still.y4m');
  writeY4m(z, 640, 360, 30, 60, (k) => movingObjectFrame(640, 360, 60, 0)(0));
  const s = azJson(['video', z]);
  assert(s.freeze.length === 1 && s.freeze[0].start === 0 && s.freeze[0].end === 2, `止まった区間 0〜2 秒のはずです: ${JSON.stringify(s.freeze)}`);
});
test('Y4M の色の形式とコマの速さ（C420p10・F0:0 などは誤り）', () => {
  const base = fs.readFileSync(Y4M);
  const nl = base.indexOf(10);
  const body = base.subarray(nl);
  for (const [head, want] of [
    ['YUV4MPEG2 W64 H48 F30:1 Ip A1:1 C420p10', '扱えません'],
    ['YUV4MPEG2 W64 H48 F30:1 Ip A1:1 C444', '扱えません'],
    ['YUV4MPEG2 W64 H48 F0:0 Ip A1:1 C420jpeg', 'コマの速さ'],
    ['YUV4MPEG2 W64 H48 Ip A1:1 C420jpeg', 'コマの速さ'],
  ]) {
    const f = path.join(TMP, 'bad-head.y4m');
    fs.writeFileSync(f, Buffer.concat([Buffer.from(head), body]));
    const j = azJson(['video', f], 1);
    assert(j.ok === false && j.error.includes(want), `'${head}' は「${want}」の誤りのはずです: ${JSON.stringify(j)}`);
  }
  for (const c of ['C420', 'C420mpeg2', 'C420paldv']) {
    const f = path.join(TMP, 'ok-head.y4m');
    fs.writeFileSync(f, Buffer.concat([Buffer.from(`YUV4MPEG2 W64 H48 F30000:1001 Ip A1:1 ${c}`), body]));
    const j = azJson(['video', f]);
    assert(j.ok && j.fps === '30000/1001', `${c} は読めるはずです: ${JSON.stringify(j).slice(0, 200)}`);
  }
});

console.log('audio');
test('無音の区間（1.2〜2.0 秒、3.0〜4.5 秒）', () => {
  const j = azJson(['audio', PCM]);
  assert(j.ok && j.rate === 48000 && j.channels === 2, '読み取りに失敗しました');
  near(j.duration, 5, 1e-6, '長さ');
  assert(j.silence.length === 2, `無音は 2 つのはずです: ${JSON.stringify(j.silence)}`);
  near(j.silence[0].start, 1.2, 0.011, '1 つ目の始まり');
  near(j.silence[0].end, 2.0, 0.011, '1 つ目の終わり');
  near(j.silence[1].start, 3.0, 0.011, '2 つ目の始まり');
  near(j.silence[1].end, 4.5, 0.011, '2 つ目の終わり');
  assert(j.silence[1].maxDb < -50 && j.silence[1].maxDb > -80, `雑音の区間の大きさ: ${j.silence[1].maxDb}`);
  near(j.peakDb, 20 * Math.log10(0.3), 0.1, '最大');
});
test('しきい値 dB と最短の長さ', () => {
  const j = azJson(['audio', PCM, '--threshold', '-70']);
  assert(j.silence.length === 1, `-70 dB なら雑音は無音にならないはずです: ${JSON.stringify(j.silence)}`);
  const k = azJson(['audio', PCM, '--min', '1.0']);
  assert(k.silence.length === 1 && Math.abs(k.silence[0].start - 3.0) < 0.011, `1 秒以上の無音は 1 つのはずです: ${JSON.stringify(k.silence)}`);
  const l = azJson(['audio', PCM, '--levels']);
  assert(Array.isArray(l.levelsDb) && l.levelsDb.length === 500, `--levels は 10 ミリ秒ごとに 500 個のはずです（${l.levelsDb?.length}）`);
});
test('モノラル・別の周波数', () => {
  const mono = path.join(TMP, 'mono.pcm');
  const st = fs.readFileSync(PCM);
  const m = Buffer.alloc(st.length / 2);
  for (let i = 0; i < m.length / 2; i++) m.writeInt16LE(st.readInt16LE(i * 4), i * 2);
  fs.writeFileSync(mono, m);
  // 48000 標本 / 秒のモノラルを 24000 と読めば時刻は 2 倍
  const j = azJson(['audio', mono, '--channels', '1', '--rate', '24000']);
  near(j.duration, 10, 1e-6, '長さ');
  near(j.silence[0].start, 2.4, 0.021, '始まり');
});
test('長い素材の --levels が速い（1 時間 = 36 万窓。文字列を足していく形だと数分かかる）', () => {
  // 窓の数が同じになるよう、8 kHz・モノラルの 1 時間（57.6 MB の無音）にする
  const long = path.join(TMP, 'hour.pcm');
  fs.writeFileSync(long, Buffer.alloc(3600 * 8000 * 2));
  const t0 = Date.now();
  const r = az(['audio', long, '--rate', '8000', '--channels', '1', '--levels', '--json']);
  const sec = (Date.now() - t0) / 1000;
  assert(r.code === 0, `失敗しました: ${r.err}`);
  const j = JSON.parse(r.out);
  assert(j.levelsDb.length === 360000, `窓の数: ${j.levelsDb.length}`);
  assert(sec < 15, `1 時間の --levels に ${sec} 秒かかりました（15 秒以内のはず）`);
  fs.rmSync(long);
});

console.log('words');
const WCPP = path.join(HERE, 'whisper-cpp.json');
const WSEG = path.join(HERE, 'segments.json');
test('whisper.cpp の JSON（特別なトークンを飛ばし、語の続きをつなぐ）', () => {
  const j = azJson(['words', WCPP]);
  assert(j.format === 'whisper.cpp' && j.language === 'en', `形式・言語: ${j.format} ${j.language}`);
  const texts = j.words.map((w) => w.text);
  assert(JSON.stringify(texts) === JSON.stringify(['Hello', 'world,', 'this', 'is', 'a', 'test', 'of', 'subtitles.', 'こん', 'にち', 'は。']),
    `単語: ${JSON.stringify(texts)}`);
  near(j.words[7].start, 3.5, 1e-9, 'subtitles の始まり');
  near(j.words[7].end, 4.5, 1e-9, 'subtitles の終わり');
  assert(j.speech.length === 3, `話している区間は 3 つのはずです: ${JSON.stringify(j.speech)}`);
  near(j.speech[1].start, 2.5, 1e-9, '2 つ目の始まり');
  near(j.speech[1].end, 4.5, 1e-9, '2 つ目の終わり');
});
test('segments 形式（OpenAI / faster-whisper）と --max-gap', () => {
  const j = azJson(['words', WSEG]);
  assert(j.format === 'segments' && j.language === 'ja' && j.words.length === 6, `読み取り: ${JSON.stringify(j).slice(0, 300)}`);
  const k = azJson(['words', WSEG, '--max-gap', '5']);
  assert(k.speech.length === 1, `間が 5 秒まで続けば区間は 1 つのはずです: ${JSON.stringify(k.speech)}`);
});
// whisper.cpp の -oj（tokens なし）。長い日本語の区切り（66 文字 = 幅 132）と [BLANK_AUDIO]
const LONG_JA = '今日は朝から雨が降っていましたが、昼過ぎには晴れてきたので、近くの公園まで散歩に出かけることにしました。公園では子供たちが元気に遊んでいました。';
const WOJ = path.join(TMP, 'whisper-oj.json');
fs.writeFileSync(WOJ, JSON.stringify({
  result: { language: 'ja' },
  transcription: [
    { offsets: { from: 0, to: 2000 }, text: ' はじめまして。' },
    { offsets: { from: 2000, to: 8000 }, text: ' [BLANK_AUDIO]' },
    { offsets: { from: 8000, to: 20000 }, text: ` ${LONG_JA}` },
    { offsets: { from: 20000, to: 22000 }, text: ' (音楽)' },
  ],
}));
test('言葉でないもの（[BLANK_AUDIO]、(音楽)）は言葉の区間と字幕から外す', () => {
  const j = azJson(['words', WOJ]);
  assert(JSON.stringify(j.nonSpeech.map((w) => w.text)) === JSON.stringify(['[BLANK_AUDIO]', '(音楽)']), `nonSpeech: ${JSON.stringify(j.nonSpeech)}`);
  assert(j.speech.length === 2, `話している区間は 0〜2 と 8〜20 の 2 つのはずです: ${JSON.stringify(j.speech)}`);
  near(j.speech[1].start, 8, 1e-9, '2 つ目の始まり');
  const s = azJson(['subs', WOJ]);
  assert(s.cues.every((c) => !c.text.includes('BLANK') && !c.text.includes('音楽')), `字幕に言葉でないものがあります: ${JSON.stringify(s.cues)}`);
  // -ojf ではトークンに分かれている（" [", "BL", "ANK", "_", "AUDIO", "]"）ので、つないだ後の単語で判定する
  const f = path.join(TMP, 'whisper-ojf-blank.json');
  const tok = (text, from, to) => ({ text, offsets: { from, to }, p: 0.9 });
  fs.writeFileSync(f, JSON.stringify({ transcription: [
    { offsets: { from: 0, to: 1000 }, text: ' Hello there', tokens: [tok(' Hello', 0, 500), tok(' there', 500, 1000)] },
    { offsets: { from: 1000, to: 6000 }, text: ' [BLANK_AUDIO]', tokens: [tok(' [', 1000, 1100), tok('BL', 1100, 1200), tok('ANK', 1200, 1300), tok('_', 1300, 1400), tok('AUDIO', 1400, 5900), tok(']', 5900, 6000)] },
    { offsets: { from: 6000, to: 8000 }, text: ' (音楽) [Music playing]', tokens: [tok(' (', 6000, 6100), tok('音', 6100, 6500), tok('楽', 6500, 6900), tok(')', 6900, 7000), tok(' [', 7000, 7100), tok('Music', 7100, 7500), tok(' playing', 7500, 7900), tok(']', 7900, 8000)] },
    { offsets: { from: 8000, to: 9000 }, text: ' Bye', tokens: [tok(' Bye', 8000, 9000)] },
  ] }));
  const g = azJson(['words', f]);
  assert(JSON.stringify(g.words.map((w) => w.text)) === JSON.stringify(['Hello', 'there', 'Bye']), `words: ${JSON.stringify(g.words.map((w) => w.text))}`);
  assert(JSON.stringify(g.nonSpeech.map((w) => w.text)) === JSON.stringify(['[BLANK_AUDIO]', '(音楽)', '[Music playing]']), `nonSpeech: ${JSON.stringify(g.nonSpeech.map((w) => w.text))}`);
  assert(g.speech.length === 2, `話している区間は 2 つのはずです: ${JSON.stringify(g.speech)}`);
  assert(g.warnings.length === 0, `tokens があれば警告はないはずです: ${JSON.stringify(g.warnings)}`);
});
test('-oj（単語ごとの時刻なし）の長い区切りを、文字の境目で折り返して字幕を分ける', () => {
  const j = azJson(['words', WOJ]);
  assert(j.warnings.length === 1 && j.warnings[0].includes('-ojf'), `-oj だけなら警告が出るはずです: ${JSON.stringify(j.warnings)}`);
  const s = azJson(['subs', WOJ, '--max-width', '32', '--max-lines', '2']);
  assert(s.warnings.length === 1, `subs にも警告: ${JSON.stringify(s.warnings)}`);
  const wid = (t) => [...t].reduce((a, ch) => a + (ch.codePointAt(0) >= 0x1100 ? 2 : 1), 0);
  for (const c of s.cues) {
    const lines = c.text.split('\n');
    assert(lines.length <= 2 && lines.every((l) => wid(l) <= 32), `幅 32・2 行を超えています: ${JSON.stringify(c)}`);
  }
  const longCues = s.cues.filter((c) => c.start >= 8 - 1e-9);
  assert(longCues.length >= 3, `長い区切りは 3 つ以上の字幕に分かれるはずです: ${JSON.stringify(longCues)}`);
  assert(longCues.map((c) => c.text.replace(/\n/g, '')).join('') === LONG_JA, `文字が欠けたか増えました: ${JSON.stringify(longCues.map((c) => c.text))}`);
  near(longCues[0].start, 8, 1e-9, '最初の字幕の始まり');
  near(longCues[longCues.length - 1].end, 20, 1e-9, '最後の字幕の終わり');
  for (let i = 1; i < longCues.length; i++) assert(longCues[i].start >= longCues[i - 1].end - 1e-9, `時刻が重なっています: ${JSON.stringify(longCues)}`);
  // 英語の長い区切りは空白で分ける（語の途中で折らない）
  const e = path.join(TMP, 'whisper-oj-en.json');
  fs.writeFileSync(e, JSON.stringify({ transcription: [{ offsets: { from: 0, to: 6000 }, text: ' This is a fairly long sentence that should be wrapped at the spaces between words.' }] }));
  const k = azJson(['subs', e, '--max-width', '20']);
  const words = k.cues.flatMap((c) => c.text.split(/[\n ]/));
  assert(words.join(' ') === 'This is a fairly long sentence that should be wrapped at the spaces between words.', `語の途中で折っています: ${JSON.stringify(k.cues)}`);
});
test('有限でない・負の時刻の単語は飛ばして警告', () => {
  const f = path.join(TMP, 'bad-times.json');
  fs.writeFileSync(f, '{"words":[{"word":"a","start":1e400,"end":2},{"word":"b","start":-1,"end":0.5},{"word":"c","start":1,"end":1.5}]}');
  const r = az(['words', f, '--json']);
  const j = JSON.parse(r.out);
  assert(JSON.stringify(j.words.map((w) => w.text)) === JSON.stringify(['c']), `words: ${JSON.stringify(j.words)}`);
  assert(j.warnings.some((w) => w.includes('2 個')), `警告: ${JSON.stringify(j.warnings)}`);
  assert(!r.out.includes('9223372036854775'), `飽和した数が出ています: ${r.out}`);
  const s = az(['subs', f]);
  assert(!s.out.includes('153722867280912'), `字幕の時刻がでたらめです: ${s.out}`);
});

console.log('subs');
test('字幕の区切りと折り返し、--offset', () => {
  const j = azJson(['subs', WCPP, '--max-width', '12']);
  assert(j.cues.length === 3, `字幕は 3 つのはずです: ${JSON.stringify(j.cues)}`);
  assert(j.cues[0].text === 'Hello world,\nthis is', `1 つ目: ${JSON.stringify(j.cues[0].text)}`);
  assert(j.cues[2].text === 'こんにちは。', `日本語は空白なしでつなぐはずです: ${JSON.stringify(j.cues[2].text)}`);
  const k = azJson(['subs', WSEG, '--offset', '10']);
  near(k.cues[0].start, 10, 1e-9, 'offset');
  assert(k.cues[0].text === '今日は晴れです。', `日本語の字幕: ${JSON.stringify(k.cues[0].text)}`);
});
test('SRT を書く', () => {
  const srt = path.join(TMP, 'out.srt');
  azJson(['subs', WCPP, '--srt', srt]);
  const s = fs.readFileSync(srt, 'utf8');
  assert(s.startsWith('1\n00:00:00,000 --> 00:00:01,500\nHello world, this is\n\n2\n00:00:02,500 --> 00:00:04,500\n'), `SRT の中身:\n${s}`);
});


// ---- まとめ ----
if (!KEEP) fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${passed} 個が通りました${skipped ? `、${skipped} 個を飛ばしました` : ''}${failures.length ? `、${failures.length} 個が落ちました` : ''}`);
process.exit(failures.length ? 1 : 0);
