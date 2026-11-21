# 素材の解析（src/analyze/）

素材を調べて、編集の手がかりと **操作の提案** を作る部品です。結果はいつも、人が読む日本語の文と、AI やプログラムが読む JSON（`--json`）の両方で出します。提案は **自動では適用しません**。AI と人が確かめてから、選んだものを `op` で適用します（操作の仕組みは `src/ops.um` の一つだけ）。

| 調べるもの | 入力 | 方法 |
| --- | --- | --- |
| シーンの切れ目 | 展開済みの Y4M（`<cache>/clip<i>.y4m`。render.um の `y4mInfo` と同じ形式） | kernel で 1 コマを小さな縮小画像（ブロックごとの Y・U・V の平均と暗い画素の割合）にし、前のコマと色のヒストグラム（Y 16・U 8・V 8 区分）の差と輝度の差を比べる |
| 黒いコマ | 同じ | 輝度が `--black-pixel` 以下の画素の割合が `--black-ratio` 以上のコマが `--min-black` 秒以上続く区間 |
| 止まったコマ | 同じ | 前のコマとの輝度の差が `--freeze-threshold` 未満のコマが `--min-freeze` 秒以上続く区間（黒いコマは除く） |
| 無音 | PCM のキャッシュ（`<cache>/clip<i>.pcm`。s16le、既定 48 kHz・2 チャンネル） | kernel で 10 ミリ秒の窓ごとの 2 乗平均を求め、`--threshold` dB 未満が `--min` 秒以上続く区間 |
| 言葉の区間・字幕 | 書き起こしの JSON（whisper.cpp の `-oj` / `-ojf`、OpenAI / faster-whisper の `segments`、単語の並び） | 単語ごとの時刻から、話している区間・言葉のない区間・字幕（行の幅・行の数・長さで区切る）を作る |

kernel（`azThumbKernel`、`azPowerKernel`）は `dispatch` で実行するので、ふつうのビルドでは CPU の複数のスレッドで、`UM_WGPU=1` のビルドでは GPU で動きます。どちらでも JSON は 1 バイトも違いません（`tests/analyze/run.mjs` の gpu で確かめます）。

書き起こしそのもの（Whisper）は外部のプロセスが要るので、ここでは行いません。たとえば whisper.cpp なら次のようにして JSON を作り、それを渡します。

```
ffmpeg -i media/talk.mp4 -ar 16000 -ac 1 -c:a pcm_s16le talk16k.wav
whisper-cli -m ggml-base.bin -f talk16k.wav -ojf -of talk     # talk.json（トークンごとの時刻つき）
```

## コマンド

本体に組み込むまでは、試験用の入口 `src/azmain.um` をビルドして使います（組み込んだ後は `node tools/mozcut.mjs analyze ...`）。

```
node <UnifiedMozaic>/src/cli.ts build src/azmain.um --target host -o build/mozcut-analyze
```

```
analyze video   <file.y4m> [--scene-threshold 0.3] [--luma-threshold 0.12] [--min-gap 0.5]
                [--black-pixel 32] [--black-ratio 0.98] [--min-black 0.25]
                [--freeze-threshold 0.002] [--min-freeze 1] [--step 1] [--frames] [--json]
analyze audio   <file.pcm> [--rate 48000] [--channels 2] [--threshold -40] [--min 0.5] [--levels] [--json]
analyze words   <whisper.json> [--max-gap 0.5] [--json]
analyze subs    <whisper.json> [--offset 0] [--max-width 32] [--max-lines 2] [--max-dur 6] [--max-gap 0.8]
                [--min-dur 0.8] [--srt <out.srt>] [--json]
analyze suggest <project.mzc> <cache> [--no-scenes] [--no-silence] [--no-black] [--freeze]
                [--silence-from <clip>] [--threshold -40] [--min-silence 0.8] [--pad 0.15] [--min-cut 0.3]
                [--scene-threshold 0.3] [--luma-threshold 0.12] [--min-gap 0.5] [--min-black 0.25] [--min-freeze 1]
                [--transcript <clip>=<whisper.json>[@<秒>]]... [--speech-gap 1.0] [--subtitles] [--sub-track N]
                [--sub-style "y=-60 size=40"] [--ops <out.txt>] [--json]
```

- 時刻: `video` / `audio` / `words` / `subs` はファイルの始まりからの秒（`video` の JSON の `source` は `<file>.in` を足した素材の秒）。`suggest` はタイムラインの秒。
- シーンの切れ目の判定: 色の差 ≥ `--scene-threshold`、または（輝度の差 ≥ `--luma-threshold` かつ色の差 ≥ その半分）。`--min-gap` 秒より近い切れ目は強い方だけを残す。
- `--transcript` の時刻は素材の秒（素材のファイルをそのまま書き起こしたもの）。展開したキャッシュ（in から始まる）を書き起こしたときは `@<in の秒>` を付ける。
- 止まったコマは、静止画やタイトルの見せ場のこともあるので、`suggest` では `--freeze` を付けたときだけ切る提案にする。
- 終了コード: 0 は成功、1 は読めない・誤りがある、2 は使い方の誤り。`--json` では失敗も `{"ok":false,"error":"..."}` で出す。

