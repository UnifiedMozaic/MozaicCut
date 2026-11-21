# uikit: 画面の部品の仕組み（M2）

MozaicCut の画面を UM で書くための、即時モードの UI の部品の仕組みです。SDL3 のウィンドウの組み込み（`windowOpen` / `pollWindowEvent` / `windowPresent`）の上で、画素の `Buffer<u32>`（0xAARRGGBB）に CPU で描きます。OS に依存するものは使いません。

- 置き場所: `src/uikit/`（`base` `draw` `theme` `core` `layout` `icons` `widgets` `window` `bmp`）
- 見本: `src/uikit_demo.um`（全部品のギャラリー）
- 試し: `src/uikit_test.um` と `tests/uikit/run.mjs`

名前の空間は全ファイルで 1 つなので、uikit の名前はすべて `uk` / `Uk` / `UK_` で始めます。

## 1 フレームの流れ

```ts
let ui = ukNew(ukThemeDefault(1.0), own uiFont());
while (running) {
  let res = ukWinResNew();
  while (true) {                       // 入力をためる
    const e = pollWindowEvent(ukWantsFrame(ui) ? 0 : 50);
    if (e == null) { break; }
    ukFeedWindowEvent(mut ui, e, mut res);
  }
  ukBegin(mut ui, W, H, clock());      // たまった入力を、このフレームの入力にする
  if (ukButtonPrimary(mut ui, "書き出し")) { ... }   // 部品を呼ぶ（入力を見て、描く命令を積む）
  v = ukSlider(mut ui, "音量", v, 0.0, 1.0, 0.01, 2);
  ukEnd(mut ui, mut px);               // 重なりの順に並べ、変わったタイルだけ描き直す
  windowPresent(win, px, W, H);
}
```

- 値は「渡して、新しい値を返してもらう」形です。直前の部品で値が変わったかは `ui.lastChanged`、入力欄で Enter を押したかは `ui.lastSubmit`。
- 部品の ID はラベルのハッシュに `ukPushId` の積み重ねを混ぜたもの。同じラベルが並ぶときは `"削除##clip3"` のように `##` の後ろで区別します（表示は `##` より前）。
- `ukWantsFrame(ui)` が true の間（アニメーション、押している最中、カーソルの点滅、通知）は待たずに次のフレームを描きます。false なら入力を待って CPU を休ませます。
- `ui.wantText` が true の間は文字の入力欄がキーボードを使っています。アプリは 1 文字のショートカット（S で分割など）を止めてください（入力欄は修飾キーのない文字のキーを取るので、ふつうは重なりません）。

## 芯（core.um）

| 仕組み | 中身 |
| --- | --- |
| 入力 | `ukEventMouseMove` / `ukEventMouseButton`（1 左 2 中 3 右）/ `ukEventWheel` / `ukEventKey`（`UK_KEY_*`、文字は `UK_KEY_CHAR + 符号位置`）/ `ukEventText`（IME の確定を含む）。`window.um` の `ukFeedWindowEvent` が `WindowEvent` を変換。ダブルクリック（0.4 秒・4 画素以内）を数える |
| 当たり判定 | その場で判定（ずれがない）。切り取り（clip）の外と、前のフレームでより上の層（ポップアップ・ダイアログ）が覆っていた所は当たらない |
| 状態 | ホバー（`hot`）、押下・ドラッグ（`active`。押した部品が離すまで入力を持つ）、フォーカス（`focus`）、ツールチップ（同じ部品に 0.5 秒止める）。`ukBehavior(ui, id, r, focusable)` が `UkHit { hover, held, pressed, clicked, rclicked, dbl, focused }` を返す |
| キーボード | Tab / Shift+Tab でフォーカスが動く（ダイアログが開いていればその中だけ）。フォーカスの輪はキーボードで動かしたときだけ見せる。Enter / Space で押せる。何もない所を押すとフォーカスが外れる |
| 重なり | 層（`UK_L_BASE` 0 → `UK_L_FLOAT` 4 → `UK_L_MODAL` 8 → `UK_L_POPUP` 16〜 → `UK_L_TOAST` 28 → `UK_L_TIP` 30）。命令は層ごとに、積んだ順に描く |
| 切り取り | `ukPushClip` / `ukPopClip`（重なりを取る）、`ukPushClipScreen`（ポップアップ用） |
| 描き直し | 画面を 32×32 のタイルに分け、タイルに掛かる命令の中身のハッシュを前のフレームと比べ、変わったタイルだけを（横・縦につないだ四角で）描き直す。部分の描き直しと全体の描き直しが同じ画素になることを試しで確かめている |
| 文字 | `ttf.um` のフォントで、文字列と大きさごとに幅と被覆率の画像を覚えておく（1536 個まで） |
| 覚えておく値 | `ukSt(ui, id)` が ID ごとの小さな値の置き場（スクロールの位置、カーソル、開いているか）を返す。使われないものは捨てる |
| 通知 | `ukToast(ui, 文字, 種類)`（0 情報、1 成功、2 注意、3 誤り）。右下に 4 秒出る |

