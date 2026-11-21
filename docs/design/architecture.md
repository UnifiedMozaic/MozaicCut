# MozaicCut の構成（コアとプラグイン）

この文書は、MozaicCut の内部の約束ごと（モジュールの境界、型、関数の形）を決めるものです。
並行して作業する人・AI は、ここに書いた形を守ってください。形を変えたいときは、先にこの文書を直します。

使う人向けの説明は [README.md](../../README.md)、AI のエージェント向けの手引きは [docs/ai.md](../ai.md) にあります。

## 方針

1. **操作の仕組みは一つ。** ファイル（.mzc）・コマンド（`mozcut op`）・編集画面・AI 用のツールは、同じ操作（move / trim / split …）と同じ名前（クリップの ID）を使い、同じコード（`src/ops.um`）を通る。
2. **出力は二つの形。** 人向け（日本語の文、図、画像）と機械向け（JSON）。診断は必ず原因コード・行・列・直し方を持つ。
3. **UM の強みを使う。** 画素の処理は kernel（CPU の全コア。GPU のビルドなら Metal（Mac）か wgpu（`UM_WGPU=1`。Vulkan / D3D12 / Metal）。どちらでも同じ結果）。読み取りは安全（範囲外は停止、未定義動作なし）。
4. **外の部品は、差し替えやすい境界の向こうに置く。** 素材の展開・シーク・圧縮は UM の FFmpeg の組み込み（`ffmpeg.um` が包み、`media.um` の `MEDIA_BACKEND_FFMPEG` と `encode.um` が使う）、音の出力・ダイアログ・ドロップは UM の SDL3 の組み込み（`audioplay.um`、`editor.um`、`edit2/`）。FFmpeg のライブラリがない環境では `ffmpeg_off.um` に差し替えてビルドし、ffmpeg のコマンドで展開した Y4M / PAM / PCM のキャッシュ（`MEDIA_BACKEND_CACHE`）と probe.txt で動かす（予備の経路）。

## コアとプラグイン

| 層 | 中身 | 場所 |
| --- | --- | --- |
| コア | プロジェクトの読み取りと配置、ID と参照、診断、操作、描画の流れ（展開・合成・YUV 変換・書き出し）、音のミックス、文字、編集画面 | `src/*.um` |
| プラグイン | 効果（色の調整、ぼかし、ビネット、モザイク…）。将来はトランジション・解析・lint も | `plugins/*.um` |
| 生成物 | プラグインの登録表と、プラグインの写し | `src/gen/plugins.um` と `src/gen/fx/*.um` |

UM には関数の値も動的なロードもないので、プラグインは **ビルド時に登録表を生成して一緒にコンパイル** する。

### 生成物と、写す理由

- UM の import は、最初のファイル（`src/main.um` / `src/editor.um`）のフォルダの中しか読めない（`import "../../plugins/x.um"` は `error[import-path]`）。
- そこで `tools/gen-plugins.mjs` は `plugins/*.um` を **中身そのまま（行番号も同じ）** `src/gen/fx/<名前>.um` に写し、登録表 `src/gen/plugins.um` から `"./fx/<名前>.um"` を import する。
- 写しと登録表は、中身が変わったときだけ書く。消えたプラグインの写しは消す。`src/gen/` は手で書き換えない。
- `tools/mozcut.mjs` は `build` の前に必ず `generate(ROOT)` を呼ぶ。エンジンを作り直すかどうかは `src/**/*.um`（`src/gen/` を含む）と `plugins/*.um` の新しさで決める。
- コンパイラの診断が写し（`src/gen/fx/x.um:12`）を指したら、`mapDiagnostics` が元の場所（`plugins/x.um:12`）に読み替えて出す。
- プラグインの中から別のファイルを import するときは、**写しの場所（`src/gen/fx/`）から見た相対パス** で書く（例: `"../../text.um"`）。

### 効果プラグインの書き方

1 ファイルに 1 つ。先頭の注釈に宣言を書き、`fx_<名前>` という関数を 1 つ用意する。

```ts
// plugins/vignette.um
// @effect vignette "周辺を暗くする"
// @param strength 0.5 0..1 "暗くする強さ"
// @param radius 0.6 0..2 "暗くし始める半径（掛ける層の対角の半分を 1 とする）"
// @param softness 0.4 0..2 "暗くなっていく幅"

kernel function vignetteKernel(i: u32, layer: mut Buffer<vec4<f32>>, w: u32, h: u32, p: f32[8]): void {
  ...
}

export function fx_vignette(layer: mut Buffer<vec4<f32>>, tmp: mut Buffer<vec4<f32>>, w: u32, h: u32, p: f32[8]): void {
  dispatch(vignetteKernel, w * h, mut layer, w, h, p);   // 結果は layer に残す
}
```

- `@effect <名前> "<説明>"`: 名前は英小文字・数字・`_`。ファイル名と同じにする。
- `@param <名前> <既定値> <最小>..<最大> "<説明>"`: 0〜8 個。書いた順に `p[0]`, `p[1]`, … に入る。最初の引数が「主の引数」。
- `@alias <別名>`: 効果の別名（例: `sat` に `saturation`）。何個でも。`<別名>=<値>`（主の引数）と `<別名>.<引数>=<値>` の両方で引ける。
- `@whole`: 層全体の大きさ・位置を使う効果（`vignette`、`pixelate`）に付ける。組み込み版の結果は変わらないが、wasm 版（`.mzplug`）を帯に分けずに掛ける印になる（下の「wasm のプラグイン」）。
- `@reach <引数> [<倍率>] [round] [max <画素>]`: 効果が周りへ広がる画素数（引数の値 × 倍率を切り上げ。倍率の既定は 1）。`round` は引数を四捨五入してから倍率を掛ける（効果が整数に丸めた半径を使うとき。blur の半径 1.5 は 2 に丸めて 2 回ぼかすので、広がりは 3 ではなく 4）。`max` は、広がりがそれを超えるときに wasm 版を帯に分けない（帯の始まりで足す順が変わり、丸めが変わる計算に切り替わるとき）。`blur` は `@reach radius 2 round max 20`（箱ぼかし 2 回。半径 10 を超えると窓を滑らせる計算）、`sharpen` は `@reach radius 1`。描画は、透明なまわりのある層（image と text）に、この分の透明な余白を足してから効果を掛ける（層の四角でぼかしが切れないように）。不透明な層（video と color）は余白を足さず、端の画素をくり返す（画面の端が暗くならないように）。
- 層の中央・層の大きさを使う効果（`vignette` など）の「中央」「対角」は、**掛ける層** のもの。クリップの行なら、そのクリップの層（文字なら文字の箱、小窓なら小窓）。画面全体を基準にしたいときは project の行に書く。
- 層は `Buffer<vec4<f32>>`（RGBA、0〜1、ストレートアルファ）、大きさ `w × h`。`tmp` は同じ大きさの作業用。**結果は `layer` に残す。**
- 色の効果はアルファを変えず、結果を 0..1 に収める。近くの画素を平均する効果（blur など）は、アルファで重み付けして平均する（プリマルチプライの形で平均し、最後にアルファで割る）。そうしないと、透明な画素の見えない色が混ざって縁が暗くにじむ（文字の層で目立つ）。
- 名前の空間は全ファイルで 1 つなので、プラグインの中の kernel や補助関数には名前を前置する（`vignetteKernel` など）。
- 標準のプラグイン: `blur` `bright` `contrast` `gray`（別名 `grey`）`invert` `pixelate`（別名 `mosaic`）`sat`（別名 `saturation`）`sepia` `sharpen` `vignette`。

### プロジェクトファイルでの書き方

```
video "a.mp4" bright=0.1 vignette=0.6 vignette.radius=0.9 blur=2
```

- `<効果>=<値>` は主の引数を決めて効果を有効にする。`<効果>.<引数>=<値>` はその引数を決めて有効にする。
- 効果は **行に初めて出てきた順** に掛ける（上の例は bright → vignette → blur）。効果ごとに 0..1 に収めるので、順を変えると結果が変わることがある。
- 書かなかった引数は既定値。範囲外はエラー（`out-of-range`）。
- 効果は video / image / text / color の行に書ける。**そのクリップの層にだけ掛かる**（小窓やロゴにも別々に掛かる）。audio の行に書くと `key-not-allowed`（「'blur' は効果なので audio の行では使えません」）。
- **project の行に書くと、合成した画面全体に掛かる**（`project vignette=0.5`。調整レイヤーの代わり）。`Project.fx` に入り、`renderFrame` がすべてのクリップを重ねた後に、行に書いた順に掛ける。透明な color の行（`opacity=0`）は描かれないので、調整レイヤーにはならない。
- 効果の名前だけの語（`video "a.mp4" gray`）は、主の引数の既定値で掛ける（`gray=1` と同じ）。
- 文字の行は、透明な層に文字を描いてから効果を掛け、合成する（`textClipLayer` → `applyClipFx` → composite）。効果のない文字はキャンバスに直接描く。

### 生成される登録表（`src/gen/plugins.um`）の形

```ts
export const FX_PARAMS: i32 = 8;
export struct FxKey { effect: i32; param: i32; }          // 見つからなければ -1, -1
export function fxCount(): i32
export function fxName(e: i32): string
export function fxDoc(e: i32): string
export function fxParamCount(e: i32): i32
export function fxParamName(e: i32, k: i32): string
export function fxParamDoc(e: i32, k: i32): string
export function fxParamDefault(e: i32, k: i32): f32
export function fxParamMin(e: i32, k: i32): f32
export function fxParamMax(e: i32, k: i32): f32
export function fxFindKey(key: string): FxKey             // "blur" → (blur, 0)、"vignette.radius" → (vignette, 1)、"saturation" → (sat, 0)、"saturation.amount" も
export function fxAliasCount(e: i32): i32                 // 別名の数（schema と候補の提示に使う）
export function fxAlias(e: i32, i: i32): string
export function fxReach(e: i32, params: f32[8]): i32       // 周りへ広がる画素数（@reach。なければ 0）
export function fxApply(e: i32, layer: mut Buffer<vec4<f32>>, tmp: mut Buffer<vec4<f32>>, w: u32, h: u32, params: f32[8]): void
```

- 効果の番号は `plugins/` のファイル名のアルファベット順（いまは blur=0 … vignette=9）。プラグインを足すと番号がずれるので、**番号を決め打ちせず、名前から `fxFindKey` で引く。**
- 引数のない効果の `fxFindKey("name")` は `(e, -1)` を返す。

`tools/gen-plugins.mjs` は `generate(rootDir)` と `mapDiagnostics(text)` を export する ES モジュールで、`plugins/*.um` を読んで上の形のファイルを書く。宣言の誤り（重複、範囲の書き間違い、既定値が範囲の外、コアのキーとのぶつかり、`fx_<名前>` がない）は、ファイル名と行を付けて例外にする（`plugins/sepia.um:2: 既定値 2 が範囲 0..1 の外です`）。

## モジュール

