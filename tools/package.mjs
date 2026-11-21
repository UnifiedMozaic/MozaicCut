// node tools/mozcut.mjs package: 配布の形（dist/MozaicCut/）を作る。exe をダブルクリックするだけで使えるように、
// 新しい編集画面の exe（MozaicCut.exe）と、それが読み込む DLL・tokens.json・アイコン・説明書・ライセンスの文書を 1 つのフォルダに集める。
//
//   dist/MozaicCut/
//     MozaicCut.exe            build/mozcut-edit.exe（コンソールの窓なし、アイコン入り。FFmpeg の組み込みあり）
//     *.dll                    exe が読み込む DLL（PE の import をたどって、build/ にあるものだけ。Windows の DLL は入れない）
//     MozaicCut.ico            アイコン（.mzc の関連付けを手で設定するときに使える）
//     resources/tokens.json    画面の色と大きさ（docs/design/tokens.json）
//     README.txt               使い方（起動、.mzc の開き方と関連付けの手順、設定の置き場所、書き出せる形式）
//     THIRD-PARTY-NOTICES.txt  使っている部品とライセンス、FFmpeg（LGPL）の元のソースの入手先と DLL の差し替え方
//     licenses/                ライセンスの全文（FFmpeg の LGPL v3 と GPL v3、SDL3、wasmtime など）
//
// 効果（plugins/*.um の 13 個）は exe に組み込まれている。フォントは Windows のもの（Yu Gothic UI など）を使うので入れない。
// レジストリは書かない（.mzc の関連付けは README.txt に手順を書くだけ）。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// PE（exe / dll）が読み込む DLL の名前（import と遅延 import）。読めなければ []。
export function peImports(file) {
  let b;
  try {
    b = fs.readFileSync(file);
  } catch {
    return [];
  }
  if (b.length < 0x40 || b.readUInt16LE(0) !== 0x5a4d) return [];
  const pe = b.readUInt32LE(0x3c);
  if (b.readUInt32LE(pe) !== 0x4550) return [];
  const nsec = b.readUInt16LE(pe + 6);
  const optSize = b.readUInt16LE(pe + 20);
  const opt = pe + 24;
  const plus = b.readUInt16LE(opt) === 0x20b;
  const dirs = opt + (plus ? 112 : 96);
  const secs = opt + optSize;
  const toOff = (rva) => {
    for (let i = 0; i < nsec; i++) {
      const s = secs + i * 40;
      const va = b.readUInt32LE(s + 12);
      const size = Math.max(b.readUInt32LE(s + 8), b.readUInt32LE(s + 16));
      if (rva >= va && rva < va + size) return rva - va + b.readUInt32LE(s + 20);
    }
    return -1;
  };
  const cstr = (rva) => {
    const o = toOff(rva);
    if (o < 0) return null;
    const end = b.indexOf(0, o);
    return b.toString('latin1', o, end < 0 ? b.length : end);
  };
  const names = [];
  // [データディレクトリの番号, 記述子の大きさ, 名前の RVA の位置]: 1 = import、13 = 遅延 import
  for (const [idx, size, nameAt] of [[1, 20, 12], [13, 32, 4]]) {
    const rva = b.readUInt32LE(dirs + idx * 8);
    if (!rva) continue;
    let o = toOff(rva);
    if (o < 0) continue;
    for (; o + size <= b.length; o += size) {
      const n = b.readUInt32LE(o + nameAt);
      if (!n) break;
      const s = cstr(n);
      if (s) names.push(s);
    }
  }
  return names;
}

// exe から import をたどり、dir（build/）にある DLL を集める（大文字・小文字は区別しない）。
export function bundledDlls(exe, dir) {
  const have = new Map();
  for (const n of fs.readdirSync(dir)) if (/\.dll$/i.test(n)) have.set(n.toLowerCase(), n);
  const found = new Set();
  const todo = [exe];
  while (todo.length) {
    for (const imp of peImports(todo.pop())) {
      const real = have.get(imp.toLowerCase());
      if (real && !found.has(real)) {
        found.add(real);
        todo.push(path.join(dir, real));
      }
    }
  }
  return [...found].sort();
}

const crlf = (s) => s.replace(/\r?\n/g, '\r\n');

