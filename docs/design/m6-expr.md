# エクスプレッション（式）: M6 の部品

After Effects の JavaScript のエクスプレッションの代わりに、**安全で小さな式の言語** を UM で持つ。
クリップの値（位置・不透明度・効果の引数など）を時刻や他のクリップの値から決める式と、画素ごとの式（kernel）の 2 つの使い方がある。

- コード: `src/m6_expr/expr.um`（字句・構文・型・中間の形・CPU の評価・座標と値の表）、`expr_math.um`（hash と f32 の数学。kernel）、
  `expr_pixel.um`（画素の式の kernel）、`expr_mzc.um`（.mzc の書き方と正規の形・評価の順・schema）。
- 試験: `node tests/m6-expr/run.mjs`（`src/expr_test.um`、`src/expr_testfix.um`、`src/expr_gpu_test.um`、`src/expr_demo.um`）。

## 方針

1. **止まる言語。** ループ・再帰・関数の定義はない。命令は前にしか進まないので、評価は命令の数（1024 まで）で必ず終わる。0 で割る・`% 0` などで値が数でなくなれば、`value` に戻す（`ExprResult.bad`）。
2. **1 回だけ解析する。** 式は読むときに 1 回だけ、スタックの命令の列（`ExprProg`）にする。定数だけの部分（`[0.5, 0.5]`、`2 * PI`）はこのとき 1 つの定数に畳む。コマごとには `exprEval` が命令を順に実行するだけ（1 回 0.1 µs ほど）。
3. **型は解析のときに決まる。** 数・2 次元 `[x, y]`・色 `[r, g, b, a]`（0〜1）の 3 つ。型の誤り（数と 2 次元を足した、結果の型がキーと違う）は `expr-type` として、行・列・直し方つきで出す。
4. **決まった結果。** `random` と `wiggle` は、種（`seedRandom`）・**値の名前**（x、y、opacity …）・**クリップの ID**・コマの番号・呼び出しの場所から hash で決まる（`exprSetIdentity`）。同じクリップの `x` と `y` に同じ `wiggle(2, 30)` を書いても違う揺れになり（AE と同じ）、前に行を足しても ID のあるクリップの値は変わらない（テキストが正本なので、差分が安定する）。ID のないクリップだけは ID の代わりに行の順を使う。`sin` などは自前の多項式（OS の数学ライブラリに頼らない）なので、どのマシンでも同じ絵になる。
5. **CPU と GPU で同じ結果。** 画素の式は kernel（`exprPixelKernel`）が同じ命令の列を画素ごとに解釈する。**NVIDIA の Vulkan（wgpu）で**、10 の式の 1920x1080 の全画素が CPU と 1 ビットも違わないことを確かめた（下の「速さ」）。ほかのドライバと Metal は未確認（下の「CPU と GPU を揃えるための注意」）。
6. **AE と同じ名前と引数。** `wiggle(freq, amp, octaves, amp_mult, t)`、`linear` / `ease` / `easeIn` / `easeOut`（5 引数と 3 引数）、`loopOut` / `loopIn`（`cycle` / `pingpong` / `offset` / `continue`）、`valueAtTime`、`key(n).value`、`random`、`seedRandom`、`Math.sin`、`thisComp.width`、`hslToRgb` など。ほかのレイヤーは `thisComp.layer("x")` の代わりに `clip('ID')`。目盛りと座標の違いは下の「AE との違い」。

## .mzc での書き方

正本の書き方は 2 つ。どちらも今の字句（`pjTokenize`）と行の書き換え（`lineedit.um` の `setKey` / `removeKey` / `keyValue` / `renameKey`）がそのまま扱える。

