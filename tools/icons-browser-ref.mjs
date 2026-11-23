#!/usr/bin/env node
// アイコンの形を、gen-icons.mjs の読み取りとは別の実装（Chromium の SVG の描画 = モックアップを表示する描画）で
// 「見本の格子」にする。モックアップの <symbol> の元の文字列をそのまま HTML に入れ、ヘッドレスのブラウザ
// （Edge か Chrome。窓は出さない）で撮り、ffmpeg で BMP にする。gen-icons.mjs --compare で UM の --sheet と比べる。
//
//   node tools/icons-browser-ref.mjs --out browser.bmp [--sizes 16,20,24] [--cols 12] [--src <モックアップ>] [--browser <exe>]
//
// 並びは gen-icons.mjs --ref・demos/icons_demo.um の --sheet と同じ（番号の表の順。セル = S + 2·round(S/2)、cols 列）。
// 黒地に白（currentColor = #fff）で描くので、画素の値 ≒ 被覆率。Chromium は縁のなだらかさの付け方が違うので、
// 縁で 1 割ほどの差は出る。形の読み違い（円弧の旗・相対の書き方・S/T・rx）は、はっきりした差として出る。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { collect, defaultSrc, listHtml, readOrder, resolveOrder, sheetLayout, ORDER_FILE, readBmp, writeBmp } from './gen-icons.mjs';

function die(msg) {
  console.error(`icons-browser-ref: ${msg}`);
  process.exit(1);
}

function findBrowser() {
  const c = [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    '/usr/bin/chromium',
    '/usr/bin/google-chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ];
  for (const f of c) if (fs.existsSync(f)) return f;
  return null;
}

function main() {
  const argv = process.argv.slice(2);
  const srcs = [];
  let out = null;
  let sizes = [16, 20, 24];
  let cols = 12;
  let browser = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--src') srcs.push(argv[++i]);
    else if (a === '--out') out = argv[++i];
    else if (a === '--sizes') sizes = argv[++i].split(',').map((s) => parseInt(s, 10));
    else if (a === '--cols') cols = parseInt(argv[++i], 10);
    else if (a === '--browser') browser = argv[++i];
    else die(`知らない引数 ${a}`);
  }
  if (!out) die('--out <bmp> が要る');
  browser = browser || findBrowser();
  if (!browser) die('Edge / Chrome が見つからない（--browser で渡す）');
  if (srcs.length === 0) srcs.push(defaultSrc());
  const files = listHtml(srcs).filter((f) => !/\.dc\.html$/i.test(f));
  const { icons } = collect(files);
  const { order } = resolveOrder(readOrder(ORDER_FILE), icons);
  // .ic の CSS は最初のモックアップから（線の太さ・端・角）
  const html0 = fs.readFileSync(files[0], 'utf8');
  const icCss = (html0.match(/\.ic\s*\{[^}]*\}/) || ['.ic{fill:none;stroke:currentColor;stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round}'])[0];
  const lay = sheetLayout(order.length, sizes, cols);
  const L = [];
  L.push('<!doctype html><html><head><meta charset="utf-8"><style>');
  L.push('html,body{margin:0;padding:0;background:#000;overflow:hidden}');
  L.push(icCss);
  L.push('.ic{position:absolute;color:#fff;display:block}');
  L.push('</style></head><body>');
  L.push('<svg width="0" height="0" style="position:absolute"><defs>');
  for (const n of order) {
    const ic = icons.get('i-' + n);
    if (ic) L.push(ic.raw);
  }
  L.push('</defs></svg>');
  for (const b of lay.blocks) {
    order.forEach((n, k) => {
      if (!icons.has('i-' + n)) return;
      const x = (k % cols) * b.cell + b.pad;
      const y = b.y + Math.floor(k / cols) * b.cell + b.pad;
      L.push(`<svg class="ic" style="left:${x}px;top:${y}px;width:${b.S}px;height:${b.S}px"><use href="#i-${n}"/></svg>`);
    });
  }
  L.push('</body></html>');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'icons-ref-'));
  const htmlFile = path.join(tmp, 'sheet.html');
  const png = path.join(tmp, 'sheet.png');
  fs.writeFileSync(htmlFile, L.join('\n'));
  try {
    execFileSync(
      browser,
      [
        '--headless=new',
        '--disable-gpu',
        '--hide-scrollbars',
        '--force-device-scale-factor=1',
        '--no-first-run',
        '--no-default-browser-check',
        `--user-data-dir=${path.join(tmp, 'profile')}`,
        `--window-size=${lay.W},${lay.H}`,
        `--screenshot=${png}`,
        'file:///' + htmlFile.replace(/\\/g, '/'),
      ],
      { stdio: 'ignore', timeout: 60000 },
    );
  } catch (e) {
    if (!fs.existsSync(png)) die(`ブラウザで撮れなかった: ${e.message}`);
  }
  if (!fs.existsSync(png)) die('ブラウザが画像を書かなかった');
  const bmp = path.join(tmp, 'sheet.bmp');
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', png, '-pix_fmt', 'bgra', bmp], { stdio: 'inherit' });
  const g = readBmp(bmp);
  // 窓の大きさが違って撮れることがあるので、格子の大きさに切る
  const rgb = new Uint32Array(lay.W * lay.H);
  for (let y = 0; y < Math.min(lay.H, g.H); y++) {
    for (let x = 0; x < Math.min(lay.W, g.W); x++) {
      const v = g.gray[y * g.W + x];
      rgb[y * lay.W + x] = (v << 16) | (v << 8) | v;
    }
  }
  writeBmp(out, lay.W, lay.H, rgb);
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`icons-browser-ref: ${order.length} 個 × 大きさ ${sizes.join('/')} を ${browser} で撮り、${out} に書きました（${lay.W}×${lay.H}、撮った画像 ${g.W}×${g.H}）`);
}

main();