## 配置（layout.um）

- `ukNext(ui, 自然な幅, 自然な高さ)` で、いまの箱から部品の四角をもらう。`ukSetNext(ui, r)` で直に決めることもできる。
- 列: `ukBeginColAt(ui, r)`。交差方向は `ukAlign(ui, UK_A_START / CENTER / END / STRETCH)`、間は `ukGap`、`ukSpace` で空ける。
- 行: `ukBeginRow(ui, 高さ, sizes)` / `ukBeginRowAt(ui, r, sizes)`。sizes は正が画素、負が伸び縮みの重み、0 が部品の自然な幅（例: `[120, -1, 80]`）。右の端からはみ出す部品は縮む（文字は「…」）。
- 高さを中身で決める箱: `ukBeginGroup(ui, 余白, 地の色)`。横に列を並べるときは `ukBeginColumns(ui, sizes)` の中で `ukBeginGroup`。
- 分割: `ukSplit(ui, label, r, vertical, 最初の割合, 最小A, 最小B)` → `{a, b, bar}`。仕切りをドラッグで動かし、ダブルクリックで戻す。
- スクロール: `ukBeginScroll(ui, label, r)` 〜 `ukEndScroll`。中身の高さを測り、ホイール（内側が先に取る）とスクロールバー（溝を押すと跳ぶ、つまみをドラッグ）で動く。
- タブ: `ukTabs(ui, label, 名前の並び, 選択)`。フォーカス中は左右のキー。
- ドッキングの土台: `UkDock`（パネルの題と、区画ごとのパネルの並び）。`ukDockArea(ui, mut dock, 区画, r)` がタブの列を描き、見せるパネルと中身の四角を返す。タブを引きずって、ほかの区画のタブの列か中身に落とすと移り、同じ区画なら並べ替わる。区画を増やす（端に落として分割する）のは、この上に後で足す。

## 部品（widgets.um）

| 部品 | 関数 |
| --- | --- |
| ボタン | `ukButton` / `ukButtonPrimary` / `ukButtonDanger` / `ukButtonEx(ui, label, UK_BTN_*, UK_I_*)`（副・主・危険・静か、アイコンつき）/ `ukIconButton(ui, label, icon, on)`（ラベルはツールチップ） |
| 選択 | `ukToggle` / `ukCheck`（新しい bool を返す）/ `ukRadio(ui, label, cur, val)` |
| 数 | `ukSlider`（溝を押す・ドラッグ、左右・PageUp/Down・Home/End、値をダブルクリックで打ち込み）/ `ukNumber`（左右にドラッグで変える。Shift で 1/10、Ctrl で 10 倍。クリックか Enter で打ち込み、上下のキー）/ `ukTimecode`（コマ番号。`HH:MM:SS:FF`、`1000` は 10 秒、`+15` で 15 コマ進める） |
| 文字 | `ukTextField(ui, "説明##id", 文字)`: カーソル、マウスとShift+矢印の選択、ダブルクリックで全選択、日本語の確定文字の挿入、Backspace / Delete（Ctrl で語ごと）、左右（Ctrl で語ごと）、Home / End、Ctrl+A / C / X / V、Enter（`ui.lastSubmit`）、Esc |
| 選ぶ | `ukDropdown(ui, label, 項目, 選択)`（フォーカス中は上下のキーで変える、Enter で開く） |
| メニュー | `ukBeginMenuBar` / `ukMenu` / `ukMenuItem(ui, label, ショートカット)` / `ukMenuCheck` / `ukMenuSep` / `ukBeginSubMenu` / `ukEndMenu` / `ukEndMenuBar`。右クリックは `ukContextMenu(ui, label, 範囲)`。外を押すか Esc で閉じる |
| 一覧 | `ukBeginList(ui, label, r, 数, 選択)` → 見えている範囲 `[first, last)`。その行だけ `ukListRow` で描く（10 万行でも速い）。上下・PageUp/Down・Home/End で選択が動き、見えるようにスクロールする |
| ダイアログ | `ukOpenDialog(ui, label)` → 毎フレーム `ukBeginDialog(ui, label, 幅, 高さ)` 〜 `ukEndDialog`。下の端のボタンは `ukBeginDialogFooter`。後ろを暗くし、下の部品に触れなくする。Esc か × で閉じる |
| そのほか | `ukProgress(ui, 割合, 名前)`（負なら終わりの分からない動き）、`ukTextLine` / `ukTextDim` / `ukHeading` / `ukSection` / `ukSeparator`、`ukBeginProp(ui, 名前, 幅)`（左に名前の 1 行）、`ukTooltip(ui, 文字)` |
| アイコン | `icons.um`: 線・三角・円で描く 21 種（再生、一時停止、停止、＋、－、×、✓、山形 4 向き、検索、はさみ、前後のコマ、三本線、点、情報、注意、目、鍵）。倍率でにじまない |

