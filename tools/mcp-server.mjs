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

function log(msg) {
  process.stderr.write(`mozcut-mcp: ${msg}\n`);
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
// （src/project.um の pjTokenize / pjReadQuoted / pjHashColorAt）を 1 文字ずつ同じ決まりで写したもので読む。
// 写しは素材の二重の確かめにも使う（どちらかが外を指せば断る）。src/project.um の字句解析を変えたら、ここも直す。

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
      '最初に 1 回読むこと。効果はプラグインで増えるので、名前や範囲を覚え込まず、ここで確かめる。大きいので section で絞れる（keys / effects / ops / syntax）。',
      '',
      'Returns the reference for writing MozaicCut projects as JSON: keys (type, range, default, allowed line kinds), effects (plugins: name, params, ranges), ops (usage and examples for the op tool), and the time/reference syntax.',
      'Read it once before editing; effects come from plugins, so always check here instead of guessing. Use "section" to fetch only keys / effects / ops / syntax.',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        section: { type: 'string', enum: ['all', 'keys', 'effects', 'ops', 'syntax'], description: '返す部分（既定 all）。 / Which part to return (default all).' },
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
      '',
      'Checks a project and returns diagnostics plus every clip after layout (index, id, line, track, start/end seconds, keys, effects) as JSON. Read-only.',
      '"ok": true means no errors. Fix problems using diagnostics[].code / line / col / hint / suggest (the hint usually says exactly how). Call it before and after editing.',
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
  if (!['all', 'keys', 'effects', 'ops', 'syntax'].includes(section)) throw new ToolError(`section は all / keys / effects / ops / syntax のどれかです: ${section}`, { code: 'bad-args' });
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
    ? `キー ${j.keys?.length ?? 0} 個、効果 ${j.effects?.length ?? 0} 個、操作 ${j.ops?.length ?? 0} 個（操作: ${(j.ops || []).map((o) => o.name).join(', ')}）`
    : `schema の ${section}`;
  return textResult(summary, data);
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
    const g = await guardProject(projectPath, { fontWarn: true });
    const r = await runMozcut(['show', projectPath, ...extra], { project: projectPath });
    let text = r.stdout + (r.code !== 0 && r.stderr ? `\n${cleanErr(r.stderr)}` : '');
    if (!text) text = cleanErr(r.stderr);
    if (g.warnings.length) text += '\n' + g.warnings.map((w) => `サーバーの警告: ${w}`).join('\n');
    return { content: [{ type: 'text', text }], isError: r.code !== 0 };
  });
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
  list_projects: toolListProjects,
};

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 / MCP
// ---------------------------------------------------------------------------

const INSTRUCTIONS = [
  'MozaicCut（テキストで編集する動画編集ソフト）のプロジェクト（.mzc）を読み書きするツールです。',
  '流れ: list_projects でプロジェクトを探す → schema（1 回）と check で書き方と今の配置を読む → op を dry_run で試して差分を確かめる → op を apply=true で保存 → check で誤りがないことを確かめる → preview で見た目を確かめる → 必要なら render。',
  'クリップは ID で指すのがいちばん安定です。許したフォルダの外のファイルには触れません。',
  `許したフォルダ: ${ROOTS.join(' , ') || '（なし）'}`,
  '',
  'Tools for reading and editing MozaicCut (text-based video editor) projects (.mzc).',
  'Workflow: list_projects → schema (once) and check → op as a dry run, inspect the diff → op with apply=true → check again → preview to verify the look → render if needed.',
  'Refer to clips by ID. Files outside the allowed folders are never touched.',
].join('\n');

// inputSchema にない引数は断る（additionalProperties: false。保存されると思い込む誤りを防ぐ）。
const SAVE_LIKE = new Set(['dry_run', 'dryrun', 'dryRun', 'save', 'commit', 'write', 'confirm', 'force']);
function checkArgNames(name, args) {
  const tool = TOOLS.find((t) => t.name === name);
  const known = Object.keys(tool?.inputSchema?.properties ?? {});
  const unknown = Object.keys(args).filter((k) => !known.includes(k));
  if (unknown.length === 0) return;
  let hint = '';
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
    // 標準入力が閉じ、答えていない要求もなくなったら終わる
    process.stdout.write('', () => process.exit(0));
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
