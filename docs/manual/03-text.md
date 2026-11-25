# 3. テキストで編集する

[目次](README.md) ／ 前: [2. 編集の基本](02-editing.md) ／ 次: [4. 効果を掛ける](04-effects.md)

MozaicCut のプロジェクト（`.mzc`）は、ふつうのテキストファイルです。テキストエディタで書いて保存すれば、そのまま編集になります（編集画面を開いていれば、すぐに読み直します）。コマンドの `op` も編集画面も、このファイルの該当する行だけを書き換えるので、注釈や行の並びは残ります。

ここでは書き方の入門と、よく使うキーを説明します。すべてのキーの正確な一覧は、いつでも `mozcut schema` で見られます（効果のプラグインを足すと、一覧も増えます）。

## 3.1 1 行に 1 つ

```sh
project size=1280x720 fps=30 output=first.mp4      # 全体の設定（1 行だけ）

video "media/clip_a.mp4" id=opening in=1 out=4     # 動画
text "はじめての動画" id=title at=0.5 dur=2 size=80  # 文字
```

- 1 行に 1 つ、`種類 ["素材" / "文字" / 色] key=value ...` と書きます。
- `#` から行の終わりまでは注釈です（`"..."` の中と、色の値の先頭の `#` は除く）。
- 値に空白を含むときは `"..."` で囲みます（`text="a b"`）。`"` そのものは `\"`、`\` は `\\` と書きます。
- ファイルは UTF-8 で保存します。改行は LF でも CRLF でも構いません（`op` は元の形を保ちます）。

## 3.2 行の種類

| 種類 | 2 番目に書くもの | 内容 |
| --- | --- | --- |
| `project` | — | 全体の設定（画面の大きさ、fps、書き出し先、フォント、画面全体の効果） |
| `video` | `"素材"` | 動画。映像と音の両方を使う（`mute` と書くと音を使わない） |
| `image` | `"素材"` | 静止画（PNG の透過も使える） |
| `text` | `"文字"` | 文字。`\n` で改行。日本語も書ける |
| `color` | 色 | 単色の四角（`w` / `h` を省くと画面全体） |
| `audio` | `"素材"` | 音だけ（BGM、効果音） |

素材のパスは、`.mzc` のあるフォルダからの相対パスか、絶対パスです。

## 3.3 時刻と並べ方

時刻は秒（`12.5`）か `分:秒`（`1:02.5`）、`時:分:秒`（`1:02:03`）で書きます。分と秒の欄は 60 未満です。

クリップの置き場所の決まりは 3 つです。

1. **`at=` を省く** と、同じトラックの前の行のクリップの後ろに並びます。動画を上から順に書くだけで、つながった 1 本になります。
2. **`at=秒`** で、タイムライン上の開始時刻を決めます。
3. **`at=参照`** で、ほかのクリップを基準に置きます。基準のクリップが動けば、一緒に動きます。

| 参照の書き方 | 意味 |
| --- | --- |
| `at=intro.start` / `at=intro.end` | intro の始まり / 終わり |
| `at=intro.start+1.5` | intro の始まりの 1.5 秒後 |
| `at=intro.end-0.5` | intro の終わりの 0.5 秒前 |
| `at=after:intro` | `intro.end` と同じ |

参照するには、相手の行に `id=名前` を付けます。名前は英字・数字・`_`・`-` で、先頭は英字か `_`、ファイルの中で 1 つだけです。

## 3.4 よく使うキー

### 長さと素材の範囲

| key | 意味 |
| --- | --- |
| `in` / `out` | 素材の使い始め・使い終わり（video / audio。素材の中の秒） |
| `dur` | 長さ（`out` の代わり）。image / text / color は既定 5 秒、video / audio は省くと素材の終わりまで |
| `xfade` | 前のクリップと重ねて、クロスフェードする秒数 |
| `track` | トラック番号（0〜63）。大きいほど手前に描く。既定は video / color / audio が 0、image が 1、text が 2。音のトラックは映像とは別の並び |

### 位置・大きさ・見た目

| key | 意味 |
| --- | --- |
| `x` / `y` | 左上の位置。`center`（既定）か画素の数。**負の数は右端・下端からの距離**（`x=-24 y=-24` で右下） |
| `w` / `h` | 大きさ（video / image / color。片方だけなら縦横比を保つ）。color の行はキーフレームでも書ける（`w="0@0 640@0.5:ease"`。キーの 0 は大きさ 0 で見えない） |
| `fit` | `w` と `h` の枠への合わせ方: `contain`（既定）/ `cover` / `stretch` |
| `opacity` | 不透明度（0〜1） |
| `fade` / `fadein` / `fadeout` | フェードの秒数（映像と音の両方） |

色は `rrggbb` か `rrggbbaa`（`#` は付けても付けなくてもよい）、または `white` / `black` / `red` / `green` / `blue` / `yellow` / `gray` / `transparent` です。

### 文字

