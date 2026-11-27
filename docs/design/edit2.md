# 新しい編集画面（v0.2、src/editor/）

[mockups/edit.html](mockups/edit.html) の配置（ui.md 2.1）で、画面の部品（`src/ui/kit/` と `src/ui/*/`）を並べた編集画面です。
今のプロジェクト（`.mzc`）を読んで各部品に中身を渡し、モニターには `render.um` で描いたコマを出します。
**部品から出てくる出来事（クリック・ドラッグ・キー）は、まだどこにもつないでいません。** つなぐのは配線の担当で、
部品ごとに 1 つのファイル（`src/editor/wire_*.um`）に書きます（この文書の「配線の担当へ」）。

| 起動 | 何が開くか |
| --- | --- |
| `node tools/mozcut.mjs edit <project.mzc>` | 新しい編集画面（`build/mozcut-edit`。`src/editor.um`） |
| `node tools/mozcut.mjs edit`（プロジェクトなし） | 新しい編集画面のスタート画面（この文書の「スタート画面」） |

`node tools/mozcut.mjs build` は、エンジンと新しい編集画面の 2 つを作ります。

## 配置

```
┌ 上の帯 40（e2TopBar）───────────────────────────────────────────────┐
├レール┬ 左の欄 260 ┬ モニター（残り）──────────┬ 右の列 320 ──────┤
│ 56   │ ui/pool     │ ui/monitor（プログラム）    │ タブ 32（aiTabBar）│ 本体の 56%
│e2Rail│ poolPanel   │ monPanel + monKeys          │ insDraw / 履歴 / AI│
├──────┴─────────────┴─────────────────────────────┴───────────────────┤ ← 境目（ドラッグ）
│ タイムライン ui/timeline（tlTimeline）                         │メーター 40│ 本体の 44%
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
| `src/editor.um` | 本体。起動の引数、窓、1 フレームの流れ（`e2Frame`）。上の帯などから来たコマンドは `e2CmdRun` に渡す |
| `src/editor/e2_cmds.um`・`e2c_*.um`・`wcm_state.um` | コマンドの表（メニュー・右クリック・コマンドの欄・キー）と、受け持ちごとのコマンドの中身。この文書の「コマンドの表と、7 人の担当へ」 |
| `src/editor/e2_dialog.um`・`wdl_state.um` | ファイルを開く・保存・フォルダのダイアログの口 |
| `src/editor/rail_*.um` | レールの効果・文字・音・テキスト・問題・設定の左の欄 |
| `src/editor/wsrc_state.um`・`wsrc_cmd.um` | レールの「テキスト」の欄（`rail_source.um`）の状態（`E2View.src`）と、その行へ飛ぶ口（`wsrcReveal`）・`text.reveal`。この文書の「テキストの欄」 |
| `src/editor/e2_state.um` | `E2`: 開いているプロジェクト（本文・`Project`・診断・素材）、取り消しの履歴、再生の頼み。**操作の適用は `e2ApplyOps`** |
| `src/editor/e2_clock.um` | 再生の時計（`e2ClockTick` / `e2ClockApply`）とプレビューのコマ（`e2PreviewRender`） |
| `src/editor/e2_view.um` | `E2Kit`（部品に読むだけで渡すもの: テーマ・キーの割り当て・素材の欄の中身・インスペクタの中身）と `E2View`（部品の状態と配置）。`e2ViewSync` がプロジェクトから中身を作る |
| `src/editor/e2_layout.um` | 配置と境目（`e2Layout`） |
| `src/editor/e2_chrome.um` | 上の帯・レール・メーター・状態の帯（どの部品のフォルダにもないもの） |
| `src/editor/start.um` | スタート画面（引数なしで起動したとき）と、最近開いた一覧（`mozcut-recent.txt`）の読み書き、窓のアイコン（`ssSetIcon`）。この文書の「スタート画面」 |
| `src/editor/e2_drop.um` | 窓の外からのファイルのドロップを受ける所（`e2DropTake` → `e2DropFiles`） |
| `src/editor/wire_*.um` | 部品の出来事の配線（タイムライン・モニター・インスペクタ・素材の欄。M6 の操作の画面は `wire_motion.um`。いまは空） |
| `src/editor/ws_color.um`・`ws_audio.um`・`ws_export.um` | 色・音・出力のワークスペースの中央と右の列（色は「色のワークスペース」の節。音・出力はいまは「準備中」）。この文書の「ワークスペースの担当へ」 |
| `src/editor/wcl_state.um`・`wau_state.um`・`wex_state.um`・`wmo_state.um` | 上の 4 つの状態（`E2View` の `wcl`・`wau`・`wex`・`wmo`）と読むだけのもの（`E2Kit` の同じ名前の欄）。いまは空 |
| `src/editor/wire_*.um` | 部品の出来事の配線（タイムライン・モニター・インスペクタ・素材の欄。M6 の操作の画面は `wire_motion.um`） |
| `src/editor/ws_color.um`・`ws_audio.um`・`ws_export.um` | 色・音・出力のワークスペースの中央と右の列（いまは「準備中」）。この文書の「ワークスペースの担当へ」 |
| `src/editor/wcl_state.um`・`wau_state.um`・`wex_state.um`・`wmo_state.um` | 上の 4 つの状態（`E2View` の `wcl`・`wau`・`wex`・`wmo`）と読むだけのもの（`E2Kit` の同じ名前の欄）。`wmo` は M6 の部品の状態とテーマ、ほかはいまは空 |

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
- キーの割り当て（`kit.keys`、ui/keymap の `KmMap`）: 部品の中で取るキー（モニターの `monKeys`、タイムライン・インスペクタ・素材の欄の中のキー）が先に効き、どの部品も取らなかったキーは、フレームの終わりにコマンドの表（`e2CmdKeys`）が `kmLookupEvent` で引いて実行する（下の「コマンドの表」）。
- 上の帯・レール・状態の帯・メニュー・右クリック・コマンドの欄のコマンドは、すべて `e2_cmds.um` の `e2CmdRun` が受け持ちのファイル（`e2c_*.um`）に振り分ける（配線のファイルではない）。
  ワークスペースのコマンド（`workspace.edit` / `color` / `audio` / `export`）は `v.workspace` を替えるだけ（`e2c_view.um`）。

## コマンドの表と、7 人の担当へ（e2_cmds.um・e2c_*.um・e2_dialog.um・rail_*.um）

画面に出ているのに動かないもの（「まだつないでいません」「次の版」）をなくすため、メニュー・右クリック・コマンドの欄（Ctrl+K）・
キーが、1 つの表（`e2_cmds.um` の `e2CmdTable`）の「コマンドの ID → 実行する関数」を使う。

- **つないだものだけを出す。** 受け持ちのファイルの `e2c*Ready(id)` が true を返すコマンドだけが、メニュー・右クリック・コマンドの欄に出て、キーで動く。
  まだ空のコマンドはどこにも出さない。項目が 1 つもないメニュー（いまはマーカー・ヘルプ）は上の帯に出さない（帯の幅は 7 語ぶんを取ってあり、右の札は動かない）。
  「まだつないでいません」「次の版」「準備中」の項目や案内は作らない。
- **表の 1 行**（`wcm_state.um` の `WcmCmd`）: ID（`keymap.um` の `kmCommands` と同じ。キーと i18n の名前はこの ID で引く）・出すメニュー（`E2_MENU_*`。-1 はコマンドの欄だけ）・
  名前・前に区切りを引くか・右クリックの場所（`E2_CTX_CLIP` タイムラインのクリップ／`E2_CTX_TIMELINE` 空いた所／`E2_CTX_POOL` 素材の欄／`E2_CTX_MONITOR` モニター の和）・
  表のキーの振り分けが受けるか（`key`）。
- **キー**: 部品が自分で取るキー（再生・コマ送り・分割・削除・取り消し・スナップ・ツールなど）は `key: false`。それ以外は、どの部品も取らなかったキーを
  フレームの終わりに `e2CmdKeys` が引いて実行する（文字の入力中・ドラッグの最中は何もしない）。新しいコマンドの既定のキーは `keymap.um` の `kmCommon` などに足す。
- **右クリック**: タイムラインのクリップ（選んでいなければ、それだけを選んでから）・空いた所・モニターは `e2CtxTake` が開き、`e2CtxMenu` が表から項目を出す。
  素材の欄は欄が自分の右クリックのメニューを持つので、その下に表の項目を足す（`e2CtxPoolPrep` → `PoolState.ctxCmds`、選ぶと `PoolEv.cmd`）。
  右クリックした所のもの（クリップ・素材の番号、時刻）は `v.cm.clip`・`v.cm.media`・`v.cm.t`。
- **コマンドを足すとき**: `keymap.um` の `kmCommands` と `i18n.um` の `cmd.<id>`（と、行をまとめるなら `row.<row>`）に足し、表に 1 行足し、受け持ちのファイルの Ready と Run に書く。
  表のファイル（`e2_cmds.um`）は、ぶつからないよう、行を足すだけにする。

### 担当とファイル

各担当は**自分のファイルだけ**を書く（`e2c*Ready` に ID を足し、`e2c*Run` に中身を書く）。足りない口は、まとめ役に言う。

| 担当 | ファイル | 受け持つコマンド・欄 |
| --- | --- | --- |
| ファイル | `e2c_file.um` | `file.new`・`file.open`・`file.saveAs`・`media.import`・`export.open`・`settings.open`（`file.save`・`app.quit` はつないだ）。ファイルを選ぶのは `e2_dialog.um` |
| 編集 | `e2c_edit.um` | `edit.cut`・`edit.copy`・`edit.paste`・`edit.pasteInsert`・`edit.splitAll`・`edit.insert`・`edit.overwrite`・`edit.liftRange`・`edit.extract`（取り消し・分割・削除・選択・コマンドを探すはつないだ） |
| クリップ | `e2c_clip.um` | `clip.speed`・`clip.gain`・`clip.enable`・`clip.link`・`clip.rename`・`clip.transition`・`clip.nudge*`・`clip.revealInPool`・`source.match` |
| シーケンス | `e2c_seq.um` | `seq.settings`・`seq.addVideoTrack`・`seq.addAudioTrack`・`seq.deleteTrack` |
| マーカーと印 | `e2c_marker.um` | `marker.add`・`marker.delete`・`marker.clearAll`・`playhead.nextMarker` / `prevMarker`・`mark.in` / `out` / `clip` / `clearBoth`・`playhead.toIn` / `toOut` |
| 表示とヘルプ | `e2c_view.um`・`e2c_help.um` | `view.zoomIn` / `zoomOut`・`view.cleanViewer`・`view.linkedSelection`・`playhead.prevEdit` / `nextEdit` / `goto`・`keymap.open`・`help.manual`・`help.about`（再生・ワークスペース・右の列などはつないだ） |
| レールの欄 | `rail_fx.um`（効果）・`rail_text.um`（文字）・`rail_audio.um`（音）・`rail_source.um`（テキスト）・`rail_problems.um`（問題）・`rail_settings.um`（設定） | 左の欄の中身。いまは見出しだけ（`e2PanelHead` が見出しを描いて中身の四角を返す）。状態が要れば `*_state.um` を作って `E2View` に足す |

受け持ちのファイルの関数の形: `e2c*Ready(id: string): bool` と `e2c*Run(ui, ed, kit, v, id): bool`（実行したら true）。レールは `railXxx(ui, ed, kit, v, r)`。
名前の空間は全ファイルで 1 つなので、関数の名前はファイルの名前で始める。

### ファイルのダイアログ（e2_dialog.um）

OS のダイアログ（UM の `windowOpenFileDialog`・`windowSaveFileDialog`・`windowOpenFolderDialog`）を出し、結果を次のフレーム以降に受け取る。ダイアログが出ている間も描画と再生は止まらない。

| 関数 | 選ぶもの |
| --- | --- |
| `e2DlgOpenProject(ed, v, purpose)` | .mzc を 1 つ |
| `e2DlgImportMedia(ed, v, purpose)` | 素材（動画・音・静止画）を複数 |
| `e2DlgSaveAs(ed, v, purpose, 最初の名前, 種類)` | 保存するファイルの名前 |
| `e2DlgChooseFolder(ed, v, purpose)` | フォルダを 1 つ |
| `e2DlgChooseFile(ed, v, purpose, 種類)` | ファイルを 1 つ（種類は `E2_DLG_MEDIA`・`VIDEO`・`AUDIO`・`IMAGE`・`PROJECT`・`SUBTITLE`・`FONT`・`LUT`・`PLUGIN`・`ANY`） |

- 頼んだら、毎フレーム `e2DlgTake(mut v, purpose)` を呼ぶ。届いたフレームだけ `done` が true で、`cancel`（取り消し・出せなかった）・`paths` が入る。
  `purpose` は呼んだ側が決める名前（`"file.open"` など）で、同じ名前で取ったときだけ返す。一度に 1 つ（出している間の次の頼みは false）。
- 試しでは本物のダイアログを出さない: `--dialog-result <パス>` を 1 つでも渡すと、OS のダイアログを出さずに、頼まれた順にその結果を、頼んだ次のフレームで返す
  （`""` は取り消し、`;` で区切ると複数）。`--dialog-probe <種類>` は口そのものの試し。

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
- 速度（`clip.speed`。Ctrl+R・右クリックの［速度］）は、画面の中の小窓（`wmn_overlay.um` の `WMN_ASK_SPEED`）で % を打ち、`set <id> speed=` にする。
  リンク（`clip.link`。Ctrl+L）は `link=` を書く・消す。リンクした選択がオンなら組で選び（`wtlLinkExpand`）、端のそろった相手を一緒にトリムする。
  マッチフレーム（`source.match`。F）は、再生ヘッドの下のクリップの素材をソースのモニターで開き、今のコマ（`clipSourceTime`）を見せる。
- まだないもの: リンクの片方だけのトリム（J/L カット。今は Ctrl+L で解いてから引く）、トラックの見出しの変更（ロック・高さなど）の保存、
  画面全体のキーの割り当て（`kit.keys`）からの振り分け。

## モニターと再生の配線（wire_monitor.um）

モニターの部品（`monPanel` / `monKeys`）が返す `MonAct` を、再生のエンジンへの頼み（`e2PbRequest`）にする。
頼みは次のフレームの `e2ClockTick` が `playback.um` に渡す。モニターの状態のうち配線が持つもの（全画面・スクラブの前の速さ・測った値）は
`v.wm`（`src/editor/wm_state.um` の `WmState`）。

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
  `playback: {...}`（`pbStatsJson`）、`audio: {...}`（`apStatsJson`。鳴らした標本の数 `played`、書いた数 `written`、音の時計 `t` など）、
  `audiows: {"playMeters", "master"}`（音のワークスペースのメーターを鳴らしている音から出したフレームの数と、マスターのピーク）と `monitor: {"renderN", "renderMsAvg", "renderMsMax", "frameN", "frameMsAvg", "frameMsMax", "shown", "skipped", "dropped", "full", "zoom", "quality", "inF", "outF"}`。
- まだないもの: ソースモニター（タブ・2 つ並べる・3 点編集の , . は知らせだけ）、時刻を打ち込んで移動する欄（時刻を押すと今の位置を状態の帯に出すだけ）、
  画質を下げたときに合成そのものを小さく描くこと（いまはキャンバスはプロジェクトの大きさのまま合成し、縮めるだけなので、描く時間はほとんど変わらない）、
  2 つ目のディスプレイへの全画面（M2）、2 倍・4 倍・逆再生の音（いまは止めて、映像だけを壁時計で進める）。

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
| テキストで開く・行の札（`INS_E_OPEN_LINE`）、問題の場所（`AI_EV_JUMP`） | `wsrcReveal` で左の欄をテキストにし、その行（と列）へ（下の「テキストの欄」） |

- まだないもの（状態の帯で知らせる）: キーフレーム（.mzc に書き方がない）、色を選ぶ窓（`#RRGGBB` を打ち込む）、フォントを選ぶ、AI の提案。
- 無効にした効果の値は、編集画面を閉じると消える（.mzc に無効の書き方がまだないため）。
- ID を写すは `ui.clipboard` に入れるだけで、OS のクリップボードに渡す `ukWindowSync` は editor.um でまだ呼んでいない。
- 試し: `node tests/run.mjs edit2-inspector` の 5 件（`tests/cases/edit2/ins.mzc` を 1440×1600 で開く。複数の選択は `--select v,c`）。

