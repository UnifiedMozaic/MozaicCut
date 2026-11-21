# AI のエージェント向けの手引き

MozaicCut のプロジェクト（`.mzc`）を、AI のエージェントが読み書きするときの手順です。人向けの説明は [README.md](../README.md)、内部の約束ごとは [design/architecture.md](design/architecture.md) にあります。

以下、`mozcut` は `node tools/mozcut.mjs`（MozaicCut のフォルダから実行）の略です。

## 1. 最初に読むもの

```sh
mozcut schema --json            # 使えるキー・効果（プラグイン）・操作・時刻と参照の書き方
mozcut check project.mzc --json # 今のプロジェクトの配置と誤り
```

- `schema --json` は `{"version":2,"keys":[...],"effects":[...],"effectsNote":"...","ops":[...],"syntax":[...]}`。
  - `keys[i]`: `name`、`kinds`（使える行の配列）、`type`（`time` / `number` / `int` / `color` / `pos` / `string` / `enum` / `flag`）、enum なら `values`、`default`（数の型なら数か null。`size/14` のような式は `defaultExpr`）、別名なら `aliasOf`、`min`、`max`、`doc`。**同じ `name` が行の種類ごとに別の項目で出ます**（`out` は video / audio では素材の使い終わり、project では `aliasOf:"output"`）。辞書にするなら (name, kinds) を鍵にします。
  - `effects[i]`: `name`、`doc`、`kinds`（書ける行）、`aliases`、`params[{name,key,default,min,max,doc}]`。`key` がそのまま `.mzc` に書くキーです（`vignette` / `vignette.radius`）。クリップの行の効果はそのクリップにだけ、project の行の効果は合成した画面全体に掛かります。
  - `ops[i]`: 操作の `name`、`usage`、`doc`、`example`。`syntax`: 時刻・参照・クリップの指し方の説明。
  - 効果はプラグインで増えるので、名前や範囲を覚え込まず、毎回 schema を読んでください。
- `check --json` は `{"ok":..,"project":{...},"clips":[...],"diagnostics":[...]}`。
  - `ok` は error の診断が 0 個か（warning は数えない）。
  - `clips[i]`: `index`（`#番号`）、`id`（なければ `null`）、`line`（行番号）、`kind`、`track`、`trackKind`（`"video"` / `"audio"`。映像と音でトラック番号は別）、`start` / `end` / `duration`（秒の数。配置した後の実際の時刻）、`in`、`src`、`text`、`at`（書いたままの値。参照なら `"clip_a.start+1"`、省けば `null`）、`placed`（`false` なら誤りのため仮の位置）、`keys`（行に書いた key=value。位置・大きさ・色などを読める）、`effects[{name,params}]`。
  - `mix[i]`（`track` の行があるときだけ。`clips` と `diagnostics` の間）: `audio`（音のトラックの番号か `"master"`）、`line`、`name`（なければ `null`）、`vol`（dB。`null` は −∞）、`pan`、`mute`、`solo`、`eq`（`eq=` に書く形。なければ `""`）、`eqOff`、`comp`（`しきい値:比:アタック:リリース:ニー:メイクアップ`。なければ `null`）、`compOff`。`mix` の操作で変える前に、いまの値をここで読みます。
  - 参照で付いて動くクリップは、`at` が参照のものです。`at` が `null` のクリップは同じトラックの前の行の後ろに並ぶので、前のクリップを消したり縮めたりすると詰まります。
  - `diagnostics` が空なら誤りはありません。終了コードは 0（誤りなし）/ 1（誤りあり・読めない）/ 2（使い方の誤り）。
  - ファイルがないなど、始める前に止まったときも `{"ok":false,"error":"..."}` が出ます。
- 人が見る形で確かめたいときは `mozcut show project.mzc`（タイムラインの図と一覧）。

`.mzc` を直接読んでもかまいません。1 行に 1 クリップ、`種類 ["素材" / "文字" / 色] key=value ...`、`#` 以降は注釈です。

## 2. クリップの指し方

| 書き方 | 意味 | 使いどころ |
| --- | --- | --- |
| `clip_b` | ID（`id=clip_b`） | **いちばん安定。** 行を足したり消したりしてもずれない |
| `#3` | 0 から数えた番号（`clips[i].index`） | ID がないとき。操作で行が増えるとずれる |
| `@9` | 行番号（`clips[i].line`） | ID がないとき。操作で行が増えるとずれる |

- ID のないクリップを何度も触るなら、先に `set @9 id=opening` で ID を付けると楽です。
- `at=` の参照（`at=clip_a.end`、`at=clip_a.start+1.5`、`at=clip_a.end-0.5`、`at=after:clip_a`）で並べておくと、参照先を動かしたときに一緒に動きます。

## 3. 操作の手順: --dry-run → 確かめる → 実行

`.mzc` を自分で書き換えるより、`op` を使ってください。該当する行だけを書き換え、注釈や並びを残し、**誤りが増える操作は何も書かずに断ります**。

