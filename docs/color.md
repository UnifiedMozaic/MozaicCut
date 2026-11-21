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

## 速さ（1920×1080 の 1 コマ、Windows 11、数回のうちの最小）

CPU（複数スレッド）。カッコの中は前の版。

| 処理 | 時間 |
| --- | --- |
| sRGB の復号（表） | 2.1 ms（13.8 ms。正確な式の `colDecodeExact` は今も 12〜13 ms） |
| PQ への符号化（表） | 4.6 ms（30.6 ms） |
| 色の調整（全部の項目、33³ に焼いた LUT） | 13〜14 ms（51 ms。正確な式は 46〜48 ms） |
| 調整を焼く（33³、調整を変えたときだけ） | 2.5〜3.2 ms |
| 1 コマの流れ: 素材を BT.1886 で復号 → 調整 → BT.1886 で符号化 | 25〜27 ms（前の版の部品を足すと約 80 ms） |
| 波形（輝度）/ パレード / ベクトルスコープ / ヒストグラム | 4.4 / 4.3 / 3.0 / 4.7 ms（9.4 / 7.7 / 4.5 / 5.9 ms） |
| sRGB に符号化しながらの波形 | 6.7 ms（19.7 ms） |

GPU（wgpu、RTX 5060 Ti）。スコープの数える kernel を続けて 6 回掛けた最小（数の表の 1 つ目を読むまで）:

| kernel | 今の版 | 前の版 |
| --- | --- | --- |
| 波形（1080p → 512 列） | 1.3〜2.1 ms | 17 ms |
| ヒストグラム | 0.6〜0.8 ms | 11 ms |
| ベクトルスコープ | 1.5〜3.4 ms | 1.8 ms |

前の版の波形とヒストグラムは、グループの 64 スレッドが共有の表へ順番に（barrier を挟んで）足していたので並列にならず、
スレッドごとの 3〜4 KB の配列もレジスタから溢れていた。今の版は、1 スレッドが 1 列の 16 行を上から読み、続く画素が同じビン
なら数をためてから全体の表へ fetchAdd する（ヒストグラムは 64 本の縦の帯ごとの表に数えてから足す。CPU でコアが同じ
キャッシュの行を取り合わないため）。

`--bench` の通しの GPU の数字（`gpu-*`）では、前の段の後始末か何かで、最初に測るスコープに 10 ms ほど乗る（どれを先に
測っても同じ）。kernel の速さはスコープの表（`gpu-scope*`）で見る。sRGB の復号や LUT の GPU の数字（25〜30 ms、9 ms）は、
ほとんどが 33 MB の Buffer の写しで、層を GPU に置いたまま続けて掛ければ速くなる見込み。

## 表と焼いた LUT の誤差（tests/color で上限を決めている）

- 伝達関数の表: 符号化は相対で 3e-5 以下、復号は 1e-4 以下（PQ の復号は 5e-4。PQ の信号に直すと 5e-5 くらい）。
  10 ビットの 1 段（1e-3）よりずっと小さい。BT.709 の逆 OETF は、規格の式が 0.081 で少しだけ不連続なので、その区間は除いて測る。
- 色の調整の LUT（33³）: 画面に出る値（sRGB の信号を 0..1 に収めて）で 5e-3 以下（測ると 3.7e-3。8 ビットの 1 段くらい）。
  なめらかな調整（ホイールとカーブ）と PQ の空間では 1e-3 以下。
  - 正確な式に回す画素: シェーパーで符号化した値が 0..1 の外（SDR で白より明るい、負の値、NaN）と、調整の式が 0 の前後で
    急に曲がるところ（ホワイトバランスの後の線形の値、ガンマの前の値の符号が箱の角で違う）。合成の画で 0.4〜5.6%。
  - 書き出しで正確な式だけを使いたいときは `colGradeBakeWith(g, 0)`。

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

## 組み込みの計画（段階に分ける）

いまの `src/render.um` は、素材（`yuvPixel`。BT.709 の行列、リミテッド、0..1 に収める）、色のクリップ（`drawColor`）、文字、
PAM の画像、効果（`fxApply`）のどれもが **0..1 の信号の値** を前提にしている。合成を線形にすると、これらの見た目がすべて
変わるので、一度に切り替えない。

1. **調整と LUT だけを入れる（見た目は今と同じ）。** 層は今のまま信号の値で持ち、クリップの調整は
   `colDecode(BT.1886) → colGradeApply → colEncode(BT.1886)` を、そのクリップの層にだけ掛ける。LUT は
   `colApplyLut`（層の値をそのまま）で掛ける。`grade` と `lut` の操作（ops.um）、show の JSON、schema はここで入れる。
2. **素材の情報を取る。** `tools/mozcut.mjs` の probe に `stream=color_space,color_transfer,color_primaries,color_range` を足し、
   `cache/probe.txt` に書く（今は `format=duration:stream=codec_type` だけ）。エンジンは `colTfFromFfprobe`、
   `colYccFind`（行列）、`colGamutFind`（原色）、範囲（`tv` → リミテッド、`pc` → フル）を引く。扱えない名前は警告の診断にする。