| ファイル | 役目 | 主な公開 |
| --- | --- | --- |
| `text.um` | 文字列・数・時間・色の読み取り、`fmtTime` | `sub` `parseNum` `parseTime` `parseColor` `splitBy` `splitLines` `fmtTime` `textNearest` |
| `keys.um` | コアのキーの表（schema、候補の提示に使う） | `KeyInfo` `coreKeys()` |
| `project.um` | .mzc の読み取り、配置、ID と参照、診断 | `Project` `Clip`（`file` は素材のファイルの場所）`FxUse` `Diag` `diag` `Probe`（`file`、`unreadable`）`parseProject` `readProbes` `findClip` `validClipId` `emptyProject` `frameCount` `frameTime` |
| `ops.um` | 操作（move / trim / split / delete / cut / set / unset / renamekey / add / rename / mix） | `OpResult` `Change` `BatchResult` `splitArgs` `runOps` |
| `report.um` | 人向け・機械向けの出力 | `jsonStr` `diagText` `diagsJson` `projectJson` `showText` `schemaText` `schemaJson` |
| `render.um` | 1 コマの描画（素材の読み取りは media.um を通す、効果、合成、YUV 変換、BMP） | `renderFrame` `renderFrameFrom` `RenderCache` `newRenderCache` `renderCacheBuffers` `applyClipFx` `loadMedia` `loadMediaFor` `releaseMedia` `checkMedia` `canvasToYuv` `writeBmp` |
| `media.um` | 素材の読み手（FFmpeg の組み込みでその場で展開する。予備は展開したキャッシュ）と素材の情報。描画と音のミックスはここを通して読む | `MediaSource` `MEDIA_OPEN_*` `mediaOpenClip` `mediaNone` `mediaOpenY4m` `mediaFrameAt` `mediaReadFrame` `mediaReadFrameRacy` `mediaReadSound` `mediaRelease` `mediaSpec` `mediaReopen` `mediaClipKey` `mediaTake` `mediaYuvK1` `mediaYuvK2` `mediaProbeSources` `mediaProbeFile` `mediaRemember` `mediaSourcePath` |
| `ffmpeg.um` | UM の FFmpeg の組み込み（標準の動画・音声の関数）の包み。`ffmpeg_off.um` は同じ形で「使えない」と答える版（ライブラリがないときに差し替える。どこからも import しない） | `FfInfo` `FfOpen` `FfDone` `ffEnabled` `ffVersion` `ffProbe` `ffOpenVideo` `ffOpenAudio` `ffReadVideo` `ffReadAudio` `ffClose` `ffCreate` `ffAddVideo` `ffAddAudio` `ffWriteYuv` `ffWriteSamples` `ffFinish` |
| `audioplay.um` | 編集画面の音の再生（SDL3 の音の出力。鳴らした標本の数を再生の時計にする。track の行のトラックの処理も掛ける。鳴らした区切りのメーターの値を覚える）。editor.um と新しい編集画面（edit2/）だけが import する | `AudioPlay` `ApMeter` `newAudioPlay` `apReload` `apUpdate` `apMeterAt` `apClose` `apStatsJson` |
| `encode.um` | MP4（H.264 + AAC）を FFmpeg の組み込みで直接書く。締め切りまで少しずつ進める。出力の大きさ（黒い帯）・コマの速さ・ビット毎秒・音の大きさの目標を選べる。render --out と書き出しのワークスペースが使う | `EncOpts` `EncJob` `encDefaults` `encOpen` `encStep` `encFinish` `encAbort` `encFraction` `encBitRate` |
| `playback.um` | 再生のエンジン（状態・J/K/L の速さ・時計・コマ落ちの方針・映像のコマの先読み） | `Playback` `FrameCache` `PrefetchWorker` `newPlayback` `pbTick` `pbPlan` `pbShown` `pbPrefetchRun` `fcVideoYuv` など（下の「再生」） |
| `wasmfx.um` | wasm の効果プラグイン（`.mzplug`）の読み込みと実行（wasmtime） | `WasmFxSet` `wasmFxLoad` `wasmFxIndex` `wasmFxApply` `wasmFxReach` |
| `ttf.um` | TrueType / TTC の読み取りと、アンチエイリアスつきの文字の画像 | `Font` `loadFont` `defaultFont` `uiFont` `projectFont` `TextImage` `renderTextImage` `textWidthPx` `decodeUtf8` |
| `gradelayer.um` | 映像・画像のクリップの色の調整（`grade.*`）と LUT を層に掛ける（BT.1886 で線形にし、`colGradeApply` → `colApplyLutIn` → 戻す）。焼いた表と読んだ .cube のキャッシュ | `GradeCache` `newGradeCache` `gradeCacheFrame` `gradeLayer` `clipGraded` `gradeLutPath` `gradeLutError` |
| `ws_color/` | 色のワークスペース（ui.md 2.3）。`wsc_model.um`: Clip.grade ⇔ パネルの値、変更 → set / unset の操作（`wscOpsFor`）、ドラッグの間の値（`wscApplyLive`）。`wsc_scope.um`: スコープを 自動 / CPU / GPU で計算。`wsc_ws.um`: `wscWorkspace` が描いて `WscEvent[]` を返す | `WscState` `wscNew` `wscSync` `wscSetLuts` `wscWorkspace` `wscEdits` `WscEvent` `wscOpsFor` `wscApplyLive` `wscGradeOf` `wscLutItem` `wscScopeImage` |
| `textlayer.um` | 文字のクリップの描画（縁取り・影・背景・揃え） | `renderTextClip`（キャッシュなし）、`TextLayerCache` `newTextLayerCache` `textCacheFrame` `textCacheClear` `renderTextClipCached` `textClipRect` `textClipDrawLayer` `textClipLayer` `TextLayerOut` |
| `ui.um` | 編集画面の部品（四角、文字） | `uiRect` `uiBlend` `uiFrame` `UiTextCache` `uiTextCache` `uiTextFrame` `uiTextF` `uiTextWidthF` `uiTextHeightF` |
| `lineedit.um` | .mzc の行の key=value の書き換え | `hasKey` `setKey` `removeKey` `secText` `keyValue` `setPositional` `addFlag` `removeFlag` など |
| `audio.um` | 音のミックス（media.um の読み手から。track の行があれば、音のトラックごとに処理してから足す） | `clipHasSound` `openSounds` `releaseSounds` `mixRange` `mixAudio` `mixTracksBlock` `mixTracksBlockFrom` `AudioMix` `audioMixOpen` `audioMixReload` `audioMixRead` `audioMixClose` |
| `ws_audio/mzc.um` | track の行（音のトラックとマスターの設定）の読み取りと書き戻し | `WsaTrackSet` `WsaBand` `wsaParseRow` `wsaParseEq` `wsaFmtEq` `wsaFmtComp` `wsaSetOf` `wsaSetCopy` |
| `ws_audio/chain.um` | トラックごとの処理（EQ → コンプ → 音量 → パン）とマスターの音量。書き出しとメーターが同じこれを通す | `WsaMix` `WsaBlock` `wsaBlockNew` `wsaMixActive` `wsaMixUpdate` `wsaTrackProcess` `wsaAudible` `wsaPrerollFrames` |
| `ws_audio/model.um` / `ws_audio/panel.um` | 音のワークスペース（本物の音のメーターとラウドネス、値の変化を `mix` の op にする。1 つの関数で描いて出来事を返す） | `WsaWs` `wsaWsNew` `wsaWsAdvance` `wsaWsAnalyzeAll` `wsaWsEvent` `wsaWsSync` `wsaPanel` `WsaEvent` |
| `font.um` | 5x7 のビットマップフォント（TrueType がないときの予備。`ttf.um` と `ui.um` が使う） | — |
| `main.um` | コマンド（ウィンドウなし） | — |
| `editor.um` | 編集画面（SDL3） | — |
| `gen/plugins.um` | プラグインの登録表（生成物） | 上の形と `FxReg`（下の「wasm のプラグイン」） |
| `m6_anim/*.um` | キーフレーム（読み取り・評価・操作・グラフエディタ・時刻の再マップ）。詳しくは `docs/design/m6-anim.md` | `AnimTrack` `animParse` `animResolve` `animEval` `animOpAdd` … `animOpRebase` `animRemapTime` |
| `m6_shape/*.um` | シェイプ（shape の行の形・塗り・線・トリム・リピーター、升の表と 1 回の dispatch の kernel）。詳しくは `docs/design/m6-shape.md` | `ShapeSpec` `shapeParse` `shapeKeyInfos` `shapePrepareAt` `shapeDrawDirect` `shapeRenderLayer` |
| `m6_textanim/*.um` | テキストアニメーター（anim= のキーとプリセット、字ごとの動きの kernel）。詳しくは `docs/design/m6-textanim.md` | `taIsKey` `taCheckKey` `taCheckClip` `taKeyInfos` `taClipAnimated` `taDrawCanvas` `taRenderLayer` `taSpecJson` |
| `m6_particles/*.um` | パーティクル（キーの表と読み取り、決まった結果のシミュレーションと kernel、クリップごとのキャッシュ） | `PtSpec` `ptIsKey` `ptSpecFromKv` `ptResolveSpec` `ptCheckClip` `PtCache` `ptCacheDraw` `ptCacheDrawLayer` `ptDescribe` |
| `m6_3d/*.um` | 3D レイヤーとカメラ（キーの表と読み取り、仮のキーフレーム、アトラスと遠近の描画）。詳しくは `docs/design/m6-3d.md` | `T3LayerSpec` `T3SceneSpec` `t3IsLayerKey` `t3ParseLayer` `t3ParseScene` `t3AtlasPut` `t3Render` `t3ShiftText` |
| `m6_expr/*.um` | エクスプレッション（式の言語・評価・評価の順・画素の式の kernel）。詳しくは `docs/design/m6-expr.md` | `ExprProg` `exprParseValue` `exprLink` `exprOrder` `exprEvalFull` `exprSchemaJson` `exprProgJson` |
| `m6_blend/*.um` | 描画モード・マスク・トラックマット（kernel、キーと mask の行の読み取り、操作の手順）。詳しくは `src/m6_blend/README.md` | `MblClipSpec` `mblClipSpec` `mblParseMaskLine` `mblCompositeLayer` `mblBuildMaskCached` `mblMatteFrom` `mblPlan*` |

### 診断（`project.um`）

```ts
export struct Diag { code: string; severity: string; line: i32; col: i32; msg: string; hint: string; suggest: string; }
export function diag(code, line, col, msg, hint): Diag       // severity "error"
export function warnDiag(code, line, col, msg, hint): Diag   // severity "warning"
export function parseProject(text: u8[], probes: Probe[], diags: mut Diag[]): Project
```

- `severity` は `"error"` か `"warning"`。`line` は 1 から（0 はファイル全体）、`col` は 1 から数えた文字の位置（UTF-8 の 1 文字を 1 と数える。0 は行全体）。
- `msg` と `hint` は日本語。`hint` は直し方（「`color` のことですか？」「`at=1:02.5` のように書きます」）。なければ ""。
- `suggest` は hint が「'x' のことですか？」で始まるときの x（`diag()` が hint から取り出す）。AI が引用符を読まずに使えるように。JSON では `"suggest"`（なければ null）。
- 原因コード（`code`）は英小文字とハイフン。決まったものだけを使い、増やしたらこの表に足す。

