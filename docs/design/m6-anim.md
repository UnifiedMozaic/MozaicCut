# M6 キーフレームとアニメーションの芯（src/m6_anim/）

After Effects のキーフレームとグラフエディタに当たる部品です。M2 のキーフレーム（不透明度・音量・位置など）の土台も兼ねます。
コアのファイルはまだ書き換えていません。組み込み方は下の「組み込み方」にあります。

| ファイル | 中身 |
| --- | --- |
| `src/m6_anim/anim.um` | 型、アニメーションできるキーの許可の表、`.mzc` の値の読み取りと書き戻し、時刻の解決、区間の準備、評価（値・速度・速さ）、診断（範囲も）、説明と JSON |
| `src/m6_anim/anim_ops.um` | キーの操作（`key add / remove / move / set / ease / shift / clear`）と、split / trim のときのキーの直し（`animOpRebase`）。値の文字を受け取り、新しい値の文字を返す |
| `src/m6_anim/anim_graph.um` | グラフエディタのデータ（値・速度のグラフ、キーと取っ手）と JSON、取っ手 → 速度と影響 |
| `src/m6_anim/anim_gpu.um` | kernel: 多くの時刻でいっぺんに評価、グラフエディタの絵、位置の経路（モーションパス）の絵 |
| `src/m6_anim/anim_remap.um` | 時刻の再マップ（`timeremap`）の土台と、フレームブレンドの kernel |
| `tests/m6-anim/` | 試験（`node tests/m6-anim/run.mjs [--bench] [--out <フォルダ>]`） |

## .mzc での書き方

```
text "タイトル" x="-400@0 120@1.5:ease 300@3:hold" opacity="0@0 1@0.5 1@end-0.5 0@end"
image "logo.png" pos="100,100@0 640,360@1:curve 1180,620@2:easein"
video "a.mp4" timeremap="0@0 2@1:ease 2@3 0@4"
```

- ふつうの `key=value` と同じ場所に、値として **`値@時刻[:印...]` を空白で並べる**（空白があるので `"..."` で囲む）。キー 1 つだけでも書ける（`x=120@0`）。書き方はこの 1 つだけ（1 キー 1 行の書き方はやめた。下の「決めたこと」）。
- **アニメーションできるキーは許可の表にあるものだけ**（`animTypeForKey` / `animTypeForFxKey`）。それ以外のキーの値の `@` はふつうの文字（`src=photo@2x.png`、`output=a@b.mp4`、`font=...` は誤りにならない）。

| キー | 値の型 | 範囲（keys.um の min / max） | 描画での使われ方 |
| --- | --- | --- | --- |
| `x` / `y` | 位置（`ANIM_POS`。左上からの画素） | なし | 配置（小数のまま） |
| `pos` | 2 次元 | なし | 配置（`x` / `y` の代わり。経路で動かす） |
| `opacity` | 数 | 0〜1 | 不透明度 |
| `color` | 色 | — | 文字の色、color の行の色 |
| `volume` / `vol` | 数 | 0〜10 | 音量（audio.um） |
| `timeremap` | 数（素材の秒） | 0〜素材の長さ | 素材の時刻 |
| `rotation` / `anchor` / `scale` | 角度 / 2 次元 / 数 | 変形の担当が決める | M6 の変形の担当が keys.um に足す |
| 効果の引数（`<効果>.<引数>`） | 数（末尾が `.angle` なら角度） | `fxParamMin` / `fxParamMax` | `FxUse.params` |

  `at` / `dur` / `in` / `out` / `xfade` / `track` / `fade*` / `w` / `h` / `size` / `src` / `font`、project の `width` / `height` / `crf` / `rate` などはアニメーションできない（描画が毎コマ読まないため）。アニメーションの値を書くと `key-not-animatable`。
- **位置（`x` / `y`）のアニメーションの値は、キャンバスの左上からの画素（小数・負も可）**。ふつうの値の「負は右端（下端）から」「`center` は中央」の読み替えはしない。`x="-400@0 100@1"` は左の画面の外から入る動きで、値が 0 をまたいでも基準は変わらない。`center@0` は `anim-bad-value`（「center はアニメーションの x / y には書けません」）。
- **時刻**はクリップの始まりからの秒（`1.5`、`1:02.5`）、コマ（`45f`）、終わりからの秒（`end`、`end-0.5`、`end-10f`）。負の時刻（クリップの前）も書ける。`end` からのキーは、長さを変えても終わりに付いて動く（フェードアウトに向く。split / trim の扱いは下の ops.um）。
- **値**: 数（`120`）、2 次元（`640,360`）、色（`ff8000` / `ff800080` / `white`）、角度（度。`720` は 2 回転。回り込みはしない）。値の大きさは ±1e9、時刻は 1e7 まで。有限でない値（`1e400`）は誤り。
- **印**（キーの後ろに `:` でつなぐ。いくつでも。After Effects と同じく、キーごとに入り側・出側を持つ）:

