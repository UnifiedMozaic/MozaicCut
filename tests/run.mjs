#!/usr/bin/env node
// MozaicCut のテスト。node tests/run.mjs で全部、node tests/run.mjs diag ops のように群を選んで流す。
// npm の依存はない。エンジン（build/mozcut）が古ければ、最初に tools/mozcut.mjs でビルドし直す。
//
// 群:
//   diag    tests/cases/diag/<名前>.mzc の check --json の診断（code・line・col）を <名前>.expect.json と比べる
//   layout  tests/cases/layout/<名前>.mzc の check --json の clips の start / end を比べる
//   ops     tests/cases/ops/<名前>.json の操作を、op --dry-run --json と op --json で試し、書き換えた結果を
//           <名前>.after.mzc と比べる。失敗する操作は何も書かないこと
//   fx      tests/cases/fx/<名前>.mzc を preview で BMP に書き、画素の値を確かめる
//   report  show と schema（文と JSON）が落ちずに出ること
//   cli     tools/mozcut.mjs から check / op を通す（CRLF の保存、使い方の誤り）
//   golden  tests/cases/golden/<名前>.mzc を preview と render で描き、基準（<名前>@<時刻>.bmp と <名前>.expect.json の
//           ハッシュ）と 1 バイトも違わないこと。素材（Y4M / PAM）は決まった模様をここで作る
//   play    再生エンジン（src/playback.um）の時計・J/K/L・シーク・コマ送り・統計・音の時計・先読みの頼み、
//           先読みの枠から描いたコマがファイルから描いたコマと同じこと（tests/um/m1check.um を src/ の写しでビルドして使う）
//
// オプション:
//   --update   ops の .after.mzc と golden の基準を今の実装の結果で書き直す（書き直したら、差分を目で確かめること）
//   --keep     作業用のフォルダを消さずに残す
//   -v         落ちたテストの詳しい出力を出す
//
// 環境変数 MOZCUT_TEST_EXE で、試すエンジンを替えられる（GPU 版や、前の版との比べ）。
// 素材の情報は tests/cases/probe.txt（ffprobe の結果の代わり）を使うので、素材のファイルは要らない。
// 作業はすべて一時フォルダの写しで行い、tests/cases は書き換えない（--update のときだけ .after.mzc を書く）。
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CASES = path.join(ROOT, 'tests', 'cases');
const EXT = process.platform === 'win32' ? '.exe' : '';
const EXE = process.env.MOZCUT_TEST_EXE ? path.resolve(process.env.MOZCUT_TEST_EXE) : path.join(ROOT, 'build', 'mozcut' + EXT);
const MOZCUT_MJS = path.join(ROOT, 'tools', 'mozcut.mjs');
const PROBE = path.join(CASES, 'probe.txt');

const argv = process.argv.slice(2);
const UPDATE = argv.includes('--update');
const KEEP = argv.includes('--keep');
const VERBOSE = argv.includes('-v');
const GROUPS = ['diag', 'layout', 'ops', 'fx', 'report', 'cli', 'golden', 'play'];
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
let skipped = 0;

// ---- 小さな道具 ----

class Fail extends Error {}
function fail(msg) {
  throw new Fail(msg);
}
function assert(cond, msg) {
  if (!cond) fail(msg);
}

class Skip extends Error {}
function skip(msg) {
  throw new Skip(msg);
}

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    if (e instanceof Skip) {
      skipped++;
      console.log(`  --  ${name}（${e.message}）`);
      return;
    }
    const msg = e instanceof Fail ? e.message : (e.stack || String(e));
    failures.push({ name, msg });
    console.log(`  NG  ${name}`);
    for (const l of msg.split('\n')) console.log(`        ${l}`);
  }
}