### 例

```
$ mozcut-analyze video cache/clip0.y4m
v.y4m: 160x90、30/1 fps、240 コマ（0:08.000）
シーンの切れ目 4 か所:
  0:02.000（60 コマ目）  強さ 2.6075（色の差 0.7822、明るさの差 0.1874）
  ...
黒いコマの区間 1 か所:
  0:04.000 〜 0:05.000（1 秒）

$ mozcut-analyze suggest demo.mzc demo.cache --transcript voice=talk.json --subtitles --ops ops.txt
提案 7 個（自動では適用しません。確かめてから op で適用します。この順のまま適用してください）:
  1. [scene] split clip_a 7
     clip_a の 7 秒でシーンが切り替わります（強さ 2.9227、色の差 0.8768、明るさの差 0.278）
  ...
  6. [black+silence+speech-gap] cut 4 5.85
     4 〜 5 秒は clip_a の黒いコマです。4.5 〜 6 秒は どの音のクリップも -40 dB 未満です。...
```

`--ops` のファイルは `node tools/mozcut.mjs op <project.mzc> --file ops.txt` にそのまま渡せます（1 行に 1 つの操作、理由は `#` の注釈）。要らない行は消すか `#` を付けます。

## 提案の作り方（suggest）

| kind | 操作 | 元 |
| --- | --- | --- |
| `scene` | `split <clip> <時刻>` | 映像のクリップの切れ目（クリップの in〜out の中だけ。クリップの端の近くは出さない） |
| `silence` | `cut <開始> <終わり>` | どの音のクリップも鳴っていない区間（`--silence-from` なら、そのクリップだけ）。前後に `--pad` 秒を残す |
| `black` / `freeze` | `cut` | 黒いコマ・止まったコマの区間 |
| `speech-gap` | `cut` | 書き起こしで言葉のない区間（`--speech-gap` 秒以上） |
| `subtitle` | `add text "..." id=sub_<n> at=.. dur=.. track=..` | 書き起こしの字幕（クリップの範囲の中だけ。トラックは空いている上のトラック、`--sub-track` で指定） |

重なる cut は 1 つにまとめます（kind は `black+silence` のように `+` でつなぐ）。並べ方は、**この順に適用すればどこまで適用しても時刻とクリップの指し方がずれない** ようにしてあります: split（クリップの行の大きい順、同じクリップなら時刻の大きい順）→ add（時刻の順）→ cut（時刻の大きい順）。一部だけを選ぶときも、この順を保てば同じです。

JSON（`suggest --json`）:

```json
{"ok":true,"project":"p.mzc","applied":false,
 "proposals":[{"kind":"scene","op":"split clip_a 4","clip":"clip_a","start":4,"end":4,"score":3.0566,"reason":"clip_a の 4 秒で..."}, ...],
 "ops":["split clip_a 4", ...],"warnings":[],"opsFile":"ops.txt"}
```

## ファイル

| ファイル | 中身 |
| --- | --- |
| `src/analyze/azcommon.um` | 区間（`AzSpan`）、数・時刻の書き方、JSON の文字列、log/exp、区間の整列・まとめ・補集合、Y4M のヘッダとコマの読み取り |
| `src/analyze/video.um` | 縮小画像の kernel（と同じ計算の CPU 版 `azThumbCpu`）、ヒストグラムの差、シーン・黒・止まりの判定、JSON と文 |
| `src/analyze/audio.um` | 窓ごとの 2 乗平均の kernel、無音の判定、JSON と文 |
| `src/analyze/json.um` | 小さな JSON の読み取り（書き起こし用。UTF-8・`\uXXXX`・サロゲートの組） |
| `src/analyze/transcript.um` | 書き起こしの読み取り（3 つの形）、話している区間、字幕（幅は全角を 2 と数える）、SRT |
| `src/analyze/suggest.um` | 提案の列（`AzProposal`）、まとめと並べ方、`op --file` の形・JSON・文 |
| `src/analyze/cli.um` | `azRun(引数)`（analyze のコマンド） |
| `src/azmain.um` | 試験用の入口（`azRun(args())`） |
| `tests/analyze/run.mjs` | テスト（node だけ。素材は node と ffmpeg で作る） |

名前はすべて `Az` / `az` / `AZ` で始まり、ほかの部品とぶつかりません。

## テスト

```
node tests/analyze/run.mjs            # 全部（ffmpeg がなければ ffmpeg の群を飛ばす）
node tests/analyze/run.mjs --no-engine   # エンジン（build/mozcut）での op --dry-run を飛ばす
UM_WGPU_HOME=<wgpu-native> node tests/analyze/run.mjs   # GPU（wgpu）でも CPU と同じ結果か
```

node で作った Y4M（場面の切り替え・黒・止まり）と PCM（音・無音・しきい値より小さい雑音）、ffmpeg の lavfi で作った映像と音、whisper.cpp と segments の形の書き起こし（`tests/analyze/*.json`）で、検出の時刻（映像は 1 コマ、音は 10 ミリ秒の窓の精度）と、提案の操作の文字列を確かめます。提案はエンジンの `op --dry-run` に通し、すべて適用できることも確かめます。
