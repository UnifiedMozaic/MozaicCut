#!/usr/bin/env node
// テーマの定数を作る。docs/design/tokens.json（色・文字・余白・角・線・影・動きの正本）を読み、
// src/gen/theme.um を書く（中身が変わったときだけ）。生成物は手で書き換えない。
//
//   node tools/gen-theme.mjs [リポジトリの場所] [--tokens <tokens.json>] [--check]
//
//   --tokens 読む tokens.json（既定は <リポジトリ>/docs/design/tokens.json）
//   --check  書かずに、いまの src/gen/theme.um が tokens.json と合っているかだけ確かめる（違えば終了コード 1）
//
// 終了コード: 0 よい、1 生成物が tokens.json と合っていない（--check）、2 tokens.json がない・読めない、
//             3 コントラストのテストに落ちた（line.control が bg.0〜bg.3 に対して 3:1 未満になる明るさの段がある）
//
// 作るもの（名前はすべて th / Th / TH_ で始める）:
//   - 生の値の定数: TH_DARK_BG_0（色、0xAARRGGBB）、TH_SPACE_2、TH_SIZE_TOP_BAR、TH_RADIUS_MD、TH_BORDER_FOCUS、
//     TH_DUR_HOVER（ms）、TH_Z_MENU、TH_OPACITY_DRAG_GHOST、TH_FONT_SANS_NAME など（倍率 1.0 の論理 px）
//   - ThColors（色の表。モードごとに thColors(mode) が返す）と ThTheme（倍率を掛けた画素の値と色）
//   - thMake(mode, 倍率, 明るさの段, 強調の色, 動きを減らす) と、寸法・線・時間・曲線の補助の関数
//   - 色の一覧（thColorCount / thColorKey / thColorAt）、文字の段階（TH_TS_*）、ラベル・クリップの種類・強調の色の表
//
// 名前の付け方: tokens.json の道筋をキャメルケースでつなぐ（color.dark.bg.0 → bg0、clip.video.faceSelected →
// clipVideoFaceSelected）。最後の "default" は落とす（accent.default → accent、line.default → line）。
// semantic.* は前置きを付けない（semantic.playhead → playhead）。label.<名前>.value → label<名前>。"note" と "use" は説明なので飛ばす。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const checkOnly = argv.includes('--check');
const ti = argv.indexOf('--tokens');
const tokensArg = ti >= 0 ? argv[ti + 1] : null;
const repo = path.resolve(argv.find((a, i) => !a.startsWith('--') && (ti < 0 || i !== ti + 1)) ?? path.join(here, '..'));
const tokensPath = tokensArg ? path.resolve(tokensArg) : path.join(repo, 'docs/design/tokens.json');
const outPath = path.join(repo, 'src/gen/theme.um');

let tok;
try {
  tok = JSON.parse(fs.readFileSync(tokensPath, 'utf8'));
} catch (e) {
  const why = e && e.code === 'ENOENT' ? 'ファイルがありません' : `読めません（${e && e.message ? e.message : e}）`;
  console.error(`tokens.json ${why}: ${tokensPath}`);
  console.error('docs/design/tokens.json を置くか、--tokens <tokens.json> で場所を渡してください。');
  process.exit(2);
}

// ---- 名前 ----
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const camel = (parts) => parts.map((p, i) => (i === 0 ? p : cap(String(p)))).join('');
const snake = (s) =>
  String(s)
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .toUpperCase();
const SKIP = new Set(['note', 'use', '$schema-note', 'impl', 'css']);

