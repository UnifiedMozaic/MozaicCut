#!/usr/bin/env node
// 字幕（src/subtitle.um）のテスト。node tests/subtitle/run.mjs で流す（-v で通ったものも出す、--keep で作業用のフォルダを残す）。
// src/ を一時フォルダに写し、tests/subtitle/subtitle_test.um をその隣に置いてビルドして試す。npm の依存はない。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildTool, run, runJson, put, test, done, eq, assert } from '../umtest.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ST = buildTool('subtitle_test', path.join(HERE, 'subtitle_test.um'));

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const codes = (ds) => ds.map((d) => `${d.code}@${d.line}`);

// ---- 読み取り: SRT ----

test('SRT: BOM と CRLF、タグ、複数行', () => {
  const f = put('a.srt', Buffer.concat([BOM, Buffer.from(
    '1\r\n00:00:01,000 --> 00:00:02,500\r\n<i>こんにちは</i>\r\n二行目\r\n\r\n2\r\n00:00:03,250 --> 00:00:04,000\r\n<font color="#ff0000">赤</font> &amp; 青\r\n')]));
  const r = runJson(ST, ['parse', f]);
  eq(r.format, 'srt', '形式');
  eq(r.diagnostics, [], '診断なし');
  eq(r.cues.map((c) => [c.index, c.start, c.end, c.line]), [[1, 1, 2.5, 2], [2, 3.25, 4, 7]], '番号・時刻・行');
  eq(r.cues[0].text, '<i>こんにちは</i>\n二行目', '書いてあったままの文字');
  eq(r.cues[0].plain, 'こんにちは\n二行目', '画面に出す文字');
  eq(r.cues[1].plain, '赤 &amp; 青', 'font のタグは外す（SRT には文字参照の決まりがないので &amp; はそのまま）');
});

test('SRT: 改行が \\r だけでも読める', () => {
  const f = put('cr.srt', '1\r00:00:01,000 --> 00:00:02,000\rA\r\r2\r00:00:02,000 --> 00:00:03,000\rB\r');
  const r = runJson(ST, ['parse', f]);
  eq(r.cues.map((c) => c.text), ['A', 'B'], '2 つ読む');
  eq(r.diagnostics, [], '診断なし');
});

test('SRT: {\\an8} は上に出す字幕', () => {
  const f = put('top.srt', '1\n00:00:01,000 --> 00:00:02,000\n{\\an8}上の字幕\n\n2\n00:00:03,000 --> 00:00:04,000\n下\n');
  const r = runJson(ST, ['parse', f]);
  eq(r.cues.map((c) => c.top), [true, false], '上か');
  eq(r.cues[0].plain, '上の字幕', '{\\an8} は画面に出さない');
});

test('SRT: 壊れた行は Diag にして、読める字幕は残す', () => {
  const f = put('bad.srt', [
    '1', '00:00:01,000 --> 00:00:02,000', 'ok', '',
    '2', '00:00:03,000 --> 00:00:02,000', '逆', '',
    'x', '00:00:04,000 --> 00:00:05,000', '番号が数でない', '',
    '4', '00:00:06,000 -> 00:00:07,000', '矢印の誤り', '',
    '5', '00:00:08,000 --> 00:00:09,000', '',
  ].join('\n'));
  const r = runJson(ST, ['parse', f]);
  eq(r.cues.map((c) => c.start), [1, 4], '読める字幕だけ');
  const c = codes(r.diagnostics);
  assert(c.includes('bad-cue-time@6'), `終わりが始まりより前: ${c}`);
  assert(c.includes('bad-cue-index@9'), `番号が数でない: ${c}`);
  assert(r.diagnostics.some((d) => d.line === 14 && d.severity === 'error'), `矢印の誤り（14 行目）: ${c}`);
  for (const d of r.diagnostics) {
    assert(d.line > 0 && d.col >= 0, `行がある（col 0 は行全体）: ${JSON.stringify(d)}`);
    assert(/[ぁ-んァ-ヶ一-龠]/.test(d.message), `日本語の文: ${d.message}`);
  }
});

test('SRT: UTF-8 として読めないバイト（Shift_JIS）は bad-encoding', () => {
  const f = put('sjis.srt', Buffer.concat([Buffer.from('1\n00:00:01,000 --> 00:00:02,000\n'), Buffer.from([0x82, 0xa0, 0x82, 0xa2]), Buffer.from('\n')]));
  const r = runJson(ST, ['parse', f]);
  eq(codes(r.diagnostics), ['bad-encoding@3'], '行の付いた診断');
  eq(r.cues.length, 1, '字幕そのものは読む');
});