## テキストの欄（rail_source.um・wsrc_state.um・wsrc_cmd.um）

レールの「テキスト」（`v.railSel` = 4）で、開いているプロジェクトの `.mzc` を行の番号と色分けつきで出し、その場で書き換える。
状態は `E2View.src`（`wsrc_state.um` の `WsrcState`。書き換え中の行・カーソルと選択・スクロール・検索・飛ぶ頼み）。

| 操作 | 入力 | どうなるか |
| --- | --- | --- |
| カーソルを置く・選ぶ | 押す、ドラッグ、Shift+押す、ダブルクリック（語）、行の番号を押す（行）、Ctrl+A | なし |
| 動かす | 矢印（Ctrl で語ごと）・Home（行の頭の空白の後ろ ↔ 行の頭）・End・Ctrl+Home / End・PageUp / Down（Shift で選ぶ） | なし |
| 書き換える | 文字（IME を含む）・Enter・Backspace・Delete（Ctrl で語ごと）・Ctrl+X / V | そのたびに `.mzc` に書いて読み直す（`e2Reparse`）。1 秒以内に続けた分は取り消しの 1 つ（「テキストの欄で書き換えました（N 行目）」）にまとめる |
| 取り消す・やり直す | Ctrl+Z、Ctrl+Y ／ Ctrl+Shift+Z | 全体の取り消しの履歴（`e2Undo` / `e2Redo`）。タイムラインやインスペクタの操作と同じ列 |
| 探す | Ctrl+F か上の検索の欄。Enter で次、Shift+Enter で前、Esc で本文へ（一致を選んだまま） | 英字の大小は見ない。一致の地を生成り色（`textSourceTint`）、今の一致を枠で囲み、「今 / 数」を出す |
| やめる | Esc、欄の外を押す | フォーカスを外し、タイムライン・モニターの 1 文字のキーが効くように戻す |

