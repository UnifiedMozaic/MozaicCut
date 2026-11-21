# 新しい編集画面（v0.2、src/edit2/）

[mockups/edit.html](mockups/edit.html) の配置（ui.md 2.1）で、画面の部品（`src/uikit/` と `src/ui_*/`）を並べた編集画面です。
今のプロジェクト（`.mzc`）を読んで各部品に中身を渡し、モニターには `render.um` で描いたコマを出します。
**部品から出てくる出来事（クリック・ドラッグ・キー）は、まだどこにもつないでいません。** つなぐのは配線の担当で、
部品ごとに 1 つのファイル（`src/edit2/wire_*.um`）に書きます（この文書の「配線の担当へ」）。

古い編集画面（`src/editor.um`）は残してあります。

| 起動 | 何が開くか |
| --- | --- |
| `node tools/mozcut.mjs edit <project.mzc>` | 新しい編集画面（`build/mozcut-edit`。`src/edit2.um`） |
| `node tools/mozcut.mjs edit <project.mzc> --old` | 古い編集画面（`build/mozcut-edit-old`。`src/editor.um`） |
| `node tools/mozcut.mjs edit`（プロジェクトなし） | 古い編集画面のスタート画面（新しい方にはまだスタート画面がない） |

`node tools/mozcut.mjs build` は、エンジン・新しい編集画面・古い編集画面の 3 つを作ります。

## 配置

```
┌ 上の帯 40（e2TopBar）───────────────────────────────────────────────┐
├レール┬ 左の欄 260 ┬ モニター（残り）──────────┬ 右の列 320 ──────┤
│ 56   │ ui_pool     │ ui_monitor（プログラム）    │ タブ 32（aiTabBar）│ 本体の 56%
│e2Rail│ poolPanel   │ monPanel + monKeys          │ insDraw / 履歴 / AI│
├──────┴─────────────┴─────────────────────────────┴───────────────────┤ ← 境目（ドラッグ）
│ タイムライン ui_timeline（tlTimeline）                         │メーター 40│ 本体の 44%
├────────────────────────────────────────────────────────────────────┤
│ 状態の帯 24（e2StatusBar）                                                  │
└────────────────────────────────────────────────────────────────────┘
```

- 境目は 3 つ（左の欄｜モニター、モニター｜右の列、上の段／タイムライン）。ドラッグで大きさが変わり、ダブルクリックで既定に戻る。
  最小・最大は tokens.json の `size.panel.*`（左 220〜420、右 280〜440、タイムライン 200〜本体の 75%、モニターは 400×260 を割らない）。
- 窓が狭くてモニターの最小を割るときは、左の欄 → 右の列の順に畳む（ui.md 2.1）。
- 色と大きさはすべて tokens.json から（`src/gen/theme.um` の生成した値と、各部品の tokens の読み取り）。tokens.json は
  `<実行ファイルのフォルダ>/../docs/design/tokens.json` か、今のフォルダの `docs/design/tokens.json` から読む。

## ファイル

| ファイル | 中身 |
| --- | --- |
| `src/edit2.um` | 本体。起動の引数、窓、1 フレームの流れ（`e2Frame`）、上の帯などから来たコマンドの実行（`e2RunCommand`） |
| `src/edit2/e2_state.um` | `E2`: 開いているプロジェクト（本文・`Project`・診断・素材）、取り消しの履歴、再生の頼み。**操作の適用は `e2ApplyOps`** |
| `src/edit2/e2_clock.um` | 再生の時計（`e2ClockTick` / `e2ClockApply`）とプレビューのコマ（`e2PreviewRender`） |
| `src/edit2/e2_view.um` | `E2Kit`（部品に読むだけで渡すもの: テーマ・キーの割り当て・素材の欄の中身・インスペクタの中身）と `E2View`（部品の状態と配置）。`e2ViewSync` がプロジェクトから中身を作る |
| `src/edit2/e2_layout.um` | 配置と境目（`e2Layout`） |
| `src/edit2/e2_chrome.um` | 上の帯・レール・メーター・状態の帯（どの部品のフォルダにもないもの） |
| `src/edit2/e2_drop.um` | 窓の外からのファイルのドロップを受ける所（`e2DropTake` → `e2DropFiles`） |
| `src/edit2/wire_*.um` | 部品の出来事の配線（タイムライン・モニター・インスペクタ・素材の欄。M6 の操作の画面は `wire_motion.um`。いまは空） |
| `src/edit2/ws_color.um`・`ws_audio.um`・`ws_export.um` | 色・音・出力のワークスペースの中央と右の列（色は「色のワークスペース」の節。音・出力はいまは「準備中」）。この文書の「ワークスペースの担当へ」 |
| `src/edit2/wcl_state.um`・`wau_state.um`・`wex_state.um`・`wmo_state.um` | 上の 4 つの状態（`E2View` の `wcl`・`wau`・`wex`・`wmo`）と読むだけのもの（`E2Kit` の同じ名前の欄）。いまは空 |

1 フレームの流れ（`main`）:

1. 窓のイベントを uikit に渡す
2. `e2Poll`（ファイルが外で書き換わったら読み直す）→ `e2ClockTick`（再生の頼みを渡し、時計を進める）→ `e2ViewSync`（読み直したとき・選択が変わったときだけ、部品の中身を作り直す）
3. `e2PreviewRender`（コマが変わったときだけ描き、モニターの絵の大きさに縮める）
4. 先読みのスレッドを走らせ、そのあいだに `e2Frame` で部品を並べる。各部品の出来事は、描いた直後に `wire*` に渡す
5. 画面に出し、先読みのスレッドと合流する

