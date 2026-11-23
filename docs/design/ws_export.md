# 書き出しのワークスペース（src/workspaces/export/）

書き出しの画面の部品（`src/ui/export/`。見た目と操作は [ui.md](ui.md) §10、`mockups/export.html`）を、本物の中身につなぐ部分です。

| つなぐ先 | 使うもの |
| --- | --- |
| プリセット | `src/engine/presets.um`（`exportPresetList`・`exportPresetCheck`・`exportPresetResolve`・`exportPresetFfmpegArgs`） |
| 書き出しの予約 | `src/engine/renderqueue.um`（`RenderQueue`・`rqAdd`・`rqTick`・`rqApplyLog`・`rqCancel`・`rqRetry`） |
| 書き出しの前の確認 | `.mzc` を読んだときの診断（`parseProject`）＋ プリセットとの食い違い（`exportPresetCheck`）＋ 出力の場所 |
| 書き出し | 今の `main.um` の `render`（別のプロセス）＋ ffmpeg（プリセットの引数） |

写し方（`ExportPreset` → `UePreset`、`Diag` → `UeCheck`、`RenderJob` → `UeJob`）は `src/ui/export/link_m5.um` のものをそのまま使います。

## ファイル

| ファイル | 中身 |
| --- | --- |
| `src/workspaces/export/types.um` | 型（`WsxState`・`WsxOpen`・`WsxRun`・`WsxNotice`） |
| `src/workspaces/export/job.um` | **書き出しを始める唯一の口** `wsxStartExport` と、進み具合の受け取り `wsxPollJobs`、取り消し `wsxCancelJob` |
| `src/workspaces/export/state.um` | 開く（`wsxOpen`）、確認（`wsxRecheck`）、要約の推定（`wsxEstimate`）、画面の知らせに応える（`wsxHandle`）、毎フレームの更新（`wsxUpdate`） |
| `src/workspaces/export/preview.um` | 再生ヘッドのコマを本物の合成（`renderFrame`）で描く |
| `src/workspaces/export/folder.um` | 書き出す場所を文字で入れる欄と、OS のフォルダのダイアログをつなぐ口 |
| `src/workspaces/export/workspace.um` | 1 フレーム（`wsxFrame`）: プレビュー・書き出しの画面・場所の欄を描き、知らせに応える |
| `demos/ws_export_demo.um` | 単体の見本。本物の `.mzc` を開いて、実際に書き出す |
| `tools/ws-export-runner.mjs` | 書き出しを別のプロセスで走らせる係（node） |
| `tests/ws_export/run.mjs` | テスト。見本で `demo.mzc` を書き出し、ffprobe で確かめる |

名前の空間は全ファイルで 1 つなので、公開する名前は `wsx` / `Wsx`（見本の中だけのものは `wsxd`）で始めます。

## 使い方（編集画面に組み込むとき）

```ts
let st = wsxOpen(wsxOpenArgs(mzc, cache));        // 1 度だけ。イン・アウト・選んだクリップ・再生ヘッドも渡せる
let pv = wsxPreviewNew(st.project, st.cache);
let cache = ueCacheNew();
// 毎フレーム
ukBegin(mut ui, W, H, clock());
… 上の帯・レール …
const notes = wsxFrame(mut ui, t, mut st, mut pv, mut cache, body, clock());   // body はワークスペースの四角
ukEndImage(mut ui, mut px, pv.img, pv.w, pv.h);    // プレビューの絵は ukDrawImage で貼るので、画像を渡す
```

- **書き出す**: 仕事を待ち行列の最後に足し、待ち行列を動かします（前の仕事が走っていれば、その後）。
- **待ち行列に足す**: 足すだけです。次に「書き出す」かやり直しを押したときに、並びの順に走ります。
- **範囲**: シーケンス全体・イン〜アウト（アウトのコマを含む）・選んだクリップ。最後まで書き出すときは、秒の丸めで
  最後のコマが落ちないよう、仕事の終わりを「最後まで」（`toSec = -1`）にします。途中の端は半コマ前の時刻で渡します
  （依頼の JSON は秒を小数 6 桁に丸めるので、コマの境目ちょうどだと 1 コマずれる）。
- **.mzc の書き換え**: 1 秒ごとと、書き出しを頼む前に `.mzc` の中身を比べ、変わっていれば読み直します（`wsxReloadIfChanged`。
  範囲・再生ヘッド・選んだプリセットは残す）。合成（render）は `.mzc` をその場で読むので、ffmpeg の引数・コマ数・確認を
  同じ中身から作るためです。プレビューは `projectVer` が変わったら素材の表を作り直します。
