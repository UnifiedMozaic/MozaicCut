# uikit: 画面の部品の仕組み（M2）

MozaicCut の画面を UM で書くための、即時モードの UI の部品の仕組みです。SDL3 のウィンドウの組み込み（`windowOpen` / `pollWindowEvent` / `windowPresent`）の上で、画素の `Buffer<u32>`（0xAARRGGBB）に CPU で描きます。OS に依存するものは使いません。

- 置き場所: `src/ui/kit/`（`base` `draw` `theme` `core` `layout` `icons` `widgets` `window` `bmp`）
- 見本: `demos/uikit_demo.um`（全部品のギャラリー）
- 試し: `tests/uikit/uikit_test.um` と `tests/uikit/run.mjs`

名前の空間は全ファイルで 1 つなので、uikit の名前はすべて `uk` / `Uk` / `UK_` で始めます。

## 1 フレームの流れ

```ts
let ui = ukNew(ukThemeDefault(1.0), own uiFont());
while (running) {
  let res = ukWinResNew();
  let first = true;
  while (true) {                       // 入力をためる
    // 最初の 1 つだけ待つ。待ち時間は ukNextFrameMs（0 すぐ、正 その ms、-1 入力が来るまで）
    const e = pollWindowEvent(first ? ukNextFrameMs(ui) : 0);
    first = false;
    if (e == null) { break; }
    ukFeedWindowEvent(mut ui, e, mut res);
  }
  ukBegin(mut ui, W, H, clock());      // たまった入力を、このフレームの入力にする
  if (ukButtonPrimary(mut ui, "書き出し")) { ... }   // 部品を呼ぶ（入力を見て、描く命令を積む）
  v = ukSlider(mut ui, "音量", v, 0.0, 1.0, 0.01, 2);
  ukEnd(mut ui, mut px);               // 重なりの順に並べ、変わったタイルだけ描き直す
  ukWindowSync(mut ui, win);           // コピーした文字・カーソルの形・文字の入力の入り切りを OS に渡す
  windowPresent(win, px, W, H);
}
```

- 値は「渡して、新しい値を返してもらう」形です。直前の部品で値が変わったかは `ui.lastChanged`、入力欄で Enter を押したかは `ui.lastSubmit`。
- 部品の ID はラベルのハッシュに `ukPushId` の積み重ねを混ぜたもの。同じラベルが並ぶときは `"削除##clip3"` のように `##` の後ろで区別します（表示は `##` より前）。
- **止まっているときは描かない（ui.md 21.2）。** `ukNextFrameMs(ui)` は、次に描くまで入力を待ってよい時間を返します。アニメーション（通知が滑り込む・薄くなる間、終わりの分からない進み具合）なら 0、カーソルの点滅・ツールチップが出る時刻・通知が薄くなり始める時刻があればそこまでの ms、何もなければ -1（入力が来るまで眠る）。押している最中・ドラッグ中もマウスの入力で描き直すので、待ってかまいません。`ukWantsFrame(ui)` は `ukNextFrameMs(ui) == 0` と同じです。
- `ui.wantText` が true の間は文字の入力欄がキーボードを使っています。アプリは 1 文字のショートカット（S で分割など）を止めてください（入力欄は修飾キーのない文字のキーを取るので、ふつうは重なりません）。

## 芯（core.um）

