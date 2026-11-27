#!/usr/bin/env node
// MozaicCut の全部のテスト。node tests/all.mjs で、tests/run.mjs の群と tests/*/run.mjs の部品を、すべて同時に流して最後に合計を出す。
// npm の依存はない。
//
//   node tests/all.mjs                 全部（CPU の数まで同時に）
//   node tests/all.mjs ops dsp uikit   名前で選ぶ（run.mjs の群の名前か、部品のフォルダの名前）
//   node tests/all.mjs edit2           名前の束で選ぶ（edit2 なら run.mjs の edit2-* の群、m6 なら m6-* の部品）
//   --changed                          前の版のタグ（v*）から変えたファイルに関係するものだけ（表は tests/changed.mjs）
//   --changed=<ref>                    <ref>（main・コミット・タグ）から変えたファイルに関係するものだけ
//   -j N                               同時に流す数（--jobs N でもよい。-j 1 で 1 つずつ）
//   -v / --keep                        それぞれのテストに渡す
//
// 流す前に、build/ に作るもの（エンジン・編集画面・解析の部品）がソースより古ければ、1 回だけビルドする
// （テストがそれぞれビルドし直して同じファイルを同時に書いたり、UM のビルドが build/ に写し直す DLL を、
// 動いているほかのテストが開いていて写せなかったりしないように）。部品ごとの試し用のプログラムは、
// それぞれの run.mjs が自分の一時フォルダに作るので、ぶつからない。
// 出力は 1 つのテストごとにまとめて、決まった順（群、部品の順）に出す。
//
// 同時に流すので、テストを書くときは次を守る（守らないと、1 本だけ流すと通るのに、ここではたまに落ちる）。
// - リポジトリの中（src/・plugins/・demo/・build/）に書かない。書くものは OS の一時フォルダ（mkdtemp）に置く。
//   - src/ や plugins/ に .um を一時でも書くと、ほかのテストの mozcut.mjs が build/mozcut を古いと見て
//     ビルドし直そうとし、動いている exe を上書きできずに落ちる。src/ を写すテストも、消えるファイルを読んで落ちる。
//   - demo/demo.mzc を開くと、隣に demo.cache を書く。使うときは一時フォルダに写す（素材の demo/media も一緒に）。
//   - UM でビルドした exe を build/ に置くと、UM が SDL3.dll・wasmtime.dll などを build/ に写し直す。ほかのテストが
//     build/mozcut-edit などでその DLL を使っていると写せず、UM は「clang failed」とだけ出して落ちる。
//     試し用のプログラムは一時フォルダに作り、同時に作るなら同じフォルダに 2 つのビルドを向けない。
// - いくつものプロセスで使い回すもの（tests/run.mjs の m1check のような、ハッシュで決まる一時フォルダ）は、
//   自分だけのフォルダに作ってから名前を変えて置く。先に置かれていたらそれを使う。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { jobsFromArgs, positionalArgs, runParallel, takeSummary } from './parallel.mjs';
import { changedNames } from './changed.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXT = process.platform === 'win32' ? '.exe' : '';
const argv = process.argv.slice(2);
const JOBS = jobsFromArgs(argv);
const picked = positionalArgs(argv);
const pass = argv.filter((a) => a === '-v' || a === '--keep');
const t0 = Date.now();

// 部品ごとのテストのだいたいの重さ（1 つずつ流したときの秒数）。重いものから始める。知らない部品は 10
const PART_WEIGHT = { mcp: 50, dsp: 30, analyze: 28, color: 21, subtitle: 15, renderqueue: 14, uikit: 13, presets: 12 };

// ---- 流すもの ----

