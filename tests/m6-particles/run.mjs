#!/usr/bin/env node
// パーティクル（src/m6_particles/particles.um）の試験。node tests/m6-particles/run.mjs で流す。npm の依存はない。
//
// 1. src/particles_test.um をビルドする（UM_WGPU_HOME があるか、既定の場所に wgpu-native があれば UM_WGPU=1 で）。
// 2. 7 つの場面を CPU（UM_GPU=0）と GPU（UM_GPU_THRESHOLD=1。全部の kernel を GPU で）で描き、
//    状態の検算値と足し込み（整数）の検算値が完全に同じことを確かめる。PNG を読んで、粒が描けていることも確かめる。
// 3. シーク（頭から・1 コマずつ・戻ってから・1 刻みずつ）で同じ状態になり、戻るシークが区切りの保存を使うこと。
// 4. 設定の誤りの診断（code と key）。
// 5. 指摘を直したことの確かめ（trim で粒の数が変わる・sprite の読み直し・fps が steps を割り切らないときの動き・
//    prewarm と burst / emit.dur・1 画素の和のあふれ・加算の層・位置の書き方・クリップの長さの警告・長いシーク・区切りの予算）。
//
// オプション:
//   --keep        作業用のフォルダを消さずに残す（PNG を見るとき）
//   --perf        1920x1080 の 1 コマの時間も測って出す（CPU と GPU）
//   --dx12        GPU の試験を Direct3D 12 でも流す（Windows）
//   -v            落ちたときに詳しく出す
//
// 環境変数: UM_ROOT（UnifiedMozaic の場所。既定は ../UnifiedMozaic）、UM_WGPU_HOME（wgpu-native の場所）。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const argv = process.argv.slice(2);
const KEEP = argv.includes('--keep');
const PERF = argv.includes('--perf');
const DX12 = argv.includes('--dx12');
const VERBOSE = argv.includes('-v');

function findUmRoot() {
  const cands = [process.env.UM_ROOT, path.join(ROOT, '..', 'UnifiedMozaic'), path.join(ROOT, '..', '..', 'UnifiedMozaic'), path.join(os.homedir(), 'UnifiedMozaic')];
  for (const c of cands) {
    if (c && fs.existsSync(path.join(c, 'src', 'cli.ts'))) return c;
  }
  console.error('UnifiedMozaic が見つかりません（UM_ROOT で場所を指定してください）');
  process.exit(2);
}
function findWgpuHome() {
  const cands = [process.env.UM_WGPU_HOME, path.join(os.homedir(), 'wgpu-native', 'v29.0.1.1')];
  for (const c of cands) {
    if (c && fs.existsSync(path.join(c, 'include', 'webgpu', 'webgpu.h'))) return c;
  }
  return null;
}

const UM = findUmRoot();
const WGPU = findWgpuHome();
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mozcut-m6-particles-'));
const EXE = path.join(TMP, 'particles_test' + (process.platform === 'win32' ? '.exe' : ''));
let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    failures.push(name);
    console.log(`  NG  ${name}: ${e.message}`);
    if (VERBOSE && e.stack) console.log(e.stack);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function run(args, env) {
  const r = spawnSync(EXE, args, { encoding: 'utf8', env: { ...process.env, ...env }, cwd: TMP, maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) {
    throw new Error(`${path.basename(EXE)} ${args.join(' ')} が終了コード ${r.status} で終わりました\n${r.stdout}\n${r.stderr}`);
  }
  return r;
}

// 「名前 key=value ...」の行を { kind, name, kv } に
function parseLines(text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const words = line.split(' ');
    const kv = {};
    for (const w of words.slice(1)) {
      const i = w.indexOf('=');
      if (i > 0) kv[w.slice(0, i)] = w.slice(i + 1);
    }
    out.push({ kind: words[0], name: words[1], kv, line });
  }
  return out;
}

