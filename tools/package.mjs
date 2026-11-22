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
// macOS では、代わりに dist/MozaicCut.app を作る（ファイルの最後の makeMacApp）。
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

// mac なら .app の中の dylib の言い方にする（Windows の文は変えない）。
function noticesText(parts, ffmpegInfo, mac = false) {
  const lines = [];
  lines.push('MozaicCut が使っている部品とライセンス');
  lines.push('');
  lines.push(`${mac ? 'MozaicCut.app' : 'MozaicCut.exe'} は UnifiedMozaic（https://github.com/UnifiedMozaic/UnifiedMozaic、MIT か Apache-2.0）でビルドしています。`);
  lines.push(mac
    ? '次の部品を、MozaicCut.app の Contents/Frameworks の dylib として動的にリンクしています。ライセンスの全文は Contents/Resources/licenses/ にあります。'
    : '次の部品を、このフォルダの DLL として動的にリンクしています。ライセンスの全文は licenses/ にあります。');
  lines.push('');
  for (const p of parts) {
    lines.push(`■ ${p.name}`);
    for (const l of p.lines) lines.push(`  ${l}`);
    lines.push('');
  }
  if (ffmpegInfo) {
    lines.push('■ FFmpeg のビルドの構成（ffmpeg -version）');
    for (const l of ffmpegInfo.split(/\r?\n/).slice(0, 3)) lines.push(`  ${l}`);
    if (/--enable-gpl\b/.test(ffmpegInfo)) {
      lines.push('  注意: この構成は --enable-gpl を含むので、GPL です（配るなら LGPL の構成のビルドに替えてください）。');
    } else {
      lines.push('  この構成は --enable-gpl を含まず、--enable-version3 なので、LGPL version 3 以降です。');
    }
    if (mac) {
      lines.push('  構成は docs/build-mac.md の手順（外部のライブラリを使わず、OS の VideoToolbox と AudioToolbox を使う）です。');
    } else {
      lines.push('  構成にある外部のライブラリ（dav1d、OpenH264、libaom など）は FFmpeg の DLL に静的に入っています。');
      lines.push('  それぞれのライセンスは、上の入手先のビルドの説明（BtbN/FFmpeg-Builds）を見てください。');
    }
    lines.push('');
  }
  return crlf(lines.join('\n'));
}

