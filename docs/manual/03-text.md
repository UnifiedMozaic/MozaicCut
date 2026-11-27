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

- 1 行に 1 つ、`種類 ["素材" / "文字" / 色 / 形] key=value ...` と書きます。
- `#` から行の終わりまでは注釈です（`"..."` の中と、色の値の先頭の `#` は除く）。
- 値に空白を含むときは `"..."` で囲みます（`text="a b"`）。`"` そのものは `\"`、`\` は `\\` と書きます。
- 値を書かずに名前だけ書けるキーもあります（`mute`、`italic`、`vertical`、`mblur`、効果の `gray` など）。
- ファイルは UTF-8 で保存します。改行は LF でも CRLF でも構いません（`op` は元の形を保ちます）。

## 3.2 行の種類

| 種類 | 2 番目に書くもの | 内容 |
| --- | --- | --- |
| `project` | — | 全体の設定（画面の大きさ、fps、書き出し先、フォント、画面全体の効果、カメラ）。1 行だけ |
| `video` | `"素材"` | 動画。映像と音の両方を使う（`mute` と書くと音を使わない） |
| `image` | `"素材"` | 静止画（PNG の透過も使える） |
| `text` | `"文字"` | 文字。`\n` で改行。日本語も書ける |
| `color` | 色 | 単色の四角（`w` / `h` を省くと画面全体） |
| `audio` | `"素材"` | 音だけ（BGM、効果音） |
| `shape` | 形 | ベクターの図形。`rect` / `ellipse` / `polygon` / `star` / `path` |
| `particles` | — | 火花・雪・塵のような粒 |
| `spectrum` | 形 | 音に合わせて動くビジュアライザー。`bars` / `wave` / `ring` |
| `comp` | `"別の.mzc"` | 別のプロジェクトを 1 つの層として重ねる（プリコンポーズ） |
| `model` | `"素材.obj"` | 3D のモデル（`.obj`）をカメラとライトで描く |

クリップのほかに、次の行も書けます。

| 種類 | 内容 |
| --- | --- |
| `mask` | クリップの一部だけを見せる（`mask ellipse to=pip units=norm x=0.1 y=0.1 w=0.8 h=0.8 feather=0.2`） |
| `marker` | タイムラインの印（`marker 12.5 name="見せ場" color=yellow`）。描画には効かない |
| `track` | 音のトラックの音量・パン・EQ など（`track audio=0 vol=-3`）。ミキサーで変えると、この行が書き換わる |

素材のパスは、`.mzc` のあるフォルダからの相対パスか、絶対パスです。

## 3.3 時刻と並べ方

時刻は秒（`12.5`）か `分:秒`（`1:02.5`）、`時:分:秒`（`1:02:03`）、コマ（`61f`。project の `fps` のコマ）で書きます。分と秒の欄は 60 未満です。コマで書くと、秒を小数で丸めたときのように 1 コマずれることがありません。

クリップの置き場所の決まりは 3 つです。

1. **`at=` を省く** と、同じトラックの前の行のクリップの後ろに並びます。動画を上から順に書くだけで、つながった 1 本になります。
2. **`at=秒`** で、タイムライン上の開始時刻を決めます。
3. **`at=参照`** で、ほかのクリップを基準に置きます。基準のクリップが動けば、一緒に動きます。

| 参照の書き方 | 意味 |
| --- | --- |
| `at=intro.start` / `at=intro.end` | intro の始まり / 終わり |
| `at=intro.start+1.5` | intro の始まりの 1.5 秒後 |
| `at=intro.end-0.5` | intro の終わりの 0.5 秒前 |
| `at=intro.end+2f` | intro の終わりの 2 コマ後 |
| `at=after:intro` | `intro.end` と同じ |

参照するには、相手の行に `id=名前` を付けます。名前は英字・数字・`_`・`-` で、先頭は英字か `_`、ファイルの中で 1 つだけです。

## 3.4 よく使うキー

### 長さと素材の範囲

| key | 意味 |
| --- | --- |
| `in` / `out` | 素材の使い始め・使い終わり（video / audio / comp。素材の中の秒） |
| `dur` | 長さ（`out` の代わり）。image / text / color は既定 5 秒、video / audio は省くと素材の終わりまで。`dur=30f` のようにコマでも書ける |
| `xfade` | 前のクリップと重ねて切り替える秒数（既定はクロスフェード。`trans=` で種類を選ぶ。[4.5](04-effects.md#45-トランジション場面のつなぎ)） |
| `speed` | 再生の速さ（0.1〜16。`2` で 2 倍速）。音の高さも変わる |
| `timeremap` | 見せる素材の時刻。キーフレームで書くと、止める・逆に戻すもできる（[3.6](#36-時間で動かすキーフレーム)） |
| `track` | トラック番号（0〜63）。大きいほど手前に描く。既定は video / color / audio が 0、image が 1、text と shape が 2。音のトラックは映像とは別の並び |
| `enabled` | `enabled=0` で描かず、音も出さない（行は残る。編集画面の Shift+E が書く） |

### 位置・大きさ・見た目

| key | 意味 |
| --- | --- |
| `x` / `y` | 左上の位置。`center`（既定）か画素の数。**負の数は右端・下端からの距離**（`x=-24 y=-24` で右下） |
| `w` / `h` | 大きさ（video / image / color / comp。片方だけなら縦横比を保つ） |
| `fit` | `w` と `h` の枠への合わせ方: `contain`（既定）/ `cover` / `stretch` |
| `rotation` / `scale` / `anchor` | 回転（度、時計回り）、拡大（`1.5` か 横,縦 で `1.5,0.8`）、回転と拡大の中心（層の中央からの画素 `x,y`） |
| `opacity` | 不透明度（0〜1） |
| `fade` / `fadein` / `fadeout` | フェードの秒数（映像と音の両方） |
| `blend` | 下の絵との混ぜ方（`screen`、`multiply`、`add`、`overlay` など 15 種。[4.7](04-effects.md#47-重ね方描画モードマスクトラックマット)） |
| `parent` | 親のクリップの ID。親の位置・回転・拡大に付いて動く（`x` / `y` は親の中央からの位置になる） |
| `mblur` | 動きのぶれ（モーションブラー）を付ける |

色は `rrggbb` か `rrggbbaa`（`#` は付けても付けなくてもよい）、または `white` / `black` / `red` / `green` / `blue` / `yellow` / `gray` / `transparent` です。

