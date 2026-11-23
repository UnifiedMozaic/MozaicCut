# シェイプレイヤー（M6）

ベクターの図形を描くクリップ（After Effects のシェイプレイヤーに当たるもの）。コードは `src/effects/shape/`、試しは `tests/m6-shape/`（`node tests/m6-shape/run.mjs [--bench]`）。

## .mzc での書き方

```
shape star points=5 r=180 inner=80 fill=linear(#ffd040,#ff6020) stroke=#202020 strokew=6 join=round at=1 dur=4
shape rect x=-48 y=48 w=480 h=270 radius=32 fill=none stroke=white strokew=8 dash=24,12 cap=round drawon=1.5
shape path d="M -200 0 C -100 -150 100 150 200 0" fill=none stroke=#00c0ff strokew=10 cap=round trimend=0.6 dur=2
shape ellipse pos=960,540 w=40 h=40 anchor=0,-200 repeat=12 repeatrot=30 repeatopend=0.2 fill=radial(white,#3060ff)
```

- 行の 2 番目は形の種類: `rect`（角丸の四角）/ `ellipse` / `polygon` / `star` / `path`（SVG の `d`）。`shape=` でも書ける。
- **位置 `x` / `y` はほかのクリップと同じ意味**（コアのキー）。形の箱（変形の前の形を拡大し、線の太さの半分を足した箱。回転・リピーターは含まない）の左上を置く。負の数は箱の右端・下端を、画面の右端・下端からその分だけ内側に収める。`center`（既定）は箱を画面の中央に置く。
- **`pos=x,y`** は After Effects の位置と同じく、`anchor`（形の中の点。既定 0,0 = rect / ellipse / polygon / star の中心）を画面のその点に置く。書けば `x` / `y` より優先する。リピーターの輪のように「回す中心」を画面の点に置くときに使う。
- 時間（`at` / `dur`）・`opacity`・`fade`・`id`・`track`・効果（`blur=2` など）は、ほかのクリップと同じコアのキー。長さは text / color / image と同じく、`dur` を省けば 5 秒。
- 色の書き方はコア（text / color の行）と同じ（`text.um` の `parseColor` を使う）: 名前（white black red green blue yellow gray transparent）、`#rrggbb`、`#rrggbbaa`。
- `fill=linear(#ff0000, #0000ff)` のようにコンマのあとに空白を入れるときは、値を `"..."` で囲む（囲まないと行が空白で分かれ、空白のあとの `#` は注釈の始まりとして読まれる）。囲めば項目の前後の空白は読み飛ばす（グラデーション・`dash`・点の値）。
- 割合は 0..1（コアの `opacity` と同じ）。角度は度で時計回り。長さは形の中の画素。

| キー | 型 | 既定 | 意味 |
| --- | --- | --- | --- |
| `w` `h` | 数 | 200 | rect / ellipse の大きさ |
| `radius` | 数 | 0 | rect の角の丸み（幅・高さの半分まで） |
| `sides`（`points`） | 整数 3..1000 | 5 | polygon の辺の数、star の先の数 |
| `r` / `inner` | 数 | 100 / r の半分 | polygon・star の外の半径、star の内の半径 |
| `d` | 文字 | | path のデータ（M L H V C S Q T A Z。小文字は相対。座標の絶対値は 1000000 まで） |
| `fill` / `stroke` | 塗り | white / none | 色、`none`、`linear(色,色@位置,…)`、`radial(…)`（8 色まで。位置 0..1、省けば等間隔） |
| `fillfrom` `fillto` / `strokefrom` `stroketo` | x,y | 形の箱から | グラデーションの始まりと終わり（円形は中心と半径の先）。形の中の座標なので、形と一緒に回る |
| `fillrule` | nonzero / evenodd | nonzero | 重なりの塗り方 |
| `strokew` | 数 | 4 | 線の太さ |
| `cap` / `join` / `miter` | butt·round·square / miter·round·bevel / 1..100 | butt / miter / 4 | 端・角・尖らせる限度 |
| `dash` / `dashoffset` | on,off,… / 数 | | 破線（`dash=0,20 cap=round` で点線） |
| `trimstart` `trimend` `trimoffset` | 0..1 / 0..1 / 数 | 0 / 1 / 0 | パスのトリム。offset は 1 で 1 周（After Effects の Offset の度 ÷ 360） |
| `trimmode` | each / all | each | パスごとに切るか、全部を 1 本として切るか |
| `drawon` / `drawoff` | 時間 | 0 | 始めの N 秒で線を描いていく・最後の N 秒で消していく（トリムを ease で動かす） |
| `pos` | x,y | | anchor を置く画面の点（書けば x / y より優先） |
| `anchor` `rotation` `scale` | x,y / 度 / 倍率（`1.5` か `1.5,0.8`） | 0,0 / 0 / 1 | 変形（anchor を中心に拡大してから回転） |
| `repeat` `repeatx` `repeaty` `repeatrot` `repeatscale` | | 1 / 0 / 0 / 0 / 1 | リピーター（写しごとに anchor を中心に足していく。1000 まで） |
| `repeatopstart` `repeatopend` `repeatorder` | 0..1 / above·below | 1 / 1 / above | 写しの不透明度と重ね順 |

