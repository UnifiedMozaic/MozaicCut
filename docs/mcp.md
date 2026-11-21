# MCP サーバー（AI のエージェントから使う）

`tools/mcp-server.mjs` は、MozaicCut を AI のエージェント（Claude Code、Claude Desktop など MCP に対応したもの）から使うための [MCP](https://modelcontextprotocol.io/) サーバーです。

- 標準入出力で JSON-RPC 2.0 をやり取りします（MCP の stdio）。npm の依存はなく、Node.js だけで動きます。
- 中身は `node tools/mozcut.mjs` のサブコマンド（`schema` / `check` / `show` / `op` / `preview` / `render`）を呼ぶだけです。人がコマンドで編集するのと同じエンジン・同じ操作が動きます（操作の仕組みは一つ）。
- 返す値の形（`check --json` や `op --json` の JSON、診断の code）は [ai.md](ai.md) のとおりです。

## 必要なもの

MozaicCut のコマンドが動く環境と同じです（[README](../README.md) の「必要なもの」）。

- Node.js 22.18 以上
- UnifiedMozaic（このリポジトリの隣に置くか、環境変数 `UM_HOME`）。エンジン（`build/mozcut`）は初回に自動でビルドされます。
- ffmpeg と ffprobe（PATH か、環境変数 `FFMPEG` / `FFPROBE`）

## 登録の仕方

以下のパスは例です。`C:/Users/you/MozaicCut` を MozaicCut の場所に、`C:/Users/you/Videos/projects` を AI に触らせてよいフォルダに読み替えてください。

### Claude Code

コマンドで足す（`--` の後ろがサーバーの起動のしかた）:

```sh
claude mcp add mozaiccut -- node C:/Users/you/MozaicCut/tools/mcp-server.mjs --root C:/Users/you/Videos/projects
```

UnifiedMozaic が MozaicCut の隣にないときは、環境変数も渡します:

```sh
claude mcp add mozaiccut -e UM_HOME=C:/Users/you/UnifiedMozaic -- node C:/Users/you/MozaicCut/tools/mcp-server.mjs --root C:/Users/you/Videos/projects
```

プロジェクトのフォルダで、チームで同じ設定を使うなら、そのフォルダに `.mcp.json` を置きます（`--root .` でそのフォルダだけを許します。相対パスは Claude Code を起動したフォルダからです）:

```json
{
  "mcpServers": {
    "mozaiccut": {
      "command": "node",
      "args": ["C:/Users/you/MozaicCut/tools/mcp-server.mjs", "--root", "."],
      "env": { "UM_HOME": "C:/Users/you/UnifiedMozaic" }
    }
  }
}
```

`claude mcp list` で、つながっているか確かめられます。会話の中では `/mcp` で状態とツールの一覧が見られます。

### Claude Desktop

設定のファイル `claude_desktop_config.json`（Windows は `%APPDATA%\Claude\claude_desktop_config.json`、macOS は `~/Library/Application Support/Claude/claude_desktop_config.json`。アプリの「設定 → 開発者 → 設定を編集」からも開けます）に足し、Claude Desktop を起動し直します:

```json
{
  "mcpServers": {
    "mozaiccut": {
      "command": "node",
      "args": [
        "C:/Users/you/MozaicCut/tools/mcp-server.mjs",
        "--root", "C:/Users/you/Videos/projects"
      ],
      "env": {
        "UM_HOME": "C:/Users/you/UnifiedMozaic",
        "FFMPEG": "C:/ffmpeg/bin/ffmpeg.exe",
        "FFPROBE": "C:/ffmpeg/bin/ffprobe.exe"
      }
    }
  }
}
```

- Claude Desktop は起動したフォルダが決まらないので、`--root` は必ず絶対パスで書きます。
- `node` や ffmpeg が PATH にないときは、`command` や `FFMPEG` / `FFPROBE` に絶対パスを書きます。

## 起動の引数と環境変数

| 指定 | 意味 |
| --- | --- |
| `--root <フォルダ>` | 触れてよいフォルダ。何度でも書ける。最初のものが、相対パスの起点と `list_projects` の既定になる |
| `MOZCUT_MCP_ROOTS` | `--root` がないときの許すフォルダ（Windows は `;`、ほかは `:` で区切る） |
| （どちらもない） | サーバーを起動したフォルダだけを許す |
| `MOZCUT_MJS` | 呼ぶ `mozcut.mjs` の場所（既定はサーバーと同じフォルダの `mozcut.mjs`） |
| `UM_HOME` / `FFMPEG` / `FFPROBE` | `mozcut.mjs` にそのまま渡る |

## ツール

| ツール | すること | 書き換え |
| --- | --- | --- |
| `list_projects` | フォルダの中の `.mzc` を探す（`folder`、`recursive`） | しない |
| `schema` | キー・効果・操作・時刻と参照の書き方（`section` で `keys` / `effects` / `ops` / `syntax` に絞れる。`format: "text"` で人向けの文） | しない |
| `check` | 診断と、配置した後の全クリップ（`check --json` と同じ JSON） | しない |
| `show` | タイムラインの図とクリップの一覧（文） | しない |
| `op` | 操作。**既定は dry_run** で、差分（`diff`）と時刻が変わるクリップ（`moved`）を返す。`apply: true` のときだけ保存する | `apply: true` のときだけ |
| `preview` | 時刻の 1 コマを PNG にして、画像として返す（`max_width` で縮める、`save_as` でプロジェクトのフォルダにも保存） | キャッシュのフォルダに画像を書く |
| `render` | 書き出しを裏で始め、`job_id` を返す（`output`、`from`、`to`） | 書き出し先に書く |
| `render_status` | 書き出しの様子（`wait_seconds` で終わるまで待つ、`cancel` で止める） | しない |

エージェントに期待する流れ（サーバーの `instructions` にも書いてあります）:

1. `list_projects` でプロジェクトを探す。
2. `schema`（1 回）と `check` で、書き方と今の配置を読む。
3. `op` を `apply` なしで呼び、`diff` と `results[].desc` / `moved` を確かめる。
4. 同じ `ops` を `apply: true` で呼んで保存する。
5. `check` で `diagnostics` が空なことを確かめる。
6. `preview` で見た目を確かめる。要るときだけ `render` → `render_status`。

`op` の例（引数）:

```json
{ "project": "demo.mzc", "ops": "split clip_b 7\nset clip_b_2 sat=0.5" }
{ "project": "demo.mzc", "ops": ["split clip_b 7", "set clip_b_2 sat=0.5"], "apply": true }
```

## 安全のための決まり

- **許したフォルダの外には触れません。** プロジェクト（`.mzc`）が外にある、`.mzc` の素材（`video "..."`、`src=`）・フォント（`font=`）が外を指す、`op` で外のファイルを足そうとする、のどれも、ツールを動かす前に `code: "outside-root"` で断ります。シンボリックリンクはたどった先で判断します。
- **書き出すファイルはプロジェクトのフォルダ（`.mzc` のあるフォルダ）の中だけ**です。`render` の `output`、project の行の `output=`、`preview` の `save_as` が外を指せば `code: "outside-project"` で断ります。
- **書き換える操作は既定で dry_run** です。`op` は `apply: true` のときだけ保存します。保存するときも、先に試して、書き換えた後の行が外のファイルを指さないことを確かめてから保存します。失敗する操作・誤りが増える操作は何も書きません（`mozcut op` と同じ）。
- 同時に来た要求は 1 つずつ処理します（エンジンのビルドとキャッシュの書き込みがぶつからないように）。`render` だけは裏で動き、同じプロジェクトを同時に 2 つ書き出すことはできません。
- 標準入力が閉じると、書き出し中のものを止めて終わります。
- 例外: 文字のフォントを指定しないとき、エンジンは OS のフォント（游ゴシックなど）を探して読みます。

## 結果の形

- 成功も失敗も、MCP のツールの結果（`content` と `structuredContent`）で返します。失敗のときは `isError: true` で、`structuredContent` は `{"ok":false,"error":"...","code":"..."}` です。
  - サーバーの code: `outside-root`、`outside-project`、`not-found`、`bad-args`、`busy`（書き出し中）、`unknown-job`、`preview-failed`、`internal`。
  - `op` の失敗は `mozcut op --json` の JSON がそのまま入ります（`results[].code` / `hint` / `suggest`。[ai.md](ai.md) の 4 節）。
- `check` で誤りが見つかるのはツールの失敗ではないので、`isError` は false で、`ok: false` と `diagnostics` を返します。
- `content` の 1 つ目は日本語の要約、2 つ目は `structuredContent` と同じ JSON の文です（`structuredContent` を読めない相手のため）。`preview` は 1 つ目が画像です。

## 手で試す

```sh
node tools/mcp-server.mjs --root demo
```

と起動し、1 行ずつ JSON を入れると答えが返ります:

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"me","version":"1"}}}
{"jsonrpc":"2.0","method":"notifications/initialized"}
{"jsonrpc":"2.0","id":2,"method":"tools/list"}
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"op","arguments":{"project":"demo.mzc","ops":"move clip_b 5.5"}}}
```

[MCP Inspector](https://github.com/modelcontextprotocol/inspector) を使うなら `npx @modelcontextprotocol/inspector node tools/mcp-server.mjs --root demo`。

## テスト

```sh
node tests/mcp/run.mjs        # -v でサーバーの標準エラーも出す、--keep で作業用のフォルダを残す
```

サーバーを子プロセスで起動し、`initialize` → `tools/list` → 各ツールを、一時フォルダの `demo/demo.mzc` の写しで呼んで確かめます。素材は `demo/media` にあれば写し、なければ ffmpeg で作ります（ffmpeg がなければ、素材の要るテストを飛ばします）。