// 圧縮しない PNG（ptWritePng の形）を読んで、画素の明るさの平均と、明るい画素の割合を返す
function pngStats(file) {
  const buf = fs.readFileSync(file);
  assert(buf.slice(1, 4).toString() === 'PNG', `${file} は PNG ではありません`);
  let pos = 8;
  let w = 0;
  let h = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.slice(pos + 4, pos + 8).toString();
    const data = buf.slice(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
    } else if (type === 'IDAT') {
      idat.push(data);
    }
    pos += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  assert(raw.length === h * (w * 3 + 1), `${file} の画素の数が合いません`);
  let sum = 0;
  let bright = 0;
  for (let y = 0; y < h; y++) {
    const row = y * (w * 3 + 1) + 1;
    for (let x = 0; x < w; x++) {
      const v = (raw[row + x * 3] + raw[row + x * 3 + 1] + raw[row + x * 3 + 2]) / 3;
      sum += v;
      if (v > 64) bright++;
    }
  }
  return { w, h, mean: sum / (w * h), brightFrac: bright / (w * h) };
}

console.log('パーティクルの試験');
console.log(`  UnifiedMozaic: ${UM}`);
console.log(`  wgpu-native: ${WGPU ?? '（見つからないので CPU だけで試す）'}`);
console.log(`  作業用: ${TMP}`);

// ---- ビルド ----
{
  const env = { ...process.env };
  if (WGPU) {
    env.UM_WGPU = '1';
    env.UM_WGPU_HOME = WGPU;
  }
  const r = spawnSync(process.execPath, [path.join(UM, 'src', 'cli.ts'), 'build', path.join(ROOT, 'src', 'particles_test.um'), '--target', 'host', '-o', EXE], { encoding: 'utf8', env });
  if (r.status !== 0) {
    console.error(`ビルドに失敗しました\n${r.stdout}\n${r.stderr}`);
    process.exit(1);
  }
}

const CPU = { UM_GPU: '0' };
const GPU = { UM_GPU_THRESHOLD: '1' };

// ---- 場面 ----
console.log('場面（CPU と GPU で同じ結果）');
fs.mkdirSync(path.join(TMP, 'cpu'));
fs.mkdirSync(path.join(TMP, 'gpu'));
const cpuScenes = run(['scenes', path.join(TMP, 'cpu')], CPU).stdout;
const scenes = parseLines(cpuScenes).filter((l) => l.kind === 'scene');
// 場面ごとに、生きている粒の数の下限と、絵の明るさ（平均の下限）
const EXPECT = {
  fountain: { alive: 600, mean: 2 },
  burst: { alive: 1500, mean: 2 },
  smoke: { alive: 250, mean: 12 },
  snow: { alive: 1000, mean: 4 },
  layer: { alive: 4000, mean: 4 },
  sprites: { alive: 50, mean: 15 },
  ring: { alive: 300, mean: 6 },
};
check('7 つの場面が描ける', () => {
  assert(scenes.length === 7, `場面の数が ${scenes.length} です\n${cpuScenes}`);
  assert(!cpuScenes.includes('spec-error'), `設定の誤りがあります\n${cpuScenes}`);
});
for (const s of scenes) {
  check(`場面 ${s.name}: 粒の数と絵`, () => {
    const e = EXPECT[s.name];
    assert(e, `知らない場面です: ${s.name}`);
    const alive = Number(s.kv.alive);
    const cap = Number(s.kv.cap);
    assert(alive >= e.alive && alive <= cap, `生きている粒が ${alive} 個（${e.alive} 以上、${cap} 以下のはず）`);
    const st = pngStats(path.join(TMP, 'cpu', `${s.name}.png`));
    assert(st.w === 640 && st.h === 360, `大きさが ${st.w}x${st.h}`);
    // 背景だけなら平均は 10 前後（暗い階調）。粒があれば明るくなる
    const bg = 12;
    assert(st.mean >= bg + e.mean || st.brightFrac > 0.01, `絵が暗すぎます（平均 ${st.mean.toFixed(2)}、明るい画素 ${(st.brightFrac * 100).toFixed(2)}%）`);
  });
}