```sh
# 式だけで値を決める（value は x の既定値）。空白を含む式は値全体を "..." で囲み、式の中の文字列は '...'
text "MozaicCut" id=title x="expr(ease(time, 0, 1, -200, 240))" y="expr(140 + 10 * sin(time * 3))"

# キーの値（数やキーフレーム）に重ねる。value はその値。キーフレームの書き方は m6-anim の担当の形のまま
text "sub" id=sub y=600 y.expr="wiggle(2, 8)"
color 30c070 id=blink opacity="0@0 1@0.25:ease" opacity.expr="loopOut('pingpong')"

# ほかのクリップの値（ID で）
image "dot.png" id=dot x="expr(clip('title').x + 60 + 50 * sin(time * 6))" y="expr(clip('title').y + 90)"

# 効果の引数
video "a.mp4" blur="expr(2 + 2 * sin(time))" vignette.radius.expr="0.6 + 0.1 * sin(time)"

# 画素の式（クリップの層に。project の行なら合成した画面全体に）
color 000000 pixel="expr(rgb(uv.x, uv.y, 0.5 + 0.5 * sin(time)))"
text "Hi" pixel="expr(rgb(uv.x, uv.y, 0.5, src.a))"          # 文字の形を保つなら a に src.a
project size=1920x1080 pixel="expr(let d = distance(uv, [0.5, 0.5]); src * (1 - smoothstep(0.4, 0.9, d) * 0.6))"
```

- `key="expr(...)"`: 値が `expr(` で始まれば式。中身は引用符なし（`expr(wiggle(2, 30))`）でも `"..."` / `'...'` で包んでも読める。空白のない式なら `x=expr(wiggle(2,30))` と引用符なしでもよい。
- **空白を含み、引用符で囲まない `x=expr("wiggle(2, 30)")` は書けない。** 字句と行の書き換えは値の終わりを空白で決めるので、`setKey(x, 50)` が `x=50 30)") y=100` のように行を壊す。読むとき（`exprLineCheck`）に `expr-syntax` にして、直した行（`exprLineFix`。`x="expr(wiggle(2, 30))"`）を `suggest` に入れる。
- `op set` が式を書くときは `exprCanonValue` で正規の値（`expr(<式>)`、式の中の文字列は `'...'`）にしてから `setKey` に渡す（`setKey` の `lineQuote` が空白のある値を `"..."` で囲む）。正規にしない値を渡しても `\"` で囲まれて読めるが、行が読みにくくなる。
- `key.expr="..."`: `key` に書いた値（数・キーフレーム）を `value` として受け取り、その上に式を掛ける（AE の「キーフレーム + エクスプレッション」）。`key="expr(...)"` と `key.expr=` を同じ行に両方書いたら、組み込みの側で `key.expr` を `expr-syntax`（「x は expr(...) で決めているので x.expr は書けません」）にする。
- `pixel="expr(...)"`: 画素の式。結果が色ならそのまま（**a も置き換わる**。文字・画像の形を保つなら a に `src.a`）、数なら明るさ（r = g = b、a は元のまま）。
- 誤った引用符: `x="expr("clip("title").x")"` のように式の中の文字列を `"` で書くと、外側の `"` がそこで閉じる。その列を指して「式の中の文字列は clip('title') のように ' で囲みます」と出す。

## 座標と目盛り

MozaicCut の `.mzc` の `x` / `y` は、既定が center（`POS_CENTER` = 1e30）で、負の数は右端・下端からの距離を表す。式はこの記号の値を扱わない:

- **式に渡す値（`value`、`ExprLayer` の `x` / `y` / `position`）は、解いた後のクリップの左上の画素**（キャンバスの左上から）。描画の担当は `exprResolvePos(v, size, canvas)`（`render.um` の `resolvePos` と同じ計算）で解いてから入れる。`w` / `h` は `exprResolveSize(v, 元の大きさ)` で、描く大きさ（画素）にしてから入れる。
- **式の結果も同じ座標**として描く（`Math.floor` だけ。`resolvePos` を通さない）。`ease(time, 0, 1, -200, 240)` の -200 は「右端から 200」ではなく「左の画面外 200」。値が 0 をまたいでも基準は変わらない（m6-anim の `ANIM_POS` と同じ約束）。
- `position` は `[x, y]`（左上）で、`x` / `y` と同じ値（`exprEnvCompose`）。AE の position（アンカー＝ふつうは中心）ではない。中心は `position + [w, h] / 2`。
- `opacity` は 0〜1（AE の 0〜100 ではない）、時刻は秒、色は 0〜1。`schema` の `expressions.props[].doc` に名前ごとに書いてある。

## 言語

