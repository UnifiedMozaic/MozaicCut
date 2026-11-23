# テキストアニメーター（M6）

文字・単語・行ごとに、位置・拡大・回転・不透明度・色・字間を、範囲セレクターで掛けて動かす仕組みです（After Effects のテキストアニメーターに当たります）。
コードは `src/effects/textanim/`、試しは `tests/m6-textanim/textanim_test.um` と `tests/m6-textanim/run.mjs` です。組み込みの差分は `docs/design/m6-textanim-integration.patch`（下の「組み込み方」）。

## .mzc での書き方

text の行に、アニメーター（`anim` など）とその引数（`anim.<引数>`）を書きます。

```
text "Hello World" dur=4 anim=rise                                              # プリセットだけ
text "こんにちは 世界" anim=bounce anim.by=word anim.stagger=0.2                  # プリセット + 上書き
text "SALE" anim.mode=range anim.start="0@0 100@1:ease" anim.opacity=0          # 範囲モード（AE の範囲セレクター）
text "Bye" anim=fadein animout=fadein animout.dur=0.3                           # 始まりに現れ、終わりに消える
text "TITLE" anim=pop anim2=wave anim2.loop=1.5                                  # 2 つ重ねる
```

- アニメーターは `anim` `anim2` `anim3` `anim4`（始まりから数える）と `animout` `animout2`（終わりから数える）の 6 つまで。この順に掛けます。
- `<名前>=<プリセット>` でプリセットを読み、`<名前>.<引数>=<値>` で上書きします。行の中の順によらず、プリセットを先に当てます。プリセットなしで引数だけ書いてもかまいません。
- 同じキーを 2 回書いたら後のものが効きます（`project.um` の決まりと同じ）。警告 `anim-duplicate` が出ます。
- `animout` は時間を「クリップの終わりからの秒数」で数え、単位の順も逆にします。`animout=fadein` は「先頭の字から順に消える」になります（`animout.reverse=1` なら最後の字から）。

### 動き方（mode）は 2 通りで、書いたキーからは推し量らない

| mode | 動き |
| --- | --- |
| `stagger`（既定。プリセットはすべてこれ） | 単位ごとに `stagger` 秒ずつずらして、`dur` 秒で変わる |
| `range` | `start` / `end` / `offset`（単位の数に対する %）の範囲を選ぶ（After Effects の範囲セレクター） |

`start` / `end` / `offset` は `mode=range` のときだけ書けます。`mode=range` なしで書くと誤り（`key-not-allowed`。hint「anim.mode=range を足します」）になります。以前は「start / end / offset のどれかを書くと範囲モード」でしたが、既定値（`end=100`）を書き足しただけで結果が逆になるので、明示にしました。`check --json` の `clips[].textanim[].mode` と `doc` の先頭にも、どちらのモードかが出ます。

### 時間で動く値（キーフレーム）

`start` / `end` / `offset` / `amount` は、m6-anim と同じ「値@時刻[:補間]」を空白で並べて書けます（空白を含むので `"..."` で囲む）。

```
anim.start="0@0 100@1"            # 0 秒に 0%、1 秒に 100%
anim.end="0@0:ease 100@1:ease"    # 両端をゆるめる（AE のイージーイーズと同じ影響 33.33%）
anim.offset="-40@0 100@end-0.5"   # 終わりの 0.5 秒前に 100%
anim.amount="0@0:hold 100@15f"    # 15 コマ目まで 0% を保ち、そこで 100%
```

- 時刻はクリップの始まりからの秒（`1.5`、`1:02.5`）、コマ（`45f`）、終わりからの秒（`end`、`end-0.5`、`end-10f`）。m6-anim の `animParseTimeText` と同じ書き方です。
- 補間の印は `linear`（既定）/ `hold` / `ease` / `easein` / `easeout`。m6-anim のほかの印（`smooth`、`in=速度/影響`、`cubic=` など）はまだ使えません（`bad-enum` で「m6-anim の結合後に使えます」と出る）。
- キーは時刻の順に並べます（違うと `bad-time`）。`loop` を書くと、キーフレームの時刻もその周期でくり返します。
- **古い書き方 `a..b`（`delay` から `dur` 秒で a → b）は非推奨です。** 読めますが、キーフレームを使ってください。m6-anim を結合したら、`taParseKeys` を m6-anim の `animParse` / `animResolve` / `animEvalNum` に差し替えます（`TaRange` の `keys` を `AnimTrack` にする）。
- 長さのキー（`stagger` / `delay` / `dur` / `loop`）は秒（`0.5`、`0.5s`、`1:02.5`）かコマ（`15f`）。長さなので `end` は使えません（`bad-time`）。