- 色分け: 行の頭の語（text1・太め）、キー（accentHover）、`=` と注釈（text3）、値（text2）、`"..."`（textSource）、フラグなどの語（reference）。
- タイムラインで選んだクリップの行は地を `accentTint` にし、左に `accent` の印を付ける。
- 診断（`ed.errors`）: 行の番号の左に誤り・警告の印、列からトークンの終わりまで下線（列がなければ行全体）。状態の帯に
  カーソルの行の誤り（なければ最初の誤り）を出す。欄の下の帯にも出し、押すとその場所へ飛ぶ。
- 飛ぶ口（`wsrc_cmd.um` の `wsrcReveal(v, 行, 列)`）: インスペクタの「テキストで開く」と行の札、問題の場所、`text.reveal`
  （Ctrl+E・表示のメニュー・クリップの右クリック。選んだクリップの行へ）。飛んだ行は少しのあいだ光る。フォーカスは移さない
  （Space などがそのまま再生に効くように。書き換えるときは押す）。
- 打っている間（フォーカスがあるとき）は `ui.textActive` を立てるので、次のフレームからタイムライン・モニター・コマンドの表の
  キーは動かない。Ctrl+S・Ctrl+K はそれより先に取られるが、本文はいつも保存済みなので変わらない。
- まだないもの: 長い行の折り返し（いまは横にずらす）、置き換えの欄、補完。