3. **10 ビットと HDR の素材を展開する。** 10 ビットの素材と、color_transfer が PQ / HLG の素材は、`-pix_fmt yuv420p10le`
   で展開し（今は `decodeArgs` で `yuv420p` に固定）、`colYuv16Decode` で読む。`yuvPixel` の 0..1 に収める処理は外す（白より明るい値を残す）。
4. **合成を線形にする。** 素材は 2 で引いた tf で `colDecodeWith`、色域が違えば `colApplyMatrix(colGamutMatrix(src, 作業の色域, true))`。
   色のクリップ、文字、PAM の画像は sRGB（PAM）/ BT.1886（色の指定）の信号から復号して層に入れる。
   効果（`fxApply`）は、線形でも同じに見えるかを 1 つずつ確かめ、合わないもの（色を直接いじるもの、ぼかしの見た目など）は
   符号化した空間で掛ける（前後で `colEncodeWith` / `colDecodeWith`）。合成（アルファ）は線形になるので、半透明の重なりと
   ディゾルブの見た目が変わる（物理的に正しい側へ）。ここは画の比較の試験を先に用意してから行う。
5. **出口。** 書き出し（`canvasToYuv`。bt709 の印）の直前は BT.1886 で `colEncodeWith`。画面に出す経路は表示の設定
   （BT.1886 / sRGB）で符号化する。HDR の書き出しは、PQ で符号化して `colLayerToYcc444`（BT.2020、10 ビット）にする（その後の段）。

### 各部品との結合

- **import**: 名前はすべて `col` / `Col` で始まる。`src/color/` は main.um / editor.um のフォルダ（`src/`）の中なので、
  `import { ... } from "./color/grade.um";` のように書ける。
- **クリップの調整**（project.um / ops.um）: クリップに grade のキーと値を持たせる（例 `grade temperature=3200 curve.y="0:0 0.5:0.6 1:1"`）。
  読むときは `colGradeNew()` に `colGradeSet(mut g, key, val)` を順に呼び、`""` でない返り値は Diag（例 `grade-bad-value`）にする。
  ops.um には `grade <clip> <key> <value>` を 1 つ足す（失敗したら g は変わらない）。名前の一覧は `COL_GRADE_KEYS`
  （`reset`、`lift.r` のような 1 チャンネルの名前も入っている）、説明は `colGradeKeyDoc(key)` で、schema にそのまま出せる。
  show の JSON には `colGradeJson(g)`。描くときは、クリップごとに `colGradeBake(g)` の結果を持っておく（調整を変えたときだけ作り直す）。
- **LUT**: クリップに `lut=path.cube lutspace=bt1886 lutmix=0.8` を持たせる。`colLoadCube(path, mut diags)` の ColDiag は
  report.um の Diag と同じフィールド（code, severity, line, col, msg, hint, suggest）。文は `colDiagText`、JSON は `colDiagsJson`。
  掛けるのは `colApplyLutIn(mut layer, n, lut, colLutSpaceFind(lutspace), 203.0, COL_LUT_TETRAHEDRAL, lutmix)`
  （計画の 1 の段では `colApplyLut`）。`lutspace` の知らない名前は Diag（例 `lut-bad-space`）にする。
- **スコープ**（editor.um の UI）: 層を `colScopeWaveform` / `colScopeVector` / `colScopeHistogram` に渡すと、`Buffer<u32>`
  （0xAARRGGBB、ui.um と同じ並び）が返るので、パネルの矩形に写す。目安は、波形 512×256・gain 4、パレード 768×256、
  ベクトルスコープは正方形・zoom 1・gain 4、ヒストグラム 512×200。説明の文は `colScopeDoc`。
- **テスト**（tests/run.mjs）: 既存の群に `color` を足し、`node tests/color/run.mjs` を spawnSync で呼んで、終了コード 0 なら通ったとする。
  GPU も試すときは `--gpu`、速さは `--bench`。
- **説明書**: README.md と docs/design/architecture.md の部品の表に、`src/color/`（docs/color.md）への一行を足す。

## CPU と GPU で同じ結果にするための書き方

wgpu（Vulkan、NVIDIA）のドライバは、kernel の浮動小数点の式を次のようにまとめ直すことがある（UM の WGSL は掛け算の FMA を防いでいるが、足し算と引き算はそのまま）:

- `(a - b) - c` → `a - (b + c)`
- `1.0 - (1.0 - q)` → `q`

このため src/color では、引き算が続く式を初めから `a - (b + c)` の形で書き、`1 - (1 - q)` の形を作らない（`ycbcr.um` の `kg`、`grade.um` の `colRotateHue`）。
表を引く位置の計算は 2 の冪を掛けるだけにして、丸めが入らないようにしている（`transfer.um` の `colTabLookup`）。
新しい kernel を足したら `node tests/color/run.mjs --gpu` で確かめる。

NaN の入力: CPU では、HLG の OOTF は NaN のチャンネルだけを 0 にする（ほかのチャンネルは残る）。WGSL は NaN が来ないと
みなしてよいことになっているので、NaN の扱いは GPU では同じとは限らない（試験も NaN は CPU だけで確かめている）。