// ---- 色 ----
function hexToArgb(h) {
  const m = /^#([0-9a-fA-F]{6})([0-9a-fA-F]{2})?$/.exec(h);
  if (!m) return null;
  const rgb = parseInt(m[1], 16);
  const a = m[2] ? parseInt(m[2], 16) : 255;
  return ((a << 24) >>> 0) + rgb;
}
const hex32 = (v) => '0x' + (v >>> 0).toString(16).padStart(8, '0');
const chan = (v, s) => (v >>> s) & 255;
function lin(c) {
  const x = c / 255;
  return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
}
const lum = (v) => 0.2126 * lin(chan(v, 16)) + 0.7152 * lin(chan(v, 8)) + 0.0722 * lin(chan(v, 0));
const contrast = (a, b) => {
  const la = lum(a);
  const lb = lum(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
};
const rgb = (r, g, b, a = 255) => (((a & 255) << 24) >>> 0) + ((r & 255) << 16) + ((g & 255) << 8) + (b & 255);
const clamp8 = (x) => Math.max(0, Math.min(255, Math.round(x)));

// 明るさの段で上下させる色。tokens.json の brightnessSteps.keys（道筋か "bg.*" の形）があればそれを使い、
// なければ brightnessSteps.note の取り決め（bg.*・line.*・text.2・text.3）にする。
const BRIGHT_KEYS = tok.color.brightnessSteps?.keys ?? ['bg.*', 'line.*', 'text.2', 'text.3'];
function brightAffects(key) {
  return BRIGHT_KEYS.some((k) => (k.endsWith('.*') ? key.startsWith(k.slice(0, -1)) : key === k));
}

// 1 つのモードの色を平らな [{key, field, value, gray}] にする。key は tokens.json の道筋（"bg.0"）。
function flattenColors(mode) {
  const out = [];
  const strings = { labelName: [], labelNameEn: [], labelKey: [] };
  const extra = { accentChoices: [], meterTicks: null, numbers: [] };
  const walk = (obj, parts) => {
    for (const [k, v] of Object.entries(obj)) {
      if (SKIP.has(k)) continue;
      const p = [...parts, k];
      if (p[0] === 'accent' && k === 'choices') {
        for (const [ck, cv] of Object.entries(v)) extra.accentChoices.push({ key: ck, value: hexToArgb(cv) });
        continue;
      }
      if (p[0] === 'meter' && k === 'ticksDb') {
        extra.meterTicks = v;
        continue;
      }
      if (p[0] === 'label' && p.length === 2 && typeof v === 'object') {
        strings.labelKey.push(k);
        strings.labelName.push(v.name ?? k);
        strings.labelNameEn.push(v.nameEn ?? k);
        out.push({ key: `label.${k}`, field: camel(['label', k]), value: hexToArgb(v.value), gray: false, label: k });
        continue;
      }
      if (typeof v === 'object' && v !== null) {
        walk(v, p);
        continue;
      }
      if (typeof v === 'number') {
        extra.numbers.push({ name: snake(camel(p)), value: v });
        continue;
      }
      if (typeof v !== 'string') continue;
      const c = hexToArgb(v);
      if (c === null) throw new Error(`色が読めません: color.${mode}.${p.join('.')} = ${v}`);
      let fp = p.slice();
      if (fp[0] === 'semantic') fp = fp.slice(1);
      if (fp.length > 1 && fp[fp.length - 1] === 'default') fp = fp.slice(0, -1);
      out.push({ key: p.join('.'), field: camel(fp), value: c, gray: brightAffects(p.join('.')) });
    }
  };
  walk(tok.color[mode], []);
  return { list: out, strings, extra };
}

const modes = Object.keys(tok.color).filter((k) => typeof tok.color[k] === 'object' && k !== 'brightnessSteps');
if (!modes.includes('dark')) throw new Error('color.dark がありません');
const dark = flattenColors('dark');
const light = modes.includes('light') ? flattenColors('light') : null;
const fieldOf = (key) => {
  const e = dark.list.find((x) => x.key === key);
  if (!e) throw new Error(`色 ${key} がありません`);
  return e;
};

// 強調の色の選択肢。default（青）は tokens.json の値をそのまま、ほかは青の値から割合を求めて作る。
const accentE = fieldOf('accent.default');
const hoverE = fieldOf('accent.hover');
const tintE = fieldOf('accent.tint');
const tintSolidE = fieldOf('accent.tintSolid');
const bg0E = fieldOf('bg.0');
function ratio(from, to, target) {
  let sum = 0;
  let n = 0;
  for (const s of [16, 8, 0]) {
    const d = chan(target, s) - chan(from, s);
    if (Math.abs(d) < 16) continue;
    sum += (chan(to, s) - chan(from, s)) / d;
    n++;
  }
  return n ? sum / n : 0;
}
const hoverMix = ratio(accentE.value, hoverE.value, 0xffffffff); // 白へ寄せる割合
const solidMix = ratio(bg0E.value, tintSolidE.value, accentE.value); // bg.0 から強調の色へ寄せる割合
const tintAlpha = chan(tintE.value, 24);
const mix = (a, b, t) => rgb(clamp8(chan(a, 16) + (chan(b, 16) - chan(a, 16)) * t), clamp8(chan(a, 8) + (chan(b, 8) - chan(a, 8)) * t), clamp8(chan(a, 0) + (chan(b, 0) - chan(a, 0)) * t));
const ACCENT_JA = { blue: '青', teal: '青緑', green: '緑', orange: '橙' }; // ui.md 12 章「強調の色（青・青緑・緑・橙）」
// 選択肢がなければ（強調の色を固定するとき）既定の 1 つだけ
const accentChoices = dark.extra.accentChoices.length ? dark.extra.accentChoices : [{ key: 'default', value: accentE.value }];
ACCENT_JA.default = '既定';
const accents = accentChoices.map((c) => {
  const isDefault = (c.value & 0xffffff) === (accentE.value & 0xffffff);
  return {
    key: c.key,
    name: ACCENT_JA[c.key] ?? c.key,
    value: c.value,
    hover: isDefault ? hoverE.value : mix(c.value, 0xffffffff, hoverMix),
    tint: isDefault ? tintE.value : (((tintAlpha << 24) >>> 0) + (c.value & 0xffffff)) >>> 0,
    tintSolid: isDefault ? tintSolidE.value : mix(bg0E.value, c.value, solidMix),
    isDefault,
  };
});
let accentDefault = accents.findIndex((a) => a.isDefault);
if (accentDefault < 0) accentDefault = 0;

// ラベルの上の文字: onLight と onDark のうちコントラストの高い方
const onLight = fieldOf('text.onLight').value;
const onDark = fieldOf('text.onDark').value;
const inkOf = (bg) => (contrast(bg, onLight) >= contrast(bg, onDark) ? 0 : 1);

// ---- 出力 ----
const L = [];
const w = (s = '') => L.push(s);
const f32 = (v) => {
  const s = String(v);
  return /[.eE]/.test(s) ? s : s + '.0';
};
const str = (s) => JSON.stringify(String(s));

w('// 生成物: tools/gen-theme.mjs が docs/design/tokens.json から作る。手で書き換えない（tokens.json を直して作り直す）。');
w('// 値の意味は docs/design/ui.md の 17〜20 章。大きさの定数は倍率 1.0 の論理 px、ThTheme の値は倍率を掛けた画素。');
w('// 色は 0xAARRGGBB。');
w();
w(`export const TH_TOKENS_VERSION: i32 = ${tok.version | 0};`);
w();
w('// ---- モード（暗い ／ 明るい）----');
w('export const TH_MODE_DARK: i32 = 0;');
w('export const TH_MODE_LIGHT: i32 = 1;');
w(`// tokens.json に color.light があるか。ないときは thColors(TH_MODE_LIGHT) も暗いテーマを返す。`);
w(`export const TH_HAS_LIGHT: bool = ${light ? 'true' : 'false'};`);
w(`export const TH_MODE_DEFAULT: i32 = ${tok.theme?.default === 'light' && light ? 'TH_MODE_LIGHT' : 'TH_MODE_DARK'};`);
w();
w('// ---- UI の倍率（OS の倍率 × 利用者の倍率）----');
w(`export const TH_SCALE_MIN: f32 = ${f32(tok.scale.min)};`);
w(`export const TH_SCALE_MAX: f32 = ${f32(tok.scale.max)};`);
w(`export const TH_SCALE_STEP: f32 = ${f32(tok.scale.step)};`);
w();
w(`// ---- 明るさ（${BRIGHT_KEYS.join('・')} の R=G=B をまとめて上下させる段）----`);
const bs = tok.color.brightnessSteps;
w(`export const TH_BRIGHT_MIN: i32 = ${bs.min};`);
w(`export const TH_BRIGHT_MAX: i32 = ${bs.max};`);
w(`export const TH_BRIGHT_STEP_RGB: i32 = ${bs.stepRgb};`);
w();

// 色の定数
const emitColorConsts = (modeName, fl) => {
  w(`// ---- 色（${modeName}）----`);
  for (const e of fl.list) w(`export const TH_${snake(modeName)}_${snake(e.field)}: u32 = ${hex32(e.value)};   // ${e.key}`);
  w();
};
emitColorConsts('dark', dark);
if (light) emitColorConsts('light', light);

w('// ---- 強調の色の選択肢（設定「強調の色」）。既定の色は tokens.json の値、ほかは既定の色の hover・tint の割合から作る ----');
accents.forEach((a, i) => w(`export const TH_ACCENT_CHOICE_${snake(a.key)}: i32 = ${i};   // ${a.name}`));
w(`export const TH_ACCENT_COUNT: i32 = ${accents.length};`);
w(`export const TH_ACCENT_DEFAULT: i32 = ${accentDefault};`);
w(`export const TH_ACCENT_VALUE: u32[${accents.length}] = [${accents.map((a) => hex32(a.value)).join(', ')}];`);
w(`export const TH_ACCENT_HOVER: u32[${accents.length}] = [${accents.map((a) => hex32(a.hover)).join(', ')}];`);
w(`export const TH_ACCENT_TINT: u32[${accents.length}] = [${accents.map((a) => hex32(a.tint)).join(', ')}];`);
w(`export const TH_ACCENT_TINT_SOLID: u32[${accents.length}] = [${accents.map((a) => hex32(a.tintSolid)).join(', ')}];`);
w();
w('export function thAccentKey(i: i32): string {');
w('  switch (i) {');
accents.forEach((a, i) => w(`    case ${i}: return ${str(a.key)};`));
w('  }');
w('  return "";');
w('}');
w();
w('export function thAccentName(i: i32): string {');
w('  switch (i) {');
accents.forEach((a, i) => w(`    case ${i}: return ${str(a.name)};`));
w('  }');
w('  return "";');
w('}');
w();

// メーターの目盛りと、色の表の中の数
if (dark.extra.meterTicks) {
  w(`// メーターの目盛り（dB）`);
  w(`export const TH_METER_TICKS_DB: i32[${dark.extra.meterTicks.length}] = [${dark.extra.meterTicks.join(', ')}];`);
}
for (const nv of dark.extra.numbers) {
  w(Number.isInteger(nv.value) ? `export const TH_${nv.name}: i32 = ${nv.value};` : `export const TH_${nv.name}: f32 = ${f32(nv.value)};`);
}
w();

// ---- 寸法 ----
const intConsts = []; // {name, value, field?, kind:'px'|'line'}
const floatConsts = [];
w('// ---- 余白（4px の格子）----');
const spaceKeys = Object.keys(tok.space).filter((k) => /^\d+$/.test(k));
for (const k of spaceKeys) w(`export const TH_SPACE_${k}: i32 = ${tok.space[k]};`);
w(`export const TH_SPACE_GRID: i32 = ${tok.space.grid};`);
w(`export const TH_SPACE_COUNT: i32 = ${spaceKeys.length};`);
w();

w('// ---- 固定の寸法（size.*）----');
const sizeFields = [];
const sizeStrings = []; // 文字の並び（trackHeight.presetNames など）は関数にする
const walkSize = (obj, parts) => {
  for (const [k, v] of Object.entries(obj)) {
    if (SKIP.has(k)) continue;
    const p = [...parts, k];
    if (Array.isArray(v)) {
      const n = `TH_SIZE_${snake(camel(p))}`;
      if (v.every((x) => Number.isInteger(x))) {
        w(`export const ${n}: i32[${v.length}] = [${v.join(', ')}];`);
      } else {
        sizeStrings.push({ fn: camel(['thSize', ...p]), konst: n, arr: v.map(String) });
      }
    } else if (typeof v === 'object') {
      walkSize(v, p);
    } else if (typeof v === 'number') {
      const n = `TH_SIZE_${snake(camel(p))}`;
      if (Number.isInteger(v)) {
        w(`export const ${n}: i32 = ${v};`);
        sizeFields.push({ field: camel(p), konst: n });
      } else {
        w(`export const ${n}: f32 = ${f32(v)};   // 割合（倍率を掛けない）`);
      }
    }
  }
};
walkSize(tok.size, []);
for (const ss of sizeStrings) {
  w(`export const ${ss.konst}_COUNT: i32 = ${ss.arr.length};`);
  w(`export function ${ss.fn}(i: i32): string {`);
  w('  switch (i) {');
  ss.arr.forEach((x, i) => w(`    case ${i}: return ${str(x)};`));
  w('  }');
  w('  return "";');
  w('}');
}
w();

w('// ---- 角の丸み ----');
const radiusKeys = Object.keys(tok.radius).filter((k) => typeof tok.radius[k] === 'number');
for (const k of radiusKeys) w(`export const TH_RADIUS_${snake(k)}: i32 = ${tok.radius[k]};`);
w();
w('// ---- 線の太さ（倍率を掛けたあと整数の画素に吸着させる）----');
const borderKeys = Object.keys(tok.border).filter((k) => typeof tok.border[k] === 'number');
for (const k of borderKeys) w(`export const TH_BORDER_${snake(k)}: i32 = ${tok.border[k]};`);
w();

// 影: "0 4px 12px rgba(0,0,0,.5)"
w('// ---- 影（浮かぶものだけの 1 種類）----');
const shadows = [];
for (const [k, v] of Object.entries(tok.shadow)) {
  if (typeof v !== 'object') continue;
  const m = /^\s*(-?[\d.]+)(?:px)?\s+(-?[\d.]+)(?:px)?\s+([\d.]+)(?:px)?(?:\s+(-?[\d.]+)(?:px)?)?\s+rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)\s*$/.exec(v.css);
  if (!m) throw new Error(`影が読めません: shadow.${k} = ${v.css}`);
  const a = m[8] === undefined ? 1 : parseFloat(m[8]);
  const s = { key: k, x: +m[1], y: +m[2], blur: +m[3], spread: m[4] ? +m[4] : 0, color: rgb(+m[5], +m[6], +m[7], clamp8(a * 255)) };
  shadows.push(s);
  const n = `TH_SHADOW_${snake(k)}`;
  w(`export const ${n}_X: i32 = ${s.x};`);
  w(`export const ${n}_Y: i32 = ${s.y};`);
  w(`export const ${n}_BLUR: i32 = ${s.blur};`);
  w(`export const ${n}_SPREAD: i32 = ${s.spread};`);
  w(`export const ${n}_COLOR: u32 = ${hex32(s.color)};   // ${v.css}`);
}
w();

