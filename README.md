# MozaicCut

[UnifiedMozaic](../UnifiedMozaic)（UM）で書いた、**テキストで編集する動画編集ソフト**です。

- プロジェクトは 1 行に 1 クリップのテキストファイル（`.mzc`）です。手で書いても、コマンド（`op`）でも、編集画面でも、AI のエージェントからでも、同じ書き方・同じ操作で編集できます。
- カット・並べ替え・効果・重ね合わせ・文字（TrueType。日本語も書ける）・音のミックスは、すべて UM のネイティブバイナリが行います。画素の処理は `kernel` なので、CPU の全コアで並列に動きます（`UM_WGPU=1`（Windows・Linux・macOS）か、Apple Silicon で `UM_METAL=1` を付けてビルドすれば GPU でも動きます。CPU と GPU の絵は 1 バイトも違いません）。
- 誤りは「ファイル:行:列: エラー[原因コード]: 理由」と「ヒント（直し方）」の形で出ます。`--json` を付ければ機械向けの JSON でも出ます。
- 効果（ぼかし、セピア、ビネット、モザイク…）はプラグイン（`plugins/*.um`）です。1 ファイル足せば効果が 1 つ増えます。

動画の圧縮・展開（H.264 などのコーデック）だけは ffmpeg に任せます。UM には子プロセスを起動する機能がないので、ffmpeg とのやり取りは小さな Node のスクリプト `tools/mozcut.mjs` が受け持ちます。

```
project.mzc ──▶ mozcut (UM) ──plan──▶ mozcut.mjs ──ffmpeg──▶ 素材を生の Y4M / PAM / PCM に展開（キャッシュ）
                     │
                     └──render──▶ 1 コマずつ合成 → out.y4m + out.pcm ──ffmpeg──▶ out.mp4
```

使う人向けの説明書（はじめに・編集の基本・効果・書き出し・困ったとき）は [docs/manual/](docs/manual/README.md)、AI のエージェントから使うときの手引きは [docs/ai.md](docs/ai.md)、内部の約束ごと（モジュール・型・関数の形）は [docs/design/architecture.md](docs/design/architecture.md) にあります。

## 必要なもの

- [UnifiedMozaic](../UnifiedMozaic) とその環境（Node.js 22.18 以上、clang）。このリポジトリの隣に `UnifiedMozaic` を置くか、環境変数 `UM_HOME` でその場所を指定します。
- ffmpeg と ffprobe（PATH に置くか、環境変数 `FFMPEG` / `FFPROBE` で指定）。
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
- 素材の展開結果は `<プロジェクト名>.cache/` に残り、クリップの設定や素材が変わらなければ再利用します。
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
| `render <p.mzc> [-o out.mp4] [--from t] [--to t] [-j N]` | 動画を書き出す（既定は project の `output`。`-j` は ffmpeg を同時に動かす数）。範囲が空（`--from` ≥ `--to`、`--from` が全体の長さ以上）なら止める | 0 / 1 / 2 |
| `edit <p.mzc>` | 編集画面を開く | |
| `build` | エンジンと編集画面を作り直す | |
| `plugin build <名前 \| file.um> [-o x.mzplug]` | 効果のプラグインを wasm の包み（既定は `dist/<名前>.mzplug`）にする | 0 / 1 / 2 |
| `plugin list [--json]` | 組み込みの効果と、入れた `.mzplug` の一覧 | 0 |
| `plugin install <x.mzplug> [--force]` / `plugin uninstall <名前>` | `.mzplug` を `plugins-installed/` に入れる・外す | 0 / 1 / 2 |