```sh
# 1. 試す（保存しない）
mozcut op project.mzc move clip_b 5.5 --dry-run --json
# 2. results[].changes の before / after と desc を見て、意図どおりか確かめる
# 3. 実行する
mozcut op project.mzc move clip_b 5.5 --json
```

いくつもの操作は 1 つのバッチにまとめます（全部成功したときだけ保存。1 つでも失敗すれば何も書かない）。

```sh
mozcut op project.mzc --file - --dry-run --json <<'EOF'
split clip_b 7
set clip_b_2 sat=0.5 blur=1
add text "つづく" at=clip_b_2.start dur=2 size=64 after clip_b_2
EOF
```

- 操作の一覧: `move <clip> <時刻か参照>`、`trim <clip> start|end <時刻>`、`split <clip> <時刻>`、`delete <clip> [fix-refs]`、`cut <開始> <終わり>`、`set <clip> key=value ...`、`unset <clip> key ...`、`renamekey <clip> <古いキー> <新しいキー>`、`add <種類> [素材/文字/色] key=value ... [after <clip>]`、`rename <clip> <新しい ID>`、`mix <音のトラックの番号|master> key=value ...`（`schema --json` の `ops` にもあります）。
- 時刻はタイムライン上の秒（`5.5`）か `分:秒`（`1:02.5`）。`trim` と `split` もタイムライン上の時刻です（素材の中の時刻ではありません）。
- 「最初の 3 秒を切る」のような範囲の削除は `cut 0 3` を使います。全トラックから範囲を切り取って後ろを詰め、範囲にかかるクリップは短くします。
- `split clip_b 7` の後半は `clip_b_2` になります。`add` で `id` を書かなければ `text1` のように付き、`results[].newId` に返ります。
- `delete` は行を `# ` で注釈にします。ほかのクリップの `at=` から参照されていると `referenced` で止まります（`delete <clip> fix-refs` なら参照を今の秒に書き換えてから消します）。`at=` のない後ろのクリップは前へ詰まります。
- 操作でほかのクリップの時刻も変わったときは、`results[].moved` に `{id,line,before:{start,end},after:{start,end}}` が並びます。意図しない動きがないか確かめてください。
- 映像・音に `set <clip> dur=...` をすると `out=` を消します（両方あると `out=` が勝つため）。
- 書き間違えたキーは `renamekey <clip> <古い> <新しい>` で直すと、効果の掛ける順が変わりません。
- 音のトラックの音量・パン・ミュート・ソロ・EQ・コンプは `track` の行（`track audio=0 vol=-6 pan=-0.2 eq=highpass:80 comp=-20:3`）で、`mix 0 vol=-6`・`mix 1 mute=1`・`mix master vol=-1` で変えます。クリップの `volume=` は倍率、`track` の行の `vol` は dB です。
- 色の調整は video / image の行の `grade.*`（README の「色の調整」）。`set clip_b grade.lift="0.02 0 -0.01 0" grade.curve.y="0:0 0.5:0.6 1:1"`、戻すときは `unset clip_b grade.lift`。名前は src/color/grade.um の `colGradeSet` と同じです（`grade.reset` は書けません）。
- 値に空白を含むときは `"..."` で囲みます。文字の値（`text=`、`add text "..."`）の中の `\n` は改行になります。
- `--json` の形: `{"ok":true,"saved":false,"results":[{"op":"move","ok":true,"code":"","desc":"clip_b を 5 秒から 5.5 秒に動かしました","error":"","hint":"","suggest":"","newId":"","changes":[{"kind":"edit","line":9,"before":"...","after":"..."}],"moved":[],"newDiagnostics":[]}],"diagnostics":[]}`。
  - `saved` が true なら保存しました。`--dry-run` なら必ず false。
  - `changes[].kind` は `edit` / `insert` / `comment`、`line` は変更後の行番号。
  - 失敗したら `ok:false`、終了コード 1。失敗した操作に `code` / `error` / `hint` が入ります。同じバッチの前の操作は `code:"not-applied"` になります。
  - `suggest` は hint で推した候補（`"vignette"`、`"clip_b"`、`"move"`）。そのまま使って直せます。
  - 誤りが増えて止めたときは、その診断が `newDiagnostics`（`line` / `col` / `code` / `suggest`）にも入ります。

## 4. 診断と操作の code と直し方

診断は `{"code","severity","line","col","message","hint","suggest"}` です。`hint` に直し方がそのまま書いてあることが多いので、まず `hint` を読んでください。`suggest` は推した候補（なければ `null`）。`severity` が `"warning"` のもの（`bad-escape`、`font-not-found`）は、終了コードや op の判断には数えません。

