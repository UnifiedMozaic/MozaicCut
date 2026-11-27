# 4. 効果を掛ける

[目次](README.md) ／ 前: [3. テキストで編集する](03-text.md) ／ 次: [5. 書き出す](05-export.md)

効果（ぼかし、セピア、ビネット、モザイク、発光、グリッチ…）は、クリップの行に `効果=値` と書くだけで掛かります。効果とトランジション（場面のつなぎ）はすべてプラグイン（`.mzplug`）で、この版には効果が 47 種類、トランジションが 16 種類入っています。入っている効果の一覧と引数の範囲は、いつも `mozcut schema` か `mozcut plugin list` で確かめてください。

## 4.1 編集画面で付ける

画面の操作だけで付けるときは、[0.8](00-beginner.md#08-効果とトランジションを付ける) のとおりです。

1. タイムラインでクリップを選び、左のレールの［**効果**］を押します。
2. 一覧から効果を選んで［**適用**］を押します（クリップの上へドラッグしても付きます）。上の「色」「ぼかし・シャープ」「キー」「スタイライズ」「プリセット」「トランジション」で種類を絞れ、「効果を探す」で名前から探せます。
3. 強さなどの引数は、右のインスペクタの効果の欄で変えます。

画面で付けた効果も、この章の書き方のとおりに `.mzc` の行へ書かれます。逆に `.mzc` に書いた効果は、インスペクタに出ます。

## 4.2 入っている効果

```console
$ mozcut plugin list
組み込みの効果（47 個、plugins/*.um）:
  blinds  ブラインド（層を平行な帯で隠し、帯の太さをキーで動かす。トランジションではなく 1 つの層の効果）
  blur  ぼかす（箱ぼかしを 2 回。ガウスぼかしに近い）
  bright  明るさを変える（rgb に同じ量を足す）
  ...
  vignette  周辺を暗くする
  wave  波のように揺らす（水面・陽炎のような歪み）

入れた .mzplug はありません（node tools/mozcut.mjs plugin install <file.mzplug>）
```

よく使うものを、編集画面の種類ごとに並べます（引数は主の引数。既定値と範囲）。

**色**

| 効果 | 画面の名前 | 主の引数（既定値、範囲） |
| --- | --- | --- |
| `bright` | 明るさ | amount（0、-1..1） |
| `contrast` | コントラスト | amount（1、0..4） |
| `sat`（別名 `saturation`） | 彩度 | amount（1、0..4）。0 で白黒 |
| `vibrance` | 自然な彩度 | amount（0、-1..1） |
| `exposure` | 露出 | ev（0、-4..4）。+1 で 2 倍の明るさ |
| `temperature` | 色温度 | warmth（0、-1..1）。+ で暖かく、- で青く |
| `levels` | レベル補正 | black（0、0..1）。`levels.white` と組で使う |
| `gray`（別名 `grey`） | 白黒 | amount（1、0..1） |
| `sepia` | セピア | amount（1、0..1） |
| `tint` | カラーフィルター | amount（0.4、0..1）。色は `tint.r` / `.g` / `.b` |
| `hue` | 色相回転 | angle（30、-180..180） |
| `invert` | 色の反転 | amount（1、0..1） |
| `filmfade` | 色あせフィルム | amount（0、0..1） |

ほかに `duotone`（デュオトーン）、`posterize`（ポスタライズ）、`solarize`（ソラリゼーション）、`threshold`（2 値化）があります。

**ぼかし・シャープ**

| 効果 | 画面の名前 | 主の引数（既定値、範囲） |
| --- | --- | --- |
| `blur` | ぼかし | radius（2、0..64）。画素 |
| `sharpen` | シャープ | amount（0.6、0..4） |
| `glow`（別名 `bloom`） | グロー（発光） | amount（0.6、0..2） |
| `motionblur` | 方向ブラー | length（8、0..48）。向きは `motionblur.angle` |

**スタイライズ**

| 効果 | 画面の名前 | 主の引数（既定値、範囲） |
| --- | --- | --- |
| `vignette` | 周辺減光 | strength（0.5、0..1） |
| `pixelate`（別名 `mosaic`） | モザイク | size（12、1..256）。ブロックの一辺の画素 |
| `grain`（別名 `noise`） | フィルム粒子 | amount（0.15、0..1） |
| `letterbox` | シネスコの帯 | ratio（0、0..4）。2.39 でシネスコ |
| `chromatic`（別名 `aberration`） | 色収差 | shift（6、-64..64） |
| `glitch` | グリッチ | amount（16、0..128） |
| `scanline` | 走査線 | strength（0.45、0..1） |
| `halftone` | ハーフトーン（網点） | size（8、3..48） |
| `lightleak` | 光漏れ | amount（0、0..1） |

ほかに、ゆがみの `wave`・`ripple`・`swirl`・`bulge`・`kaleido`・`mirror`、絵作りの `edge`・`emboss`・`dither`・`rgbsplit`・`slice`、動かして使う `blinds`・`shatter`、立体を描く `raymarch` があります。

**キー**（背景を抜く）: `chromakey`（クロマキー）、`lumakey`（ルミナンスキー）、`matteview`（抜け具合を見る）。書き方は [4.9](#49-色の調整とキーイング)。

すべての効果の引数（`blur.radius` のような 2 番目からの引数も）は、`mozcut schema` の「効果（プラグイン）」の節にあります。

## 4.3 書き方

```sh
video "media/clip_b.mp4" id=main vignette=0.6 vignette.radius=0.9 blur=2
video "media/clip_a.mp4" id=opening gray
text "ぼかした文字" size=80 blur=3 dur=2
```

- `<効果>=<値>` は、主の引数（表の引数）を決めて効果を有効にします。
- `<効果>.<引数>=<値>` は、ほかの引数を決めます（これだけ書いても効果は有効になります）。
- `.mzc` に名前だけ（`gray`）書くと、主の引数の既定値で掛かります。
- 書かなかった引数は既定値です。範囲の外は `out-of-range` になります。
- 効果は **行に初めて出てきた順** に掛かります（上の main は vignette → blur）。
- 別名でも書けます（`saturation=1.2` は `sat=1.2`、`mosaic=8` は `pixelate=8`）。

効果は、絵のある行（video / image / text / color / shape / particles / spectrum / comp）と project の行に書けます。audio の行に書くと `key-not-allowed` です。

## 4.4 クリップに掛ける

クリップの行の効果は、**そのクリップにだけ** 掛かります（小窓やロゴにも別々に掛かります）。コマンドなら `set` で足し、`unset` で外します（この章の例は、[1.5](01-getting-started.md#15-プロジェクトを作る) の `first.mzc` を `fx.mzc` に写して実行したものです）。

```console
$ mozcut op fx.mzc set main vignette=0.6 vignette.radius=0.9 blur=2
main の値を変えました: vignette 0.6（新規）、vignette.radius 0.9（新規）、blur 2（新規）
  - 5: video "media/clip_b.mp4" id=main xfade=0.5
  + 5: video "media/clip_b.mp4" id=main xfade=0.5 vignette=0.6 vignette.radius=0.9 blur=2
保存しました（fx.mzc）
$ mozcut op fx.mzc unset main blur --dry-run
main から blur=2 を消しました
  - 5: video "media/clip_b.mp4" id=main xfade=0.5 vignette=0.6 vignette.radius=0.9 blur=2
  + 5: video "media/clip_b.mp4" id=main xfade=0.5 vignette=0.6 vignette.radius=0.9
保存していません（--dry-run）
```

`op set` では、名前だけの書き方（`set opening gray`）は使えません（`bad-args`）。`set opening gray=1` と値を書きます。

効果の名前を書き間違えたときは、`renamekey` で直すと、効果の掛かる順が変わりません。

```console
$ mozcut op fx.mzc renamekey main blur sharpen --dry-run
main のキー blur を sharpen に変えました（値と位置はそのまま）
  - 5: video "media/clip_b.mp4" id=main xfade=0.5 vignette=0.6 vignette.radius=0.9 blur=2
  + 5: video "media/clip_b.mp4" id=main xfade=0.5 vignette=0.6 vignette.radius=0.9 sharpen=2
保存していません（--dry-run）
```

綴りを誤ったキーは、ファイルを書き換えずに止めて、近い名前を推します。

```console
$ mozcut op fx.mzc set main vignete=0.5
エラー[unknown-key]: この操作で誤りが増えるため、適用しませんでした（5 行目: 'vignete' というキーはありません）
  ヒント: 'vignette' のことですか？
何も書き換えていません
```

- `vignette` の中心は、掛ける層の中央です（文字なら文字の箱、小窓なら小窓の中）。
- 文字の行の効果は、文字を透明な層に描いてから掛けます。`blur` / `sharpen` は、透明なまわりのある層（画像・文字）では、ぼかしが広がる分の余白を足してから掛けるので、四角く切れません。

## 4.5 トランジション（場面のつなぎ）

同じトラックで続くクリップの **後ろ側の行** に、`xfade=<秒>`（重ねる長さ）と `trans=<種類>` を書きます。`trans=` を書かなければクロスフェードです。

```console
$ mozcut op fx.mzc set main trans=wipe trans.angle=30 trans.soft=0.15 --dry-run
main の値を変えました: trans wipe（新規）、trans.angle 30（新規）、trans.soft 0.15（新規）
  - 5: video "media/clip_b.mp4" id=main xfade=0.5 vignette=0.6 vignette.radius=0.9 blur=2
  + 5: video "media/clip_b.mp4" id=main xfade=0.5 vignette=0.6 vignette.radius=0.9 blur=2 trans=wipe trans.angle=30 trans.soft=0.15
保存していません（--dry-run）
```

| 種類 | 切り替わり方 |
| --- | --- |
| `dissolve` | 滑らかに重ねる |
| `dipblack` / `dipwhite` | 一度黒（白）に落としてから次へ |
| `wipe` | `trans.angle` の向きから境目がすべる |
| `slide` / `push` | 次の映像が滑り込む / 前の映像を押し出す |
| `zoom` | 前の映像が拡大しながら次へ |
| `iris` / `diamond` | 中央から円 / ひし形に開く |
| `split` | 中央の線から左右に開く（`trans.angle=90` で上下） |
| `clock` | 時計回りの扇形 |
| `blinds` / `checker` | すだれ / マス目ごとに入れ替わる（数は `trans.param`） |
| `pixelize` | モザイクを粗くして入れ替え、細かく戻す |
| `glitch` | デジタルノイズと横ずれを挟む |
| `lumawipe` | 前の映像の暗い所から先に（`trans.param=1` で明るい所から） |

- `trans.angle` は向き（度）、`trans.soft` は境目の柔らかさ（0..1、既定 0.08）、`trans.param` は種類ごとの追加の値です。
- 編集画面では、後ろのクリップを選んで **Ctrl+D** でつなぎを付け、［効果］の［トランジション］から種類を選びます。
- カットでつなぐのを基本にし、場面の節目だけ 0.25〜0.6 秒くらいで使うと引き締まります。

## 4.6 画面全体に掛ける

合成した画面全体に掛けるときは、**project の行** に書きます（ほかのソフトの「調整レイヤー」の代わり）。

```console
$ mozcut op fx.mzc set project vignette=0.5 --dry-run
project の値を変えました: vignette 0.5（新規）
  - 2: project size=1280x720 fps=30 output=first.mp4
  + 2: project size=1280x720 fps=30 output=first.mp4 vignette=0.5
保存していません（--dry-run）
```

- `op set project ...` か、テキストエディタで project の行に書きます。仕上げに `vignette=0.35 grain=0.06` のように薄く重ねると、全体の空気がそろいます。
- 透明な color の行（`opacity=0`）に効果を書いても、画面全体には掛かりません。
- キーイング（`chromakey` など）は project の行に書いても意味がありません。クリップの行に書きます。

## 4.7 重ね方（描画モード・マスク・トラックマット）

```sh
image "media/logo.png" id=logo at=0 dur=7 x=24 y=24 w=120 blend=screen
color ff8040 id=warm at=0 dur=7 track=4 opacity=0.25 blend=softlight
video "media/clip_a.mp4" id=pip track=3 at=1 dur=3 w=320 h=180 x=-24 y=-24 pixelate=8 sepia=0.8 mute
mask ellipse to=pip units=norm x=0.05 y=0.05 w=0.9 h=0.9 feather=0.1
```

- `blend=<モード>` で下の絵との混ぜ方を決めます: `normal` / `add` / `multiply` / `screen` / `overlay` / `softlight` / `hardlight` / `lighten` / `darken` / `difference` / `exclusion` / `hue` / `saturation` / `color` / `luminosity`。光や炎は `screen` か `add`、影や汚しは `multiply` が合います。
- `mask` の行は、`to=` のクリップの一部だけを見せます（形は `rect` / `ellipse` / `path`、ふちのぼかしは `feather`）。コマンドでは `op add mask ellipse to=pip ...` で足します。
- `matte=<ID>` は、ほかのクリップ（文字など）の形で抜きます（トラックマット。元のクリップは画面に描かれません）。particles の行にも書けるので、`matte=` に縦長の color の ID を書くと、その枠の中だけに粒が舞います。

詳しくは `mozcut schema` の「機能の早見」の描画モードの項と、`demo/m6/blend.mzc` にあります。

## 4.8 効果を動かす

効果の引数は、キーフレーム（[3.6](03-text.md#36-時間で動かすキーフレーム)）で時間とともに変えられます。`expr(...)` で式を書くと、音に合わせて動かすこともできます。

```sh
project size=1280x720 fps=30 vignette="0@0 0.8@6"
video "media/clip_a.mp4" id=opening in=1 out=4 blur="8@0 0@1:ease"
image "media/logo.png" id=logo at=0 dur=7 x=24 y=24 w=120 glow="expr(0.3 + audioBass() * 1.5)"
```

- opening は、ぼけた所から 1 秒でくっきりします。project の行の vignette は 6 秒かけて濃くなります（project の行の時刻はタイムラインの秒）。
- logo は、曲の低い音（`audioBass()`）に合わせて光ります。`audioLevel()` / `audioMid()` / `audioHigh()` も使えます。
- 式は `x` / `y` / `pos` / `opacity` / `rotation` / `scale` と効果の引数などに書けます（音量には書けません）。式で使える名前と関数は `mozcut schema --json` の `expressions` と [docs/design/m6-expr.md](../design/m6-expr.md) にあります。

## 4.9 色の調整とキーイング

**色の調整**（グレーディング）は、video / image の行に `grade.*` で書きます。効果より先に掛かります。編集画面の色のワークスペースのホイールやカーブも、このキーを書き換えます。

```sh
video "media/clip_b.mp4" id=main grade.saturation=1.15 grade.temperature=6800 grade.lift="-0.02 0 0.03 0" grade.gain="1.05 1.0 0.94 1"
```

`grade.temperature` / `grade.tint` / `grade.exposure` / `grade.saturation`、ホイールの `grade.lift` / `grade.gamma` / `grade.gain` / `grade.offset`（`"r g b m"`）、カーブの `grade.curve.y` など、LUT の `grade.lut`（`.cube`）があります。一覧は README の「色の調整（grade.*）」にあります。

**キーイング**（緑や青の背景を抜く）は、抜きたいクリップの行に書きます。

```sh
# 素材の名前は例です
video "talent.mp4" id=talent track=1 at=0 chromakey=0.3 chromakey.shrink=1 chromakey.feather=1
video "talent.mp4" chromakey=0.3 matteview=2      # 抜け具合を市松模様の上で見る（書き出しの前に消す）
video "logo_on_black.mp4" lumakey=0.08 lumakey.softness=0.1
```

キーの色の変え方や外し方は [docs/keying.md](../keying.md) にあります。

## 4.10 プリセット

編集画面の［効果］の「プリセット」は、いくつかの効果と色の調整を組み合わせた見た目（映画風・レトロ・グリッチなど）を一度に付けます。付けると、組み合わせた効果のキーがそのままクリップの行に書かれます。

自分のプリセットは、`presets/fx.mzc` に 1 行足すと、次に編集画面を開いたときに効果の一覧に出ます。このファイルは、編集画面を起動した作業フォルダから探します（リポジトリから動かすときは、リポジトリの `presets/fx.mzc`）。

```sh
fx name="モノクロ・ノワール" note="硬いコントラストと粒子、周辺減光の重厚な白黒" gray=1 contrast=1.45 vignette=0.55 grain=0.25
```

同じ `name=` を書くと、組み込みのプリセットを上書きします。文字のプリセットは `presets/text.mzc`、音は `presets/audio.mzc` です。

## 4.11 確かめる

効果は数で書くので、見た目は `preview` で確かめます。

```console
$ mozcut preview fx.mzc 5 -o fx5.png
mozcut: ffmpeg で素材を 2 件展開しています（1 件は展開済み）...
mozcut: fx5.png に書きました（0:05.000）
```

キーイングやマスクの抜け具合は、`matteview=1`（白黒）か `matteview=2`（市松模様）を一時的に足して見ると分かりやすくなります。

## 4.12 効果を足す（プラグイン）

効果とトランジションは、`.mzplug` のファイル 1 つが 1 つです。本体を作り直さずに足せます。

```sh
mozcut plugin install posterize2.mzplug     # plugins-installed/ に入れる
mozcut plugin list                          # 入れたものも一覧に出る
mozcut plugin uninstall posterize2          # 外す
```

- 入れた効果は、`check` / `show` / `op` / `schema` / `preview` / `render` と編集画面のすべてで使えます。編集画面を開いたままなら、［効果］の［**再読込**］で読み直します。
- MozaicCut の exe の隣の `plugins/` フォルダの `.mzplug` も、起動のときに読みます。
- 効果の作り方（`.um` で書いて `mozcut plugin build` で包む）は、[README の「効果のプラグインを書く」](../../README.md#効果のプラグインを書く) と、標準のプラグインのソースを置いている [MozaicCut-Plugins](https://github.com/UnifiedMozaic/MozaicCut-Plugins) にあります。式で書く小さな効果は [docs/effect-script.md](../effect-script.md) にあります。

## 4.13 準備中

- 3D のレイヤー（`z` / `rx` / `ry` などを書いた行）の描画モードとトラックマット（`blend=` / `matte=` は効かず、`key-ignored` の警告が出ます。マスクは効きます）
- 音量（`volume`）を式で決めること（音量はキーフレームで動かします）
