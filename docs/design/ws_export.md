# 書き出しのワークスペース（src/ws_export/）

書き出しの画面の部品（`src/ui_export/`。見た目と操作は [ui.md](ui.md) §10、`mockups/export.html`）を、本物の中身につなぐ部分です。

| つなぐ先 | 使うもの |
| --- | --- |
| プリセット | `src/presets.um`（`exportPresetList`・`exportPresetCheck`・`exportPresetResolve`・`exportPresetFfmpegArgs`） |
| 書き出しの予約 | `src/renderqueue.um`（`RenderQueue`・`rqAdd`・`rqTick`・`rqApplyLog`・`rqCancel`・`rqRetry`） |
| 書き出しの前の確認 | `.mzc` を読んだときの診断（`parseProject`）＋ プリセットとの食い違い（`exportPresetCheck`）＋ 出力の場所 |
| 書き出し | 今の `main.um` の `render`（別のプロセス）＋ ffmpeg（プリセットの引数） |

写し方（`ExportPreset` → `UePreset`、`Diag` → `UeCheck`、`RenderJob` → `UeJob`）は `src/ui_export/link_m5.um` のものをそのまま使います。

## ファイル

| ファイル | 中身 |
| --- | --- |
| `src/ws_export/types.um` | 型（`WsxState`・`WsxOpen`・`WsxRun`・`WsxNotice`） |
| `src/ws_export/job.um` | **書き出しを始める唯一の口** `wsxStartExport` と、進み具合の受け取り `wsxPollJobs`、取り消し `wsxCancelJob` |
| `src/ws_export/state.um` | 開く（`wsxOpen`）、確認（`wsxRecheck`）、要約の推定（`wsxEstimate`）、画面の知らせに応える（`wsxHandle`）、毎フレームの更新（`wsxUpdate`） |
| `src/ws_export/preview.um` | 再生ヘッドのコマを本物の合成（`renderFrame`）で描く |
| `src/ws_export/folder.um` | 書き出す場所を文字で入れる欄と、OS のフォルダのダイアログをつなぐ口 |
| `src/ws_export/workspace.um` | 1 フレーム（`wsxFrame`）: プレビュー・書き出しの画面・場所の欄を描き、知らせに応える |
| `src/ws_export_demo.um` | 単体の見本。本物の `.mzc` を開いて、実際に書き出す |
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
  最後のコマが落ちないよう、仕事の終わりを「最後まで」（`toSec = -1`）にします。
- **ファイル名と場所**: ファイル名は画面の欄（`ukTextEdit`）。場所は「変える…」で文字の欄を開きます（Enter か［決める］）。
  OS のダイアログは、窓を持つ呼ぶ側が `wsxFolderDialogWanted` / `wsxFolderDialogDone` でつなぎます（`folder.um` の先頭）。
  見本は `--dialogs` を付けたときだけダイアログを出します（試しでは付けない）。
- **要約**: 推定の大きさはプリセットのビットレート × 長さ（品質の固定で上限がなければ、画素あたり 0.1 ビットの目安）。
  推定の時間は、前に書き出した速さから（まだなければ、合成と圧縮で毎秒 2000 万画素の目安。「（目安）」を付ける）。
- **確認**: `.mzc` の診断、プリセットとの食い違い（向き・拡大・コマの速さ…。勧めるプリセットのボタンつき）、範囲が空、
  出力のフォルダがない（書き出すときに作る）、同じ名前のファイルがある（置き換える）。エラーがあれば書き出しを始めません
  （画面のボタンも、台本から呼んだときも）。
- **待ち行列**: 進み具合（合成 0〜50%、圧縮 50〜100%）、残り時間、取り消し（書きかけの出力は消す）、やり直し。

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

（`build/ui/ws_export_demo.exe` は `node tests/ui/run.mjs ws_export` か UM の `cli.ts build src/ws_export_demo.um` で作る。
runner は見本を `SDL_VIDEO_DRIVER=offscreen`・`SDL_AUDIO_DRIVER=dummy` で起動するので、窓は出ません。）

## stage-m1 を載せたら

stage-m1（FFmpeg の組み込みで素材をその場で展開し、MP4 を直接書く）を載せたら、ここを差し替えます。呼ぶ側
（`state.um`・`workspace.um`）は `wsxStartExport` / `wsxPollJobs` / `wsxCancelJob` だけを使うので、変えなくて済みます。

1. `job.um` の `wsxStartExport`: 依頼のファイルを書く代わりに、`thread.spawn` で組み込みの書き出し（stage-m1 の main.um の
   書き出しの関数）を走らせる。進み具合（済んだコマ数）と止める印は `RacyBuffer` で受け渡す。
2. `job.um` の `wsxPollJobs`: ログのファイルの代わりに `RacyBuffer` を読み、`rqProgress` / `rqSetPhase` / `rqFinish` / `rqFail` に通す。
3. `job.um` の `wsxCancelJob`: 止める印のファイルの代わりに `RacyBuffer` の印を立てる。
4. `preview.um`: 素材の展開の有無（`checkMedia`）を見なくてよくなる（その場で展開する）。
5. `tools/ws-export-runner.mjs` を消し、`tests/ws_export/run.mjs` は見本を直接起動する。

## まだつないでいないもの

- フォルダを開く・再生する・失敗したクリップへ移る・失敗の詳細のコピー・自分のプリセットの保存（知らせを出すだけ）。
- 確認の項目の「場所を指定する」「そのクリップへ移る」「シーケンスの設定を開く」（編集画面の仕事。知らせを出すだけ）。
- 字幕の扱い（焼き込む・SRT）は画面の値だけで、書き出しにはまだ効かない。
- `.mzc` を書き換えたときの読み直し（開いたときに 1 回だけ読む）。
