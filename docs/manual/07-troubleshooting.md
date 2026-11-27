# 7. 困ったとき

[目次](README.md) ／ 前: [6. AI と一緒に使う（MCP）](06-ai.md)

MozaicCut の誤りは、ほとんどが次の形で出ます。**まず「ヒント」を読んでください。** 直し方がそのまま書いてあることが多いです。

```text
ファイル:行:列: エラー[原因コード]: 理由
  ヒント: 直し方
```

- `エラー` は直すまで `preview` / `render` と［出力］の書き出しが止まるもの、`警告` は止まらないものです。`mozcut check` の終了コードは、エラーがなければ 0（警告だけなら 0）、あれば 1 です。
- `--json` を付けると、同じ中身を JSON で出します（`diagnostics` の 1 つずつに `code`、`severity`、`line`、`col`、`message`、`hint`、`suggest`）。AI のエージェントに渡すときはこちらです。
- 編集画面では、下の状態の帯の右に「エラー 1 · 警告 2」のように数が出ます。押すと、左の欄に「問題」の一覧が出ます（7.5）。

## 7.1 動かない・始まらない

| 出るもの | 原因 | 直し方 |
| --- | --- | --- |
| `mozcut: UnifiedMozaic のコンパイラが見つかりません。環境変数 UM_HOME にその場所を設定してください` | エンジンをビルドしたいのに UnifiedMozaic が見つからない | MozaicCut の隣に `UnifiedMozaic` を置くか、`UM_HOME` を設定する。配布の形（`MozaicCut.exe`・`mozcut.exe`）ならビルドは要らない |
| `ビルドに失敗しました（編集画面には SDL3 が要ります。README を見るか、UM_SDL3 を設定してください）` | 編集画面のビルドに SDL3 が見つからない | SDL3 を入れて `UM_SDL3` を設定する（[1.1](01-getting-started.md#11-開発用のフォルダで使うときに必要なもの)）。コマンドだけなら SDL3 は要らない |
| `mozcut: プロジェクトがありません: nofile.mzc` | `.mzc` のパスが違う | パスを確かめる（コマンドを実行したフォルダからの相対パス） |
| `mozcut: preview: ffmpeg を起動できません（spawn ffmpeg ENOENT）。ffmpeg を入れるか、FFMPEG / FFPROBE を設定してください` | `preview` で PNG を書くのに ffmpeg のコマンドがない | `-o shot.bmp` で BMP に書く。PNG が要るなら ffmpeg を PATH に置くか、`FFMPEG` に場所を設定する |
| 上と同じ「起動できません」が `render` で出る | FFmpeg の組み込みのない版で、ffmpeg / ffprobe が見つからない（[5.6](05-export.md#56-ffmpeg-の組み込みのない版)） | ffmpeg を PATH に置くか、`FFMPEG` / `FFPROBE` に場所を設定する |
| 状態の帯の右に `CPU` と出る（`GPU` でない） | GPU が使えない | そのまま動きます（描画を CPU で行うので遅くなります） |

## 7.2 書き出しで止まる

| 出るもの | 原因 | 直し方 |
| --- | --- | --- |
| `preview` / `render` が診断を出して止まる（終了コード 1） | プロジェクトに誤りがある | 出た診断を直す（7.3）。`mozcut check` で先に確かめられる |
| `mozcut: 範囲が空です（...）` （終了コード 2） | `--from` / `--to` の範囲が空か、全体の長さより後ろ | 範囲を確かめる（[5.3](05-export.md#53-動画を書き出すrender)） |
| `mozcut: 映像の符号器（h264）を開けません: ...` | H.264 の符号器を開けない（理由は「:」の後ろに出る） | 理由を読んで直す。［出力］の ProRes 422 HQ マスターは別の符号器で書くので、そちらは書き出せることがある |
| ［出力］の［書き出す］が押せない | 書き出しの前の確認にエラーがある、ファイル名に使えない字がある、目的を選んでいない | ボタンを指すと理由が出る。確認のボタン（［場所を指定する］［そのクリップへ移る］）で直す（[5.1](05-export.md#51-編集画面の出力から書き出す)） |
| 状態の帯に `書き出せませんでした · demo.mp4` | 書き出しの途中で失敗した | ［出力］の待ち行列の［詳細をコピーする］で理由を写せる。［そのクリップへ移る］で止まった所へ、直したら［やり直す］ |
| `この形式（〜）は、この版の MozaicCut だけでは書き出せません` | FFmpeg の組み込みのない版を、`mozcut edit` を通さずに開いた | `node tools/mozcut.mjs edit <project.mzc>` で開き直す（[5.6](05-export.md#56-ffmpeg-の組み込みのない版)） |

FFmpeg の組み込みのない版の `render` は、最後に ffmpeg のコマンドの libx264 で MP4 にします。libx264 の入っていない ffmpeg（LGPL 版のビルドなど）では、ここで止まります。

```text
mozcut: encode: C:/ffmpeg-lgpl/bin/ffmpeg.exe が失敗しました（終了コード ...）
[vost#0:0 @ ...] Unknown encoder 'libx264'
...
Error opening output files: Encoder not found
```

libx264 の入った ffmpeg を `FFMPEG` に設定してください（`ffmpeg -encoders` に `libx264` があるか確かめられます）。組み込みの FFmpeg のある版は libx264 を使わないので、この誤りは出ません。

## 7.3 よくある診断

| code | よくある原因 | 直し方 |
| --- | --- | --- |
| `unknown-key` | キーの綴りの誤り（`colr=`） | ヒントの「〜のことですか？」に直す（`op renamekey` でも） |
| `key-not-allowed` | 正しいキーを、使えない行に書いた（audio に `blur=`、image に `in=`） | 行を変えるか、消す。使える行はヒントと `mozcut schema` の「使える行」 |
| `missing-source` | 素材のファイルが見つからない | ヒントの「探した場所」を見てパスを直す（`.mzc` のフォルダからの相対パスか絶対パス） |
| `unreadable-source` | 素材のファイルはあるが読めない（壊れている、書きかけ、動画・画像・音でない） | ファイルを作り直すか、別のファイルにする |
| `out-of-range` | 範囲の外の値（`size=3`）、素材の長さを超える `out=` | ヒントの範囲に収める |
| `empty-clip` | 長さが 0 以下（`in=3 out=2`） | `out` を `in` より後ろに、`dur` を 0 より大きく |
| `no-video-stream` / `no-audio-stream` | 音だけの素材を `video` に書いた など | 音だけなら `audio` の行に書く |
| `unknown-length` | 素材を調べられず、長さが分からない | `dur=` か `out=` を書く。素材が読めるか確かめる |
| `unknown-ref` | `at=` の参照先の ID がない | 参照先の `id=` を確かめる |
| `ref-cycle` | 参照が輪になった（a が b を、b が a を参照） | どれかの `at=` を秒の数にする |
| `duplicate-id` / `bad-id` | ID が重なった、ID に使えない字 | ファイルの中で 1 つだけにする。英字・数字・`_`・`-`、先頭は英字か `_` |
| `syntax` | `"` が閉じていない | 同じ行の中で `"` を閉じる。`"` そのものは `\"` |
| `bad-color` | 色として読めない値（`color=zzz`） | `ff8000`・`#ff800080` か、`white` / `black` / `red` などの名前で書く |
| `anim-syntax` | キーフレームの書き方の誤り（`x="0@0 100"` の `@` がない） | キーは `値@時刻` で書く（`x="0@0 100@1"`） |
| `expr-unknown-name` | 式（`expr(...)`）の中の知らない名前 | ヒントに出る使える名前にする（`mozcut schema` の expressions） |
| `matte-missing` | `matte.type` / `matte.invert` だけを書いた | `matte=<マットに使うクリップの ID>` も書く |
| `bad-project` | 画面の大きさが奇数、fps の誤り | 大きさは 16〜8192 の偶数、fps は `30` / `29.97` / `30000/1001`（1〜240） |
| `empty-timeline` | クリップが 1 つもない | クリップの行を足す |
| `font-not-found`（警告） | `font=` のファイルがない、またはフォントとして読めない | パスを直す（`.mzc` のフォルダからの相対パスか絶対パス）。直すまでは既定のフォントで描く |
| `glyph-missing`（警告） | 文字が、描くフォントにない（絵文字など）。□ で描かれる | その字のあるフォントを `font=` で選ぶか、字を書き換える |
| `bad-escape`（警告） | 文字の中の知らない `\x` | `\` そのものは `\\` と書く |

ほかの code も、ヒントに直し方が書いてあります。

実際の出力の例です（`bad.mzc` は次の 5 行）。

```sh
project size=1280x720
color 202040 id=bg dur=2
video "media/nothere.mp4"
video "media/clip_a.mp4" out=99
text "x" id=bg
```

```console
$ mozcut check bad.mzc
bad.mzc:3: エラー[missing-source]: 素材が見つかりません: media/nothere.mp4
  ヒント: media/nothere.mp4 を探しました。素材のパスを確かめます（.mzc のあるフォルダからの相対パスか、絶対パス）
bad.mzc:4: エラー[out-of-range]: 素材 'media/clip_a.mp4'（6 秒）の終わりより後ろを使っています（out で 99 秒まで）
  ヒント: out を短くします（in + 長さ × speed が 6 秒以下になるように）
bad.mzc:5:13: エラー[duplicate-id]: ID 'bg' は 2 行目でも使っています
  ヒント: ID はファイルの中で 1 つだけにします
エラー 3 個
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
  ヒント: 4〜2048 の範囲で書きます
e2.mzc:5: エラー[empty-clip]: クリップの長さが 0 以下です
  ヒント: out は in より後ろにし、dur は 0 より大きくします（素材より長い in にも注意）
e2.mzc:6:24: エラー[key-not-allowed]: 'in' は image の行では使えません
  ヒント: video / audio / comp / text / shape / particles の行で使います
エラー 4 個
```

```sh
project size=1280x720
color red dur=2 colr=blue
text "ok 🎉 ✓" dur=1
video "media/broken.mp4" dur=1
text "x" dur=1 x="0@0 100"
text "y" dur=1 color=zzz
```

```console
$ mozcut check e3.mzc
e3.mzc:2:17: エラー[unknown-key]: 'colr' というキーはありません
  ヒント: 'color' のことですか？
e3.mzc:4: エラー[unreadable-source]: 素材を読めません: media/broken.mp4（media/broken.mp4: Invalid data found when processing input (mov,mp4,m4a,3gp,3g2,mj2: moov atom not found)）
  ヒント: ファイルが壊れていないか（書きかけ・途中で切れたファイルなど）、動画・画像・音のファイルかを確かめます
e3.mzc:5:23: エラー[anim-syntax]: キー '100' に @ がありません
  ヒント: キーは 値@時刻 で書きます（例: 120@1.5）。値だけなら @ のない key=value にします
e3.mzc:6:22: エラー[bad-color]: 'color' の値 'zzz' は色として読めません
  ヒント: rrggbb か rrggbbaa（ff8000、#ff800080）か、white / black / red / green / blue / yellow / gray / transparent で書きます
e3.mzc:3: 警告[glyph-missing]: フォント '既定のフォント' にない字があります: '🎉'（U+1F389）（□ で描きます）
  ヒント: その字のあるフォントを font= で指定するか、字を書き換えます（例: 絵文字は font="C:/Windows/Fonts/seguiemj.ttf"）
エラー 4 個、警告 1 個
```

警告だけなら、`check` は「問題はありません」と出し、終了コードは 0 です。

```sh
project font="nofont.ttf"
color red dur=1
text "a\qb" dur=1
```

```console
$ mozcut check warn.mzc
warn.mzc:1:14: 警告[font-not-found]: フォント 'nofont.ttf' が見つかりません（既定のフォントで描きます）
  ヒント: nofont.ttf を探しました。フォントのファイルのパスを確かめます（.mzc のあるフォルダからの相対パスか、絶対パス。例: font="C:/Windows/Fonts/YuGothM.ttc"）
warn.mzc:3:8: 警告[bad-escape]: '\q' というエスケープはありません（\ を外して読みました）
  ヒント: \ そのものは \\ と書きます（\n は改行、\t はタブ、\" は "）
問題はありません（クリップ 2 個、長さ 0:01.000）
```

`--json` では、1 つの診断が次の形になります（`check e3.mzc --json` の `diagnostics` の 1 つめ）。

```json
{"code":"unknown-key","severity":"error","line":2,"col":17,"message":"'colr' というキーはありません","hint":"'color' のことですか？","suggest":"color"}
```

操作（`op`）だけの code:

| code | 意味 | 直し方 |
| --- | --- | --- |
| `unknown-op` | 知らない操作の名前 | ヒントの候補か、`mozcut schema` の操作の一覧から選ぶ |
| `unknown-clip` | 指したクリップがない | ヒントの候補か、`mozcut show` の ID・`#番号`・`@行番号` で指し直す |
| `referenced` | 消すクリップが、ほかの `at=` から参照されている | `delete <クリップ> fix-refs`（[2.7](02-editing.md#27-消す)） |
| `bad-args` | 引数の数や形の誤り（`set opening gray` など） | ヒントの例の形にする（`set opening gray=1`） |
| `not-applied` | まとめて適用したうちの別の操作が失敗した | 失敗した操作を直して、まとめてやり直す |

## 7.4 見た目がおかしい

| 起きること | 原因 | 直し方 |
| --- | --- | --- |
| 文字がとても小さい | `size` は画素。古いファイルの `size=12` は 12 画素 | 720p なら見出し 64〜120、字幕 26〜40 くらい |
| 文字が □ になる | フォントにない字（絵文字など）。`check` が警告 `glyph-missing` を出す | その字のあるフォントを `font=` で選ぶ（別のフォントで補うのは準備中） |
| `font=` を書いたのに既定のフォントで描かれる | フォントが見つからないか読めない。`check` が警告 `font-not-found` を出す | ヒントの探した場所を見てパスを直す。相対パスは `.mzc` のあるフォルダから |
| 文字が出ない・画面の外 | `x` / `y` の負の数は右端・下端からの距離 | `preview` で見て直す |
| 重なりの順が逆 | トラック番号が大きいほど手前 | `track=` を変える |
| 全体が思ったより長い | `dur=` のない音や動画が、素材の終わりまで使われている | `dur=` か `out=` を書く（[1.5](01-getting-started.md#15-プロジェクトを作る)） |
| 消したら後ろが詰まった | `at=` のない後ろのクリップは、前の行の後ろに並ぶ | 隙間を残すなら、後ろのクリップを先に `move` で秒の数に置く |
| 画面全体に効果が掛からない | クリップの行の効果は、そのクリップにだけ掛かる | project の行に書く（[4.4](04-effects.md#46-画面全体に掛ける)） |
| 背景だけが描かれる | 全体の長さより後ろの時刻を `preview` した | 時刻を確かめる（警告が出ています） |
| 書き出した動画に黒い帯が付いた | プロジェクトと［出力］のプリセットの縦横比が違う | 書き出しの前の確認の［〜にする］でプリセットを変えるか、project の `size=` をプリセットに合わせる（[5.1](05-export.md#51-編集画面の出力から書き出す)） |

## 7.5 編集画面で

| 起きること | 原因 | 直し方 |
| --- | --- | --- |
| 状態の帯に「エラー 1 · 警告 0」と出ている | `.mzc` に誤りがある | 押すと左の欄に「問題」の一覧が出る。行を押すとそのクリップを選び、直せるものは直すボタン（［'color' に直す］など）が出る |
| 素材が見つからない | 素材のファイルを動かした・消した・名前を変えた | 「問題」の一覧で［素材の場所を指定…］を押し、ファイルを選ぶ。元の場所に戻してもよい |
| テキストエディタで直したのに画面が古いまま | 誤りがあると、直るまで前の状態を表示する | 「問題」の一覧か `mozcut check` で誤りを見て直す |
| Ctrl+Z で、外で書き換えた分が戻った | ほかのエディタや AI のエージェントが `.mzc` を書き換えると、それも取り消しの 1 つになる | Ctrl+Shift+Z でやり直す（[2.8](02-editing.md#28-取り消しとやり直し)） |
| 動作が重い | 再生の画質が高い、GPU が使えない | モニターの右上の「画質」を下げる（書き出す動画の画質は変わりません）。状態の帯に `CPU` と出ていれば 7.1 |
| 更新の知らせが出ない | 設定で「更新を確かめる」を止めている、開発用のビルド（自動では更新しません） | 設定の欄の「更新を確かめる」を確かめる。メニューの［ヘルプ］→［更新を確かめる］ですぐ確かめられる |
| `更新できませんでした: ...` / `更新を確かめられませんでした（...）` | ネットにつながらない、落としたファイルが壊れていた など | 時間をおいて、［ヘルプ］→［更新を確かめる］でやり直す |

`glyph-missing`（フォントにない字）は `check` だけが調べます。編集画面の「問題」には出ないので、□ が見えたら `mozcut check` で確かめてください。

## 7.6 それでも分からないとき

- `mozcut check <project.mzc> --json` の出力と `.mzc` を AI のエージェントに見せると、`hint` と `suggest` を使って直し方を提案できます（[6](06-ai.md)）。
- コマンドの使い方は `mozcut help`、書き方は `mozcut schema` で、いつでもこの版の正確な一覧が見られます。
