# MozaicCut

[UnifiedMozaic](../UnifiedMozaic)（UM）で書いた、**テキストで編集する動画編集ソフト**です。

- プロジェクトは 1 行に 1 クリップのテキストファイル（`.mzc`）です。手で書いても、コマンド（`op`）でも、編集画面でも、AI のエージェントからでも、同じ書き方・同じ操作で編集できます。
- カット・並べ替え・効果・重ね合わせ・文字（TrueType。日本語も書ける）・音のミックスは、すべて UM のネイティブバイナリが行います。画素の処理は `kernel` なので、CPU の全コアで並列に動きます（`UM_WGPU=1`（Windows・Linux・macOS）か、Apple Silicon で `UM_METAL=1` を付けてビルドすれば GPU でも動きます。CPU と GPU の絵は 1 バイトも違いません）。
- 誤りは「ファイル:行:列: エラー[原因コード]: 理由」と「ヒント（直し方）」の形で出ます。`--json` を付ければ機械向けの JSON でも出ます。
- 効果（ぼかし、セピア、ビネット、モザイク…）はプラグイン（`plugins/*.um`）です。1 ファイル足せば効果が 1 つ増えます。

動画の圧縮・展開（H.264 などのコーデック）は、UM の FFmpeg の組み込み（FFmpeg の LGPL のライブラリ）を使い、エンジンがその場で行います。素材を事前に別の形式へ展開せず、素材のファイルを直接開いてコマ単位でシークし、書き出しは MP4 を直接書きます。

```
project.mzc ──▶ mozcut (UM) ──FFmpeg の組み込み──▶ 素材を直接開いてその場で展開（コマ単位のシーク、音は f32）
                     │
                     └──render──▶ 1 コマずつ合成 ──FFmpeg の組み込み（H.264 + AAC。ハードウェアの符号器があれば使う）──▶ out.mp4
```

FFmpeg のライブラリが見つからない環境では、予備の経路で動きます: `tools/mozcut.mjs` が ffmpeg / ffprobe のコマンドで素材を生の Y4M / PAM / PCM のキャッシュに展開し、エンジンが合成した Y4M + PCM を ffmpeg のコマンドで圧縮します（UM には子プロセスを起動する機能がないので、コマンドとのやり取りは Node のスクリプトが受け持ちます）。

使う人向けの説明書（はじめに・編集の基本・効果・書き出し・困ったとき）は [docs/manual/](docs/manual/README.md)、AI のエージェントから使うときの手引きは [docs/ai.md](docs/ai.md)、内部の約束ごと（モジュール・型・関数の形）は [docs/design/architecture.md](docs/design/architecture.md) にあります。

## 必要なもの

- [UnifiedMozaic](../UnifiedMozaic) とその環境（Node.js 22.18 以上、clang）。このリポジトリの隣に `UnifiedMozaic` を置くか、環境変数 `UM_HOME` でその場所を指定します。
- FFmpeg 7.1 以降の**共有ライブラリの LGPL のビルド**（Windows は [BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds/releases) の `ffmpeg-n9.0-latest-win64-lgpl-shared-9.0.zip` など）。展開した場所を環境変数 `UM_FFMPEG_HOME` に設定します（macOS / Linux は `pkg-config` か Homebrew でも見つかります。詳しくは UnifiedMozaic の `docs/media.ja.md`）。ビルドすると FFmpeg の DLL を `build/` に写します。
  - 見つからなければ、FFmpeg の組み込みなしの版をビルドし、ffmpeg と ffprobe のコマンド（PATH に置くか、環境変数 `FFMPEG` / `FFPROBE` で指定）で展開・圧縮する予備の経路で動きます。`MOZCUT_NO_FFMPEG=1` を付けると、ライブラリがあっても予備の経路にします。
  - `preview` の PNG への変換と、テスト・デモの素材作り（`tools/demo-media.mjs`）には、ffmpeg のコマンドも使います。
