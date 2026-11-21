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
//
// オプション:
//   --update   ops の .after.mzc を今の実装の結果で書き直す（書き直したら、差分を目で確かめること）
//   --keep     作業用のフォルダを消さずに残す
//   -v         落ちたテストの詳しい出力を出す
//
// 素材の情報は tests/cases/probe.txt（ffprobe の結果の代わり）を使うので、素材のファイルは要らない。
// 作業はすべて一時フォルダの写しで行い、tests/cases は書き換えない（--update のときだけ .after.mzc を書く）。
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
const GROUPS = ['diag', 'layout', 'ops', 'fx', 'report'];
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

// ---- 実行 ----

console.log(`MozaicCut のテスト（作業用: ${TMP}）`);
ensureEngine();
const groups = { diag: groupDiag, layout: groupLayout, ops: groupOps, fx: groupFx, report: groupReport };
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