### After Effects と同じにしたこと

- パスの始まりと向き（トリム・破線・`drawon` が進む向き）: rect は**右上の角**（角丸なら右上の弧の終わり）から下へ、ellipse / polygon / star は真上から、どれも時計回り。
- 塗り → 線の順に描き、トリムは塗りにも効く。破線は線だけ。
- 変形は線にも掛かる: トリム・破線・線の輪郭を形の中の座標で作ってから変形する。`scale=1,0.5` の円は、上下の線が左右の半分の太さになる。破線の長さも形の中の長さ。
- 閉じたパスの破線で、最後の破線と最初の破線がどちらも続いていれば 1 本につなぐ（継ぎ目の角にも join が掛かる）。

### 知っておくこと

- **同じ線の部品が重なる所の端（conflation）**: 線は輪郭を非ゼロで塗るので、同じ形の中で線の部品が重なり（破線の点の重なり、折り返すパス、自分と交わる曲線）、その端が同じ画素を通ると、端の画素のアンチエイリアスの割合が足されて少し濃くなる（例: 同じ線を 2 本重ねると、端の行のアルファが 0.5 でなく 1.0）。中が穴になることはない。多くのアナリティックな塗り（ブラウザの Canvas など）と同じふるまい。曲線を折った折れ線の内側の角は、ずらした線の交わる点でつなぐので、ふつうの曲線ではこれが起きない（円の線の面積は π(55² − 45²) と 0.1% 以内で合う）。
- **画面の外**: 画面（と効果の余白）から完全に外れた写しは作らない。一部だけ外れる写しは、外の区間の破線と線の輪郭を作らない（破線の位相は長さで進めるので、見える部分は変わらない）。
- **破線の数の上限**: 画面に見える破線が 20 万本を超えたら実線で描き、`ShapeCache.notes`（`ShapeScene.notes`）に日本語の知らせを残す。render はこれを警告として出す。

## 診断

`shapeParse` が `ShDiag { code, key, keyIndex, col, msg, hint }` を返す（設定だけなら `shapeParseSpec`）。code は既存の `bad-number`（有限でない数も）`bad-color`（塗りとグラデーションの書き方の誤りも）`bad-enum`（形の種類も）`bad-time` `out-of-range`（座標・点・破線の長さの絶対値が 1000000 を超えるもの、パスの座標も）`key-not-allowed`（path でない形の `d`）と、新しい **`bad-path`**（パスのデータが読めない。`col` は値の中の文字の位置。path に `d` がない）。

## 仕組み

