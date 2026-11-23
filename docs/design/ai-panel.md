# AI のタブと設定の画面への組み込み（関数の形）

右の列の AI のタブと、設定の画面から使う AI の中身（`src/ai/`）の約束です。新しい編集画面では、次の 2 つのファイルがこの関数を呼んでつないでいます。

- `src/editor/wire_ai.um`: AI のタブ（頼む・止める・流れてくる返事・提案の適用と却下・［設定を開く］）と、Claude Code の編集を履歴に出す所。`editor.um` の輪が毎フレーム `wireAiTick` を呼ぶ。HTTP の口（`AgHttp`）は輪が持って渡す（エージェントと同じ値に入れると、1 つの呼び出しに両方を `mut` で渡せないため）。
- `src/editor/rail_ai.um`: 左の欄の「設定」の先頭の AI の節（相手・キー・モデル・一覧を取る・つながるか確かめる・Claude Code の登録の 1 行）。

パネル（`ai/ui`）からは、頼みの途中で止める `AI_EV_STOP` と、［設定を開く］の `AI_EV_CONNECT` が来ます。今の頼みのやりとりは `AiPanelState` の `chatReq`・`chatReply`・`chatNotes`・`chatErr`・`busy` に、相手の設定が足りないときの 1 文は `setup` に入れます。

- 名前の空間は全ファイルで 1 つなので、`src/ai/` の名前はすべて `ag` / `Ag` / `AG_` で始まります（`src/ai/ui/` の `ai*` とぶつかりません）。
- どの関数も待ちません（ネットワークの応答を待つ関数はありません）。毎フレーム `agStep` を呼んで進めます。
- 試しは `node tests/ai/run.mjs`（手元に立てた偽の相手で確かめます。本物の AI の API は呼びません）。

## 1. ファイルの分け方

| ファイル | 中身 |
| --- | --- |
| `src/ai/ai_http.um` | HTTP の口（`agHttpStart` / `agHttpPoll` / `agHttpCancel`）。UnifiedMozaic の HTTP の組み込みの形に合わせた包み。試しの偽物（記録した応答・標準入出力の中継）もここ |
| `src/ai/ai_config.um` | 設定（`AgConfig`）の読み書き、伏せたキー、足りない設定の 1 文 |
| `src/ai/ai_provider.um` | 相手ごとの頼みの形と、流れてくる応答の読み方（Claude・Ollama・OpenAI 互換）。誤りの言葉 |
| `src/ai/ai_tools.um` | AI に渡すツール（check・show・schema・op・preview）の定義と実行、system の文 |
| `src/ai/ai_agent.um` | エージェントのループ、提案、適用・却下 |
| `src/ai/ai_external.um` | Claude Code（外の AI）の編集を拾う口と、登録のしかたの文 |
| `src/ai/ai_json.um` / `ai_sse.um` | JSON の書き出し・スキーマの確かめ / SSE と行区切りの JSON の区切り |

## 2. 持つもの

アプリ（`E2` の隣など）が、次の 3 つを持ち続けます。

```ts
let http = agHttpNew(AG_HTTP_REAL);            // HTTP の口（1 つでよい）
let cfg = agConfigLoad(agConfigPath());        // 設定（%APPDATA%/MozaicCut/ai.json）
let agent = agNew(cfg);                        // 会話・提案（system とツールの定義はここで 1 回だけ作る）
```

ツールが読むプロジェクトは、呼ぶたびに `AgProject` で渡します（ツールは毎回 `path` のファイルを読み直します）。

```ts
const proj: AgProject = { path: ed.path, cache: ed.cache, probes: e2ProbesWithImported(ed) };
```

## 3. AI のタブ

### 頼む・進める・受ける