## 素材の欄・コマンドパレット・保存の配線（wire_pool.um・wp_palette.um・wp_state.um）

状態は `E2View.wp`（`wp_state.um` の `WpState`。パレットの開閉と探す語、保存の札の時刻、運んでいる素材の落とし先）。

**素材の欄**（`wirePool`）: 欄の中身（`kit.lib`）は `e2ViewSync` がクリップから作る（同じファイルは 1 つ。長さは probe、使っている数と割合はクリップから）。

| 出来事 | どうするか |
| --- | --- |
| 素材のイン・アウト（ホバー中の I・O）・ビン（新しいビンも）・ラベル・AI の受け入れ / 外す | `kit.lib` に入れて `kit.lib.ver` を 1 増やす。.mzc に書く所がまだないので、`e2BuildLib` が作り直すときに素材の ID で引き継ぐ（編集画面を閉じると消える） |
| ドラッグを始めた | 状態の帯に「タイムラインのトラックの上で離すと、その時刻に置きます」 |
| タイムラインの上を運んでいる間 | `wirePoolDropPreview`（editor.um がタイムラインの直後に呼ぶ）が、置く長さの枠と始まりの線を描く。離したときの `add` は `wire_timeline.um` の `wtlDropMedia`。置く行（離した行が素材と同じ種類ならそこ、違えば V1 / A1）と長さ（イン〜アウト、なければ素材の長さ、静止画は 5 秒）は両方で同じ決め方にしてある |
| 読み込む・ソースで開く・場所を指定する | まだ「次の版」と状態の帯に出す（読み込むは `e2_dialog.um` の `e2DlgImportMedia` で書く） |
| プロジェクトから外す | 欄の素材はどれも使っている素材なので、理由を出して外さない |

**コマンドパレット**（`wp_palette.um`。ui.md 3.14）:

- Ctrl+K（キーの割り当てで `palette.open` のキー）か、上の帯の「コマンドを探す…」で開く。上の帯の下の中央に幅 560 で重ねる。
- コマンドの表（`e2_cmds.um`）のつないだコマンドだけを、名前（表の名前）・英語の名前・ID・キー・ほかのソフトの呼び方（i18n の `alias.*`）で探す。各行に名前・分類（メニューの名前）・キーの札。
  つないでいないコマンドは出さない（「次の版」の札はやめた）。
- op の文（最初の語が ops.um の操作の名前。`split clip_a 3.5`、`move title 2`）を打つと先頭に「op を実行」の行。Enter で `e2ApplyOps`（1 つの操作として保存し、Ctrl+Z で戻せる）。dry-run の 1 行（ui.md 3.14）はまだない。
- 開いている間は、キーと文字をすべてパレットが取る（`wpKeys` を e2Frame の初め、`wireTimelineKeys` より先に呼ぶ）。↑↓・PgUp/PgDn・Home/End で選び、Enter で実行、Esc か外を押すと閉じる。
- 選んだコマンドは `e2CmdRun` に渡す（前の `e2RunCommand`・`wpRunCommand` の中身は `e2c_file.um`・`e2c_edit.um`・`e2c_view.um` に移した）。

**保存**（`wp_state.um`）:

- 操作のたびに `e2ApplyOps` が .mzc に書くので、Ctrl+S（`file.save`）は今の本文をもう一度書くだけ（`wpSave`）。書けなければ `ed.saveErr`。
  Ctrl+S のキーも `wpKeys` がほかの部品より先に取る。