```
文      := (let 名前 = 式 ;)* (seedRandom(種[, timeless]) ;)* 式 [;]     // 名前 = 式 ; も可（AE の書き方）。// から行末は注釈
式      := 条件 ? 式 : 式 | 式 || 式 | 式 && 式 | 式 (< <= > >= == != ===) 式 | 式 (+ - * / %) 式 | (- + !) 式
後置    := 値 .名前 | 値 [0〜3]                                           // 成分（.x .y / .r .g .b .a / [n]）
値      := 数 | 名前 | 関数(引数, ...) | ( 式 ) | [式, 式(, 式(, 式))]    // 2 個は 2 次元、3〜4 個は色（3 個なら a = 1）
```

- 演算: 同じ型どうしは成分ごと。数との `*` `/` はすべての成分に（`[1, 2] * 3`）。数と 2 次元の `+` は誤り（`expr-type`。直し方に成分ごとの書き方）。`%` は JavaScript と同じ（`-1 % 3 = -1`、`x % 0` は数でない値なので、値の式は `value` に戻して bad）。画素の式には `value` に戻す道がないので、`x % 0` は 0。比較は数どうし（`==` / `!=` は同じ型どうし）。条件は 0 が偽。
- 変数: `time`（タイムライン上の秒）、`value`、`index`（.mzc の行の順の番号。1 から）、`thisLayer.名前`、`inPoint` / `outPoint`、`thisComp.width / height / duration / frameDuration / fps`、`numKeys`、`PI` / `E` / `true` / `false`。画素の式だけ: `uv`（0〜1。画素の中心）、`px`（画素の中心の位置。左上の画素は `[0.5, 0.5]`。`uv * [層の幅, 層の高さ]` と同じ）、`src`（いまの色。`value` も同じ）。
- クリップの値の名前（`thisLayer.x`、`clip('a').position`）: `x` `y` `position`（2 次元）`w`/`width` `h`/`height` `opacity` `volume` `inPoint`/`start` `outPoint`/`end` `duration` `index` `color`（色）。描画の担当が `exprEnvAdd` で増やす（`rotation`、`scale`、効果の引数 `blur`・`vignette.radius` など。`clip('a').vignette.radius` のように点を含む名前も引ける）。
- 関数（`schema --json` の `expressions.functions` が正）: `wiggle` `linear` `ease` `easeIn` `easeOut` `loopOut` `loopIn` `valueAtTime` `key(n).value / .time` `random` `seedRandom` `noise` `clip` `sin` `cos` `tan` `asin` `acos` `atan` `atan2` `sqrt` `abs` `floor` `ceil` `round` `fract` `exp` `log` `sign` `pow` `min` `max` `step` `clamp` `mix`/`lerp` `smoothstep` `length` `normalize` `distance` `dot` `rgb` `hsl` `hslToRgb` `rgbToHsl` `vec2` `degreesToRadians` `radiansToDegrees` `timeToFrames` `framesToTime`。`Math.sin` のように `Math.` を付けてもよい。
  - 色の `length` / `dot` / `distance` / `normalize` は r g b だけを使う（a は使わない）。
  - `wiggle` の結果は `value` + 揺れ（AE と同じ。`value + wiggle(...)` と書くと 2 倍になる）。5 番目の引数に時刻 `t` を渡すと、`valueAtTime(t)` + 揺れ（AE と同じ）。揺れは格子の乱数を Catmull-Rom でつないだもの（格子点で止まらない）。
  - `random()` は 0 以上 1 未満、`random(最大)`、`random(最小, 最大)`（2 次元・色なら成分ごとに別の値）。同じ式の中の `random()` は呼び出しの場所ごとに別の値。
  - `sin` / `cos` / `tan`: 値の式（f64）は |x| ≤ 1e9 まで正確（π/2 を 23 ビットずつ 4 つに分けて 2π の倍数を引く。1e8 で 1e-13 以内）。越えると数でない値（value に戻して bad。黙って 0 にはしない）。画素の式（f32）は |x| < 8388608（2^23）まで（π/2 を 8 ビットずつに、k を 256 の倍数と残りに分けて引く。`sin(px.x * 100)` の誤差は 4e5 まで 1e-7 以下）。2^23 以上の f32 は整数しかなく位相が意味を持たないので 0。
- 上限: 式 4000 バイト、命令 1024、途中の値 32（画素の式は 16）、変数 16（画素の式は 8）、入れ子 48 段。越えると `expr-too-complex`。

## AE との違い

