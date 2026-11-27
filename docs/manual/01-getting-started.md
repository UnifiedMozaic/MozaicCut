# 1. はじめに

[目次](README.md) ／ 前: [0. はじめての人へ](00-beginner.md) ／ 次: [2. 編集の基本](02-editing.md)

この章は、MozaicCut を動かす 2 つの形（配布の形と開発用のフォルダ）、スタート画面、プロジェクトの開き方・作り方、`show` の読み方の参照です。画面の見方そのものは [0.4](00-beginner.md#04-編集画面の見方) にあります。

## 1.0 配布の形（exe だけで使う）

配布の形（`node tools/mozcut.mjs package` で作る `dist/MozaicCut/`。Mac は `dist/MozaicCut.app`）があれば、下の「必要なもの」はどれも要りません。

- `MozaicCut.exe` をダブルクリックするとスタート画面が出ます。
- `.mzc` は `MozaicCut.exe` に落とすか、［プログラムから開く］で `MozaicCut.exe` を選ぶと開きます（ダブルクリックで開けるようにする手順は、そのフォルダの `README.txt`）。
- 同じフォルダの `mozcut.exe` は、Node.js なしで動くコマンドです（`check`・`show`・`op`・`schema`・`render`・`preview`・`mcp` など。使い方は `mozcut.exe` を引数なしで実行すると出ます）。引数の形は、開発用の `node tools/mozcut.mjs` と少し違います（たとえば `render` は `--out` を付けたときに MP4 を書きます）。
- 効果とトランジションは、同じフォルダの `plugins/` にある `.mzplug` です。
- 最近の一覧・キーの割り当ての配列・設定は `%APPDATA%\MozaicCut` に置きます。

## 1.1 開発用のフォルダで使うときに必要なもの

| もの | 何に使うか | 入れ方・場所の伝え方 |
| --- | --- | --- |
| Node.js 22.18 以上 | コマンド（`tools/mozcut.mjs`）を動かす | PATH に置く |
| [UnifiedMozaic](../../../UnifiedMozaic)（UM）と clang | MozaicCut のエンジンと編集画面を作る | MozaicCut の隣のフォルダに置くか、環境変数 `UM_HOME` |
| FFmpeg 7.1 以降の共有ライブラリ（LGPL のビルド） | 素材を読む・動画に書き出す（エンジンに組み込む） | 環境変数 `UM_FFMPEG_HOME`（なければ隣とホームフォルダを探す）。見つからなければ、ffmpeg と ffprobe のコマンドで展開する予備の経路で動く |
| ffmpeg のコマンド | `preview` の PNG への変換、デモの素材作り（`tools/demo-media.mjs`）、予備の経路 | PATH に置くか、環境変数 `FFMPEG` / `FFPROBE` |
| wasmtime | 効果とトランジション（`.mzplug`）を動かす | 隣かホームフォルダの `wasmtime-*`、または環境変数 `UM_WASMTIME` |
| wgpu-native（なくてもよい） | GPU で描く・効果を掛ける | 隣かホームフォルダの `wgpu-native/<版>`、または環境変数 `UM_WGPU_HOME`。なければ CPU だけの版になる |
| SDL3（3.2.12 以上） | 編集画面（ウィンドウ）だけに使う | Windows は `SDL3-devel-*-VC.zip` を展開して `UM_SDL3`（なければ隣とホームフォルダの `SDL3-*` を探す）。macOS は `brew install sdl3` |
| TrueType / OpenType のフォント | 文字を描く | 指定しなければ、游ゴシック Medium → BIZ UDゴシック → メイリオ → Arial Unicode → IPAex ゴシック → DejaVu Sans の順に探す |

コマンドだけで編集・書き出しをするなら、SDL3 はなくても動きます。

## 1.2 はじめての起動（開発用のフォルダ）

MozaicCut のフォルダで、次を順に実行します。

```sh
node tools/demo-media.mjs              # デモの素材を作る（初回だけ。ffmpeg を使う）
node tools/mozcut.mjs check demo/demo.mzc
```

初回は、エンジン（`build/mozcut`）と効果のプラグイン（`build/plugins/*.mzplug`）を自動で作ります（数十秒かかります）。プラグインは、`plugins/` か隣の `MozaicCut-Plugins/` にソースがあればそこから作り、なければ GitHub の Releases からビルド済みのものを取ってきます。終わると次のように出ます。

```console
$ mozcut check demo/demo.mzc
問題はありません（クリップ 10 個、長さ 0:10.500）
```

エンジンと編集画面を明示的に作り直すときは `mozcut build` です（`mozcut build engine` / `mozcut build editor` で片方だけ）。`src/` や `plugins/` を書き換えたときは、次の実行で自動で作り直します。

使えるコマンドの一覧は `mozcut help` で出ます。

```console
$ mozcut help
使い方: node tools/mozcut.mjs <コマンド> ...

  edit    [<project.mzc>]                       編集画面を開く（ウィンドウ。SDL3 が要る。省くとスタート画面）
  render  <project.mzc> [-o out.mp4] [--from t] [--to t] [-j N]
                                                動画を書き出す（既定は project の output）
  preview <project.mzc> <time> [-o preview.png] 1 コマを画像に書く
  check   <project.mzc> [--json]                誤りを調べる（誤りなし 0、誤りあり 1）
  show    <project.mzc> [--width N]             タイムラインの図とクリップの一覧
  op      <project.mzc> <操作...> [--dry-run] [--json]
  op      <project.mzc> --file <ops.txt | -> [--dry-run] [--json]
                                                操作を適用して保存する。--file はファイル（- なら標準入力）の 1 行に 1 つ
  schema  [--json]                              キー・効果・操作・時刻と参照の書き方の一覧
  motion  <project.mzc> <追うクリップ> <x,y> --to <動かすクリップ> [--dry-run] [--json]
                                                映像の中の点（画面の画素）を追い、動かすクリップの位置のキーフレームにする
  build   [engine | editor]                     エンジンと編集画面を作り直す（片方だけも可）
  package [-o <dir>]                            配布の形を作る。Windows は dist/MozaicCut/（MozaicCut.exe と DLL・tokens.json・
                                                アイコン・説明書・ライセンスの文書）、macOS は dist/MozaicCut.app。node なしで動く
  plugin build <名前 | file.um> [-o out.mzplug] 効果・トランジションのプラグインを wasm（.mzplug）にする
  plugin build-all [--force]                    plugins/（または ../MozaicCut-Plugins/）の全プラグインを build/plugins/*.mzplug へ差分ビルドする
  plugin fetch [--tag <版>] [--repo <owner/repo>] GitHub Releases からビルド済みプラグイン一式（mozaiccut-plugins.zip）を build/plugins/ へ取得する
  plugin list [--json]                          組み込み（0）・標準（build/plugins/）・追加（plugins-installed/）の .mzplug 一覧
  plugin install <file.mzplug>                  .mzplug を plugins-installed/ に入れる
  plugin uninstall <名前>                       入れた .mzplug を外す

op の書き方: node tools/mozcut.mjs schema
```

## 1.3 スタート画面

プロジェクトを渡さずに起動すると、スタート画面が開きます（配布の形なら `MozaicCut.exe` をそのまま起動、開発用のフォルダなら `mozcut edit`）。絵は [0.2](00-beginner.md#02-起動する) にあります。

| 場所 | できること |
| --- | --- |
| 左「新しいプロジェクト」 | 名前・解像度とフレームレート（既定は「最初の素材に合わせる（おすすめ）」。一覧から選ぶか「自分で決める」）・保存する場所（［変える…］）・詳しい設定（音のレート・色の範囲）を決めて［作成する］（Enter）。保存する場所に `<名前>.mzc` を書いて開きます。同じ名前のファイルがあれば上書きせずに知らせます |
| 左［開く…］（Ctrl+O） | ファイルのダイアログで `.mzc` を選んで開く |
| 左の点線の枠 | 素材やフォルダを落とすと、新しいプロジェクトを作って落とした素材を順に並べて開く。`.mzc` を落とせばそれを開く |
| 右「最近のプロジェクト」 | 編集画面で開いたプロジェクトが新しい順に最大 10 件。カードには名前・場所・大きさとフレームレート・長さと、「問題なし」「エラー N」「警告 N」「素材がありません N」「外で変更あり」の札が出ます。「絞り込む」で探し、更新が新しい順・名前の順・長さの順に並べ替え、カードとリストを切り替えられます。↑↓ で選び Enter（かクリック）で開きます |
| 下「キーの割り当て」 | MozaicCut 標準・Premiere Pro 互換・DaVinci Resolve 互換・MozaicCut 0.x から選ぶ（[2.11](02-editing.md#211-キーの一覧編集画面)）。どの配列でも Delete は隙間を残す削除です |
| 上の帯の歯車 | 設定（Ctrl+,） |

最近の一覧は `<設定の置き場所>\mozcut-recent.txt`、選んだキーの配列は `mozcut-keymap.txt` に書きます。設定の置き場所は既定で `%APPDATA%\MozaicCut` です（`mozcut-edit.exe --home <フォルダ>` で変えられます）。

## 1.4 プロジェクトを開く

開き方は次のどれでも同じです。

- スタート画面のカード・［開く…］・`.mzc` のドロップ
- 編集画面のファイルのメニューの［プロジェクトを開く…］（Ctrl+O）
- 端末から `mozcut edit <project.mzc>`

```sh
mozcut edit demo/demo.mzc
```

![編集画面（clip_b を選んだところ。右のインスペクタに clip_b の設定が出ている）](images/editor.png)

- FFmpeg を組み込んだ版（配布の形と、FFmpeg のライブラリを見つけてビルドした版）は、素材をそのまま読みます。予備の経路の版は、`mozcut edit` が素材を ffmpeg で `<名前>.cache/` に展開してから開きます（2 回目からはキャッシュを使います）。
- 編集画面は、開いている `.mzc` を 0.4 秒ごとに見ています。テキストエディタやコマンド、AI が `.mzc` を書き換えて保存すると、画面はすぐに読み直し、その書き換えを取り消しの 1 つとして積みます（[2.8](02-editing.md#28-取り消しとやり直し)）。
- 編集はどれも、操作のたびに `.mzc` に書き込みます（自動保存）。Ctrl+S でも保存できます。
- 閉じるのは Ctrl+Q（ファイルのメニューの［終わる］）です。

### トラックの番号

画面のタイムラインは、トラックの番号を **1 から** 数えます（V1、V2 …、A1 …）。`.mzc` の `track=` と `show` の表は **0 から** 数えます。画面の V1 が `track=0`（`show` の V0）、V2 が `track=1` です。上の絵の V4 にある `pip` は、`.mzc` では `track=3` です。

### コマンドで中身を見る（`show`）

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
#4  logo       15  image  V1        0:02.000  0:10.500  media/logo.png                            -
#5  title      18  text   V2        0:00.200  0:01.800  "MozaicCut"                               -
#6  subtitle   19  text   V2        0:00.600  0:01.800  "Written in UnifiedMozaic"                -
#7  caption_a  20  text   V2        0:02.500  0:05.500  "Clip A: testsrc2\n小窓: pixelate + ..."  -
#8  caption_b  21  text   V2        0:06.500  0:09.500  "Clip B: mandelbrot\nsat=1.4 vignett..."  -
#9  bgm        24  audio  A0        0:00.000  0:10.500  media/bgm.wav                             -
```

`V` は映像のトラック（番号が大きいほど手前に描く）、`A` は音のトラックです（どちらも 0 から）。左の `#0`、`#1` … と `ID`、`行` は、操作でクリップを指すときに使います（[2.2](02-editing.md#22-クリップの指し方)）。

## 1.5 プロジェクトを作る

画面で作るなら、スタート画面の「新しいプロジェクト」か、素材を点線の枠に落とします（[1.3](#13-スタート画面)、[0.3](00-beginner.md#03-新しいプロジェクトを作る)）。編集画面からは、ファイルのメニューの［新しいプロジェクト…］（Ctrl+N）で保存する場所を選んで作れます。できるのは、次のような短い `.mzc` です（素材を落としたときは素材の行も並びます）。「最初の素材に合わせる」のときは、はじめ 1920x1080・30fps にしておき、最初の映像を入れたときにその大きさとフレームレートに合わせ直します。

```sh
# 旅行の思い出（MozaicCut のスタート画面で作ったプロジェクト）
project size=1920x1080 fps=30 rate=48000 bg=000000
```

プロジェクトは **テキストファイルを 1 つ書く** だけでも始められます。次の例は、この章と [2 章](02-editing.md) で使う `first.mzc` です。

1. 好きなフォルダを作り、素材を入れます（例: `C:\Users\you\Videos\myvideo\media\`）。
2. 同じフォルダに `first.mzc` を作り、テキストエディタで次のように書きます（UTF-8 で保存）。

```sh
# はじめてのプロジェクト
project size=1280x720 fps=30 output=first.mp4

video "media/clip_a.mp4" id=opening in=1 out=4
video "media/clip_b.mp4" id=main xfade=0.5
text "はじめての動画" id=title at=0.5 dur=2 size=80 outline=000000
audio "media/bgm.wav" id=bgm dur=8.5 volume=0.3 fadeout=1
```

3. 誤りがないか調べ、タイムラインを見ます。

```console
$ mozcut check first.mzc
問題はありません（クリップ 4 個、長さ 0:08.500）
$ mozcut show first.mzc --width 80
first.mzc
1280x720  30fps  48000Hz  0:08.500  クリップ 4
    0:00    0:01     0:02     0:03     0:04     0:05     0:06     0:07     0:08
    +-------+--------+--------+--------+--------+--------+--------+--------+----
V2      [title           ]
V0  [opening                 ]
                          [main                                                ]
A0  [bgm                                                                       ]

 #  ID       行  種類   トラック      開始    終わり  素材 / 文字       効果
#0  opening   4  video  V0        0:00.000  0:03.000  media/clip_a.mp4  -
#1  main      5  video  V0        0:02.500  0:08.500  media/clip_b.mp4  -
#2  title     6  text   V2        0:00.500  0:02.500  "はじめての動画"  -
#3  bgm       7  audio  A0        0:00.000  0:08.500  media/bgm.wav     -
```

4. 編集画面で開くなら `mozcut edit first.mzc`、動画にするなら `mozcut render first.mzc` です。

- 素材のパスは、`.mzc` のあるフォルダからの相対パスか、絶対パスで書きます。
- `video` の 2 行目に `at=` がないので、1 本目の後ろに並びます。`xfade=0.5` で 0.5 秒重ねてクロスフェードします。
- 音（`audio`）は、`dur=` を書かないと素材の終わりまで使います。BGM が動画より長いと、全体の長さも BGM に合わせて伸びます（上の例は `dur=8.5` で合わせています）。

書き方の詳しい説明は [3. テキストで編集する](03-text.md) にあります。