- 上の帯の札（`wpSaveKind`）: 「保存済み」（ok）／「保存しました」（Ctrl+S のあと 2 秒）／「外で変更あり」（textSource。取り消しや操作ではないのに本文が変わったとき 1.5 秒）／「保存できませんでした」（error）。
  モックアップの「保存済み 14:32」の時刻は、UM に壁時計の組み込みがないので出していない。

**ワークスペース**: 「カット編集・色・音・出力」の札（と［書き出す…］、パレットの「ワークスペース: 〜」）で `v.workspace` が替わる（下の「ワークスペースの担当へ」）。

- 試し: `node tests/run.mjs edit2-pool` の 5 件（`tests/cases/edit2/pool.mzc`）。
- まだないもの: 素材の本物の縮小画像（`ui/pool` の `poolThumb` が見本の絵柄しか描かないので、部品の側に口が要る）、ファイルを選んで読み込む、ソースのモニター。

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

3 人が同時に書けるよう、**自分のファイル（`ws_*.um` と、その状態の `w*_state.um`）だけを書き換え**、`editor.um`・`e2_state.um`・`e2_view.um`・
`e2_chrome.um` は変えない。足りない口があれば、まとめ役に言う。

| ファイル | 状態 / 読むだけのもの | 入口 | 使う部品 | まず書くこと |
| --- | --- | --- | --- | --- |
| `ws_color.um`（名前は `wcl` / `Wcl`） | `v.wcl`（`WclState`）/ `kit.wcl`（`WclKit`）。`wcl_state.um` | `wsColor`、`wclTick` | `src/workspaces/color/wsc_ws.um`（`wscWorkspace`・`wscSync`・`wscEdits`）、`docs/color.md` | 中央にプログラムの絵とスコープ、右の列に色の調整。`wscSync` に選んだクリップ（`v.tl.sel`）を渡し、`wscEdits` の調整を ops にして `e2ApplyOps` |
| `ws_audio.um`（`wau` / `Wau`） | `v.wau`（`WauState`）/ `kit.wau`（`WauKit`）。`wau_state.um` | `wsAudio`、`wauTick` | `src/workspaces/audio/panel.um`（`wsaPanel`）・`mzc.um`・`chain.um` | 中央にミキサー（`wsaPanel`）、右の列に選んだトラック・クリップの効果。出来事を ops にして `e2ApplyOps` |
| `ws_export.um`（`wex` / `Wex`） | `v.wex`（`WexState`）/ `kit.wex`（`WexKit`）。`wex_state.um` | `wsExport`、`wexTick` | `src/workspaces/export/`（`ueWorkspace`・`wsxHandle`・`wsxUpdate`）、`docs/design/ws_export.md` の「新しい編集画面（edit2）の「出力」」 | **組み込み済み**。中央と右の列を合わせた四角に書き出しの画面（プリセット・プレビュー・設定・確認・待ち行列）。書き出しの仕事を進めるのは `wexTick`（ほかのワークスペースにいる間も毎フレーム呼ばれる）。進み具合は状態の帯に出す |
| `ws_audio.um`（`wau` / `Wau`） | `v.wau`（`WauState`。ミキサーの中身 `WsaWs`）/ `kit.wau`（`WauKit`。ミキサーのテーマ `MxTheme`）。`wau_state.um` | `wsAudio`（`wauTick` は何もしない） | `src/ui/mixer/panel.um`（`mixerPanel`）・`src/workspaces/audio/model.um`（`wsaWsNew`・`wsaWsSync`・`wsaWsEvent`・`wsaWsAdvance`）・`audio.um`（`mixTracksBlock`） | **できた**: 中央と右の列をひとつながりにしてミキサーを描く（ミキサーの右の列＝ラウドネスと選んだトラックの EQ・コンプを、編集画面の右の列の幅にそろえる）。値の変化はその場の影の値にし、確定した `mix` の op を `e2ApplyOps`（track の行）。断られたら影を捨てる。`ed.ver` が増えたら `wsaWsSync`。メーターは今のコマ（`ed.frame`）の 1 コマ分を書き出しと同じ処理で混ぜて出す（止まっている間はそのコマの値のまま、再生中は続けて混ぜる）。ラウドネスは続けて再生した音だけを測る。音は鳴らさない（再生のエンジンの仕事）。`wsaPanel` の再生ボタンと Space は使わない（再生は編集画面のもの）。試しは `tests/edit2_audio/run.mjs` |
| `ws_export.um`（`wex` / `Wex`） | `v.wex`（`WexState`）/ `kit.wex`（`WexKit`）。`wex_state.um` | `wsExport`、`wexTick` | `src/workspaces/export/workspace.um`（`wsxFrame`・`wsxDrawPreview`）、`docs/design/ws_export.md` | 中央に書き出しの予定と仕事の一覧、右の列に設定。書き出しの仕事を進めるのは `wexTick`（ほかのワークスペースにいる間も毎フレーム呼ばれる） |

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
- 試し: `--click 805,20@1`（色）・`844,20@1`（音）・`887,20@1`（出力）で開いて撮る。`tests/run.mjs` の edit2-shell の群に足す。

## 色のワークスペース（ws_color.um）

札「色」で、中央に **プログラムのモニターとスコープの帯**、右の列に **色のパネル**（ホイール・カーブ・LUT）が出る。
どちらも `src/workspaces/color/wsc_ws.um` の `wscWorkspace` が描き、`ws_color.um` の `wsColor` はそれを呼んで出来事を配線する。
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

M6 の操作の画面（`src/workspaces/motion/`。`docs/design/motion.md`）を、カット編集のタイムライン・インスペクタ・モニターにつないだ。
状態は `v.wmo`（`wmo_state.um` の `WmoState`。`MoKfState`・`MoGraphState`・`MoGizmoState`・`MoPointsState`、グラフに出すキー、見せる写しの印）、
テーマは `kit.wmo.th`（`moThemeFromTokens(js, scale)` の `MoTheme`）。