| | AE | MozaicCut の式 |
| --- | --- | --- |
| 位置 | `position` はアンカー（中心）、`[x, y]` | `x` / `y` / `position` はクリップの左上の画素（center と負の値は解いた後）。中心は `position + [w, h] / 2` |
| 不透明度 | 0〜100 | 0〜1（AE の `linear(time, 0, 1, 0, 100)` は 100 で割る） |
| `index` | 上のレイヤーから 1 | .mzc の行の順（1 から）。重なりの上下とは関係しない |
| ほかのレイヤー | `thisComp.layer("name")` | `clip('ID')`（`thisComp.layer` は `expr-unknown-prop` で `clip('ID')` を勧める） |
| 乱数の種 | レイヤーとプロパティごと | 値の名前とクリップの ID ごと（ID のないクリップは行の順） |
| `x % 0` | NaN | 値の式は数でない値（value に戻す）、画素の式は 0 |
| 言語 | JavaScript | ループ・関数の定義・文字列の操作はない（止まる言語） |

## 誤り（Diag）

`Diag`（`project.um`）の形。`line` は .mzc の行、`col` は式の中の誤りの位置を .mzc の行の列にしたもの。`msg` と `hint` は日本語、`suggest` は「'x' のことですか？」の x（行の誤り `exprLineCheck` では直した行）。

| code | 意味 |
| --- | --- |
| `expr-syntax` | 字句・構文の誤り（閉じていないかっこ・引用符、使えない文字、`if` / `for` / `{` など文の制御、結果の式がない、比較を続けて書いた、数と名前の間に演算子がない、空白を含む `x=expr(...)` を引用符で囲んでいない、式の中の文字列を `"` で書いて外側の `"` が閉じた） |
| `expr-unknown-name` | 知らない名前・関数（`wigle` → 'wiggle' のことですか？） |
| `expr-type` | 型が合わない（`[1, 2] + 3`、条件の 2 つの値の型が違う、結果がキーの型と違う、`.z` のない 2 次元） |
| `expr-args` | 関数の引数の数・型（`wiggle(2)`、`loopOut('cycl')` → 'cycle' のことですか？、`clip(title)`） |
| `expr-unknown-clip` | `clip('id')` の ID のクリップがない（近い ID を出す） |
| `expr-unknown-prop` | クリップの値の名前がない（`clip('a').xx`、`thisComp.layer(...)` には clip('ID') を勧める） |
| `expr-cycle` | 式の参照が輪になっている（`title.x → logo.x → title.x`。`x` と `position` をまたぐ輪も）。輪の中の値は式を掛ける前の値を読む |
| `expr-too-complex` | 長すぎる・深すぎる・変数が多すぎる |
| `expr-not-allowed` | その場所で使えない（画素の式の `wiggle` / `loopOut`、キーの値の式の `uv`） |

例（`node tests/m6-expr/run.mjs -v` の `diag` の行）:

```
p.mzc:4:19: エラー[expr-unknown-name]: 'wigle' という関数はありません
  ヒント: 'wiggle' のことですか？
p.mzc:3:29: エラー[expr-syntax]: 空白を含む x=expr(...) は、値全体を "..." で囲みます（このままでは空白で値が切れ、行の書き換えも壊れます）
  ヒント: x="expr(wiggle(2, 30))" と書きます（キーフレームに重ねるなら x.expr="..."）
p.mzc:2:14: エラー[expr-syntax]: expr("...") の中に " があるので、式がここで切れています
  ヒント: 式の中の文字列は clip('title') のように ' で囲みます（x="expr(clip('title').x)" か x.expr="clip('title').x"）
```

## API

