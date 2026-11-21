#!/usr/bin/env node
// M6 描画モードとマスク（src/m6_blend/）のテスト。node tests/m6-blend/run.mjs で流す。npm の依存はない。
//
// src/ を一時フォルダに写し、tests/m6-blend/blend_test.um をその中に置いてビルドして試す（本物の src/ は書き換えない）。
//   - 描画モード 15 種 × 表示の値 / 線形の光を、JavaScript で書いた W3C の式（f64）と比べる
//   - 「通常・表示の値・マスクなし」が render.um の blendOver と 1 ビットも違わない
//   - マスク（四角・楕円・パス、ぼかし、広げる・縮める、反転、不透明度、重ね方）とトラックマットの値
//   - .mzc の行の読み取りの診断（code・列・suggest）
//   - 見本の画像（--out <フォルダ> に BMP を残す。付けなければ一時フォルダに書いて消す）
//   - GPU: UM_WGPU_HOME があれば UM_WGPU=1 でもビルドし、1920x1080 の場面（15 モード × 2 つの値 + マスク + マット）を
//     CPU と GPU で描いて、2^-24 の刻みで 1 つも違わないことを確かめる（UM_TEST_WGPU_BACKENDS=vulkan,dx12 で API ごと）
//
// オプション: -v（通ったテストも出す）、--keep（一時フォルダを残す）、--bench（1080p の速さを出す）、--out <dir>
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const EXT = process.platform === 'win32' ? '.exe' : '';
const argv = process.argv.slice(2);
const VERBOSE = argv.includes('-v');
const KEEP = argv.includes('--keep');
const BENCH = argv.includes('--bench');
const outIdx = argv.indexOf('--out');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mozcut-m6-blend-'));
const OUT = outIdx >= 0 ? path.resolve(argv[outIdx + 1]) : TMP;
fs.mkdirSync(OUT, { recursive: true });

function umHome() {
  const cands = [process.env.UM_HOME, path.join(ROOT, '..', 'UnifiedMozaic'), path.join(ROOT, '..', '..', 'UnifiedMozaic'),
    path.join(os.homedir(), 'UnifiedMozaic')].filter(Boolean);
  for (const c of cands) if (fs.existsSync(path.join(c, 'src', 'cli.ts'))) return c;
  console.error('UnifiedMozaic のコンパイラが見つかりません。環境変数 UM_HOME にその場所を設定してください');
  process.exit(2);
}

function build(name, env = {}) {
  const dir = path.join(TMP, 'src');
  if (!fs.existsSync(dir)) fs.cpSync(path.join(ROOT, 'src'), dir, { recursive: true });
  const main = path.join(dir, 'blend_test.um');
  fs.copyFileSync(path.join(HERE, 'blend_test.um'), main);
  const exe = path.join(TMP, name + EXT);
  const r = spawnSync(process.execPath, [path.join(umHome(), 'src', 'cli.ts'), 'build', main, '--target', 'host', '-o', exe],
    { encoding: 'utf8', env: { ...process.env, ...env } });
  if (r.status !== 0) {
    console.error(`ビルドに失敗しました（${name}）\n${r.stdout}${r.stderr}`);
    process.exit(1);
  }
  return exe;
}

function run(exe, args, env = {}) {
  const r = spawnSync(exe, args, { encoding: 'utf8', cwd: TMP, env: { ...process.env, ...env }, maxBuffer: 1 << 26 });
  if (r.status !== 0) throw new Error(`${path.basename(exe)} ${args.join(' ')} が終了コード ${r.status} で終わりました\n${r.stderr}`);
  return r.stdout;
}

let passed = 0;
const failures = [];
function test(name, fn) {
  try {
    fn();
    passed++;
    if (VERBOSE) console.log(`  ok  ${name}`);
  } catch (e) {
    failures.push(name);
    console.log(`  NG  ${name}\n    ${e.message}`);
  }
}
function assert(c, msg) {
  if (!c) throw new Error(msg);
}
function eq(a, e, msg) {
  const x = JSON.stringify(a);
  const y = JSON.stringify(e);
  if (x !== y) throw new Error(`${msg}\n    期待: ${y}\n    実際: ${x}`);
}
function near(a, e, tol, msg) {
  if (!(Math.abs(a - e) <= tol)) throw new Error(`${msg}: 期待 ${e}、実際 ${a}（差 ${Math.abs(a - e)}、許容 ${tol}）`);
}

// ---- JavaScript の参照の式（W3C Compositing and Blending Level 1。輝度の係数は表示の値で 0.3/0.59/0.11、線形の光で BT.709） ----

const MODES = ['normal', 'add', 'multiply', 'screen', 'overlay', 'softlight', 'hardlight', 'lighten', 'darken',
  'difference', 'exclusion', 'hue', 'saturation', 'color', 'luminosity'];