### 呼ぶ所

タイムラインとモニターの部品は、印やギズモを重ねたい所の押しを自分で先に取る（クリップを選ぶ・絵をずらす）。部品の後の口（`wmoTimeline`・`wmoMonitor`）では押しを取れないので、
M6 の部品は **部品より前に呼び、上の層に描く**。uikit は層の順に描くので、前に呼んでも部品の上に重なる。

| 関数 | 呼ぶ所 | すること |
| --- | --- | --- |
| `wmoTick(ui, ed, kit, v, L.tl, L.mon)` | `e2Frame` の初め（ワークスペースの Tick のあと、`wireTimelineKeys` の前） | タイムラインの印・グラフエディタの札と欄・モニターのギズモと点の編集。ファイルを書き換えたら `e2ViewSync` |
| `wmoInspectorPrep(ed, kit)` | `wireInspectorPrep` の初め（インスペクタを描く前） | インスペクタの行の ◇ / ◀ ◆ ▶ の印を `insSetKf` で入れる |
| `wmoInspector(ui, ed, kit, v, evs)` | `wireInspector` の初め | ◇ ◆ ◀ ▶ と、キーフレームのあるキーの値の変更を扱い、扱った出来事を `bool[]` で返す（`wireInspector` はそれを飛ばす） |
| `wmoTimeline`・`wmoMonitor` | `wireTimeline`・`wireMonitor` の初め | いまは何もしない |

層は、印・札・ギズモ・点が 1、グラフエディタの欄が 2（どちらもポップアップ（16〜）より下なので、メニューやコマンドパレットに覆われた所では押しを取らない）。

### 操作

| 場所 | 操作 | op |
| --- | --- | --- |
| タイムラインのクリップの上の ◆ | 押す: そのキーを選び、再生ヘッドをそのキーへ（クリップも選ぶ）。左右にドラッグ: 時刻（コマに合わせる。Shift で合わせない。前後のキーの 1 コマ内側まで）。Esc でやめる | `key move` |
| 〃 | 選んだキーの上で Delete / Backspace（タイムラインの Delete より先に取るので、クリップは消えない） | `key remove`（最後の 1 つは `key clear`） |
| ルーラーの左の隅の［グラフ］ | 押すとトラックの所に重ねてグラフエディタを開く・閉じる。上の段にキーの札（押すと出すキーが替わる）と［閉じる］ | `key ease`・`key set`・`key move`（motion.md の (3)） |
| モニターの絵 | 選んだクリップ（1 つ）が再生ヘッドで見えていれば、点の編集 → ギズモ（motion.md の (4)(5)）。それ以外の所を押すと、その点のクリップを選ぶ（押しはモニターにも渡す） | `set`・`key add`（キーフレームのあるキー） |
| インスペクタの ◇ | 再生ヘッドに今の値でキーを打つ。位置の行は x と y（shape の pos= か pos のキーフレームなら pos）。x / y を書いていない行は、置いた箱の左上の画素 | `key add` |
| インスペクタの ◆ | 再生ヘッドにキーがあれば消す、なければ打つ。Alt+◆ でキーフレームをやめる（今の値を残す） | `key remove` / `key clear` / `key add` |
| インスペクタの ◀ ▶ | 前・次のキーへ（位置の行は x と y の近い方） | なし（`E2_PB_SEEK`） |
| インスペクタの値（キーフレームのあるキー） | 打ち込む・ラベルをドラッグ: set ではなく再生ヘッドの時刻にキーを打つ（set だと列が 1 つの値に置き換わる） | `key add` |

- 幅（`w`）と文字の大きさ（`size`）は ops の `key add` が断るので、インスペクタに ◇ を出さない。
- `MoEvent` の受け方: `MO_E_OP` は `e2ApplyOps`（1 つの取り消し）。`MO_E_PREVIEW` は `ed.lines` に当てた写しで `ed.project` を入れ替える（保存も履歴もしない。
  クリップの数が変わる・誤りが出るときは見せない）。`MO_E_CANCEL` と、離しても操作が来なかったときは `e2Reparse` で読み直す。`MO_E_SEEK` は `E2_PB_SEEK`、
  `MO_E_SELECT` は `v.wmo.prop`（グラフに出すキー）とクリップの選択。
- 選んだキー・ドラッグ中のキーは 1 つのクリップにだけ持たせる（`v.wmo.kfClip`）。そのクリップの選択を外すと、キーの選択も外れる。

### まだ違う所

- インスペクタの値の欄は、キーフレームのあるキーでも行の値（`opacity="0.3@0 1@1"` なら 0.3 など）を出す。再生ヘッドの時刻の値（`animEval`）を出すには、ins_model の側に口が要る。
- グラフエディタの横の目盛りはクリップの長さに合わせた部品の目盛りで、上に見えているタイムラインのルーラーとはそろわない。
- 全画面（F11）のモニターと、2 つ並べた・ソースのタブのモニターには、ギズモと点の編集を出さない。
- shape のクリップのインスペクタは、まだ映像と同じ行（位置・幅・不透明度）を出す。回転・大きさの行はなく、それらはモニターのギズモとグラフで動かす。
- 印・ギズモ・グラフの操作は状態の帯に ops の説明を出す（部品の出来事の `text`（「x のキーを動かす」など）はまだ使っていない）。

## スタート画面（start.um）

[mockups/start.html](mockups/start.html)（ui.md 11 章）の画面。`build/mozcut-edit` を位置の引数なしで起動すると出る（`node tools/mozcut.mjs edit` も同じ）。
画面の部品は `src/ui/pool/pool_start.um` の `poolStart` で、`start.um` はそれに中身を入れて出来事を受ける。
開くプロジェクトが決まると、`src/editor.um` の `e2StartLoop` が抜け、**同じ窓**で編集画面を始める（題名を変え、画面を全部描き直す）。