### プリセット（よく使う型）

| 名前 | 動き |
| --- | --- |
| `typewriter` | タイプライター: 1 文字ずつ（空白も数える）0.06 秒ごとにぱっと現れる |
| `fadein` | フェードイン: 1 文字ずつ 0.05 秒ずらして 0.4 秒で現れる |
| `bounce` | 跳ねる: 1 文字ずつ 1.2em 上から落ちて跳ねる（0.06 秒ずつ、0.8 秒） |
| `rise` | 文字ごとに上がる: 0.6em 下から上がりながら現れる（0.04 秒ずつ、0.5 秒、減速） |
| `pop` | ぽんと出る: 0 から少し行き過ぎて等倍になる（0.04 秒ずつ、0.45 秒） |
| `slide` | 横から: 単語ごとに 1em 左から滑り込む（0.12 秒ずつ、0.5 秒） |
| `spread` | 字間を詰める: 0.6em 広い字間から、全体が同時に詰まりながら現れる（1.2 秒） |
| `wave` | 波: 0.25em 持ち上がる波が、どの字にも 2 秒ごとにくり返し通る |
| `colorwave` | 色の波: 色（ffd040）が変わる波が、どの字にも 2 秒ごとにくり返し通る |
| `none` | 何も掛けない（引数をすべて自分で書くとき） |

### 引数

| 引数 | 値 | 既定 | 意味 |
| --- | --- | --- | --- |
| `mode` | `stagger` / `range` | `stagger` | 動き方（上の表） |
| `by` | `char` / `letter` / `word` / `line` | `letter` | 動かす単位（`char` は空白も数える、`letter` は空白を除く、`word` は空白で区切った単語）。拡大・回転の中心もこの単位の箱の中心 |
| `shape` | `square` / `up` / `down` / `triangle` / `round`（`rampup` / `rampdown` も可） | `square` | 選ばれ具合の形（四角・上がり・下がり・三角・丸） |
| `smooth` | 0..100（%） | 100 | 四角の形のなめらかさ（0 は単位ごとにぱっと切り替わる）。ほかの形には効かない |
| `ease` | `linear` / `in` / `out` / `inout` / `back` / `bounce` / `elastic` | `linear` | 単位ごとの変化のイージング。位置・拡大・回転・字間に掛かり、不透明度と色には掛けない（点滅しないように） |
| `stagger` | 長さ | 0.05 | 時間差モード: 単位ごとにずらす秒数 |
| `delay` | 長さ | 0 | 始まる前の待ち（animout では終わりからの秒数） |
| `dur` | 長さ | 0.5 | 時間差モード: 1 単位が変わる秒数（範囲モードの古い `a..b` では範囲が動く秒数） |
| `loop` | 長さ | 0 | くり返しの周期（0 はくり返さない）。時間差モードでは、どの単位も自分の始まりからこの周期でくり返す |
| `start` / `end` / `offset` | %（-10000..10000）かキーフレーム | 0 / 100 / 0 | 範囲（単位の数に対する %）。`mode=range` のときだけ |
| `amount` | %（-100..100）かキーフレーム | 100 | 掛ける量 |
| `random` / `seed` | 0 か 1 / 整数 | 0 / 0 | 単位の順番をでたらめにする（同じ seed なら同じ順） |
| `reverse` | 0 か 1 | 0 | 単位の順番を逆にする |
| `x` / `y` | 画素か em（`-0.5em`） | 0 | 選んだ単位をずらす（y は下が正） |
| `scale` | %（0..1000） | 100 | 選んだ単位の拡大 |
| `rotate` | 度 | 0 | 選んだ単位の回転（時計回り） |
| `opacity` | 0..100（%） | 100 | 選んだ単位の不透明度 |
| `color` | 色 | なし | 選んだ単位の文字の色 |
| `tracking` | 画素か em | 0 | 選んだ単位の後ろの字間を足す（AE の字送り 50 は `0.05em`） |