| 仕組み | 中身 |
| --- | --- |
| 入力 | `ukEventMouseMove` / `ukEventMouseButton`（1 左 2 中 3 右。SDL の戻る・進む 4・5 は無視）/ `ukEventWheel` / `ukEventKey`（`UK_KEY_*`、文字は `UK_KEY_CHAR + 符号位置`）/ `ukEventText`（IME の確定を含む）。`window.um` の `ukFeedWindowEvent` が `WindowEvent` を変換。ダブルクリック（0.4 秒・4 画素以内）は**押した時刻**で数える（`ukEventMouseButton` は `clock()`、`ukEventMouseButtonAt` は時刻を渡す。前のフレームの時刻は使わないので、入力のときだけ描く作りでも誤らない） |
| 当たり判定 | その場で判定（ずれがない）。切り取り（clip）の外と、前のフレームでより上の層（ポップアップ・ダイアログ）が覆っていた所は当たらない |
| 状態 | ホバー（`hot`）、押下・ドラッグ（`active`）、フォーカス（`focus`）。`ukBehavior(ui, id, r, focusable)` が `UkHit { hover, held, pressed, clicked, rclicked, dbl, focused }` を返す |
| ツールチップ | `ukTooltip(ui, 文字)`。同じ部品に `theme.tipDelay`（tokens の `motion.duration.tooltipDelay`、既定 600ms）止めると出る。出た直後（0.4 秒以内）に隣へ動いたら待たずに出る（ui.md 18 章） |
| キーボード | Tab / Shift+Tab でフォーカスが動く（ダイアログが開いていればその中だけ）。フォーカスの輪はキーボードで動かしたときだけ見せる。Enter / Space で押せる。何もない所を押すとフォーカスが外れる。**ダイアログが開いている間は、下の層の部品にキーが届かない**（フォーカスがあっても） |
| ポップアップの外を押す | 開いているポップアップ（メニュー・ドロップダウン）の外を押すと閉じる。その押す・離すは下の部品に渡さない（閉じると同時に下のボタンが押されない） |
| 重なり | 層（`UK_L_BASE` 0 → `UK_L_FLOAT` 4 → `UK_L_MODAL` 8 → `UK_L_POPUP` 16〜 → `UK_L_TOAST` 28 → `UK_L_TIP` 30）。命令は層ごとに、積んだ順に描く |
| 切り取り | `ukPushClip` / `ukPopClip`（重なりを取る）、`ukPushClipScreen`（ポップアップ用） |
| 描き直し | 画面を 32×32 のタイルに分け、タイルに掛かる命令の中身のハッシュを前のフレームと比べ、変わったタイルだけを（横・縦につないだ四角で）描き直す。部分の描き直しと全体の描き直しが同じ画素になることを試しで確かめている |
| 被覆率の画像 | `ukAlphaSet(ui, 鍵, w, h, a)` で置き場に入れ（捨てない。同じ鍵なら差し替えて版を進める）、`ukDrawAlpha(ui, x, y, 鍵, 色)` で色を塗る。アイコン（`src/ui/icons/draw.um` の `icnDraw`）はこれで描く。`ukAlphaHas` で有無を見る |
| 画像 | `ukDrawImage(ui, r, sx, sy, sw, sh, 版)` と `ukEndImage(ui, px, img, imgW, imgH)`。外の `Buffer<u32>` の四角を、層の順とタイルの描き直しの中で描く（下の「動画のプレビューを重ねる」） |
| 文字 | `ttf.um` のフォントで、文字列と大きさと描き方（style）ごとに幅と被覆率の画像を覚えておく。描き方と書体は下の「文字の役と書体」。表は 3/4 を超えそうならその場で倍にするので、1 フレームに何千の文字列を測っても止まらない。フレームの始めに 1536 個を超えていたら、前のフレームで使わなかったものを捨てる |
| 覚えておく値 | `ukSt(ui, id)` が ID ごとの小さな値の置き場（スクロールの位置、カーソル、開いているか）を返す。表はその場で大きくなり、何も捨てない。フレームの始めに 3072 個を超えていたら、3600 フレーム（約 1 分）使っていない値だけを捨てる。`ukStPin` の印のある値（分割の位置・スクロールの位置・タブの送り・ダイアログ）は捨てない |
| 省略 | `ukFitText`（後ろを「…」）・`ukFitTextS`（描き方つき）・`ukFitTextMid(ui, 文字, 大きさ, 幅, style)`（真ん中を「…」。素材名・ファイル名。tokens の `font.rules.ellipsis.mediaName`）。どれも収まる長さを二分探索で探し、途中の長さは文字の置き場に入れない |
| カーソルの形 | `ukSetCursor(ui, UK_CURSOR_*)`（既定・文字・手・左右・上下・移動・十字・禁止・待ち）。`ukBegin` で既定に戻り、後で呼んだ部品が勝つ。入力欄の上は文字の形、仕切りの上は左右・上下の矢印。`ukWindowSync` が変わったときだけ OS に知らせる |
| ドロップ | 窓の外からファイルを落とすと、`ui.dropActive`（引いている最中）・`ui.dropX / dropY`（ウィンドウの座標）、落としたフレームだけ `ui.dropped` と `ui.dropFiles`。`ukDropOver(ui, 四角)` で受け口の印を出し、`ukDropTake(ui, 四角)` でその四角に落ちたファイルを 1 回だけ受け取る |
| 通知 | `ukToast(ui, 文字, 種類)`（0 情報、1 成功、2 注意、3 誤り）。右下に `theme.toastLife`（tokens の `motion.duration.toastHold`、既定 4 秒）出る |

