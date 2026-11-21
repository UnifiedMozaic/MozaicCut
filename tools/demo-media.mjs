#!/usr/bin/env node
// demo/demo.mzc で使う素材を ffmpeg の合成音源・映像で作る（リポジトリには素材を入れていない）。
//   node tools/demo-media.mjs
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'demo', 'media');
const FFMPEG = process.env.FFMPEG || 'ffmpeg';
fs.mkdirSync(OUT, { recursive: true });

const jobs = [
  ['clip_a.mp4', ['-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
    '-t', '6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac']],
  ['clip_b.mp4', ['-f', 'lavfi', '-i', 'mandelbrot=size=960x540:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=660:sample_rate=44100',
    '-t', '6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac']],
  ['logo.png', ['-f', 'lavfi', '-i', "color=c=0x00000000:size=200x200,format=rgba,geq=r='255':g='180':b='40':a='if(lt(hypot(X-100,Y-100),90),255,0)'",
    '-frames:v', '1']],
  ['bgm.wav', ['-f', 'lavfi', '-i', 'sine=frequency=220:sample_rate=48000', '-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=48000',
    '-filter_complex', 'amix=inputs=2', '-t', '20']],
];

for (const [name, args] of jobs) {
  const r = spawnSync(FFMPEG, ['-v', 'error', '-y', ...args, path.join(OUT, name)], { stdio: 'inherit' });
  if (r.error || r.status !== 0) {
    console.error(`failed to make ${name}${r.error ? `: ${r.error.message}` : ''}`);
    process.exit(1);
  }
  console.error(`made demo/media/${name}`);
}
