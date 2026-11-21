#!/usr/bin/env node
// MozaicCut のテスト。node tests/run.mjs で全部、node tests/run.mjs diag layout のように群を選んで流す。
// npm の依存はない。エンジン（build/mozcut）が古ければ、最初に tools/mozcut.mjs でビルドし直す。
//
// 群:
//   diag    tests/cases/diag/<名前>.mzc の check --json の診断（code・line・col）を <名前>.expect.json と比べる
//   layout  tests/cases/layout/<名前>.mzc の check --json の clips の start / end を比べる
//
// オプション:
//   --keep     作業用のフォルダを消さずに残す
//   -v         落ちたテストの詳しい出力を出す
//
// 素材の情報は tests/cases/probe.txt（ffprobe の結果の代わり）を使うので、素材のファイルは要らない。
// 作業はすべて一時フォルダの写しで行い、tests/cases は書き換えない。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CASES = path.join(ROOT, 'tests', 'cases');
const EXE = path.join(ROOT, 'build', 'mozcut' + (process.platform === 'win32' ? '.exe' : ''));
const MOZCUT_MJS = path.join(ROOT, 'tools', 'mozcut.mjs');
const PROBE = path.join(CASES, 'probe.txt');

const argv = process.argv.slice(2);
const UPDATE = argv.includes('--update');
const KEEP = argv.includes('--keep');
const VERBOSE = argv.includes('-v');
const GROUPS = ['diag', 'layout'];
const picked = argv.filter((a) => !a.startsWith('-'));
for (const g of picked) {
  if (!GROUPS.includes(g)) {
    console.error(`知らない群です: ${g}（${GROUPS.join(' / ')} のどれか）`);
    process.exit(2);
  }
}
const want = picked.length ? picked : GROUPS;

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mozcut-tests-'));
let passed = 0;
const failures = [];

// ---- 小さな道具 ----

class Fail extends Error {}
function fail(msg) {
  throw new Fail(msg);
}
function assert(cond, msg) {
  if (!cond) fail(msg);
}

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    const msg = e instanceof Fail ? e.message : (e.stack || String(e));
    failures.push({ name, msg });
    console.log(`  NG  ${name}`);
    for (const l of msg.split('\n')) console.log(`        ${l}`);
  }
}

function run(cmd, args, { input, cwd } = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', input, cwd, maxBuffer: 1 << 26 });
  if (r.error) fail(`${cmd} を起動できません: ${r.error.message}`);
  return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
}

function engine(args, opts) {
  return run(EXE, args, opts);
}

function parseJson(text, what) {
  try {
    return JSON.parse(text);
  } catch (e) {
    fail(`${what} の出力が JSON として読めません（${e.message}）\n${text.slice(0, 400)}`);
  }
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function list(dir, ext) {
  return fs.readdirSync(dir).filter((f) => f.endsWith(ext)).sort();
}

// 一時フォルダに .mzc の写しと cache（probe.txt）を作る。
let seq = 0;
function sandbox(srcFile, name = 'p.mzc') {
  const dir = path.join(TMP, `t${++seq}`);
  fs.mkdirSync(path.join(dir, 'cache'), { recursive: true });
  fs.copyFileSync(PROBE, path.join(dir, 'cache', 'probe.txt'));
  const file = path.join(dir, name);
  fs.copyFileSync(srcFile, file);
  return { dir, file, cache: path.join(dir, 'cache') };
}

function near(a, b, eps = 1e-6) {
  return typeof a === 'number' && Math.abs(a - b) <= eps;
}

// 引用符を外して空白で分ける（シェルがコマンドラインの引数を分けるのと同じ）。
function shellWords(s) {
  const out = [];
  let cur = '';
  let inQ = false;
  let has = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"') {
      inQ = !inQ;
      has = true;
    } else if (c === '\\' && inQ && s[i + 1] === '"') {
      cur += '"';
      i++;
    } else if (!inQ && /\s/.test(c)) {
      if (has || cur) out.push(cur);
      cur = '';
      has = false;
    } else {
      cur += c;
      has = true;
    }
  }
  if (has || cur) out.push(cur);
  return out;
}

function check(file, cache) {
  const r = engine(['check', file, cache, '--json']);
  const j = parseJson(r.out, `check --json ${path.basename(file)}`);
  return { ...r, j };
}

function fmtDiags(ds) {
  return ds.map((d) => `${d.code}@${d.line}:${d.col}`).join(', ') || '（なし）';
}

// ---- ビルド ----

function ensureEngine() {
  // schema は build() を通るので、ソースが新しければここでビルドし直される
  const r = run(process.execPath, [MOZCUT_MJS, 'schema', '--json']);
  if (r.code !== 0 || !fs.existsSync(EXE)) {
    console.error('エンジンを用意できません（node tools/mozcut.mjs build を確かめてください）');
    console.error(r.err);
    process.exit(2);
  }
}

// ---- diag ----