`check` / `show` / `op` は、素材を ffprobe で調べてからエンジンに渡すので、長さ（`out=` / `dur=`）を書かないクリップも正しく並びます。素材のファイルが見つからなければ `missing-source`（探した場所つき）、`out=` / `dur=` が素材の長さを超えれば `out-of-range` になります。`preview` と `render` は、誤りのあるプロジェクトでは誤りを出して止まります。

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
| `split <clip> <時刻>` | その時刻で 2 つに分ける。後半は次の行に入り、ID は `<id>_2` | `split clip_b 7` |
| `delete <clip> [fix-refs]` | 行を `# ` で注釈にする（行は消さない）。ほかのクリップの `at=` から参照されていれば止める（`fix-refs` を付けると、参照している `at=` を今の秒に書き換えてから消す） | `delete caption_b`、`delete clip_a fix-refs` |
| `cut <開始> <終わり>` | タイムライン上の範囲を全トラックから切り取り、後ろを詰める（「最初の 3 秒を切る」など） | `cut 0 3`、`cut 1:00 1:05.5` |
| `set <clip> key=value ...` | 値を決める（効果も、文字・素材・色も） | `set pip opacity=0.5 blur=2`、`set caption_a text="字幕"` |
| `unset <clip> key ...` | キーを消す | `unset clip_b vignette` |
| `renamekey <clip> <古いキー> <新しいキー>` | キーの名前だけを同じ場所で変える（書き間違いの直し。効果の順を保つ） | `renamekey clip_b vignete vignette` |
| `add <種類> [素材 / 文字 / 色] key=value ... [after <clip>]` | 行を足す（既定はファイルの最後）。`id` を書かなければ `text1` のように付ける | `add text "おわり" at=clip_b.end-1 dur=1 after caption_b` |
| `rename <clip> <新しい ID>` | ID を変える（ほかの行の参照も書き換える） | `rename pip inset` |
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

`mozcut edit project.mzc` でウィンドウが開きます。上がプレビュー、下がタイムラインです（映像のトラックは番号の大きいものが上、音は下）。画面も UM で書いてあり（`src/editor.um`）、文字は TrueType（Yu Gothic UI を優先）で描きます。

`node tools/mozcut.mjs edit`（プロジェクトなし）か `build/mozcut-edit` を引数なしで起動するとスタート画面になり、デモと最近開いたプロジェクト（最大 10 件）から選べます（↑↓ と Enter、クリック。Del で一覧から外す）。スタート画面や、プロジェクトだけを渡して開いたときは素材を展開しないので、展開されていない素材は「`node tools/mozcut.mjs edit <project>` で開くと展開します」と案内します。

| 操作 | 動作 |
| --- | --- |
| クリップをクリック | 選ぶ（プレビューの右下に ID・種類・時間・行の中身を出す） |
| クリップをドラッグ | 動かす（`move`） |
| クリップの左端・右端をドラッグ | 始まり・終わりを詰める／伸ばす（`trim`） |
| 目盛りや空いた所をクリック・ドラッグ | 再生位置を動かす |
| Space | 再生・一時停止（音は出ません） |
| L / J / K | 順再生 / 逆再生 / 止める。L・J を続けて押すと 2 倍 → 4 倍 |
| ← / → | 1 コマ戻る・進む（止めてから。Shift で 1 秒） |
| Home / End | 先頭・最後へ |
| S | 選んだクリップを再生位置で 2 つに分ける（`split`） |
| Delete / Backspace | 選んだクリップを消す（`delete`。行を `#` で注釈にする） |
| Ctrl+Z / Ctrl+Y（Ctrl+Shift+Z） | 取り消し・やり直し |
| ホイール | タイムラインの拡大縮小（Shift+ホイールか、横のホイールで横へ動かす） |
| F | 全体が見えるように合わせる |
| Esc | ドラッグをやめる / 選ぶのをやめる |
| Ctrl+Q / Ctrl+W | 閉じる |