w('// ---- 不透明度（0〜1 と、0〜255 の値）----');
for (const [k, v] of Object.entries(tok.opacity)) {
  if (typeof v !== 'number') continue;
  w(`export const TH_OPACITY_${snake(k)}: f32 = ${f32(v)};`);
  w(`export const TH_OPACITY_${snake(k)}_A: i32 = ${clamp8(v * 255)};`);
}
w();
w('// ---- 模様 ----');
w(`export const TH_HATCH_ANGLE: i32 = ${tok.pattern.hatch.angle};`);
w(`export const TH_HATCH_PERIOD: i32 = ${tok.pattern.hatch.period};`);
w(`export const TH_DASH_ON: i32 = ${tok.pattern.dash.on};`);
w(`export const TH_DASH_OFF: i32 = ${tok.pattern.dash.off};`);
w();

// 動き
w('// ---- 動きの時間（ms）。「動きを減らす」では、出入りの動きは 0、待ち時間と表示の時間はそのまま ----');
const durKeys = Object.keys(tok.motion.duration);
// 動きではなく「待つ・見せておく」時間（減らさない）。通知のフェードは「動きを減らす」でも残す（ui.md 18 章）
const keepWhenReduced = (k) => /Delay$|Hold/.test(k) || k === 'toastIn';
for (const k of durKeys) w(`export const TH_DUR_${snake(k)}: i32 = ${tok.motion.duration[k]};`);
w();
w('// 曲線（cubic-bezier の 4 つの値）。thEase(TH_EASE_*, t) で使う');
const eases = [];
for (const [k, v] of Object.entries(tok.motion.easing)) {
  let pts = [0, 0, 1, 1];
  const m = /cubic-bezier\(([^)]*)\)/.exec(v);
  if (m) pts = m[1].split(',').map((x) => parseFloat(x));
  eases.push({ key: k, pts });
}
eases.forEach((e, i) => w(`export const TH_EASE_${snake(e.key)}: i32 = ${i};`));
w(`export const TH_EASE_BEZIER: f32[${eases.length * 4}] = [${eases.flatMap((e) => e.pts.map(f32)).join(', ')}];`);
w();
w('// ---- 重なりの順 ----');
for (const [k, v] of Object.entries(tok.z)) w(`export const TH_Z_${snake(k)}: i32 = ${v};`);
w();
w('// ---- 性能の予算 ----');
for (const [k, v] of Object.entries(tok.budget)) w(`export const TH_BUDGET_${snake(k)}: i32 = ${v};`);
w();

