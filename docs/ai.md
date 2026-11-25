# AI のエージェント向けの手引き

MozaicCut のプロジェクト（`.mzc`）を、AI のエージェントが読み書きするときの手順です。人向けの説明は [README.md](../README.md)、内部の約束ごとは [design/architecture.md](design/architecture.md) にあります。

以下、`mozcut` は `node tools/mozcut.mjs`（MozaicCut のフォルダから実行）の略です。

## 1. 最初に読むもの

```sh
mozcut schema --json            # 使えるキー・効果（プラグイン）・操作・時刻と参照の書き方
mozcut check project.mzc --json # 今のプロジェクトの配置と誤り
```

- `schema --json` は `{"version":2,"keys":[...],"effects":[...],"effectsNote":"...","ops":[...],"syntax":[...]}`。
  - `keys[i]`: `name`、`kinds`（使える行の配列）、`type`（`time` / `number` / `int` / `color` / `pos` / `vec2` / `string` / `enum` / `flag`）、enum なら `values`、`default`（数の型なら数か null。`size/14` のような式は `defaultExpr`）、別名なら `aliasOf`、`min`、`max`、`doc`、`animatable`（キーフレームで動かせるか）。**同じ `name` が行の種類ごとに別の項目で出ます**（`out` は video / audio では素材の使い終わり、project では `aliasOf:"output"`）。辞書にするなら (name, kinds) を鍵にします。
  - `effects[i]`: `name`、`doc`、`kinds`（書ける行）、`aliases`、`params[{name,key,default,min,max,doc}]`。`key` がそのまま `.mzc` に書くキーです（`vignette` / `vignette.radius`）。クリップの行の効果はそのクリップにだけ、project の行の効果は合成した画面全体に掛かります。
  - `ops[i]`: 操作の `name`、`usage`、`doc`、`example`。`syntax`: 時刻・参照・クリップの指し方の説明。
  - `keys[i].animatable` は値を `値@時刻[:印]` の列で書けるか、`keys[i].keyOps` は `key add` などの操作で動かせるか。テキストアニメーターの `anim.start` / `end` / `offset` / `amount` も、どちらも true（`anim.start` などは `anim.mode=range` のときだけ書ける）。
  - `blend`: 描画モード（`modes`）・色空間・マスクの行のキー・マット。`features[i]`: M6 の機能（`keyframes` / `blend` / `shape` / `textanim`）ごとの早見で、`lines`（書く行）、`keys`、`values`（プリセットや形の名前）、`ops`、`check`（`check --json` で読む所）、`doc`、`examples`（`op` の 1 行。そのまま流せる）。
  - MCP の `schema` ツールでは `section` に `keys` / `effects` / `ops` / `syntax` / `blend` / `features` を渡すと、その部分だけを返します。
  - 効果はプラグインで増えるので、名前や範囲を覚え込まず、毎回 schema を読んでください。
- `check --json` は `{"ok":..,"project":{...},"clips":[...],"diagnostics":[...]}`。
  - `ok` は error の診断が 0 個か（warning は数えない）。
  - `clips[i]`: `index`（`#番号`）、`id`（なければ `null`）、`line`（行番号）、`kind`、`track`、`trackKind`（`"video"` / `"audio"`。映像と音でトラック番号は別）、`start` / `end` / `duration`（秒の数。配置した後の実際の時刻）、`in`、`src`、`text`、`at`（書いたままの値。参照なら `"clip_a.start+1"`、省けば `null`）、`placed`（`false` なら誤りのため仮の位置）、`keys`（行に書いた key=value。位置・大きさ・色などを読める）、`effects[{name,params}]`、`anims`（キーフレーム。`{"x":{"type","keys":[{t,value,text,in,out}]}}`。`project.anims` は project の行の効果の分）。
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
- 色の調整は video / image の行の `grade.*`（README の「色の調整」）。`set clip_b grade.lift="0.02 0 -0.01 0" grade.curve.y="0:0 0.5:0.6 1:1"`、戻すときは `unset clip_b grade.lift`。名前は src/effects/color/grade.um の `colGradeSet` と同じです（`grade.reset` は書けません）。
- 値に空白を含むときは `"..."` で囲みます。文字の値（`text=`、`add text "..."`）の中の `\n` は改行になります。
- `--json` の形: `{"ok":true,"saved":false,"results":[{"op":"move","ok":true,"code":"","desc":"clip_b を 5 秒から 5.5 秒に動かしました","error":"","hint":"","suggest":"","newId":"","changes":[{"kind":"edit","line":9,"before":"...","after":"..."}],"moved":[],"newDiagnostics":[]}],"diagnostics":[]}`。
  - `saved` が true なら保存しました。`--dry-run` なら必ず false。
  - `changes[].kind` は `edit` / `insert` / `comment`、`line` は変更後の行番号。
  - 失敗したら `ok:false`、終了コード 1。失敗した操作に `code` / `error` / `hint` が入ります。同じバッチの前の操作は `code:"not-applied"` になります。
  - `suggest` は hint で推した候補（`"vignette"`、`"clip_b"`、`"move"`）。そのまま使って直せます。
  - 誤りが増えて止めたときは、その診断が `newDiagnostics`（`line` / `col` / `code` / `suggest`）にも入ります。

