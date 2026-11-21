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
//   mzplug  plugins/*.um を名前を変えて .mzplug にし、読み込んで組み込みの効果と 1 ビットも違わないこと。
//           組み込みと同じ名前・壊れた包みを読み込まないこと
//   editor  古い編集画面（build/mozcut-edit-old。src/editor.um）: 引数がプロジェクトだけの起動、スタート画面の最近の一覧の読み書き、再生の統計。
//           ウィンドウは SDL_VIDEO_DRIVER=offscreen で出さない。build/mozcut-edit がなければ飛ばす
//   m6      M6（合成とモーショングラフィックス）の部品の試験 tests/m6-*/run.mjs を 1 つずつ流す（それぞれ src/ の写しで
//           試しのプログラムをビルドする。wgpu-native があれば CPU と GPU の比べも行う）。終了コード 0 なら合格
//   media   FFmpeg の組み込み（事前の展開なし）: ffmpeg のコマンドで作った本物の素材で、コマ単位の正確さ・色の行列・
//           画像の透明・音・切り抜き。エンジンに FFmpeg の組み込みがないか、ffmpeg のコマンドがなければ飛ばす
//
// 既知の誤り（KNOWN に名前を書いたテスト）は、落ちても不合格に数えず「既知」と出す。通ったら KNOWN から外す。
//
// 群を 2 つ以上流すときは、群ごとに子のプロセスで同時に流す（既定は CPU の数まで。-j 1 で 1 つずつ、前と同じ流し方）。
// 出力は群ごとにまとめて、群の順に出す。エンジンのビルドは同時に流す前に 1 回だけ。
//
// オプション:
//   -j N       同時に流す群の数（--jobs N でもよい）
//   --list-groups  群の名前と重さ（だいたいの秒数）を JSON で出して終わる（tests/all.mjs が使う）
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
import { SUMMARY_TAG, jobsFromArgs, positionalArgs, runParallel, takeSummary } from './parallel.mjs';
import { ffmpegLibsFound, useFfmpegOff } from '../tools/ffmpeg-libs.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CASES = path.join(ROOT, 'tests', 'cases');
const EXT = process.platform === 'win32' ? '.exe' : '';
const EXE = process.env.MOZCUT_TEST_EXE ? path.resolve(process.env.MOZCUT_TEST_EXE) : path.join(ROOT, 'build', 'mozcut' + EXT);
// 古い編集画面（src/editor.um）。新しい編集画面（src/edit2.um）は build/mozcut-edit（edit2 の群）
const EDITOR_EXE = path.join(ROOT, 'build', 'mozcut-edit-old' + EXT);
const EDIT2_EXE = path.join(ROOT, 'build', 'mozcut-edit' + EXT);
const MOZCUT_MJS = path.join(ROOT, 'tools', 'mozcut.mjs');
const PROBE = path.join(CASES, 'probe.txt');

const argv = process.argv.slice(2);
const UPDATE = argv.includes('--update');
const KEEP = argv.includes('--keep');
const VERBOSE = argv.includes('-v');
const GROUPS = ['diag', 'layout', 'ops', 'fx', 'report', 'cli', 'golden', 'play', 'mzplug', 'editor', 'edit2', 'm6', 'media'];
// 群のだいたいの重さ（1 つずつ流したときの秒数）。同時に流すとき、重いものから始める
const GROUP_WEIGHT = { diag: 4, layout: 1, ops: 10, fx: 2, report: 2, cli: 5, golden: 2, play: 2, mzplug: 22, editor: 17, edit2: 15, m6: 60, media: 20 };
if (argv.includes('--list-groups')) {
  // m6 の群は tests/m6-*/run.mjs を流すだけなので出さない（tests/all.mjs はそれらを部品として直に流す）
  console.log(JSON.stringify(GROUPS.filter((name) => name !== 'm6').map((name) => ({ name, weight: GROUP_WEIGHT[name] }))));
  process.exit(0);
}
// 同時に流すときの子のプロセス（ビルドは親が済ませている。集計は SUMMARY_TAG の行で親に返す）
const CHILD = process.env.MOZCUT_TEST_CHILD === '1';
const JOBS = jobsFromArgs(argv);
const picked = positionalArgs(argv);
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
const knownFails = [];
const knownFixed = [];
let skipped = 0;