## 配線の担当へ

4 人が並行で書けるよう、部品ごとに別のファイルにしてあります。**自分のファイルの関数の中身だけを書き、ほかのファイルは変えない**でください
（足りない口があれば、`e2_state.um` などに足す前に、まとめ役に言ってください。ぶつかりを避けるため）。

| ファイル | 関数 | 受け取るもの | まず書くこと |
| --- | --- | --- | --- |
| `wire_timeline.um` | `wireTimeline(ui, ed, kit, v, res, r)` と `wireTimelineKeys(ui, ed, kit, v, r)`（r はタイムラインの四角） | `TlResult`（ops・command・seek・selChanged・trimming） | `res.ops` を `e2ApplyOps`、`res.seek` を `E2_PB_SEEK`、`res.command` の分割・削除・詰めて削除を op にして適用、素材の欄からのドラッグ（`POOL_DRAG_MEDIA`）を落としたら置く op |
| `wire_monitor.um` | `wireMonitor(ui, ed, kit, v, acts)` | `MonAct[]`（再生の帯のボタンと、monKeys が取ったキー） | 再生・J/K/L・コマ送り・シーク・頭と終わりを `e2PbRequest`、イン・アウトを `v.tl.inPt / outPt`、タブ・2 つ並べ・画質・重ね表示を `v.mon` |
| `wire_inspector.um` | `wireInspector(ui, ed, kit, v, evs)` と `wireRightColumn(ui, ed, kit, v, evs)` | `InsEvent[]`（INS_E_*）と、履歴・AI のタブの `AiEvent[]` | `INS_E_SET` の ops を `e2ApplyOps` して `insFlash`、`INS_E_PREVIEW` は `ed.previewDirty`、履歴の取り消し・やり直し（`AI_EV_UNDO` など）を `e2Undo` / `e2Redo` |
| `wire_pool.um` | `wirePool(ui, ed, kit, v, ev)` | `PoolEv`（読み込む・ソースで開く・イン・アウト・ビン・ラベル・外す・ドラッグ） | ソースで開く（`v.mon` のタブ）、イン・アウト・ビン・ラベルを `kit.lib` に入れて `kit.lib.ver` を 1 増やす（`pool_demo.um` の `pdPoolEv` が見本） |

使ってよい関数（`e2_state.um`）:

- `e2ApplyOps(mut ed, ops)`: ops.um の文（`"move pip 2"`、`"split clip_a 3.5"`）をまとめて 1 つの操作として適用し、保存し、取り消しの履歴に 1 つ積む。失敗したら状態の帯に理由を出し、ファイルは変えない。成功すると `ed.ver` が増え、次のフレームで部品の中身が作り直される。
- `e2Undo(mut ed)` / `e2Redo(mut ed)`、`e2CanUndo(ed)` / `e2CanRedo(ed)`
- `e2PbRequest(mut ed, E2_PB_*, 値)`: 再生の頼み（`E2_PB_TOGGLE`・`SEEK`（秒）・`STEP`（コマ）・`J`・`K`・`L`・`PLAY`（速さ）・`PAUSE`）。実行は次のフレームの `e2ClockTick`。
- `e2SetStatus(mut ed, 文, 誤りか)`: 状態の帯の左の 1 文。
- 再生の今の位置は `ed.t`（秒）・`ed.frame`・`ed.total`・`ed.playing`・`ed.speed`（毎フレーム再生のエンジンから写す。表示用）。

決まり:

- 部品の関数に `kit` と `v` の同じ値を、読むものと書き換えるものとして同時に渡すと、UM は借用の誤りにする。だから「読むだけ」のもの（テーマ・`kit.lib`・`kit.insModel`）は `E2Kit`、部品が書き換える状態は `E2View` に分けてある。新しく持たせる値も、この分け方に合わせる。
- キーの割り当て（`kit.keys`、ui_keymap の `KmMap`）は、いまはボタンのツールチップと札の文字にだけ使っている。全体のキーの振り分け（`kmLookupEvent`）はまだない。部品の中で取るキー（モニターの `monKeys`、タイムライン・インスペクタ・素材の欄の中のキー）はそのまま効く。
- 上の帯・レール・状態の帯のコマンド（取り消す・やり直す・ワークスペース・右の列・集中モード・配置を既定に戻す）は `edit2.um` の `e2RunCommand` が実行している（配線のファイルではない）。
  ワークスペースのコマンド（`workspace.edit` / `color` / `audio` / `export`）は `v.workspace` を替えるだけ。

## タイムラインの配線（wire_timeline.um）

タイムラインの部品（`tlTimeline`）が返す `TlResult` と、編集のキーを `ops.um` の操作にして `.mzc` に書く。
どの操作も `e2ApplyOps` を通るので、1 回の操作が取り消しの 1 つになり、すぐに保存され、状態の帯に「何をしたか」が出る
（op が 1 つなら ops.um の説明、いくつかなら「clip_a.mp4 を消して後ろを詰めました（ほかに 1 個の行を書き換えました）」のようなまとめ）。