| 操作 | 動き |
| --- | --- |
| 最近のプロジェクトのカード（ダブルクリック、↑↓ で選んで Enter） | そのプロジェクトを開く。ファイルが読めなければ知らせて、スタート画面のまま（一覧も変えない） |
| ［作成する］（名前の欄で Enter） | 保存する場所（既定は今いるフォルダ。今いるフォルダが exe のフォルダ（ダブルクリックで起動した）なら `<USERPROFILE>/Documents/MozaicCut`。`ssDefaultLocation`）に `<名前>.mzc` を書いて開く。中身は `project` の行だけ（大きさとフレームレートは「解像度とフレームレート」、音のレートは「詳しい設定」から。「最初の素材に合わせる」はいまは 1920×1080・30p）。同じ名前のファイルがあれば上書きせずに知らせる |
| ［開く…］（Ctrl+O） | `ssOpenDialog`。**OS のファイルの選択はまだ開かない**（知らせるだけ）。つなぐときは `windowOpenFileDialog` で選んだパスを `ssOpenPath` に渡す |
| ［変える…］（保存する場所） | まだフォルダの選択を開かない（知らせるだけ） |
| `.mzc` を窓に落とす | それを開く（素材だけを落としたときは、まだ受けない） |

最近開いた一覧（`<home>/mozcut-recent.txt`。`<home>` は `--home`、なければ `%APPDATA%/MozaicCut`（Windows 以外は `$XDG_CONFIG_HOME/MozaicCut` か `~/.config/MozaicCut`。どれも作れなければ実行ファイルのフォルダ。`e2GuessHome`）。`node tools/mozcut.mjs edit` も `--home` を付けない）の書き方:
1 行に 1 つの絶対パス、新しい順、10 件まで、`#` で始まる行と空の行は読み飛ばす。新しい編集画面でプロジェクトを開くと（引数でも、スタート画面からでも）
`ssAddRecent` が先頭に入れる。相対パスは UM の `absPath`（今いるフォルダとつなぐ）で絶対パスにして書く。

カードには、`.mzc` を読んで大きさ・フレームレート・長さを出す。縮小画像はまだない（無地）。UM にはファイルの更新した時刻を読む口がないので、日付は出さない。
スタート画面から開いたプロジェクトの素材は、FFmpeg の組み込みでその場で読む（予備の経路の版だけは展開しないので、`node tools/mozcut.mjs edit <project.mzc>` で開く）。
`tokens.json` は `<exe のフォルダ>/resources/tokens.json`（配布の形）→ `<exe のフォルダ>/../Resources/tokens.json`（macOS の .app）→ `<exe のフォルダ>/../docs/design/tokens.json`（`build/`）→ 前からの探し方の順に探す（`e2FindTokens`）。

窓のアイコン: `ssSetIcon` が、`src/gen/app_icon.um` の 64×64 の画素を UM の `windowSetIcon` に渡す（窓を開いた直後。offscreen のドライバでは何もしない）。
`app_icon.um` は `assets/icon/png/mozaiccut-64.png` から `node tools/gen-icon.mjs --um` で作る生成物（UM に PNG を読む口がないので、画素を定数の配列にして埋め込む）。
エクスプローラーなどに出る `.exe` のアイコンは別で、`mozcut.mjs build` が `mozaiccut.ico` をリソースにして埋め込む。

## 素材・音・ドロップ（M1 の FFmpeg の組み込みと音の再生）

素材は FFmpeg の組み込みでその場で開く（`media.um`。事前の展開はしない）。新しい編集画面では次のようにつないである。

1. **素材と素材の情報**: `e2_state.um` は素材の情報を `mediaProbeSources`（FFmpeg で調べ、probe.txt は予備）で作り、調べた結果を `E2.probeKnown` に覚える（書き換えのたびに調べ直さない）。素材は `MediaSource`（`loadMediaFor(..., MEDIA_OPEN_FAST)`）で、書き換えたときは `reloadMedia`（印と開き方が同じクリップは前の展開器を使い続ける）。展開したキャッシュを読む素材がなければ、0.4 秒ごとの展開の変化を見に行かない。先読みのスレッドは、`pbReload` の後（`ed.pbStale` のとき）に `pbWorkerSync` で素材の写しを受け取り、自分の展開器を開き直す。
2. **再生の時計（音）**: `audioplay.um` の `AudioPlay` を main が `newAudioPlay` で作り、`e2ClockTick(ed, pb, fc, cvs, ap, now)` に渡す。`e2ClockTick` は再生の頼み（`e2ClockApply`）を渡したあと、`pbTick` の前に `apUpdate` を呼ぶ（等速の順再生では音を鳴らし、鳴らし終えた標本の数を `pbAudioClock` に渡すので、音の出力が時計になる）。プロジェクトを読み直したときは `pbReload` と一緒に `apReload`。J / K / L では、音を鳴らすのは等速の順再生だけ（`pbAudioWanted`）。逆再生・2 倍・4 倍と止めているあいだは音を止め、映像だけを壁時計で進める。鳴らす音には、書き出しと同じく track の行のトラックの処理とマスターを掛ける（`audio.um` の `AudioMix`）。
3. **音のワークスペースのメーター**: `AudioPlay` は混ぜた区切り（1024 フレーム）ごとに、トラックごと（処理の後）とマスターのピーク・二乗の和・コンプの下げ量を覚え、`e2ClockTick` が見せているコマの範囲の値を `E2.playMeter`（`apMeterAt`）に入れる。音のワークスペース（`ws_audio.um`）は、等速で鳴らしているあいだはメーターをその値にする（鳴らしていないときは、前と同じく 1 コマ分を混ぜ直した値）。ラウドネスは前と同じく混ぜ直した音で測る。
4. **素材のドロップ**: `e2_drop.um` の `e2DropFiles(ed, kit, v, files, where, at, row)`。種類は FFmpeg で調べて見分け（映像があって長さがあれば video、長さがないか画像の拡張子なら image、音だけなら audio。FFmpeg なしの版は拡張子で、映像と音に `dur=5`）、調べた結果を `ed.probes` と `ed.probeKnown` に入れてから `add` を通す。`where` で振り分ける:
   - `E2_DROP_POOL`（素材の欄。［読み込む…］の結果も）: 素材として読み込む（.mzc に `#pool "<素材>"` の注釈の行を書く。`E2.imported`。開き直しても残る。素材の欄に「未使用」として並び、運んでタイムラインに置ける）
   - `E2_DROP_TIMELINE`: 落とした位置の時刻（`tlQuant`）に置く。行の種類（映像 ／ 音）が合えばその行のトラック。いくつも落としたら後ろに続けて並べる。見出しの列の上なら末尾。`#pool` の行も書く（クリップを消しても素材の欄に残る）。`#pool` の行とクリップの行は、取り消し 1 回で戻る 1 つの操作（`e2UndoJoin`）
   - `E2_DROP_MONITOR`・`E2_DROP_OTHER`（上の帯・右の列など）: 素材の欄に読み込む（タイムラインには置かない）
   - `E2_DROP_APPEND`（スタート画面に素材を落として作ったとき）: 素材の欄に入れ、タイムラインの末尾に順に並べる
   素材の欄は `#pool` の行の順（読み込んだ順）に並び、`#pool` の行のない前の版の .mzc のクリップの素材がそのあとに続く。映像と画像の縮小画像は、`wire_pthumb.um` が最初のコマを 192×108 で描いて覚えたもの（1 フレームに 1 つ）。
   .mzc は開かない（スタート画面に落とすと開く）。試し用の `--drop <file>`（何度でも）と `--drop-at <x>,<y>`（既定 10,20。上の帯なので素材の欄に入る）は、編集画面の 2 フレーム目に uikit のドロップの出来事を積む。
