# モーショントラッキング（M6 の部品: motion）

映像の中の点を追い、その動きを別のレイヤーに当てたり（follow）、打ち消して手ぶれを止めたり（stabilize）する部品です。
After Effects の「トラッカー」（トラック: 位置 / 回転 / スケール、平面、コーナーピン、スタビライズ）に当たります。

.mzc のキーや操作・コマンドの名前は **motion** です（`track=` は既存のトラック番号なので使いません）。
ファイル名と関数の前置き（`trk_*.um`・`trk`）は部品の中の名前で、.mzc には出ません。

画素の処理（相関の探索、模様の変形、層の写しと重ね、YUV の写し）はすべて kernel で、CPU と GPU（`UM_WGPU=1`）で
結果がバイトまで同じです（`tests/m6-track/run.mjs` で確かめています）。

## ファイル

| ファイル | 中身 | 主な公開 |
| --- | --- | --- |
| `trk_y4m.um` | 展開済みの Y4M（render.um の `y4mInfo` と同じ形式）の読み書き。輝度だけも読める。色差の位置（C タグ）を読む | `TrkVideo` `trkOpenY4m` `trkReadLuma` `trkReadFrame` `trkWriteY4mHeader` `trkAppendY4mFrame` `trkChromaOffX/Y` |
| `trk_point.um` | 点の追跡（ZNCC のブロックマッチング、1/8 画素の細かい探索と放物線、信頼度、模様の取り直し、模様の変形、探す範囲を広げた探し直し、画面の外） | `TrkOpts` `trkDefaultOpts` `TrkTracker` `trkNew` `trkStart` `trkStep` `trkWorkPerFrame` |
| `trk_xform.um` | 2 点の相似変換・4 点の射影変換・行列・三角関数（f64 の級数）・動きをなめらかにする・層や YUV を写す kernel | `trkSimilarity2` `trkHomography4` `trkSmooth` `trkCompositeWarp` `trkWarpLayer` `trkWarpYuv` `trkLocalScale/Angle` |
| `trk_data.um` | 追跡の結果（`.trk` のテキストの読み書き、JSON、日本語の要約）、コマごとの変換、時刻の変換、追い直しの判断、`motion=` の読み取り | `TrkData` `trkDataFrom` `trkDataText` `trkDataParse` `trkDataLoad` `trkDataJson` `trkSummaryText` `trkXformAtF` `trkRenderFrame` `trkDataStale` `trkParsePoints` |
| `trk_run.um` | `mozcut motion` の本体、Y4M を通して追う、手ぶれ補正を書き出す、素材の座標 → 展開の座標、追跡を層に当てる行列 | `trkMotionRun` `trkTrackVideo` `trkSourceToCache` `trkStabilizeVideo` `trkStabilizeMats` `trkFollowFwd` `trkOffsetX/Y` |
| `trk_viz.um` | 確かめるための絵（点の印、コマの平均、BMP） | `trkYuvToRgba` `trkMarks` `trkWriteBmp` |

`trk_y4m.um` と `trk_data.um` は `../text.um`（`sub` `parseNum` `splitBy` `textNum`）を import します（`src/main.um` から使う並び）。
名前はすべて `trk` で始めています。

## しくみ

- **座標**: 画素の中心を整数とします（左上の画素の中心が (0, 0)）。render.um の層の画素の位置と同じです。
  `.mzc` の `motion=` は**素材の画素**、`.trk` の点の値は**展開した映像（キャッシュの Y4M）の画素**です（`trkSourceToCache` で変換）。
