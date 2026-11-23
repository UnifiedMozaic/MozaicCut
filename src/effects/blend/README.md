# 描画モードとマスク（M6、`src/effects/blend/`）

After Effects の描画モード・マスク・トラックマットに当たる部品です。画素の処理はすべて kernel で、CPU と GPU（wgpu の Vulkan / Direct3D 12）で同じ結果になります（1920x1080 の 15 モード × 2 つの値 + マスク + マットの 2.6 億個の値が 2^-24 の刻みで 1 つも違わない）。

| ファイル | 中身 |
| --- | --- |
| `blend.um` | 描画モード 15 種の kernel（`mblComposite`）、線形の光 ⇔ 表示の値の表（`MblLut`）、名前と説明、列挙の比べ方（`mblNormName`） |
| `mask.um` | マスク（四角・楕円・パス（SVG の d））、ぼかし・広げる・縮める・反転・不透明度・重ね方、座標の変換（`ref=` / `units=norm`）、作ったマスクを覚えておく（`mblBuildMaskCached`） |
| `matte.um` | トラックマット（アルファ・輝度、反転）（`mblMatteFrom`） |
| `spec.um` | `.mzc` のキーとマスクの行の読み取り、診断、`keys.um` に足すキー（`mblCoreKeys`）、schema の JSON |
| `maskops.um` | マスクの行とマットの参照を `ops.um` の操作で書き換える手順（`MblPlan`） |

試験: `node tests/m6-blend/run.mjs [-v] [--bench] [--out <dir>]`（`UM_WGPU_HOME` があれば GPU とも比べる。`UM_TEST_WGPU_BACKENDS=vulkan,dx12`）。

## どちらの値で計算するか

- **表示の値（`display`、既定）**: キャンバスの値（BT.709 の YUV から戻した、ガンマの掛かった信号の値）のまま混ぜる。Photoshop・After Effects の既定と同じ見え方。キャンバスに重ねるとき（`MBL_DST_OPAQUE`）、「通常」でマスク・マットがなければ `render.um` の `blendOver` と 1 ビットも違わない。
- **線形の光（`linear`）**: 伝達関数（project の `blend.tf`）で線形の光に戻して混ぜ、表示の値に戻す。After Effects の「1.0 ガンマで色をブレンド」に当たる。不透明度の混ぜも線形。結果は 0〜1 で切る（キャンバスが SDR のため）。
  - `blend.tf` の既定は **`bt1886`**（γ2.4。映像の表示の EOTF で、Resolve のタイムラインの既定と同じ）。画像・Web の素材が中心なら `srgb`、カメラの信号を光に戻すなら `bt709`（OETF の逆）。M4 の色の設定（`src/effects/color/`）が master に入ったら、その伝達関数に従わせる（番号は `COL_TF_*` と同じにしてある）。
- 式は W3C Compositing and Blending Level 1。
  - 色相・彩度・カラー・輝度の「輝度」の係数は、**表示の値では 0.3 / 0.59 / 0.11**（W3C・Photoshop・After Effects と同じ）、**線形の光では BT.709**（0.2126 / 0.7152 / 0.0722。本当の相対輝度）。
  - ソフトライトは W3C（PDF）の式。Photoshop / After Effects のソフトライトとは暗い所で少し違う。
  - 「カラー比較（明）/（暗）」（Lighter Color / Darker Color。画素の色を丸ごと選ぶモード）はまだない。`blend=lighter-color` は bad-enum で `lighten` を推す（黙って置き換えない）。`lighter` は CSS の `globalCompositeOperation` と同じく**加算**の別名。
- kernel に pow がないので、伝達関数は CPU で f64 で作った 4096 点の表を線形補間して引く（誤差 1e-5 未満。同じ表を CPU と GPU で使うので結果は同じ）。
- 列挙の値（`blend`、`blend.space`、`blend.tf`、`matte.type`、マスクの形・`mode`・`units`、真偽の値）は、どれも大文字・小文字とハイフン・下線を区別しない（`mblNormName`）。