1. **位置**（`shape.um` の `shapePlace`）: `pos` があればその点、なければ x / y で形の箱を置いて anchor の位置を決める。
2. **形の計算**（`shape_geom.um` の `shapeBuildView`、CPU）: 形 → 命令 → 形の中で折れ線（画面で 0.02 画素以内になる許容差）→ トリム → 破線 → 線の輪郭（左の側・端・右の側。内側の角はずらした線の交わる点、だめなら中心を通す。円弧の点は面積が等しくなる半径に置く）→ 写しごとに変形して辺にする。リピーターの写しは、許容差が同じなら形の中の輪郭を使い回す。結果は塗る回数ぶんの `ShPass`（輪郭の辺と、塗り方の `f32[64]`）。
3. **升の表**（`shape_raster.um` の `shapeBin`、CPU）: 描く四角を 1 行 × 32 画素の升に分け、升ごとに「掛かる pass の区分（pass の番号・下地 = 左にある辺の巻き数・小片の範囲）」を pass の順に並べる（CSR）。小片も下地もない升は区分を持たない。辺が多いときは行の帯に分けてスレッドで並列に作る。
4. **画素**（kernel、**全部の pass を 1 回の dispatch で**）: 画素ごとに升の区分を順に回り、被覆率（下地 + 小片の正確な面積。F(u) = ∫clamp(u,0,1) の閉じた式）と色（プリマルチプライの補間）を出して、画素の中で source-over で重ねていく。最後に 1 度だけ、層に書く（`shapeRenderLayer`。効果があるとき）か、キャンバスに不透明度を掛けて重ねる（`shapeDrawDirect`）。どちらも同じ値になる（`run.mjs` が確かめる）。
5. **使い回し**（`shapePrepare`）: 形・位置・時刻で決まる値（drawon の途中ならトリムの範囲）が前のコマと同じなら、2 と 3 を飛ばし、置き場の Buffer をそのまま使う（GPU へ送り直さない）。止まっている形は、毎コマ kernel の dispatch 1 回だけになる。
6. CPU と GPU は同じ kernel・同じ入力なので、f32 の値まで同じ（`run.mjs` が wgpu で確かめる）。

## 組み込み（既存のファイルへの変更）

1. **project.um**: `KIND_SHAPE = 6` を足し、行の種類 `shape` を読む。位置で渡す値（行の 2 番目）は形の種類。`Clip` に `shape: ShapeSpec` を足す。kv の中で `shapeIsKey(name)` が真のキーを集め、`shapeParse(form, kv)` を 1 度だけ呼ぶ。`ShDiag` を `diag()` に読み替える（行は同じ。列は `keyIndex` のキーの位置 + `d.col`。`keyIndex` が -1 なら行の 2 番目の語）。長さは今の `else if (p.clips[i].dur == UNSET) { p.clips[i].dur = 5; }` にそのまま入る（素材がないので `out` は使えない）。`pjDefaultTrack` で `KIND_SHAPE` は text と同じ 2。
2. **keys.um**: `shapeKeyInfos()` の各行を kinds `"shape"` で `keysAdd` する（`w` / `h` は shape では number、`points` は `sides` の別名、`pos` は shape だけのキー）。コアの `VIS` に `shape` を足す（x / y / opacity / fade / track / 効果）。`track` の説明の文を「既定は video / color / audio が 0、image が 1、text と shape が 2」にする。x / y の説明は変えなくてよい（shape でも「形の箱の左上」）。
3. **render.um**: `RenderCache` に `shape: ShapeCaches` を足す（`newRenderCache` で `newShapeCaches()`）。`renderFrameFrom` に `else if (kind == KIND_SHAPE) { drawShape(mut canvas, p.clips[idx], p, idx, lt, alpha, mut rc); }`。drawShape:
   ```
   shapeCachesEnsure(mut rc.shape, idx);
   const margin = clipFxReach(c);
   const r = shapePrepare(mut rc.shape.items[idx], c.shape, c.x, c.y, POS_CENTER, lt, c.dur, p.width, p.height, margin);
   if (r.w <= 0 || r.h <= 0) { return; }
   if (c.fx.length == 0) {
     shapeDrawDirect(mut canvas, p.width, p.height, alpha, rc.shape.items[idx]);
     return;
   }
   let layer = shapeTakeLayer(mut rc.shape.items[idx], (r.w * r.h) as u32);   // 大きくするときだけ確保し直す
   shapeRenderLayer(mut layer, rc.shape.items[idx]);
   fxComposite(mut canvas, mut layer, c, p, r.x, r.y, r.w, r.h, alpha);
   shapeGiveLayer(mut rc.shape.items[idx], own layer);
   ```
   層は効果の広がる分（margin）の透明な余白をすでに含むので、`fxComposite` の余白の条件（`KIND_IMAGE || KIND_TEXT`）に `KIND_SHAPE` を**足さない**（足すと余白が二重になる）。`rc.shape.items[idx].notes` が空でなければ警告として出す。import は `./effects/shape/shape_spec.um`、`./effects/shape/shape_raster.um`、`./effects/shape/shape.um`。