let LW = [0.3, 0.59, 0.11];
const lum = (c) => LW[0] * c[0] + LW[1] * c[1] + LW[2] * c[2];
function clipColor(c) {
  const l = lum(c);
  const n = Math.min(...c);
  const x = Math.max(...c);
  let r = c.slice();
  if (n < 0 && l - n > 0) r = r.map((v) => l + (v - l) * l / (l - n));
  if (x > 1 && x - l > 0) r = r.map((v) => l + (v - l) * (1 - l) / (x - l));
  return r.map((v) => Math.min(Math.max(v, 0), 1));
}
const setLum = (c, l) => clipColor(c.map((v) => v + l - lum(c)));
const sat = (c) => Math.max(...c) - Math.min(...c);
function setSat(c, s) {
  const mx = Math.max(...c);
  const mn = Math.min(...c);
  return mx > mn ? c.map((v) => (v - mn) * s / (mx - mn)) : [0, 0, 0];
}
function sep(m, s, d) {
  switch (m) {
    case 'add': return Math.min(s + d, 1);
    case 'multiply': return s * d;
    case 'screen': return s + d - s * d;
    case 'overlay': return sep('hardlight', d, s);
    case 'hardlight': return s <= 0.5 ? d * 2 * s : sep('screen', 2 * s - 1, d);
    case 'softlight': {
      const D = d <= 0.25 ? ((16 * d - 12) * d + 4) * d : Math.sqrt(d);
      return s <= 0.5 ? d - (1 - 2 * s) * d * (1 - d) : d + (2 * s - 1) * (D - d);
    }
    case 'lighten': return Math.max(s, d);
    case 'darken': return Math.min(s, d);
    case 'difference': return Math.abs(s - d);
    case 'exclusion': return s + d - 2 * s * d;
    default: return s;
  }
}
function blendColor(m, s, d) {
  if (m === 'hue') return setLum(setSat(s, sat(d)), lum(d));
  if (m === 'saturation') return setLum(setSat(d, sat(s)), lum(d));
  if (m === 'color') return setLum(s, lum(d));
  if (m === 'luminosity') return setLum(d, lum(s));
  return [0, 1, 2].map((k) => sep(m, s[k], d[k]));
}
const toLin = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const toDisp = (l) => (l <= 0.0031308 ? l * 12.92 : 1.055 * l ** (1 / 2.4) - 0.055);
// 下 d（rgba）に上 s（rgba）を不透明度 alpha で
function refComposite(m, space, s, d, alpha, opaque = false) {
  const a = s[3] * alpha;
  if (a <= 0) return d.slice();
  LW = space === 'linear' ? [0.2126, 0.7152, 0.0722] : [0.3, 0.59, 0.11];
  let sc = s.slice(0, 3);
  let dc = d.slice(0, 3);
  if (space === 'linear') {
    sc = sc.map(toLin);
    dc = dc.map(toLin);
  }
  const b = blendColor(m, sc, dc);
  let out;
  let ao;
  if (opaque || d[3] >= 1) {
    out = [0, 1, 2].map((k) => dc[k] + (b[k] - dc[k]) * a);
    ao = 1;
  } else {
    const ad = d[3];
    ao = a + ad * (1 - a);
    out = [0, 1, 2].map((k) => (sc[k] * a * (1 - ad) + b[k] * a * ad + dc[k] * ad * (1 - a)) / ao);
  }
  if (space === 'linear') out = out.map((v) => toDisp(Math.min(Math.max(v, 0), 1)));
  return [...out.map((v) => Math.min(Math.max(v, 0), 1)), ao];
}

// ---- テスト ----

const CPU = build('blend_test');
const pixel = (m, space, s, d, alpha, tf = 'srgb', opaque = false) =>
  run(CPU, ['pixel', m, space, tf, ...s.map(String), ...d.map(String), String(alpha), ...(opaque ? ['opaque'] : [])]).trim().split(' ').map(Number);

const PAIRS = [
  [[0.9, 0.3, 0.1, 1], [0.2, 0.5, 0.8, 1]],
  [[0.1, 0.6, 0.95, 1], [0.7, 0.7, 0.2, 1]],
  [[0.5, 0.5, 0.5, 1], [0.05, 0.95, 0.4, 1]],
  [[0.25, 0.0, 1.0, 0.6], [1.0, 0.8, 0.0, 1]],
  [[0.8, 0.2, 0.6, 0.7], [0.3, 0.4, 0.9, 0.5]],   // 下が半透明（source-over）
  [[1, 1, 1, 1], [0.02, 0.01, 0.0, 1]],
];

test('描画モード 15 種 × 表示の値: W3C の式と一致（1e-6）', () => {
  for (const m of MODES) {
    for (const [s, d] of PAIRS) {
      for (const alpha of [1, 0.35]) {
        const got = pixel(m, 'display', s, d, alpha);
        const exp = refComposite(m, 'display', s, d, alpha);
        for (let k = 0; k < 4; k++) near(got[k], exp[k], 1e-6, `${m} s=${s} d=${d} α=${alpha} の ${'rgba'[k]}`);
      }
    }
  }
});

test('描画モード 15 種 × 線形の光（sRGB）: 参照と一致（表の補間で 1e-4 以内）', () => {
  for (const m of MODES) {
    for (const [s, d] of PAIRS) {
      const got = pixel(m, 'linear', s, d, 0.8);
      const exp = refComposite(m, 'linear', s, d, 0.8);
      for (let k = 0; k < 4; k++) near(got[k], exp[k], 1e-4, `${m} s=${s} d=${d} の ${'rgba'[k]}`);
    }
  }
});

test('線形の光: 白 50% を黒に重ねると表示の値 0.7354（sRGB）、表示の値なら 0.5', () => {
  near(pixel('normal', 'linear', [1, 1, 1, 0.5], [0, 0, 0, 1], 1)[0], toDisp(0.5), 1e-5, 'linear');
  near(pixel('normal', 'display', [1, 1, 1, 0.5], [0, 0, 0, 1], 1)[0], 0.5, 0, 'display');
  // BT.1886（γ2.4）と BT.709 の逆 OETF も選べる
  near(pixel('normal', 'linear', [1, 1, 1, 0.5], [0, 0, 0, 1], 1, 'bt1886')[0], 0.5 ** (1 / 2.4), 1e-5, 'bt1886');
  near(pixel('normal', 'linear', [1, 1, 1, 0.5], [0, 0, 0, 1], 1, 'bt709')[0], 1.099 * 0.5 ** 0.45 - 0.099, 1e-5, 'bt709');
});

test('通常・表示の値・マスクなしは render.um の blendOver（d + (s - d) a、f32）と 1 ビットも違わない', () => {
  const f = Math.fround;
  for (const [s, d] of PAIRS.filter(([, d]) => d[3] >= 1)) {
    for (const alpha of [1, 0.35, 0.123]) {
      const got = pixel('normal', 'display', s, d, alpha);
      const a = f(f(s[3]) * f(alpha));
      for (let k = 0; k < 3; k++) {
        const exp = f(f(d[k]) + f(f(f(s[k]) - f(d[k])) * a));
        eq(got[k], exp, `s=${s} d=${d} α=${alpha} の ${'rgb'[k]}`);
      }
    }
  }
});