## .mzc での書き方（組み込み後）

```
project size=1920x1080 blend.space=linear blend.tf=bt1886
video "bg.mp4" id=bg
video "flare.mp4" id=flare blend=add                          # 加算（project の linear を受け継ぐ）
image "paper.png" id=paper blend=multiply blend.space=display opacity=0.6
mask ellipse to=paper ref=1920x1080 x=100 y=80 w=900 h=600 feather=60
mask path to=paper ref=1920x1080 d="M 400 300 C 450 250 550 250 600 300 L 500 450 Z" mode=subtract feather=4 expand=-2
text "TITLE" id=title size=200                                # マットの元（画面には描かない）
video "fire.mp4" id=fire matte=title matte.type=luma          # 文字の形に炎を抜く
```

- クリップの行: `blend=<モード>`（normal add multiply screen overlay softlight hardlight lighten darken difference exclusion hue saturation color luminosity。別名 linear-dodge / plus / lighter（加算）、over など）、`blend.space=display|linear`、`matte=<ID>`、`matte.type=alpha|luma`、`matte.invert`（値なしでも `=1` / `=0` でもよい）。
- project の行: `blend.space`（クリップの既定）、`blend.tf=bt1886|srgb|bt709`（既定 bt1886）。
- マスクの行（新しい行の種類 `mask`。時間もトラックも持たない）:
  `mask rect|ellipse|path to=<ID> [ref=WxH | units=norm] [x= y= w= h=] [round=] [d="..."] [mode=add|subtract|intersect|lighten|darken|difference|none] [invert] [feather=] [expand=] [opacity=]`
  - **`to=` は必ず書く**（ops はいつも書く）。読むときは省略を許し、すぐ上の（mask でない）映像の行に掛けるが、警告 `mask-implicit-target` を出す。上が消したクリップ（`# video ...`）なら誤り `mask-orphan`（黙って上の別のクリップに掛けない）。
  - **座標**: 層（効果の前の素材の絵）の左上が 0,0。層の大きさは project の size、クリップの w / h / fit（`main.um` の `scaleFilter` で ffmpeg が縮める）、プレビューの縮小で変わるので、**`ref=WxH`**（座標を書いたときの層の大きさ）を書く。描くときに層の実際の大きさとの比で、x・w は幅の比、y・h・round・feather・expand は高さの比で変える（After Effects のマスクが層の拡大・縮小に付いて行くのと同じ）。**`units=norm`** なら層の幅・高さに対する割合（0〜1。長さは高さに対する割合）。どちらもなければ今の層の画素として描き、警告 `mask-no-ref` を出す。`w` / `h` を書かなければ層の大きさ。
  - 上から順に重ねる。最初の形の重ね方が add / lighten / difference なら何もない所（0）から、それ以外は全部（1）から始める（After Effects と同じ）。
  - `opacity` は 0〜1 の割合（`50%` や `50` と書くと、`0.5` を推す診断）。`feather` は 0〜1000 画素（縁の内と外に半分ずつ）。パスの数は ±100000 まで。
  - **文字のクリップのマスク**: 文字の層の大きさと原点は、文字の中身・size・縁取り・pad で変わる。文字を直すと、マスクは文字に対してずれる（`ref=` でも直らない）。文字の形で抜くなら、文字のクリップをトラックマットの元にするほうがよい。
- トラックマット:
  - マットの元は画面に描かない。マットの元の不透明度・フェード・マスク・効果はマットに効く（After Effects と同じ）。
  - マットの連鎖（マットの元にも `matte=`）は使えない（`matte-chain`）。マットの元の `blend=` は無視される。音の行はマットの元にならない（`matte-not-visual`）。
  - マットの元がその時刻になければ、マットは 0（反転なら 1）。