- **点の追跡**（`trk_point.um`）: 点ごとに「特徴の範囲」（半径 `feature`、既定 15 → 31x31 画素）と「探す範囲」（予測した位置の ±`search`、既定 32）。
  1. 前の 2 コマの動きから位置を予測する（等速）。
  2. 粗い探索: 探す範囲の整数の位置すべてで、模様との正規化相互相関（ZNCC）を kernel で求める。
  3. 細かい探索: 最良の位置の ±1 画素を 1/8 画素の刻みで（17x17 個）、3 次の補間（Catmull-Rom）で読んで求める。最後に放物線でサブピクセルにする。
  4. 見失った（信頼度が `minConf` より下）か、最良の位置が探す範囲の端だった点は、**探す範囲を 2 倍、4 倍（96 まで）に広げて探し直す**。
     広げて見つけた位置は信頼度 0.9 以上のときだけ使い（隠れた点が遠くの似た模様に飛ばないように。試しでは 98 画素先に 0.80 の偽の一致があった）、状態を `edge` にする。
  5. 信頼度 = 最良の ZNCC（0..1）。`adapt`（既定 0.9）より低ければ、そのコマから模様を取り直す（`low`）。`minConf`（既定 0.5）より低ければ「見失った」（`lost`）とし、点は予測した位置に置き、模様は取り直さない（隠れたものが出てきたら見つけ直す）。
  6. **点の中心が画面の外に出たら `out`**（予測した位置でも、見つけた位置でも）。その後は追わず、位置は画面の中の最後の位置のまま止める（画面の外では端の画素をくり返した所に偽の一致が出て、予測で暴走するため）。
- **見失った点と画面の外の点は、ほかの点の計算から外す**: 模様の変形（下）と、変換（`trkXformAtF`）。変換は、すべての点が使える最後のコマ r までの T_r に、使える点だけで求めた「コマ r → このコマ」の変換を重ねます（T = Δ ∘ T_r。点が足りなければ平面 → 相似 → 位置と下げ、1 点もなければ T_r を保つ）。点が外れても変換は飛びません。
- **模様の変形**（`warp`、既定で有効）: 2 点以上を追うとき、模様を取ったコマから今のコマまでの回転・拡大（使える点が 4 個以上なら射影変換のその点での傾き）をほかの点から求め、元の模様をその分だけ変形してから探します。
- **模様は整数の画素で取ります**（双線形で読むと模様がぼけ、取り直すたびにずれるため）。点と模様の中心の差は別に持ちます。
- **変換**（`trkXformAtF`）: 「最初のコマ → コマ k」の 3x3 行列。点の数で決まります（1 点: 位置、2〜3 点: 位置・拡大・回転、4 点以上: 平面）。
- **手ぶれ補正**: 出力のコマ k の (x, y) に、入力の T_k(x, y) を読みます（動きを止める）。`smooth=N` なら、前後 N コマでなめらかにした動き S_k との差だけを打ち消します（T_k ∘ S_k⁻¹ で読む）。
  なめらかにするのは、窓（端では切り詰める）に直線を当てはめた値です（局所の一次回帰。端でないコマでは窓の平均と同じ）。**等速のパンは補正が 0** になり、端のコマでも元にない加速・減速が入りません。
  YUV の写しは、入力の Y4M の C タグ（`C420jpeg` / `C420mpeg2` / `C420paldv`）の色差の位置で読み、同じ C タグで書きます。
- **follow**: 付ける層の画素の座標 → キャンバスの座標（`trkFollowFwd`）。
  - `position` / `similarity` / `perspective`: clip ∘ T_k ∘ clip⁻¹ ∘ layer（最初のコマでの置き方 `x=` `y=` からの相対の動き）。
  - `cornerpin`: 層の四隅（外の縁）を、コマ k の 4 点（p0 左上・p1 右上・p2 左下・p3 右下）に貼る（画面の差し替え）。`x=` `y=` は使いません。
  `trkCompositeWarp` が逆写像で読み、双線形（プリマルチプライで混ぜる）で render.um の `composite` と同じ式で重ねます。
- **重さ**: 1 コマの積和の回数 ≈ 点の数 × (2·search+1)² × (2·feature+1)²（`trkWorkPerFrame`）。上限は `feature` 48、`search` 96。
  10 億回を超える設定には警告 `motion-slow` を出します（CPU 全コアで 1 コマ約 0.3 秒）。

## `.trk`（追跡データ）

`.mzc` と同じ key=value の 1 行 1 コマのテキストです。人も AI も読めて、手で直せます（直した値はそのまま描画に使われます）。