- **ファイル名と場所**: ファイル名は画面の欄（`ukTextEdit`）。場所は「変える…」で文字の欄を開きます（Enter か［決める］）。
  OS のダイアログは、窓を持つ呼ぶ側が `wsxFolderDialogWanted` / `wsxFolderDialogDone` でつなぎます（`folder.um` の先頭）。
  見本は `--dialogs` を付けたときだけダイアログを出します（試しでは付けない）。
- **要約**: 推定の大きさはプリセットのビットレート × 長さ（品質の固定で上限がなければ、画素あたり 0.1 ビットの目安）。
  推定の時間は、前に書き出した速さから（まだなければ、合成と圧縮で毎秒 2000 万画素の目安。「（目安）」を付ける）。
- **確認**: `.mzc` の診断、プリセットとの食い違い（向き・拡大・コマの速さ…。勧めるプリセットのボタンつき）、範囲が空、
  出力のフォルダがない（書き出すときに作る）、同じ名前のファイルがある（置き換える）。エラーがあれば書き出しを始めません
  （画面のボタンも、台本から呼んだときも）。
- **待ち行列**: 進み具合（合成 0〜50%、圧縮 50〜100%）、残り時間、取り消し（書きかけの出力は消す）、やり直し。

## 新しい編集画面（edit2）の「出力」

新しい編集画面では、`src/editor/ws_export.um` がこのワークスペースを「出力」に組み込んでいます（状態は
`src/editor/wex_state.um` の `WexState`。edit2 の決まりは [edit2.md](edit2.md) の「ワークスペースの担当へ」）。
上の帯の札「出力」・［書き出す…］・コマンドパレットの「ワークスペース: 書き出し」で開きます。

- **置き場所**: 中央（カット編集のモニターの場所）と右の列を合わせた四角に、`ueWorkspace`（左にプリセット、
  中にプレビュー、右に要約・確認・ボタン・待ち行列）と場所の欄（`wsxFolderBar`）を描きます。上の帯・左の欄・
  タイムライン・状態の帯は、ほかのワークスペースと同じです。
- **プレビュー**: `wsxFrame` / `wsxDrawPreview` は使わず、編集画面がモニターのために描いた絵（`E2Pic`）を、
  モニターと共有のキャンバス（`MonCanvas`）に写して貼ります（素材を別に開かない）。写したら `cv.gen` を進めて、
  カット編集に戻ったときにモニターが合成し直すようにします。範囲の帯をスクラブすると、編集画面の再生ヘッドが動きます。
- **範囲**: 「出力」を開くたびに、タイムラインのイン・アウト（`v.tl.inPt` / `outPt`）と選んだクリップ（`v.tl.sel`）を
  範囲の候補に写します。選んでいた範囲がなくなったら、シーケンス全体に戻します。
- **書き出すもの**: 保存されている `.mzc`（編集画面は操作のたびに `.mzc` を書くので、いまの中身と同じ）。
- **画面を止めない**: 書き出しは別のプロセス（`tools/ws-export-runner.mjs`）で走ります。`node tools/mozcut.mjs edit` は、
  編集画面より先に係を依頼を待つ形で起動し、編集画面が終わったら走っている書き出しを止めてから係を終わらせます。
  `build/mozcut-edit` を直接起動したときは係がいないので、依頼は置かれても進みません（係を
  `node tools/ws-export-runner.mjs --cache <cache>` で別に起動する）。
- **進み具合**: `wexTick` が、どのワークスペースにいても毎フレーム `wsxUpdate` を呼び（ログを読む・待ちの仕事を始める）、
  状態の帯（`e2StatusBar`。問題の件数の左）に「書き出しています 40% · demo.mp4」と進み具合の棒を出します。終わったら
  「書き出しました: <絶対パス>」と［パスをコピー］、失敗したら誤りの色で「書き出せませんでした · …」を、次の書き出しが
  始まるまで残し、トーストでも知らせます。UM に OS でフォルダを開く組み込みがないので、［フォルダを開く］の代わりに
  パスを写します。状態の帯の 1 文を押すと「出力」を開きます。
- **初めの名前と場所**: project 行に `output=` があればその名前とフォルダ、なければ .mzc のフォルダに「プロジェクト名.拡張子」。
  要約の `output=` は場所の欄とファイル名から作り（`ueOutputRel`。.mzc のフォルダの下なら相対）、実際に書く先と同じです。
- **試し**: `tests/ws_export/run.mjs` の「編集画面/」の場合（試しが係の代わりをして、依頼の中身と状態の帯を見る）。

## 書き出しの流れ（いま）

UM にはプロセスを起動する組み込みがないので、UI は依頼のファイルを置き、`tools/ws-export-runner.mjs` が起動します。

