# エフェクトスクリプト

アプリの中で、UM の kernel の書き方でエフェクトを書く仕組みです（DaVinci Resolve の DCTL や Shadertoy にあたります）。書いたその場でコンパイルされ、プレビューにすぐ反映されます。

- 書き方は **UnifiedMozaic（UM）の `kernel function` そのもの**（その一部）です。UM の kernel を知っていれば、新しく覚えることはほとんどありません。
- アプリに入っている小さなコンパイラ（`src/effects/fxs/`。UM で書いてあります）が、GPU 用の WGSL と CPU 用の wasm を作ります。利用者の PC に Node や clang は要りません。
- **意味は UM 本体の kernel と同じ**です。同じエフェクトを、UM 本体でコンパイルしたもの・WGSL（GPU）・wasm（CPU）のどれで動かしても、同じ画素になるように決めてあります。
- 宣言（先頭の注釈）は、MozaicCut の効果プラグイン（`plugins/*.um`）と同じです。

例は `src/effects/fxs/effects/` に 10 個あります（下の「例の解説」）。

## いちばん小さな例

```ts
// @effect tint "色を付ける"
// @param amount 0.5 0..1 "色を付ける強さ"

kernel function tint(i: u32, out: mut Buffer<vec4<f32>>, p: f32[8]): void {
  const c = out[i];
  const k = p[0];
  out[i] = vec4(Math.mix(c.x, 1.0, k * 0.3), c.y, Math.mix(c.z, 0.2, k), c.w);
}
```

- `out` は、実行の前に **入力の層と同じ中身** が入っています。読んで、書き換えて、結果を残します。
- 層は `Buffer<vec4<f32>>` で、RGBA（0〜1、ストレートアルファ）です。
- 入口の kernel は、層のすべての画素（`w * h` 個の添字 `i`）について 1 回ずつ実行されます。

## 宣言（先頭の注釈）

ファイルの初めから続く `//` の行（と空行）に書きます。効果プラグインと同じ書き方です。

| 宣言 | 意味 |
| --- | --- |
| `// @effect <名前> "<説明>"` | 名前は英小文字・数字・`_`。必須。 |
| `// @param <名前> <既定値> <最小>..<最大> "<説明>"` | 1〜8 個。書いた順に `p[0]`, `p[1]`, … に入ります。最初が「主の引数」（`glow=1.5` のように名前だけで決まる引数）です。**名前は英小文字・数字・`_`**（`shadowTint` ではなく `shadow_tint`）。値は −1000000〜1000000 の中にします。 |
| `// @alias <別名>` | 効果の別名（何個でも）。 |
| `// @reach <引数> [<倍率>]` | 効果が周りへ広がる画素数（引数の値 × 倍率。倍率は 0〜64）。ぼかし・ずらし・光のにじみのように、層の外へはみ出す効果に付けます。描画は、透明なまわりのある層（画像・文字）に、この分の透明な余白を足してから効果を掛けます（512 画素まで。`fxsDeclReach` が 0〜512 に切り詰めて返します）。 |
| `// @whole` | 層の大きさや位置（中心、格子、行の番号）を使う効果に付ける印です。**アプリの中のエフェクトスクリプトでは、`i`・`w`・`h` はいつも層の全体の値なので、付けても付けなくても結果は同じです**（帯に分けて並列に掛けても、どの帯も層の全体を見ます）。意味を持つのは `.mzplug` に書き出したとき（効果プラグインの帯の仕組み）なので、`w` や `i / w` を使う効果には付けておきます。 |

数は `-?(数字+(.数字+)? \| .数字+)` で書きます（`1e5` のような指数の書き方はありません）。宣言の誤りは `fx-decl` の診断になり、名前・既定値・範囲・説明のどこが悪いかを指します。

- 宣言は **ファイルの初めから続く `//` の行**（空行は挟めます）だけを読みます。`/* */` やコードの後ろに書いた `// @param` は読まず、警告（`fx-decl`）を出します。

## 入口の kernel

ファイルの中で **`mut` の引数を持つ kernel がちょうど 1 つ** あり、それが入口です。ほかの kernel は補助の関数です。

入口の引数の役は **名前と型で決まります**（順番は自由。使わないものは書かなくてかまいません）。