| code | 意味 |
| --- | --- |
| `syntax` | 字句の誤り（閉じていない `"`、`=` の前にキーがない） |
| `unknown-type` | 行の先頭が project / video / image / text / color / audio / shape / particles / track / mask のどれでもない |
| `unknown-key` | 知らないキー（近いキー・効果・別名を hint に出す） |
| `key-not-allowed` | キーは正しいが、その行では使えない（text の `w`、video の `size`、image の `in`、audio の効果、project の行の `track` など）。hint に使える行 |
| `unexpected-value` | key=value でない余分な値 |
| `bad-number` / `bad-time` / `bad-color` / `bad-enum` | 値の形が違う（`at=` が時間としても参照としても読めないときは `bad-time`。`1:99` のように分・秒の欄が 60 以上も `bad-time`） |
| `out-of-range` | 値が範囲の外。負の時間（`dur=-1`、`at=-1`、`fade=-0.5`。形は時間として正しいので `bad-time` ではない。op の時刻と同じ）。参照から求めた開始が負になる場合（`at=intro.start-5`）もこれで、開始は 0 に置く。素材の長さが分かっていて、`in` + 長さ（`out` か `dur`）が素材の終わりを超える場合もこれ（`op trim` と同じ判断。長さは素材の終わりまでに縮めて置く）。`in` が素材の終わり以降の場合もこれ（使える範囲がない） |
| `missing-source` | 素材のファイルの指定がない。または、素材のファイルが見つからない（`mediaProbeSources` が見つからない印を付けたもの、予備の経路では `mozcut.mjs` が probe.txt に `missing` と書いたもの。hint に探した場所） |
| `unreadable-source` | 素材のファイルはあるが、FFmpeg の組み込みで読めない（壊れている・途中で切れている・動画や音のファイルでない）。msg に FFmpeg の理由。長さ・映像と音の有無の誤りは重ねて出さない |
| `no-video-stream` / `no-audio-stream` | 素材に映像・音がない |
| `unknown-length` | 長さが分からない（out / dur がなく、素材も調べていない） |
| `empty-clip` | 長さが 0 以下 |
| `bad-project` | project の値（大きさ・fps・rate）の誤り |
| `bad-grade` | 色の調整（`grade.*`）の値の誤り（`colGradeSet` の理由。0 以下のガンマ、点の足りないカーブ、範囲の外の色温度など） |
| `empty-timeline` | クリップが 1 つもない |
| `bad-id` / `duplicate-id` | ID の形の誤り、重複 |
| `missing-track` / `duplicate-track` | track の行に `audio=<番号>` も `master` もない、同じトラックの track の行が 2 つある（後の行を使わない） |
| `unknown-ref` / `ref-cycle` | 参照先がない、参照が輪になっている（そのクリップは 0 に置く）。輪に at= のないクリップがあれば、hint に「X は at= がないので、同じトラックの前の行の Y の後ろに置かれます」と足す |
| `bad-escape` | （warning）文字の値の中の知らないエスケープ（`"\x"`。`\` を外して読む）。使えるのは `\n`（改行）`\t`（タブ）`\"` `\\` |
| `font-not-found` | （warning）project の `font=` のファイルが見つからない（既定のフォントで描く） |
| `key-not-animatable` | 許可の表（`animTypeForKey`）にないキー（`dur` など。数・時間・色の型）の値に `@` を書いた（キーフレームにできない） |
| `anim-syntax` / `anim-bad-value` / `anim-bad-time` | キーフレームの形（`@` がない、キーがない）・値（型の誤り、有限でない、位置の `center`）・時刻（読めない、`end+1`、コマなのに fps が不明）の誤り |
| `anim-bad-interp` / `anim-bad-ease` / `anim-bad-tangent` / `anim-spatial-not-allowed` | 知らない印（suggest つき）、影響・速度・cubic の誤り、`tin` / `tout` の形、2 次元でないキーの経路の印 |
| `anim-key-overlap` / `anim-remap-range` | 同じ時刻（4 分の 1 コマ以内）のキー、`timeremap` が負か素材の長さを超える時刻を見せる |
| `anim-key-order` / `anim-key-outside` / `anim-tag-unused` | （warning）書いた順と時刻の順が違う、補間にも使わないクリップの外のキー（すぐ外の 1 つは出さない）、効かない印 |
| `anim-duplicate` / `anim-no-effect` / `anim-word-no-space` | （warning）テキストアニメーターの同じキーを 2 回書いた（後が効く）、掛ける値がない、空白のない文に by=word |
| `expr-syntax` / `expr-type` / `expr-unknown-clip` / `expr-cycle` | エクスプレッションの字句・構文（空白を含み引用符で囲まない `x=expr(a, b)` も。suggest に直した行）、型、`clip('ID')` の参照先がない、参照の輪。ほかの `expr-*` は `docs/design/m6-expr.md` の表 |
| `bad-mask-shape` / `bad-path` | mask の行の形が rect / ellipse / path でない、パスの d が読めない（列は d の中の誤りの位置） |
| `mask-no-target` / `mask-orphan` | to= のないマスクの上に映像の行がない、上の映像の行が注釈になっている（消したクリップ。黙ってほかに掛けない） |
| `matte-gap` | （warning）マットの元が塗る側の時刻の一部にない（`pjCheckMatteTimes`。配置の後） |
| `duplicate-key` | （warning）効果の同じ引数（別名を含む）を 2 度書いた。後に書いたほうを使い、キーフレームも (fx, param) で 1 つにまとめる |
| `key-ignored` | （warning）3D のレイヤーの `blend=` / `matte=`、3D でない video / image / text / color の `rotation` / `scale` / `anchor` |
| `timeremap-audio` | （warning）音のある（mute でない）video の `timeremap`（音は再マップしない） |
| `matte-self` / `matte-missing` / `matte-not-visual` / `matte-chain` | 自分自身をマットにした、`matte=` なしで `matte.type` / `matte.invert` を書いた、音の行をマットにした、マットの元にも `matte=` がある（連鎖は使えない） |
| `mask-implicit-target` / `mask-no-ref` | （warning）to= のないマスク（行の並びで掛かる先が変わる）、ref= も units= もないマスク（層の大きさが変わるとずれる） |

- 予定の code: `bad-plugin`（`.mzplug` が読めない。ファイルがない、wasm でない、宣言がない・壊れている、abi が違う、export の形が違う、名前が組み込み・コアのキー・ほかの包みとぶつかる）。`wasmfx.um` の `wasmFxLoad` が `WasmFxDiag` で返すが、エンジンにつなぐまでは check の診断には出ないので、上の表には載せない（つないだら表に移す。下の「wasm のプラグイン」）。

#### warning の扱い

- warning は `warnDiag()` で作る。いま warning なのは `bad-escape`、`font-not-found`、`anim-key-order`、`anim-key-outside`、`anim-tag-unused`、`mask-implicit-target`、`mask-no-ref`、`anim-duplicate`、`anim-no-effect`、`anim-word-no-space`。ほかはすべて `"error"`。
- キーフレームの値の範囲の外（`opacity="0@0 2@1"`）は、ふつうの値と同じ `out-of-range`（列はそのキー）。
- warning の約束（`main.um` / `ops.um` / `editor.um` はこの形で動く）:
  - `check` の終了コードと「問題はありません」の判定には数えない（エラーが 0 なら 0）。エラーと一緒にあるときは「エラー N 個、警告 M 個」。
  - `diagText` は `警告[code]` と出す。
  - `render` / `preview` は止めない（エラーがあるときだけ止める）。
  - `runOps` の「新しい誤りが増えたか」には数えない。
- 何を warning にするかは、決めたときにこの表に書き足す（候補: 画面の外に出たクリップ、ロゴなどが最後のクリップより長く残る）。素材より長い `out` は `op trim` と揃えて error（`out-of-range`）にした。

### ID と参照（`project.um`）

- `id=<名前>`: 英字・数字・`_`・`-`、先頭は英字か `_`（`validClipId`）。ファイルの中で重複しない。
- `at=` に参照を書ける: `at=intro.end`、`at=intro.start+1.5`、`at=intro.end-0.5`、`at=after:intro`（`intro.end` と同じ）。オフセットは時間の書き方（`1:02.5` も可）。
- クリップの指し方（操作・コマンドで使う）: `intro`（ID）、`#3`（0 から数えた番号）、`@7`（行番号）。`findClip(p, ref)`、見つからなければ -1。
- 時刻の書き方: 秒（`12.5`）、分:秒（`1:02.5`）、時:分:秒（`1:02:03`）。分と秒の欄は 60 未満。負の時刻は `out-of-range`。
- 配置は依存関係の順に決める（参照先が後ろの行にあってもよい）。`at` を書かないクリップは、同じトラックの **それより前の行** のクリップがすべて配置されてから、その終わりの最大に置く（`xfade` はそこから引く）。輪になった参照は `ref-cycle`。
- 参照のある `at` は、読んだ直後は UNSET で、配置が実際の時刻を入れる。
- `Clip` は、`at=` に書いたままの文字列（`atText`）、行に書いた key=value（`kv`。位置で渡す値と id は含まない）、配置が確かか（`placed`。参照先がない・輪・参照から負になったなどで仮の 0 に置いたら false）を持つ。`projectJson` がそのまま出す。

### コアのキーの表（`keys.um`）

```ts
export struct KeyInfo { name: string; kinds: string; type: string; def: string; min: string; max: string; doc: string; }
```

- `kinds` は使える行（`"project"`、`"video,image"` のようなコンマ区切り、`"*"` は project 以外のすべて）。読み取りもこの表で確かめるので、表と読み取りは必ず一致する。schema の JSON では `"*"` を並べて出す。
- `type` は `time` / `number` / `int` / `color` / `pos` / `string` / `enum:a|b` / `flag`。project の `size` と `fps` は専用の型がないので `string`。`at` は参照も書けるが `time`。
- 別名の欄はないので、別名（project の `dur` / `out`、`vol`）は別の項目として載せ、説明に「〜の別名」と書く。schema の JSON は、説明がそう終わる項目に `aliasOf`（`"output"` など）を付ける。
- `vec2` は `pos`（x,y）の型。キーフレームで動かせるか（schema の `animatable`）は、この表ではなく `m6_anim/anim.um` の許可の表（`animTypeForKey`）で決まる（表の欄を足すと、ほかの部品の `KeyInfo` の作り方がみな変わるため）。

### テキストアニメーター（`project.um` / `render.um`）

- 読み取り: `taIsKey` のキーは効果・unknown-key の判断より先に `taCheckKey`（text でない行は key-not-allowed）。値は `Clip.kv` に残す。text の行の終わりで `taCheckClip`。
- 描画: `drawText` は `taClipAnimated(c)` なら `taDrawCanvas`（効果なし）か `taRenderLayer` → `fxComposite`。毎コマ `taClipSpec(c, p)` で kv から読み直す（1 クリップ数マイクロ秒）。位置は `clipPos`（TaStyle の xAbs / yAbs）。
- 範囲のキーフレーム（`anim.start="0@0 100@1"`）は、いまは m6_textanim の中の小さな読み取り（印は linear / hold / ease / easein / easeout）。m6_anim の `animParse` / `animEval` に替えるのは残りの仕事。

### 3D レイヤー（`project.um` / `render.um` / `ops.um`）