test('アルファ 0 の画素はキャンバスを変えない（線形の光でも往復の誤差を入れない）', () => {
  eq(pixel('screen', 'linear', [1, 0, 0, 0], [0.3, 0.6, 0.9, 1], 1), [0.30000001192092896, 0.6000000238418579, 0.8999999761581421, 1], '値');
});

test('別名と大文字: Linear-Dodge・lighter（CSS の加算）→ add、Multiply → multiply', () => {
  eq(pixel('Linear-Dodge', 'display', [0.5, 0.5, 0.5, 1], [0.6, 0.2, 0, 1], 1).slice(0, 3), [1, 0.699999988079071, 0.5], 'add');
  eq(pixel('lighter', 'display', [0.5, 0.5, 0.5, 1], [0.6, 0.2, 0, 1], 1).slice(0, 3), [1, 0.699999988079071, 0.5], 'lighter は加算');
  near(pixel('MULTIPLY', 'display', [0.5, 0.5, 0.5, 1], [0.6, 0.2, 0, 1], 1)[0], 0.3, 1e-7, 'multiply');
});

test('色相・カラー（表示の値）の輝度は 0.3/0.59/0.11（After Effects と同じ）、線形の光は BT.709', () => {
  // 青の層の輝度: 表示の値では 0.11。灰色 0.5 の下に「輝度」で青を重ねると、灰色の明るさが 0.11 になる
  const r = pixel('luminosity', 'display', [0, 0, 1, 1], [0.5, 0.5, 0.5, 1], 1);
  for (let k = 0; k < 3; k++) near(r[k], 0.11, 1e-6, `表示の値の ${'rgb'[k]}`);
  // 下が灰色なら「カラー」は上の色を下の輝度に合わせる: 結果の輝度（0.3/0.59/0.11）は 0.5
  const c = pixel('color', 'display', [0.9, 0.2, 0.1, 1], [0.5, 0.5, 0.5, 1], 1);
  near(0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2], 0.5, 1e-6, 'カラーの結果の輝度');
});

test('キャンバスに重ねる（MBL_DST_OPAQUE）: bg が透明でも blendOver と同じ（アルファは 1）', () => {
  // 白 50% を透明な bg に重ねる: blendOver なら (0.5, 0.5, 0.5, 1)
  eq(pixel('normal', 'display', [1, 1, 1, 0.5], [0, 0, 0, 0], 1, 'srgb', true), [0.5, 0.5, 0.5, 1], '通常');
  eq(pixel('normal', 'display', [1, 1, 1, 1], [0, 0, 0, 0.5], 0.5, 'srgb', true), [0.5, 0.5, 0.5, 1], 'bg=#00000080');
  // 立てなければ source-over（作業用の透明な Buffer の式）
  eq(pixel('normal', 'display', [1, 1, 1, 0.5], [0, 0, 0, 0], 1), [1, 1, 1, 0.5], 'source-over');
  // スクリーン・線形でも、下のアルファを見ない式
  for (const m of ['screen', 'overlay', 'hue']) {
    for (const space of ['display', 'linear']) {
      const s = [0.8, 0.3, 0.2, 0.7];
      const d = [0.1, 0.4, 0.6, 0.25];
      const got = pixel(m, space, s, d, 0.9, 'srgb', true);
      const exp = refComposite(m, space, s, d, 0.9, true);
      for (let k = 0; k < 3; k++) near(got[k], exp[k], space === 'linear' ? 1e-4 : 1e-6, `${m} ${space} の ${'rgb'[k]}`);
      eq(got[3], 1, `${m} ${space} のアルファ`);
    }
  }
});

// マスクの値
function maskAt(lines, lw, lh, pts) {
  const f = path.join(TMP, `mask${Math.random().toString(36).slice(2)}.txt`);
  fs.writeFileSync(f, lines.join('\n') + '\n');
  return JSON.parse(run(CPU, ['maskat', f, String(lw), String(lh), ...pts.flat().map(String)]));
}

test('マスク 四角: 内 1、外 0、縁の画素は覆う割合（x=10.5 の縁で 0.5）', () => {
  const r = maskAt(['rect x=10.5 y=10 w=50 h=40'], 100, 100, [[30, 30], [5, 30], [10, 30], [60, 30], [30, 49], [30, 50]]);
  eq(r.used, true, 'used');
  eq(r.values, [1, 0, 0.5, 0.5, 1, 0], '値');
});

test('マスク 四角のぼかし: 縁で 0.5、縁から feather/2 で 0 と 1 に張り付く（smoothstep）', () => {
  const r = maskAt(['rect x=20 y=0 w=60 h=100 feather=20'], 100, 100, [[19, 50], [20, 50], [29, 50], [30, 50], [9, 50], [10, 50], [14, 50]]);
  // 画素 19 の中心は x=19.5（縁 20 の 0.5 外）、t = 0.5 - 0.5/20 = 0.475 → smoothstep
  const ss = (t) => t * t * (3 - 2 * t);
  near(r.values[0], ss(0.475), 1e-6, '縁の外');
  near(r.values[1], ss(0.525), 1e-6, '縁の内');
  eq(r.values[3], 1, '縁から 10.5 内');
  eq(r.values[4], 0, '縁から 10.5 外 → 0');
  near(r.values[5], ss(0.025), 1e-6, '縁から 9.5 外 → まだ 0 でない');
  assert(r.values[6] > r.values[5], `外へ向かって減る: ${r.values}`);
});

