# 素材の解析（src/effects/analyze/）

素材を調べて、編集の手がかりと **操作の提案** を作る部品です。結果はいつも、人が読む日本語の文と、AI やプログラムが読む JSON（`--json`）の両方で出します。提案は **自動では適用しません**。AI と人が確かめてから、選んだものを `op` で適用します（操作の仕組みは `src/engine/ops.um` の一つだけ）。

| 調べるもの | 入力 | 方法 |
| --- | --- | --- |
| シーンの切れ目 | 展開済みの Y4M（`<cache>/clip<i>.y4m`。media.um の `mediaOpenY4m` と同じ形式） | kernel で 1 コマを小さな縮小画像（ブロックごとの Y・U・V の平均と暗い画素の割合）にし、前のコマと色のヒストグラム（Y 16・U 8・V 8 区分）の差と輝度の差を比べる |
| 黒いコマ | 同じ | 輝度が `--black-pixel` 以下の画素の割合が `--black-ratio` 以上のコマが `--min-black` 秒以上続く区間 |
| 止まったコマ | 同じ | 縮小画像の **どのブロックも** 前のコマとの輝度の差が `--freeze-threshold`（既定 0.012 ≒ 3 階調）未満のコマが `--min-freeze` 秒以上続く区間（黒いコマは除く）。差の平均ではなく最大で決めるので、話す人のアップや小さな被写体のように画面の一部だけが動く映像は止まったことにならない |
| 無音 | PCM のキャッシュ（`<cache>/clip<i>.pcm`。s16le、既定 48 kHz・2 チャンネル） | kernel で 10 ミリ秒の窓ごとの 2 乗平均を求め、`--threshold` dB 未満が `--min` 秒以上続く区間 |
| 言葉の区間・字幕 | 書き起こしの JSON（whisper.cpp の `-oj` / `-ojf`、OpenAI / faster-whisper の `segments`、単語の並び） | 単語ごとの時刻から、話している区間・言葉のない区間・字幕（行の幅・行の数・長さで区切る）を作る。`[BLANK_AUDIO]`・`[Music]`・`(音楽)`・`（拍手）` のように全体が括弧で囲まれたものと `♪` だけのものは言葉ではないので、区間と字幕から外して `nonSpeech` に入れる |

kernel（`azThumbKernel`、`azPowerKernel`）は `dispatch` で実行するので、ふつうのビルドでは CPU の複数のスレッドで、`UM_WGPU=1` のビルドでは GPU で動きます。どちらでも JSON は 1 バイトも違いません（`tests/analyze/run.mjs` の gpu で確かめます）。

書き起こしそのもの（Whisper）は外部のプロセスが要るので、ここでは行いません。たとえば whisper.cpp なら次のようにして JSON を作り、それを渡します。

```
ffmpeg -i media/talk.mp4 -ar 16000 -ac 1 -c:a pcm_s16le talk16k.wav
whisper-cli -m ggml-base.bin -f talk16k.wav -ojf -of talk     # talk.json（トークンごとの時刻つき）
```

**単語ごとの時刻が要ります。** `-oj` だけ（`-ojf` なし）や、`words` のない `segments` は区切り（文）ごとにしか時刻がないので、区切り全体を 1 つの単語として読み、`warnings` に書きます。字幕は作れます（長い区切りは空白で、それでも長ければ文字の境目で折り返し、時刻は文字の数で割り振る）が、言葉のない区間で切る（`speech-gap`）には区切りの間しか使えません。whisper.cpp なら `-ojf` か `-ml 1`、faster-whisper なら `word_timestamps=True` を使ってください。時刻が無限大・負・1000 万秒を超える単語は飛ばして `warnings` に書きます。

## コマンド

本体に組み込むまでは、試験用の入口 `src/azmain.um` をビルドして使います（組み込んだ後は `node tools/mozcut.mjs analyze ...`）。

```
node <UnifiedMozaic>/src/cli.ts build src/azmain.um --target host -o build/mozcut-analyze
```