### 選ばれ具合の決め方

単位 k の「選ばれ具合」s（0..1）を決め、`x` `y` `rotate` `tracking` は s 倍、`scale` は 100% から s の割合で近づけ、`opacity` は 100% から s の割合で近づけ、`color` は s の割合で混ぜます。「選ばれている = プロパティの値になっている」なので、始まりのアニメーターでは、まだ現れていない単位が選ばれています。

- **時間差モード**: 単位 k（並べ替えた後の順番 j）の時刻は t_j = (時刻 − `delay`) − j × `stagger`。`loop` があれば t_j ≥ 0 のときに t_j = t_j mod `loop`（**単位ごと**にくり返す。全体の時刻に剰余を掛けると、j × stagger が loop を超える単位がいつまでも動かず、周期の切れ目で途中の単位が跳ぶ）。進み p = t_j / `dur` から u = 1 − p を求め、形の値 f(u) が s です。`up` は u（だんだん選ばれなくなる = 現れる）、`down` は 1 − u、`triangle` / `round` は u が 0..1 の間だけの山（波が通る）、`square` は u > 0.5 で 1（`smooth` で斜めにする）。`loop` が `dur` より短いと、山の途中で次の周期に入るので跳びます。
- **範囲モード**: 範囲 [S, E] = ([start, end] + offset) / 100 × 単位の数。`square` は単位の中心が範囲に入っていれば 1（`smooth` で単位の箱と範囲の重なりの割合に近づける）、ほかの形は単位の中心の範囲の中の位置 u で決めます（`up` は範囲の前で 0、後ろで 1）。
- `ease` は s に掛けます（s' = 1 − ease(1 − s)）。`bounce` / `back` / `elastic` で跳ねる・行き過ぎる動きになります。
- 複数のアニメーターは、`x` `y` `rotate` `tracking` を足し、`scale` を掛け、`opacity` を掛け、`color` を順に混ぜます。拡大・回転はアニメーターごとに、その単位の中心のまわりに掛けて重ねます。

### After Effects との違い

AE の `.aep` や式から写すときは、次の違いに気をつけてください。

| 項目 | After Effects | テキストアニメーター |
| --- | --- | --- |
| 既定の単位 | 文字（Characters。空白を含む） | `letter`（空白を除く）。AE と同じにするなら `by=char` |
| 字送り（tracking） | 1/1000 em | 画素か em。AE の 50 は `0.05em` |
| 回転・拡大の中心 | 既定は字のベースラインの上の点（アンカーポイントの組み分けで変わる） | 単位の箱（送り幅 × 行の縦の中心）の中心 |
| 範囲セレクターの start > end | 形の向き（上がり・下がり）が逆になるはず（**未確認**。AE が手元にないため確かめていない） | 範囲を入れ替えるだけで、形の向きは変えない |
| 範囲の動かし方 | プロパティのキーフレーム | `start="0@0 100@1"` のキーフレーム（m6-anim と同じ書き方の小さな部分集合） |
| モード | 範囲セレクター・ウィグリー・式のセレクターを足す | `mode=range` が範囲セレクター。`mode=stagger` は AE にない（「単位ごとに時間をずらす」を 1 行で書くための型） |
| 量（amount） | 0..100% | -100..100%（負で逆向き） |

### 診断（`check` に出るもの）

キーごと（`taCheckKey`）は既存の code だけを使います: `unknown-key`（`anim.bye` →「'anim.by' のことですか？」、`anim.` →「引数の名前を書きます」）、`bad-enum`、`bad-number`、`bad-time`、`bad-color`、`out-of-range`。

行全体（`taCheckClip`。text の行を読み終えた後に 1 回）:

| code | 重さ | 出るとき |
| --- | --- | --- |
| `key-not-allowed`（既存） | 誤り | `start` / `end` / `offset` を `mode=range` でないアニメーターに書いた |
| `anim-duplicate`（新） | 警告 | 同じキーを 2 回以上書いた（後のものが効く） |
| `anim-no-effect`（新） | 警告 | 掛ける値（x / y / scale / rotate / opacity / color / tracking）もプリセットもないアニメーター |
| `anim-word-no-space`（新） | 警告 | 空白のない日本語などの文に `by=word`（文全体が 1 単語になる） |

## 見た目の決まり

- 位置（`x` / `y`）・揃え（`align`）・背景の箱（`bg` / `pad`）・影（`shadow`）・縁取り（`outline` / `outlinew`）・`fade` / `opacity` は text の行と同じ意味です。動かさないとき（アニメーターの量が 0 のとき）は `textlayer.um` とほぼ同じ絵になります（字を整数の画素に置くので、2 字目から 1 画素未満ずれることがあります。下の「数値」）。
- 背景の箱は動かしません（元の文字の箱のまま）。字間を広げると、揃え（中央なら中央）を保って行が広がります。
- 縁取りはすべての字の文字の下に敷きます。字ごとの不透明度で薄くしても、その字の中に自分の縁取りが透けないように縁取りの濃さを補正します（1 字だけなら「縁取り + 文字」を重ねた後に不透明度を掛けたのと同じ）。
- 動いていない字は整数の画素に置くので、ぼけません。動いている字（ずれ・拡大・回転）は字の画像を双線形で読みます。大きく拡大するとぼけます（字の画像は元の大きさで作るため）。

## 作り（`src/effects/textanim/`）

| ファイル | 中身 |
| --- | --- |
| `ta_math.um` | sin / cos / 2 の累乗 / イージング（UM の Math にないので多項式で書く。CPU だけで使う） |
| `ta_spec.um` | キー・プリセット・値の読み取りと確かめ（`taCheckKey` / `taCheckClip`）、キーフレーム（`taParseKeys` / `taRangeValue`）、Clip.kv からの読み取り（`taFromKv`）、説明の文（`taDescribe`）と JSON（`taSpecJson`）、schema のキーの表（`taKeyInfos`） |
| `textanim.um` | 文字の並びと字の画像（アトラスとキャッシュ）、選ばれ具合、字ごとの変換、描く kernel |

描き方:

1. **時間で変わらない部分（`TaCache` に入れる）**: 文字列を行・字（結合文字は前の字とまとめる）に分け、送り幅と単位の番号を決めます。字の形ごとに `ttf.um` の `renderTextImage` で被覆率の画像を作り、**インクのある四角 + 縁取りの太さ + 2 画素だけを切り出して**、高い字から**棚詰め**（幅 `TA_ATLAS_W` = 4096 まで）で 1 枚（アトラス）に積みます。
   - アトラスが `TA_ATLAS_MAX_PX`（3355 万画素。f32 で 128 MiB）を超えるときは、字の画像を倍率 k < 1 で作り直し、描くときに 1/k 倍に拡げます（とても大きな字が多い種類あるときだけ。少しぼける）。
   - 縁取りがあれば、`textlayer.um` と同じ距離変換で太らせます。字をいくつかずつ（作業用の画素が `TA_DILATE_BATCH_PX` = 419 万まで）まとめ、1 まとまりを 3 回の dispatch で、字の四角の中だけ処理します。作業用の Buffer はアトラス全体ではなく 1 まとまりの大きさだけです（以前はアトラスと同じ大きさの RacyBuffer が 4 つ要った）。字ごとに dispatch すると GPU では準備と受け渡しが重い（96 字で約 1 秒）ので、まとめています。
   - 鍵は文字・大きさ・縁取りの太さ・フォント。90 フレーム使わなければ捨て、32 個を超えるか、アトラスの画素の合計が `TA_CACHE_MAX_PX`（6711 万画素）を超えたら古いものから捨てます（いま作ったものは残す）。