## 3.1 キーイング（chromakey / lumakey）

- キーイングは効果です（`set <映像> chromakey chromakey.r=0.1 chromakey.g=0.7 chromakey.b=0.3`）。引数の範囲は `schema --json` の `effects`。
- 抜け具合は `matteview=2`（市松模様の上にアルファ）を足して `preview` で確かめ、確かめたら `unset <映像> matteview` で外します。
- ガーベッジマットはマスクの行（`add mask ... mode=add`）で作り、キーの後ろでアルファに掛かります。書き方の詳しいことは [keying.md](keying.md)。

## 3.2 テキストアニメーター（text の行の anim=）

- `set <文字のクリップ> anim=rise anim.by=word` のように書きます。キーは `schema --json` の `keys` の `anim` / `anim.<引数>` / `animout` …（kinds は text）。
- `anim.start` / `anim.end` / `anim.offset` は `anim.mode=range` のときだけ書けます（書かないと `key-not-allowed`）。
- 書いたら `check --json` の `clips[i].textanim[]` の `mode` と `doc`（日本語の説明）で意図どおりか確かめ、`preview` で途中の時刻を見ます。
- 字を経路に沿って並べるのは `path=circle|wave|"M ..."` と `path.r` / `path.amp` / `path.len` / `path.phase` / `path.offset`（画素。キーフレームで流す）/ `path.rotate`。円の中心は字の箱の中央なので、`x=center y=center` か `x` / `y` で箱を置いて合わせます。

## 3.20 文字のキー（text の行）

- 斜体は `italic`（`skew=-12` と同じ）、傾きは `skew=<度>`（負なら上が右へ）。テキストアニメーター（anim=）の行でも字ごとに傾きます。
- `size` / `tracking`（字間の画素）/ `outline` / `outlinew` / `skew` は `key add` でも動かせます（`key add title size 1 120 ease`）。
- 中身を時刻で替えるときは `set <文字のクリップ> text="'0'@0 '1'@2f '2'@4f"`（いつも hold。`key add` では動かせません）。`check --json` の `clips[i].anims.text` は添字（0, 1, 2 ...）の並びです。

## 3.21 モーショントラッキング（motion）

```sh
mozcut motion project.mzc <映像> <x,y> --to <クリップ> --dry-run --json   # {"ok","saved","frames","lost","desc"}
```

- `<x,y>` は画面の画素で、その映像の始まりのコマの位置です。まず `preview` で始まりのコマを見て、角や模様のはっきりした所を選びます。
- 結果は `--to` のクリップの `pos` のキーフレームです（1 コマに 1 つ）。`lost` が多ければ点を選び直します。書いたあとは `check --json` の `anims.pos` と `preview` で確かめます。

## 3.21b 2D の変形（rotation / scale / anchor）

- video / image / text / color の行に `rotation`（度、時計回り）・`scale`（倍率。`1.5` か 横,縦 で `1.5,0.8`。負なら裏返す）・`anchor`（x,y。クリップの中央からの画素）を書くと、2D のまま回して拡大します。基準点がクリップの中央の位置（x / y で置いた所）に来て、そこを中心に拡大・回転します（`z=0` の 3D レイヤーと同じ置き方）。
- キーフレームは `rotation="0@0 90@2"` のように書くか、`key add <クリップ> rotation <秒> <値>`。`scale` のキーも 横,縦 で書けます（`scale="1@0 1,2.5@1"`。数だけのキーは縦横同じ。shape の行も同じ）。`key add <クリップ> scale 1 1,2.5` のように 横,縦 を足すと、今の値も 2 次元に書き直します。マスク・効果は回す前のクリップに掛かります。
- 書いたら `preview` で確かめます。