function run(cmd, args, { input, cwd, env, timeout } = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', input, cwd, env, timeout, maxBuffer: 1 << 26 });
  if (r.error && r.error.code === 'ETIMEDOUT') fail(`${path.basename(cmd)} が ${timeout} ms で終わりませんでした（止めました）`);
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

// ---- ops ----

function opArgs(sb, ops, extra) {
  if (ops.length === 1) return { args: ['op', sb.file, sb.cache, ...shellWords(ops[0]), ...extra] };
  return { args: ['op', sb.file, sb.cache, '--file', '-', ...extra], input: ops.join('\n') + '\n' };
}

function layoutOf(j) {
  const m = {};
  for (const c of j.clips) if (c.id) m[c.id] = [c.start, c.end];
  return m;
}

function groupOps() {
  const dir = path.join(CASES, 'ops');
  for (const f of list(dir, '.json')) {
    const name = f.replace(/\.json$/, '');
    test(`ops/${name}`, () => {
      const spec = readJson(path.join(dir, f));
      const baseFile = path.join(dir, spec.base);
      const before = fs.readFileSync(baseFile);

      // 1. --dry-run --json: 結果は出すが、ファイルは書かない
      const sb = sandbox(baseFile);
      const baseDiags = check(sb.file, sb.cache).j.diagnostics.length;
      const d = opArgs(sb, spec.ops, ['--dry-run', '--json']);
      const dr = engine(d.args, { input: d.input });
      const dj = parseJson(dr.out, 'op --dry-run --json');
      assert(dj.ok === spec.ok, `--dry-run の ok が ${dj.ok} です（期待は ${spec.ok}）\n${dr.out}${dr.err}`);
      assert(dj.saved === false, '--dry-run なのに saved が true です');
      assert(Buffer.compare(fs.readFileSync(sb.file), before) === 0, '--dry-run なのにファイルが変わりました');
      assert(dr.code === (spec.ok ? 0 : 1), `--dry-run の終了コードが ${dr.code} です`);
      assert(Array.isArray(dj.results) && dj.results.length === spec.ops.length,
        `results の数が ${dj.results?.length} です（操作は ${spec.ops.length} 個）`);
      if (spec.codes) {
        const codes = dj.results.map((r) => r.code);
        assert(JSON.stringify(codes) === JSON.stringify(spec.codes), `code が違います: 期待 ${spec.codes.join(', ')}、実際 ${codes.join(', ')}`);
      }
      for (const r of dj.results) {
        if (spec.ok) {
          assert(r.ok === true && r.code === '' && r.desc !== '', `成功した操作の結果がおかしい: ${JSON.stringify(r)}`);
          assert(r.changes.length > 0, `成功した操作に changes がありません: ${r.op}`);
        } else {
          assert(r.ok === false && r.error !== '', `失敗したバッチの結果に ok=false と error がありません: ${JSON.stringify(r)}`);
          assert(r.changes.length === 0, `失敗したバッチの結果に changes があります: ${r.op}`);
        }
      }
      if (spec.newId !== undefined) {
        const last = dj.results[dj.results.length - 1];
        assert(last.newId === spec.newId, `newId が '${last.newId}' です（期待は '${spec.newId}'）`);
      }

      // 2. 実際に書き換える（--json）
      const w = opArgs(sb, spec.ops, ['--json']);
      const wr = engine(w.args, { input: w.input });
      const wj = parseJson(wr.out, 'op --json');
      const after = fs.readFileSync(sb.file);
      if (!spec.ok) {
        assert(wr.code === 1, `失敗する操作の終了コードが ${wr.code} です`);
        assert(wj.ok === false && wj.saved === false, `失敗したのに ok=${wj.ok} saved=${wj.saved} です`);
        assert(Buffer.compare(after, before) === 0, '失敗した操作がファイルを書き換えました');
        // 人向け: 標準エラーに「エラー[code]」と「何も書き換えていません」
        const h = opArgs(sb, spec.ops, []);
        const hr = engine(h.args, { input: h.input });
        const lastCode = spec.codes ? spec.codes[spec.codes.length - 1] : '';
        assert(hr.code === 1 && hr.err.includes(`エラー[${lastCode}]`) && hr.err.includes('何も書き換えていません'),
          `人向けの失敗の表示がおかしい（終了コード ${hr.code}）\n${hr.err}`);
        assert(Buffer.compare(fs.readFileSync(sb.file), before) === 0, '人向けの失敗した操作がファイルを書き換えました');
        return;
      }
      assert(wr.code === 0 && wj.ok === true && wj.saved === true, `書き換えに失敗しました（終了コード ${wr.code}）\n${wr.out}${wr.err}`);
      // --dry-run と実際の書き換えで、結果（desc と changes）は同じ
      assert(JSON.stringify(wj.results) === JSON.stringify(dj.results), '--dry-run と実際の書き換えで結果が違います');
      // after を書かないケースは、書き換えた文字列ではなく配置（layout）だけで確かめる
      if (spec.after) {
        const afterFile = path.join(dir, spec.after);
        if (UPDATE) {
          fs.writeFileSync(afterFile, after);
        }
        assert(fs.existsSync(afterFile), `${spec.after} がありません（--update で作れます）`);
        const expText = fs.readFileSync(afterFile, 'utf8');
        const gotText = after.toString('utf8');
        if (expText !== gotText) {
          fail(`書き換えた結果が ${spec.after} と違います\n${lineDiff(expText, gotText)}`);
        }
      }
      // 書き換えた後のファイルは、元より誤りが増えていない。配置も期待どおり
      const cj = check(sb.file, sb.cache).j;
      assert(cj.diagnostics.length <= baseDiags, `書き換えた後に誤りが増えました: ${fmtDiags(cj.diagnostics)}`);
      if (spec.layout) {
        const lay = layoutOf(cj);
        const bad = [];
        for (const [id, [s, e]] of Object.entries(spec.layout)) {
          const g = lay[id];
          if (!g) bad.push(`${id}: クリップがありません`);
          else if (!near(g[0], s) || !near(g[1], e)) bad.push(`${id}: 期待 ${s}〜${e}、実際 ${g[0]}〜${g[1]}`);
        }
        assert(bad.length === 0, `書き換えた後の配置が違います\n${bad.join('\n')}`);
      }
    });
  }
}

function lineDiff(a, b) {
  const x = a.split('\n');
  const y = b.split('\n');
  const out = [];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if (x[i] !== y[i]) {
      if (x[i] !== undefined) out.push(`  期待 ${i + 1}: ${x[i]}`);
      if (y[i] !== undefined) out.push(`  実際 ${i + 1}: ${y[i]}`);
    }
  }
  return out.join('\n');
}

// ---- fx ----

function readBmp(file) {
  const b = fs.readFileSync(file);
  assert(b[0] === 0x42 && b[1] === 0x4d, 'BMP ではありません');
  const off = b.readUInt32LE(10);
  const w = b.readInt32LE(18);
  const h = b.readInt32LE(22);
  const bpp = b.readUInt16LE(28);
  assert(bpp === 24, `BMP の画素が ${bpp} ビットです（24 のはず）`);
  const row = Math.ceil((w * 3) / 4) * 4;
  assert(b.length >= off + row * Math.abs(h), 'BMP の大きさが足りません');
  return {
    w,
    h: Math.abs(h),
    px(x, y) {
      const yy = h > 0 ? h - 1 - y : y;
      const o = off + yy * row + x * 3;
      return [b[o + 2], b[o + 1], b[o]];
    },
  };
}

function groupFx() {
  const dir = path.join(CASES, 'fx');
  for (const f of list(dir, '.mzc')) {
    const name = f.replace(/\.mzc$/, '');
    test(`fx/${name}`, () => {
      const exp = readJson(path.join(dir, `${name}.expect.json`));
      const sb = sandbox(path.join(dir, f));
      const bmp = path.join(sb.dir, 'out.bmp');
      const r = engine(['preview', sb.file, sb.cache, String(exp.t ?? 0.5), bmp]);
      assert(r.code === 0, `preview が終了コード ${r.code} で終わりました\n${r.err}`);
      const img = readBmp(bmp);
      assert(img.w === 32 && img.h === 32, `画像の大きさが ${img.w}x${img.h} です`);
      const bad = [];
      const show = (p) => `(${p.join(', ')})`;
      for (const [x, y] of exp.at || []) {
        const p = img.px(x, y);
        const tol = exp.tol ?? 1;
        if (p.some((v, i) => Math.abs(v - exp.rgb[i]) > tol)) bad.push(`(${x},${y}): 期待 ${show(exp.rgb)}±${tol}、実際 ${show(p)}`);
      }
      for (const rg of exp.range || []) {
        for (const [x, y] of rg.at) {
          const p = img.px(x, y);
          if (p.some((v, i) => v < rg.min[i] || v > rg.max[i])) bad.push(`(${x},${y}): 期待 ${show(rg.min)}〜${show(rg.max)}、実際 ${show(p)}`);
        }
      }
      for (const [[x1, y1], [x2, y2]] of exp.equal || []) {
        const p = img.px(x1, y1);
        const q = img.px(x2, y2);
        if (p.some((v, i) => Math.abs(v - q[i]) > 1)) bad.push(`(${x1},${y1}) ${show(p)} と (${x2},${y2}) ${show(q)} が同じではありません`);
      }
      assert(bad.length === 0, bad.join('\n'));
    });
  }
}

// ---- report（show と schema） ----