test('マスク 広げる・縮める・反転・不透明度', () => {
  const r = maskAt(['rect x=40 y=40 w=20 h=20 expand=5'], 100, 100, [[36, 50], [34, 50]]);
  eq(r.values, [1, 0], '広げる 5');
  const s = maskAt(['rect x=40 y=40 w=20 h=20 expand=-5'], 100, 100, [[44, 50], [45, 50], [50, 50]]);
  eq(s.values, [0, 1, 1], '縮める 5');
  const i = maskAt(['rect x=40 y=40 w=20 h=20 invert opacity=0.5'], 100, 100, [[50, 50], [10, 10]]);
  eq(i.values, [0, 0.5], '反転と不透明度');
});

test('マスク 楕円: 中心 1、外 0、縁の近くで約 0.5', () => {
  // 縁が画素の中心（x = 99.5、y = 0.5）を通るように置く
  const r = maskAt(['ellipse x=-0.5 y=0.5 w=100 h=50'], 100, 100, [[50, 25], [0, 0], [50, 75], [99, 25], [50, 0]]);
  eq([r.values[0], r.values[1], r.values[2]], [1, 0, 0], '中と外');
  near(r.values[3], 0.5, 0.05, '右の縁');
  near(r.values[4], 0.5, 0.05, '上の縁');
});

test('マスク 重ね方: 加算・減算・交差・最初の値（減算から始めると全部が 1）', () => {
  const add = maskAt(['rect x=0 y=0 w=50 h=100', 'rect x=50 y=0 w=50 h=100 mode=add'], 100, 100, [[25, 50], [75, 50]]);
  eq(add.values, [1, 1], '加算');
  const sub = maskAt(['rect x=0 y=0 w=100 h=100', 'ellipse x=25 y=25 w=50 h=50 mode=subtract'], 100, 100, [[50, 50], [5, 5]]);
  eq(sub.values, [0, 1], '減算');
  const inter = maskAt(['rect x=0 y=0 w=60 h=100', 'rect x=40 y=0 w=60 h=100 mode=intersect'], 100, 100, [[20, 50], [50, 50], [80, 50]]);
  eq(inter.values, [0, 1, 0], '交差');
  const first = maskAt(['rect x=40 y=40 w=20 h=20 mode=subtract'], 100, 100, [[10, 10], [50, 50]]);
  eq(first.values, [1, 0], '最初が減算なら 1 から');
  const none = maskAt(['rect x=0 y=0 w=10 h=10 mode=none'], 100, 100, [[5, 5]]);
  eq(none.used, false, 'none だけならマスクなし');
  const inter2 = maskAt(['rect x=0 y=0 w=100 h=100 opacity=0.5', 'rect x=0 y=0 w=100 h=100 mode=intersect opacity=0.5'], 10, 10, [[5, 5]]);
  eq(inter2.values, [0.25], '交差は掛け算');
});

test('マスク パス: 四角のパスは四角のマスクと同じ値。相対（小文字）・H V も同じ', () => {
  const pts = [];
  for (let y = 5; y < 100; y += 7) for (let x = 3; x < 100; x += 6) pts.push([x, y]);
  const rect = maskAt(['rect x=10 y=20 w=70 h=60 feather=8 expand=2'], 100, 100, pts);
  const p1 = maskAt(['path d="M 10 20 L 80 20 L 80 80 L 10 80 Z" feather=8 expand=2'], 100, 100, pts);
  const p2 = maskAt(['path d="m 10 20 h 70 v 60 h -70 z" feather=8 expand=2'], 100, 100, pts);
  for (let k = 0; k < pts.length; k++) {
    near(p1.values[k], rect.values[k], 1e-5, `点 ${pts[k]}（絶対）`);
    near(p2.values[k], rect.values[k], 1e-5, `点 ${pts[k]}（相対）`);
  }
});

test('マスク パス: ベジェ（C / S / Q / T）、穴は非ゼロの巻き数、帯の表で遠い辺を省いても同じ', () => {
  // 円を 4 つの 3 次ベジェで（k = 0.5523）。中心 (50,50) 半径 40
  // 中心 (50.5, 50.5)（縁が画素 90 と 10 の中心を通る）
  const c = 'M 90.5 50.5 C 90.5 72.59 72.59 90.5 50.5 90.5 C 28.41 90.5 10.5 72.59 10.5 50.5 C 10.5 28.41 28.41 10.5 50.5 10.5 C 72.59 10.5 90.5 28.41 90.5 50.5 Z';
  const r = maskAt([`path d="${c}"`], 100, 100, [[50, 50], [5, 5], [90, 50], [50, 90], [50, 10]]);
  eq([r.values[0], r.values[1]], [1, 0], '中と外');
  for (const v of r.values.slice(2)) near(v, 0.5, 0.06, '縁');
  const s = maskAt(['path d="M 10 50 C 10 20 40 10 50 10 S 90 20 90 50 Q 90 90 50 90 T 10 50 Z"'], 100, 100, [[50, 50], [2, 2]]);
  eq(s.values, [1, 0], 'S / T の折り返し');
  // 同じ向きの 2 重の四角（非ゼロなので内側も塗る）と、逆向き（穴）
  const same = maskAt(['path d="M 10 10 L 90 10 L 90 90 L 10 90 Z M 30 30 L 70 30 L 70 70 L 30 70 Z"'], 100, 100, [[50, 50], [20, 20]]);
  eq(same.values, [1, 1], '同じ向き');
  const hole = maskAt(['path d="M 10 10 L 90 10 L 90 90 L 10 90 Z M 30 30 L 30 70 L 70 70 L 70 30 Z"'], 100, 100, [[50, 50], [20, 20]]);
  eq(hole.values, [0, 1], '逆向きは穴');
  // 背の高い層（帯がたくさん）で、ぼかしの広いパス
  const tall = maskAt(['path d="M 10 10 L 90 10 L 50 990 Z" feather=40'], 100, 1000, [[50, 200], [50, 9], [50, 30], [5, 900]]);
  const rect = maskAt(['rect x=0 y=10 w=100 h=1000 feather=40'], 100, 1000, [[50, 9], [50, 30]]);
  eq([tall.values[0], tall.values[3]], [1, 0], '細い三角の中と外');
  near(tall.values[1], rect.values[0], 1e-5, '上の縁のぼかし');
  near(tall.values[2], rect.values[1], 1e-5, '上の縁から 20 内');
});