## 3.22 3D レイヤー（z / rx / ry / camera.*）

- クリップに `z=0` のような 3D だけのキーを `set` すると 3D になります（`check --json` の `clips[i].is3d`）。カメラ・ライトは project の行の `camera.*` / `light.*`（`schema --json` の keys）。
- 3D のキーのキーフレームは、いまは `linear` と `hold` の印だけ（ほかの印は `anim-bad-interp`）。`split` / `trim` は 3D のキーの時刻をずらします。
- 向き・奥行きは数値だけでは分かりにくいので、必ず `preview` でいくつかの時刻を見ます。
- 3D のモデル（.obj）は `model` の行で置きます: `add model "media/cup.obj" id=cup track=2 at=0 dur=4 size=400 z=-100 ry="0@0 360@4" color=e0a060`。いつも 3D で描き、平らな 3D レイヤーと奥行きで前後します。`size` はいちばん長い辺の画素（既定は画面の短い辺の半分）、`color` は既定 c8c8c8。.obj が読めないと `render` / `preview` が行の番号つきで止まります。

## 3.25 パーティクル（particles の行）

- `add particles emit=point x=640 y=600 rate=300 ... at=<時刻> dur=<秒>`。位置で渡す値はありません。キーは `schema --json` の kinds が `particles` のもの。
- **particles の行の `x` / `y` は発生源の中心**です（ほかの行の「左の位置」とは違う）。`blend=add|over` も粒の重ね方で、描画モードではありません。
- `check --json` の `clips[i].particles` に設定の日本語の説明が出ます。動きは `preview` をいくつかの時刻で見て確かめます（同じ `seed` なら何度描いても同じ）。

## 3.3 シェイプ（shape の行）

- `add shape <形> key=value ...`（形は rect / ellipse / polygon / star / path。引用符なし）。形のキーは `schema --json` の `keys` の kinds が `shape` のもの。
- `x` / `y` は形の箱の左上、`pos=x,y` は anchor（既定は形の中心）を置く画面の点です。回す・並べる（repeat）中心を画面の点に置くときは `pos` を使います。
- `check --json` の `clips[i].shape` に、既定値を埋めた形の値が出ます。形のキーの多く（`trimend`、`rotation`、`pos` など）は `key add` で動かせます。

## 3.4 マスクの行と描画モード

- マスクの行（`mask ...`）はクリップではないので、`@行番号` で指します（`check --json` の `clips[i].masks` が掛かったマスク）。足すときは `add mask <形> to=<クリップ> ref=<幅>x<高さ> ...`。to= は必ず書き、座標は ref= の大きさの画素か `units=norm` の割合で書きます。マスクは上から順に重なるので、行を並べ替えると結果が変わります。マスクの `x` / `y` / `w` / `h` / `round` / `feather` / `expand` / `opacity` と `d`（`'M ...'@時刻` の並び）はキーフレームで書けます（時刻は掛けるクリップの始まりから。`check --json` の `clips[i].anims` に `mask<番号>.<キー>` で出る）。`opacity` は 0〜1 の割合（50% は 0.5）です。
- 描画モード・トラックマットは `blend=` / `matte=` を `set` で書きます。値の一覧とマスクの行のキーは `schema --json` の `blend`。`check --json` の `clips[i].blend` で読めた値を確かめます。
- `matte=` の元のクリップは画面に描かれません。消すときは `delete <元> fix-refs` でマットも外れます。元を `split` すると、`matte=` で使う行も同じ時刻で分かれます。
- 3D のレイヤーには `blend=` / `matte=` がまだ効きません（`key-ignored`）。

## 3.6 エクスプレッション（式）

- `set <クリップ> x="expr(...)"` か `set <クリップ> x.expr="..."`（位置は `pos.expr` も `position.expr` と同じ）。音量（`volume`）の式は書けません。空白を含む式は値全体を `"..."` で囲み、式の中の文字列は `'...'`（`clip('title')`）。使える関数と値の名前は `schema --json` の `expressions`。
- 書いたら `check --json` の `clips[i].exprs`（`ok`、`type`、`refs`）で読めたかを確かめ、`preview` を何点かの時刻で見ます。`wiggle` / `random` は決まった結果（同じ ID と値の名前なら何度描いても同じ）。
- 式の `x` / `y` は左上の画素で、`opacity` は 0〜1（AE の 0〜100 ではない）。