### 文字

| key | 意味 |
| --- | --- |
| `size` | 文字の大きさ（**画素**。既定 48）。720p なら見出し 64〜120、字幕 26〜40 くらい |
| `color` / `color2` / `grad.angle` | 文字の色（既定 `ffffff`）。`color2` を書くと `color` から `color2` へのグラデーション（`grad.angle` は角度。90 で上から下） |
| `font` / `fontindex` / `fontweight` | 書体のファイル（`.ttf` / `.ttc` / `.otf`）、TTC の中の番号、可変フォントの太さ（100〜900 など） |
| `outline` / `outlinew` | 縁取りの色と太さ（画素） |
| `fill` | `fill=none` で縁取りだけの文字（中が透ける。`outline` を書かなければ `color` で縁取る） |
| `tracking` | 字間（画素。負なら詰める） |
| `italic` / `skew` | 斜体（`italic` とだけ書く）と傾き（度。負なら上が右へ傾く。`skew=-15` など） |
| `shadow` / `shadow.blur` / `shadow.x` / `shadow.y` | 影の色、ぼかし（4〜16 で柔らかい影）、ずらす量（画素） |
| `bg` / `pad` | 背景の箱の色と余白（画素） |
| `align` | 複数行の揃え: `left` / `center`（既定）/ `right` |
| `vertical` | 縦書き（`vertical` とだけ書く） |
| `text` | 中身。`text="'1'@0 '2'@0.1 '3'@0.2"` で中身を時刻で替える（数え上がる数字など） |
| `path` | 字を円（`circle`）・波（`wave`）・パス（SVG の d）に沿って並べる（[3.7](#37-文字を飾る動かす)） |
| `anim` | テキストアニメーター。字・単語・行ごとに動かす（[3.7](#37-文字を飾る動かす)） |

フォントは text の行の `font=` で決めます。書かなければ project の行の `font=`、それもなければ既定の書体です。相対のパスは `.mzc` のあるフォルダから探します。CFF2 の書体はまだ使えません。

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

## 3.6 時間で動かす（キーフレーム）

値の代わりに **`値@時刻` を空白で並べ、全体を `"..."` で囲む** と、その値が時刻とともに動きます。

```sh
project size=1280x720 fps=30 bg=101828
color 202040 id=bg dur=4
text "左から入る" id=title at=0 dur=4 size=80 x="-400@0 120@1:ease 120@3 1300@4:easein" y=200
image "media/logo.png" id=logo at=0 dur=4 w=160 pos="100,500@0 640,360@1.5:curve 1000,500@3" rotation="0@0 360@3" opacity="0@0 1@15f"
text "親に付いて動く" id=sub parent=logo x=0 y=140 size=32 at=0 dur=4
video "media/clip_a.mp4" id=clip track=1 at=0 dur=4 w=320 x=-24 y=-24 timeremap="0@0 2@1:ease 2@2 0@3" mute
```

- 時刻は **クリップの始まりからの** 秒（`1.5`）、コマ（`15f`）、終わりから（`end`、`end-0.5`）です。
- `:ease` などの印で、そのキーへの動き方を決めます: `linear`（既定）/ `hold`（次のキーまで止める）/ `ease` / `easein` / `easeout` / `smooth`。`pos` の経路は `:curve` でなめらかな曲線になります。`rotation` / `scale` / `anchor` と 3D のキーでは、`smooth` などは使えず、`linear` / `hold` / `ease` / `easein` / `easeout` だけです。
- **キーフレームの `x` / `y` / `pos` は、左上からの画素** です（負も可。`-400` は画面の左の外）。ふつうの値のような「`center`」「負は右端から」の読み替えはしません。
- 動かせるのは、`x` / `y` / `pos` / `opacity` / `color` / `volume` / `timeremap` / `rotation` / `scale` / `anchor` と効果の引数（`blur="8@0 0@1:ease"` など）、文字の `size` / `tracking` / `outline` / `outlinew` / `skew`、図形やマスクの多くのキーです。どのキーが動かせるかは `schema --json` の `animatable` で分かります。
- 上の例の `sub` は、`parent=logo` で logo に付いて動きます。`clip` は `timeremap` で、素材を 1 秒で 2 秒の所まで進め、1 秒止めてから逆に戻します（音は再マップしないので `mute` を付けます）。
- コマンドでは `op key add title x 1.5 120 ease` のように 1 つずつ足せます（`key remove` / `move` / `set` / `ease` / `shift` / `clear` も）。編集画面のインスペクタの ◆ でも置けます。

印の全部（`ease=60` のような影響、`cubic=` など）と式（`expr(...)`）は `mozcut schema` の「キーフレーム」と「機能の早見」にあります。

## 3.7 文字を飾る・動かす

```sh
project size=1280x720 fps=30 font="C:/Windows/Fonts/meiryo.ttc"
color 203040 id=bg dur=3
text "グラデーションの見出し" id=head at=0 dur=3 size=88 color=f8fafc color2=38bdf8 grad.angle=90 shadow=000000cc shadow.blur=10 shadow.y=4 y=80
text "縁だけの文字" id=hollow at=0 dur=3 size=110 fill=none outline=ffd040 outlinew=4 italic tracking=8 y=240
text "太さを変える" id=bold at=0 dur=3 size=64 font="C:/Windows/Fonts/NotoSansJP-VF.ttf" fontweight=800 y=420 x=80
text "夜明け前の静寂" id=vlyric at=0 dur=3 size=52 vertical x=1120 y=80
text "0" id=count at=0 dur=3 size=64 text="'1'@0 '2'@10f '3'@20f" x=80 y=-60
```

上から、水色へのグラデーションと柔らかい影の見出し、黄色い縁だけの斜めの文字、可変フォントの太字、右端の縦書き、10 コマごとに 1 → 2 → 3 と替わる数字が描かれます。

**テキストアニメーター** は、text の行に `anim=<プリセット>` を書くと、字・単語・行ごとに動かします。

```sh
text "Hello World" id=hello at=0 dur=4 y=40 size=96 anim=bounce animout=fadein animout.dur=0.3
text "こんにちは 世界" id=jp at=0 dur=4 y=200 size=72 anim=rise anim.by=word anim.stagger=0.25
text "まるく ならぶ もじ" id=ring at=0 dur=4 y=460 size=36 path=circle path.r=120 path.offset="0@0 600@4"
```

- プリセットは `typewriter` / `fadein` / `bounce` / `rise` / `pop` / `slide` / `spread` / `wave` / `colorwave` です。
- `anim.by` で動かす単位（`letter`（既定）/ `char` / `word` / `line`）、`anim.stagger` で単位ごとのずらし（秒）、`anim.dur` で 1 単位が動く秒数を決めます。
- `animout` は終わりに向けて動きます（`animout=fadein` で先頭の字から消える）。`anim2`〜`anim4` で重ねられます。
- `path=circle` / `path=wave` / `path="M ..."` で字を経路に沿って並べ、`path.offset` を動かすと字が経路の上を流れます。縦書きでは使いません。

引数の全部は `mozcut schema` の `anim.*` と、[docs/design/m6-textanim.md](../design/m6-textanim.md) にあります。編集画面では、左のレールの［文字］から、動きの付いた文字をプリセットで置けます。

## 3.8 図形・粒・入れ子

```sh
shape rect id=card w=480 h=140 radius=24 fill=1e293b stroke=38bdf8 strokew=4 pos=640,360 at=0 dur=3
shape path id=uline d="M 0 0 L 520 0" fill=none stroke=ffd040 strokew=8 cap=round x=380 y=470 drawon=0.6 at=0 dur=3
shape star id=star points=5 r=80 inner=34 pos=200,200 fill=ffd040 rotation="0@0 180@3" at=0 dur=3
particles id=sparks emit=point x=640 y=660 rate=120 speed=180 dir=-90 spread=55 life=1.8 size=8 size.end=1 color=ffd060 color.end=f43f5e00 draw=soft blend=add prewarm=1 at=0 dur=3 track=5
video "media/clip_a.mp4" id=pip track=3 at=0 dur=3 w=480 x=-24 y=24 mute
mask ellipse to=pip units=norm x=0.1 y=0.1 w=0.8 h=0.8 feather=0.2
```

- `shape`: 角の丸い枠、0.6 秒で引かれていく下線、回る星。`pos=x,y` は形の中心を置く画面の点です。塗り（`fill`）・線（`stroke`、`strokew`）・トリム（`trimstart` / `trimend`、`drawon` / `drawoff`）・くり返し（`repeat`）などがあります。
- `particles`: 下から吹き上がる火の粉。**particles の行の `x` / `y` は発生源の中心** です（ほかの行の左上とは違います）。`prewarm=1` で、始まりから粒が満ちた絵になります。
- `mask`: 右上の小窓（pip）を、ふちのぼけた楕円で切り抜きます。`to=` で掛けるクリップを指し、`units=norm` なら位置と大きさを層の割合（0〜1）で書きます。
- `comp "sub.mzc"` は、別の `.mzc` を透明な背景の 1 つの層として重ねます（入れ子は 4 段まで）。`model "cup.obj"` は 3D のモデルを、`z` / `rx` / `ry` などの 3D のキーと project の行のカメラ・ライトで描きます。

細かい書き方は、[docs/design/m6-shape.md](../design/m6-shape.md)（図形）、[docs/design/m6-3d.md](../design/m6-3d.md)（3D）、[docs/design/comp.md](../design/comp.md)（入れ子）と `mozcut schema` にあります。`demo/m6/` に見本の `.mzc` があります。

## 3.9 キーを調べる: schema

`mozcut schema` は、キー・効果・トランジション・時刻と参照の書き方・機能の早見・操作の一覧を出します。キーの表は「使える行」「型」「既定」「範囲」「説明」の列です（一部を抜き出し、説明を短くしています）。

```console
$ mozcut schema
コアのキー
  キー               使える行                                                    型      既定                範囲               説明
  size               project                                                     string  1280x720            -                  画面の大きさ（幅x高さ。どちらも 16〜8192 の偶数）
  ...
  at                 *                                                           time    -                   0 以上             タイムライン上の開始時刻か参照（intro.end、intro.start+1.5、intro.end-0.5、after:intro）。コマ（61f、intro.end+2f）でも書ける。...
  in                 video,audio,comp                                            time    0                   0 以上             素材の使い始め
  out                video,audio,comp                                            time    -                   0 以上             素材の使い終わり
  ...
  size               text                                                        int     48                  4..1000            文字の大きさ（画素。フォントの em の大きさ。...）
```

キーには使える行が決まっています。たとえば `w` は text の行では使えず、`in` は image の行では使えません。違う行に書くと `key-not-allowed` になり、ヒントに使える行が出ます。同じ名前のキーが行の種類で違う意味を持つこともあります（`size` は project では画面の大きさ、text では文字の大きさ、particles では粒の大きさ）。

AI のエージェントやスクリプトから読むときは `mozcut schema --json` を使います。

## 3.10 書いたら check

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

誤りがなければ終了コード 0、誤りがあれば 1 です。警告（`font-not-found`、`glyph-missing`（フォントにない字）、`duplicate-key`（同じ値を 2 度書いた）、`timeremap-audio`（音のある映像に timeremap）、`bad-escape` など）は数えません。

診断の一覧と直し方は [7. 困ったとき](07-troubleshooting.md) にあります。

## 3.11 まだ書けないもの（準備中）

- カーニング、合字、フォントにない字（絵文字など）を別のフォントで描くこと（いまは □ で描き、check が `glyph-missing` の警告を出します。`font=` でその字のある書体を選んでください）
- 可変フォントの太さ（`wght`）以外の軸、CFF2 の書体
- 縦書きの文字を経路（`path=`）に沿って並べること
- `model` の行のモーションブラー・被写界深度・テクスチャ・材質（mtl）・glTF
- particles の `draw=image`（`sprite=` の画像はまだ読み込みません）