### 後で足す口

- **クリップボード**: いまは `ui.clipboard`（UI の中だけ）。UM に OS のクリップボードの組み込みが来たら、`widgets.um` の `ukTextEdit` の Ctrl+C / X / V の所で OS とつなぐ。
- **IME の途中の文字**: `ukEventImeComposition(ui, 文字)` を用意してある。組み込みが来たら `window.um` から呼べば、入力欄のカーソルの所に下線つきで描く（確定の文字はいまも `WindowEvent.Text` で入る）。IME の候補の窓の位置を OS に知らせる口も、組み込みと一緒に足す。
- **マウスカーソルの形**（仕切りの上で ↔ など）: 組み込みが来たら `ukBehavior` の hover で決める。

## テーマ（theme.um）

色・文字の大きさ・余白・角などを 1 つの構造体 `UkTheme` に持ちます。大きさは UI の倍率（1.0〜2.0）を掛けた画素で持ち、`ukThemeScale(mut t, 倍率)` で作り直します（倍率を変えたら `ukInvalidate`）。

`docs/design/tokens.json` ができたら `ukThemeFromTokens(mut t, json)` で読みます（読めない値は既定のまま。戻り値は設定できた数）。JSON のどの深さでもよく、キーの道筋の最後の 2 つ（`value` / `$value` は飛ばす）を `<親>.<名前>` にして当てます。親は `color` / `colors` → 色、`size` / `sizes` / `space` / `spacing` / `radius` / `font` → 大きさ（倍率 1.0 の画素。`"4px"` も読む）。

| 種類 | 名前 |
| --- | --- |
| 色 | bg, panel, panelAlt, raised, raisedHover, raisedActive, inputBg, border, borderStrong, text, textDim, textOff, accent, accentHover, accentActive, onAccent, danger, dangerHover, success, warning, focus, selection, track, overlay, shadow, tipBg, tipText |
| 大きさ | font, fontSmall, fontLarge, ctrlH, rowH, pad, gap, radius, radiusSm, stroke, icon, scrollW, tabH, menuH, splitW, shadowBlur |

製品デザインの `tokens.json` の名前が違うときは、`ukTokGroup` と `ukThemeSet` に読み替えを足します。いまの値は仮の暗いテーマです。

## 見本と試し

```sh
node <UM>/src/cli.ts build src/uikit_demo.um --target host -o build/uikit-demo   # UM_SDL3 が要る
SDL_VIDEO_DRIVER=offscreen build/uikit-demo --frames 8 --click 30,13@2 --shot x.bmp   # 画面を出さずに画像を書く
build/uikit-demo --bench                                                          # 速さ（ウィンドウなし）
node tests/uikit/run.mjs [--bench] [--shot]
```

見本は `--move x,y@F` `--click` `--rclick` `--down` `--up` `--key 名前@F`（`shift+tab`、`ctrl+a` など）`--type 文字@F` `--wheel d@F` で、F フレーム目に入力を入れられます（`--frames` のときは時刻も 1/60 秒ずつ進むので、画像が毎回同じになる）。`--scale 1.5`、`--size 1920x1080`、`--tokens <json>` も使えます。

## 速さ（1440×900、部品 300 個。Windows、ネイティブ）

| 場合 | 1 フレーム |
| --- | --- |
| 1 フレーム目（文字の画像を作る分を含む） | 約 9 ms |
| 全体を描き直す（`ukInvalidate`） | 約 5 ms（倍率 2.0 で約 11 ms、1920×1080 で約 6 ms） |
| 何も変わらない（部品を作り、ハッシュを比べるだけ） | 約 0.5 ms |
| マウスを動かす（ホバーの変わった所だけ。平均 約 9,000 画素） | 約 0.5 ms |

`tests/uikit/run.mjs --bench` は、全体の描き直しが 33 ms を超えたら失敗にします。
