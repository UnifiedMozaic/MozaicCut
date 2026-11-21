# エフェクトスクリプト

アプリの中で、UM の kernel の書き方でエフェクトを書く仕組みです（DaVinci Resolve の DCTL や Shadertoy にあたります）。書いたその場でコンパイルされ、プレビューにすぐ反映されます。

- 書き方は **UnifiedMozaic（UM）の `kernel function` そのもの**（その一部）です。UM の kernel を知っていれば、新しく覚えることはほとんどありません。
- アプリに入っている小さなコンパイラ（`src/fxs/`。UM で書いてあります）が、GPU 用の WGSL と CPU 用の wasm を作ります。利用者の PC に Node や clang は要りません。
- **意味は UM 本体の kernel と同じ**です。同じエフェクトを、UM 本体でコンパイルしたもの・WGSL（GPU）・wasm（CPU）のどれで動かしても、同じ画素になるように決めてあります。
- 宣言（先頭の注釈）は、MozaicCut の効果プラグイン（`plugins/*.um`）と同じです。

例は `src/fxs/effects/` に 10 個あります（下の「例の解説」）。

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
| `// @param <名前> <既定値> <最小>..<最大> "<説明>"` | 1〜8 個。書いた順に `p[0]`, `p[1]`, … に入ります。最初が「主の引数」（`glow=1.5` のように名前だけで決まる引数）です。 |
| `// @alias <別名>` | 効果の別名（何個でも）。 |
| `// @reach <引数> [<倍率>]` | 効果が周りへ広がる画素数（引数の値 × 倍率）。ぼかし・ずらし・光のにじみのように、層の外へはみ出す効果に付けます。描画は、透明なまわりのある層（画像・文字）に、この分の透明な余白を足してから効果を掛けます。 |
| `// @whole` | 層の大きさや位置（中心、格子、行の番号）を使う効果に付けます。帯に分けずに、層全体に 1 度に掛けます。 |

数は `-?(数字+(.数字+)? \| .数字+)` で書きます。宣言の誤りは `fx-decl` の診断になります。

## 入口の kernel

ファイルの中で **`mut` の引数を持つ kernel がちょうど 1 つ** あり、それが入口です。ほかの kernel は補助の関数です。

入口の引数の役は **名前と型で決まります**（順番は自由。使わないものは書かなくてかまいません）。

| 引数 | 型 | 中身 |
| --- | --- | --- |
| 最初の `u32` | `u32` | 画素の番号 `i`（0 から `w * h` 未満）。横の位置は `i % w`、縦の位置は `i / w`。 |
| `mut` の層（名前は自由。`out` がおすすめ） | `mut Buffer<vec4<f32>>` | 書く層。実行の前に入力の層が入っています。**読めるのも書けるのも `out[i]` だけ**です。 |
| `src` | `Buffer<vec4<f32>>` | 入力の層の写し（読み取り専用）。**隣の画素はここから読みます。** |
| `src2` | `Buffer<vec4<f32>>` | 2 つ目の入力（トランジションや合成のため。大きさは同じ）。 |
| `w`、`h` | `u32` | 層の幅と高さ（画素）。 |
| `time` | `f32` | 時間（秒）。 |
| `p` | `f32[8]` | `@param` の値。 |

- `src` / `src2` 以外の名前の読み取り専用の層は誤りです（`fx-entry`）。
- 補助の kernel には `src` / `src2` と `p` を渡せます（`mut` の層は渡せません）。

## 書けるもの

UM の kernel と同じです。

- 型: `bool` `i32` `u32` `f32` と、`vec2` / `vec3` / `vec4`（成分は `i32` / `u32` / `f32`）。最上位の定数（`const K: f32 = 0.5;`）と、定数の配列（`const W: f32[3] = [0.25, 0.5, 0.25];`）。
- 文: `const` / `let`、代入と複合代入（`+=` など。`c.x *= 0.5` のような成分への代入も）、`if` / `else`、`for`、`while`、`do ... while`、`break`、`continue`、`return`。
- 式: 四則演算、`%`（整数だけ）、比較、`&&` `||` `!`、ビット演算 `& | ^ ~ << >>`、`? :`、`as`（型の変換）、`vec4(...)`、成分 `.x .y .z .w`。
- ベクトルどうしの `+ - * /` は成分ごとです。**ベクトルと数の組は `v * k` と `v / k`（ベクトルが左）だけ**で、`1.0 - v` や `v + 0.5` は書けません。`vec3(1.0 - v.x, ...)` のように成分で書きます。
- 小数のリテラルは `f32` です。`2 * 0.5` のように文脈のない整数と小数の組は型の誤りになります（`2.0 * 0.5` と書きます）。

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
- sin・exp などは libm を呼ばず、`src/fxs/fxslib.um` の手順（+ − × ÷ と floor などだけ）で計算するので、CPU と GPU で同じ値になるように作ってあります。
- 円周率の名前はありません。`const PI: f32 = 3.14159265;` のように定数にします。

