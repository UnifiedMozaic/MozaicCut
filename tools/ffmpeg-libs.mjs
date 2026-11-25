// FFmpeg のライブラリ（UM の動画・音声の組み込みがリンクするもの）が見つかるかを調べ、見つからなければ
// src/ の写しの engine/ffmpeg.um を engine/ffmpeg_off.um に差し替える。tools/mozcut.mjs の build と、テストのビルドが使う。
//
// 探し方は UnifiedMozaic のドライバ（src/driver.ts の findFfmpeg）と同じ順: 環境変数 UM_FFMPEG_HOME
// （include/libavformat/avformat.h がある場所）→ pkg-config の libavformat → Homebrew の決まった場所。
// UM_FFMPEG_HOME がなければ、SDL3・wasmtime・wgpu-native と同じく、このリポジトリの隣とホームの ffmpeg* のフォルダ
// （その中に 1 段入った所も。例: ~/ffmpeg-lgpl/ffmpeg-n9.0-latest-win64-lgpl-shared-9.0）を探し、見つかれば
// process.env.UM_FFMPEG_HOME に入れる（UM のコンパイラとテストの子のプロセスが同じ場所を使うように）。
// 環境変数 MOZCUT_NO_FFMPEG=1 なら、見つかっても使わない（予備の経路を試すため）。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function hasFfmpeg(dir) {
  return fs.existsSync(path.join(dir, 'include', 'libavformat', 'avformat.h'));
}

// このリポジトリの隣とホームの ffmpeg* のフォルダ（と、その中に 1 段入った所）から、FFmpeg の共有ライブラリのビルドを探す。
function findFfmpegHome() {
  for (const base of [path.join(ROOT, '..'), os.homedir()]) {
    let names = [];
    try { names = fs.readdirSync(base); } catch { continue; }
    for (const n of names.filter((n) => n.toLowerCase().startsWith('ffmpeg')).sort().reverse()) {
      const d = path.join(base, n);
      if (hasFfmpeg(d)) return d;
      let inner = [];
      try { inner = fs.readdirSync(d); } catch { continue; }
      for (const m of inner.sort().reverse()) {
        if (hasFfmpeg(path.join(d, m))) return path.join(d, m);
      }
    }
  }
  return undefined;
}

let found;

export function ffmpegLibsFound() {
  if (process.env.MOZCUT_NO_FFMPEG === '1') return false;
  if (found !== undefined) return found;
  found = false;
  if (!process.env.UM_FFMPEG_HOME) {
    const d = findFfmpegHome();
    if (d) process.env.UM_FFMPEG_HOME = d;
  }
  const home = process.env.UM_FFMPEG_HOME;
  if (home) {
    found = fs.existsSync(path.join(home, 'include', 'libavformat', 'avformat.h'));
    return found;
  }
  if (process.platform !== 'win32') {
    const r = spawnSync('pkg-config', ['--exists', 'libavformat', 'libavcodec', 'libswscale', 'libswresample', 'libavutil']);
    if (!r.error && r.status === 0) {
      found = true;
      return found;
    }
    if (process.platform === 'darwin') {
      found = ['/opt/homebrew/opt/ffmpeg', '/usr/local/opt/ffmpeg'].some((p) => fs.existsSync(path.join(p, 'include', 'libavformat', 'avformat.h')));
    }
  }
  return found;
}

// src/ の写し（dir）の ffmpeg.um を、FFmpeg なしの版（ffmpeg_off.um）で置き換える。
export function useFfmpegOff(dir) {
  fs.copyFileSync(path.join(dir, 'engine', 'ffmpeg_off.um'), path.join(dir, 'engine', 'ffmpeg.um'));
}