| code | 意味 | 直し方 |
| --- | --- | --- |
| `syntax` | 閉じていない `"`、`=` の前にキーがない | `"` を同じ行で閉じる。`"` そのものは `\"` |
| `unknown-type` | 行の先頭の種類が違う | project / video / image / text / color / audio のどれかにする |
| `unknown-key` | 知らないキー（綴りの誤り） | `suggest` か hint の「〜のことですか？」に直す（`renamekey` で） |
| `key-not-allowed` | キーは正しいが、その行では使えない | 行を変えるか、消す。使える行は schema の `kinds` と hint。効果は audio の行に書けない |
| `unexpected-value` | key=value でない余分な語 | 消すか `key=value` にする |
| `bad-number` / `bad-time` / `bad-color` / `bad-enum` | 値の形が違う | 時間は `12.5` か `1:02.5` か参照（分・秒の欄は 60 未満）。色は `rrggbb` / `rrggbbaa`。enum は schema の `values` |
| `bad-grade` | 色の調整（`grade.*`）の値の誤り | msg の理由に従う（ガンマ・ゲインは 0 より大きく、カーブは点を 2 つ以上、色温度は 1667〜25000） |
| `out-of-range` | 範囲の外（負の時間、参照から求めた開始が負、素材の長さを超える `out` / `dur` も） | schema の `min` / `max` に収める。素材の長さは超えない |
| `missing-source` | 素材のファイルの指定がない、またはファイルが見つからない | `video "media/a.mp4"` のように書く。hint の「探した場所」を見てパスを直す |
| `no-video-stream` / `no-audio-stream` | 素材に映像・音がない | 種類を `audio` にする、素材を替える |
| `unknown-length` | 長さが分からない（素材を ffprobe で調べられなかった） | `dur=` か `out=` を書く。素材を ffprobe で読めるか確かめる |
| `empty-clip` | 長さが 0 以下 | `in` < `out`、`dur` > 0 にする |
| `bad-project` | project の大きさ・fps・rate の誤り | 大きさは偶数、fps は `30` / `29.97` / `30000/1001` |
| `empty-timeline` | クリップが 1 つもない | クリップを足す |
| `bad-id` / `duplicate-id` | ID の形の誤り、重複 | 英字・数字・`_`・`-`、先頭は英字か `_`。ファイルの中で 1 つだけ |
| `unknown-ref` / `ref-cycle` | 参照先がない、参照が輪 | 参照先の ID を直す。輪の 1 つを秒の数にする（`at=` のないクリップは前の行を暗に参照している） |
| `bad-escape` | （warning）文字の中の知らない `\x` | `\` そのものは `\\` と書く |
| `font-not-found` | （warning）`font=` のファイルがない | パスを直す（既定のフォントで描かれる） |

操作だけの code:

| code | 意味 | 直し方 |
| --- | --- | --- |
| `unknown-op` | 知らない操作 | `suggest` か、上の操作の一覧から選ぶ |
| `unknown-clip` | 指したクリップがない | `suggest` か、`check --json` の `clips` の `id` / `index` / `line` で指し直す |
| `referenced` | `delete` するクリップが参照されている | 参照しているクリップを先に動かす・消すか、`delete <clip> fix-refs` |
| `bad-args` | 引数の数や形の誤り | hint の例の形にする |
| `not-applied` | 同じバッチのあとの操作が失敗したので、これも適用しなかった | 失敗した操作を直して、バッチ全体をやり直す |

操作が新しい誤りを生むときは、その診断の code（`out-of-range` など）が `code` に入り、`error` は「この操作で誤りが増えるため、適用しませんでした（12 行目: 'blur' の値 999 は範囲の外です）」の形になります。

## 5. 目で確かめる

`check` が通っても、見た目が意図どおりとは限りません（文字が小さすぎる、画面の外にはみ出す、重なりの順が逆…）。書き換えたら、その時刻の 1 コマを画像にして見てください。

```sh
mozcut preview project.mzc 3.5 -o shot.png   # 3.5 秒のコマ
```

- 文字の `size` は画素です（720p なら見出し 64〜120、字幕 26〜40 くらい）。`x` / `y` の負の数は右端・下端からの距離です。
- トラック番号が大きいほど手前に描きます（既定は video / color が 0、image が 1、text が 2）。
- 誤りのあるプロジェクトでは `preview` も `render` も止まります。先に `check` を通してください。
- 動画全体は `mozcut render project.mzc`（一部だけなら `--from 6 --to 7.5 -o part.mp4`）。時間がかかるので、確かめるのは `preview` で十分なことが多いです。

## 6. まとめ（決まった流れ）

1. `mozcut schema --json` と `mozcut check project.mzc --json` を読む。
2. クリップは ID で指す（なければ `set @行 id=名前` で付ける）。
3. `mozcut op ... --dry-run --json` で changes を確かめる。
4. `--dry-run` を外して実行し、`saved: true` を確かめる。
5. `mozcut check project.mzc --json` で `diagnostics` が空なことを確かめる。
6. `mozcut preview project.mzc <時刻> -o shot.png` で、変えた所の見た目を確かめる。
