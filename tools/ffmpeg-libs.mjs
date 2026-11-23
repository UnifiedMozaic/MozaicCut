// FFmpeg のライブラリ（UM の動画・音声の組み込みがリンクするもの）が見つかるかを調べ、見つからなければ
// src/ の写しの engine/ffmpeg.um を engine/ffmpeg_off.um に差し替える。tools/mozcut.mjs の build と、テストのビルドが使う。
//
// 探し方は UnifiedMozaic のドライバ（src/driver.ts の findFfmpeg）と同じ順: 環境変数 UM_FFMPEG_HOME
// （include/libavformat/avformat.h がある場所）→ pkg-config の libavformat → Homebrew の決まった場所。
// 環境変数 MOZCUT_NO_FFMPEG=1 なら、見つかっても使わない（予備の経路を試すため）。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

let found;

export function ffmpegLibsFound() {
  if (process.env.MOZCUT_NO_FFMPEG === '1') return false;
  if (found !== undefined) return found;
  found = false;
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