```ts
// 解析（読むときに 1 回）。valueType は EXPR_NUM / EXPR_VEC2 / EXPR_COLOR（EXPR_ANY なら何でも）。
exprCompile(src, valueType, mode /* EXPR_MODE_PARAM | EXPR_MODE_PIXEL */, env: ExprEnv, line, col, diags: mut Diag[]): ExprProg
exprParseValue(clipId, key, val, valueType, env, line, vcol, diags): ExprProg  // x="expr(...)" / x.expr="..." / pixel=...。種（exprSetIdentity）も入れる
exprSetIdentity(mut prog, clipId, key)                                    // 乱数と wiggle の種（値の名前とクリップの ID）
exprLink(mut prog, scene, diags): bool                                     // clip('id') をクリップの番号に結ぶ（expr-unknown-clip）
exprOrder(nodes: ExprNode[], progs, env, diags): i32[]                     // 評価の順（expr-cycle。position と x / y は同じ値）
// 行（.mzc）
exprLineCheck(line, lineNo, diags): i32; exprLineFix(line): string; exprCanonValue(val): string
// 座標と値
exprResolvePos(v, size, canvas): f64; exprResolveSize(v, natural): f64    // .mzc の値 → 解いた後の画素
exprScenePut(mut scene, layer, slot, v) / exprLayerPut(mut layer, env, slot, v)  // 値を書く（position と x / y を揃える）
exprEnvCompose(mut env, comp, part, lane)                                  // 合成した値（既定で position = [x, y]）
// 評価（コマごと）
exprCtxNew(time, value, index, self): ExprCtx; exprCtxSetCurve(mut ctx, t0, dt, own vals)
exprEval(prog, ctx: ExprCtx, scene: ExprScene): ExprVal                    // exprEvalFull は bad（値に戻したか）も返す
// 画素の式
exprGpuNew(prog): ExprGpu; exprGpuFrame(mut g, prog, ctx, scene); exprApplyPixels(g, mut layer, w, h)
// schema
exprSchemaJson(env) / exprSchemaText(env) / exprProgJson(key, prog)
```

- `ExprEnv`: 値の名前の表（`exprEnvDefault()` + `exprEnvAdd` / `exprEnvAlias` / `exprEnvCompose`）。`ExprScene`: 表・クリップの値（`ExprLayer`。slot ごとに 4 つの f64）・画面。`ExprCtx`: `time`、`value`、`index`、`self`（thisLayer の層の番号）、`keys`、`curve`。
- `exprGpuNew` は、画素の式として使えないもの（`ok` が false、`mode` が画素の式でない、途中の値や変数が kernel の配列を越える）を `n = 0`（層をそのまま残す）にする。
- 名前の前置きは `expr` / `Expr`（公開）、`ex` / `em` / `exprPx`（中だけ）。

## キーフレーム（m6-anim との約束）

m6-anim（ブランチ `m6-anim`、`src/m6_anim/anim.um`）の `AnimTrack` を式に渡す約束。m6-anim の担当と合わせて、両方の文書に書く。

- **`ExprCtx.keys` は利用者が置いたキーだけ**（補間のために分けたキーは入れない）。`numKeys`、`key(n).value / .time`、`loopOut` / `loopIn` のキーの数（`loopOut('cycle', 2)` の 2）と周期の端は、このキーで数える（AE と同じく、利用者が置いたキー）。
  - `ExprKey.t` は**タイムラインの秒** = クリップの始まり（`Clip.at`）+ m6-anim の解いたキーの時刻（`AnimKey.t`。`animResolve` の後なので `end-0.5` も秒になっている）。`time` と同じ基準なので、始まりが 0 でないクリップでもずれない。
  - `ExprKey.v` は `AnimKey.v`（f64[4]）をそのまま（位置は `ANIM_POS` の左上の画素で、上の「座標と目盛り」と同じ約束）。`interp` は値の表がないときの補いだけに使う（`outMode` が hold なら `EXPR_KEY_HOLD`、ほかは `EXPR_KEY_LINEAR` でよい）。
- **ベジェなどの補間は分けない。** `valueAtTime(t)`・`loopOut` / `loopIn`・`wiggle` の時刻の引数は、値を**値の表**（`ExprCtx.curve`）から引く。表は m6-anim の `animEval` で求めた値:
  ```ts
  const t0 = clip.at + track.keys[0].t;                  // タイムラインの秒
  const dt = 1.0 / (fps * 4);                            // コマの 1/4（コマの時刻とキーの時刻は表の格子に乗る）
  const n = Math.ceil((track.keys[last].t - track.keys[0].t) / dt) + 1;
  for (k = 0; k < n; k++) vals.push(...animEval(track, track.keys[0].t + k * dt));   // 4 つずつ
  exprCtxSetCurve(mut ctx, t0, dt, own vals);            // 読んだときに 1 回（毎コマ作らない）
  ```
  表のあいだは直線で補い、表の外は端の値。コマの時刻・キーの時刻・`loopOut` の折り返しが格子に乗る（キーがコマの境目にある）ときは `animEval` の値そのもの。