## 3.5 キーフレーム（値を時刻で動かす）

```sh
mozcut op project.mzc key add title x 0 -400 --dry-run --json      # 0 秒のキー
mozcut op project.mzc key add title x 1.5 120 ease --dry-run --json # 1.5 秒にイーズのキー
```

- `.mzc` では `x="-400@0 120@1.5:ease"` のように `値@時刻[:印]` を空白で並べます。書き方は `schema --json` の `syntax`（キーフレーム）、動かせるキーは `keys[].animatable` と効果の引数です。
- **キーフレームの `x` / `y` / `pos` は左上からの画素**（負も可）。ふつうの値の `center` や「負は右端から」とは意味が違います。`key add` で今のふつうの値を 0 秒のキーにできないとき（`center` や負の値で、クリップの大きさが分からない）は `anim-bad-value` で断るので、先に 0 秒のキーを画素で足します。
- 操作: `key add|remove|move|set|ease|shift|clear <クリップ> <キー> ...`。キーは時刻か `#番号`（`check --json` の `anims.<キー>.keys` の順）で指します。変えていないキーの文字は書いたまま残ります。
- `split` / `trim` / `cut` はキーの時刻を直すので、自分で `key shift` しないでください（`end` からのキーは終わりに付いて動きます）。粒・テキストアニメーター・`drawon` は `in=` / `full=` を書いて続きから見せ、マットの元を分けると `matte=` の行も分けます。`cut` は範囲をまたぐキーフレームのクリップを分け、project の行のキーも詰めます。
- 効果の引数は別名（`blur` と `blur.radius`）でも同じ値です。`key add` は行に書いてある名前のキーに足します。
- 書いたら `check --json` の `clips[].anims` で、時刻（`t`）と値（`value`）が意図どおりか確かめ、`preview` で途中の時刻も見ます。

## 3.6 よく使う手順の例

`demo/demo.mzc`（intro 0〜2 秒、clip_a 2〜6 秒、clip_b 5〜9 秒）に、MCP の `op` ツールで流して確かめた例です。CLI なら `mozcut op demo.mzc --file - --dry-run --json` に同じ行を渡します。どれも、まず `apply` なしで差分を見て、`apply=true` で保存し、`check` の `ok` と下に書いた欄を確かめ、`preview` で途中の時刻を 2〜3 枚見ます。

### この区間をズームインにする（ジャンプズーム）

```text
split clip_a 3
split clip_a_2 4.5
set clip_a_2 w=1920 h=1080
key add clip_a_2 x 0 -320
key add clip_a_2 x 1.5 -480 ease
key add clip_a_2 y 0 -180
```

- 3〜4.5 秒が `clip_a_2` に分かれ、1.5 倍（1280x720 → 1920x1080）に大きくなり、`x="-320@0 -480@1.5:ease"` で少し右へ流れます。後ろは `clip_a_2_2`（`at=clip_a_2.end`）。
- 映像の行の `w` / `h` はキーフレームで動かせない（`keys[].animatable` が false）ので、なめらかに寄るのではなく、区間を切って大きさを変えます。中心を保つには `x = -(w - 1280) / 2`、`y = -(h - 720) / 2` を 0 秒のキーにします（キーフレームの x / y は左上からの画素）。
- 確かめる: `check` の `clips[clip_a_2].anims.x.keys`、`preview` 2.8 秒（ふつう）と 3.2 秒（寄った絵）。

### 字幕を順に出す

```text
add text "まずは素材を読み込みます" id=sub1 at=2.5 dur=1.5 y=-60 size=34 bg=000000a0 pad=10 anim=fadein
add text "次に、要らない所を切ります" id=sub2 at=sub1.end dur=1.5 y=-60 size=34 bg=000000a0 pad=10 anim=fadein
add text "最後に書き出します" id=sub3 at=sub2.end dur=1.5 y=-60 size=34 bg=000000a0 pad=10 anim=fadein
```

- 2 つ目から `at=<前の字幕>.end` にすると、前の字幕の長さを変えたときに後ろが付いて動きます。`anim=fadein` で 1 文字ずつ現れます（`check` の `clips[].textanim[].doc` に説明）。
- 確かめる: `check` の sub1〜sub3 の `start` / `end`（2.5〜4、4〜5.5、5.5〜7）、`preview` 2.6 秒（出始め）と 3.2 / 4.8 / 6.3 秒。