```
UI（UM）                                        tools/ws-export-runner.mjs（node）
wsxStartExport ──<cache>/wsx/job-<id>-<回>.json──▶ 1. 素材の展開（mozcut.mjs の prepare と同じ）
                                                    2. build/mozcut render <p.mzc> <cache> <from> [<to>]（main.um の render）
                                                    3. ffmpeg（依頼の args = rqEncodeTask。-progress pipe:1）
wsxPollJobs    ◀──<cache>/wsx/job-<id>-<回>.log───  phase= / render_frame= / out_time_us= / stderr= / exit= / render_failed=
wsxCancelJob   ──<cache>/wsx/job-<id>-<回>.stop──▶ 子のプロセスを止め、書きかけの出力を消す
```

- 依頼の JSON は `rqEncodeTaskJson` のまま、ログの書き方は `rqApplyLog` のまま（`renderqueue.um` の先頭のつなぎ口の約束）。
- UI は毎コマ、ログのファイルの大きさだけを見て、増えたときに続きを読みます。書き出しは別のプロセスなので、画面は止まりません。
- 依頼の名前に何回目か（`RenderJob.attempts`）を入れるので、やり直しても前の回のログを読み違えません。
- 合成は `<cache>/out.y4m` と `out.pcm` に書くので、同時に走らせる仕事は 1 つです（`rqNew(1)`）。
- runner は起動のたびに `<cache>/wsx/` を空にします（仕事の番号は起動ごとに 1 から）。

試し方:

```sh
node tools/ws-export-runner.mjs --cache demo/demo.cache --project demo/demo.mzc -- \
  build/ui/ws_export_demo.exe --project demo/demo.mzc --preset web-light --export-at 3 --until-done --shot done.bmp
```

（`build/ui/ws_export_demo.exe` は `node tests/ui/run.mjs ws_export` か src/ の写しの一番上に demos/ws_export_demo.um を置いて UM の `cli.ts build` で作る。
runner は見本を `SDL_VIDEO_DRIVER=offscreen`・`SDL_AUDIO_DRIVER=dummy` で起動するので、窓は出ません。）

## FFmpeg の組み込みで直接書く（MP4 のプリセット）

MP4（H.264 と、AAC か音なし）のプリセットで、FFmpeg の組み込みがあれば（`job.um` の `wsxDirectOk`）、`wsxStartExport` は
依頼のファイルを置かずに、このプロセスの中で `encode.um` の書き出しを始める。呼ぶ側（`state.um`・`workspace.um`）は
変わらない（`wsxStartExport` / `wsxPollJobs` / `wsxCancelJob` だけを使う）。

- UM のスレッドの持ち手は `const` の宣言にしか置けず、フレームをまたいで持てないので、別のスレッドでは走らせない。
  `wsxPollJobs` が毎フレーム 0.03 秒まで `encStep` で進め、済んだ割合（`encFraction`）をプロジェクトのコマ数にして `rqProgress` に渡す
  （合成と圧縮を 1 つの段階「render」にし、`renderShare` は 1）。書き出しのあいだは画面のフレームが遅くなる。
- 設定はプリセットから: 大きさ・黒い帯・コマの速さの上限は `exportPresetResolve` と同じ、映像は平均のビットレート（crf のものは
  上限のビットレート）、音は AAC のビットレート。音の大きさの目標（loudness）は、先に全体を混ぜて BS.1770 の統合ラウドネスと
  真のピークを測り、目標に合わせる 1 つの倍率を掛ける（真のピークが上限を超えない所まで下げる。ffmpeg の loudnorm のような動的な
  処理はしない）。プロファイル・キーフレームの間隔・上限のビットレートは符号器に任せる（UM がハードウェアの符号器から選ぶ）。
- `<cache>/wsx/job-<id>-<回>.mp4` に書き、書き終えたら出力の場所に写して完了にする（写せなければ `encode-failed`）。取り消すと
  書き手を閉じて一時のファイルを空にする（出力の場所の前のファイルには触らない。UM にファイルの名前を変える・消す組み込みがないので、
  写して空にする）。
- ProRes・WAV・M4A のプリセットと、FFmpeg の組み込みがない版は、これまでどおり依頼のファイルを置いて `tools/ws-export-runner.mjs` に
  頼む（下の「係」）。`preview.um` の `checkMedia` は、素材をその場で開く版では空になる。
- 試し（`tests/ws_export/run.mjs`）: MP4 のプリセットは見本が直接書く。runner は見本を起動するだけで、音だけの AAC などの依頼を受ける。

## まだつないでいないもの

- フォルダを開く・再生する・失敗したクリップへ移る・失敗の詳細のコピー・自分のプリセットの保存（知らせを出すだけ）。
- 確認の項目の「場所を指定する」「そのクリップへ移る」「シーケンスの設定を開く」（編集画面の仕事。知らせを出すだけ）。
- 字幕の扱い（焼き込む・SRT）は画面の値だけで、書き出しにはまだ効かない。
