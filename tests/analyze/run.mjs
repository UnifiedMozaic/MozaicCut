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

// s16le ステレオ 48 kHz。segs: [[秒, 'tone'|'quiet'|'noise']]
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

console.log('suggest');
// プロジェクトとキャッシュ（render.um と同じ置き方: <cache>/clip<i>.y4m、clip<i>.pcm、probe.txt）
const PROJ_DIR = path.join(TMP, 'proj');
const CACHE = path.join(PROJ_DIR, 'cache');
fs.mkdirSync(path.join(PROJ_DIR, 'media'), { recursive: true });
fs.mkdirSync(CACHE, { recursive: true });
const MZC = path.join(PROJ_DIR, 'p.mzc');
fs.writeFileSync(MZC, [
  'project size=64x48 fps=30 rate=48000',
  'video "media/v.mp4" id=clip_a in=0 out=5',
  'audio "media/a.wav" id=voice at=0 dur=5',
  '',
].join('\n'));
fs.writeFileSync(path.join(CACHE, 'probe.txt'), 'media/v.mp4\t5\t1\t0\nmedia/a.wav\t5\t0\t1\n');
fs.copyFileSync(Y4M, path.join(CACHE, 'clip0.y4m'));
fs.writeFileSync(path.join(CACHE, 'clip0.y4m.in'), '0');
fs.copyFileSync(PCM, path.join(CACHE, 'clip1.pcm'));
const WANT_OPS = [
  'split clip_a 4', 'split clip_a 2.5', 'split clip_a 2', 'split clip_a 1',
  'cut 3.15 4.35', 'cut 2 2.5', 'cut 1.35 1.85',
];
test('シーン・黒・無音から操作の提案（適用はしない）', () => {
  const j = azJson(['suggest', MZC, CACHE]);
  assert(j.ok && j.applied === false, '提案に失敗しました');
  assert(JSON.stringify(j.ops) === JSON.stringify(WANT_OPS), `操作:\n  ${j.ops.join('\n  ')}\nのはずは:\n  ${WANT_OPS.join('\n  ')}`);
  assert(j.proposals.every((p) => typeof p.reason === 'string' && p.reason.length > 0), '理由（日本語の文）がありません');
  const kinds = j.proposals.map((p) => p.kind).join(',');
  assert(kinds === 'scene,scene,scene,scene,silence,black,silence', `種類: ${kinds}`);
  near(j.proposals[4].start, 3.15, 1e-9, '無音の cut の始まり（余白 0.15 秒）');
  assert(fs.readFileSync(MZC, 'utf8').includes('out=5'), 'プロジェクトを書き換えてはいけません');
});
test('--freeze で止まったコマも切る提案、--no-scenes / --no-silence', () => {
  const j = azJson(['suggest', MZC, CACHE, '--freeze', '--no-scenes', '--no-silence']);
  assert(JSON.stringify(j.ops) === JSON.stringify(['cut 2 4']), `操作: ${JSON.stringify(j.ops)}`);
});
test('書き起こしから言葉のない区間と字幕（--transcript と --subtitles）', () => {
  const j = azJson(['suggest', MZC, CACHE, '--no-scenes', '--no-black', '--no-silence', '--transcript', `voice=${WCPP}`, '--subtitles']);
  const adds = j.ops.filter((o) => o.startsWith('add text'));
  // 3 つ目（6〜7 秒）はクリップ（0〜5 秒）の外なので出さない
  assert(adds.length === 2, `字幕の add は 2 つのはずです: ${JSON.stringify(j.ops)}`);
  assert(adds[0].startsWith('add text "Hello world, this is" id=sub_1 at=0 dur=1.5 track=1'), `1 つ目: ${adds[0]}`);
  const cuts = j.ops.filter((o) => o.startsWith('cut'));
  // 言葉がない: 1.5〜2.5（1 秒）、4.5〜5（終わりに接する。0.5 秒は --speech-gap 1 より短い）
  assert(JSON.stringify(cuts) === JSON.stringify(['cut 1.65 2.35']), `cut: ${JSON.stringify(cuts)}`);
  const k = azJson(['suggest', MZC, CACHE, '--no-scenes', '--no-black', '--no-silence', '--transcript', `voice=${WCPP}@1`]);
  assert(JSON.stringify(k.ops) === JSON.stringify(['cut 2.65 3.35', 'cut 0 0.85']), `@1 で 1 秒ずらした cut: ${JSON.stringify(k.ops)}`);
});
test('--ops で op --file に渡せるファイルを書く', () => {
  const opsFile = path.join(TMP, 'ops.txt');
  const r = az(['suggest', MZC, CACHE, '--ops', opsFile]);
  assert(r.code === 0 && r.out.includes('提案 7 個'), `文の出力:\n${r.out}`);
  const lines = fs.readFileSync(opsFile, 'utf8').split('\n').filter((l) => l && !l.startsWith('#'));
  assert(JSON.stringify(lines) === JSON.stringify(WANT_OPS), `ファイルの操作: ${JSON.stringify(lines)}`);
});
test('エンジンで op --dry-run（すべての提案がそのまま適用できる）', () => {
  if (NO_ENGINE) return 'skip';
  const opsFile = path.join(TMP, 'ops-all.txt');
  azJson(['suggest', MZC, CACHE, '--freeze', '--transcript', `voice=${WCPP}`, '--subtitles', '--ops', opsFile]);
  fs.writeFileSync(path.join(PROJ_DIR, 'media', 'v.mp4'), '');
  fs.writeFileSync(path.join(PROJ_DIR, 'media', 'a.wav'), '');
  const before = fs.readFileSync(MZC, 'utf8');
  const r = run(process.execPath, [MOZCUT_MJS, 'op', MZC, '--file', opsFile, '--dry-run', '--json'], { cwd: ROOT });
  let j;
  try {
    j = JSON.parse(r.out);
  } catch {
    fail(`op の出力が JSON ではありません（${r.code}）:\n${r.out.slice(0, 800)}\n${r.err.slice(0, 800)}`);
  }
  const bad = (j.results || []).filter((x) => !x.ok);
  assert(j.ok && bad.length === 0, `適用できない提案があります: ${JSON.stringify(bad).slice(0, 800)}`);
  const nOps = fs.readFileSync(opsFile, 'utf8').split('\n').filter((l) => l && !l.startsWith('#')).length;
  assert(nOps >= 7 && j.results.length === nOps, `提案の数: ${j.results.length}（ファイルには ${nOps}）`);
  assert(j.results.some((x) => x.op === 'add') && j.results.some((x) => x.op === 'split') && j.results.some((x) => x.op === 'cut'),
    `split・add・cut がそろっていません: ${j.results.map((x) => x.op).join(',')}`);
  assert(fs.readFileSync(MZC, 'utf8') === before, '--dry-run でプロジェクトが変わりました');
});