### タイトルを左から滑り込ませる

```text
key add title x 0 -700
key add title x 0.6 392 ease
```

- 文字の行の `x` は既定が `center` なので、`key add` で今の値を 0 秒のキーにできません。最初のキーも画素で渡します（終わりの 392 は幅 1280 の中央に来る左上の画素。`preview` で見て合わせます）。
- 確かめる: `preview` 0.2 秒（画面の外）、0.5 秒（入ってくる途中）、1.0 秒（止まった所）。

### 文字を 1 語ずつ出して、終わりに消す

```text
set subtitle anim=rise anim.by=word anim.stagger=0.15 animout=fadein animout.dur=0.3
```

- `anim` は始まりから、`animout` は終わりへ向けて掛かります。プリセットの名前は `schema` の `features`（textanim）の `values`。
- 確かめる: `check` の `clips[subtitle].textanim` が 2 つ、`preview` 0.7 / 0.9 / 1.5 秒。

### 下線を描いていく（シェイプ）

```text
add shape path id=uline d="M 0 0 L 520 0" fill=none stroke=ffd040 strokew=8 cap=round x=380 y=420 at=0.4 dur=1.6 track=4
key add uline trimend 0 0
key add uline trimend 0.6 1 ease
```

- 線を伸ばすなら、塗りの四角ではなく `path` の線（`fill=none stroke=...`）に `trimend` のキーを付けます（塗りの形の `trimend` は輪郭を切るので、くさび形になります）。`x` / `y` は形の箱の左上。
- 色は `#` を付けずに `ffd040` と書きます（空白のあとの `#` は注釈の始まりとして読まれます）。
- 確かめる: `check` の `clips[uline].shape` と `anims.trimend`、`preview` 0.5 / 0.7 / 1.2 秒。

### 光を重ねる（描画モード + マスク）

```text
add color ffb040 id=glow track=4 at=clip_b.start dur=4 w=500 h=500 x=700 y=0 blend=screen
add mask ellipse to=glow units=norm x=0.1 y=0.1 w=0.8 h=0.8 feather=0.3
```

- `blend=screen` で下の映像を明るくし、楕円のマスクで縁をぼかします。マスクの行は `@行番号` で指します（`op` の `desc` に行番号が出ます）。
- 確かめる: `check` の `clips[glow].blend.mode` が `screen`、`masks` が 1 つ。`preview` 6.5 秒。

### 最後をゆっくり暗くする（不透明度のキーフレーム）

```text
set clip_b opacity="1@0 1@end-1.5 0@end"
```

- `end-1.5` はクリップの終わりからの秒です。`trim` や `cut` でクリップの長さが変わっても、終わりに付いて動きます。
- 確かめる: `check` の `clips[clip_b].anims.opacity.keys`（t が 0 / 2.5 / 4）、`preview` 7 秒と 8.5 秒。

### 音連動 MV・スペクトラム・縦書きリリック・2D モーションブラー

```text
set project bpm=128 beat.offset=0 mblur.angle=180 mblur.samples=8
add spectrum ring id=spec track=3 at=0 dur=4 w=420 h=420 x=430 y=150 color=22d3ee color2=f43f5e bars=32 gain=1.4 blend=add
add text "夜明け前の静寂" id=lyric track=5 at=0.468 dur=3 size=56 vertical=1 x=1100 y=80 color=f8fafc color2=38bdf8 grad.angle=90 shadow=000000cc shadow.blur=10 shadow.y=4 anim=rise anim.stagger=0.06 animout=fadein
set spec glow="expr(0.25 + audioBass() * 0.9)"
```

- 音声があるプロジェクトでは `analyze_audio` で推定 BPM・ビート時刻・盛り上がりピーク・静かな区間を取得できます。
- 話し声は `transcribe`（`clip`、`lang`）で書き起こせます。字幕の区切り（`cues`）・全文（`text`）と、字幕の text を足す操作（`ops`）を返すので、`ops` をそのまま `op` に渡して置きます。whisper.cpp を手元で動かすので、素材の長さに応じて時間がかかります（[analyze.md](analyze.md) の「文字起こし」）。
- ネイティブ MCP サーバー（Node.js 不要）は `mozcut mcp --root <フォルダ>` で起動できます（`preview` はインライン PNG 画像を返します）。

## 4. 診断と操作の code と直し方