| 引数 | 型 | 中身 |
| --- | --- | --- |
| 最初の `u32` | `u32` | 画素の番号 `i`（0 から `w * h` 未満）。横の位置は `i % w`、縦の位置は `i / w`。 |
| `mut` の層（名前は自由。`out` がおすすめ） | `mut Buffer<vec4<f32>>` | 書く層。実行の前に入力の層が入っています。**読めるのも書けるのも `out[i]` だけ**です。 |
| `src` | `Buffer<vec4<f32>>` | 入力の層の写し（読み取り専用）。**隣の画素はここから読みます。** |
| `src2` | `Buffer<vec4<f32>>` | 2 つ目の入力（トランジションや合成のため。大きさは同じ）。**2 つ目の入力がないとき（ふつうの効果として使ったとき）は、どこを読んでも透明（すべて 0）です。** |
| `w`、`h` | `u32` | 層の幅と高さ（画素）。 |
| `time` | `f32` | 時間（秒）。**クリップの始まりからの秒**（アプリがクリップの中の位置を渡します）。 |
| `p` | `f32[8]` | `@param` の値。 |

- `src` / `src2` 以外の名前の読み取り専用の層は誤りです（`fx-entry`）。
- 補助の kernel には `src` / `src2` と `p` を渡せます（`mut` の層は渡せません）。入口の引数（`w`・`time` など）は、補助の kernel からは見えないので、使うなら引数で渡します。
- `@param` の名前（`amount` など）は変数ではありません。値は `p[0]`（書いた順）で読みます。
- **トランジションの進み**（0..1）や長さを受ける専用の引数はありません。`// @param progress 0 0..1 "進み"` のように引数にして、アプリのキーフレームで 0 から 1 へ動かします（`examples/crossfade.fxs`）。
- `time` か `src2` を使う効果は、`.mzplug` には書き出せません（効果プラグインに時間と 2 つ目の入力がないため。書き出すと `export-time` / `export-src2` の誤り）。

## 書けるもの

UM の kernel と同じです。

- 型: `bool` `i32` `u32` `f32` と、`vec2` / `vec3` / `vec4`（成分は `i32` / `u32` / `f32`）。最上位の定数（`const K: f32 = 0.5;`）と、定数の配列（`const W: f32[3] = [0.25, 0.5, 0.25];`）。
- 文: `const` / `let`、代入と複合代入（`+=` など。`c.x *= 0.5` のような成分への代入も）、`if` / `else`、`for`、`while`、`do ... while`、`break`、`continue`、`return`。
- 式: 四則演算、`%`（整数だけ）、比較、`&&` `||` `!`、ビット演算 `& | ^ ~ << >>`、`? :`、`as`（型の変換）、`vec4(...)`、成分 `.x .y .z .w`。
- ベクトルどうしの `+ - * /` は成分ごとです。**ベクトルと数の組は `v * k` と `v / k`（ベクトルが左）だけ**で、`1.0 - v` や `v + 0.5` は書けません。`vec3(1.0 - v.x, ...)` のように成分で書きます。
- ベクトルは **成分を全部並べて作ります**: `vec4(rgb.x, rgb.y, rgb.z, a)`、`vec3(1.0, 1.0, 1.0)`。`vec4(rgb, a)` や `vec3(1.0)` のような作り方と、`.xyz` / `.rgb` のようなまとめ読みはありません。
- 小数のリテラルは `f32` です。`2 * 0.5` のように文脈のない整数と小数の組は型の誤りになります（`2.0 * 0.5` と書きます）。整数の変数と小数を混ぜるときは、**整数の側を `as f32` にします**（`(x as f32) * 0.5`）。小数の側を `as i32` にすると小数部が捨てられます（`0.5 as i32` は 0）。
- **`as` は四則演算より先に効きます**（UM と同じ。TypeScript とは逆）。`x / w as f32` は `x / (w as f32)` です。割った結果を変換するなら `(x / w) as f32` とかっこを付けます。ただし整数どうしの割り算は小数部を捨てるので、`((i % w) / w) as f32` はいつも 0 です。先に変換して `((i % w) as f32) / (w as f32)` と書きます（警告 `int-division`）。
- 入れ子の深さには上限があります（かっこ・ブロックなどの再帰が 256 段、構文木が 512 段。`a + b + c + …` の長い連鎖も段に数えます）。超えると `nesting-too-deep` の誤りです。長い式は途中で `const` に分けます。
- スクリプトの大きさは 256 KB・20000 行までです（`script-too-large`）。

### 使える関数

| 関数 | 説明 |
| --- | --- |
| `Math.sqrt(x)` `Math.floor(x)` `Math.ceil(x)` | `f32`。sqrt は正しく丸めます。 |
| `Math.abs(x)` `Math.min(a, b)` `Math.max(a, b)` | 数（`i32` / `u32` / `f32`）。`min(a, b) = a < b ? a : b`。 |
| `Math.clamp(x, lo, hi)` | `Math.min(Math.max(x, lo), hi)` と同じ。数ならどの型でも。 |
| `Math.sin(x)` `Math.cos(x)` | `f32`。絶対誤差 1e-7 未満（\|x\| が 6000 くらいまで）。 |
| `Math.exp(x)` `Math.log(x)` `Math.pow(x, y)` `Math.atan2(y, x)` | `f32`。exp / log / atan2 は 3 ulp 以内、pow は相対誤差 2e-6 くらい。 |
| `Math.fract(x)` | `x - floor(x)`。 |
| `Math.mix(a, b, t)` | `a * (1 - t) + b * t`。 |
| `Math.step(edge, x)` `Math.smoothstep(e0, e1, x)` | GLSL と同じ。 |
| `Math.popcount(x)` `Math.clz(x)` `Math.ctz(x)` `Math.shl(x, k)` `Math.shr(x, k)` | 整数。 |

