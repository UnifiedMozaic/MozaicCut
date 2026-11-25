#!/usr/bin/env node
// MozaicCut の MCP サーバー（Model Context Protocol）。AI のエージェントから MozaicCut を使うための窓口。
//
//   node tools/mcp-server.mjs [--root <フォルダ>]...
//
// - 標準入出力で JSON-RPC 2.0 をやり取りする（1 行に 1 つのメッセージ）。npm の依存はない。
// - 中身は tools/mozcut.mjs のサブコマンド（schema / check / show / op / preview / render）を子プロセスで呼ぶだけ。
//   編集の計算は、人が使うコマンドと同じエンジンが行う（操作の仕組みは一つ）。
// - 安全のため:
//   - 触れてよいのは「許したフォルダ」（--root、なければ環境変数 MOZCUT_MCP_ROOTS、なければ起動したフォルダ）の中だけ。
//     プロジェクト（.mzc）、その素材・フォント、書き出し先、プレビューの画像が外を指していたら断る。
//     素材のパスは、エンジン（build/mozcut の sources）が実際に読んだものを確かめる（自前の読み方とずれないように）。
//     フォントだけは、OS のフォントのフォルダも「読むだけ」の許可先にする。
//   - 書き換える操作（op）は既定で dry_run（差分を返すだけ）。apply=true のときだけ保存する。
//   - 書き出し先が素材・.mzc・キャッシュなら断り、既にあるファイルは overwrite=true のときだけ上書きする。
//   - 書き出し中のプロジェクトには、ほかのツールは触れない（code: busy）。
//   - 標準出力には JSON-RPC のメッセージだけを書く。記録は標準エラーに書く。
// - op を保存したときは、プロジェクトの隣の <名前>.mzc.history に 1 行（JSON Lines。"via":"mcp"）を書き足す。
//   MozaicCut のアプリはこれを読んで、外の AI（Claude Code など）の編集を AI の欄の履歴に出す（src/ai/ai_external.um）。
//
// 使い方（Claude Code / Claude Desktop への登録）は docs/mcp.md、ツールの中身の約束は docs/ai.md を見る。
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MOZCUT_MJS = process.env.MOZCUT_MJS ? path.resolve(process.env.MOZCUT_MJS) : path.join(HERE, 'mozcut.mjs');
const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const SERVER_NAME = 'mozaiccut';
const SERVER_VERSION = '0.1.0';
// 対応する MCP の版（新しい順）。相手の版が知っているものならそれを、知らなければいちばん新しいものを返す。
const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const IS_WIN = process.platform === 'win32';
const MEDIA_KINDS = new Set(['video', 'image', 'audio']);
const LONG_TIMEOUT_MS = 10 * 60 * 1000;
// エンジン（mozcut.mjs と同じ場所の ../build/mozcut）。素材のパスを読むのに直接呼ぶ（sources は素材を probe しない）。
const ENGINE_EXE = process.env.MOZCUT_EXE
  ? path.resolve(process.env.MOZCUT_EXE)
  : path.join(path.dirname(MOZCUT_MJS), '..', 'build', 'mozcut' + (process.platform === 'win32' ? '.exe' : ''));
// preview の画像の既定の最大の幅と、1 枚のバイト数の上限（base64 にして 5MB を超えないように）
const PREVIEW_DEFAULT_WIDTH = 1280;
const PREVIEW_MAX_BYTES = 3.5 * 1024 * 1024;
const PREVIEW_MAX_SIDE = 7680;
const PREVIEW_KEEP = 20;
const MAX_TIME_SEC = 1e7;
// schema の section に渡せる名前（schema --json の上の欄）
const SCHEMA_SECTIONS = ['all', 'keys', 'effects', 'transitions', 'ops', 'syntax', 'blend', 'expressions', 'features'];

function log(msg) {
  process.stderr.write(`mozcut-mcp: ${msg}\n`);
}

// initialize で相手が名乗った名前（clientInfo.name。Claude Code なら "claude-code"）。操作の記録に残す。
let clientName = '';

// その場の時刻の ISO 8601（地方時と時差つき。"2026-11-22T14:32:05+09:00"）。
function localIso(d = new Date()) {
  const p2 = (n) => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const a = Math.abs(off);
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}${sign}${p2(Math.floor(a / 60))}:${p2(a % 60)}`;
}

// 保存した操作を <名前>.mzc.history に 1 行で書き足す（MozaicCut のアプリが AI の欄の履歴に出す）。書けなくても操作は失敗にしない。
function appendHistory(projectPath, ops, results) {
  const changes = [];
  for (const res of results || []) for (const c of res.changes || []) changes.push({ kind: c.kind, line: c.line, before: c.before, after: c.after });
  const desc = (results || []).map((r) => r.desc).filter(Boolean).join('。');
  const line = { t: localIso(), who: 'ai', via: 'mcp', client: clientName, tool: 'op', ops, desc, changes };
  try {
    fs.appendFileSync(projectPath + '.history', JSON.stringify(line) + '\n');
  } catch (e) {
    log(`操作の記録（${projectPath}.history）を書けませんでした: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// 許したフォルダ（roots）と、パスの確かめ
// ---------------------------------------------------------------------------

function parseRoots(argv) {
  const roots = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root' && argv[i + 1] !== undefined) roots.push(argv[++i]);
    else if (argv[i].startsWith('--root=')) roots.push(argv[i].slice(7));
  }
  if (roots.length === 0 && process.env.MOZCUT_MCP_ROOTS) {
    roots.push(...process.env.MOZCUT_MCP_ROOTS.split(path.delimiter).filter(Boolean));
  }
  if (roots.length === 0) roots.push(process.cwd());
  const out = [];
  for (const r of roots) {
    const abs = path.resolve(r);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
      log(`許すフォルダ ${abs} がないので飛ばします`);
      continue;
    }
    out.push(fs.realpathSync(abs));
  }
  return out;
}

const ROOTS = parseRoots(process.argv.slice(2));

const norm = (p) => (IS_WIN ? p.toLowerCase() : p);

// OS のフォントのフォルダ（フォントだけ「読むだけ」で許す）。
function systemFontDirs() {
  const home = os.homedir();
  let dirs = [];
  if (IS_WIN) {
    dirs = [path.join(process.env.WINDIR || process.env.SystemRoot || 'C:\\Windows', 'Fonts')];
    if (process.env.LOCALAPPDATA) dirs.push(path.join(process.env.LOCALAPPDATA, 'Microsoft', 'Windows', 'Fonts'));
  } else if (process.platform === 'darwin') {
    dirs = ['/System/Library/Fonts', '/Library/Fonts', path.join(home, 'Library', 'Fonts')];
  } else {
    dirs = ['/usr/share/fonts', '/usr/local/share/fonts', path.join(home, '.fonts'), path.join(home, '.local', 'share', 'fonts')];
  }
  const out = [];
  for (const d of dirs) {
    try {
      if (fs.statSync(d).isDirectory()) out.push(fs.realpathSync(d));
    } catch { /* ないフォルダは飛ばす */ }
  }
  return out;
}

const FONT_DIRS = systemFontDirs();

// child が dir と同じか、その中にあるか（どちらも絶対パス・実パス）。
function isInside(dir, child) {
  const rel = path.relative(norm(dir), norm(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// シンボリックリンクをたどった実パス。まだないファイルは、あるところまでの親をたどって、残りをつなぐ。
function realish(p) {
  let cur = path.resolve(p);
  const rest = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(cur), ...rest.reverse());
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return path.resolve(p);
      rest.push(path.basename(cur));
      cur = parent;
    }
  }
}

class ToolError extends Error {
  constructor(message, extra = {}) {
    super(message);
    this.extra = extra;
  }
}

function rootsText() {
  return ROOTS.map((r) => `  - ${r}`).join('\n');
}

// p（絶対パスか、最初の許したフォルダからの相対パス）を確かめて実パスを返す。
function insideRoots(p, what) {
  if (ROOTS.length === 0) throw new ToolError('許したフォルダがありません。サーバーを --root <フォルダ> を付けて起動してください / No allowed folder. Start the server with --root <folder>.');
  const abs = realish(path.isAbsolute(p) ? p : path.resolve(ROOTS[0], p));
  if (!ROOTS.some((r) => isInside(r, abs))) {
    throw new ToolError(`${what} ${abs} は許したフォルダの外なので触れません。許したフォルダ:\n${rootsText()}\n（ほかの場所を使うには、サーバーの起動に --root <フォルダ> を足してください）`, { code: 'outside-root', path: abs });
  }
  return abs;
}

// プロジェクトの .mzc を確かめる。
function resolveProject(p) {
  if (typeof p !== 'string' || p.trim() === '') throw new ToolError('project にプロジェクトのファイル（.mzc）のパスを渡してください / Pass the path of a .mzc file as "project".', { code: 'bad-args' });
  const abs = insideRoots(p, 'プロジェクト');
  if (!abs.toLowerCase().endsWith('.mzc')) throw new ToolError(`プロジェクトは .mzc のファイルです: ${abs}`, { code: 'bad-args' });
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) throw new ToolError(`プロジェクトがありません: ${abs}（list_projects で探せます）`, { code: 'not-found' });
  return abs;
}

function cacheDirOf(projectPath) {
  return path.join(path.dirname(projectPath), path.basename(projectPath).replace(/\.[^.]+$/, '') + '.cache');
}