| 印 | 意味 | 触る側 |
| --- | --- | --- |
| `linear`（既定） | 両側とも直線 | 両側 |
| `hold` | このキーの値を次のキーまで保つ | 出側 |
| `ease` / `ease=60` | イージーイーズ（両側とも速度 0、影響 33.33% / 60%） | 両側 |
| `easein[=影響]` / `easeout[=影響]` | 入り側 / 出側だけ | 入り / 出 |
| `smooth` | 自動ベジェ（前後のキーから速度を決める。山と谷では速度 0、行き過ぎない） | 両側 |
| `in=<速度>/<影響%>` / `out=<速度>/<影響%>` | 速度（値の単位/秒。2 次元・色は経路に沿った速さ）と影響（0.1〜100%）。`in=linear` / `out=hold` / `out=smooth` も | 入り / 出 |
| `cubic=x1,y1,x2,y2` | このキーから次のキーまでを CSS の `cubic-bezier` で（`y` は 0..1 の外も可。行き過ぎ） | 出側 |
| `curve` | 2 次元だけ。経路をこのキーの前後からなめらかに曲げる（Catmull-Rom） | 経路（前後のキーが要る） |
| `tin=x,y` / `tout=x,y` | 2 次元だけ。経路の入り・出の接線（キーの点からの差）。片方だけ書くと、もう片方は逆向きの同じ長さ | 経路 |

- 片側だけベジェの区間は、直線の側を「平均の速さ・影響 1/3」の取っ手とする（After Effects と同じ）。
- 出側と入り側の影響の和が 100% を超えたら、両方を同じ比で縮めて和を 100% にする（取っ手が交差して、区間の中で値が一瞬で飛ぶのを防ぐ。速度はそのまま）。
- 同じ値のキーのあいだでも、速度を付ければ行き過ぎる（`0@0:out=900/40 300@1:in=-600/60`）。
- 色は RGBA（ストレートアルファ、0..1）の成分ごとに、2 次元は直線か空間のベジェの経路の上で補う。

### 読みやすさと差分

- 1 つのキーは 1 つの語（`120@1.5:ease`）で、キーの列は時刻の順に並べる（違えば `anim-key-order` の警告）。
- 操作で書き換えるとき、**変えていないキーの文字は書いたまま残す**（`45f` や `1:02.5` を秒に直さない）。変えたキーも、変えた部分（値・時刻・印）だけを書き直す。差分は触ったキーの語だけになる。

## 評価のしくみ

区間（隣り合う 2 つのキー）ごとに、**時刻 → 距離** のベジェ（P0 = (0, 0)、P1 = (影響出, 速度出 × 影響出 × dt)、P2 = (1 − 影響入, 長さ − 速度入 × 影響入 × dt)、P3 = (1, 長さ)。時刻は 0..1）を解き、**距離 → 値** に直す。

- 数・角度・位置: 距離は符号つきの値の差。値 = 始まりの値 + 距離。
- 2 次元・色: 距離は経路の長さに沿った量。直線の経路なら割合で補い、空間のベジェなら弧長の表（128 分割）で経路のパラメータを引く。経路の外（行き過ぎ）は端の接線の向きにまっすぐ伸ばす。
- 時刻 → パラメータは二分法（ホストは f64 で 52 回、kernel は f32 で 24 回）。x(u) は単調なので必ず解ける。
- 速度（`animVelocity`）と速さ（`animSpeed`。グラフエディタの速度のグラフ）は解析的に求める（dy/du ÷ dx/du）。
- **smooth（自動ベジェ）の速度**: 前後の傾き m0、m1 の符号が違うか、どちらかが 0（山・谷・止まる区間の隣）なら 0。それ以外は平均の傾き（前後の差の和 ÷ 時間）を `|速度| ≤ 3·min(|m0|, |m1|)` に抑える（Fritsch–Carlson。影響 1/3 のベジェは 3 次エルミートと同じなので、区間の中の値が両端のキーの値の外に出ない）。`0@0 100@1:smooth 50@2` は 100 を超えない（直す前は 1.1 秒で 101.075 だった）。
- **誤りの残った列**（`tr.ok` が false。重なりなど）は補わず、`animEval` も kernel も最初のキーの値を返す。