// .mzc の行の読み取り
function spec(lines) {
  const f = path.join(TMP, `spec${Math.random().toString(36).slice(2)}.txt`);
  fs.writeFileSync(f, lines.join('\n') + '\n');
  return JSON.parse(run(CPU, ['spec', f]));
}

test('読み取り: 描画モード・計算する値・マット。列挙は大文字・小文字を区別しない。blend.tf の既定は bt1886', () => {
  const r = spec(['project blend.space=linear blend.tf=bt1886', 'clip id=a blend=screen', 'clip id=b blend=Hard-Light blend.space=display matte=a matte.type=luma matte.invert']);
  eq(r.diagnostics, [], '診断なし');
  eq(r.items[0], { line: 1, space: 1, tf: 3 }, 'project');
  const d = spec(['project blend.space=Linear', 'clip id=a matte.type=Luma matte=b matte.invert=YES', 'clip id=b', 'mask Rect mode=Subtract units=NORM']);
  eq(d.diagnostics, [], '大文字でも診断なし');
  eq(d.items[0], { line: 1, space: 1, tf: 3 }, 'blend.tf を書かなければ bt1886');
  eq([d.items[1].matteKind, d.items[1].matteInvert], [1, true], 'Luma / YES');
  eq([d.items[3].shape, d.items[3].mode], [0, 1], 'Rect / Subtract');
  eq([r.items[1].mode, r.items[1].space, r.items[1].used], [3, 1, true], 'a（project の線形を受け継ぐ）');
  eq([r.items[2].mode, r.items[2].space, r.items[2].matte, r.items[2].matteKind, r.items[2].matteInvert], [6, 0, 'a', 1, true], 'b');
});

test('読み取り: 誤り（bad-enum と suggest、bad-path の列、unknown-key、out-of-range、bad-mask-shape）', () => {
  const r = spec([
    'clip id=a blend=scren',
    'mask path d="M 0 0 L 10 0 X 5 5 Z"',
    'mask rect fether=4 opacity=2',
    'mask elipse',
    'mask path',
    'mask rect mode=subtrct',
  ]);
  const ds = r.diagnostics.map((d) => [d.code, d.line, d.col, d.suggest]);
  eq(ds, [
    ['bad-enum', 1, 17, 'screen'],
    ['bad-path', 2, 27, ''],
    ['unknown-key', 3, 18, 'feather'],
    ['out-of-range', 3, 28, ''],
    ['bad-mask-shape', 4, 6, 'ellipse'],
    ['bad-path', 5, 6, ''],
    ['bad-enum', 6, 16, 'subtract'],
  ], '診断');
  assert(r.diagnostics[1].message.includes('数として読めません'), r.diagnostics[1].message);
});

test('読み取り: カラー比較（lighter-color）は bad-enum で lighten を推す。opacity の % と 50 は 0.5 を推す', () => {
  const r = spec(['clip id=a blend=lighter-color', 'clip id=b blend=DarkerColor', 'mask rect opacity=50%', 'mask rect opacity=50']);
  eq(r.diagnostics.map((d) => [d.code, d.line, d.suggest]), [
    ['bad-enum', 1, 'lighten'],
    ['bad-enum', 2, 'darken'],
    ['bad-number', 3, '0.5'],
    ['out-of-range', 4, '0.5'],
  ], '診断');
});

test('読み取り: パスの数の範囲（1e39 は bad-path）、引用符のない d の列、ref と units', () => {
  const r = spec([
    'mask path d="M 0 0 L 1e39 0 L 0 40 Z"',
    'mask path d=M10,10L50,10L50,50Q',
    'mask path d="M10,10L50,10L50,50Q"',
    'mask rect ref=abc',
    'mask rect ref=1920x1080 units=norm',
    'mask rect ref=1920x1080 x=10',
  ]);
  eq(r.diagnostics.map((d) => [d.code, d.line, d.col]), [
    ['bad-path', 1, 22],
    ['bad-path', 2, 32],
    ['bad-path', 3, 33],
    ['bad-number', 4, 15],
    ['key-not-allowed', 5, 15],
  ], '診断');
  assert(r.diagnostics[0].message.includes('範囲の外'), r.diagnostics[0].message);
});

test('読み取り: トラックマットの参照（unknown-ref、matte-self、ref-cycle、matte-missing、matte-not-visual、matte-chain）', () => {
  const r = spec(['clip id=a matte=title', 'clip id=title', 'clip id=b matte=b', 'clip id=c matte=d', 'clip id=d matte=c', 'clip id=e matte.type=luma',
    'clip id=f matte=titel', 'audio id=bgm', 'clip id=g matte=bgm', 'clip id=h matte=a']);
  const ds = r.diagnostics.map((d) => [d.code, d.line, d.suggest]);
  eq(ds, [
    ['matte-missing', 6, ''],
    ['matte-self', 3, ''],
    ['ref-cycle', 4, ''],
    ['ref-cycle', 5, ''],
    ['unknown-ref', 7, 'title'],
    ['matte-not-visual', 9, ''],
    ['matte-chain', 10, ''],
  ], '診断');
});