- 読み取り: video / image / text / color の行の `t3IsLayerKey` のキーは kv に残し、行の終わりで `t3ParseLayer`（`Clip.d3`）。project の行の `camera.*` / `light.*` / `mblur.*` は行の終わりで `t3ParseScene`（`Project.scene3d`）。T3Diag は Diag に写す（列は 0）。
- 描画: `c.d3.is3d` のクリップは層を作ってアトラスに入れ、続けて並ぶ 3D のクリップを 1 組にして `t3Render` で重ねる（次の 2D のクリップの前と最後）。アトラスは `rc.t3atlas`、重い場面の和は `rc.t3work` から pop / push で借りる。
- 操作: 後ろ半分・trim start は 3D のキーの時刻を `t3ShiftText` でずらす。
- 残り: 3D のキーフレームを m6_anim に替える。描くときの注意（`3d-heavy` / `3d-atlas`）を診断に出す。

### パーティクル（`project.um` / `render.um`）

- 行の種類 `particles`（`KIND_PARTICLES`）。ptIsKey のキー（x / y / color / size / blend も粒の意味）は pjApplyKey を通さず kv に残し、行の終わりで `ptSpecFromKv` の診断を Diag にする（列は kv の組の値の列）。配置のあとで `ptCheckClip` と `layer=` の参照。particles の行の `blend=` は描画モードとして読まない。
- 描画: `drawParticles` が毎コマ `ptResolveSpec(ptSpecFromKv(c.kv))` を作り、`rc.pt`（クリップの ID か `@行` ごとの状態）を時刻まで進めて描く。シミュレーションに関わる値が変われば作り直す。emit=layer は text / color のクリップの層を 1 度だけ渡す。効果のある `blend=add` は `ptAddLayer`。`draw=image` の画像の展開はまだない。

### シェイプ（`project.um` / `render.um` / `ops.um`）

- 行の種類 `shape`（`KIND_SHAPE`）。行の 2 番目（か `shape=`）が形の種類。形のキー（`shapeIsKey`）は pjApplyKey を通さず、行の終わりで `shapeParse` にまとめて渡し、`ShDiag` を Diag にする（列は値の中の位置まで）。形のキーのキーフレーム（`shapeAnimType`）は ClipAnim にし、shapeParse には最初のキーの値を渡す。
- keys.um は `shapeKeyInfos()` を kinds `shape` で載せる（`pos` / `w` / `h` は行の種類ごとに別の項目）。`tools/gen-plugins.mjs` は `.mzplug` に使えない名前に shape_spec.um の `shKey` の名前も入れる。
- 描画: `drawShape`（`shapePrepareAt` → 効果がなければ `shapeDrawDirect`、あれば層に `shapeRenderLayer` して `fxComposite`。層は効果の広がる分の余白を含むので、余白は足さない）。キーフレームの値は `clipAt` が `ShapeSpec` に入れる。キーフレームの x / y は左上の画素（`shapePlaceAt` の xAbs / yAbs）。

### エクスプレッション（`project.um` / `render.um` / `report.um`）

- 読み取り: 値が `expr(` で始まるか、キーが `<名前>.expr` なら `Clip.exprKv` に残す。全部の行を読んで配置したあとで、`exprEnvFor()`（コアの値と効果の引数の名前の表）で `exprParseValue` → `exprLink` → `exprOrder`。結果は `Project.exprProgs` / `exprNodes` / `exprKeys` / `exprOrder`。
- 描画: `exprFrame` がコマの始めに全部のクリップの値（キーフレームを評価した後、解いた後の画素）を場面に入れ、評価の順に式を求めて書き戻す。`exprApply` がクリップの写しに入れる（x / y は左上の画素）。
- `pos` / `pos.expr` は `position` として読む。`exprFrame` は式の値 `position` にキーフレームの `pos` を渡し（`ExprKey.v` は `AnimKey.v` の 4 つ）、キーを使う式（`usesKeys`）には `animEval` の値の表（コマの 1/4 ごと）を `exprCtxSetCurve` で渡す。
- 音量の式は音のミックスが評価しないので、読み取りで `key-not-allowed` にする。
- 残り: 画素の式（`pixel=`）、音量の式を音のミックスに使う、`op set` で式を正規の形（`exprCanonValue`）にして書く。

### 描画モード・マスク・トラックマット（`project.um` / `render.um` / `ops.um`）

- 読み取り: 行の種類 `mask`（クリップではない。`drawOrder` にも配置にも入らない）。全部の行を読んだあとで、to= のクリップ（なければすぐ上の映像の行）の `Clip.masks` にファイルの順で足す。クリップの `blend` は `mblClipSpec(c.kv, c.kvCols, ...)`（既定は project の `blend.space`）。project の行の `blend.space` / `blend.tf` は行ごとに `mblProjectSpec`。
- 描画: `c.blend.used` かマスクのあるクリップだけ `drawBlended` を通る（ほかは今までどおりで、結果は変わらない）。層（`clipLayerRect` / `fillClipLayer`）→ マスク（効果より前）→ 効果（image / text は広がる分の余白）→ `mblCompositeLayer`（キャンバスにはいつも `MBL_DST_OPAQUE`）。マットは、マットの元をキャンバスの大きさの透明な下地に描いて `mblMatteFrom`。マットの元は画面に描かない。
- 操作: `maskops.um` の `MblPlan`（行の書き換えの手順）を `opApplyPlan` で当てる。`add mask`、`set / unset / delete @行`（マスクの行）、`delete`（マスクも注釈、`matte=` から参照されていれば `referenced`）、`split`（後半はマスクの後ろ、マスクを `to=<後半>` で写す。`opSplitM` がマットの元を分けた後、`matte=` の行を時刻で振り分け、またぐ行は同じ時刻で分けて後半を `matte=<後半>` にする）、`rename`、`cut`。

### キーフレーム（`project.um` / `render.um` / `ops.um`）

- 読み取り: 許可の表のキーか効果の引数の値が `@` を含めば `animParse` で読み、`Clip.anims` / `Project.anims`（`ClipAnim { key, track, line, col, lo, hi, fx, param }`）に入れる。ふつうの欄には最初のキーの値を入れる（キーフレームを知らない部品のため）。配置のあとで `animResolve`（end・コマ、重なり、順番）、`timeremap` は `animRemapCheck` と素材の範囲（`Clip.remapLo` / `remapHi`。plan はこの範囲を展開する）。
- 位置: キーフレームの `x` / `y` と `pos` は左上からの画素（`Clip.xAbs` / `yAbs`）。位置は `clipPos(v, abs, size, canvas)` だけで解く（render / textlayer / editor の写しはやめた）。
- 描画: `renderFrameFrom` は、キーフレームのあるクリップだけ `clipAt(c, lt)`（評価して差し替えた写し。数は `lo` / `hi` に丸める）で描く。不透明度・フェードの判定も差し替えた値で行う。素材の時刻は `clipSourceTime`（`timeremap` か `in + lt`）。project の行の効果の引数はタイムラインの時刻で評価する。音量は `audio.um` が 256 標本ごとに評価して直線で補う。
- 操作: `key add|remove|move|set|ease|shift|clear`（`anim_ops.um` が値の文字を返し、`setKey` で書き戻す）。`split` / `trim` / `cut` は `animOpRebase` でキーの時刻を直す（前半・trim end は end からのキーを始まりからに、後ろ半分・trim start は始まりからのキーをずらす）。`cut` は project の行のキーを `animOpCutRange` で詰める（範囲の中のキーは消し、またぐ所に ta − 1 コマと tb の値の直線のキーを置く）。
- クリップの中の時刻: text / shape / particles の `in=` はクリップの中の時刻の始まり、`full=` は中の時刻の全体の長さ（`Clip.fullDur`。0 なら in + dur）。描画はテキストアニメーター・粒・drawon / drawoff を `clipInnerTime` / `clipInnerDur` で求める（キーフレームはクリップの始まりからの時刻のまま）。`split` / `trim` / `cut` は `opRebaseInner` で `in=` / `full=` を書く。
- 効果のキーはここに書かない（登録表にある）。
- track の行（音のトラックとマスターの設定）のキーも、いまはこの表に載せず、`src/ws_audio/mzc.um` の `wsaParseRow` が確かめる（`schema` の keys には出ない。`mix` の op は ops に出る）。表に載せるなら kinds に `track` を足し、`"*"` が track の行を含まないようにする。

### 音のトラックの設定（track の行。`ws_audio/mzc.um` / `ws_audio/chain.um`）

```
track audio=0 name="声" vol=-3 pan=-0.2 eq=highpass:80,peak:3200:3.5:1 comp=-20:3:10:100:6:2
track audio=1 mute
track master vol=-1
```

- `audio=<n>` は音のトラックの番号（クリップの `track=` と同じく 0 から。映像の音は、その映像のクリップの `track=` の音のトラックに入る）。`master` は全体。1 つのトラックに 1 行（2 行目は `duplicate-track`）。
- `vol`（dB。-70 以下と `-inf` は無音、上は +12）、`pan`（−1〜1。ステレオのバランス）、`mute` / `solo`（語。`=1` / `=0` も可）、`eq`（1〜8 帯。`種類:周波数[:利得 dB[:Q]]` をコンマで。種類は src/dsp の名前。`eqoff` で素通し）、`comp`（`しきい値:比[:アタック ms:リリース ms[:ニー dB[:メイクアップ dB]]]`。省くと 10 / 100 / 6 / 0。`compoff` で掛けない）、`name`。マスターの行は `vol` と `name` だけ。
- 処理の順は EQ → コンプ → 音量 → パン、全トラックを足してからマスターの音量。ソロのトラックがあれば、ソロでないトラックは足さない。
- track の行が音を変えないとき（行がない・名前だけ）は、書き出しは前のミックスと 1 ビットも違わない。途中からの書き出しは、いちばん長いリリースの 10 倍（最低 1 秒）手前から助走して捨てるので、全体の書き出しの同じ所と同じになる。
- 音のワークスペース（`ws_audio/model.um`）は書き出しと同じ `mixTracksBlock` で混ぜ、マスターを s16 に丸めてから測るので、全体を測った統合ラウドネス・真のピーク・標本のピークは、書き出しの音を測った値と一致する（`src/ws_audio_test.um`）。
- 新しい編集画面（`src/edit2/ws_audio.um`）の「音」のワークスペースも同じ `WsaWs` を使う。メーターは今のコマの 1 コマ分を `mixTracksBlock` で混ぜた値（止まっている間はラウドネスに入れない）。確定した値は `mix` の op で track の行に書く（`docs/design/edit2.md` の「ワークスペースの担当へ」）。

### 操作（`ops.um`）

```ts
export struct Change { kind: string; line: i32; before: string; after: string; }   // kind: "edit" / "insert" / "comment"。line は変更後の行番号（1 から）
export struct Moved { id: string; line: i32; beforeStart: f64; beforeEnd: f64; afterStart: f64; afterEnd: f64; }
export struct OpResult { ok: bool; op: string; code: string; desc: string; error: string; hint: string; newId: string; changes: Change[];
                         suggest: string; newDiagnostics: Diag[]; moved: Moved[]; }
export struct OpInfo { name: string; usage: string; doc: string; example: string; }
export function opInfos(): OpInfo[]          // schema に載せる操作の一覧
export function isOpName(s: string): bool    // 大文字・小文字は区別しない
export struct BatchResult { ok: bool; results: OpResult[]; lines: string[]; diags: Diag[]; }
export function splitArgs(line: string): string[]
export function runOps(lines: string[], probes: Probe[], ops: string[][]): BatchResult
```