// ---- 文字 ----
w('// ---- フォント（同梱する前提のファミリーとファイル。探し方は src/theme_font.um）----');
const fam = tok.font.family;
for (const [k, v] of Object.entries(fam)) {
  w(`export const TH_FONT_${snake(k)}_NAME: string = ${str(v.name)};`);
  if (v.files) v.files.forEach((f, i) => w(`export const TH_FONT_${snake(k)}_FILE_${i}: string = ${str(f)};`));
  if (v.range) {
    const r = /U\+([0-9A-Fa-f]+)-U\+([0-9A-Fa-f]+)/.exec(v.range);
    if (r) {
      w(`export const TH_FONT_${snake(k)}_FIRST: i32 = 0x${r[1]};`);
      w(`export const TH_FONT_${snake(k)}_LAST: i32 = 0x${r[2]};`);
    }
  }
}
for (const [k, v] of Object.entries(tok.font.weight)) if (typeof v === 'number') w(`export const TH_WEIGHT_${snake(k)}: i32 = ${v};`);
w(`export const TH_FONT_MIN_JAPANESE: i32 = ${tok.font.rules.minJapanese};`);
{
  // minJapaneseException（「レールの 2 文字までのラベルだけ 11px」）から、例外の大きさと字数を読む
  const ex = String(tok.font.rules.minJapaneseException ?? '');
  const px = /(\d+)\s*px/.exec(ex);
  const chars = /(\d+)\s*文字/.exec(ex);
  w(`// 例外: ${ex || 'なし'}`);
  w(`export const TH_FONT_MIN_JAPANESE_RAIL: i32 = ${px ? px[1] : tok.font.rules.minJapanese};`);
  w(`export const TH_FONT_MIN_JAPANESE_RAIL_MAX_CHARS: i32 = ${chars ? chars[1] : 0};`);
}
w(`// 省略の位置: 0 末尾、1 中央`);
w(`export const TH_ELLIPSIS_DEFAULT: i32 = ${tok.font.rules.ellipsis.default === 'middle' ? 1 : 0};`);
w(`export const TH_ELLIPSIS_MEDIA_NAME: i32 = ${tok.font.rules.ellipsis.mediaName === 'middle' ? 1 : 0};`);
w(`// コード（式・パス・キー）: ${tok.font.rules.ellipsis.code ?? 'end'}。2 なら省略せず、トークンの境目で折り返す`);
w(`export const TH_ELLIPSIS_TOKEN_WRAP: i32 = 2;`);
{
  const code = String(tok.font.rules.ellipsis.code ?? 'end');
  const v = code === 'middle' ? 1 : code === 'end' ? 0 : /トークン|token/i.test(code) ? 2 : 0;
  w(`export const TH_ELLIPSIS_CODE: i32 = ${v};`);
}
w();
w('// 文字の段階（font.size.*）。TH_TS_SIZE などの並びの番号');
const ts = Object.entries(tok.font.size).filter(([, v]) => typeof v === 'object');
ts.forEach(([k], i) => w(`export const TH_TS_${snake(k)}: i32 = ${i};`));
w(`export const TH_TS_COUNT: i32 = ${ts.length};`);
w(`// 0 sans、1 mono`);
w('export const TH_FAMILY_SANS: i32 = 0;');
w('export const TH_FAMILY_MONO: i32 = 1;');
w(`export const TH_TS_SIZE: f32[${ts.length}] = [${ts.map(([, v]) => f32(v.size)).join(', ')}];`);
w(`export const TH_TS_LINE_H: i32[${ts.length}] = [${ts.map(([, v]) => v.lineHeight).join(', ')}];`);
w(`export const TH_TS_WEIGHT: i32[${ts.length}] = [${ts.map(([, v]) => v.weight ?? 400).join(', ')}];`);
w(`export const TH_TS_FAMILY: i32[${ts.length}] = [${ts.map(([, v]) => (v.family === 'mono' ? 1 : 0)).join(', ')}];`);
w();
w('export function thTsKey(i: i32): string {');
w('  switch (i) {');
ts.forEach(([k], i) => w(`    case ${i}: return ${str(k)};`));
w('  }');
w('  return "";');
w('}');
w();
w('// 段階の使いどころ（tokens.json の use）');
w('export function thTsUse(i: i32): string {');
w('  switch (i) {');
ts.forEach(([, v], i) => w(`    case ${i}: return ${str(v.use ?? '')};`));
w('  }');
w('  return "";');
w('}');
w();