test('マスクの座標: ref=WxH は層の大きさとの比で、units=norm は層の大きさに対する割合で変換する（ぼかし・角も）', () => {
  const pts = [];
  for (let y = 3; y < 200; y += 9) for (let x = 2; x < 200; x += 7) pts.push([x, y]);
  const want = maskAt(['rect x=20 y=30 w=100 h=80 round=10 feather=12 expand=4'], 200, 200, pts);
  const ref = maskAt(['rect ref=100x100 x=10 y=15 w=50 h=40 round=5 feather=6 expand=2'], 200, 200, pts);
  const norm = maskAt(['rect units=norm x=0.1 y=0.15 w=0.5 h=0.4 round=0.05 feather=0.06 expand=0.02'], 200, 200, pts);
  const wantP = maskAt(['path d="M 20 30 L 120 30 L 70 110 Z" feather=12'], 200, 200, pts);
  const refP = maskAt(['path ref=100x100 d="M 10 15 L 60 15 L 35 55 Z" feather=6'], 200, 200, pts);
  for (let k = 0; k < pts.length; k++) {
    near(ref.values[k], want.values[k], 1e-5, `ref の点 ${pts[k]}`);
    near(norm.values[k], want.values[k], 1e-5, `norm の点 ${pts[k]}`);
    near(refP.values[k], wantP.values[k], 1e-5, `パス ref の点 ${pts[k]}`);
  }
  // 縦横比が違う層（幅だけ 2 倍）: x と w は幅の比、y と h は高さの比
  const wide = maskAt(['rect ref=100x100 x=10 y=10 w=50 h=40'], 200, 100, [[21, 30], [19, 30], [119, 30], [121, 30], [50, 9], [50, 10]]);
  eq(wide.values, [1, 0, 1, 0, 0, 1], '縦横比が違う層');
});

test('ぼかしの大きいパス（距離の格子）: f64 で全部の辺から求めた値との差が小さい。格子を使わない大きさでは 1e-4 以内', () => {
  const heart = 'M 960 1000 C 160 640 0 280 400 140 C 700 40 950 120 960 300 C 970 120 1220 40 1520 140 C 1920 280 1760 640 960 1000 Z';
  const f = path.join(TMP, 'diff.txt');
  const diff = (fe) => {
    fs.writeFileSync(f, `path d="${heart}" feather=${fe}\n`);
    return JSON.parse(run(CPU, ['maskdiff', f, '1920', '1080']));
  };
  const exact = diff(20);
  assert(exact.max < 1e-4, `格子なし（feather 20）: 最大の差 ${exact.max}`);
  for (const fe of [40, 300, 1000]) {
    const r = diff(fe);
    assert(r.max < 0.02 && r.mean < 0.001, `feather ${fe}: 最大の差 ${r.max}、平均 ${r.mean}`);
    if (VERBOSE) console.log(`    feather ${fe}: 最大の差 ${r.max.toExponential(2)}、平均 ${r.mean.toExponential(2)}`);
  }
});

// to= のないマスクの行
function targets(lines) {
  const f = path.join(TMP, `tg${Math.random().toString(36).slice(2)}.txt`);
  fs.writeFileSync(f, lines.join('\n') + '\n');
  return JSON.parse(run(CPU, ['targets', f])).diagnostics.map((d) => [d.code, d.line, d.severity]);
}

test('to= のないマスクの行: 掛かる先は警告、消したクリップの下は mask-orphan、上に映像がなければ mask-no-target。ref= のない px の座標は警告', () => {
  const r = targets([
    'mask rect x=0',                  // 1: 上に何もない
    'video "a.mp4" id=a',
    'mask rect x=0',                  // 3: a に掛かる（警告）
    '',
    '# 注釈',
    'mask ellipse',                   // 6: マスク・空行・注釈を飛ばして a（警告）
    '# video "b.mp4" id=b',           // 消したクリップ
    'mask rect x=1',                  // 8: mask-orphan
    'mask rect to=a x=2',             // 9: to= があるので何もしない
    'audio "bgm.wav"',
    'mask rect',                      // 11: 音の行の下 → mask-no-target
    'mask rect to=a ref=1920x1080',   // 12: 何も出ない
    'mask rect to=a units=norm',      // 13: 何も出ない
  ]);
  const noRef = r.filter((x) => x[0] === 'mask-no-ref');
  eq(noRef.map((x) => [x[1], x[2]]), [[1, 'warning'], [3, 'warning'], [6, 'warning'], [8, 'warning'], [9, 'warning'], [11, 'warning']], 'ref= のない px の座標は警告');
  eq(r.filter((x) => x[0] !== 'mask-no-ref').map((x) => x.slice(0, 3)), [
    ['mask-no-target', 1, 'error'],
    ['mask-implicit-target', 3, 'warning'],
    ['mask-implicit-target', 6, 'warning'],
    ['mask-orphan', 8, 'error'],
    ['mask-no-target', 11, 'error'],
  ], '診断');
});

// マスクの行の操作（ops.um に組み込む手順）
function maskop(lines, ...args) {
  const f = path.join(TMP, `op${Math.random().toString(36).slice(2)}.txt`);
  fs.writeFileSync(f, lines.join('\n') + '\n');
  return JSON.parse(run(CPU, ['maskop', f, ...args]));
}
const OPS_BASE = [
  'video "a.mp4" id=a',
  'mask rect to=a x=10 y=10 w=100 h=50',
  'mask ellipse x=0 y=0 w=40 h=40 mode=subtract',
  'video "b.mp4" id=b matte=a matte.type=luma',
  'text "T" id=t',
];