| key | 意味 |
| --- | --- |
| `size` | 文字の大きさ（**画素**。既定 48）。720p なら見出し 64〜120、字幕 26〜40 くらい |
| `color` | 文字の色（既定 `ffffff`） |
| `outline` / `outlinew` | 縁取りの色と太さ（画素） |
| `tracking` | 字間（画素。負なら詰める） |
| `italic` / `skew` | 斜体（`italic` とだけ書く）と傾き（度。負なら上が右へ傾く。`skew=-15` など） |
| `text` | 中身。`text="'1'@0 '2'@0.1 '3'@0.2"` で中身を時刻で替える（数え上がる数字など） |
| `shadow` | 影の色 |
| `bg` / `pad` | 背景の箱の色と余白（画素） |
| `align` | 複数行の揃え: `left` / `center`（既定）/ `right` |

`size` / `tracking` / `outline` / `outlinew` / `skew` はキーフレームでも書けます（`size="60@0 120@1:ease"`）。

フォントは project の行の `font="C:/Windows/Fonts/meiryo.ttc"`（と `fontindex=`）で決めます。TrueType（`.ttf` / `.ttc`）だけを扱い、CFF の `.otf` は使えません。

### 音

| key | 意味 |
| --- | --- |
| `volume`（`vol`） | 音量（0〜10、既定 1） |
| `mute` | 動画の音を使わない |
| `afadein` / `afadeout` | 音だけのフェード |

## 3.5 例: 見出しと字幕

```sh
project size=1280x720 fps=30 bg=#203040
color 102030 id=bg dur=4
color #c04040 id=bar at=0.5 dur=3 w=1280 h=120 y=-80 opacity=0.8
text "見出しの文字" id=head at=0.5 dur=3 size=96 color=ffffff outline=000000 outlinew=6 shadow=00000099 y=180
text "1 行目は左に揃える\n2 行目はもう少し長い" id=sub at=bg.start+1 dur=2.5 x=60 y=-100 size=36 align=left bg=000000a0 pad=12 fade=0.3
```

```console
$ mozcut check text.mzc
問題はありません（クリップ 4 個、長さ 0:04.000）
$ mozcut preview text.mzc 2 -o text.png
mozcut: text.png に書きました（0:02.000）
```

`text.png` には、上の方に縁取りと影の付いた大きな見出し、左下に赤い帯と、半透明の黒い箱に入った 2 行の字幕が描かれます。書いたら、このように **`preview` で 1 コマを画像にして見る** のが確かめの近道です（[5.1](05-export.md#51-1-コマを画像にする)）。

文字を書き換えるときは、`.mzc` を直接直しても、`op set` を使っても構いません。

```console
$ mozcut op text.mzc set head text="1 行目\n2 行目" --dry-run
head の値を変えました: text "見出しの文字" → "1 行目\n2 行目"
  - 4: text "見出しの文字" id=head at=0.5 dur=3 size=96 color=ffffff outline=000000 outlinew=6 shadow=00000099 y=180
  + 4: text "1 行目\n2 行目" id=head at=0.5 dur=3 size=96 color=ffffff outline=000000 outlinew=6 shadow=00000099 y=180
保存していません（--dry-run）
```

## 3.6 キーを調べる: schema

`mozcut schema` は、キー・効果・時刻と参照の書き方・操作の一覧を出します。キーの表は「使える行」「型」「既定」「範囲」「説明」の列です（一部を抜き出しています）。

```console
$ mozcut schema
コアのキー
  キー       使える行                型      既定         範囲          説明
  size       project                 string  1280x720     -             画面の大きさ（幅x高さ。どちらも 16〜8192 の偶数）
  ...
  at         *                       time    -            0 以上        タイムライン上の開始時刻か参照（intro.end、intro.start+1.5、intro.end-0.5、after:intro）。省くと同じトラックの前の行の後ろ
  in         video,audio             time    0            0 以上        素材の使い始め
  out        video,audio             time    -            0 以上        素材の使い終わり
  dur        *                       time    -            0 以上        長さ（out の代わり。image / text / color は既定 5 秒、video / audio は素材の終わりまで）
  ...
  size       text                    int     48           4..1000       文字の大きさ（画素。フォントの em の大きさ）
```

キーには使える行が決まっています。たとえば `w` は text の行では使えず、`in` は image の行では使えません。違う行に書くと `key-not-allowed` になり、ヒントに使える行が出ます。

## 3.7 書いたら check

書き換えたら `mozcut check` で調べます。誤りは「ファイル:行:列: エラー[原因コード]: 理由」と「ヒント（直し方）」の形で出ます。たとえば次の `bad.mzc` では:

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

誤りがなければ終了コード 0、誤りがあれば 1 です。警告（`font-not-found`、`bad-escape`）は数えません。

診断の一覧と直し方は [7. 困ったとき](07-troubleshooting.md) にあります。

## 3.8 まだ書けないもの（準備中）

- 逆再生、キーフレームのアニメーション（位置・大きさ・回転を時間で変える）（速さは `speed=`。[2.6](02-editing.md) を見ます）
- 図形・パーティクル・3D・文字のアニメーションなどのモーショングラフィックス
- カーニング、合字、縦書き、フォントにない字（絵文字など）を別のフォントで描くこと