// 部品のライセンスの全文を <dir>/licenses/ に写し、<dir>/THIRD-PARTY-NOTICES.txt を書く。
// libs は集めたライブラリの名前（Windows は SDL3.dll など、mac は libSDL3.0.dylib など）。見つからなかった文書の一覧を返す。
function writeNotices(opts, libs, dir, mac) {
  fs.mkdirSync(path.join(dir, 'licenses'), { recursive: true });
  const has = (re) => libs.some((d) => re.test(d));
  const firstFile = (home, names) => home && names.map((n) => path.join(home, n)).find((f) => fs.existsSync(f));
  const copyLicense = (from, name) => {
    if (from && fs.existsSync(from)) {
      fs.copyFileSync(from, path.join(dir, 'licenses', name));
      return `licenses/${name}`;
    }
    return null;
  };
  const libWord = mac ? 'dylib' : 'DLL';
  const parts = [];
  const missing = [];
  if (has(/^(lib)?(av(codec|format|util)|sw(scale|resample))[-.]/i)) {
    const lic = copyLicense(firstFile(opts.ffmpegHome, ['LICENSE.txt', 'LICENSE.md', 'COPYING.LGPLv3']), 'FFmpeg-LGPL-3.0.txt');
    if (!lic) missing.push('FFmpeg の LICENSE.txt（UM_FFMPEG_HOME）');
    copyLicense(path.join(opts.root, 'assets', 'licenses', 'GPL-3.0.txt'), 'GPL-3.0.txt');
    const ver = opts.ffmpegHome ? path.basename(opts.ffmpegHome) : '（不明）';
    parts.push({
      name: `FFmpeg（${libs.filter((d) => /^(lib)?(av|sw)/i.test(d)).join('、')}）`,
      lines: [
        'ライセンス: GNU LGPL version 3 以降（licenses/FFmpeg-LGPL-3.0.txt。LGPL v3 は GPL v3 に許可を足したものなので、',
        '  licenses/GPL-3.0.txt も添えています）',
        mac ? `ビルド: ${ver}（FFmpeg の n9.0 のソースから、LGPL・共有ライブラリの構成でビルドしたもの）` : `ビルド: ${ver}（BtbN の LGPL・共有ライブラリのビルド）`,
        '元のソースの入手先:',
        '  FFmpeg のソース: https://ffmpeg.org/download.html （git: https://git.ffmpeg.org/ffmpeg.git の n9.0 の版）',
        ...(mac ? [] : ['  ビルドの手順と、静的に入っている外部のライブラリのソース: https://github.com/BtbN/FFmpeg-Builds']),
        `  （${mac ? 'この .app' : 'このフォルダ'}を配る人へ: GPL v3 の 6 節により、配った ${libWord} に対応するソースを受け取れるようにしておく必要があります。`,
        '   上の入手先が使えなくなったときに備えて、同じ版のソースの写しを一緒に置いておくと確実です）',
        ...(mac ? [
          'dylib の差し替え: FFmpeg の dylib は MozaicCut と別のファイルです（Contents/Frameworks）。同じ版（libavcodec.63 など同じ名前・',
          '  同じ ABI）の LGPL のビルドの dylib で置き換えて使えます。置き換えたら codesign --force --deep --sign - MozaicCut.app で署名し直します。',
        ] : [
          'DLL の差し替え: FFmpeg の DLL は MozaicCut.exe と別のファイルです。同じ版（avcodec-63 など同じ名前・同じ ABI）の',
          '  LGPL のビルドの DLL で、このフォルダのものを置き換えて使えます。',
        ]),
      ],
    });
  }
  const sdl = libs.find((d) => /^(SDL3\.dll|libSDL3[.\d]*\.dylib)$/i.test(d));
  if (sdl) {
    const lic = copyLicense(firstFile(opts.sdl3Home, ['LICENSE.txt', 'share/licenses/SDL3/LICENSE.txt']), 'SDL3-zlib.txt');
    if (!lic) missing.push('SDL3 の LICENSE.txt（UM_SDL3）');
    parts.push({ name: `SDL3（${sdl}、${opts.sdl3Home ? path.basename(opts.sdl3Home) : '版は不明'}）`, lines: ['ライセンス: zlib（licenses/SDL3-zlib.txt）', 'https://libsdl.org/'] });
  }
  const wt = libs.find((d) => /^(lib)?wasmtime\.(dll|dylib)$/i.test(d));
  if (wt) {
    const lic = copyLicense(opts.wasmtimeHome && path.join(opts.wasmtimeHome, 'LICENSE'), 'wasmtime-Apache-2.0.txt');
    if (!lic) missing.push('wasmtime の LICENSE（UM_WASMTIME）');
    parts.push({ name: `wasmtime（${wt}、${opts.wasmtimeHome ? path.basename(opts.wasmtimeHome) : '版は不明'}）`, lines: ['ライセンス: Apache-2.0 WITH LLVM-exception（licenses/wasmtime-Apache-2.0.txt）', 'https://github.com/bytecodealliance/wasmtime'] });
  }
  const wg = libs.find((d) => /^(lib)?wgpu_native\.(dll|dylib)$/i.test(d));
  if (wg) {
    const lic = copyLicense(firstFile(opts.wgpuHome, ['LICENSE', 'LICENSE.APACHE', 'LICENSE.MIT']), 'wgpu-native-LICENSE.txt');
    parts.push({ name: `wgpu-native（${wg}）`, lines: [`ライセンス: MIT か Apache-2.0${lic ? `（${lic}）` : '（全文: https://github.com/gfx-rs/wgpu-native）'}`, 'https://github.com/gfx-rs/wgpu-native'] });
  }
  let ffmpegInfo = '';
  const ffexe = opts.ffmpegHome && path.join(opts.ffmpegHome, 'bin', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
  if (ffexe && fs.existsSync(ffexe)) {
    const r = spawnSync(ffexe, ['-hide_banner', '-version'], { encoding: 'utf8' });
    if (r.status === 0) ffmpegInfo = r.stdout.trim();
  }
  if (/--enable-gpl\b/.test(ffmpegInfo)) missing.push('LGPL の FFmpeg（いまの FFmpeg は --enable-gpl の構成です）');
  fs.writeFileSync(path.join(dir, 'THIRD-PARTY-NOTICES.txt'), noticesText(parts, ffmpegInfo, mac));
  return missing;
}

// opts: { root, build, editorExe, ffmpegHome, sdl3Home, wasmtimeHome, wgpuHome, out }
export function makePackage(opts) {
  const out = opts.out;
  const exe = opts.editorExe;
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(path.join(out, 'resources'), { recursive: true });
  fs.copyFileSync(exe, path.join(out, 'MozaicCut.exe'));
  const dlls = bundledDlls(exe, opts.build);
  for (const d of dlls) fs.copyFileSync(path.join(opts.build, d), path.join(out, d));
  fs.copyFileSync(path.join(opts.root, 'docs', 'design', 'tokens.json'), path.join(out, 'resources', 'tokens.json'));
  fs.copyFileSync(path.join(opts.root, 'assets', 'icon', 'mozaiccut.ico'), path.join(out, 'MozaicCut.ico'));
  const missing = writeNotices(opts, dlls, out, false);
  fs.writeFileSync(path.join(out, 'README.txt'), readmeText(dlls));
  return { out, dlls, missing };
}

// ---- macOS（dist/MozaicCut.app）のための、文字列だけを扱う部品 ----

export const MAC_APP_ID = 'com.mozaiccut.app';

// `otool -L <file>` の出力から、読み込むライブラリのパスを返す（1 行目の「<file>:」は飛ばす。同じパスは 1 回）。
// パスに空白が入ることがあるので、「 (compatibility version」の前までを取る。
export function otoolDeps(text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(.+?) \(compatibility version/.exec(line);
    if (m && !out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

// `otool -l <file>` の出力から、LC_RPATH のパスを返す（「cmd LC_RPATH」のあとの最初の「path <パス> (offset N)」）。
export function otoolRpaths(text) {
  const out = [];
  let inRpath = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*cmd /.test(line)) inRpath = /^\s*cmd LC_RPATH\s*$/.test(line);
    const m = inRpath && /^\s*path (.+?) \(offset \d+\)/.exec(line);
    if (m) {
      if (!out.includes(m[1])) out.push(m[1]);
      inRpath = false;
    }
  }
  return out;
}

// Info.plist の本文。.mzc を「MozaicCut Project」（com.mozaiccut.project）の文書の型として持つ。
export function macInfoPlist({ version }) {
  const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
  const str = (k, v) => `<key>${k}</key><string>${esc(v)}</string>`;
  const arr = (k, vs) => [`<key>${k}</key><array>`, ...vs.map((v) => `  <string>${esc(v)}</string>`), '</array>'];
  const ind = (n, lines) => lines.map((l) => ' '.repeat(n) + l);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    ...ind(2, [
      str('CFBundleName', 'MozaicCut'),
      str('CFBundleDisplayName', 'MozaicCut'),
      str('CFBundleIdentifier', MAC_APP_ID),
      str('CFBundleExecutable', 'MozaicCut'),
      str('CFBundleIconFile', 'mozaiccut'),
      str('CFBundlePackageType', 'APPL'),
      str('CFBundleShortVersionString', version),
      str('CFBundleVersion', version),
      str('CFBundleInfoDictionaryVersion', '6.0'),
      str('LSMinimumSystemVersion', '13.0'),
      '<key>NSHighResolutionCapable</key><true/>',
      '<key>CFBundleDocumentTypes</key>',
      '<array>',
      ...ind(2, ['<dict>', ...ind(2, [
        str('CFBundleTypeName', 'MozaicCut Project'),
        str('CFBundleTypeRole', 'Editor'),
        str('LSHandlerRank', 'Owner'),
        str('CFBundleTypeIconFile', 'mozaiccut'),
        ...arr('LSItemContentTypes', ['com.mozaiccut.project']),
      ]), '</dict>']),
      '</array>',
      '<key>UTExportedTypeDeclarations</key>',
      '<array>',
      ...ind(2, ['<dict>', ...ind(2, [
        str('UTTypeIdentifier', 'com.mozaiccut.project'),
        str('UTTypeDescription', 'MozaicCut Project'),
        str('UTTypeIconFile', 'mozaiccut'),
        ...arr('UTTypeConformsTo', ['public.data']),
        '<key>UTTypeTagSpecification</key>',
        '<dict>',
        ...ind(2, arr('public.filename-extension', ['mzc'])),
        '</dict>',
      ]), '</dict>']),
      '</array>',
    ]),
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

// ---- macOS: dist/MozaicCut.app ----
//
//   MozaicCut.app/Contents/
//     Info.plist                     名前・識別子（com.mozaiccut.app）・版・アイコン・.mzc の文書の型
//     PkgInfo
//     MacOS/MozaicCut                build/mozcut-edit（新しい編集画面）
//     Frameworks/*.dylib             実行ファイルが読み込む dylib（otool -L をたどる。/usr/lib と /System の OS のものは入れない）
//     Resources/mozaiccut.icns       アイコン（assets/icon/mozaiccut.icns）
//     Resources/tokens.json          画面の色と大きさ（編集画面は <実行ファイルのフォルダ>/../Resources/tokens.json を探す）
//     Resources/THIRD-PARTY-NOTICES.txt と licenses/
//
// UM のビルドは、ライブラリを絶対パスの rpath（Homebrew や UM_SDL3 などの lib）でリンクする。そのままでは他の Mac で動かないので、
// install_name_tool で、読み込む名前を @rpath/<名前> に、実行ファイルの rpath を @executable_path/../Frameworks に、
// dylib の rpath を @loader_path に直す（絶対パスの rpath は消す）。直すと署名が外れるので、最後に ad-hoc（codesign -s -）で
// 署名し直す。公証（notarization）はしない（docs/build-mac.md）。

function macRun(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 1 << 26 });
  if (r.error) throw new Error(`${cmd} を起動できません（${r.error.message}）。Xcode の Command Line Tools（xcode-select --install）が要ります`);
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} が失敗しました\n${r.stdout ?? ''}${r.stderr ?? ''}`);
  return r.stdout;
}

// OS が持っているライブラリ（入れない）。
const macSystemLib = (ref) => /^\/(usr\/lib|System)\//.test(ref);

// opts: makePackage と同じ ＋ version（省けば環境変数 MOZCUT_VERSION か '0.2.0'）。out は …/MozaicCut.app。
// 返り値: { out, dylibs（Frameworks に入れた名前）, missing（見つからなかったライセンスの文書） }
export function makeMacApp(opts) {
  if (process.platform !== 'darwin') {
    throw new Error('MozaicCut.app は macOS でだけ作れます（otool・install_name_tool・codesign を使うため）');
  }
  const out = opts.out;
  const contents = path.join(out, 'Contents');
  const macosDir = path.join(contents, 'MacOS');
  const fwDir = path.join(contents, 'Frameworks');
  const resDir = path.join(contents, 'Resources');
  fs.rmSync(out, { recursive: true, force: true });
  for (const d of [macosDir, fwDir, resDir]) fs.mkdirSync(d, { recursive: true });
  const version = opts.version || process.env.MOZCUT_VERSION || '0.2.0';
  fs.writeFileSync(path.join(contents, 'Info.plist'), macInfoPlist({ version }));
  fs.writeFileSync(path.join(contents, 'PkgInfo'), 'APPL????');
  fs.copyFileSync(path.join(opts.root, 'docs', 'design', 'tokens.json'), path.join(resDir, 'tokens.json'));
  fs.copyFileSync(path.join(opts.root, 'assets', 'icon', 'mozaiccut.icns'), path.join(resDir, 'mozaiccut.icns'));
  const exe = path.join(macosDir, 'MozaicCut');
  fs.copyFileSync(opts.editorExe, exe);
  fs.chmodSync(exe, 0o755);

  // 名前を探す場所の予備（元のファイルの rpath で見つからなかったときや、配布物の dylib の名前が
  // それを作った機械の絶対パスのままのとき）
  const libDirs = [opts.build, opts.sdl3Home, opts.wasmtimeHome, opts.wgpuHome, opts.ffmpegHome]
    .filter(Boolean).map((d) => (d === opts.build ? d : path.join(d, 'lib')));
  const resolveRef = (ref, src) => {
    const expand = (p) => p.replace(/^@loader_path/, path.dirname(src)).replace(/^@executable_path/, path.dirname(opts.editorExe));
    let cands;
    if (ref.startsWith('@rpath/')) {
      const rest = ref.slice('@rpath/'.length);
      cands = [...otoolRpaths(macRun('otool', ['-l', src])).map((r) => path.join(expand(r), rest)), ...libDirs.map((d) => path.join(d, rest))];
    } else {
      cands = [expand(ref), ...libDirs.map((d) => path.join(d, path.basename(ref)))];
    }
    const hit = cands.find((f) => fs.existsSync(f));
    if (!hit) throw new Error(`${path.basename(src)} が読み込む ${ref} が見つかりません（探した場所: ${cands.join(', ')}）`);
    return fs.realpathSync(hit);
  };

  // 実行ファイルから読み込む dylib をたどって、Frameworks に写す。名前は読み込むときの名前（libavcodec.62.dylib など）のまま
  const libs = new Map(); // 名前 → 元のファイル
  const jobs = [{ src: opts.editorExe, dst: exe, isExe: true }];
  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i];
    const self = job.isExe ? null : macRun('otool', ['-D', job.src]).trim().split('\n').pop().trim();
    const args = [];
    if (!job.isExe) args.push('-id', `@rpath/${path.basename(job.dst)}`);
    for (const ref of otoolDeps(macRun('otool', ['-L', job.src]))) {
      if (ref === self || macSystemLib(ref)) continue;
      const name = path.basename(ref);
      if (!libs.has(name)) {
        const real = resolveRef(ref, job.src);
        libs.set(name, real);
        const dst = path.join(fwDir, name);
        fs.copyFileSync(real, dst);
        fs.chmodSync(dst, 0o755);
        jobs.push({ src: real, dst, isExe: false });
      }
      if (ref !== `@rpath/${name}`) args.push('-change', ref, `@rpath/${name}`);
    }
    const rpaths = otoolRpaths(macRun('otool', ['-l', job.dst]));
    const want = job.isExe ? '@executable_path/../Frameworks' : '@loader_path';
    for (const r of rpaths) if (r !== want) args.push('-delete_rpath', r);
    if (!rpaths.includes(want)) args.push('-add_rpath', want);
    if (args.length) macRun('install_name_tool', [...args, job.dst]);
  }

  // 確かめ: どのファイルも、OS のものか Frameworks にある @rpath/<名前> だけを読み込む
  const dylibs = [...libs.keys()].sort();
  for (const f of [exe, ...dylibs.map((n) => path.join(fwDir, n))]) {
    const self = f === exe ? null : `@rpath/${path.basename(f)}`;
    for (const ref of otoolDeps(macRun('otool', ['-L', f]))) {
      if (ref === self || macSystemLib(ref)) continue;
      const m = /^@rpath\/(.+)$/.exec(ref);
      if (!m || !libs.has(m[1])) throw new Error(`${path.basename(f)} が .app の外の ${ref} を読み込んだままです`);
    }
  }

  const missing = writeNotices(opts, dylibs, resDir, true);

  // ad-hoc の署名（中の dylib から先に、最後に .app 全体）
  for (const n of dylibs) macRun('codesign', ['--force', '--sign', '-', path.join(fwDir, n)]);
  macRun('codesign', ['--force', '--sign', '-', out]);
  macRun('codesign', ['--verify', '--deep', '--strict', out]);
  return { out, dylibs, missing };
}