- 編集画面（ウィンドウ）を使うときだけ SDL3（3.2.12 以上）。
  - Windows: [SDL のリリース](https://github.com/libsdl-org/SDL/releases) の `SDL3-devel-*-VC.zip` を展開し、環境変数 `UM_SDL3` にその場所を設定します（設定しなければ、このリポジトリの隣とホームフォルダの `SDL3-*` を探します）。
  - macOS: `brew install sdl3`。
- 文字の描画には TrueType のフォントを使います。指定がなければ、游ゴシック Medium → BIZ UDゴシック → メイリオ → Arial Unicode → IPAex ゴシック → DejaVu Sans の順に探します（どれもなければ 5x7 のビットマップフォントで描きます）。

## はじめに

```sh
node tools/demo-media.mjs                        # デモの素材を作る（初回だけ）
node tools/mozcut.mjs check   demo/demo.mzc      # 誤りがないか調べる
node tools/mozcut.mjs show    demo/demo.mzc      # タイムラインの図とクリップの一覧
node tools/mozcut.mjs preview demo/demo.mzc 3.5  # 3.5 秒の 1 コマを demo/preview.png に
node tools/mozcut.mjs render  demo/demo.mzc      # demo/demo.mp4 を書き出す
node tools/mozcut.mjs edit    demo/demo.mzc      # 編集画面を開く
```

- 初回はエンジン（`build/mozcut`）を自動でビルドします。`src/**/*.um` や `plugins/*.um` を書き換えると、次の実行で作り直します。`node tools/mozcut.mjs build` で、エンジンと編集画面を明示的に作り直せます。
- FFmpeg の組み込みがあれば、素材は事前に展開しません（`<プロジェクト名>.cache/` には preview の中間の画像だけを置きます）。予備の経路では、素材の展開結果が `<プロジェクト名>.cache/` に残り、クリップの設定や素材が変わらなければ再利用します。
- `node tools/mozcut.mjs help` で使い方の一覧が出ます。

## コマンド

以下、`mozcut` は `node tools/mozcut.mjs` の略です。

| コマンド | すること | 終了コード |
| --- | --- | --- |
| `check <p.mzc> [--json]` | 誤りを調べる | 0: 誤りなし / 1: 誤りあり・読めない / 2: 使い方の誤り |
| `show <p.mzc> [--width N]` | タイムラインの図とクリップの一覧（既定の幅は 100 文字。track の行があれば音のトラックの設定の表も） | 0 / 1 / 2 |
| `op <p.mzc> <操作...> [--dry-run] [--json]` | 操作を 1 つ適用して保存する | 0: 成功 / 1: 失敗（何も書き換えない） / 2: 使い方の誤り（操作がないなど） |
| `op <p.mzc> --file <ops.txt \| -> [--dry-run] [--json]` | ファイル（`-` なら標準入力）の操作をまとめて適用する | 同上 |
| `schema [--json]` | 使えるキー・効果（プラグイン）・時刻と参照の書き方・操作の一覧 | 0 |
| `preview <p.mzc> <時刻> [-o x.png]` | 1 コマを画像にする（既定は `.mzc` と同じフォルダの `preview.png`。`.bmp` も可）。全体の長さより後ろなら警告を出す | 0 / 1 / 2 |
| `render <p.mzc> [-o out.mp4] [--from t] [--to t] [-j N]` | 動画（H.264 + AAC の MP4）を書き出す（既定は project の `output`。`-j` は予備の経路で ffmpeg を同時に動かす数）。範囲が空（`--from` ≥ `--to`、`--from` が全体の長さ以上）なら止める | 0 / 1 / 2 |
| `edit <p.mzc>` | 編集画面を開く | |
| `build` | エンジンと編集画面を作り直す | |
| `package [-o <dir>]` | 配布の形（既定は Windows は `dist/MozaicCut/`、macOS は `dist/MozaicCut.app`）を作る。下の「exe だけで使う（配布の形）」 | 0 / 1 |
| `plugin build <名前 \| file.um> [-o x.mzplug]` | 効果のプラグインを wasm の包み（既定は `dist/<名前>.mzplug`）にする | 0 / 1 / 2 |
| `plugin list [--json]` | 組み込みの効果と、入れた `.mzplug` の一覧 | 0 |
| `plugin install <x.mzplug> [--force]` / `plugin uninstall <名前>` | `.mzplug` を `plugins-installed/` に入れる・外す | 0 / 1 / 2 |

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

`--json` を付けると、配置の結果（各クリップの開始・終わり・効果）と診断を JSON で出します（時間は秒の数。ないものは `null`）。`ok` は誤り（error）が 0 個か、`at` は書いたままの値（参照か秒。省けば `null`）、`keys` は行に書いた key=value、`trackKind` は `"video"` か `"audio"`、`placed` が `false` なら誤りのため仮の位置（0 秒）に置いたクリップです。

```json
{"ok":true,"project":{"width":1280,"height":720,"fps":"30/1","rate":48000,"duration":10.5,"effects":[]},
 "clips":[{"index":2,"id":"clip_b","line":9,"kind":"video","track":0,"start":5,"end":9,"duration":4,"in":0.5,
           "src":"media/clip_b.mp4","text":null,"trackKind":"video","at":null,"placed":true,
           "keys":{"in":"0.5","out":"4.5","xfade":"1","sat":"1.4","contrast":"1.1","vignette":"0.4","fadeout":"1"},
           "effects":[{"name":"sat","params":{"amount":1.4}},{"name":"contrast","params":{"amount":1.1}},
                      {"name":"vignette","params":{"strength":0.4,"radius":0.6,"softness":0.4}}]}],
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
clip_b を 5 秒から 5.5 秒に動かしました
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
| `add <種類> [素材 / 文字 / 色] key=value ... [after <clip>]` | 行を足す（既定はファイルの最後）。`id` を書かなければ `text1` のように付ける | `add text "おわり" at=clip_b.end-1 dur=1 after caption_b` |
| `rename <clip> <新しい ID>` | ID を変える（ほかの行の `at=`・`to=`・`matte=`・particles の `layer=`・式の `clip('ID')` も書き換える） | `rename pip inset` |
| `add marker <時刻> [name=..] [color=..]` | マーカーの行を足す（最後のマーカーの行の後ろ）。`@行番号` で `set at= / name= / color=`・`unset`・`delete` | `add marker 12.5 name=見せ場` |
| `mix <音のトラック\|master> key=value ...` | 音のトラック（またはマスター）の `track` の行の値を決める（行がなければ足す）。`mute=1` / `mute=0` で付け外し、値を空にすると消す | `mix 0 vol=-6 pan=-0.2`、`mix 1 mute=1`、`mix master vol=-1` |

- `<clip>` の指し方は 3 通り: ID（`clip_b`）、`#番号`（`#3`。0 から数える。`show` の左の列）、`@行番号`（`@9`）。
- 操作の後でファイルを読み直し、**新しい誤りが増えたら止めて、何も書き換えません**（終了コード 1）。もとから誤りのあるファイルでも、誤りを増やさない操作は通ります。
- 参照（`at=clip_a.start+1` など）で置いたクリップを `move` / `trim` すると、その `at=` は秒の数に置き換わります。参照のまま動かしたいときは `move pip clip_a.start+0.5` のように参照で書きます。
- 操作で **ほかのクリップの時刻も変わったとき**（`delete` で `at=` のない後ろのクリップが詰まった、参照しているクリップが付いて動いた など）は、「ほかに 4 個のクリップの時刻が変わりました: clip_a 2→0 秒、…」と出します（JSON では `moved`）。
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
$ mozcut op demo/demo.mzc set pip blur=999
エラー[out-of-range]: この操作で誤りが増えるため、適用しませんでした（12 行目: 'blur' の値 999 は範囲の外です）
  ヒント: 0〜64 の範囲で書きます
何も書き換えていません
```

- 値に空白を含むときは `"..."` で囲みます（`text="a b"`）。`"` そのものは `\"`、`\` は `\\` と書きます。
- 文字の値（`set <clip> text=...`、`add text "..."`）の中の `\n` は改行になります（`set caption_a text="1 行目\n2 行目"`）。
- 操作を 1 つの引数にまとめて書いても（`mozcut op p.mzc "move pip 2"`）分けて読みます。
- `--json` を付けると `{"ok":..,"saved":..,"results":[{"op","ok","code","desc","error","hint","suggest","newId","changes":[{"kind","line","before","after"}],"moved":[{"id","line","before":{"start","end"},"after":{"start","end"}}],"newDiagnostics":[...]}],"diagnostics":[...]}` を出します。`suggest` は hint で推した候補（キーや ID）、`newDiagnostics` は誤りが増えて止めたときのその診断（行・列・code）です。

### schema: 使えるキーと効果

`mozcut schema` は、コアのキー（使える行・型・既定値・範囲・説明）、効果のプラグイン（引数・既定値・範囲・別名）、時刻と参照の書き方、操作の一覧（書き方・意味・例）を出します。`--json` なら `{"version":2,"keys":[...],"effects":[...],"ops":[...],"syntax":[...]}` です。keys は (name, kinds) ごとに 1 つ（project の `out` は `aliasOf:"output"`）、`default` は数の型なら数、`type` が `"enum"` なら `values` に選択肢があります。キーの説明はこの README よりも schema の方が正確です（プラグインを足せば効果の一覧も増えます）。

### preview と render

```sh
mozcut preview demo/demo.mzc 3.5                              # demo/preview.png
mozcut preview demo/demo.mzc 1:02.5 -o shot.png
mozcut render  demo/demo.mzc                                  # project の output（demo.mp4）に
mozcut render  demo/demo.mzc --from 6 --to 7.5 -o part.mp4    # 一部だけ
```

- 書き出しは H.264（`crf` / `preset` は project の行で決める）と AAC 192kbps です。
- 書き出しの中間ファイル（`out.y4m` / `out.pcm`）はエンコードが済むと消します。

### motion: 点を追ってキーフレームにする（モーショントラッキング）

```sh
mozcut motion demo/m6/motion.mzc bg 760,420 --to tag --dry-run   # 試す
mozcut motion demo/m6/motion.mzc bg 760,420 --to tag             # tag に pos= のキーを書く
```

- 追う映像の始まりのコマで、画面の (x,y) にある模様を追い（[src/m6_track/README.md](src/m6_track/README.md)）、`--to` のクリップの今の位置を保ったまま、同じだけ動く `pos="x,y@t ..."` を 1 コマに 1 つ書きます。書いたキーは `key` の操作やエディタで直せます。
- 信頼度の低いコマ（隠れた・画面の外）は最後の位置に止め、その数を出します。

## プロジェクトファイル（.mzc）

1 行に 1 つ、`種類 ["素材" / "文字" / 色] key=value ...` と書きます。`#` 以降は注釈です（`"..."` の中と、色の値の先頭の `#` は除く）。時間は秒（`12.5`）か `分:秒`（`1:02.5`）、`時:分:秒`（`1:02:03`）です（分と秒の欄は 60 未満。負の時間は `out-of-range`）。

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

全体は [demo/demo.mzc](demo/demo.mzc) にあります。

### 種類

| 種類 | 2 番目に書くもの | 内容 |
| --- | --- | --- |
| `project` | — | 全体の設定（1 行だけ） |
| `video` | `"素材"` | 動画。映像と音の両方を使う（`mute` で音を消す） |
| `image` | `"素材"` | 静止画（PNG の透過も使える） |
| `text` | `"文字"` | 文字。`\n` で改行、`\t` でタブ（空白 4 つ分の倍数の位置まで進む）。`\"` は `"`、`\\` は `\`（ほかの `\x` は警告 `bad-escape`）。日本語も書ける |
| `color` | 色 | 単色の四角（`w` / `h` を省くと画面全体） |
| `audio` | `"素材"` | 音だけ（BGM、効果音） |

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
| `at=intro.end-0.5` | intro の終わりの 0.5 秒前（`1:02.5` の書き方も使える） |
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
| `xfade` | 直前のクリップと重ねてクロスフェードする秒数 |
| `enabled` | `0` で無効（描かず、音も出さない。行と時刻はそのまま残る）。既定は `1` |
| `x` / `y` | 左上の位置。`center`（既定）か画素の数。負の数は右端・下端からの距離 |
| `w` / `h` | 大きさ（video / image / color。片方だけなら縦横比を保つ） |
| `fit` | `w` と `h` の枠への合わせ方（video / image）: `contain`（既定。収める）/ `cover`（切り抜いて埋める）/ `stretch` |

キーには使える行が決まっています（例: `w` は text の行では使えず、`in` は image の行では使えない）。違う行に書くと `key-not-allowed`（綴りの誤りの `unknown-key` とは別）になり、ヒントに使える行が出ます。どの行で使えるかは `mozcut schema` の「使える行」の列で分かります。

### 見た目

| key | 意味 |
| --- | --- |
| `opacity` | 不透明度（0〜1） |
| `fade` / `fadein` / `fadeout` | フェード（映像と音の両方） |
| `afadein` / `afadeout` | 音だけのフェード |

色は `rrggbb` か `rrggbbaa`（`#` は付けても付けなくてもよい）、または `white` / `black` / `red` / `green` / `blue` / `yellow` / `gray` / `transparent`。

### 文字

**`size` は画素です**（フォントの em の大きさ。既定 48、範囲 4〜1000）。前の版の「5x7 のビットマップの拡大率」ではないので、古いファイルの `size=3` は誤り（範囲の外）に、`size=12` はとても小さな文字になります。720p なら、見出しは 64〜120、字幕は 26〜40 くらいが目安です。

| key | 意味 |
| --- | --- |
| `size` | 文字の大きさ（画素） |
| `color` | 文字の色（既定 `ffffff`） |
| `bg` / `pad` | 背景の箱の色と余白（画素） |
| `shadow` | 影の色（ずらす量は size/16） |
| `outline` / `outlinew` | 縁取りの色と太さ（画素。既定は size/14） |
| `align` | 複数行の揃え: `left` / `center`（既定）/ `right` |

フォントは project の行で決めます。

```sh
project size=1920x1080 fps=30 font="C:/Windows/Fonts/meiryo.ttc" fontindex=0
```

- TrueType（`.ttf` / `.ttc`）のアウトライン（glyf）だけを扱います。CFF のフォント（多くの `.otf`）は使えません。
- 指定したフォントのファイルが見つからないときは、警告 `font-not-found` を出し、既定の候補を順に使います。
- フォントにない字（絵文字など）は □ になります。ゼロ幅スペースや異体字セレクタは描かず、結合文字（é の ´ など）は前の字に重ねます。
- 文字の色そのものを半透明（`color=ffffff80`）にすると、縁取りの色が文字の中に透けます（縁取りは文字の下に敷くため）。文字全体を半透明にするときは `opacity=` を使います。
- カーニング、合字、縦書きはまだ扱いません。

### 効果（プラグイン）

効果は video / image / **text** / color の行に書けます（audio の行に書くと `key-not-allowed`）。**クリップの行の効果は、そのクリップにだけ掛かります**（小窓やロゴにも別々に掛かります）。文字の行は、文字を透明な層に描いてから効果を掛けて重ねます。

**合成した画面全体に掛けるときは project の行に書きます**（調整レイヤーの代わり）。透明な color の行（`opacity=0`）に効果を書いても、画面全体には掛かりません。

```sh
project size=1280x720 vignette=0.5                  # 画面全体にビネット
video "a.mp4" bright=0.1 vignette=0.6 vignette.radius=0.9 blur=2
text "ぼかした文字" size=80 blur=3 dur=2
video "b.mp4" gray                                  # 名前だけなら主の引数の既定値（gray=1）
```

- `<効果>=<値>` は主の引数（最初の引数）を決めて効果を有効にします。`<効果>.<引数>=<値>` はそのほかの引数を決めます（これだけでも効果は有効になります）。
- 効果は **行に初めて出てきた順** に掛けます（上の例は bright → vignette → blur）。
- 書かなかった引数は既定値です。範囲の外は `out-of-range`。
- 別名でも書けます（`saturation=1.2` は `sat=1.2`、`mosaic=8` は `pixelate=8`）。
- `vignette` の中心は、掛ける層の中央です（文字なら文字の箱、小窓なら小窓の中）。
- `blur` / `sharpen` は、透明なまわりがある層（画像・文字）では、ぼかしが広がる分の余白を足してから掛けます（四角く切れません）。映像と色の層は、端の画素をくり返します。

標準の効果（`plugins/`）:

| 効果 | 引数（既定値、範囲） | 内容 |
| --- | --- | --- |
| `bright` | amount（0、-1..1） | 明るさ（rgb に足す） |
| `contrast` | amount（1、0..4） | コントラスト（0.5 を中心に掛ける） |
| `sat`（別名 `saturation`） | amount（1、0..4） | 彩度（0 で白黒） |
| `gray`（別名 `grey`） | amount（1、0..1） | 白黒にする |
| `sepia` | amount（1、0..1） | セピア調 |
| `invert` | amount（1、0..1） | 色の反転 |
| `blur` | radius（2、0..64） | ぼかし（箱ぼかし 2 回） |
| `sharpen` | amount（0.6、0..4）、radius（1、1..8） | くっきりさせる（アンシャープマスク） |
| `vignette` | strength（0.5、0..1）、radius（0.6、0..2）、softness（0.4、0..2） | 周辺を暗くする |
| `pixelate`（別名 `mosaic`） | size（12、1..256） | モザイク |
| `chromakey` | tolerance（0.3）、softness（0.5）、spill（1、0..2）、shrink、feather、r / g / b（キーの色。既定 0.1 / 0.7 / 0.3 の緑） | クロマキー（緑や青の背景を透明にし、縁の色を戻し、色のこぼれを取る）。詳しくは [docs/keying.md](docs/keying.md) |
| `lumakey` | threshold（0.1）、softness（0.1）、invert（0 か 1）、shrink、feather | 暗い所（invert=1 なら明るい所）を透明にする |
| `matteview` | mode（1 で白黒、2 で市松模様の上） | アルファを見せる（キーの確かめ用） |

最新の一覧は `mozcut schema` で見られます。

### 色の調整（grade.*）

video / image の行に、色の調整（グレーディング）と LUT を書けます。効果より先に掛かります（調整 → 効果の順）。
色のワークスペースのホイール・カーブ・LUT は、この行を書き換えます（既定の値に戻すと、そのキーを消します）。

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
- 描画は、層を BT.1886（γ 2.4）で線形の光にし、調整（33³ の 3D LUT に焼いた表）→ LUT（BT.1886 の空間で）の順に掛けて戻します（src/color/grade.um・lut.um）。

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

### マーカー

`marker <時刻> [name="名前"] [color=色]` の行は、タイムラインの印です（描画と書き出しには効きません）。編集画面では M で再生ヘッドの位置に足し、Shift+M / Ctrl+Shift+M で前後のマーカーへ移ります。

```
marker 12.5 name="見せ場" color=yellow
marker 1:05
```

操作は `add marker 12.5 name=見せ場`、行を `@行番号` で指して `set @30 at=13 name=サビ`・`unset @30 color`・`delete @30` です。

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

### 3D レイヤーとカメラ

video / image / text / color の行に 3D だけのキー（`z` / `ox` / `oy` / `rx` / `ry`）か `mblur` を書くと、3D のレイヤーになります（After Effects の 3D スイッチの代わり）。見本は `demo/m6/threed.mzc`、詳しくは [docs/design/m6-3d.md](docs/design/m6-3d.md)。

```
project camera.z=-2600 light.type=point light.z=-800 mblur.angle=180
video "floor.mp4" rx=70 oy=260 z=200
video "card.mp4" z=-100 ry="0@0 180@4" mblur
text "TITLE" z="-600@0 -200@4" ox="-300@0 300@4"
```

- 座標は x が右・y が下・z が奥。`rx` が正なら下の辺が奥へ倒れ、`ry` が正なら右の辺が手前へ回る。`rotation` / `scale` / `anchor` も 3D で効く。
- カメラ `camera.x/y/z`・注視点 `camera.tx/ty/tz`・`camera.fov` / `camera.zoom` / `camera.roll`、被写界深度 `camera.aperture` / `camera.focus`、アンチエイリアス `camera.aa`、ライト `light.type=parallel|point` ほか、モーションブラー `mblur.angle` / `mblur.samples`。
- 続けて並ぶ 3D のレイヤーは奥行きで重なり、間に 2D のレイヤーがあると組が分かれる。
- 3D のキーのキーフレームは、いまは `linear` と `hold` だけ。
- 2D の行（video / image / text / color）の `rotation` / `scale` / `anchor` は、まだ効かない（`key-ignored` の警告。`z=0` を足すと 3D のレイヤーとして効く）。

### パーティクル

新しい行の種類 `particles`（位置で渡す値はない）。火花・塵・雪のような粒を、決まった結果になるシミュレーションで描きます（同じ `seed` なら同じ動き。CPU でも GPU でも同じ）。見本は `demo/m6/particles.mzc`。

```
particles id=sparks at=2 dur=5 emit=point x=960 y=900 rate=400 speed=330 dir=-90 spread=22 gravity=420 life=2 size=7 size.end=2 color=ffd27a color.end=ff3a1a draw=soft blend=add
particles id=dust at=title.start dur=4 emit=layer layer=title rate=3000 turb=500 turb.scale=30 life=0.9
```

- 発生源 `emit=point|line|circle|box|layer`。**particles の行の `x` / `y` は発生源の中心**（center か数。負の数は端から、画面の外は `-200px`）。`emit=layer layer=<ID>` は、そのクリップ（text / color）の形から出す。
- 出し方 `rate` / `burst` / `emit.dur` / `max`、動き `speed` / `dir` / `spread` / `dir.mode=out` / `gravity` / `wind` / `drag` / `turb`、寿命 `life`、見た目 `size` / `size.end` / `color` / `color.end` / `opacity.end` / `opacity.in` / `opacity.out` / `draw=point|soft|ring|star`、重ね方 `blend=add|over`、`seed`、`steps`、`prewarm`。全部のキーは `schema --json` の kinds が `particles` のもの。
- 時間・不透明度・効果はほかのクリップと同じ。`draw=image`（`sprite=`）の画像はまだ読み込まない。
- 粒のキー（`x` / `y` / `rate` など）はキーフレームで動かせない（`key-not-animatable`）。
- `split` / `trim start` の後半は `in=`（クリップの中の時刻の始まり）で粒を続きから計算し、`full=`（全体の長さ）で粒の数を保つ。text の `anim=` と shape の `drawon` / `drawoff` も同じ（`full=` は終わりから数える `animout` / `drawoff` の基準）。

### シェイプ（ベクターの図形）

新しい行の種類 `shape`。行の 2 番目が形の種類（`rect` / `ellipse` / `polygon` / `star` / `path`）。見本は `demo/m6/shape.mzc`、キーの表は [docs/design/m6-shape.md](docs/design/m6-shape.md)。

```
shape star points=5 r=160 inner=70 pos=320,360 fill="linear(#ffd040,#ff6020)" stroke=#202020 strokew=6 rotation="0@0 144@4:ease"
shape rect w=480 h=270 radius=32 fill=none stroke=white strokew=8 drawon=1.5
shape path d="M 0 0 C 60 -80 120 80 180 0" fill=none stroke=#80ff80 strokew=10 trimend="0@0 1@2"
```

- `x` / `y` はほかのクリップと同じく形の箱の左上（center、負は右端から）。`pos=x,y` は anchor（既定は形の中心）を置く画面の点。
- 塗り `fill` / 線 `stroke`（色、`none`、`linear(...)` / `radial(...)`）、`strokew`、`cap` / `join`、破線 `dash`、トリム `trimstart` / `trimend` / `trimoffset`、`drawon` / `drawoff`、変形 `anchor` / `rotation` / `scale`、リピーター `repeat` ほか。
- キーフレームで動かせる形のキー: `pos` / `anchor` / `rotation` / `scale` / `trimstart` / `trimend` / `trimoffset` / `strokew` / `r` / `inner` / `w` / `h` / `radius` / `repeatx` / `repeaty` / `repeatrot` / `repeatscale`。
- 時間・不透明度・効果・描画モード・マスクはほかのクリップと同じ。

### 描画モード・マスク・トラックマット

見本は `demo/m6/blend.mzc`。詳しくは [src/m6_blend/README.md](src/m6_blend/README.md)。

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
```

- `key="expr(...)"` は式だけで決め、`key.expr="..."` はキーの値（キーフレームを含む `value`）に重ねる。空白を含む式は値全体を `"..."` で囲み、式の中の文字列は `'...'`。
- 決められるのは `x` / `y` / `position`（`pos.expr` とも書ける。キーフレームの `pos` に重なる）/ `opacity` と効果の引数。式の `x` / `y` はクリップの左上の画素、`opacity` は 0〜1。音量の式は、まだ音に効かないので書けない（`key-not-allowed`。音量はキーフレームで動かす）。
- `loopOut` / `valueAtTime` は、キーフレームと同じ補間（イーズ・ベジェ）の値を引く。
- 関数: `wiggle` `linear` `ease` `easeIn` `easeOut` `loopOut` `loopIn` `valueAtTime` `random` `clip('ID')` `sin` `cos` … 一覧は `schema --json` の `expressions`。

### キーフレーム

値の代わりに **`値@時刻[:印]` を空白で並べる**と、その値が時刻とともに動きます（`"..."` で囲む）。見本は `demo/m6/anim.mzc`。

```
text "タイトル" x="-400@0 120@1.5:ease 300@3:hold" opacity="0@0 1@0.5 1@end-0.5 0@end"
image "logo.png" pos="100,100@0 640,360@1:curve 1180,620@2:easein"
video "a.mp4" timeremap="0@0 2@1:ease 2@3 0@4" sat="1@0 0@3"
project vignette="0@0 0.8@6"
```

- 動かせるのは `x` / `y` / `pos` / `opacity` / `color` / `volume` / `timeremap` と効果の引数（`blur.radius` など）。ほかのキーの値の `@` はふつうの文字です（`src=photo@2x.png`）。`schema --json` の `animatable` で分かります。
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
| `font` / `fontindex` | 文字のフォント（上の「文字」） |
| 効果（`vignette=0.5` など） | 合成した画面全体に掛ける効果（上の「効果」） |

## 効果のプラグインを書く

`plugins/<名前>.um` を 1 つ足せば、効果が 1 つ増えます。次のビルドで `tools/gen-plugins.mjs` が登録表（`src/gen/plugins.um`）を作り直し、プラグインを `src/gen/fx/` に写して一緒にコンパイルします（UM の import は main のファイルのフォルダの中しか読めないため）。

```ts
// plugins/posterize.um
// @effect posterize "色の段階を減らす"
// @param levels 4 2..32 "1 色あたりの段階の数"

kernel function posterizeKernel(i: u32, layer: mut Buffer<vec4<f32>>, p: f32[8]): void {
  const c = layer[i];
  const n = Math.floor(p[0] + 0.5) - 1.0;
  layer[i] = vec4(Math.floor(c.x * n + 0.5) / n, Math.floor(c.y * n + 0.5) / n, Math.floor(c.z * n + 0.5) / n, c.w);
}

export function fx_posterize(layer: mut Buffer<vec4<f32>>, tmp: mut Buffer<vec4<f32>>, w: u32, h: u32, p: f32[8]): void {
  dispatch(posterizeKernel, w * h, mut layer, p);
}
```

これで `color 3060c0 posterize=3` のように書けるようになり、`mozcut schema` にも載ります。

- `@effect <名前> "<説明>"`: 名前は英小文字・数字・`_` で、ファイル名と同じにします。
- `@param <名前> <既定値> <最小>..<最大> "<説明>"`: 0〜8 個。書いた順に `p[0]`, `p[1]`, … に入ります。最初の引数が主の引数です。
- `@alias <別名>`: 効果の別名（何個でも）。
- `@reach <引数> [<倍率>] [round] [max <画素>]`: 効果が周りへ広がる画素数（引数の値 × 倍率を切り上げ）。`round` を付けると引数を四捨五入してから倍率を掛けます（効果が整数に丸めた半径を使うとき）。`max` を付けると、広がりがそれを超えるときは wasm 版を帯に分けずに掛けます（帯の始まりで足す順が変わる計算のとき）。`blur` は `@reach radius 2 round max 20`。書くと、透明なまわりのある層（画像・文字）で、その分の余白を足してから効果を掛けます。
- 関数 `fx_<名前>(layer, tmp, w, h, p)` を export します。層は RGBA（0〜1、ストレートアルファ）、`tmp` は同じ大きさの作業用です。**結果は `layer` に残します。**
- 名前の空間は全ファイルで 1 つなので、kernel や補助の関数には名前を前置します（`posterizeKernel`）。
- `@whole`: 層全体の大きさ・位置を使う効果（中心からの距離、ブロックの位置など）に付けます。wasm の包みにしたとき、層を帯に分けずに掛ける印です。
- 宣言を誤ると、ビルドのときに `plugins/posterize.um:3: ...` の形で場所を出して止まります。コンパイルの誤りも、写し（`src/gen/fx/`）ではなく `plugins/` の場所で出ます。
- `src/gen/` は生成物なので、手で書き換えないでください。

### wasm の包み（.mzplug）

同じ `plugins/<名前>.um` から、作り直さずに配れる wasm の包みも作れます（wasmtime で動き、ファイルやネットワークには触れません）。

```sh
mozcut plugin build posterize          # dist/posterize.mzplug（宣言は JSON で包みに入る）
mozcut plugin install dist/posterize.mzplug
mozcut plugin list
```

- 組み込みの効果・コアのキー・入れてある包みと名前がぶつかるときは入れられません。
- 層を横の帯に分けて、CPU の全コアで並列に掛けます。プラグインが止まった（範囲外の添字など）・20 秒で終わらない・3 GiB を超えたときは、層を変えずに理由を返します（全体は止まりません）。
- **いまの版では、入れた包みを `plugin list` で確かめられますが、描画（check / preview / render / 編集画面）にはまだ使いません。** つなぐ手順は [architecture.md](docs/design/architecture.md) の「wasm のプラグイン」にあります。

## 編集画面

`mozcut edit project.mzc` でウィンドウが開きます。上がプレビュー、下がタイムラインです（映像のトラックは番号の大きいものが上、音は下）。画面も UM で書いてあり（`src/edit2.um` と `src/edit2/`）、文字は TrueType（Yu Gothic UI を優先）で描きます。配置と操作は [docs/design/edit2.md](docs/design/edit2.md) にあります。

`node tools/mozcut.mjs edit`（プロジェクトなし）か `build/mozcut-edit` を引数なしで起動すると（最近の一覧は `%APPDATA%\MozaicCut`）、新しい編集画面のスタート画面になり、最近開いたプロジェクト（最大 10 件）を開くか、新しいプロジェクトを作れます（カードをダブルクリック、↑↓ と Enter。［作成する］は保存する場所に `<名前>.mzc` を書いて開く。［開く…］のファイルの選択はまだありません。`.mzc` を窓に落としても開けます）。詳しくは [docs/design/edit2.md](docs/design/edit2.md) の「スタート画面」。

### exe だけで使う（配布の形）

`node tools/mozcut.mjs package` で、`dist/MozaicCut/` に node も UM も要らない配布の形を作ります（FFmpeg の組み込みが要ります）。macOS では `dist/MozaicCut.app` を作ります（手順と、まだ Mac で確かめていないことは [docs/build-mac.md](docs/build-mac.md)）。

- 中身: `MozaicCut.exe`（新しい編集画面。コンソールの窓を出さない Windows のサブシステムで、アイコン入り）、exe が読み込む DLL（SDL3・wasmtime・FFmpeg の LGPL の共有ライブラリ。PE の import をたどって `build/` から集める）、`resources/tokens.json`、`MozaicCut.ico`、`README.txt`（利用者向けの使い方）、`THIRD-PARTY-NOTICES.txt`（部品とライセンス、FFmpeg の元のソースの入手先と DLL の差し替え方）、`licenses/`（LGPL v3・GPL v3・SDL3・wasmtime の全文）。
- `MozaicCut.exe` をダブルクリックするとスタート画面が出ます。最近の一覧は `%APPDATA%\MozaicCut\mozcut-recent.txt`（`--home` を省いたとき。exe の隣には書かない）、新しいプロジェクトの既定の保存場所は `ドキュメント\MozaicCut` です。
- `.mzc` を `MozaicCut.exe` に落とすか、`.mzc` の［プログラムから開く］で `MozaicCut.exe` を選ぶと、そのプロジェクトが開きます。`.mzc` をダブルクリックで開けるようにする関連付けは、MozaicCut はレジストリを書かないので、［プログラムから開く］→［別のプログラムを選択］→［PC でアプリを選ぶ］で `MozaicCut.exe` を選び［常に使う］にします（`README.txt` にも同じ手順）。
- 素材の読み込み・効果（組み込みの 13 個）・書き出し（「出力」のワークスペースの MP4・ProRes 422 HQ・WAV・M4A）は、どれも exe の中で行います。入れた `.mzplug` はまだ読みません。
- コンソールの窓を出さないのは、リンカへの指示（`/SUBSYSTEM:WINDOWS` と `/ENTRY:mainCRTStartup`）だけを持つオブジェクト（`build/gui-subsystem.obj`。`mozcut.mjs` が書く）を UM の `--link-input` で渡しているからです。標準エラー出力は、起動した側がつないだもの（`mozcut.mjs edit`、テストのパイプ）にはそのまま出ます。
- `%APPDATA%` は UM の `envVar`（UnifiedMozaic のブランチ `claude/windows-subsystem`）で読みます。

### 読み直しと再生

- テキストエディタで `.mzc` を書き換えて保存しても、画面はすぐに読み直します。
- 予備の経路の `mozcut edit` は裏でファイルを見張り、変わるたびに必要な素材だけ ffmpeg で展開し直します（展開が済むまでは古い展開からずらして表示します）。
- 再生は時計に合わせてコマを選び、描くのが遅れたらコマを飛ばします。等速の順再生では音を鳴らし（SDL3 の音の出力）、鳴らした標本の数を時計にして映像を音に合わせます。映像のコマは別のスレッドが自分の展開器で先読みします。逆再生は、後ろへ 1 コマずつ読むと毎コマ前のキーフレームから展開し直すことになるので、数コマ〜30 コマの塊ごとに前から続けて先読みし、まだ展開できていなければ前のコマを出したまま少し（最大 0.15 秒）待ちます。
- 再生の速さ（この機械。offscreen、200〜300 フレーム、`--stats` の当たり率・コマ落ち・先読みの 1 コマの時間。負荷によって揺れるので幅で書く）:

  | 素材 | 等速 | 逆再生 | 逆 2 倍 | 逆 4 倍 | 2 倍 | 4 倍 |
  | --- | --- | --- | --- | --- | --- | --- |
  | デモ（720p、キーフレームは素材の頭だけ） | 100 %・0〜3 | 99 %・13〜17 | 98〜99 %・24〜45 | 100 %・16（※） | 100 %・0〜2 | 100 %・0 |
  | 1080p（下の作り方） | 98〜100 %・0〜4、9〜10 ms | 99 %・15〜21、10〜11 ms | 99 %・24〜26 | 98 %・28〜40 | 99 %・4〜10 | 64〜98 %・8〜105 |

  ※ デモの逆 4 倍は、14 回に 1 回ほど先読みが追いつかない状態に入り、当たり 0 %・コマ落ち 222 になりました（キーフレームが素材の頭だけなので、塊ごとに頭から展開し直す。まだ直していない）。
  1080p の素材は `ffmpeg -f lavfi -i testsrc2=s=1920x1080:r=30:d=10 -c:v libx264 -pix_fmt yuv420p -b:v 20M -maxrate 20M -bufsize 40M -bf 3 -g 60 hd.mp4`（H.264 High、20 Mbps、B フレーム 3、キーフレーム 2 秒ごと）。1080p の 4 倍は先読みの手いっぱいで、負荷によって大きく揺れます。書き出し（`render`、h264_nvenc）は 300 コマで 5.6〜16 秒（ほかの処理と重なると遅い）。
- 統計の遅れ（`lateMsAvg`）は、画面に出た時刻の時計とコマの始まりの差です（音の時計のときは、音の再生位置から数える。デモの等速で平均 4 ms）。

## 構成

```
src/main.um        コマンド（check / show / op / schema / sources / plan / render / preview / caps）。ウィンドウなし
src/edit2.um       編集画面（ウィンドウ。部品の置き場と配線は src/edit2/）。SDL3 をリンクする
src/project.um     .mzc の読み取り、配置、ID と参照、診断
src/keys.um        コアのキーの表（schema と候補の提示に使う）
src/ops.um         操作（move / trim / split / delete / set / unset / add / rename）
src/lineedit.um    .mzc の行の key=value の書き換え
src/report.um      人向け・機械向けの出力（診断、JSON、タイムラインの図、schema）
src/render.um      1 コマの描画（素材の読み取りは media.um を通す、効果、合成、YUV 変換、BMP）
src/playback.um    再生（J/K/L の速さ、時計、コマ落ち、映像のコマの先読み）
src/audioplay.um   編集画面の音の再生（SDL3 の音の出力。鳴らした標本の数を再生の時計にする）
src/media.um       素材の読み手（FFmpeg の組み込みでその場で展開する。予備は展開したキャッシュ）と素材の情報
src/ffmpeg.um      FFmpeg の組み込みの包み（src/ffmpeg_off.um は、ライブラリがないときに差し替える同じ形の版）
src/wasmfx.um      wasm の効果プラグイン（.mzplug）の読み込みと実行
src/textlayer.um   文字のクリップの描画（縁取り・影・背景・揃え、文字の画像のキャッシュ）
src/gradelayer.um  映像・画像の色の調整（grade.*）と LUT を層に掛ける（焼いた表と .cube のキャッシュ）
src/color/         色の処理（伝達関数・色域・LUT・調整・スコープ）
src/ws_color/      色のワークスペース（モニター・スコープ・色のパネルを描き、出来事を返す。見本は src/ws_color_demo.um）
src/ttf.um         TrueType / TTC の読み取りと文字の画像
src/audio.um       音のミックス
src/font.um        5x7 のビットマップフォント（フォントがないときの予備）
src/text.um        文字列・数・時間・色の読み取り
src/m6_anim/       キーフレーム（値@時刻 の読み取り・評価・操作・グラフエディタの絵・時刻の再マップ）
src/m6_blend/      描画モード・マスク・トラックマット（kernel、mask の行の読み取り、操作の手順）
src/m6_shape/      シェイプ（形・塗り・線・トリム・リピーター。全部の塗りを 1 回の dispatch で描く kernel）
src/m6_textanim/   テキストアニメーター（字ごとの動き、範囲セレクター、プリセット）
src/m6_particles/  パーティクル（決まった結果のシミュレーション、kernel、キャッシュと区切りの保存）
src/m6_3d/         3D レイヤーとカメラ（遠近の投影、奥行きの順の重ね、ライト、モーションブラー、被写界深度）
src/m6_track/      モーショントラッキング（点の追跡、変換、手ぶれ補正の部品）
src/m6_expr/       エクスプレッション（式の言語、評価、画素の式の kernel）
src/motion.um      motion コマンド（点を追って位置のキーフレームにする）
src/gen/           生成物（プラグインの登録表と写し。手で書かない）
plugins/*.um       効果のプラグイン
tools/mozcut.mjs   エンジンのビルド。予備の経路の ffmpeg / ffprobe とのやり取りとキャッシュ
tools/ffmpeg-libs.mjs        FFmpeg のライブラリがあるかを調べ、なければ src/ の写しの ffmpeg.um を差し替える
tools/gen-plugins.mjs        プラグインの登録表を作る・.mzplug を作る
docs/ai.md                   AI のエージェント向けの手引き
docs/design/architecture.md  内部の約束ごと
```

- 素材は FFmpeg の組み込みが、プロジェクトのコマの速さとクリップの大きさで、その場で YUV 4:2:0（素材の色の行列のまま。描画の kernel が係数で RGB にする）に展開します。予備の経路では ffmpeg がクリップごとに生の YUV 4:2:0（Y4M、BT.709 リミテッド）に展開し、エンジンが `readFileRange` で 1 コマずつ読みます（キャッシュはディスクを使う。720p で 1 秒あたり約 40 MB）。

## まだないもの

- 回転・拡大（変形）と、小数の位置での配置（いまのキーフレームの位置は整数の画素に切り下げる）
- timeremap のフレームブレンドと音の再マップ
- 2 倍・4 倍・逆再生の音（いまは止める）、クリップの追加（いまはテキストか `op add` で足す）、ドラッグでのトラックの移動、スタート画面に素材を落として新しいプロジェクトを作ること
- 映像と音のストリームの始まりがずれている素材（MPEG-TS、カメラの MTS、編集リストのない MP4 など）の音と映像の合わせ: UM の FFmpeg の組み込みは、映像と音のそれぞれのストリームの最初の時刻を 0 として返し、ストリームの始まりの時刻を教えないので、そのずれの分だけ音と映像がずれます（UM への要望。デモの素材ではずれ 0 を確かめた）
- 開いたあとに素材のファイルを差し替えても、編集画面は調べ直しません（開き直すと調べます）
- 素材の回転（スマートフォンの縦の動画の rotation）、HDR の色の変換、`preview` の PNG を FFmpeg の組み込みで書くこと
- 予備のフォント（絵文字など、フォントにない字を別のフォントで描く）
- 予備の経路では、クリップの並びを変えると展開のキャッシュ（クリップの番号ごと）を作り直す
- 入れた wasm の効果プラグイン（.mzplug）を描画で使うこと（作る・入れる・一覧は済み）
