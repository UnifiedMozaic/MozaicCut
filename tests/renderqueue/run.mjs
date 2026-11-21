#!/usr/bin/env node
// 書き出しの予約（src/renderqueue.um）のテスト。node tests/renderqueue/run.mjs で流す（-v、--keep）。
// src/ を一時フォルダに写し、tests/renderqueue/renderqueue_test.um をその隣に置いてビルドし、
// 台本（1 行に 1 つの操作。書き方は renderqueue_test.um の先頭）を流して、各行の結果の JSON を確かめる。
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildTool, run, put, test, done, eq, assert, PROBE } from '../umtest.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RT = buildTool('renderqueue_test', path.join(HERE, 'renderqueue_test.um'));

let n = 0;
function script(lines) {
  const f = put(`s${++n}.txt`, lines.join('\n') + '\n');
  return run(RT, ['run', f]).trim().split(/\r?\n/).map((l) => JSON.parse(l));
}
const last = (rs, op) => rs.filter((r) => r.op === op).pop();

test('待ち → 実行中 → 完了。進み具合、速さ、残り時間', () => {
  const rs = script([
    'add - out/a.mp4 youtube-1080p 300 30 0',
    'queue 0',
    'tick 2',
    'progress 1 30 3',
    'progress 1 90 5',
    'queue 6',
    'finish 1 12',
    'queue 12',
  ]);
  eq(rs[0], { op: 'add', id: 1 }, '足す');
  const q0 = rs[1].queue;
  eq([q0.jobs[0].name, q0.jobs[0].state, q0.jobs[0].eta, q0.eta], ['a.mp4', 'waiting', null, null], '名前は出力の名前、待ち');
  eq(rs[2].started, [1], 'tick で始まる');
  const j = rs[5].queue.jobs[0];
  // 合成の段階は全体の 0〜0.5。90/300 コマ = 段階の 30% = 全体の 15%。全体の速さは 30×0.5/300 = 0.05/秒
  // → 残り 0.85/0.05 = 17 秒から、最後の報告（5 秒）からの 1 秒を引いて 16 秒
  eq([j.state, j.phase, j.doneFrames, j.phaseFraction, j.fraction, j.rate, j.eta, j.elapsed, j.attempts],
    ['running', 'render', 90, 0.3, 0.15, 30, 16, 4, 1], '実行中');
  assert(j.text.includes('15%（合成 90/300 コマ') && j.text.includes('残り 約 16 秒'), j.text);
  eq(rs[6].result.ok, true, '完了');
  const d = rs[7].queue.jobs[0];
  eq([d.state, d.fraction, d.doneFrames, d.eta, d.elapsed], ['done', 1, 300, 0, 10], '完了の値');
  eq(rs[7].queue.eta, 0, 'キュー全体も 0');
});

test('同時に実行する数: 1 なら 1 つずつ、2 なら 2 つ', () => {
  const rs = script([
    'add a o/a.mp4 p 100 30 0',
    'add b o/b.mp4 p 100 30 0',
    'add c o/c.mp4 p 100 30 0',
    'tick 1',
    'tick 1',
    'parallel 2',
    'tick 1',
    'tick 1',
    'finish 1 2',
    'tick 2',
  ]);
  const ticks = rs.filter((r) => r.op === 'tick').map((r) => r.started);
  eq(ticks, [[1], [], [2], [], [3]], '始まった仕事');
});

test('残り時間: キュー全体は待ちの仕事も実行中の速さで見込む', () => {
  const rs = script([
    'add a o/a.mp4 p 300 30 0',
    'add b o/b.mp4 p 600 30 0',
    'tick 0',
    'progress 1 60 2',
    'queue 2',
    'text 3',
  ]);
  const q = rs[4].queue;
  // a: 全体の 10%、全体の速さ 30×0.5/300 = 0.05/秒 → 18 秒。b: すべての段階を通した速さ 15 コマ/秒 → 600/15 = 40 秒
  eq([q.running, q.waiting, q.jobs[0].rate, q.jobs[0].eta, q.eta], [1, 1, 30, 18, 58], '18 秒 + 40 秒');
  const t = rs[5].text;
  assert(t.includes('#1 a — 実行中 10%（合成 60/300 コマ、残り 約 17 秒）'), `報告のあいだも残り時間が減る: ${t}`);
  assert(t.endsWith('実行中 1 件、待ち 1 件、残り 約 57 秒'), t);
});