const runMjs = path.join(ROOT, 'tests', 'run.mjs');
const listed = spawnSync(process.execPath, [runMjs, '--list-groups'], { encoding: 'utf8' });
if (listed.status !== 0) {
  console.error(`tests/run.mjs の群を読めません\n${listed.stdout}${listed.stderr}`);
  process.exit(2);
}
const childEnv = { ...process.env, MOZCUT_TEST_CHILD: '1' };
const jobs = JSON.parse(listed.stdout).map((g) => ({
  name: `run/${g.name}`, short: g.name, kind: 'group', cmd: process.execPath, args: [runMjs, g.name, ...pass], env: childEnv, weight: g.weight,
}));
const parts = fs.readdirSync(path.join(ROOT, 'tests'), { withFileTypes: true })
  .filter((e) => e.isDirectory() && fs.existsSync(path.join(ROOT, 'tests', e.name, 'run.mjs')))
  .map((e) => e.name).sort();
for (const p of parts) {
  jobs.push({
    name: p, short: p, kind: 'part', cmd: process.execPath, args: [path.join(ROOT, 'tests', p, 'run.mjs'), ...pass], env: process.env,
    weight: PART_WEIGHT[p] ?? 10,
  });
}
let todo = jobs;
const changedArg = argv.find((a) => a === '--changed' || a.startsWith('--changed='));
if (changedArg) {
  const base = changedArg.startsWith('--changed=') ? changedArg.slice('--changed='.length) : '';
  const c = changedNames(ROOT, base, jobs.map((j) => j.short));
  if (c.names === null) {
    console.log(`--changed: ${c.base} から ${c.files.length} 個のファイル。${c.why}なので、全部を流します`);
  } else if (c.names.length === 0) {
    console.log(`--changed: ${c.base} から、テストに関係する変更はありません（説明書など）`);
    process.exit(0);
  } else {
    console.log(`--changed: ${c.base} から ${c.files.length} 個のファイル → ${c.names.join(' ')}`);
    picked.push(...c.names.filter((n) => !picked.includes(n)));
  }
}
// 名前の束（edit2 なら edit2-* の群、m6 なら m6-* の部品）は、それで始まる名前を全部選ぶ
const pickedJob = (j, n) => j.short === n || j.name === n || j.short.startsWith(`${n}-`);
if (picked.length) {
  const unknown = picked.filter((n) => !jobs.some((j) => pickedJob(j, n)));
  if (unknown.length) {
    console.error(`知らない名前です: ${unknown.join(', ')}（${jobs.map((j) => j.short).join(' / ')} のどれか）`);
    process.exit(2);
  }
  todo = jobs.filter((j) => picked.some((n) => pickedJob(j, n)));
}

// ---- ビルド（1 回だけ） ----

function newestSource() {
  let t = 0;
  const walk = (dir, deep) => {
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const f = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (deep) walk(f, deep);
      } else if (e.name.endsWith('.um')) {
        t = Math.max(t, fs.statSync(f).mtimeMs);
      }
    }
  };
  walk(path.join(ROOT, 'src'), true);
  return t;
}
const stale = (exe) => !fs.existsSync(exe) || fs.statSync(exe).mtimeMs < newestSource();
const needEngine = todo.some((j) => j.kind === 'group' || ['mcp', 'analyze'].includes(j.short));
if (needEngine && (stale(path.join(ROOT, 'build', 'mozcut' + EXT)) || stale(path.join(ROOT, 'build', 'mozcut-edit' + EXT)))) {
  console.log('エンジンと編集画面をビルドしています（node tools/mozcut.mjs build）...');
  const b = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'mozcut.mjs'), 'build'], { stdio: 'inherit' });
  if (b.status !== 0) {
    console.error('ビルドに失敗しました');
    process.exit(2);
  }
}
// 解析の部品（build/mozcut-analyze）も build/ に作るので、同時に流す前に（古ければ）ビルドしておく
if (todo.some((j) => j.short === 'analyze')) {
  const b = spawnSync(process.execPath, [path.join(ROOT, 'tests', 'analyze', 'run.mjs'), '--build-only'], { stdio: 'inherit' });
  if (b.status !== 0) {
    console.error('解析の部品のビルドに失敗しました');
    process.exit(2);
  }
}

// ---- 件数の読み取り ----