function compareGpu(label, env) {
  const out = run(['scenes', path.join(TMP, 'gpu')], env).stdout;
  check(`GPU（${label}）の状態と足し込みが CPU と完全に同じ`, () => {
    const g = parseLines(out).filter((l) => l.kind === 'scene');
    assert(g.length === scenes.length, `場面の数が違います（${g.length}）`);
    for (let i = 0; i < g.length; i++) {
      assert(g[i].line === scenes[i].line, `違いがあります\n  CPU: ${scenes[i].line}\n  GPU: ${g[i].line}`);
    }
  });
  check(`GPU（${label}）の PNG が CPU と同じ`, () => {
    for (const s of scenes) {
      const a = fs.readFileSync(path.join(TMP, 'cpu', `${s.name}.png`));
      const b = fs.readFileSync(path.join(TMP, 'gpu', `${s.name}.png`));
      assert(a.equals(b), `${s.name}.png が違います`);
    }
  });
}
if (WGPU) {
  const tr = spawnSync(EXE, ['seek'], { encoding: 'utf8', env: { ...process.env, ...GPU, UM_GPU_TRACE: '1' }, cwd: TMP });
  check('GPU で実行している（UM_GPU_TRACE に wgpu の dispatch が出る）', () => {
    assert(/wgpu: dispatch/.test(tr.stderr), `GPU の dispatch が見えません\n${tr.stderr.slice(0, 2000)}`);
  });
  compareGpu('既定', GPU);
  if (DX12) compareGpu('Direct3D 12', { ...GPU, UM_WGPU_BACKEND: 'dx12' });
} else {
  console.log('  （wgpu-native がないので、GPU との比較は飛ばします）');
}

// ---- シーク ----
console.log('シーク');
for (const [label, env] of WGPU ? [['CPU', CPU], ['GPU', GPU]] : [['CPU', CPU]]) {
  const lines = parseLines(run(['seek'], env).stdout);
  const by = Object.fromEntries(lines.map((l) => [l.name, l.kv]));
  check(`${label}: どの道筋でも同じ状態`, () => {
    for (const k of ['frames', 'frames24', 'back', 'steps']) {
      assert(by[k] && by[k].state === by.direct.state, `${k} の状態 ${by[k]?.state} が頭からの ${by.direct.state} と違います`);
      assert(by[k].step === by.direct.step, `${k} の刻み ${by[k].step} が ${by.direct.step} と違います`);
    }
    assert(by.direct.step === '258', `4.3 秒は 258 刻みのはず（${by.direct.step}）`);
  });
  check(`${label}: 1 コマずつ進めても計算し直さない、戻るときは区切りから`, () => {
    assert(by.frames.ran === by.direct.ran, `1 コマずつで ${by.frames.ran} 刻み計算しました（${by.direct.ran} のはず）`);
    assert(by.frames24.ran === by.direct.ran, `24 コマ / 秒で 1 コマずつ進めて ${by.frames24.ran} 刻み計算しました（${by.direct.ran} のはず）`);
    assert(Number(by.back.checkpoints) > 0, '区切りが保存されていません');
    assert(Number(by.back.ran) < 60, `戻るシークで ${by.back.ran} 刻み計算しました（区切りの間隔 60 未満のはず）`);
  });
}

