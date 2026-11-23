# M6 の操作の画面（src/workspaces/motion/）

合成とモーションの操作の画面の部品です。ui.md には M6 の画面の記述がまだないので、既存の部品の見た目（`tokens.json`、ui.md 7.3 のインスペクタの行）に合わせてここで決めます。
新しい編集画面への組み込みは `src/editor/wire_motion.um`（`docs/design/edit2.md` の「M6 の操作の画面の配線」）。部品はどれも **「描いて出来事を返す」関数** で、`.mzc` を書き換えるのは ops.um の操作（`key add / move / set / ease / remove / clear`、`set`）だけです（ui.md の「操作の仕組みは一つ」）。

| ファイル | 中身 |
| --- | --- |
| `src/workspaces/motion/mo_core.um` | 出来事（`MoEvent`）、色と大きさ（`MoTheme`。`moThemeFromTokens`）、キーフレームの列の引き方、今の値の文字、操作の作り方（`moOpValue`）、キャンバスと画面の変換（`MoView`） |
| `src/workspaces/motion/mo_draw.um` | 菱形・取っ手の四角と丸・縁つきの線・点線 |
| `src/workspaces/motion/mo_kflane.um` | (1) タイムラインのクリップの上のキーフレームの印（`moKfOnClip`） |
| `src/workspaces/motion/mo_keynav.um` | (2) インスペクタの ◀ ◆ ▶（`moKeyNav`）と、ラベル・値つきの 1 行（`moPropRow`） |
| `src/workspaces/motion/mo_graph.um` | (3) グラフエディタ（`moGraph`） |
| `src/workspaces/motion/mo_geom.um` | クリップの置き場所（`moClipXf`。render.um と同じ規則）、画面の点にあるクリップ（`moClipAtPoint`） |
| `src/workspaces/motion/mo_gizmo.um` | (4) モニターの上の変形のギズモ（`moGizmo`） |
| `src/workspaces/motion/mo_points.um` | (5) シェイプとマスクの点の編集（`moPoints`） |
| `src/ws_motion_demo.um` | 単体の見本（`demo/m6/ws_motion.mzc` を開いて動かす） |
| `tests/ws-motion/run.mjs` | 見本を窓なしで動かし、返した操作と書き換えた `.mzc` を確かめる試し |

## 出来事

```ts
struct MoEvent { kind: i32; ops: string[]; t: f64; n: i32; text: string; }
```

| kind | 意味 | 編集画面がすること |
| --- | --- | --- |
| `MO_E_OP` | `ops`（1 行ずつの操作の文字）を当てる。取り消しの 1 段 | `splitArgs` で分けて `runOps` に渡し、成功したら行を差し替えて読み直す。`text` は人向けの説明（履歴の札） |
| `MO_E_PREVIEW` | ドラッグの途中。`ops` を当てた写しで描いて見せるだけ | 写しに当てて、モニター・インスペクタ・グラフのカーブをその写しで描く。履歴に積まない |
| `MO_E_CANCEL` | ドラッグを Esc でやめた | 写しを捨てる |
| `MO_E_SEEK` | 再生ヘッドを `t`（タイムラインの秒）へ | 再生ヘッドを動かす |
| `MO_E_SELECT` | キーを選んだ（`text` はキーの名前、`n` はキーの番号。-1 ならキーの名前だけ） | グラフエディタに出すキーを替える |

- クリップは ID で指す（ID がなければ `@行番号`）。キーは `#番号` で指す。時刻はクリップの始まりからの秒（4 桁の小数）で、再生ヘッドの時刻はコマに合わせてから使う。
- **値を決める操作は `moOpValue`**: キーフレームのあるキーなら、その時刻に `key add`（同じ時刻のキーは置き換わる）、なければ `set <クリップ> key=value`。After Effects と同じく、ストップウォッチを入れたキーだけが時刻ごとの値になる。
- ドラッグを始めた部品の状態（`Mo*State`）は呼ぶ側が持ち、フレームをまたいで同じものを渡す。状態はつかんだときの値を覚えているので、ドラッグ中に見せる写しで描いても点が逃げない。

## 見た目（tokens.json から）

`moThemeFromTokens(json, scale)` が `color.dark.*`、`font.size.*`、`space.*` を読みます（読めなかった値は既定の値で、数を `missing` に返す）。

