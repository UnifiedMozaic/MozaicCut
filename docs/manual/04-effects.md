# 4. 効果を掛ける

[目次](README.md) ／ 前: [3. テキストで編集する](03-text.md) ／ 次: [5. 書き出す](05-export.md)

効果（ぼかし、セピア、ビネット、モザイク…）は、クリップの行に `効果=値` と書くだけで掛かります。効果はプラグイン（`plugins/*.um`）なので、入っている効果の一覧と引数の範囲は、いつも `mozcut schema` か `mozcut plugin list` で確かめてください。

## 4.1 入っている効果

```console
$ mozcut plugin list
組み込みの効果（10 個、plugins/*.um）:
  blur  ぼかす（箱ぼかしを 2 回。ガウスぼかしに近い）
  bright  明るさを変える（rgb に同じ量を足す）
  contrast  コントラストを変える（0.5 を中心に掛ける）
  gray（別名 grey）  白黒にする（彩度を 1 - amount にする）
  invert  色を反転する
  pixelate（別名 mosaic）  モザイクにする（各ブロックを平均の色で塗る）
  sat（別名 saturation）  彩度を変える（BT.709 の輝度を中心に掛ける）
  sepia  セピア調にする
  sharpen  くっきりさせる（アンシャープマスク）
  vignette  周辺を暗くする

入れた .mzplug はありません（node tools/mozcut.mjs plugin install <file.mzplug>）
```

| 効果 | 引数（既定値、範囲） |
| --- | --- |
| `bright` | amount（0、-1..1） |
| `contrast` | amount（1、0..4） |
| `sat`（別名 `saturation`） | amount（1、0..4） |
| `gray`（別名 `grey`） | amount（1、0..1） |
| `sepia` | amount（1、0..1） |
| `invert` | amount（1、0..1） |
| `blur` | radius（2、0..64） |
| `sharpen` | amount（0.6、0..4）、radius（1、1..8） |
| `vignette` | strength（0.5、0..1）、radius（0.6、0..2）、softness（0.4、0..2） |
| `pixelate`（別名 `mosaic`） | size（12、1..256） |

## 4.2 書き方

```sh
video "media/clip_b.mp4" id=main vignette=0.6 vignette.radius=0.9 blur=2
video "media/clip_a.mp4" id=opening gray
text "ぼかした文字" size=80 blur=3 dur=2
```

- `<効果>=<値>` は、主の引数（表の最初の引数）を決めて効果を有効にします。
- `<効果>.<引数>=<値>` は、ほかの引数を決めます（これだけ書いても効果は有効になります）。
- `.mzc` に名前だけ（`gray`）書くと、主の引数の既定値で掛かります。
- 書かなかった引数は既定値です。範囲の外は `out-of-range` になります。
- 効果は **行に初めて出てきた順** に掛かります（上の main は vignette → blur）。
- 別名でも書けます（`saturation=1.2` は `sat=1.2`、`mosaic=8` は `pixelate=8`）。

効果を書ける行は video / image / text / color です。audio の行に書くと `key-not-allowed` です。

## 4.3 クリップに掛ける

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

## 4.4 画面全体に掛ける

合成した画面全体に掛けるときは、**project の行** に書きます（ほかのソフトの「調整レイヤー」の代わり）。

```sh
project size=1280x720 fps=30 output=first.mp4 vignette=0.5     # fx.mzc の 2 行目をこう書き換える
```

- project の行は `op set` で指せないので、テキストエディタで書き換えます。
- 透明な color の行（`opacity=0`）に効果を書いても、画面全体には掛かりません。

## 4.5 確かめる

効果は数で書くので、見た目は `preview` で確かめます。

```console
$ mozcut preview fx.mzc 5 -o fx5.png
mozcut: ffmpeg で素材を 2 件展開しています（1 件は展開済み）...
mozcut: fx5.png に書きました（0:05.000）
```

## 4.6 効果を足す（プラグイン）

`plugins/<名前>.um` を 1 つ足すと、次のビルドで効果が 1 つ増え、`mozcut schema` にも載ります。書き方は [README の「効果のプラグインを書く」](../../README.md#効果のプラグインを書く) と [architecture.md](../design/architecture.md) にあります。

wasm の包み（`.mzplug`）は `mozcut plugin build` で作り、`plugin install` で入れられますが、**いまの版では、入れた包みを描画（check / preview / render / 編集画面）にはまだ使いません**（準備中）。

## 4.7 準備中

- 色の調整の画面（色温度、リフト・ガンマ・ゲイン、カーブ、LUT）とスコープ（波形、ベクトルスコープ、ヒストグラム）
- 効果の値をつまみで変えるインスペクタ、効果のキーフレーム
- 合成の描画モード、キーイング（クロマキー）、トラッキング