// ---- ThColors ----
w('// ---- 色の表 ----');
w('export struct ThColors {');
for (const e of dark.list) w(`  ${e.field}: u32;   // ${e.key}`);
for (const e of dark.list.filter((x) => x.label)) w(`  ${e.field}Ink: u32;   // ${e.key} の上の文字（輝度で黒か白）`);
w('}');
w();
const emitColorsFn = (modeName, fl) => {
  w(`function thColors${cap(modeName)}(): ThColors {`);
  w('  return {');
  for (const e of dark.list) {
    const own = fl.list.find((x) => x.key === e.key) ?? e;
    if (!fl.list.find((x) => x.key === e.key)) console.warn(`warning: color.${modeName}.${e.key} がないので dark の値を使います`);
    w(`    ${e.field}: ${hex32(own.value)},`);
  }
  for (const e of dark.list.filter((x) => x.label)) {
    const own = fl.list.find((x) => x.key === e.key) ?? e;
    w(`    ${e.field}Ink: ${inkOf(own.value) === 0 ? hex32(onLight) : hex32(onDark)},`);
  }
  w('  };');
  w('}');
  w();
};
emitColorsFn('dark', dark);
if (light) emitColorsFn('light', light);
w('// モードの色の表（明るさ・強調の色を当てる前）。');
w('export function thColors(mode: i32): ThColors {');
if (light) {
  w('  if (mode == TH_MODE_LIGHT) {');
  w('    return thColorsLight();');
  w('  }');
}
w('  return thColorsDark();');
w('}');
w();