- **Math の関数は数だけを受けます**（ベクトルは成分ごとに呼びます）。
- sin・exp などは libm を呼ばず、`src/effects/fxs/fxslib.um` の手順（+ − × ÷ と floor などだけ）で計算するので、CPU と GPU で同じ値になるように作ってあります。
- 円周率の名前はありません（`Math.PI` もありません）。`const PI: f32 = 3.14159265;` のように定数にします。

### よく使う手書き

ないものは、次のように書きます（診断のヒントにも同じ書き方が出ます）。補助の kernel の名前には効果の名前を前に付けます。

| ほしいもの | 書き方 |
| --- | --- |
| 円周率 | 最上位に `const PI: f32 = 3.14159265;` |
| round / trunc | `Math.floor(x + 0.5)` / `(x >= 0.0 ? Math.floor(x) : Math.ceil(x))` |
| sign | `x > 0.0 ? 1.0 : (x < 0.0 ? -1.0 : 0.0)` |
| tan / atan（1 引数） | `Math.sin(x) / Math.cos(x)` / `Math.atan2(x, 1.0)` |
| asin / acos | `Math.atan2(x, Math.sqrt(1.0 - x * x))` / `Math.atan2(Math.sqrt(1.0 - x * x), x)` |
| log2 / exp2 | `Math.log(x) / Math.log(2.0)` / `Math.pow(2.0, x)` |
| length / dot | `Math.sqrt(v.x * v.x + v.y * v.y)` / `a.x * b.x + a.y * b.y + a.z * b.z` |
| 明るさ（luma） | `kernel function fxLuma(c: vec4<f32>): f32 { return 0.2126 * c.x + 0.7152 * c.y + 0.0722 * c.z; }` |
| 色の mix（3 成分） | `kernel function fxMix3(a: vec4<f32>, b: vec4<f32>, t: f32): vec4<f32> { return vec4(Math.mix(a.x, b.x, t), Math.mix(a.y, b.y, t), Math.mix(a.z, b.z, t), a.w); }` |
| 色の clamp（3 成分） | `vec4(Math.clamp(c.x, 0.0, 1.0), Math.clamp(c.y, 0.0, 1.0), Math.clamp(c.z, 0.0, 1.0), c.w)` |
| HSV → RGB | `kernel function fxHsv(h: f32, s: f32, v: f32, k: f32): f32 { const n = Math.fract((k + h * 6.0) / 6.0) * 6.0; return v - v * s * Math.clamp(Math.min(n, 4.0 - n), 0.0, 1.0); }` を `k = 5.0, 3.0, 1.0` で呼んで r, g, b |
| RGB → HSV の明度・彩度 | `const mx = Math.max(c.x, Math.max(c.y, c.z)); const mn = Math.min(c.x, Math.min(c.y, c.z)); const s = mx > 0.0 ? (mx - mn) / mx : 0.0;`（v = mx） |

## 決まり（UM 本体の kernel と同じ意味）

止まることはありません。どの実行でも、次の決まった結果になります。

