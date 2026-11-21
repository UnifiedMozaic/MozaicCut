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
| `src/edit2/wire_*.um` | 配線の口（いまは空） |

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
| `wire_timeline.um` | `wireTimeline(ui, ed, kit, v, res)` | `TlResult`（ops・command・seek・selChanged・trimming） | `res.ops` を `e2ApplyOps`、`res.seek` を `E2_PB_SEEK`、`res.command` の分割・削除・詰めて削除を op にして適用、素材の欄からのドラッグ（`POOL_DRAG_MEDIA`）を落としたら置く op |
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

## stage-m1 を載せるときにつなぐ所

stage-m1 は古い編集画面（`src/editor.um`）に「音の再生」と「素材のドロップ」を足している。新しい編集画面では次の 2 か所につなぐ:

1. **再生の時計（音）**: `src/edit2/e2_clock.um` の `e2ClockTick`。stage-m1 の `audioplay.um`（`newAudioPlay` / `apReload` / `apUpdate` / `apClose`）を main で作って `e2ClockTick` に渡し、`pbTick` の前で音の出力の位置を `pbAudioClock` に渡す（音の出力を時計にする）。プロジェクトを読み直したとき（`ed.pbStale`）は `pbReload` と一緒に `apReload`。再生の頼み（`e2ClockApply`）で止める・鳴らすのも合わせる。
2. **素材のドロップ**: `src/edit2/e2_drop.um` の `e2DropFiles(ed, kit, v, files, where, x, y)`。stage-m1 の `dropMedia`（FFmpeg で調べて、タイムラインの末尾に足す）をここから呼ぶ。`where` で振り分ける（`E2_DROP_POOL` 素材として読み込む ／ `E2_DROP_TIMELINE` 落とした位置に置く ／ `E2_DROP_MONITOR` ソースで開く ／ `E2_DROP_OTHER` 末尾に足す）。素材の欄の受け口の光り（`v.pool.dropHover`）は `e2DropTake` がすでに出している。

stage-m1 は `render.um` の素材の型（`Media` → `MediaSource`）と `renderFrameFrom` の引数も変えているので、載せるときは `e2_state.um`（`loadMedia`）・`e2_clock.um`（`renderFrameFrom`）・`e2_view.um`（`ed.media` の大きさ）を合わせる。

## 試し方

```sh
node tools/mozcut.mjs build
SDL_VIDEO_DRIVER=offscreen SDL_AUDIO_DRIVER=dummy build/mozcut-edit demo/demo.mzc --frames 6 --shot x.bmp --seek 3 --select clip_a
#   --size 1440x900（既定）--scale 1.0 --play 1
#   --down x,y@F --move x,y@F --up x,y@F --click x,y@F    F フレーム目にマウスの入力（境目のドラッグなど）
node tests/run.mjs edit2      # 1440×900 の配置・境目のドラッグ・起動の誤り
```

`demo/demo.mzc` の素材（`demo/media/`）と展開（`demo/demo.cache/`）は、`node tools/mozcut.mjs preview demo/demo.mzc 3` などで一度作っておく。

## モックアップとの見比べ（1440×900、demo.mzc）

合っている所: 上の帯の並び（ロゴ・メニュー 7 語・プロジェクト名 / シーケンス・保存の状態・ワークスペースの切り替え・コマンドを探す欄・↶ ↷・集中モード・［書き出す…］）、
レールの 7 項目（素材を選んだ印の線）、左の欄の素材の格子、モニターの見出し・再生の帯・時刻、右の列のタブとインスペクタの中身、
タイムラインの帯・ルーラー・トラックの見出し・クリップの色、メーター、状態の帯の左の 1 文と右の項目。各領域の位置と大きさはモックアップと同じ（モニター 804×467、タイムライン 368）。

まだ違う所（次の段で直す）:

- 素材の縮小画像は、本物のコマではなく種類ごとの仮の絵柄（`pool_draw.um` の見本の絵）。
- プロジェクト名の横のシーケンス名は仮（「シーケンス 1」。.mzc にシーケンスがまだない）。保存の時刻、AI の札、実行先（「CPU」と出す）も仮。
- メーターは目盛りだけ（音の値がまだない。stage-m1 の音の再生がつながったら渡す）。
- トラックの名前は種類からの仮（本編・映像・文字・音）。
- レールの「素材」以外の欄と、ワークスペースの「色・音・出力」は中身がない（押すと「まだつないでいません」）。コマンドパレットもまだない。
- 窓が狭いとき（1024 幅）の上の帯の縮め方（ui.md 2.1 の ①〜④）がまだなく、ワークスペースの切り替えが検索の欄に重なる。高さが足りないとき、レールの下の項目が重なる。
- 新しい編集画面は最近開いたプロジェクトの一覧（`mozcut-recent.txt`）にまだ書かない。
