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
| `MOZCUT_EXE` | 素材のパスを読むのに直接呼ぶエンジンの場所（既定は `mozcut.mjs` の隣のフォルダの `../build/mozcut`。なければ `mozcut.mjs` がビルドする） |
| `UM_HOME` / `FFMPEG` / `FFPROBE` | `mozcut.mjs` にそのまま渡る |

## ツール

| ツール | すること | 書き換え |
| --- | --- | --- |
| `list_projects` | フォルダの中の `.mzc` を探す（`folder`、`recursive`） | しない |
| `schema` | キー・効果・操作・時刻と参照の書き方（`section` で `keys` / `effects` / `ops` / `syntax` に絞れる。`format: "text"` で人向けの文） | しない |
| `check` | 診断と、配置した後の全クリップ（`check --json` と同じ JSON） | しない |
| `show` | タイムラインの図とクリップの一覧（文） | しない |
| `op` | 操作。**既定は dry_run** で、差分（`diff`）と時刻が変わるクリップ（`moved`）を返す。`apply: true` のときだけ保存する | `apply: true` のときだけ |
| `preview` | 時刻の 1 コマを PNG にして、画像として返す（既定で幅 1280 画素まで。`max_width` で変える、`0` なら元の大きさ。`save_as` でプロジェクトのフォルダにも保存。時刻が全体より後ろなら `beyondEnd: true`） | キャッシュのフォルダに画像を書く（新しい 20 枚だけ残す）。`save_as` は既にあれば `overwrite: true` のときだけ |
| `render` | 書き出しを裏で始め、`job_id` を返す（`output`、`from`、`to`、`overwrite`） | 書き出し先に書く（既にあれば `overwrite: true` のときだけ） |
| `render_status` | 書き出しの様子（`wait_seconds` で終わるまで待つ、`cancel` で止める。止めるときは子のプロセスが終わり、途中のファイルを消すまで待つ） | 止めたときに途中のファイルを消す |

- `inputSchema` にない引数は `bad-args` で断ります（たとえば `op` に `dry_run: false` や `save: true` を渡しても保存されないので、`apply: true` を使うよう案内します）。
- 時刻は、秒（`3.5`）か `"分:秒"`（`"1:02.5"`）か `"時:分:秒"` です。欄は 3 つまで、分と秒は 60 未満、0〜10000000 秒（エンジンの決まりと同じ）。外れれば `bad-args` です。

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

- **許したフォルダの外には触れません。** プロジェクト（`.mzc`）が外にある、`.mzc` の素材（`video "..."`、`src=`）・フォント（`font=`）が外を指す、`op` で外のファイルを足そうとする、のどれも、ツールを動かす前（素材を ffprobe で調べるより前）に `code: "outside-root"` で断ります。シンボリックリンクはたどった先で判断します。
  - 素材のパスは、サーバーが自分で読むのではなく、**エンジンが実際に読んだパス**（`build/mozcut sources`。素材は調べない）で確かめます。`#ff8000` のような色の語や、`\.` のようなエスケープを使っても、エンジンと読み方がずれてすり抜けることはありません。
  - フォント（`font=`）と書き出し先（`output=`）は、エンジンが一覧を出さないので、エンジンの字句解析（`src/engine/project.um` の `pjTokenize`）を同じ決まりで写したもので読みます。素材もこれで二重に確かめます。素材・フォント・書き出し先のパスに知らないエスケープ（`\` の後ろが `n`・`t`・`"`・`\` 以外。エンジンが警告 `bad-escape` を出すもの）があれば、`code: "bad-escape"` で断ります。改行やタブの入ったパスは `code: "bad-path"` で断ります。
  - `op` は、試した後に書き換わる行を、もう一度エンジンに読ませて確かめてから保存します。