console.log('errors');
test('読めないファイルは 1、使い方の誤りは 2', () => {
  const a = azJson(['video', path.join(TMP, 'none.y4m')], 1);
  assert(a.ok === false && a.error.includes('読めません'), JSON.stringify(a));
  const b = azJson(['audio', PCM, '--bogus'], 2);
  assert(b.ok === false && b.error.includes('--bogus'), JSON.stringify(b));
  const c = azJson(['audio', PCM, '--threshold', 'abc'], 2);
  assert(c.ok === false, JSON.stringify(c));
  const d = azJson(['words', Y4M], 1);
  assert(d.ok === false, JSON.stringify(d));
  const e = azJson(['nosuch'], 2);
  assert(e.ok === false, JSON.stringify(e));
  const notY4m = path.join(TMP, 'x.y4m');
  fs.writeFileSync(notY4m, 'hello\n');
  const f = azJson(['video', notY4m], 1);
  assert(f.error.includes('Y4M'), JSON.stringify(f));
});

console.log('ffmpeg');
function findFfmpeg() {
  const cands = [process.env.FFMPEG, 'ffmpeg'].filter(Boolean);
  for (const c of cands) {
    const r = spawnSync(c, ['-version'], { encoding: 'utf8' });
    if (!r.error && r.status === 0) return c;
  }
  return null;
}
const FFMPEG = findFfmpeg();
test('ffmpeg の lavfi で作った映像（赤 → testsrc2 → 黒 → 青 → mandelbrot）', () => {
  if (!FFMPEG) return 'skip';
  const out = path.join(TMP, 'lavfi.y4m');
  const r = run(FFMPEG, ['-v', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=red:s=160x90:r=30:d=2', '-f', 'lavfi', '-i', 'testsrc2=s=160x90:r=30:d=2',
    '-f', 'lavfi', '-i', 'color=black:s=160x90:r=30:d=1', '-f', 'lavfi', '-i', 'color=0x2040c0:s=160x90:r=30:d=2',
    '-f', 'lavfi', '-i', 'mandelbrot=s=160x90:r=30',
    '-filter_complex', '[4]trim=duration=1,setpts=PTS-STARTPTS[m];[0][1][2][3][m]concat=n=5:v=1:a=0,format=yuv420p',
    '-f', 'yuv4mpegpipe', out]);
  assert(r.code === 0, `ffmpeg が失敗しました: ${r.err}`);
  const j = azJson(['video', out]);
  const ts = j.scenes.map((c) => c.time);
  assert(JSON.stringify(ts) === JSON.stringify([2, 4, 5, 7]), `切れ目: ${JSON.stringify(ts)}`);
  assert(j.black.length === 1 && j.black[0].start === 4 && j.black[0].end === 5, `黒: ${JSON.stringify(j.black)}`);
  assert(JSON.stringify(j.freeze.map((s) => [s.start, s.end])) === JSON.stringify([[0, 2], [5, 7]]), `止まり: ${JSON.stringify(j.freeze)}`);
});
test('ffmpeg の lavfi で作った音（無音を挟む）', () => {
  if (!FFMPEG) return 'skip';
  const out = path.join(TMP, 'lavfi.pcm');
  const r = run(FFMPEG, ['-v', 'error', '-y',
    '-f', 'lavfi', '-i', 'sine=f=440:r=48000:d=1.5', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono',
    '-f', 'lavfi', '-i', 'sine=f=660:r=48000:d=2', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono',
    '-f', 'lavfi', '-i', 'sine=f=880:r=48000:d=1',
    '-filter_complex', '[1]atrim=duration=1[s1];[3]atrim=duration=1.5[s2];[0][s1][2][s2][4]concat=n=5:v=0:a=1',
    '-f', 's16le', '-ar', '48000', '-ac', '2', out]);
  assert(r.code === 0, `ffmpeg が失敗しました: ${r.err}`);
  const j = azJson(['audio', out]);
  assert(j.silence.length === 2, `無音: ${JSON.stringify(j.silence)}`);
  near(j.silence[0].start, 1.5, 0.011, '1 つ目の始まり');
  near(j.silence[0].end, 2.5, 0.011, '1 つ目の終わり');
  near(j.silence[1].start, 4.5, 0.011, '2 つ目の始まり');
  near(j.silence[1].end, 6.0, 0.011, '2 つ目の終わり');
});