5. **書き出し**: 書き出しのワークスペースは、MP4（H.264）のプリセットを FFmpeg の組み込みで直接書く（`workspaces/export/job.um`、`encode.um`。docs/design/ws_export.md）。

## 試し方

```sh
node tools/mozcut.mjs build
SDL_VIDEO_DRIVER=offscreen SDL_AUDIO_DRIVER=dummy build/mozcut-edit demo/demo.mzc --frames 6 --shot x.bmp --seek 3 --select clip_a
SDL_VIDEO_DRIVER=offscreen SDL_AUDIO_DRIVER=dummy build/mozcut-edit --home build --frames 4 --shot start.bmp   # スタート画面
#   スタート画面から続けて試すときは、--frames と F（フレーム目）はスタート画面の最初から数える
#   （例: --click 600,190@2 --click 600,190@3 で 1 枚目のカードをダブルクリックして開く）
#   --size 1440x900（既定）--scale 1.0 --play 1
#   --down x,y@F --move x,y@F --up x,y@F --click x,y@F    F フレーム目にマウスの入力（境目のドラッグなど）
#   --rclick x,y@F                                          F フレーム目に右クリック（右クリックのメニュー）
#   --dialog-result <パス>                                  ファイルのダイアログを出さずに、この結果を返す（何度でも。"" は取り消し、; で複数）
#   --dialog-probe <open|import|save|folder|file>           2 フレーム目にダイアログを頼み、結果を dialog: {...} で標準エラーに
#   --key ctrl+z@F --text abc@F --wheel 2@F --mods sc@F    キー・文字・ホイール・押したままの修飾キー（"-" で放す）
#   --stats                                                 終わるときに再生の統計（playback:）と描画の時間・コマ落ち（monitor:）を標準エラーに
node tests/run.mjs edit2      # 編集画面の群（edit2-*）を全部。1 つだけなら edit2-timeline のように名前で選ぶ
#   edit2-shell 配置・境目・ワークスペースの札・画素の密度・起動の誤り   edit2-start スタート画面・最近の一覧・配布の形
#   edit2-files ダイアログの口・名前を付けて保存・［開く…］             edit2-timeline タイムライン（tests/cases/edit2/tl.mzc）
#   edit2-text テキストの欄   edit2-rail レールの効果・問題   edit2-inspector インスペクタ   edit2-monitor モニター
#   edit2-pool 素材の欄・コマンドパレット・保存   edit2-color 色   edit2-comp 合成（M6 の見本）
#   edit2-motion M6 の操作の画面（motion.mzc）   edit2-wire 出力・インスペクタ・LUT のダイアログ   edit2-ai AI のタブ
#   変えたファイルに合う群は tests/changed.mjs の表で選ぶ（node tests/all.mjs --changed）
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
- タイムラインの右のメーターは目盛りだけ（音の値はまだ渡していない。音のワークスペースのメーターには、鳴らしている音の値を出す）。
- トラックの名前は種類からの仮（本編・映像・文字・音）。
- レールの「素材」以外の欄は見出しだけ（中身は `rail_*.um` の担当が書く）。ワークスペースの「音・出力」は切り替わるが、中央と右の列は「準備中」（「色」は中身がある）。
- 上の帯の AI の札（ui.md 2.1 の ③）はまだない。
- モニターの時刻は本文の書体で数字の幅をそろえて描くので、モックアップ（等幅の中太）より字の間が空いて見える（部品 ui/monitor の側）。
- トリムの最中（リップル・ロール）も、モニターは A/B の 2 画面（trim.html）にならず、インスペクタも「編集点のトリム」の中身に替わらない。
  部品（ui/monitor・ui/inspector）にその表示がまだない。トリムの量と確定（Enter）・やめる（Esc）はタイムラインの帯と札に出る。
- 新しい編集画面は最近開いたプロジェクトの一覧（`mozcut-recent.txt`）にまだ書かない。