function groupReport() {
  const pluginNames = list(path.join(ROOT, 'plugins'), '.um').map((f) => f.replace(/\.um$/, ''));

  test('report/schema（文）', () => {
    const r = engine(['schema']);
    assert(r.code === 0, `終了コードが ${r.code} です\n${r.err}`);
    for (const n of [...pluginNames, 'grey', 'mosaic', 'saturation', 'size', 'xfade', 'at']) {
      assert(r.out.includes(n), `schema の文に '${n}' がありません`);
    }
  });

  test('report/schema --json', () => {
    const r = engine(['schema', '--json']);
    assert(r.code === 0, `終了コードが ${r.code} です`);
    const j = parseJson(r.out, 'schema --json');
    assert(Array.isArray(j.keys) && j.keys.length >= 40, `keys が少なすぎます（${j.keys?.length}）`);
    const names = j.effects.map((e) => e.name).sort();
    assert(JSON.stringify(names) === JSON.stringify([...pluginNames].sort()),
      `effects が plugins/ と違います: ${names.join(', ')}`);
    const alias = (n) => j.effects.find((e) => e.name === n).aliases;
    assert(alias('gray').includes('grey') && alias('pixelate').includes('mosaic') && alias('sat').includes('saturation'),
      '別名（grey / mosaic / saturation）が載っていません');
    for (const e of j.effects) {
      for (const p of e.params) {
        assert(typeof p.default === 'number' && p.min <= p.default && p.default <= p.max, `${e.name}.${p.name} の既定値が範囲の外です`);
      }
    }
    for (const k of ['size', 'fps', 'at', 'dur', 'xfade', 'opacity', 'align', 'outlinew']) {
      assert(j.keys.some((x) => x.name === k), `keys に ${k} がありません`);
    }
  });

  const layoutDir = path.join(CASES, 'layout');
  const showCases = [...list(layoutDir, '.mzc').map((f) => path.join(layoutDir, f)), path.join(CASES, 'ops', 'base.mzc')];
  for (const src of showCases) {
    const name = path.basename(src);
    test(`report/show ${name}`, () => {
      const sb = sandbox(src, name);
      const ids = check(sb.file, sb.cache).j.clips.map((c) => c.id).filter(Boolean);
      for (const width of [100, 60, 30, 1]) {
        const r = engine(['show', sb.file, sb.cache, '--width', String(width)]);
        assert(r.code === 0, `--width ${width} で終了コード ${r.code}\n${r.err}`);
        const lines = r.out.split(/\r?\n/);
        assert(lines[0] === name, `1 行目がファイル名ではありません: '${lines[0]}'`);
        assert(lines.length > ids.length, `出力が短すぎます（--width ${width}）`);
        for (const id of ids) assert(r.out.includes(id), `--width ${width} の一覧に ${id} がありません`);
        if (width >= 60) {
          // 幅を守るのは図（最初の空の行まで）。クリップの一覧は表なので幅を超えてよい
          const blank = lines.indexOf('');
          const tooWide = lines.slice(1, blank < 0 ? lines.length : blank).filter((l) => dispWidth(l) > width);
          assert(tooWide.length === 0, `--width ${width} を超える行があります:\n${tooWide.slice(0, 3).join('\n')}`);
        }
      }
    });
  }

  test('report/show 誤りのあるファイル', () => {
    const sb = sandbox(path.join(CASES, 'diag', 'refs.mzc'));
    const r = engine(['show', sb.file, sb.cache]);
    assert(r.code === 1, `終了コードが ${r.code} です（誤りがあるので 1）`);
    assert(r.err.includes('[unknown-ref]'), '誤りが標準エラーに出ていません');
    assert(r.out.startsWith('p.mzc'), '誤りがあっても図は出すはずです');
  });

  test('report/show クリップのないファイル', () => {
    const sb = sandbox(path.join(CASES, 'diag', 'empty-timeline.mzc'));
    const r = engine(['show', sb.file, sb.cache]);
    assert(r.code === 1, `終了コードが ${r.code} です`);
    assert(r.out.startsWith('p.mzc'), '図の 1 行目が出ていません');
  });

  test('report/check --json の形', () => {
    const sb = sandbox(path.join(CASES, 'layout', 'xfade.mzc'));
    const { j } = check(sb.file, sb.cache);
    assert(j.project.width === 64 && j.project.height === 36 && j.project.fps === '30/1' && j.project.rate === 48000, `project が違います: ${JSON.stringify(j.project)}`);
    const a = j.clips.find((c) => c.id === 'a');
    assert(a.index === 0 && a.line === 2 && a.kind === 'video' && a.track === 0 && a.in === 1 && a.src === 'media/a.mp4' && a.text === null,
      `clips[0] が違います: ${JSON.stringify(a)}`);
    const t = j.clips.find((c) => c.id === 't');
    assert(t.kind === 'text' && t.track === 2 && t.text === 't' && t.src === null, `text のクリップが違います: ${JSON.stringify(t)}`);
    const sb2 = sandbox(path.join(CASES, 'diag', 'clean.mzc'));
    const c = check(sb2.file, sb2.cache).j;
    const fx = c.clips.find((x) => x.id === 'a').effects;
    assert(fx.length === 2 && fx[0].name === 'vignette' && near(fx[0].params.strength, 0.5) && near(fx[0].params.radius, 0.9, 1e-6) && near(fx[0].params.softness, 0.4, 1e-6),
      `vignette の引数が違います: ${JSON.stringify(fx)}`);
    assert(fx[1].name === 'gray' && near(fx[1].params.amount, 0.5), `別名 grey が gray として読めていません: ${JSON.stringify(fx)}`);
    assert(c.clips.find((x) => x.id === 't').text === 'a # b', '引用符の中の # が注釈になっています');
    assert(c.project.fps === '30000/1001', `fps=29.97 が ${c.project.fps} になっています`);
  });
}

// 端末での表示の幅（全角は 2）。
function dispWidth(s) {
  let w = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (c >= 0x300 && c <= 0x36f) continue;
    w += (c >= 0x1100 && (c <= 0x115f || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe4f) || (c >= 0xff00 && c <= 0xff60) || (c >= 0xffe0 && c <= 0xffe6) || c >= 0x1f300)) ? 2 : 1;
  }
  return w;
}

// ---- cli（tools/mozcut.mjs とエンジンの使い方） ----