// 色の一覧（見本・設定画面・テスト用）
w('// ---- 色の一覧（見本・コントラストの試し用）。key は tokens.json の color.<mode> の下の道筋 ----');
w(`export const TH_COLOR_COUNT: i32 = ${dark.list.length};`);
w('export function thColorKey(i: i32): string {');
w('  switch (i) {');
dark.list.forEach((e, i) => w(`    case ${i}: return ${str(e.key)};`));
w('  }');
w('  return "";');
w('}');
w();
w('export function thColorAt(c: ThColors, i: i32): u32 {');
w('  switch (i) {');
dark.list.forEach((e, i) => w(`    case ${i}: return c.${e.field};`));
w('  }');
w('  return 0;');
w('}');
w();

// ラベル
const labels = dark.list.filter((x) => x.label);
w('// ---- ラベルの色（名前つき。利用者が名前を付け替えられる）----');
labels.forEach((e, i) => w(`export const TH_LABEL_${snake(e.label)}: i32 = ${i};`));
w(`export const TH_LABEL_COUNT: i32 = ${labels.length};`);
const strFn = (name, arr) => {
  w(`export function ${name}(i: i32): string {`);
  w('  switch (i) {');
  arr.forEach((s, i) => w(`    case ${i}: return ${str(s)};`));
  w('  }');
  w('  return "";');
  w('}');
  w();
};
strFn('thLabelKey', dark.strings.labelKey);
strFn('thLabelName', dark.strings.labelName);
strFn('thLabelNameEn', dark.strings.labelNameEn);
w('export function thLabelColor(c: ThColors, i: i32): u32 {');
w('  switch (i) {');
labels.forEach((e, i) => w(`    case ${i}: return c.${e.field};`));
w('  }');
w('  return c.text3;');
w('}');
w();
w('// ラベルの色の上に載せる文字の色');
w('export function thLabelInk(c: ThColors, i: i32): u32 {');
w('  switch (i) {');
labels.forEach((e, i) => w(`    case ${i}: return c.${e.field}Ink;`));
w('  }');
w('  return c.text1;');
w('}');
w();

// クリップの種類
const clipKinds = Object.keys(tok.color.dark.clip).filter((k) => typeof tok.color.dark.clip[k] === 'object');
w('// ---- クリップの種類の色（上の辺の mark・面・選んだ面・文字）----');
clipKinds.forEach((k, i) => w(`export const TH_CLIP_${snake(k)}: i32 = ${i};`));
w(`export const TH_CLIP_COUNT: i32 = ${clipKinds.length};`);
strFn('thClipKey', clipKinds);
const clipFn = (name, part) => {
  w(`export function ${name}(c: ThColors, kind: i32): u32 {`);
  w('  switch (kind) {');
  clipKinds.forEach((k, i) => w(`    case ${i}: return c.${camel(['clip', k, part])};`));
  w('  }');
  w(`  return c.${camel(['clip', clipKinds[0], part])};`);
  w('}');
  w();
};
clipFn('thClipMark', 'mark');
clipFn('thClipFace', 'face');
clipFn('thClipFaceSelected', 'faceSelected');
clipFn('thClipText', 'text');

