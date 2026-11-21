#!/usr/bin/env node
// アプリのアイコンを作る。node tools/gen-icon.mjs
//
// 元: assets/icon/mozaiccut.svg（48px 以上）と assets/icon/mozaiccut-small.svg（32px 以下。線を太く、クリップを 1 段に）
// 出力（assets/icon/ に書く。生成物なので手で直さない）:
//   png/mozaiccut-<大きさ>.png   16, 24, 32, 48, 64, 128, 256, 512, 1024
//   mozaiccut.ico                Windows（16〜256 の PNG を入れた ICO）
//   mozaiccut.icns               macOS（16〜1024 の PNG を入れた ICNS）
//   src/gen/app_icon.um          窓のアイコンの画素（png/mozaiccut-64.png を 0xAARRGGBB の定数の表にしたもの。windowSetIcon に渡す）
//
// node tools/gen-icon.mjs --um は、今ある png/mozaiccut-64.png から src/gen/app_icon.um だけを作り直す（Chrome は要らない）。
// SVG を画素にするのには、ヘッドレスの Chrome か Edge を使う（窓は出ない）。見つからなければ環境変数 MOZCUT_CHROME で指定する。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import zlib from 'node:zlib';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'assets', 'icon');
const SIZES = [16, 24, 32, 48, 64, 128, 256, 512, 1024];
const SMALL_MAX = 32;

function findChrome() {
  if (process.env.MOZCUT_CHROME) return process.env.MOZCUT_CHROME;
  const cands = process.platform === 'win32'
    ? ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe']
    : process.platform === 'darwin'
      ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']
      : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  for (const c of cands) if (fs.existsSync(c)) return c;
  console.error('gen-icon: Chrome か Edge が見つかりません。環境変数 MOZCUT_CHROME にその場所を設定してください');
  process.exit(1);
}

function render(chrome, svg, size, out, tmp) {
  const html = path.join(tmp, `icon-${size}.html`);
  fs.writeFileSync(html, `<!doctype html><html><head><style>html,body{margin:0;background:transparent;overflow:hidden}img{display:block;width:${size}px;height:${size}px}</style></head><body><img src="${pathToFileURL(svg).href}"></body></html>`);
  const r = spawnSync(chrome, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
    `--user-data-dir=${path.join(tmp, 'profile')}`, '--force-device-scale-factor=1',
    '--default-background-color=00000000', `--window-size=${size},${size}`, `--screenshot=${out}`, pathToFileURL(html).href,
  ], { stdio: ['ignore', 'ignore', 'pipe'], timeout: 60000 });
  if (!fs.existsSync(out)) {
    console.error(`gen-icon: ${size}px の画像を作れませんでした\n${r.stderr}`);
    process.exit(1);
  }
}

// PNG の頭から幅と高さを読む（確かめ用）
function pngSize(buf) {
  return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
}

// ICO: 頭（6 バイト）+ 項目（16 バイト × 枚数）+ PNG の中身。256 の大きさは 0 と書く
function makeIco(pngs) {
  const head = Buffer.alloc(6);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(pngs.length, 4);
  const entries = [];
  let off = 6 + 16 * pngs.length;
  for (const { size, data } of pngs) {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0); e.writeUInt8(size >= 256 ? 0 : size, 1);
    e.writeUInt8(0, 2); e.writeUInt8(0, 3); e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6);
    e.writeUInt32LE(data.length, 8); e.writeUInt32LE(off, 12);
    entries.push(e); off += data.length;
  }
  return Buffer.concat([head, ...entries, ...pngs.map(p => p.data)]);
}

// ICNS: 'icns' + 全体の長さ、続けて（型 4 文字 + 長さ + PNG）の並び
const ICNS_TYPES = { 16: 'icp4', 32: 'icp5', 64: 'icp6', 128: 'ic07', 256: 'ic08', 512: 'ic09', 1024: 'ic10' };
function makeIcns(pngs) {
  const chunks = [];
  for (const { size, data } of pngs) {
    const t = ICNS_TYPES[size];
    if (!t) continue;
    const h = Buffer.alloc(8);
    h.write(t, 0, 'ascii'); h.writeUInt32BE(8 + data.length, 4);
    chunks.push(h, data);
  }
  const body = Buffer.concat(chunks);
  const h = Buffer.alloc(8);
  h.write('icns', 0, 'ascii'); h.writeUInt32BE(8 + body.length, 4);
  return Buffer.concat([h, body]);
}