function groupCli() {
  test('cli/engine 使い方の誤りは終了コード 2', () => {
    const sb = sandbox(path.join(CASES, 'ops', 'base.mzc'));
    for (const args of [[], ['nosuchcmd'], ['check'], ['check', sb.file, '--bogus'], ['op', sb.file], ['show', sb.file, '--width', '0']]) {
      const r = engine(args);
      assert(r.code === 2, `mozcut ${args.join(' ')} の終了コードが ${r.code} です`);
    }
    const r = engine(['check', path.join(sb.dir, 'nosuch.mzc'), '--json']);
    assert(r.code === 1 && parseJson(r.out, 'check --json（ないファイル）').ok === false, 'ないファイルの check --json は {ok:false} で 1 のはず');
  });

  test('cli/op は CRLF のファイルを CRLF のまま保存する', () => {
    const sb = sandbox(path.join(CASES, 'ops', 'base.mzc'));
    const crlf = fs.readFileSync(sb.file, 'utf8').replace(/\n/g, '\r\n');
    fs.writeFileSync(sb.file, crlf);
    const r = engine(['op', sb.file, sb.cache, 'move', 'cap', '2.5']);
    assert(r.code === 0, `op が終了コード ${r.code} で終わりました\n${r.err}`);
    const t = fs.readFileSync(sb.file, 'utf8');
    assert(!/[^\r]\n/.test(t) && t.includes('at=2.5'), 'CRLF が保たれていないか、書き換わっていません');
    assert(r.out.includes('保存しました'), `人向けの出力に「保存しました」がありません\n${r.out}`);
  });

  test('cli/op --file（注釈と空の行を飛ばす）', () => {
    const sb = sandbox(path.join(CASES, 'ops', 'base.mzc'));
    const ops = path.join(sb.dir, 'ops.txt');
    fs.writeFileSync(ops, '# 注釈\n\nmove cap 2.5\n  \nset clip_b blur=2\n');
    const r = engine(['op', sb.file, sb.cache, '--file', ops, '--json']);
    const j = parseJson(r.out, 'op --file --json');
    assert(r.code === 0 && j.ok && j.results.length === 2, `結果が違います: ${r.out}${r.err}`);
  });

  test('cli/op の cache は省ける（<名前>.cache/probe.txt）', () => {
    const sb = sandbox(path.join(CASES, 'layout', 'xfade.mzc'), 'x.mzc');
    fs.mkdirSync(path.join(sb.dir, 'x.cache'));
    fs.copyFileSync(PROBE, path.join(sb.dir, 'x.cache', 'probe.txt'));
    const r = engine(['check', sb.file]);
    assert(r.code === 0, `cache を省いた check が終了コード ${r.code}\n${r.out}`);
    const o = engine(['op', sb.file, 'move', 'u', '6', '--dry-run']);
    assert(o.code === 0, `cache を省いた op が終了コード ${o.code}\n${o.err}`);
  });

  test('cli/op --json の moved・suggest・newDiagnostics', () => {
    const sb = sandbox(path.join(CASES, 'ops', 'base.mzc'));
    // delete intro fix-refs: at= のない clip_a は前へ詰まる（ほかのクリップの時刻の変化は moved に出る）
    const d = engine(['op', sb.file, sb.cache, 'delete', 'intro', 'fix-refs', '--dry-run', '--json']);
    const dj = parseJson(d.out, 'op delete --json');
    const mv = dj.results[0].moved;
    const a = mv.find((m) => m.id === 'clip_a');
    assert(a && near(a.before.start, 2) && near(a.after.start, 0), `moved に clip_a の 2→0 がありません: ${JSON.stringify(mv)}`);
    assert(!mv.some((m) => m.id === 'intro'), 'moved に操作で指したクリップが入っています');
    assert(dj.results[0].desc.includes('ほかに'), `desc に動いたクリップの説明がありません: ${dj.results[0].desc}`);
    // 誤りが増えて止めたとき: newDiagnostics と suggest
    const k = engine(['op', sb.file, sb.cache, 'set', 'clip_b', 'vignete=0.5', '--json']);
    const kr = parseJson(k.out, 'op set --json').results[0];
    assert(kr.suggest === 'vignette' && kr.newDiagnostics.length === 1 && kr.newDiagnostics[0].line === 5 && kr.newDiagnostics[0].col > 0,
      `suggest / newDiagnostics が違います: ${JSON.stringify(kr)}`);
    // 打ち間違いの ID と操作の名前にも候補
    const c = parseJson(engine(['op', sb.file, sb.cache, 'delete', 'clipb', '--json']).out, 'op --json').results[0];
    assert(c.code === 'unknown-clip' && c.suggest === 'clip_b', `unknown-clip の suggest が違います: ${JSON.stringify(c)}`);
    const o = parseJson(engine(['op', sb.file, sb.cache, 'mvoe', 'cap', '2', '--json']).out, 'op --json').results[0];
    assert(o.code === 'unknown-op' && o.suggest === 'move', `unknown-op の suggest が違います: ${JSON.stringify(o)}`);
    // 1 つの引数にまとめた操作
    const q = engine(['op', sb.file, sb.cache, 'move cap 2.5', '--dry-run', '--json']);
    assert(q.code === 0 && parseJson(q.out, 'op --json').ok, `まとめた操作が通りません: ${q.out}${q.err}`);
  });

  test('cli/check --json の ok と clips の at / keys / trackKind / placed', () => {
    const sb = sandbox(path.join(CASES, 'diag', 'refs.mzc'));
    const bad = check(sb.file, sb.cache).j;
    assert(bad.ok === false, '誤りのあるファイルで ok が false ではありません');
    assert(bad.clips.some((c) => c.placed === false), '参照の誤りのあるクリップの placed が false ではありません');
    const sb2 = sandbox(path.join(CASES, 'ops', 'base.mzc'));
    const j = check(sb2.file, sb2.cache).j;
    assert(j.ok === true, 'ok が true ではありません');
    const t = j.clips.find((c) => c.id === 'title');
    assert(t.at === 'intro.start+0.5' && t.keys.size === '40' && t.trackKind === 'video' && t.placed === true, `title が違います: ${JSON.stringify(t)}`);
    assert(j.clips.find((c) => c.id === 'clip_a').at === null, 'at を書かないクリップの at が null ではありません');
  });

  test('cli/schema --json の形（ops・aliasOf・kinds の展開・数の default）', () => {
    const j = parseJson(engine(['schema', '--json']).out, 'schema --json');
    for (const n of ['move', 'trim', 'split', 'delete', 'cut', 'set', 'unset', 'renamekey', 'add', 'rename']) {
      assert(j.ops.some((o) => o.name === n && o.usage && o.example), `ops に ${n} がありません`);
    }
    const pout = j.keys.find((k) => k.name === 'out' && k.kinds.includes('project'));
    assert(pout && pout.aliasOf === 'output', `project の out に aliasOf がありません: ${JSON.stringify(pout)}`);
    assert(j.keys.every((k) => !k.kinds.includes('*')), 'kinds に * が残っています');
    const ow = j.keys.find((k) => k.name === 'outlinew');
    assert(ow.default === null && ow.defaultExpr === 'size/14', `outlinew の default が違います: ${JSON.stringify(ow)}`);
    const sz = j.keys.find((k) => k.name === 'size' && k.kinds.includes('text'));
    assert(sz.default === 48, `text の size の default が数ではありません: ${JSON.stringify(sz)}`);
    const al = j.keys.find((k) => k.name === 'align');
    assert(al.type === 'enum' && al.values.includes('left'), `align の type が enum ではありません: ${JSON.stringify(al)}`);
    assert(j.effects.every((e) => e.kinds.includes('project') && !e.kinds.includes('audio')), 'effects の kinds が違います');
  });

  const ffprobe = spawnSync(process.env.FFPROBE || 'ffprobe', ['-version'], { encoding: 'utf8' });
  if (ffprobe.error) {
    console.log('  --  cli/mozcut.mjs（ffprobe がないので飛ばす）');
    return;
  }
  test('cli/mozcut.mjs check demo/demo.mzc', () => {
    // 素材を調べるので demo/demo.cache/probe.txt を書くことがある（中身が変わったときだけ）
    const r = run(process.execPath, [MOZCUT_MJS, 'check', path.join(ROOT, 'demo', 'demo.mzc'), '--json']);
    const j = parseJson(r.out, 'mozcut.mjs check --json');
    assert(r.code === 0 && j.diagnostics.length === 0, `demo.mzc に誤りがあります: ${fmtDiags(j.diagnostics ?? [])}`);
    assert(j.clips.length >= 5, 'クリップが少なすぎます');
  });
  test('cli/mozcut.mjs show / op --dry-run（素材を調べてから渡す）', () => {
    const demo = path.join(ROOT, 'demo', 'demo.mzc');
    const before = fs.readFileSync(demo);
    const s = run(process.execPath, [MOZCUT_MJS, 'show', demo, '--width', '80']);
    assert(s.code === 0 && s.out.startsWith('demo.mzc'), `show が終了コード ${s.code}\n${s.err}`);
    const o = run(process.execPath, [MOZCUT_MJS, 'op', demo, 'move', 'pip', '2.5', '--dry-run', '--json']);
    const j = parseJson(o.out, 'mozcut.mjs op --dry-run --json');
    assert(o.code === 0 && j.ok && !j.saved, `op --dry-run の結果が違います: ${o.out}${o.err}`);
    assert(Buffer.compare(fs.readFileSync(demo), before) === 0, 'demo.mzc が書き換わりました');
    const u = run(process.execPath, [MOZCUT_MJS, 'check']);
    assert(u.code === 2, `引数なしの check の終了コードが ${u.code} です`);
    const n = run(process.execPath, [MOZCUT_MJS, 'op', demo]);
    assert(n.code === 2, `操作のない op の終了コードが ${n.code} です`);
  });
  test('cli/mozcut.mjs --json はファイルがなくても JSON を出す', () => {
    const r = run(process.execPath, [MOZCUT_MJS, 'check', path.join(TMP, 'nofile.mzc'), '--json']);
    const j = parseJson(r.out, 'mozcut.mjs check --json（ないファイル）');
    assert(r.code === 1 && j.ok === false && typeof j.error === 'string', `結果が違います: ${r.out}`);
    const o = run(process.execPath, [MOZCUT_MJS, 'op', path.join(ROOT, 'demo', 'demo.mzc'), '--json']);
    assert(o.code === 2 && parseJson(o.out, 'mozcut.mjs op --json（操作なし）').ok === false, `操作のない op --json が違います: ${o.out}`);
  });
  test('cli/mozcut.mjs check は見つからない素材を missing-source にする', () => {
    const dir = path.join(TMP, `m${++seq}`);
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, 'm.mzc');
    fs.writeFileSync(f, 'project size=64x36' + String.fromCharCode(10) + 'video "media/none.mp4" id=v out=2' + String.fromCharCode(10));
    const r = run(process.execPath, [MOZCUT_MJS, 'check', f, '--json']);
    const j = parseJson(r.out, 'mozcut.mjs check --json');
    assert(r.code === 1 && j.diagnostics.some((d) => d.code === 'missing-source' && d.line === 2 && d.hint.includes('none.mp4')),
      `missing-source が出ていません: ${r.out}`);
  });
}