診断は `{"code","severity","line","col","message","hint","suggest"}` です。`hint` に直し方がそのまま書いてあることが多いので、まず `hint` を読んでください。`suggest` は推した候補（なければ `null`）。`severity` が `"warning"` のもの（`bad-escape`、`font-not-found`）は、終了コードや op の判断には数えません。

| code | 意味 | 直し方 |
| --- | --- | --- |
| `syntax` | 閉じていない `"`、`=` の前にキーがない | `"` を同じ行で閉じる。`"` そのものは `\"` |
| `unknown-type` | 行の先頭の種類が違う | project / video / image / text / color / audio / shape / particles / mask のどれかにする |
| `unknown-key` | 知らないキー（綴りの誤り） | `suggest` か hint の「〜のことですか？」に直す（`renamekey` で） |
| `key-not-allowed` | キーは正しいが、その行では使えない（音量の式も） | 行を変えるか、消す。使える行は schema の `kinds` と hint。効果は audio の行に書けない。音量はキーフレームで動かす |
| `unexpected-value` | key=value でない余分な語 | 消すか `key=value` にする |
| `bad-number` / `bad-time` / `bad-color` / `bad-enum` | 値の形が違う | 時間は `12.5` か `1:02.5` か参照（分・秒の欄は 60 未満）。色は `rrggbb` / `rrggbbaa`。enum は schema の `values` |
| `bad-grade` | 色の調整（`grade.*`）の値の誤り | msg の理由に従う（ガンマ・ゲインは 0 より大きく、カーブは点を 2 つ以上、色温度は 1667〜25000） |
| `out-of-range` | 範囲の外（負の時間、参照から求めた開始が負、素材の長さを超える `out` / `dur`、素材の終わり以降の `in` も） | schema の `min` / `max` に収める。素材の長さは超えない（`in` は素材の長さより前） |
| `missing-source` | 素材のファイルの指定がない、またはファイルが見つからない | `video "media/a.mp4"` のように書く。hint の「探した場所」を見てパスを直す |
| `unreadable-source` | 素材のファイルはあるが、FFmpeg で読めない（壊れている・書きかけ・動画や音でない。message に FFmpeg の理由） | 素材を作り直す・替える。パスが別のファイルを指していないか確かめる |
| `no-video-stream` / `no-audio-stream` | 素材に映像・音がない | 種類を `audio` にする、素材を替える |
| `unknown-length` | 長さが分からない（素材を調べていない。FFmpeg なしの版で probe.txt にない素材など） | `dur=` か `out=` を書く。FFmpeg なしの版は `node tools/mozcut.mjs` から実行すると調べる |
| `empty-clip` | 長さが 0 以下 | `in` < `out`、`dur` > 0 にする |
| `bad-project` | project の大きさ・fps・rate の誤り | 大きさは偶数、fps は `30` / `29.97` / `30000/1001` |
| `empty-timeline` | クリップが 1 つもない | クリップを足す |
| `bad-id` / `duplicate-id` | ID の形の誤り、重複 | 英字・数字・`_`・`-`、先頭は英字か `_`。ファイルの中で 1 つだけ |
| `unknown-ref` / `ref-cycle` | 参照先がない、参照が輪 | 参照先の ID を直す。輪の 1 つを秒の数にする（`at=` のないクリップは前の行を暗に参照している） |
| `bad-escape` | （warning）文字の中の知らない `\x` | `\` そのものは `\\` と書く |
| `font-not-found` | （warning）`font=` のファイルがない | パスを直す（既定のフォントで描かれる） |
| `key-not-animatable` | キーフレームで動かせないキー（`dur`、particles の行のキーなど）に `値@時刻` を書いた | ふつうの値にする。動かせるのは schema の `animatable` |
| `anim-syntax` / `anim-bad-value` / `anim-bad-time` | キーフレームの形・値・時刻の誤り（`@` がない、位置に `center`、`end+1`） | `値@時刻` を空白で並べる。位置は左上からの画素、時刻は秒・`45f`・`end-0.5` |
| `anim-bad-interp` / `anim-bad-ease` / `anim-bad-tangent` / `anim-spatial-not-allowed` | 知らない印、影響・速度の誤り、接線の形、2 次元でないキーの `curve` / `tin` / `tout` | `suggest` の印にする。`ease=60`、`in=0/75`、`tout=80,0`（経路の印は `pos` だけ） |
| `anim-key-overlap` | 同じ時刻のキーが 2 つ | 1 つにする（急に変えるなら前のキーに `:hold`） |
| `anim-remap-range` | `timeremap` が素材の外の時刻を見せる | 0〜素材の長さにする |
| `anim-key-order` / `anim-key-outside` / `anim-tag-unused` | （warning）時刻の順でない、補間にも使わない外のキー、効かない印 | 時刻の順に並べる・消す |
| `expr-syntax` / `expr-type` / `expr-unknown-name` / `expr-args` / `expr-unknown-clip` / `expr-unknown-prop` / `expr-cycle` / `expr-too-complex` / `expr-not-allowed` | エクスプレッションの誤り（引用符・型・名前・引数・参照先・参照の輪・長さ・その場所で使えない関数） | `suggest` か hint の書き方にする。空白を含む式は `"..."` で囲む（suggest に直した行） |
| `anim-duplicate` / `anim-no-effect` / `anim-word-no-space` | （warning）テキストアニメーターの同じキーを 2 回、掛ける値がない、空白のない文に `by=word` | 1 つにする・値を足す・`by=letter` にする |
| `bad-mask-shape` / `bad-path` | マスクの形（rect / ellipse / path）の誤り、パスの d が読めない | `suggest` の形にする。d は SVG と同じ（`M 0 0 L 10 0 Z`） |
| `mask-no-target` / `mask-orphan` | マスクを掛けるクリップがない、上のクリップが消されている | `to=<ID>` を書くか、マスクの行も消す |
| `matte-self` / `matte-missing` / `matte-not-visual` / `matte-chain` | 自分をマットにした、`matte=` がないのに `matte.type` を書いた、音の行をマットにした、マットの元にも `matte=` がある | 別の映像のクリップの ID にする、余分なキーを消す |
| `matte-gap` | （warning）マットの元が塗る側の時刻の一部にない（そのあいだ何も描かない） | 元を同じ時刻に置くか、塗る側も同じ時刻で `split` して `matte=` を同じ時刻の元にする |
| `duplicate-key` | （warning）効果の同じ引数を別名でも 2 度書いた（後に書いたほうを使う） | 1 つにする。動かすなら 1 つのキーフレームの列にまとめる |
| `key-ignored` | （warning）書いても効かない値: 3D のレイヤーの `blend=` / `matte=` | 3D のキーを外す・マスクを使う |
| `timeremap-audio` | （warning）音のある video の `timeremap`（音は再マップしない） | `mute` を付けるか、音を別の audio の行に分ける |
| `speed-timeremap` | （warning）`speed=` と `timeremap` を同じ行に書いた（`timeremap` が勝つ） | 一定の速さなら `speed=` だけ、途中で変えるなら `timeremap` だけにする |
| `mask-implicit-target` / `mask-no-ref` | （warning）to= のないマスク、ref= も units= もないマスク | `to=<ID>` と `ref=<幅>x<高さ>`（か `units=norm`）を書く |

操作だけの code:

| code | 意味 | 直し方 |
| --- | --- | --- |
| `unknown-op` | 知らない操作 | `suggest` か、上の操作の一覧から選ぶ |
| `unknown-clip` | 指したクリップがない | `suggest` か、`check --json` の `clips` の `id` / `index` / `line` で指し直す |
| `referenced` | `delete` するクリップが参照されている | 参照しているクリップを先に動かす・消すか、`delete <clip> fix-refs` |
| `bad-args` | 引数の数や形の誤り | hint の例の形にする |
| `anim-no-key` / `anim-not-animated` | `key` の操作で指したキーがない（hint に今のキーの一覧）、キーフレームでない値に remove など | 時刻か `#番号` を直す。先に `key add` |
| `needs-id` | マスクのあるクリップに ID がないので、マスクの行に to= を書けない | 先に `set <クリップ> id=<名前>` |
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