- 診断の code:
  - 新しく作ったもの: `bad-path`（列は d の中の誤りの位置。値が引用符で始まるかどうかも数える）、`bad-mask-shape`、`matte-self`、`matte-missing`（matte.type / matte.invert だけ）、`matte-not-visual`、`matte-chain`、`mask-orphan`、`mask-no-target`、警告 `mask-implicit-target`、警告 `mask-no-ref`。
  - 既存のもの: `bad-enum`（suggest つき）、`unknown-key`、`key-not-allowed`、`bad-number`（`%` なら suggest）、`out-of-range`（割合のキーに 5〜100 なら suggest）、`unknown-ref`、`ref-cycle`。

## 組み込み方

既存のファイルは書き換えていない。以下は組み込むときの手順（関数の名前は master e08cf1f のもの）。

### keys.um

- `coreKeys()` の最後に `for (const k of mblCoreKeys()) { out.push(k); }` を足す（`import { mblCoreKeys } from "./m6_blend/spec.um"`）。
- `blend` / `blend.space` / `blend.tf` / `matte` / `matte.type` / `matte.invert` は **type を `"string"`** で載せてある。`pjValue` は列挙を完全一致で確かめるので、`enum:` にすると別名・大文字（`Screen`、`linear-dodge`）が bad-enum になり、誤った値には `pjValue` と `mblClipSpec` の bad-enum が 2 つ出るため。値の確かめは `mblClipSpec` / `mblProjectSpec` だけで行い、列挙の値・説明は doc と `mblSchemaJson` に載せる。

### project.um

1. `Clip` に `blend: MblClipSpec`、`masks: MblMask[]`、`kvCols: i32[]`（kv の組ごとの値の列。`mblClipSpec` の診断の列に使う）を足す。`Project` に `blendSpace: u32`、`blendTf: u32`（既定 `MBL_TF_DEFAULT`）を足す。
2. `pjApplyKey` と `pjApplyProjectKey` の `switch (key)` に `case "blend": case "blend.space": case "blend.tf": case "matte": case "matte.type": case "matte.invert": return;` を足す（値は後で読む。足さないと「表にありますが読み取りが扱っていません」になる）。
3. クリップの行の字句の `toks[i].key == ""` の枝の先頭で、`mblIsBareClipFlag(toks[i].val)`（`matte.invert`）なら `c.kv.push(word); c.kv.push(""); c.kvCols.push(col); continue;`（`mute` と同じ扱い。これがないと `unexpected-value` になる）。key=value の枝では `c.kv` に足すたびに `c.kvCols.push(vcol)`。
4. 行の種類 `mask` を足す（`head == "mask"` を `pjKindOf` の前で分ける。`drawOrder` に入れず、配置もしない）。
   - 2 番目の語を形（`shapeCol` はその列）、それより後ろを kv にする（値のない `invert` は `(invert, "")`）。値の列（vcol）を cols に。
   - `const ml = mblParseMaskLine(shape, shapeCol, kv, cols, lineNo, line, mut err)`、続けて `mblMaskRefWarn(ml.mask, lineNo, mut err)`。
   - `(ml.to, lineNo, mblCopyMask(ml.mask))` を控えておく。
5. 全部の行を読んだ後（`pjLayout` の前）:
   - project の行で控えた kv を `mblProjectSpec` に通して `p.blendSpace` / `p.blendTf` に入れる。
   - クリップごとに `c.blend = mblClipSpec(c.kv, c.kvCols, c.line, p.blendSpace, mut err)`（project の行がクリップの行より後ろにあっても既定が効くように、ここで読む）。
   - 控えたマスクを掛ける: `to != ""` なら ID で探し（なければ `unknown-ref`。`textNearest` で suggest）、`to == ""` なら `mblImplicitTarget(lines, lineNo - 1)` の行（`clips[i].line == target + 1` のクリップ）。そのクリップの `masks` にファイルの順で足す。
   - `mblCheckMaskTargets(lines, mut err)`（`mask-orphan` / `mask-no-target` / 警告 `mask-implicit-target`）。
   - `mblCheckMattes(ids, mattes, visual, lineNos, mut err)`（`visual[i] = clips[i].kind != KIND_AUDIO`）。
   - それから `pjSortDiags`。