// ---- 描画の流れから使うキャッシュ ----
console.log('キャッシュ（render.um から使う形）');
{
  const outs = [];
  for (const [label, env] of WGPU ? [['CPU', CPU], ['GPU', GPU]] : [['CPU', CPU]]) {
    const out = run(['cache', TMP], env).stdout;
    outs.push(out);
    const by = Object.fromEntries(parseLines(out).map((l) => [l.name.includes('=') ? 'main' : l.name, l.kv]));
    const main = parseLines(out)[0].kv;
    check(`${label}: 2 つのクリップをコマごとに描いても、単独で計算したのと同じ状態`, () => {
      assert(main.a === main.direct, `キャッシュ ${main.a} と単独 ${main.direct} が違います`);
      assert(main.ran === '120', `2 秒で ${main.ran} 刻み（120 のはず）`);
    });
    check(`${label}: 色だけ変えても計算し直さず、重力を変えると作り直す`, () => {
      assert(by.recolor.ran === '0', `色を変えて ${by.recolor.ran} 刻み計算しました`);
      assert(by.regravity.ran === '120', `重力を変えて ${by.regravity.ran} 刻み（作り直して 120 のはず）`);
    });
    const st = pngStats(path.join(TMP, 'cache.png'));
    check(`${label}: キャッシュで描いた絵に粒がある`, () => {
      assert(st.mean > 3, `平均の明るさ ${st.mean.toFixed(2)}`);
    });
  }
  if (outs.length === 2) {
    check('キャッシュで描いたキャンバスが CPU と GPU で同じ', () => {
      assert(outs[0] === outs[1], `違いがあります
${outs[0]}
${outs[1]}`);
    });
  }
}

// ---- 診断 ----
console.log('診断');
{
  const out = run(['diag'], CPU).stdout;
  const diags = parseLines(out).filter((l) => l.kind === 'diag' && l.kv.code);
  const codes = (line) => diags.filter((d) => d.kv.line === String(line)).map((d) => `${d.kv.code}:${d.kv.key}`);
  check('誤りの code と key', () => {
    const want = [
      ['bad-enum:emit', 'out-of-range:rate', 'bad-number:speed'],
      ['unknown-key:sizee', 'bad-color:color', 'missing-source:layer', 'missing-source:sprite'],
      ['bad-number:seed', 'out-of-range:steps', 'out-of-range:spread', 'bad-enum:dir.mode', 'bad-enum:emit.edge', 'bad-number:life'],
      [],
    ];
    for (let i = 0; i < want.length; i++) {
      assert(JSON.stringify(codes(i)) === JSON.stringify(want[i]), `${i} 行目: ${JSON.stringify(codes(i))}（${JSON.stringify(want[i])} のはず）\n${out}`);
    }
  });
  check('近い名前の hint（suggest の形）', () => {
    assert(out.includes("hint='size' のことですか？"), 'sizee に size を勧めていません');
    assert(out.includes("hint='circle' のことですか？"), 'cirle に circle を勧めていません');
  });
  check('説明の文とキーの表', () => {
    assert(out.includes('describe line=3 箱から 1 秒に 100 個、始まりに 10 個'), `説明の文が違います\n${out}`);
    const m = out.match(/keys count=(\d+)/);
    assert(m && Number(m[1]) >= 40, 'キーの表が短すぎます');
  });
}