- 操作の書き方（`mozcut op <project> <操作> ...` と、操作のファイルの 1 行）:

| 操作 | 意味 | 書くもの |
| --- | --- | --- |
| `move <clip> <at>` | 開始を動かす（`<at>` は時間か参照） | `at=` |
| `trim <clip> start <time>` / `trim <clip> end <time>` | タイムライン上の始まり・終わりを決める | `at` / `in` / `out` / `dur` |
| `split <clip> <time>` | タイムライン上の時刻で 2 つに分ける。後ろ半分は次の行。ID は `<id>_2`（重複すれば `_3`…）。ID がなければ後ろにも付けない。マットの元なら、`matte=` で使う行もまたげば同じ時刻で分ける | 2 行〜 |
| `delete <clip> [fix-refs]` | 行を `# ` で注釈にする。ほかの行の `at=` から参照されていたら `referenced` で止める。`fix-refs` なら、参照している行の `at=` を今の秒に書き換えてから消す | |
| `cut <開始> <終わり>` | タイムライン上の範囲を全トラックから切り取り、後ろを詰める（リップル削除）。範囲の中のクリップは消し、範囲にかかるものは短くし（始まりを切った映像・音は `in` を進める）、範囲の両端をまたぐ映像・音と、時刻で見え方が変わるクリップ（キーフレーム・式・3D のキーのキーフレーム・粒・字の動き・drawon。`opCutSplits`）は終わりの時刻で分けてから詰める（動かない文字・色・画像は分けずに短くする）。project の行のキーフレームも詰めた時刻に直す。秒で書いた `at=` は詰めた分だけ書き直し、参照の `at=` は付いて動けばそのまま残す。読み直して行き先と違うクリップは `at=` を秒にする | 多数 |
| `renamekey <clip> <old> <new>` | キーの名前だけを同じ場所で変える（効果の掛ける順を保つ。書き間違いの直しに） | |
| `set <clip> key=value ...` | 値を決める（効果のキーも） | |
| `unset <clip> key ...` | キーを消す | |
| `add <kind> [<素材 / 文字 / 色>] key=value ... [after <clip>]` | 行を足す（既定はファイルの最後、`after` ならその行の後ろ）。`id` がなければ `<kind><n>` を自動で付け、`newId` に返す | 1 行 |
| `rename <clip> <newid>` | ID を変える（`at=` の参照も書き換える） | |
| `mix <音のトラックの番号\|master> key=value ...` | 音のトラック（またはマスター）の track の行の値を決める。行がなければ最後の track の行の後ろ（なければ project の行の後ろ）に足す。`mute=1` / `mute=0` で語を付け外しし（solo / eqoff / compoff も）、値を空にするとキーを消す。値の形と範囲は読み直しの診断で確かめる | 1 行 |
| `key add\|remove\|move\|set\|ease\|shift\|clear <clip> <キー> ...` | キーフレームを足す・消す・動かす・値を変える・補間を決める・ずらす・やめる（上の「キーフレーム」） | `<キー>=` |

- 細かい決まり:
  - `set` で位置で渡す値（text の文字、video / image / audio の素材、color の色）は `text=...` / `src=...` / `color=...` で変える。`mute` のような値のない語は `set <clip> mute` で足し、`unset <clip> mute` で消す。
  - 映像・音の長さは `out=` と `dur=` のどちらか一方で決める（両方あると読み取りは `out=` を使う）。`set` で `dur=` を書くと `out=` を消し、`out=` を書くと `dur=` を消す（desc に「長さが効くように out=5 を消しました」）。
  - 文字の値（`set <clip> text=...`、`add text "..."`）の中の `\n`（2 文字）は改行にする。行には `"...\n..."` と書かれ、読み取りで改行に戻る。
  - `add` の 2 番目の語が `key=` を含まなければ、位置で渡す値とみなす。`=` を含む文字を足すときは `add text text="a=b"` と書く。
  - `split` で ID があるとき、ほかの行の `<id>.end` / `after:<id>` を `<id>_2` に向け直す。後半の `at=` は `<id>.end`。
  - `move` / `trim` で、参照の `at=` を持つクリップを動かすと、参照は秒に置き換わる（参照で動かすなら `move <clip> intro.end+1`）。
  - 時間は `secText` で書く（ミリ秒で丸める）。`set x dur=1:02.5` のように `set` で書いた値は正規化せずそのまま残す。
- `splitArgs`: 空白で分ける。`"..."` は 1 つの引数にまとめ（語の途中から始まる `key="a b"` も）、中の `\"` は `"`、`\\` は `\` にする。ほかの `\x` は `\` を残す（Windows のパスをそのまま渡せるように）。文字の改行は、上のとおり `ops.um` が文字の値に限って `\n` を改行にする（パスには効かない）。編集画面は `splitArgs` を通さず、改行を含む値を `runOps` に直接渡せる。
- 操作の名前は大文字・小文字を区別しない（`Move` も `move`）。知らない名前には近い名前を hint と `suggest` に出す。`<clip>` が見つからないときも近い ID を出し、ある ID は 12 個まで並べて「…ほか N 個（show で一覧）」と書く。
- 成功した操作は、操作で指したクリップと足した行を除いて、時刻（開始か終わり）が変わったほかのクリップを `moved` に入れ、`desc` の後ろに「ほかに N 個のクリップの時刻が変わりました: clip_a 2→0 秒、…」と足す（`delete` で at= のない後ろのクリップが詰まった、参照しているクリップが付いて動いた、など）。
- `desc` は人向けの日本語の 1 文（「clip_b を 5 秒から 5.5 秒に動かしました」）。編集画面の状態表示と、取り消しの履歴にも使う。
- `runOps` は操作を順に適用し、**各操作の後に読み直して** 新しい誤り（severity が error のもの）が出たらそこで止める（`ok=false`、`lines` は元のまま）。全部成功したら `ok=true` で新しい `lines` を返す。元から誤りがあるファイルでも、誤りを増やさない操作は通す。
- 失敗したバッチでは、失敗した操作より前の結果も `ok=false`・`code="not-applied"`・`changes` は空にする（何も適用していないため）。

操作の失敗の code（`OpResult.code`）:

| code | 意味 |
| --- | --- |
| `unknown-op` | 知らない操作の名前 |
| `unknown-clip` | `<clip>` で指したクリップがない（hint に指し方と、ある ID を出す） |
| `bad-args` | 引数の数や形の誤り（hint に書き方の例を出す） |
| `not-applied` | 同じバッチのあとの操作が失敗したので、適用しなかった |
| `referenced` | `delete` するクリップが、ほかのクリップの `at=` から参照されている（error に参照している ID を並べ、hint に `fix-refs` を出す） |
| 診断の code | 操作の結果、新しい誤りが増えたときは、その診断の code（`out-of-range`、`unknown-key`、`key-not-allowed`、`unknown-ref`、`ref-cycle`、`bad-id`、`duplicate-id` など）。`error` は「この操作で誤りが増えるため、適用しませんでした（N 行目: 診断の msg）」、`hint` は診断の hint（`unknown-ref` のときは、別のクリップの名前を勧めず「参照している行の at= を秒にするか…」）。その診断は `newDiagnostics` にも入る（行は元のファイルの番号。足すはずだった行なら 0） |

### コマンド（`main.um` と `tools/mozcut.mjs`）

- エンジン（`build/mozcut`）のコマンド: `check` `show` `op` `schema` `motion`（人と AI が使う）、`sources` `plan` `render` `preview`（`mozcut.mjs` が使う）。
- `motion <project> <cache> <映像> <x,y> --to <クリップ> [--dry-run] [--json]`（`motion.um`）: 展開した Y4M で点を追い（`m6_track` の `trkTrackVideo`）、`--to` のクリップの `pos` のキーフレームを `runOps` の `set` で書く。`mozcut.mjs motion` は素材を展開してから呼ぶ。follow / stabilize の描画（`.trk` を描くときに当てる）は、まだつないでいない。
- `check / show / op <project> [cache] ...`: cache は省ける（`<名前>.cache/probe.txt` があれば使う）。`op` の 2 番目の語が操作の名前でなければ cache とみなす。`mozcut.mjs` は素材を調べてから cache を添えて渡すので、利用者は cache を書かない。
- 素材の情報（`Probe`）は、エンジンが `mediaProbeSources(text, projectPath, fallback, mut known)` で作る。FFmpeg の組み込みがあれば、素材ごとに「ファイルがあり読める → FFmpeg で調べた情報（`file` つき）」「ファイルはあるが読めない → 読めない印（`unreadable` に FFmpeg の理由、`file` つき。エンジンが `unreadable-source` にし、描画と編集画面は開こうとして同じ理由を出す）」「ファイルがなく probe.txt にある → その情報」「ファイルがなく probe.txt もない → 見つからない印」。`known`（編集画面が書き換えのたびに調べ直さないための覚え）は、ファイルの場所ごとに 1 件（`mediaRemember`。読めなかったものも印のまま覚える）。FFmpeg なしの版は probe.txt だけ。`Probe.file` は配置のときに `Clip.file` になり、`media.um` はそれを直接開く（`file` のないクリップは展開したキャッシュから読む。テストの架空の素材もこの道）。
- `caps`: `ffmpeg\t1\t<FFmpeg の版とライセンス>` か `ffmpeg\t0`。`mozcut.mjs` は 1 なら ffprobe も事前の展開もせず（展開した Y4M を読む `motion` だけは展開する）、古い probe.txt を消す（残すと、見つからない素材が「調べていない素材」の扱いになるため）。
- `render <project> <cache> [from] [to] --out <file>`: FFmpeg の組み込みで MP4 を直接書く（`cmdEncode`）。映像の符号器は形式の名前 `"h264"`（UM がハードウェアの符号器から順に試し、なければ LGPL のソフトウェアの符号器。GPL の libx264 は使わない）、ビット毎秒は crf から大きさとコマの速さに合わせて決める（crf 20 で 720p30 は約 4.2 Mbps、6 上がるごとに半分）。音は AAC 192 kbps で、映像の時刻を追いかけて 1 秒ずつ混ぜて書く（`audio.um` の `AudioMix`。track の行があれば `mixAudio` と同じくトラックの処理とマスターを掛ける）。`--out` がなければ Y4M + PCM を cache に書く（予備の経路。`mozcut.mjs` が ffmpeg のコマンドで圧縮する）。
- 終了コード: 0 は成功、1 は誤りがある・操作が失敗した・ファイルが読めない、2 は使い方の誤り（引数がない、知らないオプション、知らないコマンド）。
- `check` の人向けの出力は `diagText` の並びと、最後に「問題はありません（クリップ N 個、長さ m:ss.mmm）」か「エラー N 個」。`--json` は `projectJson`。
- `show` は 1 行目にファイル名、続けて `showText(p, width)`（`--width`、既定 100）。誤りは標準エラーに出し、図は分かる範囲で描く。
- `op` の人向けの出力は、操作ごとに `desc` と「`  - 行: 前` / `  + 行: 後`」の差分、最後に「保存しました（path）」か「保存していません（--dry-run）」。失敗したら何も書かず、標準エラーに「（n 番目の操作（...）:）エラー[code]: 理由」「ヒント」「何も書き換えていません」を出して終了コード 1。
- `op --json`: `{"ok":..,"saved":..,"results":[{op,ok,code,desc,error,hint,suggest,newId,changes:[{kind,line,before,after}],moved:[{id,line,before:{start,end},after:{start,end}}],newDiagnostics:[...]}],"diagnostics":[...]}`。`saved` は実際に保存したか（`--dry-run` や失敗なら false）。失敗したときも人向けの文は標準エラーに出る。
- `op <project>` の後ろに操作がなければ使い方の誤り（終了コード 2）。操作を 1 つの引数にまとめて書いたもの（`op p.mzc "move pip 2"`）は `splitArgs` で分ける。2 番目の語が `/` か `\` を含むか `.cache` で終わるなら cache とみなす。
- `op --file <path | ->`: 1 行に 1 つの操作。空の行と `#` で始まる行は飛ばす。元のファイルが CRLF なら CRLF のまま保存する。
- 読めないファイルのとき、エンジンの `check --json` / `op --json` は `{"ok":false,"error":"'x.mzc' を読めません"}` を出して終了コード 1。`mozcut.mjs` も、`--json` があれば自分で止める誤り（プロジェクトがない、操作がない、使い方の誤り）を `{"ok":false,"error":"..."}` として標準出力に書く（終了コードは 1 か 2。文は標準エラーにも出す）。
- 予備の経路の `mozcut.mjs` は、見つからない素材を probe.txt に `<src>\tmissing\t0\t0\t<探したパス>` と書く。エンジンはそれを `missing-source`（行の番号つき）にする。
- `render` / `preview` は、エラーがあると診断を標準エラーに出して終了コード 1。`render --from a --to b` で範囲が空（`a >= b`、または `a` が全体の長さ以上）なら「範囲が空です」で終了コード 2。`preview` の時刻が全体の長さ以上なら警告を出して描く（背景だけ）。`mozcut.mjs preview` は最後の画像の場所だけを「p4.png に書きました（0:04.000）」と出す。
- 表記: 時刻は、人向けの文の中（desc・hint）は「5.5 秒」、表と図（show・check の合計・preview）は `m:ss.mmm`。トラックは show で `V0` / `A0`、文では「映像トラック 0」「音トラック 0」、JSON は `track` と `trackKind`（`"video"` / `"audio"`）。