2. **毎フレーム（CPU）**: アニメーターごとに単位の選ばれ具合を求め、字ごとの字間・位置・拡大・回転・不透明度・色を決めます。字の画像 → 画面の 2x3 の変換の逆と色・不透明度を `Buffer<TaGpuChar>` に入れます。描く範囲を 32 画素の升目に分け、升目ごとに重なる字の番号の表を作ります（字の順）。この準備（`taPrepare`）は 1 コマに 1 回だけです（効果のある経路も `taRenderLayer` 1 つで、層の四角と描く処理が同じ準備を使う）。
3. **kernel（`taDrawCanvasK` / `taDrawLayerK`）**: 画素ごとに自分の升目の字だけを見て、背景の箱 → 影 → 縁取り（全部の字）→ 文字（全部の字）の順に重ね、最後にクリップの不透明度を 1 回掛けます。字の画像は字の四角の外を読まない（隣の字が混ざらない）。

CPU と GPU の一致: kernel は四則・`floor` / `min` / `max` と、縁取りの距離変換の `sqrt` と割り算を使います。WGSL では f32 の割り算と `sqrt` の丸め（2.5 ULP まで）や、FMA へのまとめ方が GPU ごとに違ってよいので、どの GPU でも 1 ビットも同じとは言えません。**この GPU（RTX 5060 Ti の Vulkan と Direct3D 12）で、1 バイトも違わないことを確かめました。** 試しの合否は許容差（1 色 1/255）で決め、1 バイトも違わないものの数も出します。

### 関数（export）

```ts
// textanim.um
export struct TaStyle { text; size; align; color; bg; pad; shadow; outline; outlineW; x; y; dur; }
export function taStyleFromClip(c: Clip): TaStyle
export function taClipAnimated(c: Clip): bool            // 行にアニメーターのキーがあるか
export function taClipSpec(c: Clip, p: Project): TaSpec  // Clip.kv から読む（p の fps でコマを秒にする）
export function newTaCache(): TaCache
export function taCacheFrame(cache: mut TaCache): void   // フレームの始めに 1 回
export function taDrawCanvas(canvas: mut Buffer<vec4<f32>>, cw: i32, ch: i32, st: TaStyle, spec: TaSpec, font: Font,
                             lt: f64, alpha: f32, cache: mut TaCache): void
export function taRenderLayer(cw, ch, st, spec, font, lt, mut cache): TaLayerOut  // 効果を掛ける層（textClipLayer と同じ形）
export function taStates(cw, ch, st, spec, font, lt, mut cache): TaCharState[]    // 字ごとの中心・拡大・回転・不透明度・色
export function taStatesJson(states: TaCharState[]): string
export function taCacheStats(cache: TaCache): TaCacheStats                       // 字の種類・アトラスの大きさ・倍率

// ta_spec.um
export function taIsKey(key: string): bool               // anim で始まるキーか
export function taCheckKey(key: string, val: string, line: i32, col: i32, vcol: i32, diags: mut Diag[]): bool
export function taCheckClip(kv: string[], text: string, line: i32, diags: mut Diag[]): bool
export function taFromKv(kv: string[], size: f64, fps: f64): TaSpec
export function taRangeValue(r: TaRange, lt: f64, p: f64, dur: f64, fps: f64): f64
export function taSpecJson(spec: TaSpec): string
export function taDescribe(a: TaAnimator): string
export function taKeyInfos(): KeyInfo[]                  // 144 個
export function taPresetNames(): string[]
export function taPresetDoc(name: string): string
```

`lt` はクリップの中の時刻（秒）。`alpha` はクリップの不透明度（fade × opacity）。

## 組み込み方（結合の担当へ）

このブランチは新しいファイルだけです。**`docs/design/m6-textanim-integration.patch` が、master（e08cf1f）の `render.um` / `project.um` / `report.um` に実際に足した差分です。** `git apply docs/design/m6-textanim-integration.patch` で当たり、当てた版で `node <UM>/src/cli.ts check src/main.um --target host` が通ること、`mozcut check` / `check --json` / `schema --json` / `preview`（効果 `blur` のある文字を含む）が動くことを確かめました。

