# MozaicCut

[UnifiedMozaic](../UnifiedMozaic)（UM）で書いた、**テキストで編集する動画編集ソフト**です。

- プロジェクトは 1 行に 1 クリップのテキストファイル（`.mzc`）です。手で書いても、コマンド（`op`）でも、編集画面でも、AI のエージェント（アプリの中の AI と MCP）からでも、同じ書き方・同じ操作で編集できます。
- カット・並べ替え・効果・トランジション・重ね合わせ・文字（TrueType と OpenType。日本語の縦書きも）・図形・パーティクル・3D・音のミックスは、すべて UM のネイティブバイナリが行います。画素の処理は `kernel` なので、CPU の全コアで並列に動き、ビルドのときに wgpu-native が見つかれば GPU でも動きます（CPU と GPU の絵が同じことをテストで確かめています）。
- 誤りは「ファイル:行:列: エラー[原因コード]: 理由」と「ヒント（直し方）」の形で出ます。`--json` を付ければ機械向けの JSON でも出ます。
- 効果とトランジションは、本体の外の独立したプラグイン（`.mzplug`。wasm の CPU 版と WGSL の GPU 版を 1 つに包んだもの）です。いまは効果 47 個とトランジション 16 個で、ソースは別のリポジトリ [MozaicCut-Plugins](https://github.com/UnifiedMozaic/MozaicCut-Plugins) にあります。`.mzplug` を足せば、本体を作り直さずに効果が増えます。

動画の圧縮・展開（H.264 などのコーデック）は、UM の FFmpeg の組み込み（FFmpeg の LGPL のライブラリ）を使い、エンジンがその場で行います。素材を事前に別の形式へ展開せず、素材のファイルを直接開いてコマ単位でシークし、書き出しは MP4 などを直接書きます。

```
project.mzc ──▶ mozcut (UM) ──FFmpeg の組み込み──▶ 素材を直接開いてその場で展開（コマ単位のシーク、音は f32）
                     │
                     └──render──▶ 1 コマずつ合成 ──FFmpeg の組み込み（H.264 + AAC。ハードウェアの符号器があれば使う）──▶ out.mp4
```

FFmpeg のライブラリが見つからない環境では、予備の経路で動きます: `tools/mozcut.mjs` が ffmpeg / ffprobe のコマンドで素材を生の Y4M / PAM / PCM のキャッシュに展開し、エンジンが合成した Y4M + PCM を ffmpeg のコマンドで圧縮します（UM には子プロセスを起動する機能がないので、コマンドとのやり取りは Node のスクリプトが受け持ちます）。

使う人向けの説明書（はじめに・編集の基本・効果・書き出し・AI・困ったとき）は [docs/manual/](docs/manual/README.md)（動画編集がはじめての人は [はじめての人へ](docs/manual/00-beginner.md) から。`node tools/gen-manual.mjs` で `dist/manual/` に HTML にでき、配布の形には `manual/index.html` として入ります）、AI のエージェントから使うときの手引きは [docs/ai.md](docs/ai.md) と [docs/mcp.md](docs/mcp.md)、内部の約束ごと（モジュール・型・関数の形）は [docs/design/architecture.md](docs/design/architecture.md)、版ごとの変更は [CHANGELOG.md](CHANGELOG.md)、リリースと自動更新は [docs/release.md](docs/release.md) にあります。

## 必要なもの

**配布の形を使うだけなら、何も要りません。** GitHub Releases の `MozaicCut-windows-x64.zip`（Windows）か `MozaicCut-macos-arm64.zip`（macOS）を展開し、`MozaicCut.exe`（`MozaicCut.app`）を起動します。node も UM も FFmpeg も要りません（中身は下の「exe だけで使う（配布の形）」）。

ソースからビルドして開発するときは、次のものを使います。`node tools/mozcut.mjs build` は、SDL3・wasmtime・wgpu-native・FFmpeg を、環境変数がなければ **このリポジトリの隣とホームフォルダ** から自動で探します（macOS では Homebrew の場所も見ます）。

| もの | 要るか | 探し方 |
| --- | --- | --- |
| [UnifiedMozaic](../UnifiedMozaic) とその環境（Node.js 22.18 以上、clang） | 要る | 環境変数 `UM_HOME`、なければこのリポジトリの隣の `UnifiedMozaic` |
| wasmtime の C API（`.mzplug` を読み込む） | 要る（エンジンも編集画面もリンクする） | `UM_WASMTIME`、なければ隣とホームの `wasmtime-*`（`include/wasmtime.h` があるもの） |
| FFmpeg 7.1 以降の**共有ライブラリの LGPL のビルド**（Windows は [BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds/releases) の `ffmpeg-n9.0-latest-win64-lgpl-shared-9.0.zip` など） | 要る（ないと予備の経路の版になる。配布の形には必須） | `UM_FFMPEG_HOME`、なければ隣とホームの `ffmpeg*` のフォルダ（その中に 1 段入った所も）、`pkg-config`、Homebrew。ビルドすると DLL を `build/` に写す |
| [wgpu-native](https://github.com/gfx-rs/wgpu-native)（GPU） | なくてもよい（なければ CPU だけの版） | `UM_WGPU_HOME`、なければ隣とホームの `wgpu-native/<版>`（`include` があるもの）。見つかれば `UM_WGPU=1` でビルドする |
| SDL3（3.2.12 以上） | 編集画面だけ | `UM_SDL3`、なければ隣とホームの `SDL3-*`（`include/SDL3/SDL.h` があるもの）。Windows は [SDL のリリース](https://github.com/libsdl-org/SDL/releases) の `SDL3-devel-*-VC.zip`、macOS は `brew install sdl3` |
| プラグインのソース（[MozaicCut-Plugins](https://github.com/UnifiedMozaic/MozaicCut-Plugins)） | なくてもよい | `MOZCUT_PLUGINS_DIR`、`plugins/`、隣の `MozaicCut-Plugins/plugins/`。ソースがなければ `build/plugins/` の `.mzplug` を使い、それもなければ GitHub Releases からビルド済みの一式を取ってくる（`MOZCUT_PLUGINS_PREBUILT=1` なら、いつもビルド済みを使う） |
| llvm-rc | なくてもよい（なければ exe にアイコンを付けない） | `LLVM_RC`、なければ `C:/Program Files/LLVM/bin/llvm-rc.exe` |
| ffmpeg / ffprobe のコマンド | 予備の経路、`preview` の PNG への変換、デモの素材作り（`tools/demo-media.mjs`） | PATH か、環境変数 `FFMPEG` / `FFPROBE` |
| [whisper.cpp](https://github.com/ggerganov/whisper.cpp) の `whisper-cli` と ggml のモデル | 文字起こし（`transcribe`）だけ | `MOZCUT_WHISPER` / `MOZCUT_WHISPER_MODEL`、なければ実行ファイルの隣の `whisper/`、ホームの `whisper.cpp/`、PATH（置き方は [docs/analyze.md](docs/analyze.md)） |

- `MOZCUT_NO_FFMPEG=1` を付けると、FFmpeg のライブラリがあっても予備の経路の版をビルドします。
- ビルドは低い優先度で動かします（`MOZCUT_BUILD_PRIORITY=normal` で普通の優先度）。
- 文字の描画には TrueType / OpenType（CFF）のフォントを使います。指定がなければ、游ゴシック Medium → BIZ UDゴシック → メイリオ → Arial Unicode → IPAex ゴシック → DejaVu Sans の順に探します（どれもなければ 5x7 のビットマップフォントで描きます）。
- macOS でのビルドは [docs/build-mac.md](docs/build-mac.md) にあります。

## はじめに

```sh
node tools/demo-media.mjs                        # デモの素材を作る（初回だけ）
node tools/mozcut.mjs check   demo/demo.mzc      # 誤りがないか調べる
node tools/mozcut.mjs show    demo/demo.mzc      # タイムラインの図とクリップの一覧
node tools/mozcut.mjs preview demo/demo.mzc 3.5  # 3.5 秒の 1 コマを demo/preview.png に
node tools/mozcut.mjs render  demo/demo.mzc      # demo/demo.mp4 を書き出す
node tools/mozcut.mjs edit    demo/demo.mzc      # 編集画面を開く
```

- 初回はエンジン（`build/mozcut`）を自動でビルドします。`src/**/*.um` を書き換えると、次の実行で作り直します。`node tools/mozcut.mjs build` でエンジンと編集画面を、`build engine` / `build editor` で片方だけを、明示的に作り直せます。
- プラグインは本体とは別に `build/plugins/*.mzplug` へ作ります（`plugin build-all`。変わったものだけ）。プラグインを書き換えても、本体は作り直しません。
- FFmpeg の組み込みがあれば、素材は事前に展開しません（`<プロジェクト名>.cache/` には preview の中間の画像だけを置きます）。予備の経路では、素材の展開結果が `<プロジェクト名>.cache/` に残り、クリップの設定や素材が変わらなければ再利用します。
- `node tools/mozcut.mjs help` で使い方の一覧が出ます。

## コマンド

コマンドは 2 通りあります。

- `node tools/mozcut.mjs <コマンド>`: 開発の入口。必要ならビルドしてから、エンジン（`build/mozcut`）を呼びます。予備の経路の ffmpeg とのやり取りも受け持ちます。以下、`mozcut` はこの略です。
- `build/mozcut.exe <コマンド>`（配布の形では `mozcut.exe`、macOS は `Contents/MacOS/mozcut`）: エンジンそのもの。Node.js も外の ffmpeg も要りません。MCP のサーバーと文字起こしは、こちらだけにあります。

### mozcut（node tools/mozcut.mjs）

| コマンド | すること | 終了コード |
| --- | --- | --- |
| `check <p.mzc> [--json]` | 誤りを調べる | 0: 誤りなし / 1: 誤りあり・読めない / 2: 使い方の誤り |
| `show <p.mzc> [--width N]` | タイムラインの図とクリップの一覧（既定の幅は 100 文字。track の行があれば音のトラックの設定の表も） | 0 / 1 / 2 |
| `op <p.mzc> <操作...> [--dry-run] [--json]` | 操作を 1 つ適用して保存する | 0: 成功 / 1: 失敗（何も書き換えない） / 2: 使い方の誤り（操作がないなど） |
| `op <p.mzc> --file <ops.txt \| -> [--dry-run] [--json]` | ファイル（`-` なら標準入力）の操作をまとめて適用する | 同上 |
| `schema [--json]` | 使えるキー・効果とトランジション（プラグイン）・時刻と参照の書き方・機能の早見・操作の一覧 | 0 |
| `preview <p.mzc> <時刻> [-o x.png]` | 1 コマを画像にする（既定は `.mzc` と同じフォルダの `preview.png`。`.bmp` も可）。全体の長さより後ろなら警告を出す | 0 / 1 / 2 |
| `render <p.mzc> [-o out.mp4] [--from t] [--to t] [-j N]` | 動画（H.264 + AAC の MP4）を書き出す（既定は project の `output`。`-j` は予備の経路で ffmpeg を同時に動かす数）。範囲が空（`--from` ≥ `--to`、`--from` が全体の長さ以上）なら止める | 0 / 1 / 2 |
| `motion <p.mzc> <追うクリップ> <x,y> --to <動かすクリップ> [--dry-run] [--json]` | 映像の中の点を追い、動かすクリップの位置のキーフレームにする（下の「motion」） | |
| `edit [<p.mzc>]` | 編集画面を開く（省くとスタート画面） | |
| `build [engine \| editor]` | エンジンと編集画面を作り直す（片方だけも可） | |
| `package [-o <dir>]` | 配布の形（既定は Windows は `dist/MozaicCut/`、macOS は `dist/MozaicCut.app`）を作る。下の「exe だけで使う（配布の形）」 | 0 / 1 |
| `plugin build <名前 \| file.um> [-o x.mzplug]` | 効果・トランジションのプラグインを `.mzplug` にする | 0 / 1 / 2 |
| `plugin build-all [--force]` | プラグインのソースの全部を `build/plugins/*.mzplug` へ作る（変わったものだけ） | 0 / 1 |
| `plugin fetch [--tag <版>] [--repo <owner/repo>]` | GitHub Releases からビルド済みのプラグインの一式（`mozaiccut-plugins.zip`）を `build/plugins/` に取ってくる | 0 / 1 |
| `plugin list [--json]` | プラグインのソースにある効果と、入れた `.mzplug` の一覧 | 0 |
| `plugin install <x.mzplug> [--force]` / `plugin uninstall <名前>` | `.mzplug` を `plugins-installed/` に入れる・外す | 0 / 1 / 2 |

### build/mozcut.exe（エンジン）

`check` / `show` / `op` / `schema` / `motion` は上と同じです（`<p.mzc>` のあとに展開のキャッシュの場所を書きます。`motion` のほかは省けて、省けば `<project>.cache`）。そのほかに次のコマンドがあります（一覧は `build/mozcut.exe help`）。

| コマンド | すること |
| --- | --- |
| `render <p.mzc> [cache] [from] [to] --out out.mp4` | 動画を直接書く（H.264 + AAC。ハードウェアの符号器があれば使う）。`--out` がなければ、映像（Y4M）と音（PCM）をキャッシュに書く（予備の経路で mozcut.mjs が使う） |
| `preview <p.mzc> [cache] <時刻> <out.bmp>` | 1 コマを BMP に書く |
| `plugins [--json]` | 読み込んだ `.mzplug`（効果・トランジション）の一覧。GPU でも動くものは `[GPU+CPU]`、CPU だけのものは `[CPU]` |
| `mcp [--root <フォルダ>]...` | AI のエージェント（Claude Code など）から使う MCP のサーバーを標準入出力で動かす（[docs/manual/06-ai.md](docs/manual/06-ai.md)） |
| `transcribe <p.mzc> [cache] <クリップ> [--lang ja] [--apply] [--srt out.srt] [--ops out.txt] [--json]` | クリップの素材の音を whisper.cpp で書き起こし、字幕（`add text` の操作）にする。`--apply` で適用して保存する（[docs/analyze.md](docs/analyze.md) の「文字起こし」） |
| `caps` | このエンジンでできること（FFmpeg の組み込みの有無と版）を出す |
| `sources` / `plan` | 素材のパス・展開の仕事を並べる（予備の経路で mozcut.mjs が使う） |

`--plugins <フォルダか .mzplug>` を付けると、それも読みます。プラグインは、実行ファイルの隣の `plugins/`（macOS の .app では `../Resources/plugins/`）、`plugins-installed/`、`plugins/` から読みます。

### 共通のこと

`check` / `show` / `op` は、エンジンが素材を FFmpeg の組み込みで調べる（予備の経路では `mozcut.mjs` が ffprobe で調べて渡す）ので、長さ（`out=` / `dur=`）を書かないクリップも正しく並びます。素材のファイルが見つからなければ `missing-source`（探した場所つき）、`out=` / `dur=` が素材の長さを超えれば `out-of-range` になります。`preview` と `render` は、誤りのあるプロジェクトでは誤りを出して止まります。

`--json` を付けたときは、`mozcut.mjs` が止まる誤り（プロジェクトがない、操作がない など）も `{"ok":false,"error":"..."}` として標準出力に出します。

### check: 誤りを調べる

```console
$ mozcut check demo/demo.mzc
問題はありません（クリップ 10 個、長さ 0:10.500）
```

誤りがあると、1 件ずつ行・列・原因コード・ヒントを出します。たとえば次の `bad.mzc` では:

```sh
project size=1280x720 fps=30
color 202040 id=bg dur=2 colr=ff0000
text "hi" at=bg.end dur=1
text "yo" at=nosuch.end dur=1
color 000000 dur=1
audio "media/bgm.wav" blur=2
```

```console
$ mozcut check bad.mzc
bad.mzc:2:26: エラー[unknown-key]: 'colr' というキーはありません
  ヒント: 'color' のことですか？
bad.mzc:4:14: エラー[unknown-ref]: 'nosuch' という ID のクリップはありません
  ヒント: id=nosuch を付けたクリップを指します
bad.mzc:6:23: エラー[key-not-allowed]: 'blur' は効果なので audio の行では使えません
  ヒント: 効果は video / image / text / color の行か、project の行（合成した画面全体）に書きます
エラー 3 個
```

`--json` を付けると、配置の結果（各クリップの開始・終わり・効果）と診断を JSON で出します（時間は秒の数。ないものは `null`）。`ok` は誤り（error）が 0 個か、`at` は書いたままの値（参照か秒。省けば `null`）、`keys` は行に書いた key=value、`trackKind` は `"video"` か `"audio"`、`placed` が `false` なら誤りのため仮の位置（0 秒）に置いたクリップです。`anims`（キーフレーム）・`blend`・`exprs`・`is3d`・`textanim`・`particles`・`shape`・`masks` には、読めた値が入ります。

```json
{"ok":true,"project":{"width":1280,"height":720,"fps":"30/1","rate":48000,"duration":10.5,"effects":[],"anims":{}},
 "clips":[{"index":2,"id":"clip_b","line":9,"kind":"video","track":0,"start":5,"end":9,"duration":4,"in":0.5,
           "src":"media/clip_b.mp4","text":null,"trackKind":"video","at":null,"placed":true,
           "keys":{"in":"0.5","out":"4.5","xfade":"1","sat":"1.4","contrast":"1.1","vignette":"0.4","fadeout":"1"},
           "effects":[{"name":"sat","params":{"amount":1.4}},{"name":"contrast","params":{"amount":1.1}},
                      {"name":"vignette","params":{"strength":0.4,"radius":0.6,"softness":0.4}}],
           "anims":{},"blend":null,"exprs":[],"is3d":false,"textanim":null,"particles":null,"shape":null,"masks":[]}],
 "diagnostics":[]}
```

（clips は 1 つだけ載せています。）`bad.mzc` なら `diagnostics` に次のような要素が並びます。

```json
{"code":"unknown-key","severity":"error","line":2,"col":26,"message":"'colr' というキーはありません","hint":"'color' のことですか？","suggest":"color"}
```

### show: タイムラインを見る

```console
$ mozcut show demo/demo.mzc --width 90
demo.mzc
1280x720  30fps  48000Hz  0:10.500  クリップ 10
    0:00    0:01    0:02    0:03    0:04    0:05     0:06    0:07    0:08    0:09    0:10
    +-------+-------+-------+-------+-------+--------+-------+-------+-------+-------+----
V3                          [pip                    ]
V2   [title      ]      [caption_a              ]        [caption_b             ]
        [subtitle]
V1                  [logo                                                                ]
V0  [intro         ][clip_a                         ]
                                            [clip_b                         ]
A0  [bgm                                                                                 ]

 #  ID         行  種類   トラック      開始    終わり  素材 / 文字                               効果
#0  intro       7  color  V0        0:00.000  0:02.000  202040                                    vignette=0.7
#1  clip_a      8  video  V0        0:02.000  0:06.000  media/clip_a.mp4                          -
#2  clip_b      9  video  V0        0:05.000  0:09.000  media/clip_b.mp4                          sat=1.4 contrast=1.1 vignette=0.4
#3  pip        12  video  V3        0:03.000  0:06.000  media/clip_a.mp4                          pixelate=8 sepia=0.8
...
#7  caption_a  20  text   V2        0:02.500  0:05.500  "Clip A: testsrc2\n小窓: pixelate + ..."  -
...
```

`V` は映像のトラック（上ほど手前に描く）、`A` は音のトラックです。重なったクリップは行を分けて描きます。左の列の `#0`、`#1` … は、操作でクリップを指すときの番号です。

### op: 操作で書き換える

```console
$ mozcut op demo/demo.mzc move clip_b 5.5 --dry-run
clip_b を 5 秒から 5.5 秒に動かしました。ほかに 1 個のクリップの時刻が変わりました: caption_b 6.5→7 秒
  - 9: video "media/clip_b.mp4" id=clip_b in=0.5 out=4.5 xfade=1 sat=1.4 contrast=1.1 vignette=0.4 fadeout=1
  + 9: video "media/clip_b.mp4" id=clip_b in=0.5 out=4.5 xfade=1 sat=1.4 contrast=1.1 vignette=0.4 fadeout=1 at=5.5
保存していません（--dry-run）
```

`--dry-run` を外すと保存し、最後の行が `保存しました（demo/demo.mzc）` になります。書き換えるのは該当する行だけで、注釈・ほかの値・行の並び・改行の形（CRLF）はそのまま残ります。

| 操作 | 意味 | 例 |
| --- | --- | --- |
| `move <clip> <時刻か参照>` | 開始を動かす（`at=` を書く） | `move clip_b 5.5`、`move pip clip_a.start+0.5`、`move clip_b after:clip_a` |
| `trim <clip> start <時刻>` | タイムライン上の始まりを詰める・伸ばす | `trim clip_a start 2.5` |
| `trim <clip> end <時刻>` | タイムライン上の終わりを詰める・伸ばす | `trim clip_a end 5.5` |
| `split <clip> <時刻>` | その時刻で 2 つに分ける。後半は次の行に入り、ID は `<id>_2`。分ける前と同じ時刻の絵は変わらない（キーフレーム・`in=` / `full=`・マスク・`matte=` を直す） | `split clip_b 7` |
| `delete <clip> [fix-refs]` | 行を `# ` で注釈にする（行は消さない）。ほかのクリップの `at=` から参照されていれば止める（`fix-refs` を付けると、参照している `at=` を今の秒に書き換えてから消す） | `delete caption_b`、`delete clip_a fix-refs` |
| `cut <開始> <終わり>` | タイムライン上の範囲を全トラックから切り取り、後ろを詰める（「最初の 3 秒を切る」など）。範囲をまたぐ映像・音と、時刻で見え方が変わるクリップ（キーフレーム・式・粒・字の動き・drawon）は分けてから詰め、project の行のキーフレームも詰めた時刻に直す | `cut 0 3`、`cut 1:00 1:05.5` |
| `set <clip> key=value ...` | 値を決める（効果も、文字・素材・色も） | `set pip opacity=0.5 blur=2`、`set caption_a text="字幕"` |
| `unset <clip> key ...` | キーを消す | `unset clip_b vignette` |
| `renamekey <clip> <古いキー> <新しいキー>` | キーの名前だけを同じ場所で変える（書き間違いの直し。効果の順を保つ） | `renamekey clip_b vignete vignette` |
| `add <種類> [素材 / 文字 / 色] key=value ... [after <clip>]` | 行を足す（既定はファイルの最後）。`id` を書かなければ `text1` のように付ける。種類は video / image / audio / text / color / shape / particles / mask など | `add text "おわり" at=clip_b.end-1 dur=1 after caption_b` |
| `rename <clip> <新しい ID>` | ID を変える（ほかの行の `at=`・`to=`・`matte=`・particles の `layer=`・式の `clip('ID')` も書き換える） | `rename pip inset` |
| `add marker <時刻> [name=..] [color=..]` | マーカーの行を足す（最後のマーカーの行の後ろ）。`@行番号` で `set at= / name= / color=`・`unset`・`delete` | `add marker 12.5 name=見せ場` |
| `mix <音のトラック\|master> key=value ...` | 音のトラック（またはマスター）の `track` の行の値を決める（行がなければ足す）。`mute=1` / `mute=0` で付け外し、値を空にすると消す | `mix 0 vol=-6 pan=-0.2`、`mix 1 mute=1`、`mix master vol=-1` |
| `key add\|remove\|move\|set\|ease\|shift\|clear <clip> <キー> ...` | キーフレームを書き換える（下の「キーフレーム」） | `key add title x 1.5 400 ease`、`key ease title opacity * easeout` |

- `<clip>` の指し方は 3 通り: ID（`clip_b`）、`#番号`（`#3`。0 から数える。`show` の左の列）、`@行番号`（`@9`）。
- 操作の後でファイルを読み直し、**新しい誤りが増えたら止めて、何も書き換えません**（終了コード 1）。もとから誤りのあるファイルでも、誤りを増やさない操作は通ります。
- 参照（`at=clip_a.start+1` など）で置いたクリップを `move` / `trim` すると、その `at=` は秒の数に置き換わります。参照のまま動かしたいときは `move pip clip_a.start+0.5` のように参照で書きます。
- 操作で **ほかのクリップの時刻も変わったとき**（`delete` で `at=` のない後ろのクリップが詰まった、参照しているクリップが付いて動いた など）は、上の例のように「ほかに 1 個のクリップの時刻が変わりました: caption_b 6.5→7 秒」と出します（JSON では `moved`）。
- 映像・音に `set <clip> dur=...` をすると `out=` を消します（`out=` があると `dur=` は効かないため）。`out=` を書けば `dur=` を消します。
- 操作の名前は大文字・小文字を区別しません。名前やクリップの ID を打ち間違えると、近いものを「'clip_b' のことですか？」と出します。
- まとめて適用するときは、操作を 1 行に 1 つ書いたファイルを `--file` で渡します。空の行と `#` で始まる行は飛ばします。どれか 1 つでも失敗すると、全部を適用しません。

```sh
cat > ops.txt <<'EOF'
# 小窓を早め、字幕を直し、最後に文字を足す
move pip clip_a.start+0.5
set caption_a text="字幕を直しました"
add text "おわり" at=clip_b.end-1 dur=1 size=48 after caption_b
EOF
mozcut op demo/demo.mzc --file ops.txt --dry-run   # 差分を見る
mozcut op demo/demo.mzc --file ops.txt             # 保存する
```

失敗したときの例:

```console
$ mozcut op demo/demo.mzc set pip blur=999 --dry-run
エラー[out-of-range]: この操作で誤りが増えるため、適用しませんでした（12 行目: 'blur' の値 999 は範囲の外です）
  ヒント: 0〜64 の範囲で書きます
何も書き換えていません
```

- 値に空白を含むときは `"..."` で囲みます（`text="a b"`）。`"` そのものは `\"`、`\` は `\\` と書きます。
- 文字の値（`set <clip> text=...`、`add text "..."`）の中の `\n` は改行になります（`set caption_a text="1 行目\n2 行目"`）。
- 操作を 1 つの引数にまとめて書いても（`mozcut op p.mzc "move pip 2"`）分けて読みます。
- `--json` を付けると `{"ok":..,"saved":..,"results":[{"op","ok","code","desc","error","hint","suggest","newId","changes":[{"kind","line","before","after"}],"moved":[{"id","line","before":{"start","end"},"after":{"start","end"}}],"newDiagnostics":[...]}],"diagnostics":[...]}` を出します。`suggest` は hint で推した候補（キーや ID）、`newDiagnostics` は誤りが増えて止めたときのその診断（行・列・code）です。

### schema: 使えるキーと効果

`mozcut schema` は、コアのキー（使える行・型・既定値・範囲・説明）、効果とトランジションのプラグイン（引数・既定値・範囲・別名）、時刻と参照の書き方、機能の早見（キーフレーム・描画モード・シェイプ・パーティクル・3D・式など、それぞれの書き方と例）、操作の一覧（書き方・意味・例）を出します。`--json` なら `{"version":2,"keys":[...],"effects":[...],"effectsNote":..,"transitions":[...],"ops":[...],"syntax":[...],"blend":..,"expressions":..,"features":..}` です。keys は (name, kinds) ごとに 1 つ（project の `out` は `aliasOf:"output"`）、`default` は数の型なら数、`type` が `"enum"` なら `values` に選択肢があります。キーの説明はこの README よりも schema の方が正確です（プラグインを足せば効果の一覧も増えます）。

### preview と render

```sh
mozcut preview demo/demo.mzc 3.5                              # demo/preview.png
mozcut preview demo/demo.mzc 1:02.5 -o shot.png
mozcut render  demo/demo.mzc                                  # project の output（demo.mp4）に
mozcut render  demo/demo.mzc --from 6 --to 7.5 -o part.mp4    # 一部だけ
```

- 書き出しは H.264（`crf` / `preset` は project の行で決める）と AAC です。FFmpeg の組み込みがあれば、エンジンが MP4 を直接書きます（中間のファイルも ffmpeg のコマンドも使いません）。
- 予備の経路では、エンジンが書いた中間のファイル（Y4M / PCM）を ffmpeg のコマンドで libx264 と AAC 192kbps に圧縮し、済んだら消します。
- 編集画面の「出力」のワークスペースからは、MP4 のほかに ProRes 422 HQ（.mov）・WAV・M4A も書き出せます（[docs/manual/05-export.md](docs/manual/05-export.md)）。

### motion: 点を追ってキーフレームにする（モーショントラッキング）

```sh
mozcut motion demo/m6/motion.mzc bg 760,420 --to tag --dry-run   # 試す
mozcut motion demo/m6/motion.mzc bg 760,420 --to tag             # tag に pos= のキーを書く
```

- 追う映像の始まりのコマで、画面の (x,y) にある模様を追い（[src/effects/track/README.md](src/effects/track/README.md)）、`--to` のクリップの今の位置を保ったまま、同じだけ動く `pos="x,y@t ..."` を 1 コマに 1 つ書きます。書いたキーは `key` の操作やエディタで直せます。
- 信頼度の低いコマ（隠れた・画面の外）は最後の位置に止め、その数を出します。

## プロジェクトファイル（.mzc）

1 行に 1 つ、`種類 ["素材" / "文字" / 色] key=value ...` と書きます。`#` 以降は注釈です（`"..."` の中と、色の値の先頭の `#` は除く）。時間は秒（`12.5`）か `分:秒`（`1:02.5`）、`時:分:秒`（`1:02:03`）、コマ（`61f`。project の `fps` で秒にする。`at=intro.end+2f` のような参照のずらしにも書ける）です（分と秒の欄は 60 未満。負の時間は `out-of-range`）。コマで書くと描画のコマの時刻と同じ式で秒にするので、秒を小数で丸めて書いたときのように 1 コマずれません。

```sh
project size=1280x720 fps=30 rate=48000 bg=101018 output=demo.mp4

# 0 番トラック: タイトルの背景 → クリップ A → クリップ B（1 秒のクロスフェード）
color 202040 id=intro dur=2 fadeout=0.5 vignette=0.7
video "media/clip_a.mp4" id=clip_a in=1 out=5 fadein=0.5          # at を省くと同じトラックの前の行の後ろに並ぶ
video "media/clip_b.mp4" id=clip_b in=0.5 out=4.5 xfade=1 sat=1.4 contrast=1.1 vignette=0.4 fadeout=1

# 右下の小窓。クリップ A の始まりの 1 秒後から。効果は書いた順に掛かる（モザイク → セピア）
video "media/clip_a.mp4" id=pip track=3 at=clip_a.start+1 in=2 dur=3 w=320 h=180 x=-24 y=-24 pixelate=8 sepia=0.8 fade=0.3 mute

image "media/logo.png" id=logo at=clip_a.start dur=8.5 x=24 y=24 w=96 opacity=0.85 fade=0.5

# 文字（size は画素）
text "MozaicCut" id=title at=0.2 dur=1.6 size=96 color=ffffff outline=303080 outlinew=5 shadow=00000099 fade=0.3
text "Clip A: testsrc2\n小窓: pixelate + sepia" id=caption_a at=clip_a.start+0.5 dur=3 x=40 y=-40 size=26 bg=000000a0 pad=12

audio "media/bgm.wav" id=bgm at=0 dur=10.5 volume=0.25 fadein=1 fadeout=2
```

全体は [demo/demo.mzc](demo/demo.mzc) にあります。機能ごとの見本は `demo/m6/`（anim・blend・expr・key・motion・particles・shape・textanim・threed）にあります。

### 種類

| 種類 | 2 番目に書くもの | 内容 |
| --- | --- | --- |
| `project` | — | 全体の設定（1 行だけ） |
| `video` | `"素材"` | 動画。映像と音の両方を使う（`mute` で音を消す） |
| `image` | `"素材"` | 静止画（PNG の透過も使える） |
| `text` | `"文字"` | 文字。`\n` で改行、`\t` でタブ（空白 4 つ分の倍数の位置まで進む）。`\"` は `"`、`\\` は `\`（ほかの `\x` は警告 `bad-escape`）。日本語も書ける |
| `color` | 色 | 単色の四角（`w` / `h` を省くと画面全体） |
| `audio` | `"素材"` | 音だけ（BGM、効果音） |
| `shape` | 形（`rect` / `ellipse` / `polygon` / `star` / `path`） | ベクターの図形（下の「シェイプ」） |
| `particles` | — | パーティクル（下の「パーティクル」） |
| `comp` | `"別の.mzc"` | プリコンポーズ。別の `.mzc` を透明な背景の 1 つの層として重ねる（入れ子は 4 段まで。中の音もミックスする）。[docs/design/comp.md](docs/design/comp.md) |
| `model` | `"モデル.obj"` | 3D のモデル（下の「3D レイヤーとカメラ」） |
| `spectrum` | 形（`bars` / `wave` / `ring`） | プロジェクトの音に合わせて動くスペクトラム（`color` / `color2` / `bars` / `gain`） |
| `mask` | 形（`rect` / `ellipse` / `path`） | クリップのマスク（下の「描画モード・マスク・トラックマット」） |
| `track` | — | 音のトラックの設定（下の「音」） |
| `marker` | 時刻 | タイムラインの印（下の「マーカー」） |

素材のパスは `.mzc` のフォルダからの相対パスか、絶対パスです。`src="..."` と書いても同じです。

### ID と参照

クリップに `id=名前` を付けると、ほかの行の `at=` や操作（`op`）で名前で指せます。

- 名前は英字・数字・`_`・`-`。先頭は英字か `_`。ファイルの中で重複できません（`duplicate-id`）。
- `at=` に書ける参照:

| 書き方 | 意味 |
| --- | --- |
| `at=intro.end` | intro の終わり |
| `at=intro.start` | intro の始まり |
| `at=intro.start+1.5` | intro の始まりの 1.5 秒後 |
| `at=intro.end-0.5` | intro の終わりの 0.5 秒前（`1:02.5` や `15f` の書き方も使える） |
| `at=after:intro` | `intro.end` と同じ |

- 参照先が後ろの行にあっても構いません。参照先を動かすと、参照している側もついて動きます。
- 参照先がなければ `unknown-ref`、参照が輪になっていれば `ref-cycle` です。

### 配置と時間

| key | 意味 |
| --- | --- |
| `track` | トラック番号（0〜63）。大きいほど手前に描く。既定は video / color / audio が 0、image が 1、text が 2。音は映像とは別の並び |
| `at` | タイムライン上の開始時刻か参照。省くと、同じトラックのそれより前の行のクリップの終わりに置く（並べるだけでつながる） |
| `in` / `out` | 素材の使う範囲（video / audio） |
| `dur` | 長さ（`out` の代わり。image / text / color は既定 5 秒、video / audio は省くと素材の終わりまで） |
| `speed` | 再生の速さ（video / audio / comp。0.1〜16。使う素材は dur × speed。音は高さも変わる） |
| `xfade` | 直前のクリップと重ねてクロスフェードする秒数 |
| `trans` | `xfade` の区間の切り替え方（トランジションのプラグインの名前。`trans.angle` / `trans.soft` / `trans.param`。下の「効果（プラグイン）」） |
| `enabled` | `0` で無効（描かず、音も出さない。行と時刻はそのまま残る）。既定は `1` |
| `x` / `y` | 左上の位置。`center`（既定）か画素の数。負の数は右端・下端からの距離 |
| `w` / `h` | 大きさ（video / image / color。片方だけなら縦横比を保つ）。color の行はキーフレームでも書ける（`w="0@0 640@0.5:ease"`。キーの 0 は大きさ 0 で見えない） |
| `fit` | `w` と `h` の枠への合わせ方（video / image）: `contain`（既定。収める）/ `cover`（切り抜いて埋める）/ `stretch` |
| `rotation` / `scale` / `anchor` | 回転（度、時計回り）・拡大（`1.5` か 横,縦 の `1.5,0.8`）・基準点（層の中央からの画素）。2D の行でもそのまま効く（[docs/design/m6-xform.md](docs/design/m6-xform.md)） |
| `parent` | 親のクリップの ID。親の位置・回転・拡大に付いて動く（x / y は親の中央からの位置になる） |
| `link` | リンクの組の名前（同じ名前のクリップを編集画面で一緒に選び・動かす。映像とその音の行など） |

キーには使える行が決まっています（例: `w` は text の行では使えず、`in` は image の行では使えない）。違う行に書くと `key-not-allowed`（綴りの誤りの `unknown-key` とは別）になり、ヒントに使える行が出ます。どの行で使えるかは `mozcut schema` の「使える行」の列で分かります。

### 見た目

| key | 意味 |
| --- | --- |
| `opacity` | 不透明度（0〜1） |
| `fade` / `fadein` / `fadeout` | フェード（映像と音の両方） |
| `afadein` / `afadeout` | 音だけのフェード |
| `mblur` | 動きのぶれ（モーションブラー。シャッター角と標本の数は project の `mblur.angle` / `mblur.samples`） |

色は `rrggbb` か `rrggbbaa`（`#` は付けても付けなくてもよい）、または `white` / `black` / `red` / `green` / `blue` / `yellow` / `gray` / `transparent`。

### 文字

**`size` は画素です**（フォントの em の大きさ。既定 48、範囲 4〜1000）。720p なら、見出しは 64〜120、字幕は 26〜40 くらいが目安です。

| key | 意味 |
| --- | --- |
| `size` | 文字の大きさ（画素） |
| `color` / `color2` / `grad.angle` | 文字の色（既定 `ffffff`）。`color2` を書くと `color` から `color2` へ `grad.angle` 度のグラデーションで塗る |
| `bg` / `pad` | 背景の箱の色と余白（画素） |
| `shadow` / `shadow.blur` / `shadow.x` / `shadow.y` | 影の色（ずらす量は既定で size/16）と、ぼかし・ずらす量 |
| `outline` / `outlinew` | 縁取りの色と太さ（画素。既定は size/14） |
| `tracking` | 字間（画素。字ごとの送り幅に足す。負なら詰める。既定 0） |
| `fill` | `fill=none` で文字を塗らず、縁取りの輪だけを描く（中が透けて下の絵が見える。`outline` を書かなければ `color` で縁取る。太さは `outlinew`） |
| `italic` / `skew` | 斜体（`italic` とだけ書く。`skew=-12` と同じ）と傾き（度。CSS の `skewX` と同じ向きで、負なら上が右へ傾く。−80〜80） |
| `vertical` | 縦書き（`vertical` とだけ書く） |
| `align` | 複数行の揃え: `left` / `center`（既定）/ `right` |
| `text` | 中身（行の `"..."` と同じ）。`'文字'@時刻` を並べると中身を替えるキーフレーム |

- `size` / `tracking` / `outline` / `outlinew` / `skew` はキーフレームで動かせます（`size="60@0 120@1:ease"`、`tracking="0@0 24@1"`、`outline="ff000000@0 ff3030@1"`）。キーフレームの `size` は小数の大きさのまま描くので、ゆっくり大きくしても段が付きません。
- 中身のキーフレームは `text="'0'@0 '1'@2f '2'@4f '3'@6f"` のように書きます（数え上がる数字など）。字はいつも次のキーまで保ちます（印は読みません）。`'...'` の中には空白や `@` も書け、`'` そのものは `'` と書きます。囲まない値（`text="1@0 2@0.5"`）は空白を含めません。キーより前は最初のキーの字です。

フォントは project の行で決め、text の行で上書きできます（`font` / `fontindex` / `fontweight`）。

```sh
project size=1920x1080 fps=30 font="C:/Windows/Fonts/meiryo.ttc" fontindex=0
text "見出し" font="fonts/NotoSansJP-VF.ttf" fontweight=900
```

- 扱うのは TrueType（`.ttf` / `.ttc`。glyf）と OpenType の CFF（`.otf`。CID-keyed の和文フォントも）のアウトラインです。CFF2 は使えません。
- `font=` の相対パスは、素材と同じく `.mzc` のあるフォルダから探します。
- `fontindex` は TTC の中の書体の番号です（`.ttc` でなければ見ません）。
- `fontweight` は可変フォント（例: `NotoSansJP-VF.ttf`）の太さ（`wght` の軸。100〜900 など、書体の範囲に寄せます）。text の行に書かなければ project の値、どちらもなければ書体の既定の太さです。可変でない書体では効きません。ほかの軸（幅・傾きなど）はまだ決められません。
- 指定したフォントのファイルが見つからないとき、またはフォントとして読めないとき（形式が違う・`fontindex` が書体の数を超えるなど）は、警告 `font-not-found` を出し、既定の候補を順に使います。
- フォントにない字（絵文字など）は □ になります（check が警告 `glyph-missing` を出します）。ゼロ幅スペースや異体字セレクタは描かず、結合文字（é の ´ など）は前の字に重ねます。
- 文字の色そのものを半透明（`color=ffffff80`）にすると、縁取りの色が文字の中に透けます（縁取りは文字の下に敷くため）。下の絵を文字の中に透かしたいときは `fill=none`（縁取りだけ）を使います。文字全体を半透明にするときは `opacity=` を使います。
- 縦書き（`vertical`）では、書体に縦書き用の字形があれば使います（句読点・小書きの仮名は右上、括弧・長音は縦向き）。テキストアニメーター（`anim=`）も縦書きのまま字ごとに動きます。
- カーニングと合字はまだ扱いません。

### 効果（プラグイン）

効果は video / image / **text** / color の行に書けます（audio の行に書くと `key-not-allowed`）。**クリップの行の効果は、そのクリップにだけ掛かります**（小窓やロゴにも別々に掛かります）。文字の行は、文字を透明な層に描いてから効果を掛けて重ねます。

**合成した画面全体に掛けるときは project の行に書きます**（調整レイヤーの代わり）。透明な color の行（`opacity=0`）に効果を書いても、画面全体には掛かりません。

```sh
project size=1280x720 vignette=0.5                  # 画面全体にビネット
video "a.mp4" bright=0.1 vignette=0.6 vignette.radius=0.9 blur=2
text "ぼかした文字" size=80 blur=3 dur=2
video "b.mp4" gray                                  # 名前だけなら主の引数の既定値（gray=1）
video "c.mp4" xfade=0.5 trans=wipe trans.angle=30   # 前のクリップからワイプで切り替える
```

- `<効果>=<値>` は主の引数（最初の引数）を決めて効果を有効にします。`<効果>.<引数>=<値>` はそのほかの引数を決めます（これだけでも効果は有効になります）。
- 効果は **行に初めて出てきた順** に掛けます（上の例は bright → vignette → blur）。
- 書かなかった引数は既定値です。範囲の外は `out-of-range`。
- 別名でも書けます（`saturation=1.2` は `sat=1.2`、`mosaic=8` は `pixelate=8`）。
- `vignette` の中心は、掛ける層の中央です（文字なら文字の箱、小窓なら小窓の中）。
- 透明なまわりがある層（画像・文字）には、効果が広がる分の余白を足してから掛けます（ぼかしが四角く切れません）。映像と色の層は、端の画素をくり返します。
- トランジションは、同じトラックの次のクリップ（`at=` なし）に `xfade=<秒> trans=<名前>` と書くと、前のクリップと重なる区間で切り替えます。

いま入っているプラグイン（`build/plugins/`。[MozaicCut-Plugins](https://github.com/UnifiedMozaic/MozaicCut-Plugins) から作るか取ってくる）:

- 効果（47 個）: `blinds` `blur` `bright` `bulge` `chromakey` `chromatic`（別名 `aberration`）`contrast` `dither` `duotone` `edge` `emboss` `exposure` `filmfade` `glitch` `glow`（別名 `bloom`）`grain`（別名 `noise`）`gray`（別名 `grey`）`halftone` `hue` `invert` `kaleido` `letterbox` `levels` `lightleak` `lumakey` `matteview` `mirror` `motionblur` `pixelate`（別名 `mosaic`）`posterize` `raymarch` `rgbsplit` `ripple` `sat`（別名 `saturation`）`scanline` `sepia` `sharpen` `shatter` `slice` `solarize` `swirl` `temperature` `threshold` `tint` `vibrance` `vignette` `wave`
- トランジション（16 個）: `blinds` `checker` `clock` `diamond` `dipblack` `dipwhite` `dissolve` `glitch` `iris` `lumawipe` `pixelize` `push` `slide` `split` `wipe` `zoom`

`chromakey` と `lumakey` は CPU だけ、ほかは GPU でも動きます（`build/mozcut.exe plugins` の `[GPU+CPU]`）。キーイングの詳しい使い方は [docs/keying.md](docs/keying.md) にあります。引数と範囲は `mozcut schema`（効果ごとの説明は `mozcut plugin list`）で見られます。

### 色の調整（grade.*）

video / image の行に、色の調整（グレーディング）と LUT を書けます。効果より先に掛かります（調整 → 効果の順）。
色のワークスペースのホイール・カーブ・LUT は、この行を書き換えます（既定の値に戻すと、そのキーを消します）。詳しくは [docs/color.md](docs/color.md)。

```sh
video "a.mp4" grade.temperature=5600 grade.lift="0.02 0 -0.01 0" grade.curve.y="0:0 0.5:0.6 1:1" grade.lut=luts/look.cube grade.lut.amount=0.6
```

| キー | 値（何もしない値） | 内容 |
| --- | --- | --- |
| `grade.temperature` / `grade.tint` | K（6504）/ -100..100（0） | 色温度・色かぶり |
| `grade.exposure` / `grade.saturation` | 段（0）/ 倍率 0..4（1） | 露出・彩度 |
| `grade.lift` / `grade.gamma` / `grade.gain` / `grade.offset` | `"r g b m"`（リフトとオフセットは 0、ガンマとゲインは 1）。数 1 つなら m | ホイール。`grade.lift.r=0.02` のように 1 チャンネルだけも書ける |
| `grade.curve.y` / `.r` / `.g` / `.b` | `"x:y x:y ..."`（0..1。`"0:0 1:1"`） | カーブ |
| `grade.hue.sat` / `.lum` / `.hue` | `"度:値 ..."` | 色相ごとの彩度・輝度・色相 |
| `grade.space` / `grade.gamut` / `grade.refnits` | bt1886 / bt709 / 203 | 調整の空間・原色・HDR の基準の白 |
| `grade.lut` | `.cube` のパス（プロジェクトのフォルダから） | LUT |
| `grade.lut.amount` / `grade.lut.interp` | 0..1（1）/ tetrahedral か trilinear | LUT の強さ・補間 |

- 値の誤りは `bad-grade`（「gamma は 0 より大きくします」など）、知らない名前は `unknown-key`、text / color / audio の行では `key-not-allowed`。
- `grade.lut` のファイルがない・壊れているときは、`check` では誤りにならず、`render` と `preview` が「警告: N 行目: grade.lut='…' を掛けません（理由）」を出して、その LUT を掛けずに続けます。
- 描画は、層を BT.1886（γ 2.4）で線形の光にし、調整（33³ の 3D LUT に焼いた表）→ LUT（BT.1886 の空間で）の順に掛けて戻します（src/effects/color/grade.um・lut.um）。

### 音

| key | 意味 |
| --- | --- |
| `volume`（`vol`） | 音量（0〜10、既定 1） |
| `mute` | 動画の音を使わない（`mute` とだけ書く） |

音のトラックごとの音量・パン・ミュート・ソロ・EQ・コンプは、`track` の行に書きます（ミキサーで変えると、この行が書き換わります）。書き出しの音にも効きます。

```
track audio=0 name="声" vol=-3 pan=-0.2 eq=highpass:80,peak:3200:3.5 comp=-20:3
track audio=1 mute
track master vol=-1
```

| key | 意味 |
| --- | --- |
| `audio=<n>` / `master` | 音のトラックの番号（クリップの `track=` と同じく 0 から。映像の音はその映像の `track=`）か、全体 |
| `vol` | 音量（dB。`-inf` か -70 以下は無音、+12 まで） |
| `pan` | −1（左）〜 1（右）。ステレオのバランス |
| `mute` / `solo` | ミュート・ソロ（語だけ書く。ソロのトラックがあれば、ほかは聞こえない） |
| `eq` | `種類:周波数[:利得 dB[:Q]]` をコンマで 8 帯まで（種類は lowpass / highpass / bandpass / notch / peak / lowshelf / highshelf / allpass）。`eqoff` で一時的に外す |
| `comp` | コンプレッサー `しきい値:比[:アタック ms:リリース ms[:ニー:メイクアップ]]`。`compoff` で一時的に外す |
| `name` | トラックの名前 |

処理の順は EQ → コンプ → 音量 → パン、マスターは全体を足した後の音量だけです。

### マーカーと拍

`marker <時刻> [name="名前"] [color=色]` の行は、タイムラインの印です（描画と書き出しには効きません）。編集画面では M で再生ヘッドの位置に足し、Shift+M / Ctrl+Shift+M で前後のマーカーへ移ります。

```
marker 12.5 name="見せ場" color=yellow
marker 1:05
```

操作は `add marker 12.5 name=見せ場`、行を `@行番号` で指して `set @30 at=13 name=サビ`・`unset @30 color`・`delete @30` です。

project の行に `bpm=<テンポ>`（と 1 拍目の時刻 `beat.offset=`）を書くと、タイムラインと合成の画面に拍のグリッドとスナップが出ます（合成の［ビート検出］が曲から決めて書きます）。

拍があるとき、タイムラインは拍の単位で編集します。

- ルーラーに小節の番号、左上の時刻は「小節.拍.16 分」（4 拍で 1 小節）で出ます。
- クリップの移動・トリム・刃は拍の格子に乗ります。拡大して間が 8 画素以上あれば 8 分・16 分の格子です。
- 矢印キーで動かすと格子の 1 つ分、Shift を押すと 1 拍動きます。

曲の途中でテンポや拍の位置が変わるときは、キーフレームと同じ「値@時刻」の並びで書きます（テンポの地図）。時刻から先はその値です。

```sh
project bpm=122.64 beat.offset="0.415@0 0.27@24 0.415@36"
```

### テキストアニメーター

text の行に `anim=<プリセット>` と `anim.<引数>=<値>` を書くと、字・単語・行ごとに位置・拡大・回転・不透明度・色・字間を動かします（After Effects のテキストアニメーター）。見本は `demo/m6/textanim.mzc`、プリセットと引数の表は [docs/design/m6-textanim.md](docs/design/m6-textanim.md)。

```
text "Hello World" anim=bounce animout=fadein animout.dur=0.3
text "こんにちは 世界" anim=rise anim.by=word anim.stagger=0.25
text "SALE" anim.mode=range anim.start="0@0 100@1:ease" anim.opacity=0
```

- アニメーターは `anim` `anim2` `anim3` `anim4`（始まりから）と `animout` `animout2`（終わりから）。プリセット: typewriter / fadein / bounce / rise / pop / slide / spread / wave / colorwave / none。
- 動き方は `anim.mode=stagger`（既定。単位ごとにずらす）か `range`（範囲セレクター。`start` / `end` / `offset` はこのときだけ）。
- `check --json` の `clips[].textanim[].doc` に、読めた設定の日本語の説明が出ます。

**経路に沿った文字**: `path=circle`（円）/ `path=wave`（波）/ `path="M 0 0 C ..."`（SVG の d）で、字を経路の上に並べます（アニメーターの動きのあとで並びを曲げる。`anim=` がなくても書ける。縦書きでは使わない）。

```
text "AROUND THE CIRCLE •" x=center y=center size=28 path=circle path.r=120 path.offset="0@0 754@6"
text "Waves" size=40 path=wave path.amp=14 path.len=160 path.phase="0@0 360@2"
text "along a curve" path="M 0 0 C 80 -120 200 120 290 0" anim=rise
```

- 字の箱の中央を、行の頭からの距離 + `path.offset`（画素）の所に置き、経路の向きに回します（`path.rotate=0` で立てたまま）。`path.offset` を動かすと字が経路の上を流れます。
- 円の中心は字の箱の中央（x / y で置いた所）。距離 0 は円の上で時計回り。`path.r` が負なら下から反時計回り（円の下側に読める向きで並ぶ）。
- 波は 1 行目のベースラインに沿い、`path.amp`（高さ）/ `path.len`（1 周期）/ `path.phase`（度。動かすと波が流れる）。d の座標は 1 行目のベースラインの左端からの画素です。
- `path.r` / `path.amp` / `path.len` / `path.phase` / `path.offset` は `"0@0 300@2:ease"` のようにキーフレームで書けます。開いた経路の外に出た字は、端の向きにまっすぐ並びます。閉じた経路は回り込みます。

### 3D レイヤーとカメラ

video / image / text / color の行に 3D だけのキー（`z` / `ox` / `oy` / `rx` / `ry`）を書くと、3D のレイヤーになります（After Effects の 3D スイッチの代わり）。見本は `demo/m6/threed.mzc`、詳しくは [docs/design/m6-3d.md](docs/design/m6-3d.md)。

```
project camera.z=-2600 light.type=point light.z=-800 mblur.angle=180
video "floor.mp4" rx=70 oy=260 z=200
video "card.mp4" z=-100 ry="0@0 180@4" mblur
text "TITLE" z="-600@0 -200@4" ox="-300@0 300@4"
model "cup.obj" size=400 z=-100 ry="0@0 360@4" color=e0a060
```

- 座標は x が右・y が下・z が奥。`rx` が正なら下の辺が奥へ倒れ、`ry` が正なら右の辺が手前へ回る。`rotation` / `scale` / `anchor` も 3D で効く。
- カメラ `camera.x/y/z`・注視点 `camera.tx/ty/tz`・`camera.fov` / `camera.zoom` / `camera.roll`、被写界深度 `camera.aperture` / `camera.focus`、アンチエイリアス `camera.aa`、ライト `light.type=parallel|point` ほか、モーションブラー `mblur.angle` / `mblur.samples`。
- 続けて並ぶ 3D のレイヤーは奥行きで重なり、間に 2D のレイヤーがあると組が分かれる。
- 3D のキー（と `rotation` / `scale` / `anchor`）のキーフレームの印は、`linear` / `hold` / `ease` / `easein` / `easeout`（`ease=60` で影響 60%）。`smooth` などほかの印はまだ使えない。
- `model` の行は `.obj`（頂点・法線・面）の立体を、3D のレイヤーと同じカメラ・ライトで描きます。`size` はいちばん長い辺の画素、`color` は色。平らな 3D のレイヤーとは画素ごとに奥行きで前後します。モーションブラー・被写界深度・`camera.aa`・テクスチャ・材質（mtl）・glTF には、まだ対応していません。

### パーティクル

行の種類 `particles`（位置で渡す値はない）。火花・塵・雪のような粒を、決まった結果になるシミュレーションで描きます（同じ `seed` なら同じ動き。CPU でも GPU でも同じ）。見本は `demo/m6/particles.mzc`。

```
particles id=sparks at=2 dur=5 emit=point x=960 y=900 rate=400 speed=330 dir=-90 spread=22 gravity=420 life=2 size=7 size.end=2 color=ffd27a color.end=ff3a1a draw=soft blend=add
particles id=dust at=title.start dur=4 emit=layer layer=title rate=3000 turb=500 turb.scale=30 life=0.9
particles id=sakura dur=8 emit=line x=0px y=-40px x2=1920 y2=-40px rate=30 speed=60 dir=100 gravity=30 turb=80 life=14 size=34 size.var=0.4 color=ffc4d6 draw=petal blend=over spin=160 spin.var=1 rot.var=180 prewarm=10 matte=frame
```

- 発生源 `emit=point|line|circle|box|layer`。**particles の行の `x` / `y` は発生源の中心**（center か数。負の数は端から、画面の外は `-200px`）。`emit=layer layer=<ID>` は、そのクリップ（text / color）の形から出す。
- 出し方 `rate` / `burst` / `emit.dur` / `max`、動き `speed` / `dir` / `spread` / `dir.mode=out` / `gravity` / `wind` / `drag` / `turb`、寿命 `life`、見た目 `size` / `size.end` / `color` / `color.end` / `opacity.end` / `opacity.in` / `opacity.out` / `draw=point|soft|ring|star|petal`、重ね方 `blend=add|over`、`seed`、`steps`、`prewarm`。全部のキーは `schema --json` の kinds が `particles` のもの。
- `draw=petal` は桜の花びら（`size` が長さ）。`rot.var` / `spin` の向きで回り、向きに合わせて幅が変わるので、宙で裏返りながら舞うように見える。
- 時間・不透明度・効果・マスク（`mask ... to=`）・トラックマット（`matte=` / `matte.type=` / `matte.invert`）はほかのクリップと同じ（上の 3 行目は、ID が frame のクリップの形の中だけに舞う）。particles の行の `blend=` は粒の重ね方なので、描画モードは選べない。`draw=image`（`sprite=`）の画像はまだ読み込まない。
- 粒のキー（`x` / `y` / `rate` など）はキーフレームで動かせない（`key-not-animatable`）。
- `split` / `trim start` の後半は `in=`（クリップの中の時刻の始まり）で粒を続きから計算し、`full=`（全体の長さ）で粒の数を保つ。text の `anim=` と shape の `drawon` / `drawoff` も同じ（`full=` は終わりから数える `animout` / `drawoff` の基準）。

### シェイプ（ベクターの図形）

行の種類 `shape`。行の 2 番目が形の種類（`rect` / `ellipse` / `polygon` / `star` / `path`）。見本は `demo/m6/shape.mzc`、キーの表は [docs/design/m6-shape.md](docs/design/m6-shape.md)。

```
shape star points=5 r=160 inner=70 pos=320,360 fill="linear(#ffd040,#ff6020)" stroke=#202020 strokew=6 rotation="0@0 144@4:ease"
shape rect w=480 h=270 radius=32 fill=none stroke=white strokew=8 drawon=1.5
shape path d="M 0 0 C 60 -80 120 80 180 0" fill=none stroke=#80ff80 strokew=10 trimend="0@0 1@2"
```

- `x` / `y` はほかのクリップと同じく形の箱の左上（center、負は右端から）。`pos=x,y` は anchor（既定は形の中心）を置く画面の点。
- 塗り `fill` / 線 `stroke`（色、`none`、`linear(...)` / `radial(...)`）、`strokew`、`cap` / `join`、破線 `dash`、トリム `trimstart` / `trimend` / `trimoffset`、`drawon` / `drawoff`、変形 `anchor` / `rotation` / `scale`、リピーター `repeat` ほか。
- path の形（`d`）のキーフレームは `d="'M 0 0 L 200 0 L 100 100 Z'@0 'M 0 0 L 200 0 L 100 -150 Z'@1:ease"` のように `'パスのデータ'@時刻[:印]` を並べます。どのキーも同じ命令を同じ数だけ並べ（数だけを変える）、あいだは数を混ぜて補います（違えば `anim-bad-value`）。`key add` では動かせません。
- キーフレームで動かせる形のキー（`scale` は `scale="1@0 2,0.5@1"` のように 横,縦 も書ける。`fill` / `stroke` は単色だけ: `fill="ff0000@0 0040ff@1:ease"`）: `fill` / `stroke` / `pos` / `anchor` / `rotation` / `scale` / `trimstart` / `trimend` / `trimoffset` / `strokew` / `r` / `inner` / `w` / `h` / `radius` / `repeatx` / `repeaty` / `repeatrot` / `repeatscale`。
- 時間・不透明度・効果・描画モード・マスクはほかのクリップと同じ。

### 描画モード・マスク・トラックマット

見本は `demo/m6/blend.mzc`。詳しくは [src/effects/blend/README.md](src/effects/blend/README.md)。

```
project blend.space=linear blend.tf=bt1886
video "flare.mp4" id=flare blend=screen
video "pip.mp4" id=pip w=640 h=360
mask ellipse to=pip ref=640x360 x=40 y=20 w=560 h=320 feather=60
text "MATTE" id=word size=220
video "fire.mp4" matte=word matte.type=alpha
```

- `blend=<モード>`: normal / add / multiply / screen / overlay / softlight / hardlight / lighten / darken / difference / exclusion / hue / saturation / color / luminosity。`blend.space=display|linear`（project の行に書くとクリップの既定）、project の `blend.tf=bt1886|srgb|bt709`。
- マスクの行 `mask rect|ellipse|path to=<ID> ...`: 座標は層（効果の前の素材の絵）の左上が 0,0。`ref=<幅>x<高さ>`（座標を書いたときの層の大きさ）か `units=norm`（割合）を書く。`mode=add|subtract|intersect|...`、`invert`、`feather`、`expand`、`opacity`、パスは `d="M ... Z"`（SVG と同じ）。上から順に重なる。
- マスクの形と位置は時刻で動かせます: `x` / `y` / `w` / `h` / `round` / `feather` / `expand` / `opacity` に `"0@0 300@1:ease"`、`d` に `"'M 0 0 L 100 0 L 50 80 Z'@0 'M 0 0 L 200 0 L 100 160 Z'@1"`（どのキーも同じ命令の並び）。時刻は掛けるクリップの始まりから。`split` / `trim` は `to=<ID>` のマスクの行のキーもずらします（`to=` のない行と `cut` はそのまま）。
- `matte=<ID>`: そのクリップの形（`matte.type=alpha|luma`、`matte.invert`）で抜く。マットの元は画面に描かない。
- 操作: `add mask <形> to=<クリップ> ...`、マスクの行は `set / unset / delete @行番号`。`split` / `delete` / `rename` はマスクの行と `matte=` も直す。マットの元を `split` すると、`matte=` で使う行も同じ時刻で分けて、後半を `matte=<後半>` にする。
- マットの元が塗る側の時刻の一部にないと、そのあいだ塗る側は描かれない（`matte-gap` の警告）。
- 3D のレイヤーには `blend=` と `matte=` がまだ効かない（`key-ignored` の警告。マスクは効く）。

### エクスプレッション（式）

値の代わりに `expr(...)` を書くと、その値を式で決めます（After Effects のエクスプレッションの代わりの、止まる・決まった結果になる小さな言語）。見本は `demo/m6/expr.mzc`、言語は [docs/design/m6-expr.md](docs/design/m6-expr.md)。

```
color 3070e0 id=title x="expr(ease(time, 0, 1.5, -400, 200))" y=200 y.expr="wiggle(3, 20)"
color e05030 id=dot x="expr(clip('title').x + 360 + 80 * cos(time * 6))"
color 30c070 opacity="0@0 1@0.5:ease" opacity.expr="loopOut('pingpong')"
text "Hi" blur="expr(4 + 4 * sin(time * 4))"
image "logo.png" scale="expr(1 + audioBass() * 0.3)"
```

- `key="expr(...)"` は式だけで決め、`key.expr="..."` はキーの値（キーフレームを含む `value`）に重ねる。空白を含む式は値全体を `"..."` で囲み、式の中の文字列は `'...'`。
- 決められるのは `x` / `y` / `position`（`pos.expr` とも書ける。キーフレームの `pos` に重なる）/ `opacity` / `rotation` / `scale` と効果の引数。式の `x` / `y` はクリップの左上の画素、`opacity` は 0〜1。音量の式は、まだ音に効かないので書けない（`key-not-allowed`。音量はキーフレームで動かす）。
- `loopOut` / `valueAtTime` は、キーフレームと同じ補間（イーズ・ベジェ）の値を引く。
- 音に合わせて動かす関数 `audioLevel()` / `audioBass()` / `audioMid()` / `audioHigh()` / `audioBand(0..15)` は、プロジェクトの音を FFT で調べた値を返す。
- 関数: `wiggle` `linear` `ease` `easeIn` `easeOut` `loopOut` `loopIn` `valueAtTime` `random` `clip('ID')` `sin` `cos` … 一覧は `schema --json` の `expressions`。

### キーフレーム

値の代わりに **`値@時刻[:印]` を空白で並べる**と、その値が時刻とともに動きます（`"..."` で囲む）。見本は `demo/m6/anim.mzc`。

```
text "タイトル" x="-400@0 120@1.5:ease 300@3:hold" opacity="0@0 1@0.5 1@end-0.5 0@end"
image "logo.png" pos="100,100@0 640,360@1:curve 1180,620@2:easein"
video "a.mp4" timeremap="0@0 2@1:ease 2@3 0@4" sat="1@0 0@3"
project vignette="0@0 0.8@6"
```

- 動かせるのは `x` / `y` / `pos` / `opacity` / `color` / `volume` / `timeremap` / `rotation` / `scale` / `anchor` と効果の引数（`blur.radius` など）、text の `size` などの、行ごとに決まったキーです。ほかのキーの値の `@` はふつうの文字です（`src=photo@2x.png`）。どのキーが動かせるかは `schema --json` の `keys[].animatable`、`key` の操作で動かせるかは `keys[].keyOps` で分かります。
- 時刻はクリップの始まりからの秒（`1.5`、`1:02.5`）、コマ（`45f`）、終わりから（`end`、`end-0.5`）。project の行の効果はタイムラインの秒。
- 印: `linear`（既定）/ `hold` / `ease[=影響%]` / `easein` / `easeout` / `smooth`（自動。行き過ぎない）/ `in=速度/影響%` / `out=...` / `cubic=x1,y1,x2,y2`、2 次元の経路は `curve` / `tin=x,y` / `tout=x,y`。
- **キーフレームの `x` / `y` と `pos` は、左上からの画素**（負も可。`-400` は左の画面の外）。ふつうの値の「`center`」「負は右端から」の読み替えはしません。
- `timeremap` は見せる素材の時刻（秒）。速さ・静止・逆再生ができます（音は再マップしません。音のある映像には `timeremap-audio` の警告が出るので、`mute` を付けるか音を別の audio の行に分けます）。
- 効果の引数は別名（`blur` と `blur.radius`）でも同じ値です。2 度書くと後に書いたほうを使い、`duplicate-key` の警告が出ます。
- 操作: `key add <クリップ> <キー> <時刻> <値> [印]`、`key remove / move / set / ease / shift / clear`。`split` / `trim` / `cut` は、タイムラインの上の見え方が変わらないようにキーの時刻を直します（`cut` は範囲をまたぐキーフレームのクリップを分け、project の行のキーも詰めます。またぐ所に置く境目のキーの値は 4 桁に丸めます）。
- `check --json` の `clips[].anims`、`show` の「キーフレーム」の節で、読めた値を確かめられます。

### project の行

| key | 意味 |
| --- | --- |
| `size`（または `width` / `height`） | 画面の大きさ（偶数） |
| `fps` | `30`、`29.97`、`30000/1001` |
| `rate` | 音の標本化周波数（既定 48000） |
| `bg` | 背景色 |
| `duration`（`dur`） | 全体の長さ（省くと最後のクリップの終わりまで） |
| `output`（`out`） | 書き出すファイル |
| `crf` / `preset` | x264 の画質と速さ |
| `font` / `fontindex` / `fontweight` | 文字のフォント（上の「文字」） |
| `bpm` / `beat.offset` | 曲のテンポと 1 拍目（上の「マーカーと拍」） |
| `camera.*` / `light.*` / `mblur.*` | 3D のカメラ・ライトと、モーションブラー（上の「3D レイヤーとカメラ」） |
| `blend.space` / `blend.tf` | 描画モードの空間（上の「描画モード・マスク・トラックマット」） |
| 効果（`vignette=0.5` など） | 合成した画面全体に掛ける効果（上の「効果」） |

## 効果のプラグインを書く

効果とトランジションは、1 ファイルに 1 つの UM のソース（`.um`）から作る `.mzplug` です。ソースは [MozaicCut-Plugins](https://github.com/UnifiedMozaic/MozaicCut-Plugins) の `plugins/<名前>.um`（トランジションは `plugins/transitions/<名前>.um`）にあり、このリポジトリの隣に置けば `mozcut plugin build-all` が見つけて `build/plugins/` に作ります（`MOZCUT_PLUGINS_DIR` で場所を決めることもできます）。本体の登録表 `src/gen/plugins.um` は、組み込みの効果を持たず、起動のときに `.mzplug` を探して読みます。

```ts
// plugins/posterize.um
// @effect posterize "階調を減らす（イラスト・アニメ風の段階的な色にする）"
// @label "ポスタライズ"
// @category color
// @param levels 4 2..32 "階調の段数（小さいほど段階がはっきりする。小数は四捨五入）"
// @gpu 1

export kernel function fx_gpu_posterize(i: u32, dst: mut Buffer<vec4<f32>>, src: Buffer<vec4<f32>>, orig: Buffer<vec4<f32>>,
  w: u32, h: u32, p: f32[8], pass: u32): void { ... }        // GPU 版（WGSL にする）

export function fx_posterize(layer: mut Buffer<vec4<f32>>, tmp: mut Buffer<vec4<f32>>, w: u32, h: u32, p: f32[8]): void { ... }   // CPU 版（wasm）
```

```sh
mozcut plugin build posterize          # dist/posterize.mzplug
mozcut plugin install dist/posterize.mzplug
mozcut plugin list
```

- `@effect <名前> "<説明>"`（トランジションは `@transition`）: 名前は英小文字・数字・`_` で、ファイル名と同じにします。
- `@param <名前> <既定値> <最小>..<最大> "<説明>"`: 0〜8 個。書いた順に `p[0]`, `p[1]`, … に入ります。最初の引数が主の引数です。
- `@alias <別名>`: 効果の別名（何個でも）。
- `@reach <引数> [<倍率>] [round] [max <画素>]`: 効果が周りへ広がる画素数。透明なまわりのある層（画像・文字）で、その分の余白を足してから効果を掛けます。`@whole`: 層全体の大きさ・位置を使う効果に付けます（層を帯に分けずに掛ける印）。
- `@gpu <パスの数>`: GPU 版の kernel（`fx_gpu_<名前>`）から WGSL を作り、`.mzplug` に CPU 版と一緒に入れます。GPU が使えないときは CPU 版で掛けます。
- `@label` / `@category`（color / blur / key / style / other）/ `@init` / `@thumb`: 効果のパネルに出す日本語の名前・分類・最初の値・見本の絵の引数。本体を作り直さずに、パネルに並びます。
- 関数 `fx_<名前>(layer, tmp, w, h, p)` を export します。層は RGBA（0〜1、ストレートアルファ）、`tmp` は同じ大きさの作業用です。**結果は `layer` に残します。** 名前の空間は全ファイルで 1 つなので、kernel や補助の関数には名前を前置します。
- 組み込みの効果・コアのキー・入れてある包みと名前がぶつかるときは入れられません。
- `.mzplug` は wasmtime で動き、ファイルやネットワークには触れません。層を横の帯に分けて CPU の全コアで並列に掛けます。プラグインが止まった（範囲外の添字など）・時間内に終わらない・メモリを使いすぎたときは、層を変えずに理由を返します（全体は止まりません）。
- 入れた `.mzplug` は、check / preview / render と編集画面のすべてで使います。編集画面では、効果のパネルの［再読込］で、起動したまま足し外しを反映できます。
- 宣言の書き方の全部は [docs/design/architecture.md](docs/design/architecture.md) の「効果プラグインの書き方」と「wasm のプラグイン（.mzplug）」、プラグインのリポジトリの README にあります。

## 編集画面

`mozcut edit project.mzc` でウィンドウが開きます。左が素材の欄、中央がモニター、右がインスペクタ・履歴・AI のタブ、下がタイムラインです（映像のトラックは番号の大きいものが上、音は下）。上の帯の札で、カット編集・合成・色・音・出力のワークスペースを切り替えます。画面も UM で書いてあり（`src/editor.um` と `src/editor/`）、文字は TrueType（Yu Gothic UI を優先）で描きます。配置と操作は [docs/design/edit2.md](docs/design/edit2.md)、合成のワークスペースは [docs/design/comp.md](docs/design/comp.md)、使い方は [docs/manual/02-editing.md](docs/manual/02-editing.md) にあります。

`node tools/mozcut.mjs edit`（プロジェクトなし）か `build/mozcut-edit` を引数なしで起動すると（最近の一覧は `%APPDATA%\MozaicCut`）、スタート画面になり、最近開いたプロジェクトを開くか、新しいプロジェクトを作れます（［開く…］で `.mzc` を選ぶ、`.mzc` を窓に落とす、素材を落として新しいプロジェクトを作る、もできます）。詳しくは [docs/design/edit2.md](docs/design/edit2.md) の「スタート画面」。

配布の形の編集画面は、1 日に 1 回 GitHub Releases に新しい版があるかを裏で確かめ、あれば状態の帯で知らせます（勝手には入れません。［更新］で落として SHA-256 を確かめ、閉じるときに入れ替えます）。仕組みは [docs/release.md](docs/release.md) の「自動更新」。

### exe だけで使う（配布の形）

`node tools/mozcut.mjs package` で、`dist/MozaicCut/` に node も UM も要らない配布の形を作ります（FFmpeg の組み込みが要ります）。macOS では `dist/MozaicCut.app` を作ります（手順と、まだ Mac で確かめていないことは [docs/build-mac.md](docs/build-mac.md)）。リリースの手順と GitHub Releases に置くファイルの名前は [docs/release.md](docs/release.md)。

- 中身: `MozaicCut.exe`（編集画面。コンソールの窓を出さない Windows のサブシステムで、アイコン入り）、`mozcut.exe`（CLI と MCP のサーバー）、exe が読み込む DLL（SDL3・wasmtime・wgpu-native・FFmpeg の LGPL の共有ライブラリ。PE の import をたどって `build/` から集める）、`plugins/`（`.mzplug` の一式）、`resources/tokens.json`、`MozaicCut.ico`、`README.txt`（利用者向けの使い方）、`THIRD-PARTY-NOTICES.txt`（部品とライセンス、FFmpeg の元のソースの入手先と DLL の差し替え方）、`licenses/`（ライセンスの全文）。
- `MozaicCut.exe` をダブルクリックするとスタート画面が出ます。最近の一覧は `%APPDATA%\MozaicCut\mozcut-recent.txt`（exe の隣には書かない）、新しいプロジェクトの既定の保存場所は `ドキュメント\MozaicCut` です。
- `.mzc` を `MozaicCut.exe` に落とすか、`.mzc` の［プログラムから開く］で `MozaicCut.exe` を選ぶと、そのプロジェクトが開きます。MozaicCut はレジストリを書かないので、`.mzc` をダブルクリックで開く関連付けは［プログラムから開く］→［別のプログラムを選択］→［PC でアプリを選ぶ］で `MozaicCut.exe` を選び［常に使う］にします（`README.txt` にも同じ手順）。
- 素材の読み込み・効果・書き出し（「出力」のワークスペースの MP4・ProRes 422 HQ・WAV・M4A）は、どれも exe の中で行います。`mozcut.exe render project.mzc --out out.mp4` のように、コマンドでも書き出せます。
- コンソールの窓を出さないのは、リンカへの指示（`/SUBSYSTEM:WINDOWS` と `/ENTRY:mainCRTStartup`）だけを持つオブジェクト（`build/gui-subsystem.obj`。`mozcut.mjs` が書く）を UM の `--link-input` で渡しているからです。標準エラー出力は、起動した側がつないだもの（`mozcut.mjs edit`、テストのパイプ）にはそのまま出ます。

### 読み直しと再生

- テキストエディタで `.mzc` を書き換えて保存しても、画面はすぐに読み直します。
- 予備の経路の `mozcut edit` は裏でファイルを見張り、変わるたびに必要な素材だけ ffmpeg で展開し直します（展開が済むまでは古い展開からずらして表示します）。
- 再生は時計に合わせてコマを選び、描くのが遅れたらコマを飛ばします。等速の順再生では音を鳴らし（SDL3 の音の出力）、鳴らした標本の数を時計にして映像を音に合わせます。映像のコマは別のスレッドが自分の展開器で先読みします。逆再生は、後ろへ 1 コマずつ読むと毎コマ前のキーフレームから展開し直すことになるので、数コマ〜30 コマの塊ごとに前から続けて先読みし、まだ展開できていなければ前のコマを出したまま少し（最大 0.15 秒）待ちます。

## ソースの地図

```
src/                    本体の UM のソース。main を置くのはこの一番上だけで、import はこの中で閉じる
├─ main.um              エンジンのコマンド（check / show / op / schema / plugins / mcp / motion / transcribe / caps /
│                       sources / plan / render / preview）。ウィンドウなし
├─ editor.um            編集画面（ウィンドウ。SDL3 をリンクする。中身は editor/）
├─ azmain.um            解析の部品（effects/analyze/）を単独で試すための入口（build/mozcut-analyze）
├─ engine/              芯: .mzc の読み取りと診断（project・keys・lineedit）、操作（ops）、出力（report）、描画（render）、
│                       素材（media・ffmpeg・ffmpeg_off）、書き出し（encode・presets・renderqueue）、再生（playback・audioplay）、
│                       音のミックス（audio・audiomix/）、音連動の解析（audioreact）、字幕（subtitle）、文字起こし（transcribe）、
│                       MCP のサーバー（mcp）と AI 向けの指針（aiguide）、キーの割り当て（keymap）、画面の文言（i18n）、
│                       シーケンスの形式（seqfmt）、文字列の道具（text）
├─ effects/             描画と音の処理
│  ├─ anim/             キーフレーム（読み取り・評価・操作・グラフエディタ・時刻の再マップ）
│  ├─ analyze/          素材の解析（映像・音・文字起こしと、そこからの操作の提案）
│  ├─ blend/            描画モード・マスク・トラックマット
│  ├─ color/            色の処理（伝達関数・色域・LUT・調整・スコープ）と、色の調整を層に掛ける gradelayer.um
│  ├─ dsp/              音の処理（EQ・ダイナミクス・ラウドネス・真のピーク・波形）
│  ├─ expr/             エクスプレッション（式の言語、評価、画素の式の kernel）
│  ├─ fxs/              エフェクトスクリプト（読み取り・検査、WGSL と wasm への変換）
│  ├─ particles/        パーティクル
│  ├─ shape/            シェイプ（ベクターの図形）
│  ├─ text/             文字（TrueType・CFF・可変フォントの読み取り、縦書きの字形、文字の層の描画、字の有無の確かめ）
│  ├─ textanim/         テキストアニメーター
│  ├─ threed/           3D レイヤーとカメラ、.obj のモデル
│  ├─ track/            モーショントラッキングと motion コマンド
│  ├─ xform/            2D のレイヤーの変形
│  ├─ transition.um     トランジション（前と次の映像を進行度で切り替える）
│  └─ wasmfx.um         効果・トランジションのプラグイン（.mzplug）の読み込みと実行
├─ ui/                  画面の部品（描いて出来事を返す）
│  ├─ kit/              uikit（即時モードの UI の芯と基本の部品）
│  ├─ icons/            アイコンの描画とアイコンのボタン
│  ├─ timeline/ monitor/ pool/ inspector/ mixer/ color/ export/ keymap/
│  │                    タイムライン・モニター・素材の欄・インスペクタ・ミキサー・色のパネル・書き出し・キーの割り当て
│  └─ theme_uk.um theme_font.um   生成したテーマを uikit に写す・テーマのフォント
├─ workspaces/          ワークスペース（audio / color / export / motion。部品を並べ、値の変化を操作にする）
├─ editor/              編集画面の中身（状態・配置・コマンド・部品ごとの配線 wire_*.um・右の欄 rail_*.um・
│                       合成のワークスペース ws_comp.um と wcomp_*.um・スタート画面 start.um・自動更新 upd_*.um）
├─ ai/                  アプリの中の AI のエージェント（提供元・HTTP・道具・料金）と、AI のパネル（ai/ui/）
└─ gen/                 生成物（プラグインの登録表 plugins.um・テーマ・アイコン・版 version.um。手で書かない）
demos/                  画面の部品の見本（*_demo.um）。src/ の写しの一番上に置いて作る
tests/                  テスト（tests/run.mjs の群と、部品ごとの tests/<部品>/run.mjs とその試しの .um。tests/all.mjs で全部）
tools/                  開発の道具（ビルドと ffmpeg とのやり取りの mozcut.mjs、FFmpeg の探し方 ffmpeg-libs.mjs、
                        プラグインの登録表と .mzplug を作る gen-plugins.mjs、ほかの生成の gen-*.mjs、配布の package.mjs、
                        Node の MCP のサーバー mcp-server.mjs、デモの素材の demo-media.mjs）
presets/                効果・文字・音のプリセット（fx.mzc・text.mzc・audio.mzc・custom.mzc。本体を作り直さずに足せる）
docs/                   説明書（manual/）、AI 向けの手引き（ai.md・mcp.md）、解析（analyze.md）、色（color.md）、キーイング（keying.md）、
                        エフェクトスクリプト（effect-script.md）、Mac のビルド（build-mac.md）、リリース（release.md）、設計（design/）
assets/                 アプリのアイコンとライセンスの文
demo/                   デモのプロジェクト（demo.mzc、機能ごとの見本の m6/、lyric/）と素材
build/                  ビルドしたもの（mozcut・mozcut-edit・DLL・plugins/*.mzplug。git に入れない）
```

- 効果とトランジションのソースは、このリポジトリにはありません（[MozaicCut-Plugins](https://github.com/UnifiedMozaic/MozaicCut-Plugins)。上の「効果のプラグインを書く」）。
- demos/ と tests/ の .um は、中の import が src/ の一番上からの相対です（UM の import は main のフォルダの外に出られないため）。作るときは src/ を一時フォルダに写し、その一番上に置いてビルドします（`tests/umtest.mjs` の `buildTool` がこれをします）。
- モジュールごとの約束ごと（公開する型と関数）は `docs/design/architecture.md` の「モジュール」の表にあります。
- 素材は FFmpeg の組み込みが、プロジェクトのコマの速さとクリップの大きさで、その場で YUV 4:2:0（素材の色の行列のまま。描画の kernel が係数で RGB にする）に展開します。予備の経路では ffmpeg がクリップごとに生の YUV 4:2:0（Y4M、BT.709 リミテッド）に展開し、エンジンが `readFileRange` で 1 コマずつ読みます（キャッシュはディスクを使う。720p で 1 秒あたり約 40 MB）。

## まだないもの

- 2 倍・4 倍・逆再生の音（編集画面は等速の順再生のときだけ音を鳴らす）と、timeremap の音の再マップ
- 映像と音のストリームの始まりがずれている素材（MPEG-TS、カメラの MTS、編集リストのない MP4 など）の音と映像の合わせ: UM の FFmpeg の組み込みは、映像と音のそれぞれのストリームの最初の時刻を 0 として返し、ストリームの始まりの時刻を教えないので、そのずれの分だけ音と映像がずれます（UM への要望）
- 素材の回転（スマートフォンの縦の動画の rotation）
- 予備のフォント（絵文字など、フォントにない字を別のフォントで描く）、カーニングと合字、CFF2 の書体
- 3D のレイヤーの描画モード・トラックマット、`model` の行のテクスチャ・材質・モーションブラー、パーティクルの画像（`draw=image`）
