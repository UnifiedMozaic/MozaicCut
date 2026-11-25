// 部品ごとのテストが UM のコンパイラを直接呼んでビルドするときの、環境の準備（tests/umtest.mjs の buildTool を使わない試し向け）。
//
// - import するだけで、UM_WASMTIME と UM_SDL3 がなければ、tools/mozcut.mjs と同じく、このリポジトリの隣とホームの
//   wasmtime-*-c-api / SDL3-* を探して process.env に入れる（登録表 src/gen/plugins.um は wasmtime を、窓を使う試しは SDL3 を使う）。
// - srcNoFfmpeg(dir): src/ の写しで、FFmpeg のライブラリがなければ ffmpeg.um を ffmpeg_off.um に差し替える
//   （node tools/mozcut.mjs build と同じ。差し替えないと、FFmpeg のない環境では素材を読むコードのリンクで落ちる）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ffmpegLibsFound, useFfmpegOff } from '../tools/ffmpeg-libs.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// このリポジトリの隣とホームから、prefix で始まり need のファイルがあるフォルダを探す（名前の新しい順）。
function findHome(prefix, need) {
  for (const dir of [path.join(ROOT, '..'), os.homedir()]) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const n of names.filter((n) => n.startsWith(prefix)).sort().reverse()) {
      if (fs.existsSync(path.join(dir, n, need))) return path.join(dir, n);
    }
  }
  return undefined;
}

if (!process.env.UM_WASMTIME) {
  const d = findHome('wasmtime-', path.join('include', 'wasmtime.h'));
  if (d) process.env.UM_WASMTIME = d;
}
if (!process.env.UM_SDL3) {
  const d = findHome('SDL3-', path.join('include', 'SDL3', 'SDL.h'));
  if (d) process.env.UM_SDL3 = d;
}

export function srcNoFfmpeg(dir) {
  if (!ffmpegLibsFound()) useFfmpegOff(dir);
}