- `ExprCtx.value` にはそのコマのキーフレームの値（`animEval(track, t - clip.at)`）を入れる。
- `ExprCtx` は式ごとに 1 つ作って使い回し、コマごとには `time` と `value` だけを書き換える（`keys` と `curve` を毎コマ写さない）。
- 同じブランチに入った後は、`ExprCtx` に `AnimTrack` を持たせて `animEval` を直接呼ぶ形（`expr_anim.um` を足す）に置き換えられる（約束は同じ）。
- `loopOut` は最後のキーより後、`loopIn` は最初のキーより前だけを変え、キーのあいだは `value` をそのまま返す。キーが 2 つ未満なら `value`。`cycle` / `offset` は `loopIn` も `loopOut` も同じ式（`tt = ts + mod(t - ts, d)`、周期の数 `floor((t - ts) / d)`）で、周期の境目 `t = ts - k * d` は周期の始まりの値（`offset` なら k 周期ぶん引いた値）。

## 組み込み（結合の担当へ）

既存のファイルは書き換えていない。つなぐ手順:

1. **行の確かめ（`project.um` の `parseProject`）**: 行ごとに `pjTokenize` の前で `exprLineCheck(line, lineNo, mut err)` を呼ぶ。1 つでも出たら、その行の式のキー（`expr(` で始まる値）は読まない（値が空白で切れているため）。`pjTokenize` は変えない。`check --fix` のような直す操作があれば、診断の `suggest`（`exprLineFix(line)`）で行を置き換える。
2. **キー（`pjApplyKey` / `pjApplyFx` / `pjApplyProjectKey`）**: `exprIsValue(val)` か `exprKeyBase(key) != ""` なら、数として読まずに式として扱う。もとのキー（`x`、`blur`、`vignette.radius`）が書ける行かは今までどおり確かめる（`unknown-key` / `key-not-allowed`）。`Clip` に `exprs: ClipExpr[]`（`key`、`base`、`src`、`line`、`vcol`）を足して覚え、`kv` にもそのまま残す。`pixel` はコアのキー（`keys.um` に `{ name: "pixel", kinds: "video,image,text,color,project", type: "string", doc: "画素ごとの式 pixel=\"expr(...)\"（色を返すと a も置き換わる。形を保つなら src.a）" }`）。
3. **解析と結び（`parseProject` の配置の後）**: 場面の表を `exprEnvDefault()` に効果の引数（`fxName(e)` と `fxName(e) + "." + fxParamName(e, k)`）と変形の担当の値（`rotation`、`scale` など）を `exprEnvAdd` して作る。式ごとに `exprParseValue(clip.id, key, val, exprKeyType(base), env, line, vcol)`（値が引用符つきなら `vcol + 1`。project の行は `clip.id` の代わりに `""`）→ `exprLink` → `exprOrder(nodes, progs, env, err)`。診断は `parseProject` の `err` にそのまま足す（`runOps` の「誤りが増えたか」にも自然に入る）。
4. **描画（`render.um` の `renderFrameFrom`）**: `rcFrame` の後、クリップを描く前に:
   - 各クリップの層に、書いた値を**解いた後の画素**で入れる: `exprResolveSize(c.w, 元の幅)`、`exprResolvePos(c.x, w, p.width)` など（`exprScenePut`）。キーフレームのある値はそのコマの `animEval` の値（m6-anim は左上の画素）。
   - `exprOrder` の順に、`ctx.time = t; ctx.value = exprLayerGet(層, slot)` として `exprEvalFull(prog, ctx, scene)` し、結果を `exprScenePut(mut scene, 層, slot, r.v)` で書く（`position` と `x` / `y` が揃う）。
   - `drawVideo` / `drawImage` / `drawColor` / `drawText` と `alpha`（envelope × opacity）は、`Clip` のフィールドの代わりに層の値を読む。位置は `Math.floor(x)` をそのまま左上に使い、**`resolvePos` を通さない**（負は画面の外）。効果の引数は `FxUse.params` を写して上書きしてから `fxApply` に渡す。
   - 画素の式は `applyClipFxTmp` の後に `exprApplyPixels(g, mut layer, w, h)`（効果のないクリップも、画素の式があれば `fxComposite` の層の経路を通す）。project の行の `pixel` は `p.fx` を掛けた後に `exprApplyPixels(g, mut canvas, W, H)`。`ExprGpu` はプロジェクトを読んだ後に 1 回作り、コマごとに `exprGpuFrame` だけを呼ぶ。