test('取り消し: 待ちも実行中もできる。終わった仕事はできない', () => {
  const rs = script([
    'add a o/a.mp4 p 100 30 0',
    'add b o/b.mp4 p 100 30 0',
    'tick 0',
    'cancel 2 1',
    'stop 1',
    'cancel 1 2',
    'stop 1',
    'cancel 1 3',
    'tick 3',
    'finish 1 4',
  ]);
  eq(rs[3].result.ok, true, '待ちの取り消し');
  eq(rs[4].stop, false, '実行中は止めない');
  eq(rs[5].result.ok, true, '実行中の取り消し');
  assert(rs[5].result.msg.includes('書きかけ'), rs[5].result.msg);
  eq(rs[6].stop, true, '取り消したら止める');
  eq([rs[7].result.ok, rs[7].result.code], [false, 'rq-bad-state'], '二度目の取り消し');
  assert(rs[7].result.msg.includes('取り消し') && rs[7].result.hint.length > 0, rs[7].result.msg);
  eq(rs[8].started, [], '取り消した仕事は始まらない');
  eq(rs[9].result.code, 'rq-bad-state', '取り消した仕事は完了にできない');
});

test('失敗とやり直し: やり直すと待ちの最後に戻り、回数が増える', () => {
  const rs = script([
    'add a o/a.mp4 p 100 30 0',
    'add b o/b.mp4 p 100 30 0',
    'tick 0',
    'progress 1 50 1',
    'fail 1 render-failed 素材が読めません 2',
    'queue 2',
    'retry 1 3',
    'queue 3',
    'tick 3',
    'retry 2 4',
  ]);
  const f = rs[5].queue.jobs[0];
  eq([f.state, f.error, f.eta], ['failed', { code: 'render-failed', msg: '素材が読めません' }, null], '失敗');
  assert(f.text.includes('失敗: 素材が読めません'), f.text);
  const q = rs[7].queue;
  eq(q.jobs.map((j) => [j.id, j.state, j.doneFrames]), [[2, 'waiting', 0], [1, 'waiting', 0]], '最後に戻る、進み具合は消える');
  eq(rs[8].started, [2], '並びの順に始まる');
  eq(rs[9].result.code, 'rq-bad-state', '実行中はやり直せない');
});

test('並びの変更・一覧から消す・終わったものを片付ける', () => {
  const rs = script([
    'add a o/a.mp4 p 100 30 0',
    'add b o/b.mp4 p 100 30 0',
    'add c o/c.mp4 p 100 30 0',
    'move 3 0',
    'move 1 99',
    'queue 0',
    'tick 0',
    'remove 3',
    'finish 3 1',
    'cancel 2 1',
    'add d o/d.mp4 p 100 30 1',
    'clear',
    'queue 1',
    'remove 1',
    'remove 99',
  ]);
  eq(rs[5].queue.jobs.map((j) => j.id), [3, 2, 1], '並び');
  eq(rs[6].started, [3], '先頭から始まる');
  eq(rs[7].result.code, 'rq-bad-state', '実行中は消せない');
  eq(rs[11].removed, 2, '完了と取り消しを片付ける');
  eq(rs[12].queue.jobs.map((j) => j.id), [1, 4], '残り');
  eq(rs[13].result.ok, true, '待ちは消せる');
  eq(rs[14].result.code, 'rq-unknown-job', 'ない仕事');
});

test('状態に合わない操作は何も変えない', () => {
  const rs = script([
    'add a o/a.mp4 p 100 30 0',
    'progress 1 10 1',
    'finish 1 1',
    'phase 1 encode',
    'retry 1 1',
    'queue 1',
  ]);
  for (const r of rs.slice(1, 5)) eq([r.result.ok, r.result.code], [false, 'rq-bad-state'], r.op);
  const j = rs[5].queue.jobs[0];
  eq([j.state, j.doneFrames, j.attempts], ['waiting', 0, 0], '待ちのまま');
});