// PNG（8 ビット、RGBA か RGB、飛び越しなし）を読み、0xAARRGGBB の並びにする。
function decodePng(buf) {
  const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20), depth = buf[24], type = buf[25], interlace = buf[28];
  if (depth !== 8 || (type !== 6 && type !== 2) || interlace !== 0) {
    throw new Error(`読めない PNG です（ビットの深さ ${depth}、色の型 ${type}、飛び越し ${interlace}）`);
  }
  const idat = [];
  for (let off = 8; off < buf.length;) {
    const len = buf.readUInt32BE(off), kind = buf.toString('ascii', off + 4, off + 8);
    if (kind === 'IDAT') idat.push(buf.subarray(off + 8, off + 8 + len));
    off += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bpp = type === 6 ? 4 : 3, stride = w * bpp;
  const cur = Buffer.alloc(stride), prev = Buffer.alloc(stride);
  const out = new Uint32Array(w * h);
  for (let y = 0; y < h; y++) {
    const ft = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
      let p = 0;
      if (ft === 1) p = a;
      else if (ft === 2) p = b;
      else if (ft === 3) p = (a + b) >> 1;
      else if (ft === 4) {
        const q = a + b - c, pa = Math.abs(q - a), pb = Math.abs(q - b), pc = Math.abs(q - c);
        p = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[i] = (line[i] + p) & 255;
    }
    for (let x = 0; x < w; x++) {
      const i = x * bpp, al = bpp === 4 ? cur[i + 3] : 255;
      out[y * w + x] = ((al << 24) | (cur[i] << 16) | (cur[i + 1] << 8) | cur[i + 2]) >>> 0;
    }
    cur.copy(prev);
  }
  return { w, h, px: out };
}

// 窓のアイコンの画素の表（src/gen/app_icon.um）を書く。UM には PNG を読む口がないので、定数の配列にして埋め込む。
const ICON_UM_SIZE = 64;
function writeIconUm() {
  const src = path.join(DIR, 'png', `mozaiccut-${ICON_UM_SIZE}.png`);
  const { w, h, px } = decodePng(fs.readFileSync(src));
  if (w !== ICON_UM_SIZE || h !== ICON_UM_SIZE) throw new Error(`${src} が ${w}×${h} です（${ICON_UM_SIZE}×${ICON_UM_SIZE} のはず）`);
  const rows = [];
  for (let y = 0; y < h; y++) {
    const r = [];
    for (let x = 0; x < w; x++) r.push('0x' + px[y * w + x].toString(16).toUpperCase().padStart(8, '0'));
    rows.push('  ' + r.join(', ') + ',');
  }
  const text = `// 生成物: tools/gen-icon.mjs が assets/icon/png/mozaiccut-${ICON_UM_SIZE}.png から作る。手で書き換えない（node tools/gen-icon.mjs --um で作り直す）。
// 窓のアイコンの画素。0xAARRGGBB を左上から行の順に ${w}×${h} 個（windowSetIcon / windowPresent と同じ並び）。

export const APP_ICON_W: i32 = ${w};
export const APP_ICON_H: i32 = ${h};
export const APP_ICON_PX: u32[${w * h}] = [
${rows.join('\n')}
];
`;
  const out = path.join(ROOT, 'src', 'gen', 'app_icon.um');
  fs.writeFileSync(out, text);
  return out;
}

if (process.argv.includes('--um')) {
  const out = writeIconUm();
  console.log(`gen-icon: ${path.relative(ROOT, out)} を書きました`);
  process.exit(0);
}

const chrome = findChrome();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mozcut-icon-'));
fs.mkdirSync(path.join(DIR, 'png'), { recursive: true });
const pngs = [];
try {
  for (const size of SIZES) {
    const svg = path.join(DIR, size <= SMALL_MAX ? 'mozaiccut-small.svg' : 'mozaiccut.svg');
    const out = path.join(DIR, 'png', `mozaiccut-${size}.png`);
    fs.rmSync(out, { force: true });
    render(chrome, svg, size, out, tmp);
    const data = fs.readFileSync(out);
    const [w, h] = pngSize(data);
    if (w !== size || h !== size) {
      console.error(`gen-icon: ${size}px のはずが ${w}×${h} になりました`);
      process.exit(1);
    }
    pngs.push({ size, data });
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
fs.writeFileSync(path.join(DIR, 'mozaiccut.ico'), makeIco(pngs.filter(p => p.size <= 256)));
fs.writeFileSync(path.join(DIR, 'mozaiccut.icns'), makeIcns(pngs));
writeIconUm();
console.log(`gen-icon: ${SIZES.length} 枚の PNG と mozaiccut.ico・mozaiccut.icns を assets/icon/ に、窓のアイコンの画素を src/gen/app_icon.um に書きました`);