// ---- ThTheme ----
w('// ---- テーマ（倍率を掛けた画素の値と、明るさ・強調の色を当てた色）----');
w('export struct ThTheme {');
w('  mode: i32;');
w('  scale: f32;');
w('  brightness: i32;     // TH_BRIGHT_MIN〜TH_BRIGHT_MAX');
w('  accentChoice: i32;   // TH_ACCENT_*');
w('  reduceMotion: bool;');
w('  c: ThColors;');
w(`  space: i32[${spaceKeys.length}];   // TH_SPACE_0〜（倍率を掛けた画素）`);
for (const s of sizeFields) w(`  ${s.field}: i32;`);
for (const k of radiusKeys) w(`  ${camel(['radius', k])}: i32;`);
for (const k of borderKeys) w(`  ${camel(['border', k])}: i32;   // 線（整数の画素に吸着）`);
for (const s of shadows) {
  for (const p of ['x', 'y', 'blur', 'spread']) w(`  ${camel(['shadow', s.key, p])}: i32;`);
  w(`  ${camel(['shadow', s.key, 'color'])}: u32;`);
}
w('  hatchPeriod: i32;');
w('  dashOn: i32;');
w('  dashOff: i32;');
w(`  ts: f32[${ts.length}];       // 文字の大きさ（em の画素。TH_TS_* の番号）`);
w(`  tsLineH: i32[${ts.length}];  // 行の高さ（画素）`);
for (const k of durKeys) w(`  ${camel(['dur', k])}: i32;   // ms`);
w('}');
w();
w('// 寸法を倍率で画素に（四捨五入）。');
w('export function thPxAt(v: i32, scale: f32): i32 {');
w('  return Math.floor((v as f32) * scale + 0.5) as i32;');
w('}');
w();
w('// 線の太さを倍率で画素に（四捨五入して 1 以上。1px の線は 125% で 1px、150% で 2px）。');
w('export function thLineAt(v: i32, scale: f32): i32 {');
w('  if (v <= 0) {');
w('    return 0;');
w('  }');
w('  return Math.max(Math.floor((v as f32) * scale + 0.5) as i32, 1);');
w('}');
w();
w('export function thPx(t: ThTheme, v: i32): i32 {');
w('  return thPxAt(v, t.scale);');
w('}');
w();
w('export function thLine(t: ThTheme, v: i32): i32 {');
w('  return thLineAt(v, t.scale);');
w('}');
w();
w('// 倍率を tokens.json の範囲に収め、刻みにそろえる。');
w('export function thClampScale(s: f32): f32 {');
w('  const c = Math.min(Math.max(s, TH_SCALE_MIN), TH_SCALE_MAX);');
w('  return (Math.floor(c / TH_SCALE_STEP + 0.5) as f32) * TH_SCALE_STEP;');
w('}');
w();
w('// R=G=B の灰色を d だけ明るく（負なら暗く）。不透明度は保つ。');
w('export function thShiftGray(c: u32, d: i32): u32 {');
w('  const a = (c >> 24) & 255;');
w('  const r = Math.min(Math.max((((c >> 16) & 255) as i32) + d, 0), 255) as u32;');
w('  const g = Math.min(Math.max((((c >> 8) & 255) as i32) + d, 0), 255) as u32;');
w('  const b = Math.min(Math.max(((c & 255) as i32) + d, 0), 255) as u32;');
w('  return (a << 24) | (r << 16) | (g << 8) | b;');
w('}');
w();
w('// テーマを作る。mode: TH_MODE_*、scale: UI の倍率（TH_SCALE_MIN〜MAX に収める）、brightness: 明るさの段、');
w('// accent: 強調の色（TH_ACCENT_*）、reduceMotion: 動きを減らす。倍率や設定が変わったら作り直す。');
w('export function thMake(mode: i32, scale: f32, brightness: i32, accent: i32, reduceMotion: bool): ThTheme {');
w('  const s = Math.min(Math.max(scale, TH_SCALE_MIN), TH_SCALE_MAX);');
w('  const br = Math.min(Math.max(brightness, TH_BRIGHT_MIN), TH_BRIGHT_MAX);');
w('  let ac = accent;');
w('  if (ac < 0 || ac >= TH_ACCENT_COUNT) {');
w('    ac = TH_ACCENT_DEFAULT;');
w('  }');
w('  let c = thColors(mode);');
w('  const d = br * TH_BRIGHT_STEP_RGB;');
w('  if (d != 0) {');
for (const e of dark.list.filter((x) => x.gray)) w(`    c.${e.field} = thShiftGray(c.${e.field}, d);`);
w('  }');
w('  c.accent = TH_ACCENT_VALUE[ac as usize];');
w('  c.accentHover = TH_ACCENT_HOVER[ac as usize];');
w('  c.accentTint = TH_ACCENT_TINT[ac as usize];');
// accent.tintSolid は強調の色なので、brightnessSteps.keys に書かれていなければ明るさで動かさない
w(brightAffects('accent.tintSolid')
  ? '  c.accentTintSolid = thShiftGray(TH_ACCENT_TINT_SOLID[ac as usize], d);'
  : '  c.accentTintSolid = TH_ACCENT_TINT_SOLID[ac as usize];');
