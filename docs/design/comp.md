# 合成のワークスペース

After Effects のように、レイヤーを重ねてモーション（キーフレーム・描画モード・マスク・シェイプ・テキストアニメーター・
3D とカメラ・パーティクル・トラッキング・キーイング・エクスプレッション）を作る画面。描画と .mzc は M6 にあるので、
ここはそれを編集画面から操作する道具を置く所。

開き方: 上の帯の札「合成」（カット編集・**合成**・色・音・出力の並び）、コマンド `workspace.comp`（Alt+5。キーの割り当ての型によっては Alt+Shift+5）。

## 画面

| 場所 | 中身 | ファイル |
|---|---|---|
| 上 | 道具の帯（選択・カメラ・図形・ペン・文字・パーティクル・トラッカー）。右に今の道具の使い方 | `src/editor/ws_comp.um` |
| 中央 | コンポジションのビューア（プログラムのモニター `wireMonPanels`）。道具は絵の四角 `v.mon.picR` の上に重ねて描く | `src/editor/ws_comp.um` |
| 右 | 効果のコントロール。選んだレイヤーのプロパティを節ごとに並べる | `src/editor/wcomp_fx.um` |
| 下 | レイヤーの一覧。上の段から並べ、▶ で開くと変形のプロパティとキーフレームの ◆ の列が出る | `src/editor/wcomp_layers.um` |

左の列（素材・効果・文字…）はカット編集と同じ。選択の道具は、カット編集のモニターと同じギズモと点の編集（`wire_motion.um` の `wmoMonitorMarks`）。

## 1 フレームの流れ（`src/editor.um` の `e2Frame`）

```text
wmoTick（合成のときはタイムラインの四角を空にして渡す）
→ wcompTick   選んだ道具の入口 wcompTool* が、部品より先にビューアの押しを取って描く（前のフレームの v.mon.picR を使う）
→ wsComp      道具の帯・ビューア・効果のコントロール
→ wcompLayers タイムラインの代わりに、下の欄にレイヤーの一覧
```

出来事はどれも `wcompHandle`（`wcomp_ev.um`）に集まる。`MO_E_*` は `wire_motion.um` の `wmoHandle` に渡し（.mzc に当てる・ドラッグの途中を見せる・再生ヘッドを動かす）、`WCOMP_E_*` はそこで受ける。

## 共通のファイル（まとめ役だけが変える）

| ファイル | 役割 |
|---|---|
| `ws_comp.um` | 入口 `wsComp`・`wcompTick`、道具の帯、ビューア |
| `wcomp_state.um` | 状態 `WcompState`（`E2View.wcomp`）と共通の型・定数 |
| `wcomp_ev.um` | 出来事を当てる `wcompHandle` |
| `wcomp_layers.um` | レイヤーの一覧の枠・目盛り・レイヤーの行・変形の行。種類ごとの行は担当の `wcompRows*` を呼ぶ |
| `wcomp_fx.um` | 効果のコントロールの枠・節の見出し・変形と効果の節。節の中身は担当の `wcompFx*` を呼ぶ |

`editor.um`・`e2_view.um`・`e2_cmds.um`（と `e2_chrome.um`・`e2c_view.um`・`e2_macmenu.um`・`i18n.um`・`keymap.um`）は、この段で必要なだけ用意した。担当は触らなくてよい。

## 担当のファイル

| 担当 | ファイル | 道具の入口 | 一覧の行 | 効果のコントロールの節 | 状態 |
|---|---|---|---|---|---|
| カメラと 3D | `wcomp_camera.um` | `wcompToolCamera` | `wcompRowsCamera`（一覧の最上段）・`wcompRows3d` | `wcompFxCamera`（3D とカメラ） | `v.wcomp.cam` |
| 図形 | `wcomp_shape.um` | `wcompToolShape` | `wcompRowsShape` | `wcompFxShape`（図形） | `v.wcomp.shape` |
| ペン・マスク・描画モード | `wcomp_pen.um` | `wcompToolPen` | `wcompRowsMask` | `wcompFxPen`（描画モードとマスク） | `v.wcomp.pen` |
| 文字とテキストアニメーター | `wcomp_text.um` | `wcompToolText` | `wcompRowsText` | `wcompFxText`（文字） | `v.wcomp.text` |
| パーティクル | `wcomp_particle.um` | `wcompToolParticle` | `wcompRowsParticle` | `wcompFxParticle`（パーティクル） | `v.wcomp.part` |
| トラッキング・キーイング | `wcomp_track.um` | `wcompToolTrack` | なし | `wcompFxKey`（キーイングとトラッキング） | `v.wcomp.track` |
| エクスプレッション | `wcomp_expr.um` | なし | `wcompRowsExpr` | `wcompFxExpr`（エクスプレッション） | `v.wcomp.expr` |

関数の形:

```text
wcompTool*(ui, ed, kit, v, vw: WcompVw): MoEvent[]            ビューアの上の層・vw.area の切り取りの中で、毎フレーム
wcompRows*(ui, ed, kit, v, g: WcompGeo, ci, y): WcompOut       開いたレイヤー ci の行を y から下に（カメラの行は ci なし）
wcompFx*(ui, ed, kit, v, ci, r: UkRect): WcompOut              節の中身（見出しは wcomp_fx.um）。ci が -1 なら選んでいない
```

どの節をどの種類のレイヤーに出すかは `wcomp_fx.um` が決める（図形は図形のレイヤーだけ、文字は文字のレイヤーだけ、
パーティクルはパーティクルのレイヤーだけ、キーイングとトラッキングは映像と画像だけ）。

## 約束

- 関数の形（引数と返すもの）は変えず、中身だけを書く。
- .mzc は直接書かない。`MoEvent`（`MO_E_OP` の ops、途中は `MO_E_PREVIEW`、`MO_E_SEEK`・`MO_E_SELECT`・`MO_E_CANCEL`）を返す。
- 状態は `wcomp_state.um` の自分の struct（`WcompCam` など）の欄だけを足す。ほかの担当の struct と `WcompState` の共通の欄は変えない。足りなければまとめ役に言う。
- 名前の空間は全ファイルで 1 つなので、名前は `wcomp`・`Wcomp`・`WCOMP` で始める。
- 合成だけの出来事: `WCOMP_E_LAYER`（20。レイヤー n を選ぶ）・`WCOMP_E_TOOL`（21。道具を n に替える）・`WCOMP_E_STATUS`（22。状態の帯に text。n が 1 なら誤り）。
- `WcompOut` の `h` は使った高さ。0 は何も描いていない（節なら `wcomp_fx.um` が「準備中」と出す）。節で -1 なら、そのレイヤーには節ごと出さない。
- `WcompVw`: `pic` 絵の四角、`area` 道具が描いてよい四角、`view` キャンバスの画素 ↔ 画面、`t` 再生ヘッドの秒（コマに合わせたもの）、`sel` 選んでいるレイヤー（なければ -1）。
- `WcompGeo`: 左の欄 `leftX`・`leftW`、時間の欄 `timeX`・`timeW`、`t0`・`pxPerSec`（x は `wcompTimeX(g, t)`）、`rowH`・`indent`、見えている所 `clip`。

## 確かめ方

```bash
node tools/mozcut.mjs build
SDL_VIDEO_DRIVER=offscreen SDL_AUDIO_DRIVER=dummy build/mozcut-edit.exe demo/m6/threed.mzc --frames 14 \
  --click 785,20@2 --click 94,552@6 --click 20,552@9 --shot comp.bmp
```

1440×900 で、上の帯の「合成」の札を押し、一覧の 1 行目を選んで ▶ で開いた画面が撮れる。