### render.um

`RenderCache` に足すもの（`newRenderCache` で作る）:

| フィールド | 中身 |
| --- | --- |
| `blendLut: MblLut`、`blendTf: u32` | `mblNewLut(p.blendTf)`。`renderFrame` の始めに `rc.blendTf != p.blendTf` のときだけ作り直す |
| `matteLayer: Buffer<vec4<f32>>` | マットの元の層（`rc.layer` は対象の層に使うので、別に持つ） |
| `matteCanvas: Buffer<vec4<f32>>` | キャンバスの大きさの作業用（マットの元を透明な下地に描く） |
| `matte: Buffer<f32>` | キャンバスの大きさのマット |
| `masks: MblMaskCache[]` | クリップの番号ごとの `mblNewMaskCache()`（マスクの行と層の大きさが変わらなければ作り直さない） |
| `none: Buffer<f32>` | `mblNoMap()`（使わない mask / matte に渡す） |

`renderFrame` の `for (const ci of p.drawOrder)` の中:

1. ほかのクリップの `matte=` に使われているクリップは描かない（`renderFrame` の始めに、ID の集合を 1 度作る）。
2. `c.blend.used || c.masks.length > 0` でなければ、今の `drawVideo` / `drawImage` / `drawColor` / `drawText` のまま（結果は 1 ビットも変わらない）。
3. そうなら新しい `drawBlended` を通す。今の `drawXxx` は「層を作る」と「`drawLayer` → `fxComposite` → `composite` で重ねる」が 1 つになっているので、層を作る所を関数に分ける:
   `buildClipLayer(dst: mut Buffer<vec4<f32>>, c, m, p, cache, idx, lt, font, rc) -> {ok, x, y, w, h}`
   - video: `yuvToLayer` で `m.w × m.h`。位置は `resolvePos(c.x, m.w, p.width)` / `resolvePos(c.y, m.h, p.height)`。
   - image: `rgbaToLayer` で `m.w × m.h`。
   - color: `clearCanvas(colorVec(c.color))` で `w × h`（`c.w` / `c.h`、0 なら project の大きさ）。効果がなくても層を作る（`fillRect` の近道は使わない）。
   - text: `textClipLayer(c, p, font, mut rc.text)` の `lo.layer`、位置 `lo.x` / `lo.y`、大きさ `lo.w × lo.h`（効果がなくても層を作る。`renderTextClipCached` の近道は使わない）。
4. `drawBlended` の順（**マットを先に作ってから対象の層を作る**。`rc.layer` を上書きしないため）:
   1. マット（`c.blend.matte != ""`）: `mblClearTransparent(mut rc.matteCanvas)`。マットの元 s がその時刻にあれば、`buildClipLayer(mut rc.matteLayer, ...)` → s のマスク → s の効果 → `mblCompositeLayer(mut rc.matteCanvas, 層, none, none, lut, W, H, x, y, w, h, alphaS, MBL_NORMAL, MBL_SPACE_DISPLAY, 0)`（`alphaS` は s の `envelope × opacity`。**`MBL_DST_OPAQUE` は立てない**）。それから `mblMatteFrom(mut rc.matte, rc.matteCanvas, c.blend.matteKind, c.blend.matteInvert)`（元がなければ透明のままなので、マットは 0、反転なら 1）。
   2. 対象の層: `buildClipLayer(mut rc.layer, ...)`。
   3. マスク（効果より前。After Effects と同じ）: `mblBuildMaskCached(mut cache, c.masks, w, h)` が true なら `dispatch(mblApplyMask, w * h, mut rc.layer, cache.mask)`。`rc.masks[idx]` と `rc.layer` は同じ `rc` のフィールドなので、`cache` は呼び出しの前に `rc.masks` から取り出し（空の `mblNewMaskCache()` と入れ替え）、後で戻す。
   4. 効果: `fxComposite` と同じ分け方。`pad = clipFxReach(c)` が正で image / text なら、`padCopy` で `(w + 2 pad) × (h + 2 pad)` の層を作って `applyClipFx` し、**位置は `(x - pad, y - pad)`、大きさは `(w + 2 pad, h + 2 pad)`** で重ねる（マスクは pad の前の層に掛けてあるので、余白は透明のまま）。そうでなければ `applyClipFx(mut rc.layer, c, w, h)`。
   5. 重ねる: `mblCompositeLayer(mut canvas, 層, rc.none, matteOrNone, rc.blendLut, p.width, p.height, x', y', w', h', alpha, c.blend.mode, c.blend.space, MBL_DST_OPAQUE | (マットがあれば MBL_USE_MATTE))`。マスクは 3 で層のアルファに掛けたので `MBL_USE_MASK` は立てない。**キャンバスに重ねるときは必ず `MBL_DST_OPAQUE`**（project の `bg=transparent` / `bg=#00000080` でキャンバスのアルファが 1 より小さくても、今の `blendOver` と同じ式・同じ結果になる）。