- 編集画面の操作は、`op` と同じ操作（`src/ops.um`）を通ります。成功すると `.mzc` の該当する行だけを書き換えてすぐに保存し、下の帯に「clip_b を 5 秒から 5.5 秒に動かしました（保存しました）」のように出します。
- 操作が誤りを増やすときは、帯に赤で `[原因コード] 理由 ／ ヒント: ...` を出し、ファイルは書き換えません。
- 端はほかのクリップの端・再生位置・0 に吸い付き、コマの境目に揃います。
- テキストエディタで `.mzc` を書き換えて保存しても、画面はすぐに読み直します。誤りがあれば帯に `ファイル:行:列 エラー[code] 理由 ／ ヒント` の形で出し、直るまで前の状態を表示します。
- `mozcut edit` は裏でファイルを見張り、変わるたびに必要な素材だけ ffmpeg で展開し直します（展開が済むまでは古い展開からずらして表示します）。
- 再生は時計に合わせてコマを選び、描くのが遅れたらコマを飛ばします（音の出力が UM に入ったら、音を時計にします）。映像のコマは別のスレッドが先読みします（720p のデモで、等速の当たり率 100 %、コマ落ち 0）。

## 構成

```
src/main.um        コマンド（check / show / op / schema / sources / plan / render / preview）。ウィンドウなし
src/editor.um      編集画面（ウィンドウ、プレビュー、タイムライン）。SDL3 をリンクする
src/project.um     .mzc の読み取り、配置、ID と参照、診断
src/keys.um        コアのキーの表（schema と候補の提示に使う）
src/ops.um         操作（move / trim / split / delete / set / unset / add / rename）
src/lineedit.um    .mzc の行の key=value の書き換え
src/report.um      人向け・機械向けの出力（診断、JSON、タイムラインの図、schema）
src/render.um      1 コマの描画（展開した素材の読み取り、効果、合成、YUV 変換、BMP）
src/playback.um    再生（J/K/L の速さ、時計、コマ落ち、映像のコマの先読み）
src/media.um       素材の読み手（いまは展開したキャッシュ。FFmpeg の組み込みに差し替える境界）
src/wasmfx.um      wasm の効果プラグイン（.mzplug）の読み込みと実行
src/textlayer.um   文字のクリップの描画（縁取り・影・背景・揃え、文字の画像のキャッシュ）
src/gradelayer.um  映像・画像の色の調整（grade.*）と LUT を層に掛ける（焼いた表と .cube のキャッシュ）
src/color/         色の処理（伝達関数・色域・LUT・調整・スコープ）
src/ws_color/      色のワークスペース（モニター・スコープ・色のパネルを描き、出来事を返す。見本は src/ws_color_demo.um）
src/ttf.um         TrueType / TTC の読み取りと文字の画像
src/ui.um          編集画面の部品（四角、文字）
src/audio.um       音のミックス
src/font.um        5x7 のビットマップフォント（フォントがないときの予備）
src/text.um        文字列・数・時間・色の読み取り
src/gen/           生成物（プラグインの登録表と写し。手で書かない）
plugins/*.um       効果のプラグイン
tools/mozcut.mjs   ffmpeg / ffprobe とのやり取り、キャッシュ、エンジンのビルド
tools/gen-plugins.mjs        プラグインの登録表を作る・.mzplug を作る
docs/ai.md                   AI のエージェント向けの手引き
docs/design/architecture.md  内部の約束ごと
```

- 素材は ffmpeg がクリップごとに、プロジェクトのコマ数・大きさで生の YUV 4:2:0（Y4M、BT.709 リミテッド）に展開します。エンジンは `readFileRange` で 1 コマずつ読むので、長い動画でもメモリは 1 コマ分です。ただしキャッシュはディスクを使います（720p で 1 秒あたり約 40 MB）。

## まだないもの

- 速度の変更、逆再生、回転・拡大のアニメーション（キーフレーム）
- 編集画面での音の再生（UM に SDL3 の音の出力を足している最中）、.mzc のドロップ・ファイルを開くダイアログ、クリップの追加（いまはテキストか `op add` で足す）、トラックの移動
- ffmpeg を使わないその場での展開（UM に FFmpeg の組み込みを足している最中。いまは展開したキャッシュを読む）
- 予備のフォント（絵文字など、フォントにない字を別のフォントで描く）
- クリップの並びを変えると、展開のキャッシュ（クリップの番号ごと）を作り直す
- 入れた wasm の効果プラグイン（.mzplug）を描画で使うこと（作る・入れる・一覧は済み）