```
analyze video   <file.y4m> [--scene-threshold 0.3] [--luma-threshold 0.12] [--min-gap 0.5]
                [--black-pixel 32] [--black-ratio 0.98] [--min-black 0.25]
                [--freeze-threshold 0.012] [--min-freeze 1] [--step 1] [--frames] [--json]
analyze audio   <file.pcm> [--rate 48000] [--channels 2] [--threshold -40] [--min 0.5] [--levels] [--json]
analyze words   <whisper.json> [--max-gap 0.5] [--json]
analyze subs    <whisper.json> [--offset 0] [--max-width 32] [--max-lines 2] [--max-dur 6] [--max-gap 0.8]
                [--min-dur 0.8] [--srt <out.srt>] [--json]
analyze suggest <project.mzc> <cache> [--no-scenes] [--no-silence] [--no-black] [--freeze] [--no-freeze]
                [--cut-no-audio] [--silence-from <clip>] [--threshold -40] [--min-silence 0.8] [--pad 0.15] [--min-cut 0.3]
                [--scene-threshold 0.3] [--luma-threshold 0.12] [--min-gap 0.5] [--min-black 0.25] [--min-freeze 1]
                [--transcript <clip>=<whisper.json>[@<秒>]]... [--speech-gap 1.0] [--subtitles] [--sub-track N]
                [--sub-style "y=-60 size=40"] [--ops <out.txt>] [--json]
```

- 時刻: `video` / `audio` / `words` / `subs` はファイルの始まりからの秒（`video` の JSON の `source` は `<file>.in` を足した素材の秒）。`suggest` はタイムラインの秒。
- シーンの切れ目の判定: 色の差 ≥ `--scene-threshold`、または（輝度の差 ≥ `--luma-threshold` かつ色の差 ≥ その半分）。`--min-gap` 秒より近い切れ目は強い方だけを残す。
- `--transcript` の時刻は素材の秒（素材のファイルをそのまま書き起こしたもの）。展開したキャッシュ（in から始まる）を書き起こしたときは `@<in の秒>` を付ける。
- 止まったコマは、静止画やタイトルの見せ場のこともあるので、`suggest` では `--freeze` を付けたときだけ切る提案にする（`--no-freeze` は `--freeze` を打ち消す）。
- Y4M は 8 ビットの 4:2:0（`C420` / `C420jpeg` / `C420mpeg2` / `C420paldv`、C がなければ 4:2:0）だけを読みます。`C420p10` などの高ビット深度や 4:2:2 / 4:4:4、読めないコマの速さ（`F0:0` など）は誤り（終了コード 1）です。
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
| `silence` | `cut <開始> <終わり>` | 音のクリップがかかっていて、どれも鳴っていない区間（`--silence-from` なら、そのクリップだけ）。前後に `--pad` 秒を残す。その間に映像だけのクリップ（文字・画像・色・音のない映像）があれば、理由に書いて score を 0.5 にする |
| `no-audio` | `cut` | 音のクリップが 1 つもかかっていない区間のうち、映像だけのクリップ（タイトル・静止画・B ロールなど）がある区間。見せたい場面のことが多いので **既定では出さず**、`--cut-no-audio` のときだけ出す（score 0.5） |
| `gap` | `cut` | クリップが何も置かれていない隙間 |
| `black` | `cut` | 黒いコマの区間。その間に音（語りや音楽）があれば「切ると音も消えます」と理由に書き、score を 0.5 にする |
| `freeze` | `cut` | 止まったコマの区間（`--freeze` のときだけ） |
| `speech-gap` | `cut` | 書き起こしで言葉のない区間（`--speech-gap` 秒以上） |
| `subtitle` | `add text "..." id=sub_<n> at=.. dur=.. track=..` | 書き起こしの字幕（クリップの範囲の中だけ。トラックは空いている上のトラック、`--sub-track` で指定）。ID は、いまある ID と、先に適用する split が作る ID（`<id>_2`、`_3` …）を避ける。.mzc の文字では「`\` の後ろに `n`」を書き表せない（改行になる）ので、その `\` だけは全角の `＼` にする |

cut の score は 1（そのまま切ってよさそう）か 0.5（音や映像も消えるので確かめる）です。重なる cut は 1 つにまとめます（kind は `black+silence` のように `+` でつなぎ、score は小さい方）。

無音の判定は、音のクリップごとに PCM の音量へ `20·log10(volume)` を足した大きさで行います（`volume=0.05` なら -26 dB なので、聞こえない小さな音は無音になる）。フェード（`afadein` / `afadeout`）と、複数のクリップを混ぜたときの足し算は考えません。

並べ方は、**この順に適用すればどこまで適用しても時刻とクリップの指し方がずれない** ようにしてあります: split（クリップの行の大きい順、同じクリップなら時刻の大きい順）→ add（時刻の順）→ cut（時刻の大きい順）。一部だけを選ぶときも、この順を保てば同じです。

JSON（`suggest --json`）:

```json
{"ok":true,"project":"p.mzc","applied":false,
 "proposals":[{"kind":"scene","op":"split clip_a 4","clip":"clip_a","start":4,"end":4,"score":3.0566,"reason":"clip_a の 4 秒で..."}, ...],
 "ops":["split clip_a 4", ...],"warnings":[],"opsFile":"ops.txt"}
