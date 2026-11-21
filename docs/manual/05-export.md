# 5. 書き出す

[目次](README.md) ／ 前: [4. 効果を掛ける](04-effects.md) ／ 次: [6. AI と一緒に使う（MCP）](06-ai.md)

書き出しはコマンドで行います。書き出しの画面（ワークスペース「出力」、Ctrl+M）は **準備中** です。

**誤りのあるプロジェクトは、`preview` も `render` も誤りを出して止まります。** 先に `mozcut check` を通してください。

## 5.1 1 コマを画像にする

```console
$ mozcut preview first.mzc 1.5
mozcut: ffmpeg で素材を 3 件展開しています...
mozcut: preview.png に書きました（0:01.500）
```

- 既定の書き先は、`.mzc` と同じフォルダの `preview.png` です。`-o shot.png` で変えられます（`.bmp` も書けます）。
- 時刻は秒（`1.5`）か `分:秒`（`1:02.5`）です。
- 全体の長さより後ろの時刻は、警告を出して背景だけを描きます。

```console
$ mozcut preview demo/demo.mzc 20
mozcut: 警告: 0:20.000 は全体の長さ（0:10.500）より後ろです（背景だけが描かれます）
mozcut: demo\preview.png に書きました（0:20.000）
```

動画を全部書き出すより速いので、見た目の確かめには `preview` で十分なことが多いです。

## 5.2 動画を書き出す

```console
$ mozcut render first.mzc
mozcut: ffmpeg で素材を 2 件展開しています（3 件は展開済み）...
映像 62/255 コマ（毎秒 61.2 コマ）
映像 132/255 コマ（毎秒 65.3 コマ）
映像 204/255 コマ（毎秒 67.5 コマ）
映像 255/255 コマ（毎秒 69.6 コマ）
音を書きました（0:08.500）
mozcut: C:\Users\you\Videos\myvideo\first.mp4 を書き出しています...
mozcut: C:\Users\you\Videos\myvideo\first.mp4 に書き出しました
```

- 書き出し先は project の行の `output=`（`.mzc` のフォルダから）です。省くと `out.mp4` です。
- `-o part.mp4` で書き出し先を変えられます（このときは、コマンドを実行したフォルダからのパスです）。
- **同じ名前のファイルがあれば、確かめずに上書きします。**
- 書き出す形式は H.264（yuv420p、BT.709）と AAC 192kbps の MP4 だけです。ほかの形式は準備中です。
- 1 コマずつ合成した中間ファイル（`out.y4m` / `out.pcm`）は、エンコードが済むと消します。

上の例で書き出した `first.mp4` を ffprobe で見ると、次のとおりです。

```console
$ ffprobe -v error -show_entries stream=codec_name,width,height,r_frame_rate,sample_rate -show_entries format=duration -of compact first.mp4
stream|codec_name=h264|width=1280|height=720|r_frame_rate=30/1
stream|codec_name=aac|sample_rate=48000|r_frame_rate=0/0
format|duration=8.500000
```

### 一部だけ書き出す

```console
$ mozcut render first.mzc --from 2 --to 4 -o part.mp4 -j 2
映像 60/60 コマ（毎秒 67.4 コマ）
音を書きました（0:02.000）
mozcut: C:\Users\you\Videos\myvideo\part.mp4 を書き出しています...
mozcut: C:\Users\you\Videos\myvideo\part.mp4 に書き出しました
```

範囲が空のときは、何もせずに止まります（終了コード 2）。

```console
$ mozcut render first.mzc --from 5 --to 3
mozcut: 範囲が空です（--from 5 --to 3）。--to は --from より後ろにします
$ mozcut render first.mzc --from 20
mozcut: 範囲が空です（--from 20 は全体の長さ 0:08.500 より後ろです）
```

### 画質と速さ

project の行で決めます。

| key | 意味 | 既定 |
| --- | --- | --- |
| `crf` | x264 の画質（0〜51。小さいほど高画質で、ファイルが大きい） | 20 |
| `preset` | x264 の速さ（`ultrafast` 〜 `placebo`。遅いほど同じ画質で小さい） | `medium` |
| `size` / `fps` / `rate` | 画面の大きさ・1 秒のコマ数・音の標本化周波数 | 1280x720 / 30 / 48000 |

```sh
project size=1920x1080 fps=30 output=final.mp4 crf=18 preset=slow
```

`-j N` は、素材の展開で ffmpeg を同時に動かす数です。

## 5.3 素材のキャッシュ

MozaicCut は、素材を ffmpeg でプロジェクトのコマ数・大きさの生の映像と音に展開し、`<プロジェクト名>.cache/` に残します（2 回目からは、クリップの設定や素材が変わらなければ使い回します）。

- ディスクを多く使います（720p で 1 秒あたり約 40 MB。上の 8.5 秒の例で約 365 MB）。
- 消しても構いません。次の `preview` / `render` / `edit` で作り直します。
- クリップの並びを変えると、展開し直すことがあります（キャッシュはクリップの番号ごとのため）。

## 5.4 準備中

- 書き出しの画面（形式の選択、キュー、進み具合の表示）
- H.264 / AAC の MP4 以外の形式（ProRes、HEVC、画像の連番、音だけ など）、HDR の書き出し
- ffmpeg を使わない、その場での展開（いまは展開したキャッシュを読みます）