test('操作 add mask: to= を必ず書き、そのクリップのマスクの最後の後ろに入れる（to= のない行には to= を足す）', () => {
  const r = maskop(OPS_BASE, 'add', '1', 'a', 'Ellipse', '1920', '1080', 'x=5', 'feather=40', 'invert');
  eq(r.ok, true, 'ok');
  eq(r.lines.slice(0, 5), [
    'video "a.mp4" id=a',
    'mask rect to=a x=10 y=10 w=100 h=50',
    'mask ellipse to=a x=0 y=0 w=40 h=40 mode=subtract',
    'mask ellipse to=a ref=1920x1080 x=5 feather=40 invert',
    'video "b.mp4" id=b matte=a matte.type=luma',
  ], '行');
  eq(r.added, 3, '足した行');
  eq(r.diagnostics, [], 'to= のないマスクはもうない');
  const p = maskop(OPS_BASE, 'add', '5', 't', 'path', '0', '0', 'd=M 0 0 L 10 0 L 0 10 Z');
  eq(p.lines[5], 'mask path to=t d="M 0 0 L 10 0 L 0 10 Z"', 'パスの d は引用符で囲む。ref が分からなければ付けない');
  const noid = maskop(['video "a.mp4"', 'video "b.mp4" id=b'], 'add', '1', '', 'rect', '0', '0');
  eq([noid.ok, noid.code], [false, 'needs-id'], 'ID のないクリップ');
  const audio = maskop(['audio "a.wav" id=m'], 'add', '1', 'm', 'rect', '0', '0');
  eq([audio.ok, audio.code], [false, 'mask-no-target'], '音の行');
});

test('操作 set / unset / delete @行（マスクの行）', () => {
  const s = maskop(OPS_BASE, 'set', '@3', 'a', 'feather=20', 'invert');
  eq(s.lines[2], 'mask ellipse to=a x=0 y=0 w=40 h=40 mode=subtract feather=20 invert', 'set（to= も足す）');
  const s2 = maskop(['video "a.mp4" id=a', 'mask rect to=a invert feather=3'], 'set', '@2', '-', 'invert=0', 'opacity=0.5');
  eq(s2.lines[1], 'mask rect to=a feather=3 opacity=0.5', 'invert=0 は外す');
  const u = maskop(['video "a.mp4" id=a', 'mask rect to=a invert feather=3'], 'unset', '@2', 'invert', 'feather');
  eq(u.lines[1], 'mask rect to=a', 'unset');
  const d = maskop(OPS_BASE, 'delete', '@2');
  eq([d.lines[1], d.edits], ['# mask rect to=a x=10 y=10 w=100 h=50', [['comment', 1]]], 'delete は注釈にする');
  const bad = maskop(OPS_BASE, 'set', '@1', '-', 'x=1');
  eq([bad.ok, bad.code], [false, 'not-mask'], 'クリップの行は findMaskLine で見つからない');
});

test('操作 delete <クリップ>: マスクの行も一緒に注釈にする。matte= から参照されていれば referenced（fix-refs でマットを外す）', () => {
  const r = maskop(OPS_BASE, 'deleteclip', '1', 'a', '0');
  eq([r.ok, r.code], [false, 'referenced'], 'matte= の参照');
  assert(r.error.includes('4 行目'), r.error);
  const f = maskop(OPS_BASE, 'deleteclip', '1', 'a', '1');
  eq(f.ok, true, 'fix-refs');
  eq(f.lines.slice(1, 4), [
    '# mask rect to=a x=10 y=10 w=100 h=50',
    '# mask ellipse x=0 y=0 w=40 h=40 mode=subtract',
    'video "b.mp4" id=b',
  ], 'マスクを注釈にし、matte= / matte.type= を外す');
  // matte= の参照がなければ止めずに、マスクだけ一緒に消す（クリップの行は ops.um が注釈にする）
  const t = maskop(['text "T" id=t', 'mask rect to=t', 'mask ellipse', 'color red id=c'], 'deleteclip', '1', 't', '0');
  eq(t.lines, ['text "T" id=t', '# mask rect to=t', '# mask ellipse', 'color red id=c'], 'マスクの行');
});

test('操作 rename: マスクの to= とほかのクリップの matte= も書き換える', () => {
  const r = maskop(OPS_BASE, 'rename', 'a', 'opening');
  eq([r.lines[1], r.lines[3]], ['mask rect to=opening x=10 y=10 w=100 h=50', 'video "b.mp4" id=b matte=opening matte.type=luma'], '行');
});

test('操作 split: 後半は前半のマスクの後ろに入れ、前半のマスクを to=<後半> で写す（重ね方の順を保つ）', () => {
  const r = maskop(OPS_BASE, 'split', '1', 'a', 'a_2', 'video "a.mp4" id=a_2 in=3');
  eq(r.lines, [
    'video "a.mp4" id=a',
    'mask rect to=a x=10 y=10 w=100 h=50',
    'mask ellipse to=a x=0 y=0 w=40 h=40 mode=subtract',
    'video "a.mp4" id=a_2 in=3',
    'mask rect to=a_2 x=10 y=10 w=100 h=50',
    'mask ellipse to=a_2 x=0 y=0 w=40 h=40 mode=subtract',
    'video "b.mp4" id=b matte=a matte.type=luma',
    'text "T" id=t',
  ], '行');
  eq(r.diagnostics, [], '診断なし');
  const plain = maskop(['video "a.mp4" id=a', 'video "b.mp4"'], 'split', '1', 'a', 'a_2', 'video "a.mp4" id=a_2 in=3');
  eq([plain.lines[1], plain.edits], ['video "a.mp4" id=a_2 in=3', [['insert', 1]]], 'マスクがなければ次の行に入れるだけ');
});