## 診断（Diag。project.um の `diag` / `warnDiag` と同じ形）

| code | 重さ | 意味 | 直し方（hint） |
| --- | --- | --- | --- |
| `anim-syntax` | error | `@` がない、`:` の後ろが空、キーが 1 つもない | `値@時刻` を空白で並べる |
| `anim-bad-value` | error | 値の型の誤り、有限でない・大きすぎる値、位置の `center` | 型ごとの書き方 |
| `anim-bad-time` | error | 時刻が読めない・有限でない・大きすぎる、コマなのに fps が不明、end なのに長さが不明 | 時刻の書き方 |
| `anim-bad-interp` | error | 知らない印（`suggest` に近い印） | 印の一覧 |
| `anim-bad-ease` | error | 影響が 0.1〜100 の外、速度/影響の形、有限でない速度、cubic の x が 0..1 の外 | `in=0/75`、`ease=60` |
| `anim-bad-tangent` | error | `tin` / `tout` の形、有限でない接線 | `tout=80,0` |
| `anim-spatial-not-allowed` | error | `curve` / `tin` / `tout` を 2 次元でないキーに書いた | 2 次元のキー（`pos`）に書く |
| `anim-key-overlap` | error | 同じ時刻（4 分の 1 コマ以内）のキーが 2 つ（列はあとのキー） | 1 つにする。急に変えるなら前のキーに `:hold` |
| `anim-remap-range` | error | `timeremap` が負の時刻か、素材の長さを超える時刻を見せる | 値を 0〜素材の長さにする |
| `out-of-range` | error | キーの値がキーの範囲の外（`animCheckRange`。列はそのキー）。ふつうの値と同じ code | 範囲 |
| `key-not-animatable` | error | 許可の表にないキーの値をアニメーションにした（project.um で出す。新しい code） | ふつうの値で書く |
| `anim-key-order` | warning | 書いた順と時刻の順が違う（時刻の順に並べ替えて使う） | 時刻の順に書く |
| `anim-key-outside` | warning | クリップの外のキー（補間には使う） | — |
| `anim-tag-unused` | warning | 効かない印（最初のキーの入り側だけの印、最後のキーの出側だけの印 `hold` / `cubic` / `out=` / `easeout`、最初か最後のキーの `curve`、キーが 1 つの列の印） | 消す |

列（col）は、key=value の値の最初の文字の列（`vcol`）にキーの中の位置を足したもの。キーの操作だけの code: `anim-no-key`（指した時刻にキーがない。hint に今のキーの一覧 `#0=0 秒、#1=1.5 秒`）、`anim-not-animated`（キーがない値に remove / move / ease など）、`bad-args`（キーの指し方が読めない）。

## 組み込み方（既存のファイルへ）

### keys.um（許可の表）

- `KeyInfo` に `animatable: bool` の欄を足し、上の表のキー（`x` / `y` / `pos` / `opacity` / `color` / `volume` / `vol` / `timeremap`。変形の担当の `rotation` / `anchor` / `scale`）だけを true にする。`animAnimatableKeys()` と一致させる（組み込むときに、両方の表を比べる試験を足す）。
- 足すキー: `pos`（VIS、2 次元。`x` / `y` の代わりに経路で動かすとき）、`timeremap`（video、time、0 以上）。

### project.um（読み取り）

1. `Clip` に `anims: ClipAnim[]` を足す（`struct ClipAnim { key: string; track: AnimTrack; line: i32; col: i32; lo: f64; hi: f64; }`）。`Project` にも同じものを足す（project の行の効果の引数をアニメーションするため）。
2. `pjApplyKey` では、**先に**キーが許可の表にあるか（`keys[ki].animatable`）を見て、そのときだけ `animIsAnimated(val)` を調べる。`pjApplyFx` では効果のキーはいつも許可（型は `animTypeForFxKey(key)`）。string / enum / flag や許可の表にないキーの値の `@` はふつうの文字として読む。ただし、許可の表にない数・時間のキー（`dur` など）の値が `@` を含み、ふつうの値として読めないときは、`bad-number` の代わりに `key-not-animatable`（「'dur' はアニメーションできません」）を出す。
3. アニメーションなら、ふつうの値の読み取りの代わりに `animParse(val, type, line, vcol', err)` を呼び、`ClipAnim` に入れる（`type = animTypeForKey(key)`、`vcol'` は値が `"` で始まるなら `vcol + 1`）。ふつうの値の欄（`c.x` など）には最初のキーの値を入れておく（アニメーションを知らない部品のため）。続けて `animCheckRange(track, key, lo, hi, line, vcol', err)`（`lo` / `hi` は keys.um の min / max を `parseNum` したもの、空なら NaN。効果は `fxParamMin` / `fxParamMax`）。`lo` / `hi` は `ClipAnim` にも入れておく（描くときに丸めるため）。
4. 配置（`pjLayout`）のあとで、クリップごとに `animResolve(mut track, c.dur, fps, line, col, err)`（fps = `fpsNum / fpsDen`）。`timeremap` なら続けて `animRemapCheck(track, c.dur, fps, 素材の長さ, line, col, err)`。