| 操作 | 入力 | op |
| --- | --- | --- |
| 選ぶ・足す・範囲 | クリック、Ctrl+クリック（足す・外す）、Shift+クリック（範囲）、何もない所からドラッグ（囲む） | なし（状態の帯に名前と範囲） |
| 動かす | 本体をドラッグ（Ctrl を押している間は挿入、始める前に Alt で複製、Ctrl+Alt で入れ替え、Shift で縦か横に固定） | `move` ほか（部品の `tlMoveOps`） |
| トリム | 端をドラッグ（選択ツールは詰めない。Ctrl かトリムツール（T）はリップルで、Enter で確定・Esc でやめる） | `trim` ほか |
| 分割 | S ／ Ctrl+B ／ 帯の［分割］（選んだクリップ、選んでいなければターゲットのトラックを再生ヘッドで）、刃のツール（B）で押す | `split` |
| 削除 | Delete ／ Backspace（隙間を残す）、Shift+Delete（詰める）、帯のボタン | `delete`（行を注釈にする）と、詰めるときの `move` |
| 1 コマ動かす | Alt+← →（Shift で 10 コマ） | `move` |
| スナップ（マグネット） | N ／ 帯のボタン（ドラッグの最中の N か S は、そのドラッグの間だけ逆にする） | なし |
| 拡大・縮小・スクロール | = ／ + ／ -（再生ヘッドを中心に）、Alt+ホイール、Shift+ホイールで横、帯のつまみ、Shift+Z（タイムラインにフォーカスがあるとき）で全体 | なし |
| 再生ヘッド | ルーラーを押す・ドラッグ | なし（`E2_PB_SEEK`） |
| 取り消し・やり直し | Ctrl+Z、Ctrl+Shift+Z ／ Ctrl+Y | `e2Undo` ／ `e2Redo` |
| 素材を置く | 素材の欄からドラッグしてトラックの上で離す | `add video` ／ `audio` ／ `image`（at=・in=・dur=・track=） |

- キーは `wireTimelineKeys` が e2Frame の初め（上の帯・モニターより前）で取る。モニターの `monKeys` は文字のキーを修飾キーを見ずに取るので、
  後ろでは Ctrl+Z などを受けられないため。文字の入力欄が使っている間（`ui.wantText`）は取らない。素材の欄で素材を選んでいて、
  タイムラインにフォーカスがないときの Delete は素材の欄に残す。
- 部品の op のうち、何も変えない `set <id> at=<秒>`（xfade= で前と重ねた行を、部品の仕上げ `tlPlanFinish` が「ずれた」とみなして出すもの）は、
  当てる前に `wtlPruneSetAt` が落とす（その op を除いて当てても、その行がその秒に置かれるなら書かない）。部品の側で直したら要らなくなる。
- ファイルを書き換えたフレームは、その場で `e2ViewSync` を呼んで部品の中身を作り直す（消したクリップの番号で描かないように）。
  消したあとと、クリップの数が変わる取り消しのあとは選択を外す。
- まだないもの: 速度（`clip.speed`。.mzc に speed= がまだない）、リンクの片方だけのトリム（J/L カット）、トラックの見出しの変更（ロック・高さなど）の保存、
  画面全体のキーの割り当て（`kit.keys`）からの振り分け。

## モニターと再生の配線（wire_monitor.um）

モニターの部品（`monPanel` / `monKeys`）が返す `MonAct` を、再生のエンジンへの頼み（`e2PbRequest`）にする。
頼みは次のフレームの `e2ClockTick` が `playback.um` に渡す。モニターの状態のうち配線が持つもの（全画面・スクラブの前の速さ・測った値）は
`v.wm`（`src/edit2/wm_state.um` の `WmState`）。

| 操作 | 入力 | 再生のエンジン |
| --- | --- | --- |
| 再生 ／ 一時停止 | Space、帯の再生のボタン | `E2_PB_TOGGLE` |
| 逆再生 ／ 止める ／ 順再生 | J ／ K ／ L（重ねると 2 倍・4 倍） | `E2_PB_J` ／ `K` ／ `L` |
| コマ送り | ← →（Shift で 10 コマ）、帯の 1 コマ戻る ／ 進む | `E2_PB_STEP` |
| 先頭 ／ 最後のコマ | Home ／ End | `E2_PB_SEEK` |
| 前 ／ 次の編集点 | ↑ ↓、帯のボタン（クリップの始まりと終わり。音のクリップも数える） | `E2_PB_SEEK` |
| スクラブ | 帯の上の端を押す・ドラッグ（再生中なら止め、放したら元の速さで再生し直す） | `E2_PB_PAUSE` → `SEEK` → `PLAY` |
| イン ／ アウト | I ／ O、帯のボタン。Shift+I ／ O でそこへ、Alt+I ／ O で消す | なし（`v.tl.inPt / outPt`。タイムラインにも出る） |
| 表示の倍率 | 見出しの［全体に合わせる］の一覧（25〜400%）、絵のダブルクリックか Shift+Z で全体 | なし（`v.mon.zoom`） |
| 画質 | 見出しの［画質］（全部 ／ 1/2 ／ 1/4） | なし（`wireMonPicSize` が描く大きさを小さくする） |
| 全画面 | F11（Esc か もう一度 F11 で戻る） | なし（`v.wm.full`。e2Frame がモニターだけを窓いっぱいに描き、main が `windowSetFullscreen`） |

