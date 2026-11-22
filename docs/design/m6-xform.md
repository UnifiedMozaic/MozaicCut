# 2D の変形（src/m6_xform/）

video / image / text / color の行の `rotation` / `scale` / `anchor` を、3D のレイヤーにしなくても効かせる部品。
キーと値の形は 3D のレイヤーと同じ（`src/m6_3d/t3parse.um` の `t3ParseLayer` が 3D でない行でも `Clip.d3.tracks` に読む）。

## 値の意味

- `anchor`（x,y）はクリップの層の中央からの画素。基準点が、層の中央の位置（x / y で置いた所）に来る。
- `scale`（数か 横,縦）で基準点を中心に拡大してから、`rotation`（度、画面の上で時計回り）で回す。
- キャンバスの点 = 中央 + R·S·(変形の前の点 − 中央 − anchor)。`z=0` の 3D のレイヤー（`t3Plane`）と同じ置き方で、
  違うのは縁の画素だけ（3D は 8 ビットのアトラスとミップマップ、2D は f32 の層から読む）。
- 時刻はクリップの始まりからの秒（`xf2dAt(spec, lt)`）。

## 描き方（render.um）

- `drawClip` は、変形の値が何かを変えるコマ（`clipXf2dOn`）を描画モードの経路 `blendClipOnto` に回す。
  素材 → 色の調整 → マスク → 効果（After Effects と同じく層の中で掛ける）を作ってから `blendLayerXf` で変形して重ねる。
  描画モード・トラックマット（元のクリップの変形も）・不透明度・フェードはそのまま効く。
- 値が既定のまま（回転が 360 度の倍数、拡大 1、基準点 0）のコマは、今までの経路で描く。
- テキストアニメーター（`anim=`）のある文字は、字を動かした層を、動かす前の文字の四角の中央で変形する（`blendAnimTextXf`）。
- `xf2dPlan` が変形した層の外接の四角（キャンバスで切る）と逆の変形を決め、kernel `xf2dWarp` が画素ごとに元の点を求めて
  プリマルチプライの双一次で読む。縮めるときは 1 軸あたり最大 4 点（4×4）の平均。縁は画面の 1 画素の幅で被覆を付ける。
- kernel の中は f32 の掛け算と足し算だけ。CPU と GPU（`UM_WGPU=1`、`UM_GPU_THRESHOLD=1`）で BMP が 1 バイトも違わないことを
  `tests/m6-xform/run.mjs` と golden で確かめている。

## 編集画面

- モニターのギズモ（`src/ws_motion/mo_gizmo.um`）は、3D でない video / image / text / color にも大きさ・回転の取っ手を出す
  （[motion.md](motion.md) の (4)）。
- インスペクタの変形の節に「スケール」「回転」の行がある（`ins_model.um` の `insXfRows`）。キーフレームのある値と、
  横と縦の違うスケールは読むだけ。

## 試験

- `tests/cases/golden/xform.mzc`: 描画の基準（6 つの時刻の BMP と、全コマの Y4M）。
- `tests/m6-xform/run.mjs`: 診断、値の決まった場合（整数の anchor はずらしたのと同じ、rotation=360・正方形の 90 度）、
  CPU と GPU の一致。
- `tests/run.mjs` の edit2: ギズモの回転の取っ手、インスペクタの打ち込み。

## まだないこと

- 文字のクリップのギズモ（`moClipXf` がフォントを持たず、文字の大きさが分からないため。インスペクタと .mzc では効く）。
- インスペクタでの回転・スケールのキーフレームの ◇（`Clip.anims` でなく `Clip.d3` のトラックのため。ギズモと .mzc では打てる）。
- 位置のサブピクセルの配置（[m6-anim.md](m6-anim.md) の「サブピクセルの配置」）は、まだ整数の画素に丸める。