test('FFmpeg のつなぎ口: -progress の行、終了コード', () => {
  const rs = script([
    'add a o/a.mp4 p 300 30 0',
    'add b o/b.m4a p 300 30 0',
    'parallel 2',
    'tick 0',
    'ff 1 frame=150 1',
    'ff 1 out_time_us=9000000 1',
    'ff 1 progress=continue 1',
    'ff 1 なにか 1',
    'ff 2 out_time_us=5000000 2',
    'queue 2',
    'exit 1 0 - 3',
    'exit 2 1 Conversion_failed 3',
    'queue 3',
  ]);
  const q = rs[9].queue;
  // frame= は間引いた後の出力のコマ数なので使わず、out_time_us × プロジェクトの fps をコマ数にする
  eq([q.jobs[0].phase, q.jobs[0].doneFrames, q.jobs[0].fraction], ['encode', 270, 0.95], 'out_time_us（9 秒 × 30）');
  eq(q.jobs[1].doneFrames, 150, '音だけも out_time_us × fps');
  eq(rs[10].result.ok, true, '終了コード 0 は完了');
  const q2 = rs[12].queue;
  eq(q2.jobs.map((j) => j.state), ['done', 'failed'], '状態');
  eq(q2.jobs[1].error, { code: 'encode-failed', msg: 'ffmpeg が終了コード 1 で止まりました（Conversion_failed）' }, '失敗の理由');
});

test('FFmpeg のつなぎ口: 取り消した後の終了は何もしない', () => {
  const rs = script([
    'add a o/a.mp4 p 300 30 0',
    'tick 0',
    'cancel 1 1',
    'exit 1 255 - 2',
    'queue 2',
  ]);
  eq(rs[3].result.ok, true, 'ok');
  eq(rs[4].queue.jobs[0].state, 'canceled', '取り消しのまま');
});

test('FFmpeg のつなぎ口: 引数（-progress pipe:1 とプリセットの引数）', () => {
  const mzc = put('p.mzc', 'project size=1920x1080 fps=30\nvideo "media/a.mp4" id=a\n');
  const out = run(RT, ['encode', mzc, PROBE, 'youtube-1080p', 'o/out.mp4']).trim().split(/\r?\n/);
  eq(out.slice(0, 4), ['ffmpeg', '-progress', 'pipe:1', '-nostats'], '先頭');
  assert(out.includes('libx264') && out.includes('in.y4m') && out.includes('in.pcm'), out.join(' '));
  eq(out[out.length - 2], 'o/out.mp4', '出力');
  const tj = JSON.parse(out[out.length - 1]);
  eq([tj.jobId, tj.program, tj.output, tj.y4m, tj.pcm, tj.from, tj.to], [1, 'ffmpeg', 'o/out.mp4', 'in.y4m', 'in.pcm', 0, null], '依頼の JSON');
  eq(tj.args, out.slice(1, out.length - 1), 'JSON の args は引数と同じ');
});

test('時間の表記', () => {
  const rs = script(['dur 0.2', 'dur 5', 'dur 60', 'dur 61', 'dur 3600', 'dur 3725', 'dur -1']);
  eq(rs.map((r) => r.text), ['1 秒未満', '約 5 秒', '約 1 分', '約 1 分 1 秒', '約 1 時間', '約 1 時間 2 分', '見込みなし'], '表記');
});

test('空のキュー', () => {
  const rs = script(['queue 0', 'text 0']);
  eq([rs[0].queue.eta, rs[0].queue.jobs], [0, []], 'JSON');
  eq(rs[1].text, '書き出しの予約はありません', '文');
});

// ---- 指摘を直したもの ----

