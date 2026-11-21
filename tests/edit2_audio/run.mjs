#!/usr/bin/env node
// 編集画面（build/mozcut-edit）の「音」のワークスペース（src/edit2/ws_audio.um）のテスト。
//   node tests/edit2_audio/run.mjs [-v] [--keep]
//
// 決まった音（クリップの音のキャッシュ clip<n>.pcm）を持つ小さな .mzc を一時フォルダに作り、編集画面を
// SDL_VIDEO_DRIVER=offscreen で開いて「音」の札を押し、1440×900 の画像の画素と、書き換わった .mzc を確かめる。
// 編集画面は node tools/mozcut.mjs build で作る（なければ飛ばす）。音は鳴らさない（SDL_AUDIO_DRIVER=dummy）。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, TMP, test, done, assert } from '../umtest.mjs';

const EXT = process.platform === 'win32' ? '.exe' : '';
const EDIT2_EXE = path.join(ROOT, 'build', `mozcut-edit${EXT}`);
const RATE = 48000;
// 札「音」の場所（上の帯の中央。tests/run.mjs の edit2 と同じ）
const TAB_AUDIO = '844,20';

if (!fs.existsSync(EDIT2_EXE)) {
  console.log('  --  edit2_audio（build/mozcut-edit がないので飛ばす。node tools/mozcut.mjs build で作れます）');
  done('edit2_audio');
}

// 正弦波（1 kHz）の s16le ステレオ。parts は [秒, 振幅（1.0 = 0 dBFS）] の並び
function tone(parts) {
  const total = parts.reduce((a, [s]) => a + Math.round(s * RATE), 0);
  const b = Buffer.alloc(total * 4);
  let i = 0;
  for (const [sec, amp] of parts) {
    const n = Math.round(sec * RATE);
    for (let k = 0; k < n; k++, i++) {
      const v = Math.round(Math.sin((2 * Math.PI * 1000 * i) / RATE) * amp * 32767);
      b.writeInt16LE(v, i * 4);
      b.writeInt16LE(v, i * 4 + 2);
    }
  }
  return b;
}