```

## ファイル

| ファイル | 中身 |
| --- | --- |
| `src/effects/analyze/azcommon.um` | 区間（`AzSpan`）、数・時刻の書き方、JSON の文字列、log/exp、区間の整列・まとめ・補集合、Y4M のヘッダとコマの読み取り |
| `src/effects/analyze/video.um` | 縮小画像の kernel（と同じ計算の CPU 版 `azThumbCpu`）、ヒストグラムの差、シーン・黒・止まりの判定、JSON と文 |
| `src/effects/analyze/audio.um` | 窓ごとの 2 乗平均の kernel、無音の判定、JSON と文 |
| `src/effects/analyze/json.um` | 小さな JSON の読み取り（書き起こし用。UTF-8・`\uXXXX`・サロゲートの組） |
| `src/effects/analyze/transcript.um` | 書き起こしの読み取り（3 つの形）、話している区間、字幕（幅は全角を 2 と数える）、SRT |
| `src/effects/analyze/suggest.um` | 提案の列（`AzProposal`）、まとめと並べ方、`op --file` の形・JSON・文 |
| `src/effects/analyze/cli.um` | `azRun(引数)`（analyze のコマンド） |
| `src/azmain.um` | 試験用の入口（`azRun(args())`） |
| `tests/analyze/run.mjs` | テスト（node だけ。素材は node と ffmpeg で作る） |

名前はすべて `Az` / `az` / `AZ` で始まり、ほかの部品とぶつかりません。

## テスト

```
node tests/analyze/run.mjs            # 全部（ffmpeg がなければ ffmpeg の群を飛ばす）
node tests/analyze/run.mjs --no-engine   # エンジン（build/mozcut）での op --dry-run を飛ばす
UM_WGPU_HOME=<wgpu-native> node tests/analyze/run.mjs   # GPU（wgpu）でも CPU と同じ結果か
```

node で作った Y4M（場面の切り替え・黒・止まり、小さな被写体だけが動く映像）と PCM（音・無音・しきい値より小さい雑音）、ffmpeg の lavfi で作った映像と音、whisper.cpp と segments の形の書き起こし（`tests/analyze/*.json` と、テストの中で作る `-oj`・`[BLANK_AUDIO]`・壊れた時刻のもの）で、検出の時刻（映像は 1 コマ、音は 10 ミリ秒の窓の精度）と、提案の操作の文字列を確かめます。タイトルを挟むプロジェクト・`volume` を下げたクリップ・split と字幕の ID の組み合わせも確かめ、提案はエンジンの `op --dry-run` に通して、すべて適用できることも確かめます。1 時間ぶんの `audio --levels`（36 万窓）が 15 秒以内に終わること、GPU では 1280x720 の素材でも CPU と同じ JSON になることも確かめます。
