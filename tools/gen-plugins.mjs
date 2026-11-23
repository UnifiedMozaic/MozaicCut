#!/usr/bin/env node
// 効果プラグインの登録表を作る。plugins/*.um の先頭の注釈の宣言（@effect / @param / @alias）を読み、
// src/gen/plugins.um を書く（中身が変わったときだけ）。UM には関数の値も動的なロードもないので、
// 効果の呼び出しはここで生成する switch（fxApply）にまとめる。
//
//   node tools/gen-plugins.mjs [リポジトリの場所]
//
// 宣言の書き方（docs/design/architecture.md の「効果プラグインの書き方」）:
//   // @effect <名前> "<説明>"                          名前は英小文字・数字・_。ファイル名と同じ
//   // @param <名前> <既定値> <最小>..<最大> "<説明>"    1〜8 個。書いた順に p[0], p[1], …（最初が主の引数）
//   // @alias <別名>                                   主の引数の別名（何個でも）
//   // @reach <引数> [<倍率>] [round] [max <画素>]      効果が周りへ広がる画素数（引数の値 × 倍率を切り上げ。既定の倍率 1）。
//                                                    round: 引数を四捨五入してから倍率を掛ける（効果が整数に丸めた半径を使うとき。
//                                                    blur の半径 1.5 は 2 に丸めて 2 回ぼかすので、広がりは 3 ではなく 4）。
//                                                    max: 広がりがこれを超えるときは、wasm 版を帯に分けない（足す順が帯の
//                                                    始まりで変わり、丸めが 1 ビット変わる計算に切り替わるとき。blur の窓を滑らせる計算）。
//                                                    描画は、透明なまわりのある層（画像・文字）にこの分の余白を足してから掛ける
//   // @whole                                         層の大きさ・位置を使う効果（vignette、pixelate など）。wasm 版（.mzplug）を
//                                                    横の帯に分けて並列に掛けず、層全体を 1 つのインスタンスで掛ける
// そして export function fx_<名前>(layer: mut Buffer<vec4<f32>>, tmp: mut Buffer<vec4<f32>>, w: u32, h: u32, p: f32[8]): void
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const FX_PARAMS = 8;

// プラグインの写しを置く src/gen の下のフォルダ。UM の import は「最初のファイル（src/main.um など）の
// フォルダの中」しか読めないので、plugins/*.um をそのまま（行番号も同じに）ここへ写して import する。
// 写しは生成物なので手で書き換えない。プラグインの中の import は、写しの場所（src/gen/fx/）から見た相対パスになる。
export const COPY_DIR = 'fx';

// 中身が変わったときだけ書く。書いたら true。
function writeIfChanged(file, text) {
  let old = null;
  try {
    old = fs.readFileSync(file, 'utf8');
  } catch {
    old = null;
  }
  if (old === text) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return true;
}

const NAME = '[a-z0-9_]+';
const NUM = '-?(?:\\d+(?:\\.\\d+)?|\\.\\d+)';
const STR = '"([^"\\\\]*)"';
const RE_EFFECT = new RegExp(`^@effect\\s+(${NAME})\\s+${STR}\\s*$`);
const RE_PARAM = new RegExp(`^@param\\s+(${NAME})\\s+(${NUM})\\s+(${NUM})\\.\\.(${NUM})\\s+${STR}\\s*$`);
const RE_ALIAS = new RegExp(`^@alias\\s+(${NAME})\\s*$`);
const RE_REACH = new RegExp(`^@reach\\s+(${NAME})(?:\\s+(${NUM}))?(\\s+round)?(?:\\s+max\\s+(\\d+))?\\s*$`);
const RE_WHOLE = /^@whole\s*$/;

// 宣言の誤り。ファイル名と行を付けて投げる。
function declError(file, line, msg) {
  const where = line > 0 ? `${file}:${line}` : file;
  const e = new Error(`${where}: ${msg}`);
  e.file = file;
  e.line = line;
  return e;
}