test('段階: 合成 → 圧縮で全体の進み具合は 1 本（0→0.5→1）。段階が変わると速さのならしは 0 から', () => {
  const rs = script([
    'add a o/a.mp4 p 600 60 0',
    'tick 0',
    'progress 1 600 10',
    'queue 10',
    'ff 1 out_time_us=0 10',
    'queue 10',
    'ff 1 out_time_us=5000000 15',
    'queue 15',
  ]);
  const r = rs[3].queue.jobs[0];
  eq([r.phase, r.fraction, r.rate], ['render', 0.5, 60], '合成が終わると全体の 50%');
  const e0 = rs[5].queue.jobs[0];
  eq([e0.phase, e0.doneFrames, e0.fraction, e0.rate], ['encode', 0, 0.5, null], '圧縮に変わると 50% から、速さは未知に戻る');
  const e1 = rs[7].queue.jobs[0];
  // 5 秒 × 60 = 300 コマ = 段階の 50% = 全体の 75%。速さ 60 コマ/秒 → 全体の速さ 60×0.5/600 = 0.05/秒 → 残り 5 秒
  eq([e1.doneFrames, e1.fraction, e1.rate, e1.eta], [300, 0.75, 60, 5], '圧縮の途中');
});

test('段階: 59.94 のプロジェクトを 29.97 で書き出しても、圧縮は 100% まで進む（frame= を使わない）', () => {
  const rs = script([
    'add a o/a.mp4 sns-vertical 600 59.94 0',
    'tick 0',
    'phase 1 encode 1',
    'ff 1 frame=300 3',
    'ff 1 out_time_us=10010000 3',
    'queue 3',
  ]);
  const j = rs[5].queue.jobs[0];
  eq([j.doneFrames, j.phaseFraction, j.fraction], [600, 1, 1], '10.01 秒 × 59.94 = 600 コマ');
});

test('段階: 知らない段階は rq-bad-phase、合成の割合を 1 にすれば合成だけで 100%', () => {
  const rs = script([
    'add a o/a.mp4 p 100 30 0',
    'share 1 1',
    'tick 0',
    'phase 1 mux 1',
    'progress 1 100 2',
    'queue 2',
  ]);
  eq(rs[3].result.code, 'rq-bad-phase', '知らない段階');
  eq([rs[5].queue.jobs[0].fraction, rs[5].queue.jobs[0].renderShare], [1, 1], '合成だけ');
});

test('経過時間: 起動の直後（now=0）に始めた仕事でも 0 にならない', () => {
  const rs = script([
    'add a o/a.mp4 p 300 30 0',
    'tick 0',
    'progress 1 60 2',
    'queue 2',
    'finish 1 4',
    'queue 4',
  ]);
  eq([rs[3].queue.jobs[0].elapsed, rs[3].queue.jobs[0].rate], [2, 30], '実行中');
  eq(rs[5].queue.jobs[0].elapsed, 4, '完了');
});

test('ログのファイル（mozcut.mjs が書く）を続きから読む: 段階、進み具合、終了', () => {
  const body = ['phase=render', 'render_frame=150', 'render_frame=300', 'phase=encode', 'out_time_us=5000000', 'stderr=muxing', ''].join('\n');
  const log = put('job1.log', body);
  const rs = script([
    'add a o/a.mp4 p 300 30 0',
    'tick 0',
    `log 1 ${log} 0 2`,
    'queue 2',
  ]);
  eq(rs[2].next, Buffer.byteLength(body), '次に読む位置');
  const j = rs[3].queue.jobs[0];
  eq([j.phase, j.doneFrames, j.fraction], ['encode', 150, 0.75], '圧縮の途中');
  // 続きを足す（最後の書きかけの行は読まない）。前回の位置から読む
  put('job1.log', body + 'exit=1\nout_time');
  const rs2 = script([
    'add a o/a.mp4 p 300 30 0',
    'tick 0',
    `log 1 ${log} 0 2`,
    `log 1 ${log} ${Buffer.byteLength(body)} 3`,
    'queue 3',
  ]);
  eq(rs2[3].next, Buffer.byteLength(body + 'exit=1\n'), '書きかけの行は読まない');
  eq(rs2[4].queue.jobs[0].error, { code: 'encode-failed', msg: 'ffmpeg が終了コード 1 で止まりました（muxing）' }, 'stderr の最後の行が理由に入る');
  const fail = put('job2.log', 'render_failed=素材が読めません\n');
  const rs3 = script(['add a o/a.mp4 p 300 30 0', 'tick 0', `log 1 ${fail} 0 1`, 'queue 1']);
  eq(rs3[3].queue.jobs[0].error, { code: 'render-failed', msg: '素材が読めません' }, '合成の失敗');
});

done('renderqueue');
