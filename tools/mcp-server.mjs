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
//   - 書き換える操作（op）は既定で dry_run（差分を返すだけ）。apply=true のときだけ保存する。
//   - 標準出力には JSON-RPC のメッセージだけを書く。記録は標準エラーに書く。
//
// 使い方（Claude Code / Claude Desktop への登録）は docs/mcp.md、ツールの中身の約束は docs/ai.md を見る。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
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

// 1 行を語に分ける。"..." の中の空白と \" はそのまま。# で始まる語から後ろは注釈。
function tokenize(line) {
  const toks = [];
  let i = 0;
  const n = line.length;
  while (i < n) {
    while (i < n && /\s/.test(line[i])) i++;
    if (i >= n) break;
    if (line[i] === '#') break;
    let raw = '';
    let quoted = false;
    while (i < n && !/\s/.test(line[i])) {
      if (line[i] === '"') {
        quoted = true;
        i++;
        while (i < n && line[i] !== '"') {
          if (line[i] === '\\' && i + 1 < n) {
            raw += line[i + 1] === '"' ? '"' : line[i] + line[i + 1];
            i += 2;
          } else raw += line[i++];
        }
        i++;
      } else raw += line[i++];
    }
    const eq = raw.indexOf('=');
    // key=value（キーは英字で始まる語。"..." だけの語は値ではなく位置の値）
    if (eq > 0 && /^[A-Za-z_][A-Za-z0-9_.-]*$/.test(raw.slice(0, eq))) toks.push({ key: raw.slice(0, eq), value: raw.slice(eq + 1), raw, quoted });
    else toks.push({ key: null, value: raw, raw, quoted });
  }
  return toks;
}

const looksLikeTime = (v) => /^[0-9:.+-]+$/.test(v);

// .mzc の 1 行が読む・書くファイル。{ reads: [...], writes: [...] }
function pathsOfLine(line) {
  const toks = tokenize(line);
  const reads = [];
  const writes = [];
  if (toks.length === 0) return { reads, writes };
  const kind = toks[0].value;
  if (MEDIA_KINDS.has(kind) && toks[1] && toks[1].key === null) reads.push(toks[1].value);
  for (const t of toks.slice(1)) {
    if (t.key === 'src' || t.key === 'font') reads.push(t.value);
    if (kind === 'project' && (t.key === 'output' || t.key === 'out')) writes.push(t.value);
  }
  return { reads, writes };
}

// 操作の 1 行が読む・書くファイル。
function pathsOfOp(line) {
  const toks = tokenize(line);
  const reads = [];
  const writes = [];
  if (toks.length === 0) return { reads, writes };
  const op = toks[0].value;
  if (op === 'add' && toks[1] && MEDIA_KINDS.has(toks[1].value) && toks[2] && toks[2].key === null && toks[2].value !== 'after') reads.push(toks[2].value);
  for (const t of toks.slice(1)) {
    if (t.key === 'src' || t.key === 'font') reads.push(t.value);
    if (t.key === 'output' || (t.key === 'out' && !looksLikeTime(t.value))) writes.push(t.value);
  }
  return { reads, writes };
}

// 読む・書くファイルが許した場所の中か確かめる。外なら ToolError。
function guardPaths(projectPath, { reads, writes }, where) {
  const dir = path.dirname(projectPath);
  for (const r of reads) {
    if (r === '' || r === '-') continue;
    try {
      insideRoots(path.isAbsolute(r) ? r : path.resolve(dir, r), `${where}の素材・フォント`);
    } catch (e) {
      throw new ToolError(`${e.message}\n（${where}: ${r}）`, e.extra);
    }
  }
  for (const w of writes) {
    if (w === '') continue;
    try {
      resolveOutput(projectPath, w, null, `${where}の書き出し先`);
    } catch (e) {
      throw new ToolError(`${e.message}\n（${where}: ${w}）`, e.extra);
    }
  }
}

// プロジェクトの全部の行を確かめる。書き出し先（project の output）も返す。
function guardProject(projectPath) {
  const text = fs.readFileSync(projectPath, 'utf8');
  let output = null;
  text.split(/\r?\n/).forEach((line, i) => {
    const p = pathsOfLine(line);
    guardPaths(projectPath, p, `${i + 1} 行目`);
    if (p.writes.length) output = p.writes[p.writes.length - 1];
  });
  return { output: output ?? 'out.mp4' };
}