## 配置（layout.um）

- `ukNext(ui, 自然な幅, 自然な高さ)` で、いまの箱から部品の四角をもらう。`ukSetNext(ui, r)` で直に決めることもできる。
- 列: `ukBeginColAt(ui, r)`。交差方向は `ukAlign(ui, UK_A_START / CENTER / END / STRETCH)`、間は `ukGap`、`ukSpace` で空ける。
- 行: `ukBeginRow(ui, 高さ, sizes)` / `ukBeginRowAt(ui, r, sizes)`。sizes は正が画素、負が伸び縮みの重み、0 が部品の自然な幅（例: `[120, -1, 80]`）。右の端からはみ出す部品は縮む。部品は中身（アイコン・文字・つまみ）を自分の四角で切り取るので、狭くても隣に重ならない。「…」も入らない幅では文字を描かない。
- 高さを中身で決める箱: `ukBeginGroup(ui, 余白, 地の色)`。横に列を並べるときは `ukBeginColumns(ui, sizes)` の中で `ukBeginGroup`。
- 分割: `ukSplit(ui, label, r, vertical, 最初の割合, 最小A, 最小B)` → `{a, b, bar}`。仕切りをドラッグで動かし、ダブルクリックで戻す。
- スクロール: `ukBeginScroll(ui, label, r)` 〜 `ukEndScroll`。中身の高さを測り、ホイール（内側が先に取る）とスクロールバー（溝を押すと跳ぶ、つまみをドラッグ）で動く。
- タブ: `ukTabs(ui, label, 名前の並び, 選択)`。フォーカス中は左右のキー。タブの列は四角で切り取り、あふれたら横にスクロールする（ホイールで動き、選んだタブは見える位置まで送る）。
- ドッキングの土台: `UkDock`（パネルの題と、区画ごとのパネルの並び）。`ukDockArea(ui, mut dock, 区画, r)` がタブの列を描き、見せるパネルと中身の四角を返す。タブの列はタブと同じく切り取って送る。タブを引きずって、ほかの区画のタブの列か中身に落とすと移り、同じ区画なら並べ替わる。区画を増やす（端に落として分割する）のは、この上に後で足す。

## 部品（widgets.um）