- **範囲外の添字は最後の要素に切り詰めます**（`src[w * h + 5]` は最後の画素）。左や上にはみ出す計算は、負の数が `u32` で大きな数になるので、`Math.clamp` で座標を収めてから読みます。
- **整数のゼロ除算**: `x / 0 = x`、`x % 0 = 0`。i32 の最小値 / −1 = 最小値。
- **シフト量**はビット幅の余り（`x << 33` は `x << 1`）。
- **`f32` から整数への変換**は 0 の方へ切り捨て、範囲外は飽和、NaN は 0。
- 整数の `+ - *` はラップします。
- `f32` の演算は 1 回ごとに丸めます（掛けて足すのを 1 回にまとめません）。
- **ループには回数の上限があります**（1 つのループにつき 65536 回）。超えると抜けます（GPU が止まらなくならないように。UM 本体には上限がないので、3 通りの比較では UM 本体の版にも同じ数え方を書き足しています）。層の全体を回る `for (k < w * h)` は 720p で 921600 回なので途中で止まります（警告 `loop-limit`）。行と列の 2 重のループ（`for y < h { for x < w }`。それぞれは 65536 回に収まる）に分けます。ただし画素ごとに層の全体を回すと、1 コマに何分もかかります。
- **時間の上限**: プレビューでは 1 コマ 1500 ms、書き出しでは 20 秒です。CPU（wasm）は上限で止まり、層を変えずに理由を返します（同じ引数ではもう掛けません。引数を変えるか、書き出しに切り替えるか、「もう一度試す」でまた試します）。GPU は、最初の小さな塊の時間から 1 コマの時間を見積もり、上限を超えそうなら掛けません。入れ子のループなどで 1 画素の仕事がとても大きいスクリプトは、GPU（時間の上限がなく、2 秒を超えると Windows がデバイスを止める）では掛けず、CPU で掛けます（警告 `gpu-heavy`）。回数が定数で決まるループ（`k < 9`）は、その回数で見積もります。
- エフェクトスクリプトだけの決まり（UM 本体では通るが、ここでは誤り）: `f32` の `%`（`float-rem`。`Math.fract` を使う）、`i64` などの 64 ビットや 8 / 16 ビットの型（`kernel-type`）、`struct`、`out[i]` 以外の `out` の要素を読むこと、`mut` の層を補助の kernel に渡すこと、`i32` に入らない整数のリテラル（`literal-range`）。
- 入口ではない普通の `function`（プラグインの `fx_…`）は、警告を出して読み飛ばします（既存のプラグインを貼り付けられるように）。

### 層の扱いのこつ

- 結果は **0..1 に収めます**（`Math.clamp(v, 0.0, 1.0)`）。
- **色だけを変える効果はアルファを変えません**（`c.w` をそのまま書く）。
- **近くの画素を混ぜる効果は、アルファで重み付けします**: `vec4(c.x * c.w, c.y * c.w, c.z * c.w, c.w)`（プリマルチプライの形）で混ぜ、最後にアルファで割って戻します。そうしないと、透明な画素の見えない色が混ざり、文字の縁が暗くにじみます。
- 乱数は、整数のハッシュ（下の `glitchHash`）で作ります。`time` を `Math.floor(time * fps)` で区切ってハッシュに混ぜると、コマごとに変わり、同じ時間ならいつも同じになります。
- `sin` に渡す値が大きくなりすぎないように、くり返すものは `Math.fract(time / 周期)` で折り返します。

## 診断

誤りは日本語で、原因コード・行・列・直し方つきで出ます（MozaicCut の `Diag` と同じ形）。

```
tint.fxs:7:13: エラー[type-mismatch]: ...
  ヒント: ...
```

主な原因コード: `syntax`（構文）、`type-mismatch`（型）、`unknown-name` / `unknown-method` / `unknown-field`（近い名前を候補に出します。ただし `Math.sign` や `Math.log2` のような、よく知られた関数でエフェクトスクリプトにないものには、綴りの近い別の関数（`Math.sin` など）を勧めず、代わりの書き方を出します）、`immutable`（書き換えられないものへの代入）、`kernel-restriction`（kernel では使えないもの）、`float-rem`、`literal-range`、`fx-entry`（入口の決まり）、`fx-decl`（宣言）、`always-true`（`u32 >= 0` のような常に真の比較）、`nesting-too-deep`（入れ子が深すぎる）、`script-too-large`（大きすぎる）。1 つの文につき最初の誤りだけを出し、行・列の順に並べます。

警告（コンパイルは通ります）: `param-index`（`@param` のない `p[k]` を読む）、`int-division`（整数の割り算の結果を `as f32` にしている）、`fx-no-write`（入口が層に何も書かない）、`loop-limit`（層の全体を回るループ）、`gpu-heavy`（GPU では掛けない重いループ）、`ignored-function`（読み飛ばす普通の関数）、`fx-decl`（注釈の外の宣言）。

## 例の解説（`src/effects/fxs/effects/`）

どれも既定値で見栄えがするように調整してあり、UM 本体でもコンパイルできます（下の「UM 本体でコンパイルする」）。