// 書き出すファイルの場所。プロジェクトのフォルダの中だけ（相対パスはプロジェクトのフォルダから）。
function resolveOutput(projectPath, p, exts, what) {
  const dir = path.dirname(projectPath);
  const abs = realish(path.isAbsolute(p) ? p : path.resolve(dir, p));
  if (!isInside(realish(dir), abs) || !ROOTS.some((r) => isInside(r, abs))) {
    throw new ToolError(`${what} ${abs} はプロジェクトのフォルダ（${dir}）の外なので書けません。プロジェクトのフォルダからの相対パスで書いてください`, { code: 'outside-project', path: abs });
  }
  if (exts && !exts.some((e) => abs.toLowerCase().endsWith(e))) {
    throw new ToolError(`${what} の拡張子は ${exts.join(' / ')} のどれかにしてください: ${abs}`, { code: 'bad-args' });
  }
  return abs;
}

// ---------------------------------------------------------------------------
// .mzc と操作の行から、ファイルのパスを拾う（外を指していないかを確かめるため）
// ---------------------------------------------------------------------------
//
// 素材（src）は、エンジンの `mozcut sources` が実際に読んだパスで確かめる（engineSources）。
// フォント（font=）と書き出し先（output=）はエンジンが一覧を出さないので、エンジンの字句解析
// （src/engine/project.um の pjTokenize / pjReadQuoted / pjHashColorAt）を 1 文字ずつ同じ決まりで写したもので読む。
// 写しは素材の二重の確かめにも使う（どちらかが外を指せば断る）。src/engine/project.um の字句解析を変えたら、ここも直す。

const pjIsSpace = (c) => c === ' ' || c === '\t' || c === '\r';
const pjIsHex = (c) => c !== undefined && /^[0-9a-fA-F]$/.test(c);

// line[i] の '#' から始まる語が色（#rrggbb / #rrggbbaa）か。
function pjHashColorAt(line, i) {
  let j = i + 1;
  while (j < line.length && pjIsHex(line[j])) j++;
  const digits = j - i - 1;
  return (digits === 6 || digits === 8) && (j === line.length || pjIsSpace(line[j]));
}

// line[start] は '"'。\n は改行、\t はタブ、\" は "、\\ は \、ほかの \x は x（badEsc に位置）。
function pjReadQuoted(line, start) {
  let text = '';
  let i = start + 1;
  let badEsc = -1;
  while (i < line.length) {
    const c = line[i];
    if (c === '"') return { text, next: i + 1, ok: true, badEsc };
    if (c === '\\' && i + 1 < line.length) {
      const d = line[i + 1];
      if (d === 'n') text += '\n';
      else if (d === 't') text += '\t';
      else {
        if (d !== '"' && d !== '\\' && badEsc < 0) badEsc = i;
        text += d;
      }
      i += 2;
      continue;
    }
    text += c;
    i++;
  }
  return { text, next: i, ok: false, badEsc };
}

// 1 行を語に分ける。{ ok, toks: [{ key, val, badEsc }] }。key が '' なら位置の値。
function pjTokenize(line) {
  const toks = [];
  let i = 0;
  const n = line.length;
  while (i < n) {
    const c = line[i];
    if (pjIsSpace(c)) { i++; continue; }
    if (c === '#' && !pjHashColorAt(line, i)) break;
    if (c === '"') {
      const q = pjReadQuoted(line, i);
      if (!q.ok) return { ok: false, toks };
      toks.push({ key: '', val: q.text, badEsc: q.badEsc });
      i = q.next;
      continue;
    }
    const start = i;
    while (i < n && !pjIsSpace(line[i]) && line[i] !== '=') i++;
    const word = line.slice(start, i);
    if (i < n && line[i] === '=') {
      if (word.length === 0) return { ok: false, toks };
      i++;
      if (i < n && line[i] === '"') {
        const q = pjReadQuoted(line, i);
        if (!q.ok) return { ok: false, toks };
        toks.push({ key: word, val: q.text, badEsc: q.badEsc });
        i = q.next;
      } else {
        const vstart = i;
        while (i < n && !pjIsSpace(line[i])) i++;
        toks.push({ key: word, val: line.slice(vstart, i), badEsc: -1 });
      }
    } else toks.push({ key: '', val: word, badEsc: -1 });
  }
  return { ok: true, toks };
}

// .mzc の行に分ける（エンジンの splitLines と同じく \n で分け、行末の \r と先頭の BOM を落とす）。
function mzcLines(text) {
  const lines = text.split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
  if (lines.length && lines[0].startsWith('﻿')) lines[0] = lines[0].slice(1);
  return lines;
}

// .mzc の 1 行が読む・書くファイル。{ srcs, fonts, writes, badEscape }
function pathsOfLine(line) {
  const out = { srcs: [], fonts: [], writes: [], badEscape: false };
  const { ok, toks } = pjTokenize(line);
  if (!ok || toks.length === 0 || toks[0].key !== '') return out; // エンジンも読まない行
  const head = toks[0].val;
  if (head === 'project') {
    for (const t of toks.slice(1)) {
      if (t.key === 'font') { out.fonts.push(t.val); if (t.badEsc >= 0) out.badEscape = true; }
      if (t.key === 'output') { out.writes.push(t.val); if (t.badEsc >= 0) out.badEscape = true; }
    }
    return out;
  }
  if (!MEDIA_KINDS.has(head)) return out;
  let positional = 0;
  for (const t of toks.slice(1)) {
    if (t.key === '') {
      if (t.val === 'mute' && (head === 'video' || head === 'audio')) continue;
      if (positional === 0) { out.srcs.push(t.val); if (t.badEsc >= 0) out.badEscape = true; }
      positional++;
    } else if (t.key === 'src') {
      out.srcs.push(t.val);
      if (t.badEsc >= 0) out.badEscape = true;
    }
  }
  return out;
}

// 操作の 1 行が読む・書くファイル（前もっての確かめ。本当の確かめは、試した後の行で行う）。
const looksLikeTime = (v) => /^[0-9:.+-]+$/.test(v);
function pathsOfOp(line) {
  const out = { srcs: [], fonts: [], writes: [], badEscape: false };
  const { toks } = pjTokenize(line);
  if (toks.length === 0) return out;
  const op = toks[0].val;
  if (op === 'add' && toks[1] && MEDIA_KINDS.has(toks[1].val) && toks[2] && toks[2].key === '' && toks[2].val !== 'after') out.srcs.push(toks[2].val);
  for (const t of toks.slice(1)) {
    if (t.key === 'src') out.srcs.push(t.val);
    if (t.key === 'font') out.fonts.push(t.val);
    if (t.key === 'output' || (t.key === 'out' && !looksLikeTime(t.val))) out.writes.push(t.val);
  }
  return out;
}

// 制御文字（改行・タブなど）を含むパスは断る（エンジンの出力の行や欄が崩れ、別のパスとして読まれるおそれがある）。
// eslint-disable-next-line no-control-regex
const hasControl = (s) => /[\u0000-\u001f\u007f]/.test(s);

function srcAbs(projectPath, r) {
  return path.isAbsolute(r) ? r : path.resolve(path.dirname(projectPath), r);
}

function checkSrc(projectPath, r, where) {
  if (r === '' || r === '-') return null;
  if (hasControl(r)) throw new ToolError(`${where}の素材のパスに改行やタブが入っています。使えません: ${JSON.stringify(r)}`, { code: 'bad-path' });
  try {
    return insideRoots(srcAbs(projectPath, r), `${where}の素材`);
  } catch (e) {
    throw new ToolError(`${e.message}\n（${where}: ${r}）`, e.extra);
  }
}

// フォントは読むだけなので、許したフォルダか OS のフォントのフォルダの中ならよい。
// エンジンは font= の相対パスを起動したフォルダから探すので、エンジンはプロジェクトのフォルダで起動する（runMozcut の cwd）。
function fontAbs(projectPath, f) {
  return realish(srcAbs(projectPath, f));
}

function fontAllowed(abs) {
  return ROOTS.some((r) => isInside(r, abs)) || FONT_DIRS.some((d) => isInside(d, abs));
}

function checkFont(projectPath, f, where, warnings) {
  if (f === '') return null;
  if (hasControl(f)) throw new ToolError(`${where}のフォントのパスに改行やタブが入っています。使えません: ${JSON.stringify(f)}`, { code: 'bad-path' });
  const abs = fontAbs(projectPath, f);
  if (fontAllowed(abs)) return abs;
  const msg = `${where}のフォント ${abs} は許したフォルダと OS のフォントのフォルダの外です。許したフォルダ:\n${rootsText()}\nOS のフォントのフォルダ:\n${FONT_DIRS.map((d) => `  - ${d}`).join('\n') || '  （なし）'}`;
  if (warnings) {
    warnings.push(`${msg}\n（読むだけのツールなので続けます。preview・render・op は断ります）`);
    return null;
  }
  throw new ToolError(`${msg}\n（${where}: ${f}）`, { code: 'outside-root', path: abs });
}

function checkWrite(projectPath, w, where) {
  if (w === '') return null;
  try {
    return resolveOutput(projectPath, w, null, `${where}の書き出し先`);
  } catch (e) {
    throw new ToolError(`${e.message}\n（${where}: ${w}）`, e.extra);
  }
}

// 写した字句解析で拾ったパスを確かめる。warnings を渡せば、外を指すフォントは断らずに警告にする。
function guardPaths(projectPath, p, where, warnings = null) {
  if (p.badEscape) {
    throw new ToolError(`${where}の素材・フォント・書き出し先のパスに、知らないエスケープ（\\ の後ろが n・t・"・\\ 以外）があります。` +
      'パスの区切りは / で書くか、\\ そのものは \\\\ と書いてください', { code: 'bad-escape' });
  }
  for (const r of p.srcs) checkSrc(projectPath, r, where);
  for (const f of p.fonts) checkFont(projectPath, f, where, warnings);
  for (const w of p.writes) checkWrite(projectPath, w, where);
}