| 部品 | 関数 |
| --- | --- |
| ボタン | `ukButton` / `ukButtonPrimary` / `ukButtonDanger` / `ukButtonEx(ui, label, UK_BTN_*, UK_I_*)`（副・主・危険・静か、アイコンつき。危険は地が透明で error の枠と文字だけ、ホバーで errorTint の地。components.html の `.btn.danger`）/ `ukIconButton(ui, label, icon, on)`（ラベルはツールチップ） |
| 選択 | `ukToggle` / `ukCheck`（新しい bool を返す）/ `ukRadio(ui, label, cur, val)`。チェック・ラジオの枠、オフのトグルの縁、スライダーの溝、値の欄の枠は `theme.lineControl`（line.control。地に 3:1 以上） |
| フォーカスの輪 | 二重の輪（ui.md 19 章）: 部品から `focusOffset` 離して内側に accent を `focusW`、そのすぐ外に `focusOuter`（黒）。`ukFocusRing(ui, r, hit)`、四角は `ukFocusRingRect(ui, r, 角)`、円は `ukFocusRingCircle(ui, cx, cy, 半径)`。輪は部品から `focusOffset + focusW + stroke` だけ外に出る |
| 数 | `ukSlider`（溝を押す・ドラッグ、左右・PageUp/Down・Home/End、値をダブルクリックで打ち込み）/ `ukNumber`（左右にドラッグで変える。**Shift で 10 倍、Alt で 1/10**（ui.md 7.3）。クリックか Enter で打ち込み、上下のキー。打ち込み中の Esc は打ち込みの取り消し）。範囲のない欄（lo/hi が ±無限大）でも壊れない: 揃えの基準は有限の lo か 0、step=0 で範囲が無限か 1e4 を超えるなら 1 画素は 10^-decimals（`ukSnap` / `ukDragStep`）|
| タイムコード | `ukTimecode(ui, label, コマ, fpsNum, fpsDen)`。29.97（30000/1001）と 59.94（60000/1001）は**ドロップフレーム**（`HH:MM:SS;FF`、10 分ごとを除く毎分の始めに番号を 2 か 4 飛ばす）で見せて読む。決めたいときは `ukTimecodeEx(..., df)`。`1000` は 10 秒、`+15` で 15 コマ進める（相対の量は名目の速さのコマ数）。ドラッグは 1 画素 1 コマ（Shift で 10 コマ）。区切りなしは 8 桁まで、区切りのある欄は 3 桁まで、欄は 4 つまで（超えたら読まない）。関数: `ukFormatTimecodeDf` / `ukParseTimecodeDf` / `ukIsDropFrame` |
| 文字 | `ukTextField(ui, "説明##id", 文字)`: カーソル、マウスとShift+矢印の選択、ダブルクリックで全選択、日本語の確定文字の挿入、Backspace / Delete（Ctrl で語ごと）、左右（Ctrl で語ごと）、Home / End、Ctrl+A / C / X / V、Enter（`ui.lastSubmit`）、Esc |
| 選ぶ | `ukDropdown(ui, label, 項目, 選択)`。閉じているときは上下のキーで変え、Enter / Space で開く。開いているときは上下・PageUp/Down・Home/End で項目を動かし（見える位置までスクロール）、Enter / Space で選ぶ、Esc で閉じる |
| メニュー | `ukBeginMenuBar` / `ukMenu` / `ukMenuItem(ui, label, ショートカット)` / `ukMenuCheck` / `ukMenuSep` / `ukBeginSubMenu` / `ukEndMenu` / `ukEndMenuBar`。右クリックは `ukContextMenu(ui, label, 範囲)`。メニューバーを押したまま項目へ動かして離しても選べる。外を押すか Esc で閉じる |
| ポップアップ | ドロップダウン・メニューの土台（`ukOpenPopup` / `ukBeginPopup` / `ukEndPopup`）。高さは画面に収め、収まらない分はスクロールする領域に入れる（60 項目のフォント・LUT・プリセットの一覧でも全部に届く） |
| 一覧 | `ukBeginList(ui, label, r, 数, 選択)` → 見えている範囲 `[first, last)`。その行だけ `ukListRow` で描く（10 万行でも速い）。上下・PageUp/Down・Home/End で選択が動き、見えるようにスクロールする |
| ダイアログ | `ukOpenDialog(ui, label)` → 毎フレーム `ukBeginDialog(ui, label, 幅, 高さ)` 〜 `ukEndDialog`。下の端のボタンは `ukBeginDialogFooter`。開いている間は下の部品にマウスもキーも届かない。開くとフォーカスを中の最初の部品に移し、閉じると開く前のフォーカスに戻す（ui.md 19 章）。Esc（中身が取らなかったとき）か × で閉じる。後ろに暗幕は重ねない（ui.md 17.4。ダイアログの枠と影で分ける） |
| そのほか | `ukProgress(ui, 割合, 名前)`（負なら終わりの分からない動き）、`ukTextLine` / `ukTextDim` / `ukHeading` / `ukSection` / `ukSeparator`、`ukBeginProp(ui, 名前, 幅)`（左に名前の 1 行）、`ukTooltip(ui, 文字)` |
| アイコン | `icons.um`: 線・三角・円で描く 21 種（再生、一時停止、停止、＋、－、×、✓、山形 4 向き、検索、はさみ、前後のコマ、三本線、点、情報、注意、目、鍵）。倍率でにじまない |

