# 7. 困ったとき

[目次](README.md) ／ 前: [6. AI と一緒に使う（MCP）](06-ai.md)

MozaicCut の誤りは、ほとんどが次の形で出ます。**まず「ヒント」を読んでください。** 直し方がそのまま書いてあることが多いです。

```text
ファイル:行:列: エラー[原因コード]: 理由
  ヒント: 直し方
```

- `エラー` は直すまで `preview` / `render` が止まるもの、`警告` は止まらないもの（終了コードにも数えない）です。
- `--json` を付けると、同じ中身を JSON で出します（`code`、`line`、`col`、`hint`、`suggest`）。AI のエージェントに渡すときはこちらです。
- 編集画面では、誤りを下の帯に `ファイル:行:列 エラー[code] 理由 ／ ヒント` の形で出し、直るまで前の状態を表示します。

## 7.1 動かない・始まらない

| 出るもの | 原因 | 直し方 |
| --- | --- | --- |
| `mozcut: UnifiedMozaic のコンパイラが見つかりません。環境変数 UM_HOME にその場所を設定してください` | エンジンをビルドしたいのに UnifiedMozaic が見つからない | MozaicCut の隣に `UnifiedMozaic` を置くか、`UM_HOME` を設定する |
| `mozcut: ... ffprobe.exe を起動できません（spawnSync ... ENOENT）。ffmpeg を入れるか、FFPROBE を設定してください` | ffmpeg / ffprobe が見つからない | PATH に置くか、`FFMPEG` / `FFPROBE` に場所を設定する |
| `ビルドに失敗しました（編集画面には SDL3 が要ります。README を見るか、UM_SDL3 を設定してください）` | 編集画面のビルドに SDL3 が見つからない | SDL3 を入れて `UM_SDL3` を設定する（[1.1](01-getting-started.md#11-必要なもの)）。コマンドだけなら SDL3 は要らない |
| `mozcut: プロジェクトがありません: nofile.mzc` | `.mzc` のパスが違う | パスを確かめる（コマンドを実行したフォルダからの相対パス） |

## 7.2 書き出しで止まる

ffmpeg に H.264 のエンコーダ（libx264）が入っていないと、書き出しの最後で止まります。

```console
$ mozcut render first.mzc
...
mozcut: encode: C:/ffmpeg-lgpl/bin/ffmpeg.exe が失敗しました（終了コード 3165764104）
[vost#0:0 @ 00000246aec4c080] Unknown encoder 'libx264'
[vost#0:0 @ 00000246aec4c080] Error selecting an encoder
...
Error opening output files: Encoder not found
```

LGPL 版の ffmpeg のビルドには libx264 が入っていません。libx264 の入った ffmpeg を `FFMPEG` に設定してください（`ffmpeg -encoders` に `libx264` があるか確かめられます）。`preview` と、素材の展開は libx264 がなくても動きます。

## 7.3 よくある診断

| code | よくある原因 | 直し方 |
| --- | --- | --- |
| `unknown-key` | キーの綴りの誤り（`colr=`） | ヒントの「〜のことですか？」に直す（`op renamekey` でも） |
| `key-not-allowed` | 正しいキーを、使えない行に書いた（audio に `blur=`、image に `in=`） | 行を変えるか、消す。使える行はヒントと `mozcut schema` の「使える行」 |
| `missing-source` | 素材のファイルが見つからない | ヒントの「探した場所」を見てパスを直す（`.mzc` のフォルダからの相対パスか絶対パス） |
| `out-of-range` | 範囲の外の値（`blur=999`、`size=3`）、素材の長さを超える `out=` | ヒントの範囲に収める |
| `empty-clip` | 長さが 0 以下（`in=3 out=2`） | `out` を `in` より後ろに、`dur` を 0 より大きく |
| `no-video-stream` / `no-audio-stream` | 音だけの素材を `video` に書いた など | 音だけなら `audio` の行に書く |
| `unknown-length` | 素材を ffprobe で調べられず、長さが分からない | `dur=` か `out=` を書く。素材を ffprobe で読めるか確かめる |
| `unknown-ref` | `at=` の参照先の ID がない | 参照先の `id=` を確かめる |
| `ref-cycle` | 参照が輪になった（a が b を、b が a を参照） | どれかの `at=` を秒の数にする |
| `duplicate-id` / `bad-id` | ID が重なった、ID に使えない字 | ファイルの中で 1 つだけにする。英字・数字・`_`・`-`、先頭は英字か `_` |
| `syntax` | `"` が閉じていない | 同じ行の中で `"` を閉じる。`"` そのものは `\"` |
| `bad-project` | 画面の大きさが奇数、fps の誤り | 大きさは 16〜8192 の偶数、fps は `30` / `29.97` / `30000/1001` |
| `empty-timeline` | クリップが 1 つもない | クリップの行を足す |
| `font-not-found`（警告） | `font=` のファイルがない | パスを直す（直すまでは既定のフォントで描く） |
| `bad-escape`（警告） | 文字の中の知らない `\x` | `\` そのものは `\\` と書く |

実際の出力の例（`bad.mzc` は 7〜9 行目に次の 3 行を書いたもの。出力はその 3 行の分だけを抜き出しています）:

```sh
video "media/nothere.mp4"
video "media/clip_a.mp4" out=99
text "x" id=bg
```

```console
$ mozcut check bad.mzc
bad.mzc:7: エラー[missing-source]: 素材が見つかりません: media/nothere.mp4
  ヒント: C:\Users\you\Videos\myvideo\media\nothere.mp4 を探しました。素材のパスを確かめます（.mzc のあるフォルダからの相対パスか、絶対パス）
bad.mzc:8: エラー[out-of-range]: 素材 'media/clip_a.mp4'（6 秒）の終わりより後ろを使っています（out で 99 秒まで）
  ヒント: out を短くします（in + 長さが 6 秒以下になるように）
bad.mzc:9:13: エラー[duplicate-id]: ID 'bg' は 2 行目でも使っています
  ヒント: ID はファイルの中で 1 つだけにします
```

```sh
project size=1280x720
color red id=a at=b.end dur=1
color blue id=b at=a.end dur=1
text "x" size=3
video "media/clip_a.mp4" in=3 out=2
image "media/logo.png" in=1
```

```console
$ mozcut check e2.mzc
e2.mzc:2:19: エラー[ref-cycle]: 参照が輪になっています: a → b → a
  ヒント: どれかの at= を時間にするか、参照先を変えます
e2.mzc:4:15: エラー[out-of-range]: 'size' の値 3 は範囲の外です
  ヒント: 4〜1000 の範囲で書きます
e2.mzc:5: エラー[empty-clip]: クリップの長さが 0 以下です
  ヒント: out は in より後ろにし、dur は 0 より大きくします（素材より長い in にも注意）
e2.mzc:6:24: エラー[key-not-allowed]: 'in' は image の行では使えません
  ヒント: video / audio の行で使います
エラー 4 個
```

```sh
project font="nofont.ttf"
color red dur=1
text "a\qb" dur=1
```

```console
$ mozcut check warn.mzc
warn.mzc:1:14: 警告[font-not-found]: フォント 'nofont.ttf' が見つかりません（既定のフォントで描きます）
  ヒント: フォントのファイルのパスを確かめます（例: font="C:/Windows/Fonts/YuGothM.ttc"）
warn.mzc:3:8: 警告[bad-escape]: '\q' というエスケープはありません（\ を外して読みました）
  ヒント: \ そのものは \\ と書きます（\n は改行、\t はタブ、\" は "）
問題はありません（クリップ 2 個、長さ 0:01.000）
```

操作（`op`）だけの code:

| code | 意味 | 直し方 |
| --- | --- | --- |
| `unknown-op` | 知らない操作の名前 | ヒントの候補か、`mozcut schema` の操作の一覧から選ぶ |
| `unknown-clip` | 指したクリップがない | ヒントの候補か、`mozcut show` の ID・`#番号`・行で指し直す |
| `referenced` | 消すクリップが、ほかの `at=` から参照されている | `delete <クリップ> fix-refs`（[2.7](02-editing.md#27-消す)） |
| `bad-args` | 引数の数や形の誤り（`set opening gray` など） | ヒントの例の形にする（`set opening gray=1`） |
| `not-applied` | まとめて適用したうちの別の操作が失敗した | 失敗した操作を直して、まとめてやり直す |

## 7.4 見た目がおかしい

| 起きること | 原因 | 直し方 |
| --- | --- | --- |
| 文字がとても小さい | `size` は画素。古いファイルの `size=12` は 12 画素 | 720p なら見出し 64〜120、字幕 26〜40 くらい |
| 文字が □ になる | フォントにない字（絵文字など） | その字のあるフォントを `font=` で選ぶ（別のフォントで補うのは準備中） |
| 文字が出ない・画面の外 | `x` / `y` の負の数は右端・下端からの距離 | `preview` で見て直す |
| 重なりの順が逆 | トラック番号が大きいほど手前 | `track=` を変える |
| 全体が思ったより長い | `dur=` のない音や動画が、素材の終わりまで使われている | `dur=` か `out=` を書く（[1.5](01-getting-started.md#15-プロジェクトを作る)） |
| 消したら後ろが詰まった | `at=` のない後ろのクリップは、前の行の後ろに並ぶ | 隙間を残すなら、後ろのクリップを先に `move` で秒の数に置く |
| 画面全体に効果が掛からない | クリップの行の効果は、そのクリップにだけ掛かる | project の行に書く（[4.4](04-effects.md#44-画面全体に掛ける)） |
| 背景だけが描かれる | 全体の長さより後ろの時刻を `preview` した | 時刻を確かめる（警告が出ています） |

## 7.5 編集画面で

| 起きること | 原因 | 直し方 |
| --- | --- | --- |
| プレビューの上に橙の枠「素材が展開されていません」、クリップに橙の縁 | スタート画面から開いた（素材を展開しない） | 閉じて、枠に出るコマンド（`node tools/mozcut.mjs edit <project.mzc>`）で開き直す |
| プレビューの上に黄色の 1 行「素材 N 個（クリップ M 個）を展開しています…」、クリップに黄色の縁 | `mozcut edit` が裏で素材を展開している（クリップを分けた・並びを変えた後など） | 展開が済むまで待つ。済むまでは古い展開からずらして表示する |
| プレビューの上に赤い枠「素材のファイルが見つかりません」、クリップに赤い縁 | 素材のファイルを動かした・消した | ファイルを戻すか、`src=` を書き直す（枠に探したパスが出る） |
| 音が出ない | 編集画面での音の再生は準備中 | 書き出した動画で確かめる |
| テキストエディタで直したのに画面が古いまま | 誤りがあると、直るまで前の状態を表示する | 下の帯の誤りを直す（`mozcut check` でも見られる） |
| Ctrl+Z で、外で書き換えた分まで戻った | 取り消しはファイル全体を操作の前の中身に戻す | 外で書き換えた後は Ctrl+Z を使わない（[2.8](02-editing.md#28-取り消しとやり直し)） |

## 7.6 それでも分からないとき

- `mozcut check <project.mzc> --json` の出力と `.mzc` を AI のエージェントに見せると、`hint` と `suggest` を使って直し方を提案できます（[6](06-ai.md)）。
- コマンドの使い方は `mozcut help`、書き方は `mozcut schema` で、いつでもこの版の正確な一覧が見られます。