4. **ops.um**: 種類ごとの表と分岐に shape を足す。
   - `opKindWord` / `opKindOf`: `KIND_SHAPE` ↔ `"shape"`。
   - `opPositionalKey`: `if (key == "shape") { return kind == KIND_SHAPE; }`。
   - add: 位置の値がなければ失敗する条件（`!hasPos && kind != KIND_COLOR`）はそのままでよい（shape も形の種類が要る）が、失敗の文の `what` に shape なら「形の種類（rect / ellipse / polygon / star / path）」を足す。`lineQuote(pos, kind != KIND_COLOR)` を `kind != KIND_COLOR && kind != KIND_SHAPE` にする（形の種類は引用符なしの語）。
   - set: `opPositionalKey(kind, key) && (hasPositional(lines[k]) || key != "color")` の `key != "color"` を `key != "color" && key != "shape"` に、`setPositional(..., key != "color")` と 2 つの `lineQuote(..., key != "color")` も同じ条件にする。
   - これで `add shape star r=120 fill=red dur=3`、`set <clip> shape=ellipse`、`set <clip> trimend=0.5`、`unset <clip> dash` が通る。
5. **report.um**: `projectJson` の `clips[i]` に `"shape": shapeSpecJson(c.shape)`（キーは .mzc と同じ平らな名前・同じ書き方。path の `d`、グラデーションの点も入る。書いていない点は null）。`showText` の一覧に `shapeDescribe(c.shape)`。schema は keys.um 経由で載る。
6. **診断**: architecture.md の code の表に `bad-path` を足す。
7. **text.um（任意）**: 色の名前（orange / cyan / magenta / grey）や `#rgb` を足したいときは `parseColor` に足す（shape も text / color も同時に受け付ける）。`#rgb` を値の頭に書けるようにするには、project.um の `pjHashColorAt` の桁数に 3 も足す。
8. **キーフレーム・式（ほかの M6 の担当）**: `ShapeSpec` は値の struct。コマごとに写して trimEnd / rotation / repX などを書き換えてから `shapePrepare` に渡せば動く（値が変われば作り直し、止まれば使い回す）。

## 速さ（1920x1080、1 コマ、24 CPU / RTX 5060 Ti、ms。キャンバスの消去を含む）

`node tests/m6-shape/run.mjs --bench` で測る。「使い回す」は形が止まっているコマ（升の表を作り直さない）、「作り直す」は形が動くコマ。GPU は n コマ続けて描いたあと 1 度読み戻すまでの平均（3 回のうち速い回）。同じ機械でほかの仕事が走っていたので、数割は揺れる。

| 場面 | 塗る回数 | 小片 | CPU 使い回す | CPU 作り直す | GPU 使い回す | GPU 作り直す |
| --- | --- | --- | --- | --- | --- | --- |
| 円 900 画素 1 つ | 1 | 2 千 | 4.0 | 6.5 | 0.16 | 2.4 |
| いろいろな形 14 個 | 45 | 2.1 万 | 15.6 | 21.0 | 1.6 | 5.3 |
| 画面いっぱいの星 | 2 | 7.7 千 | 7.9 | 16.4 | 0.34 | 8.5 |
| リピーター 24 個 | 48 | 2.2 万 | 3.1 | 7.3 | 0.26 | 6.1 |
| 小さな円の輪 200 個 | 200 | 1.3 万 | 3.7 | 6.9 | 0.18 | 6.2 |
| 小さな円の輪 1000 個 | 1000 | 6.5 万 | 3.6 | 10.6 | 0.28 | 9.7 |
| 太い点線（5600 点） | 1 | 86 万 | 8.3 | 66 | 0.91 | 58 |
| 先が 1000 本の星の線 × 50 | 50 | 317 万 | 26.9 | 82 | 1.3 | 115 |

作り直すコマの時間の大半は、CPU の形の計算と升の表（どちらも GPU の速さに関係しない）。