| 呼ぶもの | 返るもの・起きること |
| --- | --- |
| `agSend(mut agent, mut http, text): bool` | 頼みを会話に足して送る。返事を待っている間（`agBusy`）は `false`。設定が足りなければ `false` で、`AG_EV_ERROR` の出来事に理由の 1 文 |
| `agStep(mut agent, mut http, proj, clock())` | 毎フレーム呼ぶ。届いた分を読み、ツールを実行し、次を頼む。待っている間は何もしない |
| `agTakeEvents(mut agent): AgEvent[]` | 前に呼んでから起きた出来事（下の表）。毎フレーム取り出して画面に写す |
| `agBusy(agent): bool` | 返事を待っている（送るボタンを「止める」にする） |
| `agCancel(mut agent, mut http)` | 待つのをやめる |
| `agReset(mut agent)` | 会話を新しく始める（提案は残る） |
| `agent.phase` | `AG_PH_IDLE` / `AG_PH_WAIT` / `AG_PH_RETRY`（待ってから頼み直す）/ `AG_PH_ERROR` |
| `agent.inTokens` / `outTokens` / `cacheRead` / `cacheWrite` | 最後の返事の使った量（キャッシュの効き具合の表示に） |
| `agent.turnUsage` / `chatUsage` | 今の頼み（ツールの往復を含む）/ この会話（`agReset` まで）の使った量。モデルごとの `AgUsage[]`（料金の目安つき） |
| `agTakeUsage(mut agent): AgUsage[]` | 前に呼んでから使った量。月ごとの記録（`agBookAdd`）に足す |
| `agent.month` | 最後の応答の Date の見出しの月（`"2026-11"`）。UM に暦の時刻がないので、月はここから作る |

### 使った量と料金の目安

- `src/ai/ai_price.um`: 料金の表（百万トークンあたりのドル。確かめた日を先頭の注釈に書く。変わったらここを直す）と `agUsageLine(list, cfg)`（「入力 12.3k・出力 1.2k・約 $0.07」）。Claude は `usage` を `message_start` と `message_delta` から読み、server-side fallback の `usage.iterations` があればモデルごとに数える。表にないモデルは「料金が分かりません」、Ollama は `$0（手元の AI）`、OpenAI 互換は設定の `openaiPriceIn` / `openaiPriceOut`（空なら量だけ）。円は設定の `yenPerUsd` があるときだけ。
- `src/ai/ai_usage.um`: 月ごとの記録（`ai.json` と同じフォルダの `ai-usage.json`）。`agBookLoad` / `agBookAdd` / `agBookSave` / `agBookMonth` / `agMonthPrev` / `agBookReset`。
- AI のタブ: 返事の下に `chatCost`、タブの下に `costTotal`（この会話と今月の合計）と `costNote`（「目安です。実際の請求は Anthropic の Console で確かめてください」）。設定の AI の節に今月と先月の合計・1 ドルの円の値・［数をリセット］。

`AgEvent { kind, text, name, index }` の `kind`:

| kind | 意味 | 画面ですること |
| --- | --- | --- |
| `AG_EV_TEXT` | 返事の文字が届いた（`text` は新しく届いた分） | 返事の吹き出しに足す |
| `AG_EV_TOOL_START` | ツールの呼び出しが始まった（`name`） | 「check を呼んでいます…」 |
| `AG_EV_TOOL` | ツールを実行した（`name`、`text` は 1 文の要約、`index` は失敗なら 1） | 吹き出しの中に小さく「check: 誤りなし（クリップ 3 個）」 |
| `AG_EV_PROPOSAL` | 提案ができた（`index` は `agent.proposals` の番号、`text` は `"p1"`） | 提案のカードを出す（下の「提案」） |
| `AG_EV_RETRY` | 混んでいるので待って頼み直す（`text` に秒数） | それまでの文字を消し、`text` を灰色で出す |
| `AG_EV_REFUSAL` | AI が答えるのを断った（`text` は利用者向けの 1 文） | 黄色の注意で出す。頼みは会話から取り下げてある |
| `AG_EV_ERROR` | 誤りで止まった（`text` は利用者向けの 1 文。キーが違う・つながらない・回数を超えた など） | 赤で出し、設定の画面への入口を添える |
| `AG_EV_DONE` | 1 回の頼みが終わった（`text` はこの頼みの返事の全文） | 送るボタンを戻す |