| ファイル | 効果 | 主な引数 | 使う入力 | 見どころ |
| --- | --- | --- | --- | --- |
| `glitch.um` | グリッチ（帯とブロックのずれ、RGB の割れ、色の入れ替え） | amount, shift, split, block, rate, seed | src, time | 整数のハッシュの乱数。`floor(time * rate)` で乱れ方が切り替わる。横は回り込み。 |
| `chroma.um` | 色収差 | amount, falloff, spread, cx, cy | src | 中心から外向きに赤と青を逆へずらす。4 点の平均でにじませる。双線形の読み取り（プリマルチプライ）。 |
| `crt.um` | ブラウン管 | curve, scan, pitch, bleed, mask, vignette, boost, flicker | src, time | 画面の湾曲、湾曲に沿う走査線、左へ尾を引くにじみ、蛍光体の縦縞、周辺減光、ちらつき。 |
| `halftone.um` | 網点 | size, angle, color, soft, mix | src | CMYK の 4 版を別々の角度の網で。近い 4 つの目の円を見て、隣へはみ出す大きな点も描く。 |
| `kaleido.um` | 万華鏡 | segments, angle, spin, zoom, cx, cy | src, time | `atan2` で角度を出し、扇形の幅で折り返す。層の外は縁で鏡映し。回転は `fract` で 1 回転ごとに折り返す。 |
| `grain.um` | フィルムの粒子 | amount, size, color, fps, seed, shadows | time | 種つきの値のノイズ（一様乱数 3 つの和で正規分布に近づける）。中間の明るさで強く出る。 |
| `glow.um` | グロー | radius, threshold, intensity, knee, warmth | src | 黄金角のらせんで 96 点を読み、明るい所だけをガウス形の重みで平均してスクリーンで重ねる。`@reach radius`。点は回転の漸化式で作り、sin / cos を点ごとに呼ばない。 |
| `posterize.um` | ポスタリゼーション | levels, gamma, dither, mix | なし | ガンマで曲げてから段に丸める。4×4 の Bayer のディザ（定数の配列）。 |
| `edges.um` | 輪郭の検出（ソーベル） | strength, threshold, width, color, blend, invert | src | r, g, b のそれぞれの勾配をまとめる（明るさの同じ赤と緑の境目も出る）。invert で白地に黒い線。 |
| `ripple.um` | 波紋 | amount, wavelength, speed, interval, cx, cy, shade | src, time | 輪の先頭が `speed × t` で広がる。先頭の内側に正弦波、内へ行くほど弱まる。interval ごとに新しい波紋。 |

## 例のエフェクトを試す

作業ツリーの根で:

```sh
UM=C:/Users/mozuku/UnifiedMozaic
# 10 個が fxsCompile で誤りも警告もなく通ることを確かめる（um-out で UM 本体の形も書き出す）
node $UM/src/cli.ts build src/effects/fxs/test_effects.um --target host -o fxs_effects && ./fxs_effects
./fxs_effects um-out <フォルダ>

# 画像に掛ける: 生の RGBA（1 画素 4 バイト）の画像を読み、結果を生の RGBA で書くプログラムを作る
node $UM/src/cli.ts build src/effects/fxs/fxs_shots.um --target host -o fxs_shots
./fxs_shots src/effects/fxs/effects/glitch.um h.um in.rgba in2.rgba out.rgba 640 360 1.5 amount=0.8
node $UM/src/cli.ts build h.um --target host -o h && ./h          # CPU
UM_WGPU=1 node $UM/src/cli.ts build h.um --target host -o hg && ./hg   # GPU（wgpu。main が gpu.prefer(true) で GPU を選ぶ）
```

`fxs_shots` は `fxsCompile` で検査し（診断を出します）、`fxsUmSource` で UM 本体の形にして、`main` を足します。`<引数>=<値>` で `@param` の既定値を上書きできます。エフェクトは `.um` でも `.fxs` でもかまいません（`./fxs_shots src/effects/fxs/examples/vignette.fxs ...`）。

入出力は生の RGBA（1 画素 4 バイト、幅 × 高さ。ヘッダなし）です。ImageMagick なら次のように作り、見ます:

```sh
magick in.png -resize 640x360! -depth 8 rgba:in.rgba     # PNG → 生の RGBA（大きさをそろえる）
magick -size 640x360 -depth 8 rgba:out.rgba out.png      # 生の RGBA → PNG
```

## 3 通りの実行の一致（結合の試験）

同じエフェクトを (1) UM 本体でコンパイルした kernel（`fxsUmSource` の形。CPU。基準）、(2) エフェクトスクリプトの WGSL（GPU）、(3) エフェクトスクリプトの wasm（CPU。wasmtime）で 1280x720 の画像に掛け、出力の層を f32 のビットで比べます。(2) と (3) はアプリと同じ経路（`fxsProgramBuild` → `fxsApply`）です。

```sh
bash src/effects/fxs/test_three.sh            # 例の 10 個と examples/*.fxs 6 個。結果は build/fxs-three/<名前>/out.txt と result.txt
BIG=1 bash src/effects/fxs/test_three.sh glow # 1920x1080 でも測る
./build/fxs_three diag                # 誤りのあるスクリプトの診断を並べて出す
```