```
# MozaicCut の追跡データ（M6 motion）。1 行目が設定、2 行目から 1 行に 1 コマ（f は追い始めたコマからの番号）。点の値は x,y,信頼度,状態
motion version=2 src="shot.cache/clip0.y4m" size=960x540 srcsize=1920x1080 fps=30/1 in=10 at=12.5 frames=60 points=2 names=p0,p1 srcpts="812,440;1210,460" feature=15 search=32 adapt=0.9 minconf=0.5 regrabs=0
f=0 p0=405.75,219.75,1,ok p1=604.75,229.75,1,ok
f=1 p0=406.0771,218.3571,0.9921,ok p1=605.9886,230.4252,0.9943,ok
f=20 p0=352,158,0,lost p1=561.4583,158.0183,0.9927,ok
```

- `size` は追った映像（展開）の大きさで、点の値はその画素の座標。`srcsize` は素材の大きさ、`srcpts` は `.mzc` の `motion=`（素材の画素）。
- `at` は追い始めたコマの**素材の時刻**（秒）、`in` は追ったときの展開の始まり（素材の秒、`<cache>.in`）。`f` は `at` のコマを 0 とする番号。
  展開を作り直して `in` が変わっても、`at` から今の展開のコマを求めます（`trkCacheFrame`）。
- 状態は `ok` / `low`（模様を取り直した）/ `lost`（見失った）/ `edge`（探す範囲の端・広げて見つけた）/ `out`（画面の外に出た）。
- 読めないときは `trkDataParse` が `err`（日本語）と `errLine`（行）を返します。点の名前（英数字と `_`、`f` は使えない、重複なし）、
  `names` と `points` の数、知らない状態、有限でない数（`1e400` など）、2 つ目の設定の行、古い形式（`track` の行）も行番号付きで断ります。
- JSON（`trkDataJson`）:
  `{"version":2,"ok","src","width","height","srcWidth","srcHeight","fps","in","at","frames","mode","srcPoints","options":{...},"attach":[x,y],"points":[{"name","start"}],"summary":{"meanConf","minConf","minPoint","minFrame","regrabs","lowFrames","lostFrames","edgeFrames","outFrames","lost":[{"point","from","to"}],"out":[{"point","from"}],"nearEdge":[...],"work"},"track":[{"f","p":[[x,y,conf,state],...],"dx","dy","scale","angle","matrix":[9]}]}`。
  - `attach` は付ける点（最初のコマの点の重心。AE の attach point）。`dx` / `dy` はその点の動き（画素）、`scale` / `angle`（度、時計回りが正）はその点のまわりの拡大・回転です。
    平面のときは射影変換のその点での傾きから求めた局所の値です。**位置の動きには `dx` / `dy` を使います**（`matrix` の 3 番目と 6 番目は画面の左上 (0, 0) の行き先で、回転・拡大が入ると点の動きと違う）。
- 人向けの要約（`trkSummaryText`）: 「点 2 個を 60 コマ追いました（位置・拡大・回転）。信頼度の平均 0.97、最低 0.89（p1、35 コマ目）。模様の取り直し 3 回。」と、警告とヒント
  （`motion-lost`（追い始めから見失ったときは search を指す別の文）/ `motion-edge` / `motion-out` / `motion-near-edge` / `motion-slow`）。

## 本体への組み込み方（案）

既存のファイルは書き換えていません。結合の担当がつなぐときの形です。

### .mzc の書き方

```sh
video "media/shot.mp4" id=shot motion="812,440;1210,460" motion.at=12.5 motion.feature=15 motion.search=32
image "media/logo.png" follow=shot follow.mode=similarity x=700 y=380 w=160   # shot の動き（位置・回転・拡大）に付いて動く
image "media/screen.png" follow=board follow.mode=cornerpin                    # board の 4 点（左上・右上・左下・右下）に四隅を貼る
video "media/hand.mp4" id=hand motion="300,220;660,320" stabilize stabilize.smooth=8 stabilize.edge=clamp
```

