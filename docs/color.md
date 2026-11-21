# 色の処理（src/color/）

M4（色）の部品。すべて kernel で書き、CPU と GPU（wgpu）で同じ結果になる（`node tests/color/run.mjs --gpu` で全要素を比べている）。
作業の色は **線形の光の値**（`Buffer<vec4<f32>>` の rgb。a はそのまま）で、1.0 が基準の白。

| ファイル | 中身 |
| --- | --- |
| `transfer.um` | 伝達関数（sRGB、BT.709 の OETF、BT.1886、PQ（ST 2084）、HLG（BT.2100、OOTF 込み）、線形）。kernel 用の `colPow` / `colLog2` / `colExp2`。層の `colDecode` / `colEncode`（表で速く。`colDecodeExact` は正確な式）、ffprobe の名前を引く `colTfFromFfprobe`、1 回で「復号 → 行列 → 符号化」する `colConvertKernel` |
| `gamut.um` | 色域（BT.709 / BT.2020 / P3-D65 / DCI-P3）の 3x3 行列を規格の色度から f64 で計算（白が違えば Bradford）。`colGamutMatrix(src, dst, adapt)`、`colApplyMatrix` |
| `ycbcr.um` | YCbCr の行列（601 / 709 / 2020）と範囲（リミテッド / フル）、符号の値との変換、平面の YUV（4:2:0 / 4:2:2 / 4:4:4、8 / 10〜16 ビット）→ RGB の層 |
| `lut.um` | `.cube`（1D と 3D、シェーパー付き、DOMAIN / INPUT_RANGE）の読み取りと診断（`cube-*` のコード、行・列・ヒント・候補）、三線形と四面体の補間。掛けるのは `colApplyLutIn`（LUT の入力の空間を指定し、1D → 3D → 強さで混ぜるまでを 1 回で） |
| `grade.um` | 色の調整: 色温度と色かぶり、露出、オフセット、リフト・ガンマ・ゲイン（r g b m）、彩度、カーブ（R / G / B / 輝度。単調な 3 次スプライン）、色相ごとの彩度・輝度・色相。`colGradeSet(g, 名前, 値)` で文から設定、`colGradeJson`。`colGradeBake` が全体を 33³ の LUT に焼き、コマごとは LUT を引くだけ |
| `scope.um` | スコープ: 波形（輝度 / RGB パレード / RGB 重ね）、ベクトルスコープ（BT.709 の目盛り）、ヒストグラム。結果は表示用の `Buffer<u32>`（0xAARRGGBB） |

## 信号と線形（どの伝達関数で読むか）

- 動画の素材の伝達関数は **`colTfFromFfprobe(ffprobe の color_transfer)`** で引く（`colTfFind` は使わない）。
  - SDR（`bt709` / `smpte170m` / `bt2020-10` / `bt2020-12` / `unknown` / 空 など）は **BT.1886**（γ 2.4。表示を基準にした復号）。
    ffprobe の `bt709` を `COL_TF_BT709`（カメラの逆 OETF）で読むと、シーンの光になり、sRGB で戻すと白っぽく浮く（信号 0.5 が 0.55、0.1 が 0.16 になる）。
  - `smpte2084` → PQ、`arib-std-b67` → HLG、`iec61966-2-1` → sRGB、`linear` → 線形。
  - 扱えないもの（`log100` など）は `COL_TF_COUNT`。呼ぶ側で警告を出し、BT.1886 として読む。
- `colDecode` / `colEncode` は、知らない tf（`>= COL_TF_COUNT`）を受け付けず、理由の文を返す（層は変えない）。成功なら `""`。
- 往復で元に戻すこと: SDR の素材は BT.1886 で復号し、書き出し（bt709 の印を付ける）の直前も **BT.1886** で符号化する。
  画面に出す経路だけは、表示の設定で選ぶ（BT.1886 なら今の見た目と同じ。sRGB の画面に測色的に合わせるなら sRGB）。

## 使い方の例

```ts
// 素材（SDR。ffprobe の color_transfer = bt709）を線形にして、調整して、LUT を掛けて、書き出し用に戻す
const tf = colTfFromFfprobe("bt709");            // COL_TF_BT1886
const tab = colTfTabNew(tf, 203.0);               // 表はクリップごとに作っておく
let e = colDecodeWith(mut layer, n, tab);         // "" なら成功
let g = colGradeNew();
colGradeSet(mut g, "temperature", "3200");       // 失敗なら理由の文が返る（"" は成功）
colGradeSet(mut g, "curve.y", "0:0 0.25:0.2 0.75:0.8 1:1");
const plan = colGradeBake(g);                     // 調整を変えたときだけ作り直す（33³ の LUT とカーブの表）
colGradeApply(mut layer, n, plan);
let diags: ColDiag[] = [];
const lut = colLoadCube("look.cube", mut diags);
// ふつうの .cube は Rec.709 の表示の信号（0..1）を入力に作られているので、BT.1886 の空間で掛ける
e = colApplyLutIn(mut layer, n, lut, colLutSpaceFind("bt1886"), 203.0, COL_LUT_TETRAHEDRAL, 0.8);
e = colEncodeWith(mut layer, n, tab);             // 書き出し（bt709 の印）
// スコープ（表示の信号で測る。層が線形なら tf を渡すと、表で符号化しながら数える）
const wf = colScopeWaveform(layer, w, h, COL_TF_LINEAR, 203.0, COL_YCC_709, COL_WAVE_PARADE, 768, 256, 4.0);
```

LUT を掛ける空間（`colLutSpaceFind`）: `bt1886`（既定。`rec709` / `bt709` も同じ）、`srgb`、`pq`（HDR10 用の LUT）、`hlg`、
`linear`（層の値をそのまま入れる）。SDR の空間で掛けると、白より明るい値は LUT の範囲の端（1.0）に収まる（LUT の性質）。
HDR の素材には PQ 用の LUT を `pq` で掛ける。カメラの Log（S-Log3、LogC など）用の LUT は、その Log の伝達関数をまだ
持たないので扱えない（`colLutSpaceFind("slog3")` は `COL_TF_COUNT`）。

強さ（`amount`、0..1）は 1D と 3D の両方に効き、元の色（1D を通す前）と LUT の入力の空間で混ぜる。`amount <= 0` は何もしない。

## CPU と GPU で同じ結果にするための書き方

wgpu（Vulkan、NVIDIA）のドライバは、kernel の浮動小数点の式を次のようにまとめ直すことがある（UM の WGSL は掛け算の FMA を防いでいるが、足し算と引き算はそのまま）:

- `(a - b) - c` → `a - (b + c)`
- `1.0 - (1.0 - q)` → `q`

このため src/color では、引き算が続く式を初めから `a - (b + c)` の形で書き、`1 - (1 - q)` の形を作らない（`ycbcr.um` の `kg`、`grade.um` の `colRotateHue`）。
表を引く位置の計算は 2 の冪を掛けるだけにして、丸めが入らないようにしている（`transfer.um` の `colTabLookup`）。
新しい kernel を足したら `node tests/color/run.mjs --gpu` で確かめる。

NaN の入力: CPU では、HLG の OOTF は NaN のチャンネルだけを 0 にする（ほかのチャンネルは残る）。WGSL は NaN が来ないと
みなしてよいことになっているので、NaN の扱いは GPU では同じとは限らない（試験も NaN は CPU だけで確かめている）。