// 部品ごとの run.mjs は、最後の行に件数を出す（書き方は部品ごとに少し違う）。読めなければ終了コードだけで決める。
function partCounts(text) {
  const lines = text.split(/\r?\n/).reverse();
  const find = (res) => {
    for (const l of lines) {
      for (const re of res) {
        const m = re.exec(l);
        if (m) return Number(m[1]);
      }
    }
    return null;
  };
  return {
    passed: find([/(\d+) (?:個|件)(?:が通りました|成功|通過)/, /ぜんぶ通りました（(\d+) 件）/, /通ったのは (\d+) 件/, /成功 (\d+) 件/,
      /(\d+) 件すべて成功/, /(\d+) 個の試しがすべて通りました/,
      // m6-anim「43 件 通過」、m6-expr「25 通過」、m6-particles「45 件通りました」、m6-shape「合格 28 個」、m6-track「18 個 ok」、
      // ui「30 件すべて合格」、ws_color「25 件合格」、ws-motion「13 / 13 ok」
      /(\d+) 件 通過/, /^(\d+) 通過/, /(\d+) 件通りました/, /合格 (\d+) 個/, /(\d+) 個 ok/, /(\d+) 件(?:すべて)?合格/, /(\d+) \/ \d+ ok$/]),
    failed: find([/(\d+) (?:個|件)(?:が落ちました|失敗)/, /失敗 (\d+) 件/, /(\d+) (?:件 )?失敗/, /不合格 (\d+) (?:個|件)/, /(\d+) 個 NG/,
      /(\d+) 件不合格/]),
    skipped: find([/(\d+) (?:個|件)(?:を)?飛ばしました/]),
  };
}

// ---- 実行 ----

console.log(`MozaicCut の全部のテスト（${todo.length} 本を ${Math.min(JOBS, todo.length)} 個ずつ同時に）`);
let passed = 0;
let skipped = 0;
let failed = 0;
const bad = [];
const known = [];
const rows = [];
await runParallel(todo, JOBS, (job, r) => {
  const { text, summary } = takeSummary(r.out);
  const sec = (r.ms / 1000).toFixed(1);
  console.log(`\n==== ${job.name}（${sec} 秒、終了コード ${r.code}）`);
  if (text) console.log(text);
  let p = 0;
  let f = 0;
  let s = 0;
  let note = '';
  if (job.kind === 'group') {
    if (summary) {
      p = summary.passed;
      s = summary.skipped;
      f = summary.failed.length;
      known.push(...summary.known);
    } else {
      f = 1;
      note = '集計がありません';
    }
  } else {
    const c = partCounts(text);
    p = c.passed ?? 0;
    s = c.skipped ?? 0;
    f = c.failed ?? 0;
    if (c.passed === null) note = '件数を読めません';
    if (r.code !== 0 && f === 0) {
      f = 1;
      note = note || '終了コードが 0 ではありません';
    }
  }
  if (r.code !== 0 && f === 0) f = 1;
  passed += p;
  skipped += s;
  failed += f;
  if (f) bad.push(job.name);
  rows.push({ name: job.name, sec, p, f, s, note });
});

console.log('\n==== まとめ');
const w = Math.max(...rows.map((r) => r.name.length));
for (const r of rows) {
  console.log(`  ${r.f ? 'NG' : 'ok'}  ${r.name.padEnd(w)}  ${r.sec.padStart(6)} 秒  合格 ${r.p}${r.f ? `、不合格 ${r.f}` : ''}${r.s ? `、飛ばした ${r.s}` : ''}${r.note ? `（${r.note}）` : ''}`);
}
const extra = [known.length ? `既知の誤り ${known.length} 件` : '', skipped ? `飛ばした ${skipped} 件` : ''].filter(Boolean);
console.log(`\n合計 ${passed} 件合格、${failed} 件不合格${extra.length ? `（${extra.join('、')}）` : ''}。${((Date.now() - t0) / 1000).toFixed(1)} 秒`);
if (known.length) console.log('既知の誤り: ' + known.join(', '));
if (bad.length) console.log('落ちたもの: ' + bad.join(', '));
process.exit(bad.length ? 1 : 0);