// ---- M1 の道具: 決まった模様の素材 ----

// 映像の 1 コマ（Y4M、YUV 4:2:0）。s は素材のコマの番号（同じ素材なら、どのクリップでも同じ模様になる）。
function yuvFrame(w, h, s) {
  const out = Buffer.alloc(w * h * 3 / 2);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[y * w + x] = 16 + ((x * 4 + y * 3 + s * 7) % 220);
  const cw = w / 2;
  const ch = h / 2;
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      out[w * h + y * cw + x] = 128 + (((x + s) % 32) - 16) * 3;
      out[w * h + cw * ch + y * cw + x] = 128 + (((y * 2 + s) % 40) - 20) * 2;
    }
  }
  return out;
}

function writeY4m(file, w, h, firstSrc, count) {
  const parts = [Buffer.from(`YUV4MPEG2 W${w} H${h} F30:1 Ip A1:1 C420jpeg XYSCSS=420JPEG XCOLORRANGE=LIMITED\n`)];
  for (let n = 0; n < count; n++) {
    parts.push(Buffer.from('FRAME\n'));
    parts.push(yuvFrame(w, h, firstSrc + n));
  }
  fs.writeFileSync(file, Buffer.concat(parts));
}

// 画像（PAM、RGBA、ストレートアルファ。縁は半透明、所々透明）。
function writePam(file, w, h) {
  const px = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      px[o] = (x * 30) % 256;
      px[o + 1] = (y * 40) % 256;
      px[o + 2] = 128 + ((x * y) % 100);
      px[o + 3] = (x + y) % 5 === 0 ? 0 : (x < 2 || y < 2 || x >= w - 2 || y >= h - 2) ? 128 : 255;
    }
  }
  fs.writeFileSync(file, Buffer.concat([Buffer.from(`P7\nWIDTH ${w}\nHEIGHT ${h}\nDEPTH 4\nMAXVAL 255\nTUPLTYPE RGB_ALPHA\nENDHDR\n`), px]));
}