### render.um（描画）

`renderFrame` のクリップのループで、`lt = t - p.clips[idx].at` を求めた直後、**envelope と `alpha <= 0` の判定より前に**、そのクリップのアニメーションを評価して値を差し替えた写しを作る:

```ts
const lt = t - p.clips[idx].at;
if (lt < 0 || lt >= p.clips[idx].dur) { continue; }
const c = clipAt(p.clips[idx], lt);   // 新しい関数（render.um に置く）
const env = envelope(lt, c.dur, c.fadeIn, c.fadeOut);
const alpha = (env as f32) * c.opacity;   // 差し替えたあとの opacity で判定する
if (alpha <= 0) { continue; }
... drawVideo(mut canvas, c, ...) など、以後は c を使う
```

- `clipAt` は `m6_anim` に置かず、render.um（キーの名前 → `Clip` の欄の対応を知る所）に置く。数は `animClamp(animEvalNum(track, lt), lo, hi)`（補間で範囲の外に出た値を丸める。opacity は 0〜1）、色は `animEvalColor`（0〜1 に丸めてある）、2 次元は `animEval(...)[0..1]`、効果の引数は `FxUse.params[k]` に丸めて入れる。
- **位置（`x` / `y` / `pos`）をアニメーションしたクリップは、`resolvePos` を通さない**（`POS_CENTER` や負の値の読み替えをしない）。評価した値が、そのまま左上の画素（小数）。`Clip` に「位置はアニメーションの絶対座標」の印（例: `posAbs: bool`）を持たせ、`drawVideo` / `drawImage` / `drawText` / `drawColor` の `resolvePos` の所で分ける。
- **サブピクセルの配置**: 今の配置は `Math.floor` で整数の画素に丸めるので、ゆっくり動く位置（4 秒で 100 画素）が 1 画素ずつカクカク動く。位置をアニメーションしたクリップは、小数の位置で双線形に置く描き方（kernel）を使う。これは **M6 の変形の担当**（rotation / anchor / scale と同じ「層を変換して置く」kernel）が作ると決める。それまでは `Math.floor` で置く（今と同じ見え方）。
- project の行の効果の引数も、合成のあとで同じように `animEval(track, t)`（project の時刻）で差し替える。
- `timeremap` は `drawVideo` の素材の時刻（今は `lt + in`）を `animRemapTime(track, lt)` に替える。フレームブレンドを使うなら `animFramePair` の 2 コマを読み、`animBlendFrames` で混ぜてから合成する。
- 文字のクリップは、アニメーションする値があるとき `TextLayerCache` の鍵に時刻ごとの値（色）を含める。

### audio.um（音量）

`mixClip` の `g = audioEnvelope(c, t) * c.volume` の `c.volume` を、volume のアニメーションがあれば時刻ごとの値に替える。サンプルごとに `animEval` を呼ぶと重いので、**256 サンプルのブロックごとに**ブロックの両端の時刻で `animClamp(animEvalNum(track, t), 0, 10)` を求め、ブロックの中は直線で補う（ブロックの境目で音量が段になって「ジッパー音」が出ないように）。hold のキーでの急な変化も、この補いで 256 サンプル（48 kHz で 5.3 ms）の短いランプになる。

### ops.um（操作）

`opApply` の `switch (name)` に `case "key": opKey(mut lines, p, a, mut r); return;` を足し、`opKey` は:

```ts
// a = ["key", "add", <clip>, <キー>, ...]
const c = opFindClip(p, a[2], mut r);                 // クリップを指す
const k = (p.clips[c].line - 1) as usize;
const cur = hasKey(lines[k], prop) ? keyValue(lines[k], prop) : "";   // 今の値（ない・既定なら ""）
const type = animTypeForKey(prop);                    // -1 なら key-not-animatable で断る（効果のキーは animTypeForFxKey）
const fps = p.fpsNum as f64 / p.fpsDen as f64;
const e = animOpAdd(cur, type, `${opLabel(p.clips[c])} の ${prop}`, a[4], a[5], <a[6..]>, p.clips[c].dur, fps);
if (!e.ok) { opFail(mut r, e.code, e.error, e.hint); return; }
opEdit(mut lines, mut r, k, setKey(lines[k], prop, e.text));   // e.text は囲まずに渡す（setKey が "..." で囲む）
r.desc = e.desc;
```

- **位置（`x` / `y`）の `key add`** は、クリップの大きさ（幅か高さ）と画面の大きさが分かれば `animOpAddPos(cur, label, 時刻, 値, 印, dur, fps, size, canvas)` を使う。今のふつうの値（`center`、負は右端から）を `resolvePos` と同じ規則で左上からの画素に直し、0 秒のキーにしてから足す。大きさが分からないときの `animOpAdd` は、今の値が `center` か負なら黙って捨てずに `anim-bad-value` で断る（「先に 0 秒のキーを画素の値で足します」）。0 秒に足すときは置き換えるので断らない。
- `key clear` と最後のキーの `key remove` で位置が負になるときは、ふつうの値（右端から）にせず、キー 1 つのアニメーション（`-400@0`）で残す。
- **split / cut / trim**: キーの時刻は `animOpShift` ではなく `animOpRebase(cur, type, label, cutSec, oldDur, newDur, side, fps)` で直す（`animOpShift` は end からのキーの量も減らすので、長さが変わるときに使うと二重にずれる）。アニメーションしている全部のキーの値に掛け、`setKey` で書き戻す。

| 操作 | 呼び方 |
| --- | --- |
| split / cut の前半 | `animOpRebase(cur, type, label, 0, D, s, ANIM_REBASE_HEAD, fps)`（D は元の長さ、s は分けた所） |
| split / cut の後ろ半分 | `animOpRebase(cur, type, label, s, D, D - s, ANIM_REBASE_TAIL, fps)` |
| trim start（始まりを d 秒詰める） | `animOpRebase(cur, type, label, d, D, D - d, ANIM_REBASE_TAIL, fps)` |
| trim end（終わりを詰める） | 決まり: `animOpRebase(cur, type, label, 0, D, D', ANIM_REBASE_HEAD, fps)`（見え方を保つ。After Effects のトリムと同じくキーはタイムラインの上で動かない）。フェードアウトを新しい終わりに付いていかせたい場合は呼ばない（end からのキーはそのまま終わりに付く）。どちらにするかは trim の操作の引数で選べるようにしてもよい |

  - 後ろ半分と trim start では、始まりからのキーだけを `-cutSec` ずらし、end からのキーはそのまま（終わりはタイムラインの上で動かない）。
  - 前半と trim end では、end からのキーを始まりからの時刻に書き直す（分けた所で前半がフェードアウトしない）。
  - 新しいクリップの外に出たキーは、補間に要る 1 つ（外側で一番近いキー）だけを残す。残したキーの自動の補間（smooth の速度、curve の接線）は、消す前の前後のキーから求めた値に固定する（`animFreezeSide`）ので、**タイムラインの同じ時刻の値は分ける前と同じ**（試験で、smooth・ease・hold・コマ・end・2 次元の curve・色の列を、いくつかの所で分けて確かめた。固定した値は 4 桁の小数で書くので、差は 1e-4 以下）。
- 誤りが増える操作は今の仕組み（parse し直して診断を比べる）でそのまま断られる。
- `opInfos()` には `animOpRows()`（名前・書き方・説明・例を 4 つずつ）を足す。`schema --json` の `syntax` には `{"name":"keyframes","doc":animSyntaxDoc()}`。

### report.um（JSON と説明）

- `check --json` の `clips[i]` に `"anims":{"x":animTrackJson(track),...}` を足す（キーの `t`・`value`・`text`・`in`・`out`・`cubic`・`path`）。位置の型は `"position"`。
- `show` の一覧に `animDescribe(name, track)`（「x（位置（左上からの画素））: 0 秒で -400 → 1.5 秒で 120（入り イーズ（影響 33.3333%））→ …」）。
- AI 向けの手引き（docs/ai.md）の code の表に、上の診断を足す。

### 編集画面（M2 のキーフレーム、グラフエディタ）