// ---------------------------------------------------------------------------
// mozcut.mjs を呼ぶ
// ---------------------------------------------------------------------------

// 同時に 1 つだけ（ビルドやキャッシュの書き込みがぶつからないように）。書き出しは別に動かす。
let lock = Promise.resolve();
function serial(fn) {
  const p = lock.then(fn, fn);
  lock = p.catch(() => {});
  return p;
}

function runMozcut(args, { input = null, timeoutMs = LONG_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [MOZCUT_MJS, ...args], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => {
      stderr += `\n（${Math.round(timeoutMs / 1000)} 秒で終わらなかったので止めました）`;
      child.kill();
    }, timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: `${stderr}\nnode を起動できません: ${e.message}` });
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

function parseTime(v, name) {
  if (typeof v === 'number') {
    if (!Number.isFinite(v) || v < 0) throw new ToolError(`${name} は 0 以上の秒にしてください`, { code: 'bad-args' });
    return { text: String(v), secs: v };
  }
  if (typeof v !== 'string' || !/^\d+(:\d+)*(\.\d+)?$/.test(v.trim())) {
    throw new ToolError(`${name} の値 '${v}' は時刻として読めません（3.5 や "1:02.5" のように書きます）`, { code: 'bad-args' });
  }
  const t = v.trim();
  return { text: t, secs: t.split(':').reduce((a, x) => a * 60 + Number(x), 0) };
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
    name: 'op',
    title: 'MozaicCut: 操作 / op',
    description: [
      'プロジェクトに操作を適用する。既定は dry_run（試すだけで保存しない）で、差分（変わる行の前と後）と、時刻が変わるほかのクリップ（moved）を返す。apply=true のときだけ保存する。',
      '手順: (1) apply を付けずに呼び、diff と results[].desc / moved が意図どおりか確かめる → (2) 同じ ops を apply=true で呼ぶ → (3) check で diagnostics が空なことを確かめる。',
      'ops は 1 行に 1 操作（文字列か、文字列の配列）。全部成功したときだけ保存し、1 つでも失敗すれば何も書かない。誤りが増える操作は断られる。',
      '操作: move <clip> <時刻か参照> / trim <clip> start|end <時刻> / split <clip> <時刻> / delete <clip> [fix-refs] / cut <開始> <終わり> / set <clip> key=value ... / unset <clip> key ... / renamekey <clip> <古い> <新しい> / add <種類> [素材/文字/色] key=value ... [after <clip>] / rename <clip> <新しいID>。',
      'クリップは ID（clip_b。いちばん安定）、#番号（#3）、@行番号（@9）で指す。時刻はタイムライン上の秒（5.5）か "分:秒"（1:02.5）。参照は clip_a.end、clip_a.start+1.5、after:clip_a。詳しくは schema の ops と syntax。',
      '失敗したら results[].code / error / hint / suggest を読んで直す。素材やフォントは許したフォルダの中のファイルだけを使える。',
      '',
      'Applies edit operations to a project. Default is a dry run: nothing is saved, and you get a diff (before/after of each changed line) plus other clips whose times change ("moved"). Only apply=true saves.',
      'Workflow: (1) call without apply and check the diff, results[].desc and moved; (2) call again with the same ops and apply=true; (3) run check and confirm diagnostics is empty.',
      '"ops" is one operation per line (a string, or an array of strings). The batch is all-or-nothing, and an operation that would add errors is refused.',
      'Operations: move, trim, split, delete, cut, set, unset, renamekey, add, rename (see schema "ops" for usage). Refer to clips by ID (most stable), #index or @line. Times are timeline seconds (5.5) or "m:ss" (1:02.5); references look like clip_a.end, clip_a.start+1.5, after:clip_a.',
      'On failure read results[].code / error / hint / suggest. Media and font files must be inside the allowed folders.',
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
      '画像はプロジェクトのキャッシュのフォルダ（<名前>.cache/mcp/）に書く。save_as を渡せば、プロジェクトのフォルダの中のその場所にも書く。誤りのあるプロジェクトでは止まるので、先に check を通す。',
      '初回や素材を変えた後は、素材の展開に数十秒かかることがある。',
      '',
      'Renders the single frame at a timeline time and returns it as a PNG image. Use it to verify what check cannot: text size and position, layer order, colors, effects.',
      'The image is written into the project cache folder (<name>.cache/mcp/); pass save_as to also write it inside the project folder. Fails on projects with errors, so run check first. The first call (or after media changes) may take tens of seconds to decode media.',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        project: PROJECT_PROP,
        time: { description: 'タイムライン上の時刻。秒（3.5）か "分:秒"（"1:02.5"）。 / Timeline time: seconds (3.5) or "m:ss" ("1:02.5").', anyOf: [{ type: 'number', minimum: 0 }, { type: 'string' }] },
        max_width: { type: 'integer', minimum: 16, maximum: 8192, description: '返す画像の最大の幅（画素）。省けば元の大きさ。縮めると速く軽い。 / Maximum width of the returned image in pixels (default: full size).' },
        save_as: { type: 'string', description: '画像をプロジェクトのフォルダの中にも保存するときの場所（.png。プロジェクトのフォルダからの相対パス）。 / Optional extra copy (.png), relative to the project folder; must stay inside it.' },
      },
      required: ['project', 'time'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'render',
    title: 'MozaicCut: 書き出し / render',
    description: [
      '動画の書き出しを裏で始め、すぐに job_id を返す（終わるまで待たない）。進み具合と結果は render_status で確かめる。',
      '書き出し先は output（プロジェクトのフォルダからの相対パス、.mp4 / .mov / .mkv）、省けば project の行の output=（既定 out.mp4）。どちらもプロジェクトのフォルダの中だけ。from / to で範囲だけを書き出せる。',
      '誤りのあるプロジェクトでは始めずに診断を返す。時間がかかるので、見た目の確認は preview で十分なことが多い。',
      '',
      'Starts rendering the video in the background and returns a job_id immediately. Poll render_status for progress and the result.',
      'Output goes to "output" (relative to the project folder; .mp4/.mov/.mkv) or, if omitted, the project line\'s output= (default out.mp4); it must be inside the project folder. from/to render only a range.',
      'Projects with errors are not started; the diagnostics are returned instead. Rendering is slow, so preview is usually enough to check the look.',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        project: PROJECT_PROP,
        output: { type: 'string', description: '書き出すファイル（プロジェクトのフォルダからの相対パス）。 / Output file, relative to the project folder.' },
        from: { description: '始まりの時刻（秒か "分:秒"）。 / Start time (seconds or "m:ss").', anyOf: [{ type: 'number', minimum: 0 }, { type: 'string' }] },
        to: { description: '終わりの時刻（秒か "分:秒"）。 / End time (seconds or "m:ss").', anyOf: [{ type: 'number', minimum: 0 }, { type: 'string' }] },
      },
      required: ['project'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
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
async function checkJson(projectPath) {
  const r = await serial(() => runMozcut(['check', projectPath, '--json']));
  const j = parseJsonOut(r.stdout);
  if (!j) throw new ToolError(`check の結果を読めませんでした（終了コード ${r.code}）:\n${cleanErr(r.stderr)}`);
  return j;
}

function diagLine(d) {
  return `${d.line}:${d.col} ${d.severity === 'warning' ? '警告' : 'エラー'}[${d.code}] ${d.message}${d.hint ? `（ヒント: ${d.hint}）` : ''}`;
}

async function toolCheck(args) {
  const projectPath = resolveProject(args.project);
  guardProject(projectPath);
  const j = await checkJson(projectPath);
  if (j.error) return textResult(`エラー: ${j.error}`, j, true);
  const diags = j.diagnostics || [];
  const errors = diags.filter((d) => d.severity !== 'warning').length;
  let summary = j.ok
    ? `問題はありません（クリップ ${j.clips?.length ?? 0} 個、長さ ${fmtSec(j.project?.duration ?? 0)}${diags.length ? `、警告 ${diags.length} 件` : ''}）`
    : `誤りが ${errors} 件あります`;
  if (diags.length) summary += '\n' + diags.map(diagLine).join('\n');
  // 誤りがあることはツールの失敗ではない（診断を返すのが仕事）ので isError にしない
  return textResult(summary, j);
}

// ---- show ----
async function toolShow(args) {
  const projectPath = resolveProject(args.project);
  guardProject(projectPath);
  const extra = [];
  if (args.width !== undefined) {
    if (!Number.isInteger(args.width) || args.width < 40 || args.width > 400) throw new ToolError('width は 40〜400 の整数です', { code: 'bad-args' });
    extra.push('--width', String(args.width));
  }
  const r = await serial(() => runMozcut(['show', projectPath, ...extra]));
  const text = r.stdout + (r.code !== 0 && r.stderr ? `\n${cleanErr(r.stderr)}` : '');
  return { content: [{ type: 'text', text: text || cleanErr(r.stderr) }], isError: r.code !== 0 };
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
  if (args.apply !== undefined && typeof args.apply !== 'boolean') throw new ToolError('apply は true か false です', { code: 'bad-args' });
  const apply = args.apply === true;
  guardProject(projectPath);
  lines.forEach((l, i) => guardPaths(projectPath, pathsOfOp(l), `${i + 1} 番目の操作`));

  const run = async (dry) => {
    const r = await runMozcut(['op', projectPath, '--file', '-', '--json', ...(dry ? ['--dry-run'] : [])], { input: lines.join('\n') + '\n' });
    const j = parseJsonOut(r.stdout);
    if (!j) throw new ToolError(`op の結果を読めませんでした（終了コード ${r.code}）:\n${cleanErr(r.stderr)}`);
    return j;
  };

  const j = await serial(async () => {
    // 保存するときも、まず試して、書き換えた後の行が外のファイルを指さないことを確かめる
    const dry = await run(true);
    if (dry.ok) {
      for (const res of dry.results || []) {
        for (const c of res.changes || []) if (c.after) guardPaths(projectPath, pathsOfLine(c.after), `${c.line} 行目（操作の後）`);
      }
    }
    if (!apply || !dry.ok) return dry;
    return run(false);
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
    const child = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let err = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => resolve({ code: -1, err: `${FFMPEG} を起動できません（${e.message}）` }));
    child.on('close', (code) => resolve({ code: code ?? -1, err }));
  });
}

async function toolPreview(args) {
  const projectPath = resolveProject(args.project);
  if (args.time === undefined) throw new ToolError('time に時刻を渡してください（例: 3.5、"1:02.5"）', { code: 'bad-args' });
  const t = parseTime(args.time, 'time');
  let saveAs = null;
  if (args.save_as !== undefined) saveAs = resolveOutput(projectPath, String(args.save_as), ['.png'], 'save_as');
  if (args.max_width !== undefined && (!Number.isInteger(args.max_width) || args.max_width < 16)) throw new ToolError('max_width は 16 以上の整数です', { code: 'bad-args' });
  guardProject(projectPath);
  const dir = path.join(cacheDirOf(projectPath), 'mcp');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = t.secs.toFixed(3).replace('.', '_');
  const full = path.join(dir, `preview-${stamp}.png`);
  const r = await serial(() => runMozcut(['preview', projectPath, t.text, '-o', full]));
  if (r.code !== 0 || !fs.existsSync(full)) {
    throw new ToolError(`プレビューを作れませんでした（誤りがあれば check で確かめてください）:\n${cleanErr(r.stderr)}`, { code: 'preview-failed' });
  }
  const warnings = cleanErr(r.stderr).split('\n').filter((l) => l && !/ に書きました（/.test(l) && !/^mozcut: (ffmpeg で素材|エンジンをビルド)/.test(l));
  let file = full;
  let size = pngSize(fs.readFileSync(full));
  if (args.max_width !== undefined && size && size.width > args.max_width) {
    const small = path.join(dir, `preview-${stamp}-w${args.max_width}.png`);
    const f = await runFfmpeg(['-y', '-v', 'error', '-i', full, '-vf', `scale=${args.max_width}:-2:flags=area`, small]);
    if (f.code !== 0) throw new ToolError(`画像を縮められませんでした: ${f.err.trim()}`);
    file = small;
  }
  const buf = fs.readFileSync(file);
  size = pngSize(buf);
  if (saveAs) {
    fs.mkdirSync(path.dirname(saveAs), { recursive: true });
    fs.copyFileSync(file, saveAs);
  }
  const info = {
    ok: true,
    time: t.secs,
    timeText: fmtSec(t.secs),
    width: size?.width ?? null,
    height: size?.height ?? null,
    file,
    savedAs: saveAs,
    warnings,
  };
  const text = `${fmtSec(t.secs)} のコマ（${info.width}x${info.height}）。${file}${saveAs ? `、${saveAs} にも保存しました` : ''}${warnings.length ? `\n${warnings.join('\n')}` : ''}`;
  return {
    content: [
      { type: 'image', data: buf.toString('base64'), mimeType: 'image/png' },
      { type: 'text', text },
    ],
    structuredContent: info,
    isError: false,
  };
}

// ---- render ----
const jobs = new Map();
let jobSeq = 0;

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

async function toolRender(args) {
  const projectPath = resolveProject(args.project);
  const { output: projOut } = guardProject(projectPath);
  const output = resolveOutput(projectPath, args.output !== undefined ? String(args.output) : projOut, ['.mp4', '.mov', '.mkv', '.m4v'], 'output');
  const from = args.from !== undefined ? parseTime(args.from, 'from') : null;
  const to = args.to !== undefined ? parseTime(args.to, 'to') : null;
  if (from && to && from.secs >= to.secs) throw new ToolError(`範囲が空です（from ${from.text} ≥ to ${to.text}）。to は from より後ろにします`, { code: 'bad-args' });
  for (const job of jobs.values()) {
    if (job.state === 'running' && norm(job.project) === norm(projectPath)) {
      throw new ToolError(`このプロジェクトはもう書き出し中です（job_id ${job.id}）。render_status で確かめるか、cancel で止めてください`, { code: 'busy', job_id: job.id });
    }
  }
  // 誤りがあれば始めない（エンジンのビルドもここで済ませる）
  const j = await checkJson(projectPath);
  if (!j.ok) {
    const diags = j.diagnostics || [];
    return textResult(`誤りがあるので書き出しを始めませんでした${j.error ? `: ${j.error}` : ''}\n${diags.map(diagLine).join('\n')}`, { ok: false, started: false, ...j }, true);
  }
  const id = `r${++jobSeq}`;
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const cliArgs = ['render', projectPath, '-o', output];
  if (from) cliArgs.push('--from', from.text);
  if (to) cliArgs.push('--to', to.text);
  const child = spawn(process.execPath, [MOZCUT_MJS, ...cliArgs], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const job = { id, state: 'running', project: projectPath, output, from: from?.secs ?? null, to: to?.secs ?? null, started: Date.now(), ended: null, exitCode: null, log: '', child, waiters: [] };
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
    if (job.state === 'running') job.state = code === 0 && fs.existsSync(output) ? 'done' : 'failed';
    for (const w of job.waiters) w();
    job.waiters = [];
    log(`書き出し ${id}: ${STATE_JA[job.state]}（${output}）`);
  };
  child.on('error', (e) => finish(-1, `node を起動できません: ${e.message}`));
  child.on('close', (code) => finish(code ?? -1));
  jobs.set(id, job);
  const view = jobView(job);
  return textResult(`書き出しを始めました（job_id ${id}、書き出し先 ${output}）。render_status で様子を確かめてください（wait_seconds を渡せば終わるまで待てます）。`, { ok: true, started: true, ...view });
}

async function toolRenderStatus(args) {
  if (args.job_id === undefined) {
    const list = [...jobs.values()].map((j) => jobView(j, 3));
    return textResult(list.length ? list.map((j) => `${j.job_id}: ${STATE_JA[j.state]}（${j.output}、${j.elapsedSeconds} 秒）`).join('\n') : 'このサーバーで始めた書き出しはありません', { jobs: list });
  }
  const job = jobs.get(String(args.job_id));
  if (!job) throw new ToolError(`job_id ${args.job_id} の書き出しはありません（job_id を省けば一覧）`, { code: 'unknown-job' });
  if (args.cancel === true && job.state === 'running') {
    job.state = 'cancelled';
    job.child.kill();
  }
  const wait = Number(args.wait_seconds ?? 0);
  if (!Number.isFinite(wait) || wait < 0 || wait > 600) throw new ToolError('wait_seconds は 0〜600 の秒です', { code: 'bad-args' });
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
        if (typeof args !== 'object' || Array.isArray(args)) return rpcError(id, -32602, 'arguments must be an object');
        let result;
        try {
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
  const maybeExit = () => {
    if (!closed || pending > 0) return;
    // 標準入力が閉じ、答えていない要求もなくなったら、書き出し中のものを止めて終わる
    for (const job of jobs.values()) if (job.state === 'running') { job.state = 'cancelled'; job.child.kill(); }
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