- プレビューを描く大きさは `wireMonPicSize`: 絵の場所の大きさを、プロジェクトの大きさ（拡大して見るときに大きく描かない）と画質で抑える。
- `wireMonMedia` がモニターに渡す中身を作る（今の位置・速さ・イン ／ アウト・コマ落ちの数・「描画中」の札。描くのが 1 コマの 1.5 倍を超えたら出す）。
- main は `windowPresent` のあとに `pbShown` を呼ぶ（再生のエンジンがコマ落ちと遅れを数える）。`e2PreviewRender` とフレーム全体の時間は
  `wireMonStats` が `v.wm` に写し、`--stats` で終わるときに標準エラーへ出す:
  `playback: {...}`（`pbStatsJson`）と `monitor: {"renderN", "renderMsAvg", "renderMsMax", "frameN", "frameMsAvg", "frameMsMax", "shown", "skipped", "dropped", "full", "zoom", "quality", "inF", "outF"}`。
- まだないもの: ソースモニター（タブ・2 つ並べる・3 点編集の , . は知らせだけ）、時刻を打ち込んで移動する欄（時刻を押すと今の位置を状態の帯に出すだけ）、
  画質を下げたときに合成そのものを小さく描くこと（いまはキャンバスはプロジェクトの大きさのまま合成し、縮めるだけなので、描く時間はほとんど変わらない）、
  2 つ目のディスプレイへの全画面（M2）、音の時計（下の stage-m1）。

### 再生中の 1 コマの描画の時間（測った値）

offscreen、1440×900（絵の場所 661×372）、0 秒から終わり（10.5 秒）まで等速で再生。ほかの担当のビルドとテストが同時に走っている中で測ったので、
値は揺れる（同じ条件で 2 倍ほど違うこともあった）。

| プロジェクト | 描画（`e2PreviewRender`）平均 ／ 最大 | フレーム全体 平均 | 見せたコマ ／ コマ落ち |
| --- | --- | --- | --- |
| demo.mzc（1280×720、30p） | 6.3 ms ／ 42 ms | 16.8 ms | 313 ／ 2 |
| demo.mzc を 1920×1080 にしたもの | 15.6〜18.1 ms ／ 54〜79 ms | 19.0〜24.2 ms | 221〜268 ／ 6〜32 |
| 同じ 1080p を全画面（offscreen の画面 1024×768） | 19.1 ms ／ 52 ms | 26.9 ms | 277 ／ 30 |

1080p では、描画が 1 コマ（33 ms）を超えるコマがあり、そこでコマを落とす（どのコマが重いかはまだ調べていない）。
合成はプロジェクトの大きさで行うので、絵の場所や画質を小さくしても速くならない。

## インスペクタと履歴のタブの配線（wire_inspector.um）

右の列のインスペクタ（`insDraw`）が返す `InsEvent` を `.mzc` の書き換えにし、履歴のタブ（`aiTabHistory`）の `AiEvent` を取り消しの履歴につなぐ。
インスペクタの中身（`kit.insModel`）は、選んだクリップ 1 つ（`insFromClip`）・複数（`insFromClips`。値が違えば「—（混在）」）・
何も選んでいない（`insFromProject`）で `e2ViewSync` が作る。値を書き換えると `ed.ver` が増えて、次のフレームで作り直される。

| 出来事 | どうするか |
| --- | --- |
| 値を確定（`INS_E_SET`。打ち込んで Enter、ラベルのドラッグを離す、スライダー、選択肢、↺、効果を足す） | ops（`set` / `unset`）を `e2ApplyOps` で 1 つの操作にし、変えたキーを `insFlash` で光らせる（「テキストで見る」のトークンも緑）。複数を選んでいれば、どの行にも書く |
| ドラッグ中（`INS_E_PREVIEW`） | `.mzc` は書かない。`ed.lines` に ops を当てた写しを読み、`ed.project` だけを入れ替えてプレビューを描き直す |
| project の行（`INS_E_PROJECT`。何も選んでいないとき） | project の行を `setKey` で書き換えて保存し、取り消しに 1 つ積む（ops.um に project の op がないため） |
| 効果の有効・無効（`INS_E_FX_ENABLE`） | 無効: 行から消し（unset）、値を `kit.wi`（`wi_state.um`）に覚える。`wireInspectorPrep` が描く前に `insAddDisabledFx` で「無効」として戻す。有効: 覚えた値で書き戻し、後ろの効果を書き直して掛ける順を元に戻す（1 つの操作） |
| 効果の並べ替え（`INS_E_FX_MOVE`）・秒で置く（`INS_E_REF_MODE`） | ops を `e2ApplyOps` |
| ID を付ける・参照の札・ID を写す | `set <@行> id=<種類><番号>`、そのクリップを選ぶ（`v.tl.sel`）、`ui.clipboard` |
| 履歴: 取り消す・やり直す・ここまで戻す・ここまでやり直す | `e2Undo` / `e2Redo`（ここまで〜は、取り消しの数がその行の後になるまで繰り返す） |
| 履歴: 問題を直す（`AI_EV_FIX`） | op を `e2ApplyOps` |

- まだないもの（状態の帯で知らせる）: キーフレーム（.mzc に書き方がない）、色を選ぶ窓（`#RRGGBB` を打ち込む）、フォントを選ぶ、ソースの欄（「テキストで開く」）、AI の提案。
- 無効にした効果の値は、編集画面を閉じると消える（.mzc に無効の書き方がまだないため）。
- ID を写すは `ui.clipboard` に入れるだけで、OS のクリップボードに渡す `ukWindowSync` は edit2.um でまだ呼んでいない。
- 試し: `node tests/run.mjs edit2` の「インスペクタ」の 5 件（`tests/cases/edit2/ins.mzc` を 1440×1600 で開く。複数の選択は `--select v,c`）。