// ---- 指摘を直したことの確かめ ----
console.log('指摘を直したこと');
{
  const outs = [];
  for (const [label, env] of WGPU ? [['CPU', CPU], ['GPU', GPU]] : [['CPU', CPU]]) {
    const out = run(['fixes', TMP], env).stdout;
    outs.push(out);
    const lines = parseLines(out);
    const one = (kind, name) => lines.find((l) => l.kind === kind && (name === undefined || l.name === name || l.kv.rate === name))?.kv;
    const all = (kind) => lines.filter((l) => l.kind === kind);
    check(`${label}: trim で長くすると粒の数を決め直し、新しく作ったのと同じ状態`, () => {
      const t = lines.find((l) => l.kind === 'trim').kv;
      assert(Number(t.short_cap) < Number(t.long_cap), `cap が ${t.short_cap} → ${t.long_cap}`);
      assert(t.long_cap === t.direct_cap, `cap ${t.long_cap} が新しく作った ${t.direct_cap} と違います`);
      assert(t.cache === t.direct, `状態 ${t.cache} が新しく作った ${t.direct} と違います`);
      assert(t.alive === '2000', `生きている粒が ${t.alive}（2000 のはず）`);
      const t2 = lines.find((l) => l.kind === 'trim2').kv;
      assert(t2.ran === '0', `粒の数が変わらない trim で ${t2.ran} 刻み計算し直しました`);
    });
    check(`${label}: sprite= の名前・印が変われば読み直し、ring から戻しても渡した画像で描く`, () => {
      const s = lines.find((l) => l.kind === 'sprite').kv;
      const want = { need0: 'true', need1: 'false', need_path: 'true', need_stamp: 'true', need_after_ring: 'false', same_after_ring: 'true', ring_differs: 'true' };
      for (const [k, v] of Object.entries(want)) assert(s[k] === v, `${k}=${s[k]}（${v} のはず）`);
    });
    check(`${label}: fps が steps を割り切らなくても 1 コマの動きが揃う（24 / 25 / 120 コマ、steps=10）`, () => {
      const f = all('fps');
      assert(f.length === 4, `fps の行が ${f.length}`);
      for (const l of f) assert(Number(l.kv.max_dev_px) < 0.1, `${l.kv.rate} コマ / 秒: 1 コマの動きのずれが ${l.kv.max_dev_px} px（期待 ${l.kv.expect_px} px）`);
    });
    check(`${label}: burst と emit.dur はクリップの始まりから数える（prewarm があっても）`, () => {
      const p = Object.fromEntries(all('prewarm').map((l) => [l.name, Number(l.kv.alive)]));
      assert(p.burst_pre === 500 && p.burst_nopre === 500, `burst: prewarm あり ${p.burst_pre} / なし ${p.burst_nopre}（どちらも 500）`);
      assert(p.burst_pre_late === 0, `寿命の後に ${p.burst_pre_late} 個残っています`);
      assert(p.emitdur_pre >= 190 && p.emitdur_pre <= 210, `prewarm と emit.dur で ${p.emitdur_pre} 個（約 200）`);
      assert(p.emitdur_pre_mid >= 45 && p.emitdur_pre_mid <= 55, `emit.dur の中で ${p.emitdur_pre_mid} 個（約 50）`);
      assert(p.emitdur_pre_after === 0, `emit.dur の後に ${p.emitdur_pre_after} 個`);
      assert(p.burst_rate_pre >= 490 && p.burst_rate_pre <= 510, `burst と rate で ${p.burst_rate_pre} 個（約 500）`);
    });
    check(`${label}: 1 画素の和が u32 を超えても色と不透明度が正しい`, () => {
      const o = Object.fromEntries(all('overflow').map((l) => [l.name, l.kv]));
      assert(Number(o.over.a_sum) > 262144 && Number(o.add.a_sum) > 262144, `和が小さい（over ${o.over.a_sum}、add ${o.add.a_sum}）`);
      assert(o.over.r === '1' && o.over.g === '0' && o.over.b === '0', `重ねの色が ${o.over.r},${o.over.g},${o.over.b}（赤のはず）`);
      assert(o.add.r === '1' && Number(o.add.g) > 0.39 && Number(o.add.g) < 0.41, `加算の色が ${o.add.r},${o.add.g},${o.add.b}`);
      assert(o.add.a_sum === '300000', `加算の A の和が ${o.add.a_sum}（300000 のはず）`);
    });
    check(`${label}: blend=add の層を ptAddLayer で合成すると直接の加算と同じ（重ねで合成すると違う）`, () => {
      const a = lines.find((l) => l.kind === 'addlayer').kv;
      assert(Number(a.max_diff_add) < 0.001, `加算の層との差 ${a.max_diff_add}`);
      assert(Number(a.max_diff_over) > 0.05, `重ねで合成しても差が ${a.max_diff_over}（比べの試験になっていない）`);
    });
    check(`${label}: 位置の書き方（-100px は画面の外、-100 は右端から）と color.end=00000000、= のない emit.edge`, () => {
      const p = lines.find((l) => l.kind === 'pos' && l.kv.x !== undefined).kv;
      const want = { x: '-100', y: '-20', x2: '540', y2: '20', color_end: '0', edge: '1', diags: '0' };
      for (const [k, v] of Object.entries(want)) assert(p[k] === v, `${k}=${p[k]}（${v} のはず）`);
      assert(out.includes('pos color_end_default=true'), 'color.end を省いたときに color になっていません');
    });
    check(`${label}: prewarm × steps の上限、= のない語、クリップの長さの警告`, () => {
      const d = all('diag2').filter((l) => l.kv.code).map((l) => `${l.kv.code}:${l.kv.severity}:${l.kv.key}`);
      assert(JSON.stringify(d) === JSON.stringify(['unexpected-value:error:blur', 'out-of-range:error:prewarm']), JSON.stringify(d));
      assert(out.includes('diag2 prewarm=36 blend=1'), '上限で prewarm を切り詰めていないか、blend=normal が over になっていません');
      const c = all('clipdiag').filter((l) => l.kv.code).map((l) => `${l.kv.code}:${l.kv.severity}:${l.kv.key}`);
      assert(JSON.stringify(c) === JSON.stringify(['out-of-range:warning:rate', 'out-of-range:warning:rate']), JSON.stringify(c));
      assert(out.includes('clipdiag count=2'), '警告の数が違います');
    });
  }
  if (outs.length === 2) {
    check('指摘の確かめの結果が CPU と GPU で同じ（あふれの足し込みの検算値を含む）', () => {
      assert(outs[0] === outs[1], `違いがあります
${outs[0]}
${outs[1]}`);
    });
  }
  const bs = [];
  for (const [label, env] of WGPU ? [['CPU', CPU], ['GPU', GPU]] : [['CPU', CPU]]) {
    const out = run(['bigseek'], env).stdout;
    const lines = parseLines(out);
    const b = lines.find((l) => l.kind === 'bigseek').kv;
    const g = lines.find((l) => l.kind === 'budget').kv;
    bs.push(b);
    console.log(`  （${label}: 300 秒の位置へ初めてシーク ${b.seek300_ms} ms（${b.steps300} 刻み）、prewarm=36 steps=1000 ${b.prewarm36k_ms} ms（${b.steps36k} 刻み）、区切り ${g.checkpoint_mb} MB）`);
    check(`${label}: まとめた dispatch で進めても 1 刻みずつと同じ、区切りは全体で 512MB まで`, () => {
      assert(b.batch_same === 'true', 'まとめた dispatch の結果が違います');
      assert(Number(g.checkpoint_mb) <= 512 && Number(g.checkpoint_mb) > 100, `区切りが ${g.checkpoint_mb} MB`);
    });
  }
  if (bs.length === 2) {
    check('長いシークの状態が CPU と GPU で同じ', () => {
      assert(bs[0].state === bs[1].state, `${bs[0].state} と ${bs[1].state}`);
    });
  }
}

// ---- 速さ（--perf） ----
if (PERF) {
  console.log('速さ（1920x1080。ms）');
  for (const [label, env] of WGPU ? [['CPU', CPU], ['GPU', GPU]] : [['CPU', CPU]]) {
    for (const l of parseLines(run(['perf', TMP], env).stdout)) {
      console.log(`  ${label} ${l.line.replace(/^perf /, '').replace(/ sink=\w+/, '')}`);
    }
  }
}

if (KEEP) {
  console.log(`作業用のフォルダを残しました: ${TMP}`);
} else {
  fs.rmSync(TMP, { recursive: true, force: true });
}
console.log(`${passed} 件通りました${failures.length ? `、${failures.length} 件落ちました: ${failures.join(' / ')}` : ''}`);
process.exit(failures.length ? 1 : 0);