## 7. アプリの中の AI

MozaicCut のアプリ（右の列の AI のタブ）からも、AI に編集を頼めます。中身は `src/ai/`、画面へのつなぎ方は [design/ai-panel.md](design/ai-panel.md) にあります。

### 相手（設定の画面で選ぶ）

| 相手 | つなぎ方 | モデル |
| --- | --- | --- |
| Claude（Anthropic の API） | `POST https://api.anthropic.com/v1/messages`（生の HTTP。`anthropic-version: 2026-10-21`）。API キーは設定か環境変数 `ANTHROPIC_API_KEY` | 既定 `claude-opus-5-5`（設定で変えられる） |
| Ollama（このパソコンの AI） | `http://localhost:11434/api/chat` | 設定の［一覧を取る］（`/api/tags`）で選ぶ |
| OpenAI 互換（LM Studio など） | 設定の base URL（例 `http://localhost:1234/v1`）の `/chat/completions` | 設定で選ぶ（`/models` の一覧） |
| Claude Code（外の AI） | アプリの中からは呼ばない。Claude Code に MCP サーバーを登録して、そちらで頼む（[mcp.md](mcp.md)） | Claude Code の設定 |

設定は `%APPDATA%/MozaicCut/ai.json`（Windows。ほかは `$HOME/.config/MozaicCut/ai.json`）に置きます。API キーもこのファイルに平文で入るので、ファイルを人に渡さないでください。画面ではキーを伏せて（最後の 4 文字だけ）出します。