## 素材の欄・コマンドパレット・保存の配線（wire_pool.um・wp_palette.um・wp_state.um）

状態は `E2View.wp`（`wp_state.um` の `WpState`。パレットの開閉と探す語、保存の札の時刻、運んでいる素材の落とし先）。

**素材の欄**（`wirePool`）: 欄の中身（`kit.lib`）は `e2ViewSync` がクリップから作る（同じファイルは 1 つ。長さは probe、使っている数と割合はクリップから）。

| 出来事 | どうするか |
| --- | --- |
| 素材のイン・アウト（ホバー中の I・O）・ビン（新しいビンも）・ラベル・AI の受け入れ / 外す | `kit.lib` に入れて `kit.lib.ver` を 1 増やす。.mzc に書く所がまだないので、`e2BuildLib` が作り直すときに素材の ID で引き継ぐ（編集画面を閉じると消える） |
| ドラッグを始めた | 状態の帯に「タイムラインのトラックの上で離すと、その時刻に置きます」 |
| タイムラインの上を運んでいる間 | `wirePoolDropPreview`（edit2.um がタイムラインの直後に呼ぶ）が、置く長さの枠と始まりの線を描く。離したときの `add` は `wire_timeline.um` の `wtlDropMedia`。置く行（離した行が素材と同じ種類ならそこ、違えば V1 / A1）と長さ（イン〜アウト、なければ素材の長さ、静止画は 5 秒）は両方で同じ決め方にしてある |
| 読み込む・ソースで開く・場所を指定する | 「次の版」と状態の帯に出す |
| プロジェクトから外す | 欄の素材はどれも使っている素材なので、理由を出して外さない |

**コマンドパレット**（`wp_palette.um`。ui.md 3.14）:

- Ctrl+K（キーの割り当てで `palette.open` のキー）か、上の帯の「コマンドを探す…」で開く。上の帯の下の中央に幅 560 で重ねる。
- すべてのコマンド（`kmCommands`）を、日本語・英語の名前・ID・キー・ほかのソフトの呼び方（i18n の `alias.*`）で探す。各行に名前・分類・キーの札。
  新しい編集画面で実行できるもの（`wpCanRun`）を先に並べ、ほかは薄くして「次の版」の札（Enter で「次の版でつなぎます」と出す）。
- op の文（最初の語が ops.um の操作の名前。`split clip_a 3.5`、`move title 2`）を打つと先頭に「op を実行」の行。Enter で `e2ApplyOps`（1 つの操作として保存し、Ctrl+Z で戻せる）。dry-run の 1 行（ui.md 3.14）はまだない。
- 開いている間は、キーと文字をすべてパレットが取る（`wpKeys` を e2Frame の初め、`wireTimelineKeys` より先に呼ぶ）。↑↓・PgUp/PgDn・Home/End で選び、Enter で実行、Esc か外を押すと閉じる。
- 選んだコマンドは `e2RunCommand` に渡す。e2RunCommand が知らないもの（再生・J/K/L・コマ送り・1 秒・頭と終わり・分割・削除・詰めて削除・すべて選ぶ・全体に合わせる・スナップ・インスペクタ・履歴）は `wpRunCommand` が実行する。

**保存**（`wp_state.um`）:

- 操作のたびに `e2ApplyOps` が .mzc に書くので、Ctrl+S（`file.save`）は今の本文をもう一度書くだけ（`wpSave`）。書けなければ `ed.saveErr`。
  Ctrl+S のキーも `wpKeys` がほかの部品より先に取る。
- 上の帯の札（`wpSaveKind`）: 「保存済み」（ok）／「保存しました」（Ctrl+S のあと 2 秒）／「外で変更あり」（textSource。取り消しや操作ではないのに本文が変わったとき 1.5 秒）／「保存できませんでした」（error）。
  モックアップの「保存済み 14:32」の時刻は、UM に壁時計の組み込みがないので出していない。

**ワークスペース**: 「カット編集・色・音・出力」の札（と［書き出す…］、パレットの「ワークスペース: 〜」）で `v.workspace` が替わる（下の「ワークスペースの担当へ」）。

- 試し: `node tests/run.mjs edit2` の「コマンドパレット」「Ctrl+S」「素材の欄から」の 5 件（`tests/cases/edit2/pool.mzc`）。
- まだないもの: 素材の本物の縮小画像（`ui_pool` の `poolThumb` が見本の絵柄しか描かないので、部品の側に口が要る）、ファイルを選んで読み込む、ソースのモニター。

## ワークスペースの担当へ（ws_color.um・ws_audio.um・ws_export.um）

上の帯の札（カット編集・色・音・出力）を押すと `v.workspace`（`E2_WS_EDIT` / `COLOR` / `AUDIO` / `OUTPUT`）が替わり、
`e2Frame` は **中央（カット編集のモニターの場所 `L.mon`）と右の列（`L.right`。畳んでいれば幅 0）** だけを各ワークスペースの関数に任せる。
上の帯・レールと左の欄・タイムライン・状態の帯・コマンドパレットは、どのワークスペースでも同じものが出る。