// エンジンが一度でもビルドされていることを確かめる（mozcut.mjs が要ればビルドする）。
let engineReady = null;
async function ensureEngine() {
  if (engineReady && fs.existsSync(ENGINE_EXE)) return engineReady;
  engineReady = (async () => {
    const r = await runMozcut(['schema', '--json']);
    if (r.code !== 0 || !fs.existsSync(ENGINE_EXE)) {
      engineReady = null;
      throw new ToolError(`エンジン（${ENGINE_EXE}）を用意できませんでした:\n${cleanErr(r.stderr)}`, { code: 'internal' });
    }
  })();
  return engineReady;
}

// エンジンの `sources` で、.mzc のファイル file の素材のパス（書いてあるまま）を受け取る。素材は probe しない。
async function engineSources(file, cwd) {
  await ensureEngine();
  const r = await runProcess(ENGINE_EXE, ['sources', file], { cwd, timeoutMs: 60000 });
  if (r.code !== 0) throw new ToolError(`エンジンが素材の一覧を出せませんでした（終了コード ${r.code}）:\n${cleanErr(r.stderr)}`, { code: 'internal' });
  const srcs = [];
  for (const raw of r.stdout.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (line === '') continue;
    if (!line.startsWith('src\t')) {
      // 素材のパスに改行が入っていると、行が分かれてここに来る
      throw new ToolError(`素材のパスに改行が入っているか、エンジンの出力が読めません: ${JSON.stringify(line)}`, { code: 'bad-path' });
    }
    srcs.push(line.slice(4));
  }
  return srcs;
}

// .mzc の text（file はエンジンに読ませる同じ中身のファイル）が読む・書くファイルを確かめる。
// 返す値: { output, sources（絶対パス）, fonts（絶対パス）, warnings }。
async function guardText(projectPath, text, file, { fontWarn = false, where = '' } = {}) {
  const warnings = fontWarn ? [] : null;
  let output = null;
  const fonts = [];
  mzcLines(text).forEach((line, i) => {
    const p = pathsOfLine(line);
    const w = `${where}${i + 1} 行目`;
    guardPaths(projectPath, p, w, warnings);
    for (const f of p.fonts) if (f !== '') fonts.push(fontAbs(projectPath, f));
    if (p.writes.length) output = p.writes[p.writes.length - 1];
  });
  // 本当の確かめ: エンジンが読んだ素材のパス
  const sources = [];
  for (const s of await engineSources(file, path.dirname(projectPath))) {
    const abs = checkSrc(projectPath, s, `${where}プロジェクト`);
    if (abs) sources.push(abs);
  }
  return { output: output ?? 'out.mp4', sources, fonts, warnings: warnings ?? [] };
}

// プロジェクトの全部の行を確かめる。fontWarn なら外を指すフォントは警告にする（check / show）。
async function guardProject(projectPath, opts = {}) {
  return guardText(projectPath, fs.readFileSync(projectPath, 'utf8'), projectPath, opts);
}

// ---------------------------------------------------------------------------
// mozcut.mjs を呼ぶ
// ---------------------------------------------------------------------------

// 同時に 1 つだけ（ビルドやキャッシュの書き込みがぶつからないように）。
// 書き出しは、準備（確かめ・check）までをここで行い、子のプロセスは裏で動かす。
// 書き出し中のプロジェクトには、ほかのツールは触れない（assertNotRendering）。
let lock = Promise.resolve();
function serial(fn) {
  const p = lock.then(fn, fn);
  lock = p.catch(() => {});
  return p;
}

// 子のプロセスに渡す環境変数。相対パスの UM_HOME などは、起動したフォルダからの絶対パスにする（子は別のフォルダで動くため）。
function childEnv() {
  const env = { ...process.env };
  for (const k of ['UM_HOME', 'FFMPEG', 'FFPROBE', 'UM_SDL3']) {
    const v = env[k];
    if (v && (v.includes('/') || v.includes('\\')) && !path.isAbsolute(v)) env[k] = path.resolve(v);
  }
  return env;
}