## 文字の役と書体

- 書体は役ごとに渡す: `ukNew` に本文（`UK_FONT_SANS`）、`ukSetFont(ui, UK_FONT_SEMIBOLD / UK_FONT_MONO / UK_FONT_MONO_MEDIUM, own 書体)` で見出し（600）・等幅（ID・パス・コード・キーの札）・時刻（等幅の 500）。フレームの外で呼ぶ（文字の置き場を作り直す）。
- 描くときは `ukDrawTextS(ui, x, y, 文字, 大きさ, 色, style)` / `ukTextWS` / `ukDrawTextInS` / `ukFitTextS` の style で選ぶ。style は役（下の 4 ビット）と `UK_TEXT_TABULAR`（等幅の数字: 0-9 と : ; . + - の送り幅を一番広い字にそろえる。tokens の `font.rules.tabularDigits`）の和。
- 書体を渡していない役は近いもので描く: 見出しは本文に太さを足して（`ttf.um` の `TEXT_BOLD`。送り幅は変えない）、等幅は本文で、時刻は等幅で。役の書体のベースラインは本文の書体にそろえる。
- 字ごとの予備の書体: `ukSetFallbackFont(ui, own 書体)`。どの役でも、その書体にない字（等幅の書体の和文、素材名の記号）を予備の書体で測って描く（tokens の `font.family.fallback`）。
  - 予備の書体を渡していないときは、役の書体（等幅・見出し・時刻）にない字を本文の書体で補う。和文のない等幅の書体（IBM Plex Mono など）を渡しても、パスの中の日本語は本文の書体の字形で出る（豆腐にならない）。ただし字の太さや形は本文のものになるので、等幅の和文をそろえたいときは予備の書体を渡す。
- 同梱の IBM Plex Sans JP / Mono を探して役ごとに読むのは `src/ui/theme_font.um` の `thFontsLoad`（なければ OS の予備の書体）。

## OS とつなぐ（window.um）

`ukFeedWindowEvent` がイベントを uikit の入力に変え、`ukWindowSync(ui, ウィンドウ)`（毎フレーム `ukEnd` の後）が uikit の状態を OS に渡します。core はウィンドウなしで動き、試しに使えるままです。

- **クリップボード**: 入力欄がコピー・切り取りすると `ui.clipboardOut` が立ち、`ukWindowSync` が OS のクリップボードに書く（コピーしなければ触れない）。貼り付けのキー（Ctrl+V / Cmd+V）は、`ukFeedWindowEvent` が OS の文字を `ui.clipboard` に読んでから部品に渡す。
- **IME**: `windowImeComposition(true)` を `windowOpen` の前に呼ぶと、変換中の文字（`TextEditing`）が `ui.imeText` に入り、入力欄がカーソルの所に下線つきで描く。入力欄が描いた場所とカーソル（`ui.imeArea`）を `windowSetTextInputArea` で知らせ、候補の一覧をその近くに出す。
- **文字の入力の入り切り**: 文字の入力欄にフォーカスがあるフレームだけ OS の文字の入力を入れ、ないフレームでは止める（1 文字のショートカットが IME の変換に吸われない。ui.md 21.5）。
- **カーソルの形**と**ドロップ**: 上の表の「カーソルの形」「ドロップ」。

## 動画のプレビューを重ねる

動画の画面（プログラムモニター）は、uikit の命令として描きます。`ukEnd` の後に px に直に描くと、プレビューの上に出るメニュー・ドロップダウン・ツールチップ・通知・ダイアログが毎フレーム動画で上書きされて見えなくなるからです（メニューバーの下には普通プログラムモニターがある）。

```ts
// プレビューのコマは img（iw × ih）に描いておく（kernel の dispatch など）。px に直に描かない
ukBegin(mut ui, W, H, clock());
...
const mon = ukDockArea(mut ui, mut dock, 1, r).content;
ukDrawImage(mut ui, mon, 0, 0, iw, ih, frameNo as u32);   // 版（コマの番号など）が変わったときだけ描き直す
...                                                        // この後に積んだメニュー・ツールチップは上の層で描かれる
ukEndImage(mut ui, mut px, img, iw, ih);
```