### 提案

`agent.proposals[i]` は `AgProposal { id, request, ops: string[], state }`（`state` は `AG_PROP_PENDING` / `AG_PROP_APPLIED` / `AG_PROP_REJECTED`）。

| 呼ぶもの | 返るもの・起きること |
| --- | --- |
| `agPanelProposal(agent, proj, i, reply): AiProposal` | `ai/ui` の提案のカードの形（`aiProposalFromBatch` と同じ）。今のファイルで dry-run し直して、差分・影響の札・動くクリップを作る。そのまま `AiPanelState` に入れられる |
| `agApply(mut agent, proj, i, ops, when): AgApplyResult` | 選んだ op（`aiSelectedOps(p)`。全部でも一部でもよい）を適用する。今のファイルで dry-run し直し、通ったときだけ `.mzc` を書く。`.mzc.history` に 1 行足し、次の頼みの頭で AI に「適用しました」と知らせる |
| `agReject(mut agent, i)` | 却下。次の頼みの頭で AI に知らせる |
| `agMarkApplied(mut agent, i, nApplied, nAll)` | E2 の `e2ApplyOps` で適用したときに、提案を適用済みにする（下の注意） |
| `agHistLine(agent, proj, i, ops, when): string` | `.mzc.history` の 1 行（E2 の経路で自分で書くとき） |

`AgApplyResult { ok, error, before, after, desc, histLine }`:

- `ok` が `false` なら何も書いていません。`error` は「提案を出した後にプロジェクトが変わったので、この提案はもう当てはまりません（…）」など。カードを「当てはまらない」の灰色にします。
- **取り消しは 1 つ**: `before`（書き換える前の中身）を取り消しの履歴に 1 つ積めば、op がいくつあっても Ctrl+Z 1 回で戻ります（E2 なら `ed.undo.push({ text: before, desc })` と `ed.redo.clear()` の後に読み直す）。
- **E2 の経路**: `agApply` の代わりに `e2ApplyOps(mut ed, ops)` を呼んでもかまいません（取り消しは同じく 1 つにまとまります）。そのときは `agHistLine` の行を `.mzc.history` に足し、`agMarkApplied` を呼びます。
- `when` は ISO 8601 の時刻（`"2026-11-22T14:32:05+09:00"`）。UM には暦の時刻の組み込みがないので、アプリが SDL などから作って渡します（空でもよい）。

### Claude Code（外の AI）の編集

設定で相手が Claude Code のとき（`cfg.provider == AG_P_CLAUDE_CODE`）、`agSend` は使いません（設定が足りない扱いで、Claude Code で頼むように案内する 1 文を返します）。相手に関わらず、開いている間は外からの編集を拾います。

| 呼ぶもの | 返るもの・起きること |
| --- | --- |
| `agWatchNew(path, text): AgWatch` | 開いたとき。今の history の大きさを覚える |
| `agWatchSetOwn(mut w, text)` | アプリが自分で書いたとき（自分の変更を外からと取り違えないため） |
| `agWatchPoll(mut w): AgExternal` | 1 秒に 1 回くらい。`changed` なら `newText` で読み直す。`items: AiHist[]` を `aiHistPush` で履歴に足す（MCP サーバーの記録は「Claude Code: b を 3 秒から 5 秒に動かしました」、記録のない書き換えは「ファイルが外で書き換えられました」）。`note` は状態の帯の 1 文 |

MCP サーバー（`tools/mcp-server.mjs`）は、op を保存したときに `<名前>.mzc.history` へ `{"t":…,"who":"ai","via":"mcp","client":"claude-code","tool":"op","ops":[…],"desc":"…","changes":[{"kind","line","before","after"}]}` を 1 行足します。アプリ自身の行は `"via":"app"` で、`agWatchPoll` は読み飛ばします。