function readmeText(dlls) {
  return crlf(`MozaicCut（動画編集ソフト）

■ 起動
  MozaicCut.exe をダブルクリックします。スタート画面が出て、最近開いたプロジェクトを選ぶか、新しく作れます。
  このフォルダ（MozaicCut.exe と DLL、resources）は、まとめて同じ場所に置いたままにしてください。
  node や ffmpeg のコマンドは要りません。

■ プロジェクト（.mzc）を開く
  - .mzc のファイルを MozaicCut.exe（かそのショートカット）にドラッグして落とす
  - .mzc を右クリック →［プログラムから開く］→［別のプログラムを選択］→［PC でアプリを選ぶ］で MozaicCut.exe を選ぶ
  - 起動しているスタート画面の窓に .mzc を落とす

■ .mzc をダブルクリックで開けるようにする（関連付け。手で 1 回だけ設定します）
  MozaicCut はレジストリを書き換えません。次の手順で Windows に覚えさせます。
  1. エクスプローラーで .mzc のファイルを右クリックし、［プログラムから開く］→［別のプログラムを選択］を選ぶ
  2. 一覧の下の［PC でアプリを選ぶ］（または［その他のアプリ］→［この PC で別のアプリを探す］）で、
     このフォルダの MozaicCut.exe を選ぶ
  3. ［常に使う］（または［常にこのアプリを使って .mzc ファイルを開く］）を選ぶ
  やめるときは、Windows の［設定］→［アプリ］→［既定のアプリ］で .mzc の既定を変えます。
  MozaicCut のフォルダを動かしたら、もう一度この手順で選び直してください。

■ 設定と最近の一覧の置き場所
  %APPDATA%\\MozaicCut\\mozcut-recent.txt（このフォルダには書きません）。
  ダブルクリックで起動したときの新しいプロジェクトの既定の保存場所は「ドキュメント\\MozaicCut」です。
  プロジェクトの素材の読み込みの途中のもの（キャッシュ）は、.mzc の隣の <名前>.cache フォルダに置きます。

■ 書き出せる形式（「出力」のワークスペース）
  MP4（H.264 + AAC。YouTube・SNS・Web 向けのプリセット）、ProRes 422 HQ（.mov、PCM 24 ビット）、
  音だけ（WAV の PCM 24 ビット、M4A の AAC）。どれも MozaicCut.exe の中の FFmpeg で書き出します。
  H.264 の圧縮は、使える GPU の符号器（NVIDIA・AMD・Intel）か Windows の Media Foundation を使います。

■ まだできないこと
  - ファイルを選ぶ画面（［開く…］Ctrl+O）。.mzc は上のドラッグか［プログラムから開く］で開きます
  - 自分で作った効果のプラグイン（.mzplug）の読み込み（組み込みの 13 個の効果は使えます）
  - AI の欄（node の tools/mcp-server.mjs が要ります）

■ 中身
  MozaicCut.exe、${dlls.join('、')}、MozaicCut.ico、resources/tokens.json、
  THIRD-PARTY-NOTICES.txt（使っている部品とライセンス）、licenses/（ライセンスの全文）
`);
}

function noticesText(parts, ffmpegInfo) {
  const lines = [];
  lines.push('MozaicCut が使っている部品とライセンス');
  lines.push('');
  lines.push('MozaicCut.exe は UnifiedMozaic（https://github.com/UnifiedMozaic/UnifiedMozaic、MIT か Apache-2.0）でビルドしています。');
  lines.push('次の部品を、このフォルダの DLL として動的にリンクしています。ライセンスの全文は licenses/ にあります。');
  lines.push('');
  for (const p of parts) {
    lines.push(`■ ${p.name}`);
    for (const l of p.lines) lines.push(`  ${l}`);
    lines.push('');
  }
  if (ffmpegInfo) {
    lines.push('■ FFmpeg のビルドの構成（ffmpeg -version）');
    for (const l of ffmpegInfo.split(/\r?\n/).slice(0, 3)) lines.push(`  ${l}`);
    lines.push('  この構成は --enable-gpl を含まず、--enable-version3 なので、LGPL version 3 以降です。');
    lines.push('  構成にある外部のライブラリ（dav1d、OpenH264、libaom など）は FFmpeg の DLL に静的に入っています。');
    lines.push('  それぞれのライセンスは、上の入手先のビルドの説明（BtbN/FFmpeg-Builds）を見てください。');
    lines.push('');
  }
  return crlf(lines.join('\n'));
}