| key | 行 | 型・範囲（既定） | 意味 |
| --- | --- | --- | --- |
| `motion` | video | 文字列 `"x,y;x,y;..."`（1〜16 点） | 追う点（**素材の画素**の座標、`motion.at` のコマでの位置）。1 点: 位置、2 点: 位置・拡大・回転、4 点: 平面 |
| `motion.at` | video | time（省くと `in`） | 点を置いた素材の時刻（秒）。`in`〜`out` の中。追うのはここから `out` まで（前へは追わない。`at` より前のコマは `at` の位置のまま） |
| `motion.feature` | video | int 2..48（15） | 特徴の範囲の半径（展開の画素） |
| `motion.search` | video | int 1..96（32） | 探す範囲の半径（展開の画素）。見失ったときは 2 倍・4 倍（96 まで）に広げて探し直す |
| `motion.adapt` | video | number 0..1（0.9） | 信頼度がこれより低いと模様を取り直す |
| `motion.minconf` | video | number 0..1（0.5） | 信頼度がこれより低いと見失ったとする |
| `motion.warp` | video | flag（有効） | 回転・拡大に合わせて模様を変形して探す（`motion.warp=0` で無効） |
| `motion.data` | video | 文字列（なし） | 手で直した `.trk` を使う（書かなければキャッシュの `.trk`） |
| `follow` | video / image / text / color | クリップの ID | その追跡に付いて動く |
| `follow.mode` | 同上 | enum `auto` / `position` / `similarity` / `perspective` / `cornerpin`（auto） | auto は点の数で決まる。`perspective` は最初のコマでの置き方からの相対の動き、`cornerpin` は層の四隅を 4 点に貼る |
| `stabilize` | video（`motion` のある行） | flag | 自分の追跡を打ち消す |
| `stabilize.smooth` | video | int 0..120（0） | 0 は止める、N は前後 N コマでなめらかにした動きを残す |
| `stabilize.edge` | video | enum `black` / `clamp`（black） | 画面の外になった所 |

schema の doc に重さの目安を書きます: 「重さ ≈ 点の数 × (2·search+1)² × (2·feature+1)²。既定（15・32）の 1 点は 1080p で CPU 約 4 ms。feature 48・search 96 の 1 点は CPU 約 140 ms、GPU 約 20 ms」。

### コマンド（`main.um` / `tools/mozcut.mjs`）

- `mozcut motion <p.mzc> <clip> [--json]`: `trkMotionRun(v, c.motion, srcW, srcH, c.fit == FIT_COVER, motionAt, m.inPt, opts)` を呼び、
  `trkDataText(r.d)` を `<cache>/motion_<clip>.trk` に書く。標準出力は `trkSummaryText`（`--json` なら `trkDataJson`）。
  - `v` は `trkOpenY4m(videoCachePath(cache, idx))`、`m.inPt` は `<cache>.in`（なければクリップの `in`）。
  - `srcW` / `srcH` は素材の大きさ（mozcut.mjs が ffprobe で求めて渡す。分からなければ 0 で、点は展開の画素とみなす）。
  - `trkSourceToCache` が `scaleFilter` と同じ考えで写す: fit=contain / stretch（と w / h なし）は素材の全体を展開の全体へ、fit=cover は大きい方の倍率で拡大して真ん中を切り出す。
  - `mozcut.mjs` は、展開を作り直したとき（`.in` が変わった、大きさが変わった）に `.trk` を `trkDataStale` で確かめ、理由が返れば追い直す。
- `check` / `preview` / `render` は `.trk` を `trkDataLoad` で読む。なければ追跡しないで描き、警告 `motion-not-run` を出す。

### 描画（`render.um`）

- **描くコマ**: `kf = trkRenderFrame(d, lt, c.inPt, cacheIn)`（`lt = t - 追跡したクリップの at`、`cacheIn` は追跡したクリップの `m.inPt`、UNSET ならその `c.inPt`）。
  drawVideo と同じ丸め（`floor((lt + c.inPt - m.inPt) × fps + 1e-6)`）で展開のコマを求め、`trkCacheFrame(d, m.inPt)`（`.trk` の `at` の今の展開でのコマ）を引きます。小数のコマで補いません（映像と同じコマの点を使う）。
- **follow=<id> のクリップ**: `fxComposite` を「効果を掛けた層を作る」と「重ねる」に分けます。
  1. 層を作り、効果を掛ける（image / text は `clipFxReach` の pad の余白を足して `applyClipFx`。今の `fxComposite` の前半と同じ）。
  2. `fwd = trkFollowFwd(d, mode, kf, clip, trkTranslate(lx - pad, ly - pad), w + 2·pad, h + 2·pad)`。`clip` は追跡したクリップの展開の画素 → キャンバス（`trkTranslate(その lx, ly)`）。
  3. `composite` の代わりに `trkCompositeWarp(mut canvas, p.width, p.height, layer, w + 2·pad, h + 2·pad, fwd, alpha)` で重ねる。
  - **text** は効果がないとキャンバスへ直接描く（`renderTextClipCached`）ので、`follow` があれば `textClipLayer` で層を作る経路を通します。
  - `cornerpin` で効果の余白があると、余白ごと 4 点に貼られます（余白の分だけ内側に寄る）。効果のない層では pad は 0 です。