## 4. 設定の画面

| 呼ぶもの | 返るもの・起きること |
| --- | --- |
| `agConfigPath(): string` | `%APPDATA%/MozaicCut/ai.json`（Windows）か `$HOME/.config/MozaicCut/ai.json`。環境変数 `MOZCUT_AI_CONFIG` があればそれ |
| `agConfigLoad(path): AgConfig` / `agConfigSave(path, cfg): bool` | 読む（なければ既定値）/ 書く（フォルダも作る） |
| `agSetConfig(mut agent, cfg)` | 変えた設定をエージェントに渡す（会話は残る） |
| `agKeyMasked(key): string` | 伏せたキー（`••••••••abcd`。8 文字未満は全部伏せる）。**入力欄の外でキーをそのまま出さない** |
| `agKeySource(cfg): string` | キーの出どころ（`"設定"` / `"環境変数 ANTHROPIC_API_KEY"` / `""`） |
| `agConfigProblem(cfg): string` | 足りない設定の 1 文（そろっていれば `""`）。保存の前に見せる |
| `agProviderLabel(p)` | 相手の選択肢の名前（`AG_P_CLAUDE` / `AG_P_OLLAMA` / `AG_P_OPENAI` / `AG_P_CLAUDE_CODE`） |
| `agModelsRequest(cfg): AgRequest` → `agHttpStart` … → `agModelsParse(body): string[]` | ［一覧を取る］: Ollama は `/api/tags`、OpenAI 互換は `/models`。本文を集め終えたら名前の列にする |
| `agMcpAddLine(home, root)` / `agMcpHelpText(home, root)` | 「Claude Code での登録のしかた」の 1 行と説明の文（`home` は MozaicCut のフォルダ、`root` はプロジェクトのフォルダ） |

`AgConfig` の項目: `provider`、`claudeModel`（既定 `claude-opus-5-5`）、`claudeUrl`（既定 `https://api.anthropic.com`）、`apiKey`、`effort`（既定 `medium`）、`fallbacks`（既定 `true`）、`ollamaUrl`（既定 `http://localhost:11434`）、`ollamaModel`、`openaiUrl`（既定 `http://localhost:1234/v1`）、`openaiModel`、`openaiKey`、`maxTokens`、`maxRetries`、`retryBaseSec`、`openaiPriceIn` / `openaiPriceOut`（OpenAI 互換の 1M トークンあたりのドル。空なら量だけ）、`yenPerUsd`（空なら円を出さない）。

## 5. HTTP の口（本物と試しの偽物）

`agHttpNew(AG_HTTP_REAL)` は UnifiedMozaic の HTTP(S) の組み込み（`httpStart` / `httpState` / `httpRead` など。説明は UnifiedMozaic の `docs/http.ja.md`）を使います。送受信は裏のスレッドで行うので、`agStep` を毎フレーム呼んでも待ちません。`agHttpPoll` は状態を読んでから届いた本文を取り出し、`AgHttpPoll { state, status, headers, data, error }` に写します（`data` はその poll で新しく届いた本文だけ、`headers` の名前は小文字）。受け取り終えた・失敗・中止の頼みは、その poll の中で `httpClose` して手放します。`agHttpCancel` も `httpClose` で止めます。つながらないときは `httpError` の理由（英語）を `agConnectErrorText` の 1 文に入れて `AG_EV_ERROR` で出します。

試しには `AG_HTTP_FAKE`（記録した応答）と `AG_HTTP_STDIO`（標準入出力の中継）を残しています。`tests/ai/run.mjs` は、本物の口でも手元の偽の相手（`http://127.0.0.1`。設定の `claudeUrl` / `ollamaUrl` / `openaiUrl` で向ける）に Claude・Ollama・OpenAI 互換を流して確かめます。