// 1 つのプラグインのファイルを読む。先頭の注釈（// で始まる行と空行が続くところ）の宣言だけを見る。
export function parsePlugin(file, text) {
  const base = path.basename(file, '.um');
  if (!new RegExp(`^${NAME}$`).test(base)) {
    throw declError(file, 0, `ファイル名 '${path.basename(file)}' は英小文字・数字・_ だけにしてください（効果の名前と同じにします）`);
  }
  const lines = text.split(/\r?\n/);
  const fx = { file, name: '', doc: '', line: 0, params: [], aliases: [], reach: null, whole: null };
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trim();
    if (raw === '') continue;
    if (!raw.startsWith('//')) break;
    const body = raw.slice(2).trim();
    if (!body.startsWith('@')) continue;
    const ln = i + 1;
    let m;
    if (body.startsWith('@effect')) {
      m = RE_EFFECT.exec(body);
      if (!m) throw declError(file, ln, `@effect の書き方が違います。'// @effect <名前> "<説明>"' と書きます（名前は英小文字・数字・_）`);
      if (fx.name !== '') throw declError(file, ln, `@effect が 2 つあります（${fx.line} 行目にもあります）。1 ファイルに 1 つの効果です`);
      if (m[1] !== base) throw declError(file, ln, `効果の名前 '${m[1]}' がファイル名 '${base}' と違います。同じにしてください`);
      fx.name = m[1];
      fx.doc = m[2];
      fx.line = ln;
    } else if (body.startsWith('@param')) {
      m = RE_PARAM.exec(body);
      if (!m) throw declError(file, ln, `@param の書き方が違います。'// @param <名前> <既定値> <最小>..<最大> "<説明>"' と書きます（例: // @param radius 0.75 0..2 "半径"）`);
      const [, name, d, lo, hi, doc] = m;
      const p = { name, def: Number(d), min: Number(lo), max: Number(hi), doc, line: ln };
      if (fx.params.some((q) => q.name === name)) throw declError(file, ln, `引数 '${name}' が重複しています`);
      if (!(p.min <= p.max)) throw declError(file, ln, `範囲 ${lo}..${hi} の最小が最大より大きくなっています`);
      if (p.def < p.min || p.def > p.max) throw declError(file, ln, `既定値 ${d} が範囲 ${lo}..${hi} の外です`);
      if (fx.params.length >= FX_PARAMS) throw declError(file, ln, `引数は ${FX_PARAMS} 個までです`);
      fx.params.push(p);
    } else if (body.startsWith('@alias')) {
      m = RE_ALIAS.exec(body);
      if (!m) throw declError(file, ln, `@alias の書き方が違います。'// @alias <別名>' と書きます（英小文字・数字・_）`);
      if (fx.aliases.some((a) => a.name === m[1])) throw declError(file, ln, `別名 '${m[1]}' が重複しています`);
      fx.aliases.push({ name: m[1], line: ln });
    } else if (body.startsWith('@reach')) {
      m = RE_REACH.exec(body);
      if (!m) throw declError(file, ln, `@reach の書き方が違います。'// @reach <引数> [<倍率>] [round] [max <画素>]' と書きます（例: // @reach radius 2 round）`);
      if (fx.reach) throw declError(file, ln, `@reach が 2 つあります（${fx.reach.line} 行目にもあります）`);
      fx.reach = { param: m[1], factor: m[2] === undefined ? 1 : Number(m[2]), round: !!m[3], max: m[4] === undefined ? null : Number(m[4]), line: ln };
    } else if (body.startsWith('@whole')) {
      if (!RE_WHOLE.test(body)) throw declError(file, ln, `@whole の書き方が違います。'// @whole' とだけ書きます`);
      if (fx.whole) throw declError(file, ln, `@whole が 2 つあります（${fx.whole.line} 行目にもあります）`);
      fx.whole = { line: ln };
    } else {
      const word = body.split(/\s/)[0];
      throw declError(file, ln, `知らない宣言 '${word}' です（@effect / @param / @alias / @reach / @whole のどれかです）`);
    }
  }
  if (fx.name === '') {
    throw declError(file, 0, `先頭の注釈に '// @effect ${base} "<説明>"' がありません`);
  }
  // 引数のない効果は、行に "name" と書いても値を入れる引数がなく有効にできないので、受け付けない。
  if (fx.params.length === 0) {
    throw declError(file, fx.line, `効果 '${fx.name}' に @param がありません。引数は 1 つ以上要ります（最初の引数が "${fx.name}=値" で入る主の引数です）`);
  }
  for (const a of fx.aliases) {
    if (a.name === fx.name) throw declError(file, a.line, `別名 '${a.name}' が効果の名前と同じです`);
  }
  if (fx.reach) {
    fx.reach.index = fx.params.findIndex((p) => p.name === fx.reach.param);
    if (fx.reach.index < 0) throw declError(file, fx.reach.line, `@reach の引数 '${fx.reach.param}' は @param にありません`);
    if (!(fx.reach.factor >= 0)) throw declError(file, fx.reach.line, `@reach の倍率は 0 以上にします`);
  }
  const fnRe = new RegExp(`^\\s*export\\s+function\\s+fx_${fx.name}\\s*\\(`, 'm');
  if (!fnRe.test(text)) {
    throw declError(file, fx.line, `'export function fx_${fx.name}(layer: mut Buffer<vec4<f32>>, tmp: mut Buffer<vec4<f32>>, w: u32, h: u32, p: f32[8]): void' がありません`);
  }
  return fx;
}