- **stabilize のクリップ**: `drawVideo` の `yuvToLayer` の直後に `trkWarpLayer(mut out, m.w, m.h, layer, m.w, m.h, M_k, clamp)` を掛け、そのあと `fxComposite` に渡す
  （`M_k` は `trkStabilizeMats(d, mode, smooth)` の `kf` 番目。プロジェクトを読んだときに 1 度だけ作って持つ）。
- 作業用の層は `takeV4` / `giveV4` の置き場から借ります。

### 操作（`ops.um`）

- `motion <clip> "<x,y;...>" [at=秒] [feature=N] [search=N] ...` は `set <clip> motion="..." motion.at=... motion.feature=N ...` と同じ書き換え（ほかは既存の `set` / `unset` で足りる）。
- `follow <clip> <追跡するクリップ> [mode]` は `set <clip> follow=<id> follow.mode=<mode>`。参照なので、`rename` は `follow=` の ID も書き換える（`at=` の参照と同じ扱い）。`delete` は `follow=` から参照されていれば止める（`fix-refs` で `follow` を消す）。
- **trim / split**: `motion=` のある行で `motion.at` が省かれていれば、元の `in` を `motion.at` に書いてから `in` を動かす（点を置いた時刻が動かないように）。
  - `split` の後半（`<id>_2`）には `motion=` / `motion.*` / `stabilize*` を写さない（点は前半の時刻のもの）。後半を追うなら点を置き直す。
    前半を `follow` している行はそのまま前半を指す（前半の範囲の外の時刻は端のコマの変換）。
  - `trim` で `motion.at` が `in`〜`out` の外になったら、check が `bad-motion`（error）を出す。

### 診断（`project.um` の code に足す）

| code | 重さ | 意味 |
| --- | --- | --- |
| `bad-motion` | error | `motion=` の形の誤り（`trkParsePoints` の文。`"x,y;x,y"` でない、0 点か 17 点以上）、素材の外の点、`motion.at` が `in`〜`out` の外、`follow.mode=perspective` / `cornerpin` なのに 4 点未満 |
| `unknown-ref` | error | `follow=` の ID がない（既存の code を使う）。追跡のないクリップを指したときも同じ（ヒント: 「shot に motion= を書きます」） |
| `motion-not-run` | warning | 追跡データがまだない（ヒント: `mozcut motion p.mzc shot`）。その間は付けずに描く |
| `motion-stale` | warning | `.trk` が今の行・展開と合わない（`trkDataStale` の理由: 展開の大きさ、素材の大きさ、点、`motion.at`、設定、コマの数） |
| `motion-lost` | warning | 見失ったコマがある。追い始めから見失ったときは「search を大きく」、途中なら「速いなら search、模様が小さいなら feature」 |
| `motion-edge` | warning | いちばん合う位置が探す範囲の端か、広げて見つけた（ヒント: search を大きく） |
| `motion-out` | warning | 画面の外に出た点がある（その後は止めた位置。変換はほかの点で求める） |
| `motion-near-edge` | warning | 最初のコマで模様（半径 feature）が画面からはみ出す点がある（誤差が大きくなる） |
| `motion-slow` | warning | 重い設定（`trkWorkPerFrame` が 10 億回を超える） |
| `motion-data` | error | `motion.data=` の `.trk` が読めない（`trkDataParse` の行と理由） |

`check --json` の `clips[i].track` はトラック番号のままです。追跡は `clips[i].motion`（点の文字列）と `clips[i].follow` に出します。

## 確かめたこと（`node tests/m6-track/run.mjs`）

ffmpeg で作った「動く模様」（noise + gblur + testsrc2）の映像で、分かっている動きと比べます。960x540、60 コマ（fast は 480x270、30 コマ）。