引数の組 5 つ（既定・最小・最大・乱数 2 組）× 時間 3 つ（0、1.37、7.9 秒）の 15 通りで比べます。あわせて、**特別な値の画像**（NaN・±無限大・±0・非正規化数・飽和の境目（`0x4effffff` など）と乱数のビットを混ぜた 256x256）で、引数 3 組 × 時間 2 つの 6 通りを、非正規化数なしの組とありの組に分けて比べます。非正規化数ありの組は、GPU だけ既知の違い（下の「既知の違い」）として数え、合否には入れません。`testdata/three_*.fxs` の 3 つは、意味の境目（計算した値の `e - e`、ループの回数の上限、大きな定数の表）の試しです。

結果は下の「一致の表」のとおりです。超越関数（`Math.sin` など）も、標準の関数を + - * / と floor などだけで書き、WGSL の出力が FMA や並べ替えを防いでいるので、GPU でも同じビットになります。**ただし GPU は非正規化数を 0 に潰すので、非正規化数が入力にあるか途中で生まれる計算では、GPU だけ違います**（wasm はどの入力でも UM 本体とビットまで一致します）。

### 一致の表

違う値（f32 のビットが違う成分の数。NaN どうしは同じとみなす）。2026-11-22、Ryzen 9 3900X・RTX 5060 Ti・Vulkan。「非正規化数なし」の GPU の違いは、すべて「UM 本体の出力が非正規化数、GPU の出力が 0」の組です（途中で生まれた非正規化数が 0 に潰れたもの）。**非正規化数の出ない入力・計算では、19 個すべてが 3 通りでビットまで一致します。** wasm は、非正規化数を含むすべての入力で一致しました。

| 効果 | 720p・15 通り GPU / wasm | 1080p GPU / wasm | 特別な値（非正規化数なし）GPU / wasm | 特別な値（非正規化数あり）GPU（既知の違い）/ wasm | 1 コマ 720p（ms）UM 本体 / WGSL / wasm |
|---|---|---|---|---|---|
| chroma | 0 / 0 | 0 / 0 | 0 / 0 | 32208 / 0 | 15.1 / 27.5 / 84 |
| crt | 0 / 0 | 0 / 0 | 0 / 0 | 11721 / 0 | 18.6 / 28.9 / 112.7 |
| edges | 0 / 0 | 0 / 0 | 0 / 0 | 15284 / 0 | 2.5 / 27.1 / 41 |
| glitch | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 2.6 / 31 / 42.9 |
| glow | 0 / 0 | 0 / 0 | 0 / 0 | 74884 / 0 | 222.8 / 32.8 / 748.8 |
| grain | 0 / 0 | 0 / 0 | 0 / 0 | 34478 / 0 | 7.5 / 14.8 / 53.1 |
| halftone | 0 / 0 | 0 / 0 | 0 / 0 | 61050 / 0 | 46.9 / 29.9 / 201.2 |
| kaleido | 0 / 0 | 0 / 0 | 0 / 0 | 28679 / 0 | 5.3 / 28.7 / 43.9 |
| posterize | 0 / 0 | 0 / 0 | 0 / 0 | 60638 / 0 | 11.2 / 14.4 / 46.4 |
| ripple | 0 / 0 | 0 / 0 | 43（すべて出力の非正規化数↔0。43） / 0 | 53472 / 0 | 4.3 / 31.3 / 45 |
| vignette | 0 / 0 | 0 / 0 | 0 / 0 | 107142 / 0 | 1.1 / 16.6 / 25.9 |
| wave | 0 / 0 | 0 / 0 | 0 / 0 | 153308 / 0 | 1.3 / 29.1 / 35.8 |
| crossfade | 0 / 0 | 0 / 0 | 0 / 0 | 217804 / 0 | 1.1 / 14.6 / 40.5 |
| kitchen | 0 / 0 | 0 / 0 | 0 / 0 | 55464 / 0 | 10.6 / 34.5 / 74.1 |
| semantics | 0 / 0 | 0 / 0 | 2385（すべて出力の非正規化数↔0。2385） / 0 | 101807 / 0 | 7.4 / 31.6 / 82.1 |
| edge | 0 / 0 | 0 / 0 | 1074（すべて出力の非正規化数↔0。1074） / 0 | 49860 / 0 | 1.5 / 30.3 / 35 |
| three_nanfold | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 1.2 / 32.9 / 64.6 |
| three_loop | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 1.2 / 90.3 / 49.7 |
| three_table | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 1 / 27.7 / 30.9 |


1 コマの時間（ミリ秒、15 回の中央値。Ryzen 9 3900X・RTX 5060 Ti・Vulkan。WGSL と wasm は層の写し・転送を含む）:

| 効果（720p / 1080p） | UM 本体（CPU 全コア） | WGSL（GPU） | wasm（アプリの経路、帯は自動） | wasm（帯 1） |
|---|---|---|---|---|
| vignette | 0.9 / 1.8 | 14 / 29 | 22 / 46 | 30 / 65 |
| glitch | 2.2 / 5.4 | 27 / 56 | 38 / 78 | 85 / 163 |
| crt | 17 / 38 | 29 / 54 | 104 / 213 | 489 / 1086 |
| halftone | 41 / 95 | 28 / 61 | 188 / 411 | 1139 / 2401 |
| glow | 199 / 441 | 28 / 56 | 670 / 1477 | 4221 / 9147 |

- GPU の時間はほぼ転送です（src を使う効果は層を 2 つ送るので 720p で約 28 ms、使わない効果は約 14 ms）。重い効果ほど GPU が有利です。
- 文字を変えてから、新しい版で掛けられるようになるまで（`fxsLiveSetText`。コンパイルと gpu.loadKernel / wasmtime の読み込み）は 18〜42 ms です。内訳は字句〜IR が 16〜31 ms、WGSL が 0.2〜2 ms、wasm が 0.2 ms 以下です。

## UM 本体でコンパイルする

エフェクトスクリプトは UM の kernel の書き方そのものですが、`Math.sin` / `cos` / `exp` / `log` / `pow` / `atan2` / `fract` / `mix` / `step` / `smoothstep` / `clamp` は UM 本体の `Math` にまだありません。`fxsUmSource(src)`（`src/effects/fxs/umsrc.um`）が、これらを `fxsLibSin` などに置き換え、標準の関数（`src/effects/fxs/fxslib.um`）を後ろに足します。これらを使っていないエフェクトは、そのまま UM 本体でコンパイルできます。入口の kernel は、UM 本体のプログラムから `dispatch(<入口>, w * h, mut out, src, w, h, time, p)`（引数は入口の並びのとおり）で呼べます。

## AI に頼むとき

次のように頼むと、そのまま動くものが返ってきやすくなります。

```
MozaicCut のエフェクトスクリプト（docs/effect-script.md）で、<作りたい効果> を書いてください。
- UM の kernel の書き方。入口は mut の層を持つ kernel 1 つ。引数は名前で役が決まる
  （最初の u32 が i、mut Buffer<vec4<f32>> が out、src / src2 は読み取り専用の層、w・h は u32、time は f32、p は f32[8]）。
- 先頭に // @effect、// @param（既定値で見栄えがするように。8 個まで）、必要なら @reach / @whole。
- out から読めるのは out[i] だけ。隣の画素は src から、座標を Math.clamp で収めて読む。
- Math の関数は数だけを受ける。ベクトルと数は v * k と v / k だけ（1.0 - v や v + 0.5 は書けない）。f32 の % はなく Math.fract を使う。
  2 * 0.5 のような整数と小数の組は 2.0 * 0.5 と書く。struct・i64・文字列は使えない。
- 色は 0..1 に収め、色だけを変えるならアルファはそのまま。近くを混ぜるならプリマルチプライで混ぜる。
- 補助の kernel の名前には、効果の名前を前に付ける（名前の空間は 1 つ）。main という名前は使わない。
- as は四則演算より先に効く（x / w as f32 は x / (w as f32)）。整数を小数にするときは、割る前に as f32 にする。
- vec4 は成分を 4 つ並べて作る（vec4(rgb, a) や .xyz はない）。round・sign・tan・PI などはないので手で書く。
- @param の名前は英小文字・数字・_。値は p[k] で読む。
```

- 返ってきたものに診断が出たら、**診断の文をそのまま AI に渡す**と直してもらえます（原因コード・行・列・直し方が入っています）。
- 「既定値で見栄えがするか」は、`fxs_shots` で画像に掛けて確かめます。

## 既知の違い（UM 本体への報告）

- **非正規化数（絶対値が約 1.18e-38（2^-126）未満の、0 でない f32）は、GPU（NVIDIA の Vulkan）では + - * の入力と結果で 0 になります**（Vulkan の仕様で許されている動きです）。UM 本体と wasm は IEEE のとおり非正規化数を残します。このため、非正規化数が入力にある画素や、途中で非正規化数が生まれる計算では、ふつうの大きさの結果も GPU だけ違ってきます。例:
  - `c` が最小の正規化数（`0x00800000`）のとき `2.0 * c - c / 3.0` は、UM 本体と wasm が `0x00d55555`、GPU が `0x01000000`（割り算は非正規化数を正しく返すが、続く引き算で潰れる）。
  - リテラルの `1.0e-45 * 1.0e10` は、UM 本体と wasm が `0x059502f9`、GPU が 0。
  - 最大の非正規化数 + `d.x` は、`0x80ffffff` と `0x80800000` のように違います。
  - GPU の中でも、割り算・平方根・比較・`Math.min` / `max`・`Math.abs`・符号反転は非正規化数を残し、+ - * だけが潰します。

  ふつうの画像（0〜1 の色）では非正規化数は出ないので、画素は一致します。とても小さな値を扱う計算（`1e-30` を掛けるなど）を GPU と CPU で揃えたいときは、先に `Math.max(x, 1.0e-30)` などで小さすぎる値を避けます。UM 本体の WGSL の出力（`src/wgsl.ts`）にも同じ違いがあります。