Claude への頼みでは、次を決まりにしています。

- 返事は流れてくる形（`stream: true` の SSE）で受け、文字が届いたそばから出す。
- `thinking: {type: "adaptive"}` と `output_config: {effort: "medium"}`（effort は設定で変えられる）。thinking の塊は、会話の続きで受け取ったまま返す。
- 断られた（`stop_reason: "refusal"`）ら分かる言葉で出し、その頼みは会話から取り下げる。`fallbacks: "default"` と `anthropic-beta: server-side-fallback-2026-07-01` を既定で付ける（断られたときに、ほかのモデルで続けられるように）。
- 429 と 5xx（と途中の `overloaded_error`）は、`retry-after` か 1・2・4… 秒待って頼み直す（既定 4 回まで）。ほかの誤り（401 のキーの誤り、404 のモデルの名前の誤りなど）は、直し方の分かる 1 文で出す。
- プロンプトのキャッシュ: system（下の要点 + schema）とツールの定義を、毎回同じ文字列・同じ順にして `cache_control: {type: "ephemeral"}` を付ける。最後の頼みの塊にも付けて、ツールの往復で前の分を使い回す。

### ツールと流れ

AI に渡すツールは、MCP サーバーと同じ名前・同じ中身の `check`・`show`・`schema`・`op`・`preview` です。アプリの中の関数（report.um・ops.um・render.um）で直接実行します。違いは次の 3 つです。

- プロジェクトは開いているものだけなので、`project` の引数はありません。
- **`op` の `apply=true` は保存しません。** 同じ操作を利用者への「提案」にします。利用者が提案のカードで［適用］を押したときだけ `.mzc` を書き換えます（選んだ op だけでも適用できます）。適用の前に今のファイルで dry-run し直し、当てはまらなくなっていれば書きません。
- `preview` の画像は、Claude には画像として渡します（Ollama と OpenAI 互換には文だけを渡します）。

ツールの定義は `strict: true` と `eager_input_streaming: true` で、`tool_choice` は `auto` です。届いたツールの入力は JSON として読み、スキーマ（型・必須・知らないキー・enum）に合うかを確かめてから実行します。合わなければ実行せず、`is_error` の結果で理由を返します。

system には、この手引きの要点（1・2・3・5・6 章の流れ）と `schema --json` の全体を、決まった順で入れています。流れは CLI と同じです: `check` → `op`（dry_run）で差分を確かめる → 同じ ops を `apply=true` で提案にする → 必要なら `preview`。

- 提案を適用すると、取り消しは 1 つにまとまります（op がいくつあっても Ctrl+Z 1 回で戻る）。
- 適用・却下は、次の頼みの頭で AI に知らせます。
- 適用した提案は `<名前>.mzc.history` に 1 行（`"who":"ai","via":"app"`）残します。

### Claude Code での編集をアプリに出す

Claude Code から MCP サーバーで保存すると、MCP サーバーは `<名前>.mzc.history` に 1 行（`"via":"mcp"`、`client` は Claude Code が名乗った名前、`ops`・`desc`・`changes`）を書き足します。アプリは開いている間、`.mzc` の変化とこの行を見ていて、AI の欄の履歴に「Claude Code: …」と出し、タイムラインを読み直します。

登録の 1 行（設定の画面にも出ます）:

```sh
claude mcp add mozaiccut -- node C:/Users/you/MozaicCut/tools/mcp-server.mjs --root C:/Users/you/Videos/projects
```