function runProcess(cmd, args, { input = null, timeoutMs = LONG_TIMEOUT_MS, cwd = undefined } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, cwd, env: childEnv() });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => {
      stderr += `\n（${Math.round(timeoutMs / 1000)} 秒で終わらなかったので止めました）`;
      killTree(child);
    }, timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: `${stderr}\n${cmd} を起動できません: ${e.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
    child.stdin.on('error', () => {});
    if (input !== null) child.stdin.end(input);
    else child.stdin.end();
  });
}

// mozcut.mjs を呼ぶ。プロジェクトを扱うときは project を渡す（そのフォルダで起動し、エンジンと起点をそろえる）。
function runMozcut(args, { input = null, timeoutMs = LONG_TIMEOUT_MS, project = null } = {}) {
  return runProcess(process.execPath, [MOZCUT_MJS, ...args], { input, timeoutMs, cwd: project ? path.dirname(project) : undefined });
}

// 子のプロセスを、孫（mozcut.exe、ffmpeg）ごと止める。
function killTree(child) {
  if (!child || child.exitCode !== null || child.pid === undefined) return;
  if (IS_WIN) {
    const r = spawnSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore', windowsHide: true });
    if (r.error || r.status !== 0) child.kill();
    return;
  }
  try {
    process.kill(-child.pid, 'SIGTERM'); // detached で起動したプロセスのグループごと
  } catch {
    child.kill('SIGTERM');
  }
}

// 標準出力の JSON を読む（ビルドの記録が前に混ざっていても、最後の JSON の行を拾う）。
function parseJsonOut(stdout) {
  const s = stdout.trim();
  try {
    return JSON.parse(s);
  } catch {
    const lines = s.split(/\r?\n/).filter((l) => l.startsWith('{'));
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        return JSON.parse(lines[i]);
      } catch { /* 次へ */ }
    }
  }
  return null;
}

const cleanErr = (s) => s.split(/\r?\n/).filter((l) => l.trim() !== '').join('\n');

// ---------------------------------------------------------------------------
// ツールの結果の形
// ---------------------------------------------------------------------------

function textResult(summary, data, isError = false) {
  const content = [{ type: 'text', text: summary }];
  const res = { content, isError };
  if (data !== undefined) {
    content.push({ type: 'text', text: JSON.stringify(data) });
    res.structuredContent = data;
  }
  return res;
}

function errorResult(e) {
  const data = { ok: false, error: e.message, ...(e.extra || {}) };
  return textResult(`エラー: ${e.message}`, data, true);
}

function fmtSec(t) {
  const ms = Math.round(t * 1000);
  const m = Math.floor(ms / 60000);
  const sec = (ms % 60000) / 1000;
  return `${m}:${sec.toFixed(3).padStart(6, '0')}`;
}

// 時刻を確かめる。エンジンの書き方（src/engine/text.um の parseTime）と同じ決まり: 欄は 3 つまで（時:分:秒）、
// 2 つ目からの欄（分と秒）は 60 未満。加えて 0〜1e7 秒（エンジンの操作の上限と同じ）。
// エンジンには決まった桁の文字列で渡す（1e21 のような書き方を渡さない）。
function secsText(secs) {
  const s = secs.toFixed(6);
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
}

function parseTime(v, name) {
  const bad = (why) => new ToolError(`${name} の値 ${JSON.stringify(v)} は時刻として読めません（${why}。3.5 や "1:02.5"、"1:00:00" のように書きます）`, { code: 'bad-args' });
  let secs;
  if (typeof v === 'number') {
    if (!Number.isFinite(v) || v < 0) throw bad('0 以上の秒にします');
    secs = v;
  } else if (typeof v === 'string') {
    const t = v.trim();
    if (!/^\d+(\.\d+)?(:\d+(\.\d+)?)*$/.test(t)) throw bad('数と : だけで書きます');
    const parts = t.split(':');
    if (parts.length > 3) throw bad('欄は 時:分:秒 の 3 つまでです');
    secs = 0;
    parts.forEach((x, i) => {
      const n = Number(x);
      if (i > 0 && n >= 60) throw bad('分と秒は 60 未満です');
      secs = secs * 60 + n;
    });
  } else throw bad('数か文字列で渡します');
  if (!Number.isFinite(secs) || secs > MAX_TIME_SEC) throw bad(`${MAX_TIME_SEC} 秒以下にします`);
  return { text: secsText(secs), secs };
}

// ---------------------------------------------------------------------------
// ツール
// ---------------------------------------------------------------------------

const PROJECT_PROP = {
  type: 'string',
  description: 'プロジェクトのファイル（.mzc）のパス。絶対パスか、サーバーの最初の許したフォルダからの相対パス（list_projects が返す path をそのまま使える）。 / Path to the .mzc project file: absolute, or relative to the server\'s first allowed folder (the "path" returned by list_projects works as is).',
};

const TOOLS = [
  {
    name: 'schema',
    title: 'MozaicCut: 書き方の一覧 / schema',
    description: [
      '.mzc に書けるキー（型・範囲・既定値・使える行）、効果（プラグイン。名前・引数・範囲）、操作（op の書き方と例）、時刻と参照の書き方の一覧を JSON で返す。',
      '最初に 1 回読むこと。効果はプラグインで増えるので、名前や範囲を覚え込まず、ここで確かめる。大きいので section で絞れる（keys / effects / ops / syntax / blend / features）。',
      'features は機能ごとの早見（keyframes = キーフレーム、blend = 描画モード・マスク・トラックマット、shape = シェイプ、textanim = テキストアニメーター）: 書くキー、使う操作、check で読む所、op の例。',
      'keys[].animatable は値を「値@時刻[:印]」の列で書けるか、keys[].keyOps は key add などの操作で動かせるか。blend は描画モードの一覧とマスクの行のキー。',
      '',
      'Returns the reference for writing MozaicCut projects as JSON: keys (type, range, default, allowed line kinds), effects (plugins: name, params, ranges), ops (usage and examples for the op tool), and the time/reference syntax.',
      'Read it once before editing; effects come from plugins, so always check here instead of guessing. Use "section" to fetch only keys / effects / ops / syntax / blend / features.',
      '"features" is a per-feature cheat sheet (keyframes, blend = blend modes/masks/track mattes, shape, textanim = text animators): keys, ops, where to read the result in check, and op examples. keys[].animatable = accepts "value@time" lists; keys[].keyOps = can be edited with the key ops.',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        section: { type: 'string', enum: SCHEMA_SECTIONS, description: '返す部分（既定 all）。 / Which part to return (default all).' },
        format: { type: 'string', enum: ['json', 'text'], description: 'json（既定。機械向け）か text（人向けの文）。 / json (default, structured) or text (human-readable).' },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'check',
    title: 'MozaicCut: 診断 / check',
    description: [
      'プロジェクトを調べ、誤り（診断）と、配置した後の全クリップ（index・id・行番号・トラック・開始・終わり・キー・効果）を JSON で返す。ファイルは書き換えない。',
      'ok が true なら誤り（error）はない。diagnostics[] の code・line・col・hint・suggest を読んで直す（hint に直し方が書いてある）。編集の前後に必ず呼ぶ。',
      'M6 の機能の読めた値: clips[].anims（キーフレーム。{キー:{type,keys:[{t,value,text,in,out}]}}、project.anims は project の行の効果の分）、clips[].shape（形の値。既定値を埋めたもの）、clips[].textanim（テキストアニメーター。mode と日本語の doc）、clips[].blend（描画モード・マット）、clips[].masks（掛かったマスクの行）。',
      '',
      'Checks a project and returns diagnostics plus every clip after layout (index, id, line, track, start/end seconds, keys, effects) as JSON. Read-only.',
      '"ok": true means no errors. Fix problems using diagnostics[].code / line / col / hint / suggest (the hint usually says exactly how). Call it before and after editing.',
      'Resolved M6 data per clip: anims (keyframes), shape (shape values with defaults), textanim (text animators with a Japanese description), blend (blend mode / matte), masks (mask lines applied).',
    ].join('\n'),
    inputSchema: { type: 'object', properties: { project: PROJECT_PROP }, required: ['project'], additionalProperties: false },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'show',
    title: 'MozaicCut: タイムライン / show',
    description: [
      'タイムラインの図（トラックごとのクリップの並び）とクリップの一覧（番号・ID・行・種類・トラック・開始・終わり・素材や文字・効果）を、人が読む文で返す。ファイルは書き換えない。',
      '全体の様子をつかむのに使う。正確な数値が要るときは check の JSON を使う。',
      '',
      'Returns an ASCII timeline diagram (clips per track) and a clip table (index, id, line, kind, track, start, end, source/text, effects) as plain text. Read-only.',
      'Good for getting an overview; use check for exact numbers.',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        project: PROJECT_PROP,
        width: { type: 'integer', minimum: 40, maximum: 400, description: '図の幅（文字数。既定 100）。 / Diagram width in characters (default 100).' },
      },
      required: ['project'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'op',
    title: 'MozaicCut: 操作 / op',
    description: [
      'プロジェクトに操作を適用する。既定は dry_run（試すだけで保存しない）で、差分（変わる行の前と後）と、時刻が変わるほかのクリップ（moved）を返す。apply=true のときだけ保存する。',
      '手順: (1) apply を付けずに呼び、diff と results[].desc / moved が意図どおりか確かめる → (2) 同じ ops を apply=true で呼ぶ → (3) check で diagnostics が空なことを確かめる。',
      'ops は 1 行に 1 操作（文字列か、文字列の配列）。全部成功したときだけ保存し、1 つでも失敗すれば何も書かない。誤りが増える操作は断られる。',
      '操作: move <clip> <時刻か参照> / trim <clip> start|end <時刻> / split <clip> <時刻> / delete <clip> [fix-refs] / cut <開始> <終わり> / set <clip> key=value ... / unset <clip> key ... / renamekey <clip> <古い> <新しい> / add <種類> [素材/文字/色] key=value ... [after <clip>] / add shape <形> key=value ... / add mask <形> to=<clip> key=value ... / rename <clip> <新しいID> / key add|remove|move|set|ease|shift|clear <clip> <キー> ...。',
      'キーフレーム: "key add title x 1.5 120 ease"（時刻はクリップの始まりからの秒。x / y / pos は左上からの画素。先に 0 秒のキーを画素で足す）。値を一度に書くなら set title opacity="0@0 1@0.5"。動かせるキーは schema の keys[].keyOps と効果の引数。',
      '描画モード: "set glow blend=screen"、トラックマット: "set fill matte=word"、マスク: "add mask ellipse to=pip units=norm x=0.1 y=0.1 w=0.8 h=0.8 feather=0.2"（マスクの行は @行番号 で指す）。シェイプ: "add shape star id=star points=5 r=120 inner=50 pos=640,360 fill=ffd040 at=0 dur=3"（線を描いていくなら path に trimend のキー）。テキストアニメーター: "set title anim=rise anim.by=word anim.stagger=0.2"（anim.start などの時間の値は set で値@時刻 を書く）。早見は schema の features。',
      'クリップは ID（clip_b。いちばん安定）、#番号（#3）、@行番号（@9）で指す。時刻はタイムライン上の秒（5.5）か "分:秒"（1:02.5）。参照は clip_a.end、clip_a.start+1.5、after:clip_a。詳しくは schema の ops と syntax。',
      '失敗したら results[].code / error / hint / suggest を読んで直す。素材は許したフォルダの中のファイルだけを使える（フォントは OS のフォントのフォルダのものも使える）。保存の引数は apply だけ（dry_run・save などは受け付けない）。',
      '',
      'Applies edit operations to a project. Default is a dry run: nothing is saved, and you get a diff (before/after of each changed line) plus other clips whose times change ("moved"). Only apply=true saves.',
      'Workflow: (1) call without apply and check the diff, results[].desc and moved; (2) call again with the same ops and apply=true; (3) run check and confirm diagnostics is empty.',
      '"ops" is one operation per line (a string, or an array of strings). The batch is all-or-nothing, and an operation that would add errors is refused.',
      'Operations: move, trim, split, delete, cut, set, unset, renamekey, add (incl. "add shape <kind>" and "add mask <kind> to=<clip>"), rename, and the keyframe ops "key add|remove|move|set|ease|shift|clear <clip> <key> ..." (see schema "ops" and "features" for usage and examples). Refer to clips by ID (most stable), #index or @line. Times are timeline seconds (5.5) or "m:ss" (1:02.5); references look like clip_a.end, clip_a.start+1.5, after:clip_a.',
      'On failure read results[].code / error / hint / suggest. Media files must be inside the allowed folders; fonts may also come from the OS font folders.',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        project: PROJECT_PROP,
        ops: {
          description: '操作。1 行に 1 つ（例: "move clip_b 5.5"、"split clip_b 7\\nset clip_b_2 sat=0.5"）。配列でもよい。値に空白があれば "..." で囲む。 / Operations, one per line (e.g. "move clip_b 5.5"), or an array of strings. Quote values containing spaces.',
          anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' }, minItems: 1 }],
        },
        apply: { type: 'boolean', description: 'true のときだけ保存する（既定 false = dry_run）。先に apply なしで差分を確かめること。 / Save only when true (default false = dry run). Inspect the dry-run diff first.' },
      },
      required: ['project', 'ops'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'preview',
    title: 'MozaicCut: 1 コマの画像 / preview',
    description: [
      'タイムラインの指定の時刻の 1 コマを合成し、PNG の画像として返す。文字の大きさ・位置・重なりの順・色など、check では分からない見た目を確かめるのに使う。',
      `画像はプロジェクトのキャッシュのフォルダ（<名前>.cache/mcp/。新しい ${PREVIEW_KEEP} 枚だけ残す）に書く。save_as を渡せば、プロジェクトのフォルダの中のその場所にも書く（既にあるファイルは overwrite=true のときだけ上書き）。誤りのあるプロジェクトでは止まるので、先に check を通す。`,
      `返す画像の幅は既定で ${PREVIEW_DEFAULT_WIDTH} 画素まで（max_width で変えられる。0 なら元の大きさ）。それでも大きすぎる画像（約 3.5MB 超）は、さらに縮めるか JPEG にして返す。時刻が全体の長さより後ろなら beyondEnd が true（背景だけの絵）。`,
      '初回や素材を変えた後は、素材の展開に数十秒かかることがある。',
      '',
      'Renders the single frame at a timeline time and returns it as a PNG image. Use it to verify what check cannot: text size and position, layer order, colors, effects.',
      `The image is written into the project cache folder (<name>.cache/mcp/, newest ${PREVIEW_KEEP} kept); pass save_as to also write it inside the project folder (an existing file is replaced only with overwrite=true). Fails on projects with errors, so run check first. The first call (or after media changes) may take tens of seconds to decode media.`,
      `The returned image is at most ${PREVIEW_DEFAULT_WIDTH} px wide by default (max_width changes it; 0 = full size). Images still over ~3.5MB are shrunk further or returned as JPEG. beyondEnd is true when the time is past the end of the timeline.`,
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        project: PROJECT_PROP,
        time: { description: 'タイムライン上の時刻。秒（3.5）か "分:秒"（"1:02.5"）か "時:分:秒"。 / Timeline time: seconds (3.5), "m:ss" ("1:02.5") or "h:mm:ss".', anyOf: [{ type: 'number', minimum: 0 }, { type: 'string' }] },
        max_width: { type: 'integer', minimum: 0, maximum: 8192, description: `返す画像の最大の幅（画素。既定 ${PREVIEW_DEFAULT_WIDTH}、0 なら元の大きさ。ほかは 16 以上）。 / Maximum width of the returned image in pixels (default ${PREVIEW_DEFAULT_WIDTH}; 0 = full size; otherwise at least 16).` },
        save_as: { type: 'string', description: '画像をプロジェクトのフォルダの中にも保存するときの場所（.png。プロジェクトのフォルダからの相対パス）。 / Optional extra copy (.png), relative to the project folder; must stay inside it.' },
        overwrite: { type: 'boolean', description: 'save_as が既にあるとき上書きするか（既定 false = 断る）。 / Replace an existing save_as file (default false = refuse).' },
      },
      required: ['project', 'time'],
      additionalProperties: false,
    },
    // キャッシュと save_as に画像を書くので readOnly ではない（既にあるファイルは overwrite なしには上書きしない）
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'render',
    title: 'MozaicCut: 書き出し / render',
    description: [
      '動画の書き出しを裏で始め、すぐに job_id を返す（終わるまで待たない）。進み具合と結果は render_status で確かめる。',
      '書き出し先は output（プロジェクトのフォルダからの相対パス、.mp4 / .mov / .mkv）、省けば project の行の output=（既定 out.mp4）。どちらもプロジェクトのフォルダの中だけ。from / to で範囲だけを書き出せる。',
      '書き出し先が素材・.mzc・キャッシュのフォルダなら断る（output-is-source）。既にあるファイルは overwrite=true のときだけ上書きする（既定は断る: output-exists）。',
      '書き出し中は、同じプロジェクトへのほかのツール（check / show / op / preview / render）は busy で断られる。誤りのあるプロジェクトでは始めずに診断を返す。時間がかかるので、見た目の確認は preview で十分なことが多い。',
      '',
      'Starts rendering the video in the background and returns a job_id immediately. Poll render_status for progress and the result.',
      'Output goes to "output" (relative to the project folder; .mp4/.mov/.mkv) or, if omitted, the project line\'s output= (default out.mp4); it must be inside the project folder. from/to render only a range.',
      'An output that is a source media file, the .mzc or inside the cache folder is refused (output-is-source). An existing file is replaced only with overwrite=true (default: refused with output-exists).',
      'While rendering, other tools on the same project (check / show / op / preview / render) return busy. Projects with errors are not started; the diagnostics are returned instead. Rendering is slow, so preview is usually enough to check the look.',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        project: PROJECT_PROP,
        output: { type: 'string', description: '書き出すファイル（プロジェクトのフォルダからの相対パス）。 / Output file, relative to the project folder.' },
        from: { description: '始まりの時刻（秒か "分:秒"）。 / Start time (seconds or "m:ss").', anyOf: [{ type: 'number', minimum: 0 }, { type: 'string' }] },
        to: { description: '終わりの時刻（秒か "分:秒"）。 / End time (seconds or "m:ss").', anyOf: [{ type: 'number', minimum: 0 }, { type: 'string' }] },
        overwrite: { type: 'boolean', description: '書き出し先が既にあるとき上書きするか（既定 false = 断る）。 / Replace an existing output file (default false = refuse).' },
      },
      required: ['project'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'render_status',
    title: 'MozaicCut: 書き出しの様子 / render_status',
    description: [
      'render で始めた書き出しの様子（running / done / failed / cancelled）、経過時間、書き出し先、記録の終わりの部分を返す。job_id を省けば、このサーバーで始めた書き出しの一覧。',
      'wait_seconds を渡せば、終わるまでその秒数まで待つ。cancel=true で止める。',
      '',
      'Returns the state of a render job (running / done / failed / cancelled), elapsed time, output path and the tail of its log. Omit job_id to list all jobs started by this server.',
      'Pass wait_seconds to block until it finishes (up to that many seconds); cancel=true stops it.',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        job_id: { type: 'string', description: 'render が返した job_id。 / The job_id returned by render.' },
        wait_seconds: { type: 'number', minimum: 0, maximum: 600, description: '終わるまで待つ最大の秒数（既定 0）。 / Max seconds to wait for completion (default 0).' },
        cancel: { type: 'boolean', description: 'true なら書き出しを止める。 / Stop the job when true.' },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'list_projects',
    title: 'MozaicCut: プロジェクトを探す / list_projects',
    description: [
      '指定のフォルダ（省けば最初の許したフォルダ）の中の .mzc を探し、パス・大きさ・更新時刻を返す。返す path は、ほかのツールの project にそのまま渡せる。',
      '許したフォルダの外は探さない。recursive=false なら、そのフォルダの直下だけ。',
      '',
      'Lists .mzc project files under a folder (default: the first allowed folder) with path, size and modification time. The returned "path" can be passed as "project" to the other tools.',
      'Never looks outside the allowed folders. recursive=false lists only the folder itself.',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        folder: { type: 'string', description: '探すフォルダ（絶対パスか、最初の許したフォルダからの相対パス）。 / Folder to search (absolute, or relative to the first allowed folder).' },
        recursive: { type: 'boolean', description: '下のフォルダも探すか（既定 true。深さ 6 まで）。 / Search subfolders (default true, depth up to 6).' },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
];

// ---- schema ----
async function toolSchema(args) {
  const section = args.section ?? 'all';
  const format = args.format ?? 'json';
  if (!SCHEMA_SECTIONS.includes(section)) throw new ToolError(`section は ${SCHEMA_SECTIONS.join(' / ')} のどれかです: ${section}`, { code: 'bad-args' });
  if (format === 'text') {
    const r = await serial(() => runMozcut(['schema']));
    if (r.code !== 0) throw new ToolError(`schema を読めませんでした:\n${cleanErr(r.stderr)}`);
    return { content: [{ type: 'text', text: r.stdout }], isError: false };
  }
  const r = await serial(() => runMozcut(['schema', '--json']));
  const j = parseJsonOut(r.stdout);
  if (r.code !== 0 || !j) throw new ToolError(`schema を読めませんでした:\n${cleanErr(r.stderr)}`);
  const data = section === 'all' ? j : { version: j.version, [section]: j[section], ...(section === 'effects' ? { effectsNote: j.effectsNote } : {}) };
  const summary = section === 'all'
    ? `キー ${j.keys?.length ?? 0} 個、効果 ${j.effects?.length ?? 0} 個、操作 ${j.ops?.length ?? 0} 個（操作: ${(j.ops || []).map((o) => o.name).join(', ')}）、機能の早見: ${(j.features || []).map((f) => f.name).join(', ')}`
    : `schema の ${section}`;
  return textResult(summary, data);
}

// ---- 書き出し中のプロジェクト ----
const jobs = new Map();
let jobSeq = 0;

function runningJobOf(projectPath) {
  for (const job of jobs.values()) if (job.state === 'running' && norm(job.project) === norm(projectPath)) return job;
  return null;
}

// 書き出し中のプロジェクトには触れない（キャッシュと .mzc の読み書きがぶつかるため）。serial の中で呼ぶ。
function assertNotRendering(projectPath) {
  const job = runningJobOf(projectPath);
  if (job) {
    throw new ToolError(`このプロジェクトは書き出し中です（job_id ${job.id}）。終わるまで待つ（render_status に wait_seconds）か、cancel で止めてから、もう一度呼んでください`, { code: 'busy', job_id: job.id });
  }
}

// 書き出し先が、素材・フォント・.mzc・キャッシュのフォルダでないことを確かめる。
function assertNotSource(out, projectPath, g, what) {
  const o = norm(realish(out));
  const hit = [...g.sources, ...g.fonts, projectPath].map((p) => realish(p)).find((p) => norm(p) === o);
  if (hit) {
    throw new ToolError(`${what} ${out} はプロジェクトの素材か .mzc そのものです。上書きすると取り戻せないので書きません。別の名前にしてください`, { code: 'output-is-source', path: out });
  }
  if (isInside(realish(cacheDirOf(projectPath)), realish(out))) {
    throw new ToolError(`${what} ${out} はプロジェクトのキャッシュのフォルダの中です。別の場所にしてください`, { code: 'output-is-source', path: out });
  }
}

function assertNotExisting(out, overwrite, what) {
  if (fs.existsSync(out) && overwrite !== true) {
    throw new ToolError(`${what} ${out} は既にあります。上書きするなら overwrite=true を付けて、もう一度呼んでください`, { code: 'output-exists', path: out });
  }
  if (fs.existsSync(out) && !fs.statSync(out).isFile()) throw new ToolError(`${what} ${out} はフォルダです`, { code: 'bad-args', path: out });
}

function boolArg(args, name) {
  if (args[name] !== undefined && typeof args[name] !== 'boolean') throw new ToolError(`${name} は true か false です`, { code: 'bad-args' });
  return args[name] === true;
}

// ---- check ----
// serial の中で呼ぶ（中で serial を使わない）。
async function checkJson(projectPath) {
  const r = await runMozcut(['check', projectPath, '--json'], { project: projectPath });
  const j = parseJsonOut(r.stdout);
  if (!j) throw new ToolError(`check の結果を読めませんでした（終了コード ${r.code}）:\n${cleanErr(r.stderr)}`);
  return j;
}

function diagLine(d) {
  return `${d.line}:${d.col} ${d.severity === 'warning' ? '警告' : 'エラー'}[${d.code}] ${d.message}${d.hint ? `（ヒント: ${d.hint}）` : ''}`;
}

async function toolCheck(args) {
  const projectPath = resolveProject(args.project);
  return serial(async () => {
    assertNotRendering(projectPath);
    const g = await guardProject(projectPath, { fontWarn: true });
    const j = await checkJson(projectPath);
    if (g.warnings.length) j.serverWarnings = g.warnings;
    if (j.error) return textResult(`エラー: ${j.error}`, j, true);
    const diags = j.diagnostics || [];
    const errors = diags.filter((d) => d.severity !== 'warning').length;
    let summary = j.ok
      ? `問題はありません（クリップ ${j.clips?.length ?? 0} 個、長さ ${fmtSec(j.project?.duration ?? 0)}${diags.length ? `、警告 ${diags.length} 件` : ''}）`
      : `誤りが ${errors} 件あります`;
    if (diags.length) summary += '\n' + diags.map(diagLine).join('\n');
    if (g.warnings.length) summary += '\n' + g.warnings.map((w) => `サーバーの警告: ${w}`).join('\n');
    // 誤りがあることはツールの失敗ではない（診断を返すのが仕事）ので isError にしない
    return textResult(summary, j);
  });
}

// ---- show ----
async function toolShow(args) {
  const projectPath = resolveProject(args.project);
  const extra = [];
  if (args.width !== undefined) {
    if (!Number.isInteger(args.width) || args.width < 40 || args.width > 400) throw new ToolError('width は 40〜400 の整数です', { code: 'bad-args' });
    extra.push('--width', String(args.width));
  }
  return serial(async () => {
    assertNotRendering(projectPath);
    const g = await guardProject(projectPath, { fontWarn: true });
    const r = await runMozcut(['show', projectPath, ...extra], { project: projectPath });
    let text = r.stdout + (r.code !== 0 && r.stderr ? `\n${cleanErr(r.stderr)}` : '');
    if (!text) text = cleanErr(r.stderr);
    if (g.warnings.length) text += '\n' + g.warnings.map((w) => `サーバーの警告: ${w}`).join('\n');
    return { content: [{ type: 'text', text }], isError: r.code !== 0 };
  });
}

// ---- op ----
function diffText(results) {
  const out = [];
  for (const res of results || []) {
    for (const c of res.changes || []) {
      const tag = c.kind === 'insert' ? '挿入' : c.kind === 'comment' ? '注釈にする' : '書き換え';
      out.push(`@@ ${c.line} 行目（${tag}）`);
      if (c.before) out.push(`- ${c.before}`);
      if (c.after) out.push(`+ ${c.after}`);
    }
  }
  return out.join('\n');
}

// 試した後の行（書き換え・挿入される行）が外のファイルを指さないことを、エンジンに読ませて確かめる。
async function guardChangedLines(projectPath, results) {
  const after = [];
  for (const res of results || []) for (const c of res.changes || []) if (c.after) after.push(c.after);
  if (after.length === 0) return;
  const dir = path.join(cacheDirOf(projectPath), 'mcp');
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `op-check-${process.pid}.mzc`);
  const text = after.join('\n') + '\n';
  fs.writeFileSync(tmp, text);
  try {
    await guardText(projectPath, text, tmp, { where: '操作の後の ' });
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

async function toolOp(args) {
  const projectPath = resolveProject(args.project);
  let ops = args.ops;
  if (Array.isArray(ops)) {
    if (!ops.every((o) => typeof o === 'string')) throw new ToolError('ops は文字列か、文字列の配列です', { code: 'bad-args' });
    ops = ops.join('\n');
  }
  if (typeof ops !== 'string') throw new ToolError('ops に操作を渡してください（例: "move clip_b 5.5"）。書き方は schema の ops', { code: 'bad-args' });
  const lines = ops.split(/\r?\n/).filter((l) => l.trim() !== '' && !l.trim().startsWith('#'));
  if (lines.length === 0) throw new ToolError('操作がありません（例: "move clip_b 5.5"）。書き方は schema の ops', { code: 'bad-args' });
  const apply = boolArg(args, 'apply');

  const run = async (dry) => {
    const r = await runMozcut(['op', projectPath, '--file', '-', '--json', ...(dry ? ['--dry-run'] : [])], { input: lines.join('\n') + '\n', project: projectPath });
    const j = parseJsonOut(r.stdout);
    if (!j) throw new ToolError(`op の結果を読めませんでした（終了コード ${r.code}）:\n${cleanErr(r.stderr)}`);
    return j;
  };

  const j = await serial(async () => {
    assertNotRendering(projectPath);
    await guardProject(projectPath);
    lines.forEach((l, i) => guardPaths(projectPath, pathsOfOp(l), `${i + 1} 番目の操作`));
    // 保存するときも、まず試して、書き換えた後の行が外のファイルを指さないことを確かめる
    const dry = await run(true);
    if (dry.ok) await guardChangedLines(projectPath, dry.results);
    if (!apply || !dry.ok) return dry;
    const saved = await run(false);
    if (saved.ok && saved.saved) appendHistory(projectPath, lines, saved.results);
    return saved;
  });

  if (j.error && !j.results) return textResult(`エラー: ${j.error}`, j, true);
  const diff = diffText(j.results);
  const data = { ...j, dryRun: !apply, diff };
  const parts = [];
  if (j.ok) {
    parts.push(apply ? (j.saved ? '保存しました。' : '保存されていません（変更がありません）。') : '試しただけで、保存していません（dry_run）。保存するには、同じ ops を apply=true で呼んでください。');
    for (const res of j.results || []) {
      if (res.desc) parts.push(`- ${res.desc}`);
      for (const m of res.moved || []) parts.push(`  時刻が変わる: ${m.id ?? `@${m.line}`} ${fmtSec(m.before.start)}–${fmtSec(m.before.end)} → ${fmtSec(m.after.start)}–${fmtSec(m.after.end)}`);
    }
  } else {
    parts.push('失敗しました。何も書き換えていません。');
    for (const res of j.results || []) {
      if (res.ok || res.code === 'not-applied') continue;
      parts.push(`- ${res.op}: エラー[${res.code}] ${res.error}${res.hint ? `（ヒント: ${res.hint}）` : ''}${res.suggest ? `（候補: ${res.suggest}）` : ''}`);
    }
    for (const d of j.diagnostics || []) parts.push(`- ${diagLine(d)}`);
  }
  if (diff) parts.push('', '差分:', diff);
  return textResult(parts.join('\n'), data, !j.ok);
}

// ---- preview ----
function pngSize(buf) {
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function runFfmpeg(args) {
  return new Promise((resolve) => {
    const child = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true, env: childEnv() });
    let err = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => resolve({ code: -1, err: `${FFMPEG} を起動できません（${e.message}）` }));
    child.on('close', (code) => resolve({ code: code ?? -1, err }));
  });
}

// 返す画像を、幅（maxW。null なら元の大きさ）と大きさの上限に収める。{ file, pngFile, mimeType }
async function fitPreview(full, dir, stamp, maxW) {
  const size = pngSize(fs.readFileSync(full));
  if (!size) throw new ToolError('プレビューの画像が PNG ではありません', { code: 'preview-failed' });
  let target = Math.min(maxW ?? size.width, size.width, PREVIEW_MAX_SIDE);
  if (size.height > PREVIEW_MAX_SIDE) target = Math.min(target, Math.floor((PREVIEW_MAX_SIDE * size.width) / size.height));
  target = Math.max(16, target);
  const scaleTo = async (w, ext) => {
    const out = path.join(dir, `preview-${stamp}-w${w}.${ext}`);
    const f = await runFfmpeg(['-y', '-v', 'error', '-i', full, '-vf', `scale=${w}:-2:flags=area`, ...(ext === 'jpg' ? ['-q:v', '3'] : []), out]);
    if (f.code !== 0) throw new ToolError(`画像を縮められませんでした: ${f.err.trim()}`, { code: 'preview-failed' });
    return out;
  };
  let file = target < size.width ? await scaleTo(target, 'png') : full;
  const pngFile = file;
  let mimeType = 'image/png';
  // それでも大きければ、JPEG にし、さらに縮める
  for (let k = 0; fs.statSync(file).size > PREVIEW_MAX_BYTES && k < 8; k++) {
    if (mimeType === 'image/png') mimeType = 'image/jpeg';
    else target = Math.max(16, Math.floor(target * 0.7));
    file = await scaleTo(target, 'jpg');
  }
  return { file, pngFile, mimeType };
}

// キャッシュの mcp/ の preview-* を、新しいものから PREVIEW_KEEP 枚だけ残す。
function prunePreviews(dir) {
  let ents = [];
  try {
    ents = fs.readdirSync(dir).filter((n) => n.startsWith('preview-')).map((n) => {
      const f = path.join(dir, n);
      return { f, t: fs.statSync(f).mtimeMs };
    });
  } catch { return; }
  ents.sort((a, b) => b.t - a.t);
  for (const e of ents.slice(PREVIEW_KEEP)) fs.rmSync(e.f, { force: true });
}

async function toolPreview(args) {
  const projectPath = resolveProject(args.project);
  if (args.time === undefined) throw new ToolError('time に時刻を渡してください（例: 3.5、"1:02.5"）', { code: 'bad-args' });
  const t = parseTime(args.time, 'time');
  let maxW = PREVIEW_DEFAULT_WIDTH;
  if (args.max_width !== undefined) {
    if (!Number.isInteger(args.max_width) || (args.max_width !== 0 && (args.max_width < 16 || args.max_width > 8192))) {
      throw new ToolError('max_width は 0（元の大きさ）か 16〜8192 の整数です', { code: 'bad-args' });
    }
    maxW = args.max_width === 0 ? null : args.max_width;
  }
  const overwrite = boolArg(args, 'overwrite');
  let saveAs = null;
  if (args.save_as !== undefined) {
    saveAs = resolveOutput(projectPath, String(args.save_as), ['.png'], 'save_as');
    assertNotExisting(saveAs, overwrite, 'save_as');
  }
  return serial(async () => {
    assertNotRendering(projectPath);
    const g = await guardProject(projectPath);
    if (saveAs) assertNotSource(saveAs, projectPath, g, 'save_as');
    const dir = path.join(cacheDirOf(projectPath), 'mcp');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = `${t.secs.toFixed(3).replace('.', '_')}-${Date.now().toString(36)}`;
    const full = path.join(dir, `preview-${stamp}.png`);
    const r = await runMozcut(['preview', projectPath, t.text, '-o', full], { project: projectPath });
    if (r.code !== 0 || !fs.existsSync(full)) {
      throw new ToolError(`プレビューを作れませんでした（誤りがあれば check で確かめてください）:\n${cleanErr(r.stderr)}`, { code: 'preview-failed' });
    }
    const warnings = cleanErr(r.stderr).split('\n').filter((l) => l && !/ に書きました（/.test(l) && !/^mozcut: (ffmpeg で素材|エンジンをビルド)/.test(l));
    const beyondEnd = warnings.some((l) => /全体の長さ.*より後ろ/.test(l));
    const { file, pngFile, mimeType } = await fitPreview(full, dir, stamp, maxW);
    const buf = fs.readFileSync(file);
    let size = pngSize(buf);
    if (!size) size = pngSize(fs.readFileSync(pngFile)); // JPEG のときは同じ幅の PNG から（縦横比は同じ）
    if (saveAs) {
      fs.mkdirSync(path.dirname(saveAs), { recursive: true });
      fs.copyFileSync(pngFile, saveAs);
    }
    prunePreviews(dir);
    const info = {
      ok: true,
      time: t.secs,
      timeText: fmtSec(t.secs),
      beyondEnd,
      width: mimeType === 'image/png' ? size?.width ?? null : null,
      height: mimeType === 'image/png' ? size?.height ?? null : null,
      mimeType,
      bytes: buf.length,
      file,
      savedAs: saveAs,
      warnings,
    };
    const dims = info.width ? `${info.width}x${info.height}` : mimeType;
    const text = `${fmtSec(t.secs)} のコマ（${dims}）。${file}${saveAs ? `、${saveAs} にも保存しました` : ''}${beyondEnd ? '\n全体の長さより後ろの時刻です（背景だけの絵）' : ''}${warnings.length ? `\n${warnings.join('\n')}` : ''}`;
    return {
      content: [
        { type: 'image', data: buf.toString('base64'), mimeType },
        { type: 'text', text },
      ],
      structuredContent: info,
      isError: false,
    };
  });
}

// ---- render ----
function jobView(job, tail = 20) {
  const lines = job.log.split(/\r?\n/).filter((l) => l.trim() !== '');
  return {
    job_id: job.id,
    state: job.state,
    project: job.project,
    output: job.output,
    from: job.from,
    to: job.to,
    startedAt: new Date(job.started).toISOString(),
    elapsedSeconds: Math.round(((job.ended ?? Date.now()) - job.started) / 100) / 10,
    exitCode: job.exitCode,
    outputExists: job.state === 'done' ? fs.existsSync(job.output) : undefined,
    outputBytes: job.state === 'done' && fs.existsSync(job.output) ? fs.statSync(job.output).size : undefined,
    log: lines.slice(-tail),
  };
}

const STATE_JA = { running: '書き出し中', done: '書き出しました', failed: '失敗しました', cancelled: '止めました' };

// 止めた・失敗した書き出しの中途半端なファイルを消す（キャッシュの *.tmp と out.y4m / out.pcm、途中までの書き出し先）。
function cleanupJob(job) {
  const cache = cacheDirOf(job.project);
  const removed = [];
  const rm = (f) => {
    try {
      if (fs.existsSync(f)) { fs.rmSync(f, { force: true }); removed.push(path.basename(f)); }
    } catch (e) { log(`${f} を消せませんでした: ${e.message}`); }
  };
  rm(path.join(cache, 'out.y4m'));
  rm(path.join(cache, 'out.pcm'));
  try {
    for (const n of fs.readdirSync(cache)) if (n.endsWith('.tmp')) rm(path.join(cache, n));
  } catch { /* キャッシュがなければよい */ }
  // 書き出し先は、この書き出しで新しく作ったもの（前からあったものではない）だけを消す
  if (job.state === 'cancelled' && !job.outputExisted) rm(job.output);
  if (removed.length) job.log += `\n途中のファイルを消しました: ${removed.join(', ')}`;
}

async function toolRender(args) {
  const projectPath = resolveProject(args.project);
  const from = args.from !== undefined ? parseTime(args.from, 'from') : null;
  const to = args.to !== undefined ? parseTime(args.to, 'to') : null;
  const overwrite = boolArg(args, 'overwrite');
  if (from && to && from.secs >= to.secs) throw new ToolError(`範囲が空です（from ${from.text} ≥ to ${to.text}）。to は from より後ろにします`, { code: 'bad-args' });
  return serial(async () => {
    assertNotRendering(projectPath);
    const g = await guardProject(projectPath);
    const output = resolveOutput(projectPath, args.output !== undefined ? String(args.output) : g.output, ['.mp4', '.mov', '.mkv', '.m4v'], 'output');
    assertNotSource(output, projectPath, g, 'output');
    assertNotExisting(output, overwrite, 'output');
    // 誤りがあれば始めない（エンジンのビルドもここで済ませる）
    const j = await checkJson(projectPath);
    if (!j.ok) {
      const diags = j.diagnostics || [];
      return textResult(`誤りがあるので書き出しを始めませんでした${j.error ? `: ${j.error}` : ''}\n${diags.map(diagLine).join('\n')}`, { ok: false, started: false, ...j }, true);
    }
    const dur = j.project?.duration;
    if (from && typeof dur === 'number' && from.secs >= dur) {
      throw new ToolError(`範囲が空です（from ${fmtSec(from.secs)} は全体の長さ ${fmtSec(dur)} 以上です）`, { code: 'bad-args', duration: dur });
    }
    const id = `r${++jobSeq}`;
    fs.mkdirSync(path.dirname(output), { recursive: true });
    const cliArgs = ['render', projectPath, '-o', output];
    if (from) cliArgs.push('--from', from.text);
    if (to) cliArgs.push('--to', to.text);
    // プロジェクトのフォルダで起動する（エンジンが font= の相対パスを起動したフォルダから探すため）。
    // POSIX ではプロセスのグループを分け、止めるときに孫（mozcut、ffmpeg）ごと止める。
    const child = spawn(process.execPath, [MOZCUT_MJS, ...cliArgs], {
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, cwd: path.dirname(projectPath), env: childEnv(), detached: !IS_WIN,
    });
    const job = {
      id, state: 'running', project: projectPath, output, outputExisted: fs.existsSync(output),
      from: from?.secs ?? null, to: to?.secs ?? null, started: Date.now(), ended: null, exitCode: null, log: '', child, waiters: [], cancelRequested: false,
    };
    job.closed = new Promise((resolve) => { job.resolveClosed = resolve; });
    const append = (d) => {
      job.log += d;
      if (job.log.length > 200000) job.log = job.log.slice(-100000);
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    const finish = (code, errMsg) => {
      if (job.ended) return;
      if (errMsg) append(`\n${errMsg}`);
      job.ended = Date.now();
      job.exitCode = code;
      if (job.cancelRequested) job.state = 'cancelled';
      else job.state = code === 0 && fs.existsSync(output) ? 'done' : 'failed';
      if (job.state !== 'done') cleanupJob(job);
      for (const w of job.waiters) w();
      job.waiters = [];
      job.resolveClosed();
      log(`書き出し ${id}: ${STATE_JA[job.state]}（${output}）`);
    };
    child.on('error', (e) => finish(-1, `node を起動できません: ${e.message}`));
    child.on('close', (code) => finish(code ?? -1));
    jobs.set(id, job);
    const view = jobView(job);
    return textResult(`書き出しを始めました（job_id ${id}、書き出し先 ${output}）。render_status で様子を確かめてください（wait_seconds を渡せば終わるまで待てます）。書き出し中は、このプロジェクトへのほかのツールは busy になります。`, { ok: true, started: true, ...view });
  });
}

// 書き出しを止め、子のプロセスが本当に終わる（と中途半端なファイルを消す）まで待つ。
async function cancelJob(job, timeoutMs = 20000) {
  if (job.state !== 'running') return;
  job.cancelRequested = true;
  killTree(job.child);
  await Promise.race([job.closed, new Promise((r) => setTimeout(r, timeoutMs))]);
}

async function toolRenderStatus(args) {
  if (args.job_id === undefined) {
    const list = [...jobs.values()].map((j) => jobView(j, 3));
    return textResult(list.length ? list.map((j) => `${j.job_id}: ${STATE_JA[j.state]}（${j.output}、${j.elapsedSeconds} 秒）`).join('\n') : 'このサーバーで始めた書き出しはありません', { jobs: list });
  }
  const job = jobs.get(String(args.job_id));
  if (!job) throw new ToolError(`job_id ${args.job_id} の書き出しはありません（job_id を省けば一覧）`, { code: 'unknown-job' });
  const wait = Number(args.wait_seconds ?? 0);
  if (!Number.isFinite(wait) || wait < 0 || wait > 600) throw new ToolError('wait_seconds は 0〜600 の秒です', { code: 'bad-args' });
  if (boolArg(args, 'cancel') && job.state === 'running') await cancelJob(job);
  if (wait > 0 && job.state === 'running') {
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, wait * 1000);
      job.waiters.push(() => { clearTimeout(timer); resolve(); });
    });
  }
  const view = jobView(job);
  const text = `${job.id}: ${STATE_JA[job.state]}（${job.output}、${view.elapsedSeconds} 秒）${job.state === 'failed' ? `\n${view.log.slice(-10).join('\n')}` : ''}`;
  return textResult(text, view, job.state === 'failed');
}

// ---- list_projects ----
const SKIP_DIRS = new Set(['node_modules', '.git', 'build']);

async function toolListProjects(args) {
  const folder = insideRoots(args.folder !== undefined ? String(args.folder) : ROOTS[0] ?? '.', 'フォルダ');
  if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) throw new ToolError(`フォルダがありません: ${folder}`, { code: 'not-found' });
  const recursive = args.recursive !== false;
  const found = [];
  let truncated = false;
  const walk = (dir, depth) => {
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    ents.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of ents) {
      if (found.length >= 500) { truncated = true; return; }
      const f = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (recursive && depth < 6 && !SKIP_DIRS.has(e.name) && !e.name.endsWith('.cache') && !e.name.startsWith('.')) walk(f, depth + 1);
      } else if (e.isFile() && e.name.toLowerCase().endsWith('.mzc')) {
        const st = fs.statSync(f);
        const root = ROOTS.find((r) => isInside(r, f)) ?? ROOTS[0];
        found.push({ path: f, relative: path.relative(root, f).split(path.sep).join('/'), root, bytes: st.size, modified: new Date(st.mtimeMs).toISOString() });
      }
    }
  };
  walk(folder, 0);
  const text = found.length
    ? `${folder} に .mzc が ${found.length} 個あります${truncated ? '（500 個で打ち切り）' : ''}\n${found.map((p) => `- ${p.path}`).join('\n')}`
    : `${folder} に .mzc はありません`;
  return textResult(text, { folder, roots: ROOTS, projects: found, truncated });
}

const HANDLERS = {
  schema: toolSchema,
  check: toolCheck,
  show: toolShow,
  op: toolOp,
  preview: toolPreview,
  render: toolRender,
  render_status: toolRenderStatus,
  list_projects: toolListProjects,
};

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 / MCP
// ---------------------------------------------------------------------------

function loadLocalAiGuide() {
  const over = process.env.MOZCUT_AI_GUIDE;
  if (over === 'none') return '';
  const cands = [];
  if (over) cands.push(over);
  if (process.env.APPDATA) cands.push(path.join(process.env.APPDATA, 'MozaicCut', 'ai_guide.md'));
  if (process.env.HOME) cands.push(path.join(process.env.HOME, '.config', 'MozaicCut', 'ai_guide.md'));
  cands.push(path.join(HERE, '..', 'ai_guide.local.md'));
  for (const p of cands) {
    try {
      const s = fs.readFileSync(p, 'utf8').trim();
      if (s) return s;
    } catch { /* 任意ファイルなので無視 */ }
  }
  return '';
}

const LOCAL_GUIDE = loadLocalAiGuide();
const INSTRUCTIONS = [
  'MozaicCut（テキストで編集する動画編集ソフト）のプロジェクト（.mzc）を読み書きするツールです。',
  '流れ: list_projects でプロジェクトを探す → schema（1 回）と check で書き方と今の配置を読む → op を dry_run で試して差分を確かめる → op を apply=true で保存 → check で誤りがないことを確かめる → preview で見た目を確かめる → 必要なら render。',
  'クリップは ID で指すのがいちばん安定です（project 行の編集は set project ...）。許したフォルダの外のファイルには触れません。',
  '全機能早見（キーフレーム / 描画モード・マスク・マット / シェイプ / テキストアニメーター / トランジション / リッチテキスト / パーティクル / 3D / エクスプレッション・音連動 / スペクトラム / 2D モーションブラー・親子リンク / カラーグレーディング / 音声ミキサー・BPM / キーイング）は schema の features・effects・transitions・expressions にあります。',
  `許したフォルダ: ${ROOTS.join(' , ') || '（なし）'}`,
  '',
  'Tools for reading and editing MozaicCut (text-based video editor) projects (.mzc).',
  'Workflow: list_projects → schema (once) and check → op as a dry run, inspect the diff → op with apply=true → check again → preview to verify the look → render if needed.',
  'Refer to clips by ID (and "project" for the project line). Files outside the allowed folders are never touched.',
  'See schema "features", "effects", "transitions" and "expressions" for all capabilities; check animations by previewing in-between times.',
  ...(LOCAL_GUIDE ? ['', LOCAL_GUIDE] : []),
].join('\n');

// inputSchema にない引数は断る（additionalProperties: false。保存されると思い込む誤りを防ぐ）。
const SAVE_LIKE = new Set(['dry_run', 'dryrun', 'dryRun', 'save', 'commit', 'write', 'confirm', 'force']);
function checkArgNames(name, args) {
  const tool = TOOLS.find((t) => t.name === name);
  const known = Object.keys(tool?.inputSchema?.properties ?? {});
  const unknown = Object.keys(args).filter((k) => !known.includes(k));
  if (unknown.length === 0) return;
  let hint = '';
  if (name === 'op' && unknown.some((k) => SAVE_LIKE.has(k))) hint = '。保存するには apply=true を使います（既定は dry_run で、保存しません）';
  else if ((name === 'render' || name === 'preview') && unknown.some((k) => SAVE_LIKE.has(k))) hint = '。既にあるファイルを上書きするには overwrite=true を使います';
  throw new ToolError(`${name} に知らない引数があります: ${unknown.join(', ')}（使える引数: ${known.join(', ') || 'なし'}）${hint}`, { code: 'bad-args', unknown, known });
}

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function rpcError(id, code, message, data) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data !== undefined ? { data } : {}) } };
}

async function handle(msg) {
  if (msg === null || typeof msg !== 'object' || Array.isArray(msg) || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    // 応答（result / error）が来たら無視する（このサーバーからは要求を送らない）
    if (msg && typeof msg === 'object' && msg.jsonrpc === '2.0' && msg.method === undefined && ('result' in msg || 'error' in msg)) return null;
    return rpcError(msg && typeof msg === 'object' ? msg.id : null, -32600, 'Invalid Request');
  }
  const isNotification = !('id' in msg);
  const { id, method } = msg;
  const params = msg.params ?? {};
  try {
    switch (method) {
      case 'initialize': {
        if (params.clientInfo && typeof params.clientInfo.name === 'string') clientName = params.clientInfo.name.slice(0, 100);
        const want = params.protocolVersion;
        const protocolVersion = PROTOCOL_VERSIONS.includes(want) ? want : PROTOCOL_VERSIONS[0];
        return {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: SERVER_NAME, title: 'MozaicCut', version: SERVER_VERSION },
            instructions: INSTRUCTIONS,
          },
        };
      }
      case 'notifications/initialized':
      case 'notifications/cancelled':
      case 'notifications/roots/list_changed':
        return null;
      case 'ping':
        return isNotification ? null : { jsonrpc: '2.0', id, result: {} };
      case 'tools/list':
        return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
      case 'tools/call': {
        const name = params.name;
        const handler = Object.hasOwn(HANDLERS, name) ? HANDLERS[name] : null;
        if (!handler) return rpcError(id, -32602, `Unknown tool: ${name}（知らないツールです。tools/list で一覧）`);
        const args = params.arguments ?? {};
        if (typeof args !== 'object' || args === null || Array.isArray(args)) return rpcError(id, -32602, 'arguments must be an object');
        let result;
        try {
          checkArgNames(name, args);
          result = await handler(args);
        } catch (e) {
          if (e instanceof ToolError) result = errorResult(e);
          else {
            log(`${name}: ${e.stack || e.message}`);
            result = errorResult(new ToolError(`内部の誤り: ${e.message}`, { code: 'internal' }));
          }
        }
        return isNotification ? null : { jsonrpc: '2.0', id, result };
      }
      case 'resources/list':
        return { jsonrpc: '2.0', id, result: { resources: [] } };
      case 'prompts/list':
        return { jsonrpc: '2.0', id, result: { prompts: [] } };
      default:
        if (isNotification) return null;
        return rpcError(id, -32601, `Method not found: ${method}`);
    }
  } catch (e) {
    log(`${method}: ${e.stack || e.message}`);
    return isNotification ? null : rpcError(id, -32603, `Internal error: ${e.message}`);
  }
}

async function onLine(line) {
  if (line.trim() === '') return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    send(rpcError(null, -32700, 'Parse error'));
    return;
  }
  if (Array.isArray(msg)) {
    if (msg.length === 0) {
      send(rpcError(null, -32600, 'Invalid Request'));
      return;
    }
    const out = (await Promise.all(msg.map(handle))).filter(Boolean);
    if (out.length) send(out);
    return;
  }
  const res = await handle(msg);
  if (res) send(res);
}

function main() {
  if (!fs.existsSync(MOZCUT_MJS)) log(`${MOZCUT_MJS} がありません（MOZCUT_MJS で場所を指定できます）`);
  log(`起動しました（許したフォルダ: ${ROOTS.join(' , ') || 'なし'}）`);
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  let pending = 0;
  let closed = false;
  let exiting = false;
  const maybeExit = () => {
    if (!closed || pending > 0 || exiting) return;
    exiting = true;
    // 標準入力が閉じ、答えていない要求もなくなったら、書き出し中のものを（孫のプロセスごと）止め、
    // 途中のファイルを消してから終わる
    const running = [...jobs.values()].filter((j) => j.state === 'running');
    Promise.all(running.map((j) => cancelJob(j, 10000))).finally(() => {
      process.stdout.write('', () => process.exit(0));
    });
  };
  rl.on('line', (line) => {
    pending++;
    onLine(line).catch((e) => log(e.stack || e.message)).finally(() => { pending--; maybeExit(); });
  });
  rl.on('close', () => {
    closed = true;
    maybeExit();
  });
}

main();