- **書き出すファイルはプロジェクトのフォルダ（`.mzc` のあるフォルダ）の中だけ**です。`render` の `output`、project の行の `output=`、`preview` の `save_as` が外を指せば `code: "outside-project"` で断ります。
- **素材を書き出しで壊しません。** 書き出し先が、プロジェクトの素材・フォント・`.mzc` そのもの・キャッシュのフォルダの中なら、`overwrite` を付けても `code: "output-is-source"` で断ります。既にあるファイルは `overwrite: true` のときだけ上書きします（既定は `code: "output-exists"` で断る）。`render` の annotations は `destructiveHint: true` です。
- **書き換える操作は既定で dry_run** です。`op` は `apply: true` のときだけ保存します。失敗する操作・誤りが増える操作は何も書きません（`mozcut op` と同じ）。
- **同時に来た要求は 1 つずつ処理します**（エンジンのビルドとキャッシュ・`.mzc` の書き込みがぶつからないように）。`render` は、確かめと `check` までを順番の中で行い、書き出しそのものは裏で動きます。**書き出し中のプロジェクトには、ほかのツール（`check` / `show` / `op` / `preview` / `render`）は触れず、`code: "busy"` で断ります**（`job_id` を添える）。`render_status` の `wait_seconds` で終わりを待つか、`cancel` で止めてから呼び直します。ほかのプロジェクトは書き出し中でも使えます。
- エンジンと `mozcut.mjs` は、**プロジェクトのフォルダで起動します**。エンジンは `font=` の相対パスを起動したフォルダから探すので、こうしてサーバーの確かめと起点をそろえています（サーバーをどこから起動しても結果は同じ）。
- 標準入力が閉じると、書き出し中のものを孫のプロセス（`mozcut`、ffmpeg）ごと止め、途中のファイル（キャッシュの `*.tmp`、`out.y4m`、`out.pcm`、この書き出しで作りかけた書き出し先）を消してから終わります。Windows では `taskkill /T /F` で、ほかではプロセスのグループごと止めます。

### 例外（許したフォルダの外でも読むもの）

- **OS のフォントのフォルダ**は、フォントに限って「読むだけ」の許可先です。人が作ったプロジェクトは、エンジンのヒントのとおり `font="C:/Windows/Fonts/YuGothM.ttc"` のように OS のフォントを書いていることが多いためです。
  - Windows: `%WINDIR%\Fonts`、`%LOCALAPPDATA%\Microsoft\Windows\Fonts`
  - macOS: `/System/Library/Fonts`、`/Library/Fonts`、`~/Library/Fonts`
  - Linux など: `/usr/share/fonts`、`/usr/local/share/fonts`、`~/.fonts`、`~/.local/share/fonts`
- それ以外の外を指すフォントは、`check` と `show`（読むだけで、フォントの中身も読まない）では断らずに、`serverWarnings`（`check` の JSON）と「サーバーの警告」の文を付けて診断を返します。`op` / `preview` / `render` は `outside-root` で断ります。
- 文字のフォントを指定しないとき、エンジンは OS のフォント（游ゴシックなど）を探して読みます。

## 結果の形

- 成功も失敗も、MCP のツールの結果（`content` と `structuredContent`）で返します。失敗のときは `isError: true` で、`structuredContent` は `{"ok":false,"error":"...","code":"..."}` です。
  - サーバーの code: `outside-root`、`outside-project`、`output-is-source`、`output-exists`、`bad-escape`、`bad-path`、`not-found`、`bad-args`（知らない引数のときは `unknown` と `known` も）、`busy`（書き出し中。`job_id` も）、`unknown-job`、`preview-failed`、`internal`。
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

テストには、すり抜け（色の語 `#ff8000`・エスケープ `\.`）、素材を書き出し先にした `render`、書き出し中の `preview` / `op` / `check`、`cancel` の後片付け、`font=` の起点（サーバーを許したフォルダの外で起動する）、OS のフォントと外のフォント、時刻の書き方、知らない引数を確かめるものも入っています。

## エンジン側にお願いしていること（結合の担当へ）

サーバーは既存のファイルを書き換えずに作ったので、次の食い違いはサーバー側で手当てしています。エンジン側で直れば、サーバーの手当てを外せます。

- `src/engine/project.um` の `font=` は、相対パスを**起動したフォルダ**から探します（`fileSize(val)`、`projectFont`）。素材（`src`）は `mozcut.mjs` がプロジェクトのフォルダから探すので、起点が違います。プロジェクトのフォルダから探すように直すのがよいです（サーバーは当面、エンジンをプロジェクトのフォルダで起動してそろえています）。
- `check --json` の `project` に、`font`（読むフォントのパス）と `output` を出してほしい。そうすれば、サーバーは字句解析の写しを持たずに、エンジンが読んだパスだけで確かめられます。
- `tools/mozcut.mjs` に `sources` のサブコマンド（エンジンの `sources` をそのまま渡す）があると、サーバーが `build/mozcut` を直接呼ばずに済みます。