| もの | 色・大きさ |
| --- | --- |
| キーフレームの印 | 菱形（中心から角まで 5px × 倍率、黒の縁）。ふつうは `text.1`、ホバーで白、選んだキーは `accent` |
| ドラッグ中のキー | 元の所を `text.1` の 35%、動かす先を `accent`、横に時刻（`fs.xs`） |
| インスペクタの ◇ / ◆ | ◇ は `text.2` の輪郭（キーフレームがない）、◆ は `text.2`、再生ヘッドにキーがあれば `accent`。◀ ▶ は前後にキーがなければ `text.3`。キーフレームのある行はラベルの前に 5px の `accent` の点、値を `accent.hover`（ui.md 7.3 の「変わった項目」と同じ印） |
| グラフ | 地 `bg.1`、目盛り `line.default`（0 は `line.strong`）、数は `text.3`。成分ごとの線は `clip.video.mark`（x）、`clip.audio.mark`（y）、`clip.image.mark`、`clip.text.mark`。再生ヘッドは `playhead` |
| グラフの取っ手 | 白の丸（半径 3.5、黒の縁）と `text.2` の線。つかむと `accent.hover` |
| ギズモ | 枠は `accent` の 1.2px（黒の縁）、角の四角は白（黒の縁）、回転の丸は上の辺の中央から 24px、anchor は白の十字 |
| 点の編集 | シェイプのパスは `accent`、マスクは `warn`（映像の上で区別する）。頂点は白の四角、制御点は `text.1` の丸と点線 |
| つかめる範囲 | 取っ手の中心から 7px × 倍率 |

## 部品ごとのふるまい

### (1) クリップの上のキーフレームの印 `moKfOnClip(ui, th, clip, clipR, pxPerSec, fps, st)`

- キーフレームのあるキーごとに 1 段（名前の帯 16px の下に並べる。高さが足りなければ全部を 1 段にまとめる）。幅が 120px 以上で段の高さが 14px 以上なら段の名前も出す。
- 押して離す: 選ぶ（`MO_E_SELECT`）と、再生ヘッドをそのキーへ（`MO_E_SEEK`）。
- 左右のドラッグ: `key move <クリップ> <キー> #番号 <秒>`。コマに合わせる（Shift で合わせない）。**前後のキーの 1 コマ内側までしか動かさない**（並びが変わると番号が変わり、つかんだキーを見失うため。追い越すときは一度離す）。Esc でやめる。
- 選んだキーの上で Delete / Backspace: `key remove`（最後の 1 つなら `key clear`）。
- タイムラインの部品は、クリップの選択のふるまいを **この関数のあとに** 呼ぶ（印を押したときに、印が先に取る）。

### (2) ◀ ◆ ▶ `moKeyNav(ui, th, clip, line, key, lt, fps, r)` / `moPropRow(...)`

- ◇（キーフレームがない）: 再生ヘッドの時刻に今の値でキーを打つ（`key add`。今のふつうの値は ops が 0 秒のキーにする）。
- ◆: 再生ヘッドにキーがあれば消す（`key remove`。最後の 1 つなら `key clear`）、なければ打つ。Alt+クリックでキーフレームをやめる（`key clear <クリップ> <キー> <今の時刻>`。今の値をふつうの値で残す）。
- ◀ / ▶: 前・次のキーへ（`MO_E_SEEK`）。キーがなければ使えない。クリップの外に再生ヘッドがあるときは ◆ を使えない。
- 値は `moValueText`（キーフレームなら `animEval` の値、なければ行の値、なければ既定の値）。

### (3) グラフエディタ `moGraph(ui, th, clip, key, r, lt, fps, st)`

- 上の帯: 補間のボタン（直線 `linear`・イーズ `ease`・イン `easein`・アウト `easeout`・停止 `hold`・自動 `smooth`）。選んだキーに `key ease <クリップ> <キー> #番号 <印>`。選んだキーの今の印と同じボタンを `accent` で光らせる。右に「値 / 速さ」の切り替え（速さのグラフは見るだけ）。
- キーのドラッグ: 左右で時刻（コマに合わせる、Shift で合わせない、前後のキーの 1 コマ内側まで）、上下で値（数・角度・位置だけ。2 次元と色は時刻だけ）。`key set` → `key move` の順で 1 つの `MO_E_OP` にする（番号が変わらないように値を先に）。
- 取っ手（選んだキーの入り・出。数・角度・位置だけ）: `animHandleToEase` で速度と影響に直し、`key ease ... in=<速度>/<影響>` か `out=...`。
- 何もない所を押す・ドラッグする: 再生ヘッドをその時刻へ。選択を外す（キーや取っ手が同じフレームに押しを取ったら扱わない）。
- ドラッグ中は値の範囲（縦の目盛り）を止める。呼ぶ側が見せる写しのクリップを渡せば、カーブは動かしている値で描かれる。