function wav(pcm) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(2, 22);
  h.writeUInt32LE(RATE, 24);
  h.writeUInt32LE(RATE * 4, 28);
  h.writeUInt16LE(4, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

let seq = 0;
// 声（0〜1 秒は -6 dBFS、1〜2 秒は -18 dBFS）を音のトラック 0、BGM（-12 dBFS、4 秒）を音のトラック 1 に置いたプロジェクト
function project(extra = '') {
  const dir = path.join(TMP, `p${++seq}`);
  const cache = path.join(dir, 'mix.cache');
  fs.mkdirSync(path.join(dir, 'media'), { recursive: true });
  fs.mkdirSync(cache, { recursive: true });
  const voice = tone([[1, 0.5], [1, 0.125]]);
  const bgm = tone([[4, 0.25]]);
  fs.writeFileSync(path.join(dir, 'media', 'voice.wav'), wav(voice));
  fs.writeFileSync(path.join(dir, 'media', 'bgm.wav'), wav(bgm));
  fs.writeFileSync(path.join(cache, 'clip0.pcm'), voice);
  fs.writeFileSync(path.join(cache, 'clip1.pcm'), bgm);
  fs.writeFileSync(path.join(cache, 'probe.txt'), 'media/voice.wav\t2\t0\t1\nmedia/bgm.wav\t4\t0\t1\n');
  const file = path.join(dir, 'mix.mzc');
  fs.writeFileSync(file, [
    '# 音のワークスペースの試し（tests/edit2_audio/run.mjs）',
    'project size=64x36 fps=30 rate=48000',
    'audio "media/voice.wav" id=voice dur=2',
    'audio "media/bgm.wav" id=bgm track=1 dur=4',
    extra,
    '',
  ].join('\n'));
  return { dir, file, home: path.join(dir, 'build') };
}

// 編集画面を開いて「音」を押し、frames コマ目の画面を撮る。終わった後の .mzc の本文も返す
function shoot(p, name, args) {
  fs.mkdirSync(p.home, { recursive: true });
  const shot = path.join(p.dir, `${name}.bmp`);
  const env = { ...process.env, SDL_VIDEO_DRIVER: 'offscreen', SDL_AUDIO_DRIVER: 'dummy' };
  const r = spawnSync(EDIT2_EXE, [p.file, '--home', p.home, '--shot', shot, '--click', `${TAB_AUDIO}@1`, ...args],
    { encoding: 'utf8', env, timeout: 60000 });
  assert(!r.error, `${name}: 編集画面を起動できません（${r.error && r.error.message}）`);
  assert(r.status === 0, `${name}: 終了コード ${r.status}\n${r.stderr}`);
  return { shot, mzc: fs.readFileSync(p.file, 'utf8') };
}

function bmp(file) {
  const b = fs.readFileSync(file);
  const w = b.readInt32LE(18);
  const h = Math.abs(b.readInt32LE(22));
  return { w, h, px: (x, y) => b.readUInt32LE(54 + (y * w + x) * 4) & 0xffffff };
}

// メーターの色（meter.low の緑・mid の黄・high の赤）か。地や文字の灰色ではない、鮮やかな色
function lit(c) {
  const r = (c >> 16) & 255;
  const g = (c >> 8) & 255;
  const b = c & 255;
  return Math.max(r, g, b) > 120 && Math.max(r, g, b) - Math.min(r, g, b) > 60;
}

// ミキサーの中（x 316〜1120、y 260〜450）の、色の付いたメーターの帯の列。左から [x の初め, x の終わり, いちばん上の y]
function meters(file) {
  const im = bmp(file);
  const cols = [];
  for (let x = 316; x < 1120; x++) {
    let top = -1;
    for (let y = 260; y < 450; y++) {
      if (lit(im.px(x, y))) {
        top = y;
        break;
      }
    }
    if (top >= 0) cols.push([x, top]);
  }
  const runs = [];
  for (const [x, top] of cols) {
    const last = runs[runs.length - 1];
    if (last && x === last[1] + 1) {
      last[1] = x;
      last[2] = Math.min(last[2], top);
    } else {
      runs.push([x, x, top]);
    }
  }
  return runs;
}

test('edit2_audio/「音」でミキサーが出て、メーターが今のコマの音の大きさを指す', () => {
  const p = project();
  const a = shoot(p, 'loud', ['--frames', '5', '--seek', '0.5']);
  const b = shoot(p, 'quiet', ['--frames', '5', '--seek', '1.5']);
  const ma = meters(a.shot);
  const mb = meters(b.shot);
  // トラック 2 本とマスター、それぞれ L・R の 2 本
  assert(ma.length === 6, `0.5 秒でメーターの帯が ${ma.length} 本です: ${JSON.stringify(ma)}`);
  assert(mb.length === 6, `1.5 秒でメーターの帯が ${mb.length} 本です: ${JSON.stringify(mb)}`);
  // 声（トラック 0）は -6 dBFS → -18 dBFS で下がる。BGM（トラック 1）は同じ
  assert(mb[0][2] - ma[0][2] > 10, `声のメーターが下がっていません（0.5 秒 y=${ma[0][2]}、1.5 秒 y=${mb[0][2]}）`);
  assert(Math.abs(mb[2][2] - ma[2][2]) <= 1, `BGM のメーターが変わりました（y=${ma[2][2]} → ${mb[2][2]}）`);
  // -6 dBFS の声は -12 dBFS の BGM より上まで届く
  assert(ma[0][2] < ma[2][2] - 5, `声（-6）のメーターが BGM（-12）より上にありません（${ma[0][2]} / ${ma[2][2]}）`);
  const im = bmp(a.shot);
  assert(im.w === 1440 && im.h === 900, `画面が ${im.w}×${im.h} です`);
  assert(a.mzc === fs.readFileSync(p.file, 'utf8') && !/^track /m.test(a.mzc), '開いただけで .mzc が書き換わりました');
});

test('edit2_audio/M を押すと track の行に mute が書かれ、マスターのメーターが BGM だけの大きさに下がる', () => {
  const p = project();
  // トラック 0 のストリップの M（x 343, y 270）
  const r = shoot(p, 'mute', ['--frames', '6', '--seek', '0.5', '--click', '343,270@3']);
  assert(/^track audio=0 mute$/m.test(r.mzc), `track の行がありません:\n${r.mzc}`);
  const m = meters(r.shot);
  // 声を消しても BGM が残るので、マスターは -12 dBFS あたりまで下がる（声のトラックのメーターは薄く残る）
  const full = meters(shoot(project(), 'nomute', ['--frames', '6', '--seek', '0.5']).shot);
  assert(m.length >= 4, `メーターの帯が ${m.length} 本です: ${JSON.stringify(m)}`);
  const master = m[m.length - 1];
  const masterFull = full[full.length - 1];
  assert(master[2] - masterFull[2] > 5, `ミュートしてもマスターが下がりません（${masterFull[2]} → ${master[2]}）`);
});

test('edit2_audio/フェーダーを下げると vol が書かれ、書いてある track の行の値がミキサーに出る', () => {
  const p = project();
  // トラック 1 のフェーダーのつまみ（0 dB の位置。x 472 y 318）を下へ
  const r = shoot(p, 'fader', ['--frames', '9', '--seek', '0.5',
    '--down', '472,318@3', '--move', '472,350@4', '--move', '472,360@5', '--up', '472,360@6']);
  const m = /^track audio=1 vol=(-?[0-9.]+)$/m.exec(r.mzc);
  assert(m && Number(m[1]) < -6, `vol の行がないか、下がっていません:\n${r.mzc}`);
  // 書いた値で開き直すと、BGM のメーターは下がったまま
  const again = meters(shoot(p, 'reopen', ['--frames', '5', '--seek', '0.5']).shot);
  const before = meters(shoot(project(), 'before', ['--frames', '5', '--seek', '0.5']).shot);
  assert(again[2][2] - before[2][2] > 5, `開き直した BGM のメーターが下がっていません（${before[2][2]} → ${again[2][2]}）`);
});

test('edit2_audio/続けて再生すると、ラウドネスの欄に測った値の判定が出る', () => {
  // 3 秒より長く測れると、右の列の「まだ測れていません」（灰色）が、目標との比べ（色付き）に替わる
  const chip = (file) => {
    const im = bmp(file);
    let n = 0;
    for (let y = 300; y < 330; y++) {
      for (let x = 1130; x < 1300; x++) {
        if (lit(im.px(x, y))) n++;
      }
    }
    return n;
  };
  const still = shoot(project(), 'still', ['--frames', '5', '--seek', '0']);
  // 再生は音の出力の時計で進む。負荷が高いと音の出力（dummy）の進みが遅れることがあるので、フレームを多めにする
  const played = shoot(project(), 'played', ['--frames', '600', '--seek', '0', '--play', '1']);
  assert(chip(still.shot) === 0, `止まったままなのに、判定の色が出ています（${chip(still.shot)} 画素）`);
  assert(chip(played.shot) > 50, `4 秒再生しても判定の色が出ません（${chip(played.shot)} 画素）`);
});

done('edit2_audio');