## 決まり（UM 本体の kernel と同じ意味）

止まることはありません。どの実行でも、次の決まった結果になります。

- **範囲外の添字は最後の要素に切り詰めます**（`src[w * h + 5]` は最後の画素）。左や上にはみ出す計算は、負の数が `u32` で大きな数になるので、`Math.clamp` で座標を収めてから読みます。
- **整数のゼロ除算**: `x / 0 = x`、`x % 0 = 0`。i32 の最小値 / −1 = 最小値。
- **シフト量**はビット幅の余り（`x << 33` は `x << 1`）。
- **`f32` から整数への変換**は 0 の方へ切り捨て、範囲外は飽和、NaN は 0。
- 整数の `+ - *` はラップします。
- `f32` の演算は 1 回ごとに丸めます（掛けて足すのを 1 回にまとめません）。
- **ループには回数の上限があります**（1 つのループにつき 65536 回）。超えると抜けます。
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
tint.um:7:13: エラー[type-mismatch]: ...
  ヒント: ...
```

主な原因コード: `syntax`（構文）、`type-mismatch`（型）、`unknown-name` / `unknown-method` / `unknown-field`（近い名前を候補に出します）、`immutable`（書き換えられないものへの代入）、`kernel-restriction`（kernel では使えないもの）、`float-rem`、`literal-range`、`fx-entry`（入口の決まり）、`fx-decl`（宣言）、`always-true`（`u32 >= 0` のような常に真の比較）。1 つの文につき最初の誤りだけを出します。

## 例の解説（`src/fxs/effects/`）

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
node $UM/src/cli.ts build src/fxs/test_effects.um --target host -o fxs_effects && ./fxs_effects
./fxs_effects um-out <フォルダ>

# 画像に掛ける: 生の RGBA（1 画素 4 バイト）の画像を読み、結果を生の RGBA で書くプログラムを作る
node $UM/src/cli.ts build src/fxs/fxs_shots.um --target host -o fxs_shots
./fxs_shots src/fxs/effects/glitch.um h.um in.rgba in2.rgba out.rgba 640 360 1.5 amount=0.8
node $UM/src/cli.ts build h.um --target host -o h && ./h          # CPU
UM_WGPU=1 node $UM/src/cli.ts build h.um --target host -o hg && ./hg   # GPU（wgpu。dispatch は自動で GPU を選ぶ）
```

`fxs_shots` は `fxsCompile` で検査し（診断を出します）、`fxsUmSource` で UM 本体の形にして、`main` を足します。`<引数>=<値>` で `@param` の既定値を上書きできます。

## UM 本体でコンパイルする

エフェクトスクリプトは UM の kernel の書き方そのものですが、`Math.sin` / `cos` / `exp` / `log` / `pow` / `atan2` / `fract` / `mix` / `step` / `smoothstep` / `clamp` は UM 本体の `Math` にまだありません。`fxsUmSource(src)`（`src/fxs/umsrc.um`）が、これらを `fxsLibSin` などに置き換え、標準の関数（`src/fxs/fxslib.um`）を後ろに足します。これらを使っていないエフェクトは、そのまま UM 本体でコンパイルできます。入口の kernel は、UM 本体のプログラムから `dispatch(<入口>, w * h, mut out, src, w, h, time, p)`（引数は入口の並びのとおり）で呼べます。

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
- 補助の kernel の名前には、効果の名前を前に付ける（名前の空間は 1 つ）。
```

- 返ってきたものに診断が出たら、**診断の文をそのまま AI に渡す**と直してもらえます（原因コード・行・列・直し方が入っています）。
- 「既定値で見栄えがするか」は、`fxs_shots` で画像に掛けて確かめます。

## 既知の違い（UM 本体への報告）

- UM 本体の wgpu（`UM_WGPU=1`）で、`Math.sin` / `cos` / `exp`（`fxslib.um` の手順）が、CPU の結果と最後の数ビットで違うことがあります（`sin(-185)` が CPU は −0.34662118（f32 で手順どおり計算した値）、GPU は −0.34662759）。四則演算・`sqrt`・`floor` だけの式は一致します。GPU のシェーダのコンパイラが `(x - a) - b` のような式を並べ替えている（結合の順を変えている）ためと思われます。例のエフェクトで 8 ビットの画素に直すと、crt・halftone・ripple で 1 段の違いが画素の 0.1% 以下に出ます（ほかの 7 個は全画素一致）。