1. **`project.um`（読み取り）**: `pjApplyKey` の先頭で、`taIsKey(key)` なら、行が text でなければ `key-not-allowed`（hint「anim は text の行だけに書けます」）、text なら `taCheckKey(key, val, line, col, vcol, mut err)` を呼んで戻る（効果や `unknown-key` の判定に回さない）。値は今までどおり `Clip.kv` に入る。行を読み終えたところ（`p.clips.push(c)` の前）で、text なら `taCheckClip(c.kv, c.text, lineNo, mut err)`。`project.um` と `ta_spec.um` は互いに import するが、UM はこれを受け付ける（型検査が通る）。
2. **`render.um`（描画）**: `RenderCache` に `ta: TaCache`（`newTaCache()`）を足し、`renderFrame` の始め（`textCacheFrame` の後）で `taCacheFrame(mut rc.ta)`。`drawText` に `lt: f64` を足し（呼び出しは `drawText(mut canvas, p.clips[idx], p, font, lt, alpha, mut rc)`）、先頭で:
   ```ts
   if (taClipAnimated(c)) {
     const st = taStyleFromClip(c);
     const spec = taClipSpec(c, p);
     if (c.fx.length == 0) {
       taDrawCanvas(mut canvas, p.width, p.height, st, spec, font, lt, alpha, mut rc.ta);
       return;
     }
     let lo = taRenderLayer(p.width, p.height, st, spec, font, lt, mut rc.ta);
     if (lo.w <= 0 || lo.h <= 0) {
       return;
     }
     fxComposite(mut canvas, mut lo.layer, c, p, lo.x, lo.y, lo.w, lo.h, alpha);
     return;
   }
   ```
   層は返り値（`TaLayerOut.layer`。`textClipLayer` と同じ形）で受け取ります。`rc.layer` に描かせる形（`taDrawLayer(mut rc.layer, …, mut rc.ta)`）は、同じ `rc` の 2 つのフィールドを 1 回の呼び出しで `mut` に渡すので UM が `exclusive-borrow` で止めます。
3. **`report.um`（schema と JSON）**: `schemaText` / `schemaJson` のキーを `coreKeys()` + `taKeyInfos()`（kinds は `"text"`。6 つのアニメーター × （プリセット + 23 個の引数）= 144 個）にする。型は keys.um の決まり（`time` / `number` / `int` / `color` / `string` / `enum:` / `flag`）だけで、数か em をとる値と数かキーフレームをとる値は `string`（範囲は doc に書き、min / max は空）。`projectJson` の text のクリップに `"textanim": taSpecJson(taClipSpec(c, p))`（アニメーターがなければ `[]`）を足すと、AI が設定と説明の文（`doc`。先頭にモード）を読めます（`rpClipJsonTo` に `p` を渡す）。
4. **`ops.um`（操作）**: 新しい操作は要らない。`set title anim=rise anim.by=word`、`unset title anim.by`、`add text "Hi" anim=typewriter` が今の `set` / `unset` / `add` で書ける。キーの確かめは 1 の読み取りが行う。
5. **`docs/ai.md` / README**: 上の「.mzc での書き方」と表を写す。AI には「`check --json` の `clips[].textanim[].mode` と `doc` で意図どおりか確かめる。範囲セレクターは `mode=range` を書く」と書く。
6. **編集画面（任意）**: インスペクターに「アニメーター」の欄（プリセットの一覧 = `taPresetNames()`）。`taStates` で字ごとの位置を出せば、タイムラインに字の現れる時刻の印も描ける。
7. **キーフレーム（m6-anim）との結合**: `taParseKeys` / `taRangeValue` を m6-anim の `animParse` / `animResolve` / `animEvalNum` に差し替える（書き方は同じなので .mzc は変わらない）。`a..b` は非推奨のまま残し、`check` で警告にしてもよい。

## 試し

```sh
node tests/m6-textanim/run.mjs                 # CPU 版と GPU 版（wgpu があれば）をビルドして確かめる
node tests/m6-textanim/run.mjs --png --out x   # 画像を x/cpu/*.png にも書く
```