- タイムラインのキーの印は `tr.keys[i].t`、インスペクタのストップウォッチは `key add`（今の時刻、今の値）/ `key clear`。
- グラフエディタは `animGraph(tr, t0, t1, n)` のデータか、`animGraphImage(tr, t0, t1, w, h)` の絵（`ui.um` と同じ 0xAARRGGBB の `Buffer<u32>`）を使う。取っ手を動かしたら `animHandleToEase(side, kt, kv, ht, hv, dt)` で速度と影響に直し、`key ease <clip> <キー> <時刻> in=<速度>/<影響> out=...` を ops に送る（操作の仕組みは一つ）。影響の和が 100% を超える取っ手は、評価のときに同じ比で縮める（グラフのデータの取っ手も縮めた位置で返す）。
- 合成の画面の経路は `animPathImage(tr, t0, t1, fps, w, h, view)`。`view = [sx, sy, ox, oy]` はビューアの表示の倍率とずらし（キャンバスの画素 (x, y) を絵の (x·sx + ox, y·sy + oy) に置く。等倍なら `[1, 1, 0, 0]`）。点・取っ手・キーはホストで変換してから kernel に渡すので、線の太さと点の大きさは表示の倍率によらず一定。

## 決めたこと（指摘への答え）

- **位置のアニメーションは絶対座標**: アニメーションした `x` / `y` は左上からの画素（負も可）。`pos` だけにする案もあったが、`x` だけを動かす（横のスライド）のがいちばんよく使われるので、`x` / `y` も残した。ふつうの値の読み替えとの違いは、型（`ANIM_POS`）、診断、`key add` / `clear` の扱い、`animSyntaxDoc` に書いた。
- **書き方は 1 つ**: 1 キー 1 行の書き方（`key <clip> <キー> <値@時刻>`）はやめた。キーの行ごとの診断の行、形の違う行の診断、`@行番号` のクリップの指し方と `@` が同じ文字になる点など、決めることが多く、AI にも人にも書き方の迷いが増えるため。行の差分は、変えていないキーの文字を残す書き戻しで小さく保つ。
- **ホールドの切り替えで入り側を残す**: `key ease` は印が触る側だけを既定に戻してから当てる（`50@1:ease` に `hold` → `50@1:easein:hold`）。

## kernel と CPU / GPU

- `animSampleKernel`（評価）: 区間の表（`AnimGpuSeg`、すべて `vec4<f32>`）と、空間のベジェの「弧長で等しく分けた点」の表（128 分割）を Buffer で渡す。ホストの評価（f64）との差は、数で 1.5e-4 以下（値 300 のとき）、2 次元の経路で 0.04 画素以下。
- `animGraphKernel` / `animPathKernel`（絵）: 距離までは浮動小数点、重ね合わせは整数（覆う割合 0..256）。曲線の画素の y はホストで求めて渡す。
- `animBlendKernel`（フレームブレンド）。
- **CPU（`UM_GPU=0`）と GPU（`UM_WGPU=1`、`UM_GPU_THRESHOLD=1`。RTX 5060 Ti / Vulkan）で、全部の kernel の結果がビットまで同じ**（`run.mjs` が確かめる。表示の倍率つきの経路の絵 `path_view` も）。
- 気づいたこと（UM へ報告）: 初めは絵の kernel で色を浮動小数点で混ぜていた（`dst + (c - dst) * k` を補助の kernel でくり返す）が、NVIDIA の Vulkan で 1 ULP ずれる画素があった（`um_fmul` は入っていた）。定数の色と重ねる式で、ドライバが並べ替えているらしい。整数の重ね合わせにして揃えた。

## 速さ（1920×1080、1 コマ、中央の値、ミリ秒）

Windows 11、Ryzen 9 3900X（24 スレッド）、RTX 5060 Ti、wgpu-native v29.0.1.1。GPU の値は結果の読み戻しを含む。直したあとの測り直し（15 回の中央の値）は、ほかの作業で CPU の使用率が 97% の中で測ったので、CPU の値は前より大きく出ている。

| 処理 | CPU | GPU（強制） |
| --- | --- | --- |
| 評価の kernel、207 万の時刻（粒ごとに時刻をずらす使い方） | 34（混んだ中で 42） | 10〜11 |
| フレームブレンド（RGBA f32） | 5〜8 | 10 |
| グラフエディタの絵 | 13〜19 | 5〜8 |
| 経路の絵（121 点、表示の変換つき） | 25〜28 | 6〜7 |
| ホストの評価 1000 回（1 コマに 1000 本のキーの列） | 0.6 | — |