// コアのキーの名前（src/engine/keys.um の keysAdd(mut out, "<名前>", ...) から抜き出す）。行の読み取りはコアのキーを
// 先に引くので、同じ名前の効果は黙って使えなくなる。keys.um がなければ空（ぶつかりは確かめない）。
export function coreKeyNames(rootDir) {
  let text;
  try {
    text = fs.readFileSync(path.join(rootDir, 'src', 'engine', 'keys.um'), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return new Set();
    throw err;
  }
  const names = new Set();
  for (const m of text.matchAll(/keysAdd\(\s*mut\s+out\s*,\s*"([^"]+)"/g)) names.add(m[1]);
  // keys.um が表ごと足す部品のキー（shape の行の形のキー。src/effects/shape/shape_spec.um の shKey(mut o, "<名前>", ...)）
  try {
    const shape = fs.readFileSync(path.join(rootDir, 'src', 'effects', 'shape', 'shape_spec.um'), 'utf8');
    for (const m of shape.matchAll(/shKey\(\s*mut\s+o\s*,\s*"([^"]+)"/g)) names.add(m[1]);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  // 3D のキー（src/effects/threed/t3parse.um の t3KeyAdd(mut out, "<名前>", ...)）
  try {
    const t3 = fs.readFileSync(path.join(rootDir, 'src', 'effects', 'threed', 't3parse.um'), 'utf8');
    for (const m of t3.matchAll(/t3KeyAdd\(\s*mut\s+out\s*,\s*"([^"]+)"/g)) names.add(m[1]);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  // particles の行のキー（src/effects/particles/particles.um の ptKeyAdd(mut o, "<名前>", ...)）
  try {
    const pt = fs.readFileSync(path.join(rootDir, 'src', 'effects', 'particles', 'particles.um'), 'utf8');
    for (const m of pt.matchAll(/ptKeyAdd\(\s*mut\s+o\s*,\s*"([^"]+)"/g)) names.add(m[1]);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  return names;
}

// ファイルどうしの名前のぶつかり（効果の名前と別名は、キーとして同じ空間にある）と、コアのキーとのぶつかり。
function checkNames(effects, reserved = new Set()) {
  const seen = new Map();   // 名前 → { file, line, what }
  const claim = (name, file, line, what) => {
    const prev = seen.get(name);
    if (prev) {
      throw declError(file, line, `${what} '${name}' は ${prev.file}:${prev.line} の${prev.what}とぶつかります`);
    }
    if (reserved.has(name)) {
      throw declError(file, line, `'${name}' はコアのキー（src/engine/keys.um）なので${what}に使えません`);
    }
    seen.set(name, { file, line, what });
  };
  for (const fx of effects) claim(fx.name, fx.file, fx.line, '効果の名前');
  for (const fx of effects) for (const a of fx.aliases) claim(a.name, fx.file, a.line, '別名');
}

function umStr(s) {
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

function umNum(v) {
  return String(v);
}

// 効果の番号 e で分ける関数を作る。body(fx) は case の中身（return 文）を返す。
function switchOnEffect(effects, sig, body, fallback) {
  let s = `export function ${sig} {\n`;
  if (effects.length > 0) {
    s += '  switch (e) {\n';
    effects.forEach((fx, e) => {
      s += `    case ${e}: {\n${body(fx)}    }\n`;
    });
    s += '  }\n';
  }
  s += `  return ${fallback};\n}\n`;
  return s;
}

// 引数の番号 k で分ける case の中身。
function onParam(fx, value, fallback) {
  let s = '';
  fx.params.forEach((p, k) => {
    s += `      if (k == ${k}) {\n        return ${value(p)};\n      }\n`;
  });
  s += `      return ${fallback};\n`;
  return s;
}

export function render(effects, coreKeys = new Set()) {
  let s = '';
  s += '// 自動生成されるプラグインの登録表（tools/gen-plugins.mjs が plugins/*.um から作る）。手で書き換えない。\n';
  s += `// ./${COPY_DIR}/*.um は plugins/*.um の写し（行番号も同じ）。コンパイルの誤りが写しを指したら、plugins/ の方を直す。\n`;
  s += `// 効果: ${effects.length === 0 ? 'なし' : effects.map((f) => f.name).join(', ')}\n`;
  for (const fx of effects) {
    s += `import { fx_${fx.name} } from "./${COPY_DIR}/${fx.name}.um";\n`;
  }
  s += 'import { WasmFxSet, WasmFxParam, wasmFxEmpty, wasmFxLoad, wasmFxDiscover, wasmFxApply, wasmFxReach, wasmFxSetTimeout, WASMFX_PREVIEW_TIMEOUT_MS } from "../effects/wasmfx.um";\n';
  s += '\n';
  s += `export const FX_PARAMS: i32 = ${FX_PARAMS};\n\n`;
  s += '// 効果と引数の番号。見つからなければ effect = -1, param = -1。\n';
  s += 'export struct FxKey {\n  effect: i32;\n  param: i32;\n}\n\n';
  s += `export function fxCount(): i32 {\n  return ${effects.length};\n}\n\n`;
  s += switchOnEffect(effects, 'fxName(e: i32): string', (fx) => `      return ${umStr(fx.name)};\n`, '""') + '\n';
  s += switchOnEffect(effects, 'fxDoc(e: i32): string', (fx) => `      return ${umStr(fx.doc)};\n`, '""') + '\n';
  s += switchOnEffect(effects, 'fxParamCount(e: i32): i32', (fx) => `      return ${fx.params.length};\n`, '0') + '\n';
  s += switchOnEffect(effects, 'fxParamName(e: i32, k: i32): string', (fx) => onParam(fx, (p) => umStr(p.name), '""'), '""') + '\n';
  s += switchOnEffect(effects, 'fxParamDoc(e: i32, k: i32): string', (fx) => onParam(fx, (p) => umStr(p.doc), '""'), '""') + '\n';
  s += switchOnEffect(effects, 'fxParamDefault(e: i32, k: i32): f32', (fx) => onParam(fx, (p) => umNum(p.def), '0'), '0') + '\n';
  s += switchOnEffect(effects, 'fxParamMin(e: i32, k: i32): f32', (fx) => onParam(fx, (p) => umNum(p.min), '0'), '0') + '\n';
  s += switchOnEffect(effects, 'fxParamMax(e: i32, k: i32): f32', (fx) => onParam(fx, (p) => umNum(p.max), '0'), '0') + '\n';
  s += '// 効果 e の別名（@alias）の数と、i 番目の別名。別名は主の引数を決め、"<別名>.<引数>" とも書ける。\n';
  s += switchOnEffect(effects, 'fxAliasCount(e: i32): i32', (fx) => `      return ${fx.aliases.length};\n`, '0') + '\n';
  s += switchOnEffect(effects, 'fxAlias(e: i32, i: i32): string', (fx) => {
    let b = '';
    fx.aliases.forEach((a, i) => {
      b += `      if (i == ${i}) {\n        return ${umStr(a.name)};\n      }\n`;
    });
    return b + '      return "";\n';
  }, '""') + '\n';

  // キーの表: "name"（主の引数）、"name.param"、別名と "別名.param"。効果はどれも引数を 1 つ以上持つ。
  const keys = [];
  effects.forEach((fx, e) => {
    const heads = [fx.name, ...fx.aliases.map((a) => a.name)];
    for (const h of heads) {
      keys.push([h, e, 0]);
      fx.params.forEach((p, k) => keys.push([`${h}.${p.name}`, e, k]));
    }
  });
  s += '// 効果 e が周りへ広がる画素数（@reach）。宣言がなければ 0。\n';
  s += switchOnEffect(effects, 'fxReach(e: i32, params: f32[8]): i32', (fx) => {
    if (!fx.reach) return '      return 0;\n';
    const f = Number.isInteger(fx.reach.factor) ? fx.reach.factor + '.0' : String(fx.reach.factor);
    // src/effects/wasmfx.um の wasmFxReach と同じ式（f32）
    if (fx.reach.round) return `      return Math.ceil(Math.floor(Math.max(params[${fx.reach.index}], 0.0) + 0.5) * ${f}) as i32;\n`;
    return `      return Math.ceil(Math.max(params[${fx.reach.index}], 0.0) * ${f}) as i32;\n`;
  }, '0') + '\n';
  s += '// "blur" → (blur, 0)、"vignette.radius" → (vignette, 1)、別名（"saturation" → (sat, 0)）も。\n';
  s += '// 見つからなければ effect = -1, param = -1。\n';
  s += 'export function fxFindKey(key: string): FxKey {\n';
  if (keys.length > 0) {
    s += '  switch (key) {\n';
    for (const [k, e, p] of keys) {
      s += `    case ${umStr(k)}:\n      return { effect: ${e}, param: ${p} };\n`;
    }
    s += '  }\n';
  }
  s += '  return { effect: -1, param: -1 };\n}\n\n';

  s += '// 効果 e を層に掛ける。結果は layer に残す。tmp は同じ大きさの作業用。知らない e では何もしない。\n';
  s += 'export function fxApply(e: i32, layer: mut Buffer<vec4<f32>>, tmp: mut Buffer<vec4<f32>>, w: u32, h: u32, params: f32[8]): void {\n';
  if (effects.length > 0) {
    s += '  switch (e) {\n';
    effects.forEach((fx, e) => {
      s += `    case ${e}:\n      fx_${fx.name}(mut layer, mut tmp, w, h, params);\n      break;\n`;
    });
    s += '  }\n';
  }
  s += '}\n\n';
  s += registryText(effects, coreKeys);
  return s;
}

// 登録表（FxReg）: 組み込みの効果（番号 0 .. FX_BUILTIN_COUNT-1）の後ろに、起動時に読み込んだ .mzplug の効果
// （src/effects/wasmfx.um）を続けて、同じ番号の空間で扱う。UM にはグローバル変数がないので、読み込んだ効果は FxReg の値として
// 持ち、呼ぶ側が渡す（上の fxCount() などの関数は組み込みの効果だけを数える。移行のために残してある）。
function registryText(effects, coreKeys) {
  const reserved = [...new Set([
    ...effects.flatMap((fx) => [fx.name, ...fx.aliases.map((a) => a.name)]),
    ...[...coreKeys].sort(),
  ])];
  return `// ---- 登録表（組み込みの効果と .mzplug の効果） ----

// 組み込みの効果の数。番号がこれ以上の効果は .mzplug（wasm）。
export const FX_BUILTIN_COUNT: i32 = ${effects.length};

// .mzplug の効果の名前・別名に使えない名前（組み込みの効果の名前と別名、コアのキー）。
export function fxReservedNames(): string[] {
  return [${reserved.map(umStr).join(', ')}];
}

// 効果の登録表。fxRegBuiltin()（組み込みだけ）か fxRegLoad(paths)（.mzplug も読み込む）で 1 度だけ作り、呼ぶ側が渡す。
// 番号 e は 0 .. count()-1。組み込みの効果が先で、.mzplug の効果は読み込んだ順に後ろへ続く（番号は決め打ちせず findKey で引く）。
export class FxReg {
  wasm: WasmFxSet;
  bands: i32 = 0;   // .mzplug の効果を分ける帯の数（0 は自動、1 は分けない）

  constructor(wasm: own WasmFxSet) {
    this.wasm = wasm;
  }

  count(): i32 {
    return FX_BUILTIN_COUNT + (this.wasm.fx.length as i32);
  }

  // 効果 e が .mzplug（wasm）か。
  isWasm(e: i32): bool {
    return e >= FX_BUILTIN_COUNT && e < this.count();
  }

  // 効果 e の出どころ: 組み込みなら "builtin"、.mzplug ならそのファイルの場所。知らない e は ""。
  source(e: i32): string {
    if (e >= 0 && e < FX_BUILTIN_COUNT) {
      return "builtin";
    }
    if (this.isWasm(e)) {
      return this.wasm.fx[(e - FX_BUILTIN_COUNT) as usize].path.clone();
    }
    return "";
  }

  name(e: i32): string {
    if (this.isWasm(e)) {
      return this.wasm.fx[(e - FX_BUILTIN_COUNT) as usize].name.clone();
    }
    return fxName(e);
  }

  doc(e: i32): string {
    if (this.isWasm(e)) {
      return this.wasm.fx[(e - FX_BUILTIN_COUNT) as usize].doc.clone();
    }
    return fxDoc(e);
  }

  paramCount(e: i32): i32 {
    if (this.isWasm(e)) {
      return this.wasm.fx[(e - FX_BUILTIN_COUNT) as usize].params.length as i32;
    }
    return fxParamCount(e);
  }

  paramName(e: i32, k: i32): string {
    if (this.isWasm(e)) {
      const w = (e - FX_BUILTIN_COUNT) as usize;
      if (k >= 0 && (k as usize) < this.wasm.fx[w].params.length) {
        return this.wasm.fx[w].params[k as usize].name.clone();
      }
      return "";
    }
    return fxParamName(e, k);
  }

  paramDoc(e: i32, k: i32): string {
    if (this.isWasm(e)) {
      const w = (e - FX_BUILTIN_COUNT) as usize;
      if (k >= 0 && (k as usize) < this.wasm.fx[w].params.length) {
        return this.wasm.fx[w].params[k as usize].doc.clone();
      }
      return "";
    }
    return fxParamDoc(e, k);
  }

  paramDefault(e: i32, k: i32): f32 {
    if (this.isWasm(e)) {
      const w = (e - FX_BUILTIN_COUNT) as usize;
      if (k >= 0 && (k as usize) < this.wasm.fx[w].params.length) {
        return this.wasm.fx[w].params[k as usize].def;
      }
      return 0;
    }
    return fxParamDefault(e, k);
  }

  paramMin(e: i32, k: i32): f32 {
    if (this.isWasm(e)) {
      const w = (e - FX_BUILTIN_COUNT) as usize;
      if (k >= 0 && (k as usize) < this.wasm.fx[w].params.length) {
        return this.wasm.fx[w].params[k as usize].min;
      }
      return 0;
    }
    return fxParamMin(e, k);
  }

  paramMax(e: i32, k: i32): f32 {
    if (this.isWasm(e)) {
      const w = (e - FX_BUILTIN_COUNT) as usize;
      if (k >= 0 && (k as usize) < this.wasm.fx[w].params.length) {
        return this.wasm.fx[w].params[k as usize].max;
      }
      return 0;
    }
    return fxParamMax(e, k);
  }

  aliasCount(e: i32): i32 {
    if (this.isWasm(e)) {
      return this.wasm.fx[(e - FX_BUILTIN_COUNT) as usize].aliases.length as i32;
    }
    return fxAliasCount(e);
  }

  alias(e: i32, i: i32): string {
    if (this.isWasm(e)) {
      const w = (e - FX_BUILTIN_COUNT) as usize;
      if (i >= 0 && (i as usize) < this.wasm.fx[w].aliases.length) {
        return this.wasm.fx[w].aliases[i as usize].clone();
      }
      return "";
    }
    return fxAlias(e, i);
  }

  // 効果 e が周りへ広がる画素数（@reach）。
  reach(e: i32, params: f32[8]): i32 {
    if (this.isWasm(e)) {
      return wasmFxReach(this.wasm.fx[(e - FX_BUILTIN_COUNT) as usize], params);
    }
    return fxReach(e, params);
  }

  // "blur" → (blur, 0)、"vignette.radius" → (vignette, 1)、別名も。.mzplug の効果も引く。見つからなければ (-1, -1)。
  findKey(key: string): FxKey {
    const b = fxFindKey(key);
    if (b.effect >= 0) {
      return b;
    }
    for (let w: usize = 0; w < this.wasm.fx.length; w++) {
      const e = FX_BUILTIN_COUNT + (w as i32);
      if (fxRegKeyHead(key, this.wasm.fx[w].name)) {
        return fxRegKeyParam(key, this.wasm.fx[w].name, this.wasm.fx[w].params, e);
      }
      for (const a of this.wasm.fx[w].aliases) {
        if (fxRegKeyHead(key, a)) {
          return fxRegKeyParam(key, a, this.wasm.fx[w].params, e);
        }
      }
    }
    return { effect: -1, param: -1 };
  }

  // 効果 e を層に掛ける。結果は layer に残す。tmp は同じ大きさの作業用（組み込みの効果だけが使う）。
  // 成功（と知らない e）なら ""。.mzplug の効果が失敗したら（トラップ・時間切れなど）理由の文を返し、layer は変えない。
  apply(e: i32, layer: mut Buffer<vec4<f32>>, tmp: mut Buffer<vec4<f32>>, w: u32, h: u32, params: f32[8]): string {
    if (this.isWasm(e)) {
      return wasmFxApply(this.wasm.fx[(e - FX_BUILTIN_COUNT) as usize], mut layer, w, h, params, this.bands);
    }
    fxApply(e, mut layer, mut tmp, w, h, params);
    return "";
  }
}

// key が head そのものか、head + "." で始まるか。
function fxRegKeyHead(key: string, head: string): bool {
  if (key.length < head.length) {
    return false;
  }
  for (let i: usize = 0; i < head.length; i++) {
    if (key[i] != head[i]) {
      return false;
    }
  }
  return key.length == head.length || key[head.length] == 46;
}

// fxRegKeyHead(key, head) が真のとき: "head" → (e, 0)、"head.param" → (e, その番号)。引数がなければ (-1, -1)。
function fxRegKeyParam(key: string, head: string, params: WasmFxParam[], e: i32): FxKey {
  if (key.length == head.length) {
    return { effect: e, param: 0 };
  }
  for (let k: usize = 0; k < params.length; k++) {
    if (key.length == head.length + 1 + params[k].name.length) {
      let same = true;
      for (let i: usize = 0; i < params[k].name.length; i++) {
        if (key[head.length + 1 + i] != params[k].name[i]) {
          same = false;
        }
      }
      if (same) {
        return { effect: e, param: k as i32 };
      }
    }
  }
  return { effect: -1, param: -1 };
}

// 組み込みの効果だけの登録表。
export function fxRegBuiltin(): FxReg {
  let set = wasmFxEmpty();
  return new FxReg(own set);
}

// 組み込みの効果に、.mzplug の効果（paths の順）を足した登録表。読めない包み・名前のぶつかる包みは飛ばし、
// 理由を reg.wasm.diags（code "bad-plugin"）に入れる。止まらない。
export function fxRegLoad(paths: string[]): FxReg {
  let set = wasmFxEmpty();
  const reserved = fxReservedNames();
  for (const p of paths) {
    wasmFxLoad(mut set, p, reserved);
  }
  return new FxReg(own set);
}

// 既定のフォルダ（plugins-installed/ と extra で渡されたフォルダ・index.txt・.mzplug）から .mzplug を自動で探して読み込む。
export function fxRegDiscover(extra: string[]): FxReg {
  let sources: string[] = ["plugins-installed", "plugins"];
  for (const s of extra) {
    if (s.length > 0) {
      sources.push(s.clone());
    }
  }
  return fxRegLoad(wasmFxDiscover(sources));
}

// 編集画面のプレビュー用に、.mzplug の 1 回の実行時間の上限を短くする。
export function fxRegSetPreviewTimeout(reg: FxReg): void {
  for (const f of reg.wasm.fx) {
    wasmFxSetTimeout(f, WASMFX_PREVIEW_TIMEOUT_MS);
  }
}
`;
}

// 写しの終わりに足す注釈（行番号を変えないよう、末尾にだけ足す）。
function copyText(fx, text) {
  const sep = text.endsWith('\n') ? '' : '\n';
  return `${text}${sep}// ---- この写しは tools/gen-plugins.mjs が ${fx.file} から作る。ここを直しても次の生成で消える。直すのは ${fx.file}。\n`;
}

// コンパイラの診断の中の写しの場所（src/gen/fx/<名前>.um。main.um から見た gen/fx/<名前>.um も）を、元のプラグイン（plugins/<名前>.um）に直す。
// 写しは行番号が同じなので、行と列はそのまま対応する。区切りは / と \ のどちらでもよい。
export function mapDiagnostics(text) {
  return String(text).replace(/(?:[^\s'"`()]*[\\/])?gen[\\/]fx[\\/]([a-z0-9_]+\.um)/g, 'plugins/$1');
}

// rootDir の plugins/*.um を読み、src/gen/plugins.um を書く。
// 戻り値: { path, changed, effects: [名前...] }。宣言の誤りは例外（message に「ファイル:行: 説明」）。
// rootDir に src/ がないとき（場所の打ち間違いなど）と、plugins/ がないときは例外にする（写しを黙って消さないため）。
// plugins/ があって中が空なら、効果 0 個の登録表を書く。
export function generate(rootDir) {
  if (!fs.existsSync(path.join(rootDir, 'src'))) {
    throw new Error(`${rootDir} に src/ がありません。MozaicCut のリポジトリの場所を渡してください`);
  }
  const pluginDir = path.join(rootDir, 'plugins');
  let names = [];
  try {
    names = fs.readdirSync(pluginDir).filter((n) => n.endsWith('.um')).sort();
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error(`${pluginDir} がありません（効果のないビルドにするなら、空の plugins/ を置きます）`);
    }
    throw err;
  }
  const texts = new Map();
  const effects = names.map((n) => {
    const rel = `plugins/${n}`;
    const text = fs.readFileSync(path.join(pluginDir, n), 'utf8');
    const fx = parsePlugin(rel, text);
    texts.set(fx.name, text);
    return fx;
  });
  const coreKeys = coreKeyNames(rootDir);
  checkNames(effects, coreKeys);
  const genDir = path.join(rootDir, 'src', 'gen');
  const copyDir = path.join(genDir, COPY_DIR);
  let changed = false;
  // 写し: 新しいもの・変わったものを書き、もうないプラグインの写しを消す
  for (const fx of effects) {
    if (writeIfChanged(path.join(copyDir, `${fx.name}.um`), copyText(fx, texts.get(fx.name)))) changed = true;
  }
  let stale = [];
  try {
    stale = fs.readdirSync(copyDir).filter((n) => n.endsWith('.um') && !texts.has(n.slice(0, -3)));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  for (const n of stale) {
    fs.unlinkSync(path.join(copyDir, n));
    changed = true;
  }
  const outPath = path.join(genDir, 'plugins.um');
  if (writeIfChanged(outPath, render(effects, coreKeys))) changed = true;
  return { path: outPath, changed, effects: effects.map((f) => f.name) };
}

// ---- wasm のプラグイン（.mzplug） ----
//
// 同じ plugins/<名前>.um から、組み込み版（上の写しと登録表）と wasm 版（.mzplug）を作る。.mzplug は、UM の
// --target wasm32-plugin で作った wasm のモジュールの終わりに、カスタムセクション mozaiccut.manifest（宣言の JSON）を
// 足したもの。読み込むのは src/effects/wasmfx.um。

export const MANIFEST_SECTION = 'mozaiccut.manifest';
// 宣言の形の版（src/effects/wasmfx.um の WASMFX_ABI と同じ）。入口の形や層の形を変えたら上げる。
export const PLUGIN_ABI = 1;
// wasm の入口の関数の名前（生成する包みが export する）。
export const WASM_ENTRY = 'mzfx_apply';
// 作業のフォルダ（build/plugin/<名前>/）と、できた .mzplug の置き場所（dist/）。
export const PLUGIN_WORK_DIR = path.join('build', 'plugin');
export const PLUGIN_DIST_DIR = 'dist';

// 宣言（@effect / @param / @alias / @reach / @whole）を JSON の形にする。src/effects/wasmfx.um の wfManifest が読む。
export function manifestOf(fx, extra = {}) {
  return {
    abi: PLUGIN_ABI,
    name: fx.name,
    doc: fx.doc,
    entry: WASM_ENTRY,
    params: fx.params.map((p) => ({ name: p.name, default: p.def, min: p.min, max: p.max, doc: p.doc })),
    aliases: fx.aliases.map((a) => a.name),
    reach: fx.reach ? { param: fx.reach.param, factor: fx.reach.factor, round: fx.reach.round, max: fx.reach.max } : null,
    whole: !!fx.whole,
    layer: 'rgba-f32-straight',
    ...extra,
  };
}

// wasm の入口の包み（build/plugin/<名前>/main.um）。--target wasm32-plugin の export は数と Buffer しか受け取れないので、
// 引数の f32[8] を 8 つの f32 に開き、効果の関数（fx_<名前>）に渡す。
export function wasmEntryText(fx) {
  const ps = Array.from({ length: FX_PARAMS }, (_, k) => `p${k}`);
  return `// 自動生成される .mzplug の入口（tools/gen-plugins.mjs が ${fx.file} から作る）。手で書き換えない。
// --target wasm32-plugin の export は、Buffer を (バイトの位置, 要素の数) で、引数を数で受け取る（docs/wasm.ja.md）。
import { fx_${fx.name} } from "./${COPY_DIR}/${fx.name}.um";

export function ${WASM_ENTRY}(layer: mut Buffer<vec4<f32>>, tmp: mut Buffer<vec4<f32>>, w: u32, h: u32, ${ps.map((p) => `${p}: f32`).join(', ')}): void {
  const p: f32[${FX_PARAMS}] = [${ps.join(', ')}];
  fx_${fx.name}(mut layer, mut tmp, w, h, p);
}
`;
}

function leb128(n) {
  const out = [];
  do {
    let b = n & 0x7f;
    n >>>= 7;
    if (n !== 0) b |= 0x80;
    out.push(b);
  } while (n !== 0);
  return out;
}

function readLeb(bytes, at) {
  let v = 0;
  let shift = 0;
  for (;;) {
    if (at >= bytes.length || shift > 28) return null;
    const b = bytes[at++];
    v |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) return { v: v >>> 0, at };
    shift += 7;
  }
}

function isWasm(bytes) {
  return bytes.length >= 8 && bytes[0] === 0 && bytes[1] === 0x61 && bytes[2] === 0x73 && bytes[3] === 0x6d;
}

// セクションの一覧（[{ id, start, end, name?, payloadStart? }]）。壊れていれば null。
function sections(bytes) {
  if (!isWasm(bytes)) return null;
  const out = [];
  let at = 8;
  while (at < bytes.length) {
    const start = at;
    const id = bytes[at++];
    const size = readLeb(bytes, at);
    if (!size) return null;
    const end = size.at + size.v;
    if (end > bytes.length) return null;
    const s = { id, start, end };
    if (id === 0) {
      const nl = readLeb(bytes, size.at);
      if (!nl || nl.at + nl.v > end) return null;
      s.name = Buffer.from(bytes.subarray(nl.at, nl.at + nl.v)).toString('utf8');
      s.payloadStart = nl.at + nl.v;
    }
    out.push(s);
    at = end;
  }
  return out;
}

function removeCustomSection(bytes, name) {
  const secs = sections(bytes);
  if (!secs) return bytes;
  const keep = [bytes.subarray(0, 8)];
  for (const s of secs) if (!(s.id === 0 && s.name === name)) keep.push(bytes.subarray(s.start, s.end));
  return Buffer.concat(keep);
}

// wasm のバイナリの終わりにカスタムセクション（名前 name、中身 payload）を足す。同じ名前のセクションがあれば外してから足す。
export function setCustomSection(wasm, name, payload) {
  const base = removeCustomSection(Buffer.from(wasm), name);
  const nameBytes = Buffer.from(name, 'utf8');
  const body = Buffer.concat([Buffer.from(leb128(nameBytes.length)), nameBytes, Buffer.from(payload)]);
  return Buffer.concat([base, Buffer.from([0]), Buffer.from(leb128(body.length)), body]);
}

// カスタムセクション name の中身（最初のもの）。なければ null。wasm でなければ例外。
export function readCustomSection(bytes, name) {
  const secs = sections(bytes);
  if (!secs) throw new Error('wasm のモジュールではないか、壊れています');
  const s = secs.find((x) => x.id === 0 && x.name === name);
  return s ? Buffer.from(bytes.subarray(s.payloadStart, s.end)) : null;
}

// 宣言の JSON を読む（src/effects/wasmfx.um の wjValue と同じ決まり: 入れ子は 32 段まで、オブジェクトのキーの重複は誤り）。
// JSON.parse は重複したキーの後ろを使い、深い入れ子も読むので、エンジンと意味が食い違わないように自分で読む。
function parseManifestJson(text) {
  let at = 0;
  const fail = (msg) => { throw new Error(`${msg}（${at} 文字目）`); };
  const skip = () => { while (at < text.length && ' \t\r\n'.includes(text[at])) at++; };
  const str = () => {
    const m = /^"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/.exec(text.slice(at));
    if (!m) fail('文字列が読めません');
    at += m[0].length;
    return JSON.parse(m[0]);
  };
  const value = (depth) => {
    skip();
    if (depth > 32) fail('入れ子が深すぎます');
    if (at >= text.length) fail('値がありません');
    const c = text[at];
    if (c === '"') return str();
    if (c === '{') {
      at++;
      const o = {};
      const seen = new Set();
      skip();
      if (text[at] === '}') { at++; return o; }
      for (;;) {
        skip();
        if (text[at] !== '"') fail('キー（"..."）がありません');
        const key = str();
        if (seen.has(key)) fail(`キー '${key}' が重複しています`);
        seen.add(key);
        skip();
        if (text[at] !== ':') fail(': がありません');
        at++;
        Object.defineProperty(o, key, { value: value(depth + 1), enumerable: true, writable: true, configurable: true });
        skip();
        if (text[at] === ',') { at++; continue; }
        if (text[at] === '}') { at++; return o; }
        fail(', か } がありません');
      }
    }
    if (c === '[') {
      at++;
      const a = [];
      skip();
      if (text[at] === ']') { at++; return a; }
      for (;;) {
        a.push(value(depth + 1));
        skip();
        if (text[at] === ',') { at++; continue; }
        if (text[at] === ']') { at++; return a; }
        fail(', か ] がありません');
      }
    }
    for (const [w, v] of [['true', true], ['false', false], ['null', null]]) {
      if (text.startsWith(w, at)) { at += w.length; return v; }
    }
    const m = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(at));
    if (!m) fail('値が読めません');
    at += m[0].length;
    return Number(m[0]);
  };
  const v = value(0);
  skip();
  if (at < text.length) fail('JSON の後ろに余分なものがあります');
  return v;
}

// エンジンの f32 に入る数か（wfNumOk と同じ）。
const numOk = (v) => typeof v === 'number' && Number.isFinite(v) && v < 3.0e38 && v > -3.0e38;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// .mzplug の中身から宣言を読んで確かめる（src/effects/wasmfx.um の wfManifest・wfCheckExports・読み込みのときの試しの
// インスタンスと同じ決まり）。誤りは例外。plugin install / list が使う。
export function readManifest(bytes) {
  const sec = readCustomSection(bytes, MANIFEST_SECTION);
  if (!sec) throw new Error(`宣言（カスタムセクション ${MANIFEST_SECTION}）がありません`);
  let m;
  try {
    m = parseManifestJson(sec.toString('utf8'));
  } catch (e) {
    throw new Error(`宣言の JSON が読めません: ${e.message}`);
  }
  const nameRe = new RegExp(`^${NAME}$`);
  const isName = (s) => typeof s === 'string' && s.length <= 64 && nameRe.test(s);
  if (!isObj(m)) throw new Error('宣言がオブジェクトではありません');
  if (!('abi' in m)) throw new Error('宣言に "abi"（形の版）がありません');
  if (typeof m.abi !== 'number') throw new Error('宣言の "abi"（形の版）は数で書きます（"1" のような文字列ではなく 1）');
  if (m.abi !== PLUGIN_ABI) throw new Error(`宣言の形の版（abi ${m.abi}）に対応していません（この MozaicCut は ${PLUGIN_ABI}）`);
  if (typeof m.name !== 'string') throw new Error('宣言に "name"（効果の名前）がありません');
  if (!isName(m.name)) throw new Error(`効果の名前 '${m.name}' は英小文字・数字・_ だけにします`);
  const entry = typeof m.entry === 'string' ? m.entry : WASM_ENTRY;
  if (!Array.isArray(m.params)) throw new Error('宣言に "params"（引数の配列）がありません');
  if (m.params.length < 1 || m.params.length > FX_PARAMS) throw new Error(`引数は 1〜${FX_PARAMS} 個です（${m.params.length} 個あります）`);
  const seen = new Set();
  for (const p of m.params) {
    if (!isObj(p) || !isName(p.name)) throw new Error('引数の "name" がないか、英小文字・数字・_ ではありません');
    if (![p.default, p.min, p.max].every(numOk)) throw new Error(`引数 '${p.name}' の "default" / "min" / "max" が数ではありません`);
    if (!(p.min <= p.max)) throw new Error(`引数 '${p.name}' の範囲 ${p.min}..${p.max} の最小が最大より大きくなっています`);
    if (p.default < p.min || p.default > p.max) throw new Error(`引数 '${p.name}' の既定値 ${p.default} が範囲 ${p.min}..${p.max} の外です`);
    if (seen.has(p.name)) throw new Error(`引数 '${p.name}' が重複しています`);
    seen.add(p.name);
  }
  if (m.aliases !== undefined) {
    if (!Array.isArray(m.aliases)) throw new Error('"aliases" が配列ではありません');
    const al = new Set();
    for (const a of m.aliases) {
      if (!isName(a) || a === m.name) throw new Error('別名（aliases）は効果の名前と違う、英小文字・数字・_ の文字列にします');
      if (al.has(a)) throw new Error(`別名 '${a}' が重複しています`);
      al.add(a);
    }
  }
  if (m.reach !== undefined && m.reach !== null) {
    const r = m.reach;
    if (!isObj(r) || typeof r.param !== 'string' || r.param.length === 0 || !numOk(r.factor) || r.factor < 0) {
      throw new Error('"reach" は {"param": 引数の名前, "factor": 0 以上の数} にします');
    }
    if (!seen.has(r.param)) throw new Error(`"reach" の引数 '${r.param}' は params にありません`);
    if (r.round !== undefined && typeof r.round !== 'boolean') throw new Error('"reach" の "round" は true か false にします');
    if (r.max !== undefined && r.max !== null && !(numOk(r.max) && r.max >= 0 && r.max <= 1e6 && Number.isInteger(r.max))) {
      throw new Error('"reach" の "max" は 0 以上の整数（画素）か null にします');
    }
  }
  if (m.whole !== undefined && typeof m.whole !== 'boolean') throw new Error('"whole" は true か false にします（"yes" のような文字列は使えません）');
  // wasm の形（エンジンの wfCheckExports と、読み込みのときに作る試しのインスタンス）。import を要るものは作れない
  let mod;
  try {
    mod = new WebAssembly.Module(bytes);
  } catch (e) {
    throw new Error(`wasm をコンパイルできません: ${e.message}`);
  }
  const imports = WebAssembly.Module.imports(mod);
  if (imports.length > 0) throw new Error(`import を要ります（${imports.map((i) => `${i.module}.${i.name}`).slice(0, 3).join(', ')}）。UM の --target wasm32-plugin で作った包みではありません`);
  const ex = new Map(WebAssembly.Module.exports(mod).map((e) => [e.name, e.kind]));
  if (![...ex.values()].includes('memory')) throw new Error('メモリ（memory）を export していません');
  if (ex.get('umAlloc') !== 'function' || ex.get('umFree') !== 'function') throw new Error('umAlloc / umFree を export していません（UM の --target wasm32-plugin で作った包みではありません）');
  if (ex.get(entry) !== 'function') throw new Error(`入口の関数 '${entry}' を export していません`);
  return m;
}

// 宣言の説明（plugin list などの人向け）。
export function describeManifest(m) {
  const ps = m.params.map((p) => `${p.name}=${p.default}（${p.min}..${p.max}）`).join(' ');
  const al = m.aliases && m.aliases.length ? `  別名: ${m.aliases.join(' ')}` : '';
  const reach = m.reach
    ? `  広がり: ${m.reach.param}${m.reach.round ? '（四捨五入）' : ''} × ${m.reach.factor}${m.reach.max != null ? `（${m.reach.max} 画素を超えたら帯に分けない）` : ''}`
    : '';
  return `${m.name}  ${m.doc || ''}\n    引数: ${ps}${al}${reach}${m.whole ? '  帯に分けない（@whole）' : ''}`;
}

// プラグインのソースを決める: 名前なら rootDir/plugins/<名前>.um、.um で終わるならそのファイル（plugins/ の外のものも）。
export function pluginSource(rootDir, nameOrPath) {
  if (nameOrPath.endsWith('.um')) return path.resolve(nameOrPath);
  if (!new RegExp(`^${NAME}$`).test(nameOrPath)) {
    throw new Error(`'${nameOrPath}' はプラグインの名前（英小文字・数字・_）でも .um のファイルでもありません`);
  }
  return path.join(rootDir, 'plugins', `${nameOrPath}.um`);
}

// コンパイラの診断の中の、作業のフォルダの写し（build/plugin/<名前>/fx/<名前>.um）を元のソースの場所に直す。
function mapPluginDiagnostics(text, copyPath, srcLabel) {
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rel = path.relative(process.cwd(), copyPath);
  const variants = [copyPath, copyPath.replace(/\\/g, '/'), rel, rel.replace(/\\/g, '/')];
  let out = String(text);
  for (const v of [...new Set(variants)].filter(Boolean).sort((a, b) => b.length - a.length)) {
    out = out.replace(new RegExp(esc(v), 'g'), srcLabel);
  }
  return mapDiagnostics(out);
}

// .mzplug を作る。
//   src: プラグインのソース（pluginSource で決めたもの）。umCli: UnifiedMozaic の src/cli.ts。spawnSync: node:child_process の関数。
//   戻り値: { name, out, bytes, manifest, entry, fx }。宣言の誤り・コンパイルの誤りは例外（message に場所と理由）。
// 手順: 宣言を読む → build/plugin/<名前>/ にソースの写し（行番号も同じ）と入口の包み（main.um）を書く →
// --target wasm32-plugin でコンパイルする → 宣言を JSON にしてカスタムセクションに入れ、dist/<名前>.mzplug に書く。
export function buildPlugin(rootDir, src, { umCli, outPath, spawnSync, env } = {}) {
  let text;
  try {
    text = fs.readFileSync(src, 'utf8');
  } catch {
    throw new Error(`${src} がありません`);
  }
  const rel = path.relative(rootDir, src).replace(/\\/g, '/');
  const label = rel.startsWith('..') || path.isAbsolute(rel) ? src : rel;
  const fx = parsePlugin(label, text);
  // コアのキー・組み込みの効果とのぶつかりは、ここでは止めない（読み込むときに bad-plugin になる。plugin install は断る）。
  // plugins/ の効果と同じ名前でも、wasm 版を作って組み込み版と比べられるように。
  const work = path.join(rootDir, PLUGIN_WORK_DIR, fx.name);
  const copy = path.join(work, COPY_DIR, `${fx.name}.um`);
  const entry = path.join(work, 'main.um');
  writeIfChanged(copy, copyText(fx, text));
  writeIfChanged(entry, wasmEntryText(fx));
  const wasmPath = path.join(work, `${fx.name}.wasm`);
  if (!umCli || !spawnSync) throw new Error('UnifiedMozaic のコンパイラ（src/cli.ts）の場所と spawnSync を渡してください');
  const r = spawnSync(process.execPath, [umCli, 'build', entry, '--target', 'wasm32-plugin', '-o', wasmPath],
    { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', env: env || process.env, maxBuffer: 1 << 26 });
  if (r.error) throw new Error(`コンパイラを起動できません: ${r.error.message}`);
  if (r.status !== 0) {
    const msg = mapPluginDiagnostics(`${r.stdout || ''}${r.stderr || ''}`, copy, label).trim();
    const e = new Error(`${label} を wasm にできませんでした\n${msg}`);
    e.compile = true;
    throw e;
  }
  const wasm = fs.readFileSync(wasmPath);
  const sha = crypto.createHash('sha256').update(text).digest('hex');
  const manifest = manifestOf(fx, { source: path.basename(src), sourceSha256: sha });
  const out = outPath || path.join(rootDir, PLUGIN_DIST_DIR, `${fx.name}.mzplug`);
  const bytes = setCustomSection(wasm, MANIFEST_SECTION, Buffer.from(JSON.stringify(manifest), 'utf8'));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, bytes);
  return { name: fx.name, out, bytes, manifest, entry, fx };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = process.argv[2]
    ? path.resolve(process.argv[2])
    : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  try {
    const r = generate(root);
    const what = r.changed ? 'を書きました' : 'は変わりません';
    const list = r.effects.length === 0 ? '効果はありません' : `効果 ${r.effects.length} 個: ${r.effects.join(' ')}`;
    console.error(`gen-plugins: ${path.relative(root, r.path)} ${what}（${list}）`);
  } catch (err) {
    console.error(`gen-plugins: ${err.message}`);
    process.exit(1);
  }
}