- 確かめること（52 個）: 動かさないときに `textlayer.um` とほぼ同じ、タイプライター・フェードイン・上がる・跳ねる・ぽんと出る の時刻ごとの値、範囲モードの四角（キーフレームと古い `a..b`）・三角・下がり、単語ごと、でたらめ（seed）、animout、字間（中央を保つ）、2 つ重ね、**くり返し**（40 字の `wave` で全部の字が動く・1/240 秒ごとに見て周期の切れ目で跳ばない・30 字の `colorwave` で全部の字が色づく）、**モードの明示**（`end=100` を足しても結果が同じ）、キーフレームの値（linear / ease / easein / hold）と時刻（`30f` / `end-1`）、長さのコマ（`3f`）、重複は後勝ち、キーごとの診断 17 種（と正しいキーで誤りが出ないこと）、行全体の診断 5 種、schema の 144 個、層の経路と画面の経路が同じ、**アトラス**（違う漢字 96 字・縁取り 12 で 200 px / 700 px。上限の中・幅 4096 まで）、キャッシュの画素の合計の上限。
- CPU 版と GPU 版（`UM_WGPU=1`、`UM_GPU_THRESHOLD=65536`）の BMP が許容差（1/255）の中にあること。1 バイトも違わないものの数も出す。

### 数値（Windows 11、RTX 5060 Ti。1920x1080、30 コマの平均）

ほかの作業で CPU が 100% 近く使われている中で測ったので、CPU の時間は回によって 2 倍ほど揺れます（同じ見出しで 3.6〜13 ms）。

| 場面 | CPU（全コア） | GPU（wgpu Vulkan） |
| --- | --- | --- |
| 見出し 2 行・120 px・縁取り・影・背景の箱・アニメーター 3 つ（1 コマ。画面を消す時間を含む） | 3.6〜13 ms | 0.8〜1.8 ms |
| 画面いっぱいの文 12 行 × 約 40 字・64 px・縁取り・アニメーター 2 つ | 3.2〜15 ms | 0.9〜1.6 ms |
| 画面を消すだけ | 1.4〜2.8 ms | 0.5〜0.8 ms |
| 初めのコマ（字の画像とアトラスを作る。見出し） | 15〜40 ms | 45〜180 ms（直す前の版も同じ条件で 44〜76 ms） |
| 違う漢字 96 字・200 px・縁取り 12 の初めのコマ | 90〜160 ms | 150〜380 ms |
| 違う漢字 96 字・700 px・縁取り 12 の初めのコマ | 0.8〜1.6 s | 1.2〜2.4 s |
| kv からアニメーターを読む（1 クリップ、`taClipSpec`） | 0.06〜0.16 ms | — |

アトラスの大きさ（違う漢字 96 字、縁取り 12）:

| 字の大きさ | 直す前 | 直した後 |
| --- | --- | --- |
| 200 px | 1 列に積む（86 字で最初のコマ 0.12〜0.3 s・ピーク 241 MB と報告） | 4096x1222（500 万画素。fill + outer で 38 MiB、作業用は 1 まとまり分）、倍率 1 |
| 700 px | 1 列に積む（86 字で CPU 3.1〜5.6 s・GPU 5.3 s・ピーク 1.93 GB と報告） | 4096x8121（3326 万画素、上限の中。fill + outer で 254 MiB）、倍率 0.80（字の画像を 558 px で作って 1.25 倍に拡げる） |

Direct3D 12（`UM_WGPU_BACKEND=dx12`）でも、BMP 9 枚とハッシュ 8 個が CPU と 1 バイトも違いませんでした。
動かさないときの `textlayer.um` との差: 平均 0.0018（0..1）、横に 1 画素ずらしても 0.25 を超える画素は 46 万画素中 631（字の縁取りと影の重なり方の違い）。切り出しと棚詰めに変えても、この数は変わりませんでした。

## まだないもの

- 字の画像を大きさ・位置ごとに作り直すこと（大きく拡大するとぼける。1 画素未満の位置で描かない）。
- 3D の回転（奥行き）、字ごとのぼかし、パスに沿った配置、wiggly（揺れ）セレクター、式（m6-expr）での値。
- m6-anim の補間の印のうち `smooth` / `in=` / `out=` / `cubic=`（結合後に m6-anim の読み取りへ差し替える）。
- AE の範囲セレクターの start > end の挙動の確認（上の「After Effects との違い」）。
- カーニング・合字（`ttf.um` と同じ）。