### 出力（`report.um`）

- `diagText(path, d)`: `demo.mzc:7:12: エラー[unknown-key]: 'colr' というキーはありません` と、hint があれば次の行に `  ヒント: ...`。`col` が 0 なら `demo.mzc:7: ...`、warning は `警告[...]`。
- `diagsJson(diags)`: `[{"code":..,"severity":..,"line":..,"col":..,"message":..,"hint":..}]`
- `projectJson(p, diags)`: `{"ok":..,"project":{width,height,fps:"30/1",rate,duration,effects:[..]},"clips":[{index,id,line,kind,track,trackKind,start,end,duration,in,src,text,at,placed,keys:{..},effects:[{name,params:{..}}]}],"mix":[...],"diagnostics":[...]}`。`mix` は track の行の値（`wsaSetJson`。track の行がなければ出さない）。`ok` は error の診断が 0 個か。時間は秒の数。ないもの（id・src・text・in・at）は `null`。`at` は書いたままの文字列（参照か秒。省略なら null）、`keys` は行に書いた key=value（文字列のまま。x / y / size / color / bg なども読める）、`placed` が false なら誤りのため仮の位置。診断は `suggest` も持つ。
- `showText(p, width)`: 端末向けのタイムライン図（目盛り、トラックごとの行、クリップのラベル）と、クリップの一覧（番号・ID・行・種類・トラック・時間・素材・効果）。track の行があれば、その後ろに音のトラックの設定の表（トラック・行・名前・音量・パン・ミュート / ソロ・EQ・コンプ）。ファイル名は出さない（呼ぶ側が先に書く）。文字の幅は東アジアの全角を 2 と数える。
- `schemaText()` / `schemaJson()`: コアのキー（`coreKeys()`）、プラグインの効果・引数・別名、時刻と参照の書き方、操作の一覧（`opInfos()`）。JSON は `{"version":2,"keys":[{name,kinds:[..],type,values?,default,defaultExpr?,aliasOf?,min,max,doc}],"effects":[{name,doc,kinds:[..],aliases:[..],params:[{name,key,default,min,max,doc}]}],"effectsNote","ops":[{name,usage,doc,example}],"syntax":[..]}`。keys は (name, kinds) で 1 つずつ（同じ name でも行の種類で意味が違う。project の `out` は `aliasOf:"output"`）。`type` が `"enum"` なら `values` に選択肢。`default` は数の型なら数か null（`size/14` のような式は `defaultExpr`）、ほかは文字列か null。kinds の `"*"` は並べて出す。

### 描画（`render.um`）

```ts
export struct RenderCache { text: TextLayerCache; frame: i64; ... }    // ほかのフィールド（作業用の Buffer の置き場）は render.um の中だけで使う
export function newRenderCache(): RenderCache
export function renderCacheBuffers(rc: RenderCache): i32                // 置き場にある Buffer の数（試し用）
export function renderFrame(p: Project, media: MediaSource[], cache: string, t: f64, canvas: mut Buffer<vec4<f32>>, font: Font, rc: mut RenderCache): void
export function renderFrameFrom(p: Project, media: MediaSource[], cache: string, t: f64, canvas: mut Buffer<vec4<f32>>, font: Font, rc: mut RenderCache, fc: FrameCache): void
export function applyClipFx(layer: mut Buffer<vec4<f32>>, c: Clip, w: u32, h: u32): void
```

- 呼ぶ側は、フォントを `projectFont(p.fontPath, p.fontIndex)`（`ttf.um`）で、`rc` を `newRenderCache()` で、どちらもプロジェクトを読んだ後に **1 度だけ** 作り、毎コマ同じものを渡す（フォントの読み込みは 5〜8 ms、文字の画像を毎コマ作ると数 ms かかる）。編集画面は、`fontPath` / `fontIndex` が変わったときだけ読み直す。
- `renderFrame` は先読みなしで描く（書き出し・preview）。`renderFrameFrom` は、映像のコマを先読みの置き場 `fc`（`playback.um` の `FrameCache`）から引き、なければファイルから読む（編集画面の再生）。どちらも同じ画素になる（315 コマで確かめた。CPU でも GPU でも）。
- `rc.text` は文字の画像（被覆率と縁取りで太らせた画像）を持つ。鍵は文字・大きさ・揃え・縁取りの太さ・フォント。90 フレーム使わなかったものを捨て、64 個か画素の合計 2400 万を超えたら古いものから捨てる。
- `rc` は作業用の Buffer（層・効果の作業用・余白つきの層の `vec4<f32>`、素材の YUV / RGBA の `u8`）の置き場も持つ。長さが同じものを借りて返し（`takeV4` / `giveV4` / `takeU8` / `giveU8`）、大きさが変わったときだけ確保する。返したものはそのフレームのあいだ「使用中」に置き、次のフレームの始めに戻す（GPU がまだ読んでいる素材を書き換えないため）。30 フレーム使わなかったもの、24 個を超えたもの、vec4 の置き場が 256 MB を超えた分は古いものから捨てる。置き場は renderFrame を呼んだときだけ整えるので、編集画面で止めているあいだは最近使った Buffer を持ったまま。
- 映像の YUV は `yuvPixel(yuv, i, w, h, k1, k2)` が係数で RGB にする（`media.um` の `mediaYuvK1` / `mediaYuvK2`。BT.709 / BT.601 / BT.2020 と限られた範囲 / いっぱいの範囲。展開したキャッシュは BT.709 の限られた範囲で、前の版の定数と同じ値なので画素は変わらない）。FFmpeg で読む素材は、素材の色の行列のまま受け取る（印がなければ BT.601。ffmpeg のコマンドと同じ扱い）。
- 効果のない映像と画像は、層に広げずにキャンバスへ直接重ねる（`yuvComposite` / `rgbaComposite`）。重ねる kernel は層の下の端の行までに絞って dispatch し、画面と重ならない層は描かない。
- `renderFrame` はクリップをすべて重ねた後に、`Project.fx`（project の行の効果）を画面全体に掛ける。
- 効果のあるクリップは `fxComposite` で重ねる。image / text の層で `fxReach` の合計が 0 より大きければ、その分の透明な余白を足した層に効果を掛け、余白のぶん左上へずらして置く。
- `applyClipFx` はクリップの効果（`Clip.fx`）を行に書いた順に掛ける（作業用の `tmp` は呼ぶたびに 1 つ確保する。置き場から借りたものを渡すなら `applyClipFxTmp`）。
- 古い効果のフィールド（`Clip.bright` など）は消した。効果はすべて `Clip.fx: FxUse[]` にある。
- GPU のビルド（`UM_WGPU=1`）の注意: UM の自動の振り分け（dispatch）は kernel ごとに決めるので、キャンバスが CPU 側にあると、どの kernel も単独では GPU が遅く見え、すべて CPU を選ぶ（GPU の準備の分だけ CPU 版より遅くなる）。いまは `UM_GPU_THRESHOLD=65536` を付けて動かすと GPU に載る。UM に「GPU を優先する dispatch」か「置き場所を考える振り分け」が入るまでの当座の手。

### 再生（`playback.um` / `media.um`）

- 部品: `Playback`（メインのスレッドだけが持つ。状態・速さ -4〜4 倍・再生位置・時計・統計）、`FrameCache`（スレッドで共有するコマの置き場。プロジェクトの大きさの YUV 4:2:0 の枠を 8〜48 個、約 96 MB）、`PrefetchWorker`（先読みのスレッドが持つ、自分で開いた素材）。
- 毎フレームの手順（編集画面のループ。順番が大事）:
  1. 入力を処理する（Space = `pbToggle`、J / K / L = `pbKeyJ` / `pbKeyK` / `pbKeyL`、クリック = `pbSeek`、← → = `pbStep`）。
  2. `pbTick(mut pb, clock())`: 時計を進め、見せるコマ（`pb.frame`）を決める。変わったら true。コマは「画面に出る時刻 + 画面の更新の半分」の時計で決める（先回りは pbTick から pbShown までの時間の移動平均で自動に決まる）。
  3. `pbPlan(mut pb, fc, p)`: これから見せる数コマを先読みに頼む。順再生と止まっているときは、いまのコマから再生の向きに画面の更新 `ahead` 回分（近い順）。逆再生は、見せるコマを `pbReverseChunk` 個（枠の数 /（2 × 見える映像のクリップの数）、3〜30）ずつの塊に分け、いまの塊（いまのコマまで）と 1 つ前の塊を、それぞれ前から頼む（先読みのスレッドは塊の頭へ 1 度だけ戻り、あとは続けて展開する。後ろへ 1 コマずつ読むと、毎コマ前のキーフレームから展開し直すため）。
  4. `thread.spawn(pbPrefetchRun, own wk, fc, clock() + pbWorkerBudget(pb))` で先読みを走らせ、そのあいだに `renderFrameFrom(..., pbFrameTime(pb), ..., fc)` で描いて画面に出す。逆再生で、見せるコマに要るコマがまだ枠にない（`!pbFrameReady`）ときは、描かずに前のコマを出したまま待つ（最大 0.15 秒。越えたら描く。メインのスレッドがその場で展開すると、その展開器が毎回前へ戻るシークをして先読みと CPU を取り合うため）。
  5. 描いたときだけ、`windowPresent` の直後に `pbShown(mut pb, clock())`。
  6. `wk = thread.join(h)`。spawn から join までは `wk` に触らない。