w('  let t: ThTheme = {');
w('    mode, scale: s, brightness: br, accentChoice: ac, reduceMotion, c,');
w(`    space: [${spaceKeys.map((k) => `thPxAt(TH_SPACE_${k}, s)`).join(', ')}],`);
for (const sf of sizeFields) w(`    ${sf.field}: thPxAt(${sf.konst}, s),`);
for (const k of radiusKeys) w(`    ${camel(['radius', k])}: thPxAt(TH_RADIUS_${snake(k)}, s),`);
for (const k of borderKeys) w(`    ${camel(['border', k])}: thLineAt(TH_BORDER_${snake(k)}, s),`);
for (const sh of shadows) {
  const n = `TH_SHADOW_${snake(sh.key)}`;
  w(`    ${camel(['shadow', sh.key, 'x'])}: thPxAt(${n}_X, s),`);
  w(`    ${camel(['shadow', sh.key, 'y'])}: thPxAt(${n}_Y, s),`);
  w(`    ${camel(['shadow', sh.key, 'blur'])}: thPxAt(${n}_BLUR, s),`);
  w(`    ${camel(['shadow', sh.key, 'spread'])}: thPxAt(${n}_SPREAD, s),`);
  w(`    ${camel(['shadow', sh.key, 'color'])}: ${n}_COLOR,`);
}
w('    hatchPeriod: thPxAt(TH_HATCH_PERIOD, s),');
w('    dashOn: thLineAt(TH_DASH_ON, s),');
w('    dashOff: thLineAt(TH_DASH_OFF, s),');
w(`    ts: [${ts.map((_, i) => `TH_TS_SIZE[${i}] * s`).join(', ')}],`);
w(`    tsLineH: [${ts.map((_, i) => `thPxAt(TH_TS_LINE_H[${i}], s)`).join(', ')}],`);
for (const k of durKeys) {
  const n = `TH_DUR_${snake(k)}`;
  w(`    ${camel(['dur', k])}: ${keepWhenReduced(k) ? n : `thDurAt(${n}, reduceMotion)`},`);
}
w('  };');
w('  return t;');
w('}');
w();
w('// 既定の設定（暗い、明るさ 0、既定の強調の色、動きはふつう）で、倍率だけを決めて作る。');
w('export function thMakeDefault(scale: f32): ThTheme {');
w('  return thMake(TH_MODE_DEFAULT, scale, 0, TH_ACCENT_DEFAULT, false);');
w('}');
w();
w('function thDurAt(ms: i32, reduce: bool): i32 {');
w('  if (reduce) {');
w('    return 0;');
w('  }');
w('  return ms;');
w('}');
w();
w('// 曲線 kind（TH_EASE_*）で、時間の割合 x（0〜1）を進み具合（0〜1）にする。');
w('export function thEase(kind: i32, x0: f32): f32 {');
w('  const x = Math.min(Math.max(x0, 0.0), 1.0);');
w(`  if (kind < 0 || kind >= ${eases.length}) {`);
w('    return x;');
w('  }');
w('  const k = (kind * 4) as usize;');
w('  const x1 = TH_EASE_BEZIER[k];');
w('  const y1 = TH_EASE_BEZIER[k + 1];');
w('  const x2 = TH_EASE_BEZIER[k + 2];');
w('  const y2 = TH_EASE_BEZIER[k + 3];');
w('  // x(u) = x を u について二分法で解き、y(u) を返す');
w('  let lo: f32 = 0.0;');
w('  let hi: f32 = 1.0;');
w('  let u: f32 = x;');
w('  for (let i = 0; i < 24; i++) {');
w('    u = (lo + hi) * 0.5;');
w('    const v = 1.0 - u;');
w('    const bx = 3.0 * v * v * u * x1 + 3.0 * v * u * u * x2 + u * u * u;');
w('    if (bx < x) {');
w('      lo = u;');
w('    } else {');
w('      hi = u;');
w('    }');
w('  }');
w('  const v = 1.0 - u;');
w('  return 3.0 * v * v * u * y1 + 3.0 * v * u * u * y2 + u * u * u;');
w('}');
w();
w('// 動きの途中の割合（0〜1）。t0 から dur ms の動き（dur が 0 なら 1）。now と t0 は秒。');
w('export function thProgress(now: f64, t0: f64, durMs: i32, kind: i32): f32 {');
w('  if (durMs <= 0) {');
w('    return 1.0;');
w('  }');
w('  const x = ((now - t0) * 1000.0 / (durMs as f64)) as f32;');
w('  return thEase(kind, x);');
w('}');

// ---- コントラストのテスト ----
// line.control（部品の輪郭）は、明るさの全段（min〜max）で bg.0〜bg.3 に対して 3:1 以上（WCAG 1.4.11）。
// 明るさの段では bg も line も同じだけ動くので、段ごとに両方を動かしてから比べる。
{
  const shift = (v, d) => rgb(clamp8(chan(v, 16) + d), clamp8(chan(v, 8) + d), clamp8(chan(v, 0) + d), chan(v, 24));
  const fails = [];
  let minR = Infinity;
  let minAt = '';
  for (const modeName of modes) {
    const m = tok.color[modeName];
    if (!m.line || !m.line.control || !m.bg) continue;
    const lc = hexToArgb(m.line.control);
    for (let st = bs.min; st <= bs.max; st++) {
      const d = st * bs.stepRgb;
      const lcs = brightAffects('line.control') ? shift(lc, d) : lc;
      for (const k of ['0', '1', '2', '3']) {
        if (!m.bg[k]) continue;
        const b = hexToArgb(m.bg[k]);
        const bgs = brightAffects(`bg.${k}`) ? shift(b, d) : b;
        const r = contrast(lcs, bgs);
        if (r < minR) {
          minR = r;
          minAt = `${modeName} 明るさ ${st >= 0 ? '+' : ''}${st} bg.${k}`;
        }
        if (r < 3) fails.push(`${modeName} 明るさ ${st >= 0 ? '+' : ''}${st}: line.control ${hex32(lcs)} / bg.${k} ${hex32(bgs)} = ${r.toFixed(2)}:1`);
      }
    }
  }
  if (fails.length) {
    console.error('コントラストのテストに落ちました（line.control は bg.0〜bg.3 に対して 3:1 以上）:');
    for (const f of fails) console.error('  ' + f);
    process.exit(3);
  }
  if (minR !== Infinity) console.log(`コントラスト: line.control の最小 ${minR.toFixed(2)}:1（${minAt}）`);
}

const text = L.join('\n') + '\n';
let old = null;
try {
  old = fs.readFileSync(outPath, 'utf8');
} catch {
  old = null;
}
if (checkOnly) {
  if (old !== text) {
    console.error(`src/gen/theme.um が tokens.json と合っていません。node tools/gen-theme.mjs で作り直してください。`);
    process.exit(1);
  }
  console.log('src/gen/theme.um は tokens.json と合っています。');
} else if (old !== text) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, text);
  console.log(`書きました: ${path.relative(repo, outPath)}（色 ${dark.list.length}・強調の色 ${accents.length}・文字の段階 ${ts.length}）`);
} else {
  console.log('変わっていません: src/gen/theme.um');
}