test('SRT: UTF-16 は bad-encoding（何も読まない）', () => {
  const f = put('u16.srt', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('1\n00:00:01,000 --> 00:00:02,000\nA\n', 'utf16le')]));
  const r = runJson(ST, ['parse', f]);
  assert(r.diagnostics.some((d) => d.code === 'bad-encoding'), JSON.stringify(r.diagnostics));
  eq(r.cues.length, 0, '読まない');
});

test('空のファイルは empty-subtitle', () => {
  const f = put('empty.srt', '');
  const r = runJson(ST, ['parse', f]);
  assert(r.diagnostics.some((d) => d.code === 'empty-subtitle'), JSON.stringify(r.diagnostics));
});

// ---- 読み取り: WebVTT ----

test('WebVTT: ヘッダー、NOTE と STYLE、名前、設定、短い時刻', () => {
  const f = put('a.vtt', Buffer.concat([BOM, Buffer.from(
    'WEBVTT - 試し\r\n\r\nNOTE メモ\r\n続き\r\n\r\nSTYLE\r\n::cue { color: red }\r\n\r\nintro\r\n00:01.000 --> 00:02.500 line:0 align:start\r\n<v Bob>Hello &amp; <b>bye</b>\r\n\r\n01:00:03.000 --> 01:00:04.000\r\n日本\r\n')]));
  const r = runJson(ST, ['parse', f]);
  eq(r.format, 'vtt', '形式');
  eq(r.diagnostics, [], '診断なし');
  eq(r.cues.map((c) => [c.ident, c.start, c.end, c.settings, c.top]),
    [['intro', 1, 2.5, 'line:0 align:start', true], ['', 3603, 3604, '', false]], '名前・時刻・設定');
  eq(r.cues[0].plain, 'Hello & bye', 'タグと文字参照');
});

test('WebVTT: ヘッダーがないと bad-vtt-header、ミリ秒が 2 桁は bad-cue-time', () => {
  const f = put('bad.vtt', 'WEBVT\n\n00:01.000 --> 00:02.000\nA\n\n00:03.00 --> 00:04.000\nB\n');
  const r = runJson(ST, ['parse', f]);
  const c = codes(r.diagnostics);
  assert(c.includes('bad-vtt-header@1'), c.join());
  assert(c.includes('bad-cue-time@6'), c.join());
});

test('時刻の読み取りと書き戻し', () => {
  eq(run(ST, ['time', '01:02:03,004', 'srt']).trim(), '3723.004 01:02:03,004', 'SRT');
  eq(run(ST, ['time', '02:03.500', 'vtt']).trim(), '123.5 00:02:03.500', 'WebVTT の時間なし');
  eq(run(ST, ['time', '00:00:01.000', 'srt']).trim(), '1 00:00:01,000', 'SRT の . も受け付ける（書くときは ,）');
  eq(run(ST, ['time', '02:03,500', 'srt']).trim(), 'NaN', 'SRT は時間を省けない');
  eq(run(ST, ['time', '00:61:00,000', 'srt']).trim(), 'NaN', '分が 60 以上');
  eq(run(ST, ['time', '1:2', 'srt']).trim(), 'NaN', '形の誤り');
});

// ---- 書き出し ----

test('SRT を書き直す: 番号の振り直し、CRLF、タグは残る', () => {
  const f = put('w.srt', '7\n00:00:01,000 --> 00:00:02,000\n<i>A</i>\n\n9\n00:00:03,000 --> 00:00:04,000\nB\nC\n');
  const o = path.join(path.dirname(f), 'w.out.srt');
  run(ST, ['write', f, o, 'srt', 'crlf']);
  eq(fs.readFileSync(o, 'utf8'), '1\r\n00:00:01,000 --> 00:00:02,000\r\n<i>A</i>\r\n\r\n2\r\n00:00:03,000 --> 00:00:04,000\r\nB\r\nC\r\n', '中身');
});

test('WebVTT → SRT: 上の字幕は {\\an8}、文字参照は戻す', () => {
  const f = put('c.vtt', 'WEBVTT\n\n00:01.000 --> 00:02.000 line:0\n<b>A</b> &lt;3\n\n00:03.000 --> 00:04.000\nB\n');
  const o = path.join(path.dirname(f), 'c.out.srt');
  run(ST, ['write', f, o, 'srt', 'lf']);
  eq(fs.readFileSync(o, 'utf8'), '1\n00:00:01,000 --> 00:00:02,000\n{\\an8}A <3\n\n2\n00:00:03,000 --> 00:00:04,000\nB\n', '中身');
});