- プロジェクトを書き換えた・素材を展開し直したら `pbReload(mut pb, fc, p, cache)`（世代が進み、古い枠は使わない）。大きさが変わって `!pbCacheFits(fc, p)` なら、spawn と join のあいだ以外で `fc = newFrameCache(p)` を作り直してから呼ぶ。
- コマ落ちの方針: 遅れたら飛ばす（見せるコマは常に時計から決める）。2 倍・4 倍（逆も）では、見せるコマを速さの倍数（`pbGrid`）にそろえる（見せるのは毎秒 fps コマ。画面の更新の揺らぎで、先読みが頼んだのと違うコマを見せないため）。速さのために飛ぶのは、コマ落ちには数えない。
- 遅れ（`lateMsAvg` / `lateMsMax`）: 画面に出た時刻の時計 − そのコマの始まりの時刻。壁時計では、時計がコマの始まりに届いた壁時計の時刻（`dueWall`）からの経過。音の時計で進んでいるとき（`pbAudioActive`）は、画面に出た時刻の音の時計から数える。
- 統計: 人向けは `pbStatsText(pb, fc)`、機械向けは `pbStatsJson(pb, fc)`（`{"state","speed","t","frame","shown","skipped","dropped","hits","misses","waits","hitRate","fetched","fetchFailed","fetchMsAvg","lateMsAvg","lateMsMax","displayMs","slots","slotBytes","clock"}`）。
- 音の時計（`audioplay.um`）: 編集画面のループは、入力の処理の後・`pbTick` の前に `apUpdate(mut ap, mut pb, project, clock())` を呼ぶ。音を鳴らすのは等速の順再生のときだけ（`pbAudioWanted`）。逆再生・2 倍・4 倍と停止中は出力を止めて待ち行列を捨て、壁時計で進む（速さを変えた音はまだない）。鳴らし始め（再生の始め・シーク・等速に戻したとき。pb が `audioOk` を落とす）は、その位置から混ぜた音を 0.1 秒分ためてから鳴らし、待ち行列が 0.1 秒を下回ったら 1024 フレームずつ足す。時計 = 鳴らし始めの位置 + (`audioPlayed` − 基準 − `audioLatency`) / rate を `pbAudioClock` に渡す（`newAudioPlay` が音の出力を開けたら `PB_CLOCK_AUDIO` にする）。音のデバイスがなければ何もしない。
- 素材の読み手（`media.um`）: FFmpeg の組み込みで開く素材（`MEDIA_BACKEND_FFMPEG`）では、n 番目のコマ = 素材の in + (n + 0.5) / fps 秒に表示されるコマ（ffmpeg の fps フィルタと同じ選び方）。大きさは `main.um` の `scaleFilter` と同じ規則（contain / cover の切り抜き / stretch、映像は偶数）。展開器は 1080p まで CPU、高さ 1440 を超えるものはハードウェア（`"auto"`）。`MediaSource` は 1 つのスレッドで使う。先読みのスレッドは、`pbReload` の後に `pbWorkerSync(mut wk, pb)` で受け取った写し（`mediaSpec`）から、自分の展開器を開き直す（`mediaReopen`）。メインのスレッドの `pb.srcs` は情報だけ（`MEDIA_OPEN_INFO`。展開器を開かない）。
- 編集画面は書き換えのたびに `reloadMedia` で素材を開き直すが、印（`mediaClipKey`: 素材・種類・in・長さ・大きさ・fit・プロジェクトの大きさと速さ）が同じクリップは展開器を使い続ける（`mediaTake`）。キャッシュを読む素材がなければ（`mediaUsesCache`）、展開の結果の変化を見に行かない。
- UM の組み込みの誤りの回り道: 素材と同じ大きさの 8 ビットの YUV 4:2:0 を同じ形式で受け取ると、色差の面の行がスレッドの区切りごとに欠ける（2026-11 の UM の main）。拡大縮小しないときは 10 ビットで受け取って 8 ビットに戻す（`ffmpeg.um` の `FF_PIX_YUV420_VIA10`）。
- GPU の経路では、kernel のパイプラインを初めて作るときに約 0.5〜1 秒止まる（その間のコマは飛ぶ）。再生の前に、各種類のクリップを 1 コマずつ描いて温めておくのが今後の課題。

### 文字（`ttf.um` / `textlayer.um`）

- `size` は画素（フォントの em の大きさ。既定 48、4..1000）。`color` `bg` `pad` `shadow`（影の色。ずらす量は max(1, size/16)）`outline`（縁取りの色）`outlinew`（縁取りの太さ。既定 size/14。読み取りの時点で実際の値を入れる）`align`（left / center / right。既定 center）。
- 行の送りは hhea の ascender − descender + lineGap。文字の箱の高さは (行数 − 1) × 行の送り + (ascender − descender)。
- フォント: `project font="C:/Windows/Fonts/YuGothM.ttc" fontindex=0`。指定がないか読めなければ、`defaultFont()` が既定の候補（游ゴシック Medium、BIZ UDゴシック、メイリオ、Arial Unicode、IPAex ゴシック、DejaVu Sans）を順に探す。ファイルが見つからなければ警告 `font-not-found` を出す（形式が読めない場合は、診断なしで既定の候補に戻る）。TrueType（glyf）のアウトラインだけを扱う（CFF は扱わない）。見つからなければ 5x7 のビットマップフォントに戻る。
- 不透明度（fade・opacity）は、背景の箱・影・縁取り・文字を透明な色に重ねた後に 1 回だけ掛ける（効果のある経路 `tlDrawLayer` と同じ見た目。フェードの途中で文字の中に縁取りが透けない）。
- 縁取りは文字の外側だけでなく内側も覆う（文字の下に敷く）。そのため **文字の色そのものを半透明にすると、文字の中に縁取りの色が透ける**。これは仕様とする（縁取りを外側だけにすると、不透明な文字の縁に背景がにじむため）。半透明の文字にしたいときは `opacity=` を使う。
- タブは次のタブの位置（空白 4 つ分の倍数）まで進める。幅のない文字（U+200B〜U+200D、U+2060、U+FEFF、異体字セレクタ、肌の色の修飾子）は描かない。結合文字（U+0300〜U+036F など）は前の字に重ねる。フォントにない字（絵文字など）は □ になる（予備のフォントはまだ引かない）。
- 縁取りは距離変換（kernel 3 つ）で太らせる。文字の画像は 6400 万画素を上限とし、超えるときは大きさを縮めて描く（`TextImage.sizePx`）。
- まだ扱わないもの: カーニング（kern / GPOS）、ヒンティング、合字、縦書き、合成文字。
- 編集画面の文字は `uiFont()`（Yu Gothic UI = `YuGothM.ttc` の 1 番を優先）。グローバル変数がないので、`uiTextF(..., font, mut cache: UiTextCache)` のようにキャッシュを引数で渡し、フレームの始めに `uiTextFrame(mut cache)` を呼ぶ。

### 編集画面（`editor.um`）

- 編集はすべて `runOps(ed.lines, ed.probes, [op])` を通す。ドラッグの終わりは `move <ref> <at>` か `trim <ref> start|end <時刻>`、S は `split <ref> <再生位置>`、Del は `delete <ref>`。`<ref>` は ID があれば ID、なければ `@行番号`。
- 成功して行が変わったら保存し、`desc` を状態の帯に出す。取り消しの履歴は `{text, desc}`。失敗したら帯に赤で `[code] error ／ ヒント: hint` を出し、ドラッグ前の見た目に戻す。
- 診断は `diagText` と同じ中身を 1 行にして帯に出す（ほかにあれば「（ほかに n 件）」）。
- 再生は `playback.um` が受け持つ。`Playback` と `FrameCache` と `PrefetchWorker` は `runEditor` の変数で、入力の処理（`keyDown` / `mouseDown` …）は `Editor.pbq` に頼み（シーク・コマ送り・Space・J / K / L）を積み、ループが毎フレーム `pbTick` の前に渡す（`Editor` に `Playback` を持たせると、`pbReload(mut ed.pb, fc, ed.project, ...)` のように同じ変数を mut と別の引数で同時に渡すことになり、UM の借用の決まりで書けないため）。`ed.t` / `ed.playing` / `ed.playText` は毎フレーム pb から写す表示用の値。
- プロジェクトを読み直したら（`reparse`）、また素材の展開の結果（大きさ・コマ数・展開した範囲）が変わったら（`poll` の `mediaChanged`）、`ed.pbStale` を立て、ループが `pbReload` する。
- 起動: `mozcut-edit`（スタート画面。`node tools/mozcut.mjs edit` をプロジェクトなしで呼ぶと、`--home` を絶対パスで付けて起動する）、`mozcut-edit <p.mzc>`（キャッシュは `<名前>.cache`。素材は展開しない）、`mozcut-edit <p.mzc> <cache> --managed --home <build>`（`mozcut.mjs edit` の呼び方。パスは絶対パス）。
  - `--managed`（予備の経路の `mozcut.mjs edit` の呼び方）: 素材の展開は呼んだ側（`mozcut.mjs`）が受け持つ。FFmpeg の組み込みで開くクリップは展開を待たない（`clipMissing` に数えない）。開けなかったものは赤の枠に展開器の理由を出す（`clipFfFailed`）。展開されていないクリップには「素材 n 個（クリップ m 個）を展開しています…」と出す。受け持つ者がいなければ「素材が展開されていません」と、MozaicCut のフォルダで打つコマンドとクリップの一覧を出す。素材のファイルそのものがないクリップ（`missing-source`）は、編集画面が `fileExists` で調べ、展開の案内とは別に赤で「素材のファイルが見つかりません: <探したパス>」と出す（状態の帯の 2 行目にも）。2 つ目の引数（cache）があるときも managed とみなす（前の版の `mozcut.mjs` との互換）。
  - `--home <dir>`: 最近開いたプロジェクト（`<dir>/mozcut-recent.txt`。新しい順で最大 10 件）とデモ（`<dir>/../demo/demo.mzc`）の基準。指定がなければ、いまのフォルダに `build/mozcut-edit` があれば `build`、いまのフォルダに `mozcut-edit` があれば `.`、どちらでもなければ分からない（デモと最近の一覧を使わず、スタート画面で `--home` を案内する。今いるフォルダに一覧を書き散らかさない）。UM に実行ファイルの場所か今いるフォルダを知る組み込みが入ったら、それで決める。
  - 最近の一覧には絶対パスだけを書く（相対パスは別のフォルダから開けないため。UM に今いるフォルダを知る組み込みがないので、相対パスで開いたものは一覧に入れない）。デモと同じファイルは、相対・絶対の違いがあっても（後ろが同じで中身も同じなら）重ねて出さない。長いパスは途中を「…」で省く。