// plan の scale の文字から、展開した大きさを決める（素材そのものの大きさは natW × natH とする）。
function scaledSize(scale, natW, natH, even) {
  const m = /scale=(-?\d+):(-?\d+)/.exec(scale);
  if (!m) return [natW, natH];
  let w = Number(m[1]);
  let h = Number(m[2]);
  const ev = (v) => (even ? Math.round(v / 2) * 2 : Math.round(v));
  if (w > 0 && h > 0) return [w, h];
  if (w > 0) return [w, ev((w * natH) / natW)];
  return [ev((h * natW) / natH), h];
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// 一時フォルダに .mzc の写しとキャッシュを作り、エンジンの plan が並べた素材を決まった模様で書く。
// 映像の素材は 96x54（16:9）、画像の素材は 24x16 とみなす。
function fixture(srcFile, probeFile, { name = 'p.mzc', cacheName = 'cache' } = {}) {
  const dir = path.join(TMP, `f${++seq}`);
  const cache = path.join(dir, cacheName);
  fs.mkdirSync(cache, { recursive: true });
  fs.copyFileSync(probeFile, path.join(cache, 'probe.txt'));
  const file = path.join(dir, name);
  fs.copyFileSync(srcFile, file);
  const r = engine(['plan', file, cache]);
  assert(r.code === 0, `plan が終了コード ${r.code} で終わりました\n${r.err}`);
  for (const line of r.out.split(/\r?\n/)) {
    const f = line.split('\t');
    if (f[0] === 'video') {
      const inPt = Number(f[3]);
      const [w, h] = scaledSize(f[6], 96, 54, true);
      writeY4m(f[7], w, h, Math.round(inPt * 30), Math.round(Number(f[4]) * 30) + 2);
      fs.writeFileSync(`${f[7]}.in`, f[3]);
    } else if (f[0] === 'image') {
      const [w, h] = scaledSize(f[3], 24, 16, false);
      writePam(f[4], w, h);
    }
  }
  return { dir, file, cache };
}

// 違う BMP の、違う画素の数・いちばん大きい差・最初の場所。
function bmpDiff(goldFile, gotFile) {
  const a = fs.readFileSync(goldFile);
  const b = fs.readFileSync(gotFile);
  if (a.length !== b.length) return `大きさが違います（基準 ${a.length} バイト、実際 ${b.length} バイト）`;
  const x = readBmp(goldFile);
  const y = readBmp(gotFile);
  if (x.w !== y.w || x.h !== y.h) return `画像の大きさが違います（${x.w}x${x.h} と ${y.w}x${y.h}）`;
  let n = 0;
  let max = 0;
  let first = '';
  for (let yy = 0; yy < x.h; yy++) {
    for (let xx = 0; xx < x.w; xx++) {
      const p = x.px(xx, yy);
      const q = y.px(xx, yy);
      const d = Math.max(...p.map((v, i) => Math.abs(v - q[i])));
      if (d > 0) {
        n++;
        if (d > max) max = d;
        if (!first) first = `(${xx},${yy}) 基準 (${p.join(', ')}) 実際 (${q.join(', ')})`;
      }
    }
  }
  return n ? `${n} 画素が違います（いちばん大きい差 ${max}、最初は ${first}）` : 'ヘッダーだけが違います';
}

// 失敗したら、比べた画像を見られるように作業用のフォルダを残す。
let keepTmp = false;

// ---- golden（描画の結果が前と 1 バイトも変わらないこと） ----

const GOLDEN_TIMES = [0, 0.3, 0.45, 0.8, 1.05, 1.4, 1.7, 2.0, 2.3, 2.75];
// ttf.um の defaultFont と同じ順
const DEFAULT_FONTS = [
  'C:/Windows/Fonts/YuGothM.ttc', 'C:/Windows/Fonts/BIZ-UDGothicR.ttc', 'C:/Windows/Fonts/meiryo.ttc',
  '/System/Library/Fonts/Supplemental/Arial Unicode.ttf', '/Library/Fonts/Arial Unicode.ttf',
  '/usr/share/fonts/opentype/ipaexfont-gothic/ipaexg.ttf', '/usr/share/fonts/truetype/fonts-japanese-gothic.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
];

function defaultFontNow() {
  for (const f of DEFAULT_FONTS) {
    try {
      return { file: f, size: fs.statSync(f).size };
    } catch {}
  }
  return null;
}

// y4m のコマの数（ヘッダーの後ろは "FRAME\n" + w*h*3/2 のくり返し）。
function y4mFrames(buf) {
  const nl = buf.indexOf(10);
  const head = buf.subarray(0, nl).toString();
  const w = Number(/ W(\d+)/.exec(head)[1]);
  const h = Number(/ H(\d+)/.exec(head)[1]);
  return (buf.length - nl - 1) / (w * h * 3 / 2 + 6);
}

function groupGolden() {
  const dir = path.join(CASES, 'golden');
  for (const f of list(dir, '.mzc')) {
    const name = f.replace(/\.mzc$/, '');
    const expFile = path.join(dir, `${name}.expect.json`);
    const exp = fs.existsSync(expFile) ? readJson(expFile) : { times: GOLDEN_TIMES };
    const usesText = /^\s*text\s/m.test(fs.readFileSync(path.join(dir, f), 'utf8'));
    let sb = null;
    const prepare = () => {
      if (usesText) {
        // 文字の形は OS のフォントで決まるので、基準を作ったときと同じフォントのときだけ比べる
        const now = defaultFontNow();
        if (!now) skip('フォントがありません');
        if (UPDATE) exp.font = now;
        else if (!exp.font || exp.font.file !== now.file || exp.font.size !== now.size) {
          skip(`基準は ${exp.font ? `${exp.font.file}（${exp.font.size} バイト）` : '（フォントの記録なし）'} で作ったもの。いまは ${now.file}`);
        }
      }
      if (!sb) sb = fixture(path.join(dir, f), path.join(dir, 'probe.txt'));
      return sb;
    };
    test(`golden/${name} preview（${(exp.times || GOLDEN_TIMES).length} の時刻）`, () => {
      const s = prepare();
      const bad = [];
      for (const t of exp.times || GOLDEN_TIMES) {
        const got = path.join(s.dir, `${name}@${t}.bmp`);
        const r = engine(['preview', s.file, s.cache, String(t), got]);
        assert(r.code === 0, `preview ${t} が終了コード ${r.code} で終わりました\n${r.err}`);
        const gold = path.join(dir, `${name}@${t}.bmp`);
        if (UPDATE) {
          fs.copyFileSync(got, gold);
          continue;
        }
        if (!fs.existsSync(gold)) bad.push(`${t} 秒: 基準 ${path.basename(gold)} がありません（--update で作れます）`);
        else if (Buffer.compare(fs.readFileSync(gold), fs.readFileSync(got)) !== 0) bad.push(`${t} 秒: ${bmpDiff(gold, got)}`);
      }
      if (bad.length) {
        keepTmp = true;
        bad.push(`（実際の画像は ${s.dir} に残しました）`);
      }
      assert(bad.length === 0, bad.join('\n'));
    });
    test(`golden/${name} render（全コマの Y4M と音）`, () => {
      const s = prepare();
      const r = engine(['render', s.file, s.cache]);
      assert(r.code === 0, `render が終了コード ${r.code} で終わりました\n${r.err}`);
      const y4m = fs.readFileSync(path.join(s.cache, 'out.y4m'));
      const pcm = fs.readFileSync(path.join(s.cache, 'out.pcm'));
      const got = { frames: y4mFrames(y4m), y4m: sha256(y4m), pcm: sha256(pcm) };
      const dur = parseJson(engine(['check', s.file, s.cache, '--json']).out, 'check --json').project.duration;
      assert(got.frames === Math.ceil(dur * 30 - 1e-6), `コマの数が ${got.frames} です（長さ ${dur} 秒、30 コマ/秒）`);
      if (UPDATE) {
        exp.render = got;
        return;
      }
      assert(exp.render, `${name}.expect.json に render がありません（--update で作れます）`);
      const bad = Object.keys(got).filter((k) => got[k] !== exp.render[k]).map((k) => `${k}: 基準 ${exp.render[k]}、実際 ${got[k]}`);
      assert(bad.length === 0, bad.join('\n'));
    });
    if (UPDATE) {
      exp.times = exp.times || GOLDEN_TIMES;
      fs.writeFileSync(expFile, JSON.stringify(exp, null, 2) + '\n');
    }
  }
}

// ---- play（再生エンジン）: tests/um/m1check.um を src/ の写しの中でビルドして使う ----

function umHome() {
  for (const c of [process.env.UM_HOME, path.join(ROOT, '..', 'UnifiedMozaic')].filter(Boolean)) {
    if (fs.existsSync(path.join(c, 'src', 'cli.ts'))) return c;
  }
  return null;
}

// tools/mozcut.mjs の wasmtimeHome と同じ探し方。
function wasmtimeHome() {
  if (process.env.UM_WASMTIME) return process.env.UM_WASMTIME;
  for (const dir of [path.join(ROOT, '..'), os.homedir()]) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const n of names.filter((n) => n.startsWith('wasmtime-')).sort().reverse()) {
      if (fs.existsSync(path.join(dir, n, 'include', 'wasmtime.h'))) return path.join(dir, n);
    }
  }
  return undefined;
}