function groupDiag() {
  const dir = path.join(CASES, 'diag');
  const seen = new Set();
  for (const f of list(dir, '.mzc')) {
    const name = f.replace(/\.mzc$/, '');
    test(`diag/${name}`, () => {
      const exp = readJson(path.join(dir, `${name}.expect.json`));
      const sb = sandbox(path.join(dir, f));
      const { code, j } = check(sb.file, sb.cache);
      const got = j.diagnostics;
      assert(Array.isArray(got), 'diagnostics が配列ではありません');
      for (const d of got) {
        seen.add(d.code);
        assert(typeof d.message === 'string' && d.message.length > 0, `${d.code} の message が空です`);
        assert(typeof d.hint === 'string', `${d.code} の hint が文字列ではありません`);
        assert(d.severity === 'error' || d.severity === 'warning', `${d.code} の severity が '${d.severity}' です`);
      }
      const ok = got.length === exp.diagnostics.length &&
        exp.diagnostics.every((e, i) => got[i].code === e.code && got[i].line === e.line && got[i].col === e.col);
      assert(ok, `診断が違います\n  期待: ${fmtDiags(exp.diagnostics)}\n  実際: ${fmtDiags(got)}`);
      exp.diagnostics.forEach((e, i) => {
        if (e.hintIncludes) {
          assert(got[i].hint.includes(e.hintIncludes), `${i + 1} 番目の hint に '${e.hintIncludes}' がありません: '${got[i].hint}'`);
        }
      });
      assert(code === exp.exit, `終了コードが ${code} です（期待は ${exp.exit}）`);
      // 人向けの出力にも同じ件数の「ファイル:行:列: エラー[code]」が出る
      const h = engine(['check', sb.file, sb.cache]);
      assert(h.code === exp.exit, `人向けの check の終了コードが ${h.code} です`);
      for (const e of exp.diagnostics) {
        const loc = e.line > 0 ? (e.col > 0 ? `:${e.line}:${e.col}:` : `:${e.line}:`) : '';
        assert(h.out.includes(`p.mzc${loc}`) && h.out.includes(`[${e.code}]`), `人向けの出力に ${e.code}（${e.line}:${e.col}）が見当たりません\n${h.out}`);
      }
    });
  }
  test('diag: 設計の文書の code の表をすべて出している', () => {
    const doc = fs.readFileSync(path.join(ROOT, 'docs', 'design', 'architecture.md'), 'utf8');
    const sec = doc.slice(doc.indexOf('### 診断'), doc.indexOf('### ID と参照'));
    const codes = new Set();
    for (const row of sec.split('\n').filter((l) => l.startsWith('| `'))) {
      const cell = row.split('|')[1];
      for (const m of cell.matchAll(/`([a-z-]+)`/g)) codes.add(m[1]);
    }
    assert(codes.size >= 20, `文書の表から code を読めません（${codes.size} 個）`);
    const missing = [...codes].filter((c) => !seen.has(c));
    assert(missing.length === 0, `テストで一度も出ていない code: ${missing.join(', ')}`);
  });
}

// ---- layout ----

function groupLayout() {
  const dir = path.join(CASES, 'layout');
  for (const f of list(dir, '.mzc')) {
    const name = f.replace(/\.mzc$/, '');
    test(`layout/${name}`, () => {
      const exp = readJson(path.join(dir, `${name}.expect.json`));
      const sb = sandbox(path.join(dir, f));
      const { code, j } = check(sb.file, sb.cache);
      assert(j.diagnostics.length === 0, `誤りが出ました: ${fmtDiags(j.diagnostics)}`);
      assert(code === 0, `終了コードが ${code} です`);
      const bad = [];
      for (const [id, [s, e]] of Object.entries(exp.clips)) {
        const c = j.clips.find((x) => x.id === id);
        if (!c) {
          bad.push(`${id}: クリップがありません`);
          continue;
        }
        if (!near(c.start, s) || !near(c.end, e)) bad.push(`${id}: 期待 ${s}〜${e}、実際 ${c.start}〜${c.end}`);
        if (!near(c.duration, e - s)) bad.push(`${id}: duration が ${c.duration}（end - start は ${e - s}）`);
      }
      if (exp.duration !== undefined && !near(j.project.duration, exp.duration)) {
        bad.push(`project.duration: 期待 ${exp.duration}、実際 ${j.project.duration}`);
      }
      assert(bad.length === 0, bad.join('\n'));
    });
  }
}

// ---- 実行 ----

console.log(`MozaicCut のテスト（作業用: ${TMP}）`);
ensureEngine();
const groups = { diag: groupDiag, layout: groupLayout };
for (const g of want) {
  console.log(`\n[${g}]`);
  groups[g]();
}
if (!KEEP) fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${passed} 件合格、${failures.length} 件不合格`);
if (failures.length) {
  console.log('不合格: ' + failures.map((f) => f.name).join(', '));
  if (VERBOSE) for (const f of failures) console.log(`\n== ${f.name}\n${f.msg}`);
}
process.exit(failures.length ? 1 : 0);