5. GPU の経路は `render.um` と同じく `UM_GPU_THRESHOLD=65536` を付けると GPU に載る。

### ops.um

`maskops.um` の関数は「どの行をどう書き換えるか」（`MblPlan`）を返す。`ops.um` は `plan.ok` でなければ `opFail(mut r, plan.code, plan.error, plan.hint)`、ok なら `plan.edits` を順に当てる（`insert` は `opInsert(mut lines, mut r, e.index, e.text)`、`edit` は `opEdit`、`comment` は今の delete と同じく注釈にする変更として記録）。`e.index` は、それより前の edits を当てた後の行の番号（0 から）。

- **`add mask <形> [to=<クリップ>] key=value ... [after <クリップ>]`**: `opKindOf` が `mask` を受け付けないので、`opAdd` の始めで `a[1] == "mask"` を分ける。
  - 掛ける先は `to=` か `after` のクリップ（どちらもなければ `mask-no-target`、違えば `key-not-allowed`）。
  - 掛ける先に ID がなければ、先に `opSetId` で `<kind><n>` を付ける（マスクの行に `id=mask1` は付けない）。
  - `mblPlanAddMask(lines, clipLine - 1, id, 形, kv, refW, refH)`。マスクの行はそのクリップのマスクの行の最後の後ろに入る（`after` の直後ではない。重ね方の順を保つため）。`to=` は必ず付く。`refW` / `refH` は分かるときだけ（編集画面は層の大きさを知っている。color は `w`・`h` か project の大きさ）。分からなければ 0 を渡す（書いた行に `mask-no-ref` の警告が出る）。
- **`set` / `unset` / `delete` の `@行` がマスクの行のとき**: `findClip` は `p.clips` の line で探すのでマスクの行は見つからない。`opFindClip` の前に `mblFindMaskLine(lines, ref)` を試し、見つかれば `mblPlanSetMask(lines, k, kv, implicitId)` / `mblPlanUnsetMask` / `mblPlanDeleteMask` を当てる（`implicitId` は to= のない行の今の掛かる先の ID。to= を書き足す）。
- **`delete <クリップ>`**: クリップの行を注釈にする前に `mblPlanDeleteClip(lines, clipLine - 1, id, fixRefs)`。そのクリップのマスクの行（to= のないものも）を一緒に注釈にする。ほかの行の `matte=` から参照されていれば `referenced`（`fix-refs` なら `matte=` / `matte.type` / `matte.invert` を外す）。
- **`split` と、`cut` でまたぐクリップを分けるとき**: 後半の行を `opInsert` で前半の次に入れる代わりに `mblPlanSplit(lines, firstLine - 1, firstId, secondId, secondText)`。前半の to= のないマスクに to= を足し、後半の行を前半のマスクの後ろに入れ、前半のマスクを `to=<後半>` で写す。`cut` で範囲の中のクリップを消すときは `delete` と同じく `mblPlanDeleteClip`。
- **`rename`**: `opSetId` の後で `mblPlanRenameRefs(lines, old, new)`（マスクの `to=` とほかのクリップの `matte=`）。
- `opInfos` の `add` の usage と example に `add mask ellipse to=clip_b ref=1920x1080 x=660 y=240 w=600 h=600 feather=40` を、`set` / `unset` / `delete` の doc に「マスクの行は @行番号 で指す（`set @12 feather=20`、`delete @12`）」を足す。
- `docs/ai.md` の「2. クリップの指し方」の後ろに、次の節を足す:
  > マスクの行（`mask ...`）は `@行番号` で指します（`check --json` の `clips[i].masks[j].line`）。足すときは `add mask <形> to=<クリップ> ref=<幅>x<高さ> ...`。to= は必ず書き、座標は ref= の大きさの画素か `units=norm` の割合で書きます。マスクは上から順に重なるので、行を並べ替えると結果が変わります。`opacity` は 0〜1 の割合（50% は 0.5）です。

