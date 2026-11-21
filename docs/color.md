# 色の処理（src/color/）

M4（色）の部品。すべて kernel で書き、CPU と GPU（wgpu）で同じ結果になる（`node tests/color/run.mjs --gpu` で全要素を比べている）。
作業の色は **線形の光の値**（`Buffer<vec4<f32>>` の rgb。a はそのまま）で、1.0 が基準の白。

| ファイル | 中身 |
| --- | --- |
| `transfer.um` | 伝達関数（sRGB、BT.709 の OETF、BT.1886、PQ（ST 2084）、HLG（BT.2100、OOTF 込み）、線形）。kernel 用の `colPow` / `colLog2` / `colExp2`。層の `colDecode` / `colEncode`、1 回で「復号 → 行列 → 符号化」する `colConvertKernel` |
| `gamut.um` | 色域（BT.709 / BT.2020 / P3-D65 / DCI-P3）の 3x3 行列を規格の色度から f64 で計算（白が違えば Bradford）。`colGamutMatrix(src, dst, adapt)`、`colApplyMatrix` |
| `ycbcr.um` | YCbCr の行列（601 / 709 / 2020）と範囲（リミテッド / フル）、符号の値との変換、平面の YUV（4:2:0 / 4:2:2 / 4:4:4、8 / 10〜16 ビット）→ RGB の層 |
| `lut.um` | `.cube`（1D と 3D、シェーパー付き、DOMAIN / INPUT_RANGE）の読み取りと診断（`cube-*` のコード、行・列・ヒント・候補）、三線形と四面体の補間、強さ |
| `grade.um` | 色の調整: 色温度と色かぶり、露出、オフセット、リフト・ガンマ・ゲイン（r g b m）、彩度、カーブ（R / G / B / 輝度。単調な 3 次スプライン）、色相ごとの彩度・輝度・色相。`colGradeSet(g, 名前, 値)` で文から設定、`colGradeJson` |
| `scope.um` | スコープ: 波形（輝度 / RGB パレード / RGB 重ね）、ベクトルスコープ（BT.709 の目盛り）、ヒストグラム。結果は表示用の `Buffer<u32>`（0xAARRGGBB） |

## 使い方の例

```ts
// 素材（sRGB の信号）を線形にして、調整して、LUT を掛けて、表示（sRGB）に戻す
colDecode(mut layer, n, COL_TF_SRGB, 203.0);
let g = colGradeNew();
colGradeSet(mut g, "temperature", "3200");     // 失敗なら理由の文が返る（"" は成功）
colGradeSet(mut g, "curve.y", "0:0 0.25:0.2 0.75:0.8 1:1");
const plan = colGradeBake(g);                   // カーブを表に焼く（コマごとに作り直さない）
colGradeApply(mut layer, n, plan);
let diags: ColDiag[] = [];
const lut = colLoadCube("look.cube", mut diags);
colApplyLut(mut layer, n, lut, COL_LUT_TETRAHEDRAL, 1.0);
colEncode(mut layer, n, COL_TF_SRGB, 203.0);
// スコープ（表示の信号で測る）
const wf = colScopeWaveform(layer, w, h, COL_TF_LINEAR, 203.0, COL_YCC_709, COL_WAVE_PARADE, 768, 256, 4.0);
```

## CPU と GPU で同じ結果にするための書き方

wgpu（Vulkan、NVIDIA）のドライバは、kernel の浮動小数点の式を次のようにまとめ直すことがある（UM の WGSL は掛け算の FMA を防いでいるが、足し算と引き算はそのまま）:

- `(a - b) - c` → `a - (b + c)`
- `1.0 - (1.0 - q)` → `q`

このため src/color では、引き算が続く式を初めから `a - (b + c)` の形で書き、`1 - (1 - q)` の形を作らない（`ycbcr.um` の `kg`、`grade.um` の `colRotateHue`）。新しい kernel を足したら `node tests/color/run.mjs --gpu` で確かめる。