// opts: { root, build, editorExe, ffmpegHome, sdl3Home, wasmtimeHome, wgpuHome, out }
export function makePackage(opts) {
  const out = opts.out;
  const exe = opts.editorExe;
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(path.join(out, 'resources'), { recursive: true });
  fs.mkdirSync(path.join(out, 'licenses'), { recursive: true });
  fs.copyFileSync(exe, path.join(out, 'MozaicCut.exe'));
  const dlls = bundledDlls(exe, opts.build);
  for (const d of dlls) fs.copyFileSync(path.join(opts.build, d), path.join(out, d));
  fs.copyFileSync(path.join(opts.root, 'docs', 'design', 'tokens.json'), path.join(out, 'resources', 'tokens.json'));
  fs.copyFileSync(path.join(opts.root, 'assets', 'icon', 'mozaiccut.ico'), path.join(out, 'MozaicCut.ico'));

  const has = (re) => dlls.some((d) => re.test(d));
  const copyLicense = (from, name) => {
    if (from && fs.existsSync(from)) {
      fs.copyFileSync(from, path.join(out, 'licenses', name));
      return `licenses/${name}`;
    }
    return null;
  };
  const parts = [];
  const missing = [];
  if (has(/^av(codec|format|util)-|^sw(scale|resample)-/i)) {
    const lic = copyLicense(opts.ffmpegHome && path.join(opts.ffmpegHome, 'LICENSE.txt'), 'FFmpeg-LGPL-3.0.txt');
    if (!lic) missing.push('FFmpeg の LICENSE.txt（UM_FFMPEG_HOME）');
    copyLicense(path.join(opts.root, 'assets', 'licenses', 'GPL-3.0.txt'), 'GPL-3.0.txt');
    const ver = opts.ffmpegHome ? path.basename(opts.ffmpegHome) : '（不明）';
    parts.push({
      name: `FFmpeg（${dlls.filter((d) => /^(av|sw)/i.test(d)).join('、')}）`,
      lines: [
        'ライセンス: GNU LGPL version 3 以降（licenses/FFmpeg-LGPL-3.0.txt。LGPL v3 は GPL v3 に許可を足したものなので、',
        '  licenses/GPL-3.0.txt も添えています）',
        `ビルド: ${ver}（BtbN の LGPL・共有ライブラリのビルド）`,
        '元のソースの入手先:',
        '  FFmpeg のソース: https://ffmpeg.org/download.html （git: https://git.ffmpeg.org/ffmpeg.git の n9.0 の版）',
        '  ビルドの手順と、静的に入っている外部のライブラリのソース: https://github.com/BtbN/FFmpeg-Builds',
        '  （このフォルダを配る人へ: GPL v3 の 6 節により、配った DLL に対応するソースを受け取れるようにしておく必要があります。',
        '   上の入手先が使えなくなったときに備えて、同じ版のソースの写しを一緒に置いておくと確実です）',
        'DLL の差し替え: FFmpeg の DLL は MozaicCut.exe と別のファイルです。同じ版（avcodec-63 など同じ名前・同じ ABI）の',
        '  LGPL のビルドの DLL で、このフォルダのものを置き換えて使えます。',
      ],
    });
  }
  if (has(/^SDL3\.dll$/i)) {
    const lic = copyLicense(opts.sdl3Home && path.join(opts.sdl3Home, 'LICENSE.txt'), 'SDL3-zlib.txt');
    if (!lic) missing.push('SDL3 の LICENSE.txt（UM_SDL3）');
    parts.push({ name: `SDL3（SDL3.dll、${opts.sdl3Home ? path.basename(opts.sdl3Home) : '版は不明'}）`, lines: ['ライセンス: zlib（licenses/SDL3-zlib.txt）', 'https://libsdl.org/'] });
  }
  if (has(/^wasmtime\.dll$/i)) {
    const lic = copyLicense(opts.wasmtimeHome && path.join(opts.wasmtimeHome, 'LICENSE'), 'wasmtime-Apache-2.0.txt');
    if (!lic) missing.push('wasmtime の LICENSE（UM_WASMTIME）');
    parts.push({ name: `wasmtime（wasmtime.dll、${opts.wasmtimeHome ? path.basename(opts.wasmtimeHome) : '版は不明'}）`, lines: ['ライセンス: Apache-2.0 WITH LLVM-exception（licenses/wasmtime-Apache-2.0.txt）', 'https://github.com/bytecodealliance/wasmtime'] });
  }
  if (has(/^wgpu_native\.dll$/i)) {
    const lic = copyLicense(opts.wgpuHome && ['LICENSE', 'LICENSE.APACHE', 'LICENSE.MIT'].map((n) => path.join(opts.wgpuHome, n)).find((f) => fs.existsSync(f)), 'wgpu-native-LICENSE.txt');
    parts.push({ name: 'wgpu-native（wgpu_native.dll）', lines: [`ライセンス: MIT か Apache-2.0${lic ? `（${lic}）` : '（全文: https://github.com/gfx-rs/wgpu-native）'}`, 'https://github.com/gfx-rs/wgpu-native'] });
  }
  let ffmpegInfo = '';
  const ffexe = opts.ffmpegHome && path.join(opts.ffmpegHome, 'bin', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
  if (ffexe && fs.existsSync(ffexe)) {
    const r = spawnSync(ffexe, ['-hide_banner', '-version'], { encoding: 'utf8' });
    if (r.status === 0) ffmpegInfo = r.stdout.trim();
  }
  fs.writeFileSync(path.join(out, 'THIRD-PARTY-NOTICES.txt'), noticesText(parts, ffmpegInfo));
  fs.writeFileSync(path.join(out, 'README.txt'), readmeText(dlls));
  return { out, dlls, missing };
}