// 既知の誤り（実装を直したら、ここから外す）。名前は test() の名前と同じ。
const KNOWN = new Set([
]);

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
    if (KNOWN.has(name)) {
      knownFixed.push(name);
      console.log(`  ok  ${name}（既知の誤りの一覧にあるが通った。KNOWN から外す）`);
    } else {
      console.log(`  ok  ${name}`);
    }
    passed++;
  } catch (e) {
    if (e instanceof Skip) {
      skipped++;
      console.log(`  --  ${name}（${e.message}）`);
      return;
    }
    const msg = e instanceof Fail ? e.message : (e.stack || String(e));
    if (KNOWN.has(name)) {
      knownFails.push({ name, msg });
      console.log(`  既知 ${name}`);
      for (const l of msg.split('\n')) console.log(`        ${l}`);
      return;
    }
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
  // FFmpeg の組み込みがないエンジンで飛ばした例の code（表の照らし合わせで、出ていなくてよい）
  const ffOnly = new Set();
  for (const f of list(dir, '.mzc')) {
    const name = f.replace(/\.mzc$/, '');
    test(`diag/${name}`, () => {
      const exp = readJson(path.join(dir, `${name}.expect.json`));
      if (exp.ffmpeg && !engineFfmpeg()) {
        for (const e of exp.diagnostics) ffOnly.add(e.code);
        skip('FFmpeg の組み込みがないエンジンでは素材を調べない');
      }
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
    const missing = [...codes].filter((c) => !seen.has(c) && !ffOnly.has(c));
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
      // same: [[前の時刻, 後の時刻], ...]。操作の前の絵と後の絵が 1 バイトも違わない（split / trim / cut が見え方を保つ）
      if (spec.same) {
        const orig = sandbox(baseFile);
        const bad = [];
        for (const [tb, ta] of spec.same) {
          const a = path.join(sb.dir, `before-${tb}.bmp`);
          const b = path.join(sb.dir, `after-${ta}.bmp`);
          const ra = engine(['preview', orig.file, orig.cache, String(tb), a]);
          const rb = engine(['preview', sb.file, sb.cache, String(ta), b]);
          assert(ra.code === 0 && rb.code === 0, `preview が失敗しました\n${ra.err}${rb.err}`);
          if (Buffer.compare(fs.readFileSync(a), fs.readFileSync(b)) !== 0) bad.push(`前の ${tb} 秒と後の ${ta} 秒`);
        }
        assert(bad.length === 0, `操作の前と後で絵が違います: ${bad.join('、')}`);
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

  test('report/show の track の行の表', () => {
    const sb = sandbox(path.join(CASES, 'ops', 'mix-edit.after.mzc'));
    const r = engine(['show', sb.file, sb.cache]);
    assert(r.code === 0, `終了コードが ${r.code} です\n${r.err}`);
    const lines = r.out.split(/\r?\n/);
    const head = lines.findIndex((l) => l.startsWith('トラック') && l.includes('コンプ'));
    assert(head > 0 && lines.length >= head + 4 && lines.slice(head + 4).every((l) => l === ''), `track の行の表（見出しと 3 行）がありません:\n${r.out}`);
    assert(/^A0\s+2\s+声\s+-4\.5\s+0\s+-\s+-\s+-18:4:10:100:6:0$/.test(lines[head + 1]), `音トラック 0 の行が違います: '${lines[head + 1]}'`);
    assert(lines[head + 2].includes('ソロ') && lines[head + 2].includes('lowshelf:120:-3,peak:1800:-2:0.7'), `音トラック 1 の行が違います: '${lines[head + 2]}'`);
    assert(/^マスター\s+4\s+-\s+-1\s/.test(lines[head + 3]), `マスターの行が違います: '${lines[head + 3]}'`);
    const sb2 = sandbox(path.join(CASES, 'ops', 'base.mzc'));
    assert(!engine(['show', sb2.file, sb2.cache]).out.includes('ミュート / ソロ'), 'track の行のないファイルに表が出ています');
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

  test('report/check --json の mix（track の行）', () => {
    const sb = sandbox(path.join(CASES, 'ops', 'mix-edit.after.mzc'));
    const { j } = check(sb.file, sb.cache);
    assert(Array.isArray(j.mix) && j.mix.length === 3, `mix が 3 行ではありません: ${JSON.stringify(j.mix)}`);
    const [a, b, m] = j.mix;
    assert(a.audio === 0 && a.line === 2 && a.name === '声' && a.vol === -4.5 && a.comp === '-18:4:10:100:6:0' && a.eq === '' && !a.mute,
      `音トラック 0 が違います: ${JSON.stringify(a)}`);
    assert(b.audio === 1 && b.name === null && b.solo === true && b.eq === 'lowshelf:120:-3,peak:1800:-2:0.7' && b.comp === null,
      `音トラック 1 が違います: ${JSON.stringify(b)}`);
    assert(m.audio === 'master' && m.vol === -1, `マスターが違います: ${JSON.stringify(m)}`);
    const sb2 = sandbox(path.join(CASES, 'ops', 'base.mzc'));
    assert(!('mix' in check(sb2.file, sb2.cache).j), 'track の行のないプロジェクトに mix が出ています');
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

  test('cli/caps は FFmpeg の組み込みの有無を出す（ライブラリがあれば ffmpeg 1 と版）', () => {
    const r = engine(['caps']);
    assert(r.code === 0, `caps の終了コードが ${r.code} です`);
    const f = r.out.split(/\r?\n/).find((l) => l.startsWith('ffmpeg\t'));
    assert(f, `caps に ffmpeg の行がありません: ${r.out}`);
    if (ffmpegLibsFound() && !process.env.MOZCUT_TEST_EXE) {
      assert(f.startsWith('ffmpeg\t1\t') && /LGPL/.test(f), `FFmpeg のライブラリがあるのに組み込みなしの版です（LGPL のビルドのはず）: ${f}`);
    }
  });

  test('cli/FFmpeg なしの版: ffmpeg_off.um に差し替えると FFmpeg のライブラリなしでビルドでき、caps が ffmpeg 0', () => {
    const um = umHome();
    if (!um) skip('UnifiedMozaic のコンパイラが見つかりません（UM_HOME）');
    // ほかのファイル（注釈も）に UM の標準の動画・音声の名前があると、FFmpeg をリンクしようとして失敗する
    const copy = path.join(TMP, 'noffmpeg', 'src');
    fs.cpSync(path.join(ROOT, 'src'), copy, { recursive: true });
    useFfmpegOff(copy);
    const exe = path.join(TMP, 'noffmpeg', 'mozcut' + EXT);
    const env = { ...process.env, UM_FFMPEG_HOME: path.join(TMP, 'no-ffmpeg-here'), PKG_CONFIG_PATH: path.join(TMP, 'no-ffmpeg-here') };
    const wt = wasmtimeHome();
    if (wt) env.UM_WASMTIME = wt;
    const b = run(process.execPath, [path.join(um, 'src', 'cli.ts'), 'build', path.join(copy, 'main.um'), '--target', 'host', '-o', exe], { env, timeout: 300000 });
    assert(b.code === 0, `FFmpeg なしの版をビルドできません\n${(b.out + b.err).slice(0, 2000)}`);
    const r = run(exe, ['caps']);
    assert(r.code === 0 && r.out.split(/\r?\n/).includes('ffmpeg\t0'), `caps が ffmpeg 0 ではありません: ${r.out}${r.err}`);
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
  // demo/demo.mzc と素材（demo/media）を一時フォルダに写して使う。check は素材を調べて demo.cache/probe.txt を書くので、
  // リポジトリの demo/ を使うと、同時に流れているほかのテスト（tests/all.mjs の mcp など。demo/ を写しに行く）とぶつかる。
  let cliDemoFile = null;
  const cliDemo = () => {
    if (cliDemoFile) return cliDemoFile;
    const dir = path.join(TMP, 'cli-demo');
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(path.join(ROOT, 'demo', 'demo.mzc'), path.join(dir, 'demo.mzc'));
    const media = path.join(ROOT, 'demo', 'media');
    if (fs.existsSync(media)) fs.cpSync(media, path.join(dir, 'media'), { recursive: true });
    return (cliDemoFile = path.join(dir, 'demo.mzc'));
  };
  test('cli/mozcut.mjs check demo/demo.mzc', () => {
    // 素材を調べるので、写しの隣に demo.cache/probe.txt を書く
    const r = run(process.execPath, [MOZCUT_MJS, 'check', cliDemo(), '--json']);
    const j = parseJson(r.out, 'mozcut.mjs check --json');
    assert(r.code === 0 && j.diagnostics.length === 0, `demo.mzc に誤りがあります: ${fmtDiags(j.diagnostics ?? [])}`);
    assert(j.clips.length >= 5, 'クリップが少なすぎます');
  });
  test('cli/mozcut.mjs show / op --dry-run（素材を調べてから渡す）', () => {
    const demo = cliDemo();
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
    const o = run(process.execPath, [MOZCUT_MJS, 'op', cliDemo(), '--json']);
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

  test('cli/FFmpeg の組み込みで素材を調べる（probe.txt なしで長さ・音の有無が分かり、ないファイルは missing-source）', () => {
    if (!engineFfmpeg()) skip('エンジンに FFmpeg の組み込みがない');
    const m = realMedia();
    const f = path.join(m.dir, `probe${++seq}.mzc`);
    fs.writeFileSync(f, ['project size=320x180 fps=30', 'video "v30.mp4" id=v', 'video "silent.mp4" id=s', 'audio "tone.wav" id=a',
      'image "logo.png" id=g', 'video "none.mp4" id=n out=1', ''].join('\n'));
    const r = engine(['check', f, '--json']);
    const j = parseJson(r.out, 'check --json');
    const clip = (id) => j.clips.find((c) => c.id === id);
    assert(near(clip('v').duration, 2, 0.05) && near(clip('s').duration, 1, 0.05) && near(clip('a').duration, 1.5, 0.01),
      `長さが素材の長さになっていません: ${JSON.stringify(j.clips.map((c) => [c.id, c.duration]))}`);
    assert(near(clip('g').duration, 5), `画像の長さが既定の 5 秒ではありません: ${clip('g').duration}`);
    const codes = j.diagnostics.map((d) => `${d.code}@${d.line}`);
    assert(r.code === 1 && codes.join(',') === 'missing-source@6', `診断が違います: ${codes.join(', ')}`);
  });
}

// ---- FFmpeg の組み込みを試す素材（ffmpeg のコマンドで一度だけ作る） ----

// エンジンが FFmpeg の組み込みを持つか（caps）。
let engineFfmpegCache;
function engineFfmpeg() {
  if (engineFfmpegCache === undefined) {
    const r = spawnSync(EXE, ['caps'], { encoding: 'utf8' });
    engineFfmpegCache = !r.error && r.status === 0 && (r.stdout || '').split(/\r?\n/).some((l) => l.startsWith('ffmpeg\t1\t'));
  }
  return engineFfmpegCache;
}

// 小さな本物の素材（TMP/real/）。ffmpeg のコマンドがなければ飛ばす。
//   v30.mp4    320x180、30 コマ/秒、2 秒、H.264 + AAC 48 kHz（赤の量がコマの番号 × 4 の模様）
//   v25.mp4    320x240、25 コマ/秒、2 秒、MPEG-4 Part 2（B フレームつき）+ AAC 44.1 kHz
//   silent.mp4 320x180、30 コマ/秒、1 秒、音なし
//   tone.wav   1.5 秒、440 Hz、48 kHz ステレオ
//   logo.png   64x48、半透明の RGBA
//   flat720.mp4 1280x720、1 色（拡大縮小しない大きさで、色差の行が欠けないか）
let realMediaCache;
function realMedia() {
  if (realMediaCache) return realMediaCache;
  const ff = process.env.FFMPEG || 'ffmpeg';
  if (spawnSync(ff, ['-version']).error) skip('ffmpeg のコマンドがない');
  const dir = path.join(TMP, 'real');
  fs.mkdirSync(dir, { recursive: true });
  const jobs = [
    ['v30.mp4', ['-f', 'lavfi', '-i', "color=c=black:s=320x180:r=30:d=2,format=yuv444p,geq=lum='16+min(N*4,200)':cb='128':cr='X/3+64'", '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=2',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '15', '-bf', '2', '-c:a', 'aac', '-shortest']],
    ['v25.mp4', ['-f', 'lavfi', '-i', 'testsrc=s=320x240:r=25:d=2', '-f', 'lavfi', '-i', 'sine=frequency=660:sample_rate=44100:duration=2',
      '-c:v', 'mpeg4', '-bf', '2', '-q:v', '3', '-c:a', 'aac', '-shortest']],
    ['silent.mp4', ['-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=30:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p']],
    ['tone.wav', ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=1.5', '-ac', '2']],
    ['logo.png', ['-f', 'lavfi', '-i', "color=c=0x00000000:s=64x48,format=rgba,geq=r='255':g='X*4':b='0':a='128'", '-frames:v', '1']],
    ['flat720.mp4', ['-f', 'lavfi', '-i', 'color=c=0x3060a0:s=1280x720:r=30:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p']],
  ];
  // いっぱいの範囲（yuvj420p）の 1 色（Y=214、U=209、V=50）。値がそのまま残るように、生の YUV から可逆で作る
  const fw = 1280;
  const fh = 720;
  const flat = Buffer.alloc(fw * fh * 3 / 2);
  flat.fill(214, 0, fw * fh);
  flat.fill(209, fw * fh, fw * fh * 5 / 4);
  flat.fill(50, fw * fh * 5 / 4);
  const rawFull = path.join(dir, 'full720.yuv');
  fs.writeFileSync(rawFull, Buffer.concat(Array(30).fill(flat)));
  jobs.push(['full720.mp4', ['-f', 'rawvideo', '-pix_fmt', 'yuvj420p', '-s', `${fw}x${fh}`, '-r', '30', '-i', rawFull,
    '-c:v', 'libx264', '-qp', '0', '-pix_fmt', 'yuvj420p', '-color_range', 'pc']]);
  for (const [name, args] of jobs) {
    const r = spawnSync(ff, ['-v', 'error', '-y', ...args, path.join(dir, name)], { encoding: 'utf8' });
    if (r.error || r.status !== 0) fail(`素材 ${name} を作れません: ${r.stderr}`);
  }
  realMediaCache = { dir };
  return realMediaCache;
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
  h.update(String(ffmpegLibsFound()));
  const dir = path.join(os.tmpdir(), `mozcut-m1check-${h.digest('hex').slice(0, 16)}`);
  const exe = path.join(dir, 'm1check' + EXT);
  if (fs.existsSync(exe)) return (m1checkExe = exe);
  // いくつもの群（tests/all.mjs では別々のプロセス）が同時にここへ来るので、自分だけのフォルダに作ってから
  // dir へ名前を変えて置く。先に置いたものがあれば、それを使う（作りかけの dir を消し合わないように）。
  const work = `${dir}-${process.pid}`;
  const copy = path.join(work, 'src');
  fs.rmSync(work, { recursive: true, force: true });
  for (const f of files) {
    const to = path.join(copy, path.relative(srcDir, f));
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(f, to);
  }
  fs.copyFileSync(main, path.join(copy, 'm1check.um'));
  // FFmpeg のライブラリがなければ、エンジンと同じく ffmpeg.um を ffmpeg_off.um に差し替える
  if (!ffmpegLibsFound()) useFfmpegOff(copy);
  const env = { ...process.env };
  const wt = wasmtimeHome();
  if (wt) env.UM_WASMTIME = wt;
  console.log('  ..  tests/um/m1check.um をビルドしています');
  const workExe = path.join(work, 'm1check' + EXT);
  const r = run(process.execPath, [path.join(um, 'src', 'cli.ts'), 'build', path.join(copy, 'm1check.um'), '--target', 'host', '-o', workExe], { env });
  if (r.code !== 0 || !fs.existsSync(workExe)) {
    m1checkErr = `tests/um/m1check.um をビルドできません\n${(r.out + r.err).slice(0, 2000)}`;
    fs.rmSync(work, { recursive: true, force: true });
    fail(m1checkErr);
  }
  if (!fs.existsSync(exe)) {
    // exe のない dir（前に途中で止まったもの）は消してから置く
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    try {
      fs.renameSync(work, dir);
      return (m1checkExe = exe);
    } catch {
      // ほかのプロセスが先に置いた
    }
  }
  if (fs.existsSync(exe)) {
    fs.rmSync(work, { recursive: true, force: true });
    return (m1checkExe = exe);
  }
  return (m1checkExe = workExe);
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
  test('play/時計: 等速、L で 2 倍 → 4 倍（上限）、終わりで止まる。2 倍・4 倍で見せるコマは速さの倍数', () => {
    expectKv(clockKv(), {
      'init': '停止|0|0', 'init.total': '60', 'init.tick': 'true', 'init.tick2': 'false',
      'play.tick': 'true', 'play.0.5': '再生 ×1|15|0.5', 'play.same': 'false',
      'L2': '再生 ×2|15|0.5', 'L2.tick': '再生 ×2|44|1.5', 'L4': '再生 ×4', 'L8': '再生 ×4',
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
      'audio.tick': '再生 ×1|31|1.05', 'audio.cap': '再生 ×1|33|1.1', 'audio.x2': '再生 ×2|38|1.3',
    });
    assert(JSON.parse(g['audio.json']).clock === 'audio', `音の時計なのに clock が ${JSON.parse(g['audio.json']).clock} です`);
    assert(JSON.parse(g['audio.x2.json']).clock === 'wall', '2 倍なのに clock が wall ではありません');
  });
  test('play/29.97 コマ/秒: 見せるコマの時刻が書き出しの frameTime と同じ、縮んだら収める', () => {
    expectKv(clockKv(), { 'ntsc.total': '300', 'ntsc.bad': '0', 'reload.shrink': '停止|59|2' });
  });
  test('play/統計: 60 Hz の等速は飛ばしなし、0.1 秒の遅れは 2 コマ落ち、2 倍・4 倍の飛ばし（速さの倍数のコマだけ見せる）は落ちではない', () => {
    const g = clockKv();
    const s = (k) => JSON.parse(g[k]);
    const bad = [];
    const want = (k, f, v) => { if (s(k)[f] !== v) bad.push(`${k}.${f}: 期待 ${v}、実際 ${s(k)[f]}`); };
    want('stats.60hz', 'shown', 15); want('stats.60hz', 'skipped', 0); want('stats.60hz', 'dropped', 0);
    want('stats.gap', 'skipped', 2); want('stats.gap', 'dropped', 2);
    want('stats.x2', 'skipped', 10); want('stats.x2', 'dropped', 0);
    want('stats.x4', 'skipped', 15); want('stats.x4', 'dropped', 0);
    assert(bad.length === 0, bad.join('\n'));
  });
  test('play/統計: 再生中のシークと、終わりからの再生し直しをコマ落ちに数えない', () => {
    const g = clockKv();
    const a = JSON.parse(g['stats.seekPlaying']);
    const b = JSON.parse(g['stats.restart']);
    assert(a.dropped === 0 && a.skipped === 0 && b.dropped === 0 && b.skipped === 0,
      `再生中に 1.5 秒 → 0 秒へシーク: skipped ${a.skipped} / dropped ${a.dropped}。終わりから再生し直し: skipped ${b.skipped} / dropped ${b.dropped}（どちらも 0 のはず）`);
  });
  test('play/統計: 音の時計の遅れは、画面に出た時刻の音の位置 − コマの始まり。音の時計を選んだままの 2 倍は壁時計の式', () => {
    const g = clockKv();
    const a = JSON.parse(g['stats.audioLate']);
    assert(a.clock === 'audio' && Math.abs(a.lateMsAvg - 22) < 0.5 && Math.abs(a.lateMsMax - 22) < 0.5,
      `音の時計の遅れが 22 ms ではありません（描いてから出るまでの 12 ms を数えていないか）: ${g['stats.audioLate']}`);
    const b = JSON.parse(g['stats.x2audioSrc']);
    assert(b.clock === 'wall' && b.lateMsMax < 1, `音の時計を選んだままの 2 倍で、遅れを壁時計の式で数えていません: ${g['stats.x2audioSrc']}`);
  });
  test('play/統計: 止めていた時間を遅れに数えない', () => {
    const j = JSON.parse(clockKv()['stats.60hz']);
    assert(j.lateMsMax < 1, `60 Hz の等速で遅れの最大が ${j.lateMsMax} ms です（時刻ちょうどに出しているので 0 のはず）`);
  });

  test('play/先読みに頼むコマ（止めたとき 3 コマ、等速 8 コマ、4 倍は見せる 4 の倍数のコマ、逆再生は塊ごとに前から）と世代', () => {
    const sb = fixture(path.join(CASES, 'play', 'plan.mzc'), path.join(CASES, 'play', 'probe.txt'));
    const r = run(m1check(), ['plan', sb.file, sb.cache], { timeout: 60000 });
    assert(r.code === 0, `m1check plan が終了コード ${r.code} で終わりました\n${r.err}`);
    const g = kv(r.out);
    const seqOf = (from, step, n) => Array.from({ length: n }, (_, j) => `0:${from + step * j}:${j}`).join(' ');
    expectKv(g, {
      'slots': '48',
      'stopped': seqOf(15, 1, 3), 'stopped.again': seqOf(15, 1, 3),
      'x1': seqOf(15, 1, 8), 'x4': seqOf(12, 4, 8),
      // 逆再生（27 コマ目から）: 枠 48 個・見えるクリップ 1 つなので塊は 24 コマ。いまの塊（24〜27）と 1 つ前の塊（0〜23）を、
      // それぞれ前から頼む（先読みは塊の頭へ 1 度だけ戻って、続けて展開する）
      'rev': `${seqOf(24, 1, 4)} ${Array.from({ length: 24 }, (_, j) => `0:${j}:${24 + j}`).join(' ')}`,
      'rev.ready': '28', 'rev.left': '',
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

// ---- mzplug（.mzplug の作成・読み込み・組み込みとの一致） ----

// 既定値では何もしない効果があるので、層が変わる引数で比べる
const FX_TRY = {
  blur: [3], bright: [0.25], contrast: [1.6], gray: [0.6], invert: [0.7], pixelate: [5], sat: [1.7], sepia: [0.9],
  sharpen: [1.2, 2], vignette: [0.8, 0.3, 0.5],
};

let mzDir = null;
function mzWork() {
  if (!mzDir) {
    mzDir = path.join(TMP, 'mzplug');
    fs.mkdirSync(mzDir, { recursive: true });
  }
  return mzDir;
}

function pluginBuild(src, out) {
  const r = run(process.execPath, [MOZCUT_MJS, 'plugin', 'build', src, '-o', out, '--json'], { timeout: 120000 });
  const j = parseJson(r.out, 'plugin build --json');
  assert(r.code === 0 && j.ok === true, `plugin build が失敗しました（終了コード ${r.code}）\n${r.out}${r.err}`);
  return j;
}

// plugins/<n>.um を、効果の名前を w<n> に変え、別名を外した写しにして .mzplug にする（組み込みと名前がぶつからないように）。
function renamedPlugin(n) {
  const text = fs.readFileSync(path.join(ROOT, 'plugins', `${n}.um`), 'utf8')
    .replace(/^\/\/ @effect (\S+)/m, `// @effect w${n}`)
    .replace(/^\/\/ @alias .*$/gm, '//')
    .replace(new RegExp(`\\bfx_${n}\\b`, 'g'), `fx_w${n}`);
  const src = path.join(mzWork(), `w${n}.um`);
  fs.writeFileSync(src, text);
  const out = path.join(mzWork(), `w${n}.mzplug`);
  return { j: pluginBuild(src, out), out };
}

function groupMzplug() {
  const names = list(path.join(ROOT, 'plugins'), '.um').map((f) => f.replace(/\.um$/, ''));
  const schema = parseJson(engine(['schema', '--json']).out, 'schema --json');
  // 組み込みの効果の数（plugins/*.um の数。プラグインを足しても試験を書き直さなくてよいように、決め打ちしない）
  const nb = String(names.length);
  const nb1 = String(names.length + 1);
  for (const n of names) {
    test(`mzplug/${n}: 作る → 読み込む → 組み込みと同じ結果（帯の分け方 3 通り × 大きさ 3 通り）`, () => {
      const { j, out } = renamedPlugin(n);
      const bytes = fs.readFileSync(out);
      assert(bytes.length === j.bytes && bytes.subarray(0, 4).equals(Buffer.from([0, 0x61, 0x73, 0x6d])), '.mzplug が wasm ではありません');
      assert(j.name === `w${n}` && j.manifest.name === `w${n}`, `宣言の名前が ${j.manifest?.name} です`);
      const fx = schema.effects.find((e) => e.name === n);
      const mp = (j.manifest.params || []).map((p) => `${p.name}=${p.default}[${p.min},${p.max}]`).join(' ');
      const sp = fx.params.map((p) => `${p.name}=${p.default}[${p.min},${p.max}]`).join(' ');
      assert(mp === sp, `宣言の引数が組み込みと違います\n  組み込み: ${sp}\n  .mzplug: ${mp}`);
      const r = run(m1check(), ['fx', out, n, `w${n}`, ...(FX_TRY[n] || []).map(String)], { timeout: 120000 });
      const g = kv(r.out);
      assert(r.code === 0, `m1check fx が終了コード ${r.code} で終わりました\n${r.out}${r.err}`);
      expectKv(g, { count: nb1, diags: '0', wasm: nb, 'source.isMzplug': 'true', 'reach.same': 'true' });
      assert(g['decl.builtin'] === g['decl.wasm'], `読み込んだ引数の宣言が違います\n  ${g['decl.builtin']}\n  ${g['decl.wasm']}`);
      const cmps = Object.keys(g).filter((k) => k.startsWith('cmp.'));
      assert(cmps.length === 9, `比べた数が ${cmps.length} です`);
      const bad = cmps.filter((k) => !/^err=\| diff=0 /.test(g[k]) || / changed=0$/.test(g[k])).map((k) => `${k}: ${g[k]}`);
      assert(bad.length === 0, `組み込みと違います（diff は違う画素の数、changed は効果で変わった画素の数）\n${bad.join('\n')}`);
    });
  }
  test('mzplug/組み込みと同じ名前・同じ包みの 2 回目・壊れた包みは読み込まず、bad-plugin にする', () => {
    const dir = mzWork();
    // 組み込みと同じ名前（plugin build は作れるが、注意を出す）
    const same = path.join(dir, 'sharpen.mzplug');
    pluginBuild(path.join(ROOT, 'plugins', 'sharpen.um'), same);
    const a = kv(run(m1check(), ['clash', same]).out);
    // 同じ包みを 2 回: 1 回目は読み、2 回目は名前がぶつかる
    const w = fs.existsSync(path.join(dir, 'wsepia.mzplug')) ? path.join(dir, 'wsepia.mzplug') : renamedPlugin('sepia').out;
    const runClash = (f) => {
      const r = run(m1check(), ['clash', f]);
      return { code: r.code, out: r.out, diags: r.out.split(/\r?\n/).filter((l) => l.startsWith('diag\t')) };
    };
    const b = runClash(w);
    // 壊れた包み: wasm ではない・途中で切れた・宣言のない wasm
    const junk = path.join(dir, 'junk.mzplug');
    fs.writeFileSync(junk, 'これは wasm ではありません');
    const cut = path.join(dir, 'cut.mzplug');
    fs.writeFileSync(cut, fs.readFileSync(w).subarray(0, 64));
    const bare = path.join(dir, 'bare.mzplug');
    fs.writeFileSync(bare, Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]));
    const bad = [];
    if (a.count !== nb) bad.push(`組み込みと同じ名前の包みを読み込みました（count ${a.count}）`);
    const ad = runClash(same).diags;
    if (ad.length !== 2 || !ad.every((d) => d.includes('bad-plugin'))) bad.push(`組み込みと同じ名前の診断が違います: ${ad.join(' / ')}`);
    if (kv(b.out).count !== nb1 || b.diags.length !== 1 || !b.diags[0].includes('bad-plugin')) bad.push(`同じ包みの 2 回目: count ${kv(b.out).count}、診断 ${b.diags.join(' / ')}`);
    for (const f of [junk, cut, bare]) {
      const c = runClash(f);
      if (c.code !== 0 || kv(c.out).count !== nb || c.diags.length !== 2 || !c.diags.every((d) => d.includes('bad-plugin'))) {
        bad.push(`${path.basename(f)}: 終了コード ${c.code}、count ${kv(c.out).count}、診断 ${c.diags.join(' / ') || '（なし）'}`);
      }
    }
    assert(bad.length === 0, bad.join('\n'));
  });
  test('mzplug/blur: 半径の .5・10 を超える半径でも、帯の分け方で結果が変わらない（透明なまわり・不透明、組み込みとも同じ）', () => {
    const out = fs.existsSync(path.join(mzWork(), 'wblur.mzplug')) ? path.join(mzWork(), 'wblur.mzplug') : renamedPlugin('blur').out;
    const bad = [];
    const cases = [
      [320, 240, 0, 0.5], [320, 240, 0, 1.5], [320, 240, 0, 2.5], [320, 240, 0, 10.5], [320, 240, 0, 11], [320, 240, 0, 20],
      [1280, 720, 1, 1.5], [1280, 720, 1, 20],
    ];
    for (const [w, h, opaque, r] of cases) {
      const res = run(m1check(), ['bands', out, 'blur', 'wblur', String(w), String(h), String(opaque), String(r)], { timeout: 120000 });
      const g = kv(res.out);
      if (res.code !== 0) {
        bad.push(`${w}x${h} 半径 ${r}: 終了コード ${res.code}
${res.out}${res.err}`);
        continue;
      }
      // 広がり（余白）は、実際に使う整数の半径の 2 倍
      const want = 2 * Math.floor(r + 0.5);
      if (g['reach.builtin'] !== String(want) || g['reach.wasm'] !== String(want)) bad.push(`${w}x${h} 半径 ${r}: 広がりが ${g['reach.builtin']} / ${g['reach.wasm']}（${want} のはず）`);
      for (const b of ['b1', 'b0', 'b7', 'b32']) {
        if (!/^err= diff=0 /.test(g[b] || '')) bad.push(`${w}x${h} 半径 ${r} ${b}: ${g[b]}`);
      }
    }
    assert(bad.length === 0, `帯の分け方か組み込みとで結果が違います
${bad.join('\n')}`);
  });
  test('mzplug/終わらない効果は時間切れのあと使わない（2 回目は待たない）。import を要る包みは読み込まない', () => {
    const src = path.join(mzWork(), 'wloop.um');
    fs.writeFileSync(src, [
      '// @effect wloop "終わらない（時間切れの試し）"',
      '// @param amount 1 0..1 "何もしない"',
      '',
      'export function fx_wloop(layer: mut Buffer<vec4<f32>>, tmp: mut Buffer<vec4<f32>>, w: u32, h: u32, p: f32[8]): void {',
      '  let k: u32 = 0;',
      '  while (p[0] > -1.0) {',
      '    k = k + 1;',
      '    if (k == 0) {',
      '      layer[0] = vec4(0.0, 0.0, 0.0, 0.0);',
      '    }',
      '  }',
      '}',
      '',
    ].join('\n'));
    const out = path.join(mzWork(), 'wloop.mzplug');
    pluginBuild(src, out);
    const r = run(m1check(), ['stuck', out, 'wloop'], { timeout: 60000 });
    const g = kv(r.out);
    assert(r.code === 0, `m1check stuck が終了コード ${r.code} で終わりました
${r.out}${r.err}`);
    assert(/timeout/.test(g['run0.err'] || '') && Number(g['run0.ms']) < 5000, `1 回目が時間切れになっていません: ${g['run0.ms']} ms ${g['run0.err']}`);
    assert(g['run1.err'] && Number(g['run1.ms']) < 50 && g.disabled === '1', `2 回目も待ちました: ${g['run1.ms']} ms（disabled ${g.disabled}）${g['run1.err']}`);
  });
  test('mzplug/plugin list --json（組み込みの効果を plugins/ と同じだけ並べる）', () => {
    const r = run(process.execPath, [MOZCUT_MJS, 'plugin', 'list', '--json']);
    const j = parseJson(r.out, 'plugin list --json');
    assert(r.code === 0 && j.ok === true, `plugin list が失敗しました\n${r.out}${r.err}`);
    assert(JSON.stringify(j.builtin.map((b) => b.name).sort()) === JSON.stringify([...names].sort()), `builtin が plugins/ と違います: ${j.builtin.map((b) => b.name).join(', ')}`);
    assert(Array.isArray(j.installed), 'installed が配列ではありません');
  });
  test('mzplug/plugin build の使い方の誤りは終了コード 2', () => {
    for (const args of [['plugin', 'build'], ['plugin', 'build', 'a', 'b'], ['plugin', 'build', 'blur', '--bogus'], ['plugin', 'nosuch']]) {
      const r = run(process.execPath, [MOZCUT_MJS, ...args]);
      assert(r.code === 2, `mozcut.mjs ${args.join(' ')} の終了コードが ${r.code} です`);
    }
    const r = run(process.execPath, [MOZCUT_MJS, 'plugin', 'build', path.join(mzWork(), 'nosuch.um'), '--json']);
    assert(r.code !== 0 && parseJson(r.out, 'plugin build --json（ないファイル）').ok === false, `ないファイルの plugin build が違います: ${r.code} ${r.out}`);
  });
}

// ---- editor（編集画面の起動・最近の一覧） ----

// 編集画面を、ウィンドウを出さずに（offscreen）、音を鳴らさずに（dummy）動かす。終わらなければ止める。
function editorRun(args, { cwd, timeout = 60000 } = {}) {
  const env = { ...process.env, SDL_VIDEO_DRIVER: 'offscreen', SDL_AUDIO_DRIVER: 'dummy' };
  return run(EDITOR_EXE, args, { cwd, env, timeout });
}

// <home>/mozcut-recent.txt の、注釈と空の行を除いた行。
function recentOf(home) {
  const f = path.join(home, 'mozcut-recent.txt');
  if (!fs.existsSync(f)) return null;
  return fs.readFileSync(f, 'utf8').split(/\r?\n/).filter((l) => l.trim() && !l.startsWith('#'));
}

const samePathJs = (a, b) => (process.platform === 'win32'
  ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
  : path.resolve(a) === path.resolve(b));

// 画面の BMP（32 ビット、上から下）の大きさと、色の数。
function screenInfo(file) {
  const b = fs.readFileSync(file);
  assert(b[0] === 0x42 && b[1] === 0x4d, `${path.basename(file)} が BMP ではありません`);
  const w = b.readInt32LE(18);
  const h = Math.abs(b.readInt32LE(22));
  const colors = new Set();
  for (let o = 54; o < b.length; o += 4 * 97) colors.add(b.readUInt32LE(o));
  return { w, h, colors: colors.size };
}

function editorHome(tag) {
  const base = path.join(TMP, `e-${tag}-${++seq}`);
  const home = path.join(base, 'build');
  fs.mkdirSync(home, { recursive: true });
  return { base, home };
}

// FFmpeg なしの版の編集画面（src/ の写しの ffmpeg.um を ffmpeg_off.um に差し替えてビルドする。1 度だけ作って使い回す）。
// SDL3・wasmtime の DLL は build/ のものを隣に写す。作れなければ skip。
let noFfmpegEditorCache;
function noFfmpegEditor() {
  if (noFfmpegEditorCache) return noFfmpegEditorCache;
  const um = umHome();
  if (!um) skip('UnifiedMozaic のコンパイラが見つかりません（UM_HOME）');
  const sdl = sdl3HomeJs();
  if (!sdl) skip('SDL3 が見つかりません（UM_SDL3）');
  const dir = path.join(TMP, 'noffmpeg-editor');
  const copy = path.join(dir, 'src');
  fs.cpSync(path.join(ROOT, 'src'), copy, { recursive: true });
  useFfmpegOff(copy);
  const exe = path.join(dir, 'mozcut-edit' + EXT);
  const env = { ...process.env, UM_SDL3: sdl, UM_FFMPEG_HOME: path.join(TMP, 'no-ffmpeg-here'), PKG_CONFIG_PATH: path.join(TMP, 'no-ffmpeg-here') };
  const wt = wasmtimeHome();
  if (wt) env.UM_WASMTIME = wt;
  const b = run(process.execPath, [path.join(um, 'src', 'cli.ts'), 'build', path.join(copy, 'editor.um'), '--target', 'host', '-o', exe], { env, timeout: 300000 });
  assert(b.code === 0, `FFmpeg なしの版の編集画面をビルドできません\n${(b.out + b.err).slice(0, 2000)}`);
  for (const f of fs.readdirSync(path.dirname(EDITOR_EXE))) {
    if (/^(SDL3|wasmtime).*\.(dll|so|dylib)$/i.test(f)) fs.copyFileSync(path.join(path.dirname(EDITOR_EXE), f), path.join(dir, f));
  }
  noFfmpegEditorCache = exe;
  return exe;
}

// tools/mozcut.mjs の sdl3Home と同じ探し方。
function sdl3HomeJs() {
  if (process.env.UM_SDL3) return process.env.UM_SDL3;
  for (const dir of [path.join(ROOT, '..'), os.homedir()]) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const n of names.filter((n) => n.startsWith('SDL3-')).sort().reverse()) {
      if (fs.existsSync(path.join(dir, n, 'include', 'SDL3', 'SDL.h'))) return path.join(dir, n);
    }
  }
  return undefined;
}

function groupEditor() {
  if (!fs.existsSync(EDITOR_EXE)) {
    console.log('  --  editor（build/mozcut-edit-old がないので飛ばす。node tools/mozcut.mjs build で作れます）');
    return;
  }
  test('editor/引数がプロジェクトだけの起動（キャッシュは <名前>.cache を読む。最近の一覧の先頭に入る）', () => {
    const { home } = editorHome('only');
    const sb = fixture(path.join(CASES, 'play', 'plan.mzc'), path.join(CASES, 'play', 'probe.txt'), { name: 'plan.mzc', cacheName: 'plan.cache' });
    const shot = path.join(sb.dir, 'shot.bmp');
    const r = editorRun([sb.file, '--home', home, '--frames', '3', '--shot', shot]);
    assert(r.code === 0, `終了コード ${r.code}\n${r.err}`);
    const s = screenInfo(shot);
    assert(s.w === 1280 && s.h === 800 && s.colors > 8, `画面の画像がおかしい: ${JSON.stringify(s)}`);
    const rec = recentOf(home);
    assert(rec && rec.length === 1 && samePathJs(rec[0], sb.file), `最近の一覧が違います: ${JSON.stringify(rec)}`);
    // 素材のキャッシュがないプロジェクトでも落ちない（案内を出すだけ）
    const sb2 = sandbox(path.join(CASES, 'play', 'plan.mzc'), 'nocache.mzc');
    const r2 = editorRun([sb2.file, '--home', home, '--frames', '3']);
    assert(r2.code === 0, `キャッシュのないプロジェクトで終了コード ${r2.code}\n${r2.err}`);
    assert(samePathJs(recentOf(home)[0], sb2.file) && recentOf(home).length === 2, `2 つ目が一覧の先頭にありません: ${JSON.stringify(recentOf(home))}`);
  });
  test('editor/引数がプロジェクトだけで再生する（--play 1 --stats: 先読みが当たり、展開に失敗しない）', () => {
    const { home } = editorHome('play');
    const sb = fixture(path.join(CASES, 'play', 'plan.mzc'), path.join(CASES, 'play', 'probe.txt'), { name: 'plan.mzc', cacheName: 'plan.cache' });
    const r = editorRun([sb.file, '--home', home, '--frames', '40', '--play', '1', '--stats']);
    assert(r.code === 0, `終了コード ${r.code}\n${r.err}`);
    // 編集画面は「playback: {...}」の形で出す
    const line = (r.err.split(/\r?\n/).find((l) => /^(playback: )?\{"state"/.test(l)) || '').replace(/^playback: /, '');
    assert(line, `--stats の JSON が標準エラーにありません\n${r.err}`);
    const st = parseJson(line, '--stats');
    assert(st.shown > 1 && st.hits > 0 && st.fetchFailed === 0 && st.slots > 0, `再生の統計がおかしい: ${line}`);
  });
  test('editor/相対パスで開いても、最近の一覧には絶対パスで入る', () => {
    const { base, home } = editorHome('rel');
    const proj = path.join(base, 'proj');
    fs.mkdirSync(proj);
    fs.copyFileSync(path.join(CASES, 'play', 'color.mzc'), path.join(proj, 'c.mzc'));
    const r = editorRun(['c.mzc', '--home', home, '--frames', '2'], { cwd: proj });
    assert(r.code === 0, `終了コード ${r.code}\n${r.err}`);
    const rec = recentOf(home);
    assert(rec && rec.length === 1 && path.isAbsolute(rec[0]) && samePathJs(rec[0], path.join(proj, 'c.mzc')),
      `最近の一覧に '${rec && rec[0]}' が入りました（ほかのフォルダから起動したスタート画面では開けません）`);
  });
  test('editor/スタート画面: 最近の一覧を読み（注釈・空の行・CRLF・重なりを飛ばし 10 件まで）、開いたものを先頭へ移して書く', () => {
    const { base, home } = editorHome('recent');
    const files = [];
    for (let i = 0; i < 12; i++) {
      const f = path.join(base, `p${i}.mzc`);
      if (i !== 2) fs.copyFileSync(path.join(CASES, 'play', 'color.mzc'), f); // p2 は消えたファイル
      files.push(f);
    }
    const dup = process.platform === 'win32' ? files[0].toUpperCase() : files[0];
    const text = ['# 注釈', '', files[0], `  ${dup}  `, files[1], files[2], '   ', ...files.slice(3)].join('\r\n') + '\r\n';
    const rf = path.join(home, 'mozcut-recent.txt');
    fs.writeFileSync(rf, text);
    // 消えたファイル（3 番目の項目 = p2）を開こうとしても開かず、一覧はそのまま
    const r0 = editorRun(['--home', home, '--start-select', '2', '--start-open', '1', '--frames', '3']);
    assert(r0.code === 0, `終了コード ${r0.code}\n${r0.err}`);
    assert(fs.readFileSync(rf, 'utf8') === text, '開けなかったのに最近の一覧が書き換わりました');
    // 4 番目の項目（p3）を開く → p3 が先頭、重なりは 1 つ、10 件まで、LF で保存
    const shot = path.join(base, 'start.bmp');
    const r = editorRun(['--home', home, '--start-select', '3', '--start-open', '1', '--frames', '3', '--shot', shot]);
    assert(r.code === 0, `終了コード ${r.code}\n${r.err}`);
    const after = fs.readFileSync(rf, 'utf8');
    const rec = recentOf(home);
    const want = [files[3], files[0], files[1], files[2], ...files.slice(4, 10)];
    assert(rec.length === 10 && rec.every((p, i) => samePathJs(p, want[i])),
      `最近の一覧が違います\n  期待: ${want.map((f) => path.basename(f)).join(' ')}\n  実際: ${rec.map((f) => path.basename(f)).join(' ')}`);
    assert(after.startsWith('#') && !after.includes('\r'), '書き直した一覧の先頭が注釈でないか、CR が残っています');
    assert(screenInfo(shot).w === 1280, '画面の画像がありません');
  });
  test('editor/スタート画面: デモ（<home>/../demo/demo.mzc）は先頭に 1 つだけ。最近の一覧と重ねない', () => {
    const { base, home } = editorHome('demo');
    fs.mkdirSync(path.join(base, 'demo'));
    const demo = path.join(base, 'demo', 'demo.mzc');
    fs.copyFileSync(path.join(CASES, 'play', 'color.mzc'), demo);
    const x = path.join(base, 'x.mzc');
    fs.copyFileSync(path.join(CASES, 'play', 'color.mzc'), x);
    fs.writeFileSync(path.join(home, 'mozcut-recent.txt'), `${demo}\n${x}\n`);
    // 項目は [デモ, x]。1 番目を開くと x
    const r = editorRun(['--home', home, '--start-select', '1', '--start-open', '1', '--frames', '2']);
    assert(r.code === 0, `終了コード ${r.code}\n${r.err}`);
    let rec = recentOf(home);
    assert(samePathJs(rec[0], x) && rec.length === 2, `x を開いたはずが、一覧は ${JSON.stringify(rec)}`);
    // 0 番目（デモ）を開くと、デモが一覧の先頭
    const r2 = editorRun(['--home', home, '--start-select', '0', '--start-open', '1', '--frames', '2']);
    assert(r2.code === 0, `終了コード ${r2.code}\n${r2.err}`);
    rec = recentOf(home);
    assert(samePathJs(rec[0], demo) && rec.length === 2, `デモを開いたはずが、一覧は ${JSON.stringify(rec)}`);
  });
  test('editor/--keys でキーを押す: J J で逆 2 倍、続けて K で止まる。F1 のキーの一覧を出しても落ちない', () => {
    const { home } = editorHome('keys');
    const sb = fixture(path.join(CASES, 'play', 'plan.mzc'), path.join(CASES, 'play', 'probe.txt'), { name: 'plan.mzc', cacheName: 'plan.cache' });
    const statsOf = (r) => {
      const line = (r.err.split(/\r?\n/).find((l) => /^playback: \{/.test(l)) || '').replace(/^playback: /, '');
      assert(line, `--stats の JSON が標準エラーにありません\n${r.err}`);
      return parseJson(line, '--stats');
    };
    const a = editorRun([sb.file, '--home', home, '--seek', '1', '--keys', 'J J', '--frames', '4', '--stats']);
    assert(a.code === 0, `終了コード ${a.code}\n${a.err}`);
    const sa = statsOf(a);
    assert(sa.state === 'playing' && sa.speed === -2, `J J のあとが ${sa.state} ×${sa.speed} です（playing ×-2 のはず）`);
    const shot = path.join(sb.dir, 'help.bmp');
    const b = editorRun([sb.file, '--home', home, '--seek', '1', '--keys', 'J J K F1', '--frames', '6', '--stats', '--shot', shot]);
    assert(b.code === 0, `終了コード ${b.code}\n${b.err}`);
    const sbs = statsOf(b);
    assert(sbs.state === 'stopped', `J J K のあとが ${sbs.state} です`);
    assert(screenInfo(shot).w === 1280, '画面の画像がありません');
  });
  test('editor/スタート画面の Ctrl+O: ダイアログで選んだプロジェクトを開く（--keys で Ctrl+O を押し、--start-dialog が結果を返す。OS のダイアログは出さない）', () => {
    const { base, home } = editorHome('dialog');
    const f = path.join(base, 'picked.mzc');
    fs.copyFileSync(path.join(CASES, 'play', 'color.mzc'), f);
    // Ctrl+O 以外のキー（O だけ、Ctrl+P）では開かない
    const { home: home0 } = editorHome('dialog-other');
    const r0 = editorRun(['--home', home0, '--frames', '6', '--keys', 'o Ctrl+P', '--start-dialog', f]);
    assert(r0.code === 0 && recentOf(home0) === null, `Ctrl+O でないキーで開いています: ${r0.code} ${JSON.stringify(recentOf(home0))}`);
    const r = editorRun(['--home', home, '--frames', '6', '--keys', 'Ctrl+O', '--start-dialog', f]);
    assert(r.code === 0, `終了コード ${r.code}\n${r.err}`);
    const rec = recentOf(home);
    assert(rec && rec.length === 1 && samePathJs(rec[0], f), `選んだプロジェクトが開かれていません（最近の一覧: ${JSON.stringify(rec)}）`);
    // ないファイルを選んだら開かない（スタート画面のまま終わる）
    const { home: home2 } = editorHome('dialog-none');
    const r2 = editorRun(['--home', home2, '--frames', '6', '--keys', 'Ctrl+O', '--start-dialog', path.join(base, 'none.mzc')]);
    assert(r2.code === 0 && recentOf(home2) === null, `ないファイルを開いています: ${r2.code} ${JSON.stringify(recentOf(home2))}`);
  });
  test('editor/FFmpeg なしの版: 落とした映像・音は、仮の長さ 5 秒を付けて末尾に足す（長さを調べられないので）', () => {
    const exe = noFfmpegEditor();
    const { base, home } = editorHome('drop-noff');
    const f = path.join(base, 'p.mzc');
    fs.writeFileSync(f, 'project size=320x180 fps=30\ncolor red dur=1\n');
    // 中身は見ない（FFmpeg なしの版は拡張子で見分ける）
    fs.writeFileSync(path.join(base, 'clip.mp4'), 'x');
    fs.writeFileSync(path.join(base, 'bgm.wav'), 'x');
    const env = { ...process.env, SDL_VIDEO_DRIVER: 'offscreen', SDL_AUDIO_DRIVER: 'dummy' };
    const r = run(exe, [f, '--home', home, '--frames', '5', '--drop', path.join(base, 'clip.mp4'), '--drop', path.join(base, 'bgm.wav')], { env, timeout: 60000 });
    assert(r.code === 0, `終了コード ${r.code}\n${r.err}`);
    const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/).filter(Boolean);
    assert(lines.length === 4 && /^video "clip\.mp4" .*at=1 dur=5$/.test(lines[2]) && /^audio "bgm\.wav" .*at=6 dur=5$/.test(lines[3]),
      `仮の長さで足されていません:\n${lines.join('\n')}`);
  });
  test('editor/起動の誤り（引数が多い 2、読めないプロジェクト 1）', () => {
    const { home } = editorHome('bad');
    const a = editorRun(['a.mzc', 'b.cache', 'c', '--home', home, '--frames', '1']);
    assert(a.code === 2, `引数が多いときの終了コードが ${a.code} です`);
    const b = editorRun([path.join(home, 'nosuch.mzc'), '--home', home, '--frames', '1']);
    assert(b.code === 1, `ないプロジェクトの終了コードが ${b.code} です`);
    assert(recentOf(home) === null, '開けなかったプロジェクトが最近の一覧に入りました');
  });
}

// ---- edit2（新しい編集画面の起動と配置） ----

function edit2Run(args, { cwd, timeout = 60000 } = {}) {
  const env = { ...process.env, SDL_VIDEO_DRIVER: 'offscreen', SDL_AUDIO_DRIVER: 'dummy' };
  return run(EDIT2_EXE, args, { cwd, env, timeout });
}

// BMP の (x, y) の画素（0xRRGGBB）。
function bmpPixel(file, x, y) {
  const b = fs.readFileSync(file);
  const w = b.readInt32LE(18);
  return b.readUInt32LE(54 + (y * w + x) * 4) & 0xffffff;
}

function groupEdit2() {
  if (!fs.existsSync(EDIT2_EXE)) {
    console.log('  --  edit2（build/mozcut-edit がないので飛ばす。node tools/mozcut.mjs build で作れます）');
    return;
  }
  test('edit2/1440×900 で開くと、モックアップの配置で描く（上の帯・レール・モニター・右の列・タイムライン・状態の帯）', () => {
    const { home } = editorHome('e2');
    const sb = fixture(path.join(CASES, 'play', 'plan.mzc'), path.join(CASES, 'play', 'probe.txt'), { name: 'plan.mzc', cacheName: 'plan.cache' });
    const shot = path.join(sb.dir, 'e2.bmp');
    const r = edit2Run([sb.file, '--home', home, '--frames', '3', '--shot', shot, '--seek', '1']);
    assert(r.code === 0, `終了コード ${r.code}
${r.err}`);
    const s = screenInfo(shot);
    assert(s.w === 1440 && s.h === 900 && s.colors > 8, `画面の画像がおかしい: ${JSON.stringify(s)}`);
    // 上の帯と状態の帯は bg.2（#222222）、本体の地は bg.0 か bg.1。境目は line（#2C2C2C）
    assert(bmpPixel(shot, 700, 2) === 0x222222, `上の帯の色が ${bmpPixel(shot, 700, 2).toString(16)} です`);
    assert(bmpPixel(shot, 700, 897) === 0x222222, `状態の帯の色が ${bmpPixel(shot, 700, 897).toString(16)} です`);
    assert(bmpPixel(shot, 30, 300) === 0x222222, `レールの色が ${bmpPixel(shot, 30, 300).toString(16)} です`);
    assert(bmpPixel(shot, 315, 300) === 0x2c2c2c, `左の欄の境目の色が ${bmpPixel(shot, 315, 300).toString(16)} です`);
  });
  test('edit2/境目をドラッグすると左の欄・右の列・タイムラインの大きさが変わる', () => {
    const { home } = editorHome('e2drag');
    const sb = fixture(path.join(CASES, 'play', 'plan.mzc'), path.join(CASES, 'play', 'probe.txt'), { name: 'plan.mzc', cacheName: 'plan.cache' });
    const shot = path.join(sb.dir, 'drag.bmp');
    const r = edit2Run([sb.file, '--home', home, '--frames', '12', '--shot', shot,
      '--move', '315,300@1', '--down', '315,300@2', '--move', '380,300@3', '--up', '380,300@4',
      '--move', '1120,300@5', '--down', '1120,300@6', '--move', '1060,300@7', '--up', '1060,300@8',
      '--move', '700,508@9', '--down', '700,508@10', '--move', '700,420@11', '--up', '700,420@11']);
    assert(r.code === 0, `終了コード ${r.code}
${r.err}`);
    // 動かした先に境目の線（line）。元の場所はもう線ではない
    assert(bmpPixel(shot, 379, 300) === 0x2c2c2c, `左の欄の境目が動いていません（${bmpPixel(shot, 379, 300).toString(16)}）`);
    assert(bmpPixel(shot, 1060, 200) === 0x2c2c2c, `右の列の境目が動いていません（${bmpPixel(shot, 1060, 200).toString(16)}）`);
    assert(bmpPixel(shot, 315, 300) !== 0x2c2c2c, '左の欄の境目が元の場所に残っています');
  });
  test('edit2/上の帯のワークスペースの札で、中央と右の列の中身が替わる（色・音は「準備中」、出力は書き出しの画面）', () => {
    const { home } = editorHome('e2ws');
    const sb = fixture(path.join(CASES, 'play', 'plan.mzc'), path.join(CASES, 'play', 'probe.txt'), { name: 'plan.mzc', cacheName: 'plan.cache' });
    // 札は上の帯の中央（カット編集 748・色 805・音 844・出力 887、y 20）
    const shotOf = (name, clicks) => {
      const shot = path.join(sb.dir, `${name}.bmp`);
      const r = edit2Run([sb.file, '--home', home, '--frames', '6', '--shot', shot, '--seek', '1', ...clicks]);
      assert(r.code === 0, `${name}: 終了コード ${r.code}
${r.err}`);
      return shot;
    };
    const edit = shotOf('ws-edit', []);
    const color = shotOf('ws-color', ['--click', '805,20@1']);
    const exp = shotOf('ws-export', ['--click', '887,20@1']);
    const back = shotOf('ws-back', ['--click', '805,20@1', '--click', '748,20@3']);
    // 中央（モニターの場所）と右の列は ws_*.um の空の欄（地 bg.1 #1B1B1B、見出し bg.2）。モニターの再生の帯（y 488）はない
    // （色と出力は中身を描くようになったので、groupEdit2Color と出力の群で確かめる）
    for (const [name, f] of []) {
      assert(bmpPixel(f, 700, 300) === 0x1b1b1b, `${name}: 中央の色が ${bmpPixel(f, 700, 300).toString(16)} です`);
      assert(bmpPixel(f, 678, 488) === 0x1b1b1b, `${name}: モニターの再生の帯が残っています（${bmpPixel(f, 678, 488).toString(16)}）`);
    }
    // 出力は書き出しの画面（ws_export.um。中身の試しは tests/ws_export/run.mjs）。モニターの再生の帯はない
    assert(bmpPixel(exp, 678, 488) !== bmpPixel(edit, 678, 488), `出力: モニターの再生の帯が残っています（${bmpPixel(exp, 678, 488).toString(16)}）`);
    // カット編集に戻すとモニターが元の通りに描かれる
    assert(bmpPixel(edit, 678, 488) !== 0x1b1b1b, `カット編集でモニターの再生の帯がありません（${bmpPixel(edit, 678, 488).toString(16)}）`);
    assert(bmpPixel(back, 678, 488) === bmpPixel(edit, 678, 488) && bmpPixel(back, 700, 300) === bmpPixel(edit, 700, 300),
      'カット編集に戻してもモニターが元に戻りません');
    // 左の欄（x 150, y 400）はどのワークスペースでも同じ
    assert(bmpPixel(color, 150, 400) === bmpPixel(edit, 150, 400), '色のワークスペースで左の欄が替わっています');
  });
  test('edit2/起動の誤り（引数が多い 2、読めないプロジェクト 1）', () => {
    const { home } = editorHome('e2bad');
    const a = edit2Run(['a.mzc', 'b.cache', 'c', '--home', home, '--frames', '1']);
    assert(a.code === 2, `引数が多いときの終了コードが ${a.code} です`);
    const b = edit2Run([path.join(home, 'nosuch.mzc'), '--home', home, '--frames', '1']);
    assert(b.code === 1, `ないプロジェクトの終了コードが ${b.code} です`);
  });
  groupEdit2Start();
  groupEdit2Inspector();
  groupEdit2Timeline();
  groupEdit2Monitor();
  groupEdit2Pool();
  groupEdit2Color();
  groupEdit2M6();
  groupEdit2Motion();
}

// スタート画面（src/edit2/start.um）: 引数なしで起動したとき。1440×900 の配置で、最近のプロジェクトのカードは
// y 113〜368 に 3 枚（中央 x 600・930・1258）。左の欄の地は bg.1（#1B1B1B）、編集画面ではそこがレール（bg.2 #222222）。
function e2WriteRecent(home, files) {
  fs.writeFileSync(path.join(home, 'mozcut-recent.txt'), ['# 試し', ...files, ''].join('\r\n'));
}

function groupEdit2Start() {
  test('edit2/スタート画面: 引数なしで最近の一覧を出し、カードをダブルクリックすると同じ窓で開いて一覧の先頭へ移す', () => {
    const { base, home } = editorHome('e2start');
    const sb = fixture(path.join(CASES, 'play', 'plan.mzc'), path.join(CASES, 'play', 'probe.txt'), { name: 'plan.mzc', cacheName: 'plan.cache' });
    const color = path.join(base, 'c.mzc');
    fs.copyFileSync(path.join(CASES, 'play', 'color.mzc'), color);
    e2WriteRecent(home, [color, sb.file]);
    // 開かずに終わる: スタート画面のまま
    const shot0 = path.join(base, 'start.bmp');
    const r0 = edit2Run(['--home', home, '--frames', '3', '--shot', shot0]);
    assert(r0.code === 0, `終了コード ${r0.code}
${r0.err}`);
    assert(screenInfo(shot0).w === 1440 && bmpPixel(shot0, 10, 300) === 0x1b1b1b, `スタート画面の左の欄の色が ${bmpPixel(shot0, 10, 300).toString(16)} です`);
    // 2 枚目（plan.mzc）をダブルクリック → 編集画面（レールの色）、一覧の先頭が plan.mzc
    const shot = path.join(base, 'open.bmp');
    const r = edit2Run(['--home', home, '--click', '930,190@2', '--click', '930,190@3', '--frames', '10', '--shot', shot]);
    assert(r.code === 0, `終了コード ${r.code}
${r.err}`);
    assert(bmpPixel(shot, 10, 300) === 0x222222 && bmpPixel(shot, 700, 2) === 0x222222, `編集画面になっていません（${bmpPixel(shot, 10, 300).toString(16)}）`);
    const rec = recentOf(home);
    assert(rec.length === 2 && samePathJs(rec[0], sb.file) && samePathJs(rec[1], color), `最近の一覧が違います: ${JSON.stringify(rec)}`);
  });
  test('edit2/スタート画面: ない .mzc のカードと Ctrl+O（ファイルの選択はまだない）では開かず、一覧も変えない', () => {
    const { base, home } = editorHome('e2gone');
    const gone = path.join(base, 'gone.mzc');
    e2WriteRecent(home, [gone]);
    const before = fs.readFileSync(path.join(home, 'mozcut-recent.txt'), 'utf8');
    const shot = path.join(base, 'gone.bmp');
    const r = edit2Run(['--home', home, '--click', '600,190@2', '--click', '600,190@3', '--key', 'ctrl+o@5', '--frames', '10', '--shot', shot]);
    assert(r.code === 0, `終了コード ${r.code}
${r.err}`);
    assert(bmpPixel(shot, 10, 300) === 0x1b1b1b, 'スタート画面のままではありません');
    assert(fs.readFileSync(path.join(home, 'mozcut-recent.txt'), 'utf8') === before, '開けなかったのに最近の一覧が書き換わりました');
  });
  test('edit2/スタート画面: ［作成する］（Enter）で、今いるフォルダに <名前>.mzc を書いて開く。同じ名前があれば上書きしない', () => {
    const { base, home } = editorHome('e2new');
    const where = path.join(base, 'work');
    fs.mkdirSync(where);
    const r = edit2Run(['--home', home, '--key', 'ctrl+a@2', '--text', '新作@3', '--key', 'enter@4', '--frames', '8'], { cwd: where });
    assert(r.code === 0, `終了コード ${r.code}
${r.err}`);
    const file = path.join(where, '新作.mzc');
    assert(fs.existsSync(file), `${file} がありません（${fs.readdirSync(where).join(', ')}）`);
    const text = fs.readFileSync(file, 'utf8');
    assert(/^project size=1920x1080 fps=30 rate=48000/m.test(text), `新しいプロジェクトの中身が違います:
${text}`);
    const rec = recentOf(home);
    assert(rec && rec.length === 1 && path.isAbsolute(rec[0]) && samePathJs(rec[0], file), `最近の一覧が違います: ${JSON.stringify(rec)}`);
    // もう一度同じ名前で作ろうとしても、上書きしない（スタート画面のまま）
    fs.writeFileSync(file, '# 前からある\n' + text);
    const shot = path.join(base, 'dup.bmp');
    const r2 = edit2Run(['--home', home, '--key', 'ctrl+a@2', '--text', '新作@3', '--key', 'enter@4', '--frames', '8', '--shot', shot], { cwd: where });
    assert(r2.code === 0, `終了コード ${r2.code}
${r2.err}`);
    assert(fs.readFileSync(file, 'utf8').startsWith('# 前からある'), '同じ名前のプロジェクトを上書きしました');
    assert(bmpPixel(shot, 10, 300) === 0x1b1b1b, 'スタート画面のままではありません');
  });
  test('edit2/相対パスで開いても、最近の一覧には絶対パスで入る', () => {
    const { base, home } = editorHome('e2rel');
    const proj = path.join(base, 'proj');
    fs.mkdirSync(proj);
    fs.copyFileSync(path.join(CASES, 'play', 'color.mzc'), path.join(proj, 'c.mzc'));
    const r = edit2Run(['c.mzc', '--home', home, '--frames', '2'], { cwd: proj });
    assert(r.code === 0, `終了コード ${r.code}
${r.err}`);
    const rec = recentOf(home);
    assert(rec && rec.length === 1 && path.isAbsolute(rec[0]) && samePathJs(rec[0], path.join(proj, 'c.mzc')),
      `最近の一覧に '${rec && rec[0]}' が入りました`);
  });
}

// M6 の見本（demo/m6/*.mzc。キーフレーム・シェイプ・パーティクル・3D・式など）を新しい編集画面で開き、
// 1 秒に送ってタイムラインの上の 2 つの行のクリップを選んでも落ちないこと。素材（demo/media）は要らない
// （見本だけを一時フォルダに写して開く）。座標は 1440×900 の配置（V4 の行が y 590、V3 が y 630）。
function groupEdit2M6() {
  const dir = path.join(ROOT, 'demo', 'm6');
  if (!fs.existsSync(dir)) {
    return;
  }
  for (const name of fs.readdirSync(dir).filter((n) => n.endsWith('.mzc')).sort()) {
    test(`edit2/M6 の見本 ${name} を開いてクリップを選んでも落ちない`, () => {
      const { base, home } = editorHome(`m6-${name}`);
      const file = path.join(base, name);
      fs.copyFileSync(path.join(dir, name), file);
      for (const y of [590, 630]) {
        const shot = path.join(base, `${y}.bmp`);
        const r = edit2Run([file, '--home', home, '--frames', '5', '--seek', '1', '--click', `400,${y}@2`, '--shot', shot]);
        assert(r.code === 0, `y=${y} で終了コード ${r.code}
${r.err}`);
        const s = screenInfo(shot);
        assert(s.w === 1440 && s.h === 900 && s.colors > 8, `y=${y} の画面の画像がおかしい: ${JSON.stringify(s)}`);
      }
    });
  }
}

// BMP の四角（x, y, w, h）の中の、明るい（3 色の平均が 150 を超える）画素の数。文字が描かれたかを見る。
function bmpBright(file, x, y, w, h) {
  const b = fs.readFileSync(file);
  const bw = b.readInt32LE(18);
  let n = 0;
  for (let yy = y; yy < y + h; yy++) {
    for (let xx = x; xx < x + w; xx++) {
      const c = b.readUInt32LE(54 + (yy * bw + xx) * 4);
      if (((c >> 16 & 255) + (c >> 8 & 255) + (c & 255)) / 3 > 150) n++;
    }
  }
  return n;
}

// M6 の操作の画面の配線（src/edit2/wire_motion.um）と、図形のクリップの見え方。1440×900 の配置。
function groupEdit2Motion() {
  const open = (tag, src, args) => {
    const { base, home } = editorHome(tag);
    const file = path.join(base, path.basename(src));
    fs.copyFileSync(src, file);
    const shot = path.join(base, `${tag}.bmp`);
    const r = edit2Run([file, '--home', home, '--shot', shot, ...args]);
    assert(r.code === 0, `終了コード ${r.code}
${r.err}`);
    return { file, shot, err: r.err, text: () => fs.readFileSync(file, 'utf8') };
  };
  test('edit2/ID のない図形を選ぶと、インスペクタの名前とタイムラインの見出しに種類の名前が出る（2 つ選んでも落ちない）', () => {
    const one = open('shape-name', path.join(CASES, 'edit2', 'shape.mzc'), ['--frames', '4', '--seek', '1', '--select', '@3']);
    // インスペクタの名前（「星」）と、タイムラインの V3 の見出し（「図形」）
    assert(bmpBright(one.shot, 1150, 86, 120, 16) > 10, 'インスペクタの名前が空です');
    assert(bmpBright(one.shot, 180, 580, 60, 14) > 10, 'タイムラインの見出しが空です');
    open('shape-multi', path.join(CASES, 'edit2', 'shape.mzc'), ['--frames', '4', '--seek', '1', '--select', '@3,r1']);
  });
  // tests/cases/edit2/motion.mzc（demo/m6/ws_motion.mzc と同じ）。タイムラインは 0 秒が x=176、1 秒が 302 px、box（V1）の行が y=756。
  const motion = path.join(CASES, 'edit2', 'motion.mzc');
  const lineOf = (text, id) => text.split(/\r?\n/).find((l) => l.includes(` id=${id} `)) ?? '';
  test('edit2/タイムラインのクリップの上のキーフレームの印を左右にドラッグすると key move で時刻を動かす（Esc でやめる）', () => {
    const a = open('kf-move', motion, ['--frames', '8', '--seek', '1', '--down', '780,756@2', '--move', '850,756@3', '--move', '1082,756@4', '--up', '1082,756@5']);
    assert(lineOf(a.text(), 'box').includes('x="80@0 520@3:ease 900@4"'), `box の行が ${lineOf(a.text(), 'box')} です`);
    const b = open('kf-esc', motion, ['--frames', '8', '--seek', '1', '--down', '780,756@2', '--move', '1082,756@3', '--key', 'escape@4', '--up', '1082,756@5']);
    assert(lineOf(b.text(), 'box').includes('x="80@0 520@2:ease 900@4"'), `Esc の後の box の行が ${lineOf(b.text(), 'box')} です`);
  });
  test('edit2/キーフレームの印を押すとそのキーへ再生ヘッドが動き、Delete はクリップではなくキーを消す', () => {
    const a = open('kf-del', motion, ['--frames', '8', '--seek', '1', '--down', '780,756@2', '--up', '780,756@3', '--key', 'delete@5']);
    assert(lineOf(a.text(), 'box').startsWith('color 3c78ff id=box ') && lineOf(a.text(), 'box').includes('x="80@0 900@4"'),
      `box の行が ${lineOf(a.text(), 'box')} です`);
    // 再生ヘッドの縦の線（playhead の赤）が 2 秒（x=780）にある
    const c = bmpPixel(a.shot, 780, 820);
    assert((c >> 16 & 255) > 180 && (c >> 8 & 255) < 120, `2 秒の所の色が ${c.toString(16)} です（再生ヘッドが動いていない）`);
  });
  // モニター（1440×900）: 絵の四角は x 387〜1047、y 84〜455（1280×720 を約 0.516 倍）。
  test('edit2/モニターの変形のギズモ: 星の枠の中をドラッグで pos、角の四角で大きさのキー（キーフレームのある scale は再生ヘッドに key add）', () => {
    const a = open('giz-move', motion, ['--frames', '8', '--seek', '1', '--select', 'star', '--down', '882,212@2', '--move', '900,212@3', '--move', '932,212@4', '--up', '932,212@5']);
    assert(/ pos=1056\.8,250 /.test(lineOf(a.text(), 'star')), `動かした後の star の行が ${lineOf(a.text(), 'star')} です`);
    const b = open('giz-scale', motion, ['--frames', '8', '--seek', '1', '--select', 'star', '--down', '896,149@2', '--move', '900,140@3', '--move', '920,120@4', '--up', '920,120@5']);
    assert(/ scale="0\.6@0:easeout 1\.\d+@1 1@2" /.test(lineOf(b.text(), 'star')) && / pos=960,250 /.test(lineOf(b.text(), 'star')),
      `大きさを変えた後の star の行が ${lineOf(b.text(), 'star')} です`);
  });
  test('edit2/モニターの点の編集: パスの頂点をドラッグすると d を書き換える', () => {
    const a = open('pts-path', motion, ['--frames', '8', '--seek', '1', '--select', 'wave', '--down', '614,161@2', '--move', '614,180@3', '--move', '614,200@4', '--up', '614,200@5']);
    assert(lineOf(a.text(), 'wave').includes('d="M 0 0 C 60 -90 140 165.52 200 75.52 L 320 -40"'), `wave の行が ${lineOf(a.text(), 'wave')} です`);
  });
  test('edit2/モニターでほかのクリップを押すとそれを選び、そのままギズモで動かせる（x のキーフレームは再生ヘッドに key add）', () => {
    const a = open('mon-pick', motion, ['--frames', '12', '--seek', '1', '--select', 'star', '--down', '621,350@2', '--up', '621,350@3',
      '--down', '621,350@5', '--move', '640,350@6', '--move', '671,350@7', '--up', '671,350@8']);
    assert(lineOf(a.text(), 'box').includes('x="80@0 451@1 520@2:ease 900@4"'), `box の行が ${lineOf(a.text(), 'box')} です`);
    assert(/ pos=960,250 /.test(lineOf(a.text(), 'star')), `star の行が変わりました: ${lineOf(a.text(), 'star')}`);
  });
  // インスペクタ（1440×900、box を選んだとき）: 位置の行の ◀ ◆ ▶ が x 1357 / 1377 / 1396・y 291、不透明度の行が y 348
  test('edit2/インスペクタの ◆ で再生ヘッドにキーを打つ・消す、Alt+◆ でキーフレームをやめる、▶ で次のキーへ', () => {
    const add = open('ins-kf-add', motion, ['--frames', '6', '--seek', '1', '--select', 'box', '--click', '1377,291@3']);
    assert(lineOf(add.text(), 'box').includes('x="80@0 355@1 520@2:ease 900@4" y="420@0 420@1"'), `◆ で打った後の box の行が ${lineOf(add.text(), 'box')} です`);
    const rm = open('ins-kf-rm', motion, ['--frames', '6', '--seek', '1', '--select', 'box', '--click', '1377,348@3']);
    assert(/ opacity="?0\.3@0"?$/.test(lineOf(rm.text(), 'box')), `◆ で消した後の box の行が ${lineOf(rm.text(), 'box')} です`);
    const clr = open('ins-kf-clear', motion, ['--frames', '6', '--seek', '1', '--select', 'box', '--mods', 'a@2', '--click', '1377,348@3']);
    assert(/ opacity=1$/.test(lineOf(clr.text(), 'box')), `Alt+◆ の後の box の行が ${lineOf(clr.text(), 'box')} です`);
    const next = open('ins-kf-next', motion, ['--frames', '8', '--seek', '1', '--select', 'box', '--click', '1396,291@3', '--click', '1377,291@6']);
    assert(lineOf(next.text(), 'box').includes('x="80@0 900@4" y=420 '), `▶ で 2 秒へ動いて ◆ で消した後の box の行が ${lineOf(next.text(), 'box')} です`);
  });
  test('edit2/インスペクタでキーフレームのある値を打ち込むと、set ではなく再生ヘッドの時刻に key add する', () => {
    const a = open('ins-kf-set', motion, ['--frames', '10', '--seek', '1', '--select', 'box', '--click', '1300,348@3', '--key', 'ctrl+a@4', '--text', '50@5', '--key', 'enter@6']);
    assert(lineOf(a.text(), 'box').endsWith(' opacity="0.3@0 0.5@1"'), `box の行が ${lineOf(a.text(), 'box')} です`);
  });
  // グラフエディタ: 札はルーラーの左の隅（144, 557）。開くとトラックの所に重なり、x のグラフの 2 秒のキーが (720, 741)、
  // ［停止］が (332, 612)、［opacity］の札が (172, 585)、［閉じる］が (1365, 585)
  const graph = ['--down', '144,557@2', '--up', '144,557@3'];
  test('edit2/グラフエディタの札で開き、キーを選んで［停止］で key ease、上下のドラッグで値を変える', () => {
    const a = open('graph-ease', motion, ['--frames', '12', '--seek', '1', '--select', 'box', ...graph, '--down', '720,741@5', '--up', '720,741@6', '--down', '332,612@8', '--up', '332,612@9']);
    assert(/ x="80@0 520@2:[a-z:]*hold 900@4" /.test(lineOf(a.text(), 'box')), `［停止］の後の box の行が ${lineOf(a.text(), 'box')} です`);
    const b = open('graph-drag', motion, ['--frames', '12', '--seek', '1', '--select', 'box', ...graph, '--down', '720,741@5', '--move', '720,720@6', '--move', '720,700@7', '--up', '720,700@8']);
    const m = / x="80@0 ([\d.]+)@2:ease 900@4" /.exec(lineOf(b.text(), 'box'));
    assert(m && Number(m[1]) > 600, `上へドラッグした後の box の行が ${lineOf(b.text(), 'box')} です`);
  });
  test('edit2/グラフエディタの［閉じる］で閉じると、タイムラインの印がまた使える', () => {
    const a = open('graph-close', motion, ['--frames', '14', '--seek', '1', '--select', 'box', ...graph, '--down', '1365,585@5', '--up', '1365,585@6',
      '--down', '780,756@8', '--up', '780,756@9', '--key', 'delete@11']);
    assert(lineOf(a.text(), 'box').includes('x="80@0 900@4"'), `box の行が ${lineOf(a.text(), 'box')} です`);
  });
}

// インスペクタの配線（src/edit2/wire_inspector.um）。tests/cases/edit2/ins.mzc を開き、右の列（x 1120〜1440）を
// マウスとキーの入力（--click / --key / --text）で操作して、.mzc の書き換わり方を確かめる。座標は 1440×1600 の配置。
function groupEdit2Inspector() {
  const src = path.join(CASES, 'edit2', 'ins.mzc');
  const lineOf = (file, id) => fs.readFileSync(file, 'utf8').split(/\r?\n/).find((l) => l.includes(` id=${id}`)) ?? '';
  const open = (tag, args) => {
    const { home } = editorHome(tag);
    const sb = fixture(src, path.join(CASES, 'play', 'probe.txt'), { name: 'ins.mzc', cacheName: 'ins.cache' });
    const shot = path.join(sb.dir, `${tag}.bmp`);
    const r = edit2Run([sb.file, '--home', home, '--size', '1440x1600', '--shot', shot, ...args]);
    assert(r.code === 0, `終了コード ${r.code}\n${r.err}`);
    return { file: sb.file, shot };
  };
  // 不透明度の値の欄（y）を押し、全部を選んで打ち込み、Enter で確定する（f フレーム目から 4 フレーム）
  const typeAt = (y, text, f) => ['--click', `1300,${y}@${f}`, '--key', `ctrl+a@${f + 1}`, '--text', `${text}@${f + 2}`, '--key', `enter@${f + 3}`];
  test('edit2/インスペクタの値の欄に打ち込むと set で .mzc を書き換える', () => {
    const { file } = open('ins-set', ['--select', 'v', '--frames', '10', ...typeAt(405, '55', 3)]);
    assert(/ opacity=0\.55\b/.test(lineOf(file, 'v')), `v の行が ${lineOf(file, 'v')} です`);
    assert(lineOf(file, 'c').endsWith('opacity=0.5'), `選んでいない c の行が変わりました: ${lineOf(file, 'c')}`);
  });
  test('edit2/インスペクタで効果を無効にすると行から消え、有効に戻すと元の順で書き戻す', () => {
    const off = open('ins-fxoff', ['--select', 'v', '--frames', '8', '--click', '1158,524@3']);
    assert(lineOf(off.file, 'v').endsWith('sat=1.4 vignette=0.4'), `無効にした後の v の行が ${lineOf(off.file, 'v')} です`);
    const on = open('ins-fxon', ['--select', 'v', '--frames', '14', '--click', '1158,524@3', '--click', '1158,524@9']);
    assert(lineOf(on.file, 'v').endsWith('sat=1.4 contrast=1.1 vignette=0.4'), `有効に戻した後の v の行が ${lineOf(on.file, 'v')} です`);
  });
  test('edit2/インスペクタで複数のクリップの（混在）の値を変えると、どちらの行にも書く', () => {
    const { file } = open('ins-multi', ['--select', 'v,c', '--frames', '10', ...typeAt(259, '30', 3)]);
    assert(/ opacity=0\.3\b/.test(lineOf(file, 'v')), `v の行が ${lineOf(file, 'v')} です`);
    assert(/ opacity=0\.3\b/.test(lineOf(file, 'c')) && !/opacity=0\.5/.test(lineOf(file, 'c')), `c の行が ${lineOf(file, 'c')} です`);
  });
  test('edit2/履歴のタブの［取り消す］で、インスペクタの変更を 1 つずつ戻す', () => {
    const { file } = open('ins-hist', ['--select', 'v', '--frames', '22', ...typeAt(405, '55', 3), ...typeAt(405, '40', 8),
      '--click', '1225,56@14', '--click', '1180,94@17']);
    assert(/ opacity=0\.55\b/.test(lineOf(file, 'v')), `1 つ戻した後の v の行が ${lineOf(file, 'v')} です`);
  });
  test('edit2/何も選んでいないとき、インスペクタで project の行の値を書き換える', () => {
    const { file } = open('ins-proj', ['--frames', '10', ...typeAt(259, '303030', 3)]);
    const p = fs.readFileSync(file, 'utf8').split(/\r?\n/).find((l) => l.startsWith('project ')) ?? '';
    assert(p === 'project size=64x36 fps=30 bg=303030', `project の行が ${p} です`);
  });
}

// タイムラインの配線（src/edit2/wire_timeline.um）。tests/cases/edit2/tl.mzc を 1440×900 で開き、タイムラインを
// マウスとキーの入力（--click / --down / --move / --up / --key / --mods）で操作して、.mzc の書き換わり方を確かめる。
// 座標: 0 秒が x=177、1 秒が約 201 px。V2（文字 t）の行が y=590、V1（a・b・c）の行が y=637、ルーラーが y=556。
function groupEdit2Timeline() {
  const src = path.join(CASES, 'edit2', 'tl.mzc');
  const lineOf = (file, id) => fs.readFileSync(file, 'utf8').split(/\r?\n/).find((l) => l.includes(` id=${id} `) || l.endsWith(` id=${id}`)) ?? '';
  const open = (tag, args) => {
    const { home } = editorHome(tag);
    const sb = fixture(src, path.join(CASES, 'play', 'probe.txt'), { name: 'tl.mzc', cacheName: 'tl.cache' });
    const shot = path.join(sb.dir, `${tag}.bmp`);
    const r = edit2Run([sb.file, '--home', home, '--shot', shot, ...args]);
    assert(r.code === 0, `終了コード ${r.code}\n${r.err}`);
    return { file: sb.file, shot, text: fs.readFileSync(sb.file, 'utf8') };
  };
  // t（1〜3 秒）をつかんで 1 秒（201 px）右へ動かす（f フレーム目から 4 フレーム）
  const dragT = (f) => ['--down', `500,590@${f}`, '--move', `550,590@${f + 1}`, '--move', `701,590@${f + 2}`, '--up', `701,590@${f + 3}`];
  test('edit2/タイムラインで選んで S を押すと、再生ヘッドの所で分ける', () => {
    const { file } = open('tl-split', ['--frames', '8', '--seek', '3', '--click', '700,637@2', '--key', 's@4']);
    assert(lineOf(file, 'b') === 'color 402020 id=b dur=1', `b の行が ${lineOf(file, 'b')} です`);
    assert(/^color 402020 id=b_2 dur=1 /.test(lineOf(file, 'b_2')), `後半の行が ${lineOf(file, 'b_2')} です`);
  });
  test('edit2/タイムラインの Delete は隙間を残し、Shift+Delete は後ろを詰める', () => {
    const lift = open('tl-lift', ['--frames', '8', '--click', '700,637@2', '--key', 'delete@4']);
    assert(lift.text.includes('\n# color 402020 id=b dur=2\n'), `Delete の後の b が注釈になっていません:\n${lift.text}`);
    assert(/^color 204020 id=c dur=2 at=4(\.0*)?$/.test(lineOf(lift.file, 'c')), `Delete の後の c の行が ${lineOf(lift.file, 'c')} です（4 秒に残るはず）`);
    const rip = open('tl-ripple', ['--frames', '8', '--click', '700,637@2', '--key', 'shift+delete@4']);
    assert(rip.text.includes('\n# color 402020 id=b dur=2\n'), `Shift+Delete の後の b が注釈になっていません:\n${rip.text}`);
    assert(lineOf(rip.file, 'c') === 'color 204020 id=c dur=2', `Shift+Delete の後の c の行が ${lineOf(rip.file, 'c')} です（詰めて 2 秒から）`);
  });
  test('edit2/タイムラインで Ctrl+クリックで 2 つ選び、Delete で両方を消す', () => {
    const { file, text } = open('tl-multi', ['--frames', '10', '--click', '280,637@2', '--mods', 'c@3', '--click', '1100,637@4', '--mods', '-@5', '--key', 'delete@7']);
    assert(text.includes('\n# color 202040 id=a dur=2\n') && text.includes('\n# color 204020 id=c dur=2\n'), `a と c が注釈になっていません:\n${text}`);
    assert(/^color 402020 id=b dur=2 at=2(\.0*)?$/.test(lineOf(file, 'b')), `残した b の行が ${lineOf(file, 'b')} です`);
  });
  test('edit2/タイムラインのクリップをドラッグで動かし、Ctrl+Z で戻し、Ctrl+Shift+Z でやり直す', () => {
    const moved = open('tl-move', ['--frames', '10', ...dragT(2)]);
    assert(lineOf(moved.file, 't') === 'text "T" id=t track=1 at=2 dur=2', `動かした t の行が ${lineOf(moved.file, 't')} です`);
    const undone = open('tl-undo', ['--frames', '14', ...dragT(2), '--key', 'ctrl+z@8']);
    assert(undone.text === fs.readFileSync(src, 'utf8'), `取り消した後のファイルが元と違います:\n${undone.text}`);
    const redone = open('tl-redo', ['--frames', '16', ...dragT(2), '--key', 'ctrl+z@8', '--key', 'ctrl+shift+z@11']);
    assert(lineOf(redone.file, 't') === 'text "T" id=t track=1 at=2 dur=2', `やり直した後の t の行が ${lineOf(redone.file, 't')} です`);
  });
  test('edit2/タイムラインでクリップの終わりの端を引くとトリムし、刃のツール（B）で押すと分ける', () => {
    const trim = open('tl-trim', ['--frames', '10', '--down', '777,590@2', '--move', '740,590@3', '--move', '677,590@4', '--up', '677,590@5']);
    assert(lineOf(trim.file, 't') === 'text "T" id=t track=1 at=1 dur=1.5', `トリムした t の行が ${lineOf(trim.file, 't')} です`);
    const blade = open('tl-blade', ['--frames', '10', '--key', 'b@2', '--click', '700,637@4']);
    assert(lineOf(blade.file, 'b') === 'color 402020 id=b dur=0.6', `刃で分けた b の行が ${lineOf(blade.file, 'b')} です`);
  });
  test('edit2/タイムラインで動かしても、xfade= で前と重ねた行に at= を書き足さない', () => {
    const { home } = editorHome('tl-xfade');
    const sb = fixture(path.join(CASES, 'edit2', 'xfade.mzc'), path.join(CASES, 'play', 'probe.txt'), { name: 'xfade.mzc', cacheName: 'xfade.cache' });
    const r = edit2Run([sb.file, '--home', home, '--frames', '10', ...dragT(2)]);
    assert(r.code === 0, `終了コード ${r.code}
${r.err}`);
    assert(lineOf(sb.file, 't') === 'text "T" id=t track=1 at=2 dur=2', `動かした t の行が ${lineOf(sb.file, 't')} です`);
    assert(lineOf(sb.file, 'b') === 'color 402020 id=b dur=3 xfade=1', `動かしていない b の行が ${lineOf(sb.file, 'b')} です`);
    assert(lineOf(sb.file, 'c') === 'color 204020 id=c dur=2', `動かしていない c の行が ${lineOf(sb.file, 'c')} です`);
  });
  test('edit2/一連の操作（選ぶ → 動かす → トリム → 分割 → 値の変更 → 取り消し → 保存）で .mzc が順に書き換わる', () => {
    // t を 1 秒右へ動かし（at=2）、終わりの端を 0.5 秒縮め（dur=1.5）、b を選んで 3 秒で分け、インスペクタの
    // 不透明度に 50 を打つ。値の変更だけを Ctrl+Z で戻し、Ctrl+S で書く
    const steps = ['--seek', '3', ...dragT(2), '--down', '979,590@7', '--move', '930,590@8', '--move', '878,590@9', '--up', '878,590@10',
      '--click', '700,637@12', '--key', 's@14', '--click', '1300,376@16', '--key', 'ctrl+a@17', '--text', '50@18', '--key', 'enter@19'];
    const set = open('tl-seq-set', ['--frames', '22', ...steps]);
    assert(lineOf(set.file, 't') === 'text "T" id=t track=1 at=2 dur=1.5', `t の行が ${lineOf(set.file, 't')} です`);
    assert(lineOf(set.file, 'b') === 'color 402020 id=b dur=1 opacity=0.5', `値を変えた後の b の行が ${lineOf(set.file, 'b')} です`);
    assert(lineOf(set.file, 'b_2') === 'color 402020 id=b_2 dur=1 at=b.end', `分けた後半の行が ${lineOf(set.file, 'b_2')} です`);
    const done = open('tl-seq-save', ['--frames', '28', ...steps, '--key', 'ctrl+z@22', '--key', 'ctrl+s@24']);
    const want = fs.readFileSync(src, 'utf8').replace('color 402020 id=b dur=2\n', 'color 402020 id=b dur=1\ncolor 402020 id=b_2 dur=1 at=b.end\n')
      .replace('text "T" id=t track=1 at=1 dur=2', 'text "T" id=t track=1 at=2 dur=1.5');
    assert(done.text === want, `取り消して保存した後のファイルが違います:\n${done.text}`);
  });
  test('edit2/ルーラーをドラッグすると再生ヘッドがそこへ動く（再生の時計に伝わる）', () => {
    const { shot, text } = open('tl-scrub', ['--frames', '10', '--down', '300,556@2', '--move', '500,556@3', '--move', '579,556@4', '--up', '579,556@5']);
    // 2 秒（x=579）に再生ヘッドの赤い線。0 秒の所にはもうない
    assert(bmpPixel(shot, 579, 700) === 0xff4d4d, `2 秒の所の色が ${bmpPixel(shot, 579, 700).toString(16)} です（再生ヘッドがない）`);
    assert(bmpPixel(shot, 177, 700) !== 0xff4d4d, '0 秒の所に再生ヘッドが残っています');
    assert(text === fs.readFileSync(src, 'utf8'), '再生ヘッドを動かしただけでファイルが変わりました');
  });
}

// モニターと再生の配線（src/edit2/wire_monitor.um）。tests/cases/play/plan.mzc（30p、2 秒 = 60 コマ）を開き、
// キーの入力（--key）で動かして、終わるときの統計（--stats の playback: / monitor: の JSON）で位置と状態を確かめる。
function groupEdit2Monitor() {
  const open = (tag, args) => {
    const { home } = editorHome(tag);
    const sb = fixture(path.join(CASES, 'play', 'plan.mzc'), path.join(CASES, 'play', 'probe.txt'), { name: 'plan.mzc', cacheName: 'plan.cache' });
    const shot = path.join(sb.dir, `${tag}.bmp`);
    const r = edit2Run([sb.file, '--home', home, '--shot', shot, '--stats', ...args]);
    assert(r.code === 0, `終了コード ${r.code}\n${r.err}`);
    const json = (label) => {
      const line = (r.err.split(/\r?\n/).find((l) => l.startsWith(`${label}: {`)) || '').slice(label.length + 2);
      assert(line, `--stats の ${label}: の行が標準エラーにありません\n${r.err}`);
      return parseJson(line, `--stats の ${label}`);
    };
    return { pb: json('playback'), mon: json('monitor'), shot };
  };
  test('edit2/モニター: → と Shift+→ でコマ送り、← で戻る、Home / End で先頭と最後のコマ', () => {
    const a = open('mon-step', ['--seek', '1', '--frames', '6', '--key', 'right@1', '--key', 'right@2', '--key', 'shift+right@3', '--key', 'left@4']);
    assert(a.pb.frame === 41 && a.pb.state === 'stopped', `1 秒から → → Shift+→ ← のあとが ${a.pb.frame} コマ目（${a.pb.state}）です（41 のはず）`);
    const b = open('mon-end', ['--seek', '1', '--frames', '3', '--key', 'end@1']);
    assert(b.pb.frame === 59, `End のあとが ${b.pb.frame} コマ目です（最後の 59 のはず）`);
    const c = open('mon-home', ['--seek', '1', '--frames', '3', '--key', 'home@1']);
    assert(c.pb.frame === 0, `Home のあとが ${c.pb.frame} コマ目です`);
  });
  test('edit2/モニター: Space で再生、J J で逆 2 倍、K で止まる', () => {
    const a = open('mon-play', ['--seek', '0', '--frames', '6', '--key', 'space@1']);
    assert(a.pb.state === 'playing' && a.pb.speed === 1, `Space のあとが ${a.pb.state} ×${a.pb.speed} です`);
    const b = open('mon-jj', ['--seek', '1.5', '--frames', '6', '--key', 'j@1', '--key', 'j@2']);
    assert(b.pb.state === 'playing' && b.pb.speed === -2, `J J のあとが ${b.pb.state} ×${b.pb.speed} です（逆 2 倍のはず）`);
    const c = open('mon-jjk', ['--seek', '1.5', '--frames', '6', '--key', 'j@1', '--key', 'j@2', '--key', 'k@3']);
    assert(c.pb.state === 'stopped', `J J K のあとが ${c.pb.state} です`);
    assert(c.mon.renderN >= 1 && c.mon.frameN >= 1, `再生中の描画の時間を測っていません: ${JSON.stringify(c.mon)}`);
  });
  test('edit2/モニター: I と O でイン・アウトを打ち、Alt+I で消す', () => {
    const a = open('mon-io', ['--seek', '1', '--frames', '7', '--key', 'i@1', '--key', 'right@2', '--key', 'right@3', '--key', 'o@5']);
    assert(a.mon.inF === 30 && a.mon.outF === 32, `イン・アウトが ${a.mon.inF}〜${a.mon.outF} です（30〜32 のはず）`);
    const b = open('mon-io-clear', ['--seek', '1', '--frames', '5', '--key', 'i@1', '--key', 'alt+i@3']);
    assert(b.mon.inF === -1, `Alt+I のあとのインが ${b.mon.inF} です`);
  });
  test('edit2/モニター: F11 でモニターだけを窓いっぱいに出し、Esc で戻る', () => {
    const a = open('mon-full', ['--seek', '1', '--frames', '4', '--key', 'f11@1']);
    assert(a.mon.full === true, 'F11 のあと全画面になっていません');
    // ふだんはレール（bg.2 = #222222）の所が、全画面ではモニターの絵のまわり（bg.viewer）になる
    assert(bmpPixel(a.shot, 30, 300) !== 0x222222, `全画面でもレールが描かれています（${bmpPixel(a.shot, 30, 300).toString(16)}）`);
    const b = open('mon-full-esc', ['--seek', '1', '--frames', '5', '--key', 'f11@1', '--key', 'esc@3']);
    assert(b.mon.full === false, 'Esc で全画面から戻りません');
  });
}

// 色のワークスペース（src/edit2/ws_color.um。中身は src/ws_color/ の wscWorkspace）。
// plan.mzc（映像 1 つ）を 1440×900 で開き、札「色」（805,20）を押して、色のパネルのリフトのスライダー（1178,438）を動かす。
function groupEdit2Color() {
  // 中央のモニターの絵の何か所か（絵は中央の上の方に、幅いっぱいに出る）
  const picSamples = (f) => [[560, 120], [640, 170], [718, 170], [800, 200], [880, 230]].map(([x, y]) => bmpPixel(f, x, y));
  test('edit2/色: 中央にモニターとスコープ、右の列に色のパネルを描き、ドラッグの途中はファイルを書かずにプレビューだけ変える', () => {
    const { home } = editorHome('e2col');
    const sb = fixture(path.join(CASES, 'play', 'plan.mzc'), path.join(CASES, 'play', 'probe.txt'), { name: 'plan.mzc', cacheName: 'plan.cache' });
    const before = fs.readFileSync(sb.file);
    const shotOf = (name, extra) => {
      const shot = path.join(sb.dir, `${name}.bmp`);
      const r = edit2Run([sb.file, '--home', home, '--frames', '10', '--shot', shot, '--seek', '1', '--click', '805,20@1', ...extra]);
      assert(r.code === 0, `${name}: 終了コード ${r.code}
${r.err}`);
      return shot;
    };
    const still = shotOf('col-still', []);
    // 押したまま右へ動かし、離さずに終える
    const drag = shotOf('col-drag', ['--down', '1178,438@3', '--move', '1195,438@4', '--move', '1215,438@5']);
    assert(Buffer.compare(fs.readFileSync(sb.file), before) === 0, 'ドラッグの途中で .mzc が書き換わりました');
    // 「準備中」の空の欄（bg.1 #1B1B1B）ではなく、モニターの絵が出ている
    const a = picSamples(still);
    assert(a.some((p) => p !== 0x1b1b1b), `中央にモニターの絵がありません（${a.map((p) => p.toString(16)).join(' ')}）`);
    const b = picSamples(drag);
    assert(a.some((p, i) => p !== b[i]), `リフトを動かしてもプレビューが変わりません（${a.map((p) => p.toString(16)).join(' ')}）`);
    // タイムライン（x 700, y 700）と左の欄はカット編集と同じ場所に残る
    const edit = path.join(sb.dir, 'col-edit.bmp');
    const r = edit2Run([sb.file, '--home', home, '--frames', '4', '--shot', edit, '--seek', '1']);
    assert(r.code === 0, `カット編集: 終了コード ${r.code}
${r.err}`);
    assert(bmpPixel(still, 700, 700) === bmpPixel(edit, 700, 700), 'タイムラインがカット編集と違います');
    assert(bmpPixel(still, 150, 400) === bmpPixel(edit, 150, 400), '左の欄がカット編集と違います');
  });
  test('edit2/色: スライダーを離すと grade.* を 1 つの操作で書き、Ctrl+Z で元に戻る', () => {
    const { home } = editorHome('e2col2');
    const sb = fixture(path.join(CASES, 'play', 'plan.mzc'), path.join(CASES, 'play', 'probe.txt'), { name: 'plan.mzc', cacheName: 'plan.cache' });
    const before = fs.readFileSync(sb.file, 'utf8');
    const drag = ['--click', '805,20@1', '--down', '1178,438@3', '--move', '1195,438@4', '--move', '1215,438@5', '--up', '1215,438@6'];
    const r = edit2Run([sb.file, '--home', home, '--frames', '9', '--seek', '1', ...drag]);
    assert(r.code === 0, `終了コード ${r.code}
${r.err}`);
    const after = fs.readFileSync(sb.file, 'utf8');
    assert(/^video .* grade\.lift="0 0 0 0\.\d+"/m.test(after), `リフトが書かれていません:
${after}`);
    assert(after.split('\n').length === before.split('\n').length, `行の数が変わりました:
${after}`);
    fs.writeFileSync(sb.file, before);
    const u = edit2Run([sb.file, '--home', home, '--frames', '11', '--seek', '1', ...drag, '--key', 'ctrl+z@8']);
    assert(u.code === 0, `取り消し: 終了コード ${u.code}
${u.err}`);
    assert(fs.readFileSync(sb.file, 'utf8') === before, `Ctrl+Z で元に戻りません:
${fs.readFileSync(sb.file, 'utf8')}`);
  });
}

// 素材の欄・コマンドパレット・保存の配線（src/edit2/wire_pool.um・wp_palette.um・wp_state.um）。
// tests/cases/edit2/pool.mzc を開き、キー（--key / --text）とマウスで動かして、.mzc の中身・統計・画面の画素で確かめる。
function groupEdit2Pool() {
  const src = path.join(CASES, 'edit2', 'pool.mzc');
  const lineOf = (file, id) => fs.readFileSync(file, 'utf8').split(/\r?\n/).find((l) => l.includes(` id=${id} `) || l.endsWith(` id=${id}`)) ?? '';
  const open = (tag, args, before) => {
    const { home } = editorHome(tag);
    const sb = fixture(src, path.join(CASES, 'play', 'probe.txt'), { name: 'pool.mzc', cacheName: 'pool.cache' });
    if (before) before(sb.file);
    const shot = path.join(sb.dir, `${tag}.bmp`);
    const r = edit2Run([sb.file, '--home', home, '--shot', shot, ...args]);
    assert(r.code === 0, `終了コード ${r.code}\n${r.err}`);
    const stats = (label) => {
      const line = (r.err.split(/\r?\n/).find((l) => l.startsWith(`${label}: {`)) || '').slice(label.length + 2);
      assert(line, `--stats の ${label}: の行が標準エラーにありません\n${r.err}`);
      return parseJson(line, `--stats の ${label}`);
    };
    return { file: sb.file, shot, text: fs.readFileSync(sb.file, 'utf8'), stats };
  };
  test('edit2/コマンドパレット: Ctrl+K で開き、名前（split）で探して Enter で実行する', () => {
    const { file } = open('pal-name', ['--frames', '10', '--seek', '3', '--select', 'v', '--key', 'ctrl+k@2', '--text', 'split@3', '--key', 'enter@5']);
    assert(lineOf(file, 'v') === 'video "media/a.mp4" id=v in=0 out=1', `v の行が ${lineOf(file, 'v')} です（3 秒で分けたはず）`);
    assert(/^video "media\/a\.mp4" id=v_2 in=1 out=2/.test(lineOf(file, 'v_2')), `後半の行が ${lineOf(file, 'v_2')} です`);
  });
  test('edit2/コマンドパレット: op の文をそのまま打って Enter で適用し、Ctrl+Z で戻せる', () => {
    const a = open('pal-op', ['--frames', '10', '--key', 'ctrl+k@2', '--text', 'split c 5@3', '--key', 'enter@5']);
    assert(lineOf(a.file, 'c') === 'color 204020 id=c dur=1', `c の行が ${lineOf(a.file, 'c')} です（5 秒で分けたはず）`);
    const b = open('pal-op-undo', ['--frames', '12', '--key', 'ctrl+k@2', '--text', 'split c 5@3', '--key', 'enter@5', '--key', 'ctrl+z@8']);
    assert(b.text === fs.readFileSync(src, 'utf8'), `取り消した後のファイルが元と違います:\n${b.text}`);
  });
  test('edit2/コマンドパレット: 開いている間のキーはほかの部品に届かず（Space で再生しない）、Esc で閉じる', () => {
    const a = open('pal-keys', ['--frames', '8', '--stats', '--key', 'ctrl+k@2', '--key', 'space@3', '--key', 'esc@4']);
    assert(a.stats('playback').state === 'stopped', `パレットを開いたまま Space を押したら ${a.stats('playback').state} になりました`);
    const b = open('pal-keys2', ['--frames', '8', '--stats', '--key', 'ctrl+k@2', '--key', 'esc@3', '--key', 'space@5']);
    assert(b.stats('playback').state === 'playing', `Esc で閉じたあとの Space が ${b.stats('playback').state} です（再生するはず）`);
  });
  test('edit2/Ctrl+S でファイルを書き直す（中身は同じ）', () => {
    const old = new Date('2001-01-01T00:00:00Z');
    const a = open('save', ['--frames', '6', '--key', 'ctrl+s@2'], (f) => fs.utimesSync(f, old, old));
    assert(fs.statSync(a.file).mtimeMs > old.getTime() + 1000, 'Ctrl+S のあともファイルの更新時刻が古いままです');
    assert(a.text === fs.readFileSync(src, 'utf8'), 'Ctrl+S で中身が変わりました');
  });
  test('edit2/素材の欄から素材をタイムラインへ運ぶと影が出て、V2 の 4 秒で離すとそこに置く', () => {
    const drag = ['--move', '122,190@1', '--down', '122,190@2', '--move', '140,210@3', '--move', '600,500@4', '--move', '981,590@5', '--move', '981,590@6'];
    const mid = open('pool-drag', ['--frames', '8', ...drag]);
    const none = open('pool-nodrag', ['--frames', '8']);
    // 落とす先の始まりの線（accent）が、トラックの空いた所（y=800）まで引かれる
    assert(bmpPixel(mid.shot, 981, 800) !== bmpPixel(none.shot, 981, 800), '運んでいる間、落とす先の線が出ていません');
    assert(mid.text === fs.readFileSync(src, 'utf8'), '離す前にファイルが変わりました');
    const done = open('pool-drop', ['--frames', '10', ...drag, '--up', '981,590@7']);
    const added = done.text.split(/\r?\n/).filter((l) => l.startsWith('video "media/a.mp4"') && !l.includes(' id=v '));
    assert(added.length === 1, `足した行が ${added.length} 行です:\n${done.text}`);
    const at = Number((/ at=([0-9.]+)/.exec(added[0]) || [])[1]);
    assert(Math.abs(at - 4) < 0.1 && / track=1\b/.test(added[0]) && / dur=4(\.0*)?\b/.test(added[0]), `足した行が ${added[0]} です（V2 の 4 秒に 4 秒の長さで置くはず）`);
  });
}

// ---- 実行 ----

// ---- m6（部品の試験） ----

function groupM6() {
  const dirs = fs.readdirSync(path.join(ROOT, 'tests'), { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith('m6-') && fs.existsSync(path.join(ROOT, 'tests', e.name, 'run.mjs')))
    .map((e) => e.name).sort();
  for (const name of dirs) {
    test(`m6/${name}`, () => {
      const t0 = Date.now();
      const r = run(process.execPath, [path.join(ROOT, 'tests', name, 'run.mjs')],
        { env: { ...process.env, SDL_VIDEO_DRIVER: 'offscreen', SDL_AUDIO_DRIVER: 'dummy' }, timeout: 900000 });
      const tail = (r.out + r.err).trim().split('\n').slice(-15).join('\n');
      assert(r.code === 0, `終了コード ${r.code}\n${tail}`);
      if (VERBOSE) console.log(`        ${((Date.now() - t0) / 1000).toFixed(1)} 秒: ${tail.split('\n').pop()}`);
    });
  }
}

// ---- media（FFmpeg の組み込みで素材を直接読む） ----

// 本物の素材を使うプロジェクトを real/ に書く（素材と同じフォルダ）。cache は空のフォルダ。
function realProject(lines) {
  const m = realMedia();
  const f = path.join(m.dir, `m${++seq}.mzc`);
  fs.writeFileSync(f, lines.join('\n') + '\n');
  const cache = path.join(m.dir, `m${seq}.cache`);
  fs.mkdirSync(cache, { recursive: true });
  return { file: f, cache };
}

function realPreview(pj, t) {
  const bmp = path.join(pj.cache, `p${t}.bmp`);
  const r = engine(['preview', pj.file, pj.cache, String(t), bmp]);
  assert(r.code === 0, `preview ${t} が終了コード ${r.code}\n${r.err}`);
  return readBmp(bmp);
}

function groupMedia() {
  if (!engineFfmpeg()) {
    console.log('  --  media（エンジンに FFmpeg の組み込みがないので飛ばす）');
    return;
  }
  // v30.mp4 のコマ N の Y は 16 + min(4N, 200)。x = 192 の列は色差が 128（灰色）なので、RGB は (Y - 16) / 219 * 255
  const grayOf = (n) => Math.round((Math.min(n * 4, 200)) / 219 * 255);
  test('media/コマ単位で正確に読む（in のずれ、飛び飛びの順、前へ戻るシーク）', () => {
    const pj = realProject(['project size=320x180 fps=30 bg=000000', 'video "v30.mp4" in=0.5 dur=1.4']);
    const bad = [];
    for (const t of [0, 0.4, 0.1, 0.9, 1.3, 0.0333, 0.5]) {
      const n = Math.floor(t * 30 + 1e-6) + 15;
      const got = realPreview(pj, t).px(192, 90);
      const want = grayOf(n);
      if (got.some((v) => Math.abs(v - want) > 2)) bad.push(`${t} 秒（素材のコマ ${n}）: 期待 ${want}、実際 ${got.join(',')}`);
    }
    assert(bad.length === 0, bad.join('\n'));
  });
  test('media/素材と同じ大きさで受け取っても、色差の行が欠けない（UM の変換の区切りの誤りの回り道）', () => {
    const pj = realProject(['project size=1280x720 fps=30 bg=000000', 'video "flat720.mp4" dur=1']);
    const img = realPreview(pj, 0.5);
    const ref = img.px(640, 10);
    const bad = [];
    for (let y = 0; y < 720; y++) {
      const p = img.px(640, y);
      if (p.some((v, i) => Math.abs(v - ref[i]) > 3)) bad.push(`${y} 行: ${p}`);
    }
    assert(bad.length === 0, `1 色の素材の行の色が違います（基準 ${ref}）: ${bad.slice(0, 6).join(' / ')}`);
  });
  test('media/いっぱいの範囲の素材を同じ大きさで描いても、大きさを変えた描画と同じ色（BT.601 の計算の値）になる', () => {
    const same = realPreview(realProject(['project size=1280x720 fps=30 bg=000000', 'video "full720.mp4" dur=1']), 0.5).px(640, 360);
    const scaled = realPreview(realProject(['project size=1280x720 fps=30 bg=000000', 'video "full720.mp4" dur=1 w=1278 h=718']), 0.5).px(640, 360);
    // Y=214、Cb=209、Cr=50（いっぱいの範囲）の BT.601: R = 214 + 1.402 × (50 − 128)、G = 214 − 0.344136 × 81 − 0.714136 × (−78)
    const want = [105, 242, 255];
    assert(same.slice(0, 3).every((v, i) => v === scaled[i]), `同じ大きさ ${same} と大きさを変えた描画 ${scaled} の色が違います`);
    assert(same.slice(0, 3).every((v, i) => Math.abs(v - want[i]) <= 1), `色 ${same} が BT.601 の計算の値 ${want} と違います`);
  });
  test('media/読めない素材（moov のない MP4）は check で unreadable-source。preview も FFmpeg の理由で止まり、キャッシュの案内を出さない', () => {
    const m = realMedia();
    const good = fs.readFileSync(path.join(m.dir, 'v30.mp4'));
    fs.writeFileSync(path.join(m.dir, 'cut.mp4'), good.subarray(0, Math.floor(good.length / 2)));
    const pj = realProject(['project size=320x180 fps=30 bg=000000', 'video "cut.mp4" dur=2']);
    const c = check(pj.file, pj.cache);
    const d = c.j.diagnostics.find((x) => x.code === 'unreadable-source');
    assert(c.code === 1 && d && d.line === 2 && /moov|Invalid data/.test(d.message), `unreadable-source になっていません: ${JSON.stringify(c.j.diagnostics)}`);
    assert(!c.j.diagnostics.some((x) => x.code === 'unknown-length' || x.code === 'no-video-stream'), `長さ・映像の誤りを重ねて出しています: ${JSON.stringify(c.j.diagnostics)}`);
    const r = engine(['preview', pj.file, pj.cache, '0.5', path.join(pj.cache, 'cut.bmp')]);
    assert(r.code !== 0 && r.err.includes('unreadable-source'), `preview が unreadable-source で止まっていません（終了コード ${r.code}）\n${r.err}`);
    assert(!r.err.includes('mozcut.mjs を通して'), `FFmpeg の版でキャッシュの案内を出しています\n${r.err}`);
  });
  test('media/画像（PNG の半透明）は 1 度だけ展開して重ねる', () => {
    const pj = realProject(['project size=320x180 fps=30 bg=000000', 'image "logo.png" at=0 dur=1 x=0 y=0']);
    const img = realPreview(pj, 0.5);
    // logo.png は r=255、g=4x、b=0、a=128
    const p = img.px(10, 10);
    assert(Math.abs(p[0] - 128) <= 2 && Math.abs(p[1] - 20) <= 2 && p[2] <= 1, `画像の画素が違います: ${p}`);
    const q = img.px(100, 100);
    assert(q.every((v) => v === 0), `画像の外が背景ではありません: ${q}`);
  });
  test('media/w と fit=cover は拡大して切り抜く。25 コマ/秒の素材も 30 コマ/秒で読む', () => {
    const pj = realProject(['project size=320x240 fps=30 bg=000000', 'video "v25.mp4" w=160 h=160 fit=cover x=0 y=0 dur=1.5',
      'video "v25.mp4" w=100 x=200 y=0 dur=1.5 track=1 at=0']);
    const img = realPreview(pj, 1.0);
    assert(img.px(80, 80).some((v) => v > 0), '切り抜いた映像が描かれていません');
    assert(img.px(165, 80).every((v) => v === 0), 'cover の映像が 160 の幅をはみ出しています');
    // w=100 の 4:3 は 100x76（偶数に丸める）
    assert(img.px(250, 70).some((v) => v > 0) && img.px(250, 78).every((v) => v === 0), 'w だけの映像の高さが 76 ではありません');
  });
  test('media/音を事前の展開なしでミックスする（render の PCM の長さと大きさ）', () => {
    const pj = realProject(['project size=320x180 fps=30 rate=48000 bg=000000', 'audio "tone.wav" at=0.5 dur=1', 'color 000000 dur=2']);
    const r = engine(['render', pj.file, pj.cache], { timeout: 120000 });
    assert(r.code === 0, `render が終了コード ${r.code}\n${r.err}`);
    const pcm = fs.readFileSync(path.join(pj.cache, 'out.pcm'));
    assert(pcm.length === 2 * 48000 * 4, `PCM の長さが ${pcm.length} バイトです（2 秒分のはず）`);
    const rms = (a, b) => {
      let s = 0;
      for (let i = a; i < b; i++) s += pcm.readInt16LE(i * 4) ** 2;
      return Math.sqrt(s / (b - a));
    };
    const silent = rms(0, 23000);
    const tone = rms(30000, 70000);
    // 素材の WAV（s16le、見出し 44 バイト）の左の RMS と比べる
    const wav = fs.readFileSync(path.join(realMedia().dir, 'tone.wav'));
    let ws = 0;
    for (let i = 0; i < 40000; i++) ws += wav.readInt16LE(44 + i * 4) ** 2;
    const want = Math.sqrt(ws / 40000);
    assert(silent === 0 && want > 1000 && Math.abs(tone - want) < want * 0.02, `音の大きさが違います（前 ${silent.toFixed(1)}、中 ${tone.toFixed(1)}、素材 ${want.toFixed(1)}）`);
  });
  test('media/render --out で MP4（H.264 + AAC）を直接書く（長さ・コマ数・音・LGPL の符号器・範囲）', () => {
    const ffprobe = process.env.FFPROBE || 'ffprobe';
    if (spawnSync(ffprobe, ['-version']).error) skip('ffprobe のコマンドがない');
    const pj = realProject(['project size=320x180 fps=30 rate=48000 bg=000000', 'video "v30.mp4" in=0.5 dur=1', 'audio "tone.wav" at=0.25 dur=1']);
    const out = path.join(pj.cache, 'out.mp4');
    const r = engine(['render', pj.file, pj.cache, '--out', out], { timeout: 120000 });
    assert(r.code === 0, `render --out が終了コード ${r.code}\n${r.err}`);
    assert(!/libx264|libx265/.test(r.err) && /符号器: 映像 h264/.test(r.err), `符号器が違います（GPL の符号器は使わない）: ${r.err}`);
    assert(!fs.existsSync(path.join(pj.cache, 'out.y4m')), '中間の Y4M を書いています');
    const p = spawnSync(ffprobe, ['-v', 'error', '-count_frames', '-show_entries', 'stream=codec_name,codec_type,nb_read_frames,sample_rate,channels:format=duration', '-of', 'json', out], { encoding: 'utf8' });
    const j = JSON.parse(p.stdout);
    const v = j.streams.find((x) => x.codec_type === 'video');
    const a = j.streams.find((x) => x.codec_type === 'audio');
    assert(v && v.codec_name === 'h264' && Number(v.nb_read_frames) === 38, `映像が違います: ${p.stdout}`);
    assert(a && a.codec_name === 'aac' && Number(a.sample_rate) === 48000 && Number(a.channels) === 2, `音が違います: ${p.stdout}`);
    assert(near(Number(j.format.duration), 1.25, 0.05), `長さが ${j.format.duration} 秒です（1.25 秒のはず）`);
    // 範囲（--from / --to）
    const out2 = path.join(pj.cache, 'part.mp4');
    const r2 = engine(['render', pj.file, pj.cache, '0.5', '1', '--out', out2], { timeout: 120000 });
    assert(r2.code === 0, `範囲の render --out が終了コード ${r2.code}\n${r2.err}`);
    const p2 = spawnSync(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', out2], { encoding: 'utf8' });
    assert(near(Number(p2.stdout), 0.5, 0.05), `範囲の長さが ${p2.stdout.trim()} 秒です（0.5 秒のはず）`);
  });
  test('media/編集画面の音: 等速では音の出力（dummy）が時計になり、鳴らした標本の数が進んだ時間に合う。2 倍では止める', () => {
    if (!fs.existsSync(EDITOR_EXE)) skip('build/mozcut-edit がない');
    const pj = realProject(['project size=320x180 fps=30 rate=48000 bg=000000', 'video "v30.mp4" id=a', 'audio "tone.wav" at=0']);
    const stats = (r) => {
      const get = (k) => parseJson((r.err.split(/\r?\n/).find((l) => l.startsWith(`${k}: `)) || '').slice(k.length + 2), `--stats の ${k}`);
      return { pb: get('playback'), au: get('audio') };
    };
    const r = editorRun([pj.file, '--frames', '50', '--play', '1', '--stats']);
    assert(r.code === 0, `終了コード ${r.code}\n${r.err}`);
    const { pb, au } = stats(r);
    assert(au.ok && pb.clock === 'audio' && au.starts === 1, `音の時計になっていません: ${JSON.stringify({ pb, au })}`);
    // 鳴らした長さ（played / rate）と、音の時計の位置（t、0 秒から鳴らし始めた）が合う（出力の遅れの分だけ違ってよい）
    const playedSec = au.played / au.rate;
    assert(playedSec > 0.3 && Math.abs(playedSec - au.t) < 0.1 && Math.abs(pb.t - au.t) < 0.15,
      `鳴らした標本の数と時計が合いません: played ${playedSec.toFixed(3)} 秒、音の時計 ${au.t}、映像 ${pb.t}`);
    assert(au.written >= au.played, `書いたより多く鳴っています: ${JSON.stringify(au)}`);
    // L を重ねて 2 倍にすると音を止める（時計は壁時計に戻る）
    const r2 = editorRun([pj.file, '--frames', '40', '--play', '1', '--keys', '. . . . . . . . . . L', '--stats']);
    assert(r2.code === 0, `終了コード ${r2.code}\n${r2.err}`);
    const s2 = stats(r2);
    assert(s2.pb.speed === 2 && !s2.au.playing, `2 倍で音が止まっていません: ${JSON.stringify(s2)}`);
  });
  test('media/編集画面に素材を落とすと、種類を見分けてタイムラインの末尾に足す（--drop。SDL のドロップのイベントを積む）', () => {
    if (!fs.existsSync(EDITOR_EXE)) skip('build/mozcut-edit がない');
    const pj = realProject(['project size=320x180 fps=30', 'color 202040 dur=1']);
    const m = realMedia();
    const sub = path.join(m.dir, 'sub');
    fs.mkdirSync(sub, { recursive: true });
    fs.copyFileSync(path.join(m.dir, 'logo.png'), path.join(sub, 'logo 2.png'));
    const r = editorRun([pj.file, '--frames', '5', '--drop', path.join(m.dir, 'v30.mp4'), '--drop', path.join(m.dir, 'tone.wav'),
      '--drop', path.join(sub, 'logo 2.png'), '--drop', pj.file]);
    assert(r.code === 0, `終了コード ${r.code}\n${r.err}`);
    const lines = fs.readFileSync(pj.file, 'utf8').split(/\r?\n/).filter((l) => l && !l.startsWith('project') && !l.startsWith('color'));
    const want = ['video "v30.mp4" id=video1 at=1', 'audio "tone.wav" id=audio1 at=3', 'image "sub/logo 2.png" id=image1 at=4.5'];
    assert(JSON.stringify(lines) === JSON.stringify(want), `足した行が違います\n    期待: ${JSON.stringify(want)}\n    実際: ${JSON.stringify(lines)}`);
    const c = engine(['check', pj.file]);
    assert(c.code === 0, `足したプロジェクトに誤りがあります\n${c.out}${c.err}`);
  });
  test('media/編集画面に素材を落とすと、落とした位置の時刻と行のトラックに入る（--drop-at。タイムラインの外なら末尾）', () => {
    if (!fs.existsSync(EDITOR_EXE)) skip('build/mozcut-edit がない');
    const m = realMedia();
    // 窓は 1280x800。行は 映像のトラック 1・映像のトラック 0・音のトラック 0 の 3 つ（editor.um の computeLayout:
    // タイムラインの高さ 22 + 3 × 30 + 8 = 120 → 上の端 680、行は 702・732・762 から 30 ずつ）。
    // 時間軸は全体の長さ 2 秒に合わせる（fitZoom: (1280 − 60 − 8) / (2 × 1.04) 画素/秒）ので、1 秒は x = 60 + 582.7
    const x1 = 60 + Math.round((1280 - 60 - 8) / (2 * 1.04));
    const rowY = (r) => 680 + 22 + r * 30 + 15;
    const lines = ['project size=320x180 fps=30 bg=000000', 'video "v30.mp4"', 'video "silent.mp4" track=1 dur=1', 'audio "tone.wav" dur=1'];
    const dropAt = (file, x, y) => {
      const pj = realProject(lines);
      const r = editorRun([pj.file, '--frames', '4', '--drop', path.join(m.dir, file), '--drop-at', `${x},${y}`]);
      assert(r.code === 0, `終了コード ${r.code}\n${r.err}`);
      const text = fs.readFileSync(pj.file, 'utf8').split(/\r?\n/).filter(Boolean);
      assert(text.length === lines.length + 1, `行が足されていません（${file} を ${x},${y} に）:\n${text.join('\n')}`);
      return text[text.length - 1];
    };
    const a = dropAt('logo.png', x1, rowY(0));
    assert(/^image "logo\.png" .*at=1 track=1$/.test(a), `映像のトラック 1 の行の 1 秒に入っていません: ${a}`);
    const b = dropAt('tone.wav', x1, rowY(2));
    assert(/^audio "tone\.wav" .*at=1$/.test(b), `音の行の 1 秒に入っていません: ${b}`);
    // 種類の合わない行（音の行に映像）は、時刻だけ使い、トラックは既定
    const c = dropAt('v30.mp4', x1, rowY(2));
    assert(/^video "v30\.mp4" .*at=1$/.test(c), `映像を音の行に落としたときの位置が違います: ${c}`);
    // タイムラインの外（プレビューの上）は末尾
    const d = dropAt('logo.png', 300, 200);
    assert(/^image "logo\.png" .*at=2$/.test(d), `プレビューに落としたのに末尾に入っていません: ${d}`);
  });
  test('media/編集画面は調べた素材の情報を場所ごとに 1 件だけ覚える（同じファイルを何度落としても、読めない素材があっても増えない）', () => {
    if (!fs.existsSync(EDITOR_EXE)) skip('build/mozcut-edit がない');
    const m = realMedia();
    const good = fs.readFileSync(path.join(m.dir, 'v30.mp4'));
    fs.writeFileSync(path.join(m.dir, 'cut2.mp4'), good.subarray(0, Math.floor(good.length / 2)));
    const pj = realProject(['project size=320x180 fps=30 bg=000000', 'video "v30.mp4"', 'video "cut2.mp4" dur=2']);
    const v30 = path.join(m.dir, 'v30.mp4');
    const r = editorRun([pj.file, '--frames', '8', '--drop', v30, '--drop', v30, '--drop', v30, '--drop', path.join(m.dir, 'tone.wav'), '--stats']);
    assert(r.code === 0, `終了コード ${r.code}\n${r.err}`);
    const line = r.err.split(/\r?\n/).find((l) => l.startsWith('media: '));
    assert(line, `--stats の media: の行がありません\n${r.err}`);
    const st = parseJson(line.slice('media: '.length), '--stats の media');
    // 覚えるのは v30.mp4・cut2.mp4・tone.wav の 3 件（落とした 4 つのうち 3 つは v30.mp4 と同じファイル）
    assert(st.known === 3, `覚えた素材の情報が ${st.known} 件です（3 件のはず）: ${line}`);
  });
  test('media/編集画面: 逆再生・2 倍・4 倍でも先読みが当たり、コマ落ちが少ない（--play -1 / -2 / -4 / 2 / 4 で 200 フレーム）', () => {
    if (!fs.existsSync(EDITOR_EXE)) skip('build/mozcut-edit がない');
    // 重めの素材: 1280x720・30 コマ/秒・6 秒、キーフレームは 2 秒ごと（カメラの素材に近い）、B フレームつき。前へ戻る
    // シークは前のキーフレームから展開し直すことになる（展開器は 1 つ。2 つ重ねると、4 倍はこの機械でも先読みの
    // 手いっぱいになり、負荷で結果が揺れる）
    const m = realMedia();
    const heavy = path.join(m.dir, 'gop720.mp4');
    if (!fs.existsSync(heavy)) {
      const ff = process.env.FFMPEG || 'ffmpeg';
      const g = spawnSync(ff, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=30:d=6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
        '-g', '60', '-bf', '2', heavy], { encoding: 'utf8' });
      assert(!g.error && g.status === 0, `素材 gop720.mp4 を作れません: ${g.stderr}`);
    }
    const demo = realProject(['project size=1280x720 fps=30 bg=000000', 'video "gop720.mp4"']).file;
    const { home } = editorHome('speeds');
    const measure = (seek, speed) => {
      const r = editorRun([demo, '--home', home, '--seek', String(seek), '--play', String(speed), '--frames', '200', '--stats'], { timeout: 120000 });
      assert(r.code === 0, `終了コード ${r.code}\n${r.err}`);
      const line = r.err.split(/\r?\n/).find((l) => l.startsWith('playback: '));
      assert(line, `--stats の JSON が標準エラーにありません\n${r.err}`);
      return parseJson(line.slice('playback: '.length), '--stats');
    };
    // 等速の 1 コマの展開の時間を基準にする（速さの違う機械でも比べられるように）
    const base = measure(1, 1);
    // 直す前（逆再生は毎コマのシーク、速い再生は頼んだのと違うコマを見せる）は、demo で逆再生の当たり 40〜72 %・1 コマ 38〜75 ms、
    // 2 倍でコマ落ち 68〜72、4 倍で当たり 28 % だった。
    // コマ落ちは機械の負荷で揺れるので、ゆるい上限だけにする。見分けるのは当たりと 1 コマの時間。ほかの処理と重なると
    // 1 回だけ大きく外れることがあるので、通らなければ 1 度だけ測り直す（直す前の版は、何度測っても通らない）
    const okOf = (st) => st.hitRate >= 0.8 && st.dropped <= 60 && st.fetchMsAvg <= Math.max(base.fetchMsAvg * 4, 8);
    const bad = [];
    for (const [seek, speed] of [[5.5, -1], [5.9, -2], [5.9, -4], [0, 2], [0, 4]]) {
      let st = measure(seek, speed);
      if (!okOf(st)) st = measure(seek, speed);
      const txt = `${speed} 倍（${seek} 秒から）: 当たり ${st.hitRate}、コマ落ち ${st.dropped}、1 コマ ${st.fetchMsAvg} ms（等速 ${base.fetchMsAvg} ms）`;
      if (!okOf(st)) bad.push(txt);
    }
    assert(bad.length === 0, `速い再生・逆再生で先読みが追いついていません:\n${bad.join('\n')}`);
  });
  test('media/編集画面: 事前の展開なしで再生し、先読みのスレッドが自分の展開器で読む（--play 1 --stats）', () => {
    if (!fs.existsSync(EDITOR_EXE)) skip('build/mozcut-edit がない');
    const pj = realProject(['project size=320x180 fps=30 bg=000000', 'video "v30.mp4" id=a', 'video "v30.mp4" in=1 dur=1 track=1 at=0.5 w=160 fit=cover h=90']);
    const r = editorRun([pj.file, '--frames', '60', '--play', '1', '--stats']);
    assert(r.code === 0, `終了コード ${r.code}\n${r.err}`);
    const line = (r.err.split(/\r?\n/).find((l) => l.startsWith('playback: ')) || '').replace(/^playback: /, '');
    const st = parseJson(line, '--stats');
    assert(st.shown > 1 && st.fetched > 10 && st.hits > 10 && st.fetchFailed === 0, `再生の統計がおかしい: ${line}`);
    assert(!fs.existsSync(path.join(pj.cache, 'probe.txt')), '素材の展開や probe.txt を使っています');
  });
}

const groups = {
  diag: groupDiag, layout: groupLayout, ops: groupOps, fx: groupFx, report: groupReport, cli: groupCli,
  golden: groupGolden, play: groupPlay, mzplug: groupMzplug, editor: groupEditor, edit2: groupEdit2, m6: groupM6, media: groupMedia,
};
const parallel = !CHILD && JOBS > 1 && want.length > 1;
if (CHILD) {
  // 子: 選ばれた群を流し、出力の最後に集計の行を出す（見出しと合計は親が出す）
  for (const g of want) groups[g]();
  if (!KEEP && !keepTmp) fs.rmSync(TMP, { recursive: true, force: true });
  else console.log(`作業用のフォルダを残しました: ${TMP}`);
  if (VERBOSE) for (const f of failures) console.log(`\n== ${f.name}\n${f.msg}`);
  console.log(SUMMARY_TAG + JSON.stringify({
    passed, skipped, failed: failures.map((f) => f.name), known: knownFails.map((f) => f.name), knownFixed,
  }));
  process.exit(failures.length ? 1 : 0);
}
if (parallel) {
  fs.rmSync(TMP, { recursive: true, force: true }); // 作業用のフォルダは子がそれぞれ作る
  console.log(`MozaicCut のテスト（${want.length} 群を ${Math.min(JOBS, want.length)} 個ずつ同時に）`);
} else {
  console.log(`MozaicCut のテスト（作業用: ${TMP}）`);
}
ensureEngine();
if (parallel) {
  const pass = argv.filter((a) => a === '--update' || a === '--keep' || a === '-v');
  const env = { ...process.env, MOZCUT_TEST_CHILD: '1' };
  const script = fileURLToPath(import.meta.url);
  const jobs = want.map((g) => ({ name: g, cmd: process.execPath, args: [script, g, ...pass], env, weight: GROUP_WEIGHT[g] }));
  await runParallel(jobs, JOBS, (job, r) => {
    const { text, summary } = takeSummary(r.out);
    console.log(`\n[${job.name}]（${(r.ms / 1000).toFixed(1)} 秒）`);
    if (text) console.log(text);
    if (!summary) {
      failures.push({ name: `${job.name}（群が終了コード ${r.code} で終わり、集計がありません）`, msg: '' });
      return;
    }
    passed += summary.passed;
    skipped += summary.skipped;
    for (const name of summary.failed) failures.push({ name, msg: '（上の群の出力を見る）' });
    for (const name of summary.known) knownFails.push({ name });
    knownFixed.push(...summary.knownFixed);
  });
} else {
  for (const g of want) {
    console.log(`\n[${g}]`);
    groups[g]();
  }
  if (!KEEP && !keepTmp) fs.rmSync(TMP, { recursive: true, force: true });
  else console.log(`\n作業用のフォルダを残しました: ${TMP}`);
}
const extra = [knownFails.length ? `既知の誤り ${knownFails.length} 件` : '', skipped ? `飛ばした ${skipped} 件` : ''].filter(Boolean);
console.log(`\n${passed} 件合格、${failures.length} 件不合格${extra.length ? `（${extra.join('、')}）` : ''}`);
if (knownFails.length) console.log('既知の誤り: ' + knownFails.map((f) => f.name).join(', '));
if (knownFixed.length) console.log('既知の誤りの一覧にあるが通ったもの（KNOWN から外す）: ' + knownFixed.join(', '));
if (failures.length) {
  console.log('不合格: ' + failures.map((f) => f.name).join(', '));
  if (VERBOSE && !parallel) for (const f of failures) console.log(`\n== ${f.name}\n${f.msg}`);
}
process.exit(failures.length ? 1 : 0);