console.log('gpu');
// UM_WGPU_HOME（wgpu-native の場所）があれば、UM_WGPU=1 でビルドしたものが CPU と同じ JSON を出すこと
test('kernel を GPU（wgpu）で実行しても CPU と同じ結果', () => {
  const home = process.env.UM_WGPU_HOME;
  const um = umHome();
  if (!home || !um) return 'skip';
  const gpuExe = path.join(TMP, 'mozcut-analyze-gpu' + EXT);
  const b = spawnSync(process.execPath, [path.join(um, 'src', 'cli.ts'), 'build', path.join(ROOT, 'src', 'azmain.um'), '--target', 'host', '-o', gpuExe],
    { encoding: 'utf8', env: { ...process.env, UM_WGPU: '1' }, maxBuffer: 1 << 26 });
  assert(b.status === 0, `UM_WGPU=1 のビルドに失敗しました:\n${(b.stdout + b.stderr).slice(-1500)}`);
  for (const args of [['video', Y4M, '--frames'], ['audio', PCM, '--levels']]) {
    const c = az([...args, '--json']);
    const g = run(gpuExe, [...args, '--json'], { cwd: TMP });
    assert(g.code === 0 && g.out === c.out, `${args[0]} の結果が CPU と違います:\nCPU ${c.out.slice(0, 300)}\nGPU ${g.out.slice(0, 300)}\n${g.err}`);
  }
});

// ---- まとめ ----
if (!KEEP) fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${passed} 個が通りました${skipped ? `、${skipped} 個を飛ばしました` : ''}${failures.length ? `、${failures.length} 個が落ちました` : ''}`);
process.exit(failures.length ? 1 : 0);