- UM 本体の wgpu（`UM_WGPU=1`。UM 本体の `src/wgsl.ts` の出力）で、`Math.sin` / `cos` / `exp`（`fxslib.um` の手順）が、CPU の結果と最後の数ビットで違うことがあります（`sin(-185)` が CPU は −0.34662118（f32 で手順どおり計算した値）、GPU は −0.34662759）。四則演算・`sqrt`・`floor` だけの式は一致します。GPU のシェーダのコンパイラが `(x - a) - b` のような式を並べ替えている（結合の順を変えている）ためと思われます。例のエフェクトで 8 ビットの画素に直すと、crt・halftone・ripple で 1 段の違いが画素の 0.1% 以下に出ます（ほかの 7 個は全画素一致）。
- これは UM 本体の WGSL の出力の課題で、エフェクトスクリプトの WGSL（`src/effects/fxs/wgsl.um`）は f32 の + - * の結果を実行時の 0 と OR して並べ替えを防いでいるので、上の「3 通りの実行の一致」のとおり CPU とビットまで一致します。UM 本体の `src/wgsl.ts` にも同じ工夫を入れるのがよいと思います。
- Direct3D 12（`UM_WGPU_BACKEND=dx12`）では、途中に NaN・無限大・-0 が出る式で CPU と合わないことがあります（examples の kitchen・semantics）。既定の Vulkan を使ってください。
- **GPU のドライバが `e - e` を 0 に畳む**ことがありました（NVIDIA の Vulkan。WGSL は実行時の NaN・無限大がないと仮定してよい決まりのため）。エフェクトスクリプトの WGSL は、+ - * の左・右・結果を別々の実行時の 0 と OR して、`e` が無限大・NaN のとき NaN を返すようにしています（`testdata/three_nanfold.fxs` で確かめます）。UM 本体の `src/wgsl.ts` の `um_fmul` は結果だけを隠すので、同じ問題が起きえます。
- **最上位の定数の配列を WGSL のモジュールの `const` にすると、動的な添字で読むたびにドライバが表を丸ごと写し**、4096 要素の表で 1 回目の実行に 0.8 秒、16384 要素で GPU のデバイスが失われました（そのあと次の submit で wgpu-native が panic してアプリが落ちます）。エフェクトスクリプトの WGSL は、表を binding 4 の Buffer（`b_tbl`）で渡すようにしました。UM 本体の `docs/wgpu.ja.md` の「最上位の定数の配列は使えます」（`src/wgsl.ts` の出力）にも同じ危険があります。
- UM 本体への提案: デバイスが失われたことを知らせる callback を登録し、失われたあとは `gpu.runKernel` / `gpu.loadKernel` が false / null を返すようにする（いまは次の submit で Rust の panic になる）。`gpu.freeKernel` を足す（ライブの再読み込みのたびにシェーダのモジュールとパイプラインが残る。エフェクトスクリプトの側では、同じ WGSL の kernel を使い回して増え方を抑えています）。

## アプリへの組み込み（つなぎの手引き）

- **コンパイルはメインのスレッドの外で**: `fxsProgramBuild`（GPU の `gpu.loadKernel` を含む）は、大きなスクリプトでは数百ミリ秒かかります。別のスレッドで作り、できたものを掛ける側に渡して差し替えます。編集欄から渡すときは、1 文字ごとにコンパイルせず `fxsLiveEdit(live, text, now)` で渡し、`fxsLivePoll` が最後の変更から 300 ms たったところでコンパイルします。
- **時間の上限**: プレビューは `fxsProgramSetTimeout(prog, FXH_PREVIEW_TIMEOUT_MS)`、書き出しは `FXH_TIMEOUT_MS`（20 秒）にしてから掛けます。上限を変えると、時間切れの印も消えます。
- **GPU の呼び方**（`gpu.runKernel`）: `gpu.runKernel(k, count, mut out, src, src2, tbl, w, h, time, p, base)`。`tbl` は `fxsWgslTable(ir)` を入れた `Buffer<u32>`（`FxsProgram.gpuTable`）、`base` から `count` 個の画素を掛けます。`fxsApply` はこれを塊に分けて呼びます。
- **@reach**: `render.um` の `clipFxReach` につなぐときは、`fxsDeclReach(decl, p)`（0〜512 に切り詰めた値）を使います。足し合わせる側も、足す前に 1 つずつ切り詰めるか i64 で足します。