```
e2Frame:  wpKeys → wclTick → wauTick → wexTick → wireTimelineKeys → 上の帯 → レールと左の欄
          → カット編集: モニター（monPanel・wireMonitor）と右の列（インスペクタ・履歴・AI）
            色:        wsColor(ui, ed, kit, v, cv, pic, L.mon, L.right)
            音:        wsAudio(...)    出力: wsExport(...)
          → タイムライン → 状態の帯 → ドロップ → パレット
```

3 人が同時に書けるよう、**自分のファイル（`ws_*.um` と、その状態の `w*_state.um`）だけを書き換え**、`edit2.um`・`e2_state.um`・`e2_view.um`・
`e2_chrome.um` は変えない。足りない口があれば、まとめ役に言う。

| ファイル | 状態 / 読むだけのもの | 入口 | 使う部品 | まず書くこと |
| --- | --- | --- | --- | --- |
| `ws_color.um`（名前は `wcl` / `Wcl`） | `v.wcl`（`WclState`）/ `kit.wcl`（`WclKit`）。`wcl_state.um` | `wsColor`、`wclTick` | `src/ws_color/wsc_ws.um`（`wscWorkspace`・`wscSync`・`wscEdits`）、`docs/color.md` | 中央にプログラムの絵とスコープ、右の列に色の調整。`wscSync` に選んだクリップ（`v.tl.sel`）を渡し、`wscEdits` の調整を ops にして `e2ApplyOps` |
| `ws_audio.um`（`wau` / `Wau`） | `v.wau`（`WauState`）/ `kit.wau`（`WauKit`）。`wau_state.um` | `wsAudio`、`wauTick` | `src/ws_audio/panel.um`（`wsaPanel`）・`mzc.um`・`chain.um` | 中央にミキサー（`wsaPanel`）、右の列に選んだトラック・クリップの効果。出来事を ops にして `e2ApplyOps` |
| `ws_export.um`（`wex` / `Wex`） | `v.wex`（`WexState`）/ `kit.wex`（`WexKit`）。`wex_state.um` | `wsExport`、`wexTick` | `src/ws_export/workspace.um`（`wsxFrame`・`wsxDrawPreview`）、`docs/design/ws_export.md` | 中央に書き出しの予定と仕事の一覧、右の列に設定。書き出しの仕事を進めるのは `wexTick`（ほかのワークスペースにいる間も毎フレーム呼ばれる） |

入口の形（3 つとも同じ）:

- `wsXxx(ui: mut UkCtx, ed: mut E2, kit: mut E2Kit, v: mut E2View, cv: mut MonCanvas, pic: E2Pic, center: UkRect, right: UkRect): void`:
  中央と右の列を描き、出来事をその場で処理する（`e2ApplyOps`・`e2PbRequest`・`e2SetStatus` など、上の「使ってよい関数」）。
  プログラムの絵は `pic`（`e2PreviewRender` が描いた今のコマ）。モニターの部品で出すなら `monPanel(mut ui, mut v.mon, mut cv, kit.monTh, 四角, wireMonMedia(ed, v), pic.img, pic.w, pic.h, pic.serial, mut acts)` と同じに呼ぶ
  （次のフレームの絵の大きさは `wireMonPicSize` が `v.mon` の絵の場所から決める）。絵の画素を自分で読むときは `pic.img`（`pic.w`×`pic.h`）。
- `xxxTick(ui, ed, kit, v)`: どのワークスペースにいても、毎フレーム部品を描く前に 1 回呼ばれる。描かない。裏で進める仕事と、そのワークスペースだけのキー
  （`v.workspace` を見て、自分のワークスペースのときだけ取る）。キーはここで取れば、タイムラインのキー（`wireTimelineKeys`）より先になる。
- 状態に欄を足すのは `w*_state.um` の `XxxState`（書き換えるもの）と `XxxKit`（tokens.json から作るテーマなど。`xxxKitNew(js, scale)` が起動のときに 1 回作る）。
  `e2_view.um` は変えなくてよい。`w*_state.um` は `e2_*` を読まない（E2View から読まれるので、読むと循環する）。部品の型（`WscState` など）を持たせるのはかまわない。
- 選んでいるクリップは `v.tl.sel`、今の時刻は `ed.t`・`ed.frame`、プロジェクトは `ed.project`（`ed.lines` が本文の行）。`ed.ver` が増えたら作り直す。
- 試し: `--click 805,20@1`（色）・`844,20@1`（音）・`887,20@1`（出力）で開いて撮る。`tests/run.mjs` の edit2 の群に足す。

## 色のワークスペース（ws_color.um）

札「色」で、中央に **プログラムのモニターとスコープの帯**、右の列に **色のパネル**（ホイール・カーブ・LUT）が出る。
どちらも `src/ws_color/wsc_ws.um` の `wscWorkspace` が描き、`ws_color.um` の `wsColor` はそれを呼んで出来事を配線する。
上の帯・左の欄・タイムライン・状態の帯はカット編集と同じで、タイムラインのキー（S・Delete・Ctrl+Z など）もそのまま効く。