test('SRT → WebVTT: & < > は文字参照、上の字幕は line:0', () => {
  const f = put('d.srt', '1\n00:00:01,000 --> 00:00:02,000\n{\\an8}A & B <i>c</i>\n');
  const o = path.join(path.dirname(f), 'd.out.vtt');
  run(ST, ['write', f, o, 'vtt', 'lf']);
  eq(fs.readFileSync(o, 'utf8'), 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000 line:0\nA &amp; B c\n', '中身');
});

test('WebVTT → WebVTT: 二重の文字参照にならない', () => {
  const f = put('e.vtt', 'WEBVTT\n\nx\n00:01.000 --> 00:02.000\nA &amp; B\n');
  const o = path.join(path.dirname(f), 'e.out.vtt');
  run(ST, ['write', f, o, 'vtt', 'lf']);
  eq(fs.readFileSync(o, 'utf8'), 'WEBVTT\n\nx\n00:00:01.000 --> 00:00:02.000\nA &amp; B\n', '中身');
});

// ---- .mzc との変換 ----

test('字幕 → .mzc の text の行（既定の見た目、ずらし、id の衝突）', () => {
  const f = put('m.srt', '1\n00:00:01,000 --> 00:00:02,500\n<i>こんにちは</i>\n"二行目"\n\n2\n00:00:03,000 --> 00:00:04,000\n{\\an8}上\n\n3\n00:00:05,000 --> 00:00:06,000\n<i></i>\n');
  const lines = run(ST, ['tomzc', f, '1920', '1080', 'sub', '10', 'sub1,sub3']).trim().split(/\r?\n/);
  eq(lines, [
    'text "こんにちは\\n\\"二行目\\"" id=sub2 at=11 dur=1.5 track=9 y=-76 size=54 color=ffffff outline=000000 shadow=00000080',
    'text "上" id=sub4 at=13 dur=1 track=9 y=76 size=54 color=ffffff outline=000000 shadow=00000080',
  ], '行（文字のない字幕は行にしない）');
});

test('字幕 → .mzc: 縦の画面は下から 15%、負になる字幕は落とす', () => {
  const f = put('n.srt', '1\n00:00:01,000 --> 00:00:02,000\nA\n\n2\n00:00:05,000 --> 00:00:06,000\nB\n');
  const lines = run(ST, ['tomzc', f, '1080', '1920', 'cap', '-2']).trim().split(/\r?\n/);
  eq(lines, ['text "B" id=cap1 at=3 dur=1 track=9 y=-288 size=54 color=ffffff outline=000000 shadow=00000080'], '行');
});

test('.mzc の text のクリップ → SRT / WebVTT（配置した後の時刻、上の字幕、トラックの選択）', () => {
  const mzc = put('p.mzc', [
    'project size=1920x1080',
    'color black id=bg dur=10',
    'text "Hello\\nA & <b>" id=s1 track=2 at=1 dur=2 y=50',
    'text "second" id=s2 track=2 dur=1.5 y=-80',
    'text "title" id=t track=3 at=0.5 dur=1',
    '',
  ].join('\n'));
  const srt = path.join(path.dirname(mzc), 'p.srt');
  eq(runJson(ST, ['mzc', mzc, srt, 'srt']), [], 'プロジェクトの診断なし');
  eq(fs.readFileSync(srt, 'utf8'), [
    '1', '00:00:00,500 --> 00:00:01,500', 'title', '',
    '2', '00:00:01,000 --> 00:00:03,000', '{\\an8}Hello', 'A & <b>', '',
    '3', '00:00:03,000 --> 00:00:04,500', 'second', '',
  ].join('\n'), 'SRT（始まりの順）');
  const vtt = path.join(path.dirname(mzc), 'p.vtt');
  runJson(ST, ['mzc', mzc, vtt, 'vtt', '2']);
  eq(fs.readFileSync(vtt, 'utf8'), [
    'WEBVTT', '',
    's1', '00:00:01.000 --> 00:00:03.000 line:0', 'Hello', 'A &amp; &lt;b&gt;', '',
    's2', '00:00:03.000 --> 00:00:04.500', 'second', '',
  ].join('\n'), 'WebVTT（トラック 2 だけ）');
});

test('.mzc → SRT: プロジェクトの誤りは診断で返す', () => {
  const mzc = put('q.mzc', 'project size=64x36\ntext "a" id=a dur=1\nbogus line\n');
  const out = path.join(path.dirname(mzc), 'q.srt');
  const ds = runJson(ST, ['mzc', mzc, out, 'srt']);
  assert(ds.some((d) => d.line === 3 && d.severity === 'error'), JSON.stringify(ds));
});

done('subtitle');