- ドロップ: `WindowEvent.DropFile(w, file, x, y)` で `dropMedia`。種類は FFmpeg で調べて見分け（映像があって長さがあれば video、長さがないか画像の拡張子なら image、音だけなら audio。FFmpeg なしの版は拡張子）、素材の情報（`mediaProbeFile`）を `ed.probes` に足してから `add <kind> <src> at=<時刻> [track=<n>]` を通す。位置は `dropPlace`: タイムラインの上（見出しの列より右）なら、落とした x の時刻（`snapTime` で端に吸い付き、コマの境目に丸める）。行の上で種類（映像・画像か音か）が合えばその行のトラック（0 なら書かない）。タイムラインの外なら全体の長さ（末尾）。FFmpeg なしの版は長さを調べられないので、映像と音は `dur=5` を書いて足す（書かないと unknown-length が増えて op が断る）。`<src>` はプロジェクトのフォルダの中なら相対パス（区切りは /）、外なら絶対パス。スタート画面では `.mzc` を落とすと開く（素材を落として新しいプロジェクトを作ることはまだない）。
- スタート画面の Ctrl+O: `windowOpenFileDialog`（.mzc / すべて）。結果は `WindowEvent.Dialog` で届き、`startDialogDone` が開けるか確かめる。
- 試し用の引数: `--op "<操作>"`（何度でも）、`--select <ref>`、`--seek <時刻>`、`--play <速さ>`（開いたらすぐ再生。負なら逆再生）、`--frames <n>`（スタート画面と編集画面の合計で n フレーム描いたら終わる）、`--shot <x.bmp>`（終わるときの画面）、`--stats`（終わるときに `pbStatsJson` を標準エラーに `playback: {...}` で出す）、`--start-select <i>` / `--start-open <n>`（スタート画面の項目を選ぶ・n フレームで開く）、`--keys "J J K F1"`（1 フレームごとにキーを 1 つ押したことにする。スタート画面のあいだはスタート画面のキー（`startKey`。`Ctrl+O` など）、開いたあとは編集画面のキー（`keyDown`）。`Ctrl+` `Shift+` を前に付けられる。`.` は何も押さない）、`--drop <file>`（何度でも。最初のフレームで UM の試験用の操作 `windowSetText(90, ...)` で SDL のドロップのイベントを積む。その位置はいつも (10, 20)）、`--drop-at <x>,<y>`（落とした位置をその値にする）、`--start-dialog <file>`（スタート画面のファイルのダイアログが、そのファイルを返したことにする。OS のダイアログは開かない。Ctrl+O は `--keys` で押す）。`--stats` は `playback: {...}` と `audio: {...}`（`apStatsJson`: 鳴らした標本の数 `played`、書いた数 `written`、音の時計 `t` など）と `media: {"probes","known"}`（いまの素材の数と、覚えた調べの結果の数）を出す。試しに起動するときは `SDL_AUDIO_DRIVER=dummy` も付ける。試しに起動するときは `SDL_VIDEO_DRIVER=offscreen` を付ける（窓を出さない）。

### 色のワークスペース（`ws_color/`）

- 編集画面は、色のワークスペースのあいだ毎フレーム `wscWorkspace(mut ui, th, mut ws, モニターの四角, 右の列の中身の四角, キャンバス, w, h, 版)` を呼び、
  `ukEndImage(mut ui, mut px, ws.atlas, ws.aw, ws.ah)` で終える（モニターとスコープの絵は ws.atlas にある。ほかの画像と同じフレームに出すなら、
  atlas を分け合う形にしてから組み込む）。上の帯・左の欄・右の列のタブ・タイムラインは編集画面が描く。
- 版は、描いたコマか調整が変わったら変える数。同じなら絵もスコープも作り直さない。
- 出来事 `WscEvent`: `WSC_EV_EDIT`（live なら `wscApplyLive` で読んだ Project に入れて描き直すだけ。live でなければ `wscOpsFor` で
  `runOps` の並びにして .mzc に書き、読み直して `wscSync`）、`WSC_EV_LOAD_LUT`、`WSC_EV_REVEAL`、`WSC_EV_COPY_ID`、`WSC_EV_KEYFRAME`。
- 調整するクリップは `wscSync(mut ws, p, クリップの番号)` で決める（ファイルを読み直したとき・選択が変わったとき。ドラッグの間は呼ばない）。
- スコープの計算の場所は `ws.dev`（`WSC_DEV_AUTO` / `WSC_DEV_CPU` / `WSC_DEV_GPU`）。数は整数の fetchAdd なので CPU と GPU で同じ（tests/ws_color）。

## wasm のプラグイン（.mzplug）

組み込みの効果はビルド時に一緒にコンパイルする。配布したプラグインを作り直さずに読み込めるように、同じソース（`plugins/<名前>.um`）から wasm の包み（`.mzplug`）も作れる。

- **作る**: `node tools/mozcut.mjs plugin build <名前 | file.um> [-o out.mzplug]`。`build/plugin/<名前>/` に写しと wasm 用の入口の包み（`main.um`）を書き、`--target wasm32-plugin` でコンパイルし、カスタムセクション `mozaiccut.manifest` を足して `dist/<名前>.mzplug` に書く。コンパイルの誤りは元の `plugins/` の行を指す。
- **宣言（manifest）**: JSON。`{"abi":1,"name","doc","entry","params":[...],"aliases":[...],"reach","whole","layer","source","sourceSha256"}`。
- **入口**: `mzfx_apply(layerAt, layerLen, tmpAt, tmpLen, w, h, p0..p7)`（i32 を 6 つ、f32 を 8 つ）。層は RGBA の f32、ストレートアルファ。export に `memory` `umAlloc` `umFree` が要る。
- **`@whole`**（宣言。任意）: 層全体の大きさ・位置を使う効果（`vignette` の中心、`pixelate` のブロックの位置）に付ける。付けた効果は帯に分けずに掛ける。組み込み版の結果は変わらない。
- **並列**: 層を横の帯に分け、帯ごとの wasm のインスタンスで `thread.spawnEach` して掛ける。帯には上下に `@reach` の幅だけ重ねて渡し、重ねた所は捨てる。自動の帯の高さは 16 行以上かつ重ねの 4 倍以上、帯は 32 個まで。同じ効果を 2 つのスレッドから同時に apply しない（帯のインスタンスを共有するため）。足しながら進む効果（blur の大きな半径）は、帯に分けると浮動小数の丸めが変わるので、`@reach` の `max` でその範囲では帯に分けない（帯 1・自動・7・32 のどれでも組み込みと 1 ビットも違わないことを tests/run.mjs の mzplug で確かめる）。
- **メモリ**: インスタンス 1 つの上限は、帯 1 つなら 3 GiB、帯に分けるなら「全体の予算 2 GiB ÷ 帯の数」。帯 1 つ分（層と作業用、重ねを含む）が予算に入らなければ帯を減らす。壊れたプラグインでも、全体で予算を超えて確保しない。
- **読み込みの確かめ**: 宣言（JSON。入れ子 32 段まで、キーの重複は誤り、`abi` と `whole` は型も確かめる）と export の形に加えて、インスタンスを 1 度作って捨てる（import を要るもの・start 関数が失敗するか 2 秒で終わらないものは bad-plugin）。`plugin install` / `list`（tools/gen-plugins.mjs の readManifest）も同じ決まりで確かめる（start 関数を動かす確かめだけはエンジンにしかない）。
- **時間切れ**: 呼び出し 1 回の上限は既定 20 秒（書き出し用）。編集画面のプレビューは `wasmFxSetTimeout(f, WASMFX_PREVIEW_TIMEOUT_MS)`（1.5 秒）を使う。時間切れになった・インスタンスを作れなかった効果は、読み込み直すまで使わない（層は変えずに理由を返す。毎フレーム待たないように）。
- **失敗は止まらない**: トラップ・時間切れ（20 秒）・メモリの上限（3 GiB）のときは層を変えずに理由の文を返し（止まった原因と行も添える）、そのインスタンスを捨てて次に作り直す。読み込みの誤りは `bad-plugin` の診断（`WasmFxDiag`）。
- **入れる**: `plugin install <file.mzplug> [--force]` は `plugins-installed/` に写し、`plugins-installed/index.txt`（1 行に 1 つ、そのフォルダからの場所。`#` は注釈）を書き直す。組み込みの効果・コアのキー・入れてある包みと名前がぶつかるときは断る。`plugin uninstall <名前>` で外す。`plugin list [--json]` で並べる。
- **登録表**: 生成器が `src/gen/plugins.um` に `FxReg` を書く。`fxRegBuiltin()`（組み込みだけ）か `fxRegLoad(paths)`（`.mzplug` も）で 1 度だけ作り、呼ぶ側が引数で渡す（グローバル変数がないため）。番号は `FX_BUILTIN_COUNT` を境に、組み込みの後ろへ `.mzplug` の効果が続く。メソッドは `count` `name` `doc` `paramCount` `paramName` `paramDoc` `paramDefault` `paramMin` `paramMax` `aliasCount` `alias` `reach` `findKey` `apply`（失敗なら理由の文）`source` `isWasm`。`fxReservedNames()` は `.mzplug` に使えない名前。前からの `fxCount()` などは組み込みだけを数える関数として残っている。
- **まだつないでいないもの**: `project.um` / `render.um` / `main.um` / `editor.um` / `report.um` は、まだ `fxCount` などの組み込みだけの関数を使っている（入れた `.mzplug` は `plugin list` に出るが、描画には使われない）。つなぐ手順: 起動時に `wasmFxIndex("<ROOT>/plugins-installed/index.txt")` で場所を読み `fxRegLoad(paths)` で `FxReg` を作る → `fxFindKey` / `fxApply` / `fxReach` などを `reg.findKey()` / `reg.apply()` / `reg.reach()` に置き換え、`reg` を引数で渡す → `reg.apply` の失敗の文を描画の診断に、`reg.wasm.diags` を check / schema の診断に出す → schema の出どころは `reg.source(e)`。エンジンへの場所の渡し方（`mozcut.mjs` の `pluginIndexPath()` か ROOT からの決め打ち）も決める。
- **リンク**: エンジンも編集画面も wasmtime をリンクする（`mozcut.mjs` が `UM_WASMTIME` を探して設定する。`wasmtime.dll` が exe の隣に要る）。`cli.ts` で直接ビルドするときは `UM_WASMTIME` を付ける（付けないと clang の失敗としか出ない）。
- **速さ**（1280x720、24 CPU、ms/コマ。組み込み / wasm で帯は自動）: vignette 0.94 / 21.4、sharpen 2.4 / 17.7、blur r2 7.1 / 32.2。写しの手間が 1 回約 8 ms（vec4 と f32 の並べ替えと wasmRead）。UM の `wasmWrite` / `wasmRead` が `Buffer<vec4<f32>>` を直接受け付ければ減らせる。
- **GPU**（予定）: UM の kernel を WGSL に書き出したものを包みに入れ、wgpu で実行する。WGSL がない包みや GPU のない環境では wasm で動かす。

## 並行作業の決まり

- 自分の担当のファイルだけを書き換える。ほかのファイルの形が足りなければ、この文書に書いてある形を前提に書き、報告する。
- 型検査は `node C:/Users/mozuku/UnifiedMozaic/src/cli.ts check <file> [--target host]`。全体のビルド（`node tools/mozcut.mjs build`）と `build/` への書き出しは結合の担当だけが行う。
- 試しのファイルは自分の作業用のフォルダに置く。