### (4) 変形のギズモ `moGizmo(ui, th, project, ci, lt, view, area, st)`

- 置き場所は `moClipXf`（`clipAt` で時刻の値にしてから、shape は `shapePlaceAt`、ほかは `clipPos`）。枠は形の中の箱（回転・拡大で回る）。
- 枠の中のドラッグ: 位置。shape で `pos=`（または pos のキーフレーム）なら `pos`、ほかは `x` / `y`（箱の左上の画素。整数）。
- 角の四角（shape と、3D でない video / image / text / color）: `scale`（anchor とつかんだ点の距離の比。Shift で 0.1 ずつ。2D のクリップで横と縦が違えば比を保って `scale=横,縦`）。
- 上の丸（同じ）: `rotation`（anchor のまわりの角度。Shift で 15 度ずつ）。
- 値は `moOpValue`。キーフレームのあるキーならその時刻（コマに合わせた再生ヘッド）にキーを打つ。2D のクリップの `rotation` / `scale` は `Clip.d3` のトラック（`Clip.anims` でない）なので、`moXfOpValue` が値@時刻の書き方を見て key add にする。
- 文字のクリップは大きさが分からない（描くまで決まらない）のでギズモを出さない。映像・画像で `w` / `h` の片方がないときは画面の縦横の比で仮に決める。
- 3D でない video / image / text / color は、`moClipXf` が 2D の変形（`m6_xform/xform2d.um` の `xf2dAt`）を `MoXf` に入れる（`MoXf.xf2d`）。枠・当たり判定・マスクの点（`mo_points.um`）も変形した場所になる。3D のレイヤーには出さない（カメラで見え方が変わるため）。

### (5) 点の編集 `moPoints(ui, th, project, lines, ci, lt, view, st)`

- shape path の `d`: 頂点（四角）と制御点（丸）をドラッグ。頂点を動かすと、付いた入りと出の制御点も一緒に動く。書き戻しは `set <クリップ> d="..."`。
- マスク（`mask path|rect|ellipse to=<ID>`）: path は同じく点を、rect / ellipse は箱の 4 つの角を動かす。書き戻しは `set @<マスクの行> d="..."` / `set @<行> x= y= w= h=`。座標は `ref=` / `units=norm` を見てマスクの座標に直す。
- `d` は絶対座標の `M / L / C / Z` に書き直す（相対の命令・円弧・2 次ベジェは最初に動かしたときに 3 次ベジェになる）。座標は 2 桁の小数まで。
- to= のないマスクが混ざっているクリップは、行との対応が決まらないので点を出さない（`mask-implicit-target` の警告が出ているもの）。
- モニターの部品は、点 → ギズモ → 何もない所（ほかのクリップを選ぶ）の順で呼ぶ（点は枠の中にあるので先に取る）。

## 見本と試し

```
node <UM>/src/cli.ts build src/ws_motion_demo.um --target host -o build/ws-motion-demo
SDL_VIDEO_DRIVER=offscreen build/ws-motion-demo --frames 4 --shot x.bmp --select star --t 1
node tests/ws-motion/run.mjs [--out <フォルダ>]
```

見本はモニター（`renderFrame` で描いた絵の上にギズモと点）、インスペクタの行、タイムライン、グラフエディタを並べ、出来事を `runOps` で当てます。`--down x,y@F` などで入力を入れ、`--save out.mzc` で書き換えた `.mzc` を書きます（元のファイルは書き換えない）。
試しは 9 つの場面（キーの印のドラッグ、Esc でやめる、◇、◀ ▶ と ◆、回転、位置、パスの点、マスクの点、グラフの取っ手と補間のボタン）で、返した操作と `.mzc` の行を確かめます。

## 気づいたこと

- **`stroke=#202020` のように `#` で始まる色を `=` のすぐあとに書いた行は、ops で書き換えられない**（lineedit.um の `keySpan` / `insertPoint` が `#` を注釈の始まりとして扱う）。その行に `key add` などを当てると、キーを `#` の前に足して `stroke=` が空になり、`bad-color` で断られる。読み取り（project.um）は `#` の色を読めるので、書いた人には分からない。見本の `.mzc` は `#` を付けない色（`stroke=202020`）で書いた。lineedit.um の担当に報告する。