test('schema: 15 のモード（名前・日本語の名前・説明）、マスクの重ね方とキー（型・範囲・既定・説明）', () => {
  const j = JSON.parse(run(CPU, ['schema']));
  eq(j.modes.map((m) => m.name), MODES, 'モードの名前');
  eq(j.modes.map((m) => m.label).slice(0, 4), ['通常', '加算', '乗算', 'スクリーン'], '日本語の名前');
  eq(j.mask.modes.map((m) => m.name), ['add', 'subtract', 'intersect', 'lighten', 'darken', 'difference', 'none'], 'マスクの重ね方');
  eq(j.matte.types, ['alpha', 'luma'], 'マット');
  eq(j.tfs.map((t) => t.name), ['bt1886', 'srgb', 'bt709'], '伝達関数（既定が先頭）');
  const op = j.mask.keys.find((k) => k.name === 'opacity');
  eq([op.type, op.default, op.min, op.max], ['number', '1', 0, 1], 'opacity の型と範囲');
  assert(op.doc.includes('50% は 0.5'), op.doc);
  const fe = j.mask.keys.find((k) => k.name === 'feather');
  eq([fe.min, fe.max], [0, 1000], 'feather の範囲');
  eq(j.mask.keys.map((k) => k.name), ['to', 'ref', 'units', 'x', 'y', 'w', 'h', 'round', 'd', 'mode', 'invert', 'feather', 'expand', 'opacity'], 'マスクのキー');
  eq(j.clipKeys.map((k) => k.name), ['blend', 'blend.space', 'matte', 'matte.type', 'matte.invert'], 'クリップのキー');
  eq(j.projectKeys.map((k) => k.name), ['blend.space', 'blend.tf'], 'project のキー');
  assert(j.mask.coords.includes('ref=WxH'), j.mask.coords);
});

// 見本の画像
function bmpPixel(file, x, y) {
  const b = fs.readFileSync(file);
  const off = b.readUInt32LE(10);
  const w = b.readInt32LE(18);
  const h = b.readInt32LE(22);
  const row = Math.ceil(w * 3 / 4) * 4;
  const p = off + (h - 1 - y) * row + x * 3;
  return [b[p + 2], b[p + 1], b[p]];
}

test('見本の画像: 描画モードの表・マスク・トラックマット', () => {
  const chart = path.join(OUT, 'm6-blend-chart.bmp');
  const masks = path.join(OUT, 'm6-blend-masks.bmp');
  const matte = path.join(OUT, 'm6-blend-matte.bmp');
  const lines = run(CPU, ['chart', chart]).trim().split(/\r?\n/);
  eq(lines.length, 15, '15 のモード');
  run(CPU, ['masks', masks]);
  run(CPU, ['matte', matte]);
  // マスクの見本: 1 枚目の中央はマスクの中（橙）、2 段目の 1 枚目の左上はマスクの外（黒）
  eq(bmpPixel(masks, 8 + 100, 8 + 100), [242, 89, 26], '四角の中は橙');
  eq(bmpPixel(masks, 8 + 2, 216 + 2), [0, 0, 0], 'マスクの値の外');
  eq(bmpPixel(masks, 8 + 100, 216 + 100), [255, 255, 255], 'マスクの値の中');
  // 2 枚目（楕円の反転）: 中心は下の絵、角は橙
  eq(bmpPixel(masks, 216 + 2, 8 + 2), [242, 89, 26], '反転した楕円の外は橙');
  if (VERBOSE) console.log(`    画像: ${chart}、${masks}、${matte}`);
});

// GPU
const wgpuHome = process.env.UM_WGPU_HOME;
if (wgpuHome && fs.existsSync(wgpuHome)) {
  const GPU = build('blend_test_gpu', { UM_WGPU: '1' });
  const backends = (process.env.UM_TEST_WGPU_BACKENDS || '').split(',').filter(Boolean);
  const cpuBin = path.join(TMP, 'cpu.bin');
  run(GPU, ['dump', cpuBin], { UM_GPU: '0' });
  for (const be of backends.length ? backends : ['']) {
    test(`CPU と GPU（wgpu${be ? ' ' + be : ''}）: 1920x1080 の 15 モード × 2 つの値 + マスク + マットが 2^-24 の刻みで同じ`, () => {
      const gpuBin = path.join(TMP, `gpu${be}.bin`);
      const env = { UM_GPU_THRESHOLD: '1', UM_GPU_TRACE: '1' };
      if (be) env.UM_WGPU_BACKEND = be;
      const r = spawnSync(GPU, ['dump', gpuBin], { encoding: 'utf8', cwd: TMP, env: { ...process.env, ...env }, maxBuffer: 1 << 26 });
      assert(r.status === 0, `GPU 版が終了コード ${r.status} で終わりました\n${r.stderr.slice(-2000)}`);
      const dev = (r.stderr.match(/wgpu: (.*)/) || [])[1];
      assert(dev && r.stderr.includes('dispatch'), `GPU で実行していません: ${r.stderr.slice(0, 400)}`);
      const a = fs.readFileSync(cpuBin);
      const b = fs.readFileSync(gpuBin);
      eq(a.length, b.length, '大きさ');
      let diff = 0;
      let maxd = 0;
      for (let k = 0; k < a.length; k += 4) {
        const d = Math.abs(a.readUInt32LE(k) - b.readUInt32LE(k));
        if (d) diff++;
        if (d > maxd) maxd = d;
      }
      eq([diff, maxd], [0, 0], `違う値の数と最大の差（${dev}）`);
      if (VERBOSE) console.log(`    ${dev}: ${a.length / 4} 個の値がすべて同じ`);
    });
  }
  if (BENCH) {
    console.log('速さ（1920x1080、1 回あたりのミリ秒）');
    const c = run(CPU, ['bench']).trim().split(/\r?\n/).map((l) => JSON.parse(l));
    const g = run(GPU, ['bench'], { UM_GPU_THRESHOLD: '1' }).trim().split(/\r?\n/).map((l) => JSON.parse(l));
    for (let k = 0; k < c.length; k++) console.log(`  ${c[k].what.padEnd(40)} CPU ${String(c[k].ms).padStart(7)}  GPU ${String(g[k].ms).padStart(7)}`);
  }
} else {
  console.log('  （UM_WGPU_HOME がないので GPU の比べは飛ばします）');
  if (BENCH) console.log(run(CPU, ['bench']));
}

if (KEEP) console.log(`作業用のフォルダ: ${TMP}`);
else fs.rmSync(TMP, { recursive: true, force: true });
if (OUT !== TMP) console.log(`見本の画像: ${OUT}`);
console.log(`m6-blend: ${passed} 件通過、${failures.length} 件失敗`);
process.exit(failures.length ? 1 : 0);