| 試し | 結果 |
| --- | --- |
| 平行移動（0.25 画素の刻みの既知の動き、3 点） | 誤差 平均 0.017 / 最大 0.068 画素、信頼度の最低 0.987 |
| 毎コマ取り直す（adapt=1） | 最大 0.47 画素（1 コマ 0.01 画素ほどが積み重なる。既定の 0.9 では取り直さない） |
| 2 点（20 度・1.24 倍まで回転・拡大・移動） | 点の誤差 最大 0.071 画素、回転の誤差 最大 0.015 度、拡大 1.2359（正 1.2360）。dx / dy（付ける点の動き）の誤差 0.2 画素未満 |
| 4 点（平面の傾き） | 点の誤差 最大 0.080 画素、射影変換で写した格子 9 点の誤差 最大 0.135 画素 |
| 隠す（5 コマ、探す範囲ごと） | 20〜24 コマ目を `lost`、出てきた後の誤差 最大 0.037 画素 |
| 画面の外へ出る点（1 画素/コマ、`2,2;957,537;480,270`） | p0 は 2 コマ目から `out` で止まる。p2 の誤差 最大 0.002 画素（以前は約 8 画素ずれた）、変換で写した p2 0.079 画素、取り直し 5 回 |
| 探す範囲より速い動き（20 画素/コマ、search 12） | 広げて探し直して 1 コマ目は `edge`、見失わない。誤差 最大 0.060 画素（以前は 1〜29 コマ目がすべて `lost`） |
| 手ぶれ補正 | 点の動き 最大 14.75 → 0.126 画素、平均の絵のくっきりさ 5.37 → 27.79。smooth=8 は残った動きのコマごとの加速が 27.3 → 2.3 画素 |
| 等速のパンの smooth | 四隅のずれ 最大 0.0002 画素（smooth=8・30。以前は 0 コマ目が 4 画素） |
| follow の四隅 | 位置 0.005、相似 0.037、平面 0.044 画素。cornerpin の四隅と 4 点 0.000 / 0.052 / 0.048 画素（0・30・59 コマ目） |
| `mozcut motion` の流れ | 素材の座標（2 倍）・`motion.at=1`・`in=0.5` から追った誤差 0.092 画素。描くコマは展開を作り直しても同じ（18） |
| CPU と GPU（wgpu、Vulkan、RTX 5060 Ti） | 追跡 6 本の `.trk`・手ぶれ補正 60 コマの Y4M・重ねた絵（follow と cornerpin）がバイトまで同じ |

速さ（1920x1080、1 コマ。Ryzen 9 3900X、RTX 5060 Ti。ほかの作業と同時に測ったので ±30% ほど揺れる）:

| | CPU（全コア） | GPU（wgpu、`UM_GPU_THRESHOLD=1`） |
| --- | --- | --- |
| 追跡 1 点（feature 15、search 32） | 4〜5 ms | 4〜11 ms |
| 追跡 4 点 | 11〜17 ms | 4〜13 ms |
| 追跡 4 点（feature 31、search 64） | 103〜144 ms | 11〜37 ms |
| 追跡 1 点（上限: feature 48、search 96） | 136 ms（以前の上限 64・256 は 1384 ms） | 19 ms |
| 追跡 16 点（上限） | 約 2.2 秒（見積もり） | 71 ms（以前の上限は 674 ms） |
| 手ぶれ補正の写し（YUV 4:2:0 全体） | 4.4〜7.7 ms | 1.2〜2.5 ms |
| 層の写しと重ね（640x360 の層） | 2.0〜3.7 ms | 9〜37 ms（試しでは毎回キャンバス 33 MB を CPU に読み戻すため） |
| Y4M の輝度の読み込み | 2.2〜4 ms | |

## まだないもの

- 逆向きの追跡（`motion.at` より前のコマ）、追跡の途中からのやり直し。
- 縮小画像での粗い探索（入れたら feature / search の上限を上げられる）。
- 5 点以上の最小二乗の変換（いまは平面は使える最初の 4 点、相似は使える最初の 2 点）。
- 画面の外に出た点が戻ってきたときに追い直すこと（いまは `out` のまま）。
- 編集画面での点の置き方・追跡の結果の表示（`trkMarks` はそのまま使える）。