function walkFiles(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) walkFiles(f, out);
    else out.push(f);
  }
  return out;
}

// ソースが同じなら、前にビルドしたもの（OS の一時フォルダ）を使い回す。
let m1checkExe = null;
let m1checkErr = null;
function m1check() {
  if (m1checkExe) return m1checkExe;
  if (m1checkErr) fail(m1checkErr);
  const um = umHome();
  if (!um) skip('UnifiedMozaic のコンパイラが見つかりません（UM_HOME）');
  const srcDir = path.join(ROOT, 'src');
  const files = walkFiles(srcDir).filter((f) => f.endsWith('.um')).sort();
  const main = path.join(ROOT, 'tests', 'um', 'm1check.um');
  const h = crypto.createHash('sha256');
  for (const f of [...files, main]) h.update(f).update(fs.readFileSync(f));
  h.update(String(fs.statSync(path.join(um, 'src', 'cli.ts')).mtimeMs));
  const dir = path.join(os.tmpdir(), `mozcut-m1check-${h.digest('hex').slice(0, 16)}`);
  const exe = path.join(dir, 'm1check' + EXT);
  if (fs.existsSync(exe)) return (m1checkExe = exe);
  const copy = path.join(dir, 'src');
  fs.rmSync(dir, { recursive: true, force: true });
  for (const f of files) {
    const to = path.join(copy, path.relative(srcDir, f));
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(f, to);
  }
  fs.copyFileSync(main, path.join(copy, 'm1check.um'));
  const env = { ...process.env };
  const wt = wasmtimeHome();
  if (wt) env.UM_WASMTIME = wt;
  console.log('  ..  tests/um/m1check.um をビルドしています');
  const r = run(process.execPath, [path.join(um, 'src', 'cli.ts'), 'build', path.join(copy, 'm1check.um'), '--target', 'host', '-o', exe], { env });
  if (r.code !== 0 || !fs.existsSync(exe)) {
    m1checkErr = `tests/um/m1check.um をビルドできません\n${(r.out + r.err).slice(0, 2000)}`;
    fs.rmSync(dir, { recursive: true, force: true });
    fail(m1checkErr);
  }
  return (m1checkExe = exe);
}

// 「名前<TAB>値」の行を読む。
function kv(out) {
  const m = {};
  for (const line of out.split(/\r?\n/)) {
    const i = line.indexOf('\t');
    if (i > 0) m[line.slice(0, i)] = line.slice(i + 1);
  }
  return m;
}

function expectKv(got, want) {
  const bad = Object.entries(want).filter(([k, v]) => got[k] !== v).map(([k, v]) => `${k}: 期待 '${v}'、実際 '${got[k]}'`);
  assert(bad.length === 0, bad.join('\n'));
}

let clockOut = null;
function clockKv() {
  if (clockOut) return clockOut;
  const r = run(m1check(), ['clock'], { timeout: 60000 });
  assert(r.code === 0, `m1check clock が終了コード ${r.code} で終わりました\n${r.err}`);
  return (clockOut = kv(r.out));
}