5. **キーフレーム（m6-anim）**: 上の「キーフレーム」の約束で `ExprCtx.keys`（利用者のキー、タイムラインの秒）と `exprCtxSetCurve`（`animEval` の値の表）を入れる。`x=<キーフレーム>` はキーフレームの担当が読み、`x.expr` だけをこの部品が読む。
6. **音（`audio.um`）**: `volume` に式があれば、m6-anim と同じく 256 サンプルのブロックの両端の時刻で評価し、ブロックの中は直線で補う。
7. **操作（`ops.um`）**: 新しい操作は要らない（`set title x="expr(wiggle(2, 30))"`、`set title x.expr="wiggle(2, 8)"`、`unset title x.expr`）。`set` の値が `exprIsValue` なら `exprCanonValue` で正規の値にしてから `setKey` に渡す。`schema` の `ops` の例に 1 つ足す。
8. **schema / check（`report.um`）**: `schemaJson` に `"expressions": exprSchemaJson(env)`、`schemaText` の最後に `exprSchemaText(env)`。`projectJson` のクリップに `"exprs": [exprProgJson(key, prog), ...]`。
9. **設計の文書**: `architecture.md` の診断の表に上の 9 つの code を足し、モジュールの表に `m6_expr/*.um` を足す。

## 速さ（Windows 11、RTX 5060 Ti（Vulkan）、24 スレッド。ほかの作業と同時に測ったので幅がある）

| 測ったもの | 値 |
| --- | --- |
| 解析（`ease(...) + [wiggle(2, 30).x * 0, 0]`） | 50〜120 µs / 回（読むときに 1 回だけ） |
| 値の式の評価（`wiggle(2, 30) + clip('title').x * 0.1`） | 120〜170 ns / 回 |
| 画素の式 1080p（vignette の式、18 命令） | CPU 18 ms / GPU 4.3 ms（GPU に置いたまま）/ 25 ms（送りと読み戻しを含む） |
| 画素の式 1080p（noise 2 つ + hsl、31 命令） | CPU 39 ms / GPU 6.7 ms |
| 画素の式 1080p（大きな x の sin / cos 3 つ） | CPU 42 ms / GPU 3.2 ms |
| 画素の式 1080p（全部の演算、189 命令） | CPU 214 ms / GPU 20 ms |

GPU の「送りと読み戻しを含む」は、層を CPU に置いたまま毎コマ往復させた時間。描画の全体を GPU に置けば（`UM_GPU_THRESHOLD`。`architecture.md` の「描画」）、その分はなくなる。

## CPU と GPU を揃えるための注意

- 確かめたのは **NVIDIA の Vulkan（RTX 5060 Ti、wgpu-native v29）だけ**。10 の式で全画素が一致した。ほかのドライバ・Metal（`UM_METAL=1`）では確かめていない。
- NVIDIA の Vulkan で、`(a - b) - c` のような足し算・引き算の並びが `a - (b + c)` と計算され、CPU と 1 ULP 違うことがあった（UM の WGSL は掛け算の FMA へのまとめだけを止めている。`tests/wgpu` の範囲では出ていない）。この部品の kernel では、並びの途中に `exprKeep(v)`（`v * 1.0`。UM が `um_fmul` にするので、ドライバがその先を見通せない）を挟んで止めている。sin / cos の範囲の縮め方も、引くごとに `exprKeep` を挟む。
- WGSL と Metal の既定は NaN と inf がないと仮定してよい（fast math）。そのため `exprAtanF` / `exprLogF` の `x != x`、NaN を丸める `exprPxClamp01`、`exprKeep` の効き目は、ほかのドライバでは保証されない。この GPU では `1 / (uv.x - 0.5)`、負の数の `sqrt` / `log` / `pow`、`1e30 * 1e30` でも全画素一致した。画素の式の `x % 0` は 0 にして、数でない値を作らないようにしてある。
- **UM の担当に頼むこと**: (1) WGSL の出力で足し算・引き算も守る（`um_fadd`。`um_fmul` と同じ形）。(2) kernel で f32 のビットを u32 として読む手段（`bitcast`）。これがあれば、kernel の最後で「指数が全部 1 なら 0」として、ドライバに頼らず NaN と inf の扱いを揃えられる（今は UM に手段がないので、ここではしていない）。