| 何を | どうする |
| --- | --- |
| 調整するクリップ | タイムラインで 1 つだけ選んでいればそれ、なければ再生ヘッドの上のいちばん上の映像・画像（`wclPickClip`）。`ed.ver` かクリップが変わったら `wscSync` でパネルを写し直す（ドラッグの途中は写さない） |
| コマ | プログラムの絵 `pic`（0xAARRGGBB）を信号の値（`vec4<f32>`）に戻してスコープに渡す（`wclUnpack`。8 ビットに丸めた値。`pic.serial` が変わったときだけ） |
| ドラッグの途中（`live`） | `wscApplyLive` で `ed.project` のクリップに直接入れ、`ed.previewDirty` を立てる。ファイルは書かない |
| 離したとき | `wscOpsFor` の 1 まとまりを、語を `lineQuote` で 1 行にして `e2ApplyOps` に 1 回で渡す（取り消しの 1 つ。状態の帯に「〜の値を変えました」と［取り消す］が出る）。書かなかったとき（失敗・既定の値に戻しただけ）は `e2Reparse` でファイルと揃える |
| 絵 | `wscWorkspace` は絵を自分の画像 `ws.atlas` の座標で描くので、それを共有の画像 `cv.img` の左上に写し（`wclBlit`）、`cv.gen` を進める（カット編集に戻るとモニターが合成し直す） |
| LUT の一覧 | プロジェクトのフォルダと `luts/` の `.cube`（名前の順）。.mzc に書く値はプロジェクトのフォルダからの相対のパス。プロジェクトのファイルが変わったときだけ作り直す |
| 場所の札・ID の札 | 場所はそのクリップをタイムラインで選び、状態の帯に場所を出す。ID は `ui.clipboard` に写す |
| ［読み込む…］・◇ | まだない（状態の帯に「まだ」と出す）。ファイルを選ぶ画面とキーフレームの口ができたらつなぐ |

`WclState`（`wcl_state.um`）のコマの入れ物 `frame` が 1 個の配列なのは、`wscWorkspace` に `mut v.wcl.ws` と一緒に渡すとき、
`pop` で取り出して同じ `v` からの借用を避けるため（渡したあと `push` で戻す）。

試し: `tests/run.mjs` の `groupEdit2Color`（plan.mzc で、ドラッグの途中はファイルが変わらずプレビューが変わること、離すと `grade.lift` を書き Ctrl+Z で戻ること）。

まだ違う所:

- モニターの絵の大きさは、カット編集のモニターの絵の場所（`wireMonPicSize` が `v.mon` から決める）のまま。色のワークスペースの絵の場所に合わせて描かせる口はない（縮めて描くだけ）。
- スコープは 8 ビットに丸めた表示用の絵から計算する（描画のキャンバスの値をそのまま渡す口がない）。
- 再生・コマ送りのボタンはない（タイムラインのキーと再生ヘッドで動かす）。Space などモニターのキー（`monKeys`）は効かない。

## M6 の操作の画面の配線（wire_motion.um）

M6 の操作の画面（`src/ws_motion/`。`docs/design/motion.md`）を、カット編集のタイムライン・インスペクタ・モニターにつなぐ。
各配線の関数の初めに 1 行ずつ呼ぶ口があり、どれも部品を描いた直後なので、ここで描くものは部品の上に重なる。
状態は `v.wmo`（`wmo_state.um` の `WmoState`。`MoKfState`・`MoGraphState`・`MoGizmoState`・`MoPointsState` を持たせる）、テーマは `kit.wmo`（`WmoKit`。`moThemeFromTokens(js, scale)` の `MoTheme` を持たせる）。
**`wire_motion.um` と `wmo_state.um` だけを書き換え**、`wire_timeline.um`・`wire_inspector.um`・`wire_monitor.um` は呼ぶ 1 行のほかは変えない。

| 関数 | 呼ぶ所 | まず書くこと |
| --- | --- | --- |
| `wmoTimeline(ui, ed, kit, v, r)` | `wireTimeline` の初め（`ver0` を取った直後。ここで書き換えても同じフレームで中身が作り直される） | クリップの上のキーフレームの印（`moKfOnClip`）。クリップの四角と 1 秒の幅は `v.tl` から。グラフエディタ（`moGraph`）を出すならタイムラインの中に場所を取る |
| `wmoInspector(ui, ed, kit, v, evs)` | `wireInspector` の初め | ◀ ◆ ▶ とキーフレームのある行（`moKeyNav` / `moPropRow`）。インスペクタの行の場所が要るので、`insDraw` の部品（ui_inspector）に口が要るかを先に確かめる |
| `wmoMonitor(ui, ed, kit, v, acts)` | `wireMonitor` の初め（全画面のときも） | 選んだクリップの変形のギズモ（`moGizmo`）と点の編集（`moPoints`）。絵の場所は `v.mon.picR` |

`MoEvent` の受け方は motion.md の「出来事」の表の通り: `MO_E_OP` は `e2ApplyOps`、`MO_E_PREVIEW` はインスペクタの配線（`wiPreviewOps`）と同じく
`ed.lines` に当てた写しで `ed.project` を入れ替えてプレビューを描き直す、`MO_E_SEEK` は `e2PbRequest(E2_PB_SEEK)`、`MO_E_SELECT` は `v.wmo` に覚える。

## stage-m1 を載せるときにつなぐ所

stage-m1 は古い編集画面（`src/editor.um`）に「音の再生」と「素材のドロップ」を足している。新しい編集画面では次の 2 か所につなぐ:

1. **再生の時計（音）**: `src/edit2/e2_clock.um` の `e2ClockTick`。stage-m1 の `audioplay.um`（`newAudioPlay` / `apReload` / `apUpdate` / `apClose`）を main で作って `e2ClockTick` に渡し、`pbTick` の前で音の出力の位置を `pbAudioClock` に渡す（音の出力を時計にする）。プロジェクトを読み直したとき（`ed.pbStale`）は `pbReload` と一緒に `apReload`。再生の頼み（`e2ClockApply`）で止める・鳴らすのも合わせる。
   音の時計を渡す口は `src/edit2/wire_monitor.um` の `wireMonAudioClock(mut pb, now)`（main が毎フレーム `e2ClockTick` の前に呼ぶ。いまは何もしない）。ここで `pbAudioClock(mut pb, 音の出力の再生済みの秒, now)` と `pbSetClockSource(mut pb, PB_CLOCK_AUDIO)` を呼ぶ。
2. **素材のドロップ**: `src/edit2/e2_drop.um` の `e2DropFiles(ed, kit, v, files, where, x, y)`。stage-m1 の `dropMedia`（FFmpeg で調べて、タイムラインの末尾に足す）をここから呼ぶ。`where` で振り分ける（`E2_DROP_POOL` 素材として読み込む ／ `E2_DROP_TIMELINE` 落とした位置に置く ／ `E2_DROP_MONITOR` ソースで開く ／ `E2_DROP_OTHER` 末尾に足す）。素材の欄の受け口の光り（`v.pool.dropHover`）は `e2DropTake` がすでに出している。

stage-m1 は `render.um` の素材の型（`Media` → `MediaSource`）と `renderFrameFrom` の引数も変えているので、載せるときは `e2_state.um`（`loadMedia`）・`e2_clock.um`（`renderFrameFrom`）・`e2_view.um`（`ed.media` の大きさ）を合わせる。

## 試し方

```sh
node tools/mozcut.mjs build
SDL_VIDEO_DRIVER=offscreen SDL_AUDIO_DRIVER=dummy build/mozcut-edit demo/demo.mzc --frames 6 --shot x.bmp --seek 3 --select clip_a
#   --size 1440x900（既定）--scale 1.0 --play 1
#   --down x,y@F --move x,y@F --up x,y@F --click x,y@F    F フレーム目にマウスの入力（境目のドラッグなど）
#   --key ctrl+z@F --text abc@F --wheel 2@F --mods sc@F    キー・文字・ホイール・押したままの修飾キー（"-" で放す）
#   --stats                                                 終わるときに再生の統計（playback:）と描画の時間・コマ落ち（monitor:）を標準エラーに
node tests/run.mjs edit2      # 1440×900 の配置・境目のドラッグ・起動の誤り・各配線（タイムラインは tests/cases/edit2/tl.mzc）
```

`demo/demo.mzc` の素材（`demo/media/`）と展開（`demo/demo.cache/`）は、`node tools/mozcut.mjs preview demo/demo.mzc 3` などで一度作っておく。

## モックアップとの見比べ（1440×900、demo.mzc）

合っている所: 上の帯の並び（ロゴ・メニュー 7 語・プロジェクト名 / シーケンス・保存の状態・ワークスペースの切り替え・コマンドを探す欄・↶ ↷・集中モード・［書き出す…］）、
レールの 7 項目（素材を選んだ印の線）、左の欄の素材の格子、モニターの見出し・再生の帯・時刻、右の列のタブとインスペクタの中身、
タイムラインの帯・ルーラー・トラックの見出し・クリップの色、メーター、状態の帯の左の 1 文と右の項目。各領域の位置と大きさはモックアップと同じ（モニター 804×467、タイムライン 368）。

仕上げで直した所: 窓が狭いとき（1024 幅）は上の帯を ui.md 2.1 の順に縮める（メニュー → ≡、検索の欄 → 虫眼鏡、プロジェクト名 → 「…」）。
高さが足りないとき、レールは札を消したアイコンだけの項目になる。インスペクタの見出しの下に種類とトラックの 1 行（「映像と音 · V1」）を出し、
何も選んでいないときの「〜の N 行目（project）」を実際の行の番号にした。1280×800・1920×1080 でも配置が崩れないことを撮って見た。

まだ違う所（次の段で直す）:

- 素材の縮小画像は、本物のコマではなく種類ごとの仮の絵柄（`pool_draw.um` の見本の絵。`poolThumb` に本物の絵を渡す口がまだない）。
- プロジェクト名の横のシーケンス名は仮（「シーケンス 1」。.mzc にシーケンスがまだない）。保存の時刻、AI の札、実行先（「CPU」と出す）も仮。
- メーターは目盛りだけ（音の値がまだない。stage-m1 の音の再生がつながったら渡す）。
- トラックの名前は種類からの仮（本編・映像・文字・音）。
- レールの「素材」以外の欄は中身がない（押すと「まだつないでいません」）。ワークスペースの「音・出力」は切り替わるが、中央と右の列は「準備中」（「色」は中身がある）。
- 上の帯の AI の札（ui.md 2.1 の ③）はまだない。
- モニターの時刻は本文の書体で数字の幅をそろえて描くので、モックアップ（等幅の中太）より字の間が空いて見える（部品 ui_monitor の側）。
- トリムの最中（リップル・ロール）も、モニターは A/B の 2 画面（trim.html）にならず、インスペクタも「編集点のトリム」の中身に替わらない。
  部品（ui_monitor・ui_inspector）にその表示がまだない。トリムの量と確定（Enter）・やめる（Esc）はタイムラインの帯と札に出る。
- 新しい編集画面は最近開いたプロジェクトの一覧（`mozcut-recent.txt`）にまだ書かない。