- 画像は層の順に描かれ、上の層（ポップアップ・ツールチップ・通知・ダイアログ）に隠れない。
- 描き直しは、版が変わったときと、上に重なるものが変わったときだけ（変わらないフレームは 0 画素）。
- 拡大縮小は最近傍（画素の中心で取る）。ソースとプログラムの 2 つの画面は、1 枚の img に並べて `(sx, sy, sw, sh)` で切り分けられる。
- 画質の良い縮小（線形など）が要るなら、img を表示の大きさで作っておく（kernel で縮小してから渡す）。

## テーマ（theme.um）

生成したテーマ（`src/gen/theme.um`）からは `src/ui/theme_uk.um` の `thToUk` で写します。デザインに合わせて足した値（下の対応表にも入っている）:

| 値 | tokens.json | 使う所 |
| --- | --- | --- |
| `lineControl` | `color.dark.line.control` | 部品の輪郭（チェック・ラジオ・オフのトグル・スライダーの溝・値の欄の枠） |
| `focusOuter` / `focusW` / `focusOffset` | `semantic.focusOuter` / `border.focus` / `border.focusOffset` | 二重のフォーカスの輪 |
| `dangerTint` | `semantic.errorTint` | 危ないボタンのホバーの地 |
| `shadowX` / `shadowY`（と `shadowBlur`・`shadow`） | `shadow.popover.css`（"0 4px 12px rgba(0,0,0,.5)" を `ukParseShadow` で読む） | 浮かぶものの影（`ukDrawPopShadow`。ダイアログは 2 倍のずらし） |

色・文字の大きさ・余白・角・時間を 1 つの構造体 `UkTheme` に持ちます。大きさは UI の倍率（**0.8〜2.0**。ui.md 20 章と tokens.json の `scale`）を掛けた画素で持ち、`ukThemeScale(mut t, 倍率)` で作り直します（倍率を変えたら `ukInvalidate`）。線（stroke）は round(倍率) 画素です。

`docs/design/tokens.json` は `ukThemeFromTokens(mut t, json)`（戻り値は設定できた値の数）か `ukThemeFromTokensEx`（当てた道筋と、使わなかった道筋も返す）で読みます。葉（色の `#RRGGBB` / `#RRGGBBAA`、数、`"8px"` / `"600ms"` の文字列）ごとに、キーの道筋を `.` でつなぎ（DTCG の `value` / `$value` は飛ばす）、**道筋の全体**で次の表を引きます。表にない道筋は、道筋そのものが UkTheme の名前（`color.bg`、`size.ctrlH`、`time.tipDelay`）なら当て、そうでなければ使いません（クリップ・ラベルの色など、uikit の外で使う値）。寸法と時間は下限・上限に収めます（負の値や 0 で部品が壊れない）。

| tokens.json の道筋 | UkTheme |
| --- | --- |
| `color.dark.bg.0` / `.1` / `.2` / `.3` / `.4` | bg / panel と inputBg / panelAlt / raised と track / raisedHover と raisedActive |
| `color.dark.bg.popover` | tipBg |
| `color.dark.line.default` / `.strong` / `.control` | border / borderStrong / lineControl |
| `color.dark.text.1` / `.2` / `.disabled` / `.onDark` | text と tipText / textDim / textOff / onAccent |
| `color.dark.accent.default` / `.hover` / `.tintSolid` | accent と focus / accentHover / selection（不透明） |
| `color.dark.semantic.ok` / `.warn` / `.error` / `.errorTint` / `.focusOuter` | success / warning / danger / dangerTint / focusOuter |
| `font.size.md.size` / `.sm.size` / `.lg.size` | font / fontSmall / fontLarge |
| `size.button.md`、`size.icon.sm`、`size.scrollbar`、`size.tabBar` | ctrlH、icon、scrollW、tabH |
| `space.2` / `space.1` | pad / gap |
| `radius.md` / `.sm`、`border.hairline` / `.focus` / `.focusOffset` | radius / radiusSm、stroke / focusW / focusOffset |
| `shadow.popover.css` | shadowX / shadowY / shadowBlur / shadow |
| `motion.duration.tooltipDelay` / `.toastHold` | tipDelay / toastLife |