function groupPlay() {
  // 30 コマ/秒、長さ 2 秒（60 コマ）。値は「状態|コマ|位置（秒）」
  test('play/時計: 等速、L で 2 倍 → 4 倍（上限）、終わりで止まる', () => {
    expectKv(clockKv(), {
      'init': '停止|0|0', 'init.total': '60', 'init.tick': 'true', 'init.tick2': 'false',
      'play.tick': 'true', 'play.0.5': '再生 ×1|15|0.5', 'play.same': 'false',
      'L2': '再生 ×2|15|0.5', 'L2.tick': '再生 ×2|45|1.5', 'L4': '再生 ×4', 'L8': '再生 ×4',
      'end': '停止|59|2', 'restart': '再生 ×1|0|0',
    });
  });
  test('play/時計: J で逆再生（重ねて 2 倍）、頭で止まる、頭からの J は終わりから、K で止める', () => {
    expectKv(clockKv(), {
      'J1': '逆再生 ×1|30|1', 'J1.tick': '逆再生 ×1|15|0.5', 'J2': '逆再生 ×2', 'start': '停止|0|0',
      'J.fromEnd': '逆再生 ×1|59|2', 'J.then.L': '再生 ×1', 'K': '停止',
    });
  });
  test('play/シークとコマ送り（範囲に収める、再生中のシークはそこから続ける）', () => {
    expectKv(clockKv(), {
      'seek1': '停止|30|1', 'seek.neg': '停止|0|0', 'seek.over': '停止|59|2',
      'step+1': '停止|31|1.0333', 'step-30': '停止|1|0.0333', 'step.min': '停止|0|0', 'step.max': '停止|59|1.9667',
      'seek.playing': '再生 ×1|45|1.5',
    });
  });
  test('play/止めると最後に見せたコマの頭にそろう、Space（pbToggle）', () => {
    expectKv(clockKv(), { 'pause.shown': '停止|15|0.5', 'toggle.on': '再生 ×1', 'toggle.off': '停止' });
  });
  test('play/音の時計（等速の順再生だけ。0.1 秒まで補う。2 倍は壁時計）', () => {
    const g = clockKv();
    expectKv(g, {
      'play.audioWanted': 'true', 'L2.audioWanted': 'false',
      'audio.tick': '再生 ×1|31|1.05', 'audio.cap': '再生 ×1|33|1.1', 'audio.x2': '再生 ×2|39|1.3',
    });
    assert(JSON.parse(g['audio.json']).clock === 'audio', `音の時計なのに clock が ${JSON.parse(g['audio.json']).clock} です`);
    assert(JSON.parse(g['audio.x2.json']).clock === 'wall', '2 倍なのに clock が wall ではありません');
  });
  test('play/29.97 コマ/秒: 見せるコマの時刻が書き出しの frameTime と同じ、縮んだら収める', () => {
    expectKv(clockKv(), { 'ntsc.total': '300', 'ntsc.bad': '0', 'reload.shrink': '停止|59|2' });
  });
  test('play/統計: 60 Hz の等速は飛ばしなし、0.1 秒の遅れは 2 コマ落ち、2 倍は落ちなし、4 倍の飛ばしは落ちではない', () => {
    const g = clockKv();
    const s = (k) => JSON.parse(g[k]);
    const bad = [];
    const want = (k, f, v) => { if (s(k)[f] !== v) bad.push(`${k}.${f}: 期待 ${v}、実際 ${s(k)[f]}`); };
    want('stats.60hz', 'shown', 15); want('stats.60hz', 'skipped', 0); want('stats.60hz', 'dropped', 0);
    want('stats.gap', 'skipped', 2); want('stats.gap', 'dropped', 2);
    want('stats.x2', 'skipped', 0); want('stats.x2', 'dropped', 0);
    want('stats.x4', 'skipped', 10); want('stats.x4', 'dropped', 0);
    assert(bad.length === 0, bad.join('\n'));
  });
  test('play/統計: 再生中のシークと、終わりからの再生し直しをコマ落ちに数えない', () => {
    const g = clockKv();
    const a = JSON.parse(g['stats.seekPlaying']);
    const b = JSON.parse(g['stats.restart']);
    assert(a.dropped === 0 && a.skipped === 0 && b.dropped === 0 && b.skipped === 0,
      `再生中に 1.5 秒 → 0 秒へシーク: skipped ${a.skipped} / dropped ${a.dropped}。終わりから再生し直し: skipped ${b.skipped} / dropped ${b.dropped}（どちらも 0 のはず）`);
  });
  test('play/統計: 止めていた時間を遅れに数えない', () => {
    const j = JSON.parse(clockKv()['stats.60hz']);
    assert(j.lateMsMax < 1, `60 Hz の等速で遅れの最大が ${j.lateMsMax} ms です（時刻ちょうどに出しているので 0 のはず）`);
  });

  test('play/先読みに頼むコマ（止めたとき 3 コマ、等速 8 コマ、4 倍は 2 コマおき、逆再生は前へ）と世代', () => {
    const sb = fixture(path.join(CASES, 'play', 'plan.mzc'), path.join(CASES, 'play', 'probe.txt'));
    const r = run(m1check(), ['plan', sb.file, sb.cache], { timeout: 60000 });
    assert(r.code === 0, `m1check plan が終了コード ${r.code} で終わりました\n${r.err}`);
    const g = kv(r.out);
    const seqOf = (from, step, n) => Array.from({ length: n }, (_, j) => `0:${from + step * j}:${j}`).join(' ');
    expectKv(g, {
      'slots': '48',
      'stopped': seqOf(15, 1, 3), 'stopped.again': seqOf(15, 1, 3),
      'x1': seqOf(15, 1, 8), 'x4': seqOf(15, 2, 8), 'rev': seqOf(27, -1, 8),
      'rev.ready': '8', 'rev.left': '',
      // 27 コマ目（素材の 27 コマ目）の Y の左上は 16 + 27*7 % 220
      'hit': 'true', 'hit.byte': String(16 + ((27 * 7) % 220)), 'gen.miss': 'false',
    });
    const st = JSON.parse(g.stats);
    assert(st.fetchFailed === 0 && st.hits === 1 && st.misses === 1, `統計が違います: ${g.stats}`);
  });
  test('play/先読みは古い世代の頼み（もう使わない）を展開しない', () => {
    const sb = fixture(path.join(CASES, 'play', 'plan.mzc'), path.join(CASES, 'play', 'probe.txt'));
    const g = kv(run(m1check(), ['plan', sb.file, sb.cache], { timeout: 60000 }).out);
    assert(g['rev.readyOld'] === '0', `pbReload の前に頼んだ ${g['rev.readyOld']} コマまで展開しました（今の世代のコマは ${g['rev.ready']}）`);
  });
  test('play/先読みの枠から描いたコマが、ファイルから描いたコマと 1 ビットも違わない（等速・2 倍・逆再生・逆 4 倍）', () => {
    const sb = fixture(path.join(CASES, 'golden', 'scene.mzc'), path.join(CASES, 'golden', 'probe.txt'));
    const r = run(m1check(), ['same', sb.file, sb.cache], { timeout: 180000 });
    assert(r.code === 0, `m1check same が終了コード ${r.code} で終わりました\n${r.err}`);
    const g = kv(r.out);
    const bad = [];
    for (const sp of ['1', '2', '-1', '-4']) {
      const m = /frames=(\d+) diffFrames=(\d+) diffPx=(\d+)/.exec(g[`same.${sp}`] || '');
      if (!m) {
        bad.push(`${sp} 倍: 結果がありません`);
        continue;
      }
      const st = JSON.parse(g[`same.${sp}.stats`]);
      if (Number(m[1]) < 20) bad.push(`${sp} 倍: 描いたコマが ${m[1]} しかありません`);
      if (m[2] !== '0') bad.push(`${sp} 倍: ${m[2]} コマ（${m[3]} 画素）が違います`);
      if (st.misses !== 0 || st.fetchFailed !== 0 || st.hits === 0) bad.push(`${sp} 倍: 先読みが当たっていません（hits ${st.hits} / misses ${st.misses} / 失敗 ${st.fetchFailed}）`);
    }
    assert(bad.length === 0, bad.join('\n'));
  });
}

// ---- 実行 ----

console.log(`MozaicCut のテスト（作業用: ${TMP}）`);
ensureEngine();
const groups = {
  diag: groupDiag, layout: groupLayout, ops: groupOps, fx: groupFx, report: groupReport, cli: groupCli,
  golden: groupGolden, play: groupPlay,
};
for (const g of want) {
  console.log(`\n[${g}]`);
  groups[g]();
}
if (!KEEP && !keepTmp) fs.rmSync(TMP, { recursive: true, force: true });
else console.log(`\n作業用のフォルダを残しました: ${TMP}`);
const extra = [skipped ? `飛ばした ${skipped} 件` : ''].filter(Boolean);
console.log(`\n${passed} 件合格、${failures.length} 件不合格${extra.length ? `（${extra.join('、')}）` : ''}`);
if (failures.length) {
  console.log('不合格: ' + failures.map((f) => f.name).join(', '));
  if (VERBOSE) for (const f of failures) console.log(`\n== ${f.name}\n${f.msg}`);
}
process.exit(failures.length ? 1 : 0);