### report.um

- `schemaJson` に `"blend": mblSchemaJson()` を足す（描画モード・伝達関数・クリップと project のキー・マスクのキー（型・範囲・既定・説明）・座標の約束・マットの約束）。
- `check --json` の `clips[i]` に `blend`（`{"mode","space","matte","matteType","matteInvert"}`）と `masks`（`[{"line","shape","mode",...}]`）を足す。

## 速さ（1920x1080、1 回あたり。CPU 24 スレッド / GeForce RTX 5060 Ti の Vulkan。GPU は 10 回分をまとめて読み戻して割った値）

CPU の値は計る度に 2 倍ほど揺れる（ほかの仕事と同じ機械のため）。`node tests/m6-blend/run.mjs --bench` で出る。

| 処理 | CPU | GPU |
| --- | ---: | ---: |
| 重ねる（通常・表示の値） | 10.2 ms | 2.4 ms |
| 重ねる（スクリーン・線形の光） | 13.5 ms | 2.2 ms |
| 重ねる（色相・線形の光） | 23.7 ms | 2.4 ms |
| 重ねる（オーバーレイ・線形・マスク + マット） | 13.5 ms | 2.1 ms |
| マスク 四角（ぼかし 40） | 5.8 ms | 1.1 ms |
| マスク 楕円 | 3.7 ms | 1.4 ms |
| マスク パス（星、10 辺） | 8.4 ms | 1.5 ms |
| マスク ハート（ベジェ 4 本）ぼかし 30 / 300 / 1000 | 17.5 / 6.0 / 6.7 ms | 4.7 / 2.4 / 1.7 ms |
| マスク 120 本のベジェ ぼかし 300 | 16.8 ms | 6.6 ms |
| マスク 2000 点の折れ線 ぼかし 30 / 300 / 1000 | 65 / 21 / 36 ms | 14.5 / 5.8 / 11.6 ms |
| マスク 2000 点のギザギザ（最悪の形）ぼかし 30 / 300 / 1000 | 171 / 14 / 27 ms | 49 / 8.1 / 6.6 ms |
| マスク 2000 点の折れ線 ぼかし 300（2 コマ目から、覚えておいたマスク） | 0.05 ms | 0.01 ms |

- パスは辺を 8 行ずつの帯に分けた表を作り、画素はその帯の辺だけを調べる。
- ぼかしが大きい（層の画素に直して 32 以上）と帯に掛かる辺が増えるので、縁からの距離を `feather/16` 画素（16 まで）おきの格子で求め、画素は双線形の補間で引く。直線の縁では誤差はなく、角や細い所で値の差は最大 0.015 程度（f64 で全部の辺から求めた値との差。平均は 1e-4 未満）。格子の刻みより細かいギザギザの形では、ぼかしの中にうっすら模様が出る（差 0.015 程度）。
- ぼかし 32 未満（格子を使わない）の辺の多いパスはまだ遅い（2000 点で 65 ms）。`mblBuildMaskCached` があるので、キーフレームがないうちは 2 コマ目から費用はほぼ 0。