tokens にない accentActive と dangerHover は、読んだ accent と danger から作ります。本物の tokens.json（いまの版）では、38 の道筋すべてが見つかり、46 個の値が入ります（`tests/uikit/run.mjs` が確かめる）。

| 種類 | UkTheme の名前（`ukThemeSet` に `color.<名前>` / `size.<名前>` / `time.<名前>` で渡す） |
| --- | --- |
| 色 | bg, panel, panelAlt, raised, raisedHover, raisedActive, inputBg, border, borderStrong, text, textDim, textOff, accent, accentHover, accentActive, onAccent, danger, dangerHover, dangerTint, success, warning, focus, focusOuter, selection, track, lineControl, shadow, tipBg, tipText |
| 大きさ | font, fontSmall, fontLarge, ctrlH, rowH, pad, gap, radius, radiusSm, stroke, icon, scrollW, tabH, menuH, splitW, shadowBlur, shadowX, shadowY, focusW, focusOffset |
| 時間（ms） | tipDelay, toastLife |

## 見本と試し

見本（`demos/uikit_demo.um`）は src/ の外にあり、中の import は src/ の一番上からの相対なので、src/ を一時フォルダに写し、見本をその一番上に置いてから作ります（`tests/umtest.mjs` の `buildTool` がこれをします）。

```sh
cp -r src /tmp/mzc-src && cp demos/uikit_demo.um /tmp/mzc-src/
node <UM>/src/cli.ts build /tmp/mzc-src/uikit_demo.um --target host -o build/uikit-demo   # UM_SDL3 が要る
SDL_VIDEO_DRIVER=offscreen build/uikit-demo --frames 8 --click 30,13@2 --shot x.bmp   # 画面を出さずに画像を書く
build/uikit-demo --bench                                                          # 速さ（ウィンドウなし）
node tests/uikit/run.mjs [--bench] [--shot]
node tests/ui/run.mjs [名前…] [--no-demo]   # 画面の部品（tests/ui/*_test.um と demos/*_demo.um）の試しと見本の画面
```

見本は `--move x,y@F` `--click` `--rclick` `--down` `--up` `--key 名前@F`（`shift+tab`、`ctrl+a` など）`--type 文字@F` `--wheel d@F` で、F フレーム目に入力を入れられます（`--frames` のときは時刻も 1/60 秒ずつ進むので、画像が毎回同じになる）。`--scale 1.5`、`--size 1920x1080`、`--tokens <json>` も使えます。

`tests/uikit/run.mjs` は `docs/design/tokens.json`（このリポジトリか、隣の本体のリポジトリ）があれば、本物の tokens.json の読み取りも試します。いまの UM はウィンドウを使わないプログラムのビルドでも SDL3 の場所を求めることがあるので、SDL3 が見つからずにビルドが失敗したときは、その理由を出します。

## 速さ（1440×900、部品 300 個。Windows、ネイティブ、CPU）

| 場合 | 1 フレーム |
| --- | --- |
| 1 フレーム目（文字の画像を作る分を含む） | 約 7〜10 ms |
| 全体を描き直す（`ukInvalidate`） | 約 2.8〜3.2 ms（1920×1080 で約 3.3 ms、倍率 2.0 で約 7 ms） |
| 何も変わらない（部品を作り、ハッシュを比べるだけ） | 約 0.5 ms |
| マウスを動かす（ホバーの変わった所だけ。平均 約 9,000 画素） | 約 0.5 ms |
| ダイアログを開く | ダイアログの所だけ描き直す（暗幕をやめたので全体は描き直さない） |

`tests/uikit/run.mjs --bench` は ui.md 21.3 の目標で判定します: 全体の描き直し 4 ms 以内、変わった所だけの描き直しと変わらないフレームは 1 ms 以内。倍率 2.0 の全体の描き直し（約 7 ms）はまだ 4 ms を超えています（画素の数が 4 倍になるため。変わった所だけの描き直しは 1 ms 以内）。
